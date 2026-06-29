// 1-bit spectrogram (Phase 2). Pure, worker-side: a hand-rolled radix-2 FFT, a
// Hann-windowed STFT magnitude (dB) cache built once per channel, and a renderer
// that maps the cached frames to the live viewport time axis with 8×8 Bayer
// ordered dithering down to 1-bit (ink = energy on paper). Consumes the SAME
// channel samples and the SAME viewport as the waveform path — no new data.

import { fracToFreq } from './freqscale.js';

// 8×8 Bayer ordered-dither threshold matrix, normalized to (0,1). A pixel is ink
// when its magnitude exceeds the threshold at (x%8, y%8), so higher energy →
// more ink, giving smooth tonal shading from two colours.
const BAYER8 = (() => {
  const m = [
    [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
  ];
  const f = new Float32Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) f[y * 8 + x] = (m[y][x] + 0.5) / 64;
  return f;
})();

export const FFT_SIZE = 1024;
export const HOP = 256;
export const DYNAMIC_RANGE_DB = 80;   // shown span below the spectrogram's peak

// Analysis windows. Blackman-Harris has the lowest sidelobes (cleanest, least
// spectral leakage → less "noise"); rect is raw (most leakage).
export const WINDOWS = ['hann', 'blackman', 'hamming', 'rect'];
function windowSample(type, n, N) {
  const a = (2 * Math.PI * n) / (N - 1);
  switch (type) {
    case 'rect': return 1;
    case 'hamming': return 0.54 - 0.46 * Math.cos(a);
    case 'blackman': return 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a);
    default: return 0.5 - 0.5 * Math.cos(a); // hann
  }
}

// In-place iterative radix-2 FFT (decimation-in-time). re/im are length N (a
// power of two); on return they hold the transform.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + (len >> 1)] * cr - im[i + k + (len >> 1)] * ci;
        const bi = re[i + k + (len >> 1)] * ci + im[i + k + (len >> 1)] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + (len >> 1)] = ar - br; im[i + k + (len >> 1)] = ai - bi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// Build the magnitude-dB STFT for one channel. Frame f windows samples starting
// at f*HOP; bin b is f*nBins + b in the flat `mags` array. Bounded memory:
// ceil(length/HOP) × (FFT_SIZE/2) floats.
export function buildSpectrogram(channel, { fftSize = FFT_SIZE, hop = HOP, window = 'hann' } = {}) {
  const nBins = fftSize >> 1;
  const n = channel.length;
  const nFrames = Math.max(1, Math.ceil(n / hop));
  const win = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) win[i] = windowSample(window, i, fftSize);
  const mags = new Float32Array(nFrames * nBins);
  const re = new Float32Array(fftSize), im = new Float32Array(fftSize);
  let maxDb = -Infinity;
  for (let f = 0; f < nFrames; f++) {
    const s0 = f * hop;
    for (let i = 0; i < fftSize; i++) { const idx = s0 + i; re[i] = idx < n ? channel[idx] * win[i] : 0; im[i] = 0; }
    fft(re, im);
    const base = f * nBins;
    for (let b = 0; b < nBins; b++) {
      const db = 20 * Math.log10(Math.sqrt(re[b] * re[b] + im[b] * im[b]) + 1e-9);
      mags[base + b] = db;
      if (db > maxDb) maxDb = db;
    }
  }
  return { mags, nFrames, nBins, fftSize, hop, maxDb };
}

// Render one channel lane of the spectrogram into an RGBA buffer (device pixels):
// columns map to the viewport's sample range → STFT frames; rows map to frequency
// (top = Nyquist, bottom = DC) through the chosen scale (linear/log/mel). Only ink
// pixels are written black; the caller pre-fills the buffer with paper white.
export function renderSpectrogramLane(data, W, dTop, dBot, spec, vp, nyquist, scale = 'linear', dynRange = DYNAMIC_RANGE_DB, inkRGB = [0, 0, 0]) {
  const [ir, ig, ib] = inkRGB;
  const { mags, nFrames, nBins, hop, maxDb } = spec;
  const floorDb = maxDb - dynRange;
  const invRange = 1 / (maxDb - floorDb);
  const laneH = dBot - dTop;
  const binHz = nyquist / nBins;
  const vpStart = vp.startSample, vpSpan = vp.endSample - vp.startSample;

  const frameOf = new Int32Array(W);     // STFT frame per column
  for (let px = 0; px < W; px++) {
    let fr = Math.floor((vpStart + (px / W) * vpSpan) / hop);
    fr = fr < 0 ? 0 : fr >= nFrames ? nFrames - 1 : fr;
    frameOf[px] = fr * nBins;
  }
  // Per row, the bin range it covers — averaged (mean dB) to smooth, capped so an
  // extremely zoomed-out frequency axis stays cheap.
  const loB = new Int32Array(laneH), hiB = new Int32Array(laneH);
  for (let r = 0; r < laneH; r++) binRange(scale, r, laneH, nyquist, binHz, nBins, loB, hiB);
  for (let py = dTop; py < dBot; py++) {
    const r = py - dTop, lo = loB[r], hi = hiB[r], span = hi - lo + 1;
    const brow = (py & 7) * 8;
    let o = py * W * 4;
    for (let px = 0; px < W; px++, o += 4) {
      const base = frameOf[px];
      let db; if (span <= 1) db = mags[base + lo]; else { let s = 0; for (let b = lo; b <= hi; b++) s += mags[base + b]; db = s / span; }
      let m = (db - floorDb) * invRange;
      if (m > 1) m = 1;
      if (m > BAYER8[brow + (px & 7)]) { data[o] = ir; data[o + 1] = ig; data[o + 2] = ib; } // else paper (pre-filled)
    }
  }
}

// Bin span covered by lane row r (0 = top/Nyquist), clamped + capped to 8 bins.
function binRange(scale, r, laneH, nyquist, binHz, nBins, loB, hiB) {
  const f0 = fracToFreq(scale, Math.max(0, 1 - (r + 1) / laneH), nyquist);
  const f1 = fracToFreq(scale, Math.min(1, 1 - r / laneH), nyquist);
  let lo = Math.round(Math.min(f0, f1) / binHz);
  let hi = Math.round(Math.max(f0, f1) / binHz);
  if (hi - lo > 8) { const c = (lo + hi) >> 1; lo = c; hi = c; }
  loB[r] = lo < 0 ? 0 : lo >= nBins ? nBins - 1 : lo;
  hiB[r] = hi < 0 ? 0 : hi >= nBins ? nBins - 1 : hi;
}
