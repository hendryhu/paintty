import { get, writable } from 'svelte/store';
import {
  activeLayerId, activeLayerPart, authoredRevision, dims, layerPanelRevision, layers,
  registerAuthoredContentRevertedHandler, selectedLayerIds,
} from './grid.js';
import { dirty, fileName } from './stores.js';
import { activeFrameIndex, fps, frames, gotoFrame } from './frames.js';
import { loadJSON, serializeJSON, serializeRecoverySnapshot } from './fileio.js';
import { onProjectCheckpoint, onProjectLoaded, onProjectSaved } from './documentLifecycle.js';
import {
  claimIndexedDbRecoverySession,
  createIndexedDbRecoveryStorage,
  createRecoveryController,
  RECOVERY_SESSION_HEARTBEAT_INTERVAL_MS,
} from './recovery.js';
import { recentProjectIdentity } from './recentProjects.js';
import { notifyInfo } from './notifications.js';
import type { Writable } from 'svelte/store';
import type {
  ProjectCheckpointDetail,
  ProjectLayer,
  ProjectLoadedDetail,
  ProjectSavedDetail,
  StorageLike,
  TimerHandle,
  UnknownRecord,
} from './types/project-types.js';
import { isUnknownRecord } from './types/project-types.js';
import type { RecoveryClaim, RecoveryRecord, RecoveryState } from './recovery.js';

interface RecoveryNoticeState {
  settled: boolean;
  notified: boolean;
  notification: string | null;
}

interface RecoveryNoticeInput {
  state?: string;
  authored?: boolean;
}

interface RecoveryMessage {
  type: 'goodbye' | 'hello' | 'presence' | 'probe';
  nonce?: string | null;
  sessionId?: string;
}

interface RecoveryChannel {
  postMessage(message: RecoveryMessage): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  close(): void;
}

interface PresenceOptions {
  now?: (() => number) | undefined;
  delay?: ((callback: () => void, ms: number) => TimerHandle) | undefined;
  repeat?: ((callback: () => void, ms: number) => TimerHandle) | undefined;
  cancelRepeat?: ((timer: TimerHandle) => void) | undefined;
  waitMs?: number | undefined;
  maxAge?: number | undefined;
  interval?: number | undefined;
}

interface RecoveryPresence {
  setSession(id: string): void;
  listActive(): string[];
  close(): void;
}

interface SharedRecoveryPresence extends RecoveryPresence {
  settle(exemptId?: string | null): Promise<string[]>;
}

interface LockLike {
  name?: string;
}

interface LockManagerLike {
  query?(): Promise<{ held?: LockLike[] }>;
  request?(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: LockLike | null) => void | Promise<void>,
  ): Promise<unknown>;
}

interface HistoryLike {
  state?: unknown;
  replaceState?(data: unknown, unused: string): void;
}

interface BrowserRecoverySessionOptions extends PresenceOptions {
  storage?: StorageLike | null;
  locks?: LockManagerLike | null;
  makeId?: () => string;
  ownerId?: string;
  claimSession?: (options: {
    sessionId: string;
    ownerId: string;
    serializedHandoff?: boolean;
    adoptAbandoned: boolean;
    activeSessionIds: string[];
  }) => Promise<RecoveryClaim>;
  history?: HistoryLike | null;
  claimDelay?: (callback: () => void, ms: number) => TimerHandle;
  claimRetryInterval?: number;
  channel?: RecoveryChannel | null;
  sharedStorage?: StorageLike | null;
  presenceWait?: number;
  heartbeatMaxAge?: number;
  heartbeatInterval?: number;
  reclaimStoredSession?: boolean;
}

interface EditorRecoveryContext {
  activeLayerId: string | null;
  activeLayerPart: unknown;
  selectedLayerIds: string[];
  recentProjectId: string | null;
}

interface RecoverySnapshotContext {
  fileName?: string;
  activeFrame?: number;
  context?: unknown;
}

interface RecoverySessionHold {
  coordinated: boolean;
  release: () => void;
}

function asStorage(value: unknown): StorageLike | null {
  return value !== null && typeof value === 'object' &&
    'getItem' in value && typeof value.getItem === 'function' &&
    'setItem' in value && typeof value.setItem === 'function'
    ? value as StorageLike
    : null;
}

