#include "composers_desktop_plugin.h"

#if defined(__APPLE__)

#import <Cocoa/Cocoa.h>

#include <choc/gui/choc_WebView.h>
#include <choc/gui/choc_MessageLoop.h>
#include <choc/containers/choc_Value.h>

// Locates + serves the bundled CDP web app from Contents/Resources/web.
#include "composers_desktop_plugin_editor_resources.h"
// Dispatches the web app's IPlugSendMsg (sample stream + web-keyboard MIDI).
#include "composers_desktop_plugin_editor_bridge.h"

#include <array>
#include <locale>
#include <memory>
#include <sstream>
#include <string>

// Per-instance editor storage.
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
  if (windowType != mplug::WindowType::Cocoa)
    return nullptr;

  @autoreleasepool
  {
    NSView* parent = (__bridge NSView*)parentView;

    auto* editor = new ComposersDesktopPluginEditor();

    choc::ui::WebView::Options opts;
    // DevTools (right-click -> Inspect) only in dev/debug builds; released
    // (Release/NDEBUG, no dev server) plugins ship with them off. CHOC defaults
    // enableDebugMode to false, so leaving it unset disables DevTools.
#if defined(MY_PLUGIN_EDITOR_DEV_SERVER) || !defined(NDEBUG)
    opts.enableDebugMode = true;
#endif

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

    editor->webView = std::make_unique<choc::ui::WebView>(opts);

    // JS -> C++: the CDP web app's legacy iPlug2 message channel.
    // window.IPlugSendMsg(obj) carries every JS->host message: parameter edits and
    // gestures (SPVFUI/BPCFUI/EPCFUI), streamed sample buffers (SAMFUI) and
    // web-keyboard MIDI (SMMFUI). CHOC exposes this bound function as
    // window.IPlugSendMsg, exactly the global the vendored web bundle calls. Param
    // messages route through the EditorHost (so automation records) and use the
    // editor's per-index editing flags to suppress echo-back during a drag.
    editor->webView->bind("IPlugSendMsg", [this, editor](const choc::value::ValueView& args) -> choc::value::Value
    {
      if (args.isArray() && args.size() >= 1)
      {
        myplugin::EditorBridgeContext ctx{mEditorHost, editor->editing.data(), editor->editing.size(), &editor->webReady};
        myplugin::handleIPlugSendMsg(*this, args[0], ctx);
      }
      return {};
    });

    // With fetchResource set, CHOC loads the app root ("/") automatically. Only
    // the dev-server path needs an explicit navigate.
    if (useDevServer)
      editor->webView->navigate(std::string(ComposersDesktopPlugin::editorURL()));

    // host -> UI: drain parameter changes (automation, generic UI, preset
    // recall) on the message thread and push them to the WebView.
    editor->pollTimer = choc::messageloop::Timer(30, [this, editor]() -> bool
    {
      // Backstop for the RT-safe sample handoff: free buffers the audio thread has
      // retired (the upload path also drains, but this covers idle periods).
      drainRetired();

      // Wait for the web app to signal readiness (SUIRDY) before pushing initial
      // state — otherwise the push races the WebView page load and is dropped. Fall
      // back to "ready" after ~2 s so a UI that never sends SUIRDY still syncs.
      if (!editor->webReady && ++editor->ticks > 66)
        editor->webReady = true;

      if (editor->webReady)
      {
        // Initial sync: push every parameter's current value to the UI once, and
        // rebrand the web app's menu-bar product label (default "CDP for Web").
        if (!editor->sentInitial)
        {
          editor->webView->evaluateJavascript("if (window.CDPSetAppName) window.CDPSetAppName('CDP');");
          for (std::size_t i = 0; i < ComposersDesktopPlugin::parameterCount(); ++i)
            pushParameterToJS(*editor, i, getParameterValue(i));
          editor->sentInitial = true;
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
          editor->webView->evaluateJavascript(gjs.str());
        }
      }

      if (mEditorHost)
      {
        // A bulk state change (preset / setState) asks for a full re-read.
        if (mEditorHost->consumeFullRefresh())
        {
          for (std::size_t i = 0; i < ComposersDesktopPlugin::parameterCount(); ++i)
            pushParameterToJS(*editor, i, getParameterValue(i));
        }

        mplug::ParameterChange change;
        while (mEditorHost->popParameterChange(change))
        {
          const bool busy = change.index < editor->editing.size() && editor->editing[change.index];
          if (!busy)
            pushParameterToJS(*editor, change.index, change.value);
        }
      }
      return true;  // keep running
    });

    void* webViewHandle = editor->webView->getViewHandle();
    NSView* webViewNSView = (__bridge NSView*)webViewHandle;
    auto size = defaultEditorSize();
    webViewNSView.frame = NSMakeRect(0, 0, size.width, size.height);
    webViewNSView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

    if (parent)
      [parent addSubview:webViewNSView];

    mEditorView = editor;
    return webViewHandle;
  }
}

void ComposersDesktopPlugin::destroyEditor()
{
  if (!mEditorView)
    return;

  @autoreleasepool
  {
    auto* editor = static_cast<ComposersDesktopPluginEditor*>(mEditorView);

    // Stop the poll timer before tearing down the WebView so its callback can't
    // fire against a half-destroyed view.
    editor->pollTimer.clear();

    if (editor->webView)
    {
      NSView* webViewNSView = (__bridge NSView*)editor->webView->getViewHandle();
      [webViewNSView removeFromSuperview];
    }
    delete editor;
    mEditorView = nullptr;
  }
}

void ComposersDesktopPlugin::onEditorResize(int width, int height)
{
  if (!mEditorView)
    return;

  @autoreleasepool
  {
    auto* editor = static_cast<ComposersDesktopPluginEditor*>(mEditorView);
    if (!editor->webView)
      return;

    // Re-fit the WebView to the new bounds. The autoresizing mask already tracks
    // a parent resize (VST3/CLAP embed us as a subview), but setting the frame
    // explicitly also covers the AU path where we are the top-level content.
    NSView* webViewNSView = (__bridge NSView*)editor->webView->getViewHandle();
    [webViewNSView setFrame:NSMakeRect(0, 0, width, height)];

    // Let the web app react to the new size if it wants to (optional hook).
    std::ostringstream js;
    js.imbue(std::locale::classic());
    js << "if (window.onEditorResize) window.onEditorResize(" << width << ", " << height << ");";
    editor->webView->evaluateJavascript(js.str());
  }
}

#endif  // __APPLE__
