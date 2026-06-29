// Shared GEM/Atari UI helpers for the CDP patcher. Pure DOM + the Popover
// API; no CDP coupling (decodeAudio is the only package import, for waveform/
// duration math). main.js and patcher.js both build on these.
import { decodeAudio, ENVELOPE_PARAMS } from '@olilarkin/cdp-wasm';
import { themeColors } from './themes.js';
import { getBpm, secToBeats, beatsToSec, DIVISIONS, divisionValue } from '../data/tempo.js';
import { installPopoverFallback } from './popover-fallback.js';

// Shim the Popover API before any menu/dialog/tooltip is built — no-op where
// the WebView supports it natively (see popover-fallback.js for the why).
installPopoverFallback();

export const $ = (id) => document.getElementById(id);
export const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'title') n.setAttribute('data-tip', v);   // custom tooltip, not the native one
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) n.append(c);
  return n;
};
export const fmt = (v) => (Number.isInteger(+v) ? String(v) : (+v).toFixed(2));
const SVGNS = 'http://www.w3.org/2000/svg';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- custom tooltips (replaces native title=) -------------------------------
// Any element carrying a `data-tip` attribute (el() maps `title:` to it) shows a
// GEM-styled popover on hover or keyboard focus, after a short delay. One shared
// popover element, driven by event delegation — call initTooltips() once.
let tipEl = null, tipTimer = null, tipFor = null;
function placeTip(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  if (!tipEl) { tipEl = el('div', { class: 'gem-tip' }); tipEl.setAttribute('popover', 'manual'); document.body.appendChild(tipEl); }
  tipEl.textContent = text;
  tipFor = target;
  tipEl.style.left = '-9999px'; tipEl.style.top = '0';   // measure off-screen, no flash
  tipEl.showPopover();
  const rc = target.getBoundingClientRect(), tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
  let left = Math.min(Math.max(4, rc.left + rc.width / 2 - tw / 2), innerWidth - tw - 4);
  let top = rc.bottom + 6;
  if (top + th > innerHeight - 4) top = rc.top - th - 6;   // flip above if it would overflow
  tipEl.style.left = left + 'px'; tipEl.style.top = Math.max(4, top) + 'px';
}
function hideTip() {
  clearTimeout(tipTimer); tipTimer = null; tipFor = null;
  if (tipEl && tipEl.matches(':popover-open')) tipEl.hidePopover();
}
export function initTooltips() {
  const schedule = (t, delay) => { if (!t || t === tipFor) return; clearTimeout(tipTimer); tipTimer = setTimeout(() => placeTip(t), delay); };
  document.addEventListener('pointerover', (e) => schedule(e.target.closest?.('[data-tip]'), 450));
  document.addEventListener('pointerout', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t && !(e.relatedTarget && t.contains(e.relatedTarget))) hideTip();
  });
  document.addEventListener('focusin', (e) => schedule(e.target.closest?.('[data-tip]'), 250));
  document.addEventListener('focusout', hideTip);
  document.addEventListener('pointerdown', hideTip, true);   // any click/drag dismisses
  addEventListener('blur', hideTip);
}

// GEM number field: a text box with stacked ▲▼ steppers, replacing the native
// spinner + blue focus ring. Returns { wrap, input, get, set }; onChange(value)
// fires on commit (Enter/blur) and on each step. Arrow keys also step.
export function numField(opts = {}, onChange = () => {}) {
  const { value = 0, min = -Infinity, max = Infinity, step = 1, width = '4.5rem' } = opts;
  const dec = (String(step).split('.')[1] || '').length;
  const fix = (v) => (dec ? (+v).toFixed(dec) : String(Math.round(+v)));
  const clampv = (v) => Math.min(max, Math.max(min, v));
  const input = el('input', { type: 'text', inputmode: 'decimal', class: 'numinput', value: fix(value), style: `width:${width}` });
  const get = () => { const n = parseFloat(input.value); return Number.isFinite(n) ? n : value; };
  const set = (v) => { input.value = fix(clampv(v)); };
  const bump = (d) => { set(clampv(get() + d * step)); onChange(get()); };
  input.addEventListener('change', () => { set(clampv(get())); onChange(get()); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); bump(1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); bump(-1); }
  });
  const mk = (txt, d) => { const b = el('button', { type: 'button', class: 'numbtn', textContent: txt, tabIndex: -1 }); b.onclick = () => bump(d); return b; };
  const wrap = el('span', { class: 'numfield' }, input, el('span', { class: 'numspin' }, mk('▲', 1), mk('▼', -1)));
  return { wrap, input, get, set };
}

// ---- log bus: messages buffer until a sink (the Log window) is attached ----
let _logSink = null;
const _logBuf = [];
export function log(...m) {
  const line = m.join(' ');
  if (_logSink) _logSink(line);
  else _logBuf.push(line);
}
export function setLogSink(fn) {
  _logSink = fn;
  if (fn) { for (const l of _logBuf) fn(l); _logBuf.length = 0; }
}

// ---- GEM modal alert / confirm ----------------------------------------------
// buttons: [{ label, value, primary? }]. Returns a Promise of the chosen value
// (null on Escape). message may contain simple HTML (<b>, <br>).
export function gemAlert(message, buttons = [{ label: 'OK', value: true, primary: true }]) {
  return new Promise((resolve) => {
    const card = el('div', { class: 'gem-dialog' });
    card.setAttribute('popover', 'manual');
    const msg = el('div', { class: 'gem-dialog-msg', html: message });
    const btns = el('div', { class: 'gem-dialog-btns' });
    const done = (v) => { card.hidePopover(); card.remove(); resolve(v); };
    for (const b of buttons) {
      const btn = el('button', { type: 'button', class: b.primary ? 'ok' : 'secondary', textContent: b.label });
      btn.onclick = () => done(b.value);
      btns.appendChild(btn);
    }
    card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } });
    card.append(el('div', { class: 'gem-dialog-inner' }, el('div', { class: 'gem-dialog-icon', textContent: '⚠' }), msg), btns);
    document.body.appendChild(card);
    card.showPopover();
    (btns.querySelector('.ok') || btns.firstElementChild)?.focus();
  });
}

// A modal text-input dialog. Returns a Promise of the entered string (trimmed),
// or null on Cancel / Escape. `value` pre-fills the field. message may contain
// simple HTML (<b>, <br>).
export function gemPrompt(message, value = '', { ok = 'OK', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const card = el('div', { class: 'gem-dialog' });
    card.setAttribute('popover', 'manual');
    const msg = el('div', { class: 'gem-dialog-msg', html: message });
    const input = el('input', { type: 'text', value, placeholder, style: 'width:100%;margin-top:10px' });
    const btns = el('div', { class: 'gem-dialog-btns' });
    const done = (v) => { card.hidePopover(); card.remove(); resolve(v); };
    const cancel = el('button', { type: 'button', class: 'secondary', textContent: 'Cancel' });
    const okBtn = el('button', { type: 'button', class: 'ok', textContent: ok });
    cancel.onclick = () => done(null);
    okBtn.onclick = () => done(input.value.trim());
    btns.append(cancel, okBtn);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim()); } });
    card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } });
    card.append(el('div', { class: 'gem-dialog-inner' }, el('div', { class: 'gem-dialog-icon', textContent: '✎' }),
      el('div', { style: 'flex:1' }, msg, input)), btns);
    document.body.appendChild(card);
    card.showPopover();
    input.focus(); input.select();
  });
}

