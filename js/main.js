// PawHammer app controller: routing, data source management and view switching.

import { Repository, GitHubSource, LocalSource, DEFAULT_SOURCE } from './data/repository.js';
import { cacheClear } from './data/cache.js';
import { RosterEngine } from './engine/engine.js';
import { store } from './ui/store.js';
import { html, fmtPts } from './ui/html.js';
import { parseGwAppText } from './import/gw-app-text.js';
import { importList } from './import/importer.js';
import { decodeShare } from './data/share-code.js';
import { renderHome, openNewRoster } from './ui/home.js';
import { Editor } from './ui/editor.js';
import { PlayView } from './ui/play.js';
import { openUnitLookup } from './ui/unit-lookup.js';
import { toast } from './ui/toast.js';

class App {
  constructor() {
    this.root = document.getElementById('app');
    this.gameData = new Map(); // catalogueId -> Promise<GameData>
    this.view = null;
    this.localSource = null;
    this.resetRepository();
    this.applyTheme(store.settings().theme);
    this.bindChrome();
    window.addEventListener('hashchange', () => this.route());
    this.route();
  }

  resetRepository() {
    const source = this.localSource || new GitHubSource(store.settings().source);
    this.repo = new Repository(source);
    this.gameData.clear();
    document.getElementById('source-label').textContent = source.label;
  }

  loadGameData(catalogueId, status) {
    if (!this.gameData.has(catalogueId)) {
      const p = this.repo.loadGameData(catalogueId, status);
      p.catch(() => this.gameData.delete(catalogueId));
      this.gameData.set(catalogueId, p);
    }
    return this.gameData.get(catalogueId);
  }

  /** Dark mode uses Bootswatch Darkly, light mode its sibling theme Flatly. */
  applyTheme(theme) {
    const light = theme === 'light';
    document.documentElement.setAttribute('data-bs-theme', light ? 'light' : 'dark');
    document.getElementById('theme-css').href = `https://cdn.jsdelivr.net/npm/bootswatch@5.3.3/dist/${light ? 'flatly' : 'darkly'}/bootstrap.min.css`;
  }

