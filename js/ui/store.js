// Browser persistence for rosters and settings (localStorage).

import { DEFAULT_SOURCE } from '../data/repository.js';

const ROSTERS = 'pawhammer:rosters';
const SETTINGS = 'pawhammer:settings';

function read(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.error('Could not save', err);
    return false;
  }
}

export const store = {
  listRosters() {
    return Object.values(read(ROSTERS, {})).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },
  getRoster(id) { return read(ROSTERS, {})[id] || null; },
  saveRoster(json) {
    const all = read(ROSTERS, {});
    all[json.id] = json;
    return write(ROSTERS, all);
  },
  deleteRoster(id) {
    const all = read(ROSTERS, {});
    delete all[id];
    write(ROSTERS, all);
  },
  settings() {
    return { source: { ...DEFAULT_SOURCE }, theme: 'dark', ...read(SETTINGS, {}) };
  },
  saveSettings(patch) { write(SETTINGS, { ...this.settings(), ...patch }); },
};
