// BSData repository access: lists the data files of a BSData GitHub repo (default
// BSData/wh40k-11e), builds a lightweight manifest (id/name/library per file) and
// downloads + caches game system / catalogue JSON files, resolving catalogue links.

import { GameData } from '../engine/gamedata.js';
import { cacheGet, cachePut } from './cache.js';

export const DEFAULT_SOURCE = { owner: 'BSData', repo: 'wh40k-11e', branch: 'main' };
const LIST_TTL = 60 * 60 * 1000; // 1 hour

const isDataFile = (name) => /\.(json)$/i.test(name) && !/^\./.test(name) && !/package(-lock)?\.json$/i.test(name);

function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or unavailable */ }
}

const HEADER_KEYS = new Set(['id', 'name', 'library', 'gameSystemId']);

/**
 * Pull the root id/name/library out of a (possibly partial) BSData JSON file.
 * Only keys directly on the `gameSystem`/`catalogue` object count, wherever they appear.
 * Returns null until enough of the file has been seen.
 * @param {string} text
 * @param {boolean} eof  true when `text` is the whole file
 */
function parseHeader(text, eof = false) {
  const out = { type: null, id: null, name: null, gameSystemId: null, library: null };
  const stack = []; // open containers: '{' or '['
  let expectKey = false;
  let key = null;
  let inValue = false;
  let i = 0;
  const isDone = () => out.type && out.id && out.name && (out.type === 'gameSystem' || out.library != null);
  const readString = () => {
    let s = '';
    for (i++; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') { s += c + text[++i]; continue; }
      if (c === '"') return JSON.parse('"' + s + '"');
      s += c;
    }
    return null; // truncated
  };
  for (; i < text.length; i++) {
    const c = text[i];
    const depth = stack.length;
    if (c === '"') {
      const s = readString();
      if (s == null) break;
      if (expectKey) {
        key = s;
        expectKey = false;
        if (depth === 1 && (s === 'gameSystem' || s === 'catalogue')) out.type = s;
      } else if (inValue && depth === 2 && out.type && HEADER_KEYS.has(key)) {
        out[key] = s;
        if (isDone()) break;
      }
      inValue = false;
    } else if (c === '{') { stack.push(c); expectKey = true; inValue = false; }
    else if (c === '[') { stack.push(c); expectKey = false; inValue = false; }
    else if (c === '}' || c === ']') { stack.pop(); inValue = false; if (stack.length === 1 && out.type) break; }
    else if (c === ',') { expectKey = stack[stack.length - 1] === '{'; inValue = false; }
    else if (c === ':') { inValue = true; }
    else if (inValue && depth === 2 && key === 'library' && (c === 't' || c === 'f')) { out.library = c === 't'; inValue = false; if (isDone()) break; }
  }
  if (!isDone() && !eof) return null;
  if (!out.type || !out.id) return null;
  return { ...out, library: !!out.library };
}

export class GitHubSource {
  constructor(source = DEFAULT_SOURCE) {
    this.owner = source.owner;
    this.repo = source.repo;
    this.branch = source.branch || 'main';
  }

  get label() { return `${this.owner}/${this.repo}@${this.branch}`; }
  get cacheKey() { return `pawhammer:${this.owner}/${this.repo}@${this.branch}`; }

  rawUrl(path) {
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${encodeURIComponent(this.branch)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** @returns {Promise<{name:string,path:string,version:string,size:number}[]>} */
  async listFiles({ force = false } = {}) {
    const key = this.cacheKey + ':files';
    const cached = lsGet(key);
    if (!force && cached && Date.now() - cached.at < LIST_TTL) return cached.files;
    let files = null;
    try {
      const res = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}/contents/?ref=${encodeURIComponent(this.branch)}`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const list = await res.json();
      files = list.filter((f) => f.type === 'file' && isDataFile(f.name))
        .map((f) => ({ name: f.name, path: f.path, version: f.sha, size: f.size }));
    } catch (err) {
      // Fall back to jsDelivr's listing (no GitHub API rate limit).
      try {
        const res = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${this.owner}/${this.repo}@${encodeURIComponent(this.branch)}?structure=flat`);
        if (!res.ok) throw new Error(`jsDelivr ${res.status}`);
        const body = await res.json();
        files = body.files.map((f) => ({ name: f.name.replace(/^\//, ''), path: f.name.replace(/^\//, ''), version: f.hash, size: f.size }))
          .filter((f) => !f.path.includes('/') && isDataFile(f.name));
      } catch (err2) {
        if (cached) return cached.files;
        throw new Error(`Could not list ${this.label}: ${err.message}; ${err2.message}`);
      }
    }
    lsSet(key, { at: Date.now(), files });
    return files;
  }

  async readHeader(file) {
    const full = await cacheGet(this.cacheKey + ':' + file.path);
    if (full && full.version === file.version) return parseHeader(full.text, true);
    const res = await fetch(this.rawUrl(file.path));
    if (!res.ok) throw new Error(`${file.name}: HTTP ${res.status}`);
    if (!res.body || !res.body.getReader) return parseHeader(await res.text(), true);
    // Stream until the root id/name/library have been seen (usually the first few KB).
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return parseHeader(text + decoder.decode(), true);
      text += decoder.decode(value, { stream: true });
      const header = parseHeader(text);
      if (header) { reader.cancel().catch(() => {}); return header; }
    }
  }

  async readFile(file, onProgress) {
    const key = this.cacheKey + ':' + file.path;
    const cached = await cacheGet(key);
    if (cached && cached.version === file.version) return cached.text;
    const res = await fetch(this.rawUrl(file.path));
    if (!res.ok) throw new Error(`${file.name}: HTTP ${res.status}`);
    let text;
    if (onProgress && res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const total = file.size || Number(res.headers.get('content-length')) || 0;
      let loaded = 0;
      text = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        loaded += value.length;
        text += decoder.decode(value, { stream: true });
        onProgress(loaded, total);
      }
      text += decoder.decode();
    } else {
      text = await res.text();
    }
    await cachePut(key, { version: file.version, text });
    return text;
  }
}

/** Files picked from disk (e.g. a local clone of the BSData repo). */
export class LocalSource {
  constructor(fileList) {
    this.files = [...fileList].filter((f) => isDataFile(f.name));
    this.label = `Local files (${this.files.length})`;
  }
  get cacheKey() { return 'pawhammer:local'; }
  async listFiles() {
    return this.files.map((f) => ({ name: f.name, path: f.name, version: String(f.lastModified), size: f.size, blob: f }));
  }
  async readHeader(file) {
    const header = parseHeader(await file.blob.slice(0, 8000).text());
    return header || parseHeader(await file.blob.text(), true);
  }
  async readFile(file) { return file.blob.text(); }
}

export class Repository {
  constructor(source) {
    this.source = source;
    this._manifest = null;
    this._docs = new Map();
  }

