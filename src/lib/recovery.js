import { get, writable } from 'svelte/store';
import {
  openPainttyDatabase,
  RECOVERY_SNAPSHOT_STORE,
} from './browserDb.js';
import { scheduleMediaCacheGc } from './mediaGc.js';

export const RECOVERY_SNAPSHOT_LIMIT = 3;
export const RECOVERY_WRITE_DELAY_MS = 500;
export const RECOVERY_MAX_WRITE_DELAY_MS = 2000;
export const RECOVERY_SESSION_HEARTBEAT_INTERVAL_MS = 1000;
export const RECOVERY_SESSION_MAX_AGE_MS = 6000;

const RECOVERY_SESSION_RECORD_PREFIX = 'paintty-recovery-session:';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function snapshotId(now) {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return now.toString(36) + '-' + Math.random().toString(36).slice(2);
}

function recoveryTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? Math.trunc(timestamp) : 0;
}

function recoverySessionRecordId(sessionId) {
  return RECOVERY_SESSION_RECORD_PREFIX + sessionId;
}

function isRecoverySessionRecord(record) {
  return record?.type === 'session' && record?.id === recoverySessionRecordId(record.sessionId);
}

function recoverySessionSeenAt(record) {
  return Math.max(
    recoveryTimestamp(record?.heartbeatAt),
    recoveryTimestamp(record?.observedAt),
  );
}

function recoverySessionEpoch(record) {
  const epoch = Number(record?.ownerEpoch);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : 0;
}

function recoverySessionLeaseUntil(record) {
  return recoveryTimestamp(record?.leaseUntil);
}

function hasLiveRecoverySessionOwner(record, timestamp) {
  return isRecoverySessionRecord(record)
    && !!String(record.ownerId || '')
    && recoverySessionLeaseUntil(record) > timestamp;
}

function upsertRecord(records, record) {
  const index = records.findIndex((candidate) => candidate.id === record.id);
  if (index < 0) records.push(record);
  else records[index] = record;
}

function activeRecoverySessionIds(records, timestamp, maxAge) {
  const cutoff = timestamp - maxAge;
  return new Set(records
    .filter((record) => isRecoverySessionRecord(record) && (
      hasLiveRecoverySessionOwner(record, timestamp)
        || (record.released !== true && recoverySessionSeenAt(record) > cutoff)
    ))
    .map((record) => String(record.sessionId)));
}

function observeRecoverySessions(store, records, sessionIds, timestamp) {
  for (const sessionId of sessionIds) {
    const id = String(sessionId || '');
    if (!id) continue;
    const recordId = recoverySessionRecordId(id);
    const current = records.find((record) => record.id === recordId);
    const observed = {
      ...(isRecoverySessionRecord(current) ? current : {
        id: recordId,
        type: 'session',
        sessionId: id,
        ownerId: null,
        ownerEpoch: 0,
        heartbeatAt: 0,
        leaseUntil: 0,
      }),
      observedAt: timestamp,
      released: false,
    };
    store.put(observed);
    upsertRecord(records, observed);
  }
}

async function withRecoveryRecords(openDatabase, storeName, mode, operation) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const request = store.getAll();
      let result;
      let operationError = null;
      transaction.oncomplete = () => {
        if (operationError) reject(operationError);
        else resolve(result);
      };
      transaction.onerror = () => reject(
        transaction.error || new Error('IndexedDB transaction failed.'),
      );
      transaction.onabort = () => reject(
        operationError || transaction.error || new Error('IndexedDB transaction was aborted.'),
      );
      request.onerror = () => reject(request.error || new Error('Could not read recovery snapshots.'));
      request.onsuccess = () => {
        try {
          result = operation(store, request.result || []);
        } catch (error) {
          operationError = error;
          try { transaction.abort(); } catch { reject(error); }
        }
      };
    });
  } finally {
    database.close();
  }
}