  bindChrome() {
    document.getElementById('btn-theme').addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
      this.applyTheme(next);
      store.saveSettings({ theme: next });
    });

    const settingsEl = document.getElementById('settings-modal');
    const settingsModal = bootstrap.Modal.getOrCreateInstance(settingsEl);
    const fill = (src) => {
      settingsEl.querySelector('#set-owner').value = src.owner;
      settingsEl.querySelector('#set-repo').value = src.repo;
      settingsEl.querySelector('#set-branch').value = src.branch;
    };
    document.getElementById('nav-new').addEventListener('click', (ev) => { ev.preventDefault(); openNewRoster(this); });
    document.getElementById('nav-lookup').addEventListener('click', (ev) => {
      ev.preventDefault();
      // On phones the navbar is a collapsed menu: close it so the pop-up isn't hidden behind it.
      const menu = document.getElementById('navbarNav');
      if (menu.classList.contains('show')) bootstrap.Collapse.getOrCreateInstance(menu).hide();
      openUnitLookup(this);
    });
    document.getElementById('btn-settings').addEventListener('click', (ev) => {
      ev.preventDefault();
      fill(store.settings().source);
      settingsEl.querySelector('#set-ys-proxy').value = store.settings().ysProxy;
      settingsEl.querySelector('#set-local').value = '';
      settingsModal.show();
    });
    document.getElementById('btn-reset-source').addEventListener('click', () => fill(DEFAULT_SOURCE));
    document.getElementById('btn-clear-cache').addEventListener('click', async () => {
      await cacheClear();
      Object.keys(localStorage).filter((k) => /^pawhammer:.+@.+:(files|manifest(:v\d+)?)$/.test(k)).forEach((k) => localStorage.removeItem(k));
      this.localSource = null;
      this.resetRepository();
      toast('Cached data cleared');
      settingsModal.hide();
      this.route();
    });
    document.getElementById('settings-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      store.saveSettings({ ysProxy: settingsEl.querySelector('#set-ys-proxy').value.trim() });
      const files = settingsEl.querySelector('#set-local').files;
      if (files && files.length) {
        this.localSource = new LocalSource(files);
      } else {
        this.localSource = null;
        store.saveSettings({
          source: {
            owner: settingsEl.querySelector('#set-owner').value.trim(),
            repo: settingsEl.querySelector('#set-repo').value.trim(),
            branch: settingsEl.querySelector('#set-branch').value.trim() || 'main',
          },
        });
      }
      this.resetRepository();
      hideModal(settingsEl);
      toast(`Data source: ${this.repo.source.label}`);
      this.route();
    });

    document.getElementById('new-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const form = ev.target;
      const catalogueId = form.querySelector('#new-faction').value;
      if (!catalogueId) return;
      const name = form.querySelector('#new-name').value.trim();
      const size = form.querySelector('#new-size').value;
      hideModal(document.getElementById('new-modal'));
      store.saveSettings({ lastFaction: catalogueId });
      this.createRoster(catalogueId, name, size ? Number(size) : null);
    });
  }

  /** A roster opened from a share link / QR code: preview it, then save it as the user's own copy. */
  async showSharedRoster(code, hash) {
    document.getElementById('nav-rosters').classList.remove('active');
    this.showLoading('Opening shared roster…');
    try {
      const payload = await decodeShare(code);
      const data = await this.loadGameData(payload[1], (msg) => this.showLoading(msg));
      if (location.hash !== hash) return;
      const engine = RosterEngine.fromShare(data, payload);
      const r = engine.roster;
      const force = r.forces[0];
      const limit = engine.costLimits()[engine.ptsTypeId];
      const chosen = (name) => {
        const sel = force && force.selections.find((s) => s.def.name === name);
        return sel ? [...engine.walk(sel)].map((s) => engine.displayName(s).replace(/^\d+\.\s*/, '')) : [];
      };
      const groups = force ? engine.groupedSelections(force).filter((g) => g.selections.some((s) => s.def.type !== 'upgrade')) : [];
      document.title = `Shared: ${r.name} — PawHammer`;
      this.root.innerHTML = String(html`
        <div class="row justify-content-center"><div class="col-lg-8">
          <div class="p-4 border rounded bg-secondary">
            <div class="d-flex justify-content-between align-items-start border-bottom pb-2 mb-3 gap-2">
              <div>
                <small class="opacity-75 d-block"><i class="bi bi-qr-code me-1"></i>Shared roster</small>
                <h3 class="fw-bold mb-0">${r.name}</h3>
                <small class="opacity-75">${r.catalogueName}${chosen('Detachment').length ? ` • ${chosen('Detachment').join(', ')}` : ''}${chosen('Battle Size').length ? ` • ${chosen('Battle Size')[0]}` : ''}</small>
              </div>
              <span class="badge bg-primary fs-6 pts">${fmtPts(engine.points())}${limit != null ? ` / ${fmtPts(limit)}` : ''} pts</span>
            </div>
            ${engine.loadWarnings.map((w) => html`<div class="alert alert-warning py-2 px-3 small mb-2"><i class="bi bi-exclamation-triangle me-1"></i>${w}</div>`)}
            ${groups.map((g) => html`<div class="list-cat-heading"><span>${g.name}</span></div>
              <ul class="list-group mb-2">${g.selections.filter((s) => s.def.type !== 'upgrade').map((s) => html`
                <li class="list-group-item bg-dark text-light d-flex justify-content-between align-items-center py-2">
                  <span class="fw-bold text-primary">${engine.displayName(s)}${engine.isWarlord(s) ? html` <span class="badge bg-warning text-dark ms-1">Warlord</span>` : ''}</span>
                  <span class="badge bg-primary rounded-pill pts">${fmtPts(engine.points(s))} pts</span>
                </li>`)}</ul>`)}
            <div class="d-flex flex-wrap gap-2 justify-content-end mt-3">
              <a href="#/" class="btn btn-outline-light">Cancel</a>
              <button class="btn btn-outline-light" id="shared-play"><i class="bi bi-play-fill me-1"></i>Save &amp; Play</button>
              <button class="btn btn-success" id="shared-save"><i class="bi bi-download me-1"></i>Save to My Rosters</button>
            </div>
          </div>
        </div></div>`);
      const save = (target) => {
        store.saveRoster(engine.toJSON());
        toast(`Saved "${r.name}" to your rosters`);
        location.replace(`#/${target}/${encodeURIComponent(r.id)}`);
      };
      this.root.querySelector('#shared-save').addEventListener('click', () => save('roster'));
      this.root.querySelector('#shared-play').addEventListener('click', () => save('play'));
    } catch (err) {
      this.showError(err);
    }
  }

  /** Build a roster from a pasted app export, save it, open it and show what was matched. */
  async importFromText(text, catalogueId) {
    this.showLoading('Preparing data…');
    try {
      const data = await this.loadGameData(catalogueId, (msg) => this.showLoading(msg));
      this.showLoading('Importing your list…');
      await new Promise((r) => setTimeout(r, 0)); // let the loading message paint
      const { engine, report } = importList(data, parseGwAppText(text));
      store.saveRoster(engine.toJSON());
      this.pendingImportReport = { id: engine.roster.id, report };
      location.hash = '#/roster/' + engine.roster.id;
    } catch (err) {
      this.showError(err);
    }
  }

  showImportReport(report) {
    const units = report.units;
    const skipped = units.filter((u) => u.notes.some((n) => /skipped/.test(n)));
    const unmatched = units.filter((u) => u.notes.some((n) => !/pts in the data/.test(n)) && !skipped.includes(u));
    const repriced = units.filter((u) => u.notes.some((n) => /pts in the data/.test(n)));
    const exact = units.length - skipped.length - unmatched.length;
    const body = document.getElementById('import-report-body');
    body.innerHTML = String(html`
      <p class="mb-3"><strong>${units.length - skipped.length}</strong> of ${units.length} units imported${exact === units.length ? ', all matching the list.' : '.'}
        List total <strong>${fmtPts(report.listedPoints)} pts</strong>; with the current data it's <strong>${fmtPts(report.importedPoints)} pts</strong>.</p>
      ${report.warnings.map((w) => html`<div class="alert alert-warning py-2 px-3 small mb-2"><i class="bi bi-exclamation-triangle me-1"></i>${w}</div>`)}
      ${skipped.length ? html`<h6 class="fw-bold text-danger mt-3">Not imported</h6>
        <ul class="small">${skipped.map((u) => html`<li><strong>${u.name}</strong>: ${u.notes.join(' ')}</li>`)}</ul>` : ''}
      ${unmatched.length ? html`<h6 class="fw-bold text-warning mt-3">Check these units</h6>
        <ul class="small">${unmatched.map((u) => html`<li><strong>${u.name}</strong>: ${u.notes.filter((n) => !/pts in the data/.test(n)).join(' ')}</li>`)}</ul>` : ''}
      ${repriced.length ? html`<h6 class="fw-bold text-primary mt-3">Points changed since the list was exported</h6>
        <ul class="small mb-0">${repriced.map((u) => html`<li>${u.name}: ${fmtPts(u.listedPoints)} → ${fmtPts(u.importedPoints)} pts</li>`)}</ul>` : ''}`);
    bootstrap.Modal.getOrCreateInstance(document.getElementById('import-report-modal')).show();
  }

  async createRoster(catalogueId, name, pointsLimit) {
    this.showLoading('Preparing data…');
    try {
      const data = await this.loadGameData(catalogueId, (msg) => this.showLoading(msg));
      const engine = RosterEngine.create(data, { name: name || data.primaryCatalogue.name.replace(/^[^-]+?\s+-\s+/, '') });
      if (pointsLimit) applyBattleSize(engine, pointsLimit);
      store.saveRoster(engine.toJSON());
      location.hash = '#/roster/' + engine.roster.id;
    } catch (err) {
      this.showError(err);
    }
  }

  showLoading(message) {
    if (this.view && this.view.destroy) { this.view.destroy(); this.view = null; }
    this.root.innerHTML = String(html`<div class="loading-overlay">
      <div class="spinner-border text-primary" role="status" aria-hidden="true"></div>
      <div>${message}</div></div>`);
  }

  showError(err) {
    console.error(err);
    this.root.innerHTML = String(html`<div class="container py-5"><div class="alert alert-danger">
      <h2 class="h5"><i class="bi bi-exclamation-octagon"></i> Something went wrong</h2>
      <p class="mb-2">${err.message || String(err)}</p>
      <a href="#/" class="btn btn-sm btn-outline-light">Back to rosters</a></div></div>`);
  }

  async route() {
    if (this.view && this.view.destroy) this.view.destroy();
    this.view = null;
    const hash = location.hash || '#/';
    const shared = /^#\/share\/([A-Za-z0-9_-]+)$/.exec(hash);
    if (shared) { this.showSharedRoster(shared[1], hash); return; }
    const m = /^#\/(roster|play)\/(.+)$/.exec(hash);
    document.getElementById('nav-rosters').classList.toggle('active', !m);
    if (!m) {
      document.title = 'PawHammer — Warhammer 40,000 List Builder';
      renderHome(this);
      return;
    }
    const json = store.getRoster(decodeURIComponent(m[2]));
    if (!json) { this.showError(new Error('Roster not found in this browser.')); return; }
    this.showLoading(`Loading ${json.catalogueName || 'army data'}…`);
    try {
      const data = await this.loadGameData(json.catalogueId, (msg) => this.showLoading(msg));
      if (location.hash !== hash) return;
      const engine = RosterEngine.fromJSON(data, json);
      const play = m[1] === 'play';
      document.title = `${play ? 'Play: ' : ''}${engine.roster.name} — PawHammer`;
      this.root.innerHTML = '';
      this.view = play ? new PlayView(this, engine) : new Editor(this, engine);
      if (this.pendingImportReport && this.pendingImportReport.id === engine.roster.id) {
        const { report } = this.pendingImportReport;
        this.pendingImportReport = null;
        this.showImportReport(report);
      }
    } catch (err) {
      this.showError(err);
    }
  }
}

