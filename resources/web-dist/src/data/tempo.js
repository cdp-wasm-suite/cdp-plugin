// Global project tempo for the CDP patcher. CDP itself only ever works in
// seconds — this module lets the UI author breakpoint envelopes on a musical
// beat grid and pick note divisions for rate/time parameters, converting to
// seconds before anything reaches a CDP program. One BPM for the whole patch,
// persisted to localStorage and saved with the patch JSON.
//
// (Not to be confused with makeTransport() in ui.js, which is the audio-playback
// transport — this is musical tempo.)

const KEY = 'cdp-web-bpm';
const MIN = 20, MAX = 960, DEFAULT = 120;

let bpm = DEFAULT;

export const getBpm = () => bpm;

export function setBpm(v) {
  const next = Math.min(MAX, Math.max(MIN, Math.round(+v) || DEFAULT));
  if (next === bpm) return bpm;
  bpm = next;
  try { localStorage.setItem(KEY, String(bpm)); } catch { /* storage disabled */ }
  window.dispatchEvent(new CustomEvent('tempochange', { detail: bpm }));
  return bpm;
}

export function initTempo() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* ignore */ }
  const n = Number(saved);
  bpm = Number.isFinite(n) && n >= MIN && n <= MAX ? Math.round(n) : DEFAULT;
  return bpm;
}

// time conversions (one beat = a quarter note)
export const beatsToSec = (beats, b = bpm) => (beats * 60) / b;
export const secToBeats = (sec, b = bpm) => (sec * b) / 60;

// ---- musical note divisions -------------------------------------------------
// `base` is the fraction of a whole note: a whole note spans 4 beats, so its
// duration is base * 240 / bpm seconds (quarter = 1/4 -> 60/bpm s).
export const DIVISIONS = [
  { label: '1/1', base: 1 },
  { label: '1/2', base: 1 / 2 },
  { label: '1/4', base: 1 / 4 },
  { label: '1/8', base: 1 / 8 },
  { label: '1/16', base: 1 / 16 },
  { label: '1/32', base: 1 / 32 },
];

export function divisionSeconds(base, { dotted = false, triplet = false } = {}, b = bpm) {
  return ((base * 240) / b) * (dotted ? 1.5 : 1) * (triplet ? 2 / 3 : 1);
}

// Resolve a division to a parameter value in the param's own unit:
//   'hz' -> one cycle per division (rate); 's'/'ms' -> the division's duration.
export function divisionValue(base, unit, mods = {}, b = bpm) {
  const sec = divisionSeconds(base, mods, b);
  if (unit === 'hz') return 1 / sec;
  if (unit === 'ms') return sec * 1000;
  return sec; // 's'
}
