// RosterEngine: evaluates BattleScribe-style modifiers, conditions, constraints and costs
// against a Roster built from BSData game data, and provides the mutation API used by the UI.

import { arr } from './gamedata.js';
import { Roster, Force, Selection, VirtualSelection } from './roster.js';

const COMPARE = {
  lessThan: (a, b) => a < b,
  greaterThan: (a, b) => a > b,
  equalTo: (a, b) => a === b,
  notEqualTo: (a, b) => a !== b,
  atLeast: (a, b) => a >= b,
  atMost: (a, b) => a <= b,
};

const TYPE_SCOPES = {
  unit: ['unit'],
  model: ['model'],
  upgrade: ['upgrade'],
  'model-or-unit': ['model', 'unit'],
  'unit-self': ['unit'],
};

function numericOp(cur, m, times) {
  const v = Number(m.value);
  const c = Number(cur) || 0;
  switch (m.type) {
    case 'set': return isNaN(v) ? c : v;
    case 'increment': return c + v * times;
    case 'decrement': return c - v * times;
    case 'multiply': return c * Math.pow(v, times);
    case 'divide': return v ? c / Math.pow(v, times) : c;
    case 'floor': return Math.floor(c);
    case 'ceil': case 'ceiling': return Math.ceil(c);
    default: return c;
  }
}

function textOp(cur, m, times = 1) {
  const value = m.value == null ? '' : String(m.value);
  const text = cur == null ? '' : String(cur);
  switch (m.type) {
    case 'set': return value;
    case 'append': return text ? text + (m.join != null ? m.join : ' ') + value : value;
    case 'prepend': return text ? value + (m.join != null ? m.join : ' ') + text : value;
    case 'replace': return m.arg != null ? text.split(String(m.arg)).join(value) : value;
    case 'increment': case 'decrement': case 'multiply': case 'divide': case 'floor': case 'ceil': {
      // Characteristics like `6"` or `3+`: modify the leading number, keep the suffix.
      const match = /^(-?\d+(?:\.\d+)?)(.*)$/.exec(text.trim());
      if (!match) return text;
      return String(numericOp(Number(match[1]), m, times)) + match[2];
    }
    default: return text;
  }
}

/** Wrap a raw node (category link, category entry, cost type, force entry) so it looks like an EntryDef. */
function rawOwner(raw) {
  const costs = {};
  for (const c of arr(raw.costs)) costs[c.typeId] = Number(c.value) || 0;
  return {
    name: raw.name,
    hidden: !!raw.hidden,
    costs,
    constraints: arr(raw.constraints),
    modifiers: arr(raw.modifiers),
    modifierGroups: arr(raw.modifierGroups),
    categoryIds: [],
    primaryCategoryId: null,
  };
}

export class RosterEngine {
  /** @param {import('./gamedata.js').GameData} data @param {Roster} roster */
  constructor(data, roster) {
    this.data = data;
    this.roster = roster;
    this.listeners = new Set();
    this.loadWarnings = [];
    this.rev = 0;
    this._reset();
  }

  static create(data, { name, forceEntryId } = {}) {
    const cat = data.primaryCatalogue;
    const roster = new Roster({
      name: name || cat.name,
      gameSystemId: data.gameSystem.id,
      catalogueId: cat.id,
      catalogueName: cat.name,
    });
    const engine = new RosterEngine(data, roster);
    const forces = data.forceEntries.filter((f) => !f.hidden);
    const fe = forces.find((f) => f.id === forceEntryId) || forces[0];
    if (fe) engine.addForce(fe, cat.id);
    return engine;
  }

  // ---------------------------------------------------------------- change tracking

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _reset() {
    this._memo = new Map();
    this._totals = new Map();
    this._inProgress = new Set();
    this._validation = null;
  }

  _changed() {
    this.rev++;
    this.roster.updatedAt = Date.now();
    this._reset();
    for (const fn of this.listeners) fn(this);
  }

  // ---------------------------------------------------------------- tree helpers

  _parentOf(node) {
    if (!node) return null;
    if (node.isSelection) return node.parent;
    if (node.isForce) return node.roster;
    return null;
  }

  _forceOf(node) {
    if (!node) return null;
    if (node.isSelection) return node.force;
    if (node.isForce) return node;
    return null;
  }

  _chain(node) {
    const out = [];
    for (let n = node; n; n = this._parentOf(n)) out.push(n);
    return out;
  }

  _childrenOf(node) {
    if (!node) return [];
    if (node.isRoster) return node.forces.flatMap((f) => f.selections);
    if (node.isForce) return node.selections;
    return node.children || [];
  }

  *walk(node = this.roster) {
    for (const c of this._childrenOf(node)) {
      yield c;
      yield* this.walk(c);
    }
  }

  findSelection(id) {
    for (const s of this.walk()) if (s.id === id) return s;
    return null;
  }

  // ---------------------------------------------------------------- conditions

