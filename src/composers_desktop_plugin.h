#pragma once

#include <mplug/mplug.h>
#include <mplug/mplug_dsp.h>
#include <mplug/mplug_editor_host.h>

#include <choc/containers/choc_SingleReaderSingleWriterFIFO.h>
#include <choc/containers/choc_Value.h>
#include <choc/memory/choc_Base64.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

// The shared CDP sampler DSP core: a framework-agnostic, header-only polyphonic
// one-shot sampler (voice pool, voice allocation, cubic-Hermite interpolation),
// vendored from the @olilarkin/cdp-sampler repo so the plugin and the cdp-web
// AudioWorklet run byte-identical code.
#include "cdp-sampler/CDPSampler.h"

// A MIDI note-triggered polyphonic sampler. The GUI is the CDP web app
// (cdp-web) running in the WebView editor: it renders audio offline, then
// streams the finished PCM buffer to this class over the JS->C++ bridge (see
// composers_desktop_plugin_editor_bridge.h). The buffer is played back as a
// pitched sampler under MIDI control — both host MIDI (delivered to process() as
// a MidiEventsView) and the web app's on-screen keyboard (delivered on the
// message thread via enqueueWebMidi()).
class ComposersDesktopPlugin
{
public:
  ComposersDesktopPlugin()
  {
    // Fix the lock-free queue capacities before any thread touches them. Done in
    // the constructor (not prepare()) because the editor can start streaming a
    // sample as soon as it opens, which may be before the host calls prepare().
    mIncoming.reset(8);
    mRetire.reset(32);
    mWebMidi.reset(256);
  }

  ~ComposersDesktopPlugin()
  {
    // Processing has stopped; free every buffer we still own (in-flight, retired,
    // current, and any partial upload).
    SampleBuffer* buf = nullptr;
    while (mIncoming.pop(buf)) delete buf;
    while (mRetire.pop(buf)) delete buf;
    delete mpCurrent;
    delete mStaging;
    delete mStateBuffer.exchange(nullptr);  // any state-restored buffer not yet adopted
  }

  ComposersDesktopPlugin(const ComposersDesktopPlugin&) = delete;
  ComposersDesktopPlugin& operator=(const ComposersDesktopPlugin&) = delete;

  // --- Metadata --------------------------------------------------------------
  static constexpr std::string_view name() { return "Composer's Desktop Plug-in"; }

  // --- This is a MIDI instrument (no audio input, stereo out, MIDI in) --------
  static constexpr bool processesMidi() { return true; }

  static constexpr std::size_t inputBusCount() { return 0; }
  static constexpr std::size_t outputBusCount() { return 1; }

  static constexpr mplug::BusInfo inputBusInfo(std::size_t /*index*/)
  {
    return {};
  }

  static constexpr mplug::BusInfo outputBusInfo(std::size_t index)
  {
    if (index == 0) return {"Output", 2, mplug::BusType::Main};
    return {};
  }

  // --- Parameters ------------------------------------------------------------
  // Output gain plus the amplitude-envelope ADSR. The ADSR ranges match the CDP
  // web app's on-screen faders 1:1 (A/D/R 0..2 s, S 0..1), so the web keyboard's
  // envelope controls map straight onto these parameters with no rescaling.
  enum ParamIndex : std::size_t
  {
    kParamGain = 0,
    kParamAttack,
    kParamDecay,
    kParamSustain,
    kParamRelease,
    kNumParams
  };

  static constexpr std::size_t parameterCount() { return kNumParams; }

  static constexpr mplug::ParameterInfo parameterInfo(std::size_t index)
  {
    switch (index)
    {
      case kParamGain:
        // Master volume in dB, matching the CDP web app's VOL fader: -60..0 dB
        // with -12 dB default (head-room for summed polyphony). -60 dB = silence.
        return {
          .name = "Gain", .shortName = "Gain",
          .minValue = -60.0, .maxValue = 0.0, .defaultValue = -12.0,
          .flags = mplug::ParameterFlags::Automatable,
          .unit = mplug::ParameterUnit::Decibels
        };
      case kParamAttack:
        return {
          .name = "Attack", .shortName = "Atk",
          .minValue = 0.0, .maxValue = 2.0, .defaultValue = 0.005,
          .flags = mplug::ParameterFlags::Automatable,
          .unit = mplug::ParameterUnit::Seconds
        };
      case kParamDecay:
        return {
          .name = "Decay", .shortName = "Dcy",
          .minValue = 0.0, .maxValue = 2.0, .defaultValue = 0.0,
          .flags = mplug::ParameterFlags::Automatable,
          .unit = mplug::ParameterUnit::Seconds
        };
      case kParamSustain:
        return {
          .name = "Sustain", .shortName = "Sus",
          .minValue = 0.0, .maxValue = 1.0, .defaultValue = 1.0,
          .flags = mplug::ParameterFlags::Automatable,
          .unit = mplug::ParameterUnit::Generic
        };
      case kParamRelease:
        return {
          .name = "Release", .shortName = "Rel",
          .minValue = 0.0, .maxValue = 2.0, .defaultValue = 0.05,
          .flags = mplug::ParameterFlags::Automatable,
          .unit = mplug::ParameterUnit::Seconds
        };
      default:
        return {};
    }
  }

