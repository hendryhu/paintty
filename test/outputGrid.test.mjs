import assert from 'node:assert/strict';
import { normalizeOutputGrid, paintOutputGrid } from '../src/lib/outputGrid.js';

const tokenIsWide = (glyph) => glyph === 'WIDE';
const source = [[
  { c: 'WIDE', fg: '#eeeeee', bg: '#111111' },
  { c: 'stale', fg: '#dddddd', bg: '#222222', cont: true },
  { c: 'N', fg: '#cccccc' },
  { c: '', fg: '#bbbbbb', bg: '#333333', cont: true },
  { c: 'WIDE', fg: '#aaaaaa', bg: '#444444' },
]];

const normalized = normalizeOutputGrid(source, 5, 1, tokenIsWide);
assert.deepStrictEqual(
  normalized,
  [[
    { c: 'WIDE', fg: '#eeeeee', bg: '#111111' },
    { c: '', fg: '#dddddd', bg: '#111111', cont: true },
    { c: 'N', fg: '#cccccc' },
    { bg: '#333333' },
    { bg: '#444444' },
  ]],
  'output normalization keeps complete pairs and turns invalid halves into their background channel',
);
assert.equal(source[0][1].c, 'stale', 'normalization does not rewrite editable world cells');
assert.deepStrictEqual(
  normalizeOutputGrid(normalized, 5, 1, tokenIsWide),
  normalized,
  'normalization is stable when image and video paths validate the same snapshot twice',
);

assert.deepStrictEqual(
  normalizeOutputGrid([[
    { c: 'N', fg: '#ffffff' },
    { c: '', bg: '#556677', cont: true },
  ]], 2, 1, tokenIsWide),
  [[{ c: 'N', fg: '#ffffff' }, { bg: '#556677' }]],
  'a continuation belongs only to an actual two-cell glyph immediately to its left',
);

const events = [];
const context = {
  fillStyle: null,
  fillRect(...args) { events.push(['background', this.fillStyle, ...args]); },
  fillText(...args) { events.push(['glyph', this.fillStyle, ...args]); },
};
paintOutputGrid(context, [[
  { c: '界', fg: '#f0f0f0', bg: '#101010' },
  { c: '', fg: '#f0f0f0', bg: '#202020', cont: true },
  { c: 'A', fg: '#abcdef' },
  { c: '', bg: '#303030', cont: true },
  { c: '界', fg: '#123456', bg: '#404040' },
]], 5, 1, 10, 20);

assert.deepStrictEqual(events, [
  ['background', '#101010', 0, 0, 10, 20],
  ['background', '#101010', 10, 0, 10, 20],
  ['background', '#303030', 30, 0, 10, 20],
  ['background', '#404040', 40, 0, 10, 20],
  ['glyph', '#f0f0f0', '界', 10, 10],
  ['glyph', '#abcdef', 'A', 25, 10],
], 'raster output paints both backgrounds first, centers a valid wide glyph over two cells, and omits invalid glyph halves');

console.log('output grid: 5 focused assertions passed');
