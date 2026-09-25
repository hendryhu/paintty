import assert from 'node:assert/strict';
import {
  FRAME_THUMBNAIL_LIMITS,
  buildFilmstripSamples,
  buildFrameThumbnailModel,
  createFrameThumbnailAction,
  thumbnailFrameValue,
} from '../src/lib/timelineThumbnails.ts';
import {
  requireValue,
  visualTimelineClip,
  type EditorCell,
} from './types/timeline-media-test-types.ts';

const clip = visualTimelineClip({
  frameKeys: [
    { tick: 0, value: { cells: { '0,0': { c: 'A', fg: '#ffffff' } } } },
    { tick: 4, value: { cells: { '3,2': { c: 'B', fg: '#00ff00', bg: '#001100' } } } },
  ],
});
assert.equal(thumbnailFrameValue(clip, { keyIndex: 1, sourceTick: 4 }), requireValue(clip.frameKeys[1]).value);
assert.equal(thumbnailFrameValue(clip, { keyIndex: 9, sourceTick: 3 }), requireValue(clip.frameKeys[0]).value);
const sampledClip = visualTimelineClip({
  startTick: 0,
  inTick: 0,
  outTick: 100,
  sourceDuration: 100,
});
const samples = buildFilmstripSamples(sampledClip, { startTick: 10, endTick: 30 }, 10);
assert.equal(samples.length, 4);
assert.deepEqual(samples.map(({ projectTick }) => projectTick), [12, 17, 22, 27]);
assert.equal(samples.every((sample) => sample.pixelWidth >= 40 && sample.pixelWidth <= 64), true,
  'visible filmstrip tiles stay near the target width');
assert.equal(requireValue(samples[0]).startTick, 10);
assert.equal(requireValue(samples.at(-1)).endTick, 30);
const cappedSamples = buildFilmstripSamples(sampledClip, { startTick: 0, endTick: 100 }, 1000);
assert.equal(cappedSamples.length, FRAME_THUMBNAIL_LIMITS.maxFilmstripSamples,
  'backing work is capped for very wide clips');
assert.equal(buildFilmstripSamples(sampledClip, { startTick: 101, endTick: 120 }, 10).length, 0);
assert.deepEqual(buildFrameThumbnailModel({ cells: {} }), {
  empty: true, cells: [], bounds: null, truncated: false,
});
assert.deepEqual(buildFrameThumbnailModel(requireValue(clip.frameKeys[1]).value).bounds, {
  x: 3, y: 2, width: 1, height: 1,
});
const fullFrame = buildFrameThumbnailModel(requireValue(clip.frameKeys[1]).value, {
  frameWidth: 80,
  frameHeight: 24,
  offset: { x: 4, y: 2 },
});
assert.deepEqual(fullFrame.bounds, { x: 0, y: 0, width: 80, height: 24 });
assert.deepEqual(fullFrame.cells.map(({ x, y }) => ({ x, y })), [{ x: 7, y: 4 }],
  'filmstrip cells retain their position in the full project frame');
assert.deepEqual(buildFrameThumbnailModel({ cells: {} }, {
  frameWidth: 80,
  frameHeight: 24,
}).bounds, { x: 0, y: 0, width: 80, height: 24 });
assert.equal(buildFrameThumbnailModel({}, {
  frameWidth: 80,
  frameHeight: 24,
  reference: true,
}).reference, true, 'video fallback is an explicit reference frame');
const huge = buildFrameThumbnailModel({
  cells: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
    `${index},0`, { c: 'X', fg: '#ffffff' },
  ])),
});
assert.equal(huge.cells.length, FRAME_THUMBNAIL_LIMITS.maxModelCells);
assert.equal(huge.truncated, true);
assert.deepEqual(huge.bounds, { x: 0, y: 0, width: 1000, height: 1 });

const orderedCells: Array<[string, EditorCell]> = Array.from({ length: 600 }, (_, index) => [
  `${index % 30},${Math.floor(index / 30)}`,
  { c: String.fromCharCode(65 + index % 26), fg: '#ffffff', bg: index % 7 ? null : '#112233' },
]);
orderedCells.push(['10000,10000', { c: 'Z', fg: '#ff00ff' }]);
const forward = buildFrameThumbnailModel({ cells: Object.fromEntries(orderedCells) });
const reverse = buildFrameThumbnailModel({ cells: Object.fromEntries([...orderedCells].reverse()) });
assert.deepEqual(reverse, forward,
  'large thumbnail sampling is independent of cell insertion order');
assert.equal(forward.cells.length <= FRAME_THUMBNAIL_LIMITS.maxModelCells, true);
assert.equal(forward.cells.some((entry) => entry.x === 10000 && entry.y === 10000), true,
  'spatial sampling retains a distant feature');
assert.deepEqual(forward.bounds, { x: 0, y: 0, width: 10001, height: 10001 });