  // --- Latency reporting -----------------------------------------------------
  // The sampler introduces no processing latency.
  static constexpr std::uint32_t latency() { return 0; }

  // --- Editor ----------------------------------------------------------------
  static constexpr bool hasEditor() { return true; }
  static constexpr mplug::EditorSize defaultEditorSize() { return {1024, 768}; }

  // Host-driven resizing. The framework reports these to each format (VST3
  // canResize/checkSizeConstraint, CLAP gui resize hints/adjust, App window,
  // AU Cocoa view) and clamps host-proposed sizes to the min/max below.
  static constexpr bool editorResizable() { return true; }
  static constexpr mplug::EditorSize editorMinSize() { return {640, 480}; }

  // Called on the UI thread after the host resizes the editor view, so the
  // WebView can be re-fitted to the new bounds. Implemented per-platform in the
  // editor backends (no-op on platforms without an in-host WebView).
  void onEditorResize(int width, int height);

  // Optional hook: the host reports the display's DPI scale factor (Windows only
  // in practice). Stored so the Windows editor can size its native child window in
  // physical pixels; macOS/Linux window APIs are logical, so the host leaves this at
  // 1.0 there. The mplug format wrappers call this before createEditor() when supported.
  void setEditorScale(float scale) { mEditorScale = scale; }

  // The editor loads the CDP web app (the node-graph patcher UI). By default it's
  // served from bundled assets in Contents/Resources/web via CHOC's in-process web
  // server (see composers_desktop_plugin_editor_resources.h). This URL is the
  // cdp-web dev server, used only as a fallback (when the bundled assets are
  // missing) or when the plugin is configured with the CMake option
  // -DMY_PLUGIN_EDITOR_DEV_SERVER=ON for live-reload development — run
  // `node serve.mjs` from /Users/oli/Dev/cdp-web to serve the app at the root.
  static constexpr std::string_view editorURL() { return "http://localhost:8000/"; }

  void* createEditor(void* parentView, mplug::WindowType windowType);
  void destroyEditor();

  // Optional hook: the format wrapper hands us an upward channel to the host
  // just before createEditor(). The editor uses it to record parameter gestures
  // and to receive host-originated parameter changes. Wrappers that don't
  // support it never call this, leaving mEditorHost null (editor falls back to
  // direct setParameterValue — audio updates, no automation).
  void setEditorHost(mplug::EditorHost* host) { mEditorHost = host; }

  // --- Lifecycle -------------------------------------------------------------
  void prepare(double sampleRate, int maxBlockSize)
  {
    mSampleRate = sampleRate;
    mMaxBlockSize = maxBlockSize;
    initSampler(sampleRate);
  }

  void reset()
  {
    initSampler(mSampleRate);
  }

