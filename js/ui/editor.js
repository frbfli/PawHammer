// Roster editor view: add-unit list, roster tree, option editor and datasheet.

import { html, raw, richText, Actions, fmtPts } from './html.js';
import { store } from './store.js';
import { toast, download, copyText } from './toast.js';
import { VirtualSelection } from '../engine/roster.js';

const MAX_DEPTH = 4;
const WEAPON_ICONS = { 'Ranged Weapons': 'bi-crosshair', 'Melee Weapons': 'bi-shield-slash' };

export class Editor {
  /** @param {import('../engine/engine.js').RosterEngine} engine */
  constructor(app, engine) {
    this.app = app;
    this.engine = engine;
    this.root = app.root;
    this.actions = new Actions();
    this.selectedId = null;
    this.search = '';
    this.showIssues = false;
    this.collapsedCats = new Set();
    this.tab = 'units'; // phone layout: 'units' (selector + previews) or 'army' (list + editor)
    this.previewKey = null;
    this._saveTimer = null;

    this.root.innerHTML = String(html`
      <ul class="nav nav-tabs d-lg-none mb-3 mobile-tabs" role="tablist" id="mobile-tabs"></ul>
      <div class="p-3 border rounded bg-secondary mb-4 d-lg-block" id="ed-bar" data-tab="army"></div>
      <div class="row g-4">
        <div class="col-lg-3 order-2 order-lg-1 d-lg-block" data-tab="units">
          <div class="p-3 border rounded bg-secondary pane" id="pane-add">
            <div class="d-flex justify-content-between align-items-center border-bottom pb-2 mb-3">
              <h5 class="mb-0 fw-bold">Add Units</h5>
            </div>
            <div class="input-group input-group-sm mb-3">
              <span class="input-group-text"><i class="bi bi-search"></i></span>
              <input type="search" class="form-control" id="add-search" placeholder="Search datasheets…" aria-label="Search datasheets">
            </div>
            <div id="add-list"></div>
          </div>
        </div>
        <div class="col-lg-4 order-1 order-lg-2 d-lg-block" data-tab="army">
          <div class="p-3 border rounded bg-secondary pane" id="pane-roster"></div>
        </div>
        <div class="col-lg-5 order-3 d-lg-block" data-tab="army">
          <div class="p-3 border rounded bg-secondary pane" id="pane-unit"></div>
        </div>
      </div>`);

    this.actions.bind(this.root);
    this.root.addEventListener('keydown', (ev) => {
      const el = ev.target;
      if ((ev.key === 'Enter' || ev.key === ' ') && el.matches('[data-act][tabindex]') && !el.matches('input,select,textarea,button')) {
        ev.preventDefault();
        el.click();
      }
    });
    const search = this.root.querySelector('#add-search');
    search.addEventListener('input', () => { this.search = search.value.trim().toLowerCase(); this.renderAddList(); });

    this.unsubscribe = engine.onChange(() => { this.scheduleSave(); this.render(); });
    if (engine.loadWarnings.length) {
      toast(engine.loadWarnings.slice(0, 3).join(' '), 'warning');
    }
    this.render();
    this.save();
  }

  destroy() {
    if (this.unsubscribe) this.unsubscribe();
    this.save();
  }

