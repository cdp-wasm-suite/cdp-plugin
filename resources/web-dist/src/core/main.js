// Entry point for the CDP modular patcher. Creates the CDP instance and the
// audio context, then hands them to the patcher (which builds the GEM desktop,
// windows, cables and menus). All UI lives in patcher.js / ui.js; the run engine
// in graph.js. The engine comes from the @olilarkin/cdp-wasm package (resolved
// by the import map in index.html).
import { CDP } from '@olilarkin/cdp-wasm';
import { log } from '../ui/ui.js';
import { startPatcher } from './patcher.js';
import { initTheme, initFont } from '../ui/themes.js';
import { createSampler } from '../dsp/sampler.js';
import { initHostBridge } from './host-bridge.js';

initTheme(); // restore the saved colour scheme before the UI builds
initFont();  // …and the saved UI font

const cdp = new CDP(); // the package resolves its own .wasm assets (relative to its src/)
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// The polyphonic sampler keyboard plays the most recently rendered buffer as a
// pitched instrument. It auto-detects its DSP path: inside the native plugin host
// (IPlugSendMsg present) notes are forwarded as MIDI to the C++ engine, while in
// a plain browser the DSP runs locally via Web Audio.
const sampler = createSampler(audioCtx);

// Product name + version readout, shown in the About box (#aboutVersion) and,
// when present, a menu-bar cell (#appVersion). The embedding host can override
// the name — "CDP for Live" from the Ableton extension, "CDP" from the plugin —
// three ways: define window.CDP_APP_NAME before this module runs, pass an
// ?appName= query parameter, or call window.CDPSetAppName(name) any time after
// load (for hosts that can only inject JS once the page is up, like the plugin
// webview). Plain browser default: "CDP for Web".
//
// Version single source of truth: the "version" field in package.json. Bump it
// with `npm version <patch|minor|major>`. It ships to every build (dev serves
// the file; bundle.mjs writes a slim copy; build-site.mjs copies it) and is
// fetched here at runtime — hosts that don't serve it just get the bare name.
{
  let appName = window.CDP_APP_NAME
    || new URLSearchParams(location.search).get('appName')
    || 'CDP for Web';
  let version = '';
  const menuEl = document.getElementById('appVersion');
  const aboutEl = document.getElementById('aboutVersion');
  const render = () => {
    // Expose for the Help ▸ Report a bug… menu, which pre-fills the version into
    // the GitHub issue form (patcher.js). Empty until package.json resolves.
    window.CDP_VERSION = version;
    if (menuEl) {
      menuEl.textContent = appName + (version ? ' v' + version : '');
      menuEl.title = appName + ' version';
    }
    if (aboutEl) aboutEl.textContent = version ? 'Version ' + version : '';
  };
  render();
  fetch('./package.json').then((r) => r.json()).then((p) => {
    if (p.version) { version = p.version; render(); }
  }).catch(() => {});
  window.CDPSetAppName = (name) => { appName = name; render(); };
}

// Never fail silently — surface async errors in the Log window.
addEventListener('unhandledrejection', (e) => log('error: ' + (e.reason?.message || e.reason)));

startPatcher(cdp, audioCtx, sampler);

// Activate the host-integration bridge when embedded (e.g. inside the Ableton
// Live extension). No-op in normal browser use.
initHostBridge();
