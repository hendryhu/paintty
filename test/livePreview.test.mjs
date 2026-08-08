import assert from 'node:assert/strict';
import { get, writable } from 'svelte/store';
import {
  PREVIEW_HEARTBEAT_MS,
  PREVIEW_WRITE_MAX_DELAY_MS,
  createPreviewSync,
  previewPath,
  sessionMarkerPath,
  writePreview,
} from '../src/lib/livePreview.js';
import { serializeLivePreview } from '../src/lib/fileio.js';
import { initTimeline, loadCanonicalTimeline } from '../src/lib/frames.js';

function virtualFolder({ initial = {}, failClose = null, name = 'watch-fixture' } = {}) {
  const files = new Map(Object.entries(initial));
  const directories = new Set(['']);
  const events = [];
  let failedPath = failClose;

  for (const path of files.keys()) {
    const parts = path.split('/');
    parts.pop();
    let directory = '';
    for (const part of parts) {
      directory = directory ? directory + '/' + part : part;
      directories.add(directory);
    }
  }

  function join(parent, child) {
    return parent ? parent + '/' + child : child;
  }

  function fileHandle(path) {
    return {
      async createWritable() {
        events.push('open:' + path);
        let pending = '';
        return {
          async write(contents) {
            events.push('write:' + path);
            pending = contents;
          },
          async close() {
            events.push('close:' + path);
            if (path === failedPath) throw new Error('cannot commit ' + path);
            files.set(path, pending);
          },
        };
      },
      async getFile() {
        if (!files.has(path)) throw new Error('missing file ' + path);
        return { text: async () => files.get(path) };
      },
    };
  }

  function directoryHandle(path) {
    return {
      name: path ? path.split('/').at(-1) : name,
      async getDirectoryHandle(child, options = {}) {
        const target = join(path, child);
        events.push('directory:' + target + ':' + (options.create === true));
        if (!directories.has(target)) {
          if (!options.create) throw new Error('missing directory ' + target);
          directories.add(target);
        }
        return directoryHandle(target);
      },
      async getFileHandle(child, options = {}) {
        const target = join(path, child);
        events.push('file:' + target + ':' + (options.create === true));
        if (!files.has(target) && !options.create) throw new Error('missing file ' + target);
        return fileHandle(target);
      },
      async removeEntry(child) {
        const target = join(path, child);
        events.push('remove:' + target);
        if (!files.delete(target)) throw new Error('missing file ' + target);
      },
    };
  }

  return {
    root: directoryHandle(''),
    files,
    events,
    setFailClose(path) { failedPath = path; },
  };
}

function fakeTimers() {
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(callback, delay) {
      const id = nextId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    timeoutDelays() {
      return [...timeouts.values()].map((timer) => timer.delay);
    },
    timeoutCount(delay) {
      return [...timeouts.values()].filter((timer) => timer.delay === delay).length;
    },
    runTimeout(delay) {
      const entry = [...timeouts.entries()].find(([, timer]) => timer.delay === delay);
      if (!entry) throw new Error('missing timeout ' + delay);
      timeouts.delete(entry[0]);
      return entry[1].callback();
    },
    interval() {
      return [...intervals.values()][0];
    },
    get intervalCount() {
      return intervals.size;
    },
  };
}

assert.equal(
  previewPath('boss:phase?.json', 'tab-a'),
  '.paintty-preview/previews/tab-a-boss_phase_.json',
);
assert.equal(
  previewPath('...', 'tab-a'),
  '.paintty-preview/previews/tab-a-untitled.json',
);
assert.equal(
  sessionMarkerPath('tab-a'),
  '.paintty-preview/sessions/tab-a.json',
);

{
  const fs = virtualFolder();
  const project = serializeLivePreview();
  const path = await writePreview(fs.root, 'first.json', project, {
    sessionId: 'tab-a',
    playheadTick: 4,
    updatedAt: 1234,
  });

  assert.equal(path, '.paintty-preview/previews/tab-a-first.json');
  assert.deepEqual(JSON.parse(fs.files.get(path)), JSON.parse(project));
  assert.deepEqual(Object.keys(JSON.parse(project)).sort(), [
    'format', 'fps', 'height', 'tags', 'ticks', 'version', 'width',
  ]);
  assert.deepEqual(JSON.parse(project).tags, []);
  assert.equal(JSON.parse(project).format, 'paintty-preview');
  assert.equal(Object.hasOwn(JSON.parse(project), 'timeline'), false);
  assert.deepEqual(JSON.parse(fs.files.get('.paintty-preview/sessions/tab-a.json')), {
    version: 2,
    path,
    playheadTick: 4,
    updatedAt: 1234,
  });
  assert.equal(fs.files.get('.opened'), path);
  assert.ok(
    fs.events.indexOf('close:' + path)
      < fs.events.indexOf('open:.paintty-preview/sessions/tab-a.json'),
    'the complete project is committed before its session marker',
  );
  assert.ok(
    fs.events.indexOf('close:.paintty-preview/sessions/tab-a.json')
      < fs.events.indexOf('write:.opened'),
    'the compatibility pointer follows the session marker',
  );
}

