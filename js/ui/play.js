// Play mode: a read-only view of a roster for use at the table. Units are shown with their
// attached leaders as one combined unit; tapping a unit shows its datacard with equipped
// weapon quantities, abilities, rules and keywords. A game tracker follows the battle round,
// phase, Command Points, wounds, and each unit's Destroyed / Below Half-strength / Battle-shock.

import { html, richText, Actions, fmtPts } from './html.js';
import { combinedDatasheetHtml } from './datasheet.js';
import { store } from './store.js';
import { PHASES, LAST_ROUND, newGame, unitState, strength, wound, start, nextPhase, prevPhase, resolveTest } from './game.js';

export class PlayView {
  /** @param {import('../engine/engine.js').RosterEngine} engine */
  constructor(app, engine) {
    this.app = app;
    this.engine = engine;
    this.root = app.root;
    this.actions = new Actions();
    this.selectedId = null;
    this.showArmyRules = false;
    this.game = { ...newGame(), ...(store.getGame(engine.roster.id) || {}) };
    this.collapsed = !!store.settings().playHeaderCollapsed;
    this.tracking = store.settings().playTracking !== false;
    this.unbindActions = this.actions.bind(this.root);
    this.render();
  }

  // ---------------------------------------------------------------- game tracker

  /** Register a handler that changes the game, then saves and redraws. */
  gameAct(fn) {
    return this.actions.add((ev) => {
      if (fn(ev) === false) return;
      store.saveGame(this.engine.roster.id, this.game);
      this.render();
    });
  }

  /** Models in a unit and its attached characters, by model type: [{ key, name, count, w }]. */
  modelGroups(unit) {
    const e = this.engine;
    const wOf = (sel) => {
      const p = e.describe(sel, { deep: false }).profiles.find((x) => x.typeName === 'Unit');
      const c = p && p.characteristics.find((x) => x.name.trim().toUpperCase() === 'W');
      return c ? parseInt(c.value, 10) || 0 : 0;
    };
    const groups = [];
    for (const m of this.orderedMembers(unit)) {
      const found = [];
      const walk = (s, mult) => {
        const n = mult * s.number;
        if (s.def.type === 'model') { found.push({ s, count: n }); return; }
        for (const c of s.children) walk(c, n);
      };
      walk(m, 1);
      if (!found.length) found.push({ s: m, count: m.number });
      for (const { s, count } of found) groups.push({ key: s.id, name: e.displayName(s), count, w: wOf(s) || wOf(m) || 1 });
    }
    return groups;
  }

  /** Tracker status of a shown unit (memoised per render). */
  status(unit) {
    let st = this._status.get(unit.id);
    if (!st) {
      st = strength(this.game, unit.id, this.modelGroups(unit));
      const u = this.game.units[unit.id] || {};
      st.shocked = !!u.shocked && !st.destroyed;
      st.test = !!u.test && !st.destroyed && !this.game.over;
      this._status.set(unit.id, st);
    }
    return st;
  }

  /** The player's units as the turn sequence needs them. */
  armyState(shown) {
    return shown.map((s) => { const st = this.status(s); return { id: s.id, belowHalf: st.belowHalf, destroyed: st.destroyed }; });
  }

