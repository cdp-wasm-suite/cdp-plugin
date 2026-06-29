// Patch recipes — ready-made patches loadable from File ▸ Recipes.
//
// Each recipe is a `cdp-web-patch` JSON object (the exact shape produced by the
// patcher's serialize()/consumed by loadPatch()), plus a `metadata` block. They are
// self-contained: a synth Generator feeds the chain, so a recipe renders audio
// immediately with no file to load. Builders below auto-insert PVOC Analyse/
// Resynthesise nodes around spectral effects (the patcher models spectral cables
// explicitly) and wire two-input effects to a second source.
//
// Seeded from CDP's own worked examples (docs/.../demo/sdbats/*.bat) and the
// "Musical Applications" notes in the reference, restricted to the exposed catalog.

import { EFFECTS } from '@olilarkin/cdp-wasm';

const byId = Object.fromEntries(EFFECTS.map((e) => [e.id, e]));
const isSpectral = (fx) => byId[fx]?.domain === 'spectral';

const gen = (id, values = {}, data, envs) => ({ kind: 'gen', id, values, data, envs });

// A stepped frequency breakpoint that walks up the harmonic series (f, 2f … n·f)
// and back down, holding each harmonic — a sine that "arpeggiates" the overtones.
// Real Hz values (vnorm:false) over normalised time (tnorm:true → the gen's dur).
function harmonicSeriesEnv(f0, n) {
  const steps = [];
  for (let h = 1; h <= n; h++) steps.push(h);
  for (let h = n - 1; h >= 1; h--) steps.push(h);
  const M = steps.length, eps = 0.4 / M;   // tiny ramp between holds ≈ instant jump
  const pts = [];
  for (let i = 0; i < M; i++) {
    pts.push(`${(i / M).toFixed(4)} ${steps[i] * f0}`);
    pts.push(`${((i + 1) / M - eps).toFixed(4)} ${steps[i] * f0}`);
  }
  pts.push(`1 ${steps[M - 1] * f0}`);
  return { vnorm: false, tnorm: true, text: pts.join('\n') };
}
// A bundled CDP demo sound in audio/ (auto-fetched by the Source node).
const src = (name) => ({ kind: 'url', url: `audio/${name}.wav`, name });

function sourceNode(nid, x, y, source) {
  if (source.kind === 'gen') return { id: nid, type: 'generator', x, y, gen: { id: source.id, values: source.values, envs: source.envs || {}, data: source.data } };
  if (source.kind === 'url') return { id: nid, type: 'source', x, y, source: { kind: 'url', url: source.url, name: source.name } };
  return { id: nid, type: 'source', x, y, source: { kind: 'file' } };
}

// Linear chain: one source feeding a sequence of effects into an Output. Spectral
// effects are bracketed with PVOC nodes automatically; a trailing PVOC Resynth is
// added if the chain ends in the spectral domain.
function chain(metadata, source, steps) {
  const nodes = []; const edges = []; let n = 0;
  const nid = () => 'n' + (++n);
  let x = 40; const y = 150; const dx = 200;
  const add = (node) => { node.x = x; node.y = y; x += dx; nodes.push(node); return node.id; };
  const link = (from, to, fp = 'out', tp = 'in') => edges.push({ from: { node: from, port: fp }, to: { node: to, port: tp } });
  let prev = add(sourceNode(nid(), x, y, source));
  let domain = 'audio';
  for (const s of steps) {
    const spectral = isSpectral(s.fx);
    if (spectral && domain === 'audio') { const a = add({ id: nid(), type: 'pvocAnalyse' }); link(prev, a); prev = a; domain = 'spectral'; }
    if (!spectral && domain === 'spectral') { const r = add({ id: nid(), type: 'pvocResynth' }); link(prev, r); prev = r; domain = 'audio'; }
    const t = add({ id: nid(), type: 'transform', effectId: s.fx, state: { values: s.values || {}, envs: s.envs || {} } });
    link(prev, t); prev = t; domain = spectral ? 'spectral' : 'audio';
  }
  if (domain === 'spectral') { const r = add({ id: nid(), type: 'pvocResynth' }); link(prev, r); prev = r; }
  const out = add({ id: nid(), type: 'output' }); link(prev, out);
  return { app: 'cdp-web-patch', v: 1, metadata, nodes, edges };
}

