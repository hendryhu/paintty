import assert from 'node:assert/strict';
import {
  cloneShapePathKey,
  editShapePathField,
  enumerateShapePathComponents,
  interpolateShapePath,
  interpolateShapePathComponent,
  normalizeShapePathKey,
  pathValueFromShape,
  shapePathComponentValue,
  shapePathDefaultAnchor,
  shapePathEqual,
  shapePathVertices,
  shapeWithPathValue,
  translateShapePathKey,
  withShapePathComponentValue,
} from '../src/lib/shapePath.js';
import {
  canConvertShapeDetailToCell,
  editPolygonSides,
  editShapePathAggregate,
  shapeForAnchorComponentEdit,
  shapeForStaticPathEdit,
  shapePathAggregateMetrics,
} from '../src/lib/shapePathEditing.js';
import {
  regularPolygonVertices,
  renderShapeToCells,
  resolvedShapeVertices,
} from '../src/lib/shapes.js';

function geometryBounds(shape) {
  return [
    Math.min(shape.x0, shape.x1),
    Math.min(shape.y0, shape.y1),
    Math.max(shape.x0, shape.x1),
    Math.max(shape.y0, shape.y1),
  ];
}

function renderedBounds(shape) {
  const points = Object.keys(renderShapeToCells(shape))
    .map((key) => key.split(',').map(Number));
  return [
    Math.min(...points.map(([x]) => x)),
    Math.min(...points.map(([, y]) => y)),
    Math.max(...points.map(([x]) => x)),
    Math.max(...points.map(([, y]) => y)),
  ];
}

const styledLine = {
  kind: 'line',
  x0: -8,
  y0: 3,
  x1: 12,
  y1: -5,
  style: 'slope',
  channel: 'glyph',
  fg: '#ff00ff',
};
assert.deepEqual(pathValueFromShape(styledLine), {
  kind: 'line',
  x0: -8,
  y0: 3,
  x1: 12,
  y1: -5,
}, 'line paths contain geometry only and preserve off-canvas endpoints');

const reversedRect = {
  kind: 'rect',
  x0: 5,
  y0: 7,
  x1: -2,
  y1: 1,
  style: 'filled',
  channel: 'background',
  fg: '#123456',
};
assert.deepEqual(pathValueFromShape(reversedRect), {
  kind: 'rect',
  cx: 1.5,
  cy: 4,
  w: 8,
  h: 7,
}, 'inclusive rectangle bounds become a canonical center and size');

assert.deepEqual(pathValueFromShape({
  kind: 'circle',
  x0: -6,
  y0: -4,
  x1: -3,
  y1: 1,
}), {
  kind: 'circle',
  cx: -4.5,
  cy: -1.5,
  w: 4,
  h: 6,
}, 'circle paths retain negative coordinates and inclusive dimensions');

assert.deepEqual(shapeWithPathValue(reversedRect, {
  kind: 'rect',
  cx: -3.5,
  cy: 5,
  w: 6,
  h: 3,
}), {
  ...reversedRect,
  x0: -6,
  y0: 4,
  x1: -1,
  y1: 6,
}, 'path conversion changes only geometry and rounds to inclusive integer bounds');

assert.deepEqual(shapeWithPathValue(styledLine, {
  kind: 'line',
  x0: 7.49,
  y0: -2.5,
  x1: -9.51,
  y1: 4.5,
  style: 'outline',
  fg: '#000000',
}), {
  ...styledLine,
  x0: 7,
  y0: -2,
  x1: -10,
  y1: 5,
}, 'line conversion rounds endpoints without accepting appearance fields');

const halfLine = {
  ...styledLine,
  detail: 'half',
  style: 'outline',
  x0: -2.5,
  y0: 1.5,
  x1: 4.5,
  y1: 6,
};
assert.deepEqual(shapeWithPathValue(halfLine, pathValueFromShape(halfLine)), halfLine,
  'half-cell line paths retain their handle precision');

