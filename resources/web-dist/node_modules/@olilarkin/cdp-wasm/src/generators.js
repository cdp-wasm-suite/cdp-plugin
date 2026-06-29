// CDP synthesis generators: leaf programs that create audio from scratch (no
// audio input). They mirror the EFFECTS catalog (same arg-template tokens and
// `buildArgs`), but take only `$OUT` (and optionally `$DATA`) — never `$IN`.
//
// Each entry: { id, label, category, program, args, params, blurb,
//   mode?, data?, parityExempt? }.
//   - args:   template of literals, '$OUT', '$DATA', '$SR' (the session sample
//             rate, supplied via applyGenerator's `extra.sampleRate`), and
//             { p:'name'[, flag:'-x'] } param tokens (see catalog.js grammar).
//   - params: numeric { name, label, min, max, default, step?, env? } or
//             choice  { name, label, choices:[[label,value],...], default }.
//             `env: true` marks a param that accepts a time-varying breakpoint
//             envelope (a consuming app lets you cable one in or draw one).
//   - data:   UI descriptor { label, placeholder, default } for the freeform
//             text staged as '$DATA'. `default` is what headless/test runs feed.
//   - parityExempt: note string when output is non-deterministic (rand()), so
//             the parity test only checks "both produce audio".

import { buildArgs } from './catalog.js';

