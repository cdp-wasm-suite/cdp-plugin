// Optional Faust integration: two devices — a Faust generator and a Faust effect —
// each of which you program in Faust, compile in-browser, and run in the offline
// CDP graph. The DSP source is editable and serialised with the patch; a library
// of presets seeds the editor.
//
// The Faust compiler (libfaust, multi-MB wasm) loads LAZILY on first compile via a
// dynamic import, so projects that never touch Faust pay nothing at startup.
//
// Cables carry plain WAV bytes (see graph.js), so a Faust node is just another
// audio box: decode WAV → render → encode WAV. The node's I/O is DYNAMIC — it is
// whatever the compiled DSP declares:
//   * getNumInputs() === 0           → a generator (no audio input; renders `dur`)
//   * getNumInputs() >  0            → an effect (renders the input's length)
//   * parameters (getUI controls)    → one automatable param + breakpoint port each
// Channels ride inside the WAV (single multichannel cables, like Source/Output).
// When the DSP's channel count doesn't match the file, the DSP is replicated per
// channel: a mono (1-in/1-out) effect on a stereo file processes each channel
// independently → stereo out. Faust has no .brk file, so modulation is done by
// sampling each envelope per render block and calling setParamValue().

import { decodeWav, encodeWav } from '@olilarkin/cdp-wasm';

// ---- preset library ---------------------------------------------------------
// Seeds for the in-device editor, grouped by device kind. Each is { id, label,
// code }. Add your own freely — they're just starting points; the device renders
// whatever is in its editor. Controls that should fire once (a gate) use an
// hslider initialised to 1 so a fresh offline render triggers the envelope on its
// 0→1 onset (see the gate note below).

export const FAUST_PRESETS = {
  generator: [
    { id: 'decaysine', label: 'Decaying sine', code: [
      'import("stdfaust.lib");',
      'freq  = hslider("freq",  220, 20, 8000, 0.01);',
      'amp   = hslider("amp",   0.8, 0,  1,    0.001);',
      'decay = hslider("decay", 1.5, 0.05, 10, 0.01);',
      'gate  = hslider("gate",  1,   0,  1,    1);',
      'process = os.osc(freq) * (en.adsr(0.001, decay, 0, 0.01, gate) * amp);',
    ].join('\n') },
    { id: 'fm', label: 'FM (2-op)', code: [
      'import("stdfaust.lib");',
      'freq  = hslider("freq",  110, 20, 2000, 0.01);',
      'ratio = hslider("ratio", 2,   0.5, 8,   0.01);',
      'index = hslider("index", 2,   0,  20,   0.01);',
      'decay = hslider("decay", 1.5, 0.05, 10, 0.01);',
      'gate  = hslider("gate",  1,   0,  1,    1);',
      'env = en.adsr(0.005, decay, 0, 0.01, gate);',
      'process = os.osc(freq + index*freq*os.osc(freq*ratio)) * env * 0.8;',
    ].join('\n') },
    { id: 'pluck', label: 'Karplus–Strong pluck', code: [
      'import("stdfaust.lib");',
      'freq = hslider("freq", 220, 20, 2000, 0.01);',
      'damp = hslider("damping", 0.5, 0, 1, 0.001);',
      'gate = hslider("gate", 1, 0, 1, 1);',
      'process = pm.ks(freq, damp, gate : ba.impulsify) * 0.8;',
    ].join('\n') },
    { id: 'fnoise', label: 'Filtered noise', code: [
      'import("stdfaust.lib");',
      'cutoff = hslider("cutoff", 1200, 40, 12000, 0.01);',
      'q      = hslider("q", 5, 0.5, 40, 0.01);',
      'amp    = hslider("amp", 0.5, 0, 1, 0.001);',
      'process = no.noise : fi.resonlp(cutoff, q, 1) * amp;',
    ].join('\n') },
  ],
  effect: [
    { id: 'ringmod', label: 'Ring modulator', code: [
      'import("stdfaust.lib");',
      'carrier = hslider("carrier", 220, 1, 8000, 0.01);',
      'depth   = hslider("depth",   1,   0, 1,    0.001);',
      'process = _ * (1 - depth + depth * os.osc(carrier));',
    ].join('\n') },
    { id: 'lowpass', label: 'Resonant low-pass', code: [
      'import("stdfaust.lib");',
      'cutoff = hslider("cutoff", 1200, 40, 18000, 0.01);',
      'q      = hslider("q", 3, 0.5, 40, 0.01);',
      'process = fi.resonlp(cutoff, q, 1);',
    ].join('\n') },
    { id: 'echo', label: 'Echo', code: [
      'import("stdfaust.lib");',
      'time     = hslider("time", 0.25, 0.01, 2, 0.001);',
      'feedback = hslider("feedback", 0.4, 0, 0.95, 0.001);',
      'mix      = hslider("mix", 0.4, 0, 1, 0.001);',
      'echo = +~(de.delay(192000, ma.SR*time) * feedback);',
      'process = _ <: _, echo : _*(1-mix), _*mix :> _;',
    ].join('\n') },
    { id: 'reverb', label: 'Reverb (freeverb)', code: [
      'import("stdfaust.lib");',
      'room = hslider("room", 0.5, 0, 1, 0.001);',
      'damp = hslider("damp", 0.5, 0, 1, 0.001);',
      'mix  = hslider("mix", 0.4, 0, 1, 0.001);',
      'process = _ <: _, re.mono_freeverb(room, damp, 0.5, 1500) : _*(1-mix), _*mix :> _;',
    ].join('\n') },
    { id: 'drive', label: 'Distortion', code: [
      'import("stdfaust.lib");',
      'drive = hslider("drive", 4, 1, 50, 0.01);',
      'level = hslider("level", 0.7, 0, 1, 0.001);',
      'process = *(drive) : ma.tanh : *(level);',
    ].join('\n') },
    // Multi-input: two separate source cables (in + in2). The declaration is what
    // makes the device expose a second input instead of treating 2 inputs as stereo.
    { id: 'ringext', label: 'Ring mod (ext. carrier)', code: [
      'declare cdp_inputs "2";',
      'import("stdfaust.lib");',
      'depth = hslider("depth", 1, 0, 1, 0.001);',
      'gain  = hslider("gain",  1, 0, 4, 0.001);',
      '// in = signal, in2 = carrier',
      'process(sig, car) = sig * (1 - depth + depth*car) * gain;',
    ].join('\n') },
    { id: 'xfade', label: 'Crossfade A/B', code: [
      'declare cdp_inputs "2";',
      'import("stdfaust.lib");',
      'x = hslider("mix", 0.5, 0, 1, 0.001);',
      'process(a, b) = a*(1-x) + b*x;',
    ].join('\n') },
  ],
};

