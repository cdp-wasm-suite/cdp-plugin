#include "composers_desktop_plugin.h"

#if defined(_WIN32)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX  // keep windows.h min/max macros from clobbering choc's std::max()
#endif
#include <windows.h>

#include <choc/gui/choc_WebView.h>
#include <choc/gui/choc_MessageLoop.h>
#include <choc/containers/choc_Value.h>

// Locates + serves the bundled CDP web app from Contents/Resources/web.
#include "composers_desktop_plugin_editor_resources.h"
// Dispatches the web app's IPlugSendMsg (sample stream + web-keyboard MIDI).
#include "composers_desktop_plugin_editor_bridge.h"

#include <array>
#include <cmath>
#include <locale>
#include <memory>
#include <sstream>
#include <string>

// Per-instance editor storage. Mirrors the macOS editor (composers_desktop_plugin_editor_mac.mm):
// the bidirectional parameter sync, gesture handling and host->UI poll timer are
// identical — only the native windowing (WebView2 / HWND) differs.
struct ComposersDesktopPluginEditor
{
  std::unique_ptr<choc::ui::WebView> webView;

  // True while the UI is actively editing a parameter — host->UI pushes for that
  // index are suppressed so they don't fight the user's drag. Accessed only on
  // the UI/message thread (JS bindings + poll timer), so a plain bool is fine.
  std::array<bool, ComposersDesktopPlugin::parameterCount()> editing{};

  // False until the first poll tick has pushed every parameter's current value to
  // the UI (the editor-open initial sync — see the poll timer).
  bool sentInitial = false;

  // Set true when the web app signals it's ready (SUIRDY) — its host->UI globals
  // (SPVFD/CDPLoadGraph) exist and handlers are registered. Gating initial pushes
  // on this avoids the WebView-load-vs-poll-timer race that would silently drop
  // them. `ticks` is a fallback so a UI that never sends SUIRDY still syncs.
  bool webReady = false;
  int ticks = 0;

  // Drains host-originated parameter changes to the WebView. Declared last so it
  // is destroyed first (stopping the callback before the WebView goes away).
  choc::messageloop::Timer pollTimer;
};

namespace
{
// host -> UI: push a single parameter value into the WebView as the iPlug2
// SPVFD(paramIdx, normalizedValue) call. The value is normalized 0..1 to match the
// legacy protocol (see composers_desktop_plugin_editor_bridge.h).
void pushParameterToJS(ComposersDesktopPluginEditor& editor, std::size_t index, double plainValue)
{
  // Format with the classic ("C") locale so a host that switched the global C++
  // locale to one with a comma decimal separator can't corrupt the value — e.g.
  // -12.3 becoming "-12,3", which JS reads as two arguments (wrong value).
  std::ostringstream js;
  js.imbue(std::locale::classic());
  js << "if (window.SPVFD) window.SPVFD(" << index << ", "
     << myplugin::normalizeParam(index, plainValue) << ");";
  editor.webView->evaluateJavascript(js.str());
}
}  // namespace

