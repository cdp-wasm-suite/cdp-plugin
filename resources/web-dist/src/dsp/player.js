// Shared single-voice audio player. The whole app plays through one of these, so
// the node Play buttons (patcher.js makeTransport) and the pop-out waveform
// editor never double up — and the editor can adopt (show a live, moving playhead
// for) playback that was started elsewhere, e.g. from an Output node's Play
// button. Views (buttons, editor) ask it to play()/stop(), subscribe to 'change'
// to keep their labels in sync, and read playhead() each animation frame.
//
// Audio identity is a `token`: the caller passes the wav bytes it owns, so a view
// can ask isPlaying(myWav) — "is the live voice *my* audio?".
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- native plugin-host bridge (no-op in a normal browser) -----------------
// When this page runs inside the cdp-plugin webview, the native host injects a global
// IPlugSendMsg(). We forward every rendered buffer to the plugin's DSP sampler
// as: header (sampleRate, numChans, numFrames) -> N planar PCM chunks -> end.
// Tags must match EMsgTags in the cdp-plugin native side.
const CDP_MSG_SAMPLE_HEADER = 0;
const CDP_MSG_SAMPLE_CHUNK = 1;
const CDP_MSG_SAMPLE_END = 2;
const CDP_CHUNK_BYTES = 64 * 1024;

function cdpBytesToBase64(u8) {
  let s = '';
  const STRIDE = 0x8000; // chunk fromCharCode to avoid arg-count limits
  for (let i = 0; i < u8.length; i += STRIDE)
    s += String.fromCharCode.apply(null, u8.subarray(i, i + STRIDE));
  return btoa(s);
}

export function forwardBufferToPlugin(buffer) {
  if (typeof IPlugSendMsg !== 'function' || !buffer) return; // browser: nothing to do
  try {
    const nch = buffer.numberOfChannels;
    const frames = buffer.length;
    const sr = Math.round(buffer.sampleRate);

    // Planar layout: [ch0 frames..., ch1 frames..., ...]
    const flat = new Float32Array(nch * frames);
    for (let c = 0; c < nch; c++) flat.set(buffer.getChannelData(c), c * frames);
    const bytes = new Uint8Array(flat.buffer);

    const header = new Int32Array([sr, nch, frames]);
    IPlugSendMsg({ msg: 'SAMFUI', msgTag: CDP_MSG_SAMPLE_HEADER, ctrlTag: -1,
                   data: cdpBytesToBase64(new Uint8Array(header.buffer)) });

    let idx = 0;
    for (let off = 0; off < bytes.length; off += CDP_CHUNK_BYTES, idx++) {
      const slice = bytes.subarray(off, Math.min(off + CDP_CHUNK_BYTES, bytes.length));
      IPlugSendMsg({ msg: 'SAMFUI', msgTag: CDP_MSG_SAMPLE_CHUNK, ctrlTag: idx,
                     data: cdpBytesToBase64(slice) });
    }
    IPlugSendMsg({ msg: 'SAMFUI', msgTag: CDP_MSG_SAMPLE_END, ctrlTag: idx, data: '' });
  } catch (e) {
    /* never let host forwarding break in-page playback */
  }
}

export function createPlayer(audioCtx) {
  let src = null;            // live AudioBufferSourceNode | null
  let token = null;          // identity of what's playing (the wav bytes)
  let origin = null;         // 'node' | 'editor' — who started it
  let sampleRate = 0, length = 0;
  let startCtxTime = 0, startSample = 0;
  let loop = false, loopRange = null;
  const bus = new EventTarget();
  const emit = () => bus.dispatchEvent(new Event('change'));

  function stop() {
    if (src) { try { src.onended = null; src.stop(); src.disconnect(); } catch {} src = null; }
    if (token !== null) {
      token = null; origin = null; loopRange = null; loop = false;
      emit();
    }
  }

  async function play({ token: tk, buffer, sampleRate: sr, length: len, from = 0, loop: lp = false, loopRange: lr = null, origin: org = 'node' }) {
    stop();
    await audioCtx.resume();
    const s = audioCtx.createBufferSource();
    s.buffer = buffer;
    s.connect(audioCtx.destination);
    loopRange = lr; loop = lp || !!lr;
    if (loopRange) { s.loop = true; s.loopStart = loopRange.a / sr; s.loopEnd = loopRange.b / sr; }
    else if (loop) s.loop = true;
    s.onended = () => { if (s === src) stop(); };
    startSample = clamp(from, 0, len - 1);
    s.start(0, startSample / sr);
    src = s; token = tk; origin = org; sampleRate = sr; length = len; startCtxTime = audioCtx.currentTime;
    emit();
    forwardBufferToPlugin(buffer); // mirror the rendered audio into the host DSP sampler
  }

  // Live-toggle whole-sound loop on the current voice (no effect with a loopRange).
  function setLoop(on) { loop = on; if (src && !loopRange) src.loop = on; }

  // No arg → "is anything playing"; with a token → "is *that* audio the live voice".
  // A null/undefined token (e.g. an empty node's getWav()) never matches a real voice.
  function isPlaying(tk) { return src !== null && (arguments.length === 0 || tk === token); }

  // Current playhead sample, or null when idle. Same modulo cases the editor used.
  function playhead() {
    if (!src) return null;
    const elapsed = (audioCtx.currentTime - startCtxTime) * sampleRate;
    if (loopRange) {
      const l = loopRange.b - loopRange.a;
      return loopRange.a + (((startSample - loopRange.a) + elapsed) % l + l) % l;
    }
    if (loop) return (startSample + elapsed) % length;
    const p = startSample + elapsed;
    if (p >= length) { stop(); return null; }   // natural end
    return p;
  }

  // Playhead as a 0..1 fraction of the whole sound (or null when idle) — for mini
  // waveform previews that map the entire buffer across their width.
  function progress() { const p = playhead(); return p == null ? null : (length ? p / length : 0); }

  return {
    play, stop, setLoop, isPlaying, playhead, progress,
    get origin() { return origin; },
    on(fn) { bus.addEventListener('change', fn); return () => bus.removeEventListener('change', fn); },
  };
}