export const GENERATORS = [
  // ---- synth (built-in waveshapes / noise / chord) --------------------------
  { id: 'wave', label: 'Waveform', category: 'Synthesis', program: 'synth', mode: ['wave'],
    args: ['wave', { p: 'shape' }, '$OUT', '$SR', '1', { p: 'dur' }, { p: 'freq' }, { p: 'amp', flag: '-a' }],
    params: [
      { name: 'shape', label: 'Waveform', choices: [['Sine', '1'], ['Square', '2'], ['Sawtooth', '3'], ['Ramp', '4']], default: '1' },
      { name: 'freq', label: 'Freq (Hz)', min: 20, max: 8000, default: 330, step: 1, env: true },
      { name: 'dur', label: 'Duration (s)', min: 0.1, max: 20, default: 1.5, step: 0.1 },
      { name: 'amp', label: 'Amplitude', min: 0.05, max: 1, default: 0.8, step: 0.05, env: true },
    ],
    blurb: 'Simple oscillator: sine, square, sawtooth or ramp.' },
  { id: 'noise', label: 'White noise', category: 'Synthesis', program: 'synth', mode: ['noise'],
    args: ['noise', '$OUT', '$SR', '1', { p: 'dur' }, { p: 'amp', flag: '-a' }],
    params: [
      { name: 'dur', label: 'Duration (s)', min: 0.1, max: 20, default: 1.5, step: 0.1 },
      { name: 'amp', label: 'Amplitude', min: 0.05, max: 1, default: 0.5, step: 0.05, env: true },
    ],
    parityExempt: 'rand()',
    blurb: 'White noise.' },
  { id: 'silence', label: 'Silence', category: 'Synthesis', program: 'synth', mode: ['silence'],
    args: ['silence', '$OUT', '$SR', { p: 'chans' }, { p: 'dur' }],
    params: [
      { name: 'chans', label: 'Channels', choices: [['Mono', '1'], ['Stereo', '2'], ['Quad', '4']], default: '1' },
      { name: 'dur', label: 'Duration (s)', min: 0.1, max: 60, default: 1, step: 0.1 },
    ],
    blurb: 'A silent soundfile of any length — useful for splicing gaps between sounds.' },
  { id: 'spectra', label: 'Spectral band', category: 'Synthesis', program: 'synth', mode: ['spectra'],
    args: ['spectra', '$OUT', { p: 'dur' }, { p: 'frq' }, { p: 'spread' }, { p: 'maxfoc' }, { p: 'minfoc' }, { p: 'timevar' }, '$SR'],
    params: [
      { name: 'dur', label: 'Duration (s)', min: 0.1, max: 20, default: 3, step: 0.1 },
      { name: 'frq', label: 'Centre freq (Hz)', min: 50, max: 8000, default: 440, step: 1 },
      { name: 'spread', label: 'Bandwidth (Hz)', min: 1, max: 4000, default: 300, step: 1 },
      { name: 'maxfoc', label: 'Max focus', min: 0, max: 1, default: 0.8, step: 0.05 },
      { name: 'minfoc', label: 'Min focus', min: 0, max: 1, default: 0.2, step: 0.05 },
      { name: 'timevar', label: 'Time variation', min: 0, max: 1, default: 0.5, step: 0.05 },
    ],
    parityExempt: 'rand()',
    blurb: 'A warbled tone of varying pitch within a spectral band around a centre frequency.' },
  { id: 'chord', label: 'Chord', category: 'Synthesis', program: 'synth', mode: ['chord'],
    args: ['chord', { p: 'kind' }, '$OUT', '$DATA', '$SR', '1', { p: 'dur' }, { p: 'amp', flag: '-a' }],
    params: [
      { name: 'kind', label: 'Note data', choices: [['MIDI notes', '1'], ['Frequencies', '2']], default: '1' },
      { name: 'dur', label: 'Duration (s)', min: 0.1, max: 20, default: 2, step: 0.1 },
      { name: 'amp', label: 'Amplitude', min: 0.05, max: 1, default: 0.6, step: 0.05 },
    ],
    data: { label: 'Notes (one per line)', placeholder: 'MIDI notes, e.g. 60 / 64 / 67', default: '60\n64\n67\n71' },
    parityExempt: 'sine-sum FP differs across platforms',
    blurb: 'Chord from a list of MIDI notes (or frequencies) on a sine wave.' },
  { id: 'clicks', label: 'Click track', category: 'Synthesis', program: 'clicknew', mode: ['clicks'],
    args: ['clicks', '$OUT', '$DATA', '$SR'],
    params: [],
    data: { label: 'Click times in seconds (one per line)', placeholder: 'e.g. 0 / 0.5 / 1.0 / 1.5', default: '0\n0.5\n1.0\n1.5\n2.0' },
    parityExempt: 'clicknew impulse timing differs across platforms',
    blurb: 'Clicktrack with a click at each listed time — good for triggering grains.' },

  // ---- impulse / oscillators ------------------------------------------------
  { id: 'impulse', label: 'Impulse train', category: 'Synthesis', program: 'impulse', mode: ['impulse'],
    args: ['impulse', '$OUT', { p: 'dur' }, { p: 'pitch' }, { p: 'chirp' }, { p: 'slope' }, { p: 'pkcnt' }, { p: 'level' }],
    params: [
      { name: 'dur', label: 'Duration (s)', min: 0.1, max: 20, default: 2, step: 0.1 },
      { name: 'pitch', label: 'Pitch (MIDI)', min: 24, max: 96, default: 48, step: 1, env: true },
      { name: 'chirp', label: 'Chirp', min: 0, max: 30, default: 0, step: 1, env: true },
      { name: 'slope', label: 'Slope', min: 1, max: 20, default: 5, step: 1, env: true },
      { name: 'pkcnt', label: 'Peaks', min: 1, max: 32, default: 4, step: 1 },
      { name: 'level', label: 'Level', min: 0.05, max: 1, default: 0.8, step: 0.05, env: true },
    ],
    blurb: 'Stream of impulses — good for driving grain effects.' },
  { id: 'multiosc', label: 'Nested oscillator', category: 'Synthesis', program: 'multiosc', mode: ['multiosc'],
    args: ['multiosc', '1', '$OUT', { p: 'dur' }, { p: 'frq1' }, { p: 'frq2' }, { p: 'amp2' }, '$SR', { p: 'splice' }],
    params: [
      { name: 'dur', label: 'Duration (s)', min: 0.1, max: 20, default: 2, step: 0.1 },
      { name: 'frq1', label: 'Frequency 1', min: 20, max: 4000, default: 220, step: 1, env: true },
      { name: 'frq2', label: 'Sub-osc rate', min: 0.1, max: 200, default: 5, step: 0.1, env: true },
      { name: 'amp2', label: 'Sub-osc depth', min: 0, max: 1, default: 0.5, step: 0.05 },
      { name: 'splice', label: 'Splice (ms)', min: 0, max: 50, default: 5, step: 1 },
    ],
    blurb: 'An oscillation modulated by a nested oscillation.' },
  { id: 'synspline', label: 'Spline synth', category: 'Synthesis', program: 'synspline', mode: ['synspline'],
    args: ['synspline', '$OUT', '$SR', { p: 'dur' }, { p: 'frq' }, { p: 'splinecnt' }, { p: 'interp' }, { p: 'seed' }],
    params: [
      { name: 'dur', label: 'Duration (s)', min: 0.1, max: 20, default: 2, step: 0.1 },
      { name: 'frq', label: 'Frequency', min: 20, max: 4000, default: 220, step: 1, env: true },
      { name: 'splinecnt', label: 'Spline points', min: 0, max: 64, default: 8, step: 1, env: true },
      { name: 'interp', label: 'Morph wavecycles', min: 0, max: 200, default: 2, step: 1, env: true },
      { name: 'seed', label: 'Seed', min: 1, max: 99, default: 1, step: 1 },
    ],
    parityExempt: 'rand()',
    blurb: 'Evolving timbres from smoothly-joined random points.' },
  { id: 'chirikov', label: 'Chaotic (Chirikov)', category: 'Synthesis', program: 'chirikov', mode: ['chirikov'],
    args: ['chirikov', '1', '$OUT', { p: 'dur' }, { p: 'frq' }, { p: 'damping' }, '$SR', { p: 'splice' }],
    params: [
      { name: 'dur', label: 'Duration (s)', min: 0.1, max: 20, default: 2, step: 0.1 },
      { name: 'frq', label: 'Frequency', min: 20, max: 4000, default: 220, step: 1, env: true },
      { name: 'damping', label: 'Damping', min: 0, max: 1, default: 0, step: 0.05, env: true },
      { name: 'splice', label: 'Splice (ms)', min: 0, max: 50, default: 5, step: 1 },
    ],
    parityExempt: 'chaotic (FP-divergent)',
    blurb: 'Potentially chaotic Chirikov standard-map synthesis.' },

  // ---- newsynth (additive / wave-packet / fractal / Duffing) ----------------
  { id: 'addsynth', label: 'Additive synth', category: 'Synthesis', program: 'newsynth', mode: ['synthesis', '1'],
    args: ['synthesis', '1', '$OUT', '$DATA', '$SR', { p: 'dur' }, { p: 'frq' }],
    params: [
      { name: 'dur', label: 'Duration (s)', min: 0.1, max: 20, default: 2, step: 0.1 },
      { name: 'frq', label: 'Frequency', min: 1, max: 4000, default: 220, step: 1, env: true },
    ],
    data: { label: 'Spectrum: "time pno level pno level ..." (1st partial must be 1)',
      placeholder: 'e.g. 0 1 1 2 0.5 3 0.3', default: '0 1 1 2 0.5 3 0.333 4 0.25 5 0.2 6 0.167 7 0.143 8 0.125 9 0.111 10 0.1 11 0.091 12 0.083 13 0.077 14 0.071 15 0.067 16 0.063' },
    blurb: 'Additive synthesis from a user-defined (harmonic or inharmonic) spectrum of partials.' },
  { id: 'addsynth_packets', label: 'Wave-packet synth', category: 'Synthesis', program: 'newsynth', mode: ['synthesis', '2'],
    args: ['synthesis', '2', '$OUT', '$DATA', '$SR', { p: 'dur' }, { p: 'frq' }, { p: 'narrowing', flag: '-n' }, { p: 'centring', flag: '-c' }],
    params: [
      { name: 'dur', label: 'Duration (s)', min: 0.1, max: 20, default: 2, step: 0.1 },
      { name: 'frq', label: 'Frequency', min: 1, max: 4000, default: 220, step: 1, env: true },
      { name: 'narrowing', label: 'Packet narrowing', min: 0, max: 1000, default: 1, step: 0.5 },
      { name: 'centring', label: 'Peak centring', min: -1, max: 1, default: 0, step: 0.1 },
    ],
    data: { label: 'Spectrum: "time pno level pno level ..." (1st partial must be 1)',
      placeholder: 'e.g. 0 1 1 2 0.5 3 0.3', default: '0 1 1 2 0.5 3 0.333 4 0.25 5 0.2 6 0.167 7 0.143 8 0.125 9 0.111 10 0.1 11 0.091 12 0.083 13 0.077 14 0.071 15 0.067 16 0.063' },
    blurb: 'Streams of enveloped wave-packets built from a user-defined spectrum.' },
  { id: 'fractal', label: 'Fractal synth', category: 'Synthesis', program: 'newsynth', mode: ['synthesis', '4'],
    args: ['synthesis', '4', '$OUT', '$SR', { p: 'dur' }, { p: 'frq' }, { p: 'atk' }, { p: 'ea' }, { p: 'dec' }, { p: 'ed' }, { p: 'atoh' }, { p: 'gtow' }],
    params: [
      { name: 'dur', label: 'Duration (s)', min: 0.1, max: 20, default: 2, step: 0.1 },
      { name: 'frq', label: 'Frequency', min: 1, max: 4000, default: 220, step: 1, env: true },
      { name: 'atk', label: 'Spike attack (samps)', min: 1, max: 100, default: 4, step: 1 },
      { name: 'ea', label: 'Attack curve', min: 0.1, max: 4, default: 1, step: 0.1 },
      { name: 'dec', label: 'Spike decay (samps)', min: 1, max: 200, default: 20, step: 1 },
      { name: 'ed', label: 'Decay curve', min: 0.1, max: 4, default: 1, step: 0.1 },
      { name: 'atoh', label: 'On/off ratio', min: 0, max: 1, default: 0.5, step: 0.05, env: true },
      { name: 'gtow', label: 'Group/wave ratio', min: 0, max: 1, default: 0.5, step: 0.05, env: true },
    ],
    blurb: 'A buzzy tone made of spikes distributed fractally over the wavelength.' },
  { id: 'duffing', label: 'Duffing oscillator', category: 'Synthesis', program: 'newsynth', mode: ['synthesis', '5'],
    args: ['synthesis', '5', '$OUT', '$SR', { p: 'dur' }, { p: 'frq' }, { p: 'damping' }, { p: 'k' }, { p: 'b' }],
    params: [
      { name: 'dur', label: 'Duration (s)', min: 0.1, max: 20, default: 2, step: 0.1 },
      { name: 'frq', label: 'Forcing freq (Hz)', min: 1, max: 200, default: 80, step: 1, env: true },
      { name: 'damping', label: 'Damping', min: 0.15, max: 2, default: 0.5, step: 0.05, env: true },
      { name: 'k', label: 'k coefficient', min: -10, max: 10, default: 1, step: 0.1 },
      { name: 'b', label: 'b coefficient', min: 20, max: 50, default: 30, step: 1 },
    ],
    blurb: 'An experimental Duffing damped oscillator.' },

  // ---- multisynth -----------------------------------------------------------
  // (pulser synth is omitted: it synthesizes correctly but hits an integer
  //  divide-by-zero trap on exit under WASM — see wasm/PORTING-STATUS.md.)
  { id: 'multisynth', label: 'Multisynth (score)', category: 'Synthesis', program: 'multisynth', mode: ['synth'],
    args: ['synth', '$OUT', '$DATA', { p: 'mm' }, { p: 'jitter', flag: '-j' }],
    params: [
      { name: 'mm', label: 'Tempo (MM)', min: 30, max: 300, default: 120, step: 1 },
      { name: 'jitter', label: 'Timing jitter (ms)', min: 0, max: 100, default: 15, step: 1 },
    ],
    // Times/durations are integers in thirds-of-semiquavers; durations must be
    // multiples of 3 or 4 (CDP rejects others).
    data: { label: 'Score: "Insname time pitch loud dur ..." (times/durs in thirds-of-semiquavers; dur = multiple of 3 or 4)',
      placeholder: 'flute 0 60 0.8 24 24 64 0.8 24',
      default: 'flute 0 60 0.8 24 24 64 0.8 24 48 67 0.8 24' },
    // The native multisynth binary crashes (heap "corrupted size") on this score,
    // so there's no native side to compare — skip parity (WASM output is fine).
    paritySkip: true,
    parityExempt: 'rand()',
    blurb: 'Triggers and mixes a small set of built-in instrument sounds from a score (low-fi).' },
];

