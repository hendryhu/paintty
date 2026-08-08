import { get, writable } from 'svelte/store';
import { dims } from './grid.js';
import { fileName } from './stores.js';
import { fps, playheadTick } from './frames.js';
import { canonicalClipTimeline } from './clipTimelineState.js';
import { projectMediaRegistry } from './mediaRegistry.js';
import { serializeLivePreview } from './fileio.js';
import {
  openPainttyDatabase,
  WORKSPACE_HANDLE_STORE,
} from './browserDb.js';

const DB_STORE = WORKSPACE_HANDLE_STORE;
const DB_KEY = 'preview';
const SCRATCH_DIR = '.paintty-preview';
const SNAPSHOT_DIR = 'previews';
const SESSION_DIR = 'sessions';
const WRITE_DELAY_MS = 150;
const MARKER_DELAY_MS = 40;

export const PREVIEW_HEARTBEAT_MS = 5000;
export const PREVIEW_WRITE_MAX_DELAY_MS = 1000;

function newSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function safeSegment(value, fallback, limit = 80) {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, limit) || fallback;
}

export const previewSessionId = newSessionId();

export function previewPath(name, sessionId = previewSessionId) {
  const stem = safeSegment(String(name || 'untitled').replace(/\.json$/i, ''), 'untitled');
  const id = safeSegment(sessionId, 'session', 64);
  return SCRATCH_DIR + '/' + SNAPSHOT_DIR + '/' + id + '-' + stem + '.json';
}

export function sessionMarkerPath(sessionId = previewSessionId) {
  return SCRATCH_DIR + '/' + SESSION_DIR + '/' + safeSegment(sessionId, 'session', 64) + '.json';
}

function selectedTick(value) {
  const tick = Number(value);
  return Number.isFinite(tick) ? Math.max(0, Math.trunc(tick)) : 0;
}

function unixMillis(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.trunc(timestamp)) : Date.now();
}

async function writeFile(handle, contents) {
  const destination = await handle.createWritable();
  await destination.write(contents);
  await destination.close();
}

async function directoryAt(root, names, create) {
  let directory = root;
  for (const name of names) directory = await directory.getDirectoryHandle(name, { create });
  return directory;
}

async function writePath(root, path, contents) {
  const parts = path.split('/');
  const name = parts.pop();
  const directory = await directoryAt(root, parts, true);
  const target = await directory.getFileHandle(name, { create: true });
  await writeFile(target, contents);
}

async function removePath(root, path) {
  const parts = path.split('/');
  const name = parts.pop();
  const directory = await directoryAt(root, parts, false);
  await directory.removeEntry(name);
}

