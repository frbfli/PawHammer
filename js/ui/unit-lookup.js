// Navbar "Unit Lookup": pick a faction, type a unit name, and open its datasheet.
// Only the chosen faction's data is loaded (cached after the first time).

import { html, fmtPts } from './html.js';
import { store } from './store.js';
import { datasheetHtml } from './datasheet.js';
import { RosterEngine } from '../engine/engine.js';
import { VirtualSelection } from '../engine/roster.js';
import { norm } from '../import/importer.js';
import { lookupUnits } from './unit-lookup-units.js';

const MAX_SUGGESTIONS = 8;
const factionGroup = (name) => { const m = /^([^-]+?)\s+-\s+/.exec(name); return m ? m[1] : 'Other'; };
const shortName = (name) => name.replace(/^[^-]+?\s+-\s+/, '');
const modal = (id) => bootstrap.Modal.getOrCreateInstance(document.getElementById(id));

/**
 * Show one modal after another has finished closing (Bootstrap can't stack them cleanly).
 * Bootstrap ignores hide() while a modal is still animating in, so wait for that first.
 */
function swapModal(fromId, toId, after) {
  const fromEl = document.getElementById(fromId);
  const from = bootstrap.Modal.getInstance(fromEl);
  const go = () => { modal(toId).show(); if (after) after(); };
  if (!from || (!from._isShown && !from._isTransitioning)) { go(); return; }
  fromEl.addEventListener('hidden.bs.modal', go, { once: true });
  if (!from._isShown) return; // already closing: 'hidden' will follow
  if (from._isTransitioning) fromEl.addEventListener('shown.bs.modal', () => from.hide(), { once: true });
  else from.hide();
}

let lookup = null; // the wired-up lookup for the current data source

/** Open the Unit Lookup pop-up (set up on first use, and again if the data source changed). */
export function openUnitLookup(app) {
  if (!lookup || lookup.repo !== app.repo) lookup = createLookup(app);
  const el = document.getElementById('lookup-modal');
  const input = el.querySelector('#lookup-input');
  el.addEventListener('shown.bs.modal', () => { if (!input.disabled) input.focus(); else el.querySelector('#lookup-faction').focus(); }, { once: true });
  // Never stack on top of a datasheet that's still open.
  swapModal('unit-modal', 'lookup-modal');
}

