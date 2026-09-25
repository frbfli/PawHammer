// Play mode: a read-only view of a roster for use at the table. Units are shown with their
// attached leaders as one combined unit; tapping a unit shows its datacard with equipped
// weapon quantities, abilities, rules and keywords.

import { html, richText, Actions, fmtPts } from './html.js';
import { combinedDatasheetHtml } from './datasheet.js';

export class PlayView {
  /** @param {import('../engine/engine.js').RosterEngine} engine */
  constructor(app, engine) {
    this.app = app;
    this.engine = engine;
    this.root = app.root;
    this.actions = new Actions();
    this.selectedId = null;
    this.showArmyRules = false;
    this.unbindActions = this.actions.bind(this.root);
    this.render();
  }

  destroy() { this.unbindActions(); }

  get force() { return this.engine.roster.forces[0]; }

  isPhone() { return window.matchMedia('(max-width: 991.98px)').matches; }

  /** Leaders attached to a unit are shown inside that unit, not on their own. */
  isAttachedLeader(s) {
    return this.engine.attachmentsOf(s).some((a) => this.engine.findSelection(a.targetId));
  }

  members(unit) { return [unit, ...this.engine.leadersOf(unit)]; }

  unitLabel(s) {
    const e = this.engine;
    const name = e.displayName(s);
    const same = s.force.selections.filter((x) => x.def.type !== 'upgrade' && e.displayName(x) === name);
    return same.length > 1 ? `${name} (${same.indexOf(s) + 1})` : name;
  }

  /** Chosen entries under a configuration selection, e.g. the detachment(s). */
  chosenIn(name) {
    const sel = this.force && this.force.selections.find((s) => s.def.name === name);
    if (!sel) return [];
    const out = [];
    const walk = (s) => { for (const c of s.children) { out.push(c); walk(c); } };
    walk(sel);
    return out;
  }

  /** Warlord / enhancement badges for a character. */
  honours(sel) {
    const out = [];
    const walk = (s) => {
      for (const c of s.children) {
        if (/^warlord$/i.test(c.def.name)) out.push({ kind: 'warlord', name: 'Warlord' });
        else if (c.groupPath.some((g) => /enhancement/i.test(g.name))) out.push({ kind: 'enhancement', name: this.engine.displayName(c) });
        walk(c);
      }
    };
    walk(sel);
    return out;
  }

