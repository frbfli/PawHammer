// GameData: indexes a BSData game system plus its catalogues (JSON flavour of the
// BattleScribe schema, as published by BSData/wh40k-11e) and resolves entry links
// into EntryDef objects the roster engine can work with.

const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

export class EntryDef {
  /**
   * @param {GameData} data
   * @param {object} raw   selectionEntry / selectionEntryGroup being described
   * @param {object|null} link  entryLink that pointed at `raw`, if any
   * @param {'entry'|'group'} kind
   */
  constructor(data, raw, link, kind) {
    this.data = data;
    this.raw = raw;
    this.link = link || null;
    this.kind = kind;
    this._children = null;
  }

  get id() { return this.raw.id; }
  get key() { return this.link ? this.link.id : this.raw.id; }
  get name() { return this.raw.name || (this.link && this.link.name) || '(unnamed)'; }
  get type() { return this.raw.type || (this.kind === 'group' ? 'group' : 'upgrade'); }
  get isGroup() { return this.kind === 'group'; }
  get hidden() { return !!(this.raw.hidden || (this.link && this.link.hidden)); }
  get collective() { return !!(this.raw.collective || (this.link && this.link.collective)); }
  get sortIndex() {
    const l = this.link && this.link.sortIndex;
    return l != null ? l : this.raw.sortIndex != null ? this.raw.sortIndex : 1e6;
  }
  get defaultSelectionEntryId() {
    return (this.link && this.link.defaultSelectionEntryId) || this.raw.defaultSelectionEntryId || null;
  }

  matches(id) { return id === this.raw.id || (this.link != null && id === this.link.id); }

  get constraints() { return [...arr(this.raw.constraints), ...arr(this.link && this.link.constraints)]; }
  get modifiers() { return [...arr(this.raw.modifiers), ...arr(this.link && this.link.modifiers)]; }
  get modifierGroups() { return [...arr(this.raw.modifierGroups), ...arr(this.link && this.link.modifierGroups)]; }
  get categoryLinks() { return [...arr(this.raw.categoryLinks), ...arr(this.link && this.link.categoryLinks)]; }
  get profiles() { return arr(this.raw.profiles); }
  get rules() { return arr(this.raw.rules); }
  get infoLinks() { return [...arr(this.raw.infoLinks), ...arr(this.link && this.link.infoLinks)]; }
  get infoGroups() { return arr(this.raw.infoGroups); }

  /** Base costs keyed by cost type id; link costs override target costs. */
  get costs() {
    const out = {};
    for (const c of arr(this.raw.costs)) out[c.typeId] = Number(c.value) || 0;
    for (const c of arr(this.link && this.link.costs)) out[c.typeId] = Number(c.value) || 0;
    return out;
  }

  /** Static category ids plus the static primary category id. */
  get categoryIds() {
    if (!this._cats) this._cats = this.categoryLinks.map((c) => c.targetId);
    return this._cats;
  }
  get primaryCategoryId() {
    const p = this.categoryLinks.find((c) => c.primary);
    return p ? p.targetId : null;
  }

  /** Child selectable entries and groups: { entries: EntryDef[], groups: EntryDef[] } */
  get children() {
    if (this._children) return this._children;
    const entries = [];
    const groups = [];
    const sources = [this.raw, this.link].filter(Boolean);
    for (const src of sources) {
      for (const e of arr(src.selectionEntries)) entries.push(this.data.def(e, null, 'entry'));
      for (const g of arr(src.selectionEntryGroups)) groups.push(this.data.def(g, null, 'group'));
      for (const l of arr(src.entryLinks)) {
        const d = this.data.resolveLink(l);
        if (!d) continue;
        (d.isGroup ? groups : entries).push(d);
      }
    }
    const bySort = (a, b) => a.sortIndex - b.sortIndex || a.name.localeCompare(b.name);
    entries.sort(bySort);
    groups.sort(bySort);
    this._children = { entries, groups };
    return this._children;
  }

