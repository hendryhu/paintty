import { get, writable } from 'svelte/store';
import {
  claimIndexedDbRecoverySession,
  createIndexedDbRecoveryStorage,
  createRecoveryController,
  recoveryRecordIdsToKeep,
  recoveryRecordsForSession,
  newestRecoveryRecords,
} from '../src/lib/recovery.js';
import {
  addLayer, activeLayerId, activeLayerPart, authoredRevision, canRedo, canUndo, dims, layers,
  resetEditorStateForProjectLoad, selectedLayerIds,
} from '../src/lib/grid.js';
import {
  activeFrameIndex,
  addCustomTimelineTag,
  deleteClipSelection,
  loadCanonicalTimeline,
  seekTick,
  setClipSelection,
  setVisibilityKey,
  setVisibilityTrackEnabled,
  trimClip,
  visibilityAt,
  visibilityKeys,
} from '../src/lib/frames.js';
import { audioClips } from '../src/lib/audio.js';
import {
  durationTicks as canonicalDurationTicks,
  getClipTimelineState,
} from '../src/lib/clipTimelineState.js';
import { serializeJSON } from '../src/lib/fileio.js';
import {
  createBrowserRecoverySession,
  recoveryNoticeTransition,
  restoreProject,
} from '../src/lib/recoveryRuntime.js';
import { dirty, fileName } from '../src/lib/stores.js';
import { notifications, notifyInfo } from '../src/lib/notifications.js';
import { deterministicUuid } from './projectFixture.mjs';

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log('  ✓ ' + name);
    return;
  }
  fail++;
  console.error('  ✗ ' + name + (detail ? ': ' + detail : ''));
}

async function projectText(record) {
  return typeof record.project === 'string'
    ? record.project
    : record.project.text();
}

function memoryStorage(initial = [], beforePut = null) {
  const records = [...initial];
  return {
    records,
    async listNewest() {
      return newestRecoveryRecords(records, Number.POSITIVE_INFINITY);
    },
    async putAndPrune(record, limit) {
      if (beforePut) await beforePut(record);
      records.push(record);
      const kept = newestRecoveryRecords(records, limit);
      records.splice(0, records.length, ...kept);
    },
    async clear() {
      records.length = 0;
    },
  };
}

function indexedDbHarness(initial = []) {
  const records = [...initial];
  let transactionTail = Promise.resolve();
  return {
    records,
    async openDatabase() {
      return {
        transaction() {
          const turn = transactionTail;
          let releaseTurn;
          transactionTail = new Promise((resolve) => { releaseTurn = resolve; });
          let active = false;
          let aborted = false;
          const transaction = {
            error: null,
            oncomplete: null,
            onerror: null,
            onabort: null,
            abort() {
              if (aborted) return;
              aborted = true;
              active = false;
              queueMicrotask(() => {
                transaction.onabort?.();
                releaseTurn();
              });
            },
            objectStore() {
              return {
                getAll() {
                  const request = {};
                  turn.then(() => queueMicrotask(() => {
                    if (aborted) return;
                    active = true;
                    request.result = [...records];
                    request.onsuccess?.();
                    queueMicrotask(() => {
                      if (aborted) return;
                      active = false;
                      transaction.oncomplete?.();
                      releaseTurn();
                    });
                  }));
                  return request;
                },
                put(record) {
                  if (!active) throw new Error('Inactive fake IndexedDB transaction.');
                  const index = records.findIndex((item) => item.id === record.id);
                  if (index < 0) records.push(record);
                  else records[index] = record;
                },
                delete(id) {
                  if (!active) throw new Error('Inactive fake IndexedDB transaction.');
                  const index = records.findIndex((item) => item.id === id);
                  if (index >= 0) records.splice(index, 1);
                },
              };
            },
          };
          return transaction;
        },
        close() {},
      };
    },
  };
}

function broadcastHarness() {
  const channels = new Set();
  return {
    open() {
      const listeners = new Set();
      const channel = {
        addEventListener(type, listener) {
          if (type === 'message') listeners.add(listener);
        },
        removeEventListener(type, listener) {
          if (type === 'message') listeners.delete(listener);
        },
        postMessage(data) {
          for (const other of channels) {
            if (other === channel) continue;
            queueMicrotask(() => other.deliver(data));
          }
        },
        deliver(data) {
          for (const listener of listeners) listener({ data });
        },
        close() {
          channels.delete(channel);
          listeners.clear();
        },
      };
      channels.add(channel);
      return channel;
    },
  };
}

function webStorageHarness() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(storage, initial = 'seed', controllerOptions = {}) {
  const content = writable(0);
  const name = writable('untitled');
  const frame = writable(0);
  const dirty = writable(false);
  const state = writable({ state: 'idle', recoveredAt: null, error: null });
  let project = initial;
  let clock = 0;
  const controller = createRecoveryController({
    storage,
    serialize: () => project,
    restore: (contents) => { project = contents; },
    contentStores: [content],
    contextStores: [name, frame],
    nameStore: name,
    activeFrameStore: frame,
    dirtyStore: dirty,
    stateStore: state,
    delay: 60_000,
    now: () => ++clock,
    makeId: (value) => 'snapshot-' + value,
    ...controllerOptions,
  });
  return {
    controller,
    content,
    name,
    frame,
    dirty,
    state,
    getProject() { return project; },
    setProject(value) {
      project = value;
      content.update((revision) => revision + 1);
    },
    setContextProject(value) {
      project = value;
      frame.update((current) => current + 1);
    },
  };
}

function authoredProject(projectId, width, height, glyph, x, y) {
  return JSON.stringify({
    projectId,
    width,
    height,
    cells: { [`${x},${y}`]: { c: glyph } },
  });
}

async function startIndexedRecoveryTab(database, options) {
  const {
    sessionId,
    ownerId,
    initial = authoredProject('default', 80, 24, '', 0, 0),
    now = () => 100,
    maxAge,
    adoptAbandoned = false,
    activeSessionIds = [],
    storage: storageOptions = {},
    wrapStorage = (value) => value,
    controller: controllerOptions = {},
  } = options;
  const active = typeof activeSessionIds === 'function'
    ? await activeSessionIds()
    : activeSessionIds;
  const claim = await claimIndexedDbRecoverySession({
    openDatabase: database.openDatabase,
    sessionId,
    ownerId,
    adoptAbandoned,
    activeSessionIds: active,
    now,
    ...(maxAge == null ? {} : { maxAge }),
  });
  if (!claim.claimed) throw new Error(`Could not claim test recovery session ${sessionId}.`);
  const ownedStorage = createIndexedDbRecoveryStorage({
    openDatabase: database.openDatabase,
    sessionId,
    ownerId,
    ownerEpoch: claim.ownerEpoch,
    activeSessionIds,
    now,
    ...(maxAge == null ? {} : { maxAge }),
    ...storageOptions,
  });
  const storage = wrapStorage(ownedStorage);
  const tab = harness(storage, initial, {
    now,
    makeId: (createdAt) => `${ownerId}-${createdAt}`,
    ...controllerOptions,
  });
  const recovered = await tab.controller.restoreLatest();
  const stop = tab.controller.start();
  return { ...tab, storage, ownedStorage, recovered, stop, sessionId, ownerId, claim };
}

console.log('recovery identity notice');

{
  const restoring = recoveryNoticeTransition(null, { state: 'restoring', authored: false });
  check('startup restoration does not notify before an outcome exists',
    restoring.settled === false && restoring.notification == null);

  const blank = recoveryNoticeTransition(restoring, { state: 'idle', authored: false });
  check('blank startup settles without a recovery notice',
    blank.settled === true && blank.notified === false && blank.notification == null);
  check('a later transition cannot reinterpret blank startup as recovery',
    recoveryNoticeTransition(blank, { state: 'recovered', authored: true }).notification == null);

  const incompatible = recoveryNoticeTransition(null, { state: 'idle', authored: false });
  check('skipped incompatible snapshots settle without a recovery notice',
    incompatible.settled === true && incompatible.notification == null);

  let clean = recoveryNoticeTransition(null, { state: 'recovered', authored: false });
  check('clean context-only recovery does not claim unsaved work was restored',
    clean.settled === true && clean.notified === false && clean.notification == null);
  clean = recoveryNoticeTransition(clean, { state: 'ready', authored: false });
  check('clean recovery remains silent after the controller becomes ready', clean.notification == null);

  let authored = recoveryNoticeTransition(null, { state: 'recovered', authored: true });
  check('authored startup recovery produces the one exact identity notice',
    authored.settled === true
      && authored.notified === true
      && authored.notification === 'Recovered unsaved project.');
  for (const next of [
    { state: 'recovered', authored: true },
    { state: 'ready', authored: false },
    { state: 'idle', authored: false },
  ]) {
    authored = recoveryNoticeTransition(authored, next);
    check(`the ${next.state} transition cannot duplicate the startup notice`,
      authored.notification == null && authored.notified === true);
  }

  const projectBeforeNotice = serializeJSON();
  const stateBeforeNotice = {
    dirty: get(dirty),
    revision: get(authoredRevision),
    canUndo: get(canUndo),
    canRedo: get(canRedo),
  };
  notifications.set([]);
  const notice = recoveryNoticeTransition(null, { state: 'recovered', authored: true });
  if (notice.notification) notifyInfo(notice.notification);
  check('the recovery identity notice uses one terse info notification',
    get(notifications).length === 1
      && get(notifications)[0].message === 'Recovered unsaved project.'
      && get(notifications)[0].tone === 'info');
  check('publishing the recovery notice has no project, dirty, revision, or history effect',
    serializeJSON() === projectBeforeNotice
      && JSON.stringify({
        dirty: get(dirty),
        revision: get(authoredRevision),
        canUndo: get(canUndo),
        canRedo: get(canRedo),
      }) === JSON.stringify(stateBeforeNotice));
  notifications.set([]);
}