const denseEntries: Array<[string, EditorCell]> = Array.from({ length: 432 }, (_, index) => [
  `${index % 24},${Math.floor(index / 24)}`,
  { c: index === 431 ? 'Z' : 'A', fg: index === 431 ? '#ff0000' : '#ffffff' },
]);
const dense = buildFrameThumbnailModel({ cells: Object.fromEntries(denseEntries) });
assert.equal(dense.cells.some((entry) => entry.cell.c === 'Z'), true,
  'a rare glyph/color signature wins its spatial bin over common content');

const exactEntries = orderedCells.slice(0, FRAME_THUMBNAIL_LIMITS.maxModelCells);
const exact = buildFrameThumbnailModel({ cells: Object.fromEntries([...exactEntries].reverse()) });
assert.equal(exact.truncated, false);
assert.equal(exact.cells.length, FRAME_THUMBNAIL_LIMITS.maxModelCells);
assert.deepEqual(exact.cells.map(({ x, y }) => [x, y]),
  exactEntries.map(([key]) => key.split(',').map(Number)).sort((first, second) =>
    requireValue(first[1]) - requireValue(second[1]) ||
    requireValue(first[0]) - requireValue(second[0])),
  'a model at the limit contains every valid cell exactly');

let disconnected = 0;
let observed = 0;
class Observer {
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) { this.callback = callback; }
  observe(_target: Element, _options?: ResizeObserverOptions): void { observed++; }
  unobserve(_target: Element): void {}
  disconnect(): void { disconnected++; }
}
type CanvasCall = [string, ...unknown[]];
const calls: CanvasCall[] = [];
const context = Object.assign(Object.create(null) as CanvasRenderingContext2D, {
  clearRect(...args: Parameters<CanvasRenderingContext2D['clearRect']>): void {
    calls.push(['clearRect', ...args]);
  },
  fillRect(...args: Parameters<CanvasRenderingContext2D['fillRect']>): void {
    calls.push(['fillRect', ...args]);
  },
  fillText(...args: Parameters<CanvasRenderingContext2D['fillText']>): void {
    calls.push(['fillText', ...args]);
  },
  save(): void {},
  restore(): void {},
  rect(): void {},
  clip(): void {},
  translate(): void {},
  beginPath(): void {},
  moveTo(): void {},
  lineTo(): void {},
  stroke(): void {},
});
Object.defineProperties(context, {
  fillStyle: { set(value: CanvasRenderingContext2D['fillStyle']) { calls.push(['fillStyle', value]); } },
  strokeStyle: { set(value: CanvasRenderingContext2D['strokeStyle']) { calls.push(['strokeStyle', value]); } },
  font: { set(_value: string) {} },
  textAlign: { set(_value: CanvasTextAlign) {} },
  textBaseline: { set(_value: CanvasTextBaseline) {} },
});
const node = Object.assign(Object.create(null) as HTMLCanvasElement, {
  width: 0,
  height: 0,
  getBoundingClientRect: () => ({ width: 50_000, height: 10_000 }) as DOMRect,
});
function fakeGetContext(
  contextId: '2d',
  options?: CanvasRenderingContext2DSettings,
): CanvasRenderingContext2D | null;
function fakeGetContext(
  contextId: 'bitmaprenderer',
  options?: ImageBitmapRenderingContextSettings,
): ImageBitmapRenderingContext | null;
function fakeGetContext(
  contextId: 'webgl' | 'experimental-webgl',
  options?: WebGLContextAttributes,
): WebGLRenderingContext | null;
function fakeGetContext(
  contextId: 'webgl2',
  options?: WebGLContextAttributes,
): WebGL2RenderingContext | null;
function fakeGetContext(contextId: string, options?: object): RenderingContext | null;
function fakeGetContext(contextId: string, _options?: object): RenderingContext | null {
  return contextId === '2d' ? context : null;
}
node.getContext = fakeGetContext;
const thumbnailTheme = {
  emptySurface: 'empty-surface',
  emptyLine: 'empty-line',
  referenceSurface: 'reference-surface',
  referenceLine: 'reference-line',
  referenceText: 'reference-text',
};
const action = createFrameThumbnailAction({
  ResizeObserver: Observer,
  devicePixelRatio: () => 4,
  themeColors: () => thumbnailTheme,
})(node, { model: huge });
assert.equal(observed, 1);
assert.equal(node.width, FRAME_THUMBNAIL_LIMITS.maxBackingWidth);
assert.equal(node.height, FRAME_THUMBNAIL_LIMITS.maxBackingHeight);
assert.equal(FRAME_THUMBNAIL_LIMITS.maxDevicePixelRatio, 2);
assert.equal(calls.some((call) => call[0] === 'fillRect'), true);
action.update({ model: buildFrameThumbnailModel({ cells: {} }) });
assert.equal(calls.some((call) => call[0] === 'fillStyle' && call[1] === thumbnailTheme.emptySurface), true);
assert.equal(calls.some((call) => call[0] === 'strokeStyle' && call[1] === thumbnailTheme.emptyLine), true);
action.destroy();
assert.equal(disconnected, 1);
assert.equal(requireValue(calls.at(-1))[0], 'clearRect');
console.log('bounded frame thumbnail model and cleanup tests passed');
