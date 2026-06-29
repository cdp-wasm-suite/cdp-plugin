#pragma once

// Shared JS->C++ message dispatch for the desktop WebView backends
// (composers_desktop_plugin_editor_mac.mm / composers_desktop_plugin_editor_win.cpp).
//
// The CDP web app (cdp-web) talks to the native host through a single injected
// global, window.IPlugSendMsg(obj) — a legacy iPlug2 convention the vendored web
// bundle still uses. We expose it via CHOC's WebView::bind("IPlugSendMsg", ...) and
// route each message here. Message families, discriminated by obj.msg:
//
//   'SPVFUI'  Send Parameter Value From UI: { paramIdx, value } — value NORMALIZED
//               0..1. Denormalized here (against parameterInfo's min/max) and applied
//               through the EditorHost so the host records automation.
//   'BPCFUI'  Begin Parameter Change From UI: { paramIdx } — begins a host gesture
//               and suppresses host->UI pushes for that index while the user drags.
//   'EPCFUI'  End Parameter Change From UI: { paramIdx } — ends the gesture.
//   'SAMFUI'  streamed sample, header -> chunks -> end (obj.msgTag 0/1/2):
//               msgTag 0 (header): obj.data = base64 of Int32Array[sampleRate,
//                                  numChans, numFrames] (12 bytes)
//               msgTag 1 (chunk):  obj.data = base64 of <=64 KiB of planar
//                                  little-endian Float32 PCM; obj.ctrlTag = ordinal
//               msgTag 2 (end):    obj.data = '' — finalize and hand to the sampler
//   'SMMFUI'  raw 3-byte MIDI from the web keyboard:
//               { statusByte, dataByte1, dataByte2 }, channel 0
//
// This matches the stock iPlug2 WebView parameter protocol (SPVFUI/BPCFUI/EPCFUI
// up, SPVFD down — see IPlugWebViewEditorDelegate). The host->UI direction (SPVFD)
// is emitted by the platform backends' poll timer, not here.
//
// The param cases need editor-scoped state (the host channel + the per-index
// "user is dragging" flags), which the backend passes in as an EditorBridgeContext.
//
// All functions are inline; only one backend is compiled per platform, so there
// are no ODR concerns between them.

#include "composers_desktop_plugin.h"