  _scopeTargets(self, scope) {
    switch (scope || 'self') {
      case 'self': return [self];
      case 'parent': { const p = this._parentOf(self); return p ? [p] : []; }
      case 'force': { const f = this._forceOf(self); return f ? [f] : []; }
      case 'roster': return [this.roster];
      case 'root-entry': return self.isSelection ? [self.rootEntry] : [self];
      case 'ancestor': return this._chain(self).slice(1);
      case 'primary-catalogue': return [{ isCatalogue: true, id: this.roster.catalogueId }];
      default: {
        const types = TYPE_SCOPES[scope];
        if (types) {
          const t = this._chain(self).find((n) => n.isSelection && types.includes(n.def.type));
          return t ? [t] : [];
        }
        const t = this._chain(self).find((n) =>
          n.isSelection ? n.def.matches(scope)
            : n.isForce ? n.forceEntry.id === scope || n.catalogueId === scope
              : n.isRoster ? n.gameSystemId === scope : false);
        return t ? [t] : [];
      }
    }
  }

  categoriesOf(sel) {
    if (this._inProgress.has(sel.id)) return new Set(sel.def.categoryIds);
    return this.evaluate(sel).categories;
  }

  _matchSelection(sel, childId) {
    if (!childId || childId === 'any') return true;
    if (childId === 'model' || childId === 'unit' || childId === 'upgrade') return sel.def.type === childId;
    if (sel.def.matches(childId)) return true;
    if (sel.groupPath.some((g) => g.matches(childId))) return true;
    return this.categoriesOf(sel).has(childId);
  }

  _matchForce(force, childId) {
    return !childId || childId === 'any' || force.forceEntry.id === childId || force.catalogueId === childId;
  }

  _instanceOf(target, childId) {
    if (!target) return false;
    if (target.isCatalogue) return target.id === childId;
    if (target.isSelection) return this._matchSelection(target, childId);
    if (target.isForce) return this._matchForce(target, childId);
    if (target.isRoster) {
      return childId === 'roster' || target.gameSystemId === childId ||
        target.forces.some((f) => f.forceEntry.id === childId);
    }
    return false;
  }

  _countSelections(node, pred, deep) {
    let n = 0;
    for (const c of this._childrenOf(node)) {
      if (pred(c)) n += c.number;
      if (deep) n += c.number * this._countSelections(c, pred, deep);
    }
    return n;
  }

  _isCostType(id) { return this.data.costTypes.some((t) => t.id === id); }

  /** Measure `field` (selections / forces / cost type) of `childId` within target. */
  _count(target, spec) {
    if (!target || target.isCatalogue) return 0;
    const field = spec.field || 'selections';
    const childId = spec.childId || 'any';
    const deep = !!spec.includeChildSelections;
    if (field === 'selections') {
      if (target.isRoster && !deep) {
        return target.forces.reduce((n, f) => n + this._countSelections(f, (s) => this._matchSelection(s, childId), false), 0);
      }
      return this._countSelections(target, (s) => this._matchSelection(s, childId), deep);
    }
    if (field === 'forces') {
      if (!target.isRoster) return 0;
      return target.forces.filter((f) => this._matchForce(f, childId)).length;
    }
    if (field === 'associations') return 0; // leader/attachment associations are not modelled
    if (this._isCostType(field)) {
      if (childId !== 'any') {
        let total = 0;
        for (const s of this.walk(target)) if (this._matchSelection(s, childId)) total += this.totalCost(s, field);
        return total;
      }
      return this.totalCost(target, field);
    }
    return 0;
  }

  _checkCondition(c, self) {
    if (c.type === 'instanceOf' || c.type === 'notInstanceOf') {
      const targets = this._scopeTargets(self, c.scope);
      const hit = targets.some((t) => this._instanceOf(t, c.childId));
      return c.type === 'instanceOf' ? hit : !hit;
    }
    const cmp = COMPARE[c.type];
    if (!cmp) return false; // e.g. 'before' (publication dates) is not supported
    const value = Number(c.value);
    const targets = this._scopeTargets(self, c.scope);
    if (!targets.length) return cmp(0, value);
    return targets.some((t) => cmp(this._count(t, c), value));
  }

  _checkGroup(g, self) {
    const tests = [
      ...arr(g.conditions).map((c) => () => this._checkCondition(c, self)),
      ...arr(g.conditionGroups).map((cg) => () => this._checkGroup(cg, self)),
    ];
    if (!tests.length) return true;
    return g.type === 'or' ? tests.some((t) => t()) : tests.every((t) => t());
  }

  _conditionsPass(m, self) {
    return arr(m.conditions).every((c) => this._checkCondition(c, self)) &&
      arr(m.conditionGroups).every((g) => this._checkGroup(g, self));
  }

  _repeatTimes(m, self) {
    const reps = arr(m.repeats);
    if (!reps.length) return 1;
    let total = 0;
    for (const r of reps) {
      const targets = this._scopeTargets(self, r.scope);
      const count = targets.length ? this._count(targets[0], r) : 0;
      const per = Number(r.value) || 1;
      const n = r.roundUp ? Math.ceil(count / per) : Math.floor(count / per);
      total += n * (Number(r.repeats) || 1);
    }
    return total;
  }

  // ---------------------------------------------------------------- modifiers

