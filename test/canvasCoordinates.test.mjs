import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canvasCoordinates } from '../src/lib/canvasCoordinates.js';
import { compositeWorld } from '../src/lib/grid.js';

const rect = { left: 100, top: 50 };
const cellSize = { w: 10, h: 20 };
const bounds = { w: 4, h: 3 };

function point(x, y) {
  return canvasCoordinates({ clientX: x, clientY: y }, rect, cellSize, bounds);
}

assert.deepStrictEqual(point(100, 50), {
  fractional: { x: 0, y: 0 },
  cell: { x: 0, y: 0 },
  withinCell: { x: 0, y: 0 },
  subcell: { x: 0, y: 0 },
  boundedCell: { x: 0, y: 0 },
});

assert.deepStrictEqual(point(115, 75), {
  fractional: { x: 1.5, y: 1.25 },
  cell: { x: 1, y: 1 },
  withinCell: { x: 0.5, y: 0.25 },
  subcell: { x: 3, y: 2 },
  boundedCell: { x: 1, y: 1 },
});

assert.deepStrictEqual(point(95, 40), {
  fractional: { x: -0.5, y: -0.5 },
  cell: { x: -1, y: -1 },
  withinCell: { x: 0.5, y: 0.5 },
  subcell: { x: -1, y: -1 },
  boundedCell: { x: 0, y: 0 },
});

assert.deepStrictEqual(point(140, 110), {
  fractional: { x: 4, y: 3 },
  cell: { x: 4, y: 3 },
  withinCell: { x: 0, y: 0 },
  subcell: { x: 8, y: 6 },
  boundedCell: { x: 3, y: 2 },
});

const samples = [
  { clientX: 37, clientY: 13 },
  { clientX: 104.5, clientY: 81.25 },
  { clientX: 139.99, clientY: 109.99 },
  { clientX: 177, clientY: 147 },
];