  select(id) {
    this.selectedId = this.selectedId === id && this.isPhone() ? null : id;
    this.render();
    if (this.selectedId && this.isPhone()) {
      const row = this.root.querySelector(`[data-unit="${this.selectedId}"]`);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  render() {
    this.actions.clear();
    const e = this.engine;
    const r = e.roster;
    const pts = e.points();
    const limit = e.costLimits()[e.ptsTypeId];
    const detachments = this.chosenIn('Detachment');
    const battleSize = this.chosenIn('Battle Size')[0];
    const units = this.force ? this.force.selections.filter((s) => s.def.type !== 'upgrade') : [];
    const shown = units.filter((s) => !this.isAttachedLeader(s));
    if (this.selectedId && !shown.some((s) => s.id === this.selectedId)) this.selectedId = null;
    if (!this.selectedId && !this.isPhone() && shown.length) this.selectedId = shown[0].id;
    const selected = shown.find((s) => s.id === this.selectedId) || null;
    const errors = e.validate().filter((i) => i.level === 'error').length;

    this.root.innerHTML = String(html`
      <div class="p-3 border rounded bg-secondary mb-4">
        <div class="d-flex flex-wrap align-items-center gap-2">
          <a href="#/roster/${encodeURIComponent(r.id)}" class="btn btn-sm btn-outline-light" title="Back to the editor"><i class="bi bi-pencil-square me-1"></i>Edit List</a>
          <div class="flex-grow-1" style="min-width:0">
            <h4 class="fw-bold mb-0 text-truncate"><i class="bi bi-play-fill text-warning"></i> ${r.name}</h4>
            <small class="opacity-75">${r.catalogueName || ''}${battleSize ? ` • ${e.displayName(battleSize).replace(/^\d+\.\s*/, '')}` : ''}</small>
          </div>
          <div class="text-end">
            <span class="badge bg-primary fs-6 pts">${fmtPts(pts)}${limit != null ? ` / ${fmtPts(limit)}` : ''} pts</span>
            ${errors ? html`<div class="small text-warning mt-1"><i class="bi bi-exclamation-triangle"></i> ${errors} list issue${errors === 1 ? '' : 's'}</div>` : ''}
          </div>
        </div>
        <div class="alert alert-dark d-flex justify-content-between align-items-center py-2 px-3 mt-3 mb-0 gap-2">
          <div style="min-width:0">
            <small class="opacity-75 d-block">Detachment${detachments.length > 1 ? 's' : ''}:</small>
            <span class="fw-semibold text-primary">${detachments.length ? detachments.map((d) => e.displayName(d)).join(', ') : 'None chosen'}</span>
          </div>
          ${detachments.length ? html`<button class="btn btn-sm btn-outline-info text-nowrap" aria-expanded="${this.showArmyRules}"
            data-act="${this.actions.add(() => { this.showArmyRules = !this.showArmyRules; this.render(); })}">${this.showArmyRules ? 'Hide' : 'Rules'}</button>` : ''}
        </div>
        ${this.showArmyRules ? html`<div class="mt-3">${detachments.map((d) => {
          const info = e.describe(d);
          return html`<h6 class="fw-bold text-primary">${e.displayName(d)}</h6>
            ${info.rules.map((rule) => html`<details class="rule mb-1" open><summary>${rule.name}</summary><div>${richText(rule.description)}</div></details>`)}
            ${info.profiles.map((p) => html`<div class="mb-2"><span class="fw-bold">${p.name}</span>
              <div class="small opacity-75">${richText(p.characteristics.map((c) => c.value).join(' '))}</div></div>`)}`;
        })}</div>` : ''}
      </div>

      <div class="row g-4">
        <div class="col-lg-5">
          <div class="p-3 border rounded bg-secondary pane">
            <div class="d-flex justify-content-between align-items-center border-bottom pb-2 mb-3">
              <h5 class="mb-0 fw-bold">Army</h5>
              <span class="badge bg-primary">${shown.length} unit${shown.length === 1 ? '' : 's'}</span>
            </div>
            <p class="small opacity-75 mb-2"><i class="bi bi-hand-index me-1"></i>Tap a unit to see its datacard.</p>
            ${shown.length ? e.groupedSelections(this.force).map((grp) => {
              const list = grp.selections.filter((s) => shown.includes(s));
              if (!list.length) return '';
              return html`<div class="list-cat-heading"><span>${grp.name}</span></div>
                <ul class="list-group mb-2">${list.map((s) => this.unitRow(s, s === selected))}</ul>`;
            }) : html`<ul class="list-group"><li class="list-group-item bg-dark text-light text-center opacity-75 py-4">No units in this roster yet.</li></ul>`}
          </div>
        </div>
        <div class="col-lg-7 d-none d-lg-block">
          <div class="p-3 border rounded bg-secondary pane">
            ${selected ? this.cardHtml(selected) : html`<div class="empty-state"><i class="bi bi-hand-index"></i>Select a unit to see its datacard.</div>`}
          </div>
        </div>
      </div>`);
  }

  unitRow(s, active) {
    const e = this.engine;
    const members = this.members(s);
    const total = members.reduce((n, m) => n + e.points(m), 0);
    const models = members.reduce((n, m) => n + e.modelCount(m), 0);
    return html`
      <li class="list-group-item bg-dark text-light unit-list-item d-flex justify-content-between align-items-center py-3 border-bottom ${active ? 'selected' : ''}"
        tabindex="0" role="button" aria-expanded="${active}" data-unit="${s.id}" data-act="${this.actions.add(() => this.select(s.id))}">
        <div class="me-2" style="min-width:0">
          <div class="fw-bold text-primary">${this.unitLabel(s)}</div>
          ${members.length > 1 ? html`<small class="d-block text-info"><i class="bi bi-people-fill"></i> Led by ${members.slice(1).map((m) => e.displayName(m)).join(', ')}</small>` : ''}
          <small class="opacity-75">${models ? `${models} model${models === 1 ? '' : 's'}` : ''}</small>
        </div>
        <div class="d-flex align-items-center gap-2">
          <span class="badge bg-primary rounded-pill pts">${fmtPts(total)} pts</span>
          <i class="bi ${active ? 'bi-chevron-up' : 'bi-chevron-down'} d-lg-none opacity-75"></i>
        </div>
      </li>
      ${active ? html`<li class="list-group-item bg-secondary text-light d-lg-none py-3 px-2">${this.cardHtml(s)}</li>` : ''}`;
  }

  /** Role of an attached character on `unit`: the association it uses (e.g. "Leading", "Supporting"). */
  roleOf(m, unit) {
    const e = this.engine;
    return e.associationDefs(m).find((a) => e.attachmentsOf(m).some((x) => x.assocId === a.id && x.targetId === unit.id)) || null;
  }

  /** Combined-unit members in datacard order: leaders, then support characters, then the bodyguard unit. */
  orderedMembers(unit) {
    const rank = (m) => {
      if (m === unit) return 3;
      const role = this.roleOf(m, unit);
      const name = role ? `${role.name || ''} ${role.label || ''}` : '';
      return /lead/i.test(name) ? 0 : /support/i.test(name) ? 1 : 2;
    };
    return this.members(unit).map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
  }

  /** Datacard for a unit and every character attached to it, combined into one card. */
  cardHtml(unit) {
    const e = this.engine;
    const members = this.orderedMembers(unit);
    const total = members.reduce((n, m) => n + e.points(m), 0);
    const models = members.reduce((n, m) => n + e.modelCount(m), 0);
    const nameOf = (m) => (m === unit ? this.unitLabel(m) : e.displayName(m));
    const entries = members.map((m) => {
      const role = m === unit ? null : this.roleOf(m, unit);
      const honours = this.honours(m);
      return {
        name: nameOf(m),
        info: e.describe(m),
        header: html`<span class="d-flex flex-wrap align-items-center gap-1">
          ${members.length > 1 ? (role
            ? html`<span class="badge bg-info">${role.name || role.label}</span>`
            : html`<span class="badge bg-dark border">Bodyguard</span>`) : ''}
          ${honours.map((h) => (h.kind === 'warlord'
            ? html`<span class="badge bg-warning text-dark"><i class="bi bi-star-fill me-1"></i>Warlord</span>`
            : html`<span class="badge bg-success"><i class="bi bi-gem me-1"></i>${h.name}</span>`))}
          ${members.length > 1 ? html`<span class="badge bg-primary rounded-pill pts">${fmtPts(e.points(m))} pts</span>` : ''}
        </span>`,
      };
    });
    return html`
      <div class="bg-primary text-white rounded p-3 mb-3 d-flex justify-content-between align-items-start gap-2">
        <div style="min-width:0">
          <h5 class="fw-bold mb-0">${members.map(nameOf).join(' + ')}</h5>
          <small class="opacity-75">${models ? `${models} model${models === 1 ? '' : 's'}` : ''}${members.length > 1 ? ' • attached unit' : ''}</small>
        </div>
        <div class="fs-5 fw-bold pts">${fmtPts(total)} pts</div>
      </div>
      ${combinedDatasheetHtml(entries)}`;
  }
}