  _baseState(owner) {
    return {
      name: owner.name,
      hidden: !!owner.hidden,
      costs: { ...owner.costs },
      constraints: owner.constraints.map((c) => ({ ...c, value: Number(c.value) })),
      categories: new Set(owner.categoryIds),
      primaryCategory: owner.primaryCategoryId,
      errors: [],
      warnings: [],
      annotations: [],
      defaultAmount: null,
    };
  }

  _applyModifiers(state, mods, groups, self) {
    for (const m of mods) this._applyModifier(state, m, self);
    for (const g of groups) {
      if (!this._conditionsPass(g, self)) continue;
      this._applyModifiers(state, arr(g.modifiers), arr(g.modifierGroups), self);
    }
  }

  _applyModifier(state, m, self) {
    if (m.affects) return; // modifiers targeting other objects (NewRecruit extension) are not supported
    if (!this._conditionsPass(m, self)) return;
    const times = this._repeatTimes(m, self);
    if (times <= 0) return;
    const { field, type, value } = m;
    switch (field) {
      case 'hidden':
        if (type === 'set') state.hidden = value === true || value === 'true';
        return;
      case 'name':
        state.name = textOp(state.name, m, times);
        return;
      case 'category':
        if (type === 'add') state.categories.add(value);
        else if (type === 'remove') state.categories.delete(value);
        else if (type === 'set-primary') { state.primaryCategory = value; state.categories.add(value); }
        else if (type === 'unset-primary' && state.primaryCategory === value) state.primaryCategory = null;
        return;
      case 'error': state.errors.push(String(value)); return;
      case 'warning': state.warnings.push(String(value)); return;
      case 'annotation': state.annotations.push(String(value)); return;
      case 'defaultAmount': state.defaultAmount = Number(value); return;
      case 'readme': case 'page': case 'publication': return;
      default: break;
    }
    if (type === 'set-primary' || type === 'unset-primary') {
      if (type === 'set-primary') { state.primaryCategory = value; state.categories.add(value); }
      else if (state.primaryCategory === value) state.primaryCategory = null;
      return;
    }
    if (field in state.costs) { state.costs[field] = numericOp(state.costs[field], m, times); return; }
    const con = state.constraints.find((c) => c.id === field);
    if (con) { con.value = numericOp(con.value, m, times); return; }
    if (this._isCostType(field)) { state.costs[field] = numericOp(0, m, times); return; }
    if (state.characteristics) {
      const ch = state.characteristics.find((c) => c.typeId === field || c.name === field);
      if (ch) ch.value = textOp(ch.value, m, times);
    }
  }

  /** Evaluated state of an existing or virtual selection. */
  evaluate(sel) {
    const hit = this._memo.get(sel.id);
    if (hit) return hit;
    if (this._inProgress.has(sel.id)) return this._baseState(sel.def);
    this._inProgress.add(sel.id);
    const state = this._baseState(sel.def);
    try {
      this._applyModifiers(state, sel.def.modifiers, sel.def.modifierGroups, sel);
    } finally {
      this._inProgress.delete(sel.id);
    }
    this._memo.set(sel.id, state);
    return state;
  }

  /** Evaluate a raw owner (category link, category entry, cost type) with `self` as context. */
  _evaluateRaw(raw, self, key) {
    const memoKey = 'raw:' + key;
    const hit = this._memo.get(memoKey);
    if (hit) return hit;
    const owner = rawOwner(raw);
    const state = this._baseState(owner);
    this._applyModifiers(state, owner.modifiers, owner.modifierGroups, self);
    this._memo.set(memoKey, state);
    return state;
  }

  displayName(sel) {
    return sel.customName || this.evaluate(sel).name;
  }

  // ---------------------------------------------------------------- costs

  ownCost(sel, typeId) { return this.evaluate(sel).costs[typeId] || 0; }

  totalCost(node, typeId) {
    const key = (node.id || 'roster') + '|' + typeId;
    const hit = this._totals.get(key);
    if (hit !== undefined) return hit;
    let total = 0;
    if (node.isRoster) total = node.forces.reduce((n, f) => n + this.totalCost(f, typeId), 0);
    else if (node.isForce) total = node.selections.reduce((n, s) => n + this.totalCost(s, typeId), 0);
    else if (node.isSelection) {
      if (node.virtual) total = this.ownCost(node, typeId);
      else total = node.number * (this.ownCost(node, typeId) + node.children.reduce((n, c) => n + this.totalCost(c, typeId), 0));
    }
    this._totals.set(key, total);
    return total;
  }

  get ptsTypeId() { return this.data.ptsTypeId; }

  points(node = this.roster) { return this.totalCost(node, this.ptsTypeId); }

  /** Cost types that are visible for this roster (e.g. pts, Detachment Points). */
  visibleCostTypes() {
    return this.data.costTypes.filter((t) => {
      const st = this._evaluateRaw(t, this.roster, 'costType:' + t.id);
      return !st.hidden;
    });
  }

  costLimits() {
    const limits = { ...this.roster.costLimits };
    const detected = this.detectPointsLimit();
    if (detected != null && this.ptsTypeId) limits[this.ptsTypeId] = detected;
    return limits;
  }