export const DEFAULT_CODE = {
  generator: FAUST_PRESETS.generator[0].code,
  effect: FAUST_PRESETS.effect[0].code,
};

// ---- compiler (lazy singleton) ----------------------------------------------
let _faust = null;
let _faustErr = null;
async function getFaust() {
  if (_faust) return _faust;
  if (_faustErr) throw _faustErr;
  try {
    // Dynamic import: the bundle inlines libfaust's wasm+data, so no asset paths
    // to wire — and nothing is fetched until the first compile.
    const { instantiateFaustModule, LibFaust, FaustCompiler } = await import('@grame/faustwasm');
    const mod = await instantiateFaustModule();
    _faust = { compiler: new FaustCompiler(new LibFaust(mod)) };
    return _faust;
  } catch (e) {
    _faustErr = new Error('Faust compiler failed to load: ' + (e?.message || e));
    throw _faustErr;
  }
}

// Compile a DSP once and cache it, keyed by the exact source. Returns the compiled
// generator plus everything the UI and renderer need: the name→address map, the
// parameter specs (cdp-style, for paramRow), and the audio I/O counts.
const _cache = new Map();
export async function compileFaust(code) {
  if (_cache.has(code)) return _cache.get(code);
  const { compiler } = await getFaust();
  const { FaustMonoDspGenerator } = await import('@grame/faustwasm');
  const gen = new FaustMonoDspGenerator();
  const ok = await gen.compile(compiler, 'dsp', code, '');
  if (!ok) throw new Error(compiler.getErrorMessage() || 'Faust compile error');
  const meta = gen.getMeta();
  const addresses = {};
  const params = [];
  const walk = (items) => (items || []).forEach((it) => {
    if (it.items) return walk(it.items);
    if (!it.address) return;
    const name = it.address.split('/').pop();
    addresses[name] = it.address;
    if (it.type === 'vslider' || it.type === 'hslider' || it.type === 'nentry') {
      params.push({ name, label: it.label || name, min: +it.min, max: +it.max, default: +it.init, step: +it.step || 0.01, env: true });
    } else if (it.type === 'button' || it.type === 'checkbox') {
      params.push({ name, label: it.label || name, min: 0, max: 1, default: +it.init || 0, step: 1, env: true });
    }
  });
  walk(meta.ui);
  const nIn = +meta.inputs;
  // How many SEPARATE input cables to expose. Faust's input count is a channel
  // count, which can't say whether 2 inputs are stereo L/R (one source) or two
  // different sounds. The DSP author declares the latter:  declare cdp_inputs "2";
  // Default: one cable when the DSP has any inputs. Clamped to the channel count.
  const decl = (meta.meta || []).find((e) => 'cdp_inputs' in e);
  let nSources = nIn > 0 ? 1 : 0;
  if (decl) nSources = Math.max(1, Math.min(nIn, parseInt(decl.cdp_inputs, 10) || 1));
  const entry = { gen, addresses, params, nIn, nOut: +meta.outputs, nSources };
  _cache.set(code, entry);
  return entry;
}

// Pad/truncate a channel to `frames` samples.
function fit(ch, frames) {
  if (ch.length === frames) return ch;
  const out = new Float32Array(frames);
  out.set(ch.subarray(0, frames));
  return out;
}

