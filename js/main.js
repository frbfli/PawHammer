// PawHammer app controller: routing, data source management and view switching.

import { Repository, GitHubSource, LocalSource, DEFAULT_SOURCE } from './data/repository.js';
import { cacheClear } from './data/cache.js';
import { RosterEngine } from './engine/engine.js';
import { store } from './ui/store.js';
import { html } from './ui/html.js';
import { renderHome } from './ui/home.js';
import { Editor } from './ui/editor.js';
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

  applyTheme(theme) {
    document.documentElement.setAttribute('data-bs-theme', theme === 'light' ? 'light' : 'dark');
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
    document.getElementById('btn-settings').addEventListener('click', () => {
      fill(store.settings().source);
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
      <div class="spinner-border text-accent" role="status" aria-hidden="true"></div>
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
    const m = /^#\/roster\/(.+)$/.exec(hash);
    if (!m) {
      document.title = 'PawHammer — Warhammer 40,000 List Builder';
      renderHome(this);
      return;
    }
    const json = store.getRoster(decodeURIComponent(m[1]));
    if (!json) { this.showError(new Error('Roster not found in this browser.')); return; }
    this.showLoading(`Loading ${json.catalogueName || 'army data'}…`);
    try {
      const data = await this.loadGameData(json.catalogueId, (msg) => this.showLoading(msg));
      if (location.hash !== hash) return;
      const engine = RosterEngine.fromJSON(data, json);
      document.title = `${engine.roster.name} — PawHammer`;
      this.root.innerHTML = '';
      this.view = new Editor(this, engine);
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