  // --- Audio processing ------------------------------------------------------
  // MIDI-capable overload: host MIDI arrives as a sample-offset-ordered span.
  void process(mplug::AudioInputsView /*inputs*/, mplug::AudioOutputsView outputs, mplug::MidiEventsView midi) noexcept
  {
    const auto numFrames = static_cast<int>(outputs.getNumFrames());
    const auto numChans = static_cast<int>(outputs.getNumChannels());

    // Push the (possibly host-automated) ADSR into the sampler for this block.
    applyEnvelopeParams();

    // A buffer restored from plugin state (loadCustomState) is handed over on the
    // main thread via an atomic; adopt it so playback works even headless (project
    // reload / offline bounce with the editor never opened). Treated exactly like a
    // freshly streamed buffer below.
    if (SampleBuffer* fromState = mStateBuffer.exchange(nullptr, std::memory_order_acquire))
    {
      SampleBuffer* old = mpCurrent;
      mpCurrent = fromState;
      mSampler.SetSample(mpCurrent->data.data(), mpCurrent->numChans, mpCurrent->numFrames, mpCurrent->sampleRate);
      if (old)
        mRetire.push(old);
    }

    // Adopt the most recent streamed buffer; retire any older ones we skip past.
    // SetSample() first (it kills all voices, so nothing references the old
    // buffer), then it is safe to hand the old buffer to the retire queue for the
    // message thread to free.
    SampleBuffer* incoming = nullptr;
    SampleBuffer* newest = nullptr;
    while (mIncoming.pop(incoming))
    {
      if (newest)
        mRetire.push(newest);
      newest = incoming;
    }
    if (newest)
    {
      SampleBuffer* old = mpCurrent;
      mpCurrent = newest;
      mSampler.SetSample(mpCurrent->data.data(), mpCurrent->numChans, mpCurrent->numFrames, mpCurrent->sampleRate);
      if (old)
        mRetire.push(old);
    }

    // Web-keyboard notes queued on the message thread, then host MIDI. Triggering
    // is block-accurate (fine for one-shot playback); sample offsets are ignored.
    mplug::MidiEvent webEvent;
    while (mWebMidi.pop(webEvent))
      handleMidiEvent(webEvent);

    for (const auto& event : midi)
      handleMidiEvent(event);

    // Render: cdp::Sampler wants a planar float** and overwrites the outputs.
    std::array<float*, kMaxChannels> channelPtrs{};
    const int renderChans = std::min(numChans, static_cast<int>(kMaxChannels));
    for (int ch = 0; ch < renderChans; ++ch)
      channelPtrs[ch] = outputs.getChannel(static_cast<std::size_t>(ch)).data.data;

    mSampler.Process<float>(channelPtrs.data(), renderChans, numFrames);

    // Master volume: dB -> linear (atomic load for thread-safe UI reads). Treat
    // the bottom of travel as true silence, matching the web VOL fader.
    const double gainDb = mGainDb.load(std::memory_order_relaxed);
    const float gain = (gainDb <= -60.0) ? 0.0f : static_cast<float>(mplug::dsp::dbToLinear(gainDb));
    for (int ch = 0; ch < renderChans; ++ch)
    {
      float* out = channelPtrs[ch];
      for (int i = 0; i < numFrames; ++i)
        out[i] *= gain;
    }
  }

  // Non-MIDI overload required by the base Plugin concept: delegate with no events.
  void process(mplug::AudioInputsView inputs, mplug::AudioOutputsView outputs) noexcept
  {
    process(inputs, outputs, {});
  }

  // --- Sample streaming (message thread; called from the editor bridge) ------
  // The web app streams a freshly rendered planar-float buffer as header -> chunks
  // -> end. These run on the UI/message thread, where allocation is allowed; the
  // finished buffer is handed to the audio thread through a lock-free queue.
  void beginSampleUpload(int sampleRate, int numChans, int numFrames)
  {
    // Free any buffers the audio thread has retired (message thread is the only
    // place we delete, so process() never frees on the RT thread).
    drainRetired();

    delete mStaging;  // discard any incomplete previous transfer
    mStaging = nullptr;
    mStagingBytePos = 0;
    mStagingTotalBytes = 0;

    if (numChans > 0 && numFrames > 0)
    {
      mStaging = new SampleBuffer();
      mStaging->numChans = numChans;
      mStaging->numFrames = numFrames;
      mStaging->sampleRate = static_cast<double>(sampleRate);
      mStaging->data.resize(static_cast<std::size_t>(numChans) * static_cast<std::size_t>(numFrames));
      mStagingTotalBytes = static_cast<std::size_t>(numChans) * static_cast<std::size_t>(numFrames) * sizeof(float);
    }
  }

  void appendSampleChunk(const std::uint8_t* bytes, std::size_t numBytes)
  {
    if (mStaging == nullptr || bytes == nullptr || numBytes == 0)
      return;

    const std::size_t remaining = mStagingTotalBytes - mStagingBytePos;
    const std::size_t n = std::min(numBytes, remaining);
    if (n > 0)
    {
      std::memcpy(reinterpret_cast<std::uint8_t*>(mStaging->data.data()) + mStagingBytePos, bytes, n);
      mStagingBytePos += n;
    }
  }

