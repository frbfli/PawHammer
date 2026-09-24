// Roster model: Roster -> Force -> Selection tree.
// A Selection with `number` N represents N identical copies; its children are per copy.

let counter = 0;
export function uid() {
  counter = (counter + 1) % 1e6;
  return Date.now().toString(36) + '-' + counter.toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

export class Selection {
  constructor(def, parent, groupPath = [], number = 1) {
    this.id = uid();
    this.def = def;
    this.parent = parent; // Selection | Force
    this.groupPath = groupPath; // EntryDef[] (groups this was chosen from, outermost first)
    this.number = number;
    this.children = [];
    this.customName = '';
  }
  get isSelection() { return true; }
  get force() {
    let p = this.parent;
    while (p && p.isSelection) p = p.parent;
    return p;
  }
  get roster() { return this.force.roster; }
  get rootEntry() {
    let s = this;
    while (s.parent && s.parent.isSelection) s = s.parent;
    return s;
  }
  /** Ancestors from nearest to furthest, excluding self (selections, then force, then roster). */
  get ancestors() {
    const out = [];
    let p = this.parent;
    while (p) {
      out.push(p);
      p = p.isSelection ? p.parent : p.isForce ? p.roster : null;
    }
    return out;
  }
  inGroup(group) { return this.groupPath.some((g) => g === group || g.id === group.id); }
}

/** A not-yet-selected entry, used to evaluate hidden/cost/constraint state of options. */
export class VirtualSelection extends Selection {
  constructor(def, parent, groupPath = []) {
    super(def, parent, groupPath, 0);
    this.id = 'virtual:' + (parent ? parent.id : '') + ':' + def.key;
    this.virtual = true;
  }
}

export class Force {
  constructor(roster, forceEntry, catalogueId) {
    this.id = uid();
    this.roster = roster;
    this.forceEntry = forceEntry;
    this.catalogueId = catalogueId;
    this.selections = [];
  }
  get isForce() { return true; }
  get children() { return this.selections; }
  get number() { return 1; }
  get parent() { return this.roster; }
}

export class Roster {
  constructor({ name = 'New Roster', gameSystemId, catalogueId, catalogueName } = {}) {
    this.id = uid();
    this.name = name;
    this.gameSystemId = gameSystemId;
    this.catalogueId = catalogueId;
    this.catalogueName = catalogueName;
    this.costLimits = {};
    this.forces = [];
    this.notes = '';
    this.updatedAt = Date.now();
  }
  get isRoster() { return true; }
  get number() { return 1; }
}
