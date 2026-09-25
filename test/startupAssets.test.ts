import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import {
  createStartupAssetsController,
  startupProgressState,
} from '../src/lib/startupAssets.ts';
import type { StartupAssetsState } from '../src/lib/startupAssets.ts';
import { isUnknownRecord } from '../src/lib/types/project-types.ts';
import { requireValue } from './types/ui-test-types.ts';

const bundledAssets = [
  '../public/vendor/nerd-fonts/v3.2.1/JetBrainsMonoNerdFont-Regular.ttf',
  '../public/vendor/nerd-fonts/v3.2.1/glyphnames.json',
];
for (const relative of bundledAssets) {
  const asset = await stat(new URL(relative, import.meta.url));
  assert.equal(asset.isFile(), true, `${relative} must be bundled locally`);
  assert.ok(asset.size > 0, `${relative} must not be empty`);
}
const glyphCatalog: unknown = JSON.parse(await readFile(
  new URL(requireValue(bundledAssets[1]), import.meta.url),
  'utf8',
));
assert.ok(isUnknownRecord(glyphCatalog), 'glyph catalog must be an object');
assert.ok(Object.values(glyphCatalog).some(
  (entry) => isUnknownRecord(entry) && typeof entry['char'] === 'string',
), 'glyph catalog must contain glyphs');
const fontSource = await readFile(new URL('../src/lib/font.ts', import.meta.url), 'utf8');
const glyphSource = await readFile(new URL('../src/lib/nerdglyphs.ts', import.meta.url), 'utf8');
assert.doesNotMatch(fontSource + glyphSource, /https?:\/\//);
assert.match(fontSource, /import\.meta\.env\?\.BASE_URL/);
assert.match(glyphSource, /import\.meta\.env\?\.BASE_URL/);
assert.match(fontSource, /vendor\/nerd-fonts\/v3\.2\.1\/JetBrainsMonoNerdFont-Regular\.ttf/);
assert.match(glyphSource, /vendor\/nerd-fonts\/v3\.2\.1\/glyphnames\.json/);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve: Deferred<T>['resolve'] = () => {
    throw new Error('Deferred promise was not initialized');
  };
  let reject: Deferred<T>['reject'] = () => {
    throw new Error('Deferred promise was not initialized');
  };
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

const font = deferred();
const glyphs = deferred();
const sketch = deferred();
let sketchCalls = 0;
const ordered = createStartupAssetsController({
  loadFont: () => font.promise,
  loadGlyphs: () => glyphs.promise,
  buildSketchIndex: () => {
    sketchCalls++;
    return sketch.promise;
  },
  resetSketchIndex: () => {},
});
let orderedState: StartupAssetsState | undefined;
const stopOrdered = ordered.subscribe((state) => {
  orderedState = state;
});

const orderedRun = ordered.start();
assert.deepEqual(requireValue(orderedState).tasks.map((task) => task.status), ['loading', 'loading', 'pending']);
assert.equal(sketchCalls, 0);

font.resolve();
await flush();
assert.deepEqual(requireValue(orderedState).tasks.map((task) => task.status), ['ready', 'loading', 'pending']);
assert.equal(sketchCalls, 0);

glyphs.resolve();
await flush();
assert.deepEqual(requireValue(orderedState).tasks.map((task) => task.status), ['ready', 'ready', 'loading']);
assert.equal(sketchCalls, 1);

sketch.resolve();
await orderedRun;
assert.equal(requireValue(orderedState).status, 'ready');
assert.deepEqual(requireValue(orderedState).tasks.map((task) => task.status), ['ready', 'ready', 'ready']);
stopOrdered();

let fontCalls = 0;
let glyphCalls = 0;
let retrySketchCalls = 0;
let resets = 0;
const retrying = createStartupAssetsController({
  loadFont: async () => {
    fontCalls++;
  },
  loadGlyphs: async () => {
    glyphCalls++;
    if (glyphCalls === 1) throw new Error('offline');
  },
  buildSketchIndex: async () => {
    retrySketchCalls++;
  },
  resetSketchIndex: () => {
    resets++;
  },
});
let retryState: StartupAssetsState | undefined;
const stopRetry = retrying.subscribe((state) => {
  retryState = state;
});

await retrying.start();
assert.equal(requireValue(retryState).status, 'failed');
assert.deepEqual(requireValue(retryState).tasks.map((task) => task.status), ['ready', 'failed', 'ready']);
assert.equal(fontCalls, 1);
assert.equal(glyphCalls, 1);
assert.equal(retrySketchCalls, 1);

await retrying.retry();
assert.equal(requireValue(retryState).status, 'ready');
assert.deepEqual(requireValue(retryState).tasks.map((task) => task.status), ['ready', 'ready', 'ready']);
assert.equal(fontCalls, 1);
assert.equal(glyphCalls, 2);
assert.equal(retrySketchCalls, 2);
assert.equal(resets, 2);
stopRetry();

const readyAssets = {
  status: 'ready',
  tasks: [
    { id: 'font', label: 'Nerd Font', status: 'ready', error: '' },
    { id: 'glyphs', label: 'Glyph catalog', status: 'ready', error: '' },
    { id: 'sketch', label: 'Sketch index', status: 'ready', error: '' },
  ],
} satisfies StartupAssetsState;
const recoveringProgress = startupProgressState(false, readyAssets);
assert.equal(recoveringProgress.visible, true);
assert.deepEqual(
  recoveringProgress.tasks.map((task) => [task.id, task.status]),
  [
    ['recovery', 'loading'],
    ['font', 'ready'],
    ['glyphs', 'ready'],
    ['sketch', 'ready'],
  ],
);
assert.equal(recoveringProgress.readyCount, 3);

const readyProgress = startupProgressState(true, readyAssets);
assert.equal(readyProgress.visible, false);
assert.equal(readyProgress.readyCount, 4);

console.log('startup assets tests passed');