  gameBarHtml(shown) {
    const g = this.game;
    if (!g.started) {
      return html`<div class="game-bar d-flex flex-wrap align-items-center gap-2 mt-2 pt-2 border-top">
        <span class="small opacity-75 me-1"><i class="bi bi-dice-5 me-1"></i>Track a game:</span>
        <button class="btn btn-sm btn-success" data-act="${this.gameAct(() => start(g, 'mine', this.armyState(shown)))}">I go first</button>
        <button class="btn btn-sm btn-outline-light" data-act="${this.gameAct(() => start(g, 'theirs', this.armyState(shown)))}">Opponent goes first</button>
      </div>`;
    }
    const mine = g.turn === 'mine';
    return html`<div class="game-bar mt-2 pt-2 border-top">
      <div class="d-flex flex-wrap align-items-center gap-2">
        <span class="fw-bold text-nowrap">Round ${g.round}<span class="opacity-50 fw-normal d-none d-sm-inline">/${LAST_ROUND}</span></span>
        ${g.over ? html`<span class="badge bg-info"><i class="bi bi-flag-fill me-1"></i>Battle over</span>`
          : html`<span class="badge ${mine ? 'bg-success' : 'bg-dark border'}">${mine ? 'Your turn' : "Opponent's turn"}</span>`}
        <div class="${g.over ? 'd-none' : 'd-flex'} align-items-center gap-1 text-nowrap ms-auto">
          <span class="small opacity-75">CP</span>
          <button class="btn btn-sm btn-outline-light py-0" aria-label="Spend 1 CP" ${g.cp <= 0 ? 'disabled' : ''}
            data-act="${this.gameAct(() => { g.cp = Math.max(0, g.cp - 1); })}"><i class="bi bi-dash"></i></button>
          <span class="fw-bold fs-5 cp-value" aria-live="polite">${g.cp}</span>
          <button class="btn btn-sm btn-outline-light py-0" aria-label="Gain 1 CP" data-act="${this.gameAct(() => { g.cp++; })}"><i class="bi bi-plus"></i></button>
        </div>
      </div>
      <div class="d-flex align-items-center gap-2 mt-2">
        <div class="btn-group btn-group-sm flex-grow-1 phase-bar" role="group" aria-label="Phase">
          <button class="btn btn-outline-light flex-grow-0" title="Previous phase" aria-label="Previous phase"
            data-act="${this.gameAct(() => prevPhase(g))}"><i class="bi bi-chevron-left"></i></button>
          <span class="btn btn-outline-light disabled phase-name">${g.over ? 'Battle over' : `${PHASES[g.phase]} phase`}</span>
          <button class="btn btn-warning flex-grow-0 text-nowrap" ${g.over ? 'disabled' : ''} data-act="${this.gameAct(() => nextPhase(g, this.armyState(shown)))}">Next <i class="bi bi-chevron-right"></i></button>
        </div>
        <button class="btn btn-sm btn-outline-danger text-nowrap" title="New game: clear the round, CP and all unit tracking" aria-label="New game"
          data-act="${this.gameAct(() => {
            if (!window.confirm('Start over? This clears the round, CP, wounds and statuses.')) return false;
            this.game = newGame();
            return true;
          })}"><i class="bi bi-arrow-counterclockwise"></i><span class="d-none d-md-inline ms-1">New game</span></button>
      </div>
    </div>
    ${this.pendingBanner(shown)}`;
  }

  /** Red notice while Battle-shock tests are waiting for a result. */
  pendingBanner(shown) {
    const pending = shown.filter((s) => this.status(s).test).length;
    return pending ? html`<div class="alert alert-danger py-2 px-3 mt-2 mb-0 small" role="status"><i class="bi bi-exclamation-octagon me-1"></i>
      ${pending} unit${pending === 1 ? '' : 's'} must take a Battle-shock test: mark each one passed or failed.</div>` : '';
  }

  /** Minimised header: one line with the game state and the Next button. */
  collapsedHeaderHtml(shown) {
    const g = this.game;
    const live = this.tracking && g.started;
    return html`<div class="px-3 py-2 border rounded bg-secondary mb-3 play-header">
      <div class="d-flex align-items-center gap-2">
        <button class="btn btn-sm btn-outline-light border-0 px-1" title="Show header" aria-label="Show header" aria-expanded="false"
          data-act="${this.actions.add(() => this.setCollapsed(false))}"><i class="bi bi-chevron-down"></i></button>
        <div class="flex-grow-1 small text-truncate" style="min-width:0">
          ${live
            ? html`<strong class="d-none d-sm-inline">${this.engine.roster.name} · </strong>${g.over
              ? html`<span class="fw-semibold">Battle over</span>`
              : html`<span class="opacity-75">R${g.round} · ${g.turn === 'mine' ? 'Your turn' : "Opponent's"} ·</span>
                <span class="fw-semibold">${PHASES[g.phase]}</span> <span class="opacity-75">· CP</span> <strong>${g.cp}</strong>`}`
            : html`<strong>${this.engine.roster.name}</strong>`}
        </div>
        ${live && !g.over ? html`<button class="btn btn-sm btn-warning text-nowrap" data-act="${this.gameAct(() => nextPhase(g, this.armyState(shown)))}">Next <i class="bi bi-chevron-right"></i></button>` : ''}
      </div>
      ${live ? this.pendingBanner(shown) : ''}
    </div>`;
  }

  setCollapsed(v) {
    this.collapsed = v;
    store.saveSettings({ playHeaderCollapsed: v });
    this.render();
  }

  /** Game tracking on/off; the game in progress is kept either way. */
  setTracking(v) {
    this.tracking = v;
    store.saveSettings({ playTracking: v });
    this.render();
  }

  statusBadges(st) {
    return html`${st.destroyed ? html`<span class="badge bg-dark border"><i class="bi bi-x-octagon me-1"></i>Destroyed</span>` : ''}
      ${st.belowHalf ? html`<span class="badge bg-warning text-dark">Below Half-strength</span>` : ''}
      ${st.shocked ? html`<span class="badge bg-danger"><i class="bi bi-lightning-fill me-1"></i>Battle-shocked</span>` : ''}`;
  }

