// Minimal Popover API shim for WebViews that lack it. WKWebView gates newer
// web features on the SDK the *host app* was linked against, so the same
// system WebKit that runs the full Popover API in Safari / the standalone app
// reports no support inside plugin hosts built against old SDKs (REAPER).
// The GEM UI uses popovers for menus, tooltips, dialogs, quick-add and the
// about box, so without this they all render as permanently-visible blocks.
//
// Scope: exactly what this app uses — show/hide/togglePopover, the
// beforetoggle/toggle events (with oldState/newState), the
// popoverTargetElement invoker property, light-dismiss + Escape for
// popover="auto", and matches(':popover-open'). The paired CSS lives in
// index.html under `html.no-popover`, and a <head> script stamps that class
// before first paint so static popover markup never flashes.

const OPEN = '__po-open';

export function installPopoverFallback() {
  if ('popover' in HTMLElement.prototype) return;
  document.documentElement.classList.add('no-popover');

  const autos = new Set(); // open popover="auto" elements, for light dismiss
  const isOpen = (el) => el.classList.contains(OPEN);
  const fire = (el, type, oldState, newState) => {
    const e = new Event(type, { cancelable: type === 'beforetoggle' });
    e.oldState = oldState; e.newState = newState;
    return el.dispatchEvent(e);
  };
  const show = (el) => {
    if (isOpen(el)) return;
    if (!fire(el, 'beforetoggle', 'closed', 'open')) return;
    if (el.getAttribute('popover') !== 'manual') {
      for (const o of [...autos]) if (!o.contains(el) && !el.contains(o)) hide(o);
      autos.add(el);
    }
    el.classList.add(OPEN);
    fire(el, 'toggle', 'closed', 'open');
  };
  const hide = (el) => {
    if (!isOpen(el)) return;
    fire(el, 'beforetoggle', 'open', 'closed');
    el.classList.remove(OPEN);
    autos.delete(el);
    fire(el, 'toggle', 'open', 'closed');
  };

  HTMLElement.prototype.showPopover = function () { show(this); };
  HTMLElement.prototype.hidePopover = function () { hide(this); };
  HTMLElement.prototype.togglePopover = function (force) {
    const want = force !== undefined ? !!force : !isOpen(this);
    (want ? show : hide)(this);
    return want;
  };
  // Invoker wiring: only the property form ui.js uses (not the popovertarget=
  // attribute, which nothing here sets). On HTMLElement rather than
  // HTMLButtonElement so non-button invokers work too.
  Object.defineProperty(HTMLElement.prototype, 'popoverTargetElement', {
    configurable: true,
    get() { return this.__poTarget || null; },
    set(target) {
      this.__poTarget = target;
      if (target) target.__poInvoker = this;
      if (!this.__poWired) {
        this.__poWired = true;
        this.addEventListener('click', () => this.__poTarget && this.__poTarget.togglePopover());
      }
    },
  });
  // Light dismiss for popover="auto": a press outside closes; a press on the
  // invoker is left to its click toggle (or it would close-then-reopen).
  document.addEventListener('pointerdown', (e) => {
    for (const o of [...autos]) {
      if (!o.contains(e.target) && !(o.__poInvoker && o.__poInvoker.contains(e.target))) hide(o);
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') for (const o of [...autos]) hide(o);
  }, true);
  // matches(':popover-open') throws as an unknown selector here; map it to the class.
  const origMatches = Element.prototype.matches;
  Element.prototype.matches = function (sel) {
    if (typeof sel === 'string' && sel.includes(':popover-open')) sel = sel.split(':popover-open').join('.' + OPEN);
    return origMatches.call(this, sel);
  };
}
