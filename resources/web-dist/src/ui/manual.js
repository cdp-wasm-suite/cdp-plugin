// Browsable CDP manual, opened from Help ▸ Manual.
//
// Content is ./manual.json (built by scripts/build-manual.mjs from the cdp-wasm
// docs archive): a nav tree plus one pre-rendered HTML page per topic. Internal
// links were resolved to data-page / data-anchor attributes at build time, so
// navigation here is just reading those — no markdown parser, no path juggling.
// The overlay markup + styles live in index.html (#manualBox / .manual-*).

let data = null;          // parsed manual.json (loaded once)
let wired = false;        // page/back/close listeners installed once
let current = null;       // { slug, anchor } currently shown
let history = [];         // back stack of { slug, anchor }

const $ = (id) => document.getElementById(id);
const box = () => $('manualBox');

async function ensureLoaded() {
  if (data) return;
  const res = await fetch('./manual.json');
  if (!res.ok) throw new Error('manual.json ' + res.status);
  data = await res.json();
  buildNav();
  wire();
}

function buildNav() {
  const nav = $('manualNav');
  nav.textContent = '';
  for (const sec of data.nav) {
    if (sec.title) {
      const h = document.createElement('div');
      h.className = 'sec';
      h.textContent = sec.title;
      nav.appendChild(h);
    }
    for (const p of sec.pages) {
      const a = document.createElement('a');
      a.textContent = p.label;
      a.dataset.slug = p.slug;
      a.addEventListener('click', (e) => { e.preventDefault(); navigate(p.slug); });
      nav.appendChild(a);
    }
  }
}

function wire() {
  if (wired) return;
  wired = true;
  $('manualClose').addEventListener('click', () => box().hidePopover());
  $('manualBack').addEventListener('click', back);
  // Delegate in-manual link clicks. Build-time links carry data-page (jump to
  // another topic) and/or data-anchor (a heading on the target page); external
  // links keep a real href + target=_blank and fall through to the browser.
  $('manualPage').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a || !$('manualPage').contains(a)) return;
    if (a.dataset.page) { e.preventDefault(); navigate(a.dataset.page, a.dataset.anchor || null); }
    else if (a.dataset.anchor) { e.preventDefault(); scrollToAnchor(a.dataset.anchor); }
  });
}

function scrollToAnchor(anchor) {
  const page = $('manualPage');
  const el = page.querySelector('#' + CSS.escape(anchor));
  if (el) el.scrollIntoView({ block: 'start' });
  else page.scrollTop = 0;
}

function render(slug, anchor) {
  const p = data.pages[slug];
  if (!p) return;
  current = { slug, anchor: anchor || null };
  $('manualPage').innerHTML = p.html;
  $('manualHeading').textContent = p.title || 'Manual';
  for (const a of $('manualNav').querySelectorAll('a')) a.classList.toggle('current', a.dataset.slug === slug);
  if (anchor) scrollToAnchor(anchor); else $('manualPage').scrollTop = 0;
  $('manualBack').disabled = history.length === 0;
}

function navigate(slug, anchor) {
  if (!data || !data.pages[slug]) return;
  if (current) history.push(current);
  render(slug, anchor);
}

function back() {
  const prev = history.pop();
  if (prev) render(prev.slug, prev.anchor);
}

// Open the manual, optionally at a given page slug (defaults to the home page).
// Safe to call repeatedly; the JSON is fetched only once.
export async function openManual(slug) {
  try {
    await ensureLoaded();
  } catch (e) {
    $('manualHeading').textContent = 'Manual';
    $('manualPage').innerHTML = '<p>Could not load the manual (' + e.message + ').</p>'
      + '<p>Run <code>npm run docs:manual</code> to generate <code>manual.json</code>.</p>';
  }
  history = [];
  current = null;
  if (data) render(slug || data.home, null);
  if (!box().matches(':popover-open')) box().showPopover();
}
