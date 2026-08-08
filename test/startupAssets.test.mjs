import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import {
  createStartupAssetsController,
  startupProgressState,
} from '../src/lib/startupAssets.js';

const bundledAssets = [
  '../public/vendor/nerd-fonts/v3.2.1/JetBrainsMonoNerdFont-Regular.ttf',
  '../public/vendor/nerd-fonts/v3.2.1/glyphnames.json',
];
for (const relative of bundledAssets) {
  const asset = await stat(new URL(relative, import.meta.url));
  assert.equal(asset.isFile(), true, `${relative} must be bundled locally`);
  assert.ok(asset.size > 0, `${relative} must not be empty`);
}
const glyphCatalog = JSON.parse(await readFile(new URL(bundledAssets[1], import.meta.url), 'utf8'));
assert.ok(Object.values(glyphCatalog).some((entry) => entry?.char), 'glyph catalog must contain glyphs');
const fontSource = await readFile(new URL('../src/lib/font.js', import.meta.url), 'utf8');
const glyphSource = await readFile(new URL('../src/lib/nerdglyphs.js', import.meta.url), 'utf8');
assert.doesNotMatch(fontSource + glyphSource, /https?:\/\//);
assert.match(fontSource, /import\.meta\.env\?\.BASE_URL/);
assert.match(glyphSource, /import\.meta\.env\?\.BASE_URL/);
assert.match(fontSource, /vendor\/nerd-fonts\/v3\.2\.1\/JetBrainsMonoNerdFont-Regular\.ttf/);
assert.match(glyphSource, /vendor\/nerd-fonts\/v3\.2\.1\/glyphnames\.json/);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
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
let orderedState;
const stopOrdered = ordered.subscribe((state) => {
  orderedState = state;
});

const orderedRun = ordered.start();
assert.deepEqual(orderedState.tasks.map((task) => task.status), ['loading', 'loading', 'pending']);
assert.equal(sketchCalls, 0);

font.resolve();
await flush();
assert.deepEqual(orderedState.tasks.map((task) => task.status), ['ready', 'loading', 'pending']);
assert.equal(sketchCalls, 0);

glyphs.resolve();
await flush();
assert.deepEqual(orderedState.tasks.map((task) => task.status), ['ready', 'ready', 'loading']);
assert.equal(sketchCalls, 1);

sketch.resolve();
await orderedRun;
assert.equal(orderedState.status, 'ready');
assert.deepEqual(orderedState.tasks.map((task) => task.status), ['ready', 'ready', 'ready']);
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
let retryState;
const stopRetry = retrying.subscribe((state) => {
  retryState = state;
});

await retrying.start();
assert.equal(retryState.status, 'failed');
assert.deepEqual(retryState.tasks.map((task) => task.status), ['ready', 'failed', 'ready']);
assert.equal(fontCalls, 1);
assert.equal(glyphCalls, 1);
assert.equal(retrySketchCalls, 1);

await retrying.retry();
assert.equal(retryState.status, 'ready');
assert.deepEqual(retryState.tasks.map((task) => task.status), ['ready', 'ready', 'ready']);
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
};
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