// Linear-interpolated lookup into a sorted [[t,v],…] breakpoint list at time `t`.
function sampleAt(pts, t) {
  if (!pts.length) return 0;
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) {
      const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
      const span = t1 - t0;
      return span > 0 ? v0 + (v1 - v0) * ((t - t0) / span) : v1;
    }
  }
  return pts[pts.length - 1][1];
}

const BLOCK = 128;

// Render one fresh DSP instance over `frames` samples, with per-block param
// modulation. Returns nOut channels. inputChannels feeds the DSP's audio inputs
// (missing/short channels are zero-padded). A fresh instance per call gives
// per-channel independence when we replicate across channels.
async function renderInstance(gen, sr, frames, addresses, params, values, mod, inputChannels) {
  const proc = await gen.createOfflineProcessor(sr, BLOCK);
  const nIn = proc.getNumInputs();
  const nOut = proc.getNumOutputs();
  for (const p of params) {
    const a = addresses[p.name];
    if (!a || mod[p.name]) continue;            // modulated params are set per block
    const v = values[p.name];
    proc.setParamValue(a, v != null ? +v : p.default);
  }
  const out = Array.from({ length: nOut }, () => new Float32Array(frames));
  const inBufs = Array.from({ length: nIn }, () => new Float32Array(BLOCK));
  const outBufs = Array.from({ length: nOut }, () => new Float32Array(BLOCK));
  const modList = Object.entries(mod).filter(([k]) => addresses[k]);
  proc.start();
  for (let pos = 0; pos < frames; pos += BLOCK) {
    const len = Math.min(BLOCK, frames - pos);
    const t = pos / sr;
    for (const [k, pts] of modList) proc.setParamValue(addresses[k], sampleAt(pts, t));
    for (let c = 0; c < nIn; c++) {
      const src = inputChannels[c];
      const buf = inBufs[c];
      for (let i = 0; i < BLOCK; i++) buf[i] = (src && pos + i < frames) ? src[pos + i] : 0;
    }
    proc.compute(inBufs, outBufs);
    for (let c = 0; c < nOut; c++) out[c].set(outBufs[c].subarray(0, len), pos);
  }
  proc.stop();
  proc.destroy?.();
  return out;
}

// Render a Faust node offline.
//   code       — the DSP source on the node (serialised with the patch)
//   values     — { paramName: number } static values
//   mod        — { paramName: [[tSec, value], …] } resolved envelopes (real units)
//   inputWavs  — array of WAV byte arrays, one per connected input cable (in order)
//   dur        — generator render length (s); ignored when the DSP has inputs
//   sampleRate — generators only; default 44100 to match CDP output
// Returns a 32-bit float WAV Uint8Array.
export async function renderFaust({ code, values = {}, mod = {}, inputWavs = [], dur = 3, sampleRate = 44100 }) {
  const { gen, addresses, params, nIn, nOut } = await compileFaust(code);

  // Generator: no audio input — synthesise `dur` seconds, nOut channels.
  if (nIn === 0) {
    const sr = sampleRate;
    const frames = Math.max(1, Math.round((Number(dur) || 3) * sr));
    const out = await renderInstance(gen, sr, frames, addresses, params, values, mod, []);
    return encodeWav({ sampleRate: sr, channelData: out.length ? out : [new Float32Array(frames)] });
  }

  // Effect: rate + length follow the first (main) input cable; later cables are
  // padded/truncated to it. Each cable may itself be multichannel (e.g. stereo).
  const wavs = inputWavs.filter(Boolean);
  if (!wavs.length) throw new Error('connect an audio source to the Faust effect input');
  const decs = wavs.map((w) => decodeWav(w));
  const sr = decs[0].sampleRate;
  const frames = decs[0].length;
  // Flatten every cable's channels (in cable order) into one channel list — this is
  // what feeds the DSP's audio inputs. A 2-source DSP fed two mono cables sees them
  // as inputs 0 and 1; a stereo cable contributes two channels; etc.
  const flat = [];
  for (const d of decs) for (const ch of d.channelData) flat.push(fit(ch, frames));
  const C = flat.length;

  // Single mono source through a mono (1-in/1-out) DSP: replicate per channel with
  // independent instances → output channel count matches the input.
  if (wavs.length === 1 && nIn === 1 && nOut === 1) {
    const channels = [];
    for (let c = 0; c < C; c++) {
      const o = await renderInstance(gen, sr, frames, addresses, params, values, mod, [flat[c]]);
      channels.push(o[0]);
    }
    return encodeWav({ sampleRate: sr, channelData: channels });
  }

  // Otherwise map the flattened channels onto the DSP inputs (cycling if there are
  // fewer than the DSP wants), one instance; output is the DSP's nOut channels.
  const inputChannels = Array.from({ length: nIn }, (_, i) => flat[i % C]);
  const out = await renderInstance(gen, sr, frames, addresses, params, values, mod, inputChannels);
  return encodeWav({ sampleRate: sr, channelData: out });
}
