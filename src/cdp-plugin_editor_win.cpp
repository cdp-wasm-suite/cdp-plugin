#include "cdp-plugin.h"

#if defined(_WIN32)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX  // keep windows.h min/max macros from clobbering choc's std::max()
#endif
#include <windows.h>
#include <ole2.h>
#include <shlobj.h>

#include <choc/gui/choc_WebView.h>
#include <choc/gui/choc_MessageLoop.h>
#include <choc/containers/choc_Value.h>

// Locates + serves the bundled CDP web app from Contents/Resources/web.
#include "cdp-plugin_editor_resources.h"
// Dispatches the web app's IPlugSendMsg (sample stream + web-keyboard MIDI).
#include "cdp-plugin_editor_bridge.h"

#include <array>
#include <cmath>
#include <cwctype>
#include <filesystem>
#include <locale>
#include <memory>
#include <new>
#include <sstream>
#include <string>
#include <string_view>

namespace
{
// OLE is apartment-scoped. Declaring this before the WebView makes it the last
// editor member destroyed, so WebView2 has already released its COM objects when
// the matching OleUninitialize runs.
struct OleSession
{
  bool initialized = false;
  ~OleSession()
  {
    if (initialized)
      OleUninitialize();
  }
};

class FileDropSource final : public IDropSource
{
public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override
  {
    if (!object)
      return E_POINTER;
    *object = nullptr;
    if (IsEqualIID(iid, IID_IUnknown) || IsEqualIID(iid, IID_IDropSource))
    {
      *object = static_cast<IDropSource*>(this);
      AddRef();
      return S_OK;
    }
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override { return ++mReferences; }

  ULONG STDMETHODCALLTYPE Release() override
  {
    const ULONG references = --mReferences;
    if (references == 0)
      delete this;
    return references;
  }

  HRESULT STDMETHODCALLTYPE QueryContinueDrag(BOOL escapePressed, DWORD keyState) override
  {
    if (escapePressed)
      return DRAGDROP_S_CANCEL;
    return (keyState & MK_LBUTTON) ? S_OK : DRAGDROP_S_DROP;
  }

  HRESULT STDMETHODCALLTYPE GiveFeedback(DWORD) override
  {
    return DRAGDROP_S_USEDEFAULTCURSORS;
  }

private:
  std::atomic<ULONG> mReferences{1};
};
}  // namespace

// Per-instance editor storage. Mirrors the macOS editor (cdp-plugin_editor_mac.mm):
// the bidirectional parameter sync, gesture handling and host->UI poll timer are
// identical — only the native windowing (WebView2 / HWND) differs.
struct CDPPluginEditor
{
  OleSession ole;
  std::unique_ptr<choc::ui::WebView> webView;

  // The current rendered WAV is materialised before pointer-down. BDGFUI waits
  // for Windows' configured drag threshold, then offers this existing file to
  // the destination through the Shell's IDataObject implementation.
  std::filesystem::path preparedDragPath;
  bool dragStarted = false;

