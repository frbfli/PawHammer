// Yellowscribe (https://yellowscribe.link) turns a BattleScribe roster into a code for its
// Tabletop Simulator mod. Its server does not send CORS headers, so browsers can only read
// the code when the request goes through a CORS proxy (configurable in Data Source settings).

export const YELLOWSCRIBE_URL = 'https://yellowscribe.link/';
const ENDPOINT = 'https://yellowscribe.link/makeArmyAndReturnCode?filename=roster.ros';

/** Default proxy: Corsfix (free; localhost works as-is, a live site's domain must be registered). */
export const DEFAULT_YS_PROXY = 'https://proxy.corsfix.com/?{url}';

/** Build the proxied URL. `{url}` is replaced raw, `{encodedUrl}` URL-encoded; otherwise appended. */
export function proxiedUrl(template, target = ENDPOINT) {
  const t = (template || '').trim();
  if (!t) return target;
  if (t.includes('{encodedUrl}')) return t.replace('{encodedUrl}', encodeURIComponent(target));
  if (t.includes('{url}')) return t.replace('{url}', target);
  return t + target;
}

/**
 * Upload a roster (.ros XML) to Yellowscribe and return its code.
 * @param {string} rosXml
 * @param {string} proxyTemplate
 * @returns {Promise<string>}
 */
export async function getYellowscribeCode(rosXml, proxyTemplate) {
  if (!(proxyTemplate || '').trim()) {
    throw new Error('No CORS proxy is set up for Yellowscribe (see Data Source settings).');
  }
  let res;
  try {
    // text/plain keeps this a "simple" request (no CORS preflight, which Yellowscribe can't answer).
    res = await fetch(proxiedUrl(proxyTemplate), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: rosXml });
  } catch (err) {
    throw new Error('Could not reach Yellowscribe through the proxy (network or CORS error).');
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (body && body.code) return body.code;
  if (body && body.corsfix_error === 'domain_not_registered') {
    throw new Error(`The Corsfix proxy doesn't allow this website yet. Register ${location.hostname} at corsfix.com (free) and try again.`);
  }
  const detail = body && (body.message || body.err) ? String(body.message || body.err).replace(/<[^>]+>/g, ' ').trim() : `HTTP ${res.status}`;
  throw new Error(`Yellowscribe did not return a code: ${detail}`);
}
