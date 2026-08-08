import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import {
  openPainttyDatabase,
  PAINTTY_DB_NAME,
  PAINTTY_DB_VERSION,
  RECENT_PROJECT_STORE,
} from '../src/lib/browserDb.js';
import {
  clearRecentProjects,
  newestRecentProjects,
  recentProjectRecord,
  recentProjects,
  startRecentProjectTracking,
} from '../src/lib/recentProjects.js';

const alpha = recentProjectRecord({
  recentId: 'alpha-one',
  fileName: 'Alpha.json',
  contents: '{"format":"paintty-sprite"}',
}, 10);
assert.deepEqual(alpha, {
  id: 'alpha-one',
  name: 'Alpha.json',
  contents: '{"format":"paintty-sprite"}',
  openedAt: 10,
});
assert.equal(recentProjectRecord({ fileName: '', contents: '{}' }, 10), null);

assert.deepEqual(
  newestRecentProjects([
    alpha,
    { ...alpha, name: 'ALPHA.json', contents: '{"new":true}', openedAt: 30 },
    {
      id: 'alpha-two', name: 'Alpha.json',
      contents: '{"different-folder":true}', openedAt: 25,
    },
    { id: 'beta.json', name: 'Beta.json', contents: '{}', openedAt: 20 },
    { id: 'broken', name: '', contents: '{}', openedAt: 40 },
  ], 3).map(({ name, contents }) => ({ name, contents })),
  [
    { name: 'ALPHA.json', contents: '{"new":true}' },
    { name: 'Alpha.json', contents: '{"different-folder":true}' },
    { name: 'Beta.json', contents: '{}' },
  ],
);

let loadedListener;
let savedListener;
let stopped = 0;
const writes = [];
const storage = {
  records: [{ id: 'old.json', name: 'Old.json', contents: '{}', openedAt: 1 }],
  async list() { return newestRecentProjects(this.records); },
  async put(record) {
    writes.push(record);
    this.records = newestRecentProjects([...this.records, record]);
  },
};
const tracking = startRecentProjectTracking({
  storage,
  now: () => 50,
  onLoaded(listener) {
    loadedListener = listener;
    return () => { stopped++; };
  },
  onSaved(listener) {
    savedListener = listener;
    return () => { stopped++; };
  },
  reportError(error) {
    throw error;
  },
});
await tracking.ready;
assert.deepEqual(get(recentProjects).map((item) => item.name), ['Old.json']);

const taggedContents = '{"timeline":{"tags":[{"id":"10000000-0000-4000-8000-000000000001","tick":0,"type":"custom","value":"世界"}]}}';
await loadedListener({ recentId: 'opened', fileName: 'Opened.json', contents: taggedContents });
await savedListener({ recentId: 'saved', fileName: 'Saved.json', contents: '{"saved":true}' });
assert.deepEqual(writes.map((item) => item.name), ['Opened.json', 'Saved.json']);
assert.equal(writes[0].contents, taggedContents, 'recent snapshots preserve exact sequence tag IDs');
assert.deepEqual(get(recentProjects).map((item) => item.name), ['Opened.json', 'Saved.json', 'Old.json']);

tracking.stop();
assert.equal(stopped, 2);

const createdStores = [];
const deletedStores = [];
let openedDatabase;
let openedVersion;
const migratedDatabase = {
  objectStoreNames: {
    contains(name) {
      return name !== RECENT_PROJECT_STORE;
    },
  },
  createObjectStore(name, options) {
    createdStores.push({ name, options });
  },
  deleteObjectStore(name) {
    deletedStores.push(name);
  },
  close() {},
};
const migrationFactory = {
  open(name, version) {
    openedDatabase = name;
    openedVersion = version;
    const request = { result: migratedDatabase };
    queueMicrotask(() => {
      request.onupgradeneeded();
      request.onsuccess();
    });
    return request;
  },
};
const opened = await openPainttyDatabase(migrationFactory);
assert.equal(opened, migratedDatabase);
assert.equal(openedDatabase, PAINTTY_DB_NAME);
assert.equal(openedVersion, PAINTTY_DB_VERSION);
assert.deepEqual(deletedStores, ['project-assets']);
assert.deepEqual(createdStores, [{
  name: RECENT_PROJECT_STORE,
  options: { keyPath: 'id' },
}]);

let resolveOlderRead;
let raceLoadedListener;
let readCount = 0;
const raceStorage = {
  async list() {
    readCount++;
    if (readCount === 1) {
      return new Promise((resolve) => { resolveOlderRead = resolve; });
    }
    return [{ id: 'new', name: 'New.json', contents: '{}', openedAt: 80 }];
  },
  async put() {},
};
const raced = startRecentProjectTracking({
  storage: raceStorage,
  onLoaded(listener) {
    raceLoadedListener = listener;
    return () => {};
  },
  onSaved() {
    return () => {};
  },
  now: () => 80,
  reportError(error) {
    throw error;
  },
});
await raceLoadedListener({
  recentId: 'new',
  fileName: 'New.json',
  contents: '{}',
});
assert.deepEqual(get(recentProjects).map((item) => item.name), ['New.json']);
resolveOlderRead([{ id: 'old', name: 'Old.json', contents: '{}', openedAt: 1 }]);
await raced.ready;
assert.deepEqual(get(recentProjects).map((item) => item.name), ['New.json']);
raced.stop();

let clearCalls = 0;
recentProjects.set([{ id: 'clear-me', name: 'Clear.json', contents: '{}', openedAt: 1 }]);
assert.equal(await clearRecentProjects({
  async clear() { clearCalls++; },
}), true);
assert.equal(clearCalls, 1);
assert.deepEqual(get(recentProjects), []);

let resolveClearRaceRead;
const clearRaceStorage = {
  async list() {
    return new Promise((resolve) => { resolveClearRaceRead = resolve; });
  },
  async clear() {},
};
const clearRaced = startRecentProjectTracking({
  storage: clearRaceStorage,
  onLoaded() { return () => {}; },
  onSaved() { return () => {}; },
  reportError(error) { throw error; },
});
await clearRecentProjects(clearRaceStorage);
resolveClearRaceRead([{ id: 'stale', name: 'Stale.json', contents: '{}', openedAt: 1 }]);
await clearRaced.ready;
assert.deepEqual(get(recentProjects), []);
clearRaced.stop();

console.log('recent project tests passed');
