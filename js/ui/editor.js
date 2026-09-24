// Roster editor view: add-unit list, roster tree, option editor and datasheet.

import { html, raw, richText, Actions, fmtPts } from './html.js';
import { store } from './store.js';
import { toast, download, copyText } from './toast.js';
import { VirtualSelection } from '../engine/roster.js';

const MAX_DEPTH = 4;

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
    this._saveTimer = null;

    this.root.innerHTML = String(html`
      <div class="editor-bar border-bottom" id="ed-bar"></div>
      <div class="container-fluid py-3">
        <div class="row g-3">
          <div class="col-lg-3 order-2 order-lg-1">
            <div class="card pane" id="pane-add">
              <div class="card-header bg-body-tertiary">
                <div class="d-flex align-items-center justify-content-between mb-2">
                  <span class="pane-title"><i class="bi bi-plus-square"></i> Add units</span>
                </div>
                <div class="input-group input-group-sm">
                  <span class="input-group-text"><i class="bi bi-search"></i></span>
                  <input type="search" class="form-control" id="add-search" placeholder="Search datasheets…" aria-label="Search datasheets">
                </div>
              </div>
              <div class="py-1" id="add-list"></div>
            </div>
          </div>
          <div class="col-lg-4 order-1 order-lg-2">
            <div class="card pane" id="pane-roster"></div>
          </div>
          <div class="col-lg-5 order-3">
            <div class="card pane" id="pane-unit"></div>
          </div>
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

  select(sel) {
    this.selectedId = sel ? sel.id : null;
    this.render();
    if (sel && window.matchMedia('(max-width: 991.98px)').matches) {
      this.root.querySelector('#pane-unit').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  render() {
    this.actions.clear();
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
      <div class="container-fluid py-2 d-flex flex-wrap align-items-center gap-2">
        <a href="#/" class="btn btn-sm btn-outline-secondary" title="Back to rosters" aria-label="Back to rosters"><i class="bi bi-arrow-left"></i></a>
        <input class="form-control form-control-sm roster-name-input flex-grow-1 flex-md-grow-0" value="${r.name}" aria-label="Roster name"
          data-act="${this.actions.add((ev) => e.setRosterName(ev.target.value.trim() || 'Untitled roster'))}">
        <span class="badge rounded-pill bg-accent-subtle text-accent border border-accent">${r.catalogueName || ''}</span>
        <div class="ms-auto d-flex flex-wrap align-items-center gap-3">
          ${others.map((x) => html`<span class="small text-body-secondary" title="${x.t.name}">${x.t.name}: <strong class="pts text-body">${fmtPts(x.v)}${x.lim != null ? ' / ' + fmtPts(x.lim) : ''}</strong></span>`)}
          <div class="points-meter" title="Points">
            <div class="d-flex justify-content-between small">
              <span class="pts fw-bold ${over ? 'text-danger' : 'text-accent'}">${fmtPts(pts)}${limit != null ? html` <span class="text-body-secondary fw-normal">/ ${fmtPts(limit)}</span>` : ''} pts</span>
              ${limit == null ? html`<span class="text-body-secondary">no limit</span>` : html`<span class="text-body-secondary">${fmtPts(Math.max(0, limit - pts))} left</span>`}
            </div>
            <div class="progress" role="progressbar" aria-label="Points used" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100">
              <div class="progress-bar ${over ? 'bg-danger' : 'bg-accent'}" style="width:${limit ? pct : 0}%"></div>
            </div>
          </div>
          ${errors.length
            ? html`<button class="btn btn-sm btn-outline-danger" aria-expanded="${this.showIssues}" data-act="${this.actions.add(() => { this.showIssues = !this.showIssues; this.renderBar(); })}">
                <i class="bi bi-exclamation-triangle"></i> ${errors.length} issue${errors.length === 1 ? '' : 's'}</button>`
            : html`<span class="btn btn-sm btn-outline-success disabled" aria-disabled="true"><i class="bi bi-check2-circle"></i> Valid</span>`}
          <div class="dropdown">
            <button class="btn btn-sm btn-primary dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false"><i class="bi bi-box-arrow-up"></i> Export</button>
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
        <div class="container-fluid pb-2">
          <div class="list-group list-group-flush border rounded small" style="max-height:30vh;overflow:auto">
            ${issues.map((i) => html`
              <button class="list-group-item list-group-item-action d-flex gap-2 ${i.level === 'error' ? 'text-danger-emphasis' : 'text-warning-emphasis'}"
                ${i.selectionId ? raw(`data-act="${this.actions.add(() => this.select(this.findTop(i.selectionId)))}"`) : ''}>
                <i class="bi ${i.level === 'error' ? 'bi-x-octagon' : 'bi-exclamation-triangle'}"></i><span>${i.message}</span>
              </button>`)}
          </div>
        </div>` : ''}`);
    const pane = this.root.querySelector('#ed-bar');
    document.documentElement.style.setProperty('--ph-pane-top', (56 + pane.offsetHeight + 16) + 'px');
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
        <div>
          <button class="cat-heading w-100 border-0 bg-transparent" aria-expanded="${!collapsed}"
            data-act="${this.actions.add(() => { collapsed ? this.collapsedCats.delete(cat.categoryId) : this.collapsedCats.add(cat.categoryId); this.renderAddList(); })}">
            <span><i class="bi ${collapsed ? 'bi-chevron-right' : 'bi-chevron-down'}"></i> ${cat.name}</span><span class="text-body-secondary fw-normal">${opts.length}</span>
          </button>
          ${collapsed ? '' : html`<div class="px-1">
            ${opts.map((o) => {
              const cost = e.evaluate(new VirtualSelection(o.def, this.force, [])).costs[this.pts] || 0;
              const atMax = o.max !== Infinity && o.count >= o.max;
              return html`<button class="add-item ${atMax ? 'opacity-50' : ''}" title="Add ${o.state.name}${atMax ? ' (limit reached)' : ''}"
                data-act="${this.actions.add(() => this.addUnit(o.def))}">
                <i class="bi bi-plus-circle"></i>
                <span class="flex-grow-1 text-truncate">${o.state.name}</span>
                ${cost ? html`<span class="pts small text-body-secondary">${fmtPts(cost)}</span>` : ''}
              </button>`;
            })}
          </div>`}
        </div>`);
    }
    el.innerHTML = String(blocks.length ? html`${blocks}` : html`<div class="empty-state small">No datasheets match “${this.search}”.</div>`);
  }

  addUnit(def) {
    const sel = this.engine.addSelection(this.force, def);
    this.select(sel);
    toast(`Added ${this.engine.displayName(sel)}`);
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
      <div class="card-header bg-body-tertiary d-flex justify-content-between align-items-center">
        <span class="pane-title"><i class="bi bi-list-ul"></i> Roster</span>
        <span class="small text-body-secondary">${units} unit${units === 1 ? '' : 's'}</span>
      </div>
      <div class="py-1">
        ${r.forces.map((force) => html`
          ${r.forces.length > 1 ? html`<div class="px-3 pt-2 fw-semibold">${force.forceEntry.name}</div>` : ''}
          ${e.groupedSelections(force).map((grp) => html`
            <div class="cat-heading"><span>${grp.name}</span>
              <span class="pts text-body-secondary fw-normal">${(() => { const t = grp.selections.reduce((n, s) => n + e.points(s), 0); return t ? fmtPts(t) : ''; })()}</span></div>
            ${grp.selections.map((s) => this.unitRow(s, issuesBySel.get(s.id) || 0))}
          `)}
          ${force.selections.every((s) => s.def.type === 'upgrade') ? html`
            <div class="empty-state small"><i class="bi bi-arrow-left-square"></i>Add units from the list to start building.</div>` : ''}
        `)}
      </div>`);
  }

  unitRow(s, issueCount) {
    const e = this.engine;
    const pts = e.points(s);
    const isConfig = s.def.type === 'upgrade';
    return html`
      <div class="unit-row ${s.id === this.selectedId ? 'active' : ''} ${issueCount ? 'has-error' : ''}" tabindex="0" role="button"
        aria-pressed="${s.id === this.selectedId}" data-act="${this.actions.add(() => this.select(s))}">
        <div class="flex-grow-1" style="min-width:0">
          <div class="fw-semibold text-truncate">${issueCount ? html`<i class="bi bi-exclamation-circle-fill text-danger" title="${issueCount} issue(s)"></i> ` : ''}${e.displayName(s)}</div>
          <div class="unit-summary">${this.summary(s) || (isConfig ? html`<em>Not chosen</em>` : '')}</div>
        </div>
        <div class="text-end">
          ${pts ? html`<div class="pts small fw-semibold">${fmtPts(pts)} pts</div>` : ''}
          ${isConfig ? '' : html`<div class="unit-actions btn-group btn-group-sm mt-1">
            <button class="btn btn-outline-secondary" title="Duplicate" aria-label="Duplicate ${e.displayName(s)}"
              data-act="${this.actions.add((ev) => { ev.stopPropagation(); this.select(e.duplicate(s)); })}"><i class="bi bi-copy"></i></button>
            <button class="btn btn-outline-danger" title="Remove" aria-label="Remove ${e.displayName(s)}"
              data-act="${this.actions.add((ev) => { ev.stopPropagation(); this.removeUnit(s); })}"><i class="bi bi-trash"></i></button>
          </div>`}
        </div>
      </div>`;
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
      el.innerHTML = String(html`<div class="empty-state"><i class="bi bi-hand-index"></i>Select a unit to edit its options and view its datasheet.</div>`);
      return;
    }
    const pts = e.points(sel);
    const issues = e.issuesFor(sel);
    const isConfig = sel.def.type === 'upgrade';
    const options = this.optionsHtml(sel, 0);
    const models = e.modelCount(sel);

    el.innerHTML = String(html`
      <div class="card-header bg-body-tertiary">
        <div class="d-flex align-items-start gap-2">
          <div class="flex-grow-1" style="min-width:0">
            <input class="form-control form-control-sm roster-name-input px-1 w-100" value="${e.displayName(sel)}" aria-label="Unit name"
              placeholder="${e.evaluate(sel).name}" data-act="${this.actions.add((ev) => {
                const v = ev.target.value.trim();
                e.rename(sel, v === e.evaluate(sel).name ? '' : v);
              })}">
            <div class="small text-body-secondary px-1">
              ${sel.customName ? html`${e.evaluate(sel).name} · ` : ''}${sel.def.type === 'unit' && models ? `${models} model${models === 1 ? '' : 's'}` : isConfig ? 'Army configuration' : ''}
            </div>
          </div>
          <div class="text-end">
            <div class="fs-5 pts fw-bold text-accent">${fmtPts(pts)} pts</div>
            ${isConfig ? '' : html`<div class="btn-group btn-group-sm">
              <button class="btn btn-outline-secondary" title="Duplicate unit" data-act="${this.actions.add(() => this.select(e.duplicate(sel)))}"><i class="bi bi-copy"></i></button>
              <button class="btn btn-outline-danger" title="Remove unit" data-act="${this.actions.add(() => this.removeUnit(sel))}"><i class="bi bi-trash"></i></button>
            </div>`}
          </div>
        </div>
      </div>
      <div class="card-body">
        ${issues.map((i) => html`<div class="alert ${i.level === 'error' ? 'alert-danger' : 'alert-warning'} py-1 px-2 small mb-2"><i class="bi bi-exclamation-triangle"></i> ${i.message}</div>`)}
        ${options.length ? html`<h3 class="pane-title mb-2">Options</h3>${options}` : ''}
        ${isConfig ? '' : this.sheetHtml(sel)}
      </div>`);
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
      parts.unshift(html`<div class="small text-body-secondary mb-1"><i class="bi bi-check2"></i> Includes: ${fixed.map((o) => `${o.count > 1 ? o.count + '× ' : ''}${o.state.name}`).join(', ')}</div>`);
    }
    return parts;
  }

  costLabel(opt) {
    const c = opt.state.costs[this.pts] || 0;
    return c ? html`<span class="badge text-bg-secondary pts">+${fmtPts(c)}</span>` : '';
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
      control = html`<div class="form-check">
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
      <button class="btn btn-outline-secondary btn-sm" ${value <= 0 ? 'disabled' : ''} aria-label="Decrease ${label}"
        data-act="${this.actions.add(() => set(value - 1))}"><i class="bi bi-dash"></i></button>
      <input type="number" class="form-control form-control-sm mx-1" value="${value}" min="0" ${max !== Infinity ? raw(`max="${max}"`) : ''} aria-label="${label} count"
        data-act="${this.actions.add((ev) => set(ev.target.value))}">
      <button class="btn btn-outline-secondary btn-sm" ${value >= max ? 'disabled' : ''} aria-label="Increase ${label}"
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
          <label class="form-check-label text-body-secondary" for="${name}-none">None</label></div></div>`);
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
      <legend>${g.state.name} ${hint ? html`<span class="limit-hint text-lowercase">(${hint}${g.max > 1 ? `, ${g.count} chosen` : ''})</span>` : ''}</legend>
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
    const d = this.engine.describe(sel);
    if (!d.profiles.length && !d.rules.length) return '';
    const byType = new Map();
    for (const p of d.profiles) {
      if (!byType.has(p.typeName)) byType.set(p.typeName, []);
      byType.get(p.typeName).push(p);
    }
    const sections = [];
    const unitProfiles = byType.get('Unit') || [];
    for (const p of unitProfiles) {
      sections.push(html`
        ${unitProfiles.length > 1 ? html`<div class="small fw-semibold mb-1">${p.name}</div>` : ''}
        <div class="stat-line">${p.characteristics.map((c) => html`<div class="stat"><div class="k">${c.name}</div><div class="v">${c.value || '-'}</div></div>`)}</div>`);
    }
    for (const [type, list] of byType) {
      if (type === 'Unit') continue;
      const cols = list[0].characteristics.map((c) => c.name);
      if (cols.length <= 1) {
        sections.push(html`<h4 class="pane-title mt-3 mb-2">${type}</h4>
          ${list.map((p) => html`<div class="ability"><span class="ability-name">${p.name}:</span> ${richText(p.characteristics[0] ? p.characteristics[0].value : '')}</div>`)}`);
        continue;
      }
      sections.push(html`<h4 class="pane-title mt-3 mb-2">${type}</h4>
        <div class="table-responsive"><table class="table table-sm sheet-table">
          <thead><tr><th scope="col">${type.replace(/s$/, '')}</th>${cols.map((c) => html`<th scope="col">${c}</th>`)}</tr></thead>
          <tbody>${list.map((p) => html`<tr><td>${p.name}</td>${cols.map((c) => {
            const ch = p.characteristics.find((x) => x.name === c);
            return html`<td>${ch ? richText(ch.value) : ''}</td>`;
          })}</tr>`)}</tbody>
        </table></div>`);
    }
    if (d.rules.length) {
      sections.push(html`<h4 class="pane-title mt-3 mb-2">Rules</h4>
        ${d.rules.map((r) => html`<details class="rule"><summary>${r.name}</summary><div>${r.description ? richText(r.description) : html`<em>No description in data.</em>`}</div></details>`)}`);
    }
    if (d.keywords.length) {
      const faction = d.keywords.filter((k) => /^Faction:/i.test(k));
      const other = d.keywords.filter((k) => !/^Faction:/i.test(k));
      sections.push(html`<h4 class="pane-title mt-3 mb-2">Keywords</h4>
        <div class="keyword-badges d-flex flex-wrap gap-1">
          ${other.map((k) => html`<span class="badge text-bg-secondary">${k}</span>`)}
          ${faction.map((k) => html`<span class="badge bg-accent-subtle text-accent border border-accent">${k.replace(/^Faction:\s*/i, '')}</span>`)}
        </div>`);
    }
    return html`<hr><h3 class="pane-title mb-2">Datasheet</h3>${sections}`;
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
