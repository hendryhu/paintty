import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'svelte/store';
import * as F from '../src/lib/frames.ts';
import * as G from '../src/lib/grid.ts';
import { loadJSON, serializeJSON } from '../src/lib/fileio.ts';
import {
  applyShapeBodyDrag,
  applyShapeGeometryEdit,
  captureShapeBodyDrag,
  shapeDirectEditTarget,
} from '../src/lib/shapeBodyDrag.ts';
import {
  pathValueFromShape,
  shapePathEqual,
  translateShapePathKey,
} from '../src/lib/shapePath.ts';
import {
  shapeTransformCageVertices,
  shapeTransformHandles,
  transformShapeFromCageHandle,
  transformShapeFromHandle,
} from '../src/lib/shapeTransform.ts';
import type { ShapeTransformHandle } from '../src/lib/shapeTransform.ts';
import {
  regularPolygonVertices,
  renderShapeToCells,
  resolvedShapeAnchor,
  resolvedShapeVertices,
} from '../src/lib/shapes.ts';
import type {
  EditorPoint,
  EditorShape,
  EditorShapeKind,
  EditorShapeLayer,
} from '../src/lib/types/editor-domain.ts';

type VertexShapeHandle = ShapeTransformHandle & { type: 'vertex' };
type EdgeShapeHandle = ShapeTransformHandle & { type: 'edge' };
type AnchorShapeHandle = ShapeTransformHandle & { type: 'anchor' };
type RotationShapeHandle = ShapeTransformHandle & { type: 'rotation' };

