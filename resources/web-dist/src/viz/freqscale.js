// Shared frequency-axis mapping for the spectrogram. Imported by BOTH the worker
// (pixel row → FFT bin when rendering) and the editor (axis labels + hover), so
// energy and labels always land on the same pixels. `frac` is the vertical
// fraction 0 = bottom (DC) … 1 = top (Nyquist). Pure, no DOM.
export const SCALES = ['linear', 'log', 'mel'];

const LOG_FMIN = 20;                                  // log axis floor (Hz)
const toMel = (f) => 2595 * Math.log10(1 + f / 700);
const fromMel = (m) => 700 * (10 ** (m / 2595) - 1);

export function fracToFreq(scale, frac, nyquist) {
  if (scale === 'log') { const fmin = Math.min(LOG_FMIN, nyquist / 100); return fmin * Math.pow(nyquist / fmin, frac); }
  if (scale === 'mel') return fromMel(frac * toMel(nyquist));
  return frac * nyquist;
}

export function freqToFrac(scale, f, nyquist) {
  if (scale === 'log') { const fmin = Math.min(LOG_FMIN, nyquist / 100); return f <= fmin ? 0 : Math.log(f / fmin) / Math.log(nyquist / fmin); }
  if (scale === 'mel') return toMel(f) / toMel(nyquist);
  return f / nyquist;
}
