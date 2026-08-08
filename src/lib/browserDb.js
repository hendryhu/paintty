export const PAINTTY_DB_NAME = 'paintty';
export const PAINTTY_DB_VERSION = 5;
export const WORKSPACE_HANDLE_STORE = 'workspace-handles';
export const RECOVERY_SNAPSHOT_STORE = 'recovery-snapshots';
export const RECENT_PROJECT_STORE = 'recent-projects';
export const PROJECT_ASSET_STORE = 'media-by-hash';

export function openPainttyDatabase(factory = globalThis.indexedDB) {
  if (!factory) return Promise.reject(new Error('IndexedDB is unavailable.'));
  return new Promise((resolve, reject) => {
    const request = factory.open(PAINTTY_DB_NAME, PAINTTY_DB_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      if (database.objectStoreNames.contains('project-assets')) {
        database.deleteObjectStore('project-assets');
      }
      if (!database.objectStoreNames.contains(WORKSPACE_HANDLE_STORE)) {
        database.createObjectStore(WORKSPACE_HANDLE_STORE);
      }
      if (!database.objectStoreNames.contains(RECOVERY_SNAPSHOT_STORE)) {
        database.createObjectStore(RECOVERY_SNAPSHOT_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(RECENT_PROJECT_STORE)) {
        database.createObjectStore(RECENT_PROJECT_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(PROJECT_ASSET_STORE)) {
        database.createObjectStore(PROJECT_ASSET_STORE, { keyPath: 'hash' });
      }
    };
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error('Could not open IndexedDB.'));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('IndexedDB upgrade is blocked by another Paintty tab.'));
    };
  });
}
