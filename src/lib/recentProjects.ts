import { writable } from 'svelte/store';
import {
  openPainttyDatabase,
  RECENT_PROJECT_STORE,
} from './browserDb.js';
import { onProjectLoaded, onProjectSaved } from './documentLifecycle.js';
import { scheduleMediaCacheGc } from './mediaGc.js';
import type {
  DatabaseOpener,
  ProjectLoadedDetail,
  ProjectSavedDetail,
  Unsubscribe,
} from './types/project-types.js';
import { isUnknownRecord } from './types/project-types.js';

export interface RecentProjectRecord {
  id: string;
  name: string;
  contents: string;
  openedAt: number;
}

export interface RecentProjectStorage {
  list(): Promise<RecentProjectRecord[]>;
  put(record: RecentProjectRecord): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

interface RecentProjectStorageOptions {
  openDatabase?: DatabaseOpener;
  storeName?: string;
  limit?: number;
}

interface RecentTrackingOptions {
  storage?: RecentProjectStorage;
  onLoaded?: (listener: (detail: ProjectLoadedDetail) => void | Promise<void>) => Unsubscribe;
  onSaved?: (listener: (detail: ProjectSavedDetail) => void | Promise<void>) => Unsubscribe;
  now?: () => number;
  reportError?: (error: unknown) => void;
}

export const RECENT_PROJECT_LIMIT = 8;
export const recentProjects = writable<RecentProjectRecord[]>([]);
export const recentProjectIdentity = writable<string | null>(null);
let recentMutationGeneration = 0;

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction was aborted.'));
  });
}

export function createRecentProjectId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function recentProjectRecord(
  detail: ProjectLoadedDetail | ProjectSavedDetail | null | undefined,
  now = Date.now(),
): RecentProjectRecord | null {
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

function isRecentProjectRecord(value: unknown): value is RecentProjectRecord {
  return isUnknownRecord(value) && typeof value['id'] === 'string' && !!value['id'] &&
    typeof value['name'] === 'string' && !!value['name'] &&
    typeof value['contents'] === 'string' && !!value['contents'];
}

export function newestRecentProjects(
  records: Iterable<unknown>,
  limit = RECENT_PROJECT_LIMIT,
): RecentProjectRecord[] {
  const byId = new Map<string, RecentProjectRecord>();
  for (const record of records || []) {
    if (!isRecentProjectRecord(record)) continue;
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

export function createRecentProjectStorage(
  options: RecentProjectStorageOptions = {},
): RecentProjectStorage {
  const openDatabase = options.openDatabase || openPainttyDatabase;
  const storeName = options.storeName || RECENT_PROJECT_STORE;
  const limit = options.limit ?? RECENT_PROJECT_LIMIT;

  return {
    async list() {
      const database = await openDatabase();
      try {
        const transaction = database.transaction(storeName, 'readonly');
        const request = transaction.objectStore(storeName).getAll();
        const records = await new Promise<unknown[]>((resolve, reject) => {
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

    async put(record: RecentProjectRecord) {
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

    async remove(id: string) {
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

export function startRecentProjectTracking(options: RecentTrackingOptions = {}) {
  const storage = options.storage || createRecentProjectStorage();
  const subscribeLoaded = options.onLoaded || onProjectLoaded;
  const subscribeSaved = options.onSaved || onProjectSaved;
  const now = options.now || Date.now;
  const reportError = options.reportError ||
    ((error) => console.warn('Recent projects are unavailable.', error));
  let stopped = false;
  let refreshSequence = 0;

  async function refresh(): Promise<RecentProjectRecord[]> {
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

  async function remember(detail: ProjectLoadedDetail | ProjectSavedDetail): Promise<void> {
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

export async function forgetRecentProject(
  id: string,
  storage: RecentProjectStorage = createRecentProjectStorage(),
): Promise<void> {
  try {
    await storage.remove(id);
    recentProjects.update((items) => items.filter((item) => item.id !== id));
  } catch (error) {
    console.warn('Could not remove the recent project.', error);
  }
}

export async function clearRecentProjects(
  storage: RecentProjectStorage = createRecentProjectStorage(),
): Promise<boolean> {
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