export function newestRecoveryRecords(records, limit = RECOVERY_SNAPSHOT_LIMIT) {
  return [...records]
    .sort((a, b) => {
      const aCreatedAt = Number.isFinite(Number(a?.createdAt)) ? Number(a.createdAt) : 0;
      const bCreatedAt = Number.isFinite(Number(b?.createdAt)) ? Number(b.createdAt) : 0;
      return bCreatedAt - aCreatedAt || String(b.id).localeCompare(String(a.id));
    })
    .slice(0, Math.max(1, limit));
}

function recoverySession(record) {
  return String(record?.sessionId || 'legacy');
}

export function recoveryRecordsForSession(records, sessionId) {
  const snapshots = records.filter((record) => record?.project != null);
  const own = snapshots.filter((record) => recoverySession(record) === sessionId);
  return newestRecoveryRecords(own, Number.POSITIVE_INFINITY);
}

export function recoveryRecordIdsToKeep(
  records,
  sessionId,
  activeSessionIds = [],
  limit = RECOVERY_SNAPSHOT_LIMIT,
  historyLimit = RECOVERY_SNAPSHOT_LIMIT * 3,
) {
  const snapshots = records.filter((record) => record?.project != null);
  const protectedSessions = new Set([sessionId, ...activeSessionIds]);
  const keep = new Set();
  for (const protectedSession of protectedSessions) {
    const scoped = snapshots.filter((record) => recoverySession(record) === protectedSession);
    for (const record of newestRecoveryRecords(scoped, limit)) keep.add(record.id);
  }
  const history = snapshots.filter((record) => !protectedSessions.has(recoverySession(record)));
  for (const record of newestRecoveryRecords(history, historyLimit)) keep.add(record.id);
  return keep;
}

// A live lease changes epoch only after release/expiry or a serialized same-session lock handoff.
export function claimIndexedDbRecoverySession(options = {}) {
  const openDatabase = options.openDatabase || openPainttyDatabase;
  const storeName = options.storeName || RECOVERY_SNAPSHOT_STORE;
  const sessionId = String(options.sessionId || '');
  const ownerId = String(options.ownerId || '');
  const now = options.now || (() => Date.now());
  const maxAge = options.maxAge ?? RECOVERY_SESSION_MAX_AGE_MS;
  const observedSessionIds = [...(options.activeSessionIds || [])]
    .map((id) => String(id))
    .filter((id) => id && id !== sessionId);
  if (!sessionId || !ownerId) throw new Error('Recovery session identity is required.');

  return withRecoveryRecords(openDatabase, storeName, 'readwrite', (store, records) => {
    const timestamp = recoveryTimestamp(now());
    const working = [...records];
    observeRecoverySessions(store, working, observedSessionIds, timestamp);
    const active = activeRecoverySessionIds(working, timestamp, maxAge);
    const current = working.find((record) => record.id === recoverySessionRecordId(sessionId));
    const currentOwnerId = String(current?.ownerId || '');
    const claimedByOther = hasLiveRecoverySessionOwner(current, timestamp)
      && currentOwnerId !== ownerId;
    if (claimedByOther && !options.serializedHandoff) {
      return {
        claimed: false,
        sessionId,
        ownerEpoch: null,
        retryAt: recoverySessionLeaseUntil(current),
        adoptedSessionId: null,
      };
    }

    const sameOwner = currentOwnerId === ownerId && recoverySessionEpoch(current) > 0;
    const ownerEpoch = recoverySessionEpoch(current) + (sameOwner ? 0 : 1);
    const claim = {
      id: recoverySessionRecordId(sessionId),
      type: 'session',
      sessionId,
      ownerId,
      ownerEpoch,
      heartbeatAt: timestamp,
      observedAt: timestamp,
      leaseUntil: timestamp + maxAge,
      released: false,
    };
    store.put(claim);
    upsertRecord(working, claim);
    active.add(sessionId);

    let adoptedSessionId = null;
    const ownSnapshots = working.some((record) => (
      record?.project != null && recoverySession(record) === sessionId
    ));
    if (options.adoptAbandoned && !ownSnapshots) {
      // Adoption shares the successful claim transaction, so only a lineage without a live
      // owner can move; an outgoing owner's final write commits first or is rejected as stale.
      const abandoned = newestRecoveryRecords(
        working.filter((record) => (
          record?.project != null && !active.has(recoverySession(record))
        )),
        Number.POSITIVE_INFINITY,
      );
      adoptedSessionId = abandoned.length ? recoverySession(abandoned[0]) : null;
      if (adoptedSessionId) {
        for (const record of working) {
          if (record?.project != null && recoverySession(record) === adoptedSessionId) {
            store.put({ ...record, sessionId });
          }
        }
        const abandonedClaimId = recoverySessionRecordId(adoptedSessionId);
        if (abandonedClaimId !== claim.id) store.delete(abandonedClaimId);
      }
    }

    return { claimed: true, sessionId, ownerEpoch, retryAt: null, adoptedSessionId };
  });
}