{
  const storage = memoryStorage();
  const test = harness(storage, 'seed', { now: () => 42 });
  const stop = test.controller.start();
  test.setProject('first');
  await test.controller.flush();
  test.setProject('second');
  await test.controller.flush();
  check('same-clock writes retain their actual order',
    storage.records[0].createdAt > storage.records[1].createdAt
      && await projectText(storage.records[0]) === 'second');
  await stop();
}

console.log('recovery controller');

{
  const storage = memoryStorage();
  const test = harness(storage);
  const stop = test.controller.start();
  test.setProject('one');
  test.setProject('two');
  await test.controller.flush();
  check('burst mutations coalesce to the latest project', storage.records.length === 1
    && await projectText(storage.records[0]) === 'two');

  test.content.update((revision) => revision + 1);
  await test.controller.flush();
  check('an exact duplicate does not consume a rotation slot', storage.records.length === 1);

  test.frame.set(4);
  await test.controller.flush();
  check('the selected frame is included in recovery state', storage.records.length === 2
    && storage.records[0].activeFrame === 4);

  for (const value of ['three', 'four', 'five', 'six']) {
    test.setProject(value);
    await test.controller.flush();
  }
  check('snapshot rotation retains exactly three records', storage.records.length === 3);
  check('rotation keeps the newest authored project', await projectText(storage.records[0]) === 'six');
  check('an unsaved capture marks the document dirty', get(test.dirty) === true);
  await stop();
}

{
  const storage = memoryStorage();
  const test = harness(storage, 'clean');
  const stop = test.controller.start();
  test.frame.set(4);
  check('changing only the recovery frame does not dirty a clean document',
    get(test.dirty) === false);
  await test.controller.flush();
  check('recovery preserves clean editor context without an unsaved marker',
    storage.records[0].activeFrame === 4
      && storage.records[0].clean === true
      && get(test.dirty) === false);
  await stop();
}

{
  const storage = memoryStorage();
  const test = harness(storage, 'clean');
  const stop = test.controller.start();
  test.setProject('edited');
  test.setProject('clean');
  check('authored signals conservatively mark a reverted project dirty before comparison',
    get(test.dirty) === true);
  check('history restoration can clear the dirty marker immediately without a recovery write',
    test.controller.refreshDirty() === true
      && get(test.dirty) === false
      && storage.records.length === 0);
  await stop();
}

{
  const storage = memoryStorage();
  const test = harness(storage, '{"value":1,"collapsed":false}', {
    contentKey(contents) {
      const parsed = JSON.parse(contents);
      delete parsed.collapsed;
      return JSON.stringify(parsed);
    },
  });
  const stop = test.controller.start();
  test.setContextProject('{"value":1,"collapsed":true}');
  await test.controller.flush();
  check('context-only serialized state is recovered without dirtying authored content',
    storage.records[0].clean === true
      && await projectText(storage.records[0]) === '{"value":1,"collapsed":true}'
      && get(test.dirty) === false);
  await stop();
}

{
  const storage = memoryStorage();
  const content = writable(0);
  const dirtyState = writable(false);
  let collapsed = false;
  let fallbackSerializations = 0;
  let snapshotSerializations = 0;
  let parsedContentKeys = 0;
  const controller = createRecoveryController({
    storage,
    serialize() {
      fallbackSerializations++;
      return JSON.stringify({ value: 1, collapsed });
    },
    serializeSnapshot() {
      snapshotSerializations++;
      return {
        contents: JSON.stringify({ value: 1, collapsed }),
        contentKey: '{"value":1}',
      };
    },
    contentKey(contents) {
      parsedContentKeys++;
      return JSON.stringify({ value: JSON.parse(contents).value });
    },
    restore() {},
    contentStores: [content],
    dirtyStore: dirtyState,
    delay: 60_000,
  });
  const stop = controller.start();
  collapsed = true;
  content.set(1);
  await controller.flush();
  check('current recovery captures use the serializer-provided authored key',
    fallbackSerializations === 0
      && parsedContentKeys === 0
      && snapshotSerializations === 2
      && get(dirtyState) === false
      && await projectText(storage.records[0]) === '{"value":1,"collapsed":true}');
  await stop();
}

{
  const storage = memoryStorage();
  const content = writable(0);
  const dirty = writable(false);
  let project = 'recursive';
  let serializations = 0;
  const controller = createRecoveryController({
    storage,
    serialize() {
      serializations++;
      content.update((revision) => revision + 1);
      return project;
    },
    restore: () => {},
    contentStores: [content],
    nameStore: writable('recursive.json'),
    activeFrameStore: writable(0),
    dirtyStore: dirty,
    delay: 60_000,
  });
  const stop = controller.start();
  serializations = 0;
  content.set(1);
  await controller.flush();
  check('serialization-triggered store publication does not recurse',
    storage.records.length === 1 && serializations === 1);
  await stop();
}

{
  let releaseFirst;
  let enteredFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  let writes = 0;
  const storage = memoryStorage([], async () => {
    if (writes++ === 0) {
      enteredFirst();
      await firstGate;
    }
  });
  const test = harness(storage);
  const stop = test.controller.start();
  test.setProject('first');
  const firstFlush = test.controller.flush();
  await firstEntered;
  test.setProject('second');
  const secondFlush = test.controller.flush();
  releaseFirst();
  await Promise.all([firstFlush, secondFlush]);
  const texts = await Promise.all(storage.records.map(projectText));
  check('a mutation during an in-flight write gets a second snapshot',
    texts.includes('first') && texts[0] === 'second');
  await stop();
}

{
  let releaseClean;
  let enteredClean;
  const cleanGate = new Promise((resolve) => { releaseClean = resolve; });
  const cleanEntered = new Promise((resolve) => { enteredClean = resolve; });
  let writes = 0;
  const storage = memoryStorage([], async () => {
    if (writes++ === 0) {
      enteredClean();
      await cleanGate;
    }
  });
  const test = harness(storage, 'seed');
  const dirtyTransitions = [];
  const unsubscribe = test.dirty.subscribe((value) => dirtyTransitions.push(value));
  const stop = test.controller.start();
  test.frame.set(1);
  const cleanFlush = test.controller.flush();
  await cleanEntered;
  test.setProject('newer authored edit');
  const dirtyStart = dirtyTransitions.lastIndexOf(true);
  releaseClean();
  await cleanFlush;
  await test.controller.flush();
  check('a stale clean write-never-clears-the-newer-unsaved-marker',
    !dirtyTransitions.slice(dirtyStart).includes(false) && get(test.dirty) === true);
  unsubscribe();
  await stop();
}

{
  const storage = memoryStorage([
    {
      id: 'older',
      createdAt: 1,
      fileName: 'recovered.json',
      activeFrame: 7,
      clean: false,
      project: new Blob(['{"ok":true}']),
    },
    {
      id: 'newer',
      createdAt: 2,
      fileName: 'broken.json',
      activeFrame: 2,
      clean: false,
      project: new Blob(['not json']),
    },
  ]);
  const name = writable('seed');
  const frame = writable(0);
  const dirty = writable(false);
  const state = writable({ state: 'idle' });
  let restored = null;
  const controller = createRecoveryController({
    storage,
    serialize: () => '{"seed":true}',
    restore(contents, snapshot) {
      const parsed = JSON.parse(contents);
      if (!parsed.ok) throw new Error('invalid');
      restored = snapshot.id;
      name.set(snapshot.fileName);
      frame.set(snapshot.activeFrame);
    },
    contentStores: [],
    nameStore: name,
    activeFrameStore: frame,
    dirtyStore: dirty,
    stateStore: state,
  });
  const record = await controller.restoreLatest();
  check('a corrupt newest snapshot falls back to the previous valid one',
    record?.id === 'older' && restored === 'older');
  check('restore preserves filename, selected frame, and dirty state',
    get(name) === 'recovered.json' && get(frame) === 7 && get(dirty) === true);
  check('successful recovery exposes a recovered state', get(state).state === 'recovered');
}

