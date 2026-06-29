#pragma once

// CDPSampler — a small, framework-agnostic polyphonic one-shot sampler.
//
// This is the single source of truth for the CDP sampler DSP, shared by:
//   - the iPlug2 CDPlugin (C++, included directly — see CDPlugin_DSP.h), and
//   - the cdp-web standalone app (compiled to WASM and run in an
//     AudioWorklet — see src/cdp_sampler_wasm.cpp).
//
// It owns the whole instrument: a fixed voice pool, note routing / voice
// allocation, and 4-point cubic-Hermite (Catmull-Rom) interpolation. It has NO
// dependency on iPlug2 (its MidiSynth / VoiceAllocator were the inspiration, not
// a dependency) and no heap allocation of its own — the caller owns the sample
// memory and only passes a borrowed planar pointer.
//
// Pitch convention: MIDI note 60 plays the sample at native speed; each semitone
// is a 2^(1/12) playback-rate step, then scaled by sampleRate / hostRate.
// One-shot: noteOff does not stop a voice; it rings to the sample's end.

#include <cmath>
#include <cstdint>
#include <algorithm>

namespace cdp {

// 4-point, 3rd-order Catmull-Rom (cubic Hermite). xm1..x2 are the samples at
// positions i-1, i, i+1, i+2; t is the fractional offset in [0,1) between x0/x1.
inline double CubicHermite(double xm1, double x0, double x1, double x2, double t)
{
  const double a = -0.5 * xm1 + 1.5 * x0 - 1.5 * x1 + 0.5 * x2;
  const double b = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
  const double c = -0.5 * xm1 + 0.5 * x1;
  return ((a * t + b) * t + c) * t + x0;
}

class Sampler
{
public:
  static constexpr int kMaxVoices = 64;
  static constexpr int kRootKey = 60;   // MIDI note that plays at native pitch/speed

  void Init(int numVoices, double hostSampleRate)
  {
    mNumVoices = std::max(1, std::min(numVoices, kMaxVoices));
    mHostSampleRate = hostSampleRate > 0.0 ? hostSampleRate : 44100.0;
    AllNotesOff();
  }

  void SetHostSampleRate(double sr) { if (sr > 0.0) mHostSampleRate = sr; }

  // Borrow a planar sample: channel c starts at planar + c * numFrames. Pass
  // planar == nullptr to clear. Resets all voices so none reads a stale buffer.
  void SetSample(const float* planar, int numChans, int numFrames, double sampleRate)
  {
    AllNotesOff();
    if (planar == nullptr || numChans < 1 || numFrames < 2)
    {
      mSample = nullptr; mNumChans = 0; mNumFrames = 0;
      return;
    }
    mSample = planar;
    mNumChans = numChans;
    mNumFrames = numFrames;
    mSampleRate = sampleRate > 0.0 ? sampleRate : 44100.0;
  }

  void NoteOn(int note, int velocity)
  {
    if (mSample == nullptr) return;
    Voice& v = Allocate();
    v.active = true;
    v.gate = true;
    v.note = note;
    v.pos = 0.0;
    v.level = (float) (std::max(1, std::min(velocity, 127)) / 127.0);
    v.baseRatio = std::exp2((note - (double) kRootKey) / 12.0);
    v.env = 0.0;
    v.stage = kAttack;
    v.relRate = 0.0;
    v.age = ++mAgeCounter;
  }

  // Note-off opens the release segment: the voice fades out over Release seconds
  // (or stops at the sample's end, whichever comes first).
  void NoteOff(int note)
  {
    for (int i = 0; i < mNumVoices; i++)
    {
      Voice& v = mVoices[i];
      if (v.active && v.gate && v.note == note)
      {
        v.gate = false;
        v.stage = kRelease;
        v.relRate = v.env / std::max(mRelease * mHostSampleRate, 1.0);
      }
    }
  }

  void AllNotesOff()
  {
    for (int i = 0; i < kMaxVoices; i++) mVoices[i] = Voice{};
  }

  // --- performance / sampler controls (shared by plugin + worklet) ----------
  void SetADSR(double attack, double decay, double sustain, double release)
  {
    mAttack = std::max(0.0, attack);
    mDecay = std::max(0.0, decay);
    mSustain = std::min(std::max(sustain, 0.0), 1.0);
    mRelease = std::max(0.0, release);
  }
  void SetPitchBend(double semitones) { mBendSemis = semitones; }                 // signed
  void SetModWheel(double amount01) { mMod = std::min(std::max(amount01, 0.0), 1.0); }
  void SetVibrato(double rateHz, double maxDepthSemis)
  {
    if (rateHz > 0.0) mLfoRateHz = rateHz;
    mMaxVibratoSemis = std::max(0.0, maxDepthSemis);
  }

