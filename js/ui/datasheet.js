// Shared datasheet rendering (editor, phone previews, play mode).

import { html, richText } from './html.js';

const WEAPON_ICONS = { 'Ranged Weapons': 'bi-crosshair', 'Melee Weapons': 'bi-shield-slash' };

export function formatKeywords(text) {
  if (!text || text === '-') return html`<span class="opacity-50">-</span>`;
  return text.split(',').map((kw) => html`<span class="badge bg-dark border text-info me-1" style="font-size:0.75rem;">${kw.trim()}</span>`);
}

const qty = (p) => html`<span class="badge bg-primary rounded-pill ms-1 qty">×${p.count}</span>`;

/**
 * Datasheet markup from RosterEngine.describe() output.
 * @param {{profiles:object[], rules:object[], keywords:string[]}} d
 * @param {{divider?: boolean, counts?: boolean}} [opts] counts: show equipped quantities (×N)
 */
export function datasheetHtml(d, { divider = false, counts = false } = {}) {
  if (!d.profiles.length && !d.rules.length) return '';
  const byType = new Map();
  for (const p of d.profiles) {
    if (!byType.has(p.typeName)) byType.set(p.typeName, []);
    byType.get(p.typeName).push(p);
  }
  const sections = [];
  const unitProfiles = byType.get('Unit') || [];
  if (unitProfiles.length) {
    sections.push(html`<div class="mb-4">
      <h6 class="fw-bold text-primary mb-2"><i class="bi bi-bar-chart-fill me-1"></i>Characteristics</h6>
      ${unitProfiles.map((p) => html`
        ${unitProfiles.length > 1 ? html`<div class="small fw-semibold mb-1">${p.name}${counts && p.count > 1 ? qty(p) : ''}</div>` : ''}
        <div class="d-flex flex-wrap gap-2 justify-content-between mb-2">
          ${p.characteristics.map((c) => html`<div class="stat-box flex-fill"><span class="stat-label">${c.name}</span><span class="stat-value">${c.value || '-'}</span></div>`)}
        </div>`)}
    </div>`);
  }
  const abilities = [];
  for (const [type, list] of byType) {
    if (type === 'Unit') continue;
    const cols = list[0].characteristics.map((c) => c.name);
    if (cols.length <= 1) { abilities.push(...list); continue; }
    const centered = (c) => !/keywords|description/i.test(c);
    sections.push(html`<div class="mb-4">
      <h6 class="fw-bold text-primary mb-2"><i class="bi ${WEAPON_ICONS[type] || 'bi-table'} me-1"></i>${type}</h6>
      <div class="table-responsive">
        <table class="table table-dark table-hover table-striped table-bordered weapon-table align-middle mb-0">
          <thead><tr class="table-primary"><th scope="col">Name</th>${cols.map((c) => html`<th scope="col" class="${centered(c) ? 'text-center' : ''}">${c}</th>`)}</tr></thead>
          <tbody>${list.map((p) => html`<tr><td class="fw-semibold">${p.name}${counts ? qty(p) : ''}</td>${cols.map((c) => {
            const v = (p.characteristics.find((x) => x.name === c) || {}).value || '';
            if (/keywords/i.test(c)) return html`<td>${formatKeywords(v)}</td>`;
            return html`<td class="${centered(c) ? 'text-center' : ''}">${richText(v)}</td>`;
          })}</tr>`)}</tbody>
        </table>
      </div>
    </div>`);
  }
  if (abilities.length) {
    sections.push(html`<div class="mb-4">
      <h6 class="fw-bold text-primary mb-2"><i class="bi bi-lightning-charge me-1"></i>Abilities</h6>
      ${abilities.map((p) => html`<div class="mb-2">
        <span class="fw-bold"><i class="bi bi-star-fill me-1 text-warning"></i>${p.name}</span>
        <div class="small opacity-75">${richText(p.characteristics[0] ? p.characteristics[0].value : '')}</div>
      </div>`)}
    </div>`);
  }
  if (d.rules.length) {
    sections.push(html`<div class="mb-4">
      <h6 class="fw-bold text-primary mb-2"><i class="bi bi-book me-1"></i>Rules</h6>
      ${d.rules.map((r) => html`<details class="rule mb-1"><summary>${r.name}</summary><div>${r.description ? richText(r.description) : html`<em>No description in data.</em>`}</div></details>`)}
    </div>`);
  }
  if (d.keywords.length) {
    const faction = d.keywords.filter((k) => /^Faction:/i.test(k));
    const other = d.keywords.filter((k) => !/^Faction:/i.test(k));
    sections.push(html`<div>
      <h6 class="fw-bold text-primary mb-2"><i class="bi bi-tags me-1"></i>Keywords</h6>
      <div class="d-flex flex-wrap gap-2">
        ${other.map((k) => html`<span class="badge bg-dark border text-light p-2">${k}</span>`)}
        ${faction.map((k) => html`<span class="badge bg-primary p-2">${k.replace(/^Faction:\s*/i, '')}</span>`)}
      </div>
    </div>`);
  }
  return html`${divider ? html`<hr class="my-4">` : ''}${sections}`;
}