  /**
   * Manifest of every data file: { file, type, id, name, library, gameSystemId }.
   * Only the first few KB of each file are read, and results are cached per file version.
   */
  async manifest(onProgress) {
    if (this._manifest) return this._manifest;
    const files = await this.source.listFiles();
    const key = this.source.cacheKey + ':manifest:v2';
    const cached = (this.source instanceof GitHubSource && lsGet(key)) || {};
    const out = [];
    let done = 0;
    const queue = [...files];
    const worker = async () => {
      while (queue.length) {
        const file = queue.shift();
        let header = cached[file.path] && cached[file.path].version === file.version ? cached[file.path].header : null;
        if (!header) {
          try { header = await this.source.readHeader(file); } catch (e) { header = null; console.warn(e); }
          if (header) cached[file.path] = { version: file.version, header };
        }
        if (header) out.push({ file, ...header });
        done++;
        if (onProgress) onProgress(done, files.length);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (this.source instanceof GitHubSource) lsSet(key, cached);
    out.sort((a, b) => a.name.localeCompare(b.name));
    this._manifest = out;
    return out;
  }

  async gameSystems() { return (await this.manifest()).filter((m) => m.type === 'gameSystem'); }

  async factions(gameSystemId) {
    return (await this.manifest()).filter((m) => m.type === 'catalogue' && !m.library &&
      (!gameSystemId || !m.gameSystemId || m.gameSystemId === gameSystemId));
  }

  async _loadDoc(entry, onProgress) {
    if (this._docs.has(entry.id)) return this._docs.get(entry.id);
    const text = await this.source.readFile(entry.file, onProgress);
    const json = JSON.parse(text);
    const doc = json.gameSystem || json.catalogue;
    if (!doc) throw new Error(`${entry.file.name} is not a BattleScribe game system or catalogue.`);
    this._docs.set(entry.id, doc);
    return doc;
  }

  /**
   * Load the game system, the chosen catalogue and every catalogue it links to.
   * @param {string} catalogueId
   * @param {(msg:string)=>void} [status]
   */
  async loadGameData(catalogueId, status = () => {}) {
    const manifest = await this.manifest();
    const primary = manifest.find((m) => m.id === catalogueId);
    if (!primary) throw new Error(`Catalogue ${catalogueId} not found in ${this.source.label}.`);
    const gsEntry = manifest.find((m) => m.type === 'gameSystem' && (!primary.gameSystemId || m.id === primary.gameSystemId)) ||
      manifest.find((m) => m.type === 'gameSystem');
    if (!gsEntry) throw new Error('No game system file (.gst) found in the data source.');

    const progress = (name) => (loaded, total) => status(`Downloading ${name}… ${total ? Math.round((loaded / total) * 100) + '%' : ''}`);
    status(`Loading ${gsEntry.name}…`);
    const gameSystem = await this._loadDoc(gsEntry, progress(gsEntry.name));

    const catalogues = [];
    const pending = [primary];
    const seen = new Set();
    while (pending.length) {
      const entry = pending.shift();
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      status(`Loading ${entry.name}…`);
      const doc = await this._loadDoc(entry, progress(entry.name));
      catalogues.push(doc);
      for (const link of doc.catalogueLinks || []) {
        const target = manifest.find((m) => m.id === link.targetId);
        if (target) pending.push(target);
        else console.warn(`Linked catalogue ${link.name} (${link.targetId}) not found.`);
      }
    }
    status('Indexing…');
    return new GameData(gameSystem, catalogues, primary.id);
  }
}
