#include "composers_desktop_plugin.h"

#if !defined(__APPLE__) && !defined(_WIN32)

// The in-host WebView editor is implemented for macOS (composers_desktop_plugin_editor_mac.mm)
// and Windows (composers_desktop_plugin_editor_win.cpp). On Linux (and other platforms) the
// host shows its generic parameter UI, and the standalone App provides a full
// cross-platform WebView UI. Returning nullptr here keeps all plugin formats
// building and loading cleanly.
//
// WebKitGTK needs the plugin to bridge the host's run loop (VST3 IRunLoop /
// CLAP posix-fd) into the GLib main context before its WebView can be embedded
// in a host window, which isn't wired up yet. To add it, create a
// choc::ui::WebView, bind the parameter functions (see the macOS/Windows
// editors), and re-parent its GtkWidget (choc::ui::WebView::getViewHandle())
// under the host-provided parentView.

void* ComposersDesktopPlugin::createEditor(void*, mplug::WindowType)
{
  return nullptr;
}

void ComposersDesktopPlugin::destroyEditor()
{
  mEditorView = nullptr;
}

// No in-host WebView on this platform, so nothing to re-fit.
void ComposersDesktopPlugin::onEditorResize(int, int)
{
}

#endif  // !__APPLE__ && !_WIN32
