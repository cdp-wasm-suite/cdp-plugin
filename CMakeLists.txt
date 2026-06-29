cmake_minimum_required(VERSION 3.21)

project(ComposersDesktopPlugin
  VERSION 0.1.0
  DESCRIPTION "Composer's Desktop Plug-in"
  LANGUAGES CXX C
)

# Enable Objective-C++ on Apple platforms (needed for the macOS WebView editor)
if(APPLE)
  enable_language(OBJCXX)
endif()

# Default macOS build architecture (desktop only — iOS/visionOS set their own):
#   * CI (the CI env var is set, e.g. on GitHub Actions) → universal arm64;x86_64
#     so released artifacts run on both Apple Silicon and Intel.
#   * Local dev → just the host arch, for faster builds and smaller binaries.
# Pass -DCMAKE_OSX_ARCHITECTURES=... explicitly to override either default.
if(APPLE AND NOT CMAKE_OSX_ARCHITECTURES
   AND NOT CMAKE_SYSTEM_NAME STREQUAL "iOS"
   AND NOT CMAKE_SYSTEM_NAME STREQUAL "visionOS")
  if(DEFINED ENV{CI})
    set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64")
  else()
    set(CMAKE_OSX_ARCHITECTURES "${CMAKE_HOST_SYSTEM_PROCESSOR}")
  endif()
  message(STATUS "macOS architectures: ${CMAKE_OSX_ARCHITECTURES} "
                 "(override with -DCMAKE_OSX_ARCHITECTURES=...)")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# ----------------------------------------------------------------------------
# Fetch the MPlug framework
#
# By default this clones MPlug from GitHub. For local development against a
# checkout of MPlug, configure with:
#   cmake -B build -DFETCHCONTENT_SOURCE_DIR_MPLUG=/path/to/mplug
# ----------------------------------------------------------------------------
include(FetchContent)

FetchContent_Declare(mplug
  GIT_REPOSITORY https://github.com/olilarkin/mplug.git
  # Pinned to an immutable SHA for reproducible builds (main as of 2026-07-05,
  # includes BUNDLE_NAME artifact naming, the AU/AUv3 human-readable VENDOR
  # split, the ARM64EC VST3 bundle-folder + multi-config Windows output-dir
  # fixes, and the choc `Options::denyPermissionRequests` flag that lets the
  # WebView2 backend deny prompt-triggering web permissions — e.g. Web MIDI —
  # without a prompt, while keeping clipboard-read allowed for patcher paste).
  # Bump deliberately when new MPlug features are needed.
  # (No GIT_SHALLOW here: shallow clones only work with branch/tag names.)
  GIT_TAG        c03431fb5c647f24760e3c6b95515233be1f6f49
)