// A modal with several labelled inputs. fields: [{name,label,value?,placeholder?}].
// Resolves to { name: trimmedValue } on OK/Enter, or null on Cancel/Escape.
export function gemFields(message, fields, { ok = 'OK' } = {}) {
  return new Promise((resolve) => {
    const card = el('div', { class: 'gem-dialog' });
    card.setAttribute('popover', 'manual');
    const msg = el('div', { class: 'gem-dialog-msg', html: message });
    const inputs = {};
    const rows = fields.map((f) => {
      const input = el('input', { type: 'text', value: f.value ?? '', placeholder: f.placeholder || '', style: 'width:9rem' });
      inputs[f.name] = input;
      return el('div', { style: 'display:flex;gap:.5rem;align-items:center;margin-top:8px' }, el('label', { textContent: f.label, style: 'min-width:4rem' }), input);
    });
    const btns = el('div', { class: 'gem-dialog-btns' });
    const done = (v) => { card.hidePopover(); card.remove(); resolve(v); };
    const submit = () => done(Object.fromEntries(fields.map((f) => [f.name, inputs[f.name].value.trim()])));
    const cancel = el('button', { type: 'button', class: 'secondary', textContent: 'Cancel' });
    const okBtn = el('button', { type: 'button', class: 'ok', textContent: ok });
    cancel.onclick = () => done(null); okBtn.onclick = submit;
    btns.append(cancel, okBtn);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === 'Escape') { e.preventDefault(); done(null); } });
    card.append(el('div', { class: 'gem-dialog-inner' }, el('div', { class: 'gem-dialog-icon', textContent: '✎' }), el('div', { style: 'flex:1' }, msg, ...rows)), btns);
    document.body.appendChild(card);
    card.showPopover();
    const first = inputs[fields[0].name]; first.focus(); first.select();
  });
}

// ---- GEM menu-bar dropdown (Popover API) ------------------------------------
// builder() returns item specs evaluated each open: {label,action,disabled,checked} | {group} | {sep}
// A flyout submenu: a row that opens a nested gem-menu to its right. The child
// is a DOM descendant of the parent menu so interacting with it doesn't
// light-dismiss the parent (nested-popover rules). `subs` collects the open
// children so the owner can hide/remove them on rebuild or close.
function makeSubmenu(menu, subs, it) {
  const row = el('div', { class: 'opt submenu' }, el('span', { textContent: it.label }), el('span', { class: 'sub-arr', textContent: '▸' }));
  const child = el('div', { class: 'gem-menu' });
  child.setAttribute('popover', 'manual');
  menu.appendChild(child);
  subs.push(child);
  let hideT;
  const open = () => {
    clearTimeout(hideT);
    child.innerHTML = '';
    for (const s of (typeof it.submenu === 'function' ? it.submenu() : it.submenu)) {
      if (s.sep) { child.appendChild(el('div', { class: 'menusep' })); continue; }
      const sr = el('div', { class: 'opt', textContent: (s.checked ? '✔ ' : '') + s.label });
      sr.addEventListener('click', () => { try { child.hidePopover(); } catch {} menu.hidePopover(); s.action && s.action(); });
      child.appendChild(sr);
    }
    child.style.left = '-9999px'; child.style.top = '0';
    child.showPopover();
    const rc = row.getBoundingClientRect();
    let left = rc.right - 2;
    if (left + child.offsetWidth > innerWidth - 4) left = rc.left - child.offsetWidth + 2;
    child.style.left = Math.max(4, left) + 'px';
    child.style.top = Math.max(4, Math.min(rc.top - 2, innerHeight - child.offsetHeight - 4)) + 'px';
  };
  const scheduleHide = () => { clearTimeout(hideT); hideT = setTimeout(() => { try { child.hidePopover(); } catch {} }, 220); };
  row.addEventListener('pointerenter', open);
  row.addEventListener('click', open);
  row.addEventListener('pointerleave', scheduleHide);
  child.addEventListener('pointerenter', () => clearTimeout(hideT));
  child.addEventListener('pointerleave', scheduleHide);
  return row;
}

// Render a menu's items into an (empty) .gem-menu popover. Shared by the menu-bar
// dropdowns and the right-click context menu. Returns a closeSubs() that tears
// down any open flyout children. Item shape: { label, action, disabled, checked,
// sep, group, submenu }.
function populateMenu(menu, items) {
  const subs = [];
  const closeSubs = () => { for (const s of subs) { try { s.hidePopover(); } catch {} s.remove(); } subs.length = 0; };
  closeSubs();
  menu.innerHTML = '';
  for (const it of items) {
    if (it.sep) { menu.appendChild(el('div', { class: 'menusep' })); continue; }
    if (it.group) { menu.appendChild(el('div', { class: 'grp', textContent: it.group })); continue; }
    if (it.submenu) { menu.appendChild(makeSubmenu(menu, subs, it)); continue; }
    const r = el('div', { class: 'opt' + (it.disabled ? ' dis' : ''), textContent: (it.checked ? '✔ ' : '') + it.label });
    if (!it.disabled) r.addEventListener('click', () => { menu.hidePopover(); it.action && it.action(); });
    menu.appendChild(r);
  }
  return closeSubs;
}

export function dropdown(btn, builder) {
  const menu = el('div', { class: 'gem-menu', tabIndex: -1 });
  menu.setAttribute('popover', 'auto');
  document.body.appendChild(menu);
  btn.popoverTargetElement = menu;
  let closeSubs = () => {};

  menu.addEventListener('beforetoggle', (e) => {
    if (e.newState !== 'open') return;
    closeSubs = populateMenu(menu, builder());
  });
  menu.addEventListener('toggle', (e) => {
    if (e.newState !== 'open') { closeSubs(); return; }
    const rc = btn.getBoundingClientRect();
    menu.style.minWidth = Math.max(180, rc.width) + 'px';
    menu.style.left = Math.min(rc.left, innerWidth - menu.offsetWidth - 4) + 'px';
    menu.style.top = rc.bottom + 'px';
    menu.style.maxHeight = Math.max(140, innerHeight - rc.bottom - 8) + 'px';
  });
  return menu;
}

// Open a one-shot context menu at a viewport point (x, y). Same item shape and
// styling as dropdown(); the menu light-dismisses (click-away / Escape) and
// removes itself from the DOM when closed. `builder` is an items array or a
// function returning one.
export function openMenuAt(x, y, builder) {
  const menu = el('div', { class: 'gem-menu', tabIndex: -1 });
  menu.setAttribute('popover', 'auto');
  document.body.appendChild(menu);
  let closeSubs = () => {};
  menu.addEventListener('beforetoggle', (e) => {
    if (e.newState !== 'open') return;
    closeSubs = populateMenu(menu, typeof builder === 'function' ? builder() : builder);
  });
  menu.addEventListener('toggle', (e) => {
    if (e.newState !== 'open') { closeSubs(); menu.remove(); return; }   // dismissed → tear down
    menu.style.minWidth = '180px';
    menu.style.maxHeight = Math.max(140, innerHeight - 8) + 'px';
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(x, innerWidth - w - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, innerHeight - h - 4)) + 'px';
    menu.focus();
  });
  menu.showPopover();
  return menu;
}

// A "Preset ▾" button that opens a dropdown of named shapes; picking one runs
// onPick(shapeKey). `shapes` is [[label, shapeKey], ...]. Collapses a row of
// preset buttons into a single menu.
export function presetMenu(shapes, onPick, label = 'Preset') {
  const btn = el('button', { type: 'button', class: 'secondary', textContent: label + ' ▾' });
  dropdown(btn, () => shapes.map(([t, shape]) => ({ label: t, action: () => onPick(shape) })));
  return btn;
}

