import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'svelte/store';
import * as F from '../src/lib/frames.js';
import * as G from '../src/lib/grid.js';
import { loadJSON, serializeJSON } from '../src/lib/fileio.js';
import {
  applyShapeBodyDrag,
  applyShapeGeometryEdit,
  captureShapeBodyDrag,
  shapeDirectEditTarget,
} from '../src/lib/shapeBodyDrag.js';
import {
  pathValueFromShape,
  shapePathEqual,
  translateShapePathKey,
} from '../src/lib/shapePath.js';
import {
  shapeTransformCageVertices,
  shapeTransformHandles,
  transformShapeFromCageHandle,
  transformShapeFromHandle,
} from '../src/lib/shapeTransform.js';
import {
  regularPolygonVertices,
  renderShapeToCells,
  resolvedShapeAnchor,
  resolvedShapeVertices,
} from '../src/lib/shapes.js';

const SHAPE_KINDS = ['line', 'rect', 'circle', 'polygon'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canvasSource = fs.readFileSync(
  path.join(root, 'src/components/Canvas.svelte'),
  'utf8',
);
assert.match(canvasSource, /shapeDirectEditTarget\(/,
  'Canvas delegates shape controls to the live-layer direct-edit model');
assert.doesNotMatch(canvasSource, /shapeWithPathValue/,
  'Canvas must not overlay a stale canonical Path snapshot on live rendered geometry');

function fixture(kind) {
  const common = {
    kind,
    style: 'outline',
    detail: 'cell',
    channel: 'glyph',
    char: '#',
    fg: '#ffffff',
    thickness: 1,
    strokeAlign: 'center',
  };
  if (kind === 'line') return { ...common, x0: 3, y0: 4, x1: 12, y1: 7 };
  if (kind === 'circle') return { ...common, x0: 4, y0: 4, x1: 23, y1: 10 };
  if (kind === 'polygon') {
    return {
      ...common,
      x0: 4,
      y0: 3,
      x1: 20,
      y1: 15,
      sides: 5,
      vertices: regularPolygonVertices(4, 3, 20, 15, 5),
      anchor: { x: 12, y: 9 },
      rotation: 0,
    };
  }
  return { ...common, x0: 4, y0: 4, x1: 14, y1: 10 };
}

function stroke(action) {
  G.beginStroke();
  const result = action();
  G.endStroke();
  return result;
}

function currentLayer(id) {
  return get(G.layers).find((layer) => layer.id === id) || null;
}

function handleSnapshot(shape) {
  return shapeTransformHandles(shape).map((handle) => ({
    id: handle.id,
    type: handle.type,
    x: handle.x,
    y: handle.y,
    targetX: handle.targetX,
    targetY: handle.targetY,
  }));
}

function assertControlsAttached(id, tool, stage) {
  const layer = currentLayer(id);
  assert.ok(layer?.shape, `${stage}: selected shape remains live`);
  const state = shapeDirectEditTarget(layer, tool, false);
  assert.equal(state.interactive, true, `${stage}: ${tool} keeps controls interactive`);
  assert.equal(state.layer, layer, `${stage}: controls consume the current rendered layer`);
  assert.deepEqual(layer.cells, renderShapeToCells(layer.shape),
    `${stage}: rendered cells and control geometry share one shape`);

  const vertices = resolvedShapeVertices(layer.shape);
  const cage = shapeTransformCageVertices(layer.shape);
  const handles = shapeTransformHandles(layer.shape);
  const vertexHandles = handles.filter(({ type }) => type === 'vertex');
  assert.equal(vertexHandles.length, vertices.length,
    `${stage}: every rendered vertex has one control`);
  vertexHandles.forEach((handle, index) => {
    assert.deepEqual({ x: handle.x, y: handle.y }, cage[index],
      `${stage}: ${handle.id} remains on the rendered cage`);
    assert.deepEqual({ x: handle.targetX, y: handle.targetY }, vertices[index],
      `${stage}: ${handle.id} targets its rendered vertex`);
  });

  for (const edge of handles.filter(({ type }) => type === 'edge')) {
    assert.deepEqual({ x: edge.x, y: edge.y }, {
      x: (cage[edge.from].x + cage[edge.to].x) / 2,
      y: (cage[edge.from].y + cage[edge.to].y) / 2,
    }, `${stage}: ${edge.id} remains centered on its cage edge`);
    assert.deepEqual({ x: edge.targetX, y: edge.targetY }, {
      x: (vertices[edge.from].x + vertices[edge.to].x) / 2,
      y: (vertices[edge.from].y + vertices[edge.to].y) / 2,
    }, `${stage}: ${edge.id} targets its rendered edge`);
  }

  const anchor = handles.find(({ type }) => type === 'anchor');
  assert.deepEqual({ x: anchor.x, y: anchor.y }, resolvedShapeAnchor(layer.shape),
    `${stage}: center anchor follows current geometry`);
  const rotation = handles.find(({ type }) => type === 'rotation');
  assert.ok(Number.isFinite(rotation.x) && Number.isFinite(rotation.y),
    `${stage}: rotation control follows current geometry`);
  const offset = layer.offset || { x: 0, y: 0 };
  assert.equal(handles.every((handle) =>
    Number.isFinite(handle.x + (offset.x || 0)) &&
    Number.isFinite(handle.y + (offset.y || 0))), true,
  `${stage}: every control has a finite rendered world position`);
  return { layer, handles };
}

function resizeFromHandle(id, handleId, delta) {
  const startShape = structuredClone(currentLayer(id).shape);
  const handle = shapeTransformHandles(startShape).find(({ id: candidate }) =>
    candidate === handleId);
  assert.ok(handle, `${handleId} exists before resize`);
  const target = { x: handle.x + delta.x, y: handle.y + delta.y };
  const next = transformShapeFromCageHandle(startShape, handleId, target);
  assert.ok(next, `${handleId} produces geometry`);
  assert.equal(stroke(() => applyShapeGeometryEdit(id, 0, next, startShape)), true);
  const settled = shapeTransformHandles(currentLayer(id).shape)
    .find(({ id: candidate }) => candidate === handleId);
  const expectedTarget = startShape.kind === 'polygon'
    ? { x: Math.round(target.x), y: Math.round(target.y) }
    : target;
  if (startShape.kind === 'polygon') {
    assert.ok(
      Math.abs(settled.x - expectedTarget.x) <= 0.5 &&
        Math.abs(settled.y - expectedTarget.y) <= 0.5,
      `${handleId} remains within its whole-cell pointer snap`,
    );
  } else {
    assert.deepEqual({ x: settled.x, y: settled.y }, expectedTarget,
      `${handleId} remains under the pointer in the settled frame`);
  }
}

function rotateShape(id) {
  const startShape = structuredClone(currentLayer(id).shape);
  const handles = shapeTransformHandles(startShape);
  const anchor = handles.find(({ type }) => type === 'anchor');
  const rotation = handles.find(({ type }) => type === 'rotation');
  const dx = rotation.x - anchor.x;
  const dy = rotation.y - anchor.y;
  const next = transformShapeFromHandle(startShape, 'rotation', {
    x: anchor.x - dy,
    y: anchor.y + dx,
  });
  assert.ok(next);
  assert.equal(stroke(() => applyShapeGeometryEdit(id, 0, next, startShape)), true);
}

for (const kind of SHAPE_KINDS) {
  G.dims.set({ w: 64, h: 32 });
  G.setLayers([{
    name: 'Base', type: 'cell', visible: true, cells: {},
  }]);
  F.initTimeline(get(G.layers));

  const beforeCreate = get(G.layers).length;
  const id = G.createShapeLayer(fixture(kind), renderShapeToCells);
  assert.ok(id, `${kind}: creation returns a layer id`);
  assert.equal(get(G.layers).length, beforeCreate + 1,
    `${kind}: creation adds exactly one shape layer`);
  assert.equal(get(G.activeLayerId), id, `${kind}: newly created shape remains selected`);
  assertControlsAttached(id, kind, `${kind} immediately after creation`);
  const wrongTool = SHAPE_KINDS.find((candidate) => candidate !== kind);
  assert.equal(shapeDirectEditTarget(currentLayer(id), wrongTool, false).layer, null,
    `${kind}: another creation tool remains free to draw`);

  F.commitLayersToActiveFrame();
  const firstHandle = kind === 'line' ? 'vertex:1' : 'vertex:2';
  resizeFromHandle(id, firstHandle, { x: 2, y: 1 });
  assert.equal(get(G.layers).length, beforeCreate + 1,
    `${kind}: immediate handle drag edits instead of creating another layer`);
  assertControlsAttached(id, kind, `${kind} after immediate resize`);
  F.commitLayersToActiveFrame();

  const pathBeforeMove = F.shapePathAt(id, 0);
  const bodyDrag = captureShapeBodyDrag(id, 0);
  assert.ok(bodyDrag);
  G.beginStroke();
  assert.equal(applyShapeBodyDrag(bodyDrag, 0, 3, -1), true);
  const livePathAfterMove = pathValueFromShape(currentLayer(id).shape);
  assert.equal(shapePathEqual(livePathAfterMove, pathBeforeMove), false,
    `${kind}: whole-shape move changes live rendered geometry immediately`);
  assert.equal(shapePathEqual(F.shapePathAt(id, 0), pathBeforeMove), true,
    `${kind}: canonical settlement remains pending during pointer movement`);
  assertControlsAttached(id, 'move', `${kind} during body movement`);
  G.endStroke();
  assertControlsAttached(id, 'move', `${kind} in the settled body-move frame`);
  F.commitLayersToActiveFrame();

  const secondHandle = kind === 'line'
    ? 'vertex:0'
    : (kind === 'polygon' ? 'vertex:1' : 'edge:1');
  const secondDelta = kind === 'line' ? { x: -1, y: 2 } : { x: 2, y: 0 };
  const beforeSecondResize = structuredClone(currentLayer(id).shape);
  resizeFromHandle(id, secondHandle, secondDelta);
  const afterSecondResize = structuredClone(currentLayer(id).shape);
  assertControlsAttached(id, 'move', `${kind} after second resize`);
  G.undo();
  assert.deepEqual(currentLayer(id).shape, beforeSecondResize,
    `${kind}: one Undo restores the pre-resize geometry and controls`);
  assertControlsAttached(id, 'move', `${kind} after Undo`);
  G.redo();
  assert.deepEqual(currentLayer(id).shape, afterSecondResize,
    `${kind}: one Redo restores the resized geometry and controls`);
  assertControlsAttached(id, 'move', `${kind} after Redo`);

  rotateShape(id);
  assert.notEqual(currentLayer(id).shape.rotation || 0, 0,
    `${kind}: rotation authors current geometry`);
  assertControlsAttached(id, 'move', `${kind} after rotation`);
  F.commitLayersToActiveFrame();

  F.addFrame();
  F.gotoFrame(0);
  assert.equal(F.togglePosKey(id, 0), true, `${kind}: Position track enables`);
  F.setLayerOffsetById(1, id, { x: 4, y: 2 });
  assert.equal(F.setShapePathTrackEnabled(id, true), true,
    `${kind}: Path track enables`);
  const pathAtZero = F.shapePathAt(id, 0);
  const pathAtOne = translateShapePathKey(pathAtZero, 2, 1);
  assert.equal(F.setShapePathById(1, id, pathAtOne), true,
    `${kind}: later Path key changes geometry`);

  F.gotoFrame(1);
  assert.deepEqual(currentLayer(id).offset, { x: 4, y: 2 },
    `${kind}: Position change reaches the rendered layer`);
  assert.equal(shapePathEqual(pathValueFromShape(currentLayer(id).shape), pathAtOne), true,
    `${kind}: tick seek resolves current Path geometry`);
  const tickOneHandles = assertControlsAttached(id, 'move', `${kind} at keyed tick 1`).handles;
  const ownToolHandles = assertControlsAttached(id, kind, `${kind} after tool switch`).handles;
  assert.deepEqual(ownToolHandles, tickOneHandles,
    `${kind}: Move and its own creation tool expose the same current controls`);

  if (kind === 'line') {
    for (const [endpoint, delta] of [[0, { x: -2, y: 3 }], [1, { x: 4, y: -1 }]]) {
      const beforeEndpointShape = structuredClone(currentLayer(id).shape);
      const beforeVertices = resolvedShapeVertices(beforeEndpointShape);
      const beforeAnchor = resolvedShapeAnchor(beforeEndpointShape);
      const handleId = `vertex:${endpoint}`;
      const handle = shapeTransformHandles(beforeEndpointShape)
        .find(({ id: candidate }) => candidate === handleId);
      const next = transformShapeFromCageHandle(beforeEndpointShape, handleId, {
        x: handle.x + delta.x,
        y: handle.y + delta.y,
      });
      assert.equal(stroke(() => applyShapeGeometryEdit(
        id,
        1,
        next,
        beforeEndpointShape,
      )), true);
      const afterEndpointShape = structuredClone(currentLayer(id).shape);
      const afterVertices = resolvedShapeVertices(afterEndpointShape);
      const expectedEndpoint = {
        x: beforeVertices[endpoint].x + delta.x,
        y: beforeVertices[endpoint].y + delta.y,
      };
      assert.ok(Math.hypot(
        afterVertices[endpoint].x - expectedEndpoint.x,
        afterVertices[endpoint].y - expectedEndpoint.y,
      ) < 1e-9, `line keyed ${handle.label} follows an asymmetric pointer delta`);
      assert.ok(Math.hypot(
        afterVertices[1 - endpoint].x - beforeVertices[1 - endpoint].x,
        afterVertices[1 - endpoint].y - beforeVertices[1 - endpoint].y,
      ) < 1e-9, `line keyed ${handle.label} leaves the opposite endpoint exact`);
      assert.deepEqual(resolvedShapeAnchor(afterEndpointShape), beforeAnchor,
        `line keyed ${handle.label} preserves the rotation pivot`);
      assert.equal(afterEndpointShape.rotation, beforeEndpointShape.rotation,
        `line keyed ${handle.label} preserves rotation metadata`);
      assertControlsAttached(id, 'line', `line keyed ${handle.label} under Line`);
      assertControlsAttached(id, 'move', `line keyed ${handle.label} under Move`);
      G.undo();
      assert.deepEqual(currentLayer(id).shape, beforeEndpointShape,
        `line keyed ${handle.label} has one exact Undo step`);
      G.redo();
      assert.deepEqual(currentLayer(id).shape, afterEndpointShape,
        `line keyed ${handle.label} has one exact Redo step`);
    }
  }

  const beforePropertyChange = F.shapePathAt(id, 1);
  const changedPropertyPath = translateShapePathKey(beforePropertyChange, 1, -2);
  assert.equal(stroke(() => F.setShapePathById(1, id, changedPropertyPath)), true,
    `${kind}: property-key edit changes the current pose`);
  assertControlsAttached(id, 'move', `${kind} after property key change`);
  G.undo();
  assert.equal(shapePathEqual(F.shapePathAt(id, 1), beforePropertyChange), true,
    `${kind}: Undo restores the prior property key`);
  assertControlsAttached(id, 'move', `${kind} after property-key Undo`);
  G.redo();
  assert.equal(shapePathEqual(F.shapePathAt(id, 1), changedPropertyPath), true,
    `${kind}: Redo restores the changed property key`);
  assertControlsAttached(id, 'move', `${kind} after property-key Redo`);

  F.gotoFrame(0);
  assert.equal(shapePathEqual(pathValueFromShape(currentLayer(id).shape), pathAtZero), true,
    `${kind}: seeking backward restores tick 0 geometry`);
  assertControlsAttached(id, 'move', `${kind} after seeking to tick 0`);
  F.gotoFrame(1);
  assert.equal(shapePathEqual(
    pathValueFromShape(currentLayer(id).shape),
    changedPropertyPath,
  ), true, `${kind}: seeking forward restores changed tick 1 geometry`);
  const beforeSaveLayer = structuredClone(currentLayer(id));
  const beforeSaveHandles = handleSnapshot(beforeSaveLayer.shape);

  loadJSON(serializeJSON());
  assert.equal(get(G.activeLayerId), id, `${kind}: save/reopen preserves selected shape id`);
  F.gotoFrame(1);
  assert.deepEqual(currentLayer(id).shape, beforeSaveLayer.shape,
    `${kind}: save/reopen preserves current rendered geometry`);
  assert.deepEqual(currentLayer(id).offset, beforeSaveLayer.offset,
    `${kind}: save/reopen preserves current Position`);
  assert.deepEqual(handleSnapshot(currentLayer(id).shape), beforeSaveHandles,
    `${kind}: save/reopen preserves every control coordinate`);
  assertControlsAttached(id, kind, `${kind} after save/reopen`);
}

function polygonLifecycleFixture(sides) {
  const base = fixture('polygon');
  const vertices = regularPolygonVertices(8, 4, 34, 24, sides);
  return {
    ...base,
    sides,
    vertices,
    x0: Math.min(...vertices.map(({ x }) => x)),
    y0: Math.min(...vertices.map(({ y }) => y)),
    x1: Math.max(...vertices.map(({ x }) => x)),
    y1: Math.max(...vertices.map(({ y }) => y)),
    anchor: { x: 21, y: 14 },
    rotation: 17,
  };
}

function changedIndices(before, after) {
  return before.flatMap((point, index) => (
    point.x === after[index].x && point.y === after[index].y ? [] : [index]
  ));
}

function exerciseEveryPolygonEdge(id, sides, frame, stage) {
  for (let edgeIndex = 0; edgeIndex < sides; edgeIndex++) {
    const before = structuredClone(currentLayer(id).shape);
    const beforePath = pathValueFromShape(before);
    const handleId = `edge:${edgeIndex}`;
    const handle = shapeTransformHandles(before).find(({ id }) => id === handleId);
    const direction = edgeIndex % 2 ? -1 : 1;
    const edited = transformShapeFromCageHandle(before, handleId, {
      x: handle.x + direction * 3,
      y: handle.y - direction * 2,
    }, { ctrl: true, alt: true, shift: true });
    assert.equal(stroke(() => applyShapeGeometryEdit(id, frame, edited, before)), true);
    const after = structuredClone(currentLayer(id).shape);
    const adjacent = [edgeIndex, (edgeIndex + 1) % sides].sort((a, b) => a - b);
    assert.deepEqual(changedIndices(before.vertices, after.vertices), adjacent,
      `${stage}: ${handleId} changes only adjacent vertex indices`);
    assert.deepEqual(after.anchor, before.anchor, `${stage}: ${handleId} preserves anchor`);
    assert.equal(after.rotation, before.rotation, `${stage}: ${handleId} preserves rotation`);
    assert.equal(after.sides, sides, `${stage}: ${handleId} preserves the closed side count`);
    assert.deepEqual(currentLayer(id).cells, renderShapeToCells(after),
      `${stage}: ${handleId} updates the visible raster from local geometry`);
    assertControlsAttached(id, edgeIndex % 2 ? 'move' : 'polygon',
      `${stage}: ${handleId} controls`);
    G.undo();
    assert.equal(shapePathEqual(pathValueFromShape(currentLayer(id).shape), beforePath), true,
      `${stage}: ${handleId} Undo restores the exact path`);
    G.redo();
    assert.deepEqual(currentLayer(id).shape, after,
      `${stage}: ${handleId} Redo restores the local edge edit`);
    G.undo();
  }
}

for (const sides of [3, 4, 5, 8]) {
  G.dims.set({ w: 64, h: 32 });
  G.setLayers([{ name: 'Base', type: 'cell', visible: true, cells: {} }]);
  F.initTimeline(get(G.layers));
  const id = G.createShapeLayer(polygonLifecycleFixture(sides), renderShapeToCells);
  F.commitLayersToActiveFrame();

  exerciseEveryPolygonEdge(id, sides, 0, `${sides}-side static polygon`);
  const drag = captureShapeBodyDrag(id, 0);
  G.beginStroke();
  assert.equal(applyShapeBodyDrag(drag, 0, 5, -3), true);
  G.endStroke();
  F.commitLayersToActiveFrame();
  exerciseEveryPolygonEdge(id, sides, 0, `${sides}-side polygon after body move`);

  F.addFrame();
  F.gotoFrame(0);
  assert.equal(F.togglePosKey(id, 0), true);
  F.setLayerOffsetById(1, id, { x: 7, y: 4 });
  assert.equal(F.setShapePathTrackEnabled(id, true), true);
  const keyedPath = translateShapePathKey(F.shapePathAt(id, 0), -2, 1);
  assert.equal(F.setShapePathById(1, id, keyedPath), true);
  F.gotoFrame(1);
  exerciseEveryPolygonEdge(id, sides, 1,
    `${sides}-side keyed polygon with Position offset`);
}

console.log('shape editing lifecycle tests passed');