function asLocks(value: unknown): LockManagerLike | null {
  if (value !== null && typeof value === 'object' && 'locks' in value) {
    return asLocks(value.locks);
  }
  return value !== null && typeof value === 'object' &&
    (('request' in value && typeof value.request === 'function') ||
      ('query' in value && typeof value.query === 'function'))
    ? value as LockManagerLike
    : null;
}

function asHistory(value: unknown): HistoryLike | null {
  return value !== null && typeof value === 'object' ? value as HistoryLike : null;
}

export const recoveryState = writable<RecoveryState>({ state: 'idle', recoveredAt: null, error: null });
const RECOVERY_NOTICE = 'Recovered unsaved project.';
const RECOVERY_SESSION_KEY = 'paintty-recovery-session';
const RECOVERY_LOCK_PREFIX = 'paintty-recovery:';
const RECOVERY_CHANNEL_NAME = 'paintty-recovery-sessions';
const RECOVERY_PRESENCE_WAIT_MS = 40;
const RECOVERY_PRESENCE_MAX_AGE_MS = 6000;
const RECOVERY_HEARTBEAT_PREFIX = 'paintty-recovery-active:';
const RECOVERY_HEARTBEAT_INTERVAL_MS = 250;
const RECOVERY_HEARTBEAT_MAX_AGE_MS = 1000;
const RECOVERY_CLAIM_RETRY_INTERVAL_MS = 50;
const RECOVERY_HISTORY_STATE_KEY = 'painttyRecoverySession';

export function recoveryNoticeTransition(
  previous: Partial<RecoveryNoticeState> | null | undefined,
  recovery: RecoveryNoticeInput | null | undefined,
): RecoveryNoticeState {
  const settled = previous?.settled === true;
  const notified = previous?.notified === true;
  if (settled) return { settled, notified, notification: null };

  const state = String(recovery?.state || '');
  if (state === 'restoring' || !['recovered', 'ready', 'idle', 'error'].includes(state)) {
    return { settled: false, notified, notification: null };
  }
  const shouldNotify = state === 'recovered' && recovery?.authored === true;
  return {
    settled: true,
    notified: notified || shouldNotify,
    notification: shouldNotify ? RECOVERY_NOTICE : null,
  };
}

function recoveryContentKey(contents: string): string {
  const parsed: unknown = JSON.parse(contents);
  if (!isUnknownRecord(parsed)) return JSON.stringify(parsed);
  const timeline = isUnknownRecord(parsed['timeline']) ? parsed['timeline'] : null;
  const stacks = [parsed['layers'], timeline?.['layers']];
  for (const stack of stacks) {
    if (!Array.isArray(stack)) continue;
    for (const layer of stack) {
      if (isUnknownRecord(layer) && layer['type'] === 'group') delete layer['collapsed'];
    }
  }
  return JSON.stringify(parsed);
}

function newRecoverySessionId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function browserGlobal(name: string): unknown {
  try { return Reflect.get(globalThis, name) ?? null; } catch { return null; }
}

function defaultRecoveryChannel(): RecoveryChannel | null {
  const Channel = globalThis.BroadcastChannel;
  if (typeof globalThis.document === 'undefined' || typeof Channel !== 'function') return null;
  try { return new Channel(RECOVERY_CHANNEL_NAME) as RecoveryChannel; } catch { return null; }
}

