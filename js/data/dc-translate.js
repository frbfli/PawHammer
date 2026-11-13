// Translates a 40kdc-data faction (github.com/wn-mitch/40kdc-data, CC BY 4.0) into the
// BattleScribe-shaped game system + catalogue that GameData / RosterEngine already understand:
//
//   unit + composition       -> unit entry with model entries (one per model row; rows of several
//                               models get one entry per loadout so a squad can mix weapons)
//   points rows              -> pts cost modifiers on the model count and on how many copies of
//                               the unit were added before (escalating costs)
//   wargear options          -> choice groups on single models, loadout variants on larger rows
//   leader attachments       -> leader associations
//   detachments / dispositions / enhancements / stratagems -> configuration entries and options
//
// Ability rules text comes from the 40kdc describer (`describe`), or the data's own notes.

const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
const dekebab = (id) => { const s = String(id).replace(/-/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
const plus = (v) => (v == null || v === '' ? '' : typeof v === 'number' ? `${v}+` : String(v));
const inch = (v) => (v == null || v === '' ? '-' : typeof v === 'number' ? `${v}"` : String(v));
const num = (v) => (v == null || v === '' ? '-' : String(v));

/** Matched play is the default mode: records tagged only for other modes are left out. */
const matchedPlay = (r) => !r || !r.game_modes || r.game_modes.includes('matched-play');

export const GS_ID = '40kdc-11e';
export const PTS = 'pts';
export const DP = 'dp';
const T_UNIT = 'pt-unit';
const T_RANGED = 'pt-ranged';
const T_MELEE = 'pt-melee';
const T_ABILITY = 'pt-abilities';
const T_STRAT = 'pt-stratagem';
const T_ENH = 'pt-enhancement';
const CAT_CONFIG = 'cat-configuration';
const CAT_WARLORD = 'cat-warlord';
const CAT_OTHER = 'cat-other';
const BATTLE_SIZES = [
  { id: 'bs-incursion', name: 'Incursion (1,000 Point limit)', dp: 2 },
  { id: 'bs-strike-force', name: 'Strike Force (2,000 Point limit)', dp: 3 },
];
/** Display order of the army list sections (by primary category). */
const ROLE_ORDER = ['Epic Hero', 'Character', 'Battleline', 'Infantry', 'Mounted', 'Beasts', 'Beast', 'Swarm', 'Monster', 'Vehicle', 'Dedicated Transport', 'Fortification'];
/** Unit type keywords used to group the rest, in priority order. */
const TYPE_ROLES = ['Fortification', 'Monster', 'Vehicle', 'Mounted', 'Beasts', 'Beast', 'Swarm', 'Infantry'];

/** Model count of a unit (models anywhere below it), for points and squad-size rules. */
const modelCount = (type, value) => ({ type, value, field: 'selections', scope: 'self', childId: 'model', includeChildSelections: true, shared: true });

export function translate({ faction, parent, siblings = [], files, core, abilities, describe }) {
  const t = new Translator({ faction, parent, siblings, files, core, abilities, describe });
  return t.run();
}

class Translator {
  constructor({ faction, parent, siblings, files, core, abilities, describe }) {
    this.faction = faction;
    this.parent = parent || null;
    this.siblings = siblings;
    this.files = files;
    this.core = core;
    this.abilities = abilities; // Map ability_id -> record
    this.describe = describe;
    this.categories = new Map(); // id -> categoryEntry
    this.weapons = new Map(arr(files.weapons).map((w) => [w.id, w]));
    this.wargear = new Map(arr(files.wargear).map((w) => [w.id, w]));
    this.weaponKeywords = new Map(arr(core.weaponKeywords).map((k) => [k.id, k.name]));
    this.unitKeywords = new Map(arr(core.unitKeywords).map((k) => [k.id, k.name]));
    this.textCache = new Map();
    this.seq = 0;
    this.used = new Set();
  }

  /** Throwaway ids (constraints, category links, profiles): never stored in rosters. */
  uid(prefix) { return `${prefix}#${++this.seq}`; }

  /**
   * Stable ids for entries and groups, built from names, so saved rosters and share codes keep
   * working when unrelated data changes. Duplicates within a unit get a numeric suffix.
   */
  eid(base) {
    let id = base;
    for (let n = 2; this.used.has(id); n++) id = `${base}~${n}`;
    this.used.add(id);
    return id;
  }

  // ---------------------------------------------------------------- categories

  category(id, name, extra = {}) {
    if (!this.categories.has(id)) this.categories.set(id, { id, name, hidden: false, ...extra });
    return id;
  }
  keywordCat(name) { return this.category('kw:' + slug(name), name); }
  factionCat(name) { return this.category('fk:' + slug(name), `Faction: ${name}`); }

  // ---------------------------------------------------------------- text

  /** Readable rules text for an ability record: the data's own note when it reads as one, else the describer. */
  abilityText(rec) {
    if (!rec) return '';
    if (this.textCache.has(rec)) return this.textCache.get(rec);
    const note = typeof rec.community_notes === 'string' ? rec.community_notes.trim() : '';
    const clean = note && !/^\[|community-authored|raw-text store|see #\d+/i.test(note) ? note : '';
    let text = clean;
    if (!text && this.describe) {
      try { text = String(this.describe(rec) || '').trim(); } catch { text = ''; }
    }
    this.textCache.set(rec, text);
    return text;
  }

  /** Name of an ability reference, with its value (e.g. "Deadly Demise D3", "Feel No Pain 5+"). */
  abilityName(id, value) {
    const rec = this.abilities.get(id);
    const name = (rec && rec.name) || this.unitKeywords.get(id) || dekebab(id);
    if (value == null) return name;
    if (/feel-no-pain/.test(id)) return `${name} ${plus(value)}`;
    if (/scouts|infiltrat/.test(id) && typeof value === 'number') return `${name} ${value}"`;
    if (id === 'damaged') return `Damaged: 1-${value} Wounds Remaining`;
    return `${name} ${value}`;
  }

  /** Rules shown as badges (core / faction abilities) vs ability profiles shown in full. */
  abilityInfo(ref, ownerId) {
    const id = typeof ref === 'string' ? ref : ref.id;
    const value = typeof ref === 'string' ? null : ref.value;
    const rec = this.abilities.get(id);
    const name = this.abilityName(id, value);
    const text = this.abilityText(rec);
    const isRule = !rec || rec.ability_type === 'core' || rec.ability_type === 'faction';
    if (isRule) return { rule: { id: `${ownerId}#r:${id}`, name, description: text } };
    return { profile: this.abilityProfile(`${ownerId}#a:${id}`, name, text) };
  }

  abilityProfile(id, name, text, typeName = 'Abilities', typeId = T_ABILITY) {
    return { id, name, hidden: false, typeId, typeName, characteristics: [{ name: 'Description', typeId: typeId + ':desc', $text: text || '' }] };
  }

  // ---------------------------------------------------------------- profiles

  unitProfile(id, p, base) {
    const c = (name, $text, typeId = T_UNIT + ':' + name) => ({ name, typeId, $text });
    return {
      id, name: p.name, hidden: false, typeId: T_UNIT, typeName: 'Unit',
      characteristics: [
        c('M', inch(p.M)), c('T', num(p.T)), c('Sv', plus(p.Sv) || '-'), c('W', num(p.W)),
        c('Ld', plus(p.Ld) || '-'), c('OC', num(p.OC)), c('InSv', plus(p.invuln_sv)),
        c('Base', base || '', 'nr-base-size'),
      ],
    };
  }

  baseText(b) {
    if (!b) return '';
    if (b.diameter) return `${b.diameter}mm`;
    if (b.width && b.length) return `${b.width}x${b.length}mm`;
    if (b.shape === 'hull') return 'Hull';
    if (b.shape === 'flying-base') return `Flying base${b.size ? ` (${b.size})` : ''}`;
    return b.shape ? dekebab(b.shape) : '';
  }

  keywordText(k) {
    const p = k.parameters || {};
    if (k.keyword_id === 'anti') return `Anti-${p.target_keyword || '?'}${p.threshold != null ? ` ${p.threshold}+` : ''}`;
    let s = this.weaponKeywords.get(k.keyword_id) || dekebab(k.keyword_id);
    if (p.value != null) s += ` ${p.value}`;
    if (p.threshold != null) s += ` ${p.threshold}+`;
    if (p.target_keyword) s += ` ${p.target_keyword}`;
    if (arr(p.excluded_target_keywords).length) s += `: non-${p.excluded_target_keywords.join('/')}`;
    if (arr(p.required_target_keywords_any).length) s += `: ${p.required_target_keywords_any.join('/')}`;
    return s;
  }

  weaponProfiles(entryId, w) {
    const many = arr(w.profiles).length > 1;
    return arr(w.profiles).map((p, i) => {
      const melee = w.type === 'melee' || p.range === 'Melee';
      const typeId = melee ? T_MELEE : T_RANGED;
      const s = p.stats || {};
      const c = (name, $text) => ({ name, typeId: typeId + ':' + name, $text });
      const pname = many && p.name && p.name !== w.name ? `${w.name} - ${p.name.toLowerCase()}` : (p.name || w.name);
      return {
        id: `${entryId}#w${i}`, name: pname, hidden: false, typeId, typeName: melee ? 'Melee Weapons' : 'Ranged Weapons',
        characteristics: [
          c('Range', melee ? 'Melee' : inch(p.range)), c('A', num(s.A)),
          melee ? c('WS', plus(s.WS) || 'N/A') : c('BS', plus(s.BS) || 'N/A'),
          c('S', num(s.S)), c('AP', num(s.AP)), c('D', num(s.D)),
          c('Keywords', arr(p.keywords).map((k) => this.keywordText(k)).join(', ') || '-'),
        ],
      };
    });
  }

  itemName(id) {
    const w = this.weapons.get(id) || this.wargear.get(id);
    const n = w ? w.name : dekebab(id);
    return n.charAt(0).toUpperCase() + n.slice(1);
  }

  /** One weapon / wargear item, `count` copies per model. */
  item(id, count, ctx, fixed = true) {
    const entryId = this.eid(`${ctx.parentId}/${id}`);
    const w = this.weapons.get(id);
    const e = { id: entryId, name: this.itemName(id), hidden: false, type: 'upgrade', profiles: w ? this.weaponProfiles(entryId, w) : [], rules: [] };
    for (const ref of arr(ctx.wargearAbilities.get(id))) {
      const info = this.abilityInfo(ref, entryId);
      if (info.rule) e.rules.push(info.rule); else e.profiles.push(info.profile);
    }
    const cost = ctx.wargearCosts.get(id);
    if (cost) e.costs = [{ typeId: PTS, value: cost, name: 'pts' }];
    if (fixed) e.constraints = [this.cons('min', count), this.cons('max', count)];
    return e;
  }

  /** Items of a loadout as fixed children: { 'bolt-pistol': 2, ... } -> entries. */
  items(counts, ctx) {
    return [...counts].map(([id, n]) => this.item(id, n, ctx));
  }

  cons(type, value, extra = {}) {
    return { id: this.uid('con'), type, value, field: 'selections', scope: 'parent', shared: true, includeChildSelections: false, ...extra };
  }

  /** An option choice (one or more items) as one selectable entry. */
  choiceEntry(ids, ctx, name) {
    const counts = countIds(ids);
    if (counts.size === 1 && [...counts.values()][0] === 1) {
      const e = this.item(ids[0], 1, ctx, false);
      if (name) e.name = name;
      return e;
    }
    const id = this.eid(`${ctx.parentId}/${[...counts.keys()].join('+')}`);
    return { id, name: name || [...counts.keys()].map((x) => this.itemName(x)).join(', '), hidden: false, type: 'upgrade', selectionEntries: this.items(counts, { ...ctx, parentId: id }) };
  }

  /** Limits on how many models may take a swap: `any number`, `1 per N models`, `up to N`. */
  swapCaps(mc) {
    const constraints = [];
    const modifiers = [];
    if (mc.any_number) return { constraints, modifiers };
    if (mc.per_n_models) {
      const con = this.cons('max', 0);
      constraints.push(con);
      modifiers.push({ field: con.id, type: 'increment', value: 1, repeats: [{ field: 'selections', scope: 'unit', childId: 'model', includeChildSelections: true, value: mc.per_n_models, repeats: 1, roundUp: false, shared: true }] });
      if (mc.max_count) constraints.push(this.cons('max', mc.max_count));
    } else {
      constraints.push(this.cons('max', mc.max_count || 1));
    }
    return { constraints, modifiers };
  }

  // ---------------------------------------------------------------- units

  unitAllowed(u) {
    if (!matchedPlay(u)) return false;
    // Space Marine chapters: a chapter sees generic units plus its own; the generic army only generic ones.
    const own = new Set(arr(this.faction.keywords));
    const others = new Set();
    for (const s of this.siblings) for (const k of arr(s.keywords)) if (!own.has(k)) others.add(k);
    return !arr(u.faction_keywords).some((k) => others.has(k));
  }

  primaryRole(u, kws) {
    const byRole = { 'epic-hero': 'Epic Hero', character: 'Character', battleline: 'Battleline', 'dedicated-transport': 'Dedicated Transport' }[u.role];
    if (byRole) return byRole;
    const has = new Set(kws.map((k) => k.toLowerCase()));
    if (has.has('epic hero')) return 'Epic Hero';
    if (has.has('character')) return 'Character';
    return TYPE_ROLES.find((r) => has.has(r.toLowerCase())) || null;
  }

  buildUnit(u, comp, ctx) {
    const kws = arr(u.keywords);
    const role = this.primaryRole(u, kws);
    const primary = role ? this.keywordCat(role) : this.category(CAT_OTHER, 'Other');
    const categoryLinks = [{ id: this.uid('cl'), targetId: primary, primary: true }];
    for (const k of kws) if (k !== role) categoryLinks.push({ id: this.uid('cl'), targetId: this.keywordCat(k), primary: false });
    for (const k of arr(u.faction_keywords)) categoryLinks.push({ id: this.uid('cl'), targetId: this.factionCat(k), primary: false });
    for (const lim of ctx.limitCats) if (lim.keywords.some((k) => kws.includes(k))) categoryLinks.push({ id: this.uid('cl'), targetId: lim.id, primary: false });

    const rows = comp ? arr(comp.models) : [{ name: u.name, min: (u.model_count || {}).min || 1, max: (u.model_count || {}).max || 1, default_weapon_ids: arr(u.weapon_ids) }];
    const profileFor = (row) => {
      const ps = arr(u.profiles);
      if (ps.length <= 1) return null;
      return ps.find((p) => p.name === (row.profile_name || row.name)) || null;
    };
    const unitProfiles = arr(u.profiles).length <= 1
      ? arr(u.profiles).map((p, i) => this.unitProfile(`${u.id}#u${i}`, p, this.baseText(rows[0] && rows[0].base_size_mm || u.base_size_mm)))
      : [];

    const e = {
      id: u.id, name: u.is_legend ? `${u.name} [Legends]` : u.name, hidden: !!u.is_legend, type: 'unit',
      aliases: arr(u.external_refs).filter((r) => r.namespace === 'bsdata').map((r) => r.id),
      categoryLinks, profiles: unitProfiles, rules: [], selectionEntries: [], selectionEntryGroups: [],
      costs: [{ typeId: PTS, value: 0, name: 'pts' }], constraints: [], modifiers: [], associations: [],
    };
    for (const ref of arr(u.ability_ids)) {
      if (typeof ref === 'object' && ref.wargear) continue; // shown on the wargear item
      const info = this.abilityInfo(ref, u.id);
      if (info.rule) e.rules.push(info.rule); else e.profiles.push(info.profile);
    }

    // Wargear options per model row: by model name, else the rows whose default loadout they change.
    const options = arr(ctx.options.get(u.id)).filter(matchedPlay);
    const rowOptions = new Map(rows.map((r) => [r.name, []]));
    for (const o of options) {
      const named = o.model_constraint && o.model_constraint.model_name;
      let targets = named ? rows.filter((r) => r.name === named) : [];
      if (!targets.length) {
        const replaces = arr(o.replaces);
        targets = replaces.length ? rows.filter((r) => replaces.every((id) => arr(r.default_weapon_ids).includes(id))) : [];
        if (!targets.length) targets = rows.filter((r) => !r.is_leader_model).slice(0, 1);
        if (!targets.length) targets = rows.slice(0, 1);
      }
      for (const r of targets) rowOptions.get(r.name).push(o);
    }

    const rowIds = new Map();
    for (const row of rows) {
      const p = profileFor(row);
      const prof = p ? [this.unitProfile(this.uid(`${u.id}#u`), p, this.baseText(row.base_size_mm || u.base_size_mm))] : [];
      const opts = rowOptions.get(row.name);
      if ((row.max || 1) <= 1 && !arr(row.loadout_variants).length) {
        const m = this.singleModel(u, row, opts, prof, ctx);
        rowIds.set(row.name, m.id);
        e.selectionEntries.push(m);
      } else {
        const g = this.modelGroup(u, row, opts, prof, ctx);
        rowIds.set(row.name, g.id);
        e.selectionEntryGroups.push(g);
      }
    }

    this.defaultSize(e, comp, rowIds);
    this.unitSizeRule(e, u, comp, rowIds);
    this.points(e, u, ctx);
    if (u.role === 'epic-hero' || kws.includes('Epic Hero')) {
      e.constraints.push({ id: this.uid('con'), type: 'max', value: 1, field: 'selections', scope: 'roster', shared: true, includeChildSelections: true, message: 'Epic Heroes are unique: your army can include only one {this}.' });
    }
    if (kws.includes('Character')) {
      e.selectionEntries.push({ id: 'warlord', name: 'Warlord', hidden: false, type: 'upgrade', categoryLinks: [{ id: this.uid('cl'), targetId: CAT_WARLORD, primary: true }], constraints: [this.cons('max', 1)] });
    }
    const enh = this.enhancementsFor(u, kws, ctx);
    if (enh) e.selectionEntryGroups.push(enh);
    return e;
  }

  /** A single model (sergeant, character, vehicle): its weapon swaps are choice groups. */
  singleModel(u, row, opts, profiles, ctx) {
    const id = this.eid(`${u.id}/${slug(row.name)}`);
    const m = { id, name: row.name, hidden: false, type: 'model', profiles, selectionEntries: [], selectionEntryGroups: [], constraints: [this.cons('min', row.min), this.cons('max', 1)] };
    const mctx = { ...ctx, unit: u, parentId: id };
    const loadout = countIds(arr(row.default_weapon_ids));
    const costEntry = (o, entry) => {
      if (o.is_free === false && o.additional_cost) entry.costs = [{ typeId: PTS, value: o.additional_cost, name: 'pts' }];
      return entry;
    };
    const swaps = opts.filter((o) => arr(o.replaces).length);
    const addOns = opts.filter((o) => !arr(o.replaces).length);
    // Swaps that touch the same weapons become one choice list over all of them (e.g. "bolt
    // rifle", "bolt rifle + knives", "knives" -> one list), so a weapon can't be replaced twice.
    const clusters = [];
    for (const o of swaps) {
      const ids = new Set(arr(o.replaces));
      const hits = clusters.filter((c) => [...ids].some((x) => c.ids.has(x)));
      const merged = { ids: new Set([...ids, ...hits.flatMap((c) => [...c.ids])]), opts: [...hits.flatMap((c) => c.opts), o] };
      for (const h of hits) clusters.splice(clusters.indexOf(h), 1);
      clusters.push(merged);
    }
    const replacedAll = new Map();
    for (const c of clusters) {
      // The cluster's own weapons, as many copies as any of its swaps removes.
      const own = new Map();
      for (const o of c.opts) for (const [x, n] of countIds(arr(o.replaces))) own.set(x, Math.max(own.get(x) || 0, Math.min(n, loadout.get(x) || n)));
      const base = [...own].flatMap(([x, n]) => Array(n).fill(x));
      for (const [x, n] of own) replacedAll.set(x, n);
      const key = [...own.keys()].sort().join('+');
      const gid = this.eid(`${id}/swap:${key}`);
      const def = this.choiceEntry(base, { ...mctx, parentId: gid });
      const g = { id: gid, name: [...own.keys()].map((x) => this.itemName(x)).join(', '), hidden: false, defaultSelectionEntryId: def.id, selectionEntries: [def], constraints: [this.cons('min', 1), this.cons('max', 1)] };
      const seen = new Set([[...base].sort().join('+')]);
      for (const o of c.opts) {
        for (const ch of o.replacement ? [arr(o.replacement)] : arr(o.replacement_choice)) {
          const ids = applySwap(base, arr(o.replaces), ch);
          const k = [...ids].sort().join('+');
          if (seen.has(k)) continue;
          seen.add(k);
          g.selectionEntries.push(costEntry(o, this.choiceEntry(ids, { ...mctx, parentId: gid })));
        }
      }
      m.selectionEntryGroups.push(g);
    }
    // Weapons nothing replaces are fixed equipment.
    const fixed = new Map(loadout);
    for (const [x, n] of replacedAll) { const left = (fixed.get(x) || 0) - n; if (left > 0) fixed.set(x, left); else fixed.delete(x); }
    m.selectionEntries.push(...this.items(fixed, mctx));
    for (const o of addOns) {
      const choices = o.replacement ? [arr(o.replacement)] : arr(o.replacement_choice);
      const max = (o.model_constraint && o.model_constraint.max_count) || 1;
      if (choices.length === 1) {
        const entry = costEntry(o, this.choiceEntry(choices[0], mctx));
        entry.constraints = [this.cons('max', max)];
        m.selectionEntries.push(entry);
      } else {
        const gid = this.eid(`${id}/add:${o.id}`);
        m.selectionEntryGroups.push({ id: gid, name: 'Optional wargear', hidden: false, constraints: [this.cons('max', max)], selectionEntries: choices.map((ch) => costEntry(o, this.choiceEntry(ch, { ...mctx, parentId: gid }))) });
      }
    }
    return m;
  }

  /**
   * A row of several models: one model entry per loadout (the default, each loadout variant,
   * and each weapon swap), so a squad can mix them. The row's size limits are on the group.
   */
  modelGroup(u, row, opts, profiles, ctx) {
    const gid = this.eid(`${u.id}/${slug(row.name)}`);
    const g = { id: gid, name: row.name, hidden: false, selectionEntries: [], selectionEntryGroups: [], constraints: [this.cons('min', row.min), this.cons('max', row.max)] };
    const variant = (name, ids, parentId = gid) => {
      const id = this.eid(`${parentId}/${slug(name)}`);
      return { id, name, hidden: false, type: 'model', profiles, selectionEntries: this.items(countIds(ids), { ...ctx, unit: u, parentId: id }), constraints: [], modifiers: [] };
    };
    const defaults = arr(row.default_weapon_ids);
    if (arr(row.loadout_variants).length) {
      const byName = new Map();
      for (const v of row.loadout_variants) {
        const e = variant(v.name, v.weapon_ids);
        if (v.max_count) e.constraints.push(this.cons('max', v.max_count));
        byName.set(v.name, e);
        g.selectionEntries.push(e);
      }
      // Individual allowances ("2 for every 5 models"); shared pools are not enforced.
      for (const b of arr(row.loadout_variant_budgets)) {
        if (b.variant_names.length !== 1) continue;
        const e = byName.get(b.variant_names[0]);
        if (!e) continue;
        if (!b.per_models) { e.constraints.push(this.cons('max', b.count)); continue; }
        const con = this.cons('max', 0);
        e.constraints.push(con);
        // Scaled by the whole unit, or by this row's models (counted through the row's group).
        const counted = b.scope === 'model-row' ? gid : 'model';
        e.modifiers.push({ field: con.id, type: 'increment', value: b.count, repeats: [{ field: 'selections', scope: 'unit', childId: counted, includeChildSelections: true, value: b.per_models, repeats: 1, roundUp: false, shared: true }] });
      }
      // Default loadout: the variant named after the row, else one with the default weapons that
      // can fill the whole row (a capped "special weapon" variant can't).
      const vs = row.loadout_variants;
      const fits = (v) => !v.max_count || v.max_count >= row.min;
      const pick = vs.find((v) => v.name === row.name && fits(v)) || vs.find((v) => sameIds(v.weapon_ids, defaults) && fits(v)) || vs.find(fits) || vs[0];
      g.defaultSelectionEntryId = byName.get(pick.name).id;
    } else {
      const base = variant(row.name, defaults);
      g.selectionEntries.push(base);
      g.defaultSelectionEntryId = base.id;
    }
    // Item-level swaps: each becomes its own loadout ("Necron Warrior w/ Gauss reaper").
    for (const o of opts) {
      const choices = o.replacement ? [arr(o.replacement)] : arr(o.replacement_choice);
      const shared = choices.length > 1 && !(o.model_constraint || {}).any_number;
      // "one of the following" under one allowance: the choices share the cap in a group.
      const sub = shared ? { id: this.eid(`${gid}/swaps:${o.id}`), name: `${row.name} swaps`, hidden: false, selectionEntries: [], ...this.swapCaps(o.model_constraint || {}) } : null;
      for (const ch of choices) {
        const e = variant(`${row.name} w/ ${ch.map((x) => this.itemName(x)).join(', ')}`, applySwap(defaults, arr(o.replaces), ch), sub ? sub.id : gid);
        if (o.is_free === false && o.additional_cost) e.costs = [{ typeId: PTS, value: o.additional_cost, name: 'pts' }];
        if (sub) { sub.selectionEntries.push(e); continue; }
        const caps = this.swapCaps(o.model_constraint || {});
        e.constraints.push(...caps.constraints);
        e.modifiers.push(...caps.modifiers);
        g.selectionEntries.push(e);
      }
      if (sub) g.selectionEntryGroups.push(sub);
    }
    return g;
  }

  /**
   * New units start at the smallest legal size: until the unit has that many models, each row's
   * minimum is that size's count for the row (afterwards the row's overall minimum applies and
   * the size rule below checks the combination).
   */
  defaultSize(e, comp, rowIds) {
    const tiers = comp && arr(comp.tiers);
    if (!tiers || tiers.length < 2) return;
    const total = (t) => t.models.reduce((n, m) => n + m.min, 0);
    const first = [...tiers].sort((a, b) => total(a) - total(b))[0];
    const holders = [...e.selectionEntries, ...e.selectionEntryGroups];
    for (const m of first.models) {
      const holder = holders.find((h) => h.id === rowIds.get(m.name));
      const min = holder && arr(holder.constraints).find((c) => c.type === 'min');
      if (!min || min.value === m.min) continue;
      holder.modifiers = arr(holder.modifiers);
      holder.modifiers.push({ field: min.id, type: 'set', value: m.min, conditionGroups: [{ type: 'and', conditions: [{ ...modelCount('lessThan', total(first)), scope: 'unit' }] }] });
    }
  }

  /** Squad sizes: an error when the model counts match none of the unit's composition rows. */
  unitSizeRule(e, u, comp, rowIds) {
    const tiers = comp && arr(comp.tiers);
    if (!tiers || tiers.length < 2) return;
    const range = (m) => (m.min === m.max ? `${m.min}` : `${m.min}-${m.max}`);
    const desc = tiers.map((t) => t.models.map((m) => `${range(m)} ${m.name}`).join(' + ')).join(', or ');
    const count = (name, type, value) => ({ type, value, field: 'selections', scope: 'self', childId: rowIds.get(name), includeChildSelections: true, shared: true });
    e.modifiers.push({
      field: 'error', type: 'add', value: `Unit size must be ${desc}.`,
      conditionGroups: [{ type: 'and', conditionGroups: tiers.map((t) => ({ type: 'or', conditions: t.models.filter((m) => rowIds.has(m.name)).flatMap((m) => [count(m.name, 'lessThan', m.min), count(m.name, 'greaterThan', m.max)]) })) }],
    });
  }

  /**
   * Points: each row sets the cost from its model count (the highest row reached wins), limited
   * to the copies of the unit it applies to (e.g. the 3rd copy onwards costs more).
   */
  points(e, u, ctx) {
    const rows = arr(u.points).filter((p) => p.cost != null);
    if (!rows.length) return;
    const sorted = [...rows].sort((a, b) => (a.unit_count_min || 1) - (b.unit_count_min || 1) || a.models - b.models);
    e.costs = [{ typeId: PTS, value: sorted[0].cost, name: 'pts' }];
    const copies = (type, value) => ({
      type: 'and',
      localConditionGroups: [{
        type, value, field: 'selections', scope: 'parent', includeChildSelections: false, repeats: 1,
        conditions: [
          { childId: 'any', field: 'selections', scope: 'self', shared: true, type: 'before', value: 1 },
          { childId: u.id, field: 'selections', scope: 'self', shared: true, type: 'instanceOf', value: 1 },
        ],
      }],
    });
    for (const p of rows.sort((a, b) => a.models - b.models)) {
      const groups = [];
      if (p.unit_count_min > 1) groups.push(copies('atLeast', p.unit_count_min - 1));
      if (p.unit_count_max != null) groups.push(copies('atMost', p.unit_count_max - 1));
      e.modifiers.push({ field: PTS, type: 'set', value: p.cost, conditions: [modelCount('atLeast', p.models)], conditionGroups: groups });
    }
    // Some detachments price a unit differently.
    for (const dp of arr(u.detachment_pricing)) {
      if (!ctx.detachmentIds.has(dp.detachment_id)) continue;
      e.modifiers.push({
        field: PTS, type: 'set', value: dp.cost,
        conditions: [modelCount('atLeast', dp.models || 1), { type: 'atLeast', value: 1, field: 'selections', scope: 'roster', childId: dp.detachment_id, includeChildSelections: true, shared: true }],
      });
    }
  }

  // ---------------------------------------------------------------- enhancements

  /**
   * The legacy flat `keyword_restrictions` list: every keyword is required ("Adeptus Astartes" +
   * "Dreadnought"), unless no unit in the army has them all, in which case it lists alternatives
   * (e.g. two datasheet names) and any one will do.
   */
  flatKeywordMatch(enh, keywords, ctx) {
    const list = arr(enh.keyword_restrictions);
    if (!this.flatMode) this.flatMode = new Map();
    if (!this.flatMode.has(enh.id)) this.flatMode.set(enh.id, ctx.unitKeywordSets.some((s) => list.every((k) => s.has(k))) ? 'all' : 'any');
    return this.flatMode.get(enh.id) === 'all' ? list.every((k) => keywords.has(k)) : list.some((k) => keywords.has(k));
  }

  enhancementsFor(u, kws, ctx) {
    if (u.role === 'epic-hero' || kws.includes('Epic Hero')) return null;
    const isChar = kws.includes('Character');
    const all = new Set([...kws, ...arr(u.faction_keywords)]);
    const hasAll = (list) => arr(list).every((k) => all.has(k));
    const entries = [];
    for (const enh of ctx.enhancements) {
      // Bearers: a matching datasheet group OR the keyword rule (any keyword group, else the
      // flat keyword list); exclusion keywords always apply. Upgrades (upgrade_tag) go on
      // whichever units these allow; ordinary enhancements only on characters.
      const groups = arr(enh.datasheet_restriction_groups);
      const dsOk = groups.some((g) => g.unit_id === u.id && hasAll(g.keywords));
      let kwOk = null; // null: no keyword rule
      if (arr(enh.keyword_restriction_groups).length) kwOk = enh.keyword_restriction_groups.some((g) => hasAll(g));
      else if (arr(enh.keyword_restrictions).length) kwOk = this.flatKeywordMatch(enh, all, ctx);
      const restricted = groups.length > 0 || kwOk !== null;
      if (enh.upgrade_tag ? !restricted : !isChar) continue;
      if (restricted && !(dsOk || kwOk)) continue;
      if (arr(enh.exclusion_keywords).some((k) => all.has(k))) continue;
      const rec = this.abilities.get(enh.ability_id);
      const entry = {
        id: enh.id, name: enh.name, hidden: true, type: 'upgrade',
        costs: [{ typeId: PTS, value: enh.cost || 0, name: 'pts' }],
        profiles: [this.abilityProfile(`${enh.id}#a`, enh.name, this.abilityText(rec))],
        constraints: [this.cons('max', 1)],
        // Only offered once its detachment is in the army.
        modifiers: [{ field: 'hidden', type: 'set', value: false, conditions: [{ type: 'atLeast', value: 1, field: 'selections', scope: 'roster', childId: enh.detachment_id, includeChildSelections: true, shared: true }] }],
      };
      const limit = enh.upgrade_tag ? enh.max_targets || 1 : enh.is_unique ? 1 : null;
      if (limit) entry.constraints.push({ id: this.uid('con'), type: 'max', value: limit, field: 'selections', scope: 'roster', shared: true, includeChildSelections: true });
      entries.push(entry);
    }
    if (!entries.length) return null;
    return { id: this.eid(`${u.id}/enhancements`), name: 'Enhancements', hidden: false, selectionEntries: entries, constraints: [this.cons('max', 1)] };
  }

  // ---------------------------------------------------------------- configuration

  configEntries(detachments, enhancements, stratagems) {
    const cfg = [{ id: this.uid('cl'), targetId: CAT_CONFIG, primary: true }];
    const forceMin = () => ({ id: this.uid('con'), type: 'min', value: 1, field: 'selections', scope: 'force', shared: true, includeChildSelections: false });
    const forceMax = () => ({ id: this.uid('con'), type: 'max', value: 1, field: 'selections', scope: 'force', shared: true, includeChildSelections: false });

    const battleSize = {
      id: 'cfg-battle-size', name: 'Battle Size', type: 'upgrade', hidden: false, categoryLinks: cfg, constraints: [forceMin(), forceMax()],
      selectionEntryGroups: [{
        id: 'cfg-battle-size-g', name: 'Battle Size', hidden: false, defaultSelectionEntryId: 'bs-strike-force',
        constraints: [this.cons('min', 1), this.cons('max', 1)],
        selectionEntries: BATTLE_SIZES.map((b) => ({ id: b.id, name: b.name, type: 'upgrade', hidden: false, constraints: [this.cons('max', 1)] })),
      }],
    };

    const dpMax = { id: 'con-dp-max', type: 'max', value: 3, field: DP, scope: 'self', shared: true, includeChildSelections: true, message: 'Your detachments cost more Detachment Points than your battle size allows.' };
    const byDet = (list) => { const m = new Map(); for (const x of list) { if (!m.has(x.detachment_id)) m.set(x.detachment_id, []); m.get(x.detachment_id).push(x); } return m; };
    const enhBy = byDet(enhancements);
    const stratBy = byDet(stratagems);
    const detachment = {
      id: 'cfg-detachment', name: 'Detachment', type: 'upgrade', hidden: false, categoryLinks: cfg, constraints: [forceMin(), forceMax(), dpMax],
      modifiers: BATTLE_SIZES.filter((b) => b.dp !== 3).map((b) => ({ field: dpMax.id, type: 'set', value: b.dp, conditions: [{ type: 'atLeast', value: 1, field: 'selections', scope: 'roster', childId: b.id, includeChildSelections: true, shared: true }] })),
      selectionEntryGroups: [{
        id: 'cfg-detachment-g', name: 'Detachments', hidden: false, constraints: [this.cons('min', 1)],
        selectionEntries: detachments.map((d) => {
          const rules = arr(d.detachment_rule_ids).length ? d.detachment_rule_ids : arr(d.detachment_rule_id);
          return {
            id: d.id, name: d.name, type: 'upgrade', hidden: false,
            costs: [{ typeId: DP, value: d.detachment_points || 0, name: 'Detachment Points' }],
            categoryLinks: arr(d.force_dispositions).map((fd) => ({ id: this.uid('cl'), targetId: 'disp:' + fd, primary: false })),
            constraints: [this.cons('max', 1)],
            rules: rules.map((id) => { const rec = this.abilities.get(id); return { id: `${d.id}#r:${id}`, name: (rec && rec.name) || dekebab(id), description: this.abilityText(rec) }; }),
            profiles: [
              ...arr(enhBy.get(d.id)).map((x) => this.abilityProfile(`${d.id}#e:${x.id}`, `${x.name} (${x.cost || 0} pts)`, this.abilityText(this.abilities.get(x.ability_id)), 'Enhancement', T_ENH)),
              ...arr(stratBy.get(d.id)).map((s) => this.stratagemProfile(`${d.id}#s:${s.id}`, s)),
            ],
          };
        }),
      }],
    };

    const disposition = {
      id: 'cfg-force-disposition', name: 'Force Disposition', type: 'upgrade', hidden: false, categoryLinks: cfg, constraints: [forceMin(), forceMax()],
      selectionEntryGroups: [{
        id: 'cfg-force-disposition-g', name: 'Force Disposition', hidden: false, constraints: [this.cons('min', 1), this.cons('max', 1)],
        // Offered once a chosen detachment allows it.
        selectionEntries: arr(this.core.forceDispositions).map((fd) => ({
          id: 'fd-' + fd.id, name: fd.name, type: 'upgrade', hidden: true, constraints: [this.cons('max', 1)],
          rules: fd.text ? [{ id: `fd-${fd.id}#r`, name: fd.name, description: fd.text }] : [],
          modifiers: [{ field: 'hidden', type: 'set', value: false, conditions: [{ type: 'atLeast', value: 1, field: 'selections', scope: 'roster', childId: 'disp:' + fd.id, includeChildSelections: true, shared: true }] }],
        })),
      }],
    };
    return [battleSize, detachment, disposition];
  }

  stratagemProfile(id, s) {
    const when = [arr(s.phases).map(dekebab).join('/'), s.player_turn ? dekebab(s.player_turn) : ''].filter(Boolean).join(', ');
    const text = this.abilityText(this.abilities.get(s.ability_id));
    return {
      id, name: `${dekebab(String(s.name).toLowerCase())} (${s.cp_cost}CP)`, hidden: false, typeId: T_STRAT, typeName: 'Stratagem',
      characteristics: [{ name: 'Description', typeId: T_STRAT + ':desc', $text: [when ? `${when}.` : '', text].filter(Boolean).join(' ') }],
    };
  }

  // ---------------------------------------------------------------- assembly

  run() {
    const f = this.files;
    const factionKw = arr(this.faction.keywords);
    this.category(CAT_CONFIG, 'Configuration');
    this.category(CAT_WARLORD, 'Warlord');
    for (const fd of arr(this.core.forceDispositions)) this.category('disp:' + fd.id, fd.name);

    const detachments = arr(f.detachments).filter(matchedPlay);
    const detachmentIds = new Set(detachments.map((d) => d.id));
    const enhancements = arr(f.enhancements).filter(matchedPlay).filter((x) => detachmentIds.has(x.detachment_id));
    const stratagems = arr(f.stratagems).filter(matchedPlay).filter((x) => detachmentIds.has(x.detachment_id));

    // Keyword limits ("Death Jester": 1): an invisible category per limit, with a max constraint.
    const limitCats = arr(this.faction.keyword_limits).concat(this.parent ? arr(this.parent.keyword_limits) : []).map((lim, i) => {
      const id = this.category(`limit:${i}`, '', {
        constraints: [{ id: `limit:${i}:max`, type: 'max', value: lim.max, field: 'selections', scope: 'force', shared: true, includeChildSelections: true,
          message: lim.max === 0 ? `${lim.keywords.join(' / ')} can't be included in this army.` : `Your army can include at most ${lim.max} ${lim.keywords.join(' / ')} unit${lim.max === 1 ? '' : 's'}.` }],
      });
      return { id, keywords: lim.keywords };
    });

    const options = new Map();
    for (const o of arr(f.options)) { if (!options.has(o.unit_id)) options.set(o.unit_id, []); options.get(o.unit_id).push(o); }
    const comps = new Map(arr(f.compositions).map((c) => [c.unit_id, c]));
    const units = arr(f.units).filter((u) => this.unitAllowed(u));
    const unitIds = new Set(units.map((u) => u.id));
    // Every unit's keywords, for reading enhancement keyword lists (see flatKeywordMatch).
    const unitKeywordSets = units.map((u) => new Set([...arr(u.keywords), ...arr(u.faction_keywords)]));

    const entries = [];
    for (const u of units) {
      const wargearAbilities = new Map();
      for (const ref of arr(u.ability_ids)) if (typeof ref === 'object' && ref.wargear) {
        if (!wargearAbilities.has(ref.wargear)) wargearAbilities.set(ref.wargear, []);
        wargearAbilities.get(ref.wargear).push(ref);
      }
      const wargearCosts = new Map(arr(u.wargear_costs).map((c) => [c.item_id, c.cost]));
      const ctx = { options, enhancements, detachmentIds, limitCats, wargearAbilities, wargearCosts, unitKeywordSets };
      entries.push(this.buildUnit(u, comps.get(u.id), ctx));
    }

    // Leaders: which units each character can join.
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const l of arr(f.leaders)) {
      const leader = byId.get(l.leader_id);
      if (!leader) continue;
      const unit = units.find((u) => u.id === l.leader_id);
      const support = unit && unit.attachment_role === 'support';
      const ids = [...arr(l.eligible_bodyguard_ids), ...arr(l.conditional_groups).flatMap((g) => arr(g.eligible_bodyguard_ids))].filter((id) => unitIds.has(id));
      const conds = [
        ...[...new Set(ids)].map((id) => ({ type: 'instanceOf', value: 1, field: 'selections', scope: 'self', childId: id, shared: true })),
        ...arr(l.eligible_bodyguard_keywords).map((k) => ({ type: 'instanceOf', value: 1, field: 'selections', scope: 'self', childId: 'kw:' + slug(k), shared: true })),
      ];
      if (!conds.length) continue;
      leader.associations.push({ id: `${l.leader_id}~assoc`, name: support ? 'Supporting' : 'Leading', label: support ? 'Support' : 'Leader', childId: 'unit', min: 0, max: 1, conditionGroups: [{ type: 'or', conditions: conds }] });
    }

    const roleCats = ROLE_ORDER.map((r) => this.keywordCat(r));
    const forceEntry = {
      id: 'force-army', name: 'Army', hidden: false,
      categoryLinks: [
        { id: 'fcl-config', targetId: CAT_CONFIG, primary: false },
        ...roleCats.map((id) => ({ id: 'fcl-' + id, targetId: id, primary: false })),
        { id: 'fcl-other', targetId: this.category(CAT_OTHER, 'Other'), primary: false },
        {
          id: 'fcl-warlord', name: 'Warlord', targetId: CAT_WARLORD, primary: false,
          constraints: [
            { id: 'warlord-min', type: 'min', value: 1, field: 'selections', scope: 'force', shared: true, includeChildSelections: true },
            { id: 'warlord-max', type: 'max', value: 1, field: 'selections', scope: 'force', shared: true, includeChildSelections: true },
          ],
        },
      ],
    };

    const gameSystem = {
      id: GS_ID, name: 'Warhammer 40,000 11th Edition', revision: 1,
      costTypes: [{ id: PTS, name: 'pts', defaultCostLimit: -1 }, { id: DP, name: 'Detachment Points', defaultCostLimit: -1 }],
      profileTypes: [
        { id: T_UNIT, name: 'Unit' }, { id: T_RANGED, name: 'Ranged Weapons' }, { id: T_MELEE, name: 'Melee Weapons' },
        { id: T_ABILITY, name: 'Abilities' }, { id: T_STRAT, name: 'Stratagem' }, { id: T_ENH, name: 'Enhancement' },
      ],
      forceEntries: [forceEntry],
      selectionEntries: this.configEntries(detachments, enhancements, stratagems),
      categoryEntries: [],
    };
    const catalogue = {
      id: this.faction.id, name: this.faction.displayName || this.faction.name, library: false, gameSystemId: GS_ID,
      keywords: factionKw,
      selectionEntries: entries,
      categoryEntries: [...this.categories.values()],
    };
    return { gameSystem, catalogue };
  }
}

// ---------------------------------------------------------------- loadout helpers

function countIds(ids) {
  const m = new Map();
  for (const id of ids) m.set(id, (m.get(id) || 0) + 1);
  return m;
}

function sameIds(a, b) {
  const x = countIds(arr(a));
  const y = countIds(arr(b));
  if (x.size !== y.size) return false;
  for (const [k, v] of x) if (y.get(k) !== v) return false;
  return true;
}

/** A loadout after a swap: remove each replaced item once, then add the replacement. */
function applySwap(defaults, replaces, replacement) {
  const out = [...defaults];
  for (const id of replaces) { const i = out.indexOf(id); if (i >= 0) out.splice(i, 1); }
  return [...out, ...replacement];
}