void* ComposersDesktopPlugin::createEditor(void* parentView, mplug::WindowType windowType)
{
  if (windowType != mplug::WindowType::Win32)
    return nullptr;

  HWND parent = static_cast<HWND>(parentView);

  auto editor = std::make_unique<ComposersDesktopPluginEditor>();

  choc::ui::WebView::Options opts;
  // DevTools (right-click -> Inspect) only in dev/debug builds; released
  // (Release/NDEBUG, no dev server) plugins ship with them off. CHOC defaults
  // enableDebugMode to false, so leaving it unset disables DevTools.
#if defined(MY_PLUGIN_EDITOR_DEV_SERVER) || !defined(NDEBUG)
  opts.enableDebugMode = true;
#endif

  // This is a self-contained plugin UI — it never needs any web permission
  // (Web MIDI, microphone, camera, …). Deny them at the WebView2 level so the
  // page can never trigger a system permission prompt, independent of any JS
  // guard or injection timing. (Honoured by CHOC's WebView2 backend.)
  opts.denyPermissionRequests = true;

  // Decide how to load the CDP8 web app: from the bundled assets served
  // in-process (release / normal builds) or from the dev server (opt-in via the
  // MY_PLUGIN_EDITOR_DEV_SERVER build option, for live-reload development).
#if defined(MY_PLUGIN_EDITOR_DEV_SERVER)
  const bool useDevServer = true;
#else
  // Serve Contents/Resources/web via CHOC's in-process web server. Falls back to
  // the dev server if the bundled assets aren't present (a build without the
  // CMake resource-copy step).
  const std::string resourcesDir = myplugin::editorResourcesDir();
  const bool useDevServer = !myplugin::bundledEditorAvailable(resourcesDir);
  if (!useDevServer)
  {
    opts.fetchResource = [resourcesDir](const std::string& path)
    {
      return myplugin::fetchEditorResource(resourcesDir, path);
    };
  }
#endif

  // JS -> C++: the CDP web app's legacy iPlug2 message channel.
  // window.IPlugSendMsg(obj) carries every JS->host message: parameter edits and
  // gestures (SPVFUI/BPCFUI/EPCFUI), streamed sample buffers (SAMFUI) and
  // web-keyboard MIDI (SMMFUI). CHOC exposes this bound function as
  // window.IPlugSendMsg, exactly the global the vendored web bundle calls. Param
  // messages route through the EditorHost (so automation records) and use the
  // editor's per-index editing flags to suppress echo-back during a drag.
  //
  // IMPORTANT: bind() must be deferred until the WebView is ready. WebView2's
  // controller is created *asynchronously*, so calling bind() right after the
  // constructor (as the synchronous macOS WKWebView backend can) silently no-ops
  // — addInitScript()/evaluateJavascript() both bail while coreWebView is null,
  // so window.IPlugSendMsg is never injected. The web app then sees no bridge
  // (typeof IPlugSendMsg !== 'function') and falls back to the Web Audio API
  // instead of driving the C++ DSP. CHOC's webviewIsReady fires once the
  // controller exists — synchronously, before the initial document is created —
  // which is the correct point to bind (and to run the dev-server navigate).
  opts.webviewIsReady = [this, e = editor.get(), useDevServer](choc::ui::WebView& webView)
  {
    webView.bind("IPlugSendMsg", [this, e](const choc::value::ValueView& args) -> choc::value::Value
    {
      if (args.isArray() && args.size() >= 1)
      {
        myplugin::EditorBridgeContext ctx{mEditorHost, e->editing.data(), e->editing.size(), &e->webReady};
        myplugin::handleIPlugSendMsg(*this, args[0], ctx);
      }
      return {};
    });

    // With fetchResource set, CHOC loads the app root ("/") automatically. Only
    // the dev-server path needs an explicit navigate.
    if (useDevServer)
      webView.navigate(std::string(ComposersDesktopPlugin::editorURL()));
  };

  editor->webView = std::make_unique<choc::ui::WebView>(opts);

  // choc returns a null handle if the WebView2 runtime is unavailable (it ships
  // on Windows 11 and most Windows 10 machines). Fail gracefully so the host
  // falls back to its generic parameter UI rather than showing an empty window.
  HWND webViewHwnd = static_cast<HWND>(editor->webView->getViewHandle());
  if (!webViewHwnd)
    return nullptr;

  // host -> UI: drain parameter changes (automation, generic UI, preset recall)
  // on the message thread and push them to the WebView.
  editor->pollTimer = choc::messageloop::Timer(30, [this, e = editor.get()]() -> bool
  {
    // Backstop for the RT-safe sample handoff: free buffers the audio thread has
    // retired (the upload path also drains, but this covers idle periods).
    drainRetired();

    // Initial sync: push every parameter's current value to the UI once, so a
    // freshly opened editor adopts host/preset state. CHOC has no page-loaded
    // hook, but the web SPVFD dispatcher caches by index, so an early push is
    // applied even if the controls mount slightly later.
    // Wait for the web app to signal readiness (SUIRDY) before pushing initial
    // state — otherwise the push races the WebView page load and is dropped. Fall
    // back to "ready" after ~2 s so a UI that never sends SUIRDY still syncs.
    if (!e->webReady && ++e->ticks > 66)
      e->webReady = true;

    if (e->webReady)
    {
      if (!e->sentInitial)
      {
        // Rebrand the web app's menu-bar product label (default "CDP for Web").
        e->webView->evaluateJavascript("if (window.CDPSetAppName) window.CDPSetAppName('CDP');");
        for (std::size_t i = 0; i < ComposersDesktopPlugin::parameterCount(); ++i)
          pushParameterToJS(*e, i, getParameterValue(i));
        e->sentInitial = true;
      }

      // host -> UI: push a state-restored node graph. Drained every tick (not just
      // once) so it also covers preset recall while the editor is already open.
      // Base64'd to survive embedding in the JS call string.
      std::string graphJson;
      if (takePendingGraph(graphJson))
      {
        std::ostringstream gjs;
        gjs.imbue(std::locale::classic());
        gjs << "if (window.CDPLoadGraph) window.CDPLoadGraph(\""
            << choc::base64::encodeToString(graphJson.data(), graphJson.size()) << "\");";
        e->webView->evaluateJavascript(gjs.str());
      }
    }

    if (mEditorHost)
    {
      // A bulk state change (preset / setState) asks for a full re-read.
      if (mEditorHost->consumeFullRefresh())
      {
        for (std::size_t i = 0; i < ComposersDesktopPlugin::parameterCount(); ++i)
          pushParameterToJS(*e, i, getParameterValue(i));
      }

      mplug::ParameterChange change;
      while (mEditorHost->popParameterChange(change))
      {
        const bool busy = change.index < e->editing.size() && e->editing[change.index];
        if (!busy)
          pushParameterToJS(*e, change.index, change.value);
      }
    }
    return true;  // keep running
  });

  // choc creates the WebView2 host window as a top-level WS_POPUP. Convert it to
  // a child of the host-provided parent and size it to the editor. choc's own
  // window proc handles WM_SIZE and re-fits the WebView2 controller to the new
  // client area, so resizing the host window resizes the web content too.
  //
  // The default size is logical; the WebView2 backend lays out CSS pixels against
  // the monitor DPI, so on a scaled display the native window must be sized in
  // physical pixels (logical x scale) for the web app to get its intended CSS size.
  // mEditorScale is the host-reported DPI factor (set before createEditor when the
  // format supports it; mplug also re-fits via onEditorResize once attached).
  auto size = defaultEditorSize();
  const int physicalWidth = static_cast<int>(std::lround(size.width * mEditorScale));
  const int physicalHeight = static_cast<int>(std::lround(size.height * mEditorScale));
  SetParent(webViewHwnd, parent);
  SetWindowLongPtrW(webViewHwnd, GWL_STYLE, WS_CHILD | WS_VISIBLE);
  SetWindowPos(webViewHwnd, nullptr, 0, 0, physicalWidth, physicalHeight,
               SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);

  mEditorView = editor.release();
  return webViewHwnd;
}

