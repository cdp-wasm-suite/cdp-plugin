#include "cdp-plugin.h"

#if defined(__APPLE__)

#import <Cocoa/Cocoa.h>

#include <choc/gui/choc_WebView.h>
#include <choc/gui/choc_MessageLoop.h>
#include <choc/containers/choc_Value.h>

// Locates + serves the bundled CDP web app from Contents/Resources/web.
#include "cdp-plugin_editor_resources.h"
// Dispatches the web app's IPlugSendMsg (sample stream + web-keyboard MIDI).
#include "cdp-plugin_editor_bridge.h"

#include <array>
#include <locale>
#include <memory>
#include <sstream>
#include <string>

struct CDPPluginEditor;
static void nativeDragSessionEnded(CDPPluginEditor*, NSDragOperation);

@interface CDPPluginDragSource : NSObject <NSDraggingSource>
@property(nonatomic, copy) NSString* filePath;
@property(nonatomic, assign) CDPPluginEditor* editor;
@end

@implementation CDPPluginDragSource
- (void)dealloc
{
  self.filePath = nil;
  [super dealloc];
}

- (NSDragOperation)draggingSession:(NSDraggingSession*)session
        sourceOperationMaskForDraggingContext:(NSDraggingContext)context
{
  return NSDragOperationCopy;
}

- (void)draggingSession:(NSDraggingSession*)session
           endedAtPoint:(NSPoint)screenPoint
              operation:(NSDragOperation)operation
{
  nativeDragSessionEnded(self.editor, operation);
}
@end

// Per-instance editor storage.
struct CDPPluginEditor
{
  std::unique_ptr<choc::ui::WebView> webView;

