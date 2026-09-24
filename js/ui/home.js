// Home view: data source status, saved rosters, create/import.

import { html, fmtPts } from './html.js';
import { store } from './store.js';
import { toast, download } from './toast.js';

function factionGroup(name) {
  const m = /^([^-]+?)\s+-\s+/.exec(name);
  return m ? m[1] : 'Other';
}

export function renderHome(app) {
  const root = app.root;
  const rosters = store.listRosters();
  root.innerHTML = String(html`
    <div class="container py-4">
      <section class="hero rounded-4 p-4 p-md-5 mb-4">
        <div class="row align-items-center g-4">
          <div class="col-md-8">
            <h1 class="display-font h2 mb-2">Forge your army</h1>
            <p class="text-body-secondary mb-3">Build and validate Warhammer 40,000 11th edition army lists.
              Rules, points and options come from the community-maintained
              <a href="https://github.com/${app.repo.source.owner || 'BSData'}/${app.repo.source.repo || ''}" target="_blank" rel="noopener">BSData</a> repository.</p>
            <div class="d-flex flex-wrap gap-2">
              <button class="btn btn-primary" id="btn-new"><i class="bi bi-plus-lg"></i> New roster</button>
              <label class="btn btn-outline-secondary mb-0">
                <i class="bi bi-upload"></i> Import roster
                <input type="file" accept=".json,application/json" id="import-file" hidden>
              </label>
            </div>
          </div>
          <div class="col-md-4">
            <div class="small text-body-secondary" id="data-status">
              <div class="d-flex align-items-center gap-2"><span class="spinner-border spinner-border-sm"></span> Checking data source…</div>
            </div>
          </div>
        </div>
      </section>

      <div class="d-flex align-items-baseline justify-content-between mb-2">
        <h2 class="h5 mb-0">Your rosters</h2>
        <span class="small text-body-secondary">${rosters.length} saved in this browser</span>
      </div>
      ${rosters.length ? html`
        <div class="row g-3">
          ${rosters.map((r) => html`
            <div class="col-sm-6 col-lg-4">
              <div class="card roster-card h-100" data-open="${r.id}" tabindex="0" role="link" aria-label="Open ${r.name}">
                <div class="card-body">
                  <div class="d-flex justify-content-between align-items-start gap-2">
                    <h3 class="h6 card-title mb-1 text-truncate">${r.name}</h3>
                    <div class="dropdown" data-stop>
                      <button class="btn btn-sm btn-link text-body-secondary p-0" data-bs-toggle="dropdown" aria-label="Roster actions"><i class="bi bi-three-dots-vertical"></i></button>
                      <ul class="dropdown-menu dropdown-menu-end">
                        <li><button class="dropdown-item" data-dup="${r.id}"><i class="bi bi-copy"></i> Duplicate</button></li>
                        <li><button class="dropdown-item" data-export="${r.id}"><i class="bi bi-download"></i> Export JSON</button></li>
                        <li><hr class="dropdown-divider"></li>
                        <li><button class="dropdown-item text-danger" data-del="${r.id}"><i class="bi bi-trash"></i> Delete</button></li>
                      </ul>
                    </div>
                  </div>
                  <div class="small text-body-secondary mb-2">${r.catalogueName || 'Unknown faction'}</div>
                  <div class="d-flex justify-content-between small">
                    <span class="pts fw-semibold text-accent">${fmtPts(r.points)} pts</span>
                    <span class="text-body-secondary">${new Date(r.updatedAt || Date.now()).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>
            </div>`)}
        </div>` : html`
        <div class="card"><div class="empty-state">
          <i class="bi bi-journal-plus"></i>
          No rosters yet. Create one to get started.
        </div></div>`}
    </div>`);

  root.querySelector('#btn-new').addEventListener('click', () => openNewRoster(app));
  root.querySelector('#import-file').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      if (json.format !== 'pawhammer-roster' || !json.catalogueId) throw new Error('Not a PawHammer roster file.');
      json.id = json.id && !store.getRoster(json.id) ? json.id : crypto.randomUUID();
      store.saveRoster(json);
      toast(`Imported "${json.name}"`);
      renderHome(app);
    } catch (err) {
      toast(err.message, 'danger');
    }
  });
  root.querySelectorAll('[data-open]').forEach((card) => {
    const open = (ev) => {
      if (ev.target.closest('[data-stop]')) return;
      location.hash = '#/roster/' + card.dataset.open;
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(ev); });
  });
  root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    const r = store.getRoster(b.dataset.del);
    if (r && confirm(`Delete "${r.name}"? This cannot be undone.`)) {
      store.deleteRoster(r.id);
      renderHome(app);
    }
  }));
  root.querySelectorAll('[data-dup]').forEach((b) => b.addEventListener('click', () => {
    const r = store.getRoster(b.dataset.dup);
    if (!r) return;
    store.saveRoster({ ...JSON.parse(JSON.stringify(r)), id: crypto.randomUUID(), name: r.name + ' (copy)', updatedAt: Date.now() });
    renderHome(app);
  }));
  root.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => {
    const r = store.getRoster(b.dataset.export);
    if (r) download(`${r.name}.json`, JSON.stringify(r, null, 2), 'application/json');
  }));

  showDataStatus(app);
}

