// Which units the Unit Lookup lists for a faction: the army's own datasheets only.
// Leaves out entries the data hides by default (Legends, Unbound Adversaries, …) and allied
// units (Chaos Knights in a Chaos Space Marines army, Titans, Agents of the Imperium, …).

const FACTION = /^Faction:\s*/i;

/**
 * @param {import('../engine/engine.js').RosterEngine} engine
 * @param {import('../engine/roster.js').Force} force
 * @returns {{ units: object[], excluded: object[], factionKeywords: string[] }} option-tree entries
 */
export function lookupUnits(engine, force) {
  const data = engine.data;
  const catNames = (o) => [...o.state.categories].map((id) => (data.categories.get(id) || {}).name || '');
  const candidates = engine.optionTree(force).entries.filter((o) => o.def.type !== 'upgrade' && !o.hidden && !/\[legends\]/i.test(o.state.name));

  // The army's own faction keyword(s): those most of its datasheets share (allies are a minority).
  const counts = new Map();
  for (const o of candidates) {
    for (const k of new Set(catNames(o).filter((n) => FACTION.test(n)))) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const top = Math.max(0, ...counts.values());
  const factionKeywords = [...counts.entries()].filter(([, n]) => n >= top * 0.6).map(([k]) => k);

  const units = [];
  const excluded = [];
  for (const o of candidates) {
    const names = catNames(o);
    const allied = names.some((n) => /^Allies\b/i.test(n));
    // Untagged units (Fabius Bile, Drop Pod, …) belong to the army; another faction's keyword doesn't.
    const own = names.filter((n) => FACTION.test(n));
    const ours = !factionKeywords.length || !own.length || own.some((n) => factionKeywords.includes(n));
    (ours && !allied ? units : excluded).push(o);
  }
  return { units, excluded, factionKeywords };
}