const halfRect = {
  ...reversedRect,
  detail: 'half',
  x0: -2.5,
  y0: 1.5,
  x1: 4.5,
  y1: 6.5,
};
assert.deepEqual(shapeWithPathValue(halfRect, pathValueFromShape(halfRect)), halfRect,
  'centered half-cell rectangle geometry survives a path round trip');
assert.deepEqual(shapeWithPathValue(halfRect, {
  kind: 'rect',
  cx: 1,
  cy: 4,
  w: 8,
  h: 6,
}), halfRect, 'center and size reconstruct half-cell rectangle bounds');

const quarterCircle = {
  kind: 'circle',
  detail: 'quarter',
  style: 'outline',
  x0: -4.5,
  y0: -3.5,
  x1: 1.5,
  y1: 2.5,
};
assert.deepEqual(shapeWithPathValue(
  quarterCircle,
  pathValueFromShape(quarterCircle),
), quarterCircle, 'centered quarter-cell circle geometry survives a path round trip');

const staleSlope = { ...halfLine, style: 'slope' };
assert.deepEqual(shapeWithPathValue(staleSlope, {
  kind: 'line',
  x0: -2.5,
  y0: 1.5,
  x1: 4.5,
  y1: 6.5,
}), {
  ...staleSlope,
  x0: -2,
  y0: 2,
  x1: 5,
  y1: 7,
}, 'slope geometry stays on whole-cell coordinates even with stale detail');

assert.deepEqual(normalizeShapePathKey({
  kind: 'circle',
  cx: 2,
  cy: 3,
  w: -4,
  h: 0,
}), {
  kind: 'circle',
  cx: 2,
  cy: 3,
  w: 1,
  h: 1,
}, 'normalized sizes never fall below one cell');
assert.equal(normalizeShapePathKey({ kind: 'rect', cx: 0, cy: 0, w: 2, h: 2 }, 'circle'), null);
assert.equal(normalizeShapePathKey({ kind: 'line', x0: 0, y0: 0, x1: Infinity, y1: 1 }), null);
assert.equal(normalizeShapePathKey({ kind: 'text', x0: 0, y0: 0, x1: 1, y1: 1 }), null);

const reversedMidpoint = interpolateShapePath(
  { kind: 'line', x0: -4, y0: -2, x1: 12, y1: 6 },
  { kind: 'line', x0: 12, y0: 6, x1: -4, y1: -2 },
  0.5,
);
assert.deepEqual(reversedMidpoint, {
  kind: 'line',
  x0: 4,
  y0: 2,
  x1: 4,
  y1: 2,
}, 'reversed line endpoints interpolate independently');
const extremeReversal = interpolateShapePath(
  { kind: 'line', x0: -Number.MAX_VALUE, y0: 0, x1: Number.MAX_VALUE, y1: 0 },
  { kind: 'line', x0: Number.MAX_VALUE, y0: 0, x1: -Number.MAX_VALUE, y1: 0 },
  0.5,
);
assert.equal(Object.values(extremeReversal).slice(1).every(Number.isFinite), true,
  'finite endpoints cannot overflow while crossing');

const centeredResize = interpolateShapePath(
  { kind: 'rect', cx: 9, cy: -3, w: 3, h: 5 },
  { kind: 'rect', cx: 9, cy: -3, w: 7, h: 9 },
  0.5,
);
assert.deepEqual(centeredResize, {
  kind: 'rect',
  cx: 9,
  cy: -3,
  w: 5,
  h: 7,
});
assert.deepEqual(interpolateShapePath(
  { kind: 'rect', cx: 2, cy: 1, w: 5, h: 3 },
  {
    kind: 'rect',
    cx: 2,
    cy: 1,
    w: 5,
    h: 3,
    vertices: [
      { x: -2, y: -2 },
      { x: 4, y: 0 },
      { x: 5, y: 4 },
      { x: 0, y: 2 },
    ],
  },
  0.5,
).vertices, [
  { x: -1, y: -1 },
  { x: 4, y: 0 },
  { x: 4.5, y: 3 },
  { x: 0, y: 2 },
], 'a whole Path tween transitions smoothly into its first free-distorted key');
assert.deepEqual(interpolateShapePath(
  { kind: 'line', x0: 0, y0: 0, x1: 8, y1: 4 },
  {
    kind: 'line',
    x0: 0,
    y0: 0,
    x1: 8,
    y1: 4,
    vertices: [{ x: 2, y: -2 }, { x: 10, y: 8 }],
  },
  0.5,
).vertices, [{ x: 1, y: -1 }, { x: 9, y: 6 }],
  'line Path tweens also bridge compact and explicit endpoints');

