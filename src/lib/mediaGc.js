import {
  activeMediaLeaseHashes,
  deleteProjectAssets,
  listProjectAssets,
} from './projectAssets.js';
import { currentMediaRegistry, registryHashes } from './mediaRegistry.js';

// Unmarked compressed bytes remain recoverable for seven days after their last access.
export const MEDIA_CACHE_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export function mediaHashesFromProject(value) {
  let project = value;
  if (typeof value === 'string') {
    try { project = JSON.parse(value); } catch { return new Set(); }
  }
  const assets = project?.media?.assets;
  return new Set(Array.isArray(assets)
    ? assets.flatMap((asset) => typeof asset?.hash === 'string' ? [asset.hash] : [])
    : []);
}

export function planMediaCacheSweep(records, markedHashes, options = {}) {
  const now = Number(options.now ?? Date.now());
  const grace = Math.max(0, Number(options.gracePeriodMs ?? MEDIA_CACHE_GRACE_PERIOD_MS));
  const marked = new Set(markedHashes || []);
  return (records || []).filter((record) => {
    if (!record?.hash || marked.has(record.hash)) return false;
    const touched = Math.max(
      Number.isFinite(Number(record.lastAccessedAt)) ? Number(record.lastAccessedAt) : 0,
      Number.isFinite(Number(record.createdAt)) ? Number(record.createdAt) : 0,
    );
    return now - touched >= grace;
  }).map((record) => record.hash).sort();
}

async function projectText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.text === 'function') return value.text();
  return '';
}

async function storedProjectHashes(options = {}) {
  if (options.storedProjects) {
    const output = new Set();
    for (const value of options.storedProjects) {
      for (const hash of mediaHashesFromProject(await projectText(value))) output.add(hash);
    }
    return output;
  }
  const output = new Set();
  const { openPainttyDatabase, RECENT_PROJECT_STORE, RECOVERY_SNAPSHOT_STORE } =
    await import('./browserDb.js');
  const db = await openPainttyDatabase();
  try {
    for (const storeName of [RECOVERY_SNAPSHOT_STORE, RECENT_PROJECT_STORE]) {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).getAll();
      const records = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error('Could not mark stored projects.'));
      });
      for (const record of records) {
        const source = storeName === RECOVERY_SNAPSHOT_STORE ? record.project : record.contents;
        for (const hash of mediaHashesFromProject(await projectText(source))) output.add(hash);
      }
    }
  } finally {
    db.close();
  }
  return output;
}

// Registry and lease roots are marked again after asynchronous discovery so media
// acquired during the mark phase cannot be swept.
export async function runMediaCacheGc(options = {}) {
  const marked = new Set(options.markedHashes || registryHashes(currentMediaRegistry()));
  for (const hash of activeMediaLeaseHashes()) marked.add(hash);
  for (const hash of options.historyHashes || []) marked.add(hash);
  for (const hash of options.resourceHashes || []) marked.add(hash);
  for (const hash of await storedProjectHashes(options)) marked.add(hash);
  const records = await (options.list || listProjectAssets)(options.storageOptions);
  for (const hash of registryHashes(currentMediaRegistry())) marked.add(hash);
  for (const hash of activeMediaLeaseHashes()) marked.add(hash);
  const deleted = planMediaCacheSweep(records, marked, options);
  if (deleted.length) await (options.remove || deleteProjectAssets)(deleted, options.storageOptions);
  return { marked, deleted };
}

let scheduled = false;
export function scheduleMediaCacheGc(options = {}) {
  if (!globalThis.indexedDB && !options.storedProjects && !options.list) return;
  if (scheduled) return;
  scheduled = true;
  const run = async () => {
    scheduled = false;
    try {
      let historyHashes = options.historyHashes || [];
      if (!options.historyHashes) {
        const grid = await import('./grid.js');
        historyHashes = grid.collectHistoryReachability?.() || [];
      }
      let resourceHashes = options.resourceHashes || [];
      if (!options.resourceHashes) {
        const runtime = await import('./mediaRuntime.js');
        resourceHashes = runtime.activeMediaResourceHashes?.() || [];
      }
      await runMediaCacheGc({ ...options, historyHashes, resourceHashes });
    } catch (error) {
      console.warn('Media cache cleanup could not complete.', error);
    }
  };
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 0);
  }
}