for (const event of samples) {
  const result = canvasCoordinates(event, rect, cellSize, bounds);
  const translated = canvasCoordinates(
    { clientX: event.clientX + 317, clientY: event.clientY - 53 },
    { left: rect.left + 317, top: rect.top - 53 },
    cellSize,
    bounds,
  );

  assert.deepStrictEqual(translated, result);
  assert.ok(result.boundedCell.x >= 0 && result.boundedCell.x < bounds.w);
  assert.ok(result.boundedCell.y >= 0 && result.boundedCell.y < bounds.h);
  assert.ok(result.withinCell.x >= 0 && result.withinCell.x < 1);
  assert.ok(result.withinCell.y >= 0 && result.withinCell.y < 1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canvasSource = fs.readFileSync(path.join(root, 'src/components/Canvas.svelte'), 'utf8');
const moduleScript = canvasSource.match(/<script\s+(?:module|context=["']module["'])>([\s\S]*?)<\/script>/i);
assert.ok(moduleScript, 'Canvas must expose a pure module section for geometry tests');
const helperSource = `${moduleScript[1]}
  export { CANVAS_OVERSCAN, visibleCanvasViewport, sizeCanvasBacking, layoutViewportCanvas, canvasWithStableDimensions };
`;
const helpers = await import(`data:text/javascript;base64,${Buffer.from(helperSource).toString('base64')}`);
const {
  CANVAS_OVERSCAN,
  visibleCanvasViewport,
  sizeCanvasBacking,
  canvasWithStableDimensions,
} = helpers;

function assertViewportCoverage(viewportSize, documentSize, cellSize, pan) {
  const viewport = visibleCanvasViewport(viewportSize, documentSize, cellSize, pan);
  const originX = (viewportSize.w - documentSize.w * cellSize.w) / 2 + pan.x;
  const originY = (viewportSize.h - documentSize.h * cellSize.h) / 2 + pan.y;
  const screenLeft = originX + viewport.x * cellSize.w;
  const screenTop = originY + viewport.y * cellSize.h;
  const screenRight = screenLeft + viewport.w * cellSize.w;
  const screenBottom = screenTop + viewport.h * cellSize.h;

  assert.ok(screenLeft <= -CANVAS_OVERSCAN * cellSize.w + 1e-9, 'viewport covers left overscan');
  assert.ok(screenTop <= -CANVAS_OVERSCAN * cellSize.h + 1e-9, 'viewport covers top overscan');
  assert.ok(screenRight >= viewportSize.w + CANVAS_OVERSCAN * cellSize.w - 1e-9, 'viewport covers right overscan');
  assert.ok(screenBottom >= viewportSize.h + CANVAS_OVERSCAN * cellSize.h - 1e-9, 'viewport covers bottom overscan');
  assert.ok(
    viewport.w * cellSize.w <= viewportSize.w + (CANVAS_OVERSCAN * 2 + 2) * cellSize.w,
    'viewport backing width stays bounded by visible width plus overscan',
  );
  assert.ok(
    viewport.h * cellSize.h <= viewportSize.h + (CANVAS_OVERSCAN * 2 + 2) * cellSize.h,
    'viewport backing height stays bounded by visible height plus overscan',
  );
  return viewport;
}

const viewportSize = { w: 1000, h: 700 };
const documentSize = { w: 24, h: 18 };
const viewportCellSize = { w: 18, h: 40 };
for (const dimensions of [{ w: 1, h: 1 }, documentSize, { w: 256, h: 256 }]) {
  for (const pan of [
    { x: 0, y: 0 },
    { x: -317.5, y: 211.25 },
    { x: 983.25, y: -604.75 },
    { x: -1_000_000, y: 1_000_000 },
    { x: 1_000_000, y: -1_000_000 },
  ]) {
    assertViewportCoverage(viewportSize, dimensions, viewportCellSize, pan);
  }
}

for (const cell of [
  { x: -1_000_000, y: 750_000 },
  { x: 1_000_000, y: -750_000 },
]) {
  const baseX = (viewportSize.w - documentSize.w * viewportCellSize.w) / 2;
  const baseY = (viewportSize.h - documentSize.h * viewportCellSize.h) / 2;
  const pan = {
    x: viewportSize.w / 2 - (cell.x + 0.5) * viewportCellSize.w - baseX,
    y: viewportSize.h / 2 - (cell.y + 0.5) * viewportCellSize.h - baseY,
  };
  const viewport = assertViewportCoverage(viewportSize, documentSize, viewportCellSize, pan);
  assert.ok(cell.x >= viewport.x && cell.x < viewport.x + viewport.w, 'panned sparse x coordinate is rendered');
  assert.ok(cell.y >= viewport.y && cell.y < viewport.y + viewport.h, 'panned sparse y coordinate is rendered');
}

const distantCell = { x: 1_000_000, y: -750_000 };
const baseX = (viewportSize.w - documentSize.w * viewportCellSize.w) / 2;
const baseY = (viewportSize.h - documentSize.h * viewportCellSize.h) / 2;
const distantPan = {
  x: viewportSize.w / 2 - (distantCell.x + 0.5) * viewportCellSize.w - baseX,
  y: viewportSize.h / 2 - (distantCell.y + 0.5) * viewportCellSize.h - baseY,
};
const distantViewport = visibleCanvasViewport(viewportSize, documentSize, viewportCellSize, distantPan);
const distantWorld = compositeWorld([{
  id: 1,
  type: 'cell',
  visible: true,
  cells: { [`${distantCell.x},${distantCell.y}`]: { c: 'X', fg: '#ffffff' } },
}], distantViewport, { x: 0, y: 0, w: documentSize.w, h: documentSize.h });
assert.deepEqual(
  distantWorld[distantCell.y - distantViewport.y][distantCell.x - distantViewport.x],
  { c: 'X', fg: '#ffffff', offCanvas: true },
  'sparse off-canvas content composites when its panned viewport becomes visible',
);

function instrumentedCanvas(width = 300, height = 150) {
  let currentWidth = width;
  let currentHeight = height;
  const writes = { width: 0, height: 0 };
  const canvas = {
    dataset: {},
    style: {},
    get width() { return currentWidth; },
    set width(value) { writes.width++; currentWidth = value; },
    get height() { return currentHeight; },
    set height(value) { writes.height++; currentHeight = value; },
  };
  return { canvas, writes };
}

const sized = instrumentedCanvas();
assert.equal(sizeCanvasBacking(sized.canvas, 100, 50, 2).resized, true);
assert.deepEqual({ width: sized.canvas.width, height: sized.canvas.height }, { width: 200, height: 100 });
assert.deepEqual(sized.writes, { width: 1, height: 1 });
assert.deepEqual(sized.canvas.dataset, {
  widthAssignments: '1',
  heightAssignments: '1',
  backingResizes: '1',
});
assert.equal(sized.canvas.style.width, '100px');
assert.equal(sized.canvas.style.height, '50px');

assert.equal(sizeCanvasBacking(sized.canvas, 100, 50, 2).resized, false);
assert.deepEqual(sized.writes, { width: 1, height: 1 }, 'an unchanged hover or frame draw must not resize');
assert.equal(sized.canvas.dataset.backingResizes, '1');

sizeCanvasBacking(sized.canvas, 120, 50, 2);
assert.deepEqual(sized.writes, { width: 2, height: 1 }, 'only the changed backing dimension is assigned');
assert.equal(sized.canvas.dataset.backingResizes, '2');

const dprSized = instrumentedCanvas(0, 0);
sizeCanvasBacking(dprSized.canvas, 10.4, 20.4, 1.5);
assert.deepEqual({ width: dprSized.canvas.width, height: dprSized.canvas.height }, { width: 16, height: 31 });

const adapted = instrumentedCanvas(200, 100);
const adapter = canvasWithStableDimensions(adapted.canvas);
adapter.width = 200;
adapter.height = 100;
assert.deepEqual(adapted.writes, { width: 0, height: 0 });
adapter.width = 201;
adapter.width = 201;
assert.deepEqual(adapted.writes, { width: 1, height: 0 }, 'drawGrid adapter suppresses repeated width writes');

assert.doesNotMatch(
  canvasSource,
  /\b(?:worldCanvasEl|hoverCanvasEl)\.(?:width|height)\s*=/,
  'world and hover backing dimensions must use the guarded sizing helper',
);
assert.doesNotMatch(canvasSource, /\bMARGIN\b/, 'world geometry must not grow with pan distance');
assert.match(canvasSource, /layoutViewportCanvas\(\s*worldCanvasEl\b/);
assert.match(canvasSource, /layoutViewportCanvas\(\s*hoverCanvasEl\b/);

console.log('canvas coordinate and bounded backing tests passed');
