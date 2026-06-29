// Patcher execution engine: a typed node graph run on demand from an Output node.
// Pure consumer of the cdp-wasm package; the patcher (patcher.js) owns the DOM and
// builds the node/edge model this operates on.
//
// Phase 1 is audio-domain: cables carry WAV bytes. Transform nodes run through
// applyEffect() (which internally handles spectral effects via pvoc anal/synth),
// so spectral effects work today as audio-in/audio-out. Phase 2 adds explicit
// PVOC Analyse/Resynthesise nodes + a 'spectral' cable kind for faithful, no-
// round-trip spectral chains.
import { EFFECTS, applyEffect, buildArgs, programsFor, conformChannels, GENERATORS, genById, applyGenerator } from '@olilarkin/cdp-wasm';
import { log, wavDuration, parseBrk, axisFlags } from '../ui/ui.js';
import { renderFaust } from '../dsp/faust.js';
// Synthesis generators now live in the package (single source of truth); re-export
// so the patcher can keep importing them from here.
export { GENERATORS, genById, applyGenerator };
import { getBpm } from '../data/tempo.js';

// Format real-valued breakpoint points to CDP "time value" text.
const fmtPts = (pts) => pts.map(([t, v]) => `${(+t).toFixed(3)} ${+(+v).toFixed(4)}`).join('\n');

// Convert an editor envelope's points to a CDP "time value" breakpoint file,
// denormalising each axis independently per its flags (see axisFlags):
//   value: vnorm → scaled across the target param's [min,max]; else passed as-is.
//   time:  tnorm → scaled over `dur` seconds; else seconds, or beats→seconds.
// CDP only knows real seconds and real values, so this is where the editor's
// normalised/tempo conveniences are resolved.
export function envToBrk(pts, p, dur, flags = {}) {
  const { vnorm, tnorm, tunit } = axisFlags(flags);
  const lo = p ? p.min : 0, hi = p ? p.max : 1, span = (hi - lo) || 1;
  const k = 60 / getBpm();
  return pts.map(([x, y]) => {
    const t = tnorm ? x * (dur || 1) : (tunit === 'beat' ? x * k : x);
    const v = (vnorm && p) ? lo + y * span : y;
    return `${(+t).toFixed(3)} ${+(+v).toFixed(4)}`;
  }).join('\n');
}

// Like envToBrk, but returns denormalised [time, value] points (real seconds,
// real values) instead of CDP brk text — for Faust nodes, which sample envelopes
// per render block rather than reading a .brk file. Same axis semantics.
export function envToPoints(pts, p, dur, flags = {}) {
  const { vnorm, tnorm, tunit } = axisFlags(flags);
  const lo = p ? p.min : 0, hi = p ? p.max : 1, span = (hi - lo) || 1;
  const k = 60 / getBpm();
  return pts.map(([x, y]) => {
    const t = tnorm ? x * (dur || 1) : (tunit === 'beat' ? x * k : x);
    const v = (vnorm && p) ? lo + y * span : y;
    return [t, v];
  });
}

export const byId = Object.fromEntries(EFFECTS.map((e) => [e.id, e]));

// ---- model helpers ----------------------------------------------------------
// node = { id, type:'source'|'transform'|'rawTransform'|'pvocAnalyse'|'pvocResynth'|'output'|'log',
//          x, y, source?:{kind,wav}, effectId?, state?:{values,envs}, raw?:{program,args,data},
//          inPorts:[{name,kind}], outPort:{name,kind}|null }
// edge = { id, from:{node,port}, to:{node,port}, kind }

export const inEdge = (patch, nodeId, port) =>
  patch.edges.find((e) => e.to.node === nodeId && e.to.port === port);

export const portKind = (node, portName) => {
  if (node.outPort && node.outPort.name === portName) return node.outPort.kind;
  let p = (node.inPorts || []).find((x) => x.name === portName);
  if (!p) p = (node.paramPorts || []).find((x) => x.name === portName); // breakpoint→param ports
  return p ? p.kind : null;
};