// Two-input effect: sources A and B meet at one effect. Spectral two-input effects
// (morph, combine, formants vocode) get a PVOC Analyse on each branch and a Resynth
// after; sound two-input effects (submix) wire straight through.
function twoInput(metadata, srcA, srcB, fx, values = {}) {
  const spectral = isSpectral(fx);
  const nodes = []; const edges = []; let n = 0;
  const nid = () => 'n' + (++n);
  const add = (node, x, y) => { node.x = x; node.y = y; nodes.push(node); return node.id; };
  const link = (from, to, fp = 'out', tp = 'in') => edges.push({ from: { node: from, port: fp }, to: { node: to, port: tp } });
  const mkSrc = (s, y) => add(sourceNode(nid(), 40, y, s), 40, y);
  let a = mkSrc(srcA, 80); let b = mkSrc(srcB, 300);
  if (spectral) {
    const aa = add({ id: nid(), type: 'pvocAnalyse' }, 250, 80); link(a, aa); a = aa;
    const ab = add({ id: nid(), type: 'pvocAnalyse' }, 250, 300); link(b, ab); b = ab;
  }
  const t = add({ id: nid(), type: 'transform', effectId: fx, state: { values, envs: {} } }, 470, 190);
  link(a, t, 'out', 'in'); link(b, t, 'out', 'in2');
  let prev = t;
  if (spectral) { const r = add({ id: nid(), type: 'pvocResynth' }, 690, 190); link(t, r); prev = r; }
  const out = add({ id: nid(), type: 'output' }, 910, 190); link(prev, out);
  return { app: 'cdp-web-patch', v: 1, metadata, nodes, edges };
}

// Additive re-synthesis: a source is PVOC-analysed and its partials drive an
// additive synth via its ◇ spectral input. `frq`/`data` are pre-baked from the
// ◇ Analyse tool, so the patch plays the resynthesis on load; press ◇ Analyse to
// re-derive (e.g. after changing the frame interval or the analysis mode).
function additiveResynth(metadata, source, frq, dur, data, analyse) {
  const nodes = [
    sourceNode('n1', 40, 130, source),
    { id: 'n2', type: 'pvocAnalyse', x: 250, y: 130 },
    { id: 'n3', type: 'generator', x: 470, y: 130, gen: { id: 'addsynth', values: { dur, frq }, envs: {}, data, analyse } },
    { id: 'n4', type: 'output', x: 760, y: 130 },
  ];
  const edges = [
    { from: { node: 'n1', port: 'out' }, to: { node: 'n2', port: 'in' } },
    { from: { node: 'n2', port: 'out' }, to: { node: 'n3', port: 'analyse' } },
    { from: { node: 'n3', port: 'out' }, to: { node: 'n4', port: 'in' } },
  ];
  return { app: 'cdp-web-patch', v: 1, metadata, nodes, edges };
}

