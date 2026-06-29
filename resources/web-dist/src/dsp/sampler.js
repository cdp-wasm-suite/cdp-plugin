// Polyphonic sampler — plays the most recently rendered buffer as a pitched,
// MIDI-playable instrument driven by the on-screen keyboard (keyboard.js).
//
// It runs in one of two modes, decided high up (auto-detected, override-able):
//
//   standalone  — sound is made here, in the browser, via Web Audio.
//   plugin      — the page makes no sound; note on/off are forwarded as MIDI to
//                 the plugin's C++ engine (which owns the realtime audio path),
//                 exactly mirroring how player.js streams the rendered buffer.
//
// Pitch convention matches the C++ SamplerVoice (cdp-plugin DSP): MIDI note 60
// plays the sample at its native speed; every semitone is a 2^(1/12) rate step.
//
// Standalone DSP is the shared cubic-Hermite sampler compiled to WASM, run in an
// AudioWorklet (the same code the C++ plugin uses — see @olilarkin/cdp-sampler).
// An AudioBufferSourceNode voice pool stands in while the worklet loads and is
// the permanent fallback where AudioWorklet/WASM is unavailable. Engines share a
// tiny interface: { setSample, noteOn, noteOff, allNotesOff, dispose }.

import { wavToAudioBuffer } from '@olilarkin/cdp-wasm/wav';
import { forwardBufferToPlugin } from './player.js';

const ROOT_KEY = 60;           // MIDI note that plays the sample at native pitch
const MAX_VOICES = 16;         // standalone voice cap (oldest-stolen)
const BEND_RANGE = 2;          // ± pitch-bend range, semitones (matches the C++ plugin)
const MAX_VIB_SEMIS = 0.5;     // mod wheel at full = ±0.5 semitone vibrato
const MAX_VIB_CENTS = MAX_VIB_SEMIS * 100;
const MODE_KEY = 'cdp-web-sampler-mode';   // persisted high-level override
const REPITCH_KEY = 'cdp-web-sampler-repitch';   // persisted chromatic-repitch toggle (default off)
const WASM_URL = './node_modules/@olilarkin/cdp-sampler/wasm/cdp-sampler.wasm';
const PROCESSOR_URL = new URL('./sampler-processor.js', import.meta.url);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const inPlugin = () => typeof IPlugSendMsg === 'function';

// ---- standalone engine: AudioBufferSourceNode voice pool --------------------
// The fallback used while the WASM worklet loads (or where it's unavailable). It
// mirrors the worklet's features with native nodes: a shared pitch-bend offset
// and vibrato LFO feed every voice's detune; each voice has an ADSR gain.
function bufferSourceEngine(audioCtx, dest = audioCtx.destination) {
  const out = audioCtx.createGain();
  out.gain.value = 1;
  out.connect(dest);

  // Shared modulation, in cents, summed into each voice's detune param.
  const bend = audioCtx.createConstantSource(); bend.offset.value = 0; bend.start();
  const lfo = audioCtx.createOscillator(); lfo.frequency.value = 5; lfo.start();
  const lfoDepth = audioCtx.createGain(); lfoDepth.gain.value = 0; lfo.connect(lfoDepth);

  let buffer = null;
  let adsr = { a: 0.005, d: 0, s: 1, r: 0.05 };
  const voices = [];   // { note, src, g, gate } — oldest first

  function unwire(v) {
    try { bend.disconnect(v.src.detune); lfoDepth.disconnect(v.src.detune); } catch {}
  }
  function killVoice(v) {
    unwire(v);
    try { v.src.onended = null; v.src.stop(); } catch {}
    try { v.src.disconnect(); v.g.disconnect(); } catch {}
  }
  function drop(v) { const i = voices.indexOf(v); if (i >= 0) voices.splice(i, 1); }

  return {
    setSample(buf) { buffer = buf; this.allNotesOff(); },
    noteOn(note, vel = 100) {
      if (!buffer) return;
      audioCtx.resume();
      while (voices.length >= MAX_VOICES) { killVoice(voices[0]); voices.shift(); }
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.detune.value = (note - ROOT_KEY) * 100;   // cents; key 60 = native
      bend.connect(src.detune); lfoDepth.connect(src.detune);
      const g = audioCtx.createGain();
      const now = audioCtx.currentTime;
      const peak = clamp(vel / 127, 0, 1);
      const aEnd = now + Math.max(adsr.a, 0.001);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(peak, aEnd);                            // attack
      g.gain.linearRampToValueAtTime(peak * adsr.s, aEnd + Math.max(adsr.d, 0.001)); // decay→sustain
      src.connect(g).connect(out);
      const v = { note, src, g, gate: true };
      src.onended = () => { unwire(v); drop(v); };
      src.start();
      voices.push(v);
    },
    noteOff(note) {
      const now = audioCtx.currentTime;
      const r = Math.max(adsr.r, 0.001);
      for (const v of voices) {
        if (!v.gate || v.note !== note) continue;
        v.gate = false;
        try { v.g.gain.cancelAndHoldAtTime(now); } catch { v.g.gain.cancelScheduledValues(now); }
        v.g.gain.linearRampToValueAtTime(0, now + r);                        // release
        try { v.src.stop(now + r + 0.02); } catch {}
      }
    },
    allNotesOff() { while (voices.length) { killVoice(voices[0]); voices.shift(); } },
    pitchBend(norm) { bend.offset.setTargetAtTime(clamp(norm, -1, 1) * BEND_RANGE * 100, audioCtx.currentTime, 0.005); },
    modWheel(amt) { lfoDepth.gain.setTargetAtTime(clamp(amt, 0, 1) * MAX_VIB_CENTS, audioCtx.currentTime, 0.02); },
    setVibratoRate(hz) { if (hz > 0) lfo.frequency.setTargetAtTime(hz, audioCtx.currentTime, 0.02); },
    setADSR(a, d, s, r) { adsr = { a, d, s, r }; },
    dispose() { this.allNotesOff(); try { out.disconnect(); bend.stop(); lfo.stop(); } catch {} },
  };
}