  /** Passed / Failed buttons for a pending Battle-shock test. */
  shockTestHtml(unit) {
    return html`<div class="shock-test d-flex flex-wrap align-items-center gap-2 mt-2">
      <span class="small fw-bold text-danger"><i class="bi bi-exclamation-octagon me-1"></i>Battle-shock test</span>
      <button class="btn btn-sm btn-success" data-act="${this.gameAct(() => resolveTest(this.game, unit.id, true))}"><i class="bi bi-check-lg me-1"></i>Passed</button>
      <button class="btn btn-sm btn-danger" data-act="${this.gameAct(() => resolveTest(this.game, unit.id, false))}"><i class="bi bi-x-lg me-1"></i>Failed</button>
    </div>`;
  }

  /** Wound pips per model group, wound/heal buttons, and status switches. */
  trackerHtml(unit) {
    const st = this.status(unit);
    const u = this.game.units[unit.id] || {};
    const pips = (g) => {
      const out = [];
      if (g.hurt) out.push(html`<span class="pip hurt" title="${g.w - g.hurt} of ${g.w} wounds left">${g.w - g.hurt}</span>`);
      for (let i = 0; i < g.alive - (g.hurt ? 1 : 0); i++) out.push(html`<span class="pip" title="${g.w} wounds">${g.w > 1 ? g.w : ''}</span>`);
      for (let i = 0; i < g.dead; i++) out.push(html`<span class="pip dead" title="Destroyed"><i class="bi bi-x"></i></span>`);
      return out;
    };
    const toggle = (label, checked, auto, fn) => {
      const id = 'tg' + unit.id + label.replace(/\W/g, '');
      return html`<div class="form-check form-switch mb-0">
        <input class="form-check-input" type="checkbox" id="${id}" ${checked ? 'checked' : ''} ${auto ? 'disabled' : ''}
          data-act="${this.gameAct((ev) => fn(ev.target.checked))}">
        <label class="form-check-label" for="${id}" ${auto ? 'title="From the wounds tracked above"' : ''}>${label}</label></div>`;
    };
    const auto = strength({ units: { [unit.id]: { ...u, destroyed: false, belowHalf: false } } }, unit.id, st.groups);
    return html`<div class="tracker mb-3 p-2 rounded border ${st.test ? 'border-danger' : ''}">
      <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
        <h6 class="fw-bold text-primary mb-0 me-auto">Wounds
          <span class="small opacity-75 fw-normal ms-1">${st.alive}/${st.start} model${st.start === 1 ? '' : 's'} · ${st.remainingW}/${st.totalW} wounds</span></h6>
        ${this.statusBadges(st)}
      </div>
      ${st.groups.map((g) => html`<div class="tracker-group d-flex flex-wrap align-items-center gap-2 mb-2">
        <div class="small fw-semibold tracker-name">${g.name}${g.count > 1 ? ` ×${g.count}` : ''} <span class="opacity-75 fw-normal">W${g.w}</span></div>
        <div class="d-flex flex-wrap gap-1 flex-grow-1">${pips(g)}</div>
        <div class="btn-group btn-group-sm">
          <button class="btn btn-outline-light" title="Heal 1 wound" aria-label="Heal 1 wound on ${g.name}" ${g.dmg ? '' : 'disabled'}
            data-act="${this.gameAct(() => wound(this.game, unit.id, g, -1))}"><i class="bi bi-plus-lg"></i></button>
          <button class="btn btn-danger" title="Lose 1 wound" aria-label="${g.name} loses 1 wound" ${g.alive ? '' : 'disabled'}
            data-act="${this.gameAct(() => wound(this.game, unit.id, g, 1))}"><i class="bi bi-dash-lg"></i> 1</button>
        </div>
      </div>`)}
      ${st.test ? this.shockTestHtml(unit) : ''}
      <div class="d-flex flex-wrap gap-3 small mt-2">
        ${toggle('Destroyed', st.destroyed, auto.destroyed, (v) => { unitState(this.game, unit.id).destroyed = v; })}
        ${toggle('Below Half-strength', st.belowHalf || auto.belowHalf, auto.belowHalf, (v) => { unitState(this.game, unit.id).belowHalf = v; })}
        ${toggle('Battle-shocked', st.shocked, false, (v) => { const s = unitState(this.game, unit.id); s.shocked = v; if (v) s.test = false; })}
      </div>
    </div>`;
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
    this._status = new Map();
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
      ${this.collapsed ? this.collapsedHeaderHtml(shown) : html`<div class="px-3 py-2 border rounded bg-secondary mb-3 play-header">
        <div class="d-flex flex-wrap align-items-center column-gap-3 row-gap-2">
          <div class="d-flex align-items-center gap-1">
            <button class="btn btn-sm btn-outline-light border-0 px-1" title="Minimise header" aria-label="Minimise header" aria-expanded="true"
              data-act="${this.actions.add(() => this.setCollapsed(true))}"><i class="bi bi-chevron-up"></i></button>
            <a href="#/roster/${encodeURIComponent(r.id)}" class="btn btn-sm btn-outline-light text-nowrap" title="Back to the editor"><i class="bi bi-pencil-square me-1"></i>Edit List</a>
            <button class="btn btn-sm ${this.tracking ? 'btn-success' : 'btn-outline-light'} text-nowrap" aria-pressed="${this.tracking}"
              title="${this.tracking ? 'Turn game tracking off (your game is kept)' : 'Turn game tracking on: rounds, CP, wounds and Battle-shock'}"
              data-act="${this.actions.add(() => this.setTracking(!this.tracking))}"><i class="bi ${this.tracking ? 'bi-clipboard-check' : 'bi-clipboard'} me-1"></i>Track</button>
          </div>
          <div class="flex-grow-1" style="min-width:0">
            <div class="fw-bold text-truncate play-title"><i class="bi bi-play-fill text-warning"></i> ${r.name}</div>
            <small class="opacity-75 d-block text-truncate lh-sm">${r.catalogueName || ''}${battleSize ? ` • ${e.displayName(battleSize).replace(/^\d+\.\s*/, '')}` : ''}</small>
          </div>
          <div class="d-flex align-items-center gap-2" style="min-width:0">
            <span class="small text-truncate"><span class="opacity-75">Detachment${detachments.length > 1 ? 's' : ''}:</span>
              <span class="fw-semibold text-primary">${detachments.length ? detachments.map((d) => e.displayName(d)).join(', ') : 'None chosen'}</span></span>
            ${detachments.length ? html`<button class="btn btn-sm btn-outline-info text-nowrap py-0" aria-expanded="${this.showArmyRules}"
              data-act="${this.actions.add(() => { this.showArmyRules = !this.showArmyRules; this.render(); })}">${this.showArmyRules ? 'Hide' : 'Rules'}</button>` : ''}
          </div>
          <div class="d-flex align-items-center gap-2 ms-auto">
            ${errors ? html`<span class="small text-warning text-nowrap" title="${errors} list issue${errors === 1 ? '' : 's'}"><i class="bi bi-exclamation-triangle"></i> ${errors}</span>` : ''}
            <span class="badge bg-primary pts">${fmtPts(pts)}${limit != null ? ` / ${fmtPts(limit)}` : ''} pts</span>
          </div>
        </div>
        ${this.tracking ? this.gameBarHtml(shown) : ''}
        ${this.showArmyRules ? html`<div class="mt-3">${detachments.map((d) => {
          const info = e.describe(d);
          return html`<h6 class="fw-bold text-primary">${e.displayName(d)}</h6>
            ${info.rules.map((rule) => html`<details class="rule mb-1" open><summary>${rule.name}</summary><div>${richText(rule.description)}</div></details>`)}
            ${info.profiles.map((p) => html`<div class="mb-2"><span class="fw-bold">${p.name}</span>
              <div class="small opacity-75">${richText(p.characteristics.map((c) => c.value).join(' '))}</div></div>`)}`;
        })}</div>` : ''}
      </div>`}

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
    // Without game tracking the row just shows the unit's size.
    const st = this.tracking ? this.status(s) : strength(newGame(), s.id, this.modelGroups(s));
    const damaged = st.alive < st.start || st.remainingW < st.totalW;
    return html`
      <li class="list-group-item bg-dark text-light unit-list-item d-flex justify-content-between align-items-center py-3 border-bottom
        ${active ? 'selected' : ''} ${st.test ? 'shock-pending' : ''} ${st.destroyed ? 'unit-destroyed' : ''}"
        tabindex="0" role="button" aria-expanded="${active}" data-unit="${s.id}" data-act="${this.actions.add(() => this.select(s.id))}">
        <div class="me-2" style="min-width:0">
          <div class="fw-bold text-primary">${this.unitLabel(s)}</div>
          ${members.length > 1 ? html`<small class="d-block text-info"><i class="bi bi-people-fill"></i> Led by ${members.slice(1).map((m) => e.displayName(m)).join(', ')}</small>` : ''}
          <small class="opacity-75">${st.start ? (damaged ? `${st.alive}/${st.start} models` : `${st.start} model${st.start === 1 ? '' : 's'}`) : ''}${damaged && st.start === 1 ? ` • ${st.remainingW}/${st.totalW} wounds` : ''}</small>
          ${st.destroyed || st.belowHalf || st.shocked ? html`<div class="d-flex flex-wrap gap-1 mt-1">${this.statusBadges(st)}</div>` : ''}
          ${st.test ? this.shockTestHtml(s) : ''}
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
      ${this.tracking ? this.trackerHtml(unit) : ''}
      ${combinedDatasheetHtml(entries)}`;
  }
}
