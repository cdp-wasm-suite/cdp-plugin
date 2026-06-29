// Peak pyramid + viewport sampling for the waveform worker. Pure, no DOM.
//
// A pyramid is a stack of min/max summaries at geometrically growing bucket
// sizes: level 0 holds the min & max of every `base` samples, each higher level
// downsamples the one below by `factor`. Drawing a zoomed-out view then reads a
// level whose bucket ≈ samples-per-pixel, so each column scans only a handful of
// buckets instead of thousands of raw samples. Memory is bounded: total buckets
// ≈ length/base · (1 + 1/factor + 1/factor² + …) < length/base · factor/(factor-1).

export function buildPyramid(channel, base = 32, factor = 4) {
  const levels = [];
  const n = channel.length;
  if (n === 0) return levels;

  // Level 0 straight from the samples.
  let count = Math.ceil(n / base);
  let min = new Float32Array(count);
  let max = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    const s = b * base;
    const e = Math.min(n, s + base);
    let lo = Infinity, hi = -Infinity;
    for (let i = s; i < e; i++) { const v = channel[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (lo === Infinity) { lo = 0; hi = 0; }
    min[b] = lo; max[b] = hi;
  }
  levels.push({ bucket: base, count, min, max });

  // Coarser levels by merging `factor` buckets of the level below.
  while (levels[levels.length - 1].count > 1) {
    const prev = levels[levels.length - 1];
    const ccount = Math.ceil(prev.count / factor);
    const cmin = new Float32Array(ccount);
    const cmax = new Float32Array(ccount);
    for (let b = 0; b < ccount; b++) {
      const s = b * factor;
      const e = Math.min(prev.count, s + factor);
      let lo = Infinity, hi = -Infinity;
      for (let i = s; i < e; i++) { if (prev.min[i] < lo) lo = prev.min[i]; if (prev.max[i] > hi) hi = prev.max[i]; }
      if (lo === Infinity) { lo = 0; hi = 0; }
      cmin[b] = lo; cmax[b] = hi;
    }
    levels.push({ bucket: prev.bucket * factor, count: ccount, min: cmin, max: cmax });
  }
  return levels;
}

// Coarsest level whose bucket still resolves ≤ samples-per-pixel (so no detail
// is skipped between columns). Returns -1 when even level 0 is too coarse — i.e.
// the view is zoomed in past `base` samples/px and should scan raw samples.
export function pickLevel(levels, spp) {
  let chosen = -1;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i].bucket <= spp) chosen = i; else break;
  }
  return chosen;
}

// Per-column min/max across the viewport, for min/max "bar" rendering. Reads the
// chosen pyramid level, or raw samples when the view is zoomed in past level 0.
export function peaksForViewport(channel, levels, vp, cssW) {
  const min = new Float32Array(cssW);
  const max = new Float32Array(cssW);
  const span = vp.endSample - vp.startSample;
  const lvl = pickLevel(levels, span / cssW);
  const L = lvl >= 0 ? levels[lvl] : null;
  for (let x = 0; x < cssW; x++) {
    const s0 = vp.startSample + (x / cssW) * span;
    const s1 = vp.startSample + ((x + 1) / cssW) * span;
    let lo = Infinity, hi = -Infinity;
    if (L) {
      const a = Math.max(0, Math.floor(s0 / L.bucket));
      const b = Math.min(L.count, Math.ceil(s1 / L.bucket));
      for (let i = a; i < b; i++) { if (L.min[i] < lo) lo = L.min[i]; if (L.max[i] > hi) hi = L.max[i]; }
    } else {
      const a = Math.max(0, Math.floor(s0));
      const b = Math.min(channel.length, Math.ceil(s1));
      for (let i = a; i < b; i++) { const v = channel[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    if (lo === Infinity) { lo = 0; hi = 0; }
    min[x] = lo; max[x] = hi;
  }
  return { min, max };
}

// Band-limited reconstruction of the waveform at pixel resolution: the true
// continuous (sinc-interpolated) curve between samples, so a zoomed-in view is
// smooth instead of straight-line-jaggy. Uses a Lanczos-windowed sinc kernel of
// ±`radius` samples; reads neighbours outside the viewport (the kernel needs
// them) and treats out-of-range as zero. Returns one amplitude per pixel column.
export function sincReconstruct(channel, vp, cssW, radius = 16) {
  const span = vp.endSample - vp.startSample;
  const n = channel.length;
  const out = new Float32Array(cssW);
  const PI = Math.PI;
  for (let x = 0; x < cssW; x++) {
    const t = vp.startSample + (x / cssW) * span;   // fractional sample position
    const n0 = Math.floor(t);
    const k0 = Math.max(0, n0 - radius + 1), k1 = Math.min(n - 1, n0 + radius);
    let sum = 0;
    for (let k = k0; k <= k1; k++) {
      const d = t - k;
      let w;
      if (d === 0) w = 1;
      else { const pd = PI * d; w = (Math.sin(pd) / pd) * (Math.sin(pd / radius) / (pd / radius)); }   // sinc · Lanczos window
      sum += channel[k] * w;
    }
    out[x] = sum;
  }
  return out;
}

// Individual sample points across the viewport (plus one either side so the
// polyline reaches the edges), for sample-line rendering when zoomed in. Each
// point is { x: pixel, i: sample index, v: amplitude }.
export function samplesForViewport(channel, vp, cssW) {
  const span = vp.endSample - vp.startSample;
  const pts = [];
  const start = Math.max(0, Math.floor(vp.startSample) - 1);
  const end = Math.min(channel.length - 1, Math.ceil(vp.endSample) + 1);
  for (let i = start; i <= end; i++) {
    pts.push({ x: ((i - vp.startSample) / span) * cssW, i, v: channel[i] });
  }
  return pts;
}