// ---- GEM <select> skin (Popover API). Keeps the real <select> as value source.
export function gemSelect(sel) {
  sel.style.display = 'none';
  const lbl = el('span', { class: 'lbl' });
  const trigger = el('button', { type: 'button', class: 'gem-trigger' }, lbl, el('span', { class: 'arr', textContent: '▾' }));
  const menu = el('div', { class: 'gem-menu', tabIndex: -1 });
  menu.setAttribute('popover', 'auto');
  document.body.appendChild(menu);
  const rows = [];
  const addOpt = (opt) => {
    const r = el('div', { class: 'opt', textContent: opt.textContent });
    r.dataset.value = opt.value;
    r.addEventListener('click', () => choose(opt.value));
    menu.appendChild(r); rows.push(r);
  };
  for (const child of sel.children) {
    if (child.tagName === 'OPTGROUP') {
      menu.appendChild(el('div', { class: 'grp', textContent: child.label }));
      for (const o of child.children) addOpt(o);
    } else if (child.tagName === 'OPTION') addOpt(child);
  }
  let cur = -1;
  const setCur = (i) => {
    if (rows[cur]) rows[cur].classList.remove('cur');
    cur = i;
    if (rows[cur]) { rows[cur].classList.add('cur'); rows[cur].scrollIntoView({ block: 'nearest' }); }
  };
  function choose(value) { sel.value = value; sync(); sel.dispatchEvent(new Event('change')); menu.hidePopover(); }
  function sync() {
    const o = sel.options[sel.selectedIndex];
    lbl.textContent = o ? o.textContent : '';
    for (const r of rows) r.setAttribute('aria-selected', String(r.dataset.value === sel.value));
  }
  function position() {
    const rc = trigger.getBoundingClientRect();
    menu.style.minWidth = rc.width + 'px'; menu.style.maxHeight = '';
    const mh = Math.min(menu.scrollHeight, Math.round(innerHeight * 0.6));
    const below = innerHeight - rc.bottom, above = rc.top;
    if (below < mh + 8 && above > below) menu.style.top = Math.max(4, rc.top - mh) + 'px';
    else { menu.style.top = rc.bottom + 'px'; menu.style.maxHeight = Math.max(80, below - 8) + 'px'; }
    menu.style.left = Math.min(rc.left, innerWidth - menu.offsetWidth - 6) + 'px';
  }
  sel.addEventListener('change', sync);
  trigger.popoverTargetElement = menu;
  menu.addEventListener('toggle', (e) => {
    if (e.newState !== 'open') return;
    position(); setCur(rows.findIndex((r) => r.dataset.value === sel.value)); menu.focus();
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCur(Math.min(rows.length - 1, cur + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCur(Math.max(0, cur - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (rows[cur]) choose(rows[cur].dataset.value); }
    else if (e.key.length === 1) {
      const k = e.key.toLowerCase(); const n = rows.length;
      for (let i = 0; i < n; i++) { const r = rows[(cur + 1 + i) % n]; if (r.textContent.toLowerCase().startsWith(k)) { setCur(rows.indexOf(r)); break; } }
    }
  });
  sel.after(trigger); sync();
  return { trigger, sync };
}

// ---- breakpoint envelopes ----------------------------------------------------
export const BRK_PRESETS = {
  'ramp-up': '0 0\n1 1', 'ramp-down': '0 1\n1 0',
  arch: '0 0\n0.5 1\n1 0', vee: '0 1\n0.5 0\n1 1',
};
export function parseBrk(text) {
  const pts = [];
  for (const line of (text || '').split('\n')) {
    const m = line.trim().split(/[\s,]+/).map(Number);
    if (m.length >= 2 && m.every(Number.isFinite)) pts.push([m[0], m[1]]);
  }
  return pts;
}

// An envelope's value axis (0–1 vs real) and time axis (0–1 vs seconds vs beats)
// are independent. axisFlags reads them as { vnorm, tnorm, tunit }, migrating the
// legacy single `norm` flag (which normalised BOTH axes together) to the split.
export function axisFlags(e = {}) {
  if (e.vnorm === undefined && e.tnorm === undefined && e.norm !== undefined)
    return { vnorm: e.norm !== false, tnorm: e.norm !== false, tunit: e.tunit };
  return { vnorm: e.vnorm !== false, tnorm: e.tnorm !== false, tunit: e.tunit };
}
export function plotEnvelope(cvs, text) {
  if (!cvs) return;
  const pts = parseBrk(text), dpr = devicePixelRatio || 1;
  cvs.width = cvs.clientWidth * dpr; cvs.height = cvs.clientHeight * dpr;
  const ctx = cvs.getContext('2d'), w = cvs.width, h = cvs.height, pad = 6 * dpr;
  ctx.clearRect(0, 0, w, h);
  if (pts.length < 2) return;
  const ts = pts.map((p) => p[0]), vs = pts.map((p) => p[1]);
  const t0 = Math.min(...ts), t1 = Math.max(...ts), vmin = Math.min(...vs), vmax = Math.max(...vs);
  const sx = (t) => pad + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (w - 2 * pad);
  const sy = (v) => h - pad - (vmax === vmin ? 0.5 : (v - vmin) / (vmax - vmin)) * (h - 2 * pad);
  const { ink, paper } = themeColors();
  ctx.strokeStyle = ink; ctx.lineWidth = 2 * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
  pts.forEach(([t, v], i) => (i ? ctx.lineTo(sx(t), sy(v)) : ctx.moveTo(sx(t), sy(v))));
  ctx.stroke();
  const s = 5 * dpr;
  for (const [t, v] of pts) {
    ctx.fillStyle = paper; ctx.fillRect(sx(t) - s / 2, sy(v) - s / 2, s, s);
    ctx.strokeStyle = ink; ctx.lineWidth = 2 * dpr; ctx.strokeRect(sx(t) - s / 2, sy(v) - s / 2, s, s);
  }
}
// Build an envelope text spanning `dur` seconds; flat holds `value`, shapes sweep min..max.
export function scaledPreset(shape, p, value, dur = 1) {
  dur = Math.max(0.001, dur);
  const t = (f) => +(f * dur).toFixed(3);
  const lo = p.min, hi = p.max, mid = (lo + hi) / 2;
  switch (shape) {
    case 'ramp-up': return `0 ${lo}\n${t(1)} ${hi}`;
    case 'ramp-down': return `0 ${hi}\n${t(1)} ${lo}`;
    case 'arch': return `0 ${lo}\n${t(0.5)} ${hi}\n${t(1)} ${lo}`;
    case 'vee': return `0 ${hi}\n${t(0.5)} ${lo}\n${t(1)} ${hi}`;
    default: return `0 ${value ?? mid}\n${t(1)} ${value ?? mid}`;
  }
}

// ---- 1-bit waveform scope (canvas element + WAV bytes) ----------------------
export function drawWave(cvs, wav) {
  if (!cvs || !wav) return;
  const { channelData, length, sampleRate } = decodeAudio(wav);
  const data = channelData[0], dpr = devicePixelRatio || 1;
  const { ink, paper } = themeColors();
  cvs.width = cvs.clientWidth * dpr; cvs.height = cvs.clientHeight * dpr;
  const ctx = cvs.getContext('2d'), w = cvs.width, h = cvs.height, mid = h / 2;
  ctx.fillStyle = paper; ctx.fillRect(0, 0, w, h);
  drawBeatGrid(ctx, w, h, dpr, length / (sampleRate || 44100), ink);
  ctx.fillStyle = ink; ctx.fillRect(0, Math.round(mid), w, 1);
  ctx.strokeStyle = ink; ctx.lineWidth = dpr; ctx.beginPath();
  const step = Math.max(1, Math.floor(length / w));
  for (let x = 0; x < w; x++) {
    let min = 1, max = -1;
    for (let i = 0; i < step; i++) { const v = data[x * step + i] || 0; if (v < min) min = v; if (v > max) max = v; }
    ctx.moveTo(x, mid + min * mid); ctx.lineTo(x, mid + max * mid);
  }
  ctx.stroke();
}
// Faint vertical gridlines at every beat (accented per bar, assuming 4/4) using
// the global tempo — skipped when beats would pack tighter than ~5px.
function drawBeatGrid(ctx, w, h, dpr, dur, ink) {
  const bpm = getBpm();
  if (!bpm || !dur || dur <= 0) return;
  const secPerBeat = 60 / bpm;
  if ((secPerBeat / dur) * w < 5) return;
  ctx.save();
  ctx.fillStyle = ink;
  for (let beat = 0, t = 0; t <= dur + 1e-6; beat++, t = beat * secPerBeat) {
    ctx.globalAlpha = beat % 4 === 0 ? 0.32 : 0.15;
    ctx.fillRect(Math.round((t / dur) * w), 0, Math.max(1, Math.round(dpr)), h);
  }
  ctx.restore();
}
export function wavDuration(wav) {
  try { const d = decodeAudio(wav); return d.length / d.sampleRate; } catch { return 1; }
}

// ---- shared breakpoint-envelope editor (graph + table + presets) ------------
// One widget used by both the inline per-parameter editor and the separate
// Breakpoint window. An envelope is { vnorm, tnorm, tunit?, text } where text is
// newline-joined "time value" pairs. The value (y) and time (x) axes are
// INDEPENDENT (axisFlags migrates the legacy single `norm` flag):
//   value: vnorm:true  → 0..1, scaled to the target param's [min,max] at run time
//          vnorm:false → real values in the param's own units
//   time:  tnorm:true  → 0..1, scaled to the sound's duration at run time
//          tnorm:false → real seconds, or tempo beats when tunit==='beat'
//   opts.range : {min,max} | null  value range for the real value axis (null = auto-fit)
//   opts.dur   : number            time-axis extent (seconds) for the absolute time axis
//   opts.get()/set(env)/onChange() : envelope accessors
export function makeEnvelopeEditor({ range = null, dur = 1, get, set, onChange = () => {} }) {
  const span = range ? ((range.max - range.min) || 1) : 1;
  const env = () => get() || { vnorm: true, tnorm: true, text: '' };
  // The value and time axes are independent; derive each from the env's flags.
  const valState = () => (axisFlags(env()).vnorm ? 'norm' : 'real');
  const timeState = () => { const f = axisFlags(env()); return f.tnorm ? 'norm' : (f.tunit === 'beat' ? 'beat' : 'sec'); };
  const pts = () => parseBrk(env().text);
  const num = (x) => (Number.isInteger(x) ? String(x) : +(+x).toFixed(4));
  const fmtPts = (ps) => ps.map(([t, v]) => `${num(+t)} ${num(+v)}`).join('\n');
  // Preserve both axis flags across edits; only the text changes.
  const put = (text) => { const f = axisFlags(env()); set({ vnorm: f.vnorm, tnorm: f.tnorm, tunit: f.tunit, text }); };
  // Absolute time-axis extent in the current time unit (beats vs seconds).
  const timeExtent = () => (timeState() === 'beat' ? secToBeats(dur || 1) : (dur || 1));
  // Per-axis conversion: value pivots through real units, time through seconds.
  const vToReal = (st, y) => (st === 'real' ? y : (range ? range.min + y * span : y));
  const vFromReal = (st, v) => (st === 'real' ? v : (range ? clamp((v - range.min) / span, 0, 1) : clamp(v, 0, 1)));
  const tToSec = (st, x) => (st === 'norm' ? x * (dur || 1) : st === 'beat' ? beatsToSec(x) : x);
  const tFromSec = (st, s) => (st === 'norm' ? clamp(dur ? s / dur : 0, 0, 1) : st === 'beat' ? secToBeats(s) : s);
  let gridBeats = 0.25;   // beat-grid subdivision (1/16 note); 0 = off

  // Axis bounds for the current mode: normalised 0..1; absolute uses the range
  // (or auto-fits the data when there is none, e.g. the separate window).
  const bounds = (ps) => {
    // Time axis: normalised 0..1, else fixed to the extent (range present) or
    // auto-fit to the data (no range, e.g. the standalone breakpoint window).
    let t1;
    if (timeState() === 'norm') t1 = 1;
    else { const tmax = timeExtent(); t1 = range ? tmax : Math.max(tmax, ...ps.map((q) => q[0]), 1e-6); }
    // Value axis: same rule, independently.
    let v0, v1;
    if (valState() === 'norm') { v0 = 0; v1 = 1; }
    else if (range) { v0 = range.min; v1 = range.max; }
    else {
      const vs = ps.map((q) => q[1]);
      v0 = Math.min(0, ...vs); v1 = Math.max(1e-6, ...vs);
      if (v1 - v0 < 1e-6) { v0 -= 0.5; v1 += 0.5; }
    }
    return { t0: 0, t1, v0, v1 };
  };

  const graph = el('div', { class: 'brk-edit env-graph' });
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'brk-svg');
  const grid = document.createElementNS(SVGNS, 'g');   // beat gridlines (beat mode)
  svg.appendChild(grid);
  const poly = document.createElementNS(SVGNS, 'polyline');
  poly.setAttribute('fill', 'none'); poly.setAttribute('stroke', 'currentColor'); poly.setAttribute('stroke-width', '2.5');
  poly.setAttribute('vector-effect', 'non-scaling-stroke'); poly.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(poly); graph.appendChild(svg);
  const table = el('textarea', { spellcheck: false, hidden: true, style: 'width:100%;height:96px' });

  const writePts = (ps) => { const text = fmtPts(ps); put(text); table.value = text; if (!graph.hidden) draw(); onChange(); };
  let tableMode = false;
  // Vertical gridlines per beat (accented per bar, assuming 4/4) plus optional
  // subdivisions — only in beat mode, and only when not visually too dense.
  function drawGrid(b, X) {
    grid.innerHTML = '';
    if (timeState() !== 'beat') return;
    const px = graph.clientWidth || 300;
    const line = (t, op, w) => {
      const ln = document.createElementNS(SVGNS, 'line');
      const x = X(t);
      ln.setAttribute('x1', x); ln.setAttribute('x2', x); ln.setAttribute('y1', 0); ln.setAttribute('y2', 100);
      ln.setAttribute('stroke', 'currentColor'); ln.setAttribute('stroke-opacity', op);
      ln.setAttribute('stroke-width', w); ln.setAttribute('vector-effect', 'non-scaling-stroke');
      grid.appendChild(ln);
    };
    if (gridBeats > 0 && (gridBeats / (b.t1 || 1)) * px >= 4)
      for (let t = 0; t <= b.t1 + 1e-6; t += gridBeats)
        if (Math.abs(t - Math.round(t)) > 1e-6) line(t, 0.12, 1);
    if ((1 / (b.t1 || 1)) * px >= 4)
      for (let beat = 0; beat <= b.t1 + 1e-6; beat++)
        line(beat, beat % 4 === 0 ? 0.4 : 0.22, beat % 4 === 0 ? 1.5 : 1);
  }
  function draw() {
    const ps = pts(); const b = bounds(ps);
    const X = (t) => clamp((t - b.t0) / ((b.t1 - b.t0) || 1), 0, 1) * 100;
    const Y = (v) => (1 - clamp((v - b.v0) / ((b.v1 - b.v0) || 1), 0, 1)) * 100;
    drawGrid(b, X);
    poly.setAttribute('points', ps.map(([t, v]) => `${X(t)},${Y(v)}`).join(' '));
    graph.querySelectorAll('.brk-handle').forEach((h) => h.remove());
    ps.forEach(([t, v], i) => {
      const h = el('i', { class: 'brk-handle' });
      h.style.left = X(t) + '%'; h.style.top = Y(v) + '%';
      h.addEventListener('pointerdown', (e) => drag(e, i));
      h.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); const a = pts(); if (i > 0 && i < a.length - 1) { a.splice(i, 1); writePts(a); } });
      graph.appendChild(h);
    });
  }
  function drag(e, i) {
    e.preventDefault(); e.stopPropagation();
    const ps = pts(); const b = bounds(ps), tspan = (b.t1 - b.t0) || 1;
    const move = (ev) => {
      const r = graph.getBoundingClientRect();
      const fx = clamp((ev.clientX - r.left) / r.width, 0, 1), fy = 1 - clamp((ev.clientY - r.top) / r.height, 0, 1);
      let t = b.t0 + fx * tspan; let v = b.v0 + fy * (b.v1 - b.v0);
      // Snap to the beat grid in beat mode (hold Alt to drag freely).
      if (timeState() === 'beat' && gridBeats > 0 && !ev.altKey) t = Math.round(t / gridBeats) * gridBeats;
      if (i === 0) t = b.t0; else if (i === ps.length - 1) t = b.t1;
      else t = clamp(t, ps[i - 1][0] + tspan * 0.001, ps[i + 1][0] - tspan * 0.001);
      ps[i] = [t, v]; writePts(ps);
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  }
  graph.addEventListener('dblclick', (e) => {
    if (e.target.closest('.brk-handle')) return;
    const ps = pts(); const b = bounds(ps); const r = graph.getBoundingClientRect();
    const t = b.t0 + clamp((e.clientX - r.left) / r.width, 0.001, 0.999) * (b.t1 - b.t0);
    const v = b.v0 + (1 - clamp((e.clientY - r.top) / r.height, 0, 1)) * (b.v1 - b.v0);
    let idx = ps.findIndex((q) => q[0] > t); if (idx < 0) idx = ps.length;
    ps.splice(idx, 0, [t, v]); writePts(ps);
  });
  // Right-click: add a point by typing exact time/value into a modal (pre-filled
  // from the click position, in the current mode's units).
  graph.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const ps = pts(); const b = bounds(ps); const r = graph.getBoundingClientRect();
    const ct = b.t0 + clamp((e.clientX - r.left) / r.width, 0, 1) * (b.t1 - b.t0);
    const cv = b.v0 + (1 - clamp((e.clientY - r.top) / r.height, 0, 1)) * (b.v1 - b.v0);
    const tu = timeState() === 'norm' ? 'time 0–1' : timeState() === 'beat' ? 'time in beats' : 'time in s';
    const vu = valState() === 'norm' ? 'value 0–1' : (range ? `value ${range.min}–${range.max}` : 'real value');
    const units = `${tu}, ${vu}`;
    const res = await gemFields(`Add a breakpoint <span style="opacity:.6">(${units})</span>`,
      [{ name: 't', label: 'Time', value: num(ct) }, { name: 'v', label: 'Value', value: num(cv) }], { ok: 'Add' });
    if (!res) return;
    let t = Number(res.t), v = Number(res.v);
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    // Clamp each axis only where its bounds are fixed (normalised, or a param range).
    if (timeState() === 'norm' || range) t = clamp(t, b.t0, b.t1);
    if (valState() === 'norm' || range) v = clamp(v, b.v0, b.v1);
    const a = pts();
    let idx = a.findIndex((q) => q[0] > t); if (idx < 0) idx = a.length;
    a.splice(idx, 0, [t, v]); writePts(a);
  });
  table.oninput = () => { put(table.value); onChange(); };

  const presetBtn = presetMenu(
    [['ramp ↑', 'ramp-up'], ['ramp ↓', 'ramp-down'], ['arch', 'arch'], ['V', 'vee']],
    (shape) => {
      // Presets are authored normalised 0–1 on both axes, then mapped into the
      // editor's current value and time states.
      const base = parseBrk(BRK_PRESETS[shape] || '0 0.5\n1 0.5');
      const np = base.map(([x, y]) => [tFromSec(timeState(), tToSec('norm', x)), vFromReal(valState(), vToReal('norm', y))]);
      const text = fmtPts(np);
      put(text); table.value = text; if (!graph.hidden) draw(); onChange();
    },
  );
  // Compact icon toggle (graph ⊞ / table ▤) — keeps the controls row narrow so the
  // beat-grid selector still fits when beat mode is on. Tooltip explains it.
  const viewBtn = el('button', { class: 'secondary env-icon', type: 'button', textContent: '▤', title: 'Switch between graph and table view' });
  viewBtn.onclick = () => { tableMode = !tableMode; table.hidden = !tableMode; graph.hidden = tableMode; viewBtn.textContent = tableMode ? '⊞' : '▤'; if (!tableMode) requestAnimationFrame(draw); };

  // Beat-grid subdivision selector — only meaningful in beat mode. Skinned with
  // the GEM popover (gemSelect) so it matches the rest of the editor's controls.
  const gridSel = el('select', { class: 'env-grid' });
  for (const [lbl, val] of [['1/4', 1], ['1/8', 0.5], ['1/16', 0.25], ['1/32', 0.125], ['grid off', 0]])
    gridSel.append(el('option', { value: String(val), textContent: lbl, selected: val === gridBeats }));
  gridSel.onchange = () => { gridBeats = +gridSel.value; if (!tableMode) requestAnimationFrame(draw); };
  let gridTrigger = null;   // the gemSelect-skinned button, shown only in beat mode

  // Two independent axis toggles. Value (y): 0–1 ↔ real. Time (x): 0–1 → SEC →
  // BEAT. Each remaps only its own column, converting the points losslessly.
  const TORDER = ['norm', 'sec', 'beat'];
  const yBtn = el('button', { class: 'secondary', type: 'button', style: 'min-width:3.4rem;text-align:center' });
  const xBtn = el('button', { class: 'secondary', type: 'button', style: 'min-width:3.4rem;text-align:center' });
  const syncMode = () => {
    const v = valState(), t = timeState();
    yBtn.textContent = v === 'norm' ? 'y 0–1' : 'y val';
    yBtn.classList.toggle('on', v !== 'norm');
    yBtn.setAttribute('data-tip', v === 'norm'
      ? 'Value axis: normalised 0–1, scaled to the target parameter’s range at run time — click for real values'
      : `Value axis: real values${range ? ` (${num(range.min)}–${num(range.max)})` : ''} — click for normalised 0–1`);
    xBtn.textContent = t === 'norm' ? 'x 0–1' : t === 'sec' ? 'x SEC' : 'x BEAT';
    xBtn.classList.toggle('on', t !== 'norm');
    xBtn.setAttribute('data-tip', t === 'norm'
      ? 'Time axis: normalised 0–1, scaled to the sound’s duration at run time — click for seconds'
      : t === 'sec' ? 'Time axis: absolute seconds — click for tempo beats'
        : `Time axis: tempo beats (1 beat = a quarter note @ ${getBpm()} BPM, scaled to seconds at run time) — click for normalised 0–1`);
    if (gridTrigger) gridTrigger.style.display = t === 'beat' ? '' : 'none';
  };
  yBtn.onclick = () => {
    const from = valState(), to = from === 'norm' ? 'real' : 'norm';
    const np = pts().map(([x, y]) => [x, vFromReal(to, vToReal(from, y))]);
    const f = axisFlags(env());
    set({ vnorm: to === 'norm', tnorm: f.tnorm, tunit: f.tunit, text: fmtPts(np) });
    table.value = fmtPts(np); syncMode();
    if (!tableMode) requestAnimationFrame(draw);
    onChange();
  };
  xBtn.onclick = () => {
    const from = timeState(), to = TORDER[(TORDER.indexOf(from) + 1) % TORDER.length];
    const np = pts().map(([x, y]) => [tFromSec(to, tToSec(from, x)), y]);
    const f = axisFlags(env());
    set({ vnorm: f.vnorm, tnorm: to === 'norm', tunit: to === 'beat' ? 'beat' : undefined, text: fmtPts(np) });
    table.value = fmtPts(np); syncMode();
    if (!tableMode) requestAnimationFrame(draw);
    onChange();
  };

  const controls = el('div', { class: 'env-controls' }, presetBtn, viewBtn, yBtn, xBtn, gridSel);
  gridTrigger = gemSelect(gridSel).trigger;   // inserts the skinned button after gridSel in controls
  gridTrigger.setAttribute('data-tip', 'Beat-grid subdivision (beat mode) — drag snaps to it, hold Alt to drag freely');
  const root = el('div', {}, controls, graph, table);
  const refresh = () => { table.value = env().text; syncMode(); if (!tableMode) requestAnimationFrame(draw); };
  syncMode();
  return { el: root, refresh };
}

