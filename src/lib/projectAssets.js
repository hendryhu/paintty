import { assertSha256 } from './mediaHash.js';
import { openPainttyDatabase, PROJECT_ASSET_STORE } from './browserDb.js';

const mediaLeases = new Map();
const memoryMediaCache = new Map();

function useMemory(options) {
  return !options.openDatabase && !globalThis.indexedDB;
}

function transactionComplete(transaction, message) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error(message));
    transaction.onabort = () => reject(transaction.error || new Error(message));
  });
}

function requestResult(request, message) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(message));
  });
}

function cacheRecord(hash, blob, metadata = {}, now = Date.now()) {
  if (!blob || typeof blob.arrayBuffer !== 'function') {
    throw new TypeError('Cached media must be a Blob.');
  }
  const size = Number(blob.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('Cached media size is invalid.');
  if (metadata.size != null && Number(metadata.size) !== size) {
    throw new Error(`Cached media size does not match ${hash}.`);
  }
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : 0;
  return {
    hash: assertSha256(hash),
    blob,
    size,
    mime: String(metadata.mime || blob.type || 'application/octet-stream'),
    createdAt: Number.isFinite(Number(metadata.createdAt)) ? Number(metadata.createdAt) : timestamp,
    lastAccessedAt: timestamp,
  };
}

export function activeMediaLeaseHashes() {
  return new Set([...mediaLeases].filter(([, count]) => count > 0).map(([hash]) => hash));
}

// Leases key cached bytes by hash, not asset ID, because deduplicated assets can
// share one cache record and GC must retain it until every operation finishes.
export async function withMediaLease(hash, operation) {
  const key = assertSha256(hash);
  mediaLeases.set(key, (mediaLeases.get(key) || 0) + 1);
  try {
    return await operation();
  } finally {
    const remaining = (mediaLeases.get(key) || 1) - 1;
    if (remaining > 0) mediaLeases.set(key, remaining);
    else mediaLeases.delete(key);
  }
}

export async function putProjectAsset(hash, blob, metadata = {}, options = {}) {
  const record = cacheRecord(hash, blob, metadata, options.now?.() ?? Date.now());
  if (useMemory(options)) {
    memoryMediaCache.set(record.hash, record);
    return record;
  }
  const db = await (options.openDatabase || openPainttyDatabase)();
  try {
    const tx = db.transaction(options.storeName || PROJECT_ASSET_STORE, 'readwrite');
    tx.objectStore(options.storeName || PROJECT_ASSET_STORE).put(record);
    await transactionComplete(tx, 'Could not store media bytes.');
    return record;
  } finally {
    db.close();
  }
}

export async function putProjectAssets(records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError('Media cache batch must be an array.');
  const now = options.now?.() ?? Date.now();
  const normalized = records.map((record) => cacheRecord(
    record.hash,
    record.blob,
    record,
    now,
  ));
  if (useMemory(options)) {
    for (const record of normalized) memoryMediaCache.set(record.hash, record);
    return normalized;
  }
  const db = await (options.openDatabase || openPainttyDatabase)();
  try {
    const storeName = options.storeName || PROJECT_ASSET_STORE;
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const record of normalized) store.put(record);
    await transactionComplete(tx, 'Could not store media byte batch.');
    return normalized;
  } finally {
    db.close();
  }
}

export async function getProjectAsset(hash, options = {}) {
  const key = assertSha256(hash);
  if (useMemory(options)) {
    const record = memoryMediaCache.get(key);
    if (!record) return null;
    record.lastAccessedAt = options.now?.() ?? Date.now();
    return record;
  }
  const db = await (options.openDatabase || openPainttyDatabase)();
  try {
    const storeName = options.storeName || PROJECT_ASSET_STORE;
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const record = await requestResult(store.get(key), 'Could not read media bytes.');
    if (record) {
      record.lastAccessedAt = options.now?.() ?? Date.now();
      store.put(record);
    }
    await transactionComplete(tx, 'Could not update media access time.');
    return record || null;
  } finally {
    db.close();
  }
}

export async function listProjectAssets(options = {}) {
  if (useMemory(options)) return [...memoryMediaCache.values()];
  const db = await (options.openDatabase || openPainttyDatabase)();
  try {
    const storeName = options.storeName || PROJECT_ASSET_STORE;
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const records = await requestResult(store.getAll(), 'Could not list media bytes.');
    await transactionComplete(tx, 'Could not list media bytes.');
    return records || [];
  } finally {
    db.close();
  }
}

export async function deleteProjectAsset(hash, options = {}) {
  const key = assertSha256(hash);
  if (useMemory(options)) return memoryMediaCache.delete(key);
  const db = await (options.openDatabase || openPainttyDatabase)();
  try {
    const storeName = options.storeName || PROJECT_ASSET_STORE;
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    await transactionComplete(tx, 'Could not delete media bytes.');
    return true;
  } finally {
    db.close();
  }
}

export async function deleteProjectAssets(hashes, options = {}) {
  const keys = [...new Set([...hashes].map((hash) => assertSha256(hash)))];
  if (!keys.length) return 0;
  if (useMemory(options)) {
    for (const key of keys) memoryMediaCache.delete(key);
    return keys.length;
  }
  const db = await (options.openDatabase || openPainttyDatabase)();
  try {
    const storeName = options.storeName || PROJECT_ASSET_STORE;
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const hash of keys) store.delete(hash);
    await transactionComplete(tx, 'Could not delete media byte batch.');
    return keys.length;
  } finally {
    db.close();
  }
}
