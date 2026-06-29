// Retro, monochrome on-screen MIDI keyboard docked at the bottom of the screen.
// It drives a sampler-shaped target ({ noteOn(note, vel), noteOff(note),
// allNotesOff() }) — in standalone mode that's the Web Audio sampler, in plugin
// mode it forwards MIDI to the C++ engine (see sampler.js). The keyboard itself
// is agnostic about which.
//
// Input sources, all funnelled through hold()/unhold():
//   - mouse / touch : pointer capture + drag-to-slide (glissando), multi-touch
//   - computer keys : Ableton-style row (a = C), z / x shift the octave
//   - WebMIDI       : external controllers, reflected as key highlights
//
// Styled only with the theme custom properties (--ink / --paper / --line /
// --frame), so it restyles with every theme and the font picker for free. Built
// around a small `opts` object (range, octave, velocity) so it can grow new
// modes (scales, isomorphic layouts) without reshaping the DOM code.

import { el } from './ui.js';

const BLACK = new Set([1, 3, 6, 8, 10]);
const isBlack = (n) => BLACK.has(((n % 12) + 12) % 12);
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n) => NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);

// Ableton-style computer-keyboard layout: home row = white keys from C, the row
// above = the sharps; offsets are semitones above the current base note.
const QWERTY = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17,
};

const WHITE_W = 26;   // px; black keys derive from this
const VOL_KEY = 'cdp-web-sampler-vol';   // persisted master volume, in dB
const VOL_MIN = -60, VOL_MAX = 0, VOL_DEF = -12;   // dB; bottom of travel = silence
const ADSR_KEY = 'cdp-web-sampler-adsr';   // persisted [attack, decay, sustain, release]
const ADSR_DEF = [0.005, 0, 1, 0.05];      // s, s, 0..1, s — click-free near-one-shot
const ADSR_OPEN_KEY = 'cdp-web-sampler-adsr-open';   // persisted ADSR panel expanded state (default collapsed)
const VIB_FIXED = 2;   // vibrato LFO rate (Hz) — fixed for now, no UI
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dbToGain = (db) => (db <= VOL_MIN ? 0 : Math.pow(10, db / 20));

// ---- plugin-mode parameter bridge (native plugin-host protocol) ------------
// Inside the cdp-plugin WebView the VOL/ADSR faders are host parameters, not local
// Web Audio controls. We speak the stock native-host message names over IPlugSendMsg:
// SPVFUI/BPCFUI/EPCFUI up (values normalized 0..1), SPVFD down (dispatched via
// window.registerParamHandler, wired in index.html). Indices match the C++
// ParamIndex enum in composers_desktop_plugin.h.
const inPlugin = () => typeof IPlugSendMsg === 'function';
const PARAM = { GAIN: 0, ATTACK: 1, DECAY: 2, SUSTAIN: 3, RELEASE: 4 };
// Normalize/denormalize a range input against its own min/max (linear).
const normOf = (input) => { const lo = +input.min, hi = +input.max; return hi > lo ? (+input.value - lo) / (hi - lo) : 0; };
const denormTo = (input, n) => { const lo = +input.min, hi = +input.max; return lo + n * (hi - lo); };

// Wire a range <input> to a host parameter: gesture-bracketed value sends up, and
// host pushes down (suppressed while the user is dragging, to avoid a feedback
// loop). onHostValue runs after a host-driven change so dependent UI (e.g. a
// readout) can refresh. Registers the down-handler last so any value the host
// already pushed (initial sync) is applied immediately.
const bindPluginParam = (input, paramIdx, onHostValue) => {
  let gesturing = false;
  const begin = () => { if (!gesturing) { gesturing = true; IPlugSendMsg({ msg: 'BPCFUI', paramIdx }); } };
  const end = () => { if (gesturing) { gesturing = false; IPlugSendMsg({ msg: 'EPCFUI', paramIdx }); } };
  input.addEventListener('pointerdown', begin);
  input.addEventListener('keydown', begin);
  input.addEventListener('input', () => {
    IPlugSendMsg({ msg: 'SPVFUI', paramIdx, value: normOf(input) });
    // Reflect the drag in any dependent UI (e.g. the VOL dB readout) immediately.
    // The host->UI handler below is suppressed while gesturing, so without this the
    // readout wouldn't track a local drag — only host-originated changes.
    if (onHostValue) onHostValue();
  });
  input.addEventListener('pointerup', end);
  input.addEventListener('pointercancel', end);
  input.addEventListener('keyup', end);
  input.addEventListener('blur', end);
  window.registerParamHandler(paramIdx, (norm) => {
    if (gesturing) return;                       // don't fight an active drag
    input.value = String(denormTo(input, norm));
    if (onHostValue) onHostValue();
  });
};

