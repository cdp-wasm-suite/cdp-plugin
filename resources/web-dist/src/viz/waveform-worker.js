// Waveform render worker (module worker). Owns the transferred channel data, the
// peak pyramids, and a standalone OffscreenCanvas; renders all channel lanes and
// ships each frame back as an ImageBitmap.
//
// Rendering model: the worker draws into its OWN OffscreenCanvas (created here,
// NOT transferControlToOffscreen'd from the DOM), then ships a
// transferToImageBitmap() frame to the main thread, which blits it onto a normal
// <canvas>. This composites through the same path as any main-thread canvas —
// sidestepping the Chrome GPU bug where a transferred-control placeholder canvas
// (and two stacked canvases) paint blank.
import { laneRect, ampToY, samplesPerPixel } from '../ui/viewport.js';
import { buildPyramid, peaksForViewport, samplesForViewport, sincReconstruct } from './peaks.js';
import { buildSpectrogram, renderSpectrogramLane } from './spectrogram.js';
import { renderWaterfall } from './waterfall.js';

let surface = null;       // OffscreenCanvas the worker renders into
let ctx = null;
let dpr = 1, cssW = 0, cssH = 0;
let numChannels = 1;
let channels = [];        // Float32Array[] (transferred buffers)
let pyramids = [];        // per-channel min/max peak pyramids
let specs = [];           // per-channel STFT magnitude caches (lazy)
let specImage = null;     // reusable RGBA buffer for spectrogram render
let mode = 'waveform';    // 'waveform' | 'spectrogram' | 'waterfall'
let freqScale = 'linear'; // spectrogram Y axis: 'linear' | 'log' | 'mel'
let playHead = null;      // during playback the waterfall scrolls to end here (samples)
let stft = { fftSize: 1024, hop: 256, window: 'hann' };  // STFT analysis params
let dynRange = 80;        // dB span shown
let waterDir = 1;         // waterfall: +1 = newest at front, -1 = newest at back
let waterYaw = 0.5, waterPitch = 0.34;   // waterfall orbit camera (radians)
let waterSmooth = 2;      // waterfall frequency-smoothing half-width
// Theme colours (set from the editor at init); ink = foreground, paper = bg.
let inkStr = '#000', paperStr = '#fff';
let inkRGB = [0, 0, 0], paperRGB = [255, 255, 255];
function hexToRgb(h) {
  h = (h || '').trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function setTheme(ink, paper) {
  if (ink) { inkStr = ink; inkRGB = hexToRgb(ink); }
  if (paper) { paperStr = paper; paperRGB = hexToRgb(paper); }
}
let sampleRate = 44100, totalSamples = 0;
let viewport = null;
let pending = 0;

// Below this many samples/pixel, draw individual samples (line, plus dots once
// they are far enough apart) instead of min/max bars.
const SAMPLE_MODE_SPP = 1;
const DOT_SPACING_PX = 7;

// Coalesce many state changes into one paint (latest-wins). Workers have no
// requestAnimationFrame (it's a Window-only API), so a 0ms timer is the
// coalescer — it batches a burst of messages within the same task.
function schedule() {
  if (pending || !ctx) return;
  pending = setTimeout(() => { pending = 0; render(); }, 0);
}

function applySize() {
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (!surface) { surface = new OffscreenCanvas(w, h); ctx = surface.getContext('2d'); }
  else { surface.width = w; surface.height = h; }
}

// Build the STFT cache for every channel on demand (first spectrogram render).
function ensureSpecs() {
  if (!channels.length) return false;
  if (specs.length !== channels.length) specs = channels.map((ch) => buildSpectrogram(ch, stft));
  return true;
}

function render() {
  if (!ctx) return;
  if (mode === 'spectrogram' && viewport && ensureSpecs()) drawSpectrogram();
  else if (mode === 'waterfall' && viewport && ensureSpecs()) drawWaterfall();
  else drawWaveform();
  // Ship the frame: transferToImageBitmap hands the pixels to the main thread
  // zero-copy (and resets the surface, which we fully redraw next frame).
  const bitmap = surface.transferToImageBitmap();
  postMessage({ type: 'frame', bitmap, viewport }, [bitmap]);
}

// Spectrogram: build an RGBA buffer in device pixels (the 1-bit dither must land
// on exact device pixels) and putImageData it; putImageData ignores the canvas
// transform, so all geometry here is device-pixel.
function drawSpectrogram() {
  const W = surface.width, H = surface.height;
  if (!specImage || specImage.width !== W || specImage.height !== H) specImage = new ImageData(W, H);
  // Fill paper fast via a 32-bit view (RGBA little-endian).
  new Uint32Array(specImage.data.buffer).fill(
    (255 << 24) | (paperRGB[2] << 16) | (paperRGB[1] << 8) | paperRGB[0]);
  const nyquist = sampleRate / 2;
  for (let c = 0; c < numChannels; c++) {
    const dTop = Math.round((c * H) / numChannels);
    const dBot = Math.round(((c + 1) * H) / numChannels);
    renderSpectrogramLane(specImage.data, W, dTop, dBot, specs[c], viewport, nyquist, freqScale, dynRange, inkRGB);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.putImageData(specImage, 0, 0);
  if (numChannels > 1) {
    ctx.fillStyle = inkStr;
    for (let c = 1; c < numChannels; c++) ctx.fillRect(0, Math.round((c * H) / numChannels), W, 1);
  }
}

// Hidden-line 3D waterfall (vector, in CSS pixels under the dpr transform).
function drawWaterfall() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = paperStr;
  ctx.fillRect(0, 0, cssW, cssH);
  // While playing, the front trace is "now" (playHead) and the waterfall shows
  // the preceding window (its length = the viewport span), so it scrolls as the
  // audio advances. Stopped, it shows the static viewport range.
  const span = viewport.endSample - viewport.startSample;
  const wvp = playHead != null
    ? { startSample: playHead - span, endSample: playHead }
    : viewport;
  for (let c = 0; c < numChannels; c++) {
    const lr = laneRect(c, cssH, numChannels);
    renderWaterfall(ctx, lr, specs[c], wvp, sampleRate, freqScale, cssW, dynRange, waterDir, inkStr, paperStr, waterYaw, waterPitch, waterSmooth);
    if (c > 0) { ctx.fillStyle = inkStr; ctx.fillRect(0, Math.round(lr.top), cssW, 1); }
  }
}

function drawWaveform() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 1-bit theme: paper fill, ink marks.
  ctx.fillStyle = paperStr;
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.fillStyle = inkStr;
  ctx.strokeStyle = inkStr;
  ctx.lineWidth = 1;

  const vp = viewport;
  const spp = vp ? samplesPerPixel(vp, cssW) : 0;

  for (let c = 0; c < numChannels; c++) {
    const { top, mid } = laneRect(c, cssH, numChannels);
    // Lane separator (above lanes 1+) and the zero line.
    if (c > 0) { ctx.globalAlpha = 0.3; ctx.fillRect(0, Math.round(top), cssW, 1); ctx.globalAlpha = 1; }
    ctx.fillRect(0, Math.round(mid), cssW, 1);

    const ch = channels[c];
    if (!ch || !vp) continue;

    if (spp > SAMPLE_MODE_SPP) {
      // Zoomed out: one vertical min→max bar per column from the peak pyramid.
      const { min, max } = peaksForViewport(ch, pyramids[c], vp, cssW);
      ctx.beginPath();
      for (let x = 0; x < cssW; x++) {
        let yTop = ampToY(max[x], c, cssH, numChannels);
        let yBot = ampToY(min[x], c, cssH, numChannels);
        if (yBot - yTop < 1) yBot = yTop + 1; // always at least 1px tall
        ctx.moveTo(x + 0.5, yTop);
        ctx.lineTo(x + 0.5, yBot);
      }
      ctx.stroke();
    } else {
      // Zoomed in: the band-limited (sinc) reconstruction at pixel resolution —
      // the true continuous waveform, smooth rather than straight-line jaggy —
      // with dots on the actual samples once they're far enough apart to read.
      const recon = sincReconstruct(ch, vp, cssW);
      ctx.beginPath();
      for (let x = 0; x < cssW; x++) {
        const y = ampToY(recon[x], c, cssH, numChannels);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      const pts = samplesForViewport(ch, vp, cssW);
      const spacing = pts.length > 1 ? pts[1].x - pts[0].x : 0;
      if (spacing >= DOT_SPACING_PX) {
        for (const p of pts) {
          const y = ampToY(p.v, c, cssH, numChannels);
          ctx.fillRect(p.x - 1.5, y - 1.5, 3, 3);
        }
      }
    }
  }
}

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      dpr = m.dpr; cssW = m.cssW; cssH = m.cssH;
      setTheme(m.ink, m.paper);
      applySize();
      postMessage({ type: 'ready' });
      schedule();
      break;
    case 'setTheme':
      setTheme(m.ink, m.paper);
      schedule();
      break;
    case 'load':
      channels = m.channels.map((buf) => new Float32Array(buf));
      sampleRate = m.sampleRate;
      totalSamples = m.length;
      numChannels = m.numChannels;
      pyramids = channels.map((ch) => buildPyramid(ch));
      specs = [];   // rebuilt lazily on first spectrogram render
      postMessage({ type: 'loaded' });
      schedule();
      break;
    case 'setMode':
      mode = m.mode;
      schedule();
      break;
    case 'setScale':
      freqScale = m.scale;
      schedule();
      break;
    case 'setPlayhead':
      playHead = m.sample;
      schedule();
      break;
    case 'setStft':
      stft = { fftSize: m.fftSize, hop: m.hop, window: m.window };
      specs = [];   // invalidate the STFT cache → rebuilt on next spectral render
      schedule();
      break;
    case 'setRange':
      dynRange = m.db;
      schedule();
      break;
    case 'setDir':
      waterDir = m.dir;
      schedule();
      break;
    case 'setRot':
      waterYaw = m.yaw; waterPitch = m.pitch;
      schedule();
      break;
    case 'setSmooth':
      waterSmooth = m.smooth;
      schedule();
      break;
    case 'viewport':
      viewport = { startSample: m.startSample, endSample: m.endSample, sampleRate, totalSamples };
      schedule();
      break;
    case 'resize':
      dpr = m.dpr; cssW = m.cssW; cssH = m.cssH;
      applySize();
      schedule();
      break;
    case 'queryAt':
      {
        const ch = channels[m.channel] || channels[0];
        const v = ch && m.sample >= 0 && m.sample < ch.length ? ch[m.sample] : 0;
        const db = v ? 20 * Math.log10(Math.abs(v)) : -Infinity;
        // Spectral magnitude at the hovered frequency, when a spectrogram exists.
        let magDb = null;
        const sp = specs[m.channel];
        if (m.freqHz != null && m.freqHz >= 0 && sp) {
          let fr = Math.floor(m.sample / sp.hop);
          fr = fr < 0 ? 0 : fr >= sp.nFrames ? sp.nFrames - 1 : fr;
          let bin = Math.round(m.freqHz / ((sampleRate / 2) / sp.nBins));
          bin = bin < 0 ? 0 : bin >= sp.nBins ? sp.nBins - 1 : bin;
          magDb = sp.mags[fr * sp.nBins + bin];
        }
        postMessage({ type: 'queryResult', id: m.id, sample: m.sample, value: v, db, magDb });
      }
      break;
    case 'dispose':
      if (pending) clearTimeout(pending);
      pending = 0; playHead = null; ctx = null; surface = null; channels = []; pyramids = []; specs = []; specImage = null;
      break;
  }
};