  void commitSampleUpload()
  {
    if (mStaging == nullptr)
      return;

    // Keep a main-thread copy of the finished buffer so saveCustomState() (which
    // runs on the main thread and can't touch the audio thread's mpCurrent) can
    // serialize the current rendered audio into plugin state.
    mSavedBuffer = std::make_shared<SampleBuffer>(*mStaging);

    // Hand the finished buffer to the audio thread. If the queue is full, retire
    // it straight away so it is freed (on this thread) rather than leaked.
    if (!mIncoming.push(mStaging))
      mRetire.push(mStaging);
    mStaging = nullptr;
    mStagingBytePos = 0;
    mStagingTotalBytes = 0;
  }

  // Web-keyboard MIDI (message thread): decode a raw 3-byte message into a
  // mplug::MidiEvent and queue it for the audio thread.
  void enqueueWebMidi(std::uint8_t status, std::uint8_t data1, std::uint8_t data2)
  {
    const std::uint8_t type = status & 0xF0;
    const std::uint8_t channel = status & 0x0F;
    const std::uint8_t d1 = data1 & 0x7F;
    const std::uint8_t d2 = data2 & 0x7F;

    switch (type)
    {
      case 0x90:  // Note On (velocity 0 == Note Off)
        mWebMidi.push(mplug::MidiEvent::noteOn(channel, d1, d2 / 127.0f));
        break;
      case 0x80:  // Note Off
        mWebMidi.push(mplug::MidiEvent::noteOff(channel, d1, d2 / 127.0f));
        break;
      case 0xB0:  // Control Change
        mWebMidi.push(mplug::MidiEvent::controlChange(channel, d1, d2 / 127.0f));
        break;
      case 0xE0:  // Pitch Bend (14-bit, centre = 8192)
      {
        const int value14 = (static_cast<int>(d2) << 7) | static_cast<int>(d1);
        const float normalized = static_cast<float>((value14 - 8192) / 8192.0);
        mWebMidi.push(mplug::MidiEvent::pitchBendEvent(channel, normalized));
        break;
      }
      default:
        break;
    }
  }

  // Message thread: free buffers retired by the audio thread. Called from the
  // upload path and (as a backstop) from the editor poll timer.
  void drainRetired()
  {
    SampleBuffer* buf = nullptr;
    while (mRetire.pop(buf))
      delete buf;
  }

  // --- Graph state (message/UI thread; called from the editor bridge) --------
  // The CDP web app's node graph is its "document". In plugin mode the web app
  // pushes its serialized graph JSON here (SPXFUI) on every edit; we shadow it so
  // saveCustomState() (synchronous, main thread) can write it without a round-trip.
  void setGraphState(std::string json)
  {
    std::lock_guard<std::mutex> lock(mGraphMutex);
    mGraphState = std::move(json);
  }

  // Editor poll timer: if a state-restored graph is waiting to be pushed to the UI,
  // hand it over (once). Returns false when there's nothing pending.
  bool takePendingGraph(std::string& out)
  {
    std::lock_guard<std::mutex> lock(mGraphMutex);
    if (!mHasPendingGraph)
      return false;
    out = mPendingGraph;
    mPendingGraph.clear();
    mHasPendingGraph = false;
    return true;
  }

  // --- Parameter access (atomic for thread-safe UI reads) --------------------
  double getParameterValue(std::size_t index) const
  {
    switch (index)
    {
      case kParamGain:    return mGainDb.load(std::memory_order_relaxed);
      case kParamAttack:  return mAttack.load(std::memory_order_relaxed);
      case kParamDecay:   return mDecay.load(std::memory_order_relaxed);
      case kParamSustain: return mSustain.load(std::memory_order_relaxed);
      case kParamRelease: return mRelease.load(std::memory_order_relaxed);
      default:            return 0.0;
    }
  }

  void setParameterValue(std::size_t index, double value)
  {
    switch (index)
    {
      case kParamGain:    mGainDb.store(value, std::memory_order_relaxed); break;
      case kParamAttack:  mAttack.store(value, std::memory_order_relaxed); break;
      case kParamDecay:   mDecay.store(value, std::memory_order_relaxed); break;
      case kParamSustain: mSustain.store(value, std::memory_order_relaxed); break;
      case kParamRelease: mRelease.store(value, std::memory_order_relaxed); break;
      default: break;
    }
  }