  /** All selectable entry defs below this def, flattening groups. Each item: { def, groupPath } */
  flatOptions(groupPath = []) {
    const out = [];
    const { entries, groups } = this.children;
    for (const e of entries) out.push({ def: e, groupPath });
    for (const g of groups) out.push(...g.flatOptions([...groupPath, g]));
    return out;
  }
}

export class GameData {
  /**
   * @param {object} gameSystem  parsed `gameSystem` object
   * @param {object[]} catalogues parsed `catalogue` objects (primary + every linked library)
   * @param {string} primaryCatalogueId
   */
  constructor(gameSystem, catalogues, primaryCatalogueId) {
    this.gameSystem = gameSystem;
    this.catalogues = catalogues;
    this.primaryCatalogue = catalogues.find((c) => c.id === primaryCatalogueId) || catalogues[0];
    this.byId = new Map();
    this._defs = new WeakMap();
    for (const doc of [gameSystem, ...catalogues]) this._index(doc);
    this.costTypes = arr(gameSystem.costTypes);
    this.profileTypes = [gameSystem, ...catalogues].flatMap((d) => arr(d.profileTypes));
    this.categories = new Map();
    for (const doc of [gameSystem, ...catalogues]) {
      for (const c of arr(doc.categoryEntries)) this.categories.set(c.id, c);
    }
  }

  _index(node) {
    if (Array.isArray(node)) { for (const n of node) this._index(n); return; }
    if (!node || typeof node !== 'object') return;
    // Only index "definition" nodes: things with a name & id that are not conditions/modifiers.
    if (node.id && node.name !== undefined && !this.byId.has(node.id)) this.byId.set(node.id, node);
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') this._index(v);
    }
  }

  get(id) { return this.byId.get(id); }

  def(raw, link, kind) {
    const key = link || raw;
    let d = this._defs.get(key);
    if (!d) {
      d = new EntryDef(this, raw, link, kind);
      this._defs.set(key, d);
    }
    return d;
  }

  resolveLink(link) {
    const target = this.byId.get(link.targetId);
    if (!target) return null;
    const kind = link.type === 'selectionEntryGroup' ? 'group' : 'entry';
    return this.def(target, link, kind);
  }

  costTypeName(id) {
    const c = this.costTypes.find((t) => t.id === id);
    return c ? c.name : id;
  }

  get ptsTypeId() {
    const c = this.costTypes.find((t) => t.name === 'pts') || this.costTypes[0];
    return c ? c.id : null;
  }

  /** Force entries available to build (from the game system and the primary catalogue). */
  get forceEntries() {
    const out = [];
    const walk = (list) => {
      for (const f of arr(list)) {
        out.push(f);
        walk(f.forceEntries);
      }
    };
    walk(this.gameSystem.forceEntries);
    walk(this.primaryCatalogue.forceEntries);
    return out;
  }

  /** Root entry defs available in a force from `catalogue` (includes game system + imported roots). */
  rootEntries(catalogue = this.primaryCatalogue) {
    const out = [];
    const seen = new Set();
    // Entries from imported catalogues are only included when marked `import`.
    const addFrom = (doc, imported) => {
      for (const e of arr(doc.selectionEntries)) {
        if (!imported || e.import !== false) out.push(this.def(e, null, 'entry'));
      }
      for (const l of arr(doc.entryLinks)) {
        if (imported && l.import === false) continue;
        const d = this.resolveLink(l);
        if (d && !d.isGroup) out.push(d);
      }
    };
    const visit = (doc) => {
      if (!doc || seen.has(doc.id)) return;
      addFrom(doc, seen.size > 0);
      seen.add(doc.id);
      for (const cl of arr(doc.catalogueLinks)) {
        if (cl.importRootEntries) visit(this.catalogues.find((c) => c.id === cl.targetId));
      }
    };
    addFrom(this.gameSystem);
    visit(catalogue);
    return out;
  }

  /** Resolve an infoLink to { kind, node } where kind is 'profile' | 'rule' | 'infoGroup'. */
  resolveInfoLink(link) {
    const node = this.byId.get(link.targetId);
    if (!node) return null;
    return { kind: link.type, node };
  }
}

export { arr };