async function showDataStatus(app) {
  const el = document.getElementById('data-status');
  if (!el) return;
  try {
    const manifest = await app.repo.manifest((done, total) => {
      const e = document.getElementById('data-status');
      if (e) e.innerHTML = String(html`<div class="mb-1">Indexing data files… ${done}/${total}</div>
        <div class="progress" style="height:.35rem"><div class="progress-bar bg-accent" style="width:${Math.round((done / total) * 100)}%"></div></div>`);
    });
    const gs = manifest.find((m) => m.type === 'gameSystem');
    const factions = manifest.filter((m) => m.type === 'catalogue' && !m.library).length;
    if (!document.getElementById('data-status')) return;
    document.getElementById('data-status').innerHTML = String(html`
      <div class="d-flex align-items-center gap-2 mb-1"><i class="bi bi-check-circle-fill text-success"></i>
        <strong class="text-body">${gs ? gs.name : 'No game system found'}</strong></div>
      <div>${factions} factions available</div>
      <div class="text-truncate" title="${app.repo.source.label}">Source: ${app.repo.source.label}</div>`);
  } catch (err) {
    const e = document.getElementById('data-status');
    if (e) e.innerHTML = String(html`<div class="text-danger"><i class="bi bi-exclamation-triangle"></i> ${err.message}</div>
      <button class="btn btn-sm btn-outline-secondary mt-2" id="btn-retry">Retry</button>`);
    const retry = document.getElementById('btn-retry');
    if (retry) retry.addEventListener('click', () => { app.resetRepository(); renderHome(app); });
  }
}

export async function openNewRoster(app) {
  const modalEl = document.getElementById('new-modal');
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  const select = modalEl.querySelector('#new-faction');
  const submit = modalEl.querySelector('[type=submit]');
  select.innerHTML = '<option value="">Loading factions…</option>';
  select.disabled = true;
  submit.disabled = true;
  modalEl.querySelector('#new-name').value = '';
  modal.show();
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
    select.innerHTML = String(html`<option value="" disabled ${last ? '' : 'selected'}>Choose a faction…</option>
      ${[...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([g, list]) => html`
        <optgroup label="${g}">${list.map((f) => html`<option value="${f.id}" ${f.id === last ? 'selected' : ''}>${f.name.replace(/^[^-]+?\s+-\s+/, '')}</option>`)}</optgroup>`)}`);
    select.disabled = false;
    submit.disabled = false;
  } catch (err) {
    select.innerHTML = String(html`<option value="">${err.message}</option>`);
  }
}
