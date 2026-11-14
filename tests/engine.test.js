// Engine tests against real 40kdc-data files (github.com/wn-mitch/40kdc-data), loaded through the
// app's own repository + translator. Run `npm run fixtures` first.
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';
import { DcSource, DcRepository } from '../js/data/dc-repository.js';
import { RosterEngine } from '../js/engine/engine.js';
import { toBattleScribeXml } from '../js/engine/battlescribe-export.js';
import { parseGwAppText } from '../js/import/gw-app-text.js';
import { importList } from '../js/import/importer.js';
import { lookupUnits } from '../js/ui/unit-lookup-units.js';
import { newGame, strength, wound, start, nextPhase, prevPhase, resolveTest, pendingTests } from '../js/ui/game.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'fixtures', '40kdc');
if (!fs.existsSync(path.join(dir, 'files.json'))) {
  console.error('Fixtures missing - run `npm run fixtures` first.');
  process.exit(1);
}

/** The repository's data/ folder, read from tests/fixtures/40kdc instead of GitHub. */
class FixtureSource extends DcSource {
  async listFiles() { return JSON.parse(fs.readFileSync(path.join(dir, 'files.json'), 'utf8')); }
  async readJson(p, files) { return files[p] ? JSON.parse(fs.readFileSync(path.join(dir, p), 'utf8')) : null; }
}
const repo = new DcRepository(new FixtureSource());
const data = {};
const load = async (id) => (data[id] = data[id] || await repo.loadGameData(id));

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.stack.split('\n').slice(0, 3).join('\n       ')}`);
  }
}

const roster = async (faction) => RosterEngine.create(await load(faction), { name: 'Test' });
const force = (e) => e.roster.forces[0];
const unitDef = (e, name) => {
  const o = e.optionTree(force(e)).entries.find((x) => x.def.name === name);
  assert.ok(o, `no unit ${name}`);
  return o.def;
};
const add = (e, name) => e.addSelection(force(e), unitDef(e, name));
const config = (e, name) => force(e).selections.find((s) => s.def.name === name);
const option = (e, sel, name) => {
  const find = (b) => { for (const o of b.entries) if (o.def.name === name) return o; for (const g of b.groups) { const r = find(g); if (r) return r; } return null; };
  const o = find(e.optionTree(sel));
  assert.ok(o, `no option ${name}`);
  return o;
};
const choose = (e, sel, name) => { const o = option(e, sel, name); e.setOptionCount(sel, o.def, o.groupPath, 1); return o; };
const disposition = (e) => { const fd = config(e, 'Force Disposition'); const o = e.optionTree(fd).groups[0].entries.find((x) => !x.hidden); e.chooseInGroup(fd, o.groupPath[0], o.def, o.groupPath); };
const errors = (e) => e.validate().filter((i) => i.level === 'error').map((i) => i.message);
const pickState = (st) => ({ belowHalf: st.belowHalf, destroyed: st.destroyed });

console.log('RosterEngine (40kdc-data)');

await test('the faction list has every faction, chapters under Adeptus Astartes', async () => {
  const names = (await repo.factions()).map((f) => f.name);
  assert.ok(names.length >= 30, names.length);
  assert.ok(names.includes('Necrons'));
  assert.ok(names.includes('Adeptus Astartes - Ultramarines'));
});

await test('new roster autofills Battle Size (Strike Force), Detachment and Force Disposition', async () => {
  const e = await roster('necrons');
  assert.deepStrictEqual(force(e).selections.map((s) => s.def.name).sort(), ['Battle Size', 'Detachment', 'Force Disposition']);
  assert.strictEqual(e.costLimits()[e.ptsTypeId], 2000);
});

await test('addable units are grouped by role and Legends are hidden', async () => {
  const e = await roster('necrons');
  const cats = e.addableUnits(force(e)).map((c) => c.name);
  for (const c of ['Epic Hero', 'Character', 'Battleline']) assert.ok(cats.includes(c), cats.join(','));
  const visible = e.addableUnits(force(e)).flatMap((c) => c.options.map((o) => o.state.name));
  assert.ok(!visible.some((n) => /\[Legends\]/.test(n)));
});

await test('Necron Warriors: 10 models with weapons for 85 pts, 11-20 models for 190', async () => {
  const e = await roster('necrons');
  const w = add(e, 'Necron Warriors');
  assert.strictEqual(e.modelCount(w), 10);
  assert.strictEqual(e.points(w), 85);
  const info = e.describe(w);
  assert.ok(info.profiles.some((p) => p.name === 'Gauss flayer' && p.count === 10));
  const row = w.children.find((c) => c.def.type === 'model');
  e.setNumber(row, 20);
  assert.strictEqual(e.points(w), 190);
  e.setNumber(row, 15);
  assert.strictEqual(e.points(w), 190);
  assert.deepStrictEqual(e.issuesFor(w).map((i) => i.message), []);
});

await test('loadouts: some Warriors swap to gauss reapers', async () => {
  const e = await roster('necrons');
  const w = add(e, 'Necron Warriors');
  const base = w.children.find((c) => c.def.name === 'Necron Warrior');
  const reaper = option(e, w, 'Necron Warrior w/ Gauss reaper');
  e.setNumber(base, 7);
  e.setOptionCount(w, reaper.def, reaper.groupPath, 3);
  assert.strictEqual(e.modelCount(w), 10);
  const counts = Object.fromEntries(e.describe(w).profiles.map((p) => [p.name, p.count]));
  assert.strictEqual(counts['Gauss flayer'], 7);
  assert.strictEqual(counts['Gauss reaper'], 3);
  assert.deepStrictEqual(e.issuesFor(w).map((i) => i.message), []);
});

await test('a valid army: detachment, disposition, warlord and an attached leader', async () => {
  const e = await roster('necrons');
  choose(e, config(e, 'Detachment'), 'Awakened Dynasty');
  disposition(e);
  const ov = add(e, 'Overlord');
  const war = add(e, 'Necron Warriors');
  e.setWarlord(force(e), ov);
  e.attach(ov, e.associationDefs(ov)[0].id, war);
  assert.deepStrictEqual(errors(e), []);
  assert.deepStrictEqual(e.leadersOf(war), [ov]);
});

await test('leaders only attach to their eligible units', async () => {
  const e = await roster('necrons');
  const orikan = add(e, 'Orikan the Diviner');
  const assoc = e.associationDefs(orikan)[0];
  assert.ok(assoc, 'Orikan has a leader option');
  const warriors = add(e, 'Necron Warriors');
  const wraiths = add(e, 'Canoptek Wraiths');
  assert.ok(e.canAttach(orikan, assoc, warriors));
  assert.ok(!e.canAttach(orikan, assoc, wraiths));
  e.attach(orikan, assoc.id, wraiths);
  assert.ok(errors(e).some((m) => /cannot be attached/.test(m)), errors(e).join(' | '));
});

await test('epic heroes are limited to one per army', async () => {
  const e = await roster('necrons');
  add(e, 'Orikan the Diviner');
  add(e, 'Orikan the Diviner');
  assert.ok(errors(e).some((m) => /only one Orikan/.test(m)), errors(e).join(' | '));
});

await test('only one Warlord: choosing one replaces the other, duplicates are not Warlord', async () => {
  const e = await roster('necrons');
  const a = add(e, 'Overlord');
  const b = add(e, 'Overlord');
  e.setWarlord(force(e), a);
  e.setWarlord(force(e), b);
  assert.deepStrictEqual(e.warlords(force(e)), [b]);
  assert.ok(!e.isWarlord(e.duplicate(b)));
});

await test('points limits: over the limit is an error, Incursion is 1,000 pts', async () => {
  const e = await roster('necrons');
  for (let i = 0; i < 6; i++) add(e, 'The Silent King');
  assert.ok(errors(e).some((m) => /over the pts limit/.test(m)));
  const bs = config(e, 'Battle Size');
  const inc = option(e, bs, 'Incursion (1,000 Point limit)');
  e.chooseInGroup(bs, inc.groupPath[0], inc.def, inc.groupPath);
  assert.strictEqual(e.costLimits()[e.ptsTypeId], 1000);
});

await test('detachments cost Detachment Points: 3 at Strike Force, 2 at Incursion', async () => {
  const e = await roster('necrons');
  const det = config(e, 'Detachment');
  choose(e, det, 'Awakened Dynasty'); // 3 DP
  assert.ok(!errors(e).some((m) => /Detachment Points/.test(m)));
  const bs = config(e, 'Battle Size');
  const inc = option(e, bs, 'Incursion (1,000 Point limit)');
  e.chooseInGroup(bs, inc.groupPath[0], inc.def, inc.groupPath);
  assert.ok(errors(e).some((m) => /Detachment Points/.test(m)));
});

await test('enhancements appear once their detachment is chosen and are unique', async () => {
  const e = await roster('necrons');
  const ov = add(e, 'Overlord');
  const visible = () => e.optionTree(ov).groups.find((g) => g.def.name === 'Enhancements').entries.filter((o) => !o.hidden);
  assert.strictEqual(visible().length, 0);
  choose(e, config(e, 'Detachment'), 'Awakened Dynasty');
  const enh = visible()[0];
  assert.ok(enh, 'an Awakened Dynasty enhancement is offered');
  e.setOptionCount(ov, enh.def, enh.groupPath, 1);
  assert.ok(e.points(ov) > 90);
  const ov2 = add(e, 'Overlord');
  e.setOptionCount(ov2, enh.def, enh.groupPath, 1);
  assert.ok(errors(e).some((m) => m.includes(enh.def.name) && /at most 1/.test(m)), errors(e).join(' | '));
});

await test('detachment upgrades for non-characters: Ironclad Champions on Dreadnoughts only', async () => {
  const e = await roster('adeptus-astartes');
  choose(e, config(e, 'Detachment'), 'Ironclad Champions');
  const offered = (s) => {
    const g = e.optionTree(s).groups.find((x) => x.def.name === 'Enhancements');
    return g ? g.entries.filter((o) => !o.hidden).map((o) => o.def.name) : [];
  };
  const dread = add(e, 'Redemptor Dreadnought');
  assert.ok(offered(dread).includes('Artificer Sarcophagus (Upgrade)'), offered(dread).join(', '));
  assert.deepStrictEqual(offered(add(e, 'Intercessor Squad')), []);
  const up = option(e, dread, 'Artificer Sarcophagus (Upgrade)');
  const before = e.points(dread);
  e.setOptionCount(dread, up.def, up.groupPath, 1);
  assert.strictEqual(e.points(dread), before + 40);
});

await test('stratagems: core and detachment ones listed for Play Mode, not in detachment rules', async () => {
  const data = await load('necrons');
  const all = data.gameSystem.stratagems;
  const cr = all.find((s) => s.name === 'Command Re-roll');
  assert.ok(cr && cr.detachmentId === null && cr.cp === 1, JSON.stringify(cr));
  const dynasty = all.filter((s) => s.detachmentId === 'awakened-dynasty');
  assert.ok(dynasty.length > 0);
  assert.ok(dynasty.every((s) => s.name && s.when && s.cp != null));
  const e = await roster('necrons');
  choose(e, config(e, 'Detachment'), 'Awakened Dynasty');
  const info = e.describe(config(e, 'Detachment').children.find((c) => c.def.name === 'Awakened Dynasty'));
  assert.ok(!info.profiles.some((p) => p.typeName === 'Stratagem'));
  assert.ok(info.profiles.some((p) => p.typeName === 'Enhancement'));
});

await test('Force Disposition options come from the chosen detachment', async () => {
  const e = await roster('necrons');
  const fd = config(e, 'Force Disposition');
  assert.strictEqual(e.optionTree(fd).groups[0].entries.filter((o) => !o.hidden).length, 0);
  choose(e, config(e, 'Detachment'), 'Awakened Dynasty');
  assert.ok(e.optionTree(fd).groups[0].entries.some((o) => !o.hidden));
});

await test('escalating costs: the 3rd Celestian Sacresants cost more', async () => {
  const e = await roster('adepta-sororitas');
  const s = [1, 2, 3].map(() => add(e, 'Celestian Sacresants'));
  assert.deepStrictEqual(s.map((x) => e.points(x)), [75, 75, 85]);
  e.removeSelection(s[0]);
  assert.deepStrictEqual(s.slice(1).map((x) => e.points(x)), [75, 75]);
});

await test('per-N swaps: one eviscerator per 5 Death Company Marines', async () => {
  const e = await roster('blood-angels');
  const dc = add(e, 'Death Company Marines');
  assert.strictEqual(option(e, dc, 'Death Company Marines w/ Eviscerator').max, 1);
  const base = dc.children.find((c) => c.def.name === 'Death Company Marines');
  e.setNumber(base, 10);
  assert.strictEqual(option(e, dc, 'Death Company Marines w/ Eviscerator').max, 2);
});

await test('chapters: Ultramarines get their own units, generic Space Marines do not', async () => {
  const sm = await roster('adeptus-astartes');
  const um = await roster('ultramarines');
  const names = (e) => new Set(e.optionTree(force(e)).entries.map((o) => o.def.name));
  assert.ok(!names(sm).has('Marneus Calgar'));
  assert.ok(names(um).has('Marneus Calgar'));
  assert.ok(names(um).has('Intercessor Squad'));
  // A chapter's files repeat the generic detachments: each is offered once.
  const dets = um.optionTree(config(um, 'Detachment')).groups[0].entries.map((o) => o.def.name);
  assert.strictEqual(new Set(dets).size, dets.length, dets.join(', '));
  assert.ok(dets.includes('Gladius Task Force'));
});

await test('multi-model squads start at a legal size (Victrix Honour Guard)', async () => {
  const e = await roster('ultramarines');
  const v = add(e, 'Victrix Honour Guard');
  assert.deepStrictEqual(e.issuesFor(v).map((i) => i.message), []);
});

await test('describe() returns profiles, ability text, rules and keywords', async () => {
  const e = await roster('necrons');
  const info = e.describe(add(e, 'Necron Warriors'));
  const unit = info.profiles.find((p) => p.typeName === 'Unit');
  assert.deepStrictEqual(unit.characteristics.filter((c) => c.name !== 'Base').map((c) => c.value), ['5"', '4', '4+', '1', '7+', '2', '']);
  const ability = info.profiles.find((p) => p.typeName === 'Abilities');
  assert.ok(ability && ability.characteristics[0].value.length > 20, 'ability has rules text');
  assert.ok(info.rules.some((r) => r.name === 'Reanimation Protocols'));
  assert.ok(info.keywords.includes('Battleline') && info.keywords.includes('Faction: Necrons'));
});

await test('weapon keywords have rules for their badges (text from the data where it has some)', async () => {
  const e = await roster('necrons');
  const rules = e.describe(add(e, 'Necron Warriors')).rules.map((r) => r.name);
  for (const k of ['Lethal Hits', 'Rapid Fire']) assert.ok(rules.includes(k), rules.join(', '));
  // Its text comes from the 40kdc describer, which loads in the browser (not under Node).
  assert.ok((await load('necrons')).ruleForKeyword('Twin-linked'));
});

await test('previewEntry describes an unadded unit without changing the roster', async () => {
  const e = await roster('necrons');
  const before = force(e).selections.length;
  const pv = e.previewEntry(force(e), unitDef(e, 'Necron Warriors'), { available: true });
  assert.strictEqual(pv.points, 85);
  assert.ok(pv.info.profiles.some((p) => p.name === 'Gauss reaper'));
  assert.strictEqual(force(e).selections.length, before);
});

await test('unit lookup lists the army\'s own datasheets', async () => {
  const e = await roster('necrons');
  const lk = lookupUnits(e, force(e));
  assert.deepStrictEqual(lk.factionKeywords, ['Faction: Necrons']);
  assert.ok(lk.units.length > 40);
});

await test('Warhammer app text export: parse and import (Chaos Space Marines)', async () => {
  const text = fs.readFileSync(path.join(here, 'samples', 'gw-app-csm.txt'), 'utf8');
  const list = parseGwAppText(text);
  const { engine, report } = importList(await load('chaos-space-marines'), list);
  assert.strictEqual(report.units.filter((u) => u.notes.some((n) => /skipped/.test(n))).length, 0);
  assert.strictEqual(force(engine).selections.filter((s) => s.def.type !== 'upgrade').length, list.units.length);
  assert.ok(config(engine, 'Detachment').children.some((c) => c.def.name === 'Renegade Raiders'));
});

await test('share codes, JSON and text exports round-trip the roster', async () => {
  const e = await roster('necrons');
  choose(e, config(e, 'Detachment'), 'Awakened Dynasty');
  const ov = add(e, 'Overlord');
  const w = add(e, 'Necron Warriors');
  e.attach(ov, e.associationDefs(ov)[0].id, w);
  const shared = RosterEngine.fromShare(await load('necrons'), JSON.parse(JSON.stringify(e.toShare())));
  assert.deepStrictEqual(shared.loadWarnings, []);
  assert.strictEqual(shared.points(), e.points());
  const copy = RosterEngine.fromJSON(await load('necrons'), JSON.parse(JSON.stringify(e.toJSON())));
  assert.strictEqual(copy.points(), e.points());
  assert.strictEqual(copy.leadersOf(force(copy).selections.find((s) => s.def.name === 'Necron Warriors')).length, 1);
  assert.match(e.toText(), /Necron Warriors \[85 pts\]/);
});

await test('BattleScribe .ros export has what Yellowscribe reads', async () => {
  const e = await roster('necrons');
  add(e, 'Necron Warriors');
  const xml = toBattleScribeXml(e);
  assert.match(xml, /<roster /);
  assert.match(xml, /<profile [^>]*name="Gauss flayer"/);
  assert.match(xml, /<cost [^>]*value="85/);
});

await test('rosters saved with BSData load onto the new data', async () => {
  const old = {
    format: 'pawhammer-roster', version: 1, id: 'old', name: 'Old list', gameSystemId: 'sys-352e-adc2-7639-d610',
    catalogueId: 'b-old-necrons', catalogueName: 'Xenos - Necrons', costLimits: {},
    forces: [{ id: 'f', forceEntryId: 'old-force', catalogueId: 'b-old-necrons', selections: [
      { id: 'w1', key: 'old-link', entryId: '58e9-5212-f5a6-c12d', name: 'Necron Warriors', number: 1, groupPath: [], children: [{ id: 'x', key: 'k', name: 'Necron Warrior', number: 10, children: [] }] },
      { id: 'c1', key: 'old-cfg', entryId: 'old-bs', name: 'Battle Size', number: 1, groupPath: [], children: [] },
    ] }],
  };
  assert.strictEqual(await repo.findFaction(old.catalogueId, old.catalogueName), 'necrons');
  const e = RosterEngine.fromJSON(await load('necrons'), old);
  const w = force(e).selections.find((s) => s.def.name === 'Necron Warriors');
  assert.ok(w, 'Necron Warriors restored by their BSData id');
  assert.strictEqual(e.points(w), 85);
  assert.ok(e.loadWarnings[0].includes('BSData'));
  assert.deepStrictEqual(force(e).selections.filter((s) => s.def.type === 'upgrade').map((s) => s.def.name).sort(), ['Battle Size', 'Detachment', 'Force Disposition']);
});

await test('game tracker: wounds, Below Half-strength, turns, CP and Battle-shock tests', async () => {
  const g = newGame();
  const squad = [{ key: 'sgt', name: 'Sergeant', count: 1, w: 2 }, { key: 'm', name: 'Marine', count: 9, w: 2 }];
  const solo = [{ key: 'cap', name: 'Captain', count: 1, w: 5 }];
  const army = () => [{ id: 'u1', ...pickState(strength(g, 'u1', squad)) }, { id: 'u2', ...pickState(strength(g, 'u2', solo)) }];
  start(g, 'theirs', army());
  assert.deepStrictEqual([g.round, g.turn, g.phase, g.cp], [1, 'theirs', 0, 1]);
  wound(g, 'u1', squad[1], 12);
  assert.strictEqual(strength(g, 'u1', squad).belowHalf, true);
  wound(g, 'u2', solo[0], 3);
  assert.strictEqual(strength(g, 'u2', solo).belowHalf, true);
  for (let i = 0; i < 5; i++) nextPhase(g, army());
  assert.deepStrictEqual(pendingTests(g).sort(), ['u1', 'u2']);
  resolveTest(g, 'u1', true);
  resolveTest(g, 'u2', false);
  for (let i = 0; i < 5; i++) nextPhase(g, army());
  wound(g, 'u1', squad[1], -12);
  wound(g, 'u2', solo[0], -3);
  for (let i = 0; i < 5; i++) nextPhase(g, army());
  assert.deepStrictEqual([g.units.u1.test, g.units.u2.test, g.units.u2.shocked], [false, true, true]);
  while (!g.over) nextPhase(g, army());
  assert.deepStrictEqual([g.round, g.over], [5, true]);
  prevPhase(g);
  assert.strictEqual(g.over, false);
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