  // --- State -----------------------------------------------------------------
  // Parameters (Gain + ADSR) are auto-serialized by mplug::serializeState. On top
  // of those we persist the "document": the CDP web app's node graph (shadowed via
  // setGraphState) and the current rendered audio buffer (mSavedBuffer, the buffer
  // the sampler plays). Persisting the audio means playback works headless — a
  // project reload / offline bounce with the editor never opened still makes sound.
  // Both hooks run on the main thread (host state/preset thread).
  choc::value::Value saveCustomState() const
  {
    auto state = choc::value::createObject("");

    {
      std::lock_guard<std::mutex> lock(mGraphMutex);
      state.addMember("graph", mGraphState);
    }

    if (mSavedBuffer && !mSavedBuffer->data.empty())
    {
      state.addMember("audioSampleRate", mSavedBuffer->sampleRate);
      state.addMember("audioNumChans", static_cast<int64_t>(mSavedBuffer->numChans));
      state.addMember("audioNumFrames", static_cast<int64_t>(mSavedBuffer->numFrames));
      // Planar float32 PCM, base64'd (choc has no byte type). ~4/3 size inflation.
      state.addMember("audio", choc::base64::encodeToString(
        mSavedBuffer->data.data(), mSavedBuffer->data.size() * sizeof(float)));
    }

    return state;
  }

  void loadCustomState(const choc::value::ValueView& state)
  {
    if (!state.isObject())
      return;

    // Graph: shadow it (so a later save round-trips even if the editor never opens)
    // and mark it pending so the editor poll timer pushes it to the UI on open.
    if (state.hasObjectMember("graph"))
    {
      std::string json = state["graph"].getWithDefault<std::string>("");
      std::lock_guard<std::mutex> lock(mGraphMutex);
      mGraphState = json;
      mPendingGraph = std::move(json);
      mHasPendingGraph = true;
    }

    // Audio: decode into a buffer and hand it to the audio thread for immediate
    // adoption (see process()); also keep the main-thread copy for re-saving.
    if (state.hasObjectMember("audio"))
    {
      const auto numChans = static_cast<int>(state["audioNumChans"].getWithDefault<int64_t>(0));
      const auto numFrames = static_cast<int>(state["audioNumFrames"].getWithDefault<int64_t>(0));
      const double sampleRate = state["audioSampleRate"].getWithDefault<double>(44100.0);
      const std::string b64 = state["audio"].getWithDefault<std::string>("");

      std::vector<std::uint8_t> bytes;
      if (numChans > 0 && numFrames > 0 && !b64.empty()
          && choc::base64::decodeToContainer(bytes, b64)
          && bytes.size() == static_cast<std::size_t>(numChans) * numFrames * sizeof(float))
      {
        auto buf = std::make_shared<SampleBuffer>();
        buf->numChans = numChans;
        buf->numFrames = numFrames;
        buf->sampleRate = sampleRate;
        buf->data.resize(static_cast<std::size_t>(numChans) * numFrames);
        std::memcpy(buf->data.data(), bytes.data(), bytes.size());
        mSavedBuffer = buf;

        // Hand a copy to the audio thread (single producer: the state thread).
        auto* forAudio = new SampleBuffer(*buf);
        delete mStateBuffer.exchange(forAudio, std::memory_order_release);
      }
    }
  }

private:
  static constexpr int kMaxChannels = 2;
  static constexpr int kNumVoices = 16;
  static constexpr double kBendRangeSemis = 2.0;  // +/- pitch-bend range

  // A finished, offline-rendered audio buffer handed over from the web UI. Stored
  // planar: channel c starts at data.data() + c * numFrames.
  struct SampleBuffer
  {
    std::vector<float> data;
    int numChans = 0;
    int numFrames = 0;
    double sampleRate = 44100.0;
  };

  void initSampler(double sampleRate)
  {
    // ADSR comes from the (automatable) parameters; the vibrato LFO is a fixed
    // 5 Hz, 0.5-semitone-max depth scaled by the mod wheel — matching the
    // cdp-web defaults so the plugin and the web preview sound identical.
    mSampler.Init(kNumVoices, sampleRate);
    applyEnvelopeParams();
    mSampler.SetVibrato(5.0, 0.5);
  }

