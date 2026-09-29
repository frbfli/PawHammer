// Build a PawHammer roster from a parsed text list (see gw-app-text.js).
//
// Lists name units, model groups and weapon *totals*; BSData models loadouts as model
// variants ("Legionary w/ chainsword") and option groups. The importer:
//   1. sets Battle Size, Detachment(s) and Force Disposition,
//   2. adds each unit by name,
//   3. picks the model variants whose weapons best cover each group's listed weapons,
//   4. fits the options of single models (champions, characters, vehicles) to their weapons,
//   5. applies enhancements, the Warlord and Leader/Support attachments,
//   6. compares the result with the list and reports anything that didn't match.

import { RosterEngine } from '../engine/engine.js';

// ---------------------------------------------------------------- name matching

/** Normalise a name for comparison: case, quotes, "w/", "[Legends]", spacing. */
export function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"')
    .replace(/\[legends\]/g, '')
    .replace(/\bw\/\s*/g, 'with ')
    .replace(/\s+/g, ' ').trim();
}

/** Weapon key: normalised name without the profile arrow or a " - mode" suffix. */
export function weaponKey(s) {
  return norm(String(s || '').replace(/^\s*➤\s*/, '').replace(/\s+-\s+.*$/, ''));
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Same thing, allowing small spelling differences ("Absolvor" / "Absolver") in longer names. */
function sameName(a, b) {
  if (a === b) return true;
  const squash = (s) => s.replace(/[^a-z0-9]/g, '');
  const x = squash(a);
  const y = squash(b);
  if (x === y) return true;
  const limit = Math.min(x.length, y.length) >= 8 ? 2 : Math.min(x.length, y.length) >= 5 ? 1 : 0;
  return limit > 0 && levenshtein(x, y) <= limit;
}

const singular = (s) => s.replace(/(?<=[a-z])s$/, '');

function bestByName(items, name, getName) {
  const n = norm(name);
  return items.find((it) => norm(getName(it)) === n) ||
    items.find((it) => singular(norm(getName(it))) === singular(n)) ||
    items.find((it) => sameName(norm(getName(it)), n)) || null;
}

// ---------------------------------------------------------------- option tree helpers

/** Every visible option under `owner`, with the group node that directly contains it. */
function flatOptions(engine, owner) {
  const out = [];
  const walk = (branch, group) => {
    for (const o of branch.entries) if (!o.hidden) out.push({ opt: o, group, owner });
    for (const g of branch.groups) if (!g.hidden) walk(g, g);
  };
  walk(engine.optionTree(owner), null);
  return out;
}

/** Weapon/profile keys an entry provides by default (its own profiles and those of its children). */
function entryKeys(data, def, depth = 0) {
  const keys = new Set([weaponKey(def.name)]);
  for (const p of def.profiles) keys.add(weaponKey(p.name));
  for (const l of def.infoLinks) {
    if (l.type !== 'profile') continue;
    const t = data.get(l.targetId);
    if (t) keys.add(weaponKey(t.name));
  }
  if (depth < 2) for (const c of def.children.entries) for (const k of entryKeys(data, c, depth + 1)) keys.add(k);
  return keys;
}

/** Weapon counts (by key) carried by a selection and everything under it. */
function carried(engine, sel) {
  const counts = new Map();
  for (const p of engine.describe(sel).profiles) {
    if (!/weapon/i.test(p.typeName)) continue;
    const k = weaponKey(p.name);
    counts.set(k, Math.max(counts.get(k) || 0, p.count)); // weapon modes share a key
  }
  return counts;
}

const hasKey = (keys, k) => [...keys].some((x) => sameName(x, k));

// ---------------------------------------------------------------- import

/**
 * @param {import('../engine/gamedata.js').GameData} data  game data for the list's faction
 * @param {ReturnType<import('./gw-app-text.js').parseGwAppText>} list
 * @returns {{ engine: RosterEngine, report: { warnings: string[], units: object[], listedPoints: number, importedPoints: number } }}
 */
export function importList(data, list) {
  const engine = RosterEngine.create(data, { name: list.name || 'Imported list' });
  const force = engine.roster.forces[0];
  const warnings = [];
  const config = (name) => force.selections.find((s) => s.def.name === name);

  // 1. Army configuration.
  const choose = (selName, wanted, pred) => {
    const sel = config(selName);
    if (!sel) return false;
    const hit = flatOptions(engine, sel).find(pred);
    if (!hit) { warnings.push(`${selName}: couldn't find "${wanted}".`); return false; }
    if (hit.group && hit.group.max === 1) engine.chooseInGroup(sel, hit.group.def, hit.opt.def, hit.opt.groupPath);
    else engine.setOptionCount(sel, hit.opt.def, hit.opt.groupPath, 1);
    return true;
  };
  if (list.battleSize || list.pointsLimit) {
    const pts = (list.battleSize && list.battleSize.points) || list.pointsLimit;
    const byName = list.battleSize ? norm(list.battleSize.name) : null;
    const ok = choose('Battle Size', list.battleSize ? list.battleSize.name : `${pts} points`, ({ opt }) => {
      const m = /\(([\d,]+)\s*points?\s*limit\)/i.exec(opt.state.name);
      return (m && Number(m[1].replace(/,/g, '')) === pts) || (byName && norm(opt.state.name).includes(byName));
    });
    if (!ok) engine.setCostLimit(engine.ptsTypeId, pts);
  }
  for (const det of list.detachments) choose('Detachment', det.name, ({ opt }) => sameName(norm(opt.state.name), norm(det.name)));
  if (list.forceDisposition) choose('Force Disposition', list.forceDisposition, ({ opt }) => sameName(norm(opt.state.name), norm(list.forceDisposition)));

  // 2-5. Units.
  const rootOptions = () => engine.optionTree(force).entries.filter((o) => o.def.type !== 'upgrade');
  const unitReports = [];
  const built = [];
  for (const u of list.units) {
    const notes = [];
    const report = { name: u.name, listedPoints: u.points, importedPoints: 0, notes };
    unitReports.push(report);
    const opt = bestByName(rootOptions(), u.name, (o) => o.def.name);
    if (!opt) { notes.push(`Not found in the ${data.primaryCatalogue.name} data, so it was skipped.`); continue; }
    if (opt.hidden) notes.push('Not normally available with the current army options (e.g. Legends).');
    const sel = engine.addSelection(force, opt.def);
    try {
      buildUnit(engine, sel, u, notes);
    } catch (err) {
      notes.push(`Import error: ${err.message}`);
    }
    for (const enh of u.enhancements) {
      const hit = flatOptions(engine, sel).find(({ opt: o }) => sameName(norm(o.state.name), norm(enh)));
      if (!hit) { notes.push(`Enhancement "${enh}" not found.`); continue; }
      if (hit.group && hit.group.max === 1) engine.chooseInGroup(sel, hit.group.def, hit.opt.def, hit.opt.groupPath);
      else engine.setOptionCount(sel, hit.opt.def, hit.opt.groupPath, 1);
    }
    built.push({ u, sel, report });
  }

  for (const { u, sel, report } of built) {
    if (!u.warlord) continue;
    try { engine.setWarlord(force, sel); } catch (err) { report.notes.push(`Warlord: ${err.message}`); }
  }

  // Attachments: each "Attached unit N" block is a bodyguard plus its Leader/Support characters.
  const blocks = new Map();
  for (const b of built) if (b.u.attachedGroup != null) {
    if (!blocks.has(b.u.attachedGroup)) blocks.set(b.u.attachedGroup, []);
    blocks.get(b.u.attachedGroup).push(b);
  }
  for (const members of blocks.values()) {
    const bodyguard = members.find((m) => /bodyguard/i.test(m.u.role || '')) ||
      members.find((m) => !engine.associationDefs(m.sel).length);
    if (!bodyguard) continue;
    for (const m of members) {
      if (m === bodyguard) continue;
      const role = /support/i.test(m.u.role || '') ? /support/i : /lead/i;
      const assocs = engine.associationDefs(m.sel);
      const assoc = assocs.find((a) => role.test(`${a.name} ${a.label}`) && engine.canAttach(m.sel, a, bodyguard.sel)) ||
        assocs.find((a) => engine.canAttach(m.sel, a, bodyguard.sel));
      if (assoc) engine.attach(m.sel, assoc.id, bodyguard.sel);
      else m.report.notes.push(`Couldn't attach to ${bodyguard.u.name}: not allowed by the data.`);
    }
  }

  // 6. Compare with the list.
  for (const { u, sel, report } of built) {
    report.importedPoints = engine.points(sel);
    // What the unit ended up with: weapon profiles plus the names of everything selected
    // (so wargear like a Chaos Icon counts too).
    const have = new Set(carried(engine, sel).keys());
    for (const s of engine.walk(sel)) have.add(weaponKey(s.def.name));
    const listed = listedWeapons(engine, sel, u);
    const missing = [...listed.keys()].filter((k) => ![...have].some((h) => sameName(h, k)));
    if (missing.length) report.notes.push(`Not matched: ${missing.map((k) => listed.get(k)).join(', ')}.`);
    const wantModels = u.items.filter((it) => it.children.length || isModelName(engine, sel, it.name)).reduce((n, it) => n + it.count, 0);
    const models = engine.modelCount(sel);
    if (sel.def.type === 'unit' && wantModels && models !== wantModels) report.notes.push(`${models} models instead of ${wantModels}.`);
    if (report.importedPoints !== u.points) report.notes.push(`${report.importedPoints} pts in the data vs ${u.points} pts in the list.`);
  }

  engine.roster.name = list.name || engine.roster.name;
  return {
    engine,
    report: {
      warnings,
      units: unitReports,
      listedPoints: list.units.reduce((n, u) => n + u.points, 0),
      importedPoints: engine.points(),
    },
  };
}

// ---------------------------------------------------------------- units

/** Model options of a unit (flattened across groups). */
function modelOptions(engine, unit) {
  return flatOptions(engine, unit).filter(({ opt }) => opt.def.type === 'model');
}

/** Model variants matching a list model name, e.g. "Legionary" -> "Legionary w/ chainsword", … */
function variantsFor(engine, unit, name) {
  const n = singular(norm(name));
  const all = modelOptions(engine, unit);
  const base = (o) => singular(norm(o.opt.def.name).split(' with ')[0]);
  let c = all.filter((o) => base(o) === n || sameName(base(o), n));
  if (!c.length) c = all.filter((o) => n.endsWith(' ' + base(o)) || base(o).endsWith(' ' + n));
  return c;
}

function isModelName(engine, unit, name) {
  return unit.def.type === 'unit' && variantsFor(engine, unit, name).length > 0;
}

function listedWeapons(engine, unit, u) {
  const out = new Map();
  const add = (it) => out.set(weaponKey(it.name), it.name);
  for (const it of u.items) {
    if (it.children.length) it.children.forEach(add);
    else if (!isModelName(engine, unit, it.name)) add(it);
  }
  return out;
}

function buildUnit(engine, unit, u, notes) {
  const groups = [];
  const direct = [];
  for (const it of u.items) {
    if (unit.def.type === 'unit' && (it.children.length || variantsFor(engine, unit, it.name).length)) groups.push(it);
    else direct.push(it);
  }

  if (groups.length) {
    // Choose model variants for every group, then set all model counts at once.
    const plan = new Map(); // def -> { opt, count }
    const assigned = [];
    for (const g of groups) {
      let cands = variantsFor(engine, unit, g.name);
      if (!cands.length) {
        const models = modelOptions(engine, unit);
        if (models.length === 1) cands = models; // e.g. "Possessed Champion" in a unit of "Possessed"
      }
      if (!cands.length) { notes.push(`Model "${g.name}" not found.`); continue; }
      const picks = cands.length === 1 ? [{ o: cands[0], count: g.count }] : pickVariants(engine, unit, cands, g, plan);
      for (const { o, count } of picks) {
        const p = plan.get(o.opt.def) || { o, count: 0 };
        p.count += count;
        plan.set(o.opt.def, p);
      }
      assigned.push({ g, picks });
    }
    for (const o of modelOptions(engine, unit)) {
      const want = plan.has(o.opt.def) ? plan.get(o.opt.def).count : 0;
      if (want !== o.opt.count) engine.setOptionCount(unit, o.opt.def, o.opt.groupPath, want);
    }
    // Single models (champions, named characters) get their options fitted to their weapons.
    for (const { g, picks } of assigned) {
      if (g.count !== 1 || picks.length !== 1) continue;
      const model = unit.children.find((c) => c.def === picks[0].o.opt.def);
      if (model) fitWeapons(engine, model, g.children, notes, unit);
    }
  }

  if (direct.length) {
    // Wargear listed directly: a single-model unit or vehicle.
    const models = unit.children.filter((c) => c.def.type === 'model');
    const target = unit.def.type === 'model' ? unit : models.length === 1 && models[0].number === 1 ? models[0] : unit;
    fitWeapons(engine, target, direct, notes, unit);
  }
}

/** Greedily choose model variants whose default weapons best cover the group's listed weapons. */
function pickVariants(engine, unit, cands, g, plan) {
  const loadouts = new Map();
  const loadout = (o) => {
    if (!loadouts.has(o)) {
      const counts = new Map();
      for (const p of engine.previewEntry(unit, o.opt.def).info.profiles) {
        if (!/weapon/i.test(p.typeName)) continue;
        const k = weaponKey(p.name);
        counts.set(k, Math.max(counts.get(k) || 0, p.count));
      }
      loadouts.set(o, counts);
    }
    return loadouts.get(o);
  };
  const remaining = new Map(g.children.map((c) => [weaponKey(c.name), c.count]));
  const used = new Map();
  const lookup = (m, k) => { for (const [x, v] of m) if (sameName(x, k)) return [x, v]; return null; };
  // Weapons few variants carry say more about which variant a model is (a combi-weapon vs the
  // bolt pistol everyone has), so matches are weighted by rarity.
  const weight = (k) => {
    const carriers = cands.filter((o) => lookup(loadout(o), k)).length;
    return carriers ? 1 + 1 / carriers : 1;
  };
  for (let i = 0; i < g.count; i++) {
    let best = null;
    let bestScore = -Infinity;
    for (const o of cands) {
      const already = (used.get(o) || 0) + ((plan.get(o.opt.def) || {}).count || 0);
      if (already >= o.opt.max) continue;
      let score = 0;
      for (const [k, n] of loadout(o)) {
        const hit = lookup(remaining, k);
        const avail = hit ? hit[1] : 0;
        score += 2 * weight(k) * Math.min(n, avail) - Math.max(0, n - avail);
      }
      if (score > bestScore || (score === bestScore && best && o.opt.def.name.length < best.opt.def.name.length)) { best = o; bestScore = score; }
    }
    if (!best) best = cands[0];
    used.set(best, (used.get(best) || 0) + 1);
    for (const [k, n] of loadout(best)) {
      const hit = lookup(remaining, k);
      if (hit) remaining.set(hit[0], Math.max(0, hit[1] - n));
    }
  }
  return [...used.entries()].map(([o, count]) => ({ o, count }));
}

/**
 * Select options on `target` so it carries the listed items (weapons or wargear), then drop
 * optional weapons that aren't listed. Items the target can't take are tried on the unit.
 */
function fitWeapons(engine, target, items, notes, unit) {
  const data = engine.data;
  const want = new Map();
  for (const it of items) {
    const k = weaponKey(it.name);
    want.set(k, { name: it.name, count: (want.has(k) ? want.get(k).count : 0) + it.count });
  }
  const select = (owner, hit, count) => {
    if (hit.group && hit.group.max === 1) engine.chooseInGroup(owner, hit.group.def, hit.opt.def, hit.opt.groupPath);
    else engine.setOptionCount(owner, hit.opt.def, hit.opt.groupPath, Math.min(Math.max(count, 1), hit.opt.max));
  };
  const find = (owner, k) => {
    const opts = flatOptions(engine, owner);
    return opts.find(({ opt }) => sameName(weaponKey(opt.def.name), k)) ||
      opts.find(({ opt }) => hasKey(entryKeys(data, opt.def), k)) || null;
  };

  const haveCount = (k) => {
    let n = 0;
    for (const [x, c] of carried(engine, target)) if (sameName(x, k)) n = Math.max(n, c);
    for (const { opt } of flatOptions(engine, target)) {
      if (opt.count > 0 && sameName(weaponKey(opt.def.name), k)) n = Math.max(n, opt.count);
    }
    return n;
  };
  for (const [k, w] of want) {
    // Keep selecting until the listed count is carried, e.g. two heavy melee weapons that
    // replace a bolt pistol and a boltgun come from two different option groups.
    let progressed = true;
    for (let guard = 0; guard < 6 && progressed && haveCount(k) < w.count; guard++) {
      progressed = false;
      const opts = flatOptions(engine, target).filter(({ opt }) => opt.count < opt.max &&
        (sameName(weaponKey(opt.def.name), k) || hasKey(entryKeys(data, opt.def), k)));
      // Prefer an unused option, and a choice in a group that doesn't already provide this weapon.
      const hit = opts.find(({ opt, group }) => opt.count === 0 && !(group && group.entries.some((x) => x.count > 0 && sameName(weaponKey(x.def.name), k)))) ||
        opts.find(({ group }) => !group || group.max !== 1);
      if (hit) {
        const need = w.count - haveCount(k);
        select(target, hit, hit.group && hit.group.max === 1 ? 1 : hit.opt.count + need);
        progressed = true;
      }
    }
    if (haveCount(k) > 0) continue;
    if (unit !== target) {
      const up = find(unit, k);
      if (up && up.opt.def.type !== 'model') { select(unit, up, 1); continue; }
    }
    notes.push(`Couldn't select "${w.name}".`);
  }

  // Drop defaults the list doesn't include (only removable, weapon-bearing options).
  for (const { opt, group } of flatOptions(engine, target)) {
    if (!opt.count || opt.min > 0 || opt.def.type === 'model') continue;
    if (group && group.min > 0 && group.max === 1) continue; // a required choice; it was replaced above if needed
    const keys = entryKeys(data, opt.def);
    const wanted = [...keys].some((x) => [...want.keys()].some((k) => sameName(x, k)));
    const isWeapon = opt.def.profiles.some((p) => /weapon/i.test(p.typeName || '')) || [...keys].some((x) => x !== weaponKey(opt.def.name));
    if (!wanted && isWeapon && !/warlord/i.test(opt.def.name)) engine.setOptionCount(target, opt.def, opt.groupPath, 0);
  }
}