# Don't build MPlug's own examples/tests when consumed as a dependency
set(MPLUG_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(MPLUG_BUILD_TESTS OFF CACHE BOOL "" FORCE)

FetchContent_MakeAvailable(mplug)

# ----------------------------------------------------------------------------
# Native plugin formats (skipped when building WebAssembly/WCLAP via Emscripten).
# Produces: ComposersDesktopPluginClap, ComposersDesktopPluginVST3, ComposersDesktopPluginAUv2 (macOS), ComposersDesktopPluginApp.
# (The Cli and Python targets are defined but excluded from the default build —
# see EXCLUDE_FROM_ALL below; headless formats are irrelevant for this
# WebView-based plugin.)
#
# The plugin GUI is a CHOC WebView. Embedding it into a plugin host's window is
# implemented for macOS (WKWebView) and Windows (WebView2); the Linux stub
# returns nullptr (hosts show their generic parameter UI). The standalone App
# provides the full webview UI on all three platforms.
#
# The GUI is the CDP web app (cdp-web), bundled as prebuilt assets under
# resources/web-dist/ and copied into each format's Contents/Resources/web at
# build time (see the resource-copy section after mplug_add_plugin below). At
# runtime the editor serves those files in-process via CHOC's fetchResource
# callback. For live-reload development against the cdp-web dev server, set
# -DMY_PLUGIN_EDITOR_DEV_SERVER=ON (loads http://localhost:8000/ instead).
# ----------------------------------------------------------------------------
option(MY_PLUGIN_EDITOR_DEV_SERVER
  "Load the editor from the cdp-web dev server (localhost:8000) instead of bundled assets" OFF)
# iOS / visionOS (and their simulators) only support the AUv3 app-extension
# format; the desktop formats (App/VST3/CLI/...) can't configure there.
if(CMAKE_SYSTEM_NAME STREQUAL "iOS" OR CMAKE_SYSTEM_NAME STREQUAL "visionOS")
  set(MY_PLUGIN_APPLE_EMBEDDED TRUE)
endif()

if(MY_PLUGIN_APPLE_EMBEDDED)
  # ---- iOS / visionOS: AUv3 app extension only (requires -G Xcode) ----
  include(MPlugAUv3)

  mplug_add_auv3(ComposersDesktopPluginAUv3
    PLUGIN_CLASS ComposersDesktopPlugin
    DISPLAY_NAME "cdp-plugin"
    PLUGIN_HEADER src/composers_desktop_plugin.h
    IDENTIFIER "com.olilarkin.cdp"
    SUBTYPE "CDPl"
    MANUFACTURER "oliL"
    VENDOR "Oli Larkin"
    TYPE "aumu"
    VERSION "${PROJECT_VERSION}"
    DESCRIPTION "CDP sampler instrument"
    SOURCES src/composers_desktop_plugin.cpp
  )

elseif(NOT EMSCRIPTEN)
  # ---- Native desktop formats (macOS / Windows / Linux) ----
  # MPlug plugin macros (provides mplug_add_plugin). Included here so the native
  # VST3 SDK target isn't created for Emscripten/WCLAP builds.
  include(MPlugPlugin)

  # (The old resources/web/editor.html → EmbedWebResource.cmake → myplugin::editorHTML()
  # embed pipeline has been removed: the editor now serves the vendored CDP web app
  # from resources/web-dist/ in-process via CHOC's fetchResource, so the embedded
  # HTML string was dead code. See composers_desktop_plugin_editor_resources.h.)

  if(APPLE)
    set(MY_PLUGIN_EDITOR_SOURCES src/composers_desktop_plugin_editor_mac.mm)
    find_library(COCOA_FRAMEWORK Cocoa REQUIRED)
    find_library(WEBKIT_FRAMEWORK WebKit REQUIRED)
    set(MY_PLUGIN_EDITOR_LIBS ${COCOA_FRAMEWORK} ${WEBKIT_FRAMEWORK})
  elseif(WIN32)
    set(MY_PLUGIN_EDITOR_SOURCES src/composers_desktop_plugin_editor_win.cpp)
    # No extra link libraries: choc's WebView2 backend calls CoInitialize (ole32,
    # part of the MSVC default library set) and loads WebView2Loader.dll /
    # shlwapi.dll dynamically, so nothing needs naming explicitly here.
    set(MY_PLUGIN_EDITOR_LIBS)
  else()
    set(MY_PLUGIN_EDITOR_SOURCES src/composers_desktop_plugin_editor_generic.cpp)
    set(MY_PLUGIN_EDITOR_LIBS)
  endif()

  # Dev-server toggle: when ON, the editor backends load the cdp-web dev
  # server instead of the bundled assets. Applies to every plugin target created
  # by mplug_add_plugin below (add_compile_definitions affects targets defined
  # after this point in the directory).
  if(MY_PLUGIN_EDITOR_DEV_SERVER)
    add_compile_definitions(MY_PLUGIN_EDITOR_DEV_SERVER=1)
  endif()

  mplug_add_plugin(ComposersDesktopPlugin
    PLUGIN_CLASS ComposersDesktopPlugin
    DISPLAY_NAME "cdp-plugin"
    PLUGIN_HEADER src/composers_desktop_plugin.h
    PLUGIN_ID "com.olilarkin.cdp"
    VERSION "${PROJECT_VERSION}"
    VENDOR "Oli Larkin"
    BUNDLE_NAME "cdp-plugin"
    AU_SUBTYPE "CDPl"
    AU_TYPE "aumu"
    AU_MANUFACTURER "oliL"
    CLAP_DESCRIPTION "CDP sampler instrument"
    CLAP_FEATURES "instrument" "sampler" "synthesizer" "stereo"
    VST3_CATEGORY "Instrument|Synth"
    APP_NAME "cdp-plugin"
    SOURCES
      src/composers_desktop_plugin.h
      src/composers_desktop_plugin.cpp
    EDITOR_SOURCES
      ${MY_PLUGIN_EDITOR_SOURCES}
    LINK_LIBRARIES
      ${MY_PLUGIN_EDITOR_LIBS}
  )

  # mplug_add_plugin has no per-format opt-out for the headless Cli/Python
  # formats, so drop them from the default build here (targets stay defined and
  # can still be built by name if ever needed).
  foreach(_headless Cli Python)
    if(TARGET ComposersDesktopPlugin${_headless})
      set_target_properties(ComposersDesktopPlugin${_headless}
        PROPERTIES EXCLUDE_FROM_ALL TRUE)
    endif()
  endforeach()

  # --------------------------------------------------------------------------
  # macOS standalone App icon (Icon Composer).
  #
  # The icon is authored in resources/AppIcon.icon (Icon Composer) and compiled
  # *offline* with actool into resources/mac-icon/{AppIcon.icns, Assets.car},
  # which are committed. We copy those into Contents/Resources at build time
  # rather than running actool here, because the GitHub macOS runners ship an
  # older Xcode whose actool recognises a .icon enough to emit the plist keys but
  # does NOT produce the compiled icns/car — leaving the app with no icon. The
  # repo-level resources/App-Info.plist.in points CFBundleIconFile/CFBundleIconName
  # at "AppIcon" (AppIcon.icns shows the icon on every macOS; Assets.car adds the
  # Liquid Glass rendering on macOS 26+). MPlug drops its template mac.icns into
  # Resources, so remove that first, then re-sign (the web-copy step below re-signs
  # again, which is fine).
  #
  # Regenerate after editing resources/AppIcon.icon (needs Xcode 26+):
  #   xcrun actool resources/AppIcon.icon --compile resources/mac-icon \
  #     --app-icon AppIcon --platform macosx --minimum-deployment-target 10.15 \
  #     --output-partial-info-plist "$(mktemp)" --output-format human-readable-text
  # --------------------------------------------------------------------------
  if(APPLE AND TARGET ComposersDesktopPluginApp)
    set(MY_PLUGIN_MAC_ICON_DIR ${CMAKE_CURRENT_SOURCE_DIR}/resources/mac-icon)
    if(EXISTS ${MY_PLUGIN_MAC_ICON_DIR}/AppIcon.icns)
      set(_app_res "$<TARGET_BUNDLE_CONTENT_DIR:ComposersDesktopPluginApp>/Resources")
      add_custom_command(TARGET ComposersDesktopPluginApp POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E rm -f "${_app_res}/mac.icns"
        COMMAND ${CMAKE_COMMAND} -E copy
          "${MY_PLUGIN_MAC_ICON_DIR}/AppIcon.icns" "${_app_res}/AppIcon.icns"
        COMMAND ${CMAKE_COMMAND} -E copy
          "${MY_PLUGIN_MAC_ICON_DIR}/Assets.car" "${_app_res}/Assets.car"
        COMMAND codesign --force --sign - "$<TARGET_BUNDLE_DIR:ComposersDesktopPluginApp>"
        COMMENT "Installing macOS app icon (AppIcon.icns + Assets.car) into cdp-plugin.app"
        VERBATIM)
    else()
      message(WARNING "resources/mac-icon/AppIcon.icns not found — the App will "
                      "use MPlug's default mac.icns icon.")
    endif()
  endif()

  # --------------------------------------------------------------------------
  # Windows standalone App (.exe) icon.
  #
  # MPlug only sets an icon on macOS, so embed one via a Windows resource script.
  # resources/cdp-plugin.ico is a committed multi-resolution icon (16–256 px,
  # generated from the Icon Composer artwork with ImageMagick — see resources/
  # README). Compiling a .rc that references it as ICON id 1 makes Explorer / the
  # taskbar show it for cdp-plugin.exe. (MSVC compiles .rc sources automatically.)
  # --------------------------------------------------------------------------
  if(WIN32 AND TARGET ComposersDesktopPluginApp)
    set(MY_PLUGIN_ICO_PATH "${CMAKE_CURRENT_SOURCE_DIR}/resources/cdp-plugin.ico")
    if(EXISTS "${MY_PLUGIN_ICO_PATH}")
      configure_file("${CMAKE_CURRENT_SOURCE_DIR}/resources/app-icon.rc.in"
                     "${CMAKE_CURRENT_BINARY_DIR}/app-icon.rc" @ONLY)
      target_sources(ComposersDesktopPluginApp PRIVATE
                     "${CMAKE_CURRENT_BINARY_DIR}/app-icon.rc")
    else()
      message(WARNING "resources/cdp-plugin.ico not found — the Windows App .exe "
                      "will use the default executable icon.")
    endif()
  endif()

  # --------------------------------------------------------------------------
  # Windows standalone App: GUI subsystem (no console window).
  #
  # MPlug's add_executable() has no WIN32 flag, so the App links as a console
  # subsystem exe and Windows spawns a cmd window on launch (the app logs audio
  # device/settings info to stdout). Relink it as the GUI (windowed) subsystem so
  # double-clicking doesn't pop a console; keep the standard int main() entry via
  # /ENTRY:mainCRTStartup (WIN32_EXECUTABLE alone would demand WinMain). Trade-off:
  # CLI output (--list-devices etc.) run from a terminal no longer prints — this
  # app is GUI-first on Windows; --screenshot/headless still work (they write files).
  # --------------------------------------------------------------------------
  if(MSVC AND TARGET ComposersDesktopPluginApp)
    target_link_options(ComposersDesktopPluginApp PRIVATE
      "/SUBSYSTEM:WINDOWS" "/ENTRY:mainCRTStartup")
  endif()

  # --------------------------------------------------------------------------
  # Copy the bundled CDP web app next to / into each format so the editor can
  # serve it offline (see composers_desktop_plugin_editor_resources.h). Skipped
  # when developing against the dev server.
  #
  #   * macOS  — every format is a bundle; the assets ride inside
  #              Contents/Resources/web (the module-relative candidate #1).
  #   * Windows — the VST3 is a bundle (Contents/Resources/web), but the App and
  #              the single-file CLAP are loose in out/, so they get sibling
  #              folders (out/web for the App, out/cdp-plugin.web for the CLAP)
  #              matched by candidates #2/#3 in the resource lookup.
  #
  # Linux bundle layouts are still a follow-up (blocked on the WebKitGTK editor).
  # --------------------------------------------------------------------------
  if((APPLE OR WIN32) AND NOT MY_PLUGIN_EDITOR_DEV_SERVER)
    set(MY_PLUGIN_WEB_DIST ${CMAKE_CURRENT_SOURCE_DIR}/resources/web-dist)
    if(NOT EXISTS ${MY_PLUGIN_WEB_DIST}/index.html)
      message(WARNING
        "resources/web-dist/index.html not found — the editor will fall back to "
        "the dev server. Build cdp-web (npm run bundle) and vendor its dist/bundle/ "
        "into resources/web-dist/, or configure with -DMY_PLUGIN_EDITOR_DEV_SERVER=ON.")
    endif()
    # Track the vendored web files so the copy re-runs whenever they change — not
    # just when the format target relinks. A plain TARGET POST_BUILD step only fires
    # on relink, so re-vendoring resources/web-dist without a code change would
    # otherwise leave stale assets in an already-built bundle. CONFIGURE_DEPENDS
    # re-globs (regenerating the build) when files are added/removed.
    file(GLOB_RECURSE MY_PLUGIN_WEB_DIST_FILES CONFIGURE_DEPENDS "${MY_PLUGIN_WEB_DIST}/*")
  endif()

  if(APPLE AND NOT MY_PLUGIN_EDITOR_DEV_SERVER)
    foreach(_fmt VST3 Clap AUv2 App)
      set(_tgt ComposersDesktopPlugin${_fmt})
      if(TARGET ${_tgt})
        set(_stamp "${CMAKE_CURRENT_BINARY_DIR}/${_tgt}.webcopy.stamp")
        # Stamp-driven copy: runs after the bundle is built (DEPENDS ${_tgt}) and
        # whenever the web files change (DEPENDS the file list). rm before copy so a
        # file removed from web-dist doesn't linger in the bundle.
        #
        # Re-ad-hoc-sign afterwards: the linker seals the Mach-O at link time
        # (adhoc,linker-signed) and MPlug additionally signs the App bundle; adding
        # Resources/ invalidates that seal ("code has no resources but signature
        # indicates they must be present"), so reseal it. (Distribution still needs a
        # Developer ID re-sign; this just keeps the bundle valid ad-hoc.)
        add_custom_command(
          OUTPUT ${_stamp}
          COMMAND ${CMAKE_COMMAND} -E rm -rf "$<TARGET_BUNDLE_CONTENT_DIR:${_tgt}>/Resources/web"
          COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${MY_PLUGIN_WEB_DIST}"
            "$<TARGET_BUNDLE_CONTENT_DIR:${_tgt}>/Resources/web"
          COMMAND codesign --force --sign - "$<TARGET_BUNDLE_DIR:${_tgt}>"
          COMMAND ${CMAKE_COMMAND} -E touch ${_stamp}
          DEPENDS ${_tgt} ${MY_PLUGIN_WEB_DIST_FILES}
          COMMENT "Copying CDP web app into ${_tgt} bundle (Resources/web)"
          VERBATIM)
        add_custom_target(${_tgt}WebResources ALL DEPENDS ${_stamp})
      endif()
    endforeach()
  elseif(WIN32 AND NOT MY_PLUGIN_EDITOR_DEV_SERVER)
    # $<TARGET_BUNDLE_CONTENT_DIR> is Apple-only, so use MPlug's fixed Windows
    # output paths under out/ (VST3 bundle Contents/, plus loose .exe / .clap).
    # No codesign step on Windows.
    #
    # POST_BUILD (not a separate ALL target as on macOS): the Windows CI builds
    # explicit format targets (`--build --target …VST3 …Clap …App`) rather than
    # `all`, so an ALL-driven copy would never run there. POST_BUILD fires
    # whenever the format target itself is built, however it's invoked. It's
    # added after mplug_add_plugin, so it runs after MPlug's own bundle-assembly
    # POST_BUILD steps. (Trade-off vs. the macOS stamp approach: re-vendoring
    # web-dist without a relink won't re-copy — a clean CI build always does, and
    # for local Windows dev a rebuild of the target picks it up.)
    set(_out "${CMAKE_BINARY_DIR}/out")
    # (target ; destination) pairs — destinations differ per format, so drive it
    # from an explicit list rather than the macOS genex loop.
    set(_win_web_targets
      "ComposersDesktopPluginVST3"  "${_out}/cdp-plugin.vst3/Contents/Resources/web"
      "ComposersDesktopPluginApp"   "${_out}/web"
      "ComposersDesktopPluginClap"  "${_out}/cdp-plugin.web")
    list(LENGTH _win_web_targets _n)
    math(EXPR _last "${_n} - 1")
    foreach(_i RANGE 0 ${_last} 2)
      list(GET _win_web_targets ${_i} _tgt)
      math(EXPR _j "${_i} + 1")
      list(GET _win_web_targets ${_j} _dest)
      if(TARGET ${_tgt})
        add_custom_command(TARGET ${_tgt} POST_BUILD
          COMMAND ${CMAKE_COMMAND} -E rm -rf "${_dest}"
          COMMAND ${CMAKE_COMMAND} -E copy_directory "${MY_PLUGIN_WEB_DIST}" "${_dest}"
          COMMENT "Copying CDP web app for ${_tgt} -> ${_dest}"
          VERBATIM)
      endif()
    endforeach()
  endif()
endif()

# ----------------------------------------------------------------------------
# WebAssembly CLAP (WCLAP) — the plugin compiled to run in the browser.
# Enable with -DMPLUG_BUILD_WCLAP=ON via the Emscripten toolchain (emcmake).
# Headless: no editor sources.
# ----------------------------------------------------------------------------
if(MPLUG_BUILD_WCLAP)
  include(MPlugWClap)

  mplug_add_wclap(ComposersDesktopPluginWClap
    PLUGIN_CLASS ComposersDesktopPlugin
    BUNDLE_NAME "cdp-plugin"
    PLUGIN_HEADER src/composers_desktop_plugin.h
    PLUGIN_ID "com.olilarkin.cdp"
    VENDOR "Oli Larkin"
    VERSION "${PROJECT_VERSION}"
    DESCRIPTION "CDP sampler instrument"
    FEATURES "instrument" "sampler" "synthesizer" "stereo"
    SOURCES
      src/composers_desktop_plugin.h
      src/composers_desktop_plugin.cpp
  )
endif()
