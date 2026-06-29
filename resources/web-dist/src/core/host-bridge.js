// Host-integration bridge for embedding cdp-web inside a native WebView host
// — any DAW that hosts the dialog this way (the Ableton Live "CDP" extension is
// the first, but nothing here is Live-specific). Completely inert in normal
// browser use: it only activates when the launching host passes a session config
// in the URL hash as `#cdpHost=<base64 JSON>`. (The native VST plugin embeds
// cdp-web too, but via a different native bridge — IPlugSendMsg; see below.)
//
// Session config shape (produced by the host):
//   { sourceUrl?, uploadUrl, logUrl, name, sampleRate, applyLabel? }
//
// Flow:
//   1. Fetch sourceUrl (if present) → drop it in as a Source node via
//      window.__cdpHost.setSource(wav, name).
//   2. Slot an "apply" button (label from session.applyLabel, e.g. "Apply → Live")
//      into each Output node's footer (via window.__cdpHost.registerOutputAction),
//      in place of the drag button that only works in the plugin. On click: ensure
//      the Output has rendered, POST the resulting WAV to uploadUrl, then close the
//      modal by posting `close_and_send` to the host's WebView message handler.
//
// The native message bridge (webkit.messageHandlers.live / chrome.webview — the
// `.live` handler name is the fixed protocol the host registers) only exists
// inside the host's WebView; in a plain browser we fall back to a file download
// so the page still works if a hash is set manually for testing.

function parseSession() {
  const m = /(?:^|[#&])cdpHost=([^&]+)/.exec(location.hash || '');
  if (!m) return null;
  try {
    // atob yields a Latin-1 byte string; decode those bytes as UTF-8 so non-ASCII
    // fields (e.g. the "→" in applyLabel, or accented track names) survive.
    const bin = atob(decodeURIComponent(m[1]));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    console.error('[host-bridge] bad cdpHost hash:', e);
    return null;
  }
}

// Read the sample rate straight out of a WAV's fmt chunk. Falls back to null.
function sniffWavSampleRate(bytes) {
  if (!bytes || bytes.length < 44) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ' && size >= 16) return dv.getUint32(off + 8 + 4, true);
    off += 8 + size + (size & 1);
  }
  return null;
}

// Post the result back to the host and close the modal. Returns true if a native
// host bridge was found.
function closeAndSend(resultObj) {
  const bridge =
    (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live) ||
    (window.chrome && window.chrome.webview) ||
    null;
  if (!bridge) return false;
  bridge.postMessage({ method: 'close_and_send', params: [JSON.stringify(resultObj)] });
  return true;
}

// ---- native drag-and-drop of the rendered WAV -------------------------------
// A browser can drag a file out of the page (the HTML5 DownloadURL flavour), but
// that can't cross from a plugin's WebView into the host DAW. Inside the native
// plugin (IPlugSendMsg present) the Output window's "Drag me" button instead asks
// the native side to start a real OS drag-and-drop.
//
// This is only a trigger — no audio is re-sent. The plugin already holds the
// rendered sample: every Run forwards the result to the host DSP sampler as
// planar PCM (see player.js forwardBufferToPlugin → 'SAMFUI'). So on receipt of
// 'SDGFUI' the plugin writes its current sample to a temp WAV (named by the
// message `data`) and begins a native drag session for that file —
// NSDraggingSession on macOS, DoDragDrop on Windows. It fires on the button's
// pointerdown so the drag can begin together with the gesture.
//
// Wire-up (cdp-plugin's OnMessageFromUI): match msg == "SDGFUI", read the filename
// from the message data, and kick off the platform drag.

// True when a native host that can perform an OS drag-out is present.
export function hostSupportsDragOut() {
  return typeof IPlugSendMsg === 'function';
}

// Ask the native plugin host to begin an OS drag of the last rendered sample.
// Returns true if a native host consumed it, false in a plain browser (the caller
// then falls back to the HTML5 DownloadURL drag).
export function beginNativeDragOut(filename = 'cdp-output.wav') {
  if (typeof IPlugSendMsg !== 'function') return false;
  try {
    IPlugSendMsg({ msg: 'SDGFUI', data: filename });
    return true;
  } catch (e) {
    console.error('[host-bridge] native drag-out failed:', e);
    return false;
  }
}

async function waitForHost(timeoutMs = 10000) {
  const start = performance.now();
  while (!window.__cdpHost) {
    if (performance.now() - start > timeoutMs) throw new Error('window.__cdpHost never appeared');
    await new Promise((r) => setTimeout(r, 30));
  }
  return window.__cdpHost;
}

// Build the "apply" button for one Output node. It renders that node if needed,
// POSTs the WAV to the host, then closes the modal. Styled as a regular
// Output-footer button (class 'secondary') so it sits where the Drag button was,
// rather than floating over the UI. The label is host-supplied (session.applyLabel,
// e.g. "Apply → Live") so no single host is baked in; it falls back to "Apply".
function makeApplyButton(session, node) {
  const LABEL = session.applyLabel || 'Apply';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'secondary apply-to-host';
  btn.textContent = LABEL;
  btn.title = 'Render if needed, then send the result back to the host';

  // Briefly flash a transient message on the button, then restore it.
  const flash = (msg, ms = 1600) => {
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = LABEL; btn.disabled = false; }, ms);
  };

  btn.onclick = async () => {
    btn.disabled = true;
    try {
      // Prefer this node's own result so the button applies the Output it's on.
      let wav = node && node.result && !node.stale ? node.result : null;
      if (!wav) {
        btn.textContent = 'Rendering…';
        wav = node && node.run ? await node.run() : await window.__cdpHost.render();
      }
      if (!wav) { flash('Run first'); return; }
      btn.textContent = 'Uploading…';
      await fetch(session.uploadUrl, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: wav,
      });
      const result = { sampleRate: sniffWavSampleRate(wav) || session.sampleRate || 44100 };
      if (!closeAndSend(result)) {
        // No native host (plain browser) — download instead so the page still works.
        const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = (session.name || 'cdp-output') + '.wav';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        flash('Downloaded');
      }
    } catch (e) {
      console.error('[host-bridge] apply failed:', e);
      flash('Apply failed', 2400);
    }
  };
  return btn;
}

