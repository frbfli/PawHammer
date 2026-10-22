// Shared datasheet rendering (editor, phone previews, play mode).

import { html, richText } from './html.js';

// ---- weapon keyword rules (badge -> modal)

const keywordRules = new Map(); // badge id -> { keyword, rule }
let keywordSeq = 0;

/** The rule a weapon keyword refers to, e.g. "Rapid Fire 1" -> "Rapid Fire", "Anti-Infantry 4+" -> "Anti". */
function ruleForKeyword(keyword, rules) {
  const k = keyword.toLowerCase();
  let best = null;
  for (const r of rules) {
    const n = (r.name || '').toLowerCase().trim();
    if (!n || !k.startsWith(n) || /[a-z]/.test(k.charAt(n.length))) continue;
    if (!best || n.length > best.name.length) best = r;
  }
  return best;
}

function keywordModal() {
  let el = document.getElementById('keywordModal');
  if (!el) {
    el = document.createElement('div');
    el.className = 'modal fade';
    el.id = 'keywordModal';
    el.tabIndex = -1;
    el.setAttribute('aria-labelledby', 'keywordModalLabel');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<div class="modal-dialog modal-dialog-centered modal-dialog-scrollable"><div class="modal-content border">
      <div class="modal-header bg-primary text-white"><div><h5 class="modal-title fw-bold" id="keywordModalLabel"></h5>
        <small class="opacity-75" id="keywordModalSub"></small></div>
        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button></div>
      <div class="modal-body p-4" id="keywordModalBody"></div>
      <div class="modal-footer"><button type="button" class="btn btn-primary" data-bs-dismiss="modal">Close</button></div>
    </div></div>`;
    document.body.appendChild(el);
  }
  return el;
}

function showKeywordRule({ keyword, rule, kind = 'Weapon ability' }) {
  const el = keywordModal();
  el.querySelector('#keywordModalLabel').textContent = keyword;
  el.querySelector('#keywordModalSub').textContent = rule.name.toLowerCase() === keyword.toLowerCase() ? kind : `${kind}: ${rule.name}`;
  el.querySelector('#keywordModalBody').innerHTML = String(rule.description ? html`<p class="mb-0">${richText(rule.description)}</p>` : html`<p class="mb-0 opacity-75">No rules text in the data.</p>`);
  bootstrap.Modal.getOrCreateInstance(el).show();
}

// ---- modified characteristics (asterisk -> explanation)

const statChanges = new Map(); // button id -> { profile, c }
let statSeq = 0;

const splitKw = (v) => String(v || '').split(',').map((k) => k.trim()).filter((k) => k && k !== '-');
const addedKw = (before, after) => { const b = new Set(splitKw(before)); return splitKw(after).filter((k) => !b.has(k)); };
const isKwChar = (c) => /keywords/i.test(c.name);
const isModified = (c) => c && c.changes && c.changes.length && c.value !== c.base;

/** `display` for a characteristic, as a button with an asterisk when abilities or wargear changed it. */
function modValue(profile, c, display, cls = '') {
  if (!isModified(c)) return display;
  if (statChanges.size > 5000) statChanges.clear();
  const id = 'st' + (++statSeq);
  statChanges.set(id, { profile, c });
  return html`<button type="button" class="stat-mod ${cls}" data-stat-mod="${id}" title="${c.name} is modified: show why">${display}<span class="stat-mod-mark" aria-hidden="true">*</span></button>`;
}

function showStatChange({ profile, c }) {
  const el = keywordModal();
  const kw = isKwChar(c);
  el.querySelector('#keywordModalLabel').textContent = `${profile}: ${c.name}`;
  el.querySelector('#keywordModalSub').textContent = 'Modified characteristic';
  const summary = kw
    ? html`<p>Adds <strong>${addedKw(c.base, c.value).join(', ')}</strong></p>`
    : html`<p class="fs-5 mb-3"><span class="opacity-75">${c.base || '-'}</span> <i class="bi bi-arrow-right mx-1"></i> <strong>${c.value || '-'}</strong></p>`;
  // With one change the summary already shows the values; with several, each step shows its own.
  const steps = c.changes.length > 1;
  el.querySelector('#keywordModalBody').innerHTML = String(html`${summary}
    <h6 class="small text-uppercase opacity-75 mb-2">From</h6>
    <ul class="list-unstyled mb-0">${c.changes.map((x) => html`<li class="mb-2">
      <strong>${x.source || 'Modifier'}</strong>
      ${steps ? html`<span class="ms-1">${kw ? `adds ${addedKw(x.before, x.after).join(', ')}` : `${x.before || '-'} → ${x.after || '-'}`}</span>` : ''}
      ${x.requires.length ? html`<div class="small opacity-75">Requires ${x.requires.join(', ')}</div>` : ''}
    </li>`)}</ul>`);
  bootstrap.Modal.getOrCreateInstance(el).show();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (ev) => {
    const stat = ev.target.closest('[data-stat-mod]');
    if (stat) {
      const entry = statChanges.get(stat.dataset.statMod);
      if (entry) { ev.preventDefault(); showStatChange(entry); }
      return;
    }
    const badge = ev.target.closest('[data-kw-rule]');
    if (!badge) return;
    const entry = keywordRules.get(badge.dataset.kwRule);
    if (entry) { ev.preventDefault(); showKeywordRule(entry); }
  });
}

/**
 * Weapon keyword badges. Keywords with a matching rule become buttons that open the rule;
 * matched rules are added to `used` so the datasheet can leave them out of its Rules list.
 */
export function formatKeywords(text, rules = [], used = new Set()) {
  if (!text || text === '-') return html`<span class="opacity-50">-</span>`;
  return text.split(',').map((raw) => raw.trim()).filter(Boolean).map((kw) => {
    const rule = ruleForKeyword(kw, rules);
    if (!rule) return html`<span class="badge bg-dark border text-info me-1" style="font-size:0.75rem;">${kw}</span>`;
    used.add(rule);
    if (keywordRules.size > 5000) keywordRules.clear();
    const id = 'kw' + (++keywordSeq);
    keywordRules.set(id, { keyword: kw, rule });
    return html`<button type="button" class="badge bg-dark border text-info me-1 kw-badge" style="font-size:0.75rem;" data-kw-rule="${id}"
      title="Show the ${rule.name} rule">${kw}</button>`;
  });
}

/** "Leader"/"Support" abilities that just list which units the character can join. */
const isAttachList = (p) => /^(leader|support)$/i.test(p.name.trim()) ||
  /can be attached to the following units/i.test(p.characteristics.map((c) => c.value).join(' '));

const qty = (p) => html`<span class="badge bg-primary rounded-pill ms-1 qty">×${p.count}</span>`;

// Weapon tables come first (ranged, then melee), then any other multi-column profile types.
const TYPE_ORDER = ['Ranged Weapons', 'Melee Weapons'];
const typeRank = (t) => (TYPE_ORDER.includes(t) ? TYPE_ORDER.indexOf(t) : TYPE_ORDER.length);

const profileKey = (p) => p.typeName + '|' + p.name + '|' + p.characteristics.map((c) => c.value).join('|');

function groupByType(profiles) {
  const byType = new Map();
  for (const p of profiles) {
    if (!byType.has(p.typeName)) byType.set(p.typeName, []);
    byType.get(p.typeName).push(p);
  }
  return byType;
}

// ---- section builders

/** Base size is shown as text under the keywords, not as a stat box. */
const isBaseStat = (c) => /^base/i.test(c.name.trim());

/** "Base size" text entries for unit profiles; names are only added when sizes differ. */
function baseSizes(entries) {
  const found = entries.flatMap(({ name, profile }) => profile.characteristics
    .filter((c) => isBaseStat(c) && c.value && c.value !== '-').map((c) => ({ name, value: c.value })));
  const values = [...new Set(found.map((b) => b.value))];
  if (values.length <= 1) return values;
  const seen = new Set();
  return found.filter((b) => !seen.has(b.name + '|' + b.value) && seen.add(b.name + '|' + b.value))
    .map((b) => `${b.name}: ${b.value}`);
}

function statLine(p) {
  const stats = p.characteristics.filter((c) => !isBaseStat(c));
  // Even grid so every characteristic stays on one row, even on phones.
  return html`<div class="stat-line mb-2" style="grid-template-columns: repeat(${stats.length}, minmax(0, 1fr));">
    ${stats.map((c) => html`<div class="stat-box"><span class="stat-label">${c.name}</span><span class="stat-value">${modValue(p.name, c, c.value || '-')}</span></div>`)}
  </div>`;
}

function characteristicsSection(unitProfiles, counts) {
  if (!unitProfiles.length) return '';
  return html`<div class="mb-4">
    <h6 class="fw-bold text-primary mb-2">Characteristics</h6>
    ${unitProfiles.map((p) => html`
      ${unitProfiles.length > 1 ? html`<div class="small fw-semibold mb-1">${p.name}${counts && p.count > 1 ? qty(p) : ''}</div>` : ''}
      ${statLine(p)}`)}
  </div>`;
}

/** One table per weapon/profile type. Profiles may carry `owners` (shown under the name). */
function weaponSections(byType, rules, usedRules, counts) {
  const sections = [];
  const types = [...byType.keys()].filter((t) => t !== 'Unit' && byType.get(t)[0].characteristics.length > 1)
    .sort((a, b) => typeRank(a) - typeRank(b));
  for (const type of types) {
    const list = byType.get(type);
    // Keywords are shown as badges on their own line under each weapon, not as a column.
    const isKw = (c) => /keywords/i.test(c);
    const cols = list[0].characteristics.map((c) => c.name).filter((c) => !isKw(c));
    const centered = (c) => !/description/i.test(c);
    const charOf = (p, c) => p.characteristics.find((x) => x.name === c);
    const valueOf = (p, c) => (charOf(p, c) || {}).value || '';
    const cell = (p, c) => modValue(p.name, charOf(p, c), richText(valueOf(p, c)));
    const kwOf = (p) => p.characteristics.filter((x) => isKw(x.name)).map((x) => x.value).join(', ').trim();
    // Keywords added by abilities: an asterisk after the badges explains where they came from.
    const kwMark = (p) => p.characteristics.filter((x) => isKw(x.name) && isModified(x))
      .map((x) => modValue(p.name, x, html`<span class="visually-hidden">Keywords changed</span>`, 'stat-mod-kw'));
    sections.push(html`<div class="mb-4">
      <h6 class="fw-bold text-primary mb-2">${type}</h6>
      <!-- Phones: one card per weapon with roomy stat boxes. -->
      <div class="weapon-cards d-sm-none">
        ${list.map((p) => {
          const kw = kwOf(p);
          return html`<div class="weapon-card">
            <div class="fw-semibold">${p.name}${counts ? qty(p) : ''}</div>
            ${p.owners ? html`<div class="small opacity-75">${p.owners.join(', ')}</div>` : ''}
            <div class="weapon-stats" style="grid-template-columns: repeat(${cols.length}, minmax(0, 1fr));">
              ${cols.map((c) => html`<div class="stat-box"><span class="stat-label">${c}</span><span class="stat-value">${cell(p, c)}</span></div>`)}
            </div>
            ${kw && kw !== '-' ? html`<div class="mt-2">${formatKeywords(kw, rules, usedRules)}${kwMark(p)}</div>` : ''}
          </div>`;
        })}
      </div>
      <!-- Wider screens: table. -->
      <div class="table-responsive d-none d-sm-block">
        <table class="table table-dark table-bordered weapon-table align-middle mb-0">
          <thead><tr class="table-primary"><th scope="col">Name</th>${cols.map((c) => html`<th scope="col" class="${centered(c) ? 'text-center' : ''}">${c}</th>`)}</tr></thead>
          <tbody>${list.map((p, i) => {
            const kw = p.characteristics.filter((x) => isKw(x.name)).map((x) => x.value).join(', ').trim();
            const hasKw = kw && kw !== '-';
            const stripe = i % 2 === 0 ? 'alt' : '';
            return html`<tr class="${stripe} ${hasKw ? 'has-kw' : ''}"><td class="fw-semibold">${p.name}${counts ? qty(p) : ''}
              ${p.owners ? html`<div class="small fw-normal opacity-75">${p.owners.join(', ')}</div>` : ''}</td>${cols.map((c) => html`<td class="${centered(c) ? 'text-center' : ''}">${cell(p, c)}</td>`)}</tr>
            ${hasKw ? html`<tr class="${stripe} kw-row"><td colspan="${cols.length + 1}">${formatKeywords(kw, rules, usedRules)}${kwMark(p)}</td></tr>` : ''}`;
          })}</tbody>
        </table>
      </div>
    </div>`);
  }
  return sections;
}

function abilityProfiles(byType) {
  const out = [];
  for (const [type, list] of byType) {
    if (type !== 'Unit' && list[0].characteristics.length <= 1) out.push(...list.filter((p) => !isAttachList(p)));
  }
  return out;
}

function abilitiesSection(abilities) {
  if (!abilities.length) return '';
  return html`<div class="mb-4">
    <h6 class="fw-bold text-primary mb-2">Abilities</h6>
    ${abilities.map((p) => html`<div class="mb-2">
      <span class="fw-bold">${p.name}</span>
      ${p.owners ? html`<span class="small opacity-75 ms-1">(${p.owners.join(', ')})</span>` : ''}
      <div class="small opacity-75">${richText(p.characteristics[0] ? p.characteristics[0].value : '')}</div>
    </div>`)}
  </div>`;
}

function rulesSection(rules) {
  if (!rules.length) return '';
  return html`<div class="mb-4">
    <h6 class="fw-bold text-primary mb-2">Rules</h6>
    <div class="d-flex flex-wrap gap-2">
      ${rules.map((r) => {
        if (keywordRules.size > 5000) keywordRules.clear();
        const id = 'kw' + (++keywordSeq);
        keywordRules.set(id, { keyword: r.name, rule: r, kind: 'Rule' });
        return html`<button type="button" class="badge bg-dark border text-info p-2 kw-badge" data-kw-rule="${id}"
          title="Show the ${r.name} rule">${r.name}</button>`;
      })}
    </div>
  </div>`;
}

function keywordsSection(keywords, bases = []) {
  if (!keywords.length && !bases.length) return '';
  const faction = keywords.filter((k) => /^Faction:/i.test(k));
  const other = keywords.filter((k) => !/^Faction:/i.test(k));
  return html`<div>
    ${keywords.length ? html`<h6 class="fw-bold text-primary mb-2">Keywords</h6>
    <div class="d-flex flex-wrap gap-2">
      ${other.map((k) => html`<span class="badge bg-dark border text-light p-2">${k}</span>`)}
      ${faction.map((k) => html`<span class="badge bg-primary p-2">${k.replace(/^Faction:\s*/i, '')}</span>`)}
    </div>` : ''}
    ${bases.length ? html`<div class="small opacity-75 mt-2">Base size: ${bases.join(', ')}</div>` : ''}
  </div>`;
}

/**
 * Datasheet markup from RosterEngine.describe() output.
 * @param {{profiles:object[], rules:object[], keywords:string[]}} d
 * @param {{divider?: boolean, counts?: boolean}} [opts] counts: show equipped quantities (×N)
 */
export function datasheetHtml(d, { divider = false, counts = false } = {}) {
  if (!d.profiles.length && !d.rules.length) return '';
  const byType = groupByType(d.profiles);
  const usedRules = new Set(); // rules reachable from weapon keyword badges
  const sections = [
    characteristicsSection(byType.get('Unit') || [], counts),
    ...weaponSections(byType, d.rules, usedRules, counts),
    abilitiesSection(abilityProfiles(byType)),
    rulesSection(d.rules.filter((r) => !usedRules.has(r))),
    keywordsSection(d.keywords, baseSizes((byType.get('Unit') || []).map((p) => ({ name: p.name, profile: p })))),
  ];
  return html`${divider ? html`<hr class="my-4">` : ''}${sections}`;
}

/**
 * One datacard for a unit with attached characters.
 * @param {{name:string, header:*, info:{profiles:object[], rules:object[], keywords:string[]}}[]} members
 *   in display order (leader, support, bodyguard); `header` is extra markup shown beside the name.
 */
export function combinedDatasheetHtml(members) {
  // Characteristics: each member's name followed by its stat line(s).
  const statBlocks = members.map((m) => {
    const units = m.info.profiles.filter((p) => p.typeName === 'Unit');
    return html`<div class="mb-3">
      <div class="d-flex justify-content-between align-items-center flex-wrap gap-1 mb-1">
        <span class="fw-bold fs-6">${m.name}</span>${m.header || ''}
      </div>
      ${units.map((p) => html`${units.length > 1 ? html`<div class="small fw-semibold mb-1">${p.name}${p.count > 1 ? qty(p) : ''}</div>` : ''}${statLine(p)}`)}
    </div>`;
  });

  // Weapons and abilities from every member; identical profiles merge (counts add up).
  const merged = new Map();
  for (const m of members) {
    for (const p of m.info.profiles) {
      if (p.typeName === 'Unit') continue;
      const k = profileKey(p);
      const seen = merged.get(k);
      if (seen) {
        seen.count += p.count;
        if (!seen.owners.includes(m.name)) seen.owners.push(m.name);
      } else {
        merged.set(k, { ...p, owners: [m.name] });
      }
    }
  }
  const profiles = [...merged.values()];
  const weapons = profiles.filter((p) => p.characteristics.length > 1);
  // Only name the carriers when a weapon isn't carried by the whole combined unit.
  for (const p of weapons) if (p.owners.length === members.length) delete p.owners;
  // Abilities always name the model/unit granting them, e.g. "Implacable Resilience (Overlord)".
  const abilities = profiles.filter((p) => p.characteristics.length <= 1 && !isAttachList(p));

  // Rules and keywords: one of each.
  const rules = [];
  const ruleNames = new Set();
  for (const m of members) {
    for (const r of m.info.rules) {
      const k = r.name.trim().toLowerCase();
      if (ruleNames.has(k)) continue;
      ruleNames.add(k);
      rules.push(r);
    }
  }
  const keywords = [...new Set(members.flatMap((m) => m.info.keywords))];
  const bases = baseSizes(members.flatMap((m) => m.info.profiles.filter((p) => p.typeName === 'Unit')
    .map((p) => ({ name: p.name, profile: p }))));

  const usedRules = new Set();
  const byType = groupByType(weapons);
  return html`
    <div class="mb-4">
      <h6 class="fw-bold text-primary mb-2">Characteristics</h6>
      ${statBlocks}
    </div>
    ${weaponSections(byType, rules, usedRules, true)}
    ${abilitiesSection(abilities)}
    ${rulesSection(rules.filter((r) => !usedRules.has(r)))}
    ${keywordsSection(keywords, bases)}`;
}