  /** Points limit from the data's Battle Size configuration, if selected. */
  detectPointsLimit() {
    let fromName = null;
    for (const s of this.walk()) {
      if (/^points limit$/i.test(s.def.name) && s.number > 0) return s.number;
      const m = /\(([\d,]+)\s*points?\s*limit\)/i.exec(this.evaluate(s).name || s.def.name);
      if (m && fromName == null) fromName = Number(m[1].replace(/,/g, ''));
    }
    return fromName;
  }

  modelCount(sel) {
    const self = sel.def.type === 'model' ? 1 : 0;
    return sel.number * (self + sel.children.reduce((n, c) => n + (c.def.type === 'model' || c.children.length ? this.modelCount(c) : 0), 0));
  }

  // ---------------------------------------------------------------- options

  /** Candidate child entries for a parent (Force -> root entries, Selection -> its children). */
  _optionSource(parent) {
    if (parent.isForce) {
      const cat = this.data.catalogues.find((c) => c.id === parent.catalogueId) || this.data.primaryCatalogue;
      const roots = this.data.rootEntries(cat);
      const allowed = new Set(arr(parent.forceEntry.categoryLinks).map((c) => c.targetId));
      const entries = roots.filter((d) => {
        const p = d.primaryCategoryId || d.categoryIds[0];
        return !allowed.size || !p || allowed.has(p);
      });
      return { entries, groups: [] };
    }
    return parent.def.children;
  }

  _existingOrVirtual(parent, def, groupPath) {
    const existing = this._childrenOf(parent).find((c) => c.def === def) ||
      this._childrenOf(parent).find((c) => c.def.id === def.id);
    return existing || new VirtualSelection(def, parent, groupPath);
  }

  _limits(state, scopes) {
    let min = 0;
    let max = Infinity;
    for (const c of state.constraints) {
      if ((c.field || 'selections') !== 'selections' || !scopes.includes(c.scope)) continue;
      if (c.type === 'min' && c.value > min) min = c.value;
      if (c.type === 'max' && c.value >= 0 && c.value < max) max = c.value;
    }
    return { min, max };
  }

  /**
   * Option tree for a parent node. Each entry option:
   *   { def, groupPath, state, hidden, count, min, max, selections }
   * Each group option: { def, groupPath, state, hidden, count, min, max, entries, groups }
   */
  optionTree(parent) {
    const memoKey = 'opts:' + parent.id;
    const hit = this._memo.get(memoKey);
    if (hit) return hit;
    const engine = this;
    const lazy = (def) => ({ get state() { return this._state || (this._state = engine._baseState(def)); } });
    const build = (source, groupPath, parentHidden) => {
      if (parentHidden) {
        // Everything below a hidden group is hidden: skip modifier evaluation entirely.
        const kids = this._childrenOf(parent);
        return {
          entries: source.entries.map((def) => {
            const selections = kids.filter((c) => c.def === def);
            return Object.assign(lazy(def), { def, groupPath, hidden: true, count: selections.reduce((n, s) => n + s.number, 0), min: 0, max: Infinity, selections });
          }),
          groups: source.groups.map((g) => {
            const inner = build(g.children, [...groupPath, g], true);
            return Object.assign(lazy(g), { def: g, groupPath, hidden: true, count: 0, min: 0, max: Infinity, entries: inner.entries, groups: inner.groups });
          }),
        };
      }
      const entries = source.entries.map((def) => {
        const probe = this._existingOrVirtual(parent, def, groupPath);
        const state = this.evaluate(probe);
        const selections = this._childrenOf(parent).filter((c) => c.def === def ||
          (c.def.id === def.id && c.groupPath.length === groupPath.length));
        const count = selections.reduce((n, s) => n + s.number, 0);
        const { min, max } = this._limits(state, parent.isForce ? ['parent', 'force', 'roster'] : ['parent']);
        return { def, groupPath, state, hidden: parentHidden || state.hidden, count, min, max, selections };
      });
      const groups = source.groups.map((g) => {
        const gp = [...groupPath, g];
        const probe = new VirtualSelection(g, parent, groupPath);
        const state = this.evaluate(probe);
        const hidden = parentHidden || state.hidden;
        const count = this._childrenOf(parent).filter((c) => c.inGroup(g)).reduce((n, s) => n + s.number, 0);
        const { min, max } = this._limits(state, ['parent']);
        const inner = build(g.children, gp, hidden);
        return { def: g, groupPath, state, hidden, count, min, max, entries: inner.entries, groups: inner.groups };
      });
      return { entries, groups };
    };
    const tree = build(this._optionSource(parent), [], false);
    this._memo.set(memoKey, tree);
    return tree;
  }

