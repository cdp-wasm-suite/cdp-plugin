#pragma once

// Shared editor-resource plumbing for the desktop WebView backends
// (composers_desktop_plugin_editor_mac.mm / composers_desktop_plugin_editor_win.cpp).
//
// The CDP web app (the node-graph patcher UI, ~18 MB of HTML/JS/WASM produced by
// `npm run bundle` in cdp-web) is shipped inside each plugin/app bundle under
//   Contents/Resources/web/
// copied there at build time by CMake. At runtime we locate that directory
// relative to the loaded plugin binary and serve its files to the WebView through
// CHOC's fetchResource callback — effectively an in-process web server. This lets
// the editor load the app offline, instead of from the cdp-web dev server
// (see ComposersDesktopPlugin::editorURL(), which is now only used as a fallback /
// when the MY_PLUGIN_EDITOR_DEV_SERVER build option is enabled).
//
// All functions are inline; only one of the two backends is compiled per platform,
// so there are no ODR concerns between them.

#include <choc/gui/choc_WebView.h>

#include <cctype>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <optional>
#include <string>
#include <vector>

#if defined(__APPLE__)
  #include <dlfcn.h>
#elif defined(_WIN32)
  #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
  #endif
  #ifndef NOMINMAX
  #define NOMINMAX
  #endif
  #include <windows.h>
#endif

namespace myplugin
{

// Directory containing the currently-loaded plugin/app binary. On macOS this is
// …/Contents/MacOS; on Windows it's the folder holding the .dll/.vst3/.clap
// (e.g. …/Contents/x86_64-win for a VST3 bundle). Uses the address of a symbol in
// this binary so it resolves the *plugin* module, not the host executable.
inline std::string editorModuleDir()
{
#if defined(__APPLE__)
  Dl_info info{};
  if (dladdr(reinterpret_cast<const void*>(&editorModuleDir), &info) && info.dli_fname)
  {
    std::string path = info.dli_fname;
    const auto slash = path.find_last_of('/');
    if (slash != std::string::npos)
      return path.substr(0, slash);
  }
  return {};
#elif defined(_WIN32)
  HMODULE mod = nullptr;
  if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                             GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                         reinterpret_cast<LPCWSTR>(&editorModuleDir), &mod))
  {
    wchar_t buf[MAX_PATH] = {};
    const DWORD n = GetModuleFileNameW(mod, buf, MAX_PATH);
    if (n > 0 && n < MAX_PATH)
    {
      std::wstring w(buf, n);
      const auto slash = w.find_last_of(L"\\/");
      if (slash != std::wstring::npos)
        w.resize(slash);
      const int len = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
      if (len > 0)
      {
        std::string out(static_cast<std::size_t>(len - 1), '\0');
        WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, out.data(), len, nullptr, nullptr);
        return out;
      }
    }
  }
  return {};
#else
  return {};
#endif
}

// Emit a diagnostic line about resource resolution. Silent-failure lookups are
// hard to debug from a user report, so we log the chosen path and the misses.
inline void editorResourceLog(const std::string& msg)
{
#if defined(_WIN32)
  OutputDebugStringA(("[cdp-plugin] " + msg + "\n").c_str());
#else
  std::fprintf(stderr, "[cdp-plugin] %s\n", msg.c_str());
#endif
}