{
  const untouched = {
    contents: serializeJSON(),
    fileName: get(fileName),
    activeFrame: get(activeFrameIndex),
    dirty: get(dirty),
  };
  const incompatible = JSON.parse(untouched.contents);
  incompatible.audio = [];
  const storage = memoryStorage([
    {
      id: 'stale-older',
      createdAt: 1,
      project: new Blob([JSON.stringify(incompatible)]),
    },
    {
      id: 'stale-newer',
      createdAt: 2,
      project: new Blob([JSON.stringify(incompatible)]),
    },
  ]);
  const state = writable({ state: 'idle' });
  const restoreErrors = [];
  const controller = createRecoveryController({
    storage,
    serialize: serializeJSON,
    restore(contents, snapshot) {
      try {
        restoreProject(contents, snapshot);
      } catch (error) {
        restoreErrors.push(error.message);
        throw error;
      }
    },
    contentStores: [],
    nameStore: fileName,
    activeFrameStore: activeFrameIndex,
    dirtyStore: dirty,
    stateStore: state,
    now: () => 3,
    makeId: () => 'current-schema',
  });
  const record = await controller.restoreLatest();
  check('all incompatible snapshots leave the current project untouched',
    record === null
      && serializeJSON() === untouched.contents
      && get(fileName) === untouched.fileName
      && get(activeFrameIndex) === untouched.activeFrame
      && get(dirty) === untouched.dirty);
  check('all incompatible snapshots return to idle without a recovery error',
    get(state).state === 'idle' && get(state).error == null);
  check('the strict runtime loader still diagnoses every incompatible snapshot',
    restoreErrors.length === 2
      && restoreErrors.every((message) => message === 'Project contains unsupported field audio'));

  const stop = controller.start();
  await controller.flush();
  const currentRecord = storage.records.find((item) => item.id === 'current-schema');
  const currentProject = JSON.parse(await projectText(currentRecord));
  const rootFields = new Set(Object.keys(currentProject));
  check('capture starts normally after incompatible recovery history',
    get(state).state === 'ready'
      && get(state).error == null
      && rootFields.size === 8
      && [
        'format', 'version', 'projectId', 'width', 'height', 'fps', 'timeline', 'media',
      ].every((field) => rootFields.has(field))
      && !rootFields.has('audio'));
  await stop();
}

{
  const storage = {
    async listNewest() { throw new Error('snapshot listing failed'); },
    async putAndPrune() {},
  };
  const test = harness(storage);
  const record = await test.controller.restoreLatest();
  check('a recovery storage listing failure remains a visible error',
    record === null
      && get(test.state).state === 'error'
      && get(test.state).error === 'snapshot listing failed');
}

{
  const storage = {
    async listNewest() { return []; },
    async putAndPrune() { throw new Error('quota'); },
  };
  const test = harness(storage);
  const stop = test.controller.start();
  test.setProject('cannot persist');
  check('a content mutation marks the document dirty before recovery debounce',
    get(test.dirty) === true);
  await test.controller.flush();
  check('storage failure is nonfatal and still marks authored work dirty',
    get(test.dirty) === true && get(test.state).state === 'error');
  await stop();
}

{
  const storage = memoryStorage();
  const test = harness(storage, 'saved');
  await test.controller.markSaved('saved', 'saved.json', 'edited while writing');
  check('a save race protects the newer unsaved project without a stale clean gap',
    storage.records.length === 1
      && await projectText(storage.records[0]) === 'edited while writing'
      && storage.records[0].clean === false
      && get(test.dirty) === true);
}

{
  const storage = memoryStorage();
  const test = harness(storage, 'clean project');
  const stop = test.controller.start();
  await test.controller.checkpoint('clean project', 'clean.json');
  check('a pre-picker checkpoint does not dirty a clean document',
    storage.records.length === 1
      && storage.records[0].clean === true
      && get(test.dirty) === false);
  await stop();
}

{
  const storage = memoryStorage();
  const test = harness(storage, 'saved');
  const stop = test.controller.start();
  await test.controller.markSaved('saved', 'saved.json');
  check('a completed disk save records a clean recovery point', get(test.dirty) === false);
  test.setProject('edited after save');
  await test.controller.flush();
  check('an edit after save supersedes the clean point as dirty',
    get(test.dirty) === true && await projectText(storage.records[0]) === 'edited after save');
  await stop();
}

{
  const storage = memoryStorage();
  const test = harness(storage);
  await test.controller.checkpoint('prepared project', 'prepared.json');
  check('a required checkpoint persists exact prepared contents before returning',
    storage.records.length === 1
      && await projectText(storage.records[0]) === 'prepared project'
      && storage.records[0].clean === false
      && storage.records[0].fileName === 'prepared.json');
}