async function pathExists(root, path) {
  try {
    const parts = path.split('/');
    const name = parts.pop();
    const directory = await directoryAt(root, parts, false);
    await directory.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function writeLegacyPointer(root, path) {
  const pointer = await root.getFileHandle('.opened', { create: true });
  await writeFile(pointer, path);
}

async function clearLegacyPointer(root, path) {
  try {
    const pointer = await root.getFileHandle('.opened');
    const file = await pointer.getFile();
    if ((await file.text()) === path) await root.removeEntry('.opened');
  } catch {
    // Another session may own the pointer, or the browser may already be closing.
  }
}

export async function writeSessionMarker(
  root,
  sessionId,
  path,
  playhead,
  updatedAt = Date.now(),
) {
  const marker = JSON.stringify({
    version: 2,
    path,
    playheadTick: selectedTick(playhead),
    updatedAt: unixMillis(updatedAt),
  });
  await writePath(root, sessionMarkerPath(sessionId), marker);
  return marker;
}

export async function writePreview(root, name, contents, options = {}) {
  const sessionId = options.sessionId || previewSessionId;
  const path = previewPath(name, sessionId);
  await writePath(root, path, contents);
  await writeSessionMarker(
    root,
    sessionId,
    path,
    options.playheadTick,
    options.updatedAt ?? Date.now(),
  );
  await writeLegacyPointer(root, path);
  return path;
}

function stateError(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createPreviewSync(options = {}) {
  const sessionId = options.sessionId || newSessionId();
  const state = options.stateStore || writable({ state: 'off', name: null, error: null });
  const nameStore = options.nameStore || fileName;
  const activeStore = options.playheadStore || playheadTick;
  const contentStores = options.contentStores || [
    canonicalClipTimeline, projectMediaRegistry, dims, fps, fileName,
  ];
  const serialize = options.serialize || serializeLivePreview;
  const now = options.now || (() => Date.now());
  const setTimeoutFn = options.setTimeout || ((callback, delay) => setTimeout(callback, delay));
  const clearTimeoutFn = options.clearTimeout || ((timer) => clearTimeout(timer));
  const setIntervalFn = options.setInterval || ((callback, delay) => setInterval(callback, delay));
  const clearIntervalFn = options.clearInterval || ((timer) => clearInterval(timer));
  const heartbeatMs = options.heartbeatMs || PREVIEW_HEARTBEAT_MS;

  let root = null;
  let currentPath = null;
  let lastContents = null;
  let fullTimer = null;
  let fullMaxTimer = null;
  let markerTimer = null;
  let heartbeatTimer = null;
  let pendingFull = false;
  let pendingMarker = false;
  let snapshotDirty = false;
  let dirtyRevision = 0;
  let draining = false;
  let drainPromise = Promise.resolve();
  let suppressSchedule = false;
  let started = false;
  let stopping = false;
  let unsubscribers = [];

  function clearFullTimers() {
    if (fullTimer != null) clearTimeoutFn(fullTimer);
    if (fullMaxTimer != null) clearTimeoutFn(fullMaxTimer);
    fullTimer = null;
    fullMaxTimer = null;
  }

  function clearScheduledWrites() {
    clearFullTimers();
    if (markerTimer != null) clearTimeoutFn(markerTimer);
    markerTimer = null;
    pendingFull = false;
    pendingMarker = false;
    snapshotDirty = false;
  }

  function setReady() {
    state.update((value) => ({ ...value, state: 'ready', error: null }));
  }

  async function removeOldSnapshot(path, fromRoot = root) {
    if (!fromRoot || !path) return;
    try { await removePath(fromRoot, path); } catch {}
  }

  async function cleanSession(fromRoot, path) {
    if (!fromRoot) return;
    try { await removePath(fromRoot, sessionMarkerPath(sessionId)); } catch {}
    if (path) await clearLegacyPointer(fromRoot, path);
    if (path) await removeOldSnapshot(path, fromRoot);
  }

  async function writeFullSnapshot() {
    let contents;
    suppressSchedule = true;
    try {
      contents = serialize();
    } finally {
      suppressSchedule = false;
    }

    const name = get(nameStore);
    const nextPath = previewPath(name, sessionId);
    const frame = get(activeStore);
    const revision = dirtyRevision;
    const missing = nextPath === currentPath
      && contents === lastContents
      && !await pathExists(root, nextPath);
    if (nextPath !== currentPath || contents !== lastContents || missing) {
      const oldPath = currentPath;
      await writePreview(root, name, contents, {
        sessionId,
        playheadTick: frame,
        updatedAt: now(),
      });
      currentPath = nextPath;
      lastContents = contents;
      if (oldPath && oldPath !== nextPath) await removeOldSnapshot(oldPath);
    } else {
      await writeSessionMarker(root, sessionId, currentPath, frame, now());
      await writeLegacyPointer(root, currentPath);
    }
    return revision;
  }

  async function writeMarker() {
    if (!currentPath) {
      pendingFull = true;
      return;
    }
    if (!await pathExists(root, currentPath)) {
      snapshotDirty = true;
      pendingFull = true;
      return;
    }
    await writeSessionMarker(root, sessionId, currentPath, get(activeStore), now());
    await writeLegacyPointer(root, currentPath);
  }

  // A single drain serializes marker and snapshot writes; dirtyRevision schedules
  // another full write when state changes during an in-flight snapshot.
  function drain() {
    if (draining) return drainPromise;
    draining = true;
    drainPromise = (async () => {
      while (root && (pendingFull || pendingMarker)) {
        const full = pendingFull || snapshotDirty;
        pendingFull = false;
        pendingMarker = false;
        state.update((value) => ({ ...value, state: 'writing', error: null }));
        try {
          if (full) {
            const writtenRevision = await writeFullSnapshot();
            snapshotDirty = writtenRevision !== dirtyRevision;
            if (snapshotDirty) {
              clearFullTimers();
              pendingFull = true;
              continue;
            }
          } else {
            await writeMarker();
          }
          setReady();
        } catch (error) {
          if (full) snapshotDirty = true;
          pendingFull = false;
          pendingMarker = false;
          state.update((value) => ({ ...value, state: 'error', error: stateError(error) }));
          break;
        }
      }
    })().finally(() => {
      draining = false;
      if (root && (pendingFull || pendingMarker)) return drain();
    });
    return drainPromise;
  }

  function scheduleFull() {
    if (!root || suppressSchedule || stopping) return;
    snapshotDirty = true;
    dirtyRevision++;
    scheduleFullRetry();
  }

  function scheduleFullRetry() {
    if (!root || suppressSchedule || stopping) return;
    if (fullTimer != null) clearTimeoutFn(fullTimer);
    fullTimer = setTimeoutFn(() => {
      clearFullTimers();
      pendingFull = true;
      return drain();
    }, WRITE_DELAY_MS);
    if (fullMaxTimer == null) {
      fullMaxTimer = setTimeoutFn(() => {
        clearFullTimers();
        pendingFull = true;
        return drain();
      }, PREVIEW_WRITE_MAX_DELAY_MS);
    }
  }

  function scheduleMarker() {
    if (!root || stopping) return;
    if (snapshotDirty || !currentPath) {
      scheduleFullRetry();
      return;
    }
    if (markerTimer != null) clearTimeoutFn(markerTimer);
    markerTimer = setTimeoutFn(() => {
      markerTimer = null;
      pendingMarker = true;
      drain();
    }, MARKER_DELAY_MS);
  }

  async function flushProject() {
    clearFullTimers();
    if (!snapshotDirty) {
      snapshotDirty = true;
      dirtyRevision++;
    }
    pendingFull = true;
    return drain();
  }

  async function flushMarker() {
    if (snapshotDirty || !currentPath) return flushProject();
    if (markerTimer != null) clearTimeoutFn(markerTimer);
    markerTimer = null;
    pendingMarker = true;
    return drain();
  }

  async function useWatchFolder(handle, isCurrent = () => true) {
    stopping = true;
    clearScheduledWrites();
    await drainPromise;
    if (!isCurrent()) {
      stopping = false;
      return false;
    }
    if (root) await cleanSession(root, currentPath);
    if (!isCurrent()) {
      stopping = false;
      return false;
    }
    root = handle;
    currentPath = null;
    lastContents = null;
    snapshotDirty = false;
    stopping = false;
    state.set({ state: 'ready', name: handle.name || 'watch folder', error: null });
    scheduleFull();
    return true;
  }

  function start() {
    if (started) return stop;
    started = true;
    stopping = false;
    const unsubscribeFrame = activeStore.subscribe(scheduleMarker);
    unsubscribers = [
      unsubscribeFrame,
      ...contentStores.map((store) => store.subscribe(scheduleFull)),
    ];
    heartbeatTimer = setIntervalFn(scheduleMarker, heartbeatMs);
    if (root) scheduleFull();
    return stop;
  }

  async function stop() {
    if (!started && !root) return;
    started = false;
    stopping = true;
    clearScheduledWrites();
    if (heartbeatTimer != null) clearIntervalFn(heartbeatTimer);
    heartbeatTimer = null;
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers = [];
    await drainPromise;

    const stoppedRoot = root;
    root = null;
    await cleanSession(stoppedRoot, currentPath);
    currentPath = null;
    lastContents = null;
    snapshotDirty = false;
    stopping = false;
    state.update((value) => ({ ...value, state: 'off', error: null }));
  }

  async function disconnect() {
    stopping = true;
    clearScheduledWrites();
    await drainPromise;
    const disconnectedRoot = root;
    const disconnectedPath = currentPath;
    root = null;
    currentPath = null;
    lastContents = null;
    snapshotDirty = false;
    await cleanSession(disconnectedRoot, disconnectedPath);
    stopping = false;
    state.set({ state: 'off', name: null, error: null });
  }

  return {
    sessionId,
    state,
    start,
    stop,
    disconnect,
    useWatchFolder,
    scheduleFull,
    scheduleMarker,
    flushProject,
    flushMarker,
    get currentPath() { return currentPath; },
  };
}

async function storedHandle() {
  if (typeof indexedDB === 'undefined') return null;
  const database = await openPainttyDatabase();
  try {
    let handle = null;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(DB_STORE, 'readonly');
      const request = transaction.objectStore(DB_STORE).get(DB_KEY);
      request.onsuccess = () => { handle = request.result || null; };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return handle;
  } finally {
    database.close();
  }
}

async function storeHandle(handle) {
  if (typeof indexedDB === 'undefined') return;
  const database = await openPainttyDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(DB_STORE, 'readwrite');
      transaction.objectStore(DB_STORE).put(handle, DB_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function clearStoredHandle() {
  if (typeof indexedDB === 'undefined') return;
  const database = await openPainttyDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(DB_STORE, 'readwrite');
      transaction.objectStore(DB_STORE).delete(DB_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export const watchFolderState = writable({ state: 'off', name: null, error: null });
const previewSync = createPreviewSync({
  sessionId: previewSessionId,
  stateStore: watchFolderState,
});
let restoreGeneration = 0;

async function restoreWatchFolder(generation) {
  try {
    const handle = await storedHandle();
    if (!handle || generation !== restoreGeneration) return;
    const permission = await handle.queryPermission({ mode: 'readwrite' });
    if (generation !== restoreGeneration) return;
    if (permission !== 'granted') {
      watchFolderState.set({ state: 'off', name: handle.name, error: null });
      return;
    }
    await previewSync.useWatchFolder(handle, () => generation === restoreGeneration);
  } catch (error) {
    if (generation !== restoreGeneration) return;
    watchFolderState.set({ state: 'error', name: null, error: stateError(error) });
  }
}

export async function chooseWatchFolder() {
  if (typeof window === 'undefined' || !window.showDirectoryPicker) {
    throw new Error('Watch folders require Chrome or Edge folder access.');
  }
  const lifecycle = restoreGeneration;
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  if (lifecycle !== restoreGeneration) return;
  const generation = ++restoreGeneration;
  await storeHandle(handle);
  if (generation !== restoreGeneration) return;
  await previewSync.useWatchFolder(handle, () => generation === restoreGeneration);
}

export async function disconnectWatchFolder() {
  restoreGeneration++;
  await previewSync.disconnect();
  await clearStoredHandle();
}

export function schedulePreview() {
  previewSync.scheduleFull();
}

export function retryPreviewSync() {
  return previewSync.flushProject();
}

export function startPreviewSync() {
  const stop = previewSync.start();
  const generation = ++restoreGeneration;
  restoreWatchFolder(generation);
  return () => {
    restoreGeneration++;
    return stop();
  };
}