  /** Root entries for the "add unit" list, grouped by primary category in force order. */
  addableUnits(force) {
    const tree = this.optionTree(force);
    const catOrder = arr(force.forceEntry.categoryLinks).map((c) => c.targetId);
    const groups = new Map();
    for (const opt of tree.entries) {
      if (opt.hidden) continue;
      const cid = opt.state.primaryCategory || opt.def.primaryCategoryId || 'other';
      if (!groups.has(cid)) groups.set(cid, []);
      groups.get(cid).push(opt);
    }
    return [...groups.entries()]
      .map(([cid, options]) => ({
        categoryId: cid,
        name: cid === 'other' ? 'Other' : (this.data.categories.get(cid) || {}).name || 'Other',
        order: catOrder.indexOf(cid) === -1 ? 999 : catOrder.indexOf(cid),
        options: options.sort((a, b) => a.state.name.localeCompare(b.state.name)),
      }))
      .sort((a, b) => a.order - b.order);
  }

  /** Force selections grouped by primary category. */
  groupedSelections(force) {
    const catOrder = arr(force.forceEntry.categoryLinks).map((c) => c.targetId);
    const groups = new Map();
    for (const sel of force.selections) {
      const st = this.evaluate(sel);
      const cid = st.primaryCategory || sel.def.primaryCategoryId || 'other';
      if (!groups.has(cid)) groups.set(cid, []);
      groups.get(cid).push(sel);
    }
    return [...groups.entries()]
      .map(([cid, selections]) => ({
        categoryId: cid,
        name: cid === 'other' ? 'Other' : (this.data.categories.get(cid) || {}).name || 'Other',
        order: catOrder.indexOf(cid) === -1 ? 999 : catOrder.indexOf(cid),
        selections,
      }))
      .sort((a, b) => a.order - b.order);
  }

  // ---------------------------------------------------------------- mutations

  addForce(forceEntry, catalogueId = this.roster.catalogueId) {
    const force = new Force(this.roster, forceEntry, catalogueId);
    this.roster.forces.push(force);
    this._reset();
    this._autofill(force);
    this._changed();
    return force;
  }

  removeForce(force) {
    this.roster.forces = this.roster.forces.filter((f) => f !== force);
    this._changed();
  }

  _insert(parent, def, groupPath, number) {
    const sel = new Selection(def, parent, groupPath, number);
    this._childrenOf(parent).push(sel);
    this._reset();
    this._autofill(sel);
    return sel;
  }

  addSelection(parent, def, groupPath = [], number) {
    let n = number;
    if (n == null) {
      const st = this.evaluate(new VirtualSelection(def, parent, groupPath));
      n = st.defaultAmount > 0 ? st.defaultAmount : 1;
    }
    const sel = this._insert(parent, def, groupPath, n);
    this._changed();
    return sel;
  }

  removeSelection(sel) {
    const list = this._childrenOf(sel.parent);
    const i = list.indexOf(sel);
    if (i >= 0) list.splice(i, 1);
    this._changed();
  }

  setNumber(sel, n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    if (n === 0) return this.removeSelection(sel);
    sel.number = n;
    this._changed();
  }

  /** Set how many of `def` (chosen via groupPath) the parent has, adding/removing as needed. */
  setOptionCount(parent, def, groupPath, n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    const existing = this._childrenOf(parent).filter((c) => c.def === def);
    if (n === 0) {
      const list = this._childrenOf(parent);
      for (const e of existing) list.splice(list.indexOf(e), 1);
      this._changed();
      return;
    }
    if (existing.length) {
      existing[0].number = n - existing.slice(1).reduce((t, s) => t + s.number, 0);
      if (existing[0].number <= 0) {
        const list = this._childrenOf(parent);
        list.splice(list.indexOf(existing[0]), 1);
      }
      this._changed();
      return;
    }
    this._insert(parent, def, groupPath, n);
    this._changed();
  }

  /** Radio-style choice: replace whatever is selected in `group` with `def` (or nothing). */
  chooseInGroup(parent, group, def, groupPath, number = 1) {
    const list = this._childrenOf(parent);
    for (const c of list.filter((s) => s.inGroup(group))) list.splice(list.indexOf(c), 1);
    this._reset();
    if (def) this._insert(parent, def, groupPath, number);
    this._changed();
  }

  /**
   * Datasheet preview for an entry that has not been added: builds it with its default
   * selections, describes it, then removes it again without notifying listeners.
   */
  previewEntry(parent, def) {
    const sel = new Selection(def, parent, [], 1);
    const list = this._childrenOf(parent);
    list.push(sel);
    this._reset();
    try {
      this._autofill(sel);
      this._reset();
      return { points: this.points(sel), models: this.modelCount(sel), info: this.describe(sel) };
    } finally {
      list.splice(list.indexOf(sel), 1);
      this._reset();
    }
  }

  duplicate(sel) {
    const clone = (s, parent) => {
      const c = new Selection(s.def, parent, s.groupPath, s.number);
      c.customName = s.customName;
      c.children = s.children.map((ch) => clone(ch, c));
      return c;
    };
    const copy = clone(sel, sel.parent);
    const list = this._childrenOf(sel.parent);
    list.splice(list.indexOf(sel) + 1, 0, copy);
    this._changed();
    return copy;
  }

  rename(sel, name) {
    sel.customName = name || '';
    this._changed();
  }

  setRosterName(name) {
    this.roster.name = name;
    this._changed();
  }

