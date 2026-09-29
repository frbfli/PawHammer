// Share codes: a roster (RosterEngine.toShare()) compressed into a short URL-safe string, carried
// in a link (…/#/share/<code>) and shown as a QR code. Nothing is uploaded anywhere.

/** Public site used in share links when running locally (other devices can't reach localhost). */
export const PUBLIC_URL = 'https://frbfli.github.io/PawHammer/';

const QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
const SCAN_LIB = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';

const toB64Url = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64Url = (str) => {
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/**
 * Encode a share payload. "z…" = deflate-compressed JSON, "j…" = plain JSON (older browsers
 * without CompressionStream).
 */
export async function encodeShare(payload) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  if (typeof CompressionStream === 'function') {
    return 'z' + toB64Url(await pipe(json, new CompressionStream('deflate-raw')));
  }
  return 'j' + toB64Url(json);
}

export async function decodeShare(code) {
  const c = String(code || '').trim();
  const body = c.slice(1);
  let bytes;
  try {
    bytes = fromB64Url(body);
  } catch {
    throw new Error("That doesn't look like a PawHammer share code.");
  }
  if (c[0] === 'z') {
    if (typeof DecompressionStream !== 'function') throw new Error('This browser is too old to open share codes. Try a current Chrome, Edge, Safari or Firefox.');
    try { bytes = await pipe(bytes, new DecompressionStream('deflate-raw')); } catch { throw new Error('This share code is incomplete or damaged.'); }
  } else if (c[0] !== 'j') {
    throw new Error("That doesn't look like a PawHammer share code.");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('This share code is incomplete or damaged.');
  }
}

/** Pull the code out of a pasted/scanned link ("…#/share/<code>") or a bare code. */
export function extractShareCode(text) {
  const s = String(text || '').trim();
  const m = /#\/share\/([A-Za-z0-9_-]+)/.exec(s);
  if (m) return m[1];
  return /^[zj][A-Za-z0-9_-]{8,}$/.test(s) ? s : null;
}

export function shareLink(code) {
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname) || location.protocol === 'file:';
  const base = local ? PUBLIC_URL : location.origin + location.pathname;
  return `${base}#/share/${code}`;
}

// ---- libraries (loaded only when needed)

const loaded = new Map();
function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => { loaded.delete(src); reject(new Error('Could not load the QR code library (are you offline?).')); };
      document.head.appendChild(s);
    }));
  }
  return loaded.get(src);
}

/** SVG markup for a QR code of `text` (dark modules on a white background). */
export async function qrSvg(text) {
  await loadScript(QR_LIB);
  const qr = window.qrcode(0, 'M'); // 0 = smallest version that fits
  qr.addData(text, 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
}

/** Decode a QR code from a video frame; uses the browser's BarcodeDetector when available. */
export async function qrScanner() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (video) => {
          const codes = await detector.detect(video);
          return codes.length ? codes[0].rawValue : null;
        };
      }
    } catch { /* fall back to jsQR */ }
  }
  await loadScript(SCAN_LIB);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    if (!video.videoWidth) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hit = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return hit ? hit.data : null;
  };
}
