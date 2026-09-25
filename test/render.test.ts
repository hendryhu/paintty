import assert from 'node:assert/strict';
import {
  canvasBackingScale,
  drawGrid,
  drawOnionCells,
  fillCellBackground,
  redrawCellBoundaryCoverage,
  type EditorFontMetrics,
} from '../src/lib/render.ts';

const calls: unknown[][] = [];
const context = {
  globalAlpha: 1,
  fillStyle: '',
  textAlign: '',
  textBaseline: '',
  fillRect(...args: [number, number, number, number]) {
    calls.push(['background', this.globalAlpha, this.fillStyle, ...args]);
  },
  fillText(...args: [string, number, number]) {
    calls.push(['glyph', this.globalAlpha, this.fillStyle, ...args]);
  },
};
const metrics = { cellW: 10, cellH: 20, baseline: 15 } as EditorFontMetrics;
drawOnionCells(context as unknown as CanvasRenderingContext2D, [[
  { bg: '#112233' },
  { c: '@', fg: '#ffffff' },
  { c: 'X', fg: '#ffffff', bg: '#445566' },
  { c: '', cont: true },
  { c: 'Y', fg: '#ffffff' },
]], metrics, '#e06c6c', 0.3);

assert.deepEqual(calls, [
  ['background', 0.3, '#e06c6c', 0, 0, 10, 20],
  ['background', 0.3, '#e06c6c', 20, 0, 10, 20],
  ['glyph', 0.3, '#e06c6c', '@', 10, 15],
  ['glyph', 0.3, '#e06c6c', 'X', 20, 15],
  ['glyph', 0.3, '#e06c6c', 'Y', 40, 15],
]);
assert.equal(context.globalAlpha, 1);
assert.deepEqual(
  [canvasBackingScale(0.8), canvasBackingScale(1), canvasBackingScale(1.1), canvasBackingScale(2)],
  [2, 2, 2, 2],
  'editor text is supersampled on an integer backing lattice at every browser DPR',
);
assert.equal(canvasBackingScale(1, 5_000, 10_000), 1,
  'large canvases stay within the backing-pixel budget');

let boundaryDraws = 0;
const boundaryContext = {
  save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, translate() {},
} as unknown as CanvasRenderingContext2D;
redrawCellBoundaryCoverage(boundaryContext, 2, 1, 10, 20, 2,
  () => { boundaryDraws++; }, 0, 0, () => false);
assert.equal(boundaryDraws, 0, 'an empty neighboring cell does not activate boundary repair');
redrawCellBoundaryCoverage(boundaryContext, 2, 1, 10, 20, 2,
  () => { boundaryDraws++; }, 0, 0, () => true);
assert.equal(boundaryDraws, 2, 'an occupied shared boundary receives color-preserving coverage');

const originalWindow = globalThis.window;
globalThis.window = { devicePixelRatio: 1.25 } as unknown as Window & typeof globalThis;
const transforms: number[][] = [];
const gridFillCalls: number[][] = [];
const gridTextCalls: unknown[][] = [];
const gridContext = {
  clearRect() {},
  fillRect(...args: [number, number, number, number]) { gridFillCalls.push(args); },
  fillText(...args: [string, number, number]) { gridTextCalls.push(args); },
  save() {},
  restore() {},
  beginPath() {},
  rect() {},
  clip() {},
  translate() {},
  setTransform(...args: [number, number, number, number, number, number]) { transforms.push(args); },
  set fillStyle(_value: string) {},
  set font(_value: string) {},
  set fontKerning(_value: CanvasFontKerning) {},
  set textAlign(_value: CanvasTextAlign) {},
  set textBaseline(_value: CanvasTextBaseline) {},
};
const gridCanvas = {
  width: 0,
  height: 0,
  style: {},
  getContext: () => gridContext,
};
drawGrid(gridCanvas as unknown as HTMLCanvasElement, [[{ bg: '#000' }, { bg: '#000' }, { bg: '#000' }]], {
  cellW: 11, cellH: 22, fontPx: 18, baseline: 15,
} as EditorFontMetrics);
assert.deepEqual({ width: gridCanvas.width, height: gridCanvas.height }, { width: 66, height: 44 });
assert.deepEqual(transforms, [[2, 0, 0, 2, 0, 0]],
  'integer supersampling keeps cell boundaries on the backing-pixel lattice');
gridFillCalls.length = 0;
gridTextCalls.length = 0;
drawGrid(gridCanvas as unknown as HTMLCanvasElement, [[
  { c: 'A', fg: '#123456' },
  { c: 'B', fg: '#654321' },
  { c: '@', fg: '#abcdef' },
]], { cellW: 10, cellH: 20, fontPx: 16, baseline: 15, advance: 10 });
assert.deepEqual(gridTextCalls, Array.from({ length: 3 }, () => [
  ['A', 0, 15], ['B', 10, 15], ['@', 20, 15],
]).flat(), 'every glyph follows the same text-rendering path at cell boundaries');
const overlapCalls: number[][] = [];
fillCellBackground({
  fillRect: (...args: [number, number, number, number]) => overlapCalls.push(args),
} as unknown as CanvasRenderingContext2D, 1, 2,
{ cellW: 11, cellH: 22 } as EditorFontMetrics, 1.25, 1.5);
assert.deepEqual(overlapCalls, [[11, 44, 11.8, 22 + 2 / 3]],
  'background cells overlap by one backing pixel to cover fractional boundaries');
globalThis.window = originalWindow;

console.log('ok - onion rendering includes background and glyph channels');