// ---- auto-layout -------------------------------------------------------------
// Lay a node graph out left-to-right as a layered DAG (signal flows rightward):
// each node sits one column right of its furthest upstream node, and columns are
// stacked vertically and centred. A few barycentre sweeps order each column to
// reduce cable crossings (e.g. a two-input morph's two sources line up with its
// two analyse nodes). Pure: takes measured sizes, returns id -> {x,y}; the caller
// applies and clamps them to the desktop.
//
//   items: [{ id, w, h }]   edges: [{ from:{node}, to:{node} }]
export function layoutGraph(items, edges, opts = {}) {
  const { startX = 24, startY = 20, colGap = 56, rowGap = 26 } = opts;
  const byId = new Map(items.map((n) => [n.id, n]));
  const succ = new Map(items.map((n) => [n.id, []]));
  const pred = new Map(items.map((n) => [n.id, []]));
  for (const e of edges) {
    const f = e.from.node, t = e.to.node;
    if (!byId.has(f) || !byId.has(t) || f === t) continue;
    succ.get(f).push(t); pred.get(t).push(f);
  }
  // Kahn topological order (graph is acyclic by construction)
  const indeg = new Map(items.map((n) => [n.id, pred.get(n.id).length]));
  const queue = items.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  while (queue.length) {
    const u = queue.shift(); order.push(u);
    for (const v of succ.get(u)) { indeg.set(v, indeg.get(v) - 1); if (indeg.get(v) === 0) queue.push(v); }
  }
  for (const n of items) if (!order.includes(n.id)) order.push(n.id); // any cycle leftovers
  // longest-path layering: a node is one past its furthest predecessor
  const layer = new Map(items.map((n) => [n.id, 0]));
  for (const u of order) for (const v of succ.get(u)) layer.set(v, Math.max(layer.get(v), layer.get(u) + 1));
  const layers = [];
  for (const n of items) (layers[layer.get(n.id)] ||= []).push(n.id);

  // order within each layer by the mean index of its predecessors in the layer
  // to its left (barycentre heuristic), a few sweeps for stability
  const idx = new Map();
  const reindex = () => { for (const L of layers) L && L.forEach((id, i) => idx.set(id, i)); };
  reindex();
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let L = 1; L < layers.length; L++) {
      const arr = layers[L]; if (!arr) continue;
      const bc = (id) => {
        const ps = pred.get(id).filter((p) => layer.get(p) === L - 1);
        return ps.length ? ps.reduce((s, p) => s + (idx.get(p) || 0), 0) / ps.length : (idx.get(id) || 0);
      };
      arr.sort((a, b) => bc(a) - bc(b)); reindex();
    }
  }

  // column x from measured widths; column height for vertical centring
  const colW = layers.map((L) => (L ? Math.max(...L.map((id) => byId.get(id).w)) : 0));
  const colX = []; let x = startX;
  for (let L = 0; L < layers.length; L++) { colX[L] = x; x += colW[L] + colGap; }
  const colH = layers.map((L) => (L ? L.reduce((s, id) => s + byId.get(id).h, 0) + rowGap * (L.length - 1) : 0));
  const maxH = Math.max(0, ...colH);

  const pos = new Map();
  for (let L = 0; L < layers.length; L++) {
    const arr = layers[L]; if (!arr) continue;
    let y = startY + (maxH - colH[L]) / 2;
    for (const id of arr) { pos.set(id, { x: colX[L], y }); y += byId.get(id).h + rowGap; }
  }
  return pos;
}


// Can `start` reach `target` by following edges output→input? (used for cycle test)
function reaches(patch, start, target) {
  const seen = new Set(); const stack = [start];
  while (stack.length) {
    const n = stack.pop();
    if (n === target) return true;
    if (seen.has(n)) continue; seen.add(n);
    for (const e of patch.edges) if (e.from.node === n) stack.push(e.to.node);
  }
  return false;
}

// Validate a proposed connection output(from) -> input(to). Returns {ok} or {ok:false,reason}.
export function validateConnection(patch, from, to) {
  if (from.node === to.node) return { ok: false, reason: 'same window' };
  const fn = patch.nodes.get(from.node), tn = patch.nodes.get(to.node);
  if (!fn || !tn) return { ok: false, reason: 'missing node' };
  const fk = portKind(fn, from.port), tk = portKind(tn, to.port);
  if (!fk || !tk) return { ok: false, reason: 'missing port' };
  if (fk !== tk) return { ok: false, reason: `type mismatch (${fk} → ${tk})` };
  if (inEdge(patch, to.node, to.port)) return { ok: false, reason: 'input already connected' };
  if (reaches(patch, to.node, from.node)) return { ok: false, reason: 'would create a cycle' };
  return { ok: true };
}

