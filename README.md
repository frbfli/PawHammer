# PawHammer

A Warhammer 40,000 **11th edition** army list builder that runs entirely in the browser.
Army rules, points, wargear options and restrictions come straight from the community
[BSData/wh40k-11e](https://github.com/BSData/wh40k-11e) repository, so the builder stays
current as the data is updated. The UI is built with Bootstrap 5; the rules engine is plain
JavaScript (ES modules, no build step, no dependencies).

## Running

```sh
npm start            # serves the app at http://localhost:8080
```

Any static file server works; ES modules just need to be served over HTTP, not opened as a `file://` URL.

## Features

- Pick any faction in the data source. Linked library catalogues (Unaligned Forces,
  Imperial Knights, Titans, Legends, and so on) load automatically.
- Add units from a searchable list grouped by battlefield role. Mandatory models and default
  wargear are selected for you.
- Edit options: unit size, model loadouts, weapon swaps, enhancements, Warlord, and the
  army configuration (Battle Size, Detachment, Force Disposition).
- Live validation of the data's own rules: minimum and maximum selections, per-army limits
  (epic heroes, enhancements), category requirements, and points limits.
- Datasheet view with unit stats, weapon tables (with equipped quantities, e.g. "Bolt pistol ×10"),
  abilities, rules and keywords.
- Leaders and support characters: attach a character to an eligible unit (as defined by the data).
  The builder enforces limits such as one Leader per unit and required attachments, and unlocks
  rules that depend on the attachment (e.g. a Technomancer granting Feel No Pain).
- **Play Mode**: a read-only view for the table. Each unit shows with its attached characters, and
  tapping one opens its datacard with equipped weapon counts, abilities, Warlord and enhancements,
  plus the detachment rules.
- Rosters auto-save to browser storage. You can export them as text or JSON, re-import them,
  and print them as datasheets.
- Data files are cached in IndexedDB and re-downloaded only when the repository changes.
- A different repo or branch, or a local copy of the JSON files, can be selected under **Data**.
- Dark and light themes, and a responsive layout.

## Architecture

```
js/
  engine/
    gamedata.js   Indexes a game system + catalogues and resolves entry links into EntryDefs
    roster.js     Roster / Force / Selection model
    engine.js     RosterEngine: modifiers, conditions, repeats, constraints, costs,
                  validation, auto-selection, datasheet info, text/JSON export
  data/
    repository.js GitHub / local sources, file manifest, catalogue-link resolution
    cache.js      IndexedDB cache
  ui/             Bootstrap views (home, editor), templating helpers, storage
  main.js         App controller and routing
```

The engine implements the BattleScribe data model in the JSON form BSData uses for
11th edition:

- Entry links, shared entries and groups, including `import` rules for linked catalogues.
- Modifiers (`set`, `increment`, `decrement`, `append`, `replace`, category changes)
  applied to `hidden`, `name`, costs, constraint values, and profile characteristics.
- Condition groups and repeats.
- Scopes: `self`, `parent`, `force`, `roster`, `root-entry`, `ancestor`, `primary-catalogue`,
  unit/model scopes, and scopes that name a specific entry ID.
- Constraints on selection counts and on cost totals.

A selection with `number` N stands for N identical copies, and its children are counted per copy.

Leader/Support attachments use the data's `associations`, which list eligible units as conditions.
They are stored on the leader selection and counted wherever the data checks `field: "associations"`.

**Not supported:** modifiers that use the NewRecruit `affects` extension to target other objects.

## Tests

```sh
npm run fixtures     # downloads a few BSData files into tests/fixtures
npm test
```

The tests build Necron and Space Marine rosters from the real 11th edition data. They check
auto-selection, points that depend on unit size, weapon swaps, epic-hero and points-limit
validation, datasheets, and JSON round-trips.

Warhammer 40,000 is a trademark of Games Workshop. This project is unofficial and not
endorsed by Games Workshop. Rules data © the BSData contributors.
