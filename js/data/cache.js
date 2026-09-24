// Tiny IndexedDB key/value cache for downloaded data files. Falls back to an
// in-memory map when IndexedDB is unavailable (private mode, blocked storage).

const DB_NAME = 'pawhammer';
const STORE = 'files';
const memory = new Map();
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run(mode, fn) {
  return openDb().then((db) => {
    if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

export async function cacheGet(key) {
  if (memory.has(key)) return memory.get(key);
  const v = await run('readonly', (s) => s.get(key));
  if (v !== undefined) memory.set(key, v);
  return v;
}

export async function cachePut(key, value) {
  memory.set(key, value);
  await run('readwrite', (s) => s.put(value, key));
}

export async function cacheClear() {
  memory.clear();
  await run('readwrite', (s) => s.clear());
}