{
  const storage = {
    async listNewest() { return []; },
    async putAndPrune() { throw new Error('checkpoint failed'); },
  };
  const test = harness(storage);
  let rejected = false;
  try {
    await test.controller.checkpoint('unprotected', 'unsafe.json');
  } catch (error) {
    rejected = error.message === 'checkpoint failed';
  }
  check('a required checkpoint reports persistence failure to its caller',
    rejected && get(test.state).state === 'error');
}
{
  const timers = new Map();
  let nextTimer = 0;
  const storage = memoryStorage();
  const test = harness(storage, 'seed', {
    delay: 100,
    maxDelay: 10,
    setTimeout(callback, timeout) {
      const id = ++nextTimer;
      timers.set(id, { id, callback, timeout });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  const stop = test.controller.start();
  test.setProject('playing one');
  test.setProject('playing latest');
  const maxTimerEntry = [...timers.values()].find((entry) => entry.timeout === 10);
  timers.delete(maxTimerEntry?.id);
  maxTimerEntry?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  check('continuous activity cannot postpone recovery past the maximum interval',
    storage.records.length === 1
      && await projectText(storage.records[0]) === 'playing latest');
  await stop();
}
{
  const before = {
    contents: serializeJSON(),
    dims: { ...get(dims) },
    fileName: get(fileName),
    activeFrame: get(activeFrameIndex),
    dirty: get(dirty),
  };
  const malformed = JSON.stringify({
    format: 'paintty-sprite',
    version: 10,
    width: before.dims.w + 7,
    height: before.dims.h + 5,
    fps: 24,
    timeline: { frameCount: 1, holds: [1], layers: [null] },
  });
  let failed = false;
  try {
    restoreProject(malformed, { fileName: 'broken.json', activeFrame: 0 });
  } catch {
    failed = true;
  }
  const beforeProject = JSON.parse(before.contents);
  const afterProject = JSON.parse(serializeJSON());
  const afterDims = get(dims);
  check('a failed real restore rolls back every partially mutated project store',
    failed
      && JSON.stringify(afterProject) === JSON.stringify(beforeProject)
      && afterDims.w === before.dims.w
      && afterDims.h === before.dims.h
      && get(fileName) === before.fileName
      && get(activeFrameIndex) === before.activeFrame
      && get(dirty) === before.dirty);
}
{
  const records = [
    { id: 'a-old', sessionId: 'a', createdAt: 2, project: 'a-old' },
    { id: 'a-new', sessionId: 'a', createdAt: 5, project: 'a-new' },
    { id: 'b-active', sessionId: 'b', createdAt: 6, project: 'b' },
    { id: 'legacy', createdAt: 1, project: 'legacy' },
  ];
  const own = recoveryRecordsForSession(records, 'a');
  const fallback = recoveryRecordsForSession(records, 'new-session');
  check('recovery returns only snapshots owned by the claimed tab session',
    own.map((record) => record.id).join(',') === 'a-new,a-old'
      && fallback.length === 0);
  const kept = recoveryRecordIdsToKeep(records, 'a', ['b'], 1, 1);
  check('rotation preserves each live tab while bounding abandoned history',
    kept.has('a-new') && kept.has('b-active') && kept.has('legacy') && kept.size === 3);
}

{
  const database = indexedDbHarness([
    { id: 'first-live', sessionId: 'first-live', createdAt: 10, project: 'first' },
    { id: 'old-history', sessionId: 'old', createdAt: 20, project: 'old' },
  ]);
  let clock = 100;
  await claimIndexedDbRecoverySession({
    openDatabase: database.openDatabase,
    sessionId: 'first-live',
    ownerId: 'first-owner',
    now: () => clock,
  });
  const currentClaim = await claimIndexedDbRecoverySession({
    openDatabase: database.openDatabase,
    sessionId: 'current',
    ownerId: 'current-owner',
    activeSessionIds: ['first-live'],
    now: () => clock,
  });
  let active = ['first-live'];
  const storage = createIndexedDbRecoveryStorage({
    openDatabase: database.openDatabase,
    sessionId: 'current',
    ownerId: 'current-owner',
    ownerEpoch: currentClaim.ownerEpoch,
    activeSessionIds: async () => active,
    historyLimit: 1,
    now: () => ++clock,
  });
  await storage.putAndPrune({
    id: 'current-1', createdAt: 21, project: 'current one',
  }, 1);
  database.records.push(
    { id: 'later-live', sessionId: 'later-live', createdAt: 30, project: 'later' },
    { id: 'new-history', sessionId: 'new-history', createdAt: 40, project: 'history' },
  );
  await claimIndexedDbRecoverySession({
    openDatabase: database.openDatabase,
    sessionId: 'later-live',
    ownerId: 'later-owner',
    activeSessionIds: ['first-live', 'current'],
    now: () => ++clock,
  });
  active = ['first-live', 'later-live'];
  await storage.putAndPrune({
    id: 'current-2', createdAt: 41, project: 'current two',
  }, 1);
  const ids = new Set(database.records.map((record) => record.id));
  check('IndexedDB pruning refreshes the live-tab set before every write',
    ids.has('current-2')
      && ids.has('first-live')
      && ids.has('later-live')
      && ids.has('new-history')
      && !ids.has('current-1'));
  const orphan = {
    id: 'orphan-newest', sessionId: 'orphan', createdAt: 50, project: 'orphan newest',
  };
  database.records.push(
    { id: 'orphan-old', sessionId: 'orphan', createdAt: 49, project: 'orphan old' },
    orphan,
  );
  const adopted = await claimIndexedDbRecoverySession({
    openDatabase: database.openDatabase,
    sessionId: 'adopter',
    ownerId: 'adopter-owner',
    activeSessionIds: ['first-live', 'current', 'later-live'],
    adoptAbandoned: true,
    now: () => ++clock,
  });
  check('claiming a fresh tab atomically transfers the newest abandoned session',
    adopted.claimed
      && adopted.adoptedSessionId === 'orphan'
      && database.records.some((record) => record.id === orphan.id && record.sessionId === 'adopter')
      && !database.records.some((record) => record?.project != null && record.sessionId === 'orphan'));
}

{
  const database = indexedDbHarness();
  const timestamp = 350;
  const outgoing = await startIndexedRecoveryTab(database, {
    sessionId: 'adoption-source', ownerId: 'adoption-owner', now: () => timestamp,
  });
  outgoing.setProject('authored before adoption');
  await outgoing.controller.flush();
  const blocked = await claimIndexedDbRecoverySession({
    openDatabase: database.openDatabase,
    sessionId: 'blocked-adopter',
    ownerId: 'blocked-owner',
    adoptAbandoned: true,
    now: () => timestamp,
  });
  const blockedStorage = createIndexedDbRecoveryStorage({
    openDatabase: database.openDatabase,
    sessionId: blocked.sessionId,
    ownerId: 'blocked-owner',
    ownerEpoch: blocked.ownerEpoch,
    now: () => timestamp,
  });
  check('adoption cannot move snapshots while their durable owner lease is live',
    blocked.claimed
      && blocked.adoptedSessionId == null
      && database.records.some((record) => (
        record?.project != null && record.sessionId === 'adoption-source'
      )));
  await blockedStorage.release();
  await outgoing.stop();
  await outgoing.ownedStorage.release();
  const accepted = await claimIndexedDbRecoverySession({
    openDatabase: database.openDatabase,
    sessionId: 'accepted-adopter',
    ownerId: 'accepted-owner',
    adoptAbandoned: true,
    now: () => timestamp,
  });
  check('adoption moves the complete lineage only after the owner releases it',
    accepted.adoptedSessionId === 'adoption-source'
      && database.records.some((record) => (
        record?.project != null && record.sessionId === 'accepted-adopter'
      ))
      && !database.records.some((record) => (
        record?.project != null && record.sessionId === 'adoption-source'
      )));
  const acceptedStorage = createIndexedDbRecoveryStorage({
    openDatabase: database.openDatabase,
    sessionId: accepted.sessionId,
    ownerId: 'accepted-owner',
    ownerEpoch: accepted.ownerEpoch,
    now: () => timestamp,
  });
  await acceptedStorage.release();
}

console.log('recovery session races');

{
  const database = indexedDbHarness();
  const claims = await Promise.all([
    claimIndexedDbRecoverySession({
      openDatabase: database.openDatabase,
      sessionId: 'cloned-session',
      ownerId: 'clone-owner-a',
      now: () => 400,
    }),
    claimIndexedDbRecoverySession({
      openDatabase: database.openDatabase,
      sessionId: 'cloned-session',
      ownerId: 'clone-owner-b',
      now: () => 400,
    }),
  ]);
  check('an atomic claim gives a cloned session ID to exactly one live owner',
    claims.filter((claim) => claim.claimed).length === 1
      && claims.filter((claim) => !claim.claimed).length === 1);
}

{
  const database = indexedDbHarness();
  const timestamp = 450;
  const original = await startIndexedRecoveryTab(database, {
    sessionId: 'copied-session', ownerId: 'original-owner', now: () => timestamp,
  });
  const copiedValues = new Map([['paintty-recovery-session', 'copied-session']]);
  const clone = await createBrowserRecoverySession({
    storage: {
      getItem(key) { return copiedValues.get(key) || null; },
      setItem(key, value) { copiedValues.set(key, value); },
    },
    history: null,
    locks: {},
    channel: null,
    sharedStorage: null,
    reclaimStoredSession: false,
    ownerId: 'clone-owner',
    makeId: () => 'isolated-clone-session',
    claimSession: (options) => claimIndexedDbRecoverySession({
      ...options,
      openDatabase: database.openDatabase,
      now: () => timestamp,
    }),
  });
  const cloneStorage = createIndexedDbRecoveryStorage({
    openDatabase: database.openDatabase,
    sessionId: clone.sessionId,
    ownerId: clone.ownerId,
    ownerEpoch: clone.ownerEpoch,
    now: () => timestamp,
  });
  await original.ownedStorage.heartbeat();
  check('a cloned tab without any coordination falls back to a durable isolated session',
    clone.sessionId === 'isolated-clone-session'
      && copiedValues.get('paintty-recovery-session') === 'isolated-clone-session'
      && clone.activeSessionIds.includes('copied-session'));
  await original.stop();
  await Promise.all([original.ownedStorage.release(), cloneStorage.release()]);
  clone.release();
}

for (const releaseOrder of [['a', 'b'], ['b', 'a']]) {
  const database = indexedDbHarness();
  const timestamp = 500;
  const tabs = {
    a: await startIndexedRecoveryTab(database, {
      sessionId: 'session-a', ownerId: 'owner-a', now: () => timestamp,
    }),
    b: await startIndexedRecoveryTab(database, {
      sessionId: 'session-b', ownerId: 'owner-b', now: () => timestamp,
    }),
  };
  const projectA = authoredProject('project-a', 24, 18, 'A', 2, 3);
  const projectB = authoredProject('project-b', 30, 10, 'B', 7, 4);
  tabs.a.setProject(projectA);
  tabs.b.setProject(projectB);

  const retryCallbacks = { a: [], b: [] };
  const settled = { a: false, b: false };
  const pending = {};
  for (const id of ['a', 'b']) {
    const values = new Map([['paintty-recovery-session', `session-${id}`]]);
    pending[id] = createBrowserRecoverySession({
      storage: {
        getItem(key) { return values.get(key) || null; },
        setItem(key, value) { values.set(key, value); },
      },
      history: null,
      locks: {},
      channel: null,
      sharedStorage: null,
      reclaimStoredSession: true,
      ownerId: `reload-owner-${id}`,
      makeId: () => `wrong-reload-session-${id}`,
      claimRetryInterval: 0,
      claimDelay(callback) { retryCallbacks[id].push(callback); },
      claimSession: (options) => claimIndexedDbRecoverySession({
        ...options,
        openDatabase: database.openDatabase,
        now: () => timestamp,
        maxAge: 20,
      }),
    }).then((session) => {
      settled[id] = true;
      return session;
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  check(`simultaneous no-lock reloads wait before ${releaseOrder.join('-then-')} pagehide flushes`,
    !settled.a && !settled.b
      && retryCallbacks.a.length === 1
      && retryCallbacks.b.length === 1);

  const sessions = {};
  for (const id of releaseOrder) {
    await tabs[id].stop();
    await tabs[id].ownedStorage.release();
    retryCallbacks[id].shift()?.();
    sessions[id] = await pending[id];
  }

  const restored = {};
  const successorStorage = {};
  for (const id of ['a', 'b']) {
    successorStorage[id] = createIndexedDbRecoveryStorage({
      openDatabase: database.openDatabase,
      sessionId: sessions[id].sessionId,
      ownerId: sessions[id].ownerId,
      ownerEpoch: sessions[id].ownerEpoch,
      now: () => timestamp,
      maxAge: 20,
    });
    const records = await successorStorage[id].listNewest();
    restored[id] = JSON.parse(await projectText(records[0]));
  }
  check(`simultaneous ${releaseOrder.join('-then-')} handoffs restore each final authored snapshot`,
    restored.a.projectId === 'project-a'
      && restored.a.width === 24
      && restored.a.height === 18
      && restored.a.cells['2,3']?.c === 'A'
      && !restored.a.cells['7,4']
      && restored.b.projectId === 'project-b'
      && restored.b.width === 30
      && restored.b.height === 10
      && restored.b.cells['7,4']?.c === 'B'
      && !restored.b.cells['2,3']);
  await Promise.all(Object.values(successorStorage).map((storage) => storage.release()));
  Object.values(sessions).forEach((session) => session.release());
}

{
  const database = indexedDbHarness();
  const timestamp = 700;
  const writeEntered = deferred();
  const releaseWrite = deferred();
  const retryCallbacks = [];
  let delayFinalWrite = true;
  const outgoing = await startIndexedRecoveryTab(database, {
    sessionId: 'delayed-pagehide', ownerId: 'outgoing-owner', now: () => timestamp,
    wrapStorage(storage) {
      return {
        ...storage,
        async putAndPrune(...args) {
          if (delayFinalWrite) {
            delayFinalWrite = false;
            writeEntered.resolve();
            await releaseWrite.promise;
          }
          return storage.putAndPrune(...args);
        },
      };
    },
  });
  const finalProject = authoredProject('pagehide-final', 41, 17, 'F', 9, 6);
  outgoing.setProject(finalProject);
  const values = new Map([['paintty-recovery-session', 'delayed-pagehide']]);
  let settled = false;
  const pending = createBrowserRecoverySession({
    storage: {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, value); },
    },
    history: null,
    locks: {},
    channel: null,
    sharedStorage: null,
    reclaimStoredSession: true,
    ownerId: 'incoming-owner',
    makeId: () => 'wrong-delayed-session',
    claimRetryInterval: 0,
    claimDelay(callback) { retryCallbacks.push(callback); },
    claimSession: (options) => claimIndexedDbRecoverySession({
      ...options,
      openDatabase: database.openDatabase,
      now: () => timestamp,
      maxAge: 20,
    }),
  }).then((session) => {
    settled = true;
    return session;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const pagehideFlush = outgoing.stop();
  await writeEntered.promise;
  retryCallbacks.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  check('an incoming no-lock reload stays gated during a delayed pagehide flush',
    settled === false && retryCallbacks.length === 1);

  releaseWrite.resolve();
  await pagehideFlush;
  await outgoing.ownedStorage.release();
  retryCallbacks.shift()?.();
  const incoming = await pending;
  const incomingStorage = createIndexedDbRecoveryStorage({
    openDatabase: database.openDatabase,
    sessionId: incoming.sessionId,
    ownerId: incoming.ownerId,
    ownerEpoch: incoming.ownerEpoch,
    now: () => timestamp,
    maxAge: 20,
  });
  const newest = (await incomingStorage.listNewest())[0];
  let staleRejected = false;
  try {
    await outgoing.ownedStorage.putAndPrune({
      id: 'late-outgoing-write', createdAt: timestamp + 1, project: 'stale',
    });
  } catch (error) {
    staleRejected = error.message === 'Recovery session is no longer owned by this tab.';
  }
  check('the accepted pagehide snapshot wins and the old epoch cannot write after handoff',
    await projectText(newest) === finalProject
      && incoming.ownerEpoch > outgoing.claim.ownerEpoch
      && staleRejected
      && !database.records.some((record) => record.id === 'late-outgoing-write'));
  await incomingStorage.release();
  incoming.release();
}

{
  const database = indexedDbHarness();
  const timestamp = 800;
  const outgoing = await startIndexedRecoveryTab(database, {
    sessionId: 'released-before-claim', ownerId: 'first-owner', now: () => timestamp,
  });
  const finalProject = authoredProject('released-final', 19, 12, 'R', 4, 5);
  outgoing.setProject(finalProject);
  await outgoing.stop();
  await outgoing.ownedStorage.release();
  const values = new Map([['paintty-recovery-session', 'released-before-claim']]);
  const incoming = await createBrowserRecoverySession({
    storage: {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, value); },
    },
    history: null,
    locks: {},
    channel: null,
    sharedStorage: null,
    reclaimStoredSession: true,
    ownerId: 'second-owner',
    makeId: () => 'wrong-release-first-session',
    claimSession: (options) => claimIndexedDbRecoverySession({
      ...options,
      openDatabase: database.openDatabase,
      now: () => timestamp,
      maxAge: 20,
    }),
  });
  const incomingStorage = createIndexedDbRecoveryStorage({
    openDatabase: database.openDatabase,
    sessionId: incoming.sessionId,
    ownerId: incoming.ownerId,
    ownerEpoch: incoming.ownerEpoch,
    now: () => timestamp,
    maxAge: 20,
  });
  const newest = (await incomingStorage.listNewest())[0];
  check('release-before-claim preserves the same final snapshot and advances the epoch',
    await projectText(newest) === finalProject
      && incoming.ownerEpoch === outgoing.claim.ownerEpoch + 1);
  await incomingStorage.release();
  incoming.release();
}

{
  const database = indexedDbHarness();
  const timestamp = 850;
  const outgoing = await startIndexedRecoveryTab(database, {
    sessionId: 'history-fallback', ownerId: 'history-owner', now: () => timestamp,
  });
  const finalProject = authoredProject('storage-fallback-final', 22, 11, 'H', 8, 3);
  outgoing.setProject(finalProject);
  await outgoing.stop();
  await outgoing.ownedStorage.release();
  const history = {
    state: { unrelated: 'preserved', painttyRecoverySession: 'history-fallback' },
    replaceState(state) { this.state = state; },
  };
  const unavailableStorage = {
    get length() { throw new Error('storage unavailable'); },
    getItem() { throw new Error('storage unavailable'); },
    setItem() { throw new Error('storage unavailable'); },
    key() { throw new Error('storage unavailable'); },
    removeItem() { throw new Error('storage unavailable'); },
  };
  const sessionStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const historyDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'history');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() { throw new Error('session storage unavailable'); },
  });
  Object.defineProperty(globalThis, 'history', { configurable: true, value: history });
  let incoming;
  try {
    incoming = await createBrowserRecoverySession({
      locks: {},
      channel: null,
      sharedStorage: unavailableStorage,
      reclaimStoredSession: true,
      ownerId: 'history-successor',
      makeId: () => 'wrong-storage-fallback-session',
      claimSession: (options) => claimIndexedDbRecoverySession({
        ...options,
        openDatabase: database.openDatabase,
        now: () => timestamp,
      }),
    });
  } finally {
    if (sessionStorageDescriptor) {
      Object.defineProperty(globalThis, 'sessionStorage', sessionStorageDescriptor);
    } else {
      delete globalThis.sessionStorage;
    }
    if (historyDescriptor) Object.defineProperty(globalThis, 'history', historyDescriptor);
    else delete globalThis.history;
  }
  const incomingStorage = createIndexedDbRecoveryStorage({
    openDatabase: database.openDatabase,
    sessionId: incoming.sessionId,
    ownerId: incoming.ownerId,
    ownerEpoch: incoming.ownerEpoch,
    now: () => timestamp,
  });
  const newest = (await incomingStorage.listNewest())[0];
  check('history state preserves reload handoff when session and shared storage are unavailable',
    incoming.sessionId === 'history-fallback'
      && history.state.unrelated === 'preserved'
      && history.state.painttyRecoverySession === 'history-fallback'
      && await projectText(newest) === finalProject);
  await incomingStorage.release();
  incoming.release();
}

{
  const database = indexedDbHarness();
  const timestamp = 875;
  const firstClaim = await claimIndexedDbRecoverySession({
    openDatabase: database.openDatabase,
    sessionId: 'reused-owner-session',
    ownerId: 'reused-owner',
    now: () => timestamp,
  });
  const staleStorage = createIndexedDbRecoveryStorage({
    openDatabase: database.openDatabase,
    sessionId: 'reused-owner-session',
    ownerId: 'reused-owner',
    ownerEpoch: firstClaim.ownerEpoch,
    now: () => timestamp,
  });
  await staleStorage.release();
  const secondClaim = await claimIndexedDbRecoverySession({
    openDatabase: database.openDatabase,
    sessionId: 'reused-owner-session',
    ownerId: 'reused-owner',
    now: () => timestamp,
  });
  const currentStorage = createIndexedDbRecoveryStorage({
    openDatabase: database.openDatabase,
    sessionId: 'reused-owner-session',
    ownerId: 'reused-owner',
    ownerEpoch: secondClaim.ownerEpoch,
    now: () => timestamp,
  });
  let staleRejected = false;
  try {
    await staleStorage.putAndPrune({ id: 'reused-owner-stale', createdAt: 1, project: 'stale' });
  } catch {
    staleRejected = true;
  }
  check('owner epoch rejects stale writes even if an owner token is accidentally reused',
    secondClaim.ownerEpoch === firstClaim.ownerEpoch + 1
      && staleRejected
      && !database.records.some((record) => record.id === 'reused-owner-stale'));
  await currentStorage.release();
}

{
  const database = indexedDbHarness();
  let clock = 900;
  const outgoing = await startIndexedRecoveryTab(database, {
    sessionId: 'crashed-session', ownerId: 'crashed-owner', now: () => clock,
    maxAge: 20,
  });
  const crashedProject = authoredProject('before-crash', 33, 9, 'C', 3, 2);
  outgoing.setProject(crashedProject);
  await outgoing.controller.flush();
  const values = new Map([['paintty-recovery-session', 'crashed-session']]);
  const incoming = await createBrowserRecoverySession({
    storage: {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, value); },
    },
    history: null,
    locks: {},
    channel: null,
    sharedStorage: null,
    reclaimStoredSession: true,
    ownerId: 'post-crash-owner',
    makeId: () => 'wrong-crash-session',
    claimRetryInterval: 20,
    claimDelay(callback, ms) {
      clock += ms;
      queueMicrotask(callback);
    },
    claimSession: (options) => claimIndexedDbRecoverySession({
      ...options,
      openDatabase: database.openDatabase,
      now: () => clock,
      maxAge: 20,
    }),
  });
  const incomingStorage = createIndexedDbRecoveryStorage({
    openDatabase: database.openDatabase,
    sessionId: incoming.sessionId,
    ownerId: incoming.ownerId,
    ownerEpoch: incoming.ownerEpoch,
    now: () => clock,
    maxAge: 20,
  });
  const newest = (await incomingStorage.listNewest())[0];
  let staleRejected = false;
  try {
    await outgoing.ownedStorage.heartbeat();
  } catch {
    staleRejected = true;
  }
  check('a crashed owner expires at the lease bound without admitting a later stale heartbeat',
    clock === 920
      && incoming.ownerEpoch === outgoing.claim.ownerEpoch + 1
      && await projectText(newest) === crashedProject
      && staleRejected);
  await outgoing.stop();
  await incomingStorage.release();
  incoming.release();
}