// ---- AudioBuffer → planar Float32 (for the worklet / WASM heap) -------------
function audioBufferToPlanar(buf) {
  const chans = buf.numberOfChannels, frames = buf.length;
  const pcm = new Float32Array(chans * frames);
  for (let c = 0; c < chans; c++) pcm.set(buf.getChannelData(c), c * frames);
  return { pcm, chans, frames, sr: buf.sampleRate };
}

// ---- standalone engine: WASM AudioWorklet (shared cubic-Hermite DSP) ---------
// Spins up the worklet asynchronously; until it's ready (or if WASM/worklet is
// unavailable) it routes through the AudioBufferSourceNode pool above, which
// stays as the permanent fallback.
function standaloneEngine(audioCtx) {
  // Shared master gain → destination; both the worklet and the fallback feed it,
  // so one volume control tames the (head-room-free) summed polyphony.
  const master = audioCtx.createGain();
  master.gain.value = 0.251;   // ≈ -12 dB default; the keyboard's VOL control drives it
  master.connect(audioCtx.destination);

  const fallback = bufferSourceEngine(audioCtx, master);
  let active = fallback;     // current note target
  let worklet = null;        // upgraded engine once ready
  let pending = null;        // planar sample captured before the worklet was ready
  // Last control values, replayed into the worklet when it comes online.
  const ctl = { bend: 0, mod: 0, vib: 5, adsr: [0.005, 0, 1, 0.05] };

  (async () => {
    const bytes = await fetch(WASM_URL).then((r) => { if (!r.ok) throw new Error('wasm ' + r.status); return r.arrayBuffer(); });
    await audioCtx.audioWorklet.addModule(PROCESSOR_URL);
    const node = new AudioWorkletNode(audioCtx, 'cdp-sampler', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { wasmBytes: bytes, sampleRate: audioCtx.sampleRate, numVoices: MAX_VOICES },
    });
    node.connect(master);
    worklet = {
      setPlanar(s) { node.port.postMessage({ type: 'sample', chans: s.chans, frames: s.frames, sr: s.sr, pcm: s.pcm }, [s.pcm.buffer]); },
      noteOn(n, v) { audioCtx.resume(); node.port.postMessage({ type: 'noteOn', note: n, vel: v || 100 }); },
      noteOff(n) { node.port.postMessage({ type: 'noteOff', note: n }); },
      allNotesOff() { node.port.postMessage({ type: 'allOff' }); },
      pitchBend(norm) { node.port.postMessage({ type: 'pitchBend', semis: clamp(norm, -1, 1) * BEND_RANGE }); },
      modWheel(amt) { node.port.postMessage({ type: 'modWheel', amt: clamp(amt, 0, 1) }); },
      setVibratoRate(hz) { node.port.postMessage({ type: 'vibrato', rate: hz, depth: MAX_VIB_SEMIS }); },
      setADSR(a, d, s, r) { node.port.postMessage({ type: 'adsr', a, d, s, r }); },
      dispose() { try { node.disconnect(); } catch {} },
    };
    if (pending) { worklet.setPlanar(pending); pending = null; }
    worklet.setADSR(...ctl.adsr); worklet.pitchBend(ctl.bend); worklet.modWheel(ctl.mod); worklet.setVibratoRate(ctl.vib);
    fallback.allNotesOff();
    active = worklet;        // hand over; fallback goes idle
  })().catch(() => { /* no worklet/WASM — keep the AudioBufferSourceNode fallback */ });

  return {
    setSample(buf) {
      fallback.setSample(buf);                 // keep the fallback loaded too
      const planar = buf ? audioBufferToPlanar(buf) : null;
      if (worklet) { if (planar) worklet.setPlanar(planar); }
      else pending = planar;                   // hand to the worklet when it's ready
    },
    noteOn(n, v) { active.noteOn(n, v); },
    noteOff(n) { active.noteOff(n); },
    allNotesOff() { active.allNotesOff(); },
    setGain(v) { master.gain.setTargetAtTime(clamp(v, 0, 1), audioCtx.currentTime, 0.01); },
    // Controls go to whichever engine is live now and are remembered for the worklet.
    pitchBend(norm) { ctl.bend = norm; fallback.pitchBend(norm); worklet?.pitchBend(norm); },
    modWheel(amt) { ctl.mod = amt; fallback.modWheel(amt); worklet?.modWheel(amt); },
    setVibratoRate(hz) { ctl.vib = hz; fallback.setVibratoRate(hz); worklet?.setVibratoRate(hz); },
    setADSR(a, d, s, r) { ctl.adsr = [a, d, s, r]; fallback.setADSR(a, d, s, r); worklet?.setADSR(a, d, s, r); },
    dispose() { fallback.dispose(); worklet?.dispose?.(); try { master.disconnect(); } catch {} },
  };
}

