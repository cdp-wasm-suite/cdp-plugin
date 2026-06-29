// Pure, shared viewport math for the pop-out waveform editor. Imported by BOTH
// the worker (which draws the waveform lanes) and the main thread (which draws
// the playhead/selection/hover overlay), so both compute identical sample↔pixel
// and lane geometry from the same viewport object. No DOM, no side effects.
//
// A viewport describes which slice of the sound is currently visible:
//   { startSample, endSample, sampleRate, totalSamples }
// startSample is inclusive, endSample exclusive (a half-open [start, end) range),
// so span = endSample - startSample is the visible sample count.

// Never let the view collapse below a few samples (keeps the math non-degenerate
// and bounds how far the user can zoom in; the editor switches to sample-line
// rendering long before this).
export const MIN_SPAN = 4;

export const span = (vp) => vp.endSample - vp.startSample;
export const samplesPerPixel = (vp, cssW) => (vp.endSample - vp.startSample) / Math.max(1, cssW);

// Map a sample index to an x pixel within a cssW-wide lane (and back). Neither is
// clamped — callers may want off-screen coordinates (e.g. a playhead just past
// the edge) and clamp themselves when drawing.
export const sampleToX = (vp, sample, cssW) =>
  ((sample - vp.startSample) / (vp.endSample - vp.startSample)) * cssW;
export const xToSample = (vp, x, cssW) =>
  vp.startSample + (x / Math.max(1, cssW)) * (vp.endSample - vp.startSample);

// Clamp a (possibly out-of-range) {startSample,endSample} into [0,total],
// preserving the span where possible and never going below MIN_SPAN. Returns a
// fresh viewport carrying the same sampleRate/totalSamples.
export function clampViewport(vp, total = vp.totalSamples) {
  total = Math.max(MIN_SPAN, total || MIN_SPAN);
  let s = vp.startSample;
  let e = vp.endSample;
  let sp = Math.min(Math.max(MIN_SPAN, e - s), total);
  if (s < 0) s = 0;
  if (s + sp > total) s = total - sp;
  if (s < 0) s = 0;
  e = s + sp;
  return { startSample: s, endSample: e, sampleRate: vp.sampleRate, totalSamples: total };
}

// Whole-sound view.
export function fit(vp, total = vp.totalSamples) {
  total = Math.max(MIN_SPAN, total || MIN_SPAN);
  return { startSample: 0, endSample: total, sampleRate: vp.sampleRate, totalSamples: total };
}

// Zoom by `factor` (>1 zooms in, <1 zooms out) keeping `anchorSample` pinned to
// its current fractional position across the view — so wheel-zoom under the
// cursor leaves the sample under the cursor put.
export function zoomAt(vp, anchorSample, factor, total = vp.totalSamples) {
  total = Math.max(MIN_SPAN, total || MIN_SPAN);
  const cur = vp.endSample - vp.startSample;
  const rel = cur > 0 ? (anchorSample - vp.startSample) / cur : 0.5;
  const next = Math.min(Math.max(MIN_SPAN, cur / factor), total);
  const start = anchorSample - rel * next;
  return clampViewport(
    { startSample: start, endSample: start + next, sampleRate: vp.sampleRate, totalSamples: total },
    total,
  );
}

// Zoom the view to exactly span [a,b] (order-independent), clamped.
export function zoomToRange(vp, a, b, total = vp.totalSamples) {
  let lo = Math.min(a, b);
  let hi = Math.max(a, b);
  if (hi - lo < MIN_SPAN) hi = lo + MIN_SPAN;
  return clampViewport(
    { startSample: lo, endSample: hi, sampleRate: vp.sampleRate, totalSamples: total },
    total,
  );
}

// Pan by a pixel delta (positive = content moves left / view moves right).
export function panByPixels(vp, dxPixels, cssW, total = vp.totalSamples) {
  const ds = (dxPixels / Math.max(1, cssW)) * (vp.endSample - vp.startSample);
  return clampViewport(
    { startSample: vp.startSample + ds, endSample: vp.endSample + ds, sampleRate: vp.sampleRate, totalSamples: total },
    total,
  );
}