{
  const database = indexedDbHarness();
  let failFirstWrite = true;
  const tabA = await startIndexedRecoveryTab(database, {
    sessionId: 'failed-a', ownerId: 'failed-owner-a', now: () => 1000,
    wrapStorage(storage) {
      return {
        ...storage,
        async putAndPrune(...args) {
          if (failFirstWrite) {
            failFirstWrite = false;
            throw new Error('forced first write failure');
          }
          return storage.putAndPrune(...args);
        },
      };
    },
  });
  const tabB = await startIndexedRecoveryTab(database, {
    sessionId: 'failed-b', ownerId: 'failed-owner-b', now: () => 1000,
  });
  tabA.setProject(authoredProject('failed-project-a', 24, 18, 'A', 2, 3));
  tabB.setProject(authoredProject('failed-project-b', 30, 10, 'B', 7, 4));
  await Promise.all([tabA.controller.flush(), tabB.controller.flush()]);
  await tabA.stop();
  await tabA.ownedStorage.release();
  const reloadedA = await startIndexedRecoveryTab(database, {
    sessionId: 'failed-a', ownerId: 'failed-reload-a', now: () => 1000,
  });
  const restored = JSON.parse(reloadedA.getProject());
  check('a failed first write leaves its reload blank instead of adopting a live tab',
    get(tabA.state).state === 'error'
      && restored.projectId === 'default'
      && restored.projectId !== 'failed-project-b'
      && !restored.cells['7,4']);
  await Promise.all([tabB.stop(), reloadedA.stop()]);
  await Promise.all([tabB.ownedStorage.release(), reloadedA.ownedStorage.release()]);
}