void ComposersDesktopPlugin::destroyEditor()
{
  if (!mEditorView)
    return;

  auto* editor = static_cast<ComposersDesktopPluginEditor*>(mEditorView);

  // Stop the poll timer before tearing down the WebView so its callback can't
  // fire against a half-destroyed view.
  editor->pollTimer.clear();

  if (editor->webView)
  {
    // Detach from the host window before the WebView (and its HWND) is torn down.
    if (HWND webViewHwnd = static_cast<HWND>(editor->webView->getViewHandle()))
      SetParent(webViewHwnd, nullptr);
  }
  delete editor;
  mEditorView = nullptr;
}

void ComposersDesktopPlugin::onEditorResize(int width, int height)
{
  if (!mEditorView)
    return;

  auto* editor = static_cast<ComposersDesktopPluginEditor*>(mEditorView);
  if (!editor->webView)
    return;

  // Resize the child WebView2 host window; choc's window proc handles WM_SIZE
  // and re-fits the WebView2 controller to the new client area.
  if (HWND webViewHwnd = static_cast<HWND>(editor->webView->getViewHandle()))
  {
    SetWindowPos(webViewHwnd, nullptr, 0, 0, width, height,
                 SWP_NOZORDER | SWP_NOMOVE | SWP_NOACTIVATE);
  }

  // Let the web app react to the new size if it wants to (optional hook).
  std::ostringstream js;
  js.imbue(std::locale::classic());
  js << "if (window.onEditorResize) window.onEditorResize(" << width << ", " << height << ");";
  editor->webView->evaluateJavascript(js.str());
}

#endif  // _WIN32