#include <choc/containers/choc_Value.h>
#include <choc/memory/choc_Base64.h>

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace myplugin
{

// The web app's EMsgTags for the SAMFUI sample stream (must match player.js).
enum : int
{
  kMsgTagSampleHeader = 0,
  kMsgTagSampleChunk  = 1,
  kMsgTagSampleEnd    = 2
};

// Editor-scoped state the parameter messages need, supplied by the platform
// backend per dispatch. `host` is the upward channel to the DAW (null in formats
// that don't provide one — SPVFUI then falls back to a direct value write). The
// `editing` flags mirror iPlug2's per-parameter "is the user dragging" state so a
// concurrent host->UI push doesn't fight an in-progress drag.
struct EditorBridgeContext
{
  mplug::EditorHost* host = nullptr;
  bool* editing = nullptr;
  std::size_t editingCount = 0;
  bool* webReady = nullptr;  // set true when the web app signals SUIRDY (UI ready)
};

// Linear map between a parameter's plain value (the units getParameterValue uses)
// and the 0..1 normalized value that crosses the iPlug2 bridge. Our parameters are
// all plain linear ranges, so a straight lerp against parameterInfo's min/max is
// exact; a degenerate range collapses to 0.
inline double normalizeParam(std::size_t index, double plainValue)
{
  const auto info = ComposersDesktopPlugin::parameterInfo(index);
  const double span = info.maxValue - info.minValue;
  return span != 0.0 ? (plainValue - info.minValue) / span : 0.0;
}

inline double denormalizeParam(std::size_t index, double normalizedValue)
{
  const auto info = ComposersDesktopPlugin::parameterInfo(index);
  return info.minValue + normalizedValue * (info.maxValue - info.minValue);
}

// Read an integer member with a fallback (choc getWithDefault only covers a
// handful of arithmetic types; int64 -> int is fine for our small values).
inline int intMember(const choc::value::ValueView& obj, std::string_view name, int fallback)
{
  if (obj.isObject() && obj.hasObjectMember(name))
  {
    const auto member = obj[name];
    if (member.isInt() || member.isFloat() || member.isBool())
      return static_cast<int>(member.getWithDefault<int64_t>(fallback));
  }
  return fallback;
}

// Dispatch one IPlugSendMsg(obj) call onto the plugin. Called on the UI/message
// thread (the CHOC binding thread), where allocation is allowed.
inline void handleIPlugSendMsg(ComposersDesktopPlugin& plugin, const choc::value::ValueView& obj,
                               const EditorBridgeContext& ctx)
{
  if (!obj.isObject() || !obj.hasObjectMember("msg"))
    return;

  const std::string msg = obj["msg"].getWithDefault<std::string>("");

  if (msg == "SUIRDY")
  {
    // UI ready: the web app has defined its host->UI globals (SPVFD/CDPLoadGraph)
    // and registered its handlers. Only now is it safe to push initial state — the
    // WebView page-load races the editor poll timer, so pushing earlier is dropped.
    if (ctx.webReady)
      *ctx.webReady = true;
  }
  else if (msg == "SPVFUI")
  {
    // Send Parameter Value From UI: normalized 0..1 -> plain, then apply.
    const auto index = static_cast<std::size_t>(intMember(obj, "paramIdx", -1));
    if (index < ComposersDesktopPlugin::parameterCount() && obj.hasObjectMember("value"))
    {
      const double normalized = obj["value"].getWithDefault<double>(0.0);
      const double plain = denormalizeParam(index, normalized);
      if (ctx.host)
        ctx.host->performParameterEdit(index, plain);
      else
        plugin.setParameterValue(index, plain);
    }
  }
  else if (msg == "BPCFUI")
  {
    // Begin Parameter Change From UI: open a host gesture + suppress echo-back.
    const auto index = static_cast<std::size_t>(intMember(obj, "paramIdx", -1));
    if (index < ComposersDesktopPlugin::parameterCount())
    {
      if (index < ctx.editingCount)
        ctx.editing[index] = true;
      if (ctx.host)
        ctx.host->beginParameterGesture(index);
    }
  }
  else if (msg == "EPCFUI")
  {
    // End Parameter Change From UI.
    const auto index = static_cast<std::size_t>(intMember(obj, "paramIdx", -1));
    if (index < ComposersDesktopPlugin::parameterCount())
    {
      if (ctx.host)
        ctx.host->endParameterGesture(index);
      if (index < ctx.editingCount)
        ctx.editing[index] = false;
    }
  }
  else if (msg == "SPXFUI")
  {
    // Set Patch (graph) state From UI: the web app's serialized node graph, pushed
    // on every edit in plugin mode. Shadowed so saveCustomState() can persist it.
    if (obj.hasObjectMember("data"))
      plugin.setGraphState(obj["data"].getWithDefault<std::string>(""));
  }
  else if (msg == "SAMFUI")
  {
    const int msgTag = intMember(obj, "msgTag", -1);
    const std::string data = obj.hasObjectMember("data")
      ? obj["data"].getWithDefault<std::string>("")
      : std::string{};

    std::vector<std::uint8_t> bytes;
    if (!data.empty() && !choc::base64::decodeToContainer(bytes, data))
      return;  // malformed base64 — drop the message

    switch (msgTag)
    {
      case kMsgTagSampleHeader:
      {
        // 3 x int32 little-endian: sampleRate, numChans, numFrames.
        if (bytes.size() >= 3 * sizeof(std::int32_t))
        {
          std::int32_t header[3];
          std::memcpy(header, bytes.data(), sizeof(header));
          plugin.beginSampleUpload(header[0], header[1], header[2]);
        }
        break;
      }
      case kMsgTagSampleChunk:
        plugin.appendSampleChunk(bytes.data(), bytes.size());
        break;
      case kMsgTagSampleEnd:
        plugin.commitSampleUpload();
        break;
      default:
        break;
    }
  }
  else if (msg == "SMMFUI")
  {
    const int status = intMember(obj, "statusByte", 0);
    const int data1 = intMember(obj, "dataByte1", 0);
    const int data2 = intMember(obj, "dataByte2", 0);
    plugin.enqueueWebMidi(static_cast<std::uint8_t>(status),
                          static_cast<std::uint8_t>(data1),
                          static_cast<std::uint8_t>(data2));
  }
}

}  // namespace myplugin