async function createRecoveryPresence(
  channel: RecoveryChannel | null,
  options: PresenceOptions = {},
): Promise<RecoveryPresence> {
  const known = new Map<string, number>();
  const now = options.now || (() => Date.now());
  const delay = options.delay || ((callback, ms) => setTimeout(callback, ms));
  const repeat = options.repeat || ((callback, ms) => setInterval(callback, ms));
  const cancelRepeat = options.cancelRepeat || ((timer) => clearInterval(timer));
  const waitMs = options.waitMs ?? RECOVERY_PRESENCE_WAIT_MS;
  let sessionId: string | null = null;
  let heartbeat: TimerHandle | null = null;
  let closed = false;

  function post(message: RecoveryMessage): void {
    if (closed || !channel?.postMessage) return;
    try { channel.postMessage(message); } catch {}
  }

  function announce(
    type: RecoveryMessage['type'] = 'presence',
    nonce: string | null = null,
  ): void {
    if (!sessionId) return;
    post({ type, nonce, sessionId });
  }

  function onMessage(event: MessageEvent<unknown>): void {
    const message = isUnknownRecord(event.data) ? event.data : {};
    const otherId = String(message['sessionId'] || '');
    if (message['type'] === 'probe') {
      announce('presence', typeof message['nonce'] === 'string' ? message['nonce'] : null);
    } else if (message['type'] === 'presence' || message['type'] === 'hello') {
      if (otherId && otherId !== sessionId) known.set(otherId, now());
    } else if (message['type'] === 'goodbye' && otherId) {
      known.delete(otherId);
    }
  }

  if (channel) {
    channel.addEventListener('message', onMessage);
    post({ type: 'probe', nonce: newRecoverySessionId() });
    await new Promise<void>((resolve) => delay(resolve, waitMs));
  }

  return {
    setSession(id: string) {
      sessionId = String(id);
      known.delete(sessionId);
      announce('hello');
      if (channel && heartbeat == null) {
        heartbeat = repeat(() => announce('hello'), RECOVERY_PRESENCE_MAX_AGE_MS / 3);
      }
    },
    listActive() {
      const cutoff = now() - RECOVERY_PRESENCE_MAX_AGE_MS;
      for (const [id, seenAt] of known) if (seenAt < cutoff) known.delete(id);
      return [...known.keys()];
    },
    close() {
      if (closed) return;
      announce('goodbye');
      closed = true;
      if (heartbeat != null) cancelRepeat(heartbeat);
      channel?.removeEventListener?.('message', onMessage);
      channel?.close?.();
    },
  };
}

function isReloadNavigation(): boolean {
  try {
    return globalThis.performance?.getEntriesByType?.('navigation')
      ?.some((entry) => (entry as PerformanceNavigationTiming).type === 'reload') || false;
  } catch {
    return false;
  }
}

function createSharedRecoveryPresence(
  storage: StorageLike | null,
  options: PresenceOptions = {},
): SharedRecoveryPresence {
  const now = options.now || (() => Date.now());
  const delay = options.delay || ((callback, ms) => setTimeout(callback, ms));
  const repeat = options.repeat || ((callback, ms) => setInterval(callback, ms));
  const cancelRepeat = options.cancelRepeat || ((timer) => clearInterval(timer));
  const maxAge = options.maxAge ?? RECOVERY_HEARTBEAT_MAX_AGE_MS;
  const interval = options.interval ?? RECOVERY_HEARTBEAT_INTERVAL_MS;
  const token = newRecoverySessionId();
  let sessionId: string | null = null;
  let heartbeat: TimerHandle | null = null;
  let closed = false;

  function key(id: string): string {
    return RECOVERY_HEARTBEAT_PREFIX + id;
  }

  function read(id: string): UnknownRecord | null {
    try {
      const record = JSON.parse(storage?.getItem?.(key(id)) || 'null');
      return record && typeof record === 'object' ? record : null;
    } catch {
      return null;
    }
  }

  function write(): void {
    if (closed || !sessionId) return;
    try {
      storage?.setItem?.(key(sessionId), JSON.stringify({ token, seenAt: now() }));
    } catch {}
  }

  function remove(): void {
    if (!sessionId) return;
    try {
      if (read(sessionId)?.['token'] === token) storage?.removeItem?.(key(sessionId));
    } catch {}
  }

  function listActive(): string[] {
    const active: string[] = [];
    const cutoff = now() - maxAge;
    const storageKey = storage?.key?.bind(storage);
    if (!storageKey) return [];
    try {
      for (let index = Number(storage?.length || 0) - 1; index >= 0; index--) {
        const itemKey = storageKey(index);
        if (!itemKey?.startsWith(RECOVERY_HEARTBEAT_PREFIX)) continue;
        const id = itemKey.slice(RECOVERY_HEARTBEAT_PREFIX.length);
        const record = read(id);
        if (Number(record?.['seenAt']) >= cutoff) active.push(id);
        else storage?.removeItem?.(itemKey);
      }
    } catch {
      return [];
    }
    return active;
  }

  return {
    async settle(exemptId: string | null = null) {
      const first = listActive();
      if (!first.some((id) => id !== exemptId)) return first;
      await new Promise<void>((resolve) => delay(resolve, maxAge + interval));
      return listActive();
    },
    setSession(id: string) {
      sessionId = String(id);
      write();
      if (storage && heartbeat == null) heartbeat = repeat(write, interval);
    },
    listActive,
    close() {
      if (closed) return;
      remove();
      closed = true;
      if (heartbeat != null) cancelRepeat(heartbeat);
    },
  };
}