  // Render numFrames into planar output channels, OVERWRITING them (zero then
  // accumulate every active voice). Templated so the same code serves the
  // plugin (sample == double) and the WASM worklet (float).
  template <typename T>
  void Process(T** outputs, int numChans, int numFrames)
  {
    for (int c = 0; c < numChans; c++)
      for (int s = 0; s < numFrames; s++)
        outputs[c][s] = (T) 0;

    if (mSample == nullptr) return;

    const int lastFrame = mNumFrames - 1;
    const double srRatio = mSampleRate / mHostSampleRate;
    const double twoPi = 2.0 * 3.14159265358979323846;
    const double lfoInc = twoPi * mLfoRateHz / mHostSampleRate;
    const double aInc = 1.0 / std::max(mAttack * mHostSampleRate, 1.0);
    const double dInc = (1.0 - mSustain) / std::max(mDecay * mHostSampleRate, 1.0);
    const double vibDepth = mMod * mMaxVibratoSemis;

    for (int s = 0; s < numFrames; s++)
    {
      // One global pitch multiplier per sample (bend + LFO vibrato), shared by
      // every voice — one exp2 per sample rather than per voice.
      const double vib = vibDepth * std::sin(mLfoPhase);
      const double mult = std::exp2((mBendSemis + vib) / 12.0);
      mLfoPhase += lfoInc;
      if (mLfoPhase >= twoPi) mLfoPhase -= twoPi;

      for (int vi = 0; vi < mNumVoices; vi++)
      {
        Voice& v = mVoices[vi];
        if (!v.active) continue;
        if (v.pos >= (double) lastFrame) { v.active = false; continue; }

        const int i0 = (int) v.pos;
        const double frac = v.pos - i0;
        const int im1 = (i0 > 0) ? i0 - 1 : 0;
        const int ip1 = (i0 + 1 <= lastFrame) ? i0 + 1 : lastFrame;
        const int ip2 = (i0 + 2 <= lastFrame) ? i0 + 2 : lastFrame;

        const double amp = v.env * v.level;
        for (int c = 0; c < numChans; c++)
        {
          const int sc = (mNumChans <= 1) ? 0 : std::min(c, mNumChans - 1);
          const float* pCh = mSample + (size_t) sc * mNumFrames;
          const double val = CubicHermite(pCh[im1], pCh[i0], pCh[ip1], pCh[ip2], frac);
          outputs[c][s] += (T) (val * amp);
        }

        v.pos += v.baseRatio * mult * srRatio;

        // Advance the amplitude envelope one sample.
        switch (v.stage)
        {
          case kAttack:  v.env += aInc; if (v.env >= 1.0) { v.env = 1.0; v.stage = kDecay; } break;
          case kDecay:   v.env -= dInc; if (v.env <= mSustain) { v.env = mSustain; v.stage = kSustain; } break;
          case kSustain: v.env = mSustain; break;
          case kRelease: v.env -= v.relRate; if (v.env <= 0.0) { v.env = 0.0; v.active = false; } break;
        }
      }
    }
  }

private:
  enum Stage { kAttack, kDecay, kSustain, kRelease };
  struct Voice
  {
    bool active = false;
    bool gate = false;
    int note = 60;
    double pos = 0.0;
    double baseRatio = 1.0;   // 2^((note-60)/12), fixed at note-on
    float level = 1.0f;       // velocity 0..1
    double env = 0.0;         // ADSR amplitude 0..1
    Stage stage = kAttack;
    double relRate = 0.0;     // per-sample release decrement (set at note-off)
    uint32_t age = 0;
  };

  // Prefer a free voice; otherwise steal the oldest (smallest age).
  Voice& Allocate()
  {
    int oldest = 0;
    for (int i = 0; i < mNumVoices; i++)
    {
      if (!mVoices[i].active) return mVoices[i];
      if (mVoices[i].age < mVoices[oldest].age) oldest = i;
    }
    return mVoices[oldest];
  }

  Voice mVoices[kMaxVoices];
  int mNumVoices = 16;
  uint32_t mAgeCounter = 0;

  const float* mSample = nullptr;   // borrowed planar PCM (caller-owned)
  int mNumChans = 0;
  int mNumFrames = 0;
  double mSampleRate = 44100.0;
  double mHostSampleRate = 44100.0;

  // ADSR (seconds / 0..1 sustain). Default = tiny attack + short release: a
  // click-free one-shot that still honours note-off.
  double mAttack = 0.005, mDecay = 0.0, mSustain = 1.0, mRelease = 0.05;

  // Pitch bend (semitones) + mod-wheel vibrato LFO.
  double mBendSemis = 0.0;
  double mMod = 0.0;            // mod wheel 0..1
  double mLfoPhase = 0.0;
  double mLfoRateHz = 5.0;
  double mMaxVibratoSemis = 0.5;
};

} // namespace cdp
