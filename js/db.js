// Minimal IndexedDB wrapper. Everything stays on this device.
const DB_NAME = 'roofline';
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('houseTypes')) db.createObjectStore('houseTypes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('extracts')) db.createObjectStore('extracts', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted (device storage full?)'));
  });
}

export const get = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const put = (store, val) => tx(store, 'readwrite', (s) => s.put(val));
export const del = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
export const all = (store) => tx(store, 'readonly', (s) => s.getAll());
export const clear = (store) => tx(store, 'readwrite', (s) => s.clear());

export const kvGet = async (key, dflt = null) => (await get('kv', key))?.value ?? dflt;
export const kvSet = (key, value) => put('kv', { key, value });

export async function sha256(buf) {
  if (crypto?.subtle) {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback (non-secure context): FNV-1a 64-ish, good enough as an identity key
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const a = new Uint8Array(buf);
  for (let i = 0; i < a.length; i++) { h1 = Math.imul(h1 ^ a[i], 16777619); h2 = Math.imul(h2 ^ a[i], 2246822519); }
  return 'f' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + a.length.toString(16);
}

/** Store a PDF (deduplicated by hash). Returns file id. */
export async function saveFile(name, arrayBuffer) {
  const id = await sha256(arrayBuffer);
  const existing = await get('files', id);
  if (!existing) await put('files', { id, name, size: arrayBuffer.byteLength, addedAt: new Date().toISOString(), data: arrayBuffer });
  return id;
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}

export async function wipeAll() {
  for (const s of ['files', 'houseTypes', 'extracts', 'kv']) await clear(s);
}
