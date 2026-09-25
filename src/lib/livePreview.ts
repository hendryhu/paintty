import { get, writable } from 'svelte/store';
import type { Readable, Writable } from 'svelte/store';
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
import type {
  FileSystemDirectoryHandleLike,
  FileSystemFileHandleLike,
  TimerHandle,
  Unsubscribe,
} from './types/project-types.js';

interface PreviewSyncState {
  state: 'error' | 'off' | 'ready' | 'writing';
  name: string | null;
  error: string | null;
}

interface PreviewWriteOptions {
  sessionId?: string;
  playheadTick?: number;
  updatedAt?: number;
}

interface PreviewSyncOptions {
  sessionId?: string;
  stateStore?: Writable<PreviewSyncState>;
  nameStore?: Readable<string>;
  playheadStore?: Readable<number>;
  contentStores?: Readable<unknown>[];
  serialize?: () => string;
  now?: () => number;
  setTimeout?: (callback: () => void | Promise<void>, delay: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
  setInterval?: (callback: () => void, delay: number) => TimerHandle;
  clearInterval?: (timer: TimerHandle) => void;
  heartbeatMs?: number;
}

type ShowDirectoryPicker = (options: {
  mode: 'readwrite';
}) => Promise<FileSystemDirectoryHandleLike>;

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

function safeSegment(value: unknown, fallback: string, limit = 80): string {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, limit) || fallback;
}

export const previewSessionId = newSessionId();

export function previewPath(name: unknown, sessionId = previewSessionId): string {
  const stem = safeSegment(String(name || 'untitled').replace(/\.json$/i, ''), 'untitled');
  const id = safeSegment(sessionId, 'session', 64);
  return SCRATCH_DIR + '/' + SNAPSHOT_DIR + '/' + id + '-' + stem + '.json';
}

export function sessionMarkerPath(sessionId = previewSessionId): string {
  return SCRATCH_DIR + '/' + SESSION_DIR + '/' + safeSegment(sessionId, 'session', 64) + '.json';
}

function selectedTick(value: unknown): number {
  const tick = Number(value);
  return Number.isFinite(tick) ? Math.max(0, Math.trunc(tick)) : 0;
}

function unixMillis(value: unknown): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.trunc(timestamp)) : Date.now();
}

async function writeFile(handle: FileSystemFileHandleLike, contents: string): Promise<void> {
  const destination = await handle.createWritable();
  await destination.write(contents);
  await destination.close();
}

async function directoryAt(
  root: FileSystemDirectoryHandleLike,
  names: string[],
  create: boolean,
): Promise<FileSystemDirectoryHandleLike> {
  let directory = root;
  for (const name of names) directory = await directory.getDirectoryHandle(name, { create });
  return directory;
}

async function writePath(
  root: FileSystemDirectoryHandleLike,
  path: string,
  contents: string,
): Promise<void> {
  const parts = path.split('/');
  const name = parts.pop()!;
  const directory = await directoryAt(root, parts, true);
  const target = await directory.getFileHandle(name, { create: true });
  await writeFile(target, contents);
}

async function removePath(root: FileSystemDirectoryHandleLike, path: string): Promise<void> {
  const parts = path.split('/');
  const name = parts.pop()!;
  const directory = await directoryAt(root, parts, false);
  await directory.removeEntry(name);
}