async function activeRecoverySessions(locks: LockManagerLike | null): Promise<string[]> {
  if (!locks?.query) return [];
  try {
    const state = await locks.query();
    return (state.held || [])
      .map((lock) => String(lock.name || ''))
      .filter((name) => name.startsWith(RECOVERY_LOCK_PREFIX))
      .map((name) => name.slice(RECOVERY_LOCK_PREFIX.length));
  } catch {
    return [];
  }
}

// Web Lock acquisition and request completion are separate: the callback intentionally
// stays pending until the returned lifetime handle releases it.
async function holdRecoverySession(
  locks: LockManagerLike | null,
  sessionId: string,
  wait = false,
): Promise<RecoverySessionHold | null> {
  if (!locks?.request) return { coordinated: false, release() {} };
  const requestLock = locks.request.bind(locks);
  let signalAcquired!: (acquired: boolean) => void;
  let releaseHold!: () => void;
  const acquired = new Promise<boolean>((resolve) => { signalAcquired = resolve; });
  const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
  try {
    const request = requestLock(
      RECOVERY_LOCK_PREFIX + sessionId,
      wait ? { mode: 'exclusive' } : { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        signalAcquired(!!lock);
        if (lock) await hold;
      },
    );
    Promise.resolve(request).catch(() => signalAcquired(false));
  } catch {
    signalAcquired(false);
  }
  return await acquired ? { coordinated: true, release: releaseHold } : null;
}

function readStoredSession(storage: StorageLike | null, history: HistoryLike | null): string | null {
  try {
    const stored = storage?.getItem(RECOVERY_SESSION_KEY);
    if (stored) return stored;
  } catch {}
  try {
    const state = history?.state;
    return isUnknownRecord(state) && typeof state[RECOVERY_HISTORY_STATE_KEY] === 'string'
      ? state[RECOVERY_HISTORY_STATE_KEY]
      : null;
  } catch { return null; }
}

function writeStoredSession(
  storage: StorageLike | null,
  history: HistoryLike | null,
  sessionId: string,
): void {
  try { storage?.setItem(RECOVERY_SESSION_KEY, sessionId); } catch {}
  try {
    const state = history?.state;
    const current = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    history?.replaceState?.({ ...current, [RECOVERY_HISTORY_STATE_KEY]: sessionId }, '');
  } catch {}
}

