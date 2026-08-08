import assert from 'node:assert/strict';
import { canvasFont } from '../src/lib/font.js';

const idleQueue = [];
let lastGlyph = '';
const context = {
  fillStyle: '#000000',
  textAlign: 'center',
  textBaseline: 'middle',
  font: '',
  fillRect() {},
  fillText(glyph) { lastGlyph = glyph; },
  getImageData() {
    const data = new Uint8ClampedArray(24 * 24 * 4);
    if (lastGlyph !== String.fromCodePoint(0x10ffff)) {
      for (let pixel = 0; pixel < 24 * 24; pixel++) data[pixel * 4] = 255;
    }
    return { data };
  },
};

globalThis.document = {
  createElement() {
    return { width: 0, height: 0, getContext: () => context };
  },
};
globalThis.window = {
  requestIdleCallback(callback) { idleQueue.push(callback); },
};

const {
  buildCandidatesAsync,
  matchGlyphs,
  meaningfulSketchStrokes,
  rankGlyphBitmaps,
  rasterizeSketchStrokes,
} = await import('../src/lib/sketchMatch.js');

const verticalStroke = [[{ x: 42, y: 18 }, { x: 42, y: 150 }]];
assert.equal(meaningfulSketchStrokes(verticalStroke), true);
assert.equal(meaningfulSketchStrokes([[{ x: 2, y: 2 }]]), false);
const verticalBitmap = rasterizeSketchStrokes(verticalStroke, {
  sourceWidth: 84,
  sourceHeight: 168,
  lineWidth: 6,
});
assert.ok(verticalBitmap instanceof Float32Array);
assert.ok([...verticalBitmap].filter((value) => value > 0.4).length >= 4,
  'an open vertical stroke produces bounded raster ink');
assert.equal(rasterizeSketchStrokes([], { sourceWidth: 84, sourceHeight: 168 }), null);
assert.equal(rasterizeSketchStrokes([[{ x: 1, y: 1 }, { x: 2, y: 1 }]], {
  sourceWidth: 84,
  sourceHeight: 168,
}), null, 'tap-sized noise produces no match work');
assert.ok(rasterizeSketchStrokes([[
  { x: 10, y: 10 }, { x: 70, y: 10 }, { x: 70, y: 140 },
  { x: 10, y: 140 }, { x: 10, y: 10 },
]], { sourceWidth: 84, sourceHeight: 168, lineWidth: 6 }),
'closed strokes continue to rasterize');

const glyphStroke = (from, to, lineWidth = 2) => rasterizeSketchStrokes([[from, to]], {
  sourceWidth: 24,
  sourceHeight: 24,
  lineWidth,
  minimumLength: 1,
});
const rankedVertical = rankGlyphBitmaps(verticalBitmap, [
  { ch: '│', bitmap: glyphStroke({ x: 12, y: 2 }, { x: 12, y: 22 }, 2) },
  { ch: '|', bitmap: glyphStroke({ x: 12, y: 3 }, { x: 12, y: 21 }, 1) },
  { ch: 'I', bitmap: glyphStroke({ x: 12, y: 2 }, { x: 12, y: 22 }, 4) },
  { ch: 'l', bitmap: glyphStroke({ x: 11, y: 3 }, { x: 11, y: 22 }, 2) },
  { ch: '─', bitmap: glyphStroke({ x: 2, y: 12 }, { x: 22, y: 12 }, 2) },
  { ch: '_', bitmap: glyphStroke({ x: 2, y: 20 }, { x: 22, y: 20 }, 2) },
], 4);
assert.deepEqual(new Set(rankedVertical), new Set(['│', '|', 'I', 'l']),
  'a vertical open stroke ranks available vertical atlas glyphs first');

canvasFont.set('Font A');
let firstResolved = false;
const firstBuild = buildCandidatesAsync().then(() => { firstResolved = true; });
const firstStep = idleQueue.shift();
let checks = 0;
firstStep({ timeRemaining: () => (checks++ === 0 ? 4 : 0) });
assert.equal(idleQueue.length, 1, 'the partial first build schedules its continuation');

canvasFont.set('Font B');
let secondResolved = false;
const secondBuild = buildCandidatesAsync().then(() => { secondResolved = true; });
await firstBuild;
assert.equal(firstResolved, true, 'a superseded caller is released to retry the new font');
assert.equal(secondResolved, false, 'releasing the old caller cannot complete the new build');

const staleStep = idleQueue.shift();
staleStep({ timeRemaining: () => 100 });
await Promise.resolve();
assert.equal(secondResolved, false, 'the stale idle chain cannot resolve or append to the new build');

const currentStep = idleQueue.shift();
currentStep({ timeRemaining: () => 100 });
await secondBuild;
assert.equal(secondResolved, true);
assert.equal(idleQueue.length, 0);

await buildCandidatesAsync();
assert.equal(idleQueue.length, 0, 'a completed atlas is reused for the current font');

const nativeMatches = matchGlyphs(new Float32Array(24 * 24).fill(1));
const timeoutQueue = [];
const originalSetTimeout = globalThis.setTimeout;
delete window.requestIdleCallback;
globalThis.setTimeout = (callback) => {
  timeoutQueue.push(callback);
  return timeoutQueue.length;
};

try {
  canvasFont.set('Font C');
  let fallbackResolved = false;
  const fallbackBuild = buildCandidatesAsync().then(() => { fallbackResolved = true; });
  assert.equal(timeoutQueue.length, 1, 'the fallback schedules its first batch');

  timeoutQueue.shift()();
  await Promise.resolve();
  assert.equal(fallbackResolved, false, 'one fallback turn cannot monopolize the full atlas build');
  assert.equal(timeoutQueue.length, 1, 'unfinished fallback work yields to another timer turn');

  let turns = 1;
  while (timeoutQueue.length) {
    timeoutQueue.shift()();
    turns++;
    await Promise.resolve();
    assert.ok(turns < 100, 'the bounded scheduler still completes');
  }
  await fallbackBuild;
  assert.ok(turns > 1, 'fallback construction spans multiple event-loop turns');
  assert.deepEqual(
    matchGlyphs(new Float32Array(24 * 24).fill(1)),
    nativeMatches,
    'scheduling changes do not change the ordered match output',
  );
} finally {
  globalThis.setTimeout = originalSetTimeout;
}

console.log('ok - interrupted sketch atlas builds remain isolated by font generation');
