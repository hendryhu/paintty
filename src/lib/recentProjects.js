import { writable } from 'svelte/store';
import {
  openPainttyDatabase,
  RECENT_PROJECT_STORE,
} from './browserDb.js';
import { onProjectLoaded, onProjectSaved } from './documentLifecycle.js';
import { scheduleMediaCacheGc } from './mediaGc.js';

export const RECENT_PROJECT_LIMIT = 8;
export const recentProjects = writable([]);
export const recentProjectIdentity = writable(null);
let recentMutationGeneration = 0;

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction was aborted.'));
  });
}

export function createRecentProjectId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function recentProjectRecord(detail, now = Date.now()) {
  if (detail?.recent === false) return null;
  const name = String(detail?.fileName || '').trim();
  const contents = String(detail?.contents || '');
  if (!name || !contents) return null;
  const id = String(detail?.recentId || '').trim() || createRecentProjectId();
  return {
    id,
    name,
    contents,
    openedAt: Number(now) || 0,
  };
}

export function newestRecentProjects(records, limit = RECENT_PROJECT_LIMIT) {
  const byId = new Map();
  for (const record of records || []) {
    if (!record?.id || !record?.name || !record?.contents) continue;
    const previous = byId.get(record.id);
    if (!previous || Number(record.openedAt) >= Number(previous.openedAt)) {
      byId.set(record.id, record);
    }
  }
  return [...byId.values()]
    .sort((a, b) => Number(b.openedAt) - Number(a.openedAt) ||
      String(a.name).localeCompare(String(b.name)))
    .slice(0, Math.max(0, limit));
}

export function createRecentProjectStorage(options = {}) {
  const openDatabase = options.openDatabase || openPainttyDatabase;
  const storeName = options.storeName || RECENT_PROJECT_STORE;
  const limit = options.limit ?? RECENT_PROJECT_LIMIT;

  return {
    async list() {
      const database = await openDatabase();
      try {
        const transaction = database.transaction(storeName, 'readonly');
        const request = transaction.objectStore(storeName).getAll();
        const records = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error || new Error('Could not read recent projects.'));
        });
        await transactionComplete(transaction);
        scheduleMediaCacheGc();
        return newestRecentProjects(records, limit);
      } finally {
        database.close();
      }
    },

    async put(record) {
      if (!record) return;
      const database = await openDatabase();
      try {
        const transaction = database.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        store.put(record);
        const request = store.getAll();
        request.onsuccess = () => {
          const keep = new Set(newestRecentProjects(request.result || [], limit).map((item) => item.id));
          for (const old of request.result || []) if (!keep.has(old.id)) store.delete(old.id);
        };
        await transactionComplete(transaction);
        scheduleMediaCacheGc();
      } finally {
        database.close();
      }
    },

    async remove(id) {
      const database = await openDatabase();
      try {
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).delete(id);
        await transactionComplete(transaction);
        scheduleMediaCacheGc();
      } finally {
        database.close();
      }
    },

    async clear() {
      const database = await openDatabase();
      try {
        const transaction = database.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).clear();
        await transactionComplete(transaction);
      } finally {
        database.close();
      }
    },
  };
}

export function startRecentProjectTracking(options = {}) {
  const storage = options.storage || createRecentProjectStorage();
  const subscribeLoaded = options.onLoaded || onProjectLoaded;
  const subscribeSaved = options.onSaved || onProjectSaved;
  const now = options.now || Date.now;
  const reportError = options.reportError ||
    ((error) => console.warn('Recent projects are unavailable.', error));
  let stopped = false;
  let refreshSequence = 0;

  async function refresh() {
    const sequence = ++refreshSequence;
    const mutationGeneration = recentMutationGeneration;
    try {
      const records = await storage.list();
      if (!stopped &&
          sequence === refreshSequence &&
          mutationGeneration === recentMutationGeneration) recentProjects.set(records);
      return records;
    } catch (error) {
      reportError(error);
      return [];
    }
  }

  async function remember(detail) {
    const record = recentProjectRecord(detail, now());
    if (!record) return;
    const mutationGeneration = recentMutationGeneration;
    try {
      await storage.put(record);
      if (mutationGeneration !== recentMutationGeneration) await storage.remove(record.id);
      await refresh();
    } catch (error) {
      reportError(error);
    }
  }

  const stopLoaded = subscribeLoaded(remember);
  const stopSaved = subscribeSaved(remember);
  return {
    ready: refresh(),
    stop() {
      stopped = true;
      refreshSequence++;
      stopLoaded();
      stopSaved();
    },
  };
}

export async function forgetRecentProject(id, storage = createRecentProjectStorage()) {
  try {
    await storage.remove(id);
    recentProjects.update((items) => items.filter((item) => item.id !== id));
  } catch (error) {
    console.warn('Could not remove the recent project.', error);
  }
}

export async function clearRecentProjects(storage = createRecentProjectStorage()) {
  try {
    await storage.clear();
    recentMutationGeneration++;
    recentProjects.set([]);
    return true;
  } catch (error) {
    console.warn('Could not clear recent projects.', error);
    return false;
  }
}