// ---- runner -----------------------------------------------------------------
export class GraphRunner {
  // onNode(id, result) fires once per node as it resolves during a run — lets the
  // UI show each upstream node's computed audio (e.g. generator previews), not
  // just the final output. `sampleRate` is the session rate at which generators
  // (CDP + Faust) synthesise; the host updates it when the user changes it.
  constructor(cdp, onNode = null) { this.cdp = cdp; this.onNode = onNode; this.sampleRate = 44100; }

  // Resolve the audio at `outputId` by pulling its upstream graph. Memoised per run
  // (a fan-out source executes once). The graph is acyclic by construction
  // (validateConnection rejects cycles), so no cycle guard is needed here.
  async run(patch, outputId) {
    return (await this._resolve(patch, outputId, new Map())).bytes;
  }

  _resolve(patch, id, memo) {
    if (memo.has(id)) return memo.get(id);
    const pr = this._exec(patch, id, memo);
    memo.set(id, pr);
    if (this.onNode) pr.then((r) => this.onNode(id, r)).catch(() => {});   // notify on success; errors surface via run()
    return pr;
  }

  async _exec(patch, id, memo) {
    const node = patch.nodes.get(id);
    if (!node) throw new Error('missing node ' + id);
    const get = async (port) => {
      const e = inEdge(patch, id, port);
      return e ? this._resolve(patch, e.from.node, memo) : null;
    };
    switch (node.type) {
      case 'source':
        if (!node.source || !node.source.wav) throw new Error('Source is empty — load a sound file');
        return { kind: 'audio', bytes: node.source.wav, dur: wavDuration(node.source.wav) };
      case 'generator': {
        const spec = genById[node.genId];
        if (!spec) throw new Error('unknown generator ' + node.genId);
        // Envelopes (inline + breakpoint windows cabled to param ports), scaled
        // over the generator's own duration, become brk files for env-capable params.
        const dur = Number(node.state?.values?.dur) || 2;
        const merged = this._mergeBrk(node, spec.params, dur, await this._gatherBrk(patch, node, spec, dur, memo));
        const brk = {};
        for (const [name, text] of Object.entries(merged)) {
          if (spec.params.some((p) => p.name === name && p.env)) brk[name] = text;
        }
        await this.cdp.load(spec.program);
        log(`generate: ${spec.label} (${spec.program})`);
        const wav = await applyGenerator(this.cdp, spec, node.state?.values || {}, { brk, data: node.data, sampleRate: this.sampleRate });
        return { kind: 'audio', bytes: wav, dur: wavDuration(wav) };
      }
      case 'breakpoint': {
        const bp = node.bp || {};
        const pts = parseBrk(bp.text);
        return { kind: 'breakpoint', ...axisFlags(bp), pts: pts.length >= 2 ? pts : [[0, 0.5], [1, 0.5]] };
      }
      case 'output': {
        const i = await get('in');
        if (!i) throw new Error('Output has nothing connected to its input');
        return i;
      }
      case 'pvocAnalyse': {
        const i = await get('in');
        if (!i || i.kind !== 'audio') throw new Error('PVOC Analyse needs an audio input');
        const ana = (await this.cdp.process('pvoc', ['anal', '1', '$IN', '$OUT'], conformChannels(i.bytes, 'mono'), { outExt: 'ana' })).bytes;
        return { kind: 'spectral', bytes: ana, dur: i.dur };
      }
      case 'pvocResynth': {
        const i = await get('in');
        if (!i || i.kind !== 'spectral') throw new Error('PVOC Resynthesise needs a spectral input');
        const wav = (await this.cdp.process('pvoc', ['synth', '$IN', '$OUT'], i.bytes, { inExt: 'ana' })).bytes;
        return { kind: 'audio', bytes: wav, dur: i.dur };
      }
      case 'transform': {
        const eff = byId[node.effectId];
        if (!eff) throw new Error('unknown effect ' + node.effectId);
        const a = await get('in'), b = await get('in2');
        const brk = await this._gatherBrk(patch, node, eff, (a && a.dur) || 1, memo);
        return eff.domain === 'spectral' ? this._transformSpectral(node, eff, a, b, brk) : this._transformSound(node, eff, a, b, brk);
      }
      case 'rawTransform': return this._raw(node, await get('in'), await get('in2'));
      case 'faust': {
        // I/O is whatever the compiled DSP declares: with no audio inputs it's a
        // generator (renders `dur`); otherwise an effect. A DSP may declare several
        // separate input cables (cdp_inputs) — gather them all in port order.
        const ins = [];
        for (const p of node.inPorts || []) {
          const r = await get(p.name);
          if (r && r.kind === 'audio') ins.push(r);
        }
        const dur = Number(node.state?.values?.dur) || 3;
        const refDur = (ins[0] && ins[0].dur) || dur;   // scale time-normalised envelopes
        const mod = await this._faustEnvs(patch, node, { params: node.params || [] }, refDur, memo);
        log(`faust: ${node.faustKind || 'dsp'}`);
        // sampleRate only applies when there are no inputs (generator); for an
        // effect renderFaust adopts the input file's rate and ignores this.
        const wav = await renderFaust({ code: node.code, values: node.state?.values || {}, mod, dur, inputWavs: ins.map((i) => i.bytes), sampleRate: this.sampleRate });
        return { kind: 'audio', bytes: wav, dur: wavDuration(wav) };
      }
      default: throw new Error('cannot run node type ' + node.type);
    }
  }

