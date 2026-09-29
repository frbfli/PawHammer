// Home view: data source status, saved rosters, create/import.

import { html, fmtPts } from './html.js';
import { store } from './store.js';
import { toast, download } from './toast.js';
import { parseGwAppText } from '../import/gw-app-text.js';
import { norm } from '../import/importer.js';
import { qrScanner, extractShareCode } from '../data/share-code.js';

function factionGroup(name) {
  const m = /^([^-]+?)\s+-\s+/.exec(name);
  return m ? m[1] : 'Other';
}

export function renderHome(app) {
  const root = app.root;
  const rosters = store.listRosters();
  root.innerHTML = String(html`
    <div class="row g-4">
      <div class="col-lg-8">
        <div class="p-4 border rounded bg-secondary h-100 d-flex flex-column">
          <div class="d-flex justify-content-between align-items-center border-bottom pb-2 mb-3">
            <h3 class="mb-0 fw-bold">Your Rosters</h3>
            <span class="badge bg-primary fs-6">${rosters.length} saved</span>
          </div>
          <p class="small opacity-75 mb-2"><i class="bi bi-info-circle me-1"></i>Rosters are saved in this browser. Click a roster to open it.</p>
          ${rosters.length ? html`
            <ul class="list-group">
              ${rosters.map((r) => html`
                <li class="list-group-item bg-dark text-light unit-list-item d-flex justify-content-between align-items-center py-3 border-bottom"
                  data-open="${r.id}" tabindex="0" role="link" aria-label="Open ${r.name}">
                  <div class="me-2" style="min-width:0">
                    <div class="fw-bold text-primary text-truncate">${r.name}</div>
                    <small class="opacity-75 d-block">${r.catalogueName || 'Unknown faction'} • ${new Date(r.updatedAt || Date.now()).toLocaleDateString()}</small>
                  </div>
                  <div class="d-flex align-items-center gap-2">
                    <span class="badge bg-primary rounded-pill pts">${fmtPts(r.points)} pts</span>
                    <div class="dropdown" data-stop>
                      <button class="btn btn-sm btn-outline-light border-0 fs-5" data-bs-toggle="dropdown" aria-label="Roster actions"><i class="bi bi-three-dots-vertical"></i></button>
                      <ul class="dropdown-menu dropdown-menu-end">
                        <li><a class="dropdown-item" href="#/play/${encodeURIComponent(r.id)}"><i class="bi bi-play-fill me-1"></i>Play Mode</a></li>
                        <li><button class="dropdown-item" data-dup="${r.id}"><i class="bi bi-copy me-1"></i>Duplicate</button></li>
                        <li><button class="dropdown-item" data-export="${r.id}"><i class="bi bi-download me-1"></i>Export JSON</button></li>
                        <li><hr class="dropdown-divider"></li>
                        <li><button class="dropdown-item text-danger" data-del="${r.id}"><i class="bi bi-trash me-1"></i>Delete</button></li>
                      </ul>
                    </div>
                  </div>
                </li>`)}
            </ul>` : html`
            <ul class="list-group"><li class="list-group-item bg-dark text-light text-center opacity-75 py-4">No rosters yet. Create one to get started.</li></ul>`}
        </div>
      </div>
      <div class="col-lg-4">
        <div class="p-4 border rounded bg-secondary h-100">
          <h3 class="fw-bold border-bottom pb-2 mb-3">Get Started</h3>
          <p class="opacity-75">Build and validate Warhammer 40,000 11th edition army lists. Rules, points and options come
            from the community-maintained <a href="https://github.com/${app.repo.source.owner || 'BSData'}/${app.repo.source.repo || ''}" class="link-light" target="_blank" rel="noopener">BSData</a> repository.</p>
          <div class="d-grid gap-2 mb-4">
            <button class="btn btn-success" id="btn-new"><i class="bi bi-plus-lg me-1"></i>New Roster</button>
            <button class="btn btn-outline-light" id="btn-receive"><i class="bi bi-qr-code-scan me-1"></i>Scan QR / Enter Code</button>
            <button class="btn btn-outline-light" id="btn-text-import"><i class="bi bi-clipboard-plus me-1"></i>Import from Text</button>
            <label class="btn btn-outline-light mb-0">
              <i class="bi bi-upload me-1"></i>Import Roster File
              <input type="file" accept=".json,application/json" id="import-file" hidden>
            </label>
          </div>
          <div class="alert alert-dark small mb-0" id="data-status">
            <div class="d-flex align-items-center gap-2"><span class="spinner-border spinner-border-sm"></span> Checking data source…</div>
          </div>
        </div>
      </div>
    </div>`);

  root.querySelector('#btn-new').addEventListener('click', () => openNewRoster(app));
  root.querySelector('#btn-text-import').addEventListener('click', () => openTextImport(app));
  root.querySelector('#btn-receive').addEventListener('click', () => openReceive());
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
        <div class="progress" style="height:.35rem"><div class="progress-bar bg-success" style="width:${Math.round((done / total) * 100)}%"></div></div>`);
    });
    const gs = manifest.find((m) => m.type === 'gameSystem');
    const factions = manifest.filter((m) => m.type === 'catalogue' && !m.library).length;
    if (!document.getElementById('data-status')) return;
    document.getElementById('data-status').innerHTML = String(html`
      <div class="d-flex align-items-center gap-2 mb-1"><i class="bi bi-check-circle-fill text-success"></i>
        <strong>${gs ? gs.name : 'No game system found'}</strong></div>
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

/** "Scan QR / Enter Code": read a shared roster with the camera, or from a pasted link/code. */
export function openReceive() {
  const modalEl = document.getElementById('receive-modal');
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  const video = modalEl.querySelector('#receive-video');
  const box = modalEl.querySelector('#receive-video-box');
  const status = modalEl.querySelector('#receive-status');
  const input = modalEl.querySelector('#receive-code');
  const cameraBtn = modalEl.querySelector('#receive-camera');
  let stream = null;
  let scanning = false;

  const stop = () => {
    scanning = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    box.classList.add('d-none');
    cameraBtn.disabled = false;
  };
  const open = (code) => {
    stop();
    modal.hide();
    location.hash = '#/share/' + code;
  };

  input.value = '';
  status.innerHTML = '';
  box.classList.add('d-none');
  cameraBtn.disabled = !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (cameraBtn.disabled) status.innerHTML = String(html`<span class="opacity-75">This browser can't use the camera here; paste the link instead.</span>`);

  cameraBtn.onclick = async () => {
    try {
      cameraBtn.disabled = true;
      status.innerHTML = String(html`<span class="opacity-75">Starting camera…</span>`);
      const detect = await qrScanner();
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      video.srcObject = stream;
      box.classList.remove('d-none');
      await video.play();
      status.innerHTML = String(html`<span class="opacity-75">Point the camera at a PawHammer QR code.</span>`);
      scanning = true;
      const tick = async () => {
        if (!scanning) return;
        let text = null;
        try { text = await detect(video); } catch { /* frame not ready */ }
        const code = text && extractShareCode(text);
        if (code) { open(code); return; }
        if (text) status.innerHTML = String(html`<span class="text-warning">That QR code isn't a PawHammer roster.</span>`);
        setTimeout(tick, 250);
      };
      tick();
    } catch (err) {
      stop();
      status.innerHTML = String(html`<span class="text-danger">${err.name === 'NotAllowedError' ? 'Camera access was blocked.' : err.message || 'Could not start the camera.'} Paste the link instead.</span>`);
    }
  };
  modalEl.querySelector('#receive-form').onsubmit = (ev) => {
    ev.preventDefault();
    const code = extractShareCode(input.value);
    if (!code) { status.innerHTML = String(html`<span class="text-danger">That isn't a PawHammer share link or code.</span>`); return; }
    open(code);
  };
  modalEl.addEventListener('hidden.bs.modal', stop, { once: true });
  modal.show();
}

/** Faction catalogue for a faction name from a text list, e.g. "Chaos Space Marines". */
export function matchFaction(factions, name) {
  const n = norm(name);
  if (!n) return null;
  const tail = (f) => norm(f.name.replace(/^.*\s-\s/, ''));
  return factions.find((f) => norm(f.name) === n) ||
    factions.find((f) => tail(f) === n) ||
    factions.find((f) => norm(f.name).endsWith(' ' + n)) || null;
}

/** "Import from Text": paste an app export, confirm the faction, then import. */
export async function openTextImport(app) {
  const modalEl = document.getElementById('text-import-modal');
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  const textEl = modalEl.querySelector('#text-import-text');
  const select = modalEl.querySelector('#text-import-faction');
  const detected = modalEl.querySelector('#text-import-detected');
  const submit = modalEl.querySelector('[type=submit]');
  textEl.value = '';
  detected.innerHTML = '';
  select.innerHTML = '<option value="">Loading factions…</option>';
  select.disabled = true;
  submit.disabled = true;
  modal.show();

  let factions = [];
  try {
    const gs = (await app.repo.gameSystems())[0];
    factions = await app.repo.factions(gs && gs.id);
    select.innerHTML = String(html`<option value="">Choose a faction…</option>
      ${factions.map((f) => html`<option value="${f.id}">${f.name}</option>`)}`);
    select.disabled = false;
  } catch (err) {
    select.innerHTML = String(html`<option value="">${err.message}</option>`);
  }

  const update = () => {
    const list = parseGwAppText(textEl.value);
    const ok = list.units.length > 0;
    submit.disabled = !ok || !select.value;
    if (!textEl.value.trim()) { detected.innerHTML = ''; return; }
    if (!ok) {
      detected.innerHTML = String(html`<span class="text-warning"><i class="bi bi-exclamation-triangle me-1"></i>No units found. Paste the whole export, including lines like "Unit Name (100 Points)".</span>`);
      return;
    }
    const f = matchFaction(factions, list.faction);
    if (f && !select.dataset.touched) select.value = f.id;
    submit.disabled = !select.value;
    detected.innerHTML = String(html`<span class="text-success"><i class="bi bi-check-circle me-1"></i>
      ${list.name || 'List'}: ${list.faction || 'unknown faction'}${list.detachments.length ? ` • ${list.detachments.map((d) => d.name).join(', ')}` : ''}
      • ${list.units.length} unit${list.units.length === 1 ? '' : 's'} • ${fmtPts(list.units.reduce((n, u) => n + u.points, 0))} pts</span>
      ${!f && list.faction ? html`<div class="text-warning">Couldn't match "${list.faction}" to a faction, so please choose it below.</div>` : ''}`);
  };
  textEl.oninput = update;
  select.onchange = () => { select.dataset.touched = '1'; update(); };
  delete select.dataset.touched;
  modalEl.querySelector('#text-import-form').onsubmit = (ev) => {
    ev.preventDefault();
    if (!select.value) return;
    modal.hide();
    app.importFromText(textEl.value, select.value);
  };
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