  // Copy the ADSR parameter atomics into the sampler. Cheap (just clamps + stores
  // a few doubles), so it's fine to call every block from the audio thread.
  void applyEnvelopeParams() noexcept
  {
    mSampler.SetADSR(mAttack.load(std::memory_order_relaxed),
                     mDecay.load(std::memory_order_relaxed),
                     mSustain.load(std::memory_order_relaxed),
                     mRelease.load(std::memory_order_relaxed));
  }

  // Audio thread: route a decoded MIDI event into the shared sampler.
  void handleMidiEvent(const mplug::MidiEvent& event) noexcept
  {
    switch (event.type)
    {
      case mplug::MidiEvent::Type::NoteOn:
      {
        const int velocity = static_cast<int>(std::lround(event.note.velocity * 127.0f));
        if (velocity > 0)
          mSampler.NoteOn(event.note.note, velocity);
        else
          mSampler.NoteOff(event.note.note);
        break;
      }
      case mplug::MidiEvent::Type::NoteOff:
        mSampler.NoteOff(event.note.note);
        break;
      case mplug::MidiEvent::Type::PitchBend:
        mSampler.SetPitchBend(event.pitchBend.value * kBendRangeSemis);
        break;
      case mplug::MidiEvent::Type::ControlChange:
        if (event.control.controller == 1)  // Mod Wheel
          mSampler.SetModWheel(event.control.value);
        else if (event.control.controller == 123)  // All Notes Off
          mSampler.AllNotesOff();
        break;
      default:
        break;
    }
  }

  double mSampleRate = 44100.0;
  int mMaxBlockSize = 512;

  std::atomic<double> mGainDb{-12.0};  // Master volume, dB (default -12 dB)

  // Amplitude-envelope ADSR (seconds / 0..1 sustain). Defaults are the click-free
  // near-one-shot the sampler shipped with; the host/UI can now automate them.
  std::atomic<double> mAttack{0.005};
  std::atomic<double> mDecay{0.0};
  std::atomic<double> mSustain{1.0};
  std::atomic<double> mRelease{0.05};

  // The shared sampler DSP core.
  cdp::Sampler mSampler;

  // Lock-free handoff of rendered buffers: message thread -> audio thread
  // (mIncoming), audio thread -> message thread for freeing (mRetire).
  choc::fifo::SingleReaderSingleWriterFIFO<SampleBuffer*> mIncoming;
  choc::fifo::SingleReaderSingleWriterFIFO<SampleBuffer*> mRetire;
  SampleBuffer* mpCurrent = nullptr;  // audio thread only

  // Web-keyboard MIDI: message thread -> audio thread.
  choc::fifo::SingleReaderSingleWriterFIFO<mplug::MidiEvent> mWebMidi;

  // Sample reassembly staging (message thread only).
  SampleBuffer* mStaging = nullptr;
  std::size_t mStagingBytePos = 0;
  std::size_t mStagingTotalBytes = 0;

  // --- Persistable "document" state ------------------------------------------
  // Main-thread copy of the last rendered buffer, kept for saveCustomState (the
  // audio thread owns mpCurrent, which the main thread must not touch).
  std::shared_ptr<SampleBuffer> mSavedBuffer;

  // State-restored buffer handed to the audio thread (single producer: the state
  // thread; single consumer: process() via exchange). Adopted like a streamed one.
  std::atomic<SampleBuffer*> mStateBuffer{nullptr};

  // Shadowed node-graph JSON (the web app's document). mGraphState is the latest
  // from the UI (for saving); mPendingGraph is a state-restored graph waiting to be
  // pushed back to the UI. Guarded because the UI-message writer and the main-thread
  // saver/loader can differ by format. Mutable so saveCustomState() can lock it.
  mutable std::mutex mGraphMutex;
  std::string mGraphState;
  std::string mPendingGraph;
  bool mHasPendingGraph = false;

  // Opaque, platform-specific editor handle (managed in the editor sources).
  void* mEditorView = nullptr;

  // Upward channel to the host, supplied by the wrapper via setEditorHost().
  // Null when the active format/wrapper doesn't provide one.
  mplug::EditorHost* mEditorHost = nullptr;

  // Display DPI scale factor reported by the host (VST3 setContentScaleFactor /
  // CLAP gui set_scale). Used only by the Windows editor to size the native child
  // window in physical pixels; 1.0 (and unused) on macOS, where the OS handles HiDPI.
  float mEditorScale = 1.0f;
};

// Verify the plugin satisfies the MPlug Plugin concept at compile time.
static_assert(mplug::Plugin<ComposersDesktopPlugin>);
