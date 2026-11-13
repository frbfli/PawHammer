// 40kdc-data repository access (github.com/wn-mitch/40kdc-data, data CC BY 4.0): lists the
// dataset's files, builds the faction list, downloads + caches a faction's files and translates
// them into GameData (see dc-translate.js). Same interface as Repository in repository.js.

import { GameData } from '../engine/gamedata.js';
import { cacheGet, cachePut } from './cache.js';
import { translate, GS_ID } from './dc-translate.js';

export const DC_SOURCE = { owner: 'wn-mitch', repo: '40kdc-data', branch: 'main' };
/** The 40kdc ability describer (MIT): turns ability rules into readable text. Optional. */
const DESCRIBER_URL = 'https://cdn.jsdelivr.net/npm/@alpaca-software/40kdc-data@1.5.0/dist/translate/index.js';
const LIST_TTL = 60 * 60 * 1000; // 1 hour
const DATA = 'data/';
const FACTION_FILES = ['factions', 'units', 'unit-compositions', 'wargear-options', 'wargear', 'weapons', 'leader-attachments', 'detachments', 'enhancements', 'stratagems'];

function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or unavailable */ }
}

let describer = null;
/** Load the describer once; resolves to null when it can't be loaded (offline, blocked). */
function loadDescriber() {
  if (!describer) {
    describer = import(DESCRIBER_URL).then((m) => (typeof m.describeAbility === 'function' ? m.describeAbility : null)).catch((err) => {
      console.warn('Ability describer unavailable:', err);
      return null;
    });
  }
  return describer;
}

export class DcSource {
  constructor(source = DC_SOURCE) {
    this.owner = source.owner;
    this.repo = source.repo;
    this.branch = source.branch || 'main';
  }

  get label() { return `${this.owner}/${this.repo}@${this.branch}`; }
  get cacheKey() { return `pawhammer:${this.owner}/${this.repo}@${this.branch}`; }

  rawUrl(path) {
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${encodeURIComponent(this.branch)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** Data files by path: { path: { version, size } } (GitHub's tree, else jsDelivr's listing). */
  async listFiles({ force = false } = {}) {
    const key = this.cacheKey + ':dc-files';
    const cached = lsGet(key);
    if (!force && cached && Date.now() - cached.at < LIST_TTL) return cached.files;
    const keep = (path) => path.startsWith(DATA) && path.endsWith('.json') && /^data\/(core|enrichment)\//.test(path);
    let files = null;
    const tree = async (treeish, prefix) => {
      // no-store: the listing is kept in localStorage for an hour, and a revalidated response
      // can otherwise surface as a bodyless 304.
      const res = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/git/trees/${encodeURIComponent(treeish)}?recursive=1`, {
        headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store',
      });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const body = await res.json();
      const out = {};
      for (const f of body.tree || []) {
        const path = prefix + f.path;
        if (f.type === 'blob' && keep(path)) out[path] = { version: f.sha, size: f.size };
      }
      return out;
    };
    try {
      // Just the data folder (a fraction of the repository's tree), else the whole tree.
      try { files = await tree(`${this.branch}:data`, DATA); } catch { files = await tree(this.branch, ''); }
    } catch (err) {
      try {
        const res = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${this.owner}/${this.repo}@${encodeURIComponent(this.branch)}?structure=flat`);
        if (!res.ok) throw new Error(`jsDelivr ${res.status}`);
        const body = await res.json();
        files = {};
        for (const f of body.files || []) { const path = f.name.replace(/^\//, ''); if (keep(path)) files[path] = { version: f.hash, size: f.size }; }
      } catch (err2) {
        if (cached) return cached.files;
        throw new Error(`Could not list ${this.label}: ${err.message}; ${err2.message}`);
      }
    }
    if (!Object.keys(files).some((p) => /^data\/core\/[^/]+\/factions\.json$/.test(p))) {
      throw new Error(`${this.label} doesn't look like a 40kdc-data repository (no data/core/<faction>/factions.json).`);
    }
    lsSet(key, { at: Date.now(), files });
    return files;
  }

  async readJson(path, files) {
    const meta = files[path];
    if (!meta) return null;
    const key = this.cacheKey + ':' + path;
    const cached = await cacheGet(key);
    if (cached && cached.version === meta.version) return JSON.parse(cached.text);
    const res = await fetch(this.rawUrl(path));
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const text = await res.text();
    await cachePut(key, { version: meta.version, text });
    return JSON.parse(text);
  }
}

export class DcRepository {
  constructor(source) {
    this.source = source;
    this._manifest = null;
    this._factions = null; // id -> faction record (with dir)
  }

  /** All factions in the dataset: { id, name, parent_faction_id, keywords, dir, ... }. */
  async _factionRecords(onProgress) {
    if (this._factions) return this._factions;
    const files = await this.source.listFiles();
    const paths = Object.keys(files).filter((p) => /^data\/core\/[^/]+\/factions\.json$/.test(p) && !/\/_/.test(p));
    const out = new Map();
    let done = 0;
    await Promise.all(paths.map(async (p) => {
      try {
        const dir = p.split('/')[2];
        for (const f of (await this.source.readJson(p, files)) || []) out.set(f.id, { ...f, dir });
      } catch (err) { console.warn(err); }
      if (onProgress) onProgress(++done, paths.length);
    }));
    for (const f of out.values()) {
      const parent = f.parent_faction_id && out.get(f.parent_faction_id);
      f.displayName = parent ? `${parent.name} - ${f.name}` : f.name;
    }
    this._factions = out;
    return out;
  }

  /** Manifest in the shape the UI expects: one game system plus a "catalogue" per faction. */
  async manifest(onProgress) {
    if (this._manifest) return this._manifest;
    const factions = await this._factionRecords(onProgress);
    const out = [{ type: 'gameSystem', id: GS_ID, name: 'Warhammer 40,000 11th Edition', library: false }];
    for (const f of factions.values()) out.push({ type: 'catalogue', id: f.id, name: f.displayName, library: false, gameSystemId: GS_ID });
    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'gameSystem' ? -1 : 1));
    this._manifest = out;
    return out;
  }

