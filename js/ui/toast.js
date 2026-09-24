import { html } from './html.js';

export function toast(message, variant = 'success') {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast align-items-center text-bg-${variant} border-0`;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = String(html`<div class="d-flex"><div class="toast-body">${message}</div>
    <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button></div>`);
  host.appendChild(el);
  // Keep at most three toasts on screen.
  while (host.children.length > 3) host.firstElementChild.remove();
  const t = bootstrap.Toast.getOrCreateInstance(el, { delay: 2000 });
  el.addEventListener('hidden.bs.toast', () => el.remove());
  t.show();
}

export function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