const SHAPE_KINDS: readonly EditorShapeKind[] = ['line', 'rect', 'circle', 'polygon'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canvasSource = fs.readFileSync(
  path.join(root, 'src/components/Canvas.svelte'),
  'utf8',
);
assert.match(canvasSource, /shapeDirectEditTarget\(/,
  'Canvas delegates shape controls to the live-layer direct-edit model');
assert.doesNotMatch(canvasSource, /shapeWithPathValue/,
  'Canvas must not overlay a stale canonical Path snapshot on live rendered geometry');

function required<T>(value: T | null | undefined, message: string): T {
  if (value == null) assert.fail(message);
  return value;
}

function requiredLayerId(value: string | false, message: string): string {
  if (value === false) assert.fail(message);
  return value;
}

function pointAt(points: readonly EditorPoint[], index: number, message: string): EditorPoint {
  return required(points[index], message);
}

function isVertexShapeHandle(handle: ShapeTransformHandle): handle is VertexShapeHandle {
  return handle.type === 'vertex';
}

function isEdgeShapeHandle(handle: ShapeTransformHandle): handle is EdgeShapeHandle {
  return handle.type === 'edge';
}

function isAnchorShapeHandle(handle: ShapeTransformHandle): handle is AnchorShapeHandle {
  return handle.type === 'anchor';
}

function isRotationShapeHandle(handle: ShapeTransformHandle): handle is RotationShapeHandle {
  return handle.type === 'rotation';
}

function fixture(kind: EditorShapeKind): EditorShape {
  const common = {
    style: 'outline',
    detail: 'cell',
    channel: 'glyph',
    char: '#',
    fg: '#ffffff',
    thickness: 1,
    strokeAlign: 'center',
  } satisfies Pick<
    EditorShape,
    'style' | 'detail' | 'channel' | 'char' | 'fg' | 'thickness' | 'strokeAlign'
  >;
  if (kind === 'line') return { kind, ...common, x0: 3, y0: 4, x1: 12, y1: 7 };
  if (kind === 'circle') return { kind, ...common, x0: 4, y0: 4, x1: 23, y1: 10 };
  if (kind === 'polygon') {
    return {
      kind,
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
  return { kind, ...common, x0: 4, y0: 4, x1: 14, y1: 10 };
}

function stroke<T>(action: () => T): T {
  G.beginStroke();
  const result = action();
  G.endStroke();
  return result;
}

function currentLayer(id: string): EditorShapeLayer {
  const layer = get(G.layers).find((candidate) => candidate.id === id);
  if (layer?.type !== 'shape') assert.fail(`shape layer ${id} remains available`);
  return layer;
}

function currentShape(id: string): EditorShape {
  return required(currentLayer(id).shape, `shape layer ${id} retains geometry`);
}

function handleSnapshot(shape: EditorShape) {
  return shapeTransformHandles(shape).map((handle: ShapeTransformHandle) => ({
    id: handle.id,
    type: handle.type,
    x: handle.x,
    y: handle.y,
    targetX: handle.targetX,
    targetY: handle.targetY,
  }));
}

function assertControlsAttached(id: string, tool: string, stage: string): {
  layer: EditorShapeLayer;
  handles: ShapeTransformHandle[];
} {
  const layer = currentLayer(id);
  const shape = required(layer.shape, `${stage}: selected shape remains live`);
  const state = shapeDirectEditTarget(layer, tool, false);
  assert.equal(state.interactive, true, `${stage}: ${tool} keeps controls interactive`);
  assert.equal(state.layer, layer, `${stage}: controls consume the current rendered layer`);
  assert.deepEqual(layer.cells, renderShapeToCells(shape),
    `${stage}: rendered cells and control geometry share one shape`);

  const vertices = resolvedShapeVertices(shape);
  const cage = shapeTransformCageVertices(shape);
  const handles = shapeTransformHandles(shape);
  const vertexHandles = handles.filter(isVertexShapeHandle);
  assert.equal(vertexHandles.length, vertices.length,
    `${stage}: every rendered vertex has one control`);
  vertexHandles.forEach((handle, index) => {
    assert.deepEqual({ x: handle.x, y: handle.y },
      pointAt(cage, index, `${stage}: ${handle.id} has a cage vertex`),
      `${stage}: ${handle.id} remains on the rendered cage`);
    assert.deepEqual({
      x: required(handle.targetX, `${stage}: ${handle.id} has a target x`),
      y: required(handle.targetY, `${stage}: ${handle.id} has a target y`),
    }, pointAt(vertices, index, `${stage}: ${handle.id} has a rendered vertex`),
      `${stage}: ${handle.id} targets its rendered vertex`);
  });

  for (const edge of handles.filter(isEdgeShapeHandle)) {
    const from = required(edge.from, `${stage}: ${edge.id} has a start vertex`);
    const to = required(edge.to, `${stage}: ${edge.id} has an end vertex`);
    const cageFrom = pointAt(cage, from, `${stage}: ${edge.id} start is on the cage`);
    const cageTo = pointAt(cage, to, `${stage}: ${edge.id} end is on the cage`);
    const vertexFrom = pointAt(vertices, from, `${stage}: ${edge.id} start is rendered`);
    const vertexTo = pointAt(vertices, to, `${stage}: ${edge.id} end is rendered`);
    assert.deepEqual({ x: edge.x, y: edge.y }, {
      x: (cageFrom.x + cageTo.x) / 2,
      y: (cageFrom.y + cageTo.y) / 2,
    }, `${stage}: ${edge.id} remains centered on its cage edge`);
    assert.deepEqual({
      x: required(edge.targetX, `${stage}: ${edge.id} has a target x`),
      y: required(edge.targetY, `${stage}: ${edge.id} has a target y`),
    }, {
      x: (vertexFrom.x + vertexTo.x) / 2,
      y: (vertexFrom.y + vertexTo.y) / 2,
    }, `${stage}: ${edge.id} targets its rendered edge`);
  }

  const anchor = required(handles.find(isAnchorShapeHandle),
    `${stage}: center anchor control exists`);
  assert.deepEqual({ x: anchor.x, y: anchor.y }, resolvedShapeAnchor(shape),
    `${stage}: center anchor follows current geometry`);
  const rotation = required(handles.find(isRotationShapeHandle),
    `${stage}: rotation control exists`);
  assert.ok(Number.isFinite(rotation.x) && Number.isFinite(rotation.y),
    `${stage}: rotation control follows current geometry`);
  const offset = layer.offset || { x: 0, y: 0 };
  assert.equal(handles.every((handle) =>
    Number.isFinite(handle.x + (offset.x || 0)) &&
    Number.isFinite(handle.y + (offset.y || 0))), true,
  `${stage}: every control has a finite rendered world position`);
  return { layer, handles };
}

function resizeFromHandle(id: string, handleId: string, delta: EditorPoint): void {
  const startShape = structuredClone(currentShape(id));
  const handle = required(
    shapeTransformHandles(startShape).find(({ id: candidate }) => candidate === handleId),
    `${handleId} exists before resize`,
  );
  const target = { x: handle.x + delta.x, y: handle.y + delta.y };
  const next = transformShapeFromCageHandle(startShape, handleId, target);
  assert.ok(next, `${handleId} produces geometry`);
  assert.equal(stroke(() => applyShapeGeometryEdit(id, 0, next, startShape)), true);
  const settled = required(
    shapeTransformHandles(currentShape(id))
      .find(({ id: candidate }) => candidate === handleId),
    `${handleId} exists after resize`,
  );
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

function rotateShape(id: string): void {
  const startShape = structuredClone(currentShape(id));
  const handles = shapeTransformHandles(startShape);
  const anchor = required(handles.find(isAnchorShapeHandle), 'anchor handle exists before rotation');
  const rotation = required(handles.find(isRotationShapeHandle),
    'rotation handle exists before rotation');
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
  const wrongTool = required(SHAPE_KINDS.find((candidate) => candidate !== kind),
    `${kind}: another creation tool exists`);
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
  const livePathAfterMove = pathValueFromShape(currentShape(id));
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
  const secondDelta: EditorPoint = kind === 'line' ? { x: -1, y: 2 } : { x: 2, y: 0 };
  const beforeSecondResize = structuredClone(currentShape(id));
  resizeFromHandle(id, secondHandle, secondDelta);
  const afterSecondResize = structuredClone(currentShape(id));
  assertControlsAttached(id, 'move', `${kind} after second resize`);
  G.undo();
  assert.deepEqual(currentShape(id), beforeSecondResize,
    `${kind}: one Undo restores the pre-resize geometry and controls`);
  assertControlsAttached(id, 'move', `${kind} after Undo`);
  G.redo();
  assert.deepEqual(currentShape(id), afterSecondResize,
    `${kind}: one Redo restores the resized geometry and controls`);
  assertControlsAttached(id, 'move', `${kind} after Redo`);

  rotateShape(id);
  assert.notEqual(currentShape(id).rotation || 0, 0,
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
  assert.equal(shapePathEqual(pathValueFromShape(currentShape(id)), pathAtOne), true,
    `${kind}: tick seek resolves current Path geometry`);
  const tickOneHandles = assertControlsAttached(id, 'move', `${kind} at keyed tick 1`).handles;
  const ownToolHandles = assertControlsAttached(id, kind, `${kind} after tool switch`).handles;
  assert.deepEqual(ownToolHandles, tickOneHandles,
    `${kind}: Move and its own creation tool expose the same current controls`);

  if (kind === 'line') {
    const endpointDeltas: readonly [
      readonly [endpoint: 0, delta: EditorPoint],
      readonly [endpoint: 1, delta: EditorPoint],
    ] = [[0, { x: -2, y: 3 }], [1, { x: 4, y: -1 }]];
    for (const [endpoint, delta] of endpointDeltas) {
      const beforeEndpointShape: EditorShape = structuredClone(currentShape(id));
      const beforeVertices = resolvedShapeVertices(beforeEndpointShape);
      const beforeAnchor = resolvedShapeAnchor(beforeEndpointShape);
      const handleId = `vertex:${endpoint}`;
      const handle: VertexShapeHandle = required(
        shapeTransformHandles(beforeEndpointShape)
          .find((candidate): candidate is VertexShapeHandle =>
            isVertexShapeHandle(candidate) && candidate.id === handleId),
        `${handleId} exists for keyed line editing`,
      );
      const next = transformShapeFromCageHandle(beforeEndpointShape, handleId, {
        x: handle.x + delta.x,
        y: handle.y + delta.y,
      });
      assert.equal(stroke((): boolean => applyShapeGeometryEdit(
        id,
        1,
        next,
        beforeEndpointShape,
      )), true);
      const afterEndpointShape: EditorShape = structuredClone(currentShape(id));
      const afterVertices = resolvedShapeVertices(afterEndpointShape);
      const beforeEndpoint = pointAt(beforeVertices, endpoint,
        `line keyed ${handle.label} has a starting endpoint`);
      const afterEndpoint = pointAt(afterVertices, endpoint,
        `line keyed ${handle.label} has a settled endpoint`);
      const expectedEndpoint = {
        x: beforeEndpoint.x + delta.x,
        y: beforeEndpoint.y + delta.y,
      };
      assert.ok(Math.hypot(
        afterEndpoint.x - expectedEndpoint.x,
        afterEndpoint.y - expectedEndpoint.y,
      ) < 1e-9, `line keyed ${handle.label} follows an asymmetric pointer delta`);
      const oppositeEndpoint = endpoint === 0 ? 1 : 0;
      const afterOpposite = pointAt(afterVertices, oppositeEndpoint,
        `line keyed ${handle.label} has an opposite endpoint`);
      const beforeOpposite = pointAt(beforeVertices, oppositeEndpoint,
        `line keyed ${handle.label} has a starting opposite endpoint`);
      assert.ok(Math.hypot(
        afterOpposite.x - beforeOpposite.x,
        afterOpposite.y - beforeOpposite.y,
      ) < 1e-9, `line keyed ${handle.label} leaves the opposite endpoint exact`);
      assert.deepEqual(resolvedShapeAnchor(afterEndpointShape), beforeAnchor,
        `line keyed ${handle.label} preserves the rotation pivot`);
      assert.equal(afterEndpointShape.rotation, beforeEndpointShape.rotation,
        `line keyed ${handle.label} preserves rotation metadata`);
      assertControlsAttached(id, 'line', `line keyed ${handle.label} under Line`);
      assertControlsAttached(id, 'move', `line keyed ${handle.label} under Move`);
      G.undo();
      assert.deepEqual(currentShape(id), beforeEndpointShape,
        `line keyed ${handle.label} has one exact Undo step`);
      G.redo();
      assert.deepEqual(currentShape(id), afterEndpointShape,
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
  assert.equal(shapePathEqual(pathValueFromShape(currentShape(id)), pathAtZero), true,
    `${kind}: seeking backward restores tick 0 geometry`);
  assertControlsAttached(id, 'move', `${kind} after seeking to tick 0`);
  F.gotoFrame(1);
  assert.equal(shapePathEqual(
    pathValueFromShape(currentShape(id)),
    changedPropertyPath,
  ), true, `${kind}: seeking forward restores changed tick 1 geometry`);
  const beforeSaveLayer = structuredClone(currentLayer(id));
  const beforeSaveShape = required(beforeSaveLayer.shape,
    `${kind}: shape geometry is available before save`);
  const beforeSaveHandles = handleSnapshot(beforeSaveShape);

  loadJSON(serializeJSON());
  assert.equal(get(G.activeLayerId), id, `${kind}: save/reopen preserves selected shape id`);
  F.gotoFrame(1);
  assert.deepEqual(currentShape(id), beforeSaveShape,
    `${kind}: save/reopen preserves current rendered geometry`);
  assert.deepEqual(currentLayer(id).offset, beforeSaveLayer.offset,
    `${kind}: save/reopen preserves current Position`);
  assert.deepEqual(handleSnapshot(currentShape(id)), beforeSaveHandles,
    `${kind}: save/reopen preserves every control coordinate`);
  assertControlsAttached(id, kind, `${kind} after save/reopen`);
}

function polygonLifecycleFixture(sides: number): EditorShape {
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

function changedIndices(
  before: readonly EditorPoint[],
  after: readonly EditorPoint[],
): number[] {
  return before.flatMap((point: EditorPoint, index: number): number[] => {
    const afterPoint = pointAt(after, index, `changed point ${index} exists`);
    return point.x === afterPoint.x && point.y === afterPoint.y ? [] : [index];
  });
}

function changedWorldIndices(
  before: readonly EditorPoint[],
  after: readonly EditorPoint[],
  epsilon = 1e-9,
): number[] {
  return before.flatMap((point: EditorPoint, index: number): number[] => {
    const afterPoint = pointAt(after, index, `changed world point ${index} exists`);
    return Math.abs(point.x - afterPoint.x) <= epsilon &&
      Math.abs(point.y - afterPoint.y) <= epsilon ? [] : [index];
  });
}

function exerciseEveryPolygonEdge(
  id: string,
  sides: number,
  frame: number,
  stage: string,
): void {
  for (let edgeIndex = 0; edgeIndex < sides; edgeIndex++) {
    const before = structuredClone(currentShape(id));
    const beforeWorld = resolvedShapeVertices(before);
    const beforePath = pathValueFromShape(before);
    const handleId = `edge:${edgeIndex}`;
    const handle = required(
      shapeTransformHandles(before).find((candidate): candidate is EdgeShapeHandle =>
        isEdgeShapeHandle(candidate) && candidate.id === handleId),
      `${stage}: ${handleId} exists`,
    );
    const direction = edgeIndex % 2 ? -1 : 1;
    const edited = transformShapeFromCageHandle(before, handleId, {
      x: handle.x + direction * 3,
      y: handle.y - direction * 2,
    }, { ctrl: true, alt: true, shift: true });
    assert.equal(stroke(() => applyShapeGeometryEdit(id, frame, edited, before)), true);
    const after = structuredClone(currentShape(id));
    const afterWorld = resolvedShapeVertices(after);
    const adjacent = [edgeIndex, (edgeIndex + 1) % sides]
      .sort((a: number, b: number) => a - b);
    assert.deepEqual(changedWorldIndices(beforeWorld, afterWorld), adjacent,
      `${stage}: ${handleId} changes only adjacent rendered vertices`);
    assert.equal(Number.isFinite(after.anchor?.x) && Number.isFinite(after.anchor?.y), true,
      `${stage}: ${handleId} keeps a finite transform anchor`);
    assert.equal(after.rotation, before.rotation, `${stage}: ${handleId} preserves rotation`);
    assert.equal(after.sides, sides, `${stage}: ${handleId} preserves the closed side count`);
    assert.deepEqual(currentLayer(id).cells, renderShapeToCells(after),
      `${stage}: ${handleId} updates the visible raster from local geometry`);
    assertControlsAttached(id, edgeIndex % 2 ? 'move' : 'polygon',
      `${stage}: ${handleId} controls`);
    G.undo();
    assert.equal(shapePathEqual(pathValueFromShape(currentShape(id)), beforePath), true,
      `${stage}: ${handleId} Undo restores the exact path`);
    G.redo();
    assert.deepEqual(currentShape(id), after,
      `${stage}: ${handleId} Redo restores the local edge edit`);
    G.undo();
  }
}

for (const sides of [3, 4, 5, 8]) {
  G.dims.set({ w: 64, h: 32 });
  G.setLayers([{ name: 'Base', type: 'cell', visible: true, cells: {} }]);
  F.initTimeline(get(G.layers));
  const id = requiredLayerId(
    G.createShapeLayer(polygonLifecycleFixture(sides), renderShapeToCells),
    `${sides}-side polygon creation returns a layer id`,
  );
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