// A fresh flat envelope at `value` within [min,max] (normalised by default).
export function flatEnvelope(p, value, norm = true) {
  const y = norm ? clamp(((value ?? (p.min + p.max) / 2) - p.min) / ((p.max - p.min) || 1), 0, 1) : (value ?? (p.min + p.max) / 2);
  // Fresh envelopes default to a normalised time axis (0..1 endpoints); the value
  // axis follows `norm`.
  return { vnorm: norm, tnorm: true, text: `0 ${+(+y).toFixed(4)}\n1 ${+(+y).toFixed(4)}` };
}

// A param's physical time unit, for the musical-division picker: 'hz' (a rate),
// 's' or 'ms' (a duration). Inferred from the label suffix — e.g. "Rate (Hz)",
// "Delay (ms)", "Duration (s)" — unless the catalog sets an explicit `p.unit`.
export function paramTimeUnit(p) {
  if (p.unit) return p.unit;
  const m = /\((Hz|ms|s)\)\s*$/.exec(p.label || '');
  return m ? m[1].toLowerCase() : null;
}

// ---- one parameter row: slider (+value) with a ∿ breakpoint-envelope editor.
// state = { values:{name:val}, envs:{name:{norm,text}} } belongs to ONE node.
// opts.canEnv: whether this param accepts an envelope; opts.dur: seconds for presets;
// opts.onChange: called after any value/envelope edit. Returns { row, paramPort? }.
export function paramRow(state, p, opts = {}) {
  const { canEnv = false, dur = 1, onChange = () => {} } = opts;
  if (state.values[p.name] == null) state.values[p.name] = p.default;
  const row = el('div', { style: 'margin:.45rem 0' });
  const head = el('div', { class: 'prow-head' });
  const label = el('label', { class: 'prow-label', textContent: p.label });
  // The parameter's description (from the catalog) shows on hover — on the label
  // too, since an envelope/cable can disable the slider but the label stays live.
  if (p.help) label.setAttribute('data-tip', p.help);
  const range = el('input', { type: 'range', min: p.min, max: p.max, step: p.step ?? 1, value: state.values[p.name], style: 'flex:1' });
  const out = el('span', { class: 'pv', textContent: fmt(range.value) });
  range.oninput = () => { state.values[p.name] = +range.value; out.textContent = fmt(range.value); onChange(); };
  // Hover shows the description; right-click the slider to type an exact value
  // (kept precise even off the slider's step; the thumb snaps to the nearest spot).
  range.setAttribute('data-tip', (p.help ? p.help + '\n' : '') + 'Right-click to type an exact value');
  range.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    if (range.disabled) return;
    const res = await gemPrompt(`${p.label} <span style="opacity:.6">(${p.min}–${p.max})</span>`, String(state.values[p.name]), { ok: 'Set' });
    if (res == null || res === '') return;
    const v = Number(res);
    if (!Number.isFinite(v)) return;
    state.values[p.name] = clamp(v, p.min, p.max);
    range.value = state.values[p.name]; out.textContent = fmt(state.values[p.name]); onChange();
  });
  // ♪ musical-division picker for rate/time params: set the value to a common
  // note division at the project tempo (1/4, 1/8, dotted, triplet…).
  const tunit = paramTimeUnit(p);
  const noteBtn = tunit ? el('button', { type: 'button', class: 'secondary notebtn', textContent: '♪' }) : null;
  if (noteBtn) {
    noteBtn.setAttribute('data-tip', 'Set to a musical note division at the project tempo');
    const applyDivision = (base, mods) => {
      if (range.disabled) return;
      const v = divisionValue(base, tunit, mods, getBpm());
      const cl = clamp(v, p.min, p.max);
      state.values[p.name] = cl; range.value = cl; out.textContent = fmt(cl); onChange();
      if (Math.abs(cl - v) > 1e-6) log(`${p.label}: ${fmt(v)} ${tunit} is out of range — clamped to ${fmt(cl)}`);
    };
    dropdown(noteBtn, () => [
      { group: `note ÷ @ ${getBpm()} BPM` },
      ...DIVISIONS.map((d) => ({ label: d.label, action: () => applyDivision(d.base, {}) })),
      { sep: true },
      { label: 'Dotted ·', submenu: () => DIVISIONS.map((d) => ({ label: d.label + ' ·', action: () => applyDivision(d.base, { dotted: true }) })) },
      { label: 'Triplet ³', submenu: () => DIVISIONS.map((d) => ({ label: d.label + ' ³', action: () => applyDivision(d.base, { triplet: true }) })) },
    ]);
  }
  // Reserve the ♪ column on every row (empty placeholder when this param has no
  // note-division picker) so the slider's right edge aligns across all rows.
  const noteSlot = noteBtn || el('span', { class: 'prow-note' });
  const toggle = el('button', { type: 'button', class: 'secondary envtoggle', textContent: '∿' });
  const isEnv = () => state.envs[p.name] != null;
  if (!canEnv) {
    toggle.disabled = true;
    toggle.setAttribute('data-tip', 'Constant only — CDP does not accept a breakpoint envelope for this parameter');
    head.append(label, range, out, noteSlot, toggle);
    row.append(head);
    return { row, setDriven: () => {} };
  }
  toggle.setAttribute('data-tip', 'Automate this parameter with a breakpoint envelope');
  const env = el('div', { style: 'margin:.3rem 0 .3rem 8rem', hidden: true });
  const editor = makeEnvelopeEditor({
    range: { min: p.min, max: p.max }, dur,
    get: () => state.envs[p.name],
    set: (e) => { state.envs[p.name] = e; },
    onChange,
  });
  env.append(editor.el);
  toggle.onclick = () => {
    if (isEnv()) { delete state.envs[p.name]; env.hidden = true; range.disabled = false; toggle.classList.add('secondary'); }
    else {
      state.envs[p.name] = flatEnvelope(p, +range.value);
      env.hidden = false; range.disabled = true; toggle.classList.remove('secondary');
      requestAnimationFrame(editor.refresh);
    }
    onChange();
  };
  // Cable into this param's port disables/hides the inline editor (run from the
  // cable instead); it's restored if there's an inline envelope when unplugged.
  const setDriven = (on) => {
    range.disabled = on || isEnv();
    toggle.disabled = on;
    out.textContent = on ? '↻ env' : fmt(range.value);
    const showEnv = !on && isEnv();
    env.hidden = !showEnv;
    if (showEnv) requestAnimationFrame(editor.refresh);
  };
  // Restoring a saved patch with an inline envelope: open the editor pre-filled.
  if (isEnv()) {
    env.hidden = false; range.disabled = true; toggle.classList.remove('secondary');
    requestAnimationFrame(editor.refresh);
  }
  head.append(label, range, out, noteSlot, toggle);
  row.append(head, env);
  return { row, setDriven };
}

