// Pop-out full-screen waveform navigator (Phase 1). Main-thread owner of the
// fixed overlay DOM, the single display canvas, playback and interaction; spawns
// the render worker that owns the sample data + its own OffscreenCanvas surface.
//
// The worker renders the waveform into its own OffscreenCanvas and ships each
// frame as an ImageBitmap; the main thread caches the latest frame and paints
// it (transformed to the live viewport for instant zoom/pan feedback) plus the
// HUD — selection, play cursor, playhead — onto ONE canvas. (One canvas, no
// popover top layer: both avoid Chrome GPU compositing bugs found during
// bring-up where offscreen/stacked canvases paint blank.)
import { decodeAudio, encodeWav } from '@olilarkin/cdp-wasm/wav';
import { el, gemSelect } from '../ui/ui.js';
import {
  fit, zoomAt, zoomToRange, panByPixels, followStep,
  sampleToX, xToSample, laneAt, laneRect, waterfallGeometry,
} from '../ui/viewport.js';
import { SCALES, freqToFrac, fracToFreq } from './freqscale.js';
import { themeColors } from '../ui/themes.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function openWaveformEditor({ wav, audioCtx, name = 'audio', nodeId = null, onPromote = null, onCrop = null, player = null }) {
  // ---- decode + build the AudioBuffer BEFORE any transfer -------------------
  // copyToChannel copies the samples in, so the Float32Array buffers stay valid
  // to transfer to the worker immediately after (transfer neuters them). The
  // original `wav` bytes are retained (not transferred) for export re-decode.
  const { sampleRate, numChannels, length, channelData } = decodeAudio(wav);
  const audioBuffer = audioCtx.createBuffer(numChannels, length, sampleRate);
  for (let c = 0; c < numChannels; c++) audioBuffer.copyToChannel(channelData[c], c);

  // ---- DOM ------------------------------------------------------------------
  const ruler = el('canvas', { class: 'wfx-ruler' });
  const waveCanvas = el('canvas', { class: 'wfx-wave' });
  const stage = el('div', { class: 'wfx-stage' }, waveCanvas);

  const mkBtn = (txt, title, onclick) => {
    const b = el('button', { type: 'button', textContent: txt, title });
    b.addEventListener('click', () => { onclick(); b.blur(); });
    return b;
  };
  const fitBtn = mkBtn('⤢ Fit', 'Fit whole sound (resets the 3D view)', () => {
    if (mode === 'waterfall') { wfYaw = WF_YAW0; wfPitch = WF_PITCH0; if (started) worker.postMessage({ type: 'setRot', yaw: wfYaw, pitch: wfPitch }); }
    setViewport(fit(viewport, length));
  });
  const zoomOutBtn = mkBtn('−', 'Zoom out', () => zoomCentered(1 / 1.4));
  const zoomInBtn = mkBtn('+', 'Zoom in', () => zoomCentered(1.4));
  const zoomSelBtn = mkBtn('⤢ Sel', 'Zoom to selection', () => { if (selection) setViewport(zoomToRange(viewport, selection.a, selection.b, length)); });
  const playBtn = mkBtn('▶', 'Play / Stop (Space)', () => togglePlay());
  // Loop respects the selection: with a region selected it loops that region,
  // otherwise the whole sound. Toggling mid-play re-applies the intent (a live
  // setLoop for whole-sound loops to avoid a jump; selection loops restart).
  const loopBtn = mkBtn('⟳', 'Loop (the selection if there is one, else the whole sound)', () => {
    loopWhole = !loopWhole; loopBtn.classList.toggle('on', loopWhole);
    if (!player.isPlaying(wav)) return;
    if (selection) startPlayback();          // (re)apply selection-loop intent
    else player.setLoop(loopWhole);          // whole sound: toggle live, no jump
  });
  const loopSelBtn = mkBtn('⟳ Sel', 'Loop selection', () => { if (selection) play(selection.a, { loopRange: { a: selection.a, b: selection.b } }); });
  // Snap selection edges to zero crossings so looped regions don't click. On by
  // default; toggling re-snaps (or leaves) the current selection immediately.
  const SNAP_KEY = 'cdp-web-wfx-snap-zero';
  let snapZero = true;
  try { snapZero = localStorage.getItem(SNAP_KEY) !== '0'; } catch {}
  const snapBtn = mkBtn('Snap 0', 'Snap selection edges to zero crossings (avoids clicks when looping)', () => {
    snapZero = !snapZero; snapBtn.classList.toggle('on', snapZero);
    try { localStorage.setItem(SNAP_KEY, snapZero ? '1' : '0'); } catch {}
    if (snapZero && selection) {
      selection = snapSelection(selection); cursorSample = selection.a; paint();
      if (player.isPlaying(wav)) startPlayback();
    }
  });
  const MODES = ['waveform', 'spectrogram', 'waterfall'];
  const modeBtn = el('button', { type: 'button', textContent: '∿ Wave', title: 'View: waveform → spectrogram → 3D waterfall (Tab)' });
  modeBtn.addEventListener('click', () => { setRenderMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]); modeBtn.blur(); });
  const scaleBtn = el('button', { type: 'button', textContent: 'Log', title: 'Frequency scale: linear / log / mel (spectrogram)' });
  scaleBtn.addEventListener('click', () => { setFreqScale(SCALES[(SCALES.indexOf(freqScale) + 1) % SCALES.length]); scaleBtn.blur(); });

  // ---- STFT / analysis settings panel ---------------------------------------
  const opt = (v, t) => el('option', { value: String(v), textContent: t });
  const sel = (opts, value, onChange) => {
    const s = el('select', {}, ...opts.map(([v, t]) => opt(v, t)));
    s.value = String(value);
    s.addEventListener('change', onChange);
    return s;
  };
  const sendStft = () => {
    const fftSize = +fftSel.value, overlap = +ovSel.value;
    worker.postMessage({ type: 'setStft', fftSize, hop: Math.max(1, Math.round(fftSize * (1 - overlap))), window: winSel.value });
  };
  const fftSel = sel([[256, '256'], [512, '512'], [1024, '1024'], [2048, '2048'], [4096, '4096']], 1024, sendStft);
  const winSel = sel([['hann', 'Hann'], ['blackman', 'Blackman-Harris'], ['hamming', 'Hamming'], ['rect', 'Rect']], 'hann', sendStft);
  const ovSel = sel([[0.5, '50%'], [0.75, '75%'], [0.875, '87.5%']], 0.75, sendStft);
  const rangeSel = sel([[40, '40 dB'], [50, '50 dB'], [60, '60 dB'], [70, '70 dB'], [80, '80 dB'], [90, '90 dB'], [100, '100 dB']], 80,
    () => worker.postMessage({ type: 'setRange', db: +rangeSel.value }));
  const dirSel = sel([[-1, 'Front = start'], [1, 'Front = now']], -1,
    () => worker.postMessage({ type: 'setDir', dir: +dirSel.value }));
  const smoothSel = sel([[0, 'Off'], [1, 'Low'], [2, 'Medium'], [4, 'High']], 2,
    () => worker.postMessage({ type: 'setSmooth', smooth: +smoothSel.value }));
  const row = (label, ctrl) => el('label', { class: 'wfx-row' }, el('span', { textContent: label }), ctrl);
  const settings = el('div', { class: 'wfx-settings' },
    row('FFT size', fftSel), row('Window', winSel), row('Overlap', ovSel), row('dB range', rangeSel), row('3D depth', dirSel), row('Smoothing', smoothSel));
  settings.style.display = 'none';
  const gearBtn = el('button', { type: 'button', textContent: '⚙', title: 'STFT / analysis settings' });
  gearBtn.addEventListener('click', () => {
    const show = settings.style.display === 'none';
    settings.style.display = show ? 'block' : 'none';
    settings.style.top = toolbar.offsetHeight + 'px';
    gearBtn.classList.toggle('on', show);
    gearBtn.blur();
  });
  const exportBtn = mkBtn('⤓ WAV', 'Download selection (or whole sound) as WAV', () => exportRegion());
  const regionGrp = el('span', { class: 'wfx-grp' }, exportBtn);
  if (onPromote) regionGrp.append(mkBtn('→ Src', 'Promote selection (or whole sound) to a new Source node', () => promoteRegion()));
  if (onCrop) regionGrp.append(mkBtn('✂ Crop', 'Crop this Source to the selection (replaces its audio)', () => cropRegion()));
  const closeBtn = el('button', { class: 'wfx-btn', type: 'button', textContent: '×', title: 'Close (Esc)' });
  const readout = el('span', { class: 'wfx-readout', textContent: name });

  const toolbar = el('div', { class: 'wfx-toolbar' },
    el('span', { class: 'wfx-grp' }, modeBtn, scaleBtn, gearBtn),
    el('span', { class: 'wfx-grp' }, fitBtn, zoomOutBtn, zoomInBtn, zoomSelBtn),
    el('span', { class: 'wfx-grp' }, playBtn, loopBtn, loopSelBtn, snapBtn),
    regionGrp,
    el('span', { class: 'wfx-spacer' }),
    closeBtn,
  );
  // The hover readout lives in a bottom status bar so its (variable-length) text
  // can't wrap the toolbar and grow the buttons.
  const statusbar = el('div', { class: 'wfx-statusbar' }, readout);
  const root = el('div', { class: 'wfx' }, toolbar, ruler, stage, statusbar, settings);
  document.body.appendChild(root);
  snapBtn.classList.toggle('on', snapZero);
  // Skin the settings-panel <select>s with the GEM popover dropdown so they match
  // the rest of the app (the real <select>s stay as the value source).
  [fftSel, winSel, ovSel, rangeSel, dirSel, smoothSel].forEach(gemSelect);
  const RULER_H = 22;

  // ---- state ----------------------------------------------------------------
  let viewport = fit({ startSample: 0, endSample: length, sampleRate, totalSamples: length }, length);
  let dpr = devicePixelRatio || 1;
  let cssW = 1, cssH = 1;
  let closed = false, started = false, ready = false;
  let lastBitmap = null;     // most recent worker frame
  let bitmapVp = null;       // the viewport that frame was rendered for
  let selection = null;      // { a, b } samples (a<b) | null
  let cursorSample = 0;      // play-from position (last click)
  let mode = 'waveform';     // 'waveform' | 'spectrogram'
  let freqScale = 'log';     // spectrogram Y axis scale (log by default)
  // waterfall orbit camera (radians); kept within ±~80° yaw so depth stays monotonic
  const WF_YAW0 = 0.5, WF_PITCH0 = 0.34;
  const YAW_MIN = -1.4, YAW_MAX = 1.4, PITCH_MIN = 0.08, PITCH_MAX = 1.45;
  let wfYaw = WF_YAW0, wfPitch = WF_PITCH0;
  let hoverX = null, hoverY = null;   // pointer position over the stage (CSS px) for the crosshair
  // playback — the live voice + its timing live in the shared `player`; these are
  // just this view's reflection of it (drawn playhead, button state, loop intent).
  let playing = false, playSample = 0;
  let loopWhole = false, loopRange = null;
  let rafPlay = 0;
  // interaction / follow suppression
  let interacting = false, resumeTimer = 0;
  const FOLLOW_EDGE = 0.18;   // playhead rides this fraction in from the left while following
  // hover query
  let queryId = 0, pendingQuery = 0, hover = null;
  let ditherPat = null;      // lazy 1-bit selection fill pattern
  const { ink: INK, paper: PAPER } = themeColors();   // theme colours, read at open
  const waveCtx = waveCanvas.getContext('2d');
  const rulerCtx = ruler.getContext('2d');

  const worker = new Worker(new URL('./waveform-worker.js', import.meta.url), { type: 'module' });
  worker.onerror = (e) => console.error('[wfx] worker error:', e.message, e.filename, e.lineno);
  worker.onmessageerror = (e) => console.error('[wfx] worker message error:', e);
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') {
      ready = true;
      worker.postMessage(
        { type: 'load', channels: channelData.map((a) => a.buffer), sampleRate, length, numChannels },
        channelData.map((a) => a.buffer),
      );
      postViewport();
    } else if (m.type === 'frame') {
      if (lastBitmap) lastBitmap.close();
      lastBitmap = m.bitmap;
      bitmapVp = m.viewport;
      paint();
    } else if (m.type === 'queryResult') {
      if (m.id === pendingQuery && hover) { hover.value = m.value; hover.db = m.db; hover.magDb = m.magDb; renderReadout(); }
    }
  };

  // ---- viewport ----------------------------------------------------------
  function postViewport() {
    if (started) worker.postMessage({ type: 'viewport', startSample: viewport.startSample, endSample: viewport.endSample });
  }
  function setViewport(vp) {
    viewport = vp;
    postViewport();
    paint();          // instant: repaints the cached frame transformed to vp
  }
  function zoomCentered(factor) {
    const mid = (viewport.startSample + viewport.endSample) / 2;
    setViewport(zoomAt(viewport, mid, factor, length));
  }
  const spectral = () => mode === 'spectrogram' || mode === 'waterfall';   // freq-axis views
  function setRenderMode(m) {
    mode = m;
    modeBtn.textContent = mode === 'spectrogram' ? '▒ Spec' : mode === 'waterfall' ? '⛰ 3D' : '∿ Wave';
    modeBtn.classList.toggle('on', mode !== 'waveform');
    scaleBtn.classList.toggle('on', spectral() && freqScale !== 'linear');
    if (started) worker.postMessage({ type: 'setMode', mode });
    stage.style.cursor = mode === 'waterfall' ? 'grab' : 'crosshair';   // orbit hint
    renderReadout();
    paint();
  }
  function setFreqScale(s) {
    freqScale = s;
    scaleBtn.textContent = s === 'linear' ? 'Lin' : s === 'log' ? 'Log' : 'Mel';
    scaleBtn.classList.toggle('on', spectral() && freqScale !== 'linear');
    if (started) worker.postMessage({ type: 'setScale', scale: freqScale });
    paint();
  }

  // ---- sizing / paint -------------------------------------------------------
  function measure() {
    const r = stage.getBoundingClientRect();
    cssW = Math.max(1, Math.round(r.width));
    cssH = Math.max(1, Math.round(r.height));
  }
  function sizeCanvas() {
    waveCanvas.style.width = cssW + 'px';
    waveCanvas.style.height = cssH + 'px';
    waveCanvas.width = Math.round(cssW * dpr);
    waveCanvas.height = Math.round(cssH * dpr);
    ruler.style.width = cssW + 'px';
    ruler.style.height = RULER_H + 'px';
    ruler.width = Math.round(cssW * dpr);
    ruler.height = Math.round(RULER_H * dpr);
  }
  // 1-bit ordered-dither tile (25% ink) for the selection fill, built once. Drawn
  // in device pixels so the dots stay crisp and screen-aligned at any DPR/zoom.
  function dither() {
    if (ditherPat) return ditherPat;
    const tile = el('canvas', { width: 2, height: 2 });
    const g = tile.getContext('2d');
    g.fillStyle = INK;
    g.fillRect(0, 0, 1, 1);
    ditherPat = waveCtx.createPattern(tile, 'repeat');
    return ditherPat;
  }
  function paint() {
    if (closed) return;
    const W = waveCanvas.width, H = waveCanvas.height;
    // Background: paper + each lane's zero line. This shows through wherever we
    // don't yet have a fresh waveform frame (the newly-revealed edges right after
    // a zoom-out / pan), so those margins read as the waveform's flat
    // continuation rather than flashing a blank white (or smeared) bar.
    waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    waveCtx.fillStyle = PAPER;
    waveCtx.fillRect(0, 0, cssW, cssH);
    waveCtx.fillStyle = INK;
    for (let c = 0; c < numChannels; c++) {
      waveCtx.fillRect(0, Math.round(laneRect(c, cssH, numChannels).mid), cssW, 1);
    }
    // Which viewport to draw against. Normally the live one. But during playback-
    // follow at deep (sample/sinc) zoom the playhead advances more than a whole
    // span per animation frame, so the live viewport pages forward in jumps that
    // don't overlap the most recent worker frame; remapping that frame would clamp
    // to nothing and the lane would go blank ("the waveform vanishes once the
    // playhead reaches the edge"). When the live view has fully outrun the freshest
    // frame, draw everything against that frame's own range instead — the waveform,
    // ruler and playhead (riding at the follow edge it was paged to) then scroll
    // smoothly, ~1 frame behind reality rather than disappearing.
    let dv = viewport, snapped = false;
    if (playing && !interacting && lastBitmap && bitmapVp && mode !== 'waterfall') {
      const bSpan = bitmapVp.endSample - bitmapVp.startSample;
      const r0 = (viewport.startSample - bitmapVp.startSample) / bSpan;
      const r1 = (viewport.endSample - bitmapVp.startSample) / bSpan;
      if (r1 <= 0 || r0 >= 1) { dv = bitmapVp; snapped = true; }   // live view no longer overlaps the frame
    }
    // The cached frame, mapped from the viewport it was rendered for to the display
    // viewport (instant zoom/pan preview), clamped to its rendered range so it
    // never stretches past its own data into the margins.
    if (lastBitmap && bitmapVp && mode !== 'waterfall') {
      waveCtx.setTransform(1, 0, 0, 1, 0, 0);
      const bw = lastBitmap.width, bh = lastBitmap.height;
      const bSpan = bitmapVp.endSample - bitmapVp.startSample;
      const sx0 = ((dv.startSample - bitmapVp.startSample) / bSpan) * bw;
      const sx1 = ((dv.endSample - bitmapVp.startSample) / bSpan) * bw;
      const scale = W / (sx1 - sx0);
      const cs0 = Math.max(0, sx0), cs1 = Math.min(bw, sx1);
      if (cs1 > cs0) {
        waveCtx.drawImage(lastBitmap, cs0, 0, cs1 - cs0, bh, (cs0 - sx0) * scale, 0, (cs1 - cs0) * scale, H);
      }
    } else if (lastBitmap) {
      waveCtx.setTransform(1, 0, 0, 1, 0, 0);
      waveCtx.drawImage(lastBitmap, 0, 0, W, H);
    }
    waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawHud(dv, snapped);
    drawRuler(dv);
  }
  function drawHud(dv = viewport, snapped = false) {
    // The waterfall is a 3D projection (frequency across, amplitude up, time into
    // depth) — the flat time-axis overlays don't map onto it. Draw the labelled
    // 3D axis box instead.
    if (mode === 'waterfall') { drawWaterfallAxes(); return; }
    // selection band: 1-bit dither fill (in device px for crisp dots) + 2px edges
    if (selection) {
      const xa = sampleToX(dv, selection.a, cssW);
      const xb = sampleToX(dv, selection.b, cssW);
      waveCtx.setTransform(1, 0, 0, 1, 0, 0);
      waveCtx.fillStyle = dither();
      waveCtx.fillRect(Math.round(xa * dpr), 0, Math.round((xb - xa) * dpr), waveCanvas.height);
      waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      waveCtx.fillStyle = INK;
      waveCtx.fillRect(xa - 1, 0, 2, cssH);
      waveCtx.fillRect(xb - 1, 0, 2, cssH);
    }
    // play cursor (thin)
    const xc = sampleToX(dv, cursorSample, cssW);
    if (xc >= 0 && xc <= cssW) { waveCtx.fillStyle = INK; waveCtx.fillRect(Math.round(xc), 0, 1, cssH); }
    // playhead (thick) while playing. When `snapped`, the lane is the frame the
    // follow paged the playhead to the edge of, so the live sample maps off-screen
    // right — draw it at the follow edge to ride the (slightly stale) waveform.
    if (playing) {
      const xp = snapped ? FOLLOW_EDGE * cssW : sampleToX(dv, playSample, cssW);
      if (xp >= 0 && xp <= cssW) { waveCtx.fillStyle = INK; waveCtx.fillRect(Math.round(xp) - 1, 0, 2, cssH); }
    }
    waveCtx.strokeStyle = INK;
    waveCtx.lineWidth = 1;
    waveCtx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1);
    drawAxis();
    if (hoverX != null && !drag) drawCrosshair();
  }

  const fmtHz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f % 1000 ? 1 : 0)}k` : `${Math.round(f)}`);
  // Small paper-backed ink label so axis/crosshair text stays readable over ink.
  function labelLeft(text, y) {
    waveCtx.font = '10px "AtariST", monospace';
    waveCtx.textBaseline = 'middle';
    const w = waveCtx.measureText(text).width + 4;
    waveCtx.fillStyle = PAPER; waveCtx.fillRect(8, y - 6, w, 12);
    waveCtx.fillStyle = INK; waveCtx.fillText(text, 10, y);
  }
  function pill(x, y, text, center) {
    waveCtx.font = '11px "AtariST", monospace';
    waveCtx.textBaseline = 'top';
    const w = waveCtx.measureText(text).width + 6, h = 15;
    let px = clamp(center ? x - w / 2 : x, 0, cssW - w);
    let py = clamp(y, 0, cssH - h);
    waveCtx.fillStyle = PAPER; waveCtx.fillRect(px, py, w, h);
    waveCtx.strokeStyle = INK; waveCtx.lineWidth = 1; waveCtx.strokeRect(px + 0.5, py + 0.5, w - 1, h - 1);
    waveCtx.fillStyle = INK; waveCtx.fillText(text, px + 3, py + 3);
  }
  // Static Y-axis ticks + labels: frequency (spectrogram) or amplitude (waveform).
  function drawAxis() {
    const nyq = sampleRate / 2;
    for (let c = 0; c < numChannels; c++) {
      const lr = laneRect(c, cssH, numChannels);
      if (mode === 'spectrogram') {
        let freqs;
        if (freqScale === 'linear') {
          const step = niceInterval(nyq / 4); freqs = [];
          for (let f = step; f < nyq * 0.999; f += step) freqs.push(f);
        } else {
          freqs = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter((f) => f < nyq * 0.999);
        }
        for (const f of freqs) {
          const y = lr.top + (1 - freqToFrac(freqScale, f, nyq)) * lr.height;
          waveCtx.fillStyle = INK; waveCtx.fillRect(0, Math.round(y), 7, 1);
          labelLeft(fmtHz(f), y);
        }
      } else {
        for (const a of [1, 0, -1]) {
          const y = lr.mid - a * (lr.height / 2) * 0.92;
          waveCtx.fillStyle = INK; waveCtx.fillRect(0, Math.round(y), 7, 1);
          labelLeft(a > 0 ? `+${a}` : `${a}`, y);
        }
      }
    }
  }
  // 3D axis box for the waterfall: amplitude (front-left), frequency (front-
  // bottom) and time (right, into depth) with tick labels — registers with the
  // back-wall grid the worker draws.
  function drawWaterfallAxes() {
    const nyq = sampleRate / 2;
    const dir = dirSel ? +dirSel.value : 1;            // +1 = newest at front
    const spanS = viewport.endSample - viewport.startSample;
    const wEnd = playing ? playSample : viewport.endSample;   // matches worker wvp
    const tHi = Math.max(0, wEnd) / sampleRate;
    const tLo = Math.max(0, wEnd - spanS) / sampleRate;
    const tSpan = Math.max(1e-6, tHi - tLo);
    waveCtx.save();
    waveCtx.strokeStyle = INK; waveCtx.fillStyle = INK; waveCtx.lineWidth = 1;
    waveCtx.font = '10px "AtariST", monospace';
    const seg = (a, b) => { waveCtx.beginPath(); waveCtx.moveTo(a.x, a.y); waveCtx.lineTo(b.x, b.y); waveCtx.stroke(); };
    const label = (s, x, y, align, baseline) => { waveCtx.textAlign = align; waveCtx.textBaseline = baseline; waveCtx.fillText(s, x, y); };
    for (let c = 0; c < numChannels; c++) {
      const lr = laneRect(c, cssH, numChannels);
      const g = waterfallGeometry(lr.top, lr.height, cssW, wfYaw, wfPitch);
      const near1 = g.depthPerTy >= 0;                  // ty=1 nearest the camera?
      const roomy = lr.height > 130;
      const P = (fx, ty, amp) => g.project(fx, ty, amp);
      // Faint full wireframe so it reads as a box at any orbit angle.
      waveCtx.save();
      waveCtx.globalAlpha = 0.3;
      for (const amp of [0, 1]) {     // bottom + top faces
        seg(P(0, 0, amp), P(1, 0, amp)); seg(P(1, 0, amp), P(1, 1, amp));
        seg(P(1, 1, amp), P(0, 1, amp)); seg(P(0, 1, amp), P(0, 0, amp));
      }
      for (const [fx, ty] of [[0, 0], [1, 0], [1, 1], [0, 1]]) seg(P(fx, ty, 0), P(fx, ty, 1));   // verticals
      waveCtx.restore();
      // Bold labelled axes: frequency (front-bottom), amplitude (front-left), time (depth).
      seg(P(0, 0, 0), P(1, 0, 0));
      seg(P(0, 0, 0), P(0, 0, 1));
      seg(P(1, 0, 0), P(1, 1, 0));
      // amplitude ticks
      for (const a of [0, 0.5, 1]) {
        const p = P(0, 0, a);
        seg({ x: p.x - 4, y: p.y }, p);
        if (roomy) label(a.toFixed(1), p.x - 6, p.y, 'right', 'middle');
      }
      // frequency ticks
      let freqs;
      if (freqScale === 'linear') { const step = niceInterval(nyq / 4); freqs = []; for (let f = 0; f < nyq * 0.999; f += step) freqs.push(f); }
      else freqs = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter((f) => f < nyq * 0.999);
      for (const f of freqs) {
        const fx = f <= 0 ? 0 : freqToFrac(freqScale, f, nyq);
        if (fx < 0 || fx > 1) continue;
        const p = P(fx, 0, 0);
        seg(p, { x: p.x, y: p.y + 4 });
        if (roomy) label(fmtHz(f), p.x, p.y + 6, 'center', 'top');
      }
      // time ticks (into depth)
      const tStep = niceInterval(tSpan / 3);
      for (let t = Math.ceil(tLo / tStep) * tStep; t <= tHi + 1e-6; t += tStep) {
        const tau = (t - tLo) / tSpan;
        const fromNear = dir < 0 ? tau : 1 - tau;       // mirror the renderer's mapping
        const ty = near1 ? 1 - fromNear : fromNear;
        const p = P(1, ty, 0);
        seg(p, { x: p.x + 4, y: p.y });
        if (roomy) label(t.toFixed(tStep < 1 ? 1 : 0), p.x + 6, p.y, 'left', 'middle');
      }
      // axis titles
      if (roomy) {
        label('AMPLITUDE', 4, lr.top + 8, 'left', 'middle');
        const fm = P(0.5, 0, 0);
        label('FREQUENCY (Hz)', fm.x, fm.y + 16, 'center', 'top');
        const tm = P(1, 0.5, 0);
        label('TIME (s)', tm.x + 8, tm.y, 'left', 'middle');
      }
    }
    waveCtx.restore();
  }
  // Dotted X/Y crosshair following the pointer, with time + frequency/amplitude tags.
  function drawCrosshair() {
    const hx = Math.round(hoverX) + 0.5, hy = Math.round(hoverY) + 0.5;
    waveCtx.save();
    waveCtx.setLineDash([2, 2]); waveCtx.strokeStyle = INK; waveCtx.lineWidth = 1;
    waveCtx.beginPath();
    waveCtx.moveTo(hx, 0); waveCtx.lineTo(hx, cssH);
    waveCtx.moveTo(0, hy); waveCtx.lineTo(cssW, hy);
    waveCtx.stroke();
    waveCtx.restore();
    // X tag: time at the top of the vertical line
    pill(hoverX, 2, `${xToSample(viewport, hoverX, cssW) >= 0 ? (xToSample(viewport, hoverX, cssW) / sampleRate).toFixed(3) : '0'}s`, true);
    // Y tag: frequency (spectrogram) or amplitude (waveform) on the horizontal line
    const lane = laneAt(hoverY, cssH, numChannels);
    const lr = laneRect(lane, cssH, numChannels);
    const frac = clamp(1 - (hoverY - lr.top) / lr.height, 0, 1);
    const ytxt = mode === 'spectrogram'
      ? fmtHz(fracToFreq(freqScale, frac, sampleRate / 2)) + ' Hz'
      : (() => { const a = (lr.mid - hoverY) / ((lr.height / 2) * 0.92); return (a >= 0 ? '+' : '') + a.toFixed(3); })();
    pill(14, hoverY - 7, ytxt, false);
  }

  // Nearest "nice" 1/2/5×10ⁿ value ≥ target — used to pick the tick interval.
  function niceInterval(target) {
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const f = target / pow;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * pow;
  }
  function drawRuler(dv = viewport) {
    if (!rulerCtx) return;
    rulerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rulerCtx.fillStyle = PAPER;
    rulerCtx.fillRect(0, 0, cssW, RULER_H);
    rulerCtx.fillStyle = INK;
    // Waterfall's X axis is frequency, not time — a top time ruler would mislead,
    // so leave it blank (the 3D box carries its own time/freq/amplitude axes).
    if (mode === 'waterfall') return;
    const spanSec = (dv.endSample - dv.startSample) / sampleRate;
    if (spanSec <= 0) return;
    const major = niceInterval((80 / cssW) * spanSec);   // ~80px between labels
    const minor = major / 5;
    const dec = Math.max(0, -Math.floor(Math.log10(major) + 1e-9));
    rulerCtx.font = '11px "AtariST", monospace';
    rulerCtx.textBaseline = 'top';
    const k0 = Math.floor(dv.startSample / sampleRate / minor);
    const k1 = Math.ceil(dv.endSample / sampleRate / minor);
    for (let k = k0; k <= k1; k++) {
      const t = k * minor;
      if (t < 0) continue;
      const x = Math.round(sampleToX(dv, t * sampleRate, cssW));
      if (x < 0 || x > cssW) continue;
      const isMajor = k % 5 === 0;
      const h = isMajor ? 9 : 5;
      rulerCtx.fillRect(x, RULER_H - h, 1, h);
      if (isMajor) rulerCtx.fillText(t.toFixed(dec) + 's', x + 3, 2);
    }
    rulerCtx.fillRect(0, RULER_H - 1, cssW, 1);   // baseline
    if (hoverX != null && !drag) { rulerCtx.fillRect(Math.round(hoverX), 0, 1, RULER_H); }   // cursor marker
  }

  // First layout: stage isn't measurable until laid out — double-rAF then init.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (closed) return;
    measure();
    if (cssW < 2 || cssH < 2) console.warn('[wfx] stage measured', cssW, '×', cssH, '— layout not ready?');
    sizeCanvas();
    started = true;
    worker.postMessage({ type: 'init', dpr, cssW, cssH, ink: INK, paper: PAPER });
    worker.postMessage({ type: 'setScale', scale: freqScale });   // sync the non-default (log) scale
    worker.postMessage({ type: 'setDir', dir: +dirSel.value });    // sync the depth direction (front = start)
    worker.postMessage({ type: 'setRot', yaw: wfYaw, pitch: wfPitch });   // sync the orbit camera
    worker.postMessage({ type: 'setSmooth', smooth: +smoothSel.value });  // sync waterfall smoothing
    paint();
    syncFromPlayer();   // adopt a moving playhead if this audio is already playing (e.g. a node Play button)
    setTimeout(() => { if (!closed && !ready) console.warn('[wfx] worker never reported ready (1.5s)'); }, 1500);
  }));

  // ---- resize / DPR ---------------------------------------------------------
  function onResize() {
    if (closed || !started) return;
    dpr = devicePixelRatio || 1;
    measure();
    sizeCanvas();
    worker.postMessage({ type: 'resize', dpr, cssW, cssH });
    paint();
  }
  const ro = new ResizeObserver(onResize);
  ro.observe(stage);
  window.addEventListener('resize', onResize);

  // ---- interaction: follow suppression --------------------------------------
  function markInteracting() { interacting = true; clearTimeout(resumeTimer); }
  function scheduleResume() { clearTimeout(resumeTimer); resumeTimer = setTimeout(() => { interacting = false; }, 250); }

  // ---- pointer: zoom / pan / select / hover ---------------------------------
  const offsetX = (e) => clamp(e.clientX - waveCanvas.getBoundingClientRect().left, 0, cssW);
  const offsetY = (e) => clamp(e.clientY - waveCanvas.getBoundingClientRect().top, 0, cssH);
  const sampleAt = (x) => clamp(Math.round(xToSample(viewport, x, cssW)), 0, length);

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const anchor = xToSample(viewport, offsetX(e), cssW);
    setViewport(zoomAt(viewport, anchor, e.deltaY < 0 ? 1.2 : 1 / 1.2, length));
    markInteracting(); scheduleResume();
  }, { passive: false });

  let drag = null, downX = 0, downY = 0, downSample = 0, startVp = null, selAnchor = 0, moved = false, spaceHeld = false, spacePanned = false;
  let hadSelectionAtDown = false;   // was a region already selected when this drag began?
  let startYaw = 0, startPitch = 0;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    try { stage.setPointerCapture(e.pointerId); } catch {}
    const x = offsetX(e);
    downX = x; downY = offsetY(e); moved = false; hadSelectionAtDown = !!selection; markInteracting();
    hoverX = hoverY = null;   // hide the crosshair while dragging
    // Waterfall: left-drag orbits the 3D camera (no time selection there).
    if (mode === 'waterfall' && e.button === 0 && !spaceHeld) {
      drag = 'orbit'; startYaw = wfYaw; startPitch = wfPitch; stage.style.cursor = 'grabbing'; return;
    }
    if (e.button === 1 || spaceHeld) { drag = 'pan'; startVp = viewport; if (spaceHeld) spacePanned = true; stage.style.cursor = 'grabbing'; return; }
    downSample = sampleAt(x);
    if (selection) {  // grab an edge to resize (±6px)
      const xa = sampleToX(viewport, selection.a, cssW), xb = sampleToX(viewport, selection.b, cssW);
      if (Math.abs(x - xa) <= 6) { drag = 'resize-a'; return; }
      if (Math.abs(x - xb) <= 6) { drag = 'resize-b'; return; }
    }
    drag = 'select'; selAnchor = downSample;
  });
  stage.addEventListener('pointermove', (e) => {
    const x = offsetX(e);
    if (drag && Math.abs(x - downX) > 3) moved = true;
    if (drag === 'orbit') {
      wfYaw = clamp(startYaw + (x - downX) * 0.008, YAW_MIN, YAW_MAX);
      wfPitch = clamp(startPitch - (offsetY(e) - downY) * 0.008, PITCH_MIN, PITCH_MAX);
      // The worker re-renders and its 'frame' message repaints — axes + traces
      // then always come from the same angle (no detached outline mid-drag).
      worker.postMessage({ type: 'setRot', yaw: wfYaw, pitch: wfPitch });
      markInteracting(); return;
    }
    if (drag === 'pan') { setViewport(panByPixels(startVp, -(x - downX), cssW, length)); markInteracting(); return; }
    if (drag === 'select') { const s = sampleAt(x); selection = { a: Math.min(selAnchor, s), b: Math.max(selAnchor, s) }; paint(); markInteracting(); return; }
    if (drag === 'resize-a') { const s = sampleAt(x); selection = { a: Math.min(s, selection.b), b: Math.max(s, selection.b) }; paint(); return; }
    if (drag === 'resize-b') { const s = sampleAt(x); selection = { a: Math.min(selection.a, s), b: Math.max(selection.a, s) }; paint(); return; }
    updateHover(x, e);   // idle hover readout
  });
  stage.addEventListener('pointerup', (e) => {
    // Only ever *redirect* playback that's already running — clicking or selecting
    // never starts audio from stopped, and never touches the loop toggle.
    const playingNow = player.isPlaying(wav);
    if (drag === 'select' && !moved) {
      // Click: move the play cursor here and clear any selection. If audio is
      // already rolling, jump it to the new spot (whole-sound, since the selection
      // is gone); otherwise just park the cursor for the next play.
      cursorSample = downSample; selection = null; paint();
      if (playingNow) startPlayback();
    } else if (drag === 'select' && selection && selection.b - selection.a < 2) {
      selection = null; paint();   // degenerate drag: no real region
    } else if ((drag === 'select' || drag === 'resize-a' || drag === 'resize-b') && selection) {
      // Finished dragging a region: snap its edges to zero crossings (click-free
      // loops), then — if audio is already playing — jump playback to the region
      // start (looping when loop is on). Stopped stays stopped.
      if (snapZero) selection = snapSelection(selection);
      cursorSample = selection.a; paint();
      if (playingNow) {
        // Drawing a brand-new region from nothing while it plays arms loop-selection.
        if (drag === 'select' && !hadSelectionAtDown && !loopWhole) {
          loopWhole = true; loopBtn.classList.toggle('on', true);
        }
        startPlayback();
      }
    }
    try { stage.releasePointerCapture(e.pointerId); } catch {}
    drag = null; stage.style.cursor = (spaceHeld || mode === 'waterfall') ? 'grab' : 'crosshair';
    scheduleResume();
  });
  stage.addEventListener('pointerleave', () => { if (!drag) { hover = null; hoverX = hoverY = null; renderReadout(); paint(); } });

  function updateHover(x, e) {
    if (mode === 'waterfall') { hover = null; hoverX = hoverY = null; renderReadout(); return; }
    const y = clamp(e.clientY - waveCanvas.getBoundingClientRect().top, 0, cssH);
    hoverX = x; hoverY = y;
    const s = sampleAt(x);
    const ch = laneAt(y, cssH, numChannels);
    hover = { s, ch, t: s / sampleRate, value: null, db: null, freq: null, magDb: null };
    // In spectrogram mode the vertical position is frequency (top = Nyquist),
    // mapped through the active scale so it matches the rendered rows.
    let freqHz = -1;
    if (mode === 'spectrogram') {
      const lr = laneRect(ch, cssH, numChannels);
      const frac = clamp(1 - (y - lr.top) / lr.height, 0, 1);
      hover.freq = freqHz = fracToFreq(freqScale, frac, sampleRate / 2);
    }
    renderReadout();
    pendingQuery = ++queryId;        // one in-flight query; stale results ignored
    worker.postMessage({ type: 'queryAt', id: pendingQuery, sample: s, channel: ch, freqHz });
    paint();                         // redraw crosshair under the cursor
  }
  function renderReadout() {
    if (mode === 'waterfall') { readout.textContent = name; return; }
    if (!hover) { readout.textContent = name; return; }
    const base = `${hover.t.toFixed(3)}s · ${hover.s} smp` + (numChannels > 1 ? ` · ch${hover.ch + 1}` : '');
    if (mode === 'spectrogram' && hover.freq != null) {
      const mag = hover.magDb != null ? ` · ${hover.magDb > -150 ? hover.magDb.toFixed(1) : '−∞'} dB` : '';
      readout.textContent = `${base} · ${Math.round(hover.freq)} Hz${mag}`;
    } else {
      const a = hover.value != null
        ? ` · ${hover.value >= 0 ? '+' : ''}${hover.value.toFixed(3)} (${hover.db > -99 ? hover.db.toFixed(1) : '−∞'} dB)`
        : '';
      readout.textContent = base + a;
    }
  }

  // ---- zero-crossing snap ---------------------------------------------------
  // The sample data was transferred to the worker, but audioBuffer keeps a copy
  // (copyToChannel). Build a lazy mono mix from it and snap selection edges to the
  // nearest zero crossing so looped regions join without a click. We prefer rising
  // crossings for both edges so start/end share slope direction (fewer artifacts).
  let monoMix = null;
  function mix() {
    if (monoMix) return monoMix;
    const m = new Float32Array(length);
    for (let c = 0; c < numChannels; c++) {
      const d = audioBuffer.getChannelData(c);
      for (let i = 0; i < length; i++) m[i] += d[i];
    }
    if (numChannels > 1) for (let i = 0; i < length; i++) m[i] /= numChannels;
    monoMix = m;
    return m;
  }
  // Nearest sample to `target` where the mix crosses zero. dir +1 = rising only,
  // -1 = falling only, 0 = either. Searches ±~50ms; returns target if none found.
  function zeroCross(target, dir = 0) {
    const m = mix();
    const t = clamp(Math.round(target), 0, length);
    const win = Math.max(1, Math.round(sampleRate * 0.05));
    const lo = Math.max(1, t - win), hi = Math.min(length - 1, t + win);
    let best = -1, bestDist = Infinity;
    for (let i = lo; i <= hi; i++) {
      const a = m[i - 1], b = m[i];
      const rising = a < 0 && b >= 0, falling = a > 0 && b <= 0;
      if (dir > 0 ? !rising : dir < 0 ? !falling : !(rising || falling)) continue;
      const d = Math.abs(i - t);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best >= 0 ? best : t;
  }
  function snapSelection(sel) {
    if (!sel) return sel;
    const a = zeroCross(sel.a, +1);
    let b = zeroCross(sel.b, +1);
    if (b <= a) b = zeroCross(sel.b, 0);   // fall back to any crossing if rising collapses it
    return b > a ? { a, b } : sel;          // never invert or degenerate the region
  }

  // ---- playback -------------------------------------------------------------
  function updatePlayBtn() { playBtn.textContent = playing ? '■' : '▶'; playBtn.classList.toggle('on', playing); }
  function play(from, opts = {}) {
    loopRange = opts.loopRange || null;
    player.play({
      token: wav, buffer: audioBuffer, sampleRate, length,
      from, loop: loopWhole, loopRange, origin: 'editor',
    });
  }
  // Start the main transport: play from the selection's left edge when there is
  // one (else the click cursor), and when loop is on, loop the selection if there
  // is one, otherwise the whole sound.
  function startPlayback() {
    const from = selection ? selection.a : cursorSample;
    const loopRange = (loopWhole && selection) ? { a: selection.a, b: selection.b } : null;
    play(from, { loopRange });
  }
  function togglePlay() { if (player.isPlaying(wav)) player.stop(); else startPlayback(); }
  // Reflect the shared player's state into this view: button, raf loop, waterfall.
  function syncFromPlayer() {
    const now = player.isPlaying(wav);   // only adopt when the live voice is OUR audio
    if (now && !rafPlay) rafPlay = requestAnimationFrame(tick);
    if (!now) {
      loopRange = null;
      if (rafPlay) { cancelAnimationFrame(rafPlay); rafPlay = 0; }
      if (started) worker.postMessage({ type: 'setPlayhead', sample: null });   // waterfall reverts to static
    }
    if (now !== playing) { playing = now; updatePlayBtn(); paint(); }
    else updatePlayBtn();
  }
  function tick() {
    const ph = player.isPlaying(wav) ? player.playhead() : null;
    if (ph == null) { rafPlay = 0; syncFromPlayer(); return; }
    playSample = ph;
    if (mode === 'waterfall') {
      // Scroll the waterfall: the worker re-renders with the front trace at now.
      if (started) worker.postMessage({ type: 'setPlayhead', sample: playSample });
    } else if (!interacting && (viewport.endSample - viewport.startSample) < length) {
      // playhead-follow when zoomed in and not mid-interaction
      const nv = followStep(viewport, playSample, cssW, FOLLOW_EDGE);
      if (nv !== viewport) setViewport(nv);
    }
    paint();
    rafPlay = requestAnimationFrame(tick);
  }
  // Keep this view in step with playback started from anywhere (node buttons,
  // other editors). The initial adopt happens once layout is ready (init rAF).
  const offPlayer = player.on(syncFromPlayer);

  // ---- export / promote region ----------------------------------------------
  // The "region" is the selection if there is one, else the whole sound.
  function currentRegion() {
    if (selection && selection.b - selection.a >= 1) {
      return { a: clamp(Math.round(selection.a), 0, length), b: clamp(Math.round(selection.b), 0, length), sel: true };
    }
    return { a: 0, b: length, sel: false };
  }
  // Re-decode the retained bytes (channelData was transferred to the worker) and
  // slice the region into a fresh 32-bit float WAV.
  function sliceRegionWav(a, b) {
    const dec = decodeAudio(wav);
    return encodeWav({ sampleRate: dec.sampleRate, channelData: dec.channelData.map((c) => c.subarray(a, b)) });
  }
  function exportRegion() {
    const { a, b, sel } = currentRegion();
    if (b - a < 1) return;
    const url = URL.createObjectURL(new Blob([sliceRegionWav(a, b)], { type: 'audio/wav' }));
    const an = el('a', { href: url, download: `${(name || 'audio').replace(/[^\w.-]+/g, '_')}${sel ? '-sel' : ''}.wav` });
    an.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function promoteRegion() {
    if (!onPromote) return;
    const { a, b, sel } = currentRegion();
    if (b - a < 1) return;
    onPromote(sliceRegionWav(a, b), sel ? `${name} ✂` : name);
    close();   // the region now lives in its own Source node
  }
  // Crop the owning Source to the selection: replace its audio with the sliced
  // region, then close (the worker still holds the old full sample, so we don't
  // live-swap it — reopening shows the cropped audio). Needs an explicit region.
  function cropRegion() {
    if (!onCrop) return;
    const { a, b, sel } = currentRegion();
    if (!sel || b - a < 1) return;
    onCrop(sliceRegionWav(a, b), name);
    close();
  }

  // ---- keyboard -------------------------------------------------------------
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {   // cycle view: waveform → spectrogram → waterfall (Shift = back)
      e.preventDefault();
      const n = MODES.length;
      setRenderMode(MODES[(MODES.indexOf(mode) + (e.shiftKey ? n - 1 : 1)) % n]);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {   // select all
      e.preventDefault();
      if (length > 0) { selection = { a: 0, b: length }; cursorSample = 0; paint(); }
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      if (e.repeat) return;
      spaceHeld = true; spacePanned = false;
      if (!drag) stage.style.cursor = 'grab';
    }
  }
  function onKeyUp(e) {
    if (e.code === 'Space') {
      spaceHeld = false;
      if (!drag) stage.style.cursor = 'crosshair';
      if (!spacePanned) togglePlay();   // tap = play/stop; drag = pan
    }
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKeyUp, true);

  // ---- close / cleanup ------------------------------------------------------
  function close() {
    if (closed) return;
    closed = true;
    offPlayer();
    // Stop only playback this editor started; audio a node Play button started
    // keeps going after the editor closes (the "peek then close" flow).
    if (player.isPlaying(wav) && player.origin === 'editor') player.stop();
    if (rafPlay) { cancelAnimationFrame(rafPlay); rafPlay = 0; }
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('keyup', onKeyUp, true);
    clearTimeout(resumeTimer);
    ro.disconnect();
    try { worker.postMessage({ type: 'dispose' }); } catch {}
    worker.terminate();
    if (lastBitmap) { lastBitmap.close(); lastBitmap = null; }
    root.remove();
  }
  closeBtn.addEventListener('click', close);

  return {
    close,
    // Inspectable state (debugging / tests).
    getState: () => ({ viewport: { ...viewport }, selection: selection && { ...selection }, playing, cursorSample, loopWhole }),
  };
}