assert.deepEqual(interpolateShapePath(
  { kind: 'circle', cx: 0, cy: 0, w: 1, h: 1 },
  { kind: 'circle', cx: 10, cy: 6, w: 5, h: 3 },
  2,
), {
  kind: 'circle',
  cx: 10,
  cy: 6,
  w: 5,
  h: 3,
}, 'interpolation progress is bounded to its keyframe interval');
assert.equal(interpolateShapePath(
  { kind: 'rect', cx: 0, cy: 0, w: 1, h: 1 },
  { kind: 'circle', cx: 0, cy: 0, w: 1, h: 1 },
  0.5,
), null);

const translatedCircle = translateShapePathKey({
  kind: 'circle',
  cx: -4.5,
  cy: -1.5,
  w: 4,
  h: 6,
}, -3, 8);
assert.deepEqual(translatedCircle, {
  kind: 'circle',
  cx: -7.5,
  cy: 6.5,
  w: 4,
  h: 6,
});
assert.deepEqual(translateShapePathKey(pathValueFromShape(styledLine), 2, -4), {
  kind: 'line',
  x0: -6,
  y0: -1,
  x1: 14,
  y1: -9,
});

const sourceKey = { kind: 'rect', cx: 2.5, cy: 4, w: 8, h: 3 };
const clonedKey = cloneShapePathKey(sourceKey);
assert.deepEqual(clonedKey, sourceKey);
assert.notEqual(clonedKey, sourceKey);
assert.equal(shapePathEqual(sourceKey, clonedKey), true);
assert.equal(shapePathEqual(sourceKey, { ...sourceKey, h: 4 }), false);
assert.equal(shapePathEqual(null, null), true);
assert.equal(shapePathEqual({ kind: 'rect' }, { kind: 'rect' }), false);

const polygonPath = {
  kind: 'polygon',
  vertices: [
    { x: 2, y: 0 },
    { x: 5, y: 3 },
    { x: 3, y: 7 },
    { x: -1, y: 4 },
  ],
  anchor: { x: 2, y: 3 },
  rotation: 15,
};
assert.deepEqual(normalizeShapePathKey(polygonPath), polygonPath,
  'polygon paths retain ordered vertices, anchor, and rotation');
assert.equal(normalizeShapePathKey({
  kind: 'polygon',
  vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
}), null, 'polygons require at least three finite vertices');
assert.deepEqual(shapePathVertices({
  kind: 'rect', cx: 3, cy: 4, w: 5, h: 3,
}), [
  { x: 1, y: 3 },
  { x: 5, y: 3 },
  { x: 5, y: 5 },
  { x: 1, y: 5 },
], 'rectangles expose stable clockwise corner components');
assert.deepEqual(shapePathDefaultAnchor(polygonPath), { x: 2, y: 3 });
assert.deepEqual(enumerateShapePathComponents(polygonPath).map(({ id, label }) => ({
  id, label,
})), [
  { id: 'vertex:0', label: 'Vertex 1' },
  { id: 'vertex:1', label: 'Vertex 2' },
  { id: 'vertex:2', label: 'Vertex 3' },
  { id: 'vertex:3', label: 'Vertex 4' },
  { id: 'anchor', label: 'Anchor point' },
  { id: 'rotation', label: 'Rotation' },
]);
const cornerEdited = withShapePathComponentValue(
  { kind: 'rect', cx: 3, cy: 4, w: 5, h: 3 },
  'vertex:0',
  { x: -2, y: 1 },
);
assert.deepEqual(shapePathComponentValue(cornerEdited, 'vertex:0'), { x: -2, y: 1 });
assert.deepEqual(shapePathComponentValue(cornerEdited, 'vertex:1'), { x: 5, y: 3 },
  'editing one corner promotes the quad without perturbing another corner');