  // True while the UI is actively editing a parameter — host->UI pushes for that
  // index are suppressed so they don't fight the user's drag. Accessed only on
  // the UI/message thread (JS bindings + poll timer), so a plain bool is fine.
  std::array<bool, CDPPlugin::parameterCount()> editing{};

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
std::wstring utf8ToWide(const std::string& text)
{
  if (text.empty())
    return {};
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                          text.data(), static_cast<int>(text.size()),
                                          nullptr, 0);
  if (length <= 0)
    return {};
  std::wstring result(static_cast<std::size_t>(length), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                      static_cast<int>(text.size()), result.data(), length);
  return result;
}

std::wstring safeWavName(const std::string& requestedName)
{
  std::wstring name = std::filesystem::path(utf8ToWide(requestedName)).filename().wstring();
  for (wchar_t& character : name)
    if (character < 32 || std::wstring_view(L"<>:\"/\\|?*").find(character) != std::wstring_view::npos)
      character = L'_';
  while (!name.empty() && (name.back() == L'.' || name.back() == L' '))
    name.pop_back();
  if (name.empty())
    name = L"cdp-output.wav";

  std::wstring extension = std::filesystem::path(name).extension().wstring();
  std::transform(extension.begin(), extension.end(), extension.begin(),
                 [](wchar_t c) { return static_cast<wchar_t>(std::towlower(c)); });
  if (extension != L".wav")
    name += L".wav";
  return name;
}

void cancelPreparedDrag(CDPPluginEditor& editor)
{
  if (!editor.preparedDragPath.empty() && !editor.dragStarted)
  {
    std::error_code error;
    std::filesystem::remove(editor.preparedDragPath, error);
    std::filesystem::remove(editor.preparedDragPath.parent_path(), error);
  }
  editor.preparedDragPath.clear();
  editor.dragStarted = false;
}

void prepareNativeDrag(CDPPlugin& plugin, CDPPluginEditor& editor,
                       const std::string& requestedName)
{
  cancelPreparedDrag(editor);
  if (!editor.ole.initialized)
    return;

  std::array<wchar_t, 32768> tempPath{};
  const DWORD length = GetTempPathW(static_cast<DWORD>(tempPath.size()), tempPath.data());
  if (length == 0 || length >= tempPath.size())
    return;

  static std::atomic<std::uint64_t> nextDirectory{0};
  const std::wstring uniqueName = std::to_wstring(GetCurrentProcessId()) + L"-"
                                + std::to_wstring(GetTickCount64()) + L"-"
                                + std::to_wstring(++nextDirectory);
  const std::filesystem::path directory = std::filesystem::path(tempPath.data())
                                        / L"cdp-plugin" / uniqueName;
  std::error_code error;
  if (!std::filesystem::create_directories(directory, error) || error)
    return;

  const std::filesystem::path path = directory / safeWavName(requestedName);
  if (!plugin.writeRenderedSampleWav(path))
  {
    std::filesystem::remove(path, error);
    std::filesystem::remove(directory, error);
    return;
  }
  editor.preparedDragPath = path;
}

void beginNativeDrag(CDPPluginEditor& editor)
{
  if (!editor.ole.initialized || editor.preparedDragPath.empty()
      || editor.dragStarted || !editor.webView
      || (GetAsyncKeyState(VK_LBUTTON) & 0x8000) == 0)
    return;

  HWND view = static_cast<HWND>(editor.webView->getViewHandle());
  POINT start{};
  if (!view || !GetCursorPos(&start) || !DragDetect(view, start))
    return;

  IShellItem* item = nullptr;
  if (FAILED(SHCreateItemFromParsingName(editor.preparedDragPath.c_str(), nullptr,
                                         IID_PPV_ARGS(&item))))
    return;

  IDataObject* dataObject = nullptr;
  const HRESULT dataResult = item->BindToHandler(nullptr, BHID_DataObject,
                                                  IID_PPV_ARGS(&dataObject));
  item->Release();
  if (FAILED(dataResult) || !dataObject)
    return;

  auto* source = new (std::nothrow) FileDropSource();
  if (!source)
  {
    dataObject->Release();
    return;
  }

  editor.dragStarted = true;
  DWORD effect = DROPEFFECT_NONE;
  DoDragDrop(dataObject, source, DROPEFFECT_COPY, &effect);
  editor.dragStarted = false;
  source->Release();
  dataObject->Release();
}

// host -> UI: push a single parameter value into the WebView as the iPlug2
// SPVFD(paramIdx, normalizedValue) call. The value is normalized 0..1 to match the
// legacy protocol (see cdp-plugin_editor_bridge.h).
void pushParameterToJS(CDPPluginEditor& editor, std::size_t index, double plainValue)
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

void* CDPPlugin::createEditor(void* parentView, mplug::WindowType windowType)
{
  if (windowType != mplug::WindowType::Win32)
    return nullptr;

  // Hosts can request a replacement editor before destroying the previous one
  // (REAPER's AUv2 wrapper does on macOS; guard here too). Never let two editors
  // coexist: the orphan's poll timer would steal the pending-graph handshake
  // meant for the new editor and, once the plugin is destroyed, fire into freed
  // memory.
  if (mEditorView)
    destroyEditor();

  HWND parent = static_cast<HWND>(parentView);

  // A WebView never survives editor close/reopen. Queue the plugin's current
  // graph shadow for this fresh JS document, even when no DAW state load occurred.
  queueGraphForEditor();

  auto editor = std::make_unique<CDPPluginEditor>();
  editor->ole.initialized = SUCCEEDED(OleInitialize(nullptr));

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

  // Likewise, the editor is a plugin UI, not a browser: a link to the CDP docs or the
  // issue tracker must open in the user's browser. Letting it replace the WebView's
  // content would strand them on a web page inside the plugin window with no way back.
  opts.openExternalLinksInBrowser = true;

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
        const auto obj = args[0];
        const std::string msg = obj.isObject() && obj.hasObjectMember("msg")
          ? obj["msg"].getWithDefault<std::string>("") : std::string{};
        if (msg == "PDGFUI")
          prepareNativeDrag(*this, *e, obj.hasObjectMember("data")
            ? obj["data"].getWithDefault<std::string>("cdp-output.wav") : "cdp-output.wav");
        else if (msg == "BDGFUI")
          beginNativeDrag(*e);
        myplugin::EditorBridgeContext ctx{mEditorHost, e->editing.data(), e->editing.size(), &e->webReady};
        myplugin::handleIPlugSendMsg(*this, obj, ctx);
      }
      return {};
    });

    // With fetchResource set, CHOC loads the app root ("/") automatically. Only
    // the dev-server path needs an explicit navigate.
    if (useDevServer)
      webView.navigate(std::string(CDPPlugin::editorURL()));
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
        if (e->ole.initialized)
          e->webView->evaluateJavascript("window.CDPNativeDragOut = true;");
        // Rebrand the web app's menu-bar product label (default "CDP for Web").
        e->webView->evaluateJavascript("if (window.CDPSetAppName) window.CDPSetAppName('cdp-plugin');");
        for (std::size_t i = 0; i < CDPPlugin::parameterCount(); ++i)
          pushParameterToJS(*e, i, getParameterValue(i));
        e->sentInitial = true;
      }

      // host -> UI: push a state-restored node graph. Drained every tick (not just
      // once) so it also covers preset recall while the editor is already open.
      // Base64'd to survive embedding in the JS call string.
      std::string graphJson;
      if (takePendingGraph(graphJson))
      {
        if (graphJson.empty())
        {
          e->webView->evaluateJavascript("if (window.CDPNoGraph) window.CDPNoGraph();");
        }
        else
        {
          std::ostringstream gjs;
          gjs.imbue(std::locale::classic());
          gjs << "if (window.CDPLoadGraph) window.CDPLoadGraph(\""
              << choc::base64::encodeToString(graphJson.data(), graphJson.size()) << "\");";
          e->webView->evaluateJavascript(gjs.str());
        }
      }
    }

    if (mEditorHost)
    {
      // A bulk state change (preset / setState) asks for a full re-read.
      if (mEditorHost->consumeFullRefresh())
      {
        for (std::size_t i = 0; i < CDPPlugin::parameterCount(); ++i)
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

  // choc creates the WebView2 host window as a top-level WS_POPUP; setParentWindow
  // makes it a child of the host-provided parent. choc's own window proc then
  // handles WM_SIZE and re-fits the WebView2 controller to the new client area,
  // so resizing the host window resizes the web content too.
  //
  // Do NOT hand-roll this with SetParent + SetWindowLongPtr. WebView2 keeps
  // hosting state tied to the window its controller was created under, and there
  // is a trap in the obvious implementation: putting WS_VISIBLE into the style
  // marks the window visible without showing it, so a following ShowWindow() has
  // nothing to do and sends no WM_SHOWWINDOW — the message choc turns into
  // ICoreWebView2Controller::put_IsVisible. The browser then stays switched off
  // and the editor paints blank white, while every window property you can
  // inspect looks correct. setParentWindow handles that, and the put_ParentWindow
  // / NotifyParentWindowPositionChanged calls that keep rendering and input
  // working after a move.
  editor->webView->setParentWindow(parent);

  // The default size is logical; the WebView2 backend lays out CSS pixels against
  // the monitor DPI, so on a scaled display the native window must be sized in
  // physical pixels (logical x scale) for the web app to get its intended CSS size.
  // mEditorScale is the host-reported DPI factor (set before createEditor when the
  // format supports it; mplug also re-fits via onEditorResize once attached).
  auto size = defaultEditorSize();
  const int physicalWidth = static_cast<int>(std::lround(size.width * mEditorScale));
  const int physicalHeight = static_cast<int>(std::lround(size.height * mEditorScale));
  SetWindowPos(webViewHwnd, nullptr, 0, 0, physicalWidth, physicalHeight,
               SWP_NOZORDER | SWP_FRAMECHANGED);

  mEditorView = editor.release();
  return webViewHwnd;
}

void CDPPlugin::destroyEditor()
{
  if (!mEditorView)
    return;

  auto* editor = static_cast<CDPPluginEditor*>(mEditorView);

  // Stop the poll timer before tearing down the WebView so its callback can't
  // fire against a half-destroyed view.
  editor->pollTimer.clear();
  cancelPreparedDrag(*editor);

  // Detach from the host window before the WebView (and its HWND) is torn down.
  // setParentWindow(nullptr) rather than SetParent(hwnd, nullptr): the latter
  // leaves the window with WS_CHILD and no parent, which is not a valid state.
  if (editor->webView)
    editor->webView->setParentWindow(nullptr);

  delete editor;
  mEditorView = nullptr;
}

void CDPPlugin::onEditorResize(int width, int height)
{
  if (!mEditorView)
    return;

  auto* editor = static_cast<CDPPluginEditor*>(mEditorView);
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