export async function createBrowserRecoverySession(
  options: BrowserRecoverySessionOptions = {},
) {
  const storage = options.storage === undefined
    ? asStorage(browserGlobal('sessionStorage'))
    : options.storage;
  const locks = options.locks === undefined
    ? asLocks(browserGlobal('navigator'))
    : options.locks;
  const makeId = options.makeId || newRecoverySessionId;
  const ownerId = String(options.ownerId || newRecoverySessionId());
  const claimSession = options.claimSession;
  const history = options.history === undefined
    ? asHistory(browserGlobal('history'))
    : options.history;
  const delay = options.delay || ((callback, ms) => setTimeout(callback, ms));
  const claimDelay = options.claimDelay || delay;
  const claimRetryInterval = options.claimRetryInterval ?? RECOVERY_CLAIM_RETRY_INTERVAL_MS;
  const channel = options.channel === undefined ? defaultRecoveryChannel() : options.channel;
  const sharedStorage = options.sharedStorage === undefined
    ? (typeof globalThis.document === 'undefined' ? null : asStorage(browserGlobal('localStorage')))
    : options.sharedStorage;
  const presence = await createRecoveryPresence(channel, {
    waitMs: options.presenceWait,
    delay: options.delay,
    repeat: options.repeat,
    cancelRepeat: options.cancelRepeat,
    now: options.now,
  });
  const sharedPresence = createSharedRecoveryPresence(sharedStorage, {
    delay: options.delay,
    repeat: options.repeat,
    cancelRepeat: options.cancelRepeat,
    now: options.now,
    maxAge: options.heartbeatMaxAge,
    interval: options.heartbeatInterval,
  });
  const storedSession = readStoredSession(storage, history);
  const canReclaimStored = options.reclaimStoredSession ?? isReloadNavigation();
  const sharedActive = await sharedPresence.settle(canReclaimStored ? storedSession : null);
  const lockedSessionIds = await activeRecoverySessions(locks);
  const activeSessionIds = new Set([
    ...lockedSessionIds,
    ...presence.listActive(),
    ...sharedActive,
  ]);
  let sessionId = storedSession;
  if (!sessionId || (activeSessionIds.has(sessionId) && !canReclaimStored)) sessionId = makeId();
  const reclaimingStored = !!storedSession && sessionId === storedSession && canReclaimStored;
  let lockHold = await holdRecoverySession(locks, sessionId, reclaimingStored);
  if (!lockHold && !reclaimingStored) {
    activeSessionIds.add(sessionId);
    sessionId = makeId();
    lockHold = await holdRecoverySession(locks, sessionId);
  }
  if (!lockHold) lockHold = { coordinated: false, release() {} };
  const serializedHandoff = reclaimingStored
    && lockHold.coordinated;

  let ownerEpoch: number | null = null;
  try {
    if (claimSession) {
      let claim = await claimSession({
        sessionId,
        ownerId,
        serializedHandoff,
        adoptAbandoned: !storedSession,
        activeSessionIds: [...activeSessionIds],
      });
      // Reload may replace a live lease only while holding that session's exclusive Web Lock.
      while (!claim?.claimed && reclaimingStored) {
        await new Promise<void>((resolve) => claimDelay(resolve, Math.max(0, claimRetryInterval)));
        claim = await claimSession({
          sessionId,
          ownerId,
          adoptAbandoned: false,
          activeSessionIds: [...activeSessionIds],
        });
      }
      if (!claim?.claimed) {
        lockHold.release();
        activeSessionIds.add(sessionId);
        sessionId = makeId();
        lockHold = await holdRecoverySession(locks, sessionId)
          || { coordinated: false, release() {} };
        claim = await claimSession({
          sessionId,
          ownerId,
          adoptAbandoned: false,
          activeSessionIds: [...activeSessionIds],
        });
        if (!claim?.claimed) throw new Error('Could not claim an isolated recovery session.');
      }
      ownerEpoch = claim.ownerEpoch ?? null;
    }
  } catch (error) {
    lockHold.release();
    presence.close();
    sharedPresence.close();
    throw error;
  }
  writeStoredSession(storage, history, sessionId);
  activeSessionIds.delete(sessionId);
  presence.setSession(sessionId);
  sharedPresence.setSession(sessionId);
  let released = false;
  return {
    sessionId,
    ownerId,
    ownerEpoch,
    activeSessionIds: [...activeSessionIds],
    getActiveSessionIds: async () => [...new Set([
      ...await activeRecoverySessions(locks),
      ...presence.listActive(),
      ...sharedPresence.listActive(),
    ])].filter((activeId) => activeId !== sessionId),
    release() {
      if (released) return;
      released = true;
      lockHold.release();
      presence.close();
      sharedPresence.close();
    },
  };
}

function captureEditorContext(): EditorRecoveryContext {
  const activeId = get(activeLayerId);
  const selectedIds = get(selectedLayerIds);
  return {
    activeLayerId: activeId,
    activeLayerPart: get(activeLayerPart),
    selectedLayerIds: [...selectedIds],
    recentProjectId: get(recentProjectIdentity),
  };
}

function applyEditorContext(context: unknown): void {
  const value = isUnknownRecord(context) ? context : {};
  recentProjectIdentity.set(typeof value['recentProjectId'] === 'string'
    ? value['recentProjectId']
    : null);
  const currentLayers = get(layers) as ProjectLayer[];
  if (!currentLayers.length) {
    activeLayerId.set(null);
    activeLayerPart.set('layer');
    selectedLayerIds.set(new Set());
    return;
  }
  const active = currentLayers.find((layer) => layer.id === value['activeLayerId']) ||
    currentLayers.find((layer) => layer.id === get(activeLayerId)) || currentLayers[0]!;
  activeLayerId.set(active.id);
  activeLayerPart.set(value['activeLayerPart'] === 'mask' && active.type === 'effect' && active.mask
    ? 'mask'
    : value['activeLayerPart'] === 'content-mask' && active['contentMask']
      ? 'content-mask'
      : 'layer');
  const selectedIds = Array.isArray(value['selectedLayerIds'])
    ? value['selectedLayerIds'].filter((id): id is string => typeof id === 'string')
    : [];
  const available = new Set(currentLayers.map((layer) => layer.id));
  const selected = new Set(selectedIds.filter((id) => available.has(id)));
  selectedLayerIds.set(selected.size ? selected : new Set([active.id]));
}