assert.deepEqual(shapePathComponentValue(cornerEdited, 'anchor'), { x: 1.5, y: 3 },
  'an implicit anchor follows the bounds of independently edited vertices');
const endpointEdited = withShapePathComponentValue(
  { kind: 'line', x0: 2, y0: 3, x1: 9, y1: 6 },
  'vertex:1',
  { x: 11, y: 7 },
);
assert.deepEqual(shapePathComponentValue(endpointEdited, 'anchor'), { x: 6.5, y: 5 },
  'an implicit line anchor follows independently edited endpoints');
assert.equal(shapePathComponentValue(
  withShapePathComponentValue(cornerEdited, 'rotation', 37.5),
  'rotation',
), 37.5);
assert.deepEqual(interpolateShapePathComponent(
  'vertex:0',
  { x: -2, y: 1 },
  { x: 8, y: 5 },
  0.25,
), { x: 0.5, y: 2 });
assert.deepEqual(translateShapePathKey(polygonPath, -2, 5), {
  ...polygonPath,
  vertices: [
    { x: 0, y: 5 },
    { x: 3, y: 8 },
    { x: 1, y: 12 },
    { x: -3, y: 9 },
  ],
  anchor: { x: 0, y: 8 },
}, 'polygon translation moves vertices and the anchor but preserves rotation');

const fiveSideScrubStart = {
  kind: 'polygon',
  sides: 5,
  x0: 1,
  y0: 2,
  x1: 11,
  y1: 8,
  vertices: [
    { x: 6, y: 2 },
    { x: 11, y: 4 },
    { x: 9, y: 8 },
    { x: 3, y: 8 },
    { x: 1, y: 4 },
  ],
  anchor: { x: 4, y: 6 },
  rotation: 17,
};
const sixSidePreview = editPolygonSides(fiveSideScrubStart, 6, fiveSideScrubStart);
assert.equal(sixSidePreview.vertices.length, 6);
assert.deepEqual(shapePathAggregateMetrics(sixSidePreview),
  { cx: 6, cy: 5, w: 11, h: 7 },
  'changing a non-square polygon from five to six sides preserves its aggregate bounds');
assert.deepEqual({
  anchor: sixSidePreview.anchor,
  rotation: sixSidePreview.rotation,
}, {
  anchor: fiveSideScrubStart.anchor,
  rotation: fiveSideScrubStart.rotation,
}, 'changing polygon sides preserves its authored anchor and rotation');
const separateFiveSideEdit = editPolygonSides(sixSidePreview, 5);
assert.deepEqual(shapePathAggregateMetrics(separateFiveSideEdit),
  { cx: 6, cy: 5, w: 11, h: 7 },
  'changing a polygon from six to five sides also preserves its aggregate bounds');
assert.deepEqual(editPolygonSides(sixSidePreview, 5, fiveSideScrubStart), fiveSideScrubStart,
  'one polygon-side scrub restores its exact starting geometry when it returns home');
assert.equal(editPolygonSides(fiveSideScrubStart, 5, fiveSideScrubStart), null,
  'an unchanged polygon-side scrub does not create an edit');

