// Engine tests against real BSData/wh40k-11e files. Run `npm run fixtures` first.
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';
import { GameData } from '../js/engine/gamedata.js';
import { RosterEngine } from '../js/engine/engine.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
if (!fs.existsSync(path.join(dir, 'Necrons.json'))) {
  console.error('Fixtures missing - run `npm run fixtures` first.');
  process.exit(1);
}

const gs = load('Warhammer 40,000.json').gameSystem;
const necrons = load('Necrons.json').catalogue;
const unaligned = load('Unaligned Forces.json').catalogue;
const data = new GameData(gs, [necrons, unaligned], necrons.id);

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.stack.split('\n').slice(0, 3).join('\n       ')}`);
  }
}

const newRoster = () => RosterEngine.create(data, { name: 'Test' });
const findOpt = (tree, name) => {
  for (const o of tree.entries) if (o.def.name === name) return o;
  for (const g of tree.groups) { const r = findOpt(g, name); if (r) return r; }
  return null;
};
const findGroup = (tree, name) => {
  for (const g of tree.groups) { if (g.def.name === name) return g; const r = findGroup(g, name); if (r) return r; }
  return null;
};
const unitDef = (e, name) => e.optionTree(e.roster.forces[0]).entries.find((o) => o.def.name === name).def;
const config = (e, name) => e.roster.forces[0].selections.find((s) => s.def.name === name);

function setup() {
  const e = newRoster();
  const bs = config(e, 'Battle Size');
  const strike = findOpt(e.optionTree(bs), '2. Strike Force (2000 Point limit)');
  e.chooseInGroup(bs, strike.groupPath[strike.groupPath.length - 1], strike.def, strike.groupPath);
  const det = config(e, 'Detachment');
  const ad = findOpt(e.optionTree(det), 'Awakened Dynasty');
  e.setOptionCount(det, ad.def, ad.groupPath, 1);
  return e;
}

console.log('RosterEngine');

test('new roster autofills mandatory configuration entries', () => {
  const e = newRoster();
  const names = e.roster.forces[0].selections.map((s) => s.def.name);
  assert.ok(names.includes('Battle Size'));
  assert.ok(names.includes('Detachment'));
  assert.ok(names.includes('Force Disposition'));
  const msgs = e.validate().map((i) => i.message).join('\n');
  assert.match(msgs, /Character/);
});

test('addable units are grouped by category and hide Legends by default', () => {
  const e = newRoster();
  const groups = e.addableUnits(e.roster.forces[0]);
  const byName = Object.fromEntries(groups.map((g) => [g.name, g.options.map((o) => o.def.name)]));
  assert.ok(byName.Battleline.includes('Necron Warriors'));
  assert.ok(byName.Character.includes('Overlord'));
  const all = groups.flatMap((g) => g.options.map((o) => o.def.name));
  assert.ok(!all.some((n) => /\[Legends\]/.test(n)), 'Legends should be hidden');
});

test('battle size sets the points limit', () => {
  const e = setup();
  assert.strictEqual(e.costLimits()[data.ptsTypeId], 2000);
});

test('Necron Warriors autofill 10 models with weapons and cost 85, 20 models cost 190', () => {
  const e = setup();
  const force = e.roster.forces[0];
  const w = e.addSelection(force, unitDef(e, 'Necron Warriors'));
  assert.strictEqual(e.modelCount(w), 10);
  assert.strictEqual(e.points(w), 85);
  const models = w.children.find((c) => c.def.type === 'model');
  assert.ok(models.children.some((c) => c.def.name === 'Gauss flayer'), 'weapon autofilled');
  e.setNumber(models, 20);
  assert.strictEqual(e.points(w), 190);
  assert.strictEqual(e.issuesFor(w).length, 0, JSON.stringify(e.issuesFor(w)));
  e.setNumber(models, 21);
  assert.ok(e.issuesFor(w).some((i) => /at most 20/.test(i.message)), 'max 20 enforced');
});

test('swapping model type within a unit group', () => {
  const e = setup();
  const w = e.addSelection(e.roster.forces[0], unitDef(e, 'Necron Warriors'));
  const reaper = findOpt(e.optionTree(w), 'Warrior w/ gauss reaper');
  const flayer = w.children.find((c) => c.def.name === 'Warrior w/ gauss flayer');
  e.setNumber(flayer, 5);
  e.setOptionCount(w, reaper.def, reaper.groupPath, 5);
  const r = w.children.find((c) => c.def.name === 'Warrior w/ gauss reaper');
  assert.ok(r.children.some((c) => c.def.name === 'Gauss reaper'));
  assert.strictEqual(e.modelCount(w), 10);
  assert.strictEqual(e.issuesFor(w).length, 0, JSON.stringify(e.issuesFor(w)));
});

test('a valid small army has no errors', () => {
  const e = setup();
  const force = e.roster.forces[0];
  e.addSelection(force, unitDef(e, 'Overlord'));
  e.addSelection(force, unitDef(e, 'Necron Warriors'));
  // Force Disposition becomes available once a detachment is chosen.
  const fd = config(e, 'Force Disposition');
  const grp = findGroup(e.optionTree(fd), 'Force Disposition');
  const pick = grp.entries.find((o) => !o.hidden);
  assert.ok(pick, 'a force disposition is available');
  e.chooseInGroup(fd, grp.def, pick.def, pick.groupPath);
  const errors = e.validate().filter((i) => i.level === 'error').map((i) => i.message);
  // Warlord is chosen per character; everything else should be satisfied.
  assert.deepStrictEqual(errors.filter((m) => !/Warlord/.test(m)), []);
  assert.ok(e.points() > 0);
});

test('epic heroes are limited to one per army', () => {
  const e = setup();
  const force = e.roster.forces[0];
  e.addSelection(force, unitDef(e, 'Imotekh the Stormlord'));
  assert.ok(!e.validate().some((i) => /Imotekh/.test(i.message)));
  e.addSelection(force, unitDef(e, 'Imotekh the Stormlord'));
  assert.ok(e.validate().some((i) => /Imotekh/.test(i.message)), JSON.stringify(e.validate()));
});

test('exceeding the points limit is an error', () => {
  const e = setup();
  const force = e.roster.forces[0];
  for (let i = 0; i < 5; i++) e.addSelection(force, unitDef(e, 'Monolith'));
  assert.ok(e.points() > 2000);
  assert.ok(e.validate().some((i) => /over the pts limit/.test(i.message)));
});

test('describe() returns datasheet profiles and rules', () => {
  const e = setup();
  const w = e.addSelection(e.roster.forces[0], unitDef(e, 'Necron Warriors'));
  const d = e.describe(w);
  assert.ok(d.profiles.some((p) => p.typeName === 'Unit'));
  assert.ok(d.profiles.some((p) => p.name === 'Gauss flayer'));
  assert.ok(d.rules.some((r) => r.name === 'Reanimation Protocols'));
  assert.ok(d.keywords.includes('Infantry'));
});

test('previewEntry describes an unadded unit without changing the roster', () => {
  const e = setup();
  const force = e.roster.forces[0];
  const before = JSON.stringify(e.toJSON());
  const rev = e.rev;
  const preview = e.previewEntry(force, unitDef(e, 'Necron Warriors'));
  assert.strictEqual(preview.points, 85);
  assert.strictEqual(preview.models, 10);
  assert.ok(preview.info.profiles.some((p) => p.name === 'Gauss flayer'));
  assert.strictEqual(JSON.stringify(e.toJSON()), before);
  assert.strictEqual(e.rev, rev, 'no change notification');
});

test('describe() counts equipped weapons across models', () => {
  const e = setup();
  const w = e.addSelection(e.roster.forces[0], unitDef(e, 'Necron Warriors'));
  e.setNumber(w.children.find((c) => c.def.type === 'model'), 20);
  const d = e.describe(w);
  assert.strictEqual(d.profiles.find((p) => p.name === 'Gauss flayer').count, 20);
  assert.strictEqual(d.profiles.find((p) => p.name === 'Close combat weapon').count, 20);
});

test('leaders attach to eligible units and are validated', () => {
  const e = setup();
  const force = e.roster.forces[0];
  const overlord = e.addSelection(force, unitDef(e, 'Overlord'));
  const warriors = e.addSelection(force, unitDef(e, 'Necron Warriors'));
  const wraiths = e.addSelection(force, unitDef(e, 'Canoptek Wraiths'));
  const [assoc] = e.associationDefs(overlord);
  assert.ok(assoc, 'Overlord has a Leader association');
  const candidates = e.attachCandidates(overlord, assoc);
  assert.ok(candidates.includes(warriors));
  assert.ok(!candidates.includes(wraiths));
  e.attach(overlord, assoc.id, warriors);
  assert.deepStrictEqual(e.leadersOf(warriors), [overlord]);
  assert.ok(!e.validate().some((i) => /attached/.test(i.message)), JSON.stringify(e.validate()));

  // A second Leader on the same unit breaks the unit's "max 1 Leader" limit.
  const overlord2 = e.addSelection(force, unitDef(e, 'Overlord'));
  e.attach(overlord2, assoc.id, warriors);
  assert.ok(e.validate().some((i) => /Necron Warriors: can have at most 1 Leader attached/.test(i.message)), JSON.stringify(e.validate()));
  e.attach(overlord2, assoc.id, null);

  // Technomancer (Support) must be attached, and grants Feel No Pain to the unit it joins.
  const tech = e.addSelection(force, unitDef(e, 'Technomancer'));
  assert.ok(e.validate().some((i) => /Technomancer must be attached/.test(i.message)));
  assert.ok(!e.describe(warriors).rules.some((r) => /Feel No Pain/.test(r.name)));
  e.attach(tech, e.associationDefs(tech)[0].id, warriors);
  assert.ok(!e.validate().some((i) => /Technomancer must be attached/.test(i.message)));
  assert.ok(e.describe(warriors).rules.some((r) => /Feel No Pain/.test(r.name)), 'Feel No Pain unlocked');

  // Attachments survive a save/load round trip and are pruned when the unit is removed.
  const e2 = RosterEngine.fromJSON(data, JSON.parse(JSON.stringify(e.toJSON())));
  const w2 = e2.findSelection(warriors.id);
  assert.strictEqual(e2.leadersOf(w2).length, 2);
  e2.removeSelection(w2);
  assert.ok(e2.roster.forces[0].selections.every((s) => !(s.attachments || []).length));
});

test('JSON round trip preserves the roster', () => {
  const e = setup();
  const force = e.roster.forces[0];
  const w = e.addSelection(force, unitDef(e, 'Necron Warriors'));
  e.setNumber(w.children.find((c) => c.def.type === 'model'), 15);
  e.addSelection(force, unitDef(e, 'Overlord'));
  const json = JSON.parse(JSON.stringify(e.toJSON()));
  const e2 = RosterEngine.fromJSON(data, json);
  assert.deepStrictEqual(e2.loadWarnings, []);
  assert.strictEqual(e2.points(), e.points());
  assert.strictEqual(e2.toText(), e.toText());
});

test('text export lists units and points', () => {
  const e = setup();
  e.addSelection(e.roster.forces[0], unitDef(e, 'Necron Warriors'));
  const text = e.toText();
  assert.match(text, /Necron Warriors \[85 pts\]/);
  assert.match(text, /Awakened Dynasty/);
});

test('Space Marines: imported catalogues do not duplicate configuration entries', () => {
  const names = ['Imperium - Space Marines', 'Imperium - Agents of the Imperium', 'Library - Titans',
    'Imperium - Imperial Knights - Library', 'Library - Astartes Heresy Legends'];
  const cats = names.map((n) => load(n + '.json').catalogue);
  const sm = new GameData(gs, [...cats, unaligned], cats[0].id);
  const e = RosterEngine.create(sm, { name: 'SM' });
  const config = e.roster.forces[0].selections.map((s) => s.def.name).sort();
  assert.deepStrictEqual(config, ['Battle Size', 'Detachment', 'Force Disposition']);
  // Rules on units that are not in the list (e.g. Judiciar "must be attached") must not fire.
  assert.ok(!e.validate().some((i) => /Judiciar/.test(i.message)), JSON.stringify(e.validate()));
  const judiciar = e.addSelection(e.roster.forces[0], e.optionTree(e.roster.forces[0]).entries.find((o) => o.def.name === 'Judiciar').def);
  assert.ok(e.validate().some((i) => i.message === 'Judiciar must be attached to a Bodyguard unit.'), JSON.stringify(e.validate()));
  e.removeSelection(judiciar);
  const force = e.roster.forces[0];
  const tac = e.addSelection(force, e.optionTree(force).entries.find((o) => o.def.name === 'Tactical Squad').def);
  assert.strictEqual(e.modelCount(tac), 10);
  assert.ok(e.points(tac) > 0);
  assert.strictEqual(e.issuesFor(tac).length, 0, JSON.stringify(e.issuesFor(tac)));
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