/** Hide a modal, even if it is still animating in (Bootstrap ignores hide() mid-transition). */
function hideModal(el) {
  const modal = bootstrap.Modal.getOrCreateInstance(el);
  el.addEventListener('shown.bs.modal', () => modal.hide(), { once: true });
  modal.hide();
}

/** Pick the Battle Size option matching `limit` (e.g. "Strike Force (2000 Point limit)"). */
function applyBattleSize(engine, limit) {
  for (const force of engine.roster.forces) {
    for (const sel of force.selections) {
      const found = findOption(engine.optionTree(sel), (o) => {
        const m = /\(([\d,]+)\s*points?\s*limit\)/i.exec(o.state.name);
        return m && Number(m[1].replace(/,/g, '')) === limit;
      });
      if (found) {
        const { opt, group } = found;
        if (group) engine.chooseInGroup(sel, group.def, opt.def, opt.groupPath);
        else engine.setOptionCount(sel, opt.def, opt.groupPath, 1);
        return;
      }
    }
  }
  engine.setCostLimit(engine.ptsTypeId, limit);
}

function findOption(branch, pred, group = null) {
  for (const o of branch.entries) if (!o.hidden && pred(o)) return { opt: o, group };
  for (const g of branch.groups) {
    if (g.hidden) continue;
    const r = findOption(g, pred, g);
    if (r) return r;
  }
  return null;
}

window.pawhammer = new App();