const resizeGestureStart = pathValueFromShape({
  kind: 'rect',
  x0: 22,
  y0: 5,
  x1: 32,
  y1: 8,
});
let resizeGestureShape = {
  kind: 'rect',
  x0: 22,
  y0: 5,
  x1: 32,
  y1: 8,
};
for (let width = 12; width <= 19; width++) {
  const current = pathValueFromShape(resizeGestureShape);
  const edited = editShapePathField(current, 'w', width, resizeGestureStart);
  resizeGestureShape = shapeWithPathValue(resizeGestureShape, edited);
}
assert.equal(pathValueFromShape(resizeGestureShape).cx, resizeGestureStart.cx,
  'one size scrub cannot accumulate rounding drift from its intermediate shapes');
assert.equal(pathValueFromShape(resizeGestureShape).w, 19);
assert.equal(editShapePathField(resizeGestureStart, 'x1', 10), null,
  'rectangle paths reject line-only fields');

const explicitLineEndpoints = {
  kind: 'line',
  x0: 1,
  y0: 2,
  x1: 8,
  y1: 6,
  vertices: [
    { x: 2.5, y: 1.5 },
    { x: 9, y: 7 },
  ],
  anchor: { x: 4, y: 3 },
  rotation: 12,
};
assert.deepEqual(editShapePathField(explicitLineEndpoints, 'x0', -3), {
  ...explicitLineEndpoints,
  x0: -3,
  y0: 1.5,
  x1: 9,
  y1: 7,
  vertices: [
    { x: -3, y: 1.5 },
    { x: 9, y: 7 },
  ],
}, 'whole-Path line fields edit the visible endpoint when component vertices exist');

for (const { name, shape, path, expected } of [
  {
    name: 'Special',
    shape: {
      kind: 'line', style: 'special', boxStyle: 'single', detail: 'cell',
      channel: 'glyph', char: '#', fg: '#ffffff', x0: 1, y0: 2, x1: 7, y1: 4,
    },
    path: { kind: 'line', x0: 1, y0: 2, x1: 9, y1: 5 },
    expected: { x0: 1, y0: 2, x1: 9, y1: 2 },
  },
  {
    name: 'Diagonal triangles',
    shape: {
      kind: 'line', style: 'slope', detail: 'cell',
      channel: 'glyph', char: '#', fg: '#ffffff', x0: 0, y0: 0, x1: 4, y1: 3,
    },
    path: { kind: 'line', x0: 0, y0: 0, x1: 5, y1: 3 },
    expected: { x0: 0, y0: 0, x1: 4, y1: 3 },
  },
]) {
  const stored = shapeForStaticPathEdit(shape, path);
  assert.deepEqual({
    geometry: {
      x0: stored.x0, y0: stored.y0, x1: stored.x1, y1: stored.y1,
    },
    guideBounds: geometryBounds(stored),
    rasterBounds: renderedBounds(stored),
  }, {
    geometry: expected,
    guideBounds: geometryBounds(expected),
    rasterBounds: geometryBounds(expected),
  }, `${name} numeric Path edits store the same constrained geometry that they render`);
}

const aggregateRect = {
  kind: 'rect',
  cx: 5,
  cy: 4,
  w: 9,
  h: 5,
};
assert.deepEqual(shapePathAggregateMetrics(aggregateRect), {
  cx: 5,
  cy: 4,
  w: 9,
  h: 5,
},
  'aggregate controls expose the compact rectangle center and size');
assert.deepEqual(editShapePathAggregate(aggregateRect, 'w', 13), {
  ...aggregateRect,
  w: 13,
}, 'aggregate width scales a compact rectangle around its default anchor');
assert.deepEqual(editShapePathAggregate({
  ...aggregateRect,
  w: 1,
}, 'w', 5), {
  ...aggregateRect,
  w: 5,
}, 'a collapsed aggregate width can be expanded again');