  // Native drag state. The web UI prepares a file before movement and explicitly
  // arms one gesture from the Drag button; the event monitor then starts AppKit
  // synchronously on that gesture's first non-Option mouse drag.
  // Objective-C objects are manually retained in this non-ARC translation unit.
  NSString* preparedDragPath = nil;
  CDPPluginDragSource* dragSource = nil;
  NSEvent* dragMouseDown = nil;
  id mouseDownMonitor = nil;
  bool dragArmed = false;
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

static void nativeDragSessionEnded(CDPPluginEditor* editor, NSDragOperation)
{
  // Keep the file reusable, but consume this gesture completely. A new native
  // drag must be armed by a fresh BDGFUI from the Output button.
  if (editor)
  {
    editor->dragArmed = false;
    editor->dragStarted = false;
    [editor->dragMouseDown release];
    editor->dragMouseDown = nil;
  }
}

namespace
{
void cancelPreparedDrag(CDPPluginEditor& editor)
{
  if (editor.preparedDragPath && !editor.dragStarted)
  {
    [[NSFileManager defaultManager] removeItemAtPath:editor.preparedDragPath error:nil];
    [[NSFileManager defaultManager] removeItemAtPath:editor.preparedDragPath.stringByDeletingLastPathComponent error:nil];
  }
  [editor.preparedDragPath release];
  editor.preparedDragPath = nil;
  editor.dragArmed = false;
  editor.dragStarted = false;
}

void prepareNativeDrag(CDPPlugin& plugin, CDPPluginEditor& editor, const std::string& requestedName)
{
  cancelPreparedDrag(editor);

  NSString* name = [NSString stringWithUTF8String:requestedName.c_str()];
  name = name.lastPathComponent;
  if (name.length == 0)
    name = @"cdp-output.wav";
  if (![name.pathExtension.lowercaseString isEqualToString:@"wav"])
    name = [name stringByAppendingPathExtension:@"wav"];

  NSString* directory = [NSTemporaryDirectory() stringByAppendingPathComponent:
    [@"cdp-plugin/" stringByAppendingString:NSUUID.UUID.UUIDString]];
  if (![[NSFileManager defaultManager] createDirectoryAtPath:directory
                                 withIntermediateDirectories:YES attributes:nil error:nil])
    return;

  NSString* path = [directory stringByAppendingPathComponent:name];
  if (!plugin.writeRenderedSampleWav(std::filesystem::path(path.fileSystemRepresentation)))
  {
    [[NSFileManager defaultManager] removeItemAtPath:directory error:nil];
    return;
  }
  editor.preparedDragPath = [path copy];
}

void beginNativeDrag(CDPPluginEditor& editor, NSEvent* event)
{
  if (!editor.dragArmed || !editor.preparedDragPath || editor.dragStarted
      || !editor.webView || !event)
    return;

  // Consume the arm before entering AppKit. Even if session creation fails or
  // the drag is cancelled, no later WebView movement can reuse this mouse-down.
  editor.dragArmed = false;

  NSView* view = (__bridge NSView*)editor.webView->getViewHandle();
  NSWindow* window = view.window;
  if (!view || !window)
    return;

  NSURL* fileURL = [NSURL fileURLWithPath:editor.preparedDragPath];
  NSDraggingItem* item = [[[NSDraggingItem alloc] initWithPasteboardWriter:fileURL] autorelease];
  NSPoint location = [view convertPoint:event.locationInWindow fromView:nil];
  NSImage* image = [[NSWorkspace sharedWorkspace] iconForFile:editor.preparedDragPath];
  [image setSize:NSMakeSize(48, 48)];
  [item setDraggingFrame:NSMakeRect(location.x - 24, location.y - 24, 48, 48) contents:image];

  [editor.dragSource release];
  editor.dragSource = [[CDPPluginDragSource alloc] init];
  editor.dragSource.filePath = editor.preparedDragPath;
  editor.dragSource.editor = &editor;
  NSDraggingSession* session = [view beginDraggingSessionWithItems:@[item] event:event source:editor.dragSource];
  if (session)
  {
    session.animatesToStartingPositionsOnCancelOrFail = YES;
    editor.dragStarted = true;
  }
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
  if (windowType != mplug::WindowType::Cocoa)
    return nullptr;

  @autoreleasepool
  {
    auto* editor = new CDPPluginEditor();

    choc::ui::WebView::Options opts;
    // DevTools (right-click -> Inspect) only in dev/debug builds; released
    // (Release/NDEBUG, no dev server) plugins ship with them off. CHOC defaults
    // enableDebugMode to false, so leaving it unset disables DevTools.
#if defined(MY_PLUGIN_EDITOR_DEV_SERVER) || !defined(NDEBUG)
    opts.enableDebugMode = true;
#endif

    // The editor is a plugin UI, not a browser: a link to the CDP docs or the issue
    // tracker must open in the user's browser. Letting it replace the WebView's content
    // would strand them on a web page inside the plugin window with no way back.
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

    editor->webView = std::make_unique<choc::ui::WebView>(opts);

    // WKWebView delivers script messages asynchronously, after AppKit's current
    // event has gone away. Preserve the initiating mouse-down, then take over a
    // normal drag synchronously at its first native movement. The monitor observes
    // but never consumes or alters either event.
    editor->mouseDownMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:
      (NSEventMaskLeftMouseDown | NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp)
      handler:^NSEvent*(NSEvent* event)
      {
        if (editor->webView)
        {
          NSView* view = (__bridge NSView*)editor->webView->getViewHandle();
          const NSPoint point = [view convertPoint:event.locationInWindow fromView:nil];
          if (event.type == NSEventTypeLeftMouseDown)
          {
            // Every press invalidates the previous gesture. BDGFUI, delivered by
            // the Drag button's pointerdown handler, arms this new press shortly
            // after the native mouse-down has been retained here.
            editor->dragArmed = false;
            [editor->dragMouseDown release];
            editor->dragMouseDown = nil;
            if (event.window == view.window && NSPointInRect(point, view.bounds))
              editor->dragMouseDown = [event retain];
          }
          else if (event.type == NSEventTypeLeftMouseDragged && editor->dragMouseDown)
          {
            // Own normal mouse drags once they cross a conventional movement
            // threshold. Option explicitly reserves the gesture for the patcher's
            // Output -> Source interaction.
            const NSPoint start = editor->dragMouseDown.locationInWindow;
            const double dx = event.locationInWindow.x - start.x;
            const double dy = event.locationInWindow.y - start.y;
            if (editor->dragArmed && editor->preparedDragPath && !editor->dragStarted
                && (event.modifierFlags & NSEventModifierFlagOption) == 0
                && std::hypot(dx, dy) >= 8.0)
              beginNativeDrag(*editor, event);
          }
          else if (event.type == NSEventTypeLeftMouseUp)
          {
            editor->dragArmed = false;
            [editor->dragMouseDown release];
            editor->dragMouseDown = nil;
          }
        }
        return event;
      }];

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
        const auto obj = args[0];
        const std::string msg = obj.isObject() && obj.hasObjectMember("msg")
          ? obj["msg"].getWithDefault<std::string>("") : std::string{};
        if (msg == "PDGFUI")
          prepareNativeDrag(*this, *editor, obj.hasObjectMember("data")
            ? obj["data"].getWithDefault<std::string>("cdp-output.wav") : "cdp-output.wav");
        else if (msg == "BDGFUI")
          editor->dragArmed = editor->preparedDragPath && editor->dragMouseDown
            && ([NSEvent pressedMouseButtons] & 1u) != 0;
        myplugin::EditorBridgeContext ctx{mEditorHost, editor->editing.data(), editor->editing.size(), &editor->webReady};
        myplugin::handleIPlugSendMsg(*this, obj, ctx);
      }
      return {};
    });

    // With fetchResource set, CHOC loads the app root ("/") automatically. Only
    // the dev-server path needs an explicit navigate.
    if (useDevServer)
      editor->webView->navigate(std::string(CDPPlugin::editorURL()));

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
          editor->webView->evaluateJavascript("window.CDPNativeDragOut = true;");
          editor->webView->evaluateJavascript("if (window.CDPSetAppName) window.CDPSetAppName('CDP');");
          for (std::size_t i = 0; i < CDPPlugin::parameterCount(); ++i)
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
          for (std::size_t i = 0; i < CDPPlugin::parameterCount(); ++i)
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

    // setParentWindow rather than a direct addSubview:, to match the Windows
    // backend, where hand-rolling the reparent silently leaves WebView2 switched
    // off (see cdp-plugin_editor_win.cpp). It sets the frame and
    // the autoresizing mask too, so the size below is only the initial one.
    void* webViewHandle = editor->webView->getViewHandle();
    editor->webView->setParentWindow(parentView);  // nil parentView simply detaches

    NSView* webViewNSView = (__bridge NSView*)webViewHandle;
    auto size = defaultEditorSize();
    webViewNSView.frame = NSMakeRect(0, 0, size.width, size.height);

    mEditorView = editor;
    return webViewHandle;
  }
}

void CDPPlugin::destroyEditor()
{
  if (!mEditorView)
    return;

  @autoreleasepool
  {
    auto* editor = static_cast<CDPPluginEditor*>(mEditorView);

    if (editor->mouseDownMonitor)
      [NSEvent removeMonitor:editor->mouseDownMonitor];
    editor->mouseDownMonitor = nil;
    [editor->dragMouseDown release];
    editor->dragMouseDown = nil;
    cancelPreparedDrag(*editor);
    editor->dragSource.editor = nullptr;
    [editor->dragSource release];
    editor->dragSource = nil;

    // Stop the poll timer before tearing down the WebView so its callback can't
    // fire against a half-destroyed view.
    editor->pollTimer.clear();

    // Detach from the host's view hierarchy before the WebView is torn down.
    if (editor->webView)
      editor->webView->setParentWindow(nullptr);

    delete editor;
    mEditorView = nullptr;
  }
}

void CDPPlugin::onEditorResize(int width, int height)
{
  if (!mEditorView)
    return;

  @autoreleasepool
  {
    auto* editor = static_cast<CDPPluginEditor*>(mEditorView);
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