// Playhead-follow: when the playhead approaches/crosses the trailing edge (or
// falls behind the start), page the view so the playhead sits `edgeFraction` in
// from the left. Returns the SAME object when no scroll is needed, so callers can
// cheaply skip re-posting the viewport.
export function followStep(vp, playSample, cssW, edgeFraction = 0.18) {
  const sp = vp.endSample - vp.startSample;
  const trailing = vp.endSample - edgeFraction * sp;
  if (playSample >= vp.startSample && playSample <= trailing) return vp;
  const start = playSample - edgeFraction * sp;
  return clampViewport(
    { startSample: start, endSample: start + sp, sampleRate: vp.sampleRate, totalSamples: vp.totalSamples },
    vp.totalSamples,
  );
}

// ---- lane geometry (stacked multichannel) ----------------------------------
// Lanes stack vertically and fill cssH equally. `scrollTop` accounts for a
// vertically-scrolled stage when numChannels*minLane exceeds the visible height.
// laneRect gives a lane's pixel band + its mid (zero) line; laneAt inverts it.

export function laneHeight(cssH, numChannels) {
  return cssH / Math.max(1, numChannels);
}

export function laneRect(channel, cssH, numChannels) {
  const h = laneHeight(cssH, numChannels);
  const top = channel * h;
  return { top, height: h, mid: top + h / 2 };
}

export function laneAt(y, cssH, numChannels, scrollTop = 0) {
  const h = laneHeight(cssH, numChannels);
  const idx = Math.floor((y + scrollTop) / h);
  return Math.min(Math.max(0, idx), numChannels - 1);
}

// Map a linear amplitude [-1,1] to a y pixel within a lane (uses ~92% of the
// lane half-height so the loudest peaks don't touch the lane border).
export function ampToY(amp, channel, cssH, numChannels) {
  const { mid, height } = laneRect(channel, cssH, numChannels);
  return mid - amp * (height / 2) * 0.92;
}

// ---- 3D waterfall projection -----------------------------------------------
// A rotatable orthographic camera over the amplitude/frequency/time box for the
// waterfall view, shared by the worker (traces + back-wall grid) and the editor
// (axis lines + tick labels) so they register exactly. Box coordinates are unit
// fractions:
//   frequency  fx  0..1  (box X)
//   amplitude  amp 0..1  (box Y, up)
//   time       ty  0..1  (box Z, depth)
// `yaw` orbits around the vertical axis, `pitch` tilts up/down (radians). The box
// is auto-fitted into the lane (minus label margins) at any angle. `project`
// returns screen {x,y} plus `depth` (larger = nearer the camera) for painter's
// ordering. Keep |yaw| < 90° so the time axis stays monotonic in depth.
const WF_BOX = { sx: 1.2, sy: 0.62, sz: 1.0 };   // box proportions (freq × amp × time)
export function waterfallGeometry(laneTop, laneHeight, cssW, yaw = 0.5, pitch = 0.34) {
  const mL = 44, mR = 50, mT = 22, mB = 30;          // label margins (CSS px)
  const availW = Math.max(40, cssW - mL - mR);
  const availH = Math.max(30, laneHeight - mT - mB);
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const world = (fx, ty, amp) => [(fx - 0.5) * WF_BOX.sx, (amp - 0.5) * WF_BOX.sy, (ty - 0.5) * WF_BOX.sz];
  const rot = (p) => {                                // yaw about Y, then pitch about X
    const x1 = p[0] * cy + p[2] * sy, z1 = -p[0] * sy + p[2] * cy, y1 = p[1];
    return [x1, y1 * cp - z1 * sp, y1 * sp + z1 * cp];
  };
  // Auto-fit: rotate the 8 corners, take the screen bounds, derive scale + centre.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    const r = rot(world(i & 1, (i >> 1) & 1, (i >> 2) & 1));
    if (r[0] < minX) minX = r[0]; if (r[0] > maxX) maxX = r[0];
    if (r[1] < minY) minY = r[1]; if (r[1] > maxY) maxY = r[1];
  }
  const scale = Math.min(availW / Math.max(1e-6, maxX - minX), availH / Math.max(1e-6, maxY - minY));
  const cx = mL + availW / 2 - ((minX + maxX) / 2) * scale;
  const cyv = laneTop + mT + availH / 2 + ((minY + maxY) / 2) * scale;
  const project = (fx, ty, amp) => { const r = rot(world(fx, ty, amp)); return { x: cx + r[0] * scale, y: cyv - r[1] * scale, depth: r[2] }; };
  const depthPerTy = rot(world(0.5, 1, 0.5))[2] - rot(world(0.5, 0, 0.5))[2];   // >0 → ty=1 nearest
  return { project, depthPerTy, scale };
}