function applyProject(contents: string, snapshot: RecoverySnapshotContext): void {
  loadJSON(contents);
  fileName.set(String(snapshot.fileName || 'untitled'));
  const lastFrame = Math.max(0, get(frames).length - 1);
  gotoFrame(Math.min(lastFrame, Math.max(0, Math.trunc(Number(snapshot.activeFrame) || 0))));
  applyEditorContext(snapshot.context);
}

// Recovery replacement is transactional at the editor boundary: malformed snapshots
// restore the prior project, context, frame, and dirty state.
export function restoreProject(contents: string, snapshot: RecoverySnapshotContext): void {
  const previous = {
    contents: serializeJSON(undefined),
    fileName: get(fileName),
    activeFrame: get(activeFrameIndex),
    dirty: get(dirty),
    context: captureEditorContext(),
  };
  try {
    applyProject(contents, snapshot);
  } catch (error) {
    applyProject(previous.contents, previous);
    dirty.set(previous.dirty);
    throw error;
  }
}

export async function startBrowserRecovery(): Promise<() => Promise<void>> {
  const session = await createBrowserRecoverySession({
    claimSession: claimIndexedDbRecoverySession,
  });
  const recoveryStorage = createIndexedDbRecoveryStorage({
    sessionId: session.sessionId,
    ownerId: session.ownerId,
    ownerEpoch: session.ownerEpoch,
    activeSessionIds: session.getActiveSessionIds,
  });
  const controller = createRecoveryController({
    storage: recoveryStorage,
    serialize: () => serializeJSON(undefined),
    serializeSnapshot: serializeRecoverySnapshot,
    contentKey: recoveryContentKey,
    restore: restoreProject,
    contentStores: [
      authoredRevision, dims, fps,
    ],
    contextStores: [
      fileName, activeFrameIndex, activeLayerId, activeLayerPart, selectedLayerIds,
      layerPanelRevision, recentProjectIdentity,
    ],
    captureContext: captureEditorContext,
    nameStore: fileName,
    activeFrameStore: activeFrameIndex,
    dirtyStore: dirty,
    stateStore: recoveryState,
  });

  const recovered = await controller.restoreLatest();
  const notice = recoveryNoticeTransition(null, {
    state: recovered ? 'recovered' : get(recoveryState).state,
    authored: !!recovered && !recovered.clean,
  });
  if (notice.notification) notifyInfo(notice.notification);
  const stopController = controller.start();
  const stopCheckpoint = onProjectCheckpoint(({
    contents,
    fileName: checkpointName,
  }: ProjectCheckpointDetail) => {
    return controller.checkpoint(contents, checkpointName).then(() => {});
  });
  const stopSaved = onProjectSaved(({
    contents, currentContents, fileName: savedName,
  }: ProjectSavedDetail) => {
    return controller.markSaved(contents, savedName, currentContents).then(() => {});
  });
  const stopLoaded = onProjectLoaded(({ contents, fileName: loadedName }: ProjectLoadedDetail) => {
    controller.markLoaded(contents, loadedName);
  });
  const stopReverted = registerAuthoredContentRevertedHandler(controller.refreshDirty);
  const flushWhenHidden = () => {
    if (document.visibilityState === 'hidden') controller.flush();
  };
  let stopPromise: Promise<void> | null = null;
  const stopRecovery = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopCheckpoint();
      stopSaved();
      stopLoaded();
      stopReverted();
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('pagehide', flushOnPageHide);
      try {
        await stopController();
      } finally {
        stopped = true;
        clearInterval(heartbeat);
        try {
          await recoveryStorage.release();
        } finally {
          session.release();
        }
      }
    })();
    return stopPromise;
  };
  const flushOnPageHide = (event: PageTransitionEvent): void => {
    if (event.persisted) controller.flush();
    else stopRecovery();
  };
  document.addEventListener('visibilitychange', flushWhenHidden);
  window.addEventListener('pagehide', flushOnPageHide);
  let stopped = false;
  const heartbeat = setInterval(() => {
    recoveryStorage.heartbeat().catch((error) => {
      if (stopped) return;
      recoveryState.set({
        state: 'error', recoveredAt: null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, RECOVERY_SESSION_HEARTBEAT_INTERVAL_MS);

  return stopRecovery;
}