// ---- plugin engine: forward MIDI to the C++ host ----------------------------
// Uses the same IPlugSendMsg bridge as player.js. Status bytes are channel 0.
function pluginEngine() {
  const send = (status, d1, d2) => {
    if (!inPlugin()) return;
    try { IPlugSendMsg({ msg: 'SMMFUI', statusByte: status, dataByte1: d1 & 0x7f, dataByte2: d2 & 0x7f }); } catch {}
  };
  const sounding = new Set();
  return {
    // Stream the rendered buffer to the C++ host so it's playable even before the
    // user hits Play (player.js forwards it again on Play — the host adopts the
    // newest). Same planar-PCM protocol as player.js.
    setSample(buf) { forwardBufferToPlugin(buf); },
    noteOn(note, vel = 100) { send(0x90, note, vel || 1); sounding.add(note); },
    noteOff(note) { send(0x80, note, 0); sounding.delete(note); },
    allNotesOff() { for (const n of sounding) send(0x80, n, 0); sounding.clear(); send(0xb0, 123, 0); },
    setGain() { /* host parameter in plugin mode: the VOL fader drives the Gain param directly via SPVFUI (keyboard.js), not the engine */ },
    // Standard MIDI: pitch bend (0xE0, 14-bit, centre 8192) and mod wheel (CC1).
    pitchBend(norm) { const v = clamp(Math.round((clamp(norm, -1, 1) + 1) * 8191.5), 0, 16383); send(0xe0, v & 0x7f, (v >> 7) & 0x7f); },
    modWheel(amt) { send(0xb0, 1, Math.round(clamp(amt, 0, 1) * 127)); },
    setVibratoRate() { /* LFO rate is a C++/host setting, not standard MIDI */ },
    setADSR() { /* host parameters in plugin mode: the A/D/S/R faders drive the Attack/Decay/Sustain/Release params via SPVFUI (keyboard.js), not the engine */ },
    dispose() { this.allNotesOff(); },
  };
}

