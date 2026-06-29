// UI colour schemes for the CDP patcher. A theme is a set of CSS custom-property
// overrides applied to <html>; almost the entire UI already draws from these
// variables, so switching one restyles everything. The canvases (mini scopes +
// the waveform editor) read --ink / --paper back via themeColors().
//
// Variables a theme sets:
//   --ink      foreground (text, lines, waveform)
//   --paper    window / panel background
//   --desk     desktop background behind the windows
//   --line     border / frame colour
//   --shadow   hard drop-shadow colour
//   --backdrop modal dialog backdrop (rgba)

export const THEMES = {
  gem:   { label: 'GEM (mono)',     dark: false, vars: { '--ink': '#000000', '--paper': '#ffffff', '--desk': '#00aa00', '--line': '#000000', '--shadow': '#000000', '--backdrop': 'rgba(0,80,0,.55)' } },
  green: { label: 'Green terminal', dark: true,  vars: { '--ink': '#34ff6a', '--paper': '#02160b', '--desk': '#010c05', '--line': '#27c451', '--shadow': '#0a361b', '--backdrop': 'rgba(0,25,5,.6)' } },
  amber: { label: 'Amber terminal', dark: true,  vars: { '--ink': '#ffb22e', '--paper': '#190f00', '--desk': '#0c0700', '--line': '#cf8c18', '--shadow': '#4a3208', '--backdrop': 'rgba(25,12,0,.6)' } },
  mono:  { label: 'Mono (CRT)',     dark: true,  vars: { '--ink': '#e8e8e8', '--paper': '#050505', '--desk': '#121212', '--line': '#c0c0c0', '--shadow': '#2a2a2a', '--backdrop': 'rgba(0,0,0,.6)' } },
  c64:   { label: 'C64',            dark: true,  vars: { '--ink': '#b1a7ff', '--paper': '#4034a8', '--desk': '#2c2382', '--line': '#b1a7ff', '--shadow': '#241c63', '--backdrop': 'rgba(20,10,60,.6)' } },
};

const KEY = 'cdp-web-theme';

export function applyTheme(name) {
  const t = THEMES[name] || THEMES.gem;
  const r = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) r.style.setProperty(k, v);
  r.style.colorScheme = t.dark ? 'dark' : 'light';   // native control rendering
  r.dataset.theme = name;
  try { localStorage.setItem(KEY, name); } catch { /* storage disabled */ }
  window.dispatchEvent(new CustomEvent('themechange', { detail: name }));
  return name;
}

export const currentTheme = () => document.documentElement.dataset.theme || 'gem';

// Resolved foreground/background for canvas drawing (hex strings).
export function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  return {
    ink: cs.getPropertyValue('--ink').trim() || '#000',
    paper: cs.getPropertyValue('--paper').trim() || '#fff',
  };
}

export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* ignore */ }
  return applyTheme(saved && THEMES[saved] ? saved : 'gem');
}

// ---- UI font ----------------------------------------------------------------
// The whole UI draws its text through the --ui custom property, so switching it
// restyles everything at once (like a theme). AtariST is the retro default; the
// alternatives are system font stacks (no download) for better readability.
export const FONTS = {
  atari: { label: 'Atari ST (retro)', stack: "'AtariST', 'VT323', monospace" },
  sans:  { label: 'Modern sans',      stack: "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  mono:  { label: 'Modern mono',      stack: "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, 'Liberation Mono', monospace" },
};

const FONT_KEY = 'cdp-web-font';

export function applyFont(name) {
  const f = FONTS[name] || FONTS.atari;
  document.documentElement.style.setProperty('--ui', f.stack);
  document.documentElement.dataset.font = name;
  try { localStorage.setItem(FONT_KEY, name); } catch { /* storage disabled */ }
  window.dispatchEvent(new CustomEvent('fontchange', { detail: name }));
  return name;
}

export const currentFont = () => document.documentElement.dataset.font || 'atari';

export function initFont() {
  let saved = null;
  try { saved = localStorage.getItem(FONT_KEY); } catch { /* ignore */ }
  return applyFont(saved && FONTS[saved] ? saved : 'atari');
}