  setCostLimit(typeId, value) {
    if (value == null || value === '' || Number(value) < 0) delete this.roster.costLimits[typeId];
    else this.roster.costLimits[typeId] = Number(value);
    this._changed();
  }

  /** Auto-select mandatory children (min constraints and group defaults). */
  _autofill(parent, depth = 0) {
    if (depth > 10) return;
    for (let guard = 0; guard < 60; guard++) {
      this._reset();
      const tree = this.optionTree(parent);
      const step = this._autofillStep(parent, tree, depth);
      if (!step) break;
    }
  }

  _autofillStep(parent, tree, depth) {
    for (const opt of tree.entries) {
      if (opt.hidden || opt.min <= opt.count) continue;
      if (parent.isForce) {
        // Roster-level mandatory entries (e.g. Battle Size, Detachment) are added once each.
        if (opt.count > 0) continue;
        this._insertAuto(parent, opt.def, opt.groupPath, 1, depth);
        return true;
      }
      const need = Math.min(opt.min - opt.count, opt.max);
      if (need <= 0) continue;
      const existing = opt.selections[0];
      if (existing) existing.number += need;
      else this._insertAuto(parent, opt.def, opt.groupPath, need, depth);
      return true;
    }
    for (const g of tree.groups) {
      if (g.hidden) continue;
      if (g.min > g.count) {
        const visible = this._visibleGroupEntries(g);
        let pick = null;
        const defId = g.def.defaultSelectionEntryId;
        if (defId && defId !== 'none') pick = visible.find((o) => o.def.matches(defId));
        if (!pick && visible.length === 1) pick = visible[0];
        if (pick) {
          const need = Math.min(g.min - g.count, pick.max === Infinity ? g.min - g.count : Math.max(pick.max - pick.count, 0));
          if (need > 0) {
            if (pick.selections[0]) pick.selections[0].number += need;
            else this._insertAuto(parent, pick.def, pick.groupPath, need, depth);
            return true;
          }
        }
      }
      if (this._autofillStep(parent, { entries: g.entries, groups: g.groups }, depth)) return true;
    }
    return false;
  }

  _visibleGroupEntries(g) {
    const out = g.entries.filter((e) => !e.hidden);
    for (const sub of g.groups) if (!sub.hidden) out.push(...this._visibleGroupEntries(sub));
    return out;
  }

  _insertAuto(parent, def, groupPath, number, depth) {
    const sel = new Selection(def, parent, groupPath, number);
    this._childrenOf(parent).push(sel);
    this._autofill(sel, depth + 1);
    this._reset();
  }

  // ---------------------------------------------------------------- validation

  validate() {
    if (this._validation) return this._validation;
    const issues = [];
    const seen = new Set();
    const push = (level, message, node) => {
      const k = level + '|' + message + '|' + (node && node.id);
      if (seen.has(k)) return;
      seen.add(k);
      issues.push({ level, message, selectionId: node && node.isSelection ? node.id : null });
    };

    for (const [typeId, limit] of Object.entries(this.costLimits())) {
      const total = this.totalCost(this.roster, typeId);
      if (limit >= 0 && total > limit) {
        push('error', `Roster is over the ${this.data.costTypeName(typeId)} limit: ${fmt(total)} / ${fmt(limit)}.`, null);
      }
    }
    if (!this.roster.forces.length) push('error', 'Roster has no forces.', null);

    for (const force of this.roster.forces) {
      this._validateForce(force, push, seen);
      this._validateChildren(force, push, seen);
    }
    this._validation = issues;
    return issues;
  }

  _validateForce(force, push, seen) {
    const check = (raw, key, categoryId) => {
      const st = this._evaluateRaw(raw, force, key);
      for (const con of st.constraints) {
        this._checkConstraint(con, force, st.name, (s) => this.categoriesOf(s).has(categoryId), push, seen, true, null, categoryId);
      }
    };
    for (const cl of arr(force.forceEntry.categoryLinks)) {
      if (arr(cl.constraints).length) check(cl, force.id + ':cl:' + cl.id, cl.targetId);
    }
    for (const cat of this.data.categories.values()) {
      if (arr(cat.constraints).length) check(cat, force.id + ':cat:' + cat.id, cat.id);
    }
  }

  _validateChildren(parent, push, seen) {
    const tree = this.optionTree(parent);
    const parentName = parent.isSelection ? this.displayName(parent) : parent.forceEntry.name;

    const visit = (branch) => {
      for (const opt of branch.entries) {
        if (opt.hidden) {
          for (const s of opt.selections) push('error', `${this.displayName(s)} is not available in this roster.`, s);
          continue;
        }
        const self = opt.selections[0] || this._existingOrVirtual(parent, opt.def, opt.groupPath);
        for (const con of opt.state.constraints) {
          this._checkConstraint(con, self, opt.state.name, (s) => s.def.id === opt.def.id, push, seen, false, parentName, opt.def.id);
        }
      }
      for (const g of branch.groups) {
        if (g.hidden) continue;
        const self = new VirtualSelection(g.def, parent, g.groupPath);
        for (const con of g.state.constraints) {
          this._checkConstraint(con, self, g.state.name, (s) => s.inGroup(g.def), push, seen, false, parentName, g.def.id, true);
        }
        visit(g);
      }
    };
    visit(tree);

    for (const sel of this._childrenOf(parent)) {
      const st = this.evaluate(sel);
      for (const e of st.errors) push('error', `${this.displayName(sel)}: ${e}`, sel);
      for (const w of st.warnings) push('warning', `${this.displayName(sel)}: ${w}`, sel);
      this._validateChildren(sel, push, seen);
    }
  }