async function pathExists(root: FileSystemDirectoryHandleLike, path: string): Promise<boolean> {
  try {
    const parts = path.split('/');
    const name = parts.pop()!;
    const directory = await directoryAt(root, parts, false);
    await directory.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function writeLegacyPointer(root: FileSystemDirectoryHandleLike, path: string): Promise<void> {
  const pointer = await root.getFileHandle('.opened', { create: true });
  await writeFile(pointer, path);
}

async function clearLegacyPointer(root: FileSystemDirectoryHandleLike, path: string): Promise<void> {
  try {
    const pointer = await root.getFileHandle('.opened');
    const file = await pointer.getFile();
    if ((await file.text()) === path) await root.removeEntry('.opened');
  } catch {
    // Another session may own the pointer, or the browser may already be closing.
  }
}

export async function writeSessionMarker(
  root: FileSystemDirectoryHandleLike,
  sessionId: string,
  path: string,
  playhead: unknown,
  updatedAt = Date.now(),
): Promise<string> {
  const marker = JSON.stringify({
    version: 2,
    path,
    playheadTick: selectedTick(playhead),
    updatedAt: unixMillis(updatedAt),
  });
  await writePath(root, sessionMarkerPath(sessionId), marker);
  return marker;
}

export async function writePreview(
  root: FileSystemDirectoryHandleLike,
  name: unknown,
  contents: string,
  options: PreviewWriteOptions = {},
): Promise<string> {
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

function stateError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPreviewSync(options: PreviewSyncOptions = {}) {
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

  let root: FileSystemDirectoryHandleLike | null = null;
  let currentPath: string | null = null;
  let lastContents: string | null = null;
  let fullTimer: TimerHandle | null = null;
  let fullMaxTimer: TimerHandle | null = null;
  let markerTimer: TimerHandle | null = null;
  let heartbeatTimer: TimerHandle | null = null;
  let pendingFull = false;
  let pendingMarker = false;
  let snapshotDirty = false;
  let dirtyRevision = 0;
  let draining = false;
  let drainPromise = Promise.resolve();
  let suppressSchedule = false;
  let started = false;
  let stopping = false;
  let unsubscribers: Unsubscribe[] = [];

  function clearFullTimers(): void {
    if (fullTimer != null) clearTimeoutFn(fullTimer);
    if (fullMaxTimer != null) clearTimeoutFn(fullMaxTimer);
    fullTimer = null;
    fullMaxTimer = null;
  }

  function clearScheduledWrites(): void {
    clearFullTimers();
    if (markerTimer != null) clearTimeoutFn(markerTimer);
    markerTimer = null;
    pendingFull = false;
    pendingMarker = false;
    snapshotDirty = false;
  }

  function setReady(): void {
    state.update((value) => ({ ...value, state: 'ready', error: null }));
  }

  async function removeOldSnapshot(
    path: string,
    fromRoot: FileSystemDirectoryHandleLike | null = root,
  ): Promise<void> {
    if (!fromRoot || !path) return;
    try { await removePath(fromRoot, path); } catch {}
  }

  async function cleanSession(
    fromRoot: FileSystemDirectoryHandleLike | null,
    path: string | null,
  ): Promise<void> {
    if (!fromRoot) return;
    try { await removePath(fromRoot, sessionMarkerPath(sessionId)); } catch {}
    if (path) await clearLegacyPointer(fromRoot, path);
    if (path) await removeOldSnapshot(path, fromRoot);
  }

  async function writeFullSnapshot(): Promise<number> {
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
      && !await pathExists(root!, nextPath);
    if (nextPath !== currentPath || contents !== lastContents || missing) {
      const oldPath = currentPath;
      await writePreview(root!, name, contents, {
        sessionId,
        playheadTick: frame,
        updatedAt: now(),
      });
      currentPath = nextPath;
      lastContents = contents;
      if (oldPath && oldPath !== nextPath) await removeOldSnapshot(oldPath);
    } else {
      await writeSessionMarker(root!, sessionId, currentPath!, frame, now());
      await writeLegacyPointer(root!, currentPath!);
    }
    return revision;
  }

  async function writeMarker(): Promise<void> {
    if (!currentPath) {
      pendingFull = true;
      return;
    }
    if (!await pathExists(root!, currentPath)) {
      snapshotDirty = true;
      pendingFull = true;
      return;
    }
    await writeSessionMarker(root!, sessionId, currentPath, get(activeStore), now());
    await writeLegacyPointer(root!, currentPath);
  }

  // A single drain serializes marker and snapshot writes; dirtyRevision schedules
  // another full write when state changes during an in-flight snapshot.
  function drain(): Promise<void> {
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

  function scheduleFull(): void {
    if (!root || suppressSchedule || stopping) return;
    snapshotDirty = true;
    dirtyRevision++;
    scheduleFullRetry();
  }

  function scheduleFullRetry(): void {
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

  function scheduleMarker(): void {
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

  async function flushProject(): Promise<void> {
    clearFullTimers();
    if (!snapshotDirty) {
      snapshotDirty = true;
      dirtyRevision++;
    }
    pendingFull = true;
    return drain();
  }

  async function flushMarker(): Promise<void> {
    if (snapshotDirty || !currentPath) return flushProject();
    if (markerTimer != null) clearTimeoutFn(markerTimer);
    markerTimer = null;
    pendingMarker = true;
    return drain();
  }

  async function useWatchFolder(
    handle: FileSystemDirectoryHandleLike,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
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

  function start(): () => Promise<void> {
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

  async function stop(): Promise<void> {
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

  async function disconnect(): Promise<void> {
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

function isDirectoryHandle(value: unknown): value is FileSystemDirectoryHandleLike {
  return value !== null && typeof value === 'object' &&
    'name' in value && typeof value.name === 'string' &&
    'getDirectoryHandle' in value && typeof value.getDirectoryHandle === 'function' &&
    'getFileHandle' in value && typeof value.getFileHandle === 'function' &&
    'removeEntry' in value && typeof value.removeEntry === 'function' &&
    'queryPermission' in value && typeof value.queryPermission === 'function';
}

async function storedHandle(): Promise<FileSystemDirectoryHandleLike | null> {
  if (typeof indexedDB === 'undefined') return null;
  const database = await openPainttyDatabase();
  try {
    let handle: FileSystemDirectoryHandleLike | null = null;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(DB_STORE, 'readonly');
      const request = transaction.objectStore(DB_STORE).get(DB_KEY);
      request.onsuccess = () => {
        handle = isDirectoryHandle(request.result) ? request.result : null;
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return handle;
  } finally {
    database.close();
  }
}

async function storeHandle(handle: FileSystemDirectoryHandleLike): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const database = await openPainttyDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(DB_STORE, 'readwrite');
      transaction.objectStore(DB_STORE).put(handle, DB_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function clearStoredHandle(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const database = await openPainttyDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(DB_STORE, 'readwrite');
      transaction.objectStore(DB_STORE).delete(DB_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export const watchFolderState = writable<PreviewSyncState>({ state: 'off', name: null, error: null });
const previewSync = createPreviewSync({
  sessionId: previewSessionId,
  stateStore: watchFolderState,
});
let restoreGeneration = 0;

async function restoreWatchFolder(generation: number): Promise<void> {
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
  const browserWindow = typeof window === 'undefined'
    ? null
    : window as Window & { showDirectoryPicker?: ShowDirectoryPicker };
  if (!browserWindow?.showDirectoryPicker) {
    throw new Error('Watch folders require Chrome or Edge folder access.');
  }
  const lifecycle = restoreGeneration;
  const handle = await browserWindow.showDirectoryPicker({ mode: 'readwrite' });
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