export const RECIPES = [
  // ---- synthesis ------------------------------------------------------------
  chain({ name: 'Harmonic series', category: 'Synthesis',
    description: 'A sine tone steps up the harmonic series (110, 220, 330 … 880 Hz) and back down, then repeat — a frequency breakpoint arpeggiating the overtones of 110 Hz.' },
    gen('wave', { shape: '1', freq: 110, dur: 6, amp: 0.7 }, undefined, { freq: harmonicSeriesEnv(110, 8) }),
    []),

  additiveResynth({ name: 'Additive re-synthesis', category: 'Synthesis',
    description: 'A horn, PVOC-analysed and rebuilt as additive synthesis — 10 timbre frames of harmonic levels (at the detected 275 Hz) tracking the note’s swell and decay. Press ◇ Analyse on the synth to re-derive the partials; try the Inharmonic mode for bells/gongs, or a finer frame interval.' },
    src('horn'), 275, 5.4,
    '0 1 0.014 2 0.249 3 0.013 4 0.009 5 0 6 0 7 0 8 0 9 0 10 0 11 0 12 0 13 0\n0.5 1 0.185 2 0.294 3 0.045 4 0.053 5 0.022 6 0.017 7 0.006 8 0 9 0 10 0 11 0 12 0 13 0\n1 1 0.115 2 0.523 3 0.186 4 0.042 5 0.05 6 0.087 7 0.021 8 0.03 9 0 10 0 11 0 12 0 13 0\n1.5 1 0.264 2 0.779 3 0.155 4 0.097 5 0.035 6 0.037 7 0.078 8 0.067 9 0.037 10 0.025 11 0.019 12 0 13 0\n2 1 0.264 2 0.665 3 0.056 4 0.103 5 0.071 6 0.187 7 0.229 8 0.096 9 0 10 0 11 0.022 12 0.026 13 0.018\n2.5 1 0.28 2 1 3 0.241 4 0.313 5 0.11 6 0.184 7 0.192 8 0.094 9 0.036 10 0.034 11 0.03 12 0.022 13 0\n3 1 0.262 2 0.959 3 0.216 4 0.293 5 0.089 6 0.159 7 0.165 8 0.087 9 0.084 10 0.026 11 0.024 12 0 13 0\n3.5 1 0.267 2 0.429 3 0.084 4 0.24 5 0.117 6 0.144 7 0.077 8 0.055 9 0.026 10 0.024 11 0.01 12 0 13 0\n4 1 0.005 2 0.006 3 0.003 4 0.011 5 0.005 6 0.004 7 0.006 8 0.002 9 0.001 10 0 11 0.001 12 0.001 13 0\n4.5 1 0.002 2 0.002 3 0 4 0.001 5 0.001 6 0 7 0 8 0 9 0 10 0 11 0 12 0 13 0',
    { mode: 'harmonic', intervalMs: 500, matchPitch: true }),

  additiveResynth({ name: 'Inharmonic re-synthesis', category: 'Synthesis',
    description: 'A marimba rebuilt from its inharmonic modes — partial ratios 1 : 4.02 : 10.27 (the classic 1:4:10 bar tuning), each decaying at its own rate. This is the gong/bell path: press ◇ Analyse with the mode set to Inharmonic to re-derive any struck/resonant sound’s modes.' },
    src('marimba'), 260, 1.2,
    '0 1 0 4.0206 0 10.2746 0\n0.1 1 1 4.0206 0.041 10.2746 0.077\n0.2 1 0.521 4.0206 0.011 10.2746 0.047\n0.3 1 0.135 4.0206 0.005 10.2746 0.035\n0.4 1 0.05 4.0206 0.001 10.2746 0.015\n0.5 1 0.047 4.0206 0.002 10.2746 0.007\n0.6 1 0.051 4.0206 0.002 10.2746 0.005\n0.7 1 0.035 4.0206 0 10.2746 0.003\n0.8 1 0.023 4.0206 0.001 10.2746 0.001\n0.9 1 0.017 4.0206 0.001 10.2746 0.001\n1 1 0.001 4.0206 0 10.2746 0',
    { mode: 'inharmonic', intervalMs: 100, matchPitch: true }),

  // ---- waveset distortion ---------------------------------------------------
  chain({ name: 'Gritty saw', category: 'Distortion',
    description: 'A sawtooth roughened by waveset multiplication, then tamed in level — buzzy, raised in pitch.' },
    gen('wave', { shape: '3', freq: 110, dur: 2 }),
    [{ fx: 'distort.multiply', values: { factor: 6 } }, { fx: 'modify.loudness', values: { gain: 0.6 } }]),

  chain({ name: 'Telescoped impulses', category: 'Distortion',
    description: 'Telescope wavecycles of an impulse train together — a sharp time-contraction.' },
    gen('impulse', { dur: 3, pitch: 40 }),
    [{ fx: 'distort.telescope', values: { cycles: 6 } }]),

  chain({ name: 'Harmonic overload', category: 'Distortion',
    description: 'Add harmonics to a pure tone, then soft-overload it for warmth.' },
    gen('wave', { shape: '1', freq: 165, dur: 2 }),
    [{ fx: 'distort.harmonic', values: { h2: 0.6, h3: 0.4, h4: 0.2 } }, { fx: 'distort.overload', values: { level: 0.4, depth: 0.6 } }]),

  // ---- filtering / dynamics -------------------------------------------------
  chain({ name: 'Noise sweep', category: 'Filter',
    description: 'A resonant band sweeps up through white noise — classic filter-sweep gesture.' },
    gen('noise', { dur: 4 }),
    [{ fx: 'filter.sweeping', values: { acuity: 0.05, gain: 1, lofrq: 200, hifrq: 5000, rate: 0.4 } }]),

  chain({ name: 'Resonant comb', category: 'Filter',
    description: 'Fixed resonant filter bank rings a noise burst into a pitched, metallic tone.' },
    gen('noise', { dur: 2 }),
    [{ fx: 'filter.bank', values: { q: 40, lof: 220, hif: 6000 } }]),

  chain({ name: 'Tuned delay ping', category: 'Filter',
    description: 'Impulses through a short tuned delay — the feedback rings at a pitch.' },
    gen('impulse', { dur: 2, pitch: 36 }),
    [{ fx: 'newdelay.newdelay', values: { midipitch: 55, mix: 0.7, feedback: 0.7 } }]),

  chain({ name: 'Tremolo pad', category: 'Filter',
    description: 'Slow amplitude modulation turns a sustained tone into a pulsing pad.' },
    gen('wave', { shape: '1', freq: 220, dur: 3 }),
    [{ fx: 'tremolo.tremolo', values: { frq: 5, depth: 0.8 } }]),

  // ---- envelope -------------------------------------------------------------
  chain({ name: 'Swell', category: 'Envelope',
    description: 'Fade in to and out from a peak — a gentle swell shape imposed on a chord.' },
    gen('chord', { dur: 3 }, '52\n55\n59\n62'),
    [{ fx: 'envel.swell', values: { peaktime: 0.5 } }]),

  // ---- granular -------------------------------------------------------------
  chain({ name: 'Grain reorder', category: 'Granular',
    description: 'Chop an impulse stream into grains and shuffle their order.' },
    gen('impulse', { dur: 3, pitch: 48 }),
    [{ fx: 'grain.reorder', values: {} }]),

  chain({ name: 'Scrambled chord', category: 'Granular',
    description: 'Randomly cut a chord up and reassemble it into a stuttering texture.' },
    gen('chord', { dur: 3 }, '48\n55\n60\n64'),
    [{ fx: 'scramble.scramble', values: { dur: 3 } }]),

  // ---- extend / segment -----------------------------------------------------
  chain({ name: 'Iterated cloud', category: 'Extend',
    description: 'Iterate a short tone many times with random pitch/time scatter — a granular cloud.' },
    gen('wave', { shape: '1', freq: 330, dur: 0.4 }),
    [{ fx: 'extend.iterate', values: { reps: 12, pshift: 3, rand: 0.4 } }]),

  chain({ name: 'Stutter doublets', category: 'Extend',
    description: 'Cut the source into short segments and repeat each — a rhythmic stutter.' },
    gen('wave', { shape: '3', freq: 220, dur: 2 }),
    [{ fx: 'extend.doublets', values: { segdur: 0.12, repets: 3 } }]),

  // ---- spectral -------------------------------------------------------------
  chain({ name: 'Spectral blur wash', category: 'Spectral',
    description: 'Time-average the spectrum of noise into a soft, evolving wash. Demonstrates the PVOC analyse/resynth wrapper.' },
    gen('noise', { dur: 3 }),
    [{ fx: 'blur.blur', values: { windows: 40 } }]),

  chain({ name: 'Spectral freeze-stretch', category: 'Spectral',
    description: 'Stretch a chord in time without changing pitch — the phase vocoder smears it into a drone.' },
    gen('chord', { dur: 2 }, '48\n52\n55\n60'),
    [{ fx: 'stretch.time', values: { factor: 4 } }]),

  chain({ name: 'Exaggerated spectrum', category: 'Spectral',
    description: 'Sharpen the spectral peaks of a rich tone, focusing its timbre.' },
    gen('multiosc', { dur: 2, frq1: 180, frq2: 7 }),
    [{ fx: 'focus.exag', values: { exag: 3 } }]),

  chain({ name: 'Spectral chorus', category: 'Spectral',
    description: 'Random amplitude/frequency spread across analysis channels thickens a tone into a chorus.' },
    gen('wave', { shape: '3', freq: 165, dur: 3 }),
    [{ fx: 'blur.chorus', values: { aspread: 300, fspread: 3 } }]),

  // ---- spectral pitch -------------------------------------------------------
  chain({ name: 'Transpose up a fifth', category: 'Pitch',
    description: 'Spectral transposition lifts a chord by 7 semitones, formants and all.' },
    gen('chord', { dur: 2 }, '48\n52\n55'),
    [{ fx: 'repitch.transpose', values: { semitones: 7 } }]),

  // ---- two-input morph / vocode --------------------------------------------
  twoInput({ name: 'Morph tone → noise', category: 'Morph',
    description: 'Interpolate the spectrum of a tone into noise over time — a spectral cross-fade.' },
    gen('wave', { shape: '1', freq: 220, dur: 2 }), gen('noise', { dur: 2 }),
    'morph.morph', { dur: 1.5, expa: 1, expf: 1 }),

  twoInput({ name: 'Vocoder', category: 'Morph',
    description: "Impose a chord's formant spectrum onto noise — a vocoder/talkbox colour." },
    gen('noise', { dur: 2 }), gen('chord', { dur: 2 }, '52\n55\n59\n64'),
    'formants.vocode', { bands: 12, gain: 1 }),

  // ---- spatialisation -------------------------------------------------------
  chain({ name: 'Stereo placement', category: 'Spatialisation',
    description: 'Place a mono chord off to the right of the stereo field — the foundational pan (mono → stereo). −1 is hard left, 0 centre, +1 hard right.' },
    gen('chord', { dur: 3 }, '52\n55\n59\n64'),
    [{ fx: 'modify.space', values: { pan: 0.6 } }, { fx: 'modify.loudness', values: { gain: 4 } }]),

  chain({ name: 'Spinning image', category: 'Spatialisation',
    description: 'Pan a tone to centre, then spin the stereo image around the listener at 1 rotation/sec — a rotating-speaker / Leslie-style gesture built from Pan → Spin.' },
    gen('multiosc', { dur: 4, frq1: 180, frq2: 6 }),
    [{ fx: 'modify.space', values: { pan: 0 } }, { fx: 'spin.stereo', values: { rate: 1 } }]),

  chain({ name: 'Ambisonic orbit (B-format)', category: 'Spatialisation',
    description: 'Pan the horn into 1st-order ambisonic B-format (4-channel W/X/Y/Z) while orbiting it a full circle around the listener (start front, rotate clockwise). Decode the 4-channel result to stereo/binaural or a speaker ring for true periphony.' },
    src('horn'),
    [{ fx: 'abfpan.bformat', values: { startpos: 0, endpos: 1 } }]),

  chain({ name: 'Surround spread', category: 'Spatialisation',
    description: 'Spread a mono noise burst outward from the front channel across a 6-channel surround field — the source widens to fill the ring, level rolling off as it spreads.' },
    gen('noise', { dur: 3 }),
    [{ fx: 'mchanpan.spread', values: { chans: 6, centre: 1, spread: 8, depth: 4, rolloff: 0.5 } }]),

  // ---- mix ------------------------------------------------------------------
  twoInput({ name: 'Layered fifths', category: 'Mix',
    description: 'Mix two tones a fifth apart into one file.' },
    gen('wave', { shape: '1', freq: 220, dur: 2 }), gen('wave', { shape: '1', freq: 330, dur: 2 }),
    'submix.merge', { stagger: 0, skew: 1 }),

  // ---- recipes on bundled CDP demo sounds (File ▸ Recipes) ------------------
  // These load a real sound from audio/ — swap in your own via the Source
  // window's "Choose file…". Several mirror chains from CDP's own demo batch files.

  chain({ name: 'Marimba blur-drone', category: 'Sound files',
    description: 'A marimba note blurred across the spectrum then time-stretched into a sustained drone — the blur→stretch chain from CDP’s reentry demo.' },
    src('marimba'),
    [{ fx: 'blur.blur', values: { windows: 40 } }, { fx: 'stretch.time', values: { factor: 3 } }]),

  chain({ name: 'Marimba stretched', category: 'Sound files',
    description: 'Time-stretch the marimba ×6 without changing pitch — the attack smears into a bell-like pad.' },
    src('marimba'),
    [{ fx: 'stretch.time', values: { factor: 6 } }]),

  chain({ name: 'Horn filter sweep', category: 'Sound files',
    description: 'A resonant band sweeps slowly up through a sustained horn tone.' },
    src('horn'),
    [{ fx: 'filter.sweeping', values: { acuity: 0.05, gain: 1, lofrq: 200, hifrq: 4000, rate: 0.3 } }]),

  chain({ name: 'Horn up a fifth', category: 'Sound files',
    description: 'Spectral transposition lifts the horn by 7 semitones, formants and all.' },
    src('horn'),
    [{ fx: 'repitch.transpose', values: { semitones: 7 } }]),

  chain({ name: 'Scrambled speech', category: 'Sound files',
    description: 'Randomly cut up and reassemble the spoken voice into a stuttering collage.' },
    src('speech'),
    [{ fx: 'scramble.scramble', values: { dur: 3 } }]),

  chain({ name: 'Speech brassage', category: 'Sound files',
    description: 'Granular reconstitution (brassage) of the voice — re-grains the speech into a textured wash.' },
    src('speech'),
    [{ fx: 'modify.brassage', values: { pitch: -0.5 } }]),

  chain({ name: 'Frog granular cloud', category: 'Sound files',
    description: 'Iterate the frog sound many times with random pitch/time scatter into a dense cloud.' },
    src('frog'),
    [{ fx: 'extend.iterate', values: { reps: 10, pshift: 4, rand: 0.5 } }]),

  twoInput({ name: 'Talking horn (vocoder)', category: 'Sound files',
    description: 'Impose the speech’s formants onto the horn — the horn appears to talk.' },
    src('horn'), src('speech'),
    'formants.vocode', { bands: 8, gain: 1 }),

  twoInput({ name: 'Morph marimba → horn', category: 'Sound files',
    description: 'Spectrally morph the marimba into the horn over its first second — a timbral cross-fade between two real sounds (the morph spans the shorter sound).' },
    src('marimba'), src('horn'),
    'morph.morph', { dur: 0.8, expa: 1, expf: 1 }),
];

export default RECIPES;