  _checkConstraint(con, self, ownerName, match, push, seen, isCategory, parentName, ownerId, isGroup) {
    const field = con.field || 'selections';
    if (field === 'associations' || field === 'forces') return;
    if (con.type === 'max' && con.value < 0) return;
    const scope = con.scope || 'parent';
    const targets = this._scopeTargets(self, scope);
    const target = targets[0];
    if (!target) return;
    const dedupe = con.id + '|' + ownerId + '|' + (target.id || 'roster');
    if (seen.has(dedupe)) return;
    seen.add(dedupe);

    let count;
    if (field === 'selections') {
      if (scope === 'self' && !isCategory) count = self.number;
      else count = this._countSelections(target, match, isCategory ? true : !!con.includeChildSelections || scope !== 'parent');
    } else if (this._isCostType(field)) {
      count = this._count(target, { field, childId: con.childId || 'any' });
    } else {
      return;
    }

    const fails = con.type === 'min' ? count < con.value : con.type === 'max' ? count > con.value : false;
    if (!fails) return;
    const node = self.isSelection && !self.virtual ? self : (target.isSelection ? target : null);
    if (con.message) { push('error', `${ownerName}: ${con.message}`, node); return; }
    if (isGroup && field === 'selections' && scope === 'parent') {
      const verb = con.type === 'min' ? `choose at least ${fmt(con.value)}` : `choose at most ${fmt(con.value)}`;
      push('error', `${parentName || ownerName}: ${verb} from "${ownerName}" (currently ${fmt(count)}).`, node);
      return;
    }
    const what = field === 'selections' ? '' : ' ' + this.data.costTypeName(field);
    const where = scope === 'parent' ? (parentName ? ` in ${parentName}` : '')
      : scope === 'force' ? ' in this force' : scope === 'roster' ? ' in the roster' : scope === 'self' ? '' : scope === 'root-entry' ? ' in this unit' : '';
    const verb = con.type === 'min' ? 'needs at least' : 'allows at most';
    push('error', `${ownerName}${what}: ${verb} ${fmt(con.value)}${where} (currently ${fmt(count)}).`, node);
  }

  issuesFor(sel) {
    const ids = new Set([sel.id]);
    for (const s of this.walk(sel)) ids.add(s.id);
    return this.validate().filter((i) => i.selectionId && ids.has(i.selectionId));
  }

  // ---------------------------------------------------------------- datasheet info

  _evalInfo(node, link, self, key) {
    const memoKey = 'info:' + key;
    const hit = this._memo.get(memoKey);
    if (hit) return hit;
    const state = {
      name: node.name,
      hidden: !!(node.hidden || (link && link.hidden)),
      costs: {},
      constraints: [],
      categories: new Set(),
      errors: [], warnings: [], annotations: [],
      characteristics: arr(node.characteristics).map((c) => ({ name: c.name, typeId: c.typeId, value: c.$text != null ? String(c.$text) : '' })),
    };
    const mods = [...arr(node.modifiers), ...arr(link && link.modifiers)];
    const groups = [...arr(node.modifierGroups), ...arr(link && link.modifierGroups)];
    this._applyModifiers(state, mods, groups, self);
    this._memo.set(memoKey, state);
    return state;
  }

  /** Profiles and rules for a selection and all its descendants (deduplicated). */
  describe(sel) {
    const profiles = [];
    const rules = [];
    const pSeen = new Set();
    const rSeen = new Set();
    const addProfile = (node, link, self) => {
      const st = this._evalInfo(node, link, self, self.id + ':' + (link ? link.id : node.id));
      if (st.hidden) return;
      const typeName = node.typeName || (this.data.profileTypes.find((t) => t.id === node.typeId) || {}).name || 'Profile';
      const k = typeName + '|' + st.name + '|' + st.characteristics.map((c) => c.value).join('|');
      if (pSeen.has(k)) return;
      pSeen.add(k);
      profiles.push({ typeId: node.typeId, typeName, name: st.name, characteristics: st.characteristics });
    };
    const addRule = (node, link, self) => {
      const st = this._evalInfo(node, link, self, self.id + ':' + (link ? link.id : node.id));
      if (st.hidden || rSeen.has(st.name)) return;
      rSeen.add(st.name);
      rules.push({ name: st.name, description: node.description || '' });
    };
    const collectInfo = (holder, self, depth = 0) => {
      if (depth > 4) return;
      for (const p of arr(holder.profiles)) addProfile(p, null, self);
      for (const r of arr(holder.rules)) addRule(r, null, self);
      for (const l of arr(holder.infoLinks)) {
        const target = this.data.get(l.targetId);
        if (!target) continue;
        const st = this._evalInfo(target, l, self, self.id + ':lnk:' + l.id);
        if (st.hidden) continue;
        if (l.type === 'profile') addProfile(target, l, self);
        else if (l.type === 'rule') addRule(target, l, self);
        else if (l.type === 'infoGroup') collectInfo(target, self, depth + 1);
      }
      for (const g of arr(holder.infoGroups)) {
        const st = this._evalInfo(g, null, self, self.id + ':ig:' + g.id);
        if (!st.hidden) collectInfo(g, self, depth + 1);
      }
    };
    const visit = (s) => {
      const d = s.def;
      collectInfo({ profiles: d.profiles, rules: d.rules, infoLinks: d.infoLinks, infoGroups: d.infoGroups }, s);
      for (const c of s.children) visit(c);
    };
    visit(sel);
    const st = this.evaluate(sel);
    const keywords = [...st.categories].map((id) => (this.data.categories.get(id) || {}).name).filter(Boolean);
    return { profiles, rules, keywords };
  }