#if defined(_WIN32)
// Read an environment variable as UTF-8 (empty if unset). Used for the
// installer-shared / per-user candidate roots (%COMMONPROGRAMFILES%, %LOCALAPPDATA%).
inline std::string editorEnvVar(const wchar_t* name)
{
  const DWORD n = GetEnvironmentVariableW(name, nullptr, 0);  // size incl. null
  if (n == 0)
    return {};
  std::wstring w(n, L'\0');
  const DWORD got = GetEnvironmentVariableW(name, w.data(), n);
  if (got == 0 || got >= n)
    return {};
  w.resize(got);
  const int len = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
  if (len <= 0)
    return {};
  std::string out(static_cast<std::size_t>(len - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, out.data(), len, nullptr, nullptr);
  return out;
}
#endif

// Ordered list of directories that may hold the bundled web app, most-specific
// first. The first one containing index.html wins (see editorResourcesDir).
// Forward slashes work for file I/O on all platforms; the Windows env roots use
// backslashes, which mix fine when concatenated with a "/index.html" request.
//   #1 <parent-of-moduleDir>/Resources/web — bundle formats (all macOS, Windows VST3)
//   #2 <moduleDir>/web                      — the App exe (and a co-located CLAP)
//   #3 <moduleDir>/cdp-plugin.web           — portable CLAP sibling folder
//   #4 %COMMONPROGRAMFILES%\Oli Larkin\cdp-plugin\web — installer-shared (Windows)
//   #5 %LOCALAPPDATA%\Oli Larkin\cdp-plugin\web       — per-user install (Windows)
inline std::vector<std::string> editorResourceCandidates()
{
  std::vector<std::string> out;
  const std::string dir = editorModuleDir();
  if (!dir.empty())
  {
    const auto slash = dir.find_last_of("/\\");
    const std::string parent = (slash != std::string::npos) ? dir.substr(0, slash) : dir;
    out.push_back(parent + "/Resources/web");  // #1
    out.push_back(dir + "/web");               // #2
    out.push_back(dir + "/cdp-plugin.web");    // #3
  }
#if defined(_WIN32)
  if (const std::string cf = editorEnvVar(L"CommonProgramFiles"); !cf.empty())
    out.push_back(cf + "\\Oli Larkin\\cdp-plugin\\web");  // #4
  if (const std::string la = editorEnvVar(L"LOCALAPPDATA"); !la.empty())
    out.push_back(la + "\\Oli Larkin\\cdp-plugin\\web");  // #5
#endif
  return out;
}

// The bundled web app's root directory: the first candidate that actually holds
// an index.html, or "" if none do (callers then fall back to the dev server).
inline std::string editorResourcesDir()
{
  std::string misses;
  for (const auto& c : editorResourceCandidates())
  {
    std::ifstream f(c + "/index.html", std::ios::binary);
    if (f)
    {
      editorResourceLog("serving editor from: " + c);
      return c;
    }
    misses += (misses.empty() ? "" : " ; ") + c;
  }
  editorResourceLog("no bundled editor found (falling back to dev server). Tried: " +
                    (misses.empty() ? std::string{"<no candidates>"} : misses));
  return {};
}

// True if the bundled web app is present (i.e. the CMake copy step ran). Callers
// use this to fall back to the dev server when building without bundled assets.
inline bool bundledEditorAvailable(const std::string& resourcesDir)
{
  if (resourcesDir.empty())
    return false;
  std::ifstream f(resourcesDir + "/index.html", std::ios::binary);
  return static_cast<bool>(f);
}

// Percent-decode a URL path component (e.g. "%40" -> "@" for node_modules/@olilarkin).
inline std::string urlDecode(const std::string& s)
{
  const auto hexVal = [](char c) -> int
  {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  std::string out;
  out.reserve(s.size());
  for (std::size_t i = 0; i < s.size(); ++i)
  {
    if (s[i] == '%' && i + 2 < s.size())
    {
      const int hi = hexVal(s[i + 1]);
      const int lo = hexVal(s[i + 2]);
      if (hi >= 0 && lo >= 0)
      {
        out.push_back(static_cast<char>((hi << 4) | lo));
        i += 2;
        continue;
      }
    }
    out.push_back(s[i]);
  }
  return out;
}

// Map a file extension to a MIME type. The critical ones are `.wasm`
// (WebAssembly streaming instantiation requires application/wasm) and `.js/.mjs`
// (ES-module scripts are rejected unless served with a JavaScript MIME type).
inline std::string mimeTypeForPath(const std::string& path)
{
  const auto dot = path.find_last_of('.');
  std::string ext = (dot == std::string::npos) ? std::string{} : path.substr(dot + 1);
  for (auto& c : ext)
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));

  if (ext == "html" || ext == "htm") return "text/html";
  if (ext == "js" || ext == "mjs")   return "text/javascript";
  if (ext == "wasm")                 return "application/wasm";
  if (ext == "json" || ext == "map") return "application/json";
  if (ext == "css")                  return "text/css";
  if (ext == "svg")                  return "image/svg+xml";
  if (ext == "png")                  return "image/png";
  if (ext == "jpg" || ext == "jpeg") return "image/jpeg";
  if (ext == "gif")                  return "image/gif";
  if (ext == "ico")                  return "image/x-icon";
  if (ext == "woff2")                return "font/woff2";
  if (ext == "woff")                 return "font/woff";
  if (ext == "ttf")                  return "font/ttf";
  if (ext == "wav")                  return "audio/wav";
  return "application/octet-stream";
}

// CHOC fetchResource implementation: given the request path (starting with "/"),
// read the corresponding file under `resourcesDir` and return it with a MIME type.
// Returns nullopt (-> 404) for missing files or path-traversal attempts.
inline std::optional<choc::ui::WebView::Options::Resource>
fetchEditorResource(const std::string& resourcesDir, const std::string& requestPath)
{
  if (resourcesDir.empty())
    return std::nullopt;

  // Drop any query string / fragment ("?v=1", "#frag").
  std::string path = requestPath;
  if (const auto cut = path.find_first_of("?#"); cut != std::string::npos)
    path.resize(cut);

  path = urlDecode(path);

  // Root document -> index.html; ensure a single leading slash.
  if (path.empty() || path == "/")
    path = "/index.html";
  else if (path.front() != '/')
    path.insert(path.begin(), '/');

  // Reject traversal outside the resources dir (defence in depth — the origin is
  // ours, but never let a crafted path escape the sandbox).
  if (path.find("..") != std::string::npos)
    return std::nullopt;

  std::ifstream file(resourcesDir + path, std::ios::binary);
  if (!file)
    return std::nullopt;

  choc::ui::WebView::Options::Resource resource;
  resource.data.assign(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
  resource.mimeType = mimeTypeForPath(path);
  return resource;
}

}  // namespace myplugin