{
  const database = indexedDbHarness([
    { id: 'history-1', sessionId: 'history-1', createdAt: 1, project: 'history 1' },
    { id: 'history-2', sessionId: 'history-2', createdAt: 2, project: 'history 2' },
    { id: 'history-3', sessionId: 'history-3', createdAt: 3, project: 'history 3' },
  ]);
  const tabA = await startIndexedRecoveryTab(database, {
    sessionId: 'prune-a', ownerId: 'prune-owner-a', now: () => 900,
    storage: { historyLimit: 2 }, controller: { limit: 1 },
  });
  const tabB = await startIndexedRecoveryTab(database, {
    sessionId: 'prune-b', ownerId: 'prune-owner-b', now: () => 900,
    storage: { historyLimit: 2 }, controller: { limit: 1 },
  });
  for (const revision of [1, 2]) {
    tabA.setProject(`prune a ${revision}`);
    tabB.setProject(`prune b ${revision}`);
    await Promise.all([tabA.controller.flush(), tabB.controller.flush()]);
  }
  const snapshots = database.records.filter((record) => record?.project != null);
  const sessionCounts = (sessionId) => snapshots.filter((record) => record.sessionId === sessionId).length;
  check('atomic pruning bounds abandoned history without deleting either live session',
    sessionCounts('prune-a') === 1
      && sessionCounts('prune-b') === 1
      && snapshots.filter((record) => record.sessionId.startsWith('history-')).length === 2
      && snapshots.length === 4);
  await Promise.all([tabA.stop(), tabB.stop()]);
  await Promise.all([tabA.ownedStorage.release(), tabB.ownedStorage.release()]);
}

{
  const claimEntered = deferred();
  const releaseClaim = deferred();
  const values = new Map();
  let settled = false;
  const pending = createBrowserRecoverySession({
    storage: {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, value); },
    },
    locks: {},
    channel: null,
    sharedStorage: null,
    ownerId: 'startup-owner',
    makeId: () => 'startup-session',
    async claimSession(claim) {
      claimEntered.resolve(claim);
      await releaseClaim.promise;
      return { claimed: true };
    },
  }).then((session) => {
    settled = true;
    return session;
  });
  const claim = await claimEntered.promise;
  await new Promise((resolve) => setImmediate(resolve));
  check('startup cannot report readiness before its durable session claim settles',
    settled === false
      && values.get('paintty-recovery-session') == null
      && claim.sessionId === 'startup-session');
  releaseClaim.resolve();
  const session = await pending;
  check('startup publishes its session only after the claim is ready',
    session.sessionId === 'startup-session'
      && values.get('paintty-recovery-session') === 'startup-session');
  session.release();
}

{
  const database = indexedDbHarness();
  let clock = 1000;
  const atomicClaims = new Map();
  for (const [sessionId, ownerId] of [['atomic-a', 'atomic-owner-a'], ['atomic-b', 'atomic-owner-b']]) {
    atomicClaims.set(sessionId, await claimIndexedDbRecoverySession({
      openDatabase: database.openDatabase,
      sessionId,
      ownerId,
      now: () => clock,
    }));
  }
  const storageA = createIndexedDbRecoveryStorage({
    openDatabase: database.openDatabase,
    sessionId: 'atomic-a',
    ownerId: 'atomic-owner-a',
    ownerEpoch: atomicClaims.get('atomic-a').ownerEpoch,
    now: () => ++clock,
    historyLimit: 1,
  });
  const storageB = createIndexedDbRecoveryStorage({
    openDatabase: database.openDatabase,
    sessionId: 'atomic-b',
    ownerId: 'atomic-owner-b',
    ownerEpoch: atomicClaims.get('atomic-b').ownerEpoch,
    now: () => ++clock,
    historyLimit: 1,
  });
  const [, , listedA] = await Promise.all([
    storageA.putAndPrune({ id: 'atomic-snapshot-a', createdAt: 1, project: 'A' }, 1),
    storageB.putAndPrune({ id: 'atomic-snapshot-b', createdAt: 1, project: 'B' }, 1),
    storageA.listNewest(),
    storageB.heartbeat(),
  ]);
  const snapshots = database.records.filter((record) => record?.project != null);
  check('concurrent put, prune, list, and heartbeat transactions retain both owners',
    listedA.length === 1
      && listedA[0].sessionId === 'atomic-a'
      && snapshots.some((record) => record.id === 'atomic-snapshot-a')
      && snapshots.some((record) => record.id === 'atomic-snapshot-b'));
  await Promise.all([storageA.release(), storageB.release()]);
}

for (const outgoingLockVisible of [true, false]) {
  const database = indexedDbHarness();
  let clock = 1100;
  const outgoingClaim = await claimIndexedDbRecoverySession({
    openDatabase: database.openDatabase,
    sessionId: 'reload-session',
    ownerId: 'outgoing-owner',
    now: () => clock,
  });
  const outgoingStorage = createIndexedDbRecoveryStorage({
    openDatabase: database.openDatabase,
    sessionId: 'reload-session',
    ownerId: 'outgoing-owner',
    ownerEpoch: outgoingClaim.ownerEpoch,
    now: () => clock,
  });
  await outgoingStorage.putAndPrune({
    id: 'snapshot-before-reload',
    createdAt: clock,
    project: 'authored before reload',
  });
  const waiters = new Map();
  const held = new Set(outgoingLockVisible ? ['paintty-recovery:reload-session'] : []);
  const locks = {
    async query() {
      return { held: [...held].map((name) => ({ name })) };
    },
    request(name, options, callback) {
      if (options.ifAvailable && held.has(name)) return Promise.resolve(callback(null));
      const acquire = held.has(name)
        ? new Promise((resolve) => waiters.set(name, resolve))
        : Promise.resolve();
      return acquire.then(async () => {
        held.add(name);
        try {
          return await callback({ name });
        } finally {
          held.delete(name);
        }
      });
    },
  };
  const storage = {
    getItem() { return 'reload-session'; },
    setItem() {},
  };
  let claimAttempts = 0;
  let settled = false;
  const pending = createBrowserRecoverySession({
    storage,
    history: null,
    locks,
    channel: null,
    sharedStorage: null,
    reclaimStoredSession: true,
    ownerId: 'incoming-owner',
    makeId: () => 'wrong-new-session',
    claimRetryInterval: 6000,
    claimDelay(callback, ms) {
      clock += ms;
      queueMicrotask(callback);
    },
    claimSession(options) {
      claimAttempts++;
      return claimIndexedDbRecoverySession({
        ...options,
        openDatabase: database.openDatabase,
        now: () => clock,
      });
    },
  }).then((session) => {
    settled = true;
    return session;
  });
  if (outgoingLockVisible) {
    await new Promise((resolve) => setImmediate(resolve));
    check('a concurrent reload waits for the outgoing Web Lock before reclaiming its session',
      settled === false);
    held.delete('paintty-recovery:reload-session');
    waiters.get('paintty-recovery:reload-session')?.();
    waiters.delete('paintty-recovery:reload-session');
  }
  const session = await pending;
  const incomingStorage = createIndexedDbRecoveryStorage({
    openDatabase: database.openDatabase,
    sessionId: session.sessionId,
    ownerId: session.ownerId,
    ownerEpoch: session.ownerEpoch,
    now: () => clock,
  });
  const records = await incomingStorage.listNewest();
  check(`an ${outgoingLockVisible ? 'observed' : 'already released'} Web Lock confirms handoff without lease expiry`,
    claimAttempts === 1 && clock === 1100);
  check(`the exact same session claim lists its pre-reload snapshot after ${outgoingLockVisible ? 'queued' : 'immediate'} lock acquisition`,
    session.sessionId === 'reload-session'
      && records.length === 1
      && records[0].id === 'snapshot-before-reload'
      && await projectText(records[0]) === 'authored before reload');
  await incomingStorage.release();
  session.release();
}