loadCanonicalTimeline({
  fps: 24,
  tags: [{ id: '10000000-0000-4000-8000-000000000001', tick: 1, type: 'loop-start' }],
  tracks: [{
    id: 'preview-track', kind: 'visual', locked: false,
    layer: { id: 'preview-layer', name: 'Preview', type: 'cell', visible: true, cells: {} },
  }],
  clips: [{
    id: 'preview-clip', trackId: 'preview-track', kind: 'visual',
    startTick: 0, inTick: 0, outTick: 3, sourceDuration: 3,
    frameKeys: [{ tick: 0, value: { cells: {} } }], propertyTracks: {},
  }],
});
assert.deepEqual(JSON.parse(serializeLivePreview()).tags, [{ tick: 1, type: 'loop-start' }],
  'resolved preview preserves the open-ended loop contract without authoring identity');
initTimeline([]);

{
  const fs = virtualFolder();
  const timers = fakeTimers();
  const content = writable(1);
  const project = { format: 'test-preview', revision: 1 };
  let serializations = 0;
  const sync = createPreviewSync({
    sessionId: 'busy-tab',
    nameStore: writable('busy.json'),
    playheadStore: writable(0),
    contentStores: [content],
    serialize: () => {
      serializations++;
      return JSON.stringify(project);
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });

  await sync.useWatchFolder(fs.root);
  await sync.flushProject();
  const stop = sync.start();
  for (let revision = 2; revision <= 20; revision++) {
    project.revision = revision;
    content.set(revision);
    assert.equal(
      timers.timeoutCount(PREVIEW_WRITE_MAX_DELAY_MS),
      1,
      'continuous edits retain one original maximum write deadline',
    );
  }
  assert.equal(timers.timeoutCount(150), 1, 'continuous edits debounce the short write');

  await timers.runTimeout(PREVIEW_WRITE_MAX_DELAY_MS);
  const path = '.paintty-preview/previews/busy-tab-busy.json';
  assert.equal(JSON.parse(fs.files.get(path)).revision, 20);
  assert.equal(serializations, 2, 'the maximum deadline commits the newest project once');
  assert.equal(timers.timeoutCount(150), 0);
  assert.equal(timers.timeoutCount(PREVIEW_WRITE_MAX_DELAY_MS), 0);
  await stop();
}

{
  const fs = virtualFolder({ name: 'active-folder' });
  const timers = fakeTimers();
  const content = writable(1);
  const sync = createPreviewSync({
    sessionId: 'disconnect-tab',
    nameStore: writable('disconnect.json'),
    playheadStore: writable(0),
    contentStores: [content],
    serialize: () => JSON.stringify({ revision: get(content) }),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  const stop = sync.start();
  await sync.useWatchFolder(fs.root);
  await sync.flushProject();
  assert.equal(get(sync.state).name, 'active-folder');
  const path = sync.currentPath;
  assert.equal(fs.files.has(path), true);
  await sync.disconnect();
  assert.deepEqual(get(sync.state), { state: 'off', name: null, error: null });
  assert.equal(sync.currentPath, null);
  assert.equal(fs.files.has(path), false, 'Disconnect removes this session snapshot');
  assert.equal(fs.files.has(sessionMarkerPath('disconnect-tab')), false,
    'Disconnect removes this session marker');
  content.set(2);
  assert.equal(timers.timeoutCount(150), 0, 'Disconnected subscriptions schedule no writes');
  await stop();
}

{
  const fs = virtualFolder();
  const timers = fakeTimers();
  const project = '{"format":"test-preview","name":"recover me"}';
  let serializations = 0;
  const sync = createPreviewSync({
    sessionId: 'missing-tab',
    nameStore: writable('missing.json'),
    playheadStore: writable(7),
    contentStores: [],
    serialize: () => {
      serializations++;
      return project;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });

  await sync.useWatchFolder(fs.root);
  await sync.flushProject();
  const stop = sync.start();
  const path = '.paintty-preview/previews/missing-tab-missing.json';
  fs.files.delete(path);

  timers.interval().callback();
  await sync.flushMarker();
  assert.equal(fs.files.get(path), project, 'a heartbeat recreates a missing cached snapshot');
  assert.equal(fs.files.get('.opened'), path);
  assert.equal(serializations, 2, 'recovery verifies current serialized content');
  await stop();
}

{
  const fs = virtualFolder();
  const timers = fakeTimers();
  const sessionA = createPreviewSync({
    sessionId: 'remaining-tab',
    nameStore: writable('remaining.json'),
    playheadStore: writable(3),
    contentStores: [],
    serialize: () => '{"format":"test-preview","tab":"A"}',
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  const sessionB = createPreviewSync({
    sessionId: 'closing-tab',
    nameStore: writable('closing.json'),
    playheadStore: writable(5),
    contentStores: [],
    serialize: () => '{"format":"test-preview","tab":"B"}',
  });

  await sessionA.useWatchFolder(fs.root);
  await sessionA.flushProject();
  const stopA = sessionA.start();
  await sessionB.useWatchFolder(fs.root);
  await sessionB.flushProject();
  const pathA = '.paintty-preview/previews/remaining-tab-remaining.json';
  const pathB = '.paintty-preview/previews/closing-tab-closing.json';
  assert.equal(fs.files.get('.opened'), pathB);

  await sessionB.stop();
  assert.equal(fs.files.has('.opened'), false, 'the last writer removes only its pointer');
  timers.interval().callback();
  await sessionA.flushMarker();
  assert.equal(
    fs.files.get('.opened'),
    pathA,
    'the remaining session heartbeat restores the compatibility pointer',
  );
  await stopA();
}

{
  const oldMarker = JSON.stringify({
    version: 2,
    path: '.paintty-preview/previews/tab-a-known-good.json',
    playheadTick: 1,
    updatedAt: 100,
  });
  const fs = virtualFolder({
    initial: {
      '.opened': '.paintty-preview/previews/tab-a-known-good.json',
      '.paintty-preview/sessions/tab-a.json': oldMarker,
    },
    failClose: '.paintty-preview/previews/tab-a-broken.json',
  });

  await assert.rejects(
    writePreview(fs.root, 'broken.json', '{"partial":true}', {
      sessionId: 'tab-a',
      playheadTick: 8,
      updatedAt: 200,
    }),
    /cannot commit \.paintty-preview\/previews\/tab-a-broken\.json/,
  );
  assert.equal(fs.files.get('.paintty-preview/sessions/tab-a.json'), oldMarker);
  assert.equal(fs.files.get('.opened'), '.paintty-preview/previews/tab-a-known-good.json');
  assert.equal(fs.files.has('.paintty-preview/previews/tab-a-broken.json'), false);
}

{
  const stalePath = '.paintty-preview/previews/stale-tab-old.json';
  const staleMarkerPath = '.paintty-preview/sessions/stale-tab.json';
  const fs = virtualFolder({
    initial: {
      [stalePath]: 'STALE',
      [staleMarkerPath]: JSON.stringify({
        version: 2, path: stalePath, playheadTick: 0, updatedAt: 1,
      }),
    },
  });
  const nameA = writable('shared.json');
  const nameB = writable('shared.json');
  const activeA = writable(2);
  const activeB = writable(9);
  const projectA = JSON.stringify({ format: 'test-preview', tab: 'A' });
  const projectB = JSON.stringify({ format: 'test-preview', tab: 'B' });
  const sessionA = createPreviewSync({
    sessionId: 'tab-a',
    nameStore: nameA,
    playheadStore: activeA,
    contentStores: [],
    serialize: () => projectA,
    now: () => 1000,
  });
  const sessionB = createPreviewSync({
    sessionId: 'tab-b',
    nameStore: nameB,
    playheadStore: activeB,
    contentStores: [],
    serialize: () => projectB,
    now: () => 2000,
  });

  await sessionA.useWatchFolder(fs.root);
  await sessionB.useWatchFolder(fs.root);
  await sessionA.flushProject();
  await sessionB.flushProject();

  const pathA = '.paintty-preview/previews/tab-a-shared.json';
  const pathB = '.paintty-preview/previews/tab-b-shared.json';
  assert.equal(fs.files.get(pathA), projectA);
  assert.equal(fs.files.get(pathB), projectB);
  assert.equal(JSON.parse(fs.files.get('.paintty-preview/sessions/tab-a.json')).path, pathA);
  assert.equal(JSON.parse(fs.files.get('.paintty-preview/sessions/tab-b.json')).path, pathB);
  assert.equal(fs.files.get('.opened'), pathB);

  await sessionA.stop();
  assert.equal(fs.files.has(pathA), false);
  assert.equal(fs.files.has('.paintty-preview/sessions/tab-a.json'), false);
  assert.equal(fs.files.get(pathB), projectB);
  assert.equal(fs.files.get('.opened'), pathB);
  assert.equal(fs.files.get(stalePath), 'STALE');
  assert.equal(fs.files.has(staleMarkerPath), true);

  await sessionB.stop();
  assert.equal(fs.files.has(pathB), false);
  assert.equal(fs.files.has('.paintty-preview/sessions/tab-b.json'), false);
  assert.equal(fs.files.has('.opened'), false);
  assert.equal(fs.files.get(stalePath), 'STALE');
  assert.equal(fs.files.has(staleMarkerPath), true);
}

{
  const fs = virtualFolder();
  const timers = fakeTimers();
  const name = writable('live-boss.json');
  const activeFrame = writable(3);
  const content = writable({ revision: 1 });
  const frameReadModel = writable({ active: 3 });
  let serializations = 0;
  let clock = 5000;
  const project = {
    format: 'paintty-sprite',
    version: 13,
    projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    width: 80,
    height: 30,
    fps: 24,
    timeline: {
      tags: [],
      tracks: [{
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'visual', locked: false,
        layer: {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Layer 1', type: 'cell',
          visible: true, cells: {}, offset: { x: 0, y: 0 },
        },
      }],
      clips: [{
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        trackId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'visual',
        startTick: 0, inTick: 0, outTick: 20, sourceDuration: 20,
        frameKeys: [{ tick: 0, value: { cells: {} } }], propertyTracks: {},
      }],
    },
    media: { generation: 0, assets: [] },
  };
  const sync = createPreviewSync({
    sessionId: 'live-tab',
    nameStore: name,
    playheadStore: activeFrame,
    contentStores: [content, frameReadModel, name],
    serialize: () => {
      serializations++;
      return JSON.stringify(project);
    },
    now: () => ++clock,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });

  await sync.useWatchFolder(fs.root);
  const stop = sync.start();
  assert.equal(timers.interval().delay, PREVIEW_HEARTBEAT_MS);
  await sync.flushProject();

  const firstPath = '.paintty-preview/previews/live-tab-live-boss.json';
  assert.deepEqual(JSON.parse(fs.files.get(firstPath)), project);
  assert.equal(Object.hasOwn(JSON.parse(fs.files.get(firstPath)), 'playheadTick'), false);
  const firstTargetWrites = fs.events.filter((event) => event === 'write:' + firstPath).length;
  assert.equal(serializations, 1);

  activeFrame.set(17);
  assert.ok(timers.timeoutDelays().includes(40), 'frame scrubbing schedules a marker update');
  await sync.flushMarker();
  assert.equal(serializations, 1, 'frame scrubbing does not serialize the project');
  assert.equal(
    JSON.parse(fs.files.get('.paintty-preview/sessions/live-tab.json')).playheadTick,
    17,
  );

  frameReadModel.set({ active: 17 });
  assert.ok(timers.timeoutDelays().includes(150), 'the frame read model still reaches the dedupe gate');
  await sync.flushProject();
  assert.equal(serializations, 2);
  assert.equal(
    fs.events.filter((event) => event === 'write:' + firstPath).length,
    firstTargetWrites,
    'an unchanged project is not rewritten after a scrub',
  );

  const writesBeforeHeartbeat = fs.events.filter((event) => event === 'write:' + firstPath).length;
  timers.interval().callback();
  await sync.flushMarker();
  assert.equal(
    JSON.parse(fs.files.get('.paintty-preview/sessions/live-tab.json')).updatedAt,
    clock,
  );
  assert.equal(
    fs.events.filter((event) => event === 'write:' + firstPath).length,
    writesBeforeHeartbeat,
    'the heartbeat does not rewrite the project',
  );

  name.set('renamed.json');
  await sync.flushProject();
  const renamedPath = '.paintty-preview/previews/live-tab-renamed.json';
  assert.equal(fs.files.has(firstPath), false, 'renaming removes the old session snapshot');
  assert.deepEqual(JSON.parse(fs.files.get(renamedPath)), project);
  assert.equal(
    JSON.parse(fs.files.get('.paintty-preview/sessions/live-tab.json')).path,
    renamedPath,
  );

  content.set({ revision: 2 });
  project.timeline.clips[0].frameKeys.push({ tick: 1, value: { cells: {} } });
  await sync.flushProject();
  assert.deepEqual(JSON.parse(fs.files.get(renamedPath)), project);
  assert.deepEqual(get(sync.state), {
    state: 'ready',
    name: 'watch-fixture',
    error: null,
  });

  const writesBeforeStop = fs.events.filter((event) => event === 'write:' + renamedPath).length;
  content.set({ revision: 3 });
  await stop();
  assert.equal(
    fs.events.filter((event) => event === 'write:' + renamedPath).length,
    writesBeforeStop,
    'stopping cancels a pending project write',
  );
  assert.deepEqual(get(sync.state), { state: 'off', name: 'watch-fixture', error: null });
  assert.equal(timers.intervalCount, 0);
  assert.equal(fs.files.has(renamedPath), false);
  assert.equal(fs.files.has('.paintty-preview/sessions/live-tab.json'), false);
  assert.equal(fs.files.has('.opened'), false);
}

{
  const fs = virtualFolder();
  const name = writable('broken.json');
  const activeFrame = writable(0);
  const sync = createPreviewSync({
    sessionId: 'error-tab',
    nameStore: name,
    playheadStore: activeFrame,
    contentStores: [],
    serialize: () => '{"format":"test-preview"}',
  });
  fs.setFailClose('.paintty-preview/previews/error-tab-broken.json');

  await sync.useWatchFolder(fs.root);
  await sync.flushProject();
  assert.deepEqual(get(sync.state), {
    state: 'error',
    name: 'watch-fixture',
    error: 'cannot commit .paintty-preview/previews/error-tab-broken.json',
  });
  assert.equal(fs.files.has('.paintty-preview/sessions/error-tab.json'), false);
  assert.equal(fs.files.has('.opened'), false);
  await sync.stop();
}

{
  const fs = virtualFolder();
  const timers = fakeTimers();
  const name = writable('retry.json');
  const activeFrame = writable(1);
  const content = writable(1);
  const project = { format: 'test-preview', revision: 1 };
  let clock = 100;
  let serializations = 0;
  const sync = createPreviewSync({
    sessionId: 'retry-tab',
    nameStore: name,
    playheadStore: activeFrame,
    contentStores: [content],
    serialize: () => {
      serializations++;
      return JSON.stringify(project);
    },
    now: () => ++clock,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });

  await sync.useWatchFolder(fs.root);
  const stop = sync.start();
  await sync.flushProject();
  const path = '.paintty-preview/previews/retry-tab-retry.json';
  const markerPath = '.paintty-preview/sessions/retry-tab.json';
  const goodMarker = fs.files.get(markerPath);
  assert.equal(JSON.parse(fs.files.get(path)).revision, 1);

  project.revision = 2;
  content.set(2);
  fs.setFailClose(path);
  await sync.flushProject();
  assert.equal(get(sync.state).state, 'error');
  assert.equal(JSON.parse(fs.files.get(path)).revision, 1);

  activeFrame.set(9);
  timers.interval().callback();
  const markerWritesBeforeRetry = fs.events.filter((event) => event === 'write:' + markerPath).length;
  await sync.flushMarker();
  assert.equal(get(sync.state).state, 'error');
  assert.equal(fs.files.get(markerPath), goodMarker);
  assert.equal(
    fs.events.filter((event) => event === 'write:' + markerPath).length,
    markerWritesBeforeRetry,
    'a failed full snapshot blocks marker heartbeats from advertising stale art',
  );

  fs.setFailClose(null);
  await sync.flushMarker();
  assert.equal(JSON.parse(fs.files.get(path)).revision, 2);
  assert.equal(JSON.parse(fs.files.get(markerPath)).playheadTick, 9);
  assert.equal(get(sync.state).state, 'ready');
  assert.ok(serializations >= 3, 'retry serializes the current project before advancing the marker');
  await stop();
}

console.log('live preview: passed');