  // Resolve any breakpoint windows cabled into a transform's per-parameter ports,
  // scaling each to that parameter's range and the input duration.
  async _gatherBrk(patch, node, eff, dur, memo) {
    const out = {};
    for (const port of node.paramPorts || []) {
      const e = inEdge(patch, node.id, port.name);
      if (!e) continue;
      const r = await this._resolve(patch, e.from.node, memo);
      if (!r || r.kind !== 'breakpoint') continue;
      const name = port.name.slice('param:'.length);
      const p = (eff.params || []).find((q) => q.name === name);
      if (p) out[name] = envToBrk(r.pts, p, dur, r);
    }
    return out;
  }

  // Resolve a Faust node's envelopes to {paramName: [[tSec,value],…]} (real units),
  // combining inline state.envs with breakpoint windows cabled to its param ports
  // (cabled wins, matching the CDP path). renderFaust samples these per block.
  async _faustEnvs(patch, node, spec, dur, memo) {
    const out = {};
    for (const [k, e] of Object.entries(node.state?.envs || {})) {
      if (!e || !e.text || !e.text.trim()) continue;
      const p = (spec.params || []).find((q) => q.name === k);
      out[k] = envToPoints(parseBrk(e.text), p, dur, e);
    }
    for (const port of node.paramPorts || []) {
      const ed = inEdge(patch, node.id, port.name);
      if (!ed) continue;
      const r = await this._resolve(patch, ed.from.node, memo);
      if (!r || r.kind !== 'breakpoint') continue;
      const name = port.name.slice('param:'.length);
      const p = (spec.params || []).find((q) => q.name === name);
      if (p) out[name] = envToPoints(r.pts, p, dur, r);
    }
    return out;
  }

  // Merge a node's inline envelopes (state.envs: {name:{vnorm,tnorm,tunit,text}})
  // with cabled breakpoints (connectedBrk wins). envToBrk resolves each envelope's
  // normalised/tempo axes to the real seconds & values CDP expects.
  _mergeBrk(node, params, dur, connectedBrk) {
    const brk = {};
    for (const [k, e] of Object.entries(node.state?.envs || {})) {
      if (!e || !e.text || !e.text.trim()) continue;
      const p = (params || []).find((q) => q.name === k);
      brk[k] = envToBrk(parseBrk(e.text), p, dur, e);
    }
    Object.assign(brk, connectedBrk || {});
    return brk;
  }

  // Sound-domain transform: audio in -> audio out, via applyEffect (handles
  // mono-split / derive / data / pipeline / two-input internally).
  async _transformSound(node, eff, inp, inp2, connectedBrk) {
    if (!inp || !inp.bytes) throw new Error(`${eff.label}: connect an audio source to its input`);
    const brk = this._mergeBrk(node, eff.params, (inp && inp.dur) || 1, connectedBrk);
    const extra = {};
    if (Object.keys(brk).length) extra.brk = brk;
    if (eff.inputs >= 2) extra.in2 = (inp2 && inp2.bytes) || inp.bytes;
    await this.cdp.load(...programsFor(eff));
    log(`run: ${eff.label} (${eff.program})`);
    const bytes = await applyEffect(this.cdp, eff, node.state.values || {}, inp.bytes, extra);
    return { kind: 'audio', bytes, dur: inp.dur };
  }