{
  const held = new Set(['paintty-recovery:active-session']);
  const locks = {
    async query() {
      return { held: [...held].map((name) => ({ name })) };
    },
    request(name, options, callback) {
      const lock = options.ifAvailable && held.has(name) ? null : { name };
      if (lock) held.add(name);
      return Promise.resolve(callback(lock)).finally(() => {
        if (lock) held.delete(name);
      });
    },
  };
  const values = new Map([['paintty-recovery-session', 'active-session']]);
  const storage = {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, value); },
  };
  const session = await createBrowserRecoverySession({
    storage,
    locks,
    makeId: () => 'new-session',
  });
  check('a second tab cannot claim the recovery session held by a live tab',
    session.sessionId === 'new-session'
      && session.activeSessionIds.includes('active-session')
      && values.get('paintty-recovery-session') === 'new-session');
  held.add('paintty-recovery:later-session');
  const activeNow = await session.getActiveSessionIds();
  check('a recovery session discovers tabs opened after its own startup',
    activeNow.includes('active-session')
      && activeNow.includes('later-session')
      && !activeNow.includes('new-session'));
  session.release();
}

{
  const held = new Set();
  const locks = {
    async query() { return { held: [] }; },
    request(name, options, callback) {
      const lock = options.ifAvailable && held.has(name) ? null : { name };
      if (lock) held.add(name);
      return Promise.resolve(callback(lock)).finally(() => {
        if (lock) held.delete(name);
      });
    },
  };
  const storage = {
    getItem() { return 'resume-session'; },
    setItem() {},
  };
  const session = await createBrowserRecoverySession({ storage, locks });
  check('a reload reclaims its existing abandoned recovery session',
    session.sessionId === 'resume-session');
  session.release();
}