export const genById = Object.fromEntries(GENERATORS.map((g) => [g.id, g]));

/**
 * Run a synthesis generator and return the produced WAV bytes. Mirrors
 * applyEffect's data/breakpoint handling, but stages no audio input.
 *
 * @param {import('./index.js').CDP} cdp
 * @param {object} gen   an entry from GENERATORS
 * @param {Record<string,number|string>} values  current parameter values
 * @param {{ brk?: Record<string,string|Uint8Array>, data?: string|Uint8Array }} [extra]
 *   `brk` supplies time-varying breakpoint envelopes (param name -> "t v\n..."),
 *   `data` overrides the freeform '$DATA' text (defaults to gen.data.default).
 * @returns {Promise<Uint8Array>}
 */
export async function applyGenerator(cdp, gen, values = {}, extra = {}) {
  const brk = extra.brk || {};
  const inputs = {};
  const vals = { ...values };
  // Breakpoint envelopes: replace the param value with a staged /brk_<name>.brk path.
  for (const name of Object.keys(brk)) {
    if (brk[name] == null || brk[name] === '') continue;
    const path = `/brk_${name}.brk`;
    inputs[path] = typeof brk[name] === 'string' ? new TextEncoder().encode(brk[name]) : brk[name];
    vals[name] = path;
  }
  // Freeform text data ('$DATA'): explicit override, else the generator's default.
  if (gen.args.includes('$DATA')) {
    const text = extra.data != null ? extra.data : (gen.data ? gen.data.default : undefined);
    if (text != null && String(text).trim()) {
      inputs['/data.txt'] = typeof text === 'string' ? new TextEncoder().encode(String(text)) : text;
    }
  }
  const sr = extra.sampleRate || 44100;   // session-configurable; '$SR' tokens in args resolve to this
  const mapped = buildArgs(gen, vals, sr).map((a) => (a === '$OUT' ? '/out.wav' : a === '$DATA' ? '/data.txt' : a));
  const res = await cdp.run(gen.program, mapped, { inputs, outputs: ['/out.wav'] });
  const wav = res.outputs['/out.wav'];
  if (!wav) throw new Error(`${gen.program} produced no output (exit ${res.exitCode}).\n${res.stderr || res.stdout}`.trim());
  return wav;
}