  /**
   * The faction for a saved roster: its id, or for rosters saved with BSData, the faction whose
   * name (or alias) matches the end of the old catalogue name (e.g. "Xenos - Necrons").
   */
  async findFaction(catalogueId, catalogueName = '') {
    const factions = await this._factionRecords();
    if (factions.has(catalogueId)) return catalogueId;
    const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z]+/g, ' ').trim();
    const parts = String(catalogueName).split(/\s+-\s+/).map(norm).filter(Boolean);
    const names = (f) => [f.name, ...(f.aliases || [])].map(norm);
    for (let i = parts.length - 1; i >= 0; i--) {
      const hit = [...factions.values()].find((f) => names(f).includes(parts[i]));
      if (hit) return hit.id;
    }
    if (parts.includes('space marines')) return 'adeptus-astartes';
    return null;
  }

  async gameSystems() { return (await this.manifest()).filter((m) => m.type === 'gameSystem'); }

  async factions() { return (await this.manifest()).filter((m) => m.type === 'catalogue'); }

  /**
   * Download a faction (and its parent, for sub-factions such as Ultramarines) with the shared
   * core files and ability data, and translate it into GameData.
   */
  async loadGameData(factionId, status = () => {}) {
    const factions = await this._factionRecords();
    const faction = factions.get(factionId);
    if (!faction) throw new Error(`Faction ${factionId} not found in ${this.source.label}.`);
    const parent = faction.parent_faction_id ? factions.get(faction.parent_faction_id) : null;
    const familyRoot = parent || faction;
    const siblings = [...factions.values()].filter((f) => f.parent_faction_id === familyRoot.id && f.id !== faction.id);
    const files = await this.source.listFiles();
    const read = (path) => this.source.readJson(DATA + path, files).catch((err) => { console.warn(err); return null; });

    status(`Loading ${faction.displayName}…`);
    const describe = loadDescriber();
    const dirs = [faction.dir, ...(parent ? [parent.dir] : [])];
    const load = async (dir) => {
      const got = await Promise.all(FACTION_FILES.map((name) => read(`core/${dir}/${name}.json`)));
      return Object.fromEntries(FACTION_FILES.map((name, i) => [name, got[i] || []]));
    };
    const [own, inherited, forceDispositions, weaponKeywords, unitKeywords, ...abilityFiles] = await Promise.all([
      load(faction.dir), parent ? load(parent.dir) : null,
      read('core/force-dispositions.json'), read('core/weapon-keywords.json'), read('core/unit-keywords.json'),
      ...dirs.map((d) => read(`enrichment/${d}/abilities.json`)), read('enrichment/_core/abilities.json'),
    ]);
    // A chapter's files repeat many of its parent's records (e.g. the generic Space Marine
    // detachments): keep one of each, the chapter's own version.
    const recordKey = (r) => r.id || (r.leader_id && 'leader:' + r.leader_id) || (r.unit_id && 'unit:' + r.unit_id) || null;
    const merged = (key) => {
      const out = new Map();
      let anon = 0;
      for (const r of [...(inherited ? inherited[key] : []), ...own[key]]) out.set(recordKey(r) || `#${anon++}`, r);
      return [...out.values()];
    };
    const abilities = new Map();
    for (const list of abilityFiles.reverse()) for (const a of list || []) abilities.set(a.ability_id, a);

    status('Preparing datasheets…');
    const { gameSystem, catalogue } = translate({
      faction: { ...faction, displayName: faction.displayName },
      parent,
      siblings,
      files: {
        units: merged('units'), compositions: merged('unit-compositions'), options: merged('wargear-options'),
        wargear: merged('wargear'), weapons: merged('weapons'), leaders: merged('leader-attachments'),
        detachments: merged('detachments'), enhancements: merged('enhancements'), stratagems: merged('stratagems'),
      },
      core: { forceDispositions: forceDispositions || [], weaponKeywords: weaponKeywords || [], unitKeywords: unitKeywords || [] },
      abilities,
      describe: await describe,
    });
    return new GameData(gameSystem, [catalogue], catalogue.id);
  }
}
