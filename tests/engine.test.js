// Engine tests against real BSData/wh40k-11e files. Run `npm run fixtures` first.
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';
import { GameData } from '../js/engine/gamedata.js';
import { RosterEngine } from '../js/engine/engine.js';
import { toBattleScribeXml } from '../js/engine/battlescribe-export.js';
import { parseGwAppText } from '../js/import/gw-app-text.js';
import { importList } from '../js/import/importer.js';

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

test('BattleScribe .ros export has what Yellowscribe reads', () => {
  const e = setup();
  const force = e.roster.forces[0];
  e.addSelection(force, unitDef(e, 'Overlord'));
  const w = e.addSelection(force, unitDef(e, 'Necron Warriors'));
  e.setNumber(w.children.find((c) => c.def.type === 'model'), 20);
  const xml = toBattleScribeXml(e);
  assert.match(xml, /^<\?xml version="1\.0"/);
  assert.match(xml, new RegExp(`<roster [^>]*gameSystemId="${gs.id}"`));
  // Units are top-level unit/model selections with their keywords as categories.
  assert.match(xml, /<selection [^>]*name="Necron Warriors"[^>]*type="unit"/);
  assert.match(xml, /<selection [^>]*name="Overlord"[^>]*type="model"/);
  assert.match(xml, /<category [^>]*name="Battleline"[^>]*primary="true"/);
  // Numbers are totals: 20 models, each with a gauss flayer -> 20.
  assert.match(xml, /<selection [^>]*name="Warrior w\/ gauss flayer"[^>]*number="20"/);
  assert.match(xml, /<selection [^>]*name="Gauss flayer"[^>]*number="20"/);
  // Profiles and rules sit on the selection that grants them.
  assert.match(xml, /<profile [^>]*name="Gauss flayer"[^>]*typeName="Ranged Weapons"/);
  assert.match(xml, /<characteristic name="Keywords"[^>]*>Lethal Hits, Rapid Fire 1<\/characteristic>/);
  assert.match(xml, /<rule [^>]*name="Reanimation Protocols"[^>]*>\s*<description>/);
  assert.match(xml, /<cost name="pts" typeId="[^"]+" value="190"\/>/);
});

test('only one Warlord: choosing one replaces the other, duplicates are not Warlord', () => {
  const e = setup();
  const force = e.roster.forces[0];
  const ov1 = e.addSelection(force, unitDef(e, 'Overlord'));
  const ov2 = e.addSelection(force, unitDef(e, 'Overlord'));
  const warriors = e.addSelection(force, unitDef(e, 'Necron Warriors'));
  assert.ok(e.validate().some((i) => /Choose a Warlord/.test(i.message)));
  assert.deepStrictEqual(e.warlordCandidates(force), [ov1, ov2]);
  assert.ok(!e.warlordOption(warriors), 'non-characters cannot be Warlord');
  e.setWarlord(force, ov1);
  assert.deepStrictEqual(e.warlords(force), [ov1]);
  e.setWarlord(force, ov2);
  assert.deepStrictEqual(e.warlords(force), [ov2]);
  const copy = e.duplicate(ov2);
  assert.ok(!e.isWarlord(copy), 'a duplicated Warlord is not also the Warlord');
  assert.ok(!e.validate().some((i) => /Warlord/.test(i.message)), JSON.stringify(e.validate()));
});

test('must-be-Warlord characters are selected automatically and cannot be replaced', () => {
  const e = setup();
  const force = e.roster.forces[0];
  const ov = e.addSelection(force, unitDef(e, 'Overlord'));
  e.setWarlord(force, ov);
  const king = e.addSelection(force, unitDef(e, 'The Silent King'));
  assert.ok(e.mustBeWarlord(king));
  assert.deepStrictEqual(e.warlords(force), [king], 'the Silent King takes over as Warlord');
  assert.throws(() => e.setWarlord(force, ov), /The Silent King must be your Warlord/);
  assert.ok(!e.validate().some((i) => /Warlord/.test(i.message)), JSON.stringify(e.validate()));

  // Guilliman (min 1 on the Warlord option) and Ghazghkull (min raised to 1 by a modifier).
  for (const [cat, name, extra] of [['Imperium - Ultramarines', 'Roboute Guilliman', 'Captain'], ['Orks', 'Ghazghkull Thraka', 'Warboss']]) {
    const files = cat === 'Orks' ? ['Orks', 'Unaligned Forces']
      : [cat, 'Imperium - Space Marines', 'Imperium - Agents of the Imperium', 'Library - Titans', 'Imperium - Imperial Knights - Library', 'Library - Astartes Heresy Legends', 'Unaligned Forces'];
    const cats = files.map((n) => load(n + '.json').catalogue);
    const e2 = RosterEngine.create(new GameData(gs, cats, cats[0].id), {});
    const f2 = e2.roster.forces[0];
    const pick = (n) => e2.addSelection(f2, e2.optionTree(f2).entries.find((o) => o.def.name === n).def);
    const other = pick(extra);
    e2.setWarlord(f2, other);
    const hero = pick(name);
    assert.deepStrictEqual(e2.warlords(f2), [hero], `${name} becomes the Warlord`);
    assert.ok(!e2.validate().some((i) => /Warlord/.test(i.message)), JSON.stringify(e2.validate()));
  }
});