function createLookup(app) {
  const el = document.getElementById('lookup-modal');
  const select = el.querySelector('#lookup-faction');
  const input = el.querySelector('#lookup-input');
  const button = el.querySelector('#lookup-search');
  const list = el.querySelector('#lookup-suggestions');
  const status = el.querySelector('#lookup-status');
  let units = []; // { def, name, nameNorm, category, points, engine, force }
  let catalogueName = '';
  let matches = [];
  let active = -1;
  let loadToken = 0;

  const setStatus = (markup) => { status.innerHTML = String(markup); };

  const hide = () => {
    list.classList.add('d-none');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  /** Units whose names match: name starts with the query, then a word starts with it, then contains it. */
  const find = (q) => {
    const n = norm(q);
    if (!n) return [];
    const words = n.split(' ');
    const scored = [];
    for (const u of units) {
      let score = -1;
      if (u.nameNorm.startsWith(n)) score = 0;
      else if (u.nameNorm.split(/[\s-]+/).some((w) => w.startsWith(n))) score = 1;
      else if (u.nameNorm.includes(n)) score = 2;
      else if (words.every((w) => u.nameNorm.includes(w))) score = 3;
      if (score >= 0) scored.push([score, u]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map(([, u]) => u);
  };

  const render = () => {
    matches = find(input.value).slice(0, MAX_SUGGESTIONS);
    if (!matches.length) {
      hide();
      if (input.value.trim()) setStatus(html`<span class="text-warning">No units match “${input.value.trim()}” in ${catalogueName}.</span>`);
      else setStatus(html`<span class="opacity-75">${units.length} units in ${catalogueName}.</span>`);
      return;
    }
    setStatus('');
    active = Math.min(active, matches.length - 1);
    list.innerHTML = String(html`${matches.map((u, i) => html`
      <li class="list-group-item list-group-item-action bg-dark text-light d-flex justify-content-between align-items-center gap-2 ${i === active ? 'active-suggestion' : ''}"
        id="lookup-opt-${i}" role="option" aria-selected="${i === active}" data-index="${i}">
        <span style="min-width:0"><span class="fw-semibold text-primary">${u.name}</span>
          ${u.category ? html`<small class="opacity-75 ms-1">${u.category}</small>` : ''}</span>
        ${u.points ? html`<span class="badge bg-primary rounded-pill pts">${fmtPts(u.points)} pts</span>` : ''}
      </li>`)}`);
    list.classList.remove('d-none');
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `lookup-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  const open = (u) => {
    if (!u) return;
    hide();
    input.value = u.name;
    showDatasheet(u, catalogueName);
  };

  const search = () => {
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    const found = find(q);
    const exact = found.find((u) => u.nameNorm === norm(q));
    if (exact || found.length) open(exact || found[0]);
    else setStatus(html`<span class="text-warning">No units match “${q}” in ${catalogueName}.</span>`);
  };

  const loadFaction = async (catalogueId) => {
    const token = ++loadToken;
    units = [];
    hide();
    input.disabled = true;
    button.disabled = true;
    input.placeholder = catalogueId ? 'Loading units…' : 'Choose a faction first';
    if (!catalogueId) { setStatus(''); return; }
    catalogueName = shortName(select.options[select.selectedIndex].textContent);
    setStatus(html`<span class="opacity-75"><span class="spinner-border spinner-border-sm me-1"></span>Loading ${catalogueName}…</span>`);
    try {
      const data = await app.loadGameData(catalogueId, (msg) => { if (token === loadToken) setStatus(html`<span class="opacity-75"><span class="spinner-border spinner-border-sm me-1"></span>${msg}</span>`); });
      if (token !== loadToken) return;
      const engine = RosterEngine.create(data, { name: 'Unit lookup' });
      const force = engine.roster.forces[0];
      const pts = engine.ptsTypeId;
      // The army's own datasheets: no Legends, no allied units.
      units = lookupUnits(engine, force).units
        .map((o) => {
          const cat = data.categories.get(o.def.primaryCategoryId);
          return {
            def: o.def,
            name: o.state.name,
            nameNorm: norm(o.state.name),
            category: cat ? cat.name : '',
            points: engine.evaluate(new VirtualSelection(o.def, force, [])).costs[pts] || 0,
            engine,
            force,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      store.saveSettings({ lastFaction: catalogueId });
      input.disabled = false;
      button.disabled = false;
      input.placeholder = `Search ${units.length} ${catalogueName} units…`;
      if (el.classList.contains('show')) input.focus();
      if (input.value.trim()) render(); else setStatus(html`<span class="opacity-75">${units.length} units in ${catalogueName}.</span>`);
    } catch (err) {
      if (token === loadToken) setStatus(html`<span class="text-danger">${err.message}</span>`);
    }
  };

  // Events (bound once per lookup; the modal markup is static).
  input.oninput = () => { active = -1; render(); };
  input.onfocus = () => { if (input.value.trim()) render(); };
  input.onkeydown = (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (list.classList.contains('d-none')) render();
      if (!matches.length) return;
      ev.preventDefault();
      active = ev.key === 'ArrowDown' ? (active + 1) % matches.length : (active <= 0 ? matches.length - 1 : active - 1);
      render();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (active >= 0 && matches[active]) open(matches[active]); else search();
    } else if (ev.key === 'Escape' && !list.classList.contains('d-none')) {
      ev.stopPropagation(); // close the suggestions, not the modal
      hide();
    }
  };
  list.onmousedown = (ev) => ev.preventDefault(); // keep focus in the input
  list.onclick = (ev) => {
    const li = ev.target.closest('[data-index]');
    if (li) open(matches[Number(li.dataset.index)]);
  };
  button.onclick = search;
  select.onchange = () => loadFaction(select.value);
  document.getElementById('unit-modal-back').onclick = () => swapModal('unit-modal', 'lookup-modal', () => {
    document.getElementById('lookup-modal').addEventListener('shown.bs.modal', () => { input.focus(); input.select(); }, { once: true });
  });

  // Faction list (same grouping as New Roster); preselect the last used faction.
  select.innerHTML = '<option value="">Loading factions…</option>';
  input.disabled = true;
  button.disabled = true;
  input.value = '';
  setStatus('');
  (async () => {
    try {
      const gs = (await app.repo.gameSystems())[0];
      const factions = await app.repo.factions(gs && gs.id);
      const groups = new Map();
      for (const f of factions) {
        const g = factionGroup(f.name);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(f);
      }
      const last = store.settings().lastFaction;
      const preselect = factions.some((f) => f.id === last) ? last : '';
      select.innerHTML = String(html`<option value="" ${preselect ? '' : 'selected'}>Choose a faction…</option>
        ${[...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([g, fs]) => html`
          <optgroup label="${g}">${fs.map((f) => html`<option value="${f.id}" ${f.id === preselect ? 'selected' : ''}>${shortName(f.name)}</option>`)}</optgroup>`)}`);
      if (preselect) loadFaction(preselect);
    } catch (err) {
      select.innerHTML = String(html`<option value="">${err.message}</option>`);
    }
  })();

  return { repo: app.repo };
}

/** Datasheet modal for a looked-up unit, with its default wargear. */
function showDatasheet(u, catalogueName) {
  const el = document.getElementById('unit-modal');
  const preview = u.engine.previewEntry(u.force, u.def, { available: true });
  el.querySelector('#unit-modal-title').textContent = u.name;
  el.querySelector('#unit-modal-subtitle').textContent = [
    catalogueName,
    u.category,
    preview.models ? `${preview.models} model${preview.models === 1 ? '' : 's'}` : '',
    `${fmtPts(preview.points)} pts`,
  ].filter(Boolean).join(' • ');
  el.querySelector('#unit-modal-body').innerHTML = String(html`
    <p class="small opacity-75 mb-3"><i class="bi bi-info-circle me-1"></i>Every weapon and piece of wargear this unit can take. Model count and points are for its default loadout.</p>
    ${datasheetHtml(preview.info) || html`<p class="opacity-75 mb-0">No datasheet information in the data.</p>`}`);
  el.querySelector('.modal-body').scrollTop = 0;
  swapModal('lookup-modal', 'unit-modal');
}
