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
  'model-self': ['model'],
  'model-or-unit-self': ['model', 'unit'],
};

/**
 * Combine a condition group's tests: "and" (default), "or", or New Recruit's "count"
 * (at least `min` and at most `max` of the tests pass). An empty group passes.
 */
function combineTests(g, tests) {
  if (!tests.length) return true;
  if (g.type === 'or') return tests.some((t) => t());
  if (g.type === 'count') {
    const n = tests.filter((t) => t()).length;
    return n >= (Number(g.min) || 0) && (g.max == null || n <= Number(g.max));
  }
  return tests.every((t) => t());
}

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
    this._pruneAttachments();
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

  /**
   * A top-level unit together with the characters attached to it, or the unit a character is
   * attached to and that unit's other characters (traverseAssociationGroup: the attached unit
   * counts as one, e.g. "An Attached Unit can only take 1 Enhancement").
   */
  _associationGroup(sel) {
    if (!sel || !sel.isSelection || sel.virtual || !sel.parent || !sel.parent.isForce) return [sel];
    const host = this.attachmentsOf(sel).map((a) => this.findSelection(a.targetId)).find(Boolean) || sel;
    return [host, ...this.leadersOf(host)];
  }

  /** Measure `field` (selections / forces / cost type) of `childId` within target. */
  _count(target, spec) {
    if (!target || target.isCatalogue) return 0;
    const field = spec.field || 'selections';
    if (spec.traverseAssociationGroup && field !== 'associations') {
      const group = this._associationGroup(target);
      if (group.length > 1) return group.reduce((n, s) => n + this._count(s, { ...spec, traverseAssociationGroup: false }), 0);
    }
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
    if (field === 'associations') {
      // Leaders attached to this unit, or units this leader is attached to.
      if (!target.isSelection || target.virtual) return 0;
      return this._associated(target).filter((s) => this._matchSelection(s, childId)).length;
    }
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
    return combineTests(g, [
      ...arr(g.conditions).map((c) => () => this._checkCondition(c, self)),
      ...arr(g.conditionGroups).map((cg) => () => this._checkGroup(cg, self)),
      ...arr(g.localConditionGroups).map((lg) => () => this._checkLocalGroup(lg, self)),
    ]);
  }

  /**
   * New Recruit "local" condition group: counts the selections in its scope that pass its
   * conditions (each tested as `self`). BSData uses it for escalating costs, e.g. "+10 pts if at
   * least 2 Infernus Squads were added before this one". `before` compares roster order with
   * the owner of the modifier.
   */
  _checkLocalGroup(lg, owner) {
    const cmp = COMPARE[lg.type];
    if (!cmp) return false;
    const conds = arr(lg.conditions);
    // Cheap ordering checks first, so most candidates are rejected before evaluating categories.
    const ordered = [...conds.filter((c) => c.type === 'before'), ...conds.filter((c) => c.type !== 'before')];
    let n = 0;
    for (const t of this._scopeTargets(owner, lg.scope)) {
      const pool = lg.includeChildSelections ? [...this.walk(t)] : this._childrenOf(t);
      for (const c of pool) {
        if (c === owner) continue;
        const pass = ordered.every((cond) => (cond.type === 'before' ? this._isBefore(c, owner) : this._checkCondition(cond, c))) &&
          arr(lg.conditionGroups).every((cg) => this._checkGroup(cg, c));
        if (pass) n += c.number;
      }
    }
    return cmp(n, Number(lg.value));
  }

  /** Position of a selection in roster order; entries not in the roster yet would be added last. */
  _order(sel) {
    let order = this._memo.get('order');
    if (!order) {
      order = new Map();
      let i = 0;
      for (const s of this.walk()) order.set(s.id, i++);
      this._memo.set('order', order);
    }
    return order.has(sel.id) ? order.get(sel.id) : Infinity;
  }

  _isBefore(a, b) { return this._order(a) < this._order(b); }

  _conditionsPass(m, self) {
    return arr(m.conditions).every((c) => this._checkCondition(c, self)) &&
      arr(m.conditionGroups).every((g) => this._checkGroup(g, self));
  }

  // ---------------------------------------------------------------- Warlord
  //
  // Characters that can lead the army have a "Warlord" option in the Warlord category; the game
  // system requires exactly one per roster. Some (Roboute Guilliman, Ghazghkull, …) have a
  // minimum of 1 on that option: they must be the Warlord whenever they are in the army.

  get warlordCategoryId() {
    if (this._warlordCat === undefined) {
      this._warlordCat = null;
      for (const [id, c] of this.data.categories) if (c.name === 'Warlord') { this._warlordCat = id; break; }
    }
    return this._warlordCat;
  }

  /** The Warlord option of a top-level unit, or null when it can't be the Warlord. */
  warlordOption(unit) {
    const cat = this.warlordCategoryId;
    if (!cat || !unit || !unit.parent || !unit.parent.isForce) return null;
    const find = (branch) => {
      for (const o of branch.entries) if (!o.hidden && o.def.categoryIds.includes(cat)) return o;
      for (const g of branch.groups) if (!g.hidden) { const r = find(g); if (r) return r; }
      return null;
    };
    return find(this.optionTree(unit));
  }

  /** The Warlord selection inside a unit, if it has one. */
  _warlordSelection(unit) {
    const cat = this.warlordCategoryId;
    if (!cat) return null;
    for (const s of this.walk(unit)) if (this.categoriesOf(s).has(cat)) return s;
    return null;
  }

  isWarlord(unit) { return !!this._warlordSelection(unit); }

  /** True for characters that must be the Warlord whenever they are in the army. */
  mustBeWarlord(unit) {
    const o = this.warlordOption(unit);
    return !!o && o.min >= 1;
  }

  warlordCandidates(force) { return force.selections.filter((s) => this.warlordOption(s)); }

  warlords(force) { return force.selections.filter((s) => this.isWarlord(s)); }

  _removeWarlord(unit) {
    const w = this._warlordSelection(unit);
    if (!w) return;
    const list = this._childrenOf(w.parent);
    list.splice(list.indexOf(w), 1);
    this._reset();
  }

  /**
   * Make `unit` the army's Warlord (null clears it). Only one model can be the Warlord, so any
   * other Warlord is replaced, unless that model must be the Warlord.
   */
  setWarlord(force, unit) {
    const blocker = force.selections.find((s) => s !== unit && this.isWarlord(s) && this.mustBeWarlord(s));
    if (blocker) throw new Error(`${this.displayName(blocker)} must be your Warlord.`);
    if (unit && !this.warlordOption(unit)) throw new Error(`${this.displayName(unit)} can't be your Warlord.`);
    for (const s of force.selections) if (s !== unit) this._removeWarlord(s);
    if (unit && !this.isWarlord(unit)) {
      const o = this.warlordOption(unit);
      this._insert(unit, o.def, o.groupPath, 1);
    }
    this._changed();
  }

  // ---------------------------------------------------------------- associations (leaders)
  //
  // BSData 11e describes Leader/Support attachments as `associations` on the leader's entry:
  // { id, name, label, min, max, childId: 'unit', conditions/conditionGroups }. Conditions are
  // evaluated against the candidate unit, or against the leader when `queryFromSelf` is set.
  // Attachments are stored on the leader selection as [{ assocId, targetId }].

  associationDefs(sel) {
    const own = [sel.def.raw, sel.def.link].filter(Boolean);
    // associationLinks point at sharedAssociations (e.g. Death Guard's Foul Blightspawn); the
    // link's id identifies the attachment so two links to one shared association stay distinct.
    const linked = own.flatMap((n) => arr(n.associationLinks))
      .filter((l) => !l.hidden)
      .map((l) => { const t = this.data.get(l.targetId); return t ? { ...t, id: l.id } : null; })
      .filter(Boolean);
    return [...own.flatMap((n) => arr(n.associations)), ...linked];
  }

  _assocCheck(c, leader, cand) { return this._checkCondition(c, c.queryFromSelf ? leader : cand); }

  _assocGroup(g, leader, cand) {
    return combineTests(g, [
      ...arr(g.conditions).map((c) => () => this._assocCheck(c, leader, cand)),
      ...arr(g.conditionGroups).map((cg) => () => this._assocGroup(cg, leader, cand)),
    ]);
  }

  canAttach(leader, assoc, cand) {
    if (!cand || cand === leader || !cand.isSelection || cand.force !== leader.force) return false;
    const childId = assoc.childId || 'unit';
    if (!this._matchSelection(cand, childId)) return false;
    return arr(assoc.conditions).every((c) => this._assocCheck(c, leader, cand)) &&
      arr(assoc.conditionGroups).every((g) => this._assocGroup(g, leader, cand));
  }

  /** Units in the leader's force that this association may attach to. */
  attachCandidates(leader, assoc) {
    return leader.force.selections.filter((s) => this.canAttach(leader, assoc, s));
  }

  attachmentsOf(sel) { return sel.attachments || []; }

  attachedTarget(leader, assocId) {
    const a = this.attachmentsOf(leader).find((x) => x.assocId === assocId);
    return a ? this.findSelection(a.targetId) : null;
  }

  /** Selections attached to `unit` (its leaders / supporting characters). */
  leadersOf(unit) {
    if (!unit.force) return [];
    return unit.force.selections.filter((s) => this.attachmentsOf(s).some((a) => a.targetId === unit.id));
  }

  /** Everything associated with a selection in either direction. */
  _associated(sel) {
    const out = new Set(this.leadersOf(sel));
    for (const a of this.attachmentsOf(sel)) {
      const t = this.findSelection(a.targetId);
      if (t) out.add(t);
    }
    return [...out];
  }

  /** Attach `leader` to `target` via association `assocId` (target null detaches). */
  attach(leader, assocId, target) {
    leader.attachments = this.attachmentsOf(leader).filter((a) => a.assocId !== assocId);
    if (target) leader.attachments.push({ assocId, targetId: target.id });
    this._changed();
  }

  /** Drop attachments whose target no longer exists. */
  _pruneAttachments() {
    for (const force of this.roster.forces) {
      const ids = new Set(force.selections.map((s) => s.id));
      for (const s of force.selections) {
        if (s.attachments && s.attachments.some((a) => !ids.has(a.targetId))) {
          s.attachments = s.attachments.filter((a) => ids.has(a.targetId));
        }
      }
    }
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
    // A character that must be the Warlord (e.g. Roboute Guilliman) takes over from any other.
    if (parent.isForce && this.mustBeWarlord(sel) && this.isWarlord(sel)) {
      for (const other of parent.selections) if (other !== sel && !this.mustBeWarlord(other)) this._removeWarlord(other);
    }
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
  previewEntry(parent, def, { available = false } = {}) {
    const sel = new Selection(def, parent, [], 1);
    const list = this._childrenOf(parent);
    list.push(sel);
    this._reset();
    try {
      this._autofill(sel);
      this._reset();
      // available: every weapon/wargear option it could take, not just the defaults.
      return { points: this.points(sel), models: this.modelCount(sel), info: available ? this.describeAvailable(sel) : this.describe(sel) };
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
    // Only one model can be the Warlord: the copy doesn't inherit it.
    this._reset();
    if (this.isWarlord(copy)) this._removeWarlord(copy);
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
      // Mandatory members first (e.g. a squad's Sergeant), so they count towards the group's
      // minimum before it is topped up with the default choice.
      if (this._autofillStep(parent, { entries: g.entries, groups: g.groups }, depth)) return true;
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
      this._validateAttachments(force, push);
    }
    this._validation = issues;
    return issues;
  }

  _validateForce(force, push, seen) {
    const check = (raw, key, categoryId) => {
      const st = this._evaluateRaw(raw, force, key);
      for (let con of st.constraints) {
        if (categoryId === this.warlordCategoryId && (con.field || 'selections') === 'selections') {
          con = { ...con, message: con.type === 'min'
            ? 'Choose a Warlord: turn on Warlord in the options of one of your Characters.'
            : 'Your army can only have one Warlord.' };
        }
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

  /** Leader attachments: required attachments, and targets that are no longer eligible. */
  _validateAttachments(force, push) {
    for (const leader of force.selections) {
      for (const assoc of this.associationDefs(leader)) {
        const attached = this.attachmentsOf(leader).filter((a) => a.assocId === assoc.id);
        const label = assoc.label || assoc.name || 'attachment';
        if (attached.length < (Number(assoc.min) || 0)) {
          push('error', `${this.displayName(leader)} must be attached to a unit (${label}).`, leader);
        }
        const max = Number(assoc.max);
        if (max >= 0 && assoc.max != null && attached.length > max) {
          push('error', `${this.displayName(leader)} can be attached to at most ${max} unit${max === 1 ? '' : 's'}.`, leader);
        }
        for (const a of attached) {
          const target = this.findSelection(a.targetId);
          if (target && !this.canAttach(leader, assoc, target)) {
            push('error', `${this.displayName(leader)} cannot be attached to ${this.displayName(target)}.`, leader);
          }
        }
      }
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
        // Check each selection of this entry (scope "self" constraints differ per selection,
        // e.g. how many leaders a unit has); shared scopes are de-duplicated in _checkConstraint.
        const selves = opt.selections.length ? opt.selections : [this._existingOrVirtual(parent, opt.def, opt.groupPath)];
        for (const self of selves) {
          const st = self.virtual ? opt.state : this.evaluate(self);
          for (const con of st.constraints) {
            // shared: false limits count only this link (e.g. a Rhino's fixed combi-bolter and
            // its pintle combi-bolter are two links to one entry); otherwise every link counts.
            const match = con.shared === false ? (s) => s.def === opt.def : (s) => s.def.id === opt.def.id;
            this._checkConstraint(con, self, self.virtual ? opt.state.name : this.displayName(self), match, push, seen, false, parentName, con.shared === false ? opt.def.key : opt.def.id);
          }
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
    if (field === 'forces') return;
    if (con.type === 'max' && con.value < 0) return;
    const scope = con.scope || 'parent';
    // An entry that is not in the roster has nothing of its own to validate: constraints on
    // itself (e.g. "must be attached to a unit") only apply once it is actually selected.
    if (self.virtual && (scope === 'self' || field === 'associations')) return;
    const targets = this._scopeTargets(self, scope);
    const target = targets[0];
    if (!target) return;
    const dedupe = con.id + '|' + ownerId + '|' + (target.id || 'roster');
    if (seen.has(dedupe)) return;
    seen.add(dedupe);

    let count;
    if (field === 'selections') {
      if (scope === 'self' && !isCategory) count = self.number;
      else {
        const deep = isCategory ? true : !!con.includeChildSelections || scope !== 'parent';
        const group = con.traverseAssociationGroup ? this._associationGroup(target) : [target];
        count = group.reduce((n, t) => n + this._countSelections(t, match, deep), 0);
      }
    } else if (this._isCostType(field) && isCategory) {
      // e.g. "Faction: Unaligned Forces" max 500 pts: only units with that keyword count.
      count = 0;
      const sum = (node) => {
        for (const c of this._childrenOf(node)) {
          if (match(c)) count += this.totalCost(c, field);
          else sum(c);
        }
      };
      sum(target);
    } else if (this._isCostType(field) || field === 'associations') {
      count = this._count(target, { field, childId: con.childId || 'any', traverseAssociationGroup: con.traverseAssociationGroup });
    } else {
      return;
    }

    const fails = con.type === 'min' ? count < con.value : con.type === 'max' ? count > con.value : false;
    if (!fails) return;
    const node = self.isSelection && !self.virtual ? self : (target.isSelection ? target : null);
    if (con.message) {
      // Data messages may use "{this}" for the entry's own name.
      const msg = String(con.message).replace(/\{this\}/g, ownerName);
      push('error', msg.includes(ownerName) ? msg : `${ownerName}: ${msg}`, node);
      return;
    }
    if (isGroup && field === 'selections' && scope === 'parent') {
      const verb = con.type === 'min' ? `choose at least ${fmt(con.value)}` : `choose at most ${fmt(con.value)}`;
      push('error', `${parentName || ownerName}: ${verb} from "${ownerName}" (currently ${fmt(count)}).`, node);
      return;
    }
    if (field === 'associations') {
      const kind = con.childName || (this.data.categories.get(con.childId) || {}).name || 'unit';
      const verb = con.type === 'min' ? 'needs at least' : 'can have at most';
      push('error', `${ownerName}: ${verb} ${fmt(con.value)} ${kind} attached (currently ${fmt(count)}).`, node);
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

  /**
   * Everything a unit could take: its own profiles and rules plus those of every available
   * option (other model variants, weapon swaps, wargear), selected or not. Options the data
   * hides (Crusade upgrades, enhancements without a detachment, …) or caps at 0 are skipped.
   * Same shape as describe(), without counts.
   */
  describeAvailable(sel) {
    const profiles = new Map();
    const rules = new Map();
    const visit = (node, depth) => {
      const info = this.describe(node, { deep: false });
      for (const p of info.profiles) {
        const k = p.typeName + '|' + p.name + '|' + p.characteristics.map((c) => c.value).join('|');
        if (!profiles.has(k)) profiles.set(k, { ...p, count: undefined });
      }
      for (const r of info.rules) if (!rules.has(r.name)) rules.set(r.name, r);
      if (depth > 6) return;
      const kids = node.virtual ? [] : node.children;
      for (const { def, groupPath } of node.def.flatOptions()) {
        if (groupPath.some((g, i) => this.evaluate(new VirtualSelection(g, node, groupPath.slice(0, i))).hidden)) continue;
        const child = kids.find((c) => c.def === def) || new VirtualSelection(def, node, groupPath);
        const st = this.evaluate(child);
        if (st.hidden || this._limits(st, ['parent']).max === 0) continue;
        visit(child, depth + 1);
      }
    };
    visit(sel, 0);
    const keywords = [...this.evaluate(sel).categories].map((id) => (this.data.categories.get(id) || {}).name).filter(Boolean);
    return { profiles: [...profiles.values()], rules: [...rules.values()], keywords };
  }

  /**
   * Profiles and rules for a selection and all its descendants (deduplicated).
   * Each profile has a `count`: how many copies the unit carries (e.g. 10 models × 1 bolt pistol).
   */
  describe(sel, { deep = true } = {}) {
    const profiles = [];
    const rules = [];
    const pSeen = new Map();
    const rSeen = new Set();
    let mult = 1;
    const addProfile = (node, link, self) => {
      const st = this._evalInfo(node, link, self, self.id + ':' + (link ? link.id : node.id));
      if (st.hidden) return;
      const typeName = node.typeName || (this.data.profileTypes.find((t) => t.id === node.typeId) || {}).name || 'Profile';
      const k = typeName + '|' + st.name + '|' + st.characteristics.map((c) => c.value).join('|');
      const seen = pSeen.get(k);
      if (seen) { seen.count += mult; return; }
      const profile = { typeId: node.typeId, typeName, name: st.name, characteristics: st.characteristics, count: mult };
      pSeen.set(k, profile);
      profiles.push(profile);
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
    const visit = (s, m) => {
      const d = s.def;
      mult = m;
      collectInfo({ profiles: d.profiles, rules: d.rules, infoLinks: d.infoLinks, infoGroups: d.infoGroups }, s);
      if (deep) for (const c of s.children) visit(c, m * c.number);
    };
    visit(sel, 1);
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
      if (depth === 0) {
        for (const a of this.attachmentsOf(s)) {
          const t = this.findSelection(a.targetId);
          if (t) lines.push(`  (attached to ${this.displayName(t)})`);
        }
      }
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
      attachments: s.attachments && s.attachments.length ? s.attachments : undefined,
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
    engine._pruneAttachments();
    engine._reset();
    return engine;
  }

  // ---------------------------------------------------------------- sharing (compact form)
  //
  // Small enough for a QR code: only what auto-selection can't rebuild is stored. A selection is
  // `key` or [key, number, children, customName, attachments]; `children` is 0 when they are
  // exactly what adding the selection produces by default, otherwise an explicit list.
  // Attachments point at other top-level units by their index in the force.

  _shape(sel) {
    return [sel.def.key, sel.number, sel.children.map((c) => this._shape(c))];
  }

  /** Shape of the children auto-selection gives `sel` (same entry, parent and number). */
  _defaultShape(sel) {
    const tmp = new Selection(sel.def, sel.parent, sel.groupPath, sel.number);
    const list = this._childrenOf(sel.parent);
    list.push(tmp);
    this._reset();
    try {
      this._autofill(tmp);
      return JSON.stringify(tmp.children.map((c) => this._shape(c)));
    } finally {
      list.splice(list.indexOf(tmp), 1);
      this._reset();
    }
  }

  /** Options a selection's entry was chosen from (as used when rebuilding). */
  _shareOptions(parent) {
    return parent.isForce
      ? this._optionSource(parent).entries.map((def) => ({ def, groupPath: [] }))
      : parent.def.flatOptions();
  }

  /** Shortest start of `key` (4+ chars) that no other option key shares: IDs stay short but still survive data updates. */
  _shortKey(key, options) {
    const others = [...new Set(options.map((o) => o.def.key))].filter((k) => k !== key);
    for (let len = 4; len < key.length; len++) {
      const p = key.slice(0, len);
      if (!p.endsWith('-') && !others.some((k) => k.startsWith(p))) return p;
    }
    return key;
  }

  _shareSel(sel, index) {
    const isDefault = JSON.stringify(sel.children.map((c) => this._shape(c))) === this._defaultShape(sel);
    const key = this._shortKey(sel.def.key, this._shareOptions(sel.parent));
    const out = [key, sel.number, isDefault ? 0 : sel.children.map((c) => this._shareSel(c, index)), sel.customName || ''];
    const att = (sel.attachments || []).map((a) => [a.assocId, index.get(a.targetId)]).filter((a) => a[1] != null);
    if (att.length) out.push(att);
    while (out.length > 1 && (out[out.length - 1] === '' || (out.length === 3 && out[2] === 0) || (out.length === 2 && out[1] === 1))) out.pop();
    return out.length === 1 ? out[0] : out;
  }

  /** Compact, JSON-serialisable form of the roster for share codes / QR codes. */
  toShare() {
    const r = this.roster;
    const forces = r.forces.map((f) => {
      const index = new Map(f.selections.map((s, i) => [s.id, i]));
      return [f.forceEntry.id, f.catalogueId === r.catalogueId ? 0 : f.catalogueId, f.selections.map((s) => this._shareSel(s, index))];
    });
    this._reset();
    return [1, r.catalogueId, r.name, r.costLimits, forces, this.points()];
  }

  /** Rebuild a roster from toShare() output. Sets `loadWarnings` for anything that didn't resolve. */
  static fromShare(data, payload) {
    const [version, catalogueId, name, costLimits, forces, points] = payload;
    if (version !== 1) throw new Error('This share code was made by a newer version of PawHammer.');
    const cat = data.catalogues.find((c) => c.id === catalogueId) || data.primaryCatalogue;
    const roster = new Roster({ name, gameSystemId: data.gameSystem.id, catalogueId: cat.id, catalogueName: cat.name });
    roster.costLimits = costLimits || {};
    const engine = new RosterEngine(data, roster);
    const unpack = (enc) => (typeof enc === 'string' ? [enc, 1, 0, '', null] : [enc[0], enc[1] == null ? 1 : enc[1], enc[2] == null ? 0 : enc[2], enc[3] || '', enc[4] || null]);
    const defaults = []; // selections whose children are "whatever auto-selection picks"
    const build = (parent, list, options) => {
      const made = [];
      for (const enc of list) {
        const [key, number, children, customName] = unpack(enc);
        const hits = options.filter((o) => o.def.key.startsWith(key));
        const opt = hits.find((o) => o.def.key === key) || hits[0];
        if (!opt) { engine.loadWarnings.push(`An entry (${key}) isn't in the current data and was left out.`); made.push(null); continue; }
        if (new Set(hits.map((o) => o.def.key)).size > 1) engine.loadWarnings.push(`"${opt.def.name}" may not match what was shared (the data has changed).`);
        const sel = new Selection(opt.def, parent, opt.groupPath, number);
        sel.customName = customName;
        engine._childrenOf(parent).push(sel);
        engine._reset();
        if (children === 0) { engine._autofill(sel); defaults.push(sel); } else build(sel, children, opt.def.flatOptions());
        made.push(sel);
      }
      return made;
    };
    for (const [forceEntryId, forceCat, sels] of forces) {
      const fe = data.forceEntries.find((f) => f.id === forceEntryId);
      if (!fe) { engine.loadWarnings.push('The army type in this share code no longer exists in the data.'); continue; }
      const force = new Force(roster, fe, forceCat || cat.id);
      roster.forces.push(force);
      const roots = engine._optionSource(force).entries.map((def) => ({ def, groupPath: [] }));
      const made = build(force, sels, roots);
      sels.forEach((enc, i) => {
        const att = unpack(enc)[4];
        if (made[i] && att) made[i].attachments = att.filter(([, t]) => made[t]).map(([assocId, t]) => ({ assocId, targetId: made[t].id }));
      });
    }
    // Defaults were computed against the finished roster when sharing (e.g. a Force Disposition
    // only offered once a Detachment is chosen), so fill them again now that everything exists.
    for (const sel of defaults) { engine._reset(); engine._autofill(sel); }
    engine._pruneAttachments();
    engine._reset();
    if (points != null && engine.points() !== points) {
      engine.loadWarnings.push(`Shared at ${fmt(points)} pts; with this copy of the data it's ${fmt(engine.points())} pts.`);
    }
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
      if (Array.isArray(js.attachments)) sel.attachments = js.attachments.map((a) => ({ assocId: a.assocId, targetId: a.targetId }));
      this._childrenOf(parent).push(sel);
      this._restoreChildren(sel, arr(js.children));
    }
  }
}

export function fmt(n) {
  if (n == null || isNaN(n)) return '0';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