  get force() { return this.engine.roster.forces[0]; }
  get pts() { return this.engine.ptsTypeId; }

  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 250);
  }

  save() {
    clearTimeout(this._saveTimer);
    if (!store.saveRoster(this.engine.toJSON())) toast('Could not save roster: browser storage is full or unavailable.', 'danger');
  }

  isPhone() { return window.matchMedia('(max-width: 991.98px)').matches; }

  select(sel) {
    this.selectedId = sel ? sel.id : null;
    this.render();
    const pane = this.root.querySelector('#pane-unit');
    if (sel && this.isPhone() && pane.offsetParent) pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** Phone layout: show one tab's panels (desktop always shows everything via d-lg-block). */
  setTab(tab) {
    this.tab = tab;
    this.renderTabs();
    window.scrollTo({ top: 0 });
  }

  renderTabs() {
    const e = this.engine;
    const units = this.force ? this.force.selections.filter((s) => s.def.type !== 'upgrade').length : 0;
    const errors = e.validate().filter((i) => i.level === 'error').length;
    const tabBtn = (id, label) => html`<li class="nav-item flex-fill text-center" role="presentation">
      <button class="nav-link fw-semibold w-100 ${this.tab === id ? 'active' : ''}" type="button" role="tab" aria-selected="${this.tab === id}"
        data-act="${this.actions.add(() => this.setTab(id))}">${label}</button></li>`;
    this.root.querySelector('#mobile-tabs').innerHTML = String(html`
      ${tabBtn('units', html`<i class="bi bi-grid me-1"></i>Units`)}
      ${tabBtn('army', html`<i class="bi bi-list-ul me-1"></i>Army List (${units} • ${fmtPts(e.points())} pts)${errors ? html` <i class="bi bi-exclamation-circle-fill text-danger"></i>` : ''}`)}`);
    for (const el of this.root.querySelectorAll('[data-tab]')) el.classList.toggle('d-none', el.dataset.tab !== this.tab);
  }

  render() {
    this.actions.clear();
    this.renderTabs();
    this.renderBar();
    this.renderAddList();
    this.renderRoster();
    this.renderUnit();
  }

  // ------------------------------------------------------------ top bar

  renderBar() {
    const e = this.engine;
    const r = e.roster;
    const pts = e.points();
    const limit = e.costLimits()[this.pts];
    const pct = limit ? Math.min(100, (pts / limit) * 100) : 0;
    const over = limit != null && pts > limit;
    const issues = e.validate();
    const errors = issues.filter((i) => i.level === 'error');
    const others = e.visibleCostTypes().filter((t) => t.id !== this.pts)
      .map((t) => ({ t, v: e.totalCost(r, t.id), lim: e.costLimits()[t.id] }))
      .filter((x) => x.v || x.lim != null);

    this.root.querySelector('#ed-bar').innerHTML = String(html`
      <div class="d-flex flex-wrap align-items-center gap-2">
        <a href="#/" class="btn btn-sm btn-outline-light" title="Back to rosters" aria-label="Back to rosters"><i class="bi bi-arrow-left"></i></a>
        <div class="flex-grow-1 flex-md-grow-0" style="min-width:0">
          <input class="form-control form-control-sm roster-name-input w-100" value="${r.name}" aria-label="Roster name"
            data-act="${this.actions.add((ev) => e.setRosterName(ev.target.value.trim() || 'Untitled roster'))}">
          <small class="opacity-75 ps-1">${r.catalogueName || ''}</small>
        </div>
        <div class="ms-auto d-flex flex-wrap align-items-center gap-3">
          ${others.map((x) => html`<span class="small opacity-75" title="${x.t.name}">${x.t.name}: <strong class="pts text-light">${fmtPts(x.v)}${x.lim != null ? ' / ' + fmtPts(x.lim) : ''}</strong></span>`)}
          <div class="points-meter" title="Points">
            <span class="small opacity-75 d-block">Points Limit</span>
            <span class="pts fw-bold fs-5 d-block mb-1 ${over ? 'text-danger' : 'text-light'}">${fmtPts(pts)} / ${limit != null ? fmtPts(limit) : '—'} pts</span>
            <div class="progress" style="height: 8px;" role="progressbar" aria-label="Points used" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100">
              <div class="progress-bar ${over ? 'bg-danger' : 'bg-success'}" style="width:${limit ? pct : 0}%"></div>
            </div>
          </div>
          ${errors.length
            ? html`<button class="btn btn-sm btn-danger" aria-expanded="${this.showIssues}" data-act="${this.actions.add(() => { this.showIssues = !this.showIssues; this.renderBar(); })}">
                <i class="bi bi-exclamation-triangle me-1"></i>${errors.length} issue${errors.length === 1 ? '' : 's'}</button>`
            : html`<span class="btn btn-sm btn-success disabled" aria-disabled="true"><i class="bi bi-check2-circle me-1"></i>Valid</span>`}
          <div class="dropdown">
            <button class="btn btn-sm btn-outline-light dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false"><i class="bi bi-box-arrow-up me-1"></i>Export</button>
            <ul class="dropdown-menu dropdown-menu-end">
              <li><button class="dropdown-item" data-act="${this.actions.add(() => this.copyList())}"><i class="bi bi-clipboard"></i> Copy as text</button></li>
              <li><button class="dropdown-item" data-act="${this.actions.add(() => download(`${r.name}.txt`, e.toText()))}"><i class="bi bi-file-text"></i> Download text</button></li>
              <li><button class="dropdown-item" data-act="${this.actions.add(() => download(`${r.name}.json`, JSON.stringify(e.toJSON(), null, 2), 'application/json'))}"><i class="bi bi-filetype-json"></i> Download JSON</button></li>
              <li><hr class="dropdown-divider"></li>
              <li><button class="dropdown-item" data-act="${this.actions.add(() => this.print())}"><i class="bi bi-printer"></i> Print datasheets</button></li>
            </ul>
          </div>
        </div>
      </div>
      ${this.showIssues && errors.length ? html`
        <div class="list-group mt-3 small" style="max-height:30vh;overflow:auto">
          ${issues.map((i) => html`
            <button class="list-group-item list-group-item-action bg-dark d-flex gap-2 ${i.level === 'error' ? 'text-danger' : 'text-warning'}"
              ${i.selectionId ? raw(`data-act="${this.actions.add(() => this.select(this.findTop(i.selectionId)))}"`) : ''}>
              <i class="bi ${i.level === 'error' ? 'bi-x-octagon' : 'bi-exclamation-triangle'}"></i><span>${i.message}</span>
            </button>`)}
        </div>` : ''}`);
  }

  /** The top-level selection (unit/config entry) containing a selection id. */
  findTop(id) {
    const sel = this.engine.findSelection(id);
    return sel ? sel.rootEntry : null;
  }

  async copyList() {
    const ok = await copyText(this.engine.toText());
    toast(ok ? 'Army list copied to clipboard' : 'Copy failed', ok ? 'success' : 'danger');
  }

  // ------------------------------------------------------------ add list

  renderAddList() {
    const el = this.root.querySelector('#add-list');
    if (!this.force) { el.innerHTML = ''; return; }
    const e = this.engine;
    const cats = e.addableUnits(this.force);
    const q = this.search;
    const blocks = [];
    for (const cat of cats) {
      const opts = q ? cat.options.filter((o) => o.state.name.toLowerCase().includes(q)) : cat.options;
      if (!opts.length) continue;
      const collapsed = !q && this.collapsedCats.has(cat.categoryId);
      blocks.push(html`
        <div class="border rounded mb-2 overflow-hidden">
          <button class="cat-toggle bg-dark text-light" aria-expanded="${!collapsed}"
            data-act="${this.actions.add(() => { collapsed ? this.collapsedCats.delete(cat.categoryId) : this.collapsedCats.add(cat.categoryId); this.renderAddList(); })}">
            <span class="fw-bold">${cat.name}</span>
            <span class="badge bg-primary ms-2 rounded-pill">${opts.length}</span>
            <i class="bi ${collapsed ? 'bi-chevron-down' : 'bi-chevron-up'} ms-auto"></i>
          </button>
          ${collapsed ? '' : html`<ul class="list-group list-group-flush">
            ${opts.map((o) => {
              const cost = e.evaluate(new VirtualSelection(o.def, this.force, [])).costs[this.pts] || 0;
              const atMax = o.max !== Infinity && o.count >= o.max;
              // Desktop: clicking the row adds the unit. Phone: it toggles a datasheet preview.
              const previewing = this.previewKey === o.def.key;
              return html`<li class="list-group-item bg-secondary text-light unit-list-item d-flex justify-content-between align-items-center py-2 gap-2 ${atMax ? 'opacity-50' : ''}"
                tabindex="0" role="button" title="${o.state.name}${atMax ? ' (limit reached)' : ''}" aria-expanded="${previewing}"
                data-act="${this.actions.add(() => {
                  if (!this.isPhone()) { this.addUnit(o.def); return; }
                  this.previewKey = previewing ? null : o.def.key;
                  this.renderAddList();
                })}">
                <div style="min-width:0">
                  <div class="fw-bold text-primary text-truncate">${o.state.name}
                    <i class="bi ${previewing ? 'bi-chevron-up' : 'bi-chevron-down'} small d-lg-none opacity-75"></i></div>
                  <small class="opacity-75">${fmtPts(cost)} pts${atMax ? ' • limit reached' : ''}</small>
                </div>
                <button type="button" class="btn btn-sm btn-success border-0 text-nowrap" aria-label="Add ${o.state.name}"
                  data-act="${this.actions.add(() => this.addUnit(o.def))}"><i class="bi bi-plus-lg"></i> Add</button>
              </li>
              ${previewing ? this.previewHtml(o.def) : ''}`;
            })}
          </ul>`}
        </div>`);
    }
    el.innerHTML = String(blocks.length ? html`${blocks}` : html`<div class="empty-state small">No datasheets match “${this.search}”.</div>`);
  }

  addUnit(def) {
    this.previewKey = null;
    const sel = this.engine.addSelection(this.force, def);
    this.select(sel);
    toast(`Added ${this.engine.displayName(sel)}`);
  }

  /** Inline datasheet preview for a unit that has not been added yet (phone layout). */
  previewHtml(def) {
    const preview = this.engine.previewEntry(this.force, def);
    return html`<li class="list-group-item bg-dark text-light d-lg-none py-3">
      <small class="opacity-75 d-block mb-2">${preview.models ? `${preview.models} model${preview.models === 1 ? '' : 's'} • ` : ''}${fmtPts(preview.points)} pts with default wargear</small>
      ${this.infoSheetHtml(preview.info, false) || html`<p class="opacity-75 mb-2">No datasheet information in the data.</p>`}
      <div class="d-grid mt-3">
        <button type="button" class="btn btn-success" data-act="${this.actions.add(() => this.addUnit(def))}"><i class="bi bi-plus-lg me-1"></i>Add to Army</button>
      </div>
    </li>`;
  }

  // ------------------------------------------------------------ roster tree

  summary(sel) {
    const e = this.engine;
    const parts = [];
    const models = e.modelCount(sel);
    if (sel.def.type === 'unit' && models) parts.push(`${models} model${models === 1 ? '' : 's'}`);
    const leafNames = (s, out) => {
      for (const c of s.children) {
        const n = e.displayName(c);
        if (c.def.type === 'model' || c.children.length === 0 || s.def.type !== 'unit') out.push((c.number > 1 ? c.number + '× ' : '') + n);
        else leafNames(c, out);
      }
      return out;
    };
    parts.push(...leafNames(sel, []));
    return parts.join(' · ');
  }

  renderRoster() {
    const el = this.root.querySelector('#pane-roster');
    const e = this.engine;
    const r = e.roster;
    const issuesBySel = new Map();
    for (const i of e.validate()) {
      if (!i.selectionId || i.level !== 'error') continue;
      const top = this.findTop(i.selectionId);
      if (top) issuesBySel.set(top.id, (issuesBySel.get(top.id) || 0) + 1);
    }
    const units = this.force ? this.force.selections.filter((s) => s.def.type !== 'upgrade').length : 0;

    el.innerHTML = String(html`
      <div class="d-flex justify-content-between align-items-center border-bottom pb-2 mb-3">
        <h5 class="mb-0 fw-bold">Army List</h5>
        <span class="badge bg-primary fs-6 pts">${fmtPts(e.points())} pts</span>
      </div>
      <p class="small opacity-75 mb-2"><i class="bi bi-info-circle me-1"></i>Click any entry to edit its options. ${units} unit${units === 1 ? '' : 's'} in this roster.</p>
      ${r.forces.map((force) => html`
        ${r.forces.length > 1 ? html`<div class="fw-semibold mb-1">${force.forceEntry.name}</div>` : ''}
        ${e.groupedSelections(force).map((grp) => html`
          <div class="list-cat-heading"><span>${grp.name}</span>
            <span class="pts">${(() => { const t = grp.selections.reduce((n, s) => n + e.points(s), 0); return t ? fmtPts(t) + ' pts' : ''; })()}</span></div>
          <ul class="list-group mb-2">
            ${grp.selections.map((s) => this.unitRow(s, issuesBySel.get(s.id) || 0))}
          </ul>
        `)}
        ${force.selections.every((s) => s.def.type === 'upgrade') ? html`
          <ul class="list-group"><li class="list-group-item bg-dark text-light text-center opacity-75 py-4">No units added to army roster yet.</li></ul>` : ''}
      `)}`);
  }

  unitRow(s, issueCount) {
    const e = this.engine;
    const pts = e.points(s);
    const isConfig = s.def.type === 'upgrade';
    return html`
      <li class="list-group-item bg-dark text-light unit-list-item d-flex justify-content-between align-items-center py-2 gap-2 ${s.id === this.selectedId ? 'selected' : ''} ${issueCount ? 'has-error' : ''}"
        tabindex="0" role="button" aria-pressed="${s.id === this.selectedId}" data-act="${this.actions.add(() => this.select(s))}">
        <div class="me-2" style="min-width:0">
          <div class="fw-bold text-primary">${issueCount ? html`<i class="bi bi-exclamation-circle-fill text-danger me-1" title="${issueCount} issue(s)"></i>` : ''}${e.displayName(s)}</div>
          <small class="opacity-75 d-block">${this.summary(s) || (isConfig ? html`<em>Not chosen</em>` : '')}</small>
        </div>
        <div class="d-flex align-items-center gap-1">
          ${pts ? html`<span class="badge bg-primary rounded-pill pts">${fmtPts(pts)} pts</span>` : ''}
          ${isConfig ? '' : html`
            <button type="button" class="btn btn-sm btn-outline-light border-0 fs-6" title="Duplicate" aria-label="Duplicate ${e.displayName(s)}"
              data-act="${this.actions.add((ev) => { ev.stopPropagation(); this.select(e.duplicate(s)); })}"><i class="bi bi-copy"></i></button>
            <button type="button" class="btn btn-sm btn-outline-danger border-0 fs-6" title="Remove Unit" aria-label="Remove ${e.displayName(s)}"
              data-act="${this.actions.add((ev) => { ev.stopPropagation(); this.removeUnit(s); })}"><i class="bi bi-trash"></i></button>`}
        </div>
      </li>`;
  }

  removeUnit(s) {
    const name = this.engine.displayName(s);
    if (this.selectedId === s.id) this.selectedId = null;
    this.engine.removeSelection(s);
    toast(`Removed ${name}`, 'secondary');
  }

  // ------------------------------------------------------------ unit panel

  renderUnit() {
    const el = this.root.querySelector('#pane-unit');
    const e = this.engine;
    const sel = this.selectedId ? e.findSelection(this.selectedId) : null;
    if (!sel) {
      this.selectedId = null;
      el.innerHTML = String(html`
        <div class="d-flex justify-content-between align-items-center border-bottom pb-2 mb-3"><h5 class="mb-0 fw-bold">Unit Details</h5></div>
        <div class="empty-state"><i class="bi bi-hand-index"></i>Select a unit to edit its options and view its datasheet.</div>`);
      return;
    }
    const pts = e.points(sel);
    const issues = e.issuesFor(sel);
    const isConfig = sel.def.type === 'upgrade';
    const options = this.optionsHtml(sel, 0);
    const models = e.modelCount(sel);

    el.innerHTML = String(html`
      <div class="bg-primary text-white rounded p-3 mb-3 d-flex align-items-start gap-2">
        <div class="flex-grow-1" style="min-width:0">
          <input class="form-control form-control-sm roster-name-input unit-name-input w-100" value="${e.displayName(sel)}" aria-label="Unit name"
            placeholder="${e.evaluate(sel).name}" data-act="${this.actions.add((ev) => {
              const v = ev.target.value.trim();
              e.rename(sel, v === e.evaluate(sel).name ? '' : v);
            })}">
          <small class="opacity-75 ps-1">
            ${sel.customName ? html`${e.evaluate(sel).name} • ` : ''}${sel.def.type === 'unit' && models ? `${models} model${models === 1 ? '' : 's'}` : isConfig ? 'Army configuration' : ''}
          </small>
        </div>
        <div class="text-end">
          <div class="fs-5 pts fw-bold">${fmtPts(pts)} pts</div>
          ${isConfig ? '' : html`<div class="d-flex gap-1 justify-content-end">
            <button class="btn btn-sm btn-outline-light border-0" title="Duplicate unit" aria-label="Duplicate unit" data-act="${this.actions.add(() => this.select(e.duplicate(sel)))}"><i class="bi bi-copy"></i></button>
            <button class="btn btn-sm btn-outline-light border-0" title="Remove unit" aria-label="Remove unit" data-act="${this.actions.add(() => this.removeUnit(sel))}"><i class="bi bi-trash"></i></button>
          </div>`}
        </div>
      </div>
      ${issues.map((i) => html`<div class="alert ${i.level === 'error' ? 'alert-danger' : 'alert-warning'} py-2 px-3 small mb-2"><i class="bi bi-exclamation-triangle me-1"></i>${i.message}</div>`)}
      ${options.length ? html`<h6 class="fw-bold text-primary mb-2"><i class="bi bi-sliders me-1"></i>Options</h6>${options}` : ''}
      ${isConfig ? '' : this.sheetHtml(sel)}`);
  }

  _visibleEntries(g) {
    const out = g.entries.filter((o) => !o.hidden && !(o.max === 0 && o.count === 0));
    for (const sub of g.groups) if (!sub.hidden) out.push(...this._visibleEntries(sub));
    return out;
  }

  optionsHtml(parent, depth) {
    const tree = this.engine.optionTree(parent);
    return this.branchHtml(parent, tree, depth);
  }

  branchHtml(parent, branch, depth) {
    const parts = [];
    const fixed = [];
    for (const opt of branch.entries) {
      if (opt.hidden || (opt.max === 0 && opt.count === 0)) continue;
      const nested = opt.count > 0 ? this.childOptionsHtml(opt.selections, depth) : [];
      if (opt.min > 0 && opt.min === opt.max && opt.count === opt.min && !nested.length) { fixed.push(opt); continue; }
      parts.push(this.entryHtml(parent, opt, nested));
    }
    for (const g of branch.groups) {
      if (g.hidden || !this._visibleEntries(g).length) continue;
      parts.push(this.groupHtml(parent, g, depth));
    }
    parts.hasControls = parts.length > 0;
    if (fixed.length) {
      parts.unshift(html`<div class="small opacity-75 mb-1"><i class="bi bi-check2"></i> Includes: ${fixed.map((o) => `${o.count > 1 ? o.count + '× ' : ''}${o.state.name}`).join(', ')}</div>`);
    }
    return parts;
  }

  costLabel(opt) {
    const c = opt.state.costs[this.pts] || 0;
    return c ? html`<span class="badge bg-primary rounded-pill pts">+${fmtPts(c)} pts</span>` : '';
  }

  limitHint(min, max) {
    if (max === Infinity) return min ? `min ${min}` : '';
    if (min === max) return `exactly ${min}`;
    return `${min}–${max}`;
  }

  entryHtml(parent, opt, nested) {
    const e = this.engine;
    const id = 'o' + parent.id + opt.def.key;
    const invalid = opt.count < opt.min || opt.count > opt.max;
    let control;
    if (opt.max === 1 && opt.min <= 1) {
      control = html`<div class="form-check form-switch">
        <input class="form-check-input" type="checkbox" id="${id}" ${opt.count > 0 ? 'checked' : ''} ${opt.min === 1 && opt.count === 1 ? 'disabled' : ''}
          data-act="${this.actions.add((ev) => e.setOptionCount(parent, opt.def, opt.groupPath, ev.target.checked ? 1 : 0))}">
        <label class="form-check-label ${invalid ? 'text-danger' : ''}" for="${id}">${opt.state.name}</label>
      </div>`;
    } else {
      control = html`<span class="opt-name ${invalid ? 'text-danger' : ''}">${opt.state.name}
        <span class="limit-hint ms-1">${this.limitHint(opt.min, opt.max)}</span></span>
        ${this.stepper(opt.count, opt.min, opt.max, (n) => e.setOptionCount(parent, opt.def, opt.groupPath, n), opt.state.name)}`;
    }
    return html`<div class="opt-row">${control}${this.costLabel(opt)}</div>${nested}`;
  }

  stepper(value, min, max, set, label) {
    return html`<span class="stepper">
      <button class="btn btn-outline-light btn-sm" ${value <= 0 ? 'disabled' : ''} aria-label="Decrease ${label}"
        data-act="${this.actions.add(() => set(value - 1))}"><i class="bi bi-dash"></i></button>
      <input type="number" class="form-control form-control-sm mx-1" value="${value}" min="0" ${max !== Infinity ? raw(`max="${max}"`) : ''} aria-label="${label} count"
        data-act="${this.actions.add((ev) => set(ev.target.value))}">
      <button class="btn btn-outline-light btn-sm" ${value >= max ? 'disabled' : ''} aria-label="Increase ${label}"
        data-act="${this.actions.add(() => set(value + 1))}"><i class="bi bi-plus"></i></button>
    </span>`;
  }

  groupHtml(parent, g, depth) {
    const e = this.engine;
    const visible = this._visibleEntries(g);
    const invalid = g.count < g.min || g.count > g.max;
    const hint = this.limitHint(g.min, g.max);
    let body;
    if (g.max === 1) {
      const name = 'r' + parent.id + g.def.key;
      const rows = [];
      if (g.min === 0) {
        rows.push(html`<div class="opt-row"><div class="form-check">
          <input class="form-check-input" type="radio" name="${name}" id="${name}-none" ${g.count === 0 ? 'checked' : ''}
            data-act="${this.actions.add(() => e.chooseInGroup(parent, g.def, null, g.groupPath))}">
          <label class="form-check-label opacity-75" for="${name}-none">None</label></div></div>`);
      }
      for (const opt of visible) {
        const id = name + '-' + opt.def.key;
        rows.push(html`<div class="opt-row"><div class="form-check">
          <input class="form-check-input" type="radio" name="${name}" id="${id}" ${opt.count > 0 ? 'checked' : ''}
            data-act="${this.actions.add(() => e.chooseInGroup(parent, g.def, opt.def, opt.groupPath))}">
          <label class="form-check-label" for="${id}">${opt.state.name}</label></div>${this.costLabel(opt)}</div>
          ${opt.count > 0 ? this.childOptionsHtml(opt.selections, depth) : ''}`);
      }
      body = rows;
    } else {
      body = this.branchHtml(parent, { entries: g.entries, groups: g.groups }, depth);
    }
    return html`<fieldset class="opt-group ${invalid ? 'invalid' : ''}">
      <legend>${g.state.name} ${hint ? html`<span class="limit-hint">(${hint}${g.max > 1 ? `, ${g.count} chosen` : ''})</span>` : ''}</legend>
      ${body}
    </fieldset>`;
  }

  childOptionsHtml(selections, depth) {
    if (depth >= MAX_DEPTH) return [];
    const out = [];
    for (const s of selections) {
      const inner = this.optionsHtml(s, depth + 1);
      if (!inner.length) continue;
      const hasControls = inner.hasControls;
      out.push(html`<div class="opt-nested">
        ${s.number > 1 && hasControls ? html`<div class="limit-hint mb-1">Options for each of ${s.number} ${this.engine.displayName(s)}</div>` : ''}
        ${inner}</div>`);
    }
    return out;
  }

  // ------------------------------------------------------------ datasheet

  sheetHtml(sel) {
    return this.infoSheetHtml(this.engine.describe(sel));
  }

  /** Datasheet markup from RosterEngine.describe() output. */
  infoSheetHtml(d, divider = true) {
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
          ${unitProfiles.length > 1 ? html`<div class="small fw-semibold mb-1">${p.name}</div>` : ''}
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
            <tbody>${list.map((p) => html`<tr><td class="fw-semibold">${p.name}</td>${cols.map((c) => {
              const v = (p.characteristics.find((x) => x.name === c) || {}).value || '';
              if (/keywords/i.test(c)) return html`<td>${this.formatKeywords(v)}</td>`;
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
          ${faction.map((k) => html`<span class="badge bg-primary p-2">${k.replace(/^Faction:s*/i, '')}</span>`)}
        </div>
      </div>`);
    }
    return html`${divider ? html`<hr class="my-4">` : ''}${sections}`;
  }

  formatKeywords(text) {
    if (!text || text === '-') return html`<span class="opacity-50">-</span>`;
    return text.split(',').map((kw) => html`<span class="badge bg-dark border text-info me-1" style="font-size:0.75rem;">${kw.trim()}</span>`);
  }

  // ------------------------------------------------------------ print

  print() {
    const e = this.engine;
    const r = e.roster;
    const pv = document.getElementById('print-view');
    const limit = e.costLimits()[this.pts];
    const units = r.forces.flatMap((f) => e.groupedSelections(f).flatMap((g) => g.selections.map((s) => ({ s, cat: g.name }))));
    const config = units.filter((u) => u.s.def.type === 'upgrade');
    const rest = units.filter((u) => u.s.def.type !== 'upgrade');
    pv.innerHTML = String(html`
      <h1>${r.name}</h1>
      <p><strong>${r.catalogueName}</strong> — ${fmtPts(e.points())}${limit != null ? ' / ' + fmtPts(limit) : ''} pts</p>
      <p>${config.map((u) => html`<strong>${e.displayName(u.s)}:</strong> ${this.summary(u.s) || '—'}<br>`)}</p>
      ${rest.map(({ s, cat }) => {
        const d = e.describe(s);
        const byType = new Map();
        for (const p of d.profiles) { if (!byType.has(p.typeName)) byType.set(p.typeName, []); byType.get(p.typeName).push(p); }
        return html`<div class="unit">
          <h2 style="font-size:12pt;margin:0">${e.displayName(s)} — ${fmtPts(e.points(s))} pts <small>(${cat})</small></h2>
          <div>${this.summary(s)}</div>
          ${[...byType.entries()].map(([type, list]) => {
            const cols = list[0].characteristics.map((c) => c.name);
            if (cols.length <= 1) return html`${list.map((p) => html`<div><strong>${p.name}:</strong> ${richText(p.characteristics[0] ? p.characteristics[0].value : '')}</div>`)}`;
            return html`<table><thead><tr><th>${type}</th>${cols.map((c) => html`<th>${c}</th>`)}</tr></thead>
              <tbody>${list.map((p) => html`<tr><td>${p.name}</td>${cols.map((c) => html`<td>${(p.characteristics.find((x) => x.name === c) || {}).value || ''}</td>`)}</tr>`)}</tbody></table>`;
          })}
          ${d.keywords.length ? html`<div><em>Keywords: ${d.keywords.join(', ')}</em></div>` : ''}
        </div>`;
      })}`);
    window.print();
  }
}
