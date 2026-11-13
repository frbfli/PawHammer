# PawHammer

A Warhammer 40,000 **11th edition** army list builder that runs entirely in the browser.
Unit stats, points, wargear options, leaders, detachments, enhancements and stratagems come
straight from the community [40kdc-data](https://github.com/wn-mitch/40kdc-data) dataset, so the
builder stays current as the data is updated. The UI is built with Bootstrap 5; the rules engine is
plain JavaScript (ES modules, no build step, no dependencies).

PawHammer originally read BSData/wh40k-11e, which has been taken offline. The app now translates
40kdc-data into the same model its engine uses (see *Data* below); BattleScribe JSON files can
still be loaded from disk under **Data Source**.

## Running

```sh
npm start            # serves the app at http://localhost:8080
```

Any static file server works; ES modules just need to be served over HTTP, not opened as a `file://` URL.

## Features

- Pick any faction in the data source, including Space Marine chapters (which add their own
  units, detachments and enhancements to the Adeptus Astartes ones).
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
- Rosters auto-save to browser storage. You can export them as text, JSON or a BattleScribe
  roster (`.ros`, which also opens in New Recruit), re-import them, and print them as datasheets.
- **Unit Lookup** (home page): pick a faction and start typing a unit name. Matching units appear
  as you type, and picking one (or pressing Search) opens its datasheet with default wargear and points.
- **Share by QR code:** Export → *Share (QR code)* shows a QR code and link that contain the whole
  roster in compressed form, so nothing is uploaded and codes never expire. Scanning with a phone
  camera opens PawHammer with an import prompt. *Scan QR / Enter Code* on the home screen reads a
  code with the camera, or from a pasted link. The receiver saves their own editable copy.
- **Import from text:** paste a list exported from the official Warhammer 40,000 app. The importer
  sets Battle Size, Detachment and Force Disposition, and picks the model variants and wargear
  that match the listed weapons. It also sets enhancements, the Warlord and Leader/Support
  attachments, then reports anything it couldn't match and any points that changed since the export.
- **Tabletop Simulator:** Export → *Get Yellowscribe code* uploads the roster to
  [Yellowscribe](https://yellowscribe.link) and shows the code for the Yellowscribe v2 mod.
- Data files are cached in IndexedDB and re-downloaded only when the repository changes.
- A fork or branch of 40kdc-data, or local BattleScribe JSON files, can be selected under **Data Source**.
- Dark and light themes, and a responsive layout.

## Yellowscribe setup

Yellowscribe's server doesn't send CORS headers, so a web page can only read the code it
returns through a CORS proxy. The proxy URL is set under **Data Source** and defaults to
[Corsfix](https://corsfix.com) (`https://proxy.corsfix.com/?{url}`):

- **Running locally** (`npm start`): works as-is. Corsfix allows localhost without an account.
- **Live site** (e.g. GitHub Pages): create a free Corsfix account and add the site's domain
  (for example `frbfli.github.io`). The free plan allows 60 requests per minute and 100 MB a month.

Other proxies work too. `{url}` is replaced with the Yellowscribe address, and `{encodedUrl}`
with a URL-encoded one. For corsproxy.io, for example: `https://corsproxy.io/?key=YOUR_KEY&url={encodedUrl}`.

If the proxy is empty or fails, the dialog offers to download the `.ros` file and open
Yellowscribe, so you can upload the file there yourself.

## Architecture

```
js/
  engine/
    gamedata.js   Indexes a game system + catalogues and resolves entry links into EntryDefs
    roster.js     Roster / Force / Selection model
    engine.js     RosterEngine: modifiers, conditions, repeats, constraints, costs,
                  validation, auto-selection, datasheet info, text/JSON export
  data/
    dc-repository.js 40kdc-data source: file listing, downloads, faction list
    dc-translate.js  40kdc-data -> the engine's (BattleScribe-shaped) game data
    repository.js    BattleScribe JSON files (local), catalogue-link resolution
    cache.js         IndexedDB cache
  ui/             Bootstrap views (home, editor, play), templating helpers, storage
  main.js         App controller and routing
```

### Data

`dc-translate.js` turns a 40kdc-data faction into the structures the engine reads:

- Units and their compositions become unit entries with model entries. Rows of several models get
  one entry per loadout (the default, each loadout variant and each weapon swap), so a squad can
  mix them; swaps limited "1 per N models" scale with the unit size.
- Single models (sergeants, characters, vehicles) get a choice list for each set of weapons
  their swaps replace.
- Points rows set the unit's cost by model count, including escalating costs for later copies of
  a unit and per-item wargear costs.
- Leader attachments, detachments (with Detachment Points and their rules, enhancements and
  stratagems), Force Dispositions and the Warlord become the engine's associations and
  configuration entries.
- Ability text comes from the data's own notes or the 40kdc describer (MIT), loaded from
  jsDelivr when available.

Not translated (yet): allied units, wargear budgets shared between several weapons, conditional
keywords, and a model taking several weapon swaps at once.

The engine implements the BattleScribe data model, in the JSON form BSData used for
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

## Tests

```sh
npm run fixtures     # downloads 40kdc-data files into tests/fixtures/40kdc
npm test
```

`tests/engine.test.js` builds Necron, Space Marine, Sororitas and Chaos rosters from the real
40kdc-data files through the app's repository and translator. It checks auto-selection, points by
unit size and copy, weapon swaps, leaders, Warlord, enhancements, Detachment Points, validation,
datasheets, import/export round trips and old BSData rosters. `tests/bsdata.test.js` covers the
BattleScribe format and runs only when BSData files are in `tests/fixtures/`.

Warhammer 40,000 is a trademark of Games Workshop. This project is unofficial and not
endorsed by Games Workshop. Data from [40kdc-data](https://github.com/wn-mitch/40kdc-data)
© Alpaca Software and the 40kdc community contributors, licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); converted for use in this app.