// ---- partials editor: additive-synth spectrum with timbre frames ------------
// Edits a CDP `newsynth` SPECTRUM string. The string is a list of lines, each
// "time pno level pno level …" — a "timbre frame" (à la the Synclavier): the
// synth interpolates between frames over time. This editor shows ONE frame at a
// time as a multislider (partial 1..N, 0..1), with a keyframe track above to
// add / select / move frames in time. CDP requires every line to carry the same
// partials, so the partial count is shared across all frames. A ⌨ toggle drops
// to the raw list for the cases bars can't show (inharmonic ratios, -ve phase).
export function makePartialsEditor({ get, set, label = '', onChange = () => {}, max = 32, dur = () => 2, playback = null }) {
  const round3 = (v) => +(+v).toFixed(3);
  const numT = (v) => (Number.isInteger(v) ? String(v) : round3(v));

  // Parse into { count, frames:[{time, levels[count]}] } or null when the list
  // isn't representable as 0..1 integer-harmonic bars (→ stay in list mode).
  function parseFrames(text) {
    const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return null;
    const raw = []; let maxP = 0;
    for (const ln of lines) {
      const t = ln.split(/\s+/).map(Number);
      if (t.length < 3 || (t.length - 1) % 2 !== 0 || !t.every(Number.isFinite)) return null;
      const m = new Map(); let prevPno = 0;
      for (let i = 1; i < t.length; i += 2) {
        const pno = t[i], lvl = t[i + 1];
        if (!Number.isInteger(pno) || pno < 1 || pno > max || pno <= prevPno) return null;  // inharmonic / unordered → list
        if (lvl < 0 || lvl > 1) return null;                                                // phase-invert / over-unity → list
        prevPno = pno; m.set(pno, lvl); if (pno > maxP) maxP = pno;
      }
      raw.push({ time: t[0], map: m });
    }
    if (Math.abs(raw[0].time) > 1e-6) return null;                                  // first frame must be t=0
    for (let i = 1; i < raw.length; i++) if (raw[i].time <= raw[i - 1].time) return null;  // times strictly increasing
    const count = Math.max(1, maxP);
    return { count, frames: raw.map((f) => ({ time: f.time, levels: Array.from({ length: count }, (_, k) => f.map.get(k + 1) ?? 0) })) };
  }
  // Same partials on every line (CDP requires it); trim partials that are silent
  // in EVERY frame so unused high harmonics never trip newsynth's nyquist check,
  // but always keep partial 1.
  const serialize = () => {
    let N = 1;
    for (const f of frames) for (let k = count; k > N; k--) if ((f.levels[k - 1] || 0) > 0) { N = k; break; }
    return frames.map((f) => {
      const out = [numT(f.time)];
      for (let p = 1; p <= N; p++) out.push(String(p), String(round3(f.levels[p - 1] || 0)));
      return out.join(' ');
    }).join('\n');
  };

  // ---- state ----------------------------------------------------------------
  const init = parseFrames(get());
  let frames = init ? init.frames : [{ time: 0, levels: [1, 0.5, 0.3, 0.15] }];
  let count = Math.min(max, Math.max(init ? init.count : 4, 1));
  let sel = 0;
  const fitLevels = () => frames.forEach((f) => { while (f.levels.length < count) f.levels.push(0); f.levels.length = count; });
  fitLevels();
  const cur = () => frames[sel];
  const maxTime = () => Math.max(dur() || 1, frames[frames.length - 1].time, 0.001);
  // Linearly interpolate a frame's levels at an arbitrary time (for new frames).
  const levelsAt = (t) => {
    if (t <= frames[0].time) return frames[0].levels.slice();
    const last = frames[frames.length - 1];
    if (t >= last.time) return last.levels.slice();
    let i = 1; while (frames[i].time < t) i++;
    const a = frames[i - 1], b = frames[i], u = (t - a.time) / ((b.time - a.time) || 1);
    return a.levels.map((v, k) => round3(v + (b.levels[k] - v) * u));
  };

  // ---- elements -------------------------------------------------------------
  const track = el('div', { class: 'pftrack', title: 'Click to add a timbre frame; drag a marker to move it in time' });
  const playhead = el('i', { class: 'pfplayhead', hidden: true });   // sweeps the track during this node's own playback
  track.appendChild(playhead);
  const cvs = el('canvas', { class: 'pedit', title: 'Drag across the bars to set this frame’s partial levels' });
  const countInput = el('input', { type: 'number', min: 1, max, step: 1, style: 'width:3.5rem', title: 'Number of partials — type a value or use − / +' });
  const frameOut = el('span', { class: 'muted' });
  const less = el('button', { type: 'button', textContent: '–', title: 'Fewer partials' });
  const more = el('button', { type: 'button', textContent: '+', title: 'More partials' });
  const addF = el('button', { type: 'button', textContent: '＋ frame', title: 'Add a timbre frame' });
  const delF = el('button', { type: 'button', textContent: '－ frame', title: 'Delete the selected frame' });
  const textBtn = el('button', { type: 'button', class: 'secondary', textContent: '⌨', title: 'Edit as a partials list' });
  const ta = el('textarea', { rows: 3, spellcheck: false, hidden: true, placeholder: 'time pno level pno level …  (one line per frame)', style: 'width:100%;margin-top:4px;font-family:monospace' });

  // Every edit reserialises into the data string and the (hidden) list textarea.
  const commit = () => { const s = serialize(); set(s); ta.value = s; onChange(); };
  const sync = () => {
    if (document.activeElement !== countInput) countInput.value = count;   // don't fight mid-typing
    frameOut.textContent = `frame ${sel + 1}/${frames.length} @ ${numT(cur().time)}s`;
    delF.disabled = frames.length < 2;
  };

  function drawBars(lvOverride) {
    const dpr = devicePixelRatio || 1, { ink, paper } = themeColors();
    cvs.width = cvs.clientWidth * dpr; cvs.height = cvs.clientHeight * dpr;
    const ctx = cvs.getContext('2d'), w = cvs.width, h = cvs.height;
    if (!w || !h) return;
    ctx.fillStyle = paper; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.18; ctx.fillRect(0, Math.round(h / 2), w, dpr); ctx.globalAlpha = 1;   // half-level guide
    const lv = lvOverride || cur().levels, bw = w / count, gap = Math.max(dpr, Math.round(bw * 0.14));
    for (let i = 0; i < count; i++) {
      const bh = Math.round(clamp(lv[i] || 0, 0, 1) * (h - dpr));
      ctx.fillRect(Math.round(i * bw) + gap, h - bh, Math.max(dpr, Math.round(bw) - gap * 2), bh);
    }
    ctx.fillRect(0, h - dpr, w, dpr);   // baseline
  }
  function drawTrack() {
    track.querySelectorAll('.pfmark').forEach((m) => m.remove());
    const mt = maxTime();
    frames.forEach((f, i) => {
      const m = el('i', { class: 'pfmark' + (i === sel ? ' sel' : '') });
      m.style.left = clamp(f.time / mt, 0, 1) * 100 + '%';
      m.setAttribute('data-tip', `frame ${i + 1} @ ${numT(f.time)}s` + (i ? ' — drag to move, right-click for exact time' : ' — fixed at the start'));
      m.addEventListener('pointerdown', (e) => dragMark(e, i));
      m.addEventListener('contextmenu', (e) => editTime(e, i));
      track.appendChild(m);
    });
  }
  const drawAll = () => { drawTrack(); drawBars(); sync(); };

  // ---- bar painting ---------------------------------------------------------
  function paint(ev) {
    const r = cvs.getBoundingClientRect();
    const i = clamp(Math.floor((ev.clientX - r.left) / r.width * count), 0, count - 1);
    cur().levels[i] = round3(clamp(1 - (ev.clientY - r.top) / r.height, 0, 1));
    drawBars(); commit();
  }
  cvs.addEventListener('pointerdown', (e) => {
    e.preventDefault(); cvs.setPointerCapture(e.pointerId); paint(e);
    const move = (ev) => paint(ev);
    const up = () => { cvs.removeEventListener('pointermove', move); cvs.removeEventListener('pointerup', up); };
    cvs.addEventListener('pointermove', move); cvs.addEventListener('pointerup', up);
  });

  // ---- keyframe track -------------------------------------------------------
  function selectFrame(i) { sel = clamp(i, 0, frames.length - 1); drawAll(); }
  function addFrameAt(t) {
    if (frames.some((f) => Math.abs(f.time - t) < 1e-4)) return;   // no duplicate times
    const fr = { time: round3(t), levels: levelsAt(t) };
    frames.push(fr); frames.sort((a, b) => a.time - b.time);
    sel = frames.indexOf(fr); drawAll(); commit();
  }
  // A marker drag moves its frame in time, clamped between its neighbours (the
  // first frame is pinned at t=0). A click that doesn't move just selects it.
  function dragMark(e, i) {
    e.preventDefault(); e.stopPropagation(); selectFrame(i);
    if (i === 0) return;   // start frame is fixed at 0
    const mt = maxTime();
    const move = (ev) => {
      const r = track.getBoundingClientRect();
      const t = clamp((ev.clientX - r.left) / r.width, 0, 1) * mt;
      const lo = frames[i - 1].time + 1e-3, hi = (frames[i + 1]?.time ?? mt) - 1e-3;
      frames[i].time = round3(clamp(t, lo, Math.max(lo, hi)));
      drawTrack(); sync(); commit();
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  }
  async function editTime(e, i) {
    e.preventDefault();
    if (i === 0) return gemAlert('The first frame is the start of the sound — its time is fixed at 0.');
    selectFrame(i);
    const res = await gemPrompt(`Frame ${i + 1} time <span style="opacity:.6">(seconds)</span>`, numT(frames[i].time), { ok: 'Set' });
    if (res == null || res === '') return;
    const v = Number(res); if (!Number.isFinite(v)) return;
    const lo = frames[i - 1].time + 1e-3, hi = (frames[i + 1]?.time ?? Infinity) - 1e-3;
    frames[i].time = round3(clamp(v, lo, Math.max(lo, hi))); drawAll(); commit();
  }
  track.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.pfmark')) return;
    const r = track.getBoundingClientRect();
    const t = clamp((e.clientX - r.left) / r.width, 0, 1) * maxTime();
    if (t > 1e-3) addFrameAt(t);   // clicking empty track adds a frame (t=0 is reserved for the start)
  });

  // ---- buttons --------------------------------------------------------------
  less.onclick = () => { if (count > 1) { count--; fitLevels(); drawAll(); commit(); } };
  more.onclick = () => { if (count < max) { count++; fitLevels(); drawAll(); commit(); } };
  addF.onclick = () => {
    const next = frames[sel + 1];
    addFrameAt(next ? (cur().time + next.time) / 2 : Math.min(maxTime(), cur().time + (dur() || 2) * 0.25) || cur().time + 0.25);
  };
  delF.onclick = () => {
    if (frames.length < 2) return;
    frames.splice(sel, 1); if (sel >= frames.length) sel = frames.length - 1;
    frames[0].time = 0;   // whatever remains, the earliest frame anchors the start
    drawAll(); commit();
  };

  // ---- list (text) toggle ---------------------------------------------------
  // The track + bars + controls travel as a unit so the toggle shows/hides them
  // together; the ⌨ button stays put. (Canvas is hidden via style.display since
  // the global `canvas{display:block}` rule overrides the [hidden] attribute.)
  countInput.onchange = () => { count = clamp(Math.round(Number(countInput.value) || 1), 1, max); fitLevels(); drawAll(); commit(); };
  const partCtl = el('span', { style: 'display:flex;align-items:center;gap:6px' }, less, more, countInput, el('span', { class: 'muted', textContent: 'partials' }));
  const frameCtl = el('div', { style: 'display:flex;align-items:center;gap:6px;margin-top:4px' }, addF, delF, frameOut);
  const barsView = el('div', {}, track, cvs,
    el('div', { style: 'display:flex;align-items:center;gap:6px;margin-top:4px' }, partCtl), frameCtl);
  let textMode = false;
  const showText = () => { textMode = true; ta.value = get() || ''; barsView.style.display = 'none'; ta.hidden = false; textBtn.classList.add('on'); textBtn.title = 'Back to the editor'; };
  const showBars = () => { textMode = false; barsView.style.display = ''; ta.hidden = true; textBtn.classList.remove('on'); textBtn.title = 'Edit as a partials list'; requestAnimationFrame(drawAll); };
  textBtn.onclick = () => {
    if (!textMode) return showText();
    const parsed = parseFrames(ta.value);
    if (!parsed) { gemAlert('This spectrum has inharmonic partials or phase inversions the bars can’t show — keep editing it as a list.'); return; }
    frames = parsed.frames; count = Math.min(max, Math.max(parsed.count, 1)); sel = 0; fitLevels();
    showBars();
  };
  ta.oninput = () => { set(ta.value); onChange(); };

  const wrap = el('div', {},
    label ? el('div', { class: 'muted', style: 'font-size:13px;margin-top:6px', textContent: label }) : null,
    barsView,
    el('div', { style: 'display:flex;margin-top:4px' }, el('span', { style: 'flex:1' }), textBtn),
    ta);

  // ---- live preview: while THIS node's own audio plays, sweep a playhead down
  // the track and morph the bars to the interpolated spectrum at the play time.
  // Read-only — reverts to the selected frame when playback stops.
  let animRaf = 0, animating = false;
  function stopAnim() { if (animRaf) cancelAnimationFrame(animRaf); animRaf = 0; if (animating) { animating = false; playhead.hidden = true; drawAll(); } }
  function animTick() {
    const p = playback && playback.progress();
    if (p == null || textMode) { stopAnim(); return; }
    if (!animating) { animating = true; track.appendChild(playhead); }   // bring playhead in front of the markers
    drawBars(levelsAt(clamp(p, 0, 1) * (dur() || 1)));
    playhead.hidden = false; playhead.style.left = clamp(p, 0, 1) * 100 + '%';
    animRaf = requestAnimationFrame(animTick);
  }
  const unsub = playback && playback.subscribe ? playback.subscribe(() => { if (!animRaf) animRaf = requestAnimationFrame(animTick); }) : null;

  // Re-read the data string and rebuild the bars/frames (e.g. after an external
  // import writes n.data). When representable, commit() rewrites n.data in the
  // canonical form — partials 1..N on every line, partial 1 first — which is what
  // newsynth requires (raw imported data may start at partial 2 or vary per line).
  const reload = () => {
    const p = parseFrames(get());
    if (p) { frames = p.frames; count = Math.min(max, Math.max(p.count, 1)); sel = 0; fitLevels(); showBars(); commit(); }
    else { showText(); ta.value = get() || ''; }
  };

  ta.value = get() || '';                                               // keep the (hidden) list current from the start
  if (parseFrames(get()) == null && (get() || '').trim()) showText();   // unrepresentable data opens as the list
  requestAnimationFrame(drawAll);                                        // canvas/track have no size until laid out
  return { el: wrap, refresh: drawAll, reload, dispose: () => { stopAnim(); unsub && unsub(); } };
}

export { ENVELOPE_PARAMS };