test('Warhammer app text export: parse and import (Chaos Space Marines)', () => {
  const text = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'samples', 'gw-app-csm.txt'), 'utf8');
  const list = parseGwAppText(text);
  assert.strictEqual(list.name, 'August RTT');
  assert.strictEqual(list.faction, 'Chaos Space Marines');
  assert.deepStrictEqual(list.detachments, [{ name: 'Renegade Raiders', dp: 3 }]);
  assert.strictEqual(list.forceDisposition, 'Reconnaissance');
  assert.deepStrictEqual(list.battleSize, { name: 'Strike Force', points: 2000 });
  assert.strictEqual(list.units.length, 17);
  assert.strictEqual(list.units.reduce((n, u) => n + u.points, 0), 2000);

  const names = ['Chaos - Chaos Space Marines', 'Chaos - Chaos Knights Library', 'Chaos - Chaos Daemons Library', 'Library - Astartes Heresy Legends', 'Library - Titans', 'Unaligned Forces'];
  const cats = names.map((n) => load(n + '.json').catalogue);
  const { engine: e, report } = importList(new GameData(gs, cats, cats[0].id), list);
  const force = e.roster.forces[0];
  assert.deepStrictEqual(report.warnings, []);
  assert.strictEqual(force.selections.filter((s) => s.def.type !== 'upgrade').length, 17);
  // Nothing unmatched; the only notes are points that changed since the list was exported.
  for (const u of report.units) {
    assert.deepStrictEqual(u.notes.filter((n) => !/pts in the data/.test(n)), [], `${u.name}: ${u.notes.join(' ')}`);
  }
  const unit = (n) => force.selections.find((s) => s.def.name === n);
  const models = (s) => Object.fromEntries(s.children.filter((c) => c.def.type === 'model').map((c) => [c.def.name, c.number]));
  assert.deepStrictEqual(models(unit('Legionaries')), { 'Aspiring Champion': 1, 'Legionary w/ chainsword': 3, 'Legionary w/ heavy melee weapon': 1 });
  assert.deepStrictEqual(models(unit('Chosen')), {
    'Chosen Champion': 1, 'Chosen w/ combi-weapon and bolt pistol': 2,
    'Chosen w/ paired accursed weapons and bolt pistol': 1, 'Chosen w/ power fist and bolt pistol': 1,
  });
  assert.deepStrictEqual(e.warlords(force).map((s) => s.def.name), ['Huron Blackheart']);
  assert.deepStrictEqual(e.leadersOf(unit('Chosen')).map((s) => s.def.name).sort(), ['Huron Blackheart', 'Masters of the Maelstrom']);
  const issues = e.validate().filter((i) => i.level === 'error').map((i) => i.message);
  assert.deepStrictEqual(issues.filter((m) => !/over the pts limit/.test(m)), []);

  // The imported 17-unit list also survives a share code round trip exactly.
  const e2 = RosterEngine.fromShare(e.data, JSON.parse(JSON.stringify(e.toShare())));
  assert.deepStrictEqual(e2.loadWarnings, []);
  assert.strictEqual(e2.toText(), e.toText());
});

test('share codes: compact form rebuilds the exact roster', () => {
  // Necrons with a Warlord, a leader + support attachment and a custom unit size.
  const e = setup();
  const force = e.roster.forces[0];
  const ov = e.addSelection(force, unitDef(e, 'Overlord'));
  const tech = e.addSelection(force, unitDef(e, 'Technomancer'));
  const w = e.addSelection(force, unitDef(e, 'Necron Warriors'));
  e.setNumber(w.children.find((c) => c.def.type === 'model'), 20);
  e.setWarlord(force, ov);
  e.attach(ov, e.associationDefs(ov)[0].id, w);
  e.attach(tech, e.associationDefs(tech)[0].id, w);
  e.rename(w, 'The Silent Tide');
  const payload = JSON.parse(JSON.stringify(e.toShare()));
  assert.ok(JSON.stringify(payload).length < 600, 'compact: ' + JSON.stringify(payload).length);
  const e2 = RosterEngine.fromShare(data, payload);
  assert.deepStrictEqual(e2.loadWarnings, []);
  assert.strictEqual(e2.toText(), e.toText());
  const f2 = e2.roster.forces[0];
  const w2 = f2.selections.find((s) => s.def.name === 'Necron Warriors');
  assert.strictEqual(e2.displayName(w2), 'The Silent Tide');
  assert.deepStrictEqual(e2.leadersOf(w2).map((s) => s.def.name).sort(), ['Overlord', 'Technomancer']);
  assert.deepStrictEqual(e2.warlords(f2).map((s) => s.def.name), ['Overlord']);
  assert.deepStrictEqual(e2.validate(), e.validate().map((i) => ({ ...i, selectionId: i.selectionId && e2.validate().find((j) => j.message === i.message).selectionId })));
});

test('ally points limits only count units with that faction keyword', () => {
  const e = setup();
  const force = e.roster.forces[0];
  for (let i = 0; i < 3; i++) e.addSelection(force, unitDef(e, 'Monolith'));
  assert.ok(!e.validate().some((i) => /Unaligned Forces pts/.test(i.message)), JSON.stringify(e.validate()));
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
  // Mandatory Sergeant counts towards the squad's minimum size (5, not 5 + Sergeant).
  const term = e.addSelection(force, e.optionTree(force).entries.find((o) => o.def.name === 'Terminator Squad').def);
  assert.strictEqual(e.modelCount(term), 5);
  assert.strictEqual(e.issuesFor(term).length, 0, JSON.stringify(e.issuesFor(term)));
  assert.ok(e.points(tac) > 0);
  assert.strictEqual(e.issuesFor(tac).length, 0, JSON.stringify(e.issuesFor(tac)));
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