export function createKeyboard(target, opts = {}) {
  const cfg = { lo: 12, hi: 108, octave: 5, velocity: 100, ...opts };   // 8 octaves, C0–C8

  // ---- DOM -----------------------------------------------------------------
  const keysWrap = el('div', { class: 'kbd-keys' });
  const octLabel = el('span', { class: 'kbd-oct' });
  const title = el('span', { class: 'kbd-title', textContent: 'SAMPLER' });
  const panic = el('button', { class: 'kbd-btn kbd-panic', textContent: 'panic', title: 'All notes off' });
  // Master volume in dB, far right (a head-room safety valve for summed polyphony).
  let savedDb = VOL_DEF;
  try { const s = localStorage.getItem(VOL_KEY); if (s != null && Number.isFinite(+s)) savedDb = clamp(+s, VOL_MIN, VOL_MAX); } catch {}
  const vol = el('input', { class: 'kbd-vol', type: 'range', min: String(VOL_MIN), max: String(VOL_MAX), step: '1', value: String(savedDb), title: 'Master volume (dB)' });
  const volReadout = el('span', { class: 'kbd-vol-db' });
  const volWrap = el('label', { class: 'kbd-vol-wrap' }, el('span', { textContent: 'VOL' }), vol, volReadout);
  const adsrToggle = el('button', { class: 'kbd-btn kbd-adsr-toggle', type: 'button',
    title: 'Show / hide amplitude envelope (ADSR)' });
  // Chromatic repitch on/off. Off (default) plays the sample at its native pitch
  // on every key; on maps the keyboard to semitones. Reflects the sampler's state.
  const repitchToggle = el('button', { class: 'kbd-btn kbd-repitch-toggle', type: 'button',
    title: 'Chromatic repitch: play the keyboard as pitches, or every key at the sample’s original pitch' });
  const setRepitchLabel = (on) => {
    repitchToggle.textContent = on ? 'REPITCH ●' : 'REPITCH ○';
    repitchToggle.classList.toggle('on', on);
    repitchToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  if (target.setRepitch) {
    setRepitchLabel(!!target.repitch);
    repitchToggle.addEventListener('click', () => { const on = !target.repitch; target.setRepitch(on); setRepitchLabel(on); });
  } else {
    repitchToggle.style.display = 'none';
  }
  const closeBtn = el('button', { class: 'kbd-btn', textContent: '▾', title: 'Collapse / expand (or double-click the bar)' });
  const bar = el('div', { class: 'kbd-bar' }, title, adsrToggle, repitchToggle, el('span', { class: 'kbd-spacer' }), octLabel, panic, volWrap, closeBtn);

  const fmtDb = (db) => (db <= VOL_MIN ? '-∞' : (db > 0 ? '+' + db : String(db))) + ' dB';
  const updateVolReadout = () => { volReadout.textContent = fmtDb(clamp(+vol.value, VOL_MIN, VOL_MAX)); };
  const applyVol = () => {
    updateVolReadout();
    target.setGain && target.setGain(dbToGain(clamp(+vol.value, VOL_MIN, VOL_MAX)));
  };
  if (inPlugin()) {
    // The host owns output level (the Gain parameter). Send edits up, receive host
    // changes down, and just keep the readout in sync — no local engine gain, no
    // localStorage (host/preset state is the source of truth).
    updateVolReadout();
    bindPluginParam(vol, PARAM.GAIN, updateVolReadout);
  } else {
    vol.addEventListener('input', () => { applyVol(); try { localStorage.setItem(VOL_KEY, vol.value); } catch {} });
    applyVol();   // push the saved/default level into the engine up front
  }

  // ---- left control cluster: pitch-bend + mod wheels, then ADSR ------------
  const fader = (label, attrs, title) => {
    const input = el('input', { class: 'kbd-fader', type: 'range', title, ...attrs });
    // A fixed-size box reserves the layout; the slider is a horizontal range
    // rotated to vertical inside it (reliable sizing across browsers).
    const box = el('div', { class: 'kbd-fader-box' }, input);
    const col = el('label', { class: 'kbd-fader-col' }, box, el('span', { class: 'kbd-fader-lbl', textContent: label }));
    return { input, col };
  };
  const pb = fader('PB', { min: '-1', max: '1', step: '0.01', value: '0' }, 'Pitch bend (springs back to centre)');
  const mod = fader('MOD', { min: '0', max: '1', step: '0.01', value: '0' }, 'Mod wheel → vibrato depth');
  // Pitch bend is live while dragged, then springs back to centre on release.
  pb.input.addEventListener('input', () => target.pitchBend && target.pitchBend(+pb.input.value));
  pb.input.addEventListener('change', () => { pb.input.value = '0'; target.pitchBend && target.pitchBend(0); });
  mod.input.addEventListener('input', () => target.modWheel && target.modWheel(+mod.input.value));

  // Vibrato rate is fixed for now (no UI); the MOD wheel controls its depth.
  target.setVibratoRate && target.setVibratoRate(VIB_FIXED);

  let savedAdsr = ADSR_DEF.slice();
  try { const s = JSON.parse(localStorage.getItem(ADSR_KEY)); if (Array.isArray(s) && s.length === 4) savedAdsr = s.map(Number); } catch {}
  const aF = fader('A', { min: '0', max: '2', step: '0.005', value: String(savedAdsr[0]) }, 'Attack (s)');
  const dF = fader('D', { min: '0', max: '2', step: '0.005', value: String(savedAdsr[1]) }, 'Decay (s)');
  const sF = fader('S', { min: '0', max: '1', step: '0.01', value: String(savedAdsr[2]) }, 'Sustain level');
  const rF = fader('R', { min: '0', max: '2', step: '0.005', value: String(savedAdsr[3]) }, 'Release (s)');
  const applyAdsr = () => {
    const v = [+aF.input.value, +dF.input.value, +sF.input.value, +rF.input.value];
    target.setADSR && target.setADSR(...v);
    try { localStorage.setItem(ADSR_KEY, JSON.stringify(v)); } catch {}
  };
  if (inPlugin()) {
    // In the plugin, A/D/S/R are host parameters (same order as the C++ enum).
    bindPluginParam(aF.input, PARAM.ATTACK);
    bindPluginParam(dF.input, PARAM.DECAY);
    bindPluginParam(sF.input, PARAM.SUSTAIN);
    bindPluginParam(rF.input, PARAM.RELEASE);
  } else {
    for (const f of [aF, dF, sF, rF]) f.input.addEventListener('input', applyAdsr);
    applyAdsr();   // push saved/default ADSR into the engine up front
  }

  // ADSR faders live in a collapsible group, hidden by default behind the header
  // chevron (adsrToggle, created up in the bar). The separator hides with them so
  // the cluster reads cleanly when collapsed.
  const adsrGroup = el('div', { class: 'kbd-adsr', role: 'group', 'aria-label': 'Amplitude envelope (ADSR)' },
    el('span', { class: 'kbd-ctrls-sep' }), aF.col, dF.col, sF.col, rF.col);
  let adsrOpen = false;
  try { adsrOpen = localStorage.getItem(ADSR_OPEN_KEY) === '1'; } catch {}
  const setAdsrOpen = (on) => {
    adsrOpen = on;
    adsrGroup.classList.toggle('collapsed', !on);
    adsrToggle.textContent = on ? 'ADSR ▾' : 'ADSR ▸';
    adsrToggle.setAttribute('aria-expanded', on ? 'true' : 'false');
    try { localStorage.setItem(ADSR_OPEN_KEY, on ? '1' : '0'); } catch {}
  };
  adsrToggle.addEventListener('click', () => setAdsrOpen(!adsrOpen));
  setAdsrOpen(adsrOpen);

  const ctrls = el('div', { class: 'kbd-ctrls' }, pb.col, mod.col, adsrGroup);
  const scroll = el('div', { class: 'kbd-scroll' }, keysWrap);
  const main = el('div', { class: 'kbd-main' }, ctrls, scroll);
  const root = el('div', { class: 'kbd', role: 'group', 'aria-label': 'MIDI keyboard' }, bar, main);

  const keyEls = new Map();   // note -> element
  const held = new Map();     // note -> hold count (any source)

  function buildKeys() {
    keysWrap.innerHTML = '';
    keyEls.clear();
    let whiteCount = 0;
    const blacks = [];
    for (let n = cfg.lo; n <= cfg.hi; n++) {
      if (isBlack(n)) { blacks.push(n); continue; }
      const left = whiteCount * WHITE_W;
      const k = el('div', { class: 'kbd-key kbd-white', 'data-note': String(n),
        style: `left:${left}px;width:${WHITE_W}px` });
      if (n % 12 === 0) k.append(el('span', { class: 'kbd-label', textContent: noteName(n) }));
      keysWrap.append(k); keyEls.set(n, k);
      whiteCount++;
    }
    const bw = Math.round(WHITE_W * 0.62);
    for (const n of blacks) {
      // Count white keys strictly below n to find the straddle point.
      let whitesBelow = 0;
      for (let m = cfg.lo; m < n; m++) if (!isBlack(m)) whitesBelow++;
      const left = whitesBelow * WHITE_W - bw / 2;
      const k = el('div', { class: 'kbd-key kbd-black', 'data-note': String(n),
        style: `left:${left}px;width:${bw}px` });
      keysWrap.append(k); keyEls.set(n, k);
    }
    keysWrap.style.width = (whiteCount * WHITE_W + 2) + 'px';   // +2 for the container's left border
    octLabel.textContent = `OCT ${cfg.octave}`;
  }

  // ---- note routing --------------------------------------------------------
  // hold/unhold are reference-counted so overlapping sources (e.g. a held mouse
  // key that's also struck on a MIDI controller) light up and release cleanly.
  function paint(note) {
    const k = keyEls.get(note);
    if (k) k.classList.toggle('on', (held.get(note) || 0) > 0);
  }
  function hold(note, vel = cfg.velocity) {
    const c = held.get(note) || 0;
    held.set(note, c + 1);
    if (c === 0) { target.noteOn(note, vel); paint(note); }
  }
  function unhold(note) {
    const c = held.get(note) || 0;
    if (c <= 0) return;
    held.set(note, c - 1);
    if (c - 1 === 0) { target.noteOff(note); paint(note); }
  }
  function releaseAll() {
    target.allNotesOff();
    for (const n of [...held.keys()]) { held.set(n, 0); paint(n); }
    held.clear();
  }

  // ---- pointer (mouse / touch), with glissando -----------------------------
  const pointerNote = new Map();   // pointerId -> note currently sounded
  const noteAt = (x, y) => {
    const t = document.elementFromPoint(x, y)?.closest?.('.kbd-key');
    return t ? Number(t.dataset.note) : null;
  };
  keysWrap.addEventListener('pointerdown', (e) => {
    const n = noteAt(e.clientX, e.clientY);
    if (n == null) return;
    e.preventDefault();
    try { keysWrap.setPointerCapture(e.pointerId); } catch {}
    pointerNote.set(e.pointerId, n);
    hold(n);
  });
  keysWrap.addEventListener('pointermove', (e) => {
    if (!pointerNote.has(e.pointerId)) return;
    const prev = pointerNote.get(e.pointerId);
    const n = noteAt(e.clientX, e.clientY);
    if (n === prev) return;
    if (prev != null) unhold(prev);          // legato slide
    if (n != null) hold(n);
    pointerNote.set(e.pointerId, n);
  });
  const endPointer = (e) => {
    if (!pointerNote.has(e.pointerId)) return;
    const n = pointerNote.get(e.pointerId);
    if (n != null) unhold(n);
    pointerNote.delete(e.pointerId);
  };
  keysWrap.addEventListener('pointerup', endPointer);
  keysWrap.addEventListener('pointercancel', endPointer);

  // ---- computer keyboard ---------------------------------------------------
  const downKeys = new Set();   // physical keys currently held (de-dupe repeats)
  function typingTarget() {
    const ae = document.activeElement;
    const tag = (ae?.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || ae?.isContentEditable
      || ae?.closest?.('[popover]');
  }
  function onKeyDown(e) {
    if (!expanded || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (typingTarget()) return;
    const key = e.key.toLowerCase();
    if (key === 'z') { e.preventDefault(); cfg.octave = Math.max(0, cfg.octave - 1); octLabel.textContent = `OCT ${cfg.octave}`; return; }
    if (key === 'x') { e.preventDefault(); cfg.octave = Math.min(9, cfg.octave + 1); octLabel.textContent = `OCT ${cfg.octave}`; return; }
    if (!(key in QWERTY) || downKeys.has(key)) return;
    e.preventDefault();
    downKeys.add(key);
    hold(cfg.octave * 12 + QWERTY[key]);
  }
  function onKeyUp(e) {
    const key = e.key.toLowerCase();
    if (!downKeys.has(key)) return;
    downKeys.delete(key);
    unhold(cfg.octave * 12 + QWERTY[key]);
  }

  // ---- WebMIDI -------------------------------------------------------------
  let midiAccess = null;
  function bindMidi(input) {
    input.onmidimessage = (ev) => {
      const [status, d1, d2] = ev.data;
      const cmd = status & 0xf0;
      if (cmd === 0x90 && d2 > 0) hold(d1, d2);
      else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) unhold(d1);
      else if (cmd === 0xb0 && (d1 === 123 || d1 === 120)) releaseAll();
    };
  }
  function initMidi() {
    // In a plugin/host WebView the DAW routes MIDI straight to the C++ engine and
    // the on-screen keys forward via SMMFUI, so the page never needs Web MIDI —
    // and requesting it there pops a permission prompt (e.g. WebView2 on Windows).
    if (inPlugin()) return;
    if (!navigator.requestMIDIAccess) return;
    navigator.requestMIDIAccess().then((access) => {
      midiAccess = access;
      for (const input of access.inputs.values()) bindMidi(input);
      access.onstatechange = (e) => { if (e.port.type === 'input' && e.port.state === 'connected') bindMidi(e.port); };
    }).catch(() => { /* WebMIDI denied/unavailable — silent */ });
  }

  // ---- lifecycle -----------------------------------------------------------
  // The dock is mounted once and then stays put. "Hiding" slides it down (a CSS
  // transform) so only the SAMPLER title bar peeks above the bottom edge — its
  // volume/panic stay live there. Double-click that bar — or use the View menu —
  // to bring the keys back.
  let mounted = false;
  let expanded = true;   // chevron state: the dock can fold to just its title bar
  let shown = false;     // whole-dock presence: the Show Sampler menu toggles this
  // A paper strip pinned to the very bottom edge, so macOS's rounded window
  // corners clip empty footer rather than eating into the SAMPLER bar.
  const footer = el('div', { class: 'kbd-footer', 'aria-hidden': 'true' });
  panic.onclick = releaseAll;
  // The chevron / bar double-click only collapse the dock to its title bar; fully
  // hiding the sampler is the Show Sampler menu's job (api.show/hide).
  closeBtn.onclick = () => setExpanded(!expanded);
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input, .kbd-vol-wrap')) return;   // leave the bar's own controls alone
    setExpanded(!expanded);
  });
  buildKeys();
  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', onKeyUp);

  function mount() {
    if (mounted) return;
    mounted = true;
    document.body.appendChild(root);
    document.body.appendChild(footer);
    if (!midiAccess) initMidi();
  }
  function setExpanded(on) {
    expanded = on;
    root.classList.toggle('collapsed', !on);
    document.body.classList.toggle('kbd-collapsed', !on);
    closeBtn.textContent = on ? '▾' : '▸';
    if (!on) releaseAll();
  }
  // Show/hide the whole dock — like the Log's Show Log, this removes the UI
  // entirely (no leftover bar) and lets the desktop reclaim the space via has-kbd.
  function setShown(on) {
    shown = on;
    root.style.display = on ? '' : 'none';
    footer.style.display = on ? '' : 'none';
    document.body.classList.toggle('has-kbd', on);
    if (!on) releaseAll();
  }

  const api = {
    el: root,
    get visible() { return shown; },   // "visible" == the whole sampler dock is present
    show() { mount(); setShown(true); },
    hide() { setShown(false); },        // remove the whole dock (not just collapse to the bar)
    toggle() { api.visible ? api.hide() : api.show(); },
    dispose() {
      releaseAll();
      root.remove();
      footer.remove();
      document.body.classList.remove('has-kbd', 'kbd-collapsed');
      mounted = false; shown = false; expanded = true;
      removeEventListener('keydown', onKeyDown);
      removeEventListener('keyup', onKeyUp);
    },
  };
  return api;
}