{
  const hub = broadcastHarness();
  const firstValues = new Map();
  const firstStorage = {
    getItem(key) { return firstValues.get(key) || null; },
    setItem(key, value) { firstValues.set(key, value); },
  };
  const waitForMessages = (resolve) => queueMicrotask(resolve);
  const claimRetries = [];
  let handoffReleased = false;
  const first = await createBrowserRecoverySession({
    storage: firstStorage,
    locks: {},
    channel: hub.open(),
    presenceWait: 0,
    delay: waitForMessages,
    makeId: () => 'shared-session',
  });
  let reloadSettled = false;
  const pendingReload = createBrowserRecoverySession({
    storage: firstStorage,
    locks: {},
    channel: hub.open(),
    presenceWait: 0,
    delay: waitForMessages,
    reclaimStoredSession: true,
    makeId: () => 'wrong-broadcast-reload-session',
    claimRetryInterval: 0,
    claimDelay(callback) { claimRetries.push(callback); },
    async claimSession() {
      return handoffReleased
        ? { claimed: true, ownerEpoch: 2 }
        : { claimed: false, ownerEpoch: null };
    },
  }).then((session) => {
    reloadSettled = true;
    return session;
  });
  await new Promise((resolve) => setImmediate(resolve));
  check('BroadcastChannel reload stays gated behind the durable owner',
    reloadSettled === false && claimRetries.length === 1);
  handoffReleased = true;
  first.release();
  claimRetries.shift()?.();
  const reloaded = await pendingReload;
  check('BroadcastChannel fallback preserves identity after durable handoff',
    reloaded.sessionId === 'shared-session' && reloaded.ownerEpoch === 2);
  const clonedValues = new Map(firstValues);
  const clonedStorage = {
    getItem(key) { return clonedValues.get(key) || null; },
    setItem(key, value) { clonedValues.set(key, value); },
  };
  const second = await createBrowserRecoverySession({
    storage: clonedStorage,
    locks: {},
    channel: hub.open(),
    presenceWait: 0,
    delay: waitForMessages,
    makeId: () => 'second-session',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const reloadedSees = await reloaded.getActiveSessionIds();
  check('BroadcastChannel isolates a cloned tab when Web Locks are unavailable',
    first.sessionId === 'shared-session'
      && second.sessionId === 'second-session'
      && second.activeSessionIds.includes('shared-session')
      && reloadedSees.includes('second-session'));
  second.release();
  reloaded.release();
}

{
  const sharedStorage = webStorageHarness();
  const firstValues = new Map();
  const firstStorage = {
    getItem(key) { return firstValues.get(key) || null; },
    setItem(key, value) { firstValues.set(key, value); },
  };
  const claimRetries = [];
  let handoffReleased = false;
  const first = await createBrowserRecoverySession({
    storage: firstStorage,
    sharedStorage,
    locks: {},
    channel: null,
    heartbeatMaxAge: 20,
    heartbeatInterval: 5,
    makeId: () => 'heartbeat-session',
  });
  let reloadSettled = false;
  const pendingReload = createBrowserRecoverySession({
    storage: firstStorage,
    sharedStorage,
    locks: {},
    channel: null,
    heartbeatMaxAge: 20,
    heartbeatInterval: 5,
    reclaimStoredSession: true,
    makeId: () => 'wrong-heartbeat-reload-session',
    claimRetryInterval: 0,
    claimDelay(callback) { claimRetries.push(callback); },
    async claimSession() {
      return handoffReleased
        ? { claimed: true, ownerEpoch: 2 }
        : { claimed: false, ownerEpoch: null };
    },
  }).then((session) => {
    reloadSettled = true;
    return session;
  });
  await new Promise((resolve) => setImmediate(resolve));
  check('shared-storage reload stays gated behind the durable owner',
    reloadSettled === false && claimRetries.length === 1);
  handoffReleased = true;
  first.release();
  claimRetries.shift()?.();
  const reloaded = await pendingReload;
  check('shared-storage fallback preserves identity after durable handoff',
    reloaded.sessionId === 'heartbeat-session' && reloaded.ownerEpoch === 2);
  const clonedValues = new Map(firstValues);
  const clonedStorage = {
    getItem(key) { return clonedValues.get(key) || null; },
    setItem(key, value) { clonedValues.set(key, value); },
  };
  const second = await createBrowserRecoverySession({
    storage: clonedStorage,
    sharedStorage,
    locks: {},
    channel: null,
    heartbeatMaxAge: 20,
    heartbeatInterval: 5,
    makeId: () => 'heartbeat-second',
  });
  const reloadedSees = await reloaded.getActiveSessionIds();
  check('shared-storage heartbeats isolate tabs without Web Locks or BroadcastChannel',
    first.sessionId === 'heartbeat-session'
      && second.sessionId === 'heartbeat-second'
      && second.activeSessionIds.includes('heartbeat-session')
      && reloadedSees.includes('heartbeat-second'));
  second.release();
  reloaded.release();
}

{
  const original = {
    contents: serializeJSON(),
    fileName: get(fileName),
    activeFrame: get(activeFrameIndex),
  };
  const layerId = deterministicUuid('layer', 918);
  const trackId = deterministicUuid('track', 918);
  const clipId = deterministicUuid('clip', 918);
  const storage = memoryStorage();
  try {
    const layer = {
      id: layerId,
      name: 'Recovery visibility',
      type: 'cell',
      visible: true,
      cells: { '0,0': { c: 'V', fg: '#ffffff', bg: null } },
      offset: { x: 0, y: 0 },
    };
    loadCanonicalTimeline({
      fps: 24,
      tags: [],
      tracks: [{ id: trackId, kind: 'visual', locked: false, layer }],
      clips: [{
        id: clipId,
        trackId,
        kind: 'visual',
        startTick: 0,
        inTick: 0,
        outTick: 20,
        sourceDuration: 20,
        frameKeys: [{ tick: 0, value: { cells: layer.cells } }],
        propertyTracks: {},
      }],
    });
    resetEditorStateForProjectLoad();
    seekTick(0);
    check('visibility recovery fixture enables its true key at tick zero',
      setVisibilityTrackEnabled(layerId, true));
    check('visibility recovery fixture authors hidden tick twelve',
      setVisibilityKey(layerId, 12, false));
    check('visibility recovery fixture authors visible tick eighteen',
      setVisibilityKey(layerId, 18, true));
    check('later clip editing extends the keyed clip', trimClip(clipId, 'end', 24)?.changed === true);
    check('later tag editing follows the visibility keys',
      addCustomTimelineTag(23, 'after-visibility')?.changed === true);

    const outgoing = createRecoveryController({
      storage,
      serialize: serializeJSON,
      restore: restoreProject,
      contentStores: [],
      nameStore: fileName,
      activeFrameStore: activeFrameIndex,
      dirtyStore: dirty,
    });
    await outgoing.checkpoint(serializeJSON(), 'visibility-recovery.paintty');

    loadCanonicalTimeline({ fps: 24, tracks: [], clips: [], tags: [] });
    resetEditorStateForProjectLoad();
    const incoming = createRecoveryController({
      storage,
      serialize: serializeJSON,
      restore: restoreProject,
      contentStores: [],
      nameStore: fileName,
      activeFrameStore: activeFrameIndex,
      dirtyStore: dirty,
    });
    const recovered = await incoming.restoreLatest();
    const recoveredState = getClipTimelineState();
    const recoveredClip = recoveredState.clips.find((clip) => clip.id === clipId);
    check('checkpoint reload preserves every visibility key after later clip and tag edits',
      recovered?.fileName === 'visibility-recovery.paintty'
        && JSON.stringify(visibilityKeys(layerId)) === JSON.stringify([
          { frame: 0, visible: true },
          { frame: 12, visible: false },
          { frame: 18, visible: true },
        ])
        && visibilityAt(layerId, 0) === true
        && visibilityAt(layerId, 12) === false
        && visibilityAt(layerId, 18) === true
        && recoveredClip?.outTick === 24
        && recoveredState.tags.some((tag) => (
          tag.tick === 23 && tag.type === 'custom' && tag.value === 'after-visibility'
        )));
  } finally {
    restoreProject(original.contents, original);
  }
}

{
  const original = {
    contents: serializeJSON(),
    fileName: get(fileName),
    activeFrame: get(activeFrameIndex),
  };
  addLayer('cell');
  const project = JSON.parse(serializeJSON());
  const visualTracks = project.timeline.tracks.filter((track) => track.kind !== 'audio');
  const firstLayerId = visualTracks[0].layer.id;
  const secondLayerId = visualTracks[1].layer.id;
  const openLoopId = deterministicUuid('tag', 901);
  project.timeline.tags = [{ id: openLoopId, tick: 0, type: 'loop-start' }];
  visualTracks.reverse();
  project.timeline.tracks = [
    ...visualTracks,
    ...project.timeline.tracks.filter((track) => track.kind === 'audio'),
  ];
  restoreProject(JSON.stringify(project), {
    fileName: 'two-layers.json',
    activeFrame: 0,
    context: {
      activeLayerId: firstLayerId,
      activeLayerPart: 'layer',
      selectedLayerIds: [firstLayerId, secondLayerId],
    },
  });
  const restoredLayers = get(layers);
  check('real recovery restores active and multi-selected layer UUIDs after reorder',
    get(activeLayerId) === firstLayerId
      && restoredLayers[1].id === firstLayerId
      && get(activeLayerPart) === 'layer'
      && get(selectedLayerIds).has(firstLayerId)
      && get(selectedLayerIds).has(secondLayerId));
  check('real recovery preserves a start-only loop marker and authoring identity',
    getClipTimelineState().tags.length === 1
      && getClipTimelineState().tags[0].id === openLoopId
      && getClipTimelineState().tags[0].type === 'loop-start'
      && JSON.parse(serializeJSON()).timeline.tags[0].id === openLoopId);

  const zeroLayerProject = JSON.parse(original.contents);
  zeroLayerProject.timeline.tracks = zeroLayerProject.timeline.tracks
    .filter((track) => track.kind === 'audio');
  const retainedTrackIds = new Set(zeroLayerProject.timeline.tracks.map((track) => track.id));
  zeroLayerProject.timeline.clips = zeroLayerProject.timeline.clips
    .filter((clip) => retainedTrackIds.has(clip.trackId));
  restoreProject(JSON.stringify(zeroLayerProject), {
    fileName: 'empty.json',
    activeFrame: 0,
    context: {
      activeLayerId: null,
      activeLayerPart: 'mask',
      selectedLayerIds: [firstLayerId],
    },
  });
  check('zero-layer recovery clears every layer-selection store',
    get(activeLayerId) == null
      && get(activeLayerPart) === 'layer'
      && get(selectedLayerIds).size === 0);

  activeLayerId.set(999_999);
  activeLayerPart.set('mask');
  selectedLayerIds.set(new Set([999_999]));
  restoreProject(original.contents, {
    fileName: original.fileName,
    activeFrame: original.activeFrame,
  });
  const contextlessLayers = get(layers);
  check('context-less recovery repairs dangling layer selection safely',
    contextlessLayers.some((layer) => layer.id === get(activeLayerId))
      && get(activeLayerPart) === 'layer'
      && get(selectedLayerIds).size === 1
      && get(selectedLayerIds).has(get(activeLayerId)));

  const audioRecoveryProject = JSON.parse(original.contents);
  const recoveryAssetId = deterministicUuid('asset', 901);
  const recoveryTrackId = deterministicUuid('track', 901);
  const recoveryClipId = deterministicUuid('clip', 901);
  const recoveryHash = '9'.repeat(64);
  audioRecoveryProject.media.assets.push({
    assetId: recoveryAssetId,
    hash: recoveryHash,
    path: `assets/sha256/99/${recoveryHash}`,
    sourceName: 'recovery.wav',
    mime: 'audio/wav',
    size: 4,
    kind: 'audio',
    duration: 1,
    generation: 1,
  });
  audioRecoveryProject.media.generation++;
  audioRecoveryProject.timeline.tracks.push({
    id: recoveryTrackId,
    kind: 'audio',
    name: 'Recovery audio',
    locked: false,
  });
  audioRecoveryProject.timeline.clips.push({
    id: recoveryClipId,
    trackId: recoveryTrackId,
    kind: 'audio',
    startTick: 5,
    inTick: 0,
    outTick: 12,
    sourceDuration: 12,
    frameKeys: [],
    propertyTracks: {},
    assetId: recoveryAssetId,
    inPoint: 0.25,
    outPoint: 0.75,
    volume: 0.5,
    muted: false,
  });
  restoreProject(JSON.stringify(audioRecoveryProject), {
    fileName: 'audio-recovery.paintty',
    activeFrame: 0,
  });
  await Promise.resolve();
  const recoveredAudio = get(audioClips)[0];
  check('real recovery restores canonical audio placement without runtime media',
    recoveredAudio?.id === recoveryClipId
      && recoveredAudio.startTick === 5
      && recoveredAudio.inPoint === 0.25
      && recoveredAudio.outPoint === 0.75
      && get(canonicalDurationTicks) === 5 + Math.ceil(0.5 * audioRecoveryProject.fps)
      && !JSON.stringify(recoveredAudio).includes('buffer'));

  setClipSelection({ clipIds: [recoveryClipId] });
  const deletedAudio = deleteClipSelection();
  const deletedAudioRecovery = serializeJSON();
  const deletedAudioProject = JSON.parse(deletedAudioRecovery);
  check('contextual audio deletion retains its final-use project asset',
    deletedAudio.changed
      && deletedAudio.removedClips === 1
      && deletedAudio.removedTrackIds?.[0] === recoveryTrackId
      && !deletedAudioProject.timeline.tracks.some((track) => track.id === recoveryTrackId)
      && deletedAudioProject.media.assets.some((asset) => asset.assetId === recoveryAssetId));

  restoreProject(deletedAudioRecovery, {
    fileName: 'deleted-audio-recovery.paintty',
    activeFrame: 0,
  });
  await Promise.resolve();
  const recoveredVisualDuration = Math.max(1, ...deletedAudioProject.timeline.clips.map((clip) =>
    clip.startTick + clip.outTick - clip.inTick));
  check('recovery round-trip keeps the final audio clip and its empty row deleted',
    get(audioClips).length === 0
      && get(canonicalDurationTicks) === Math.max(1, recoveredVisualDuration));

  restoreProject(original.contents, {
    ...original,
    context: {
      activeLayerId: JSON.parse(original.contents).timeline.tracks
        .find((track) => track.layer)?.layer.id ?? null,
      activeLayerPart: 'layer',
      selectedLayerIds: JSON.parse(original.contents).timeline.tracks
        .flatMap((track) => track.layer ? [track.layer.id] : []).slice(0, 1),
    },
  });
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