export function createIndexedDbRecoveryStorage(options = {}) {
  const openDatabase = options.openDatabase || openPainttyDatabase;
  const storeName = options.storeName || RECOVERY_SNAPSHOT_STORE;
  const sessionId = String(options.sessionId || 'default');
  const ownerId = String(options.ownerId || '');
  const ownerEpoch = Math.trunc(Number(options.ownerEpoch));
  const activeSessionIds = options.activeSessionIds || [];
  const historyLimit = options.historyLimit ?? RECOVERY_SNAPSHOT_LIMIT * 3;
  const now = options.now || (() => Date.now());
  const maxAge = options.maxAge ?? RECOVERY_SESSION_MAX_AGE_MS;
  if (!ownerId || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) {
    throw new Error('Recovery session owner and epoch are required.');
  }

  async function currentActiveSessionIds() {
    const value = typeof activeSessionIds === 'function'
      ? await activeSessionIds()
      : activeSessionIds;
    return [...(value || [])]
      .map((id) => String(id))
      .filter((id) => id !== sessionId);
  }

  // Heartbeats and writes verify owner plus epoch in the same transaction, preventing
  // a stale tab from extending or overwriting a handed-off lineage.
  async function withOwnedSession(operation) {
    const observedSessionIds = await currentActiveSessionIds();
    return withRecoveryRecords(openDatabase, storeName, 'readwrite', (store, records) => {
      const timestamp = recoveryTimestamp(now());
      const working = [...records];
      const current = working.find((record) => record.id === recoverySessionRecordId(sessionId));
      if (!isRecoverySessionRecord(current)
        || String(current.ownerId || '') !== ownerId
        || recoverySessionEpoch(current) !== ownerEpoch) {
        throw new Error('Recovery session is no longer owned by this tab.');
      }
      observeRecoverySessions(store, working, observedSessionIds, timestamp);
      const heartbeat = {
        ...current,
        heartbeatAt: timestamp,
        observedAt: timestamp,
        leaseUntil: timestamp + maxAge,
        released: false,
      };
      store.put(heartbeat);
      upsertRecord(working, heartbeat);
      return operation(store, working, timestamp);
    });
  }

  return {
    async listNewest() {
      return withOwnedSession((store, records) => (
        recoveryRecordsForSession(records, sessionId)
      ));
    },

    async putAndPrune(record, limit = RECOVERY_SNAPSHOT_LIMIT) {
      await withOwnedSession((store, records, timestamp) => {
        const snapshot = { ...record, sessionId };
        store.put(snapshot);
        upsertRecord(records, snapshot);
        const active = activeRecoverySessionIds(records, timestamp, maxAge);
        const keep = recoveryRecordIdsToKeep(
          records,
          sessionId,
          active,
          limit,
          historyLimit,
        );
        for (const old of records) {
          if (old?.project != null && !keep.has(old.id)) store.delete(old.id);
          if (isRecoverySessionRecord(old)
            && old.sessionId !== sessionId
            && !active.has(String(old.sessionId))) {
            store.delete(old.id);
          }
        }
      });
      scheduleMediaCacheGc();
    },

    async clear() {
      await withOwnedSession((store, records) => {
        for (const record of records) {
          if (record?.project != null && recoverySession(record) === sessionId) {
            store.delete(record.id);
          }
        }
      });
    },

    async heartbeat() {
      await withOwnedSession(() => {});
    },

    async release() {
      return withRecoveryRecords(openDatabase, storeName, 'readwrite', (store, records) => {
        const timestamp = recoveryTimestamp(now());
        const claim = records.find((record) => record.id === recoverySessionRecordId(sessionId));
        if (!isRecoverySessionRecord(claim)
          || String(claim.ownerId || '') !== ownerId
          || recoverySessionEpoch(claim) !== ownerEpoch) {
          return false;
        }
        store.put({
          ...claim,
          ownerId: null,
          heartbeatAt: timestamp,
          observedAt: 0,
          leaseUntil: 0,
          released: true,
        });
        return true;
      });
    },
  };
}