const anchoredQuad = {
  kind: 'rect',
  cx: 4,
  cy: 3,
  w: 7,
  h: 5,
  vertices: [
    { x: 1, y: 1 },
    { x: 7, y: 1 },
    { x: 7, y: 5 },
    { x: 1, y: 5 },
  ],
  anchor: { x: 2, y: 3 },
  rotation: 20,
};
const widenedQuad = editShapePathAggregate(anchoredQuad, 'w', 13);
assert.deepEqual(widenedQuad.vertices.map(({ x }) => x), [0, 12, 12, 0],
  'aggregate size scales explicit vertices around the authored anchor');
assert.deepEqual(widenedQuad.anchor, anchoredQuad.anchor);
const shiftedQuad = editShapePathAggregate(anchoredQuad, 'cy', 8);
assert.deepEqual(shiftedQuad.vertices.map(({ y }) => y), [6, 6, 10, 10]);
assert.deepEqual(shiftedQuad.anchor, { x: 2, y: 8 },
  'moving the aggregate center carries its transform anchor with the artwork');

const rotatedShape = shapeWithPathValue({
  kind: 'rect',
  style: 'outline',
  detail: 'cell',
  channel: 'glyph',
  x0: 1,
  y0: 1,
  x1: 7,
  y1: 5,
}, anchoredQuad);
const visibleBeforeAnchorEdit = resolvedShapeVertices(rotatedShape);
const numericallyReanchored = shapeForAnchorComponentEdit(
  rotatedShape,
  pathValueFromShape(rotatedShape),
  { x: 8, y: -2 },
);
const visibleAfterAnchorEdit = resolvedShapeVertices(numericallyReanchored);
visibleBeforeAnchorEdit.forEach((point, index) => {
  assert.ok(Math.abs(point.x - visibleAfterAnchorEdit[index].x) < 1e-9);
  assert.ok(Math.abs(point.y - visibleAfterAnchorEdit[index].y) < 1e-9);
});
assert.deepEqual(numericallyReanchored.anchor, { x: 8, y: -2 },
  'numeric anchor edits preserve the same visible artwork as anchor dragging');

const regularHalfPolygon = {
  kind: 'polygon',
  detail: 'half',
  x0: 0,
  y0: 0,
  x1: 7,
  y1: 5,
  sides: 5,
  anchor: { x: 3.5, y: 2.5 },
};
regularHalfPolygon.vertices = regularPolygonVertices(
  regularHalfPolygon.x0,
  regularHalfPolygon.y0,
  regularHalfPolygon.x1,
  regularHalfPolygon.y1,
  regularHalfPolygon.sides,
);
assert.equal(canConvertShapeDetailToCell(regularHalfPolygon), true,
  'an untouched regular polygon keeps its valid half-cell center when returning to cell detail');
const resolvedHalfPolygon = shapeWithPathValue(
  regularHalfPolygon,
  pathValueFromShape(regularHalfPolygon),
);
assert.equal(canConvertShapeDetailToCell(resolvedHalfPolygon), true,
  'timeline-resolved polygon bounds do not strand cell detail');
assert.equal(canConvertShapeDetailToCell({
  ...regularHalfPolygon,
  vertices: regularHalfPolygon.vertices.map((point, index) =>
    index === 0 ? { ...point, x: point.x + 0.5 } : point),
}), true, 'polygon detail changes preserve fractional custom handles');
assert.equal(canConvertShapeDetailToCell({
  ...regularHalfPolygon,
  vertices: regularHalfPolygon.vertices.map((point, index) =>
    index === 0 ? { ...point, y: point.y + 0.5 } : point),
}, true), true, 'polygon detail changes preserve keyed Path geometry');
assert.equal(canConvertShapeDetailToCell({
  kind: 'rect',
  detail: 'quarter',
  x0: 0.5,
  y0: 1,
  x1: 6.5,
  y1: 4,
}), false, 'cell conversion refuses fractional compact bounds');
assert.equal(canConvertShapeDetailToCell({
  kind: 'rect',
  detail: 'half',
  x0: 0,
  y0: 1,
  x1: 6,
  y1: 4,
}, true), false, 'animated detail conversion stays disabled instead of rewriting keys');

console.log('shape path tests passed');
