// Export a roster as a BattleScribe roster file (.ros XML, rosterSchema), the format read by
// BattleScribe, New Recruit and Yellowscribe (the Tabletop Simulator army importer).
//
// Like BattleScribe, every selection carries its own resolved profiles, rules, costs and
// categories, and `number` is the total count (e.g. 10 gauss flayers under 10 Warriors).

import { uid } from './roster.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const escAttr = (s) => esc(s).replace(/\r?\n/g, '&#10;');
const num = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

function attrs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
}

/** BattleScribe entry path: "linkId::targetId" for linked entries, otherwise the entry id. */
const entryIdOf = (def) => (def.link ? `${def.link.id}::${def.raw.id}` : def.raw.id);

/**
 * @param {import('./engine.js').RosterEngine} engine
 * @returns {string} roster XML
 */
export function toBattleScribeXml(engine) {
  const data = engine.data;
  const r = engine.roster;
  const gs = data.gameSystem;
  const costTypes = data.costTypes;
  const out = [];
  const w = (depth, line) => out.push('  '.repeat(depth) + line);

  const costsXml = (depth, valueOf) => {
    w(depth, '<costs>');
    for (const t of costTypes) {
      const v = valueOf(t.id);
      if (v == null) continue;
      w(depth + 1, `<cost${attrs({ name: t.name, typeId: t.id, value: num(v) })}/>`);
    }
    w(depth, '</costs>');
  };

  const categoriesXml = (depth, sel) => {
    const st = engine.evaluate(sel);
    const ids = [...st.categories].filter((id) => data.categories.has(id));
    if (!ids.length) return;
    w(depth, '<categories>');
    for (const id of ids) {
      w(depth + 1, `<category${attrs({ id: uid(), name: data.categories.get(id).name, entryId: id, primary: String(id === st.primaryCategory) })}/>`);
    }
    w(depth, '</categories>');
  };

  const infoXml = (depth, sel) => {
    const info = engine.describe(sel, { deep: false });
    if (info.rules.length) {
      w(depth, '<rules>');
      for (const rule of info.rules) {
        w(depth + 1, `<rule${attrs({ id: uid(), name: rule.name, hidden: 'false' })}>`);
        w(depth + 2, `<description>${esc(rule.description || '')}</description>`);
        w(depth + 1, '</rule>');
      }
      w(depth, '</rules>');
    }
    if (info.profiles.length) {
      w(depth, '<profiles>');
      for (const p of info.profiles) {
        w(depth + 1, `<profile${attrs({ id: uid(), name: p.name, hidden: 'false', typeId: p.typeId, typeName: p.typeName })}>`);
        w(depth + 2, '<characteristics>');
        for (const c of p.characteristics) {
          w(depth + 3, `<characteristic${attrs({ name: c.name, typeId: c.typeId })}>${esc(c.value)}</characteristic>`);
        }
        w(depth + 2, '</characteristics>');
        w(depth + 1, '</profile>');
      }
      w(depth, '</profiles>');
    }
  };

  /** @param {number} mult how many copies of the parent there are in total */
  const selectionXml = (depth, sel, mult) => {
    const total = mult * sel.number;
    const group = sel.groupPath[sel.groupPath.length - 1];
    w(depth, `<selection${attrs({
      id: sel.id,
      name: engine.displayName(sel),
      entryId: entryIdOf(sel.def),
      entryGroupId: group ? entryIdOf(group) : undefined,
      number: num(total),
      type: sel.def.type,
      from: group ? 'group' : 'entry',
    })}>`);
    infoXml(depth + 1, sel);
    if (sel.children.length) {
      w(depth + 1, '<selections>');
      for (const c of sel.children) selectionXml(depth + 2, c, total);
      w(depth + 1, '</selections>');
    }
    costsXml(depth + 1, (typeId) => engine.ownCost(sel, typeId) * total);
    categoriesXml(depth + 1, sel);
    w(depth, '</selection>');
  };

  const limits = engine.costLimits();
  w(0, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  w(0, `<roster${attrs({
    id: r.id,
    name: r.name,
    battleScribeVersion: '2.03',
    generatedBy: 'PawHammer',
    gameSystemId: gs.id,
    gameSystemName: gs.name,
    gameSystemRevision: gs.revision,
    xmlns: 'http://www.battlescribe.net/schema/rosterSchema',
  })}>`);
  costsXml(1, (typeId) => engine.totalCost(r, typeId));
  const limitTypes = costTypes.filter((t) => limits[t.id] != null);
  if (limitTypes.length) {
    w(1, '<costLimits>');
    for (const t of limitTypes) w(2, `<costLimit${attrs({ name: t.name, typeId: t.id, value: num(limits[t.id]) })}/>`);
    w(1, '</costLimits>');
  }
  w(1, '<forces>');
  for (const force of r.forces) {
    const cat = data.catalogues.find((c) => c.id === force.catalogueId) || data.primaryCatalogue;
    w(2, `<force${attrs({
      id: force.id,
      name: force.forceEntry.name,
      entryId: force.forceEntry.id,
      catalogueId: cat.id,
      catalogueRevision: cat.revision,
      catalogueName: cat.name,
    })}>`);
    if (force.selections.length) {
      w(3, '<selections>');
      for (const s of force.selections) selectionXml(4, s, 1);
      w(3, '</selections>');
    }
    const forceCats = (force.forceEntry.categoryLinks || []).filter((cl) => data.categories.has(cl.targetId));
    if (forceCats.length) {
      w(3, '<categories>');
      for (const cl of forceCats) w(4, `<category${attrs({ id: uid(), name: data.categories.get(cl.targetId).name, entryId: cl.targetId, primary: 'false' })}/>`);
      w(3, '</categories>');
    }
    w(2, '</force>');
  }
  w(1, '</forces>');
  w(0, '</roster>');
  return out.join('\n');
}