// ---- public API -------------------------------------------------------------
// createSampler(audioCtx, { forcedMode }) — forcedMode ('standalone' | 'plugin')
// wins; otherwise a saved override, otherwise auto-detect from the host bridge.
export function createSampler(audioCtx, { forcedMode = null } = {}) {
  let override = forcedMode;
  if (!override) { try { override = localStorage.getItem(MODE_KEY); } catch {} }

  const resolve = () => override || (inPlugin() ? 'plugin' : 'standalone');

  let mode = resolve();
  let engine = mode === 'plugin' ? pluginEngine() : standaloneEngine(audioCtx);
  let lastBuffer = null;
  let gain = null;           // last set master gain (0..1), re-applied across mode switches
  let adsr = null;           // last set ADSR, re-applied across mode switches
  let vib = null;            // last set vibrato rate (Hz), re-applied across mode switches
  // Chromatic repitch. Off (default): every key plays the sample at its native
  // pitch — we hand the engine the root note regardless of which key was struck.
  // On: the struck note drives the pitch (the engines' normal semitone scaling).
  // The remap happens here, once, so all three engines behave identically. Note
  // the shared DSP keys voices by note, so in repitch-off mode held keys collapse
  // onto the root note and releasing one releases them all — acceptable since they
  // all sound the same pitch anyway.
  let repitch = false;
  try { repitch = localStorage.getItem(REPITCH_KEY) === '1'; } catch {}
  const playNote = (note) => (repitch ? note : ROOT_KEY);
  const bus = new EventTarget();

  function rebuild() {
    const next = resolve();
    if (next === mode) return;
    engine.dispose();
    mode = next;
    engine = mode === 'plugin' ? pluginEngine() : standaloneEngine(audioCtx);
    if (lastBuffer) engine.setSample(lastBuffer);
    if (gain != null) engine.setGain(gain);
    if (adsr) engine.setADSR(...adsr);
    if (vib != null) engine.setVibratoRate(vib);
    bus.dispatchEvent(new CustomEvent('modechange', { detail: mode }));
  }

  return {
    get mode() { return mode; },
    get modeOverride() { return override; },   // null when auto-detecting
    // Force a mode (persisted) or pass null to clear the override (auto-detect).
    setMode(m) {
      override = m && m !== 'auto' ? m : null;
      try { override ? localStorage.setItem(MODE_KEY, override) : localStorage.removeItem(MODE_KEY); } catch {}
      rebuild();
    },
    // Adopt a freshly rendered WAV (Uint8Array) as the playable sample.
    setSampleFromWav(wav) {
      if (!wav) return;
      try { lastBuffer = wavToAudioBuffer(wav, audioCtx); } catch { lastBuffer = null; }
      engine.setSample(lastBuffer);
    },
    // Drop the loaded sample (e.g. on New patch) so the keyboard falls silent
    // rather than replaying the previous patch's audio.
    clearSample() {
      lastBuffer = null;
      engine.allNotesOff();
      engine.setSample(null);
    },
    noteOn(note, vel) { engine.noteOn(playNote(note), vel); },
    noteOff(note) { engine.noteOff(playNote(note)); },
    allNotesOff() { engine.allNotesOff(); },
    get repitch() { return repitch; },
    // Toggle chromatic repitch (persisted). Flush sounding notes first so held
    // keys don't stick — their note-off would map to the new scheme and miss.
    setRepitch(on) {
      on = !!on;
      if (on === repitch) return;
      engine.allNotesOff();
      repitch = on;
      try { on ? localStorage.setItem(REPITCH_KEY, '1') : localStorage.removeItem(REPITCH_KEY); } catch {}
    },
    setGain(v) { gain = clamp(v, 0, 1); engine.setGain(gain); },
    pitchBend(norm) { engine.pitchBend(norm); },     // norm -1..1 (wheel position)
    modWheel(amt) { engine.modWheel(amt); },         // 0..1
    setVibratoRate(hz) { vib = hz; engine.setVibratoRate(hz); },   // LFO rate, Hz
    setADSR(a, d, s, r) { adsr = [a, d, s, r]; engine.setADSR(a, d, s, r); },
    on(type, fn) { bus.addEventListener(type, fn); return () => bus.removeEventListener(type, fn); },
  };
}