// Forward console + errors to the host's log (via logUrl) so failures are visible
// there — a host WebView typically has no devtools (e.g. Live's ExtensionHost.txt).
function installLogForwarder(logUrl) {
  const send = (level, args) => {
    try {
      navigator.sendBeacon
        ? navigator.sendBeacon(logUrl, JSON.stringify({ level, parts: args.map(String) }))
        : fetch(logUrl, {
            method: 'POST',
            body: JSON.stringify({ level, parts: args.map(String) }),
            keepalive: true,
          });
    } catch {
      /* ignore */
    }
  };
  ['warn', 'error'].forEach((level) => {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      send(level, args);
      orig(...args);
    };
  });
  window.addEventListener('error', (e) => send('error', [e.message, e.filename + ':' + e.lineno]));
  window.addEventListener('unhandledrejection', (e) =>
    send('error', ['unhandledrejection', e.reason && e.reason.message ? e.reason.message : e.reason]),
  );
}

export async function initHostBridge() {
  const session = parseSession();
  if (!session) return; // standalone — do nothing
  if (session.logUrl) installLogForwarder(session.logUrl);
  console.log('[host-bridge] embedded session:', session.name);
  try {
    const host = await waitForHost();
    if (session.sourceUrl) {
      const buf = await (await fetch(session.sourceUrl)).arrayBuffer();
      host.setSource(new Uint8Array(buf), session.name || 'Host selection');
      console.log('[host-bridge] source loaded:', buf.byteLength, 'bytes');
    }
    // Slot the Apply button into each Output node's footer (replacing the
    // host-irrelevant Drag button) rather than overlaying it on the UI.
    if (typeof host.registerOutputAction === 'function') {
      host.registerOutputAction((node) => makeApplyButton(session, node));
    } else {
      console.warn('[host-bridge] registerOutputAction missing — is cdp-web up to date?');
    }
  } catch (e) {
    console.error('[host-bridge] init failed:', e);
  }
}
