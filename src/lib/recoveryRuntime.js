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

export const recoveryState = writable({ state: 'idle', recoveredAt: null, error: null });
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

export function recoveryNoticeTransition(previous, recovery) {
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

function recoveryContentKey(contents) {
  const project = JSON.parse(contents);
  const stacks = [project.layers, project.timeline?.layers];
  for (const stack of stacks) {
    if (!Array.isArray(stack)) continue;
    for (const layer of stack) {
      if (layer?.type === 'group') delete layer.collapsed;
    }
  }
  return JSON.stringify(project);
}

function newRecoverySessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function browserGlobal(name) {
  try { return globalThis[name] ?? null; } catch { return null; }
}

function defaultRecoveryChannel() {
  const Channel = globalThis.BroadcastChannel;
  if (typeof globalThis.document === 'undefined' || typeof Channel !== 'function') return null;
  try { return new Channel(RECOVERY_CHANNEL_NAME); } catch { return null; }
}

async function createRecoveryPresence(channel, options = {}) {
  const known = new Map();
  const now = options.now || (() => Date.now());
  const delay = options.delay || ((callback, ms) => setTimeout(callback, ms));
  const repeat = options.repeat || ((callback, ms) => setInterval(callback, ms));
  const cancelRepeat = options.cancelRepeat || ((timer) => clearInterval(timer));
  const waitMs = options.waitMs ?? RECOVERY_PRESENCE_WAIT_MS;
  let sessionId = null;
  let heartbeat = null;
  let closed = false;

  function post(message) {
    if (closed || !channel?.postMessage) return;
    try { channel.postMessage(message); } catch {}
  }

  function announce(type = 'presence', nonce = null) {
    if (!sessionId) return;
    post({ type, nonce, sessionId });
  }

  function onMessage(event) {
    const message = event?.data;
    const otherId = String(message?.sessionId || '');
    if (message?.type === 'probe') {
      announce('presence', message.nonce || null);
    } else if (message?.type === 'presence' || message?.type === 'hello') {
      if (otherId && otherId !== sessionId) known.set(otherId, now());
    } else if (message?.type === 'goodbye' && otherId) {
      known.delete(otherId);
    }
  }

  if (channel?.addEventListener && channel?.postMessage) {
    channel.addEventListener('message', onMessage);
    post({ type: 'probe', nonce: newRecoverySessionId() });
    await new Promise((resolve) => delay(resolve, waitMs));
  }

  return {
    setSession(id) {
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

function isReloadNavigation() {
  try {
    return globalThis.performance?.getEntriesByType?.('navigation')
      ?.some((entry) => entry.type === 'reload') || false;
  } catch {
    return false;
  }
}

function createSharedRecoveryPresence(storage, options = {}) {
  const now = options.now || (() => Date.now());
  const delay = options.delay || ((callback, ms) => setTimeout(callback, ms));
  const repeat = options.repeat || ((callback, ms) => setInterval(callback, ms));
  const cancelRepeat = options.cancelRepeat || ((timer) => clearInterval(timer));
  const maxAge = options.maxAge ?? RECOVERY_HEARTBEAT_MAX_AGE_MS;
  const interval = options.interval ?? RECOVERY_HEARTBEAT_INTERVAL_MS;
  const token = newRecoverySessionId();
  let sessionId = null;
  let heartbeat = null;
  let closed = false;

  function key(id) {
    return RECOVERY_HEARTBEAT_PREFIX + id;
  }

  function read(id) {
    try {
      const record = JSON.parse(storage?.getItem?.(key(id)) || 'null');
      return record && typeof record === 'object' ? record : null;
    } catch {
      return null;
    }
  }

  function write() {
    if (closed || !sessionId) return;
    try {
      storage?.setItem?.(key(sessionId), JSON.stringify({ token, seenAt: now() }));
    } catch {}
  }

  function remove() {
    if (!sessionId) return;
    try {
      if (read(sessionId)?.token === token) storage?.removeItem?.(key(sessionId));
    } catch {}
  }

  function listActive() {
    const active = [];
    const cutoff = now() - maxAge;
    try {
      for (let index = Number(storage?.length || 0) - 1; index >= 0; index--) {
        const itemKey = storage.key(index);
        if (!itemKey?.startsWith(RECOVERY_HEARTBEAT_PREFIX)) continue;
        const id = itemKey.slice(RECOVERY_HEARTBEAT_PREFIX.length);
        const record = read(id);
        if (Number(record?.seenAt) >= cutoff) active.push(id);
        else storage.removeItem(itemKey);
      }
    } catch {
      return [];
    }
    return active;
  }

  return {
    async settle(exemptId = null) {
      const first = listActive();
      if (!first.some((id) => id !== exemptId)) return first;
      await new Promise((resolve) => delay(resolve, maxAge + interval));
      return listActive();
    },
    setSession(id) {
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

async function activeRecoverySessions(locks) {
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
async function holdRecoverySession(locks, sessionId, wait = false) {
  if (!locks?.request) return { coordinated: false, release() {} };
  let signalAcquired;
  let releaseHold;
  const acquired = new Promise((resolve) => { signalAcquired = resolve; });
  const hold = new Promise((resolve) => { releaseHold = resolve; });
  try {
    const request = locks.request(
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

function readStoredSession(storage, history) {
  try {
    const stored = storage?.getItem(RECOVERY_SESSION_KEY);
    if (stored) return stored;
  } catch {}
  try { return history?.state?.[RECOVERY_HISTORY_STATE_KEY] || null; } catch { return null; }
}

function writeStoredSession(storage, history, sessionId) {
  try { storage?.setItem(RECOVERY_SESSION_KEY, sessionId); } catch {}
  try {
    const state = history?.state;
    const current = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    history?.replaceState?.({ ...current, [RECOVERY_HISTORY_STATE_KEY]: sessionId }, '');
  } catch {}
}

export async function createBrowserRecoverySession(options = {}) {
  const storage = options.storage === undefined ? browserGlobal('sessionStorage') : options.storage;
  const locks = options.locks === undefined ? browserGlobal('navigator')?.locks : options.locks;
  const makeId = options.makeId || newRecoverySessionId;
  const ownerId = String(options.ownerId || newRecoverySessionId());
  const claimSession = options.claimSession;
  const history = options.history === undefined ? browserGlobal('history') : options.history;
  const delay = options.delay || ((callback, ms) => setTimeout(callback, ms));
  const claimDelay = options.claimDelay || delay;
  const claimRetryInterval = options.claimRetryInterval ?? RECOVERY_CLAIM_RETRY_INTERVAL_MS;
  const channel = options.channel === undefined ? defaultRecoveryChannel() : options.channel;
  const sharedStorage = options.sharedStorage === undefined
    ? (typeof globalThis.document === 'undefined' ? null : browserGlobal('localStorage'))
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

  let ownerEpoch = null;
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
        await new Promise((resolve) => claimDelay(resolve, Math.max(0, claimRetryInterval)));
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

function captureEditorContext() {
  const activeId = get(activeLayerId);
  const selectedIds = get(selectedLayerIds);
  return {
    activeLayerId: activeId,
    activeLayerPart: get(activeLayerPart),
    selectedLayerIds: [...selectedIds],
    recentProjectId: get(recentProjectIdentity),
  };
}

function applyEditorContext(context) {
  recentProjectIdentity.set(context?.recentProjectId || null);
  const currentLayers = get(layers);
  if (!currentLayers.length) {
    activeLayerId.set(null);
    activeLayerPart.set('layer');
    selectedLayerIds.set(new Set());
    return;
  }
  const active = currentLayers.find((layer) => layer.id === context?.activeLayerId) ||
    currentLayers.find((layer) => layer.id === get(activeLayerId)) || currentLayers[0];
  activeLayerId.set(active.id);
  activeLayerPart.set(context?.activeLayerPart === 'mask' && active.type === 'effect' && active.mask
    ? 'mask'
    : 'layer');
  const selectedIds = Array.isArray(context?.selectedLayerIds)
    ? context.selectedLayerIds
    : [];
  const available = new Set(currentLayers.map((layer) => layer.id));
  const selected = new Set(selectedIds.filter((id) => available.has(id)));
  selectedLayerIds.set(selected.size ? selected : new Set([active.id]));
}

function applyProject(contents, snapshot) {
  loadJSON(contents);
  fileName.set(String(snapshot.fileName || 'untitled'));
  const lastFrame = Math.max(0, get(frames).length - 1);
  gotoFrame(Math.min(lastFrame, Math.max(0, Math.trunc(Number(snapshot.activeFrame) || 0))));
  applyEditorContext(snapshot.context);
}

// Recovery replacement is transactional at the editor boundary: malformed snapshots
// restore the prior project, context, frame, and dirty state.
export function restoreProject(contents, snapshot) {
  const previous = {
    contents: serializeJSON(),
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

export async function startBrowserRecovery() {
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
    serialize: serializeJSON,
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
  const stopCheckpoint = onProjectCheckpoint(({ contents, fileName: checkpointName }) => (
    controller.checkpoint(contents, checkpointName)
  ));
  const stopSaved = onProjectSaved(({
    contents, currentContents, fileName: savedName,
  }) => controller.markSaved(contents, savedName, currentContents));
  const stopLoaded = onProjectLoaded(({ contents, fileName: loadedName }) => {
    controller.markLoaded(contents, loadedName);
  });
  const stopReverted = registerAuthoredContentRevertedHandler(controller.refreshDirty);
  const flushWhenHidden = () => {
    if (document.visibilityState === 'hidden') controller.flush();
  };
  let stopPromise = null;
  const stopRecovery = () => {
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
  const flushOnPageHide = (event) => {
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
