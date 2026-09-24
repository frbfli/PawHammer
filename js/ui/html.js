// Minimal templating: `html` escapes interpolated values unless wrapped with raw().

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(s);

function render(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Raw(out);
}

/** Format BSData rule text: **bold**, ^^keyword^^, line breaks. */
export function richText(text) {
  let s = escapeHtml(text || '');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\^\^(.+?)\^\^/g, '<span class="kw">$1</span>');
  s = s.replace(/(^|\s)\*(\S.*?\S|\S)\*(?=\s|$|[.,;:])/g, '$1<em>$2</em>');
  s = s.replace(/\r?\n/g, '<br>');
  return raw(s);
}

/**
 * Action registry: handlers are registered while rendering and invoked through
 * delegated DOM events via `data-act` attributes.
 */
export class Actions {
  constructor() { this.map = new Map(); this.seq = 0; }
  clear() { this.map.clear(); }
  add(fn) { const id = 'a' + (++this.seq); this.map.set(id, fn); return id; }
  bind(root) {
    const dispatch = (type) => (ev) => {
      const el = ev.target.closest('[data-act]');
      if (!el || !root.contains(el)) return;
      const on = el.dataset.on || (el.matches('input,select,textarea') ? 'change' : 'click');
      if (on !== type) return;
      const fn = this.map.get(el.dataset.act);
      if (fn) {
        if (type === 'click' && el.tagName !== 'INPUT') ev.preventDefault();
        fn(ev, el);
      }
    };
    // Enter/Space activates focusable non-button elements with actions (e.g. list rows).
    const onKey = (ev) => {
      const el = ev.target;
      if ((ev.key === 'Enter' || ev.key === ' ') && el.matches('[data-act][tabindex]') && !el.matches('input,select,textarea,button')) {
        ev.preventDefault();
        el.click();
      }
    };
    const handlers = ['click', 'change', 'input', 'keydown'].map((t) => [t, dispatch(t)]);
    handlers.push(['keydown', onKey]);
    for (const [t, h] of handlers) root.addEventListener(t, h);
    /** Remove the listeners (call when the view is torn down). */
    return () => { for (const [t, h] of handlers) root.removeEventListener(t, h); };
  }
}

export const fmtPts = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString();