  // Spectral-domain transform: spectral in -> spectral out, run directly on .ana
  // (no pvoc round-trip — analysis/synthesis are separate PVOC nodes).
  async _transformSpectral(node, eff, inp, inp2, connectedBrk) {
    if (!inp || inp.kind !== 'spectral') throw new Error(`${eff.label}: needs a spectral input — add a PVOC Analyse node`);
    const merged = this._mergeBrk(node, eff.params, (inp && inp.dur) || 1, connectedBrk);
    const vals = { ...(node.state?.values || {}) };
    const brkInputs = {};
    for (const [name, t] of Object.entries(merged)) {
      const path = `/brk_${name}.brk`;
      brkInputs[path] = new TextEncoder().encode(t);
      vals[name] = path;
    }
    const args = buildArgs(eff, vals).map((a) =>
      a === '$IN' ? '/in.ana' : a === '$IN2' ? '/in2.ana' : a === '$OUT' ? '/out.ana' : a === '$DATA' ? '/data.txt' : a);
    const inputs = { '/in.ana': inp.bytes, ...brkInputs };
    if (eff.inputs >= 2) inputs['/in2.ana'] = (inp2 && inp2.bytes) || inp.bytes;
    if (eff.data) { const d = eff.data(vals); inputs['/data.txt'] = typeof d === 'string' ? new TextEncoder().encode(d) : d; }
    await this.cdp.load(...programsFor(eff));
    log(`run: ${eff.label} (spectral)`);
    const res = await this.cdp.run(eff.program, args, { inputs, outputs: ['/out.ana'] });
    const out = res.outputs['/out.ana'];
    if (!out) throw new Error(`${eff.label} produced no output (exit ${res.exitCode}).\n${res.stderr || res.stdout}`.trim());
    return { kind: 'spectral', bytes: out, dur: inp.dur };
  }

  // Raw CLI node: mirrors main.js runRaw using the node's program/args/data and the
  // resolved upstream audio. Supports $IN/$IN2/$ANA/$ANA2/$OUT/$OUTANA/$DATA.
  async _raw(node, inp, inp2) {
    const cdp = this.cdp;
    const { program, args = '$IN $OUT', data = '' } = node.raw || {};
    const inWav = inp && inp.bytes;
    if (!inWav) throw new Error(`${program}: connect an audio source to its input`);
    const in2Wav = (inp2 && inp2.bytes) || inWav;
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const inputs = {};
    let outPath = null, outAna = null;
    const analyse = async (wav) => (await cdp.process('pvoc', ['anal', '1', '$IN', '$OUT'], conformChannels(wav, 'mono'), { outExt: 'ana' })).bytes;
    if (tokens.includes('$ANA')) inputs['/in.ana'] = await analyse(inWav);
    if (tokens.includes('$ANA2')) inputs['/in2.ana'] = await analyse(in2Wav);
    const mapped = tokens.map((t) => {
      switch (t) {
        case '$IN': inputs['/in.wav'] = inWav; return '/in.wav';
        case '$IN2': inputs['/in2.wav'] = in2Wav; return '/in2.wav';
        case '$OUT': outPath = '/out.wav'; return '/out.wav';
        case '$ANA': return '/in.ana';
        case '$ANA2': return '/in2.ana';
        case '$OUTANA': outAna = '/out.ana'; return '/out.ana';
        case '$DATA': inputs['/data.txt'] = new TextEncoder().encode(data); return '/data.txt';
        default: return t;
      }
    });
    log(`run: ${program} ${mapped.join(' ')}`);
    const res = await cdp.run(program, mapped, { inputs, outputs: [outPath, outAna].filter(Boolean) });
    if (res.stderr && res.stderr.trim()) log(res.stderr.trim());
    let wav = outPath && res.outputs[outPath];
    if (!wav && outAna && res.outputs[outAna]) {
      wav = (await cdp.process('pvoc', ['synth', '$IN', '$OUT'], res.outputs[outAna], { inExt: 'ana' })).bytes;
    }
    if (!wav || wav.length <= 44) throw new Error(`${program}: produced no audio (exit ${res.exitCode}) — check the args`);
    return { kind: 'audio', bytes: wav, dur: wavDuration(wav) };
  }
}