  // ---------------------------------------------------------------- export

  toText() {
    const pts = this.ptsTypeId;
    const lines = [];
    const limit = this.costLimits()[pts];
    lines.push(`${this.roster.name} (${this.roster.catalogueName || ''}) - ${fmt(this.points())}${limit != null ? ' / ' + fmt(limit) : ''} pts`);
    const line = (s, depth) => {
      const cost = this.totalCost(s, pts);
      const num = s.number > 1 ? `${s.number}x ` : '';
      const c = depth === 0 && cost ? ` [${fmt(cost)} pts]` : '';
      lines.push(`${'  '.repeat(depth)}${depth ? '• ' : ''}${num}${this.displayName(s)}${c}`);
      for (const ch of s.children) line(ch, depth + 1);
    };
    for (const force of this.roster.forces) {
      lines.push('');
      lines.push(`++ ${force.forceEntry.name} ++`);
      for (const grp of this.groupedSelections(force)) {
        lines.push('');
        lines.push(`${grp.name.toUpperCase()}`);
        for (const s of grp.selections) line(s, 0);
      }
    }
    return lines.join('\n');
  }

  toJSON() {
    const ser = (s) => ({
      id: s.id,
      key: s.def.key,
      entryId: s.def.id,
      name: s.def.name,
      groupPath: s.groupPath.map((g) => g.key),
      number: s.number,
      customName: s.customName || undefined,
      children: s.children.map(ser),
    });
    const r = this.roster;
    return {
      format: 'pawhammer-roster',
      version: 1,
      id: r.id,
      name: r.name,
      gameSystemId: r.gameSystemId,
      catalogueId: r.catalogueId,
      catalogueName: r.catalogueName,
      costLimits: r.costLimits,
      notes: r.notes,
      updatedAt: r.updatedAt,
      points: this.points(),
      forces: r.forces.map((f) => ({ id: f.id, forceEntryId: f.forceEntry.id, catalogueId: f.catalogueId, selections: f.selections.map(ser) })),
    };
  }

  static fromJSON(data, json) {
    const roster = new Roster({
      name: json.name,
      gameSystemId: json.gameSystemId,
      catalogueId: json.catalogueId,
      catalogueName: json.catalogueName,
    });
    roster.id = json.id || roster.id;
    roster.costLimits = json.costLimits || {};
    roster.notes = json.notes || '';
    roster.updatedAt = json.updatedAt || Date.now();
    const engine = new RosterEngine(data, roster);
    for (const jf of arr(json.forces)) {
      const fe = data.forceEntries.find((f) => f.id === jf.forceEntryId);
      if (!fe) { engine.loadWarnings.push(`Force type ${jf.forceEntryId} no longer exists in the data.`); continue; }
      const force = new Force(roster, fe, jf.catalogueId || roster.catalogueId);
      force.id = jf.id || force.id;
      roster.forces.push(force);
      engine._restoreChildren(force, arr(jf.selections));
    }
    engine._reset();
    return engine;
  }

  _restoreChildren(parent, list) {
    const options = parent.isForce
      ? this._optionSource(parent).entries.map((def) => ({ def, groupPath: [] }))
      : parent.def.flatOptions();
    for (const js of list) {
      const pathKey = arr(js.groupPath).join('/');
      const opt = options.find((o) => o.def.key === js.key && o.groupPath.map((g) => g.key).join('/') === pathKey) ||
        options.find((o) => o.def.key === js.key) ||
        options.find((o) => o.def.id === js.entryId);
      if (!opt) {
        this.loadWarnings.push(`"${js.name || js.key}" could not be found in the current data and was dropped.`);
        continue;
      }
      const sel = new Selection(opt.def, parent, opt.groupPath, js.number || 1);
      sel.id = js.id || sel.id;
      sel.customName = js.customName || '';
      this._childrenOf(parent).push(sel);
      this._restoreChildren(sel, arr(js.children));
    }
  }
}

export function fmt(n) {
  if (n == null || isNaN(n)) return '0';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
