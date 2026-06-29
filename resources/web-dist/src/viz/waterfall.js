// Phase 3 — 3D hidden-line FFT waterfall (the classic Atari look). Pure,
// worker-side: draws over the SAME STFT frames the spectrogram uses. Each trace
// is a spectrum (frequency across, amplitude up); traces recede into depth
// (time). Hidden-line removal is the painter's algorithm — draw back-to-front,
// filling under each ridge with paper so nearer ridges occlude the lines behind.
//
// The box geometry (waterfallGeometry) is shared with the editor, which draws the
// amplitude / frequency / time axis lines + tick labels on top, so they register.
import { DYNAMIC_RANGE_DB } from './spectrogram.js';
import { fracToFreq } from './freqscale.js';
import { waterfallGeometry } from '../ui/viewport.js';

const MAX_TRACES = 40;   // spectra drawn back-to-front
const COLS = 180;        // frequency samples per trace
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Dotted grid on the far time-plane (amplitude horizontals + frequency
// verticals), drawn before the traces so peaks occlude it — the recede cue.
function drawGrid(ctx, g, ink, farTy) {
  ctx.save();
  ctx.setLineDash([1, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.4;
  const line = (a, b) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
  for (const a of [0, 0.25, 0.5, 0.75, 1]) line(g.project(0, farTy, a), g.project(1, farTy, a));  // amp rules
  for (let i = 0; i <= 8; i++) { const fx = i / 8; line(g.project(fx, farTy, 0), g.project(fx, farTy, 1)); }  // freq rules
  ctx.restore();
}

// Draw one channel lane's waterfall. `lane` is {top,height} in CSS px; the ctx is
// already under the dpr transform, so geometry here is CSS pixels. `dynRange` is
// the dB span shown; `dir` = +1 puts "now" (latest frame) at the front, -1 back.
// `yaw`/`pitch` orbit the camera.
export function renderWaterfall(ctx, lane, spec, vp, sampleRate, scale, cssW, dynRange = DYNAMIC_RANGE_DB, dir = 1, ink = '#000', paper = '#fff', yaw, pitch, smooth = 2) {
  const { mags, nFrames, nBins, hop, maxDb } = spec;
  const nyq = sampleRate / 2, binHz = nyq / nBins;
  const floorDb = maxDb - dynRange, invRange = 1 / dynRange;
  const g = waterfallGeometry(lane.top, lane.height, cssW, yaw, pitch);
  const near1 = g.depthPerTy >= 0;                    // true → ty=1 is nearest the camera
  drawGrid(ctx, g, ink, near1 ? 0 : 1);              // grid on the far plane

  // Frames visible in the viewport → trace set (subsampled to MAX_TRACES).
  const f0 = Math.max(0, Math.floor(vp.startSample / hop));
  const f1 = Math.min(nFrames - 1, Math.ceil(vp.endSample / hop));
  const framesInView = Math.max(0, f1 - f0);
  const N = Math.max(1, Math.min(MAX_TRACES, framesInView + 1));

  // Each column averages the bins it spans (mean dB) → smoother, less noisy ridge.
  const colLo = new Int32Array(COLS), colHi = new Int32Array(COLS);
  const cb = (u) => { const b = Math.round(fracToFreq(scale, clamp01(u), nyq) / binHz); return b < 0 ? 0 : b >= nBins ? nBins - 1 : b; };
  for (let j = 0; j < COLS; j++) {
    const lo = cb((j - 0.5) / (COLS - 1)), hi = cb((j + 0.5) / (COLS - 1));
    colLo[j] = Math.min(lo, hi); colHi[j] = Math.max(lo, hi);
  }

  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  const rx = new Float32Array(COLS), ry = new Float32Array(COLS);
  const fxp = new Float32Array(COLS), fyp = new Float32Array(COLS);
  const m = new Float32Array(COLS), ms = new Float32Array(COLS);
  const halfBucket = N > 1 ? (0.5 * framesInView) / (N - 1) : framesInView;
  for (let d = 0; d < N; d++) {                       // draw far → near for painter's occlusion
    const ti = near1 ? d : N - 1 - d;
    const ty = N > 1 ? ti / (N - 1) : 0;
    // 0=earliest .. 1=latest frame. dir<0 ('Front = start') puts earliest nearest.
    const fromNear = near1 ? 1 - ty : ty;             // 0 at the near edge .. 1 at the far
    const tau = dir < 0 ? fromNear : 1 - fromNear;
    const fc = f0 + tau * framesInView;
    let fa = Math.round(fc - halfBucket), fb = Math.round(fc + halfBucket);
    if (fa < f0) fa = f0; if (fb > f1) fb = f1; if (fb < fa) fb = fa;

    // Mean dB over this trace's time bucket × the bins each column spans.
    for (let j = 0; j < COLS; j++) {
      const lo = colLo[j], hi = colHi[j];
      let s = 0, cnt = 0;
      for (let fr = fa; fr <= fb; fr++) { const fi = fr * nBins; for (let b = lo; b <= hi; b++) { s += mags[fi + b]; cnt++; } }
      const db = cnt ? s / cnt : floorDb;
      m[j] = clamp01((db - floorDb) * invRange);
    }
    // Frequency smoothing: a triangular kernel of half-width `smooth` knocks back
    // the per-bin fuzz (smooth=0 → none; 2 → the classic [1 2 3 2 1]).
    if (smooth <= 0) {
      ms.set(m);
    } else {
      for (let j = 0; j < COLS; j++) {
        let s = 0, wsum = 0;
        for (let i = -smooth; i <= smooth; i++) {
          const idx = j + i; if (idx < 0 || idx >= COLS) continue;
          const w = smooth + 1 - Math.abs(i);
          s += m[idx] * w; wsum += w;
        }
        ms[j] = s / wsum;
      }
    }

    for (let j = 0; j < COLS; j++) {
      const fx = j / (COLS - 1);
      const pr = g.project(fx, ty, ms[j]); rx[j] = pr.x; ry[j] = pr.y;
      const pf = g.project(fx, ty, 0); fxp[j] = pf.x; fyp[j] = pf.y;
    }
    // Paper fill between ridge and floor occludes farther traces (drawn earlier).
    ctx.beginPath();
    ctx.moveTo(rx[0], ry[0]);
    for (let j = 1; j < COLS; j++) ctx.lineTo(rx[j], ry[j]);
    for (let j = COLS - 1; j >= 0; j--) ctx.lineTo(fxp[j], fyp[j]);
    ctx.closePath();
    ctx.fillStyle = paper;
    ctx.fill();
    // Ink-stroke the ridge line only.
    ctx.beginPath();
    ctx.moveTo(rx[0], ry[0]);
    for (let j = 1; j < COLS; j++) ctx.lineTo(rx[j], ry[j]);
    ctx.strokeStyle = ink;
    ctx.stroke();
  }
}