async function projectText(project) {
  if (typeof project === 'string') return project;
  if (project && typeof project.text === 'function') return project.text();
  throw new Error('Recovery snapshot has no project data.');
}

function snapshotContextKey(context) {
  return JSON.stringify(context ?? null);
}

function sameSnapshot(last, contents, fileName, activeFrame, clean, contextKey) {
  return last.contents === contents
    && last.fileName === fileName
    && last.activeFrame === activeFrame
    && last.clean === clean && last.contextKey === contextKey;
}

export function createRecoveryController(options) {
  const storage = options.storage;
  const serialize = options.serialize;
  const serializeSnapshot = options.serializeSnapshot;
  const restore = options.restore;
  const contentKey = options.contentKey || ((contents) => contents);
  const contentStores = options.contentStores || [];
  const contextStores = options.contextStores || [];
  const nameStore = options.nameStore;
  const activeFrameStore = options.activeFrameStore;
  const dirtyStore = options.dirtyStore;
  const captureContext = options.captureContext || (() => null);
  const state = options.stateStore || writable({ state: 'idle', recoveredAt: null, error: null });
  const delay = options.delay ?? RECOVERY_WRITE_DELAY_MS;
  const maxDelay = options.maxDelay ?? RECOVERY_MAX_WRITE_DELAY_MS;
  const limit = options.limit ?? RECOVERY_SNAPSHOT_LIMIT;
  const now = options.now || (() => Date.now());
  const makeId = options.makeId || snapshotId;
  const setTimeoutFn = options.setTimeout || ((callback, ms) => setTimeout(callback, ms));
  const clearTimeoutFn = options.clearTimeout || ((timer) => clearTimeout(timer));

  let timer = null;
  let maxTimer = null;
  let started = false;
  let suppressSchedule = false;
  let pendingCapture = false;
  let draining = false;
  let drainPromise = Promise.resolve();
  let unsubscribers = [];
  let lastCreatedAt = 0;
  let contentRevision = 0;
  const explicitSnapshots = [];
  let cleanContents = null;
  let cleanContentKey = null;
  let last = {
    contents: null,
    fileName: null,
    activeFrame: null,
    clean: null,
    contextKey: null,
  };

  function currentName() {
    return String(nameStore ? get(nameStore) : 'untitled') || 'untitled';
  }

  function currentFrame() {
    const value = Number(activeFrameStore ? get(activeFrameStore) : 0);
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  function currentContext() {
    return captureContext();
  }

  function captureSerializedProject() {
    if (!serializeSnapshot) {
      const contents = serialize();
      return { contents, key: contentKey(contents) };
    }
    const snapshot = serializeSnapshot();
    const contents = String(snapshot?.contents ?? '');
    return {
      contents,
      key: snapshot?.contentKey ?? contentKey(contents),
    };
  }

  function establishCleanBaseline() {
    if (cleanContents != null || !dirtyStore || get(dirtyStore)) return;
    suppressSchedule = true;
    try {
      const captured = captureSerializedProject();
      cleanContents = captured.contents;
      cleanContentKey = captured.key;
    } catch (error) {
      setError(error);
    } finally {
      suppressSchedule = false;
    }
  }

  function setError(error) {
    state.set({ state: 'error', recoveredAt: null, error: errorMessage(error) });
  }

  async function persist(
    contents,
    clean,
    fileName,
    activeFrame,
    context = currentContext(),
    revision = contentRevision,
  ) {
    const contextKey = snapshotContextKey(context);
    if (sameSnapshot(last, contents, fileName, activeFrame, clean, contextKey)) return false;
    const timestamp = Number(now());
    const createdAt = Math.max(
      Number.isFinite(timestamp) ? Math.trunc(timestamp) : 0,
      lastCreatedAt + 1,
    );
    lastCreatedAt = createdAt;
    await storage.putAndPrune({
      id: makeId(createdAt),
      schema: 1,
      createdAt,
      fileName,
      activeFrame,
      clean,
      context,
      project: new Blob([contents], { type: 'application/json' }),
    }, limit);
    last = { contents, fileName, activeFrame, clean, contextKey };
    if (revision === contentRevision) dirtyStore?.set(!clean);
    state.set({ state: 'ready', recoveredAt: null, error: null });
    return true;
  }

  async function capture() {
    let captured;
    const revision = contentRevision;
    suppressSchedule = true;
    try {
      captured = captureSerializedProject();
    } finally {
      suppressSchedule = false;
    }
    const { contents, key } = captured;
    const clean = cleanContents != null && key === cleanContentKey;
    dirtyStore?.set(!clean);
    return persist(contents, clean, currentName(), currentFrame(), currentContext(), revision);
  }

  // Required checkpoints retain FIFO order ahead of coalesced captures, so a discard
  // cannot overtake the snapshot that makes it safe.
  function drain() {
    if (draining) return drainPromise;
    draining = true;
    drainPromise = (async () => {
      while (explicitSnapshots.length || pendingCapture) {
        let explicitSnapshot = null;
        try {
          if (explicitSnapshots.length) {
            explicitSnapshot = explicitSnapshots.shift();
            const persisted = await persist(
              explicitSnapshot.contents,
              explicitSnapshot.clean,
              explicitSnapshot.fileName,
              explicitSnapshot.activeFrame,
              explicitSnapshot.context,
              explicitSnapshot.revision,
            );
            explicitSnapshot.resolve(persisted);
          } else {
            pendingCapture = false;
            await capture();
          }
        } catch (error) {
          setError(error);
          if (explicitSnapshot?.required) explicitSnapshot.reject(error);
          else explicitSnapshot?.resolve(false);
        }
      }
    })().finally(() => {
      draining = false;
      if (explicitSnapshots.length || pendingCapture) return drain();
    });
    return drainPromise;
  }

  function clearTimers() {
    let scheduled = false;
    if (timer != null) {
      clearTimeoutFn(timer);
      timer = null;
      scheduled = true;
    }
    if (maxTimer != null) {
      clearTimeoutFn(maxTimer);
      maxTimer = null;
      scheduled = true;
    }
    return scheduled;
  }

  // Debounce bursts but keep a maximum delay so continuous editing cannot starve recovery writes.
  function schedule(markDirty = true) {
    if (!started || suppressSchedule) return;
    if (markDirty) {
      contentRevision++;
      dirtyStore?.set(true);
    }
    if (timer != null) clearTimeoutFn(timer);
    timer = setTimeoutFn(() => {
      timer = null;
      if (maxTimer != null) clearTimeoutFn(maxTimer);
      maxTimer = null;
      pendingCapture = true;
      drain();
    }, delay);
    if (maxTimer == null) {
      maxTimer = setTimeoutFn(() => {
        maxTimer = null;
        if (timer != null) clearTimeoutFn(timer);
        timer = null;
        pendingCapture = true;
        drain();
      }, maxDelay);
    }
  }

  async function flush() {
    clearTimers();
    pendingCapture = true;
    await drain();
  }

  function refreshDirty() {
    suppressSchedule = true;
    try {
      const captured = captureSerializedProject();
      const clean = cleanContents != null && captured.key === cleanContentKey;
      dirtyStore?.set(!clean);
      return clean;
    } catch (error) {
      setError(error);
      return null;
    } finally {
      suppressSchedule = false;
    }
  }

  async function restoreLatest() {
    state.set({ state: 'restoring', recoveredAt: null, error: null });
    let records;
    try {
      records = await storage.listNewest();
    } catch (error) {
      setError(error);
      return null;
    }
    if (!records.length) {
      state.set({ state: 'idle', recoveredAt: null, error: null });
      return null;
    }
    for (const record of records) {
      try {
        const contents = await projectText(record.project);
        suppressSchedule = true;
        try {
          await restore(contents, record);
        } finally {
          suppressSchedule = false;
        }
        const fileName = String(record.fileName || 'untitled');
        const activeFrame = Math.max(0, Math.trunc(Number(record.activeFrame) || 0));
        const clean = !!record.clean;
        cleanContents = clean ? contents : null;
        cleanContentKey = clean ? contentKey(contents) : null;
        lastCreatedAt = Math.max(
          lastCreatedAt,
          Number.isFinite(Number(record.createdAt)) ? Math.trunc(Number(record.createdAt)) : 0,
        );
        const contextKey = snapshotContextKey(record.context);
        last = { contents, fileName, activeFrame, clean, contextKey };
        dirtyStore?.set(!clean);
        state.set({ state: 'recovered', recoveredAt: record.createdAt, error: null });
        return record;
      } catch {}
    }
    state.set({ state: 'idle', recoveredAt: null, error: null });
    return null;
  }

  function queueExplicit(snapshot, required = false) {
    return new Promise((resolve, reject) => {
      explicitSnapshots.push({
        ...snapshot,
        revision: snapshot.revision ?? contentRevision,
        required,
        resolve,
        reject,
      });
      drain();
    });
  }

  function queueClean(contents, fileName) {
    contentRevision++;
    cleanContents = contents;
    cleanContentKey = contentKey(contents);
    clearTimers();
    return queueExplicit({
      contents,
      clean: true,
      fileName: String(fileName || currentName()),
      activeFrame: currentFrame(),
      context: currentContext(),
    });
  }

  function queueSaved(contents, fileName, currentContents = contents) {
    contentRevision++;
    cleanContents = contents;
    cleanContentKey = contentKey(contents);
    clearTimers();
    if (currentContents == null) {
      pendingCapture = true;
      return drain();
    }
    const clean = contentKey(currentContents) === cleanContentKey;
    return queueExplicit({
      contents: currentContents,
      clean,
      fileName: String(fileName || currentName()),
      activeFrame: currentFrame(),
      context: currentContext(),
    });
  }

  function queueCheckpoint(contents, fileName) {
    contentRevision++;
    const clean = cleanContents != null && contentKey(contents) === cleanContentKey;
    dirtyStore?.set(!clean);
    clearTimers();
    return queueExplicit({
      contents,
      clean,
      fileName: String(fileName || currentName()),
      activeFrame: currentFrame(),
      context: currentContext(),
    }, true);
  }

  function start() {
    if (started) return stop;
    establishCleanBaseline();
    started = true;
    let priming = true;
    unsubscribers = [
      ...contentStores.map((store) => store.subscribe(() => {
        if (!priming) schedule(true);
      })),
      ...contextStores.map((store) => store.subscribe(() => {
        if (!priming) schedule(false);
      })),
    ];
    priming = false;
    return stop;
  }

  async function stop() {
    if (!started) return;
    started = false;
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers = [];
    if (clearTimers()) pendingCapture = true;
    await drain();
  }

  return {
    state,
    restoreLatest,
    start,
    stop,
    schedule,
    flush,
    refreshDirty,
    checkpoint: queueCheckpoint,
    markSaved: queueSaved,
    markLoaded: queueClean,
  };
}
