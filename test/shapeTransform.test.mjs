import assert from 'node:assert/strict';
import {
  pickShapeTransformHandle,
  shapeHandleDragTarget,
  shapeTransformCageVertices,
  shapeTransformHandles,
  shapeTransformQuantum,
  snapShapeTransformPoint,
  transformShapeFromCageHandle,
  transformShapeFromHandle,
} from '../src/lib/shapeTransform.js';
import { resolvedShapeVertices } from '../src/lib/shapes.js';

const rect = {
  kind: 'rect',
  x0: 0,
  y0: 0,
  x1: 4,
  y1: 2,
  style: 'outline',
  detail: 'cell',
};

assert.deepEqual(shapeHandleDragTarget(
  { x: 4.5, y: 7.5 },
  { x: 120, y: 220 },
  { x: 150, y: 180 },
  { w: 10, h: 20 },
), { x: 7.5, y: 5.5 },
'pointer deltas convert through independent cell width and height');
assert.deepEqual(shapeHandleDragTarget(
  { x: 4.5, y: 7.5 },
  { x: 730, y: 910 },
  { x: 766, y: 856 },
  { w: 12, h: 27 },
), { x: 7.5, y: 5.5 },
'equal cell-space gestures are independent of canvas position and cell aspect ratio');
assert.equal(shapeHandleDragTarget(
  { x: 4.5, y: 7.5 },
  { x: 0, y: 0 },
  { x: 10, y: 20 },
  { w: 0, h: 20 },
), null, 'invalid cell metrics cannot corrupt shape geometry');

const narrowHandleShapes = [
  ['line-column', {
    kind: 'line', x0: 2, y0: 2, x1: 2, y1: 2.5, style: 'outline', detail: 'half',
  }],
  ['line-row', {
    kind: 'line', x0: 2, y0: 2, x1: 2.5, y1: 2, style: 'outline', detail: 'half',
  }],
  ...['rect', 'circle'].flatMap((kind) => [[`${kind}-column`, {
    kind, x0: 2, y0: 1, x1: 2, y1: 4, style: 'outline', detail: 'cell',
  }], [`${kind}-row`, {
    kind, x0: 1, y0: 2, x1: 4, y1: 2, style: 'outline', detail: 'cell',
  }]]),
  ['polygon-column', {
    kind: 'polygon', sides: 4, style: 'outline', detail: 'cell', anchor: { x: 2, y: 2 },
    vertices: [{ x: 2, y: 0 }, { x: 2.5, y: 2 }, { x: 2, y: 4 }, { x: 1.5, y: 2 }],
  }],
  ['polygon-row', {
    kind: 'polygon', sides: 4, style: 'outline', detail: 'cell', anchor: { x: 2, y: 2 },
    vertices: [{ x: 0, y: 2 }, { x: 2, y: 2.5 }, { x: 4, y: 2 }, { x: 2, y: 1.5 }],
  }],
];
const handleTargetSize = (type) => type === 'edge' || type === 'anchor' ? 18 : 20;
const containsPoint = (target, point) => point.x >= target.rect.left &&
  point.x <= target.rect.right && point.y >= target.rect.top && point.y <= target.rect.bottom;
const handleHitPriority = { vertex: 0, edge: 1, anchor: 2, rotation: 3 };
function expectedHandleAt(targets, point) {
  return targets.filter((target) => containsPoint(target, point))
    .map((target) => ({
      ...target,
      distance: (point.x - target.center.x) ** 2 + (point.y - target.center.y) ** 2,
    }))
    .sort((first, second) => {
      const distance = first.distance - second.distance;
      if (Math.abs(distance) > 1e-9) return distance;
      return handleHitPriority[second.type] - handleHitPriority[first.type] ||
        second.stackOrder - first.stackOrder;
    })[0]?.id ?? null;
}

for (const [name, shape] of narrowHandleShapes) {
  for (const zoom of [8, 11, 14]) {
    for (const dpr of [1, 1.25, 2]) {
      const targets = shapeTransformHandles(shape).map((handle, stackOrder) => {
        const size = handleTargetSize(handle.type);
        const center = {
          x: 17 / dpr + (handle.x + 0.5) * zoom,
          y: 23 / dpr + (handle.y + 0.5) * zoom * 2,
        };
        return {
          id: handle.id,
          type: handle.type,
          stackOrder,
          center,
          rect: {
            left: center.x - size / 2,
            top: center.y - size / 2,
            right: center.x + size / 2,
            bottom: center.y + size / 2,
          },
        };
      });
      const overlapSamples = new Map();
      for (let first = 0; first < targets.length; first++) {
        for (let second = first + 1; second < targets.length; second++) {
          const left = Math.max(targets[first].rect.left, targets[second].rect.left);
          const right = Math.min(targets[first].rect.right, targets[second].rect.right);
          const top = Math.max(targets[first].rect.top, targets[second].rect.top);
          const bottom = Math.min(targets[first].rect.bottom, targets[second].rect.bottom);
          if (left > right || top > bottom) continue;
          const firstPixelX = Math.ceil(left * dpr - 0.5);
          const lastPixelX = Math.floor(right * dpr - 0.5);
          const firstPixelY = Math.ceil(top * dpr - 0.5);
          const lastPixelY = Math.floor(bottom * dpr - 0.5);
          for (let pixelY = firstPixelY; pixelY <= lastPixelY; pixelY++) {
            for (let pixelX = firstPixelX; pixelX <= lastPixelX; pixelX++) {
              const point = { x: (pixelX + 0.5) / dpr, y: (pixelY + 0.5) / dpr };
              overlapSamples.set(`${point.x},${point.y}`, point);
            }
          }
        }
      }
      assert.ok(overlapSamples.size > 0,
        `${name} exercises overlapping hit pixels at zoom ${zoom} and DPR ${dpr}`);
      for (const point of overlapSamples.values()) {
        const overlaps = targets.filter((target) => containsPoint(target, point));
        if (overlaps.length < 2) continue;
        const visiblyCentered = overlaps
          .filter((target) => target.center.x === point.x && target.center.y === point.y)
          .at(-1);
        assert.equal(
          pickShapeTransformHandle(targets, point),
          visiblyCentered?.id ?? expectedHandleAt(targets, point),
          `${name} picks the nearest visible control at every overlapping device pixel ` +
            `at zoom ${zoom} and DPR ${dpr}`,
        );
      }
    }
  }
}
const coincidentTargets = ['vertex', 'edge', 'anchor', 'rotation'].map((type, stackOrder) => ({
  id: type,
  type,
  stackOrder,
  rect: { left: 0, top: 0, right: 20, bottom: 20 },
}));
assert.equal(pickShapeTransformHandle(coincidentTargets, { x: 10, y: 10 }), 'rotation',
  'an exact tie follows explicit visible stacking rather than event-target accident');

function cageEdgeLengths(shape) {
  const cage = shapeTransformCageVertices(shape);
  return [
    Math.hypot(cage[1].x - cage[0].x, cage[1].y - cage[0].y),
    Math.hypot(cage[2].x - cage[1].x, cage[2].y - cage[1].y),
  ];
}

const rotated = {
  ...rect,
  rotation: 90,
  anchor: { x: 2, y: 1 },
  vertices: [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 2 },
    { x: 0, y: 2 },
  ],
};
const rotatedSnapshot = structuredClone(rotated);
const handles = shapeTransformHandles(rotated, { rotationOffset: 2 });
assert.deepEqual(
  handles.filter(({ type }) => type === 'vertex').map(({ x, y }) => ({
    x: Number(x.toFixed(9)),
    y: Number(y.toFixed(9)),
  })),
  [
    { x: 3.5, y: -1.5 },
    { x: 3.5, y: 3.5 },
    { x: 0.5, y: 3.5 },
    { x: 0.5, y: -1.5 },
  ],
  'vertex handles frame the rendered outer edge of inclusive cells',
);
assert.deepEqual(
  handles.filter(({ type }) => type === 'vertex')
    .map(({ targetX: x, targetY: y }) => ({
      x: Number(x.toFixed(9)),
      y: Number(y.toFixed(9)),
    })),
  [
    { x: 3, y: -1 },
    { x: 3, y: 3 },
    { x: 1, y: 3 },
    { x: 1, y: -1 },
  ],
  'visual cage padding does not change the authored transform targets',
);
assert.equal(handles.filter(({ type }) => type === 'edge').length, 4);
assert.deepEqual(
  handles.find(({ type }) => type === 'anchor'),
  { id: 'anchor', type: 'anchor', x: 2, y: 1, label: 'Anchor point' },
);
assert.equal(handles.some(({ type }) => type === 'rotation'), true);
assert.deepEqual(rotated, rotatedSnapshot, 'enumerating handles does not mutate the shape');
for (const [shape, vertexCount, edgeCount] of [
  [{ ...rect, kind: 'line' }, 2, 0],
  [{ ...rect, kind: 'circle' }, 4, 4],
  [{
    ...rect,
    kind: 'polygon',
    vertices: [
      { x: 2, y: 0 },
      { x: 4, y: 2 },
      { x: 3, y: 4 },
      { x: 1, y: 4 },
      { x: 0, y: 2 },
    ],
  }, 5, 5],
]) {
  const kinds = shapeTransformHandles(shape);
  assert.equal(kinds.filter(({ type }) => type === 'vertex').length, vertexCount);
  assert.equal(kinds.filter(({ type }) => type === 'edge').length, edgeCount);
  assert.equal(kinds.some(({ type }) => type === 'anchor'), true);
  assert.equal(kinds.some(({ type }) => type === 'rotation'), true);
}
assert.equal(
  transformShapeFromHandle({ ...rect, kind: 'line' }, 'edge:0', { x: 2, y: 2 }),
  null,
  'a line does not accept the nonexistent midpoint scale handle',
);

const legacyScaled = transformShapeFromHandle(rect, 'vertex:2', { x: 8, y: 4 });
assert.deepEqual(
  { x0: legacyScaled.x0, y0: legacyScaled.y0, x1: legacyScaled.x1, y1: legacyScaled.y1 },
  { x0: 0, y0: 0, x1: 8, y1: 4 },
  'a normal corner drag scales all vertices around the opposite corner',
);
assert.equal(Object.hasOwn(legacyScaled, 'vertices'), false,
  'an axis-aligned resize keeps the compact legacy geometry');
const distorted = transformShapeFromHandle(rect, 'vertex:0', { x: 1, y: 1 }, {
  ctrl: true,
});
assert.deepEqual(distorted.vertices, [
  { x: 1, y: 1 },
  { x: 4, y: 0 },
  { x: 4, y: 2 },
  { x: 0, y: 2 },
], 'Ctrl free-distort moves only the selected corner and materializes vertices');
assert.deepEqual(
  shapeTransformHandles(distorted)
    .filter(({ type }) => type === 'vertex')
    .map(({ x, y }) => ({ x, y })),
  [
    { x: 0.5, y: 0.5 },
    { x: 4.5, y: -0.5 },
    { x: 4.5, y: 2.5 },
    { x: -0.5, y: 2.5 },
  ],
  'a one-cell pointer delta leaves the free-distorted cage settled under the pointer',
);
const crossedCornerTarget = { x: 6.5, y: 3.5 };
const crossedCorner = transformShapeFromCageHandle(
  rect,
  'vertex:0',
  crossedCornerTarget,
);
assert.deepEqual(
  shapeTransformHandles(crossedCorner)
    .find(({ id }) => id === 'vertex:0'),
  {
    id: 'vertex:0',
    type: 'vertex',
    index: 0,
    x: crossedCornerTarget.x,
    y: crossedCornerTarget.y,
    targetX: 7,
    targetY: 4,
    label: 'Vertex 1',
    freeDistort: true,
    perspective: true,
    scaleModifiers: true,
  },
  'a corner remains under the pointer after crossing its opposite corner',
);
assert.equal(Array.isArray(crossedCorner.vertices), true,
  'crossing preserves vertex identity instead of compacting and renumbering the cage');
const continuedCornerTarget = { x: 7.5, y: 4.5 };
const continuedCorner = transformShapeFromCageHandle(
  rect,
  'vertex:0',
  continuedCornerTarget,
);
const continuedCornerHandle = shapeTransformHandles(continuedCorner)
  .find(({ id }) => id === 'vertex:0');
assert.deepEqual(
  { x: continuedCornerHandle.x, y: continuedCornerHandle.y },
  continuedCornerTarget,
  'the same corner follows later pointer movement beyond the crossing',
);
const crossedEdgeTarget = { x: -2.5, y: 1 };
const crossedEdge = transformShapeFromCageHandle(
  rect,
  'edge:1',
  crossedEdgeTarget,
);
const crossedEdgeHandle = shapeTransformHandles(crossedEdge)
  .find(({ id }) => id === 'edge:1');
assert.deepEqual(
  { x: crossedEdgeHandle.x, y: crossedEdgeHandle.y },
  crossedEdgeTarget,
  'an edge remains under the pointer after crossing its opposite edge',
);
assert.equal(Array.isArray(crossedEdge.vertices), true,
  'an edge crossing also preserves the original handle identity');
for (const target of [
  { id: 'vertex:0', point: { x: -0.5, y: 2.5 } },
  { id: 'edge:1', point: { x: -0.5, y: 1 } },
]) {
  const settledShape = transformShapeFromCageHandle(
    rect,
    target.id,
    target.point,
  );
  const settledHandle = shapeTransformHandles(settledShape)
    .find(({ id }) => id === target.id);
  assert.deepEqual(
    { x: settledHandle.x, y: settledHandle.y },
    target.point,
    `${target.id} stays continuous at the exact opposite-cage crossing`,
  );
}
const nearCenterDistortTarget = { x: 1.5, y: 1.5 };
const nearCenterDistort = transformShapeFromCageHandle(
  rect,
  'vertex:0',
  nearCenterDistortTarget,
  { ctrl: true },
);
const nearCenterDistortHandle = shapeTransformHandles(nearCenterDistort)
  .find(({ id }) => id === 'vertex:0');
assert.deepEqual(
  { x: nearCenterDistortHandle.x, y: nearCenterDistortHandle.y },
  nearCenterDistortTarget,
  'free-distort remains continuous as a corner crosses the derived center',
);
assert.deepEqual(rect, {
  kind: 'rect', x0: 0, y0: 0, x1: 4, y1: 2, style: 'outline', detail: 'cell',
}, 'transforming a shape leaves the input untouched');
const rotatedDistort = transformShapeFromHandle(rotated, 'vertex:0', { x: 5, y: 0 }, {
  ctrl: true,
});
assert.ok(Math.abs(resolvedShapeVertices(rotatedDistort)[0].x - 5) < 1e-9);
assert.ok(Math.abs(resolvedShapeVertices(rotatedDistort)[0].y) < 1e-9,
  'a rotated free-distort handle lands on its rendered pointer coordinate');

const centeredProportional = transformShapeFromHandle(
  rect,
  'vertex:2',
  { x: 6, y: 3 },
  { alt: true, shift: true },
);
assert.deepEqual(
  {
    x0: centeredProportional.x0,
    y0: centeredProportional.y0,
    x1: centeredProportional.x1,
    y1: centeredProportional.y1,
  },
  { x0: -2, y0: -1, x1: 6, y1: 3 },
  'Alt+Shift scales proportionally around the explicit or default anchor',
);
const verticalProportional = transformShapeFromHandle(
  rect,
  'vertex:2',
  { x: 4, y: 7 },
  { shift: true },
);
assert.deepEqual(
  {
    x0: verticalProportional.x0,
    y0: verticalProportional.y0,
    x1: verticalProportional.x1,
    y1: verticalProportional.y1,
  },
  { x0: 0, y0: 0, x1: 12, y1: 7 },
  'Shift uses the dragged whole-cell cage height to preserve its visible aspect',
);
assert.deepEqual(cageEdgeLengths(verticalProportional), [13, 8]);

const anchoredRect = { ...rect, anchor: { x: 1, y: 1 } };
const anchorProportional = transformShapeFromHandle(
  anchoredRect,
  'vertex:2',
  { x: 4, y: 7 },
  { alt: true, shift: true },
);
assert.deepEqual(
  {
    x0: anchorProportional.x0,
    y0: anchorProportional.y0,
    x1: anchorProportional.x1,
    y1: anchorProportional.y1,
    anchor: anchorProportional.anchor,
  },
  { x0: -5, y0: -5, x1: 16, y1: 7, anchor: { x: 1, y: 1 } },
  'Alt+Shift preserves the visible cage ratio around an explicit transform anchor',
);
assert.deepEqual(cageEdgeLengths(anchorProportional), [22, 13]);

const rotatedCompact = {
  ...rect,
  rotation: 45,
  anchor: { x: 2, y: 1 },
};
const rotatedStartHandle = shapeTransformHandles(rotatedCompact)
  .find(({ id }) => id === 'vertex:0');
const rotatedPositive = transformShapeFromCageHandle(
  rotatedCompact,
  'vertex:0',
  { x: rotatedStartHandle.x + 1, y: rotatedStartHandle.y },
);
const rotatedNegative = transformShapeFromCageHandle(
  rotatedCompact,
  'vertex:0',
  { x: rotatedStartHandle.x - 1, y: rotatedStartHandle.y },
);
assert.notDeepEqual(
  resolvedShapeVertices(rotatedPositive),
  resolvedShapeVertices(rotatedCompact),
  'a positive screen-space delta changes a rotated whole-cell cage',
);
const initialRotatedLengths = cageEdgeLengths(rotatedCompact);
const positiveRotatedLengths = cageEdgeLengths(rotatedPositive);
const negativeRotatedLengths = cageEdgeLengths(rotatedNegative);
assert.ok(
  Math.abs(
    positiveRotatedLengths[0] + negativeRotatedLengths[0] -
    initialRotatedLengths[0] * 2,
  ) < 1e-9 &&
  Math.abs(
    positiveRotatedLengths[1] + negativeRotatedLengths[1] -
    initialRotatedLengths[1] * 2,
  ) < 1e-9,
  'equal opposite pointer deltas produce symmetric rotated-cage dimensions',
);
const rotatedProportional = transformShapeFromHandle(
  rotatedCompact,
  'vertex:2',
  {
    x: 2 - 4 * Math.SQRT1_2,
    y: 1 + 8 * Math.SQRT1_2,
  },
  { shift: true },
);
assert.deepEqual(
  {
    x0: rotatedProportional.x0,
    y0: rotatedProportional.y0,
    x1: rotatedProportional.x1,
    y1: rotatedProportional.y1,
    rotation: rotatedProportional.rotation,
    anchor: rotatedProportional.anchor,
  },
  {
    x0: 0,
    y0: 0,
    x1: 12,
    y1: 7,
    rotation: 45,
    anchor: { x: 2, y: 1 },
  },
  'an arbitrarily rotated cage snaps authored motion before proportional scaling',
);
const rotatedCageLengths = cageEdgeLengths(rotatedProportional);
assert.ok(
  Math.abs(rotatedCageLengths[0] - 13) < 1e-9 &&
    Math.abs(rotatedCageLengths[1] - 8) < 1e-9,
  'rotation preserves the same thirteen-by-eight rendered cage',
);

const circleProportional = transformShapeFromHandle(
  { ...rect, kind: 'circle' },
  'vertex:2',
  { x: 4, y: 7 },
  { shift: true },
);
assert.deepEqual(
  {
    x0: circleProportional.x0,
    y0: circleProportional.y0,
    x1: circleProportional.x1,
    y1: circleProportional.y1,
  },
  { x0: 0, y0: 0, x1: 12, y1: 7 },
  'circle scaling independently resolves to the same inclusive bounds',
);
assert.deepEqual(cageEdgeLengths(circleProportional), [13, 8],
  'whole-cell circles use the same visible-cage proportional scale');

const wideEllipse = {
  ...rect,
  kind: 'circle',
  x0: 2,
  y0: 3,
  x1: 21,
  y1: 9,
};
const ellipseEdgeGestures = [
  ['edge:0', { x: 0, y: -2 }, { x0: 2, y0: 1, x1: 21, y1: 9 }],
  ['edge:1', { x: 3, y: 0 }, { x0: 2, y0: 3, x1: 24, y1: 9 }],
  ['edge:2', { x: 0, y: 2 }, { x0: 2, y0: 3, x1: 21, y1: 11 }],
  ['edge:3', { x: -3, y: 0 }, { x0: -1, y0: 3, x1: 21, y1: 9 }],
];
for (const [handleId, delta, expectedBounds] of ellipseEdgeGestures) {
  const initialHandle = shapeTransformHandles(wideEllipse)
    .find(({ id }) => id === handleId);
  const resized = transformShapeFromCageHandle(wideEllipse, handleId, {
    x: initialHandle.x + delta.x,
    y: initialHandle.y + delta.y,
  });
  assert.deepEqual(
    { x0: resized.x0, y0: resized.y0, x1: resized.x1, y1: resized.y1 },
    expectedBounds,
    `${handleId} fixes the topologically opposite ellipse edge`,
  );
  const settled = shapeTransformHandles(resized).find(({ id }) => id === handleId);
  assert.deepEqual(
    { x: settled.x, y: settled.y },
    { x: initialHandle.x + delta.x, y: initialHandle.y + delta.y },
    `${handleId} settles on its cell-space pointer target`,
  );
}
const topEllipseEdge = shapeTransformHandles(wideEllipse)
  .find(({ id }) => id === 'edge:0');
const centeredEllipseResize = transformShapeFromCageHandle(
  wideEllipse,
  'edge:0',
  { x: topEllipseEdge.x, y: topEllipseEdge.y - 2 },
  { alt: true },
);
assert.deepEqual(
  {
    x0: centeredEllipseResize.x0,
    y0: centeredEllipseResize.y0,
    x1: centeredEllipseResize.x1,
    y1: centeredEllipseResize.y1,
  },
  { x0: 2, y0: 1, x1: 21, y1: 11 },
  'Alt ellipse edge scaling preserves the center instead of the opposite edge',
);
const reversedEllipseEdge = transformShapeFromCageHandle(
  wideEllipse,
  'edge:0',
  { x: topEllipseEdge.x, y: topEllipseEdge.y + 8 },
);
assert.deepEqual(reversedEllipseEdge.vertices, [
  { x: 2, y: 11 },
  { x: 21, y: 11 },
  { x: 21, y: 9 },
  { x: 2, y: 9 },
], 'an ellipse edge can cross its opposite without swapping handle identity');
assert.deepEqual(
  shapeTransformHandles(reversedEllipseEdge).find(({ id }) => id === 'edge:0'),
  {
    id: 'edge:0', type: 'edge', index: 0, from: 0, to: 1,
    x: topEllipseEdge.x, y: topEllipseEdge.y + 8,
    targetX: topEllipseEdge.targetX, targetY: 11,
    label: 'Edge 1', skew: true,
  },
  'the reversed ellipse edge remains under the pointer',
);
const ellipseResizeDeltas = new Map([
  ['vertex:0', { x: -3, y: -2 }],
  ['vertex:1', { x: 3, y: -2 }],
  ['vertex:2', { x: 3, y: 2 }],
  ['vertex:3', { x: -3, y: 2 }],
  ['edge:0', { x: 0, y: -2 }],
  ['edge:1', { x: 3, y: 0 }],
  ['edge:2', { x: 0, y: 2 }],
  ['edge:3', { x: -3, y: 0 }],
]);
const oppositeEllipseHandle = new Map([
  ['vertex:0', 'vertex:2'], ['vertex:1', 'vertex:3'],
  ['vertex:2', 'vertex:0'], ['vertex:3', 'vertex:1'],
  ['edge:0', 'edge:2'], ['edge:1', 'edge:3'],
  ['edge:2', 'edge:0'], ['edge:3', 'edge:1'],
]);
const translatedWideEllipse = {
  ...wideEllipse,
  x0: wideEllipse.x0 + 31,
  y0: wideEllipse.y0 - 13,
  x1: wideEllipse.x1 + 31,
  y1: wideEllipse.y1 - 13,
};
function localEllipseGeometry(shape, origin) {
  return {
    bounds: [
      shape.x0 - origin.x, shape.y0 - origin.y,
      shape.x1 - origin.x, shape.y1 - origin.y,
    ],
    vertices: shape.vertices?.map(({ x, y }) => [x - origin.x, y - origin.y]) || null,
    anchor: shape.anchor
      ? [shape.anchor.x - origin.x, shape.anchor.y - origin.y]
      : null,
    rotation: shape.rotation || 0,
  };
}
for (const [handleId, delta] of ellipseResizeDeltas) {
  const initialHandles = shapeTransformHandles(wideEllipse);
  const translatedHandles = shapeTransformHandles(translatedWideEllipse);
  const initial = initialHandles.find(({ id }) => id === handleId);
  const translatedInitial = translatedHandles.find(({ id }) => id === handleId);
  const target = { x: initial.x + delta.x, y: initial.y + delta.y };
  const translatedTarget = {
    x: translatedInitial.x + delta.x,
    y: translatedInitial.y + delta.y,
  };
  const resized = transformShapeFromCageHandle(wideEllipse, handleId, target);
  const translatedResized = transformShapeFromCageHandle(
    translatedWideEllipse,
    handleId,
    translatedTarget,
  );
  assert.deepEqual(
    localEllipseGeometry(resized, { x: wideEllipse.x0, y: wideEllipse.y0 }),
    localEllipseGeometry(translatedResized, {
      x: translatedWideEllipse.x0,
      y: translatedWideEllipse.y0,
    }),
    `${handleId} produces the same ellipse resize at every canvas position`,
  );
  const settled = shapeTransformHandles(resized).find(({ id }) => id === handleId);
  assert.deepEqual({ x: settled.x, y: settled.y }, target,
    `${handleId} remains attached after resizing`);

  const oppositeId = oppositeEllipseHandle.get(handleId);
  const opposite = initialHandles.find(({ id }) => id === oppositeId);
  const reverseTarget = {
    x: opposite.x + (opposite.x === initial.x ? 0 : (opposite.x > initial.x ? 2 : -2)),
    y: opposite.y + (opposite.y === initial.y ? 0 : (opposite.y > initial.y ? 2 : -2)),
  };
  const reversed = transformShapeFromCageHandle(wideEllipse, handleId, reverseTarget);
  const reversedHandles = shapeTransformHandles(reversed);
  const reversedHandle = reversedHandles.find(({ id }) => id === handleId);
  const fixedOpposite = reversedHandles.find(({ id }) => id === oppositeId);
  assert.deepEqual({ x: reversedHandle.x, y: reversedHandle.y }, reverseTarget,
    `${handleId} remains attached after crossing its opposite`);
  assert.deepEqual({ x: fixedOpposite.x, y: fixedOpposite.y }, {
    x: opposite.x,
    y: opposite.y,
  }, `${handleId} reverse drag preserves its opposite anchor`);
}

const halfCellProportional = transformShapeFromHandle(
  { ...rect, detail: 'half' },
  'vertex:2',
  { x: 4, y: 7 },
  { shift: true },
);
assert.deepEqual(
  {
    x0: halfCellProportional.x0,
    y0: halfCellProportional.y0,
    x1: halfCellProportional.x1,
    y1: halfCellProportional.y1,
  },
  { x0: 0, y0: 0, x1: 14, y1: 7 },
  'subcell proportional scaling keeps authored-vertex behavior',
);
const edgeScaled = transformShapeFromHandle(rect, 'edge:1', { x: 8, y: 1 });
assert.deepEqual(
  { x0: edgeScaled.x0, x1: edgeScaled.x1, y0: edgeScaled.y0, y1: edgeScaled.y1 },
  { x0: 0, x1: 8, y0: 0, y1: 2 },
  'an edge drag scales only the edge-normal axis around its opposite edge',
);
const skewed = transformShapeFromHandle(rect, 'edge:1', { x: 4, y: 2 }, {
  ctrl: true,
  shift: true,
});
assert.deepEqual(skewed.vertices, [
  { x: 0, y: 0 },
  { x: 4, y: 1 },
  { x: 4, y: 3 },
  { x: 0, y: 2 },
], 'Ctrl+Shift slides only the selected edge along its tangent');

const perspective = transformShapeFromHandle(rect, 'vertex:0', { x: 1, y: 0.5 }, {
  ctrl: true,
  alt: true,
  shift: true,
});
assert.deepEqual(perspective.vertices, [
  { x: 1, y: 1 },
  { x: 3, y: 0 },
  { x: 4, y: 2 },
  { x: 0, y: 1 },
], 'perspective mirrors horizontal and vertical motion across the two meeting edges');
assert.equal(shapeTransformQuantum({ ...rect, detail: 'quarter' }), 0.5);
assert.deepEqual(
  snapShapeTransformPoint({ ...rect, detail: 'quarter' }, { x: 1.26, y: -0.24 }),
  { x: 1.5, y: 0 },
  'half and quarter geometry snaps to half cells without negative zero',
);

const anchorMoved = transformShapeFromHandle(rotated, 'anchor', { x: 4, y: 1 });
const beforeAnchorMove = resolvedShapeVertices(rotated);
const afterAnchorMove = resolvedShapeVertices(anchorMoved);
for (let index = 0; index < beforeAnchorMove.length; index++) {
  assert.ok(Math.abs(beforeAnchorMove[index].x - afterAnchorMove[index].x) < 1e-9);
  assert.ok(Math.abs(beforeAnchorMove[index].y - afterAnchorMove[index].y) < 1e-9);
}
assert.deepEqual(anchorMoved.anchor, { x: 4, y: 1 },
  'moving a reference point does not move already-rotated artwork');
const fractionalAnchorMoved = transformShapeFromHandle(
  rotated,
  'anchor',
  { x: 4.25, y: 1.75 },
);
assert.deepEqual(fractionalAnchorMoved.anchor, { x: 4.25, y: 1.75 },
  'an anchor keeps its authored fractional position instead of snapping to cells');
resolvedShapeVertices(fractionalAnchorMoved).forEach((point, index) => {
  assert.ok(Math.abs(point.x - beforeAnchorMove[index].x) < 1e-9);
  assert.ok(Math.abs(point.y - beforeAnchorMove[index].y) < 1e-9);
});
const rotationHandle = shapeTransformHandles(rect).find(({ type }) => type === 'rotation');
const rotatedFromHandle = transformShapeFromHandle(rect, 'rotation', { x: 4, y: 1 });
assert.ok(Math.abs(rotatedFromHandle.rotation - 90) < 1e-9,
  'rotation uses the pointer angle relative to the original rotation handle');
assert.ok(rotationHandle.y < 0);
const nearWrapRotation = { ...rect, rotation: 170 };
const nearWrapHandle = shapeTransformHandles(nearWrapRotation)
  .find(({ type }) => type === 'rotation');
const wrapTargetAngle = Math.atan2(
  nearWrapHandle.y - 1,
  nearWrapHandle.x - 2,
) + 20 * Math.PI / 180;
const wrapRadius = Math.hypot(nearWrapHandle.x - 2, nearWrapHandle.y - 1);
const rotatedAcrossWrap = transformShapeFromHandle(nearWrapRotation, 'rotation', {
  x: 2 + Math.cos(wrapTargetAngle) * wrapRadius,
  y: 1 + Math.sin(wrapTargetAngle) * wrapRadius,
});
assert.ok(Math.abs(rotatedAcrossWrap.rotation - 190) < 1e-9,
  'rotation stays continuous when a handle crosses the 180-degree boundary');
assert.equal(
  transformShapeFromHandle(rect, 'rotation', { x: 2, y: -3 }, {
    rotationDelta: 360,
  }).rotation,
  360,
  'a continuous handle drag can author a complete turn',
);

const special = { ...rect, style: 'special', boxStyle: 'single' };
const specialHandles = shapeTransformHandles(special);
assert.equal(specialHandles.some(({ type }) => type === 'rotation'), false);
assert.equal(specialHandles.some(({ type }) => type === 'anchor'), false);
assert.equal(
  specialHandles.filter(({ type }) => type === 'vertex')
    .every(({ freeDistort }) => !freeDistort),
  true,
);
const restrictedDrag = transformShapeFromHandle(
  special,
  'vertex:0',
  { x: 1, y: 1 },
  { ctrl: true, alt: true, shift: true },
);
assert.equal(Object.hasOwn(restrictedDrag, 'vertices'), false,
  'semantic borders stay box geometry even when free-distort modifiers are held');

const backgroundShape = {
  ...rect,
  channel: 'background',
  detail: 'quarter',
};
const backgroundHandles = shapeTransformHandles(backgroundShape);
assert.equal(backgroundHandles.some(({ type }) => type === 'rotation'), false);
assert.equal(backgroundHandles.some(({ type }) => type === 'anchor'), false);
assert.equal(
  backgroundHandles.filter(({ type }) => type === 'vertex')
    .every(({ freeDistort, perspective }) => !freeDistort && !perspective),
  true,
);
assert.equal(shapeTransformQuantum(backgroundShape), 1,
  'background geometry stays on whole cells and cannot enter free transform');
assert.equal(
  transformShapeFromHandle(backgroundShape, 'anchor', { x: 7, y: 7 }),
  null,
  'restricted geometry cannot mutate a hidden transform anchor',
);

assert.deepEqual(
  shapeTransformCageVertices(rect),
  [
    { x: -0.5, y: -0.5 },
    { x: 4.5, y: -0.5 },
    { x: 4.5, y: 2.5 },
    { x: -0.5, y: 2.5 },
  ],
  'an inclusive cell rectangle cage encloses the complete rendered cells',
);
assert.deepEqual(
  shapeTransformCageVertices({ ...rect, kind: 'circle' }),
  shapeTransformCageVertices(rect),
  'an inclusive cell circle uses the same outer transform box',
);
assert.deepEqual(
  shapeTransformCageVertices({ ...rect, detail: 'quarter' }),
  resolvedShapeVertices({ ...rect, detail: 'quarter' }),
  'subcell geometry keeps its authored boundary without whole-cell padding',
);

const restrictedLineHandles = shapeTransformHandles({
  ...rect,
  kind: 'line',
  style: 'slope',
});
assert.deepEqual(
  restrictedLineHandles.map(({ type }) => type),
  ['vertex', 'vertex'],
  'a constrained line exposes only its two meaningful endpoint controls',
);
assert.equal(
  restrictedLineHandles.every(({ scaleModifiers }) => !scaleModifiers),
  true,
  'constrained endpoints do not advertise modifiers that their geometry ignores',
);

const asymmetricLine = {
  ...rect,
  kind: 'line',
  x0: 3,
  y0: 8,
  x1: 14,
  y1: 5,
  anchor: { x: 7, y: 6 },
};
for (const translation of [{ x: 0, y: 0 }, { x: 9, y: -4 }]) {
  const movedLine = {
    ...asymmetricLine,
    x0: asymmetricLine.x0 + translation.x,
    y0: asymmetricLine.y0 + translation.y,
    x1: asymmetricLine.x1 + translation.x,
    y1: asymmetricLine.y1 + translation.y,
    anchor: {
      x: asymmetricLine.anchor.x + translation.x,
      y: asymmetricLine.anchor.y + translation.y,
    },
  };
  for (const [index, delta] of [[0, { x: -2, y: 3 }], [1, { x: 4, y: -1 }]]) {
    const before = resolvedShapeVertices(movedLine);
    const handleId = `vertex:${index}`;
    const handle = shapeTransformHandles(movedLine).find(({ id }) => id === handleId);
    const edited = transformShapeFromCageHandle(movedLine, handleId, {
      x: handle.x + delta.x,
      y: handle.y + delta.y,
    });
    const after = resolvedShapeVertices(edited);
    assert.deepEqual(after[index], {
      x: before[index].x + delta.x,
      y: before[index].y + delta.y,
    }, `${handle.label} follows its asymmetric two-axis pointer delta`);
    assert.deepEqual(after[1 - index], before[1 - index],
      `${handle.label} leaves the opposite endpoint exact after a body move`);
    assert.deepEqual(edited.anchor, movedLine.anchor,
      `${handle.label} preserves explicit line anchor metadata`);
  }
}

const pentagon = {
  ...rect,
  kind: 'polygon',
  vertices: [
    { x: 2, y: 0 },
    { x: 4, y: 2 },
    { x: 3, y: 4 },
    { x: 1, y: 4 },
    { x: 0, y: 2 },
  ],
};

function polygonArea(vertices) {
  return vertices.reduce((area, point, index) => {
    const next = vertices[(index + 1) % vertices.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function rotatedDelta(delta, degrees) {
  const radians = degrees * Math.PI / 180;
  return {
    x: delta.x * Math.cos(radians) - delta.y * Math.sin(radians),
    y: delta.x * Math.sin(radians) + delta.y * Math.cos(radians),
  };
}

function polygonForEdgeOracle(sides, translation = { x: 0, y: 0 }) {
  const anchor = { x: 30 + translation.x, y: 24 + translation.y };
  return {
    ...rect,
    kind: 'polygon',
    sides,
    rotation: 30,
    anchor,
    vertices: Array.from({ length: sides }, (_, index) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / sides;
      return {
        x: anchor.x + Math.cos(angle) * 14,
        y: anchor.y + Math.sin(angle) * 11,
      };
    }),
  };
}

function changedVertexIndices(before, after) {
  return before.flatMap((point, index) => (
    point.x === after[index].x && point.y === after[index].y ? [] : [index]
  ));
}

for (const sides of [3, 4, 5, 8]) {
  for (const translation of [{ x: 0, y: 0 }, { x: 9, y: -6 }]) {
    const polygon = polygonForEdgeOracle(sides, translation);
    const beforeArea = polygonArea(polygon.vertices);
    const snapshot = structuredClone(polygon);
    for (const authoredDelta of [{ x: 3, y: -2 }, { x: -3, y: 2 }]) {
      const screenDelta = rotatedDelta(authoredDelta, polygon.rotation);
      for (let edgeIndex = 0; edgeIndex < sides; edgeIndex++) {
        const handleId = `edge:${edgeIndex}`;
        const handle = shapeTransformHandles(polygon)
          .find(({ id }) => id === handleId);
        const worldOffset = { x: 17, y: -9 };
        const cellSize = { w: 13, h: 29 };
        const pointerStart = {
          x: (handle.x + worldOffset.x) * cellSize.w,
          y: (handle.y + worldOffset.y) * cellSize.h,
        };
        const target = shapeHandleDragTarget(handle, pointerStart, {
          x: pointerStart.x + screenDelta.x * cellSize.w,
          y: pointerStart.y + screenDelta.y * cellSize.h,
        }, cellSize);
        const edited = transformShapeFromCageHandle(polygon, handleId, target, {
          ctrl: true,
          alt: true,
          shift: true,
        });
        const adjacent = [edgeIndex, (edgeIndex + 1) % sides];

        assert.deepEqual(
          changedVertexIndices(polygon.vertices, edited.vertices),
          [...adjacent].sort((a, b) => a - b),
          `${sides}-side ${handleId} changes only its adjacent vertex indices`,
        );
        edited.vertices.forEach((point, index) => {
          const expected = adjacent.includes(index)
            ? {
              x: polygon.vertices[index].x + authoredDelta.x,
              y: polygon.vertices[index].y + authoredDelta.y,
            }
            : polygon.vertices[index];
          assert.ok(Math.abs(point.x - expected.x) < 1e-9);
          assert.ok(Math.abs(point.y - expected.y) < 1e-9);
        });
        assert.deepEqual(edited.anchor, polygon.anchor,
          `${sides}-side ${handleId} preserves its authored anchor`);
        assert.equal(edited.rotation, polygon.rotation,
          `${sides}-side ${handleId} preserves rotation metadata`);
        assert.equal(edited.sides, sides,
          `${sides}-side ${handleId} remains a closed polygon with the same side count`);
        assert.equal(Math.sign(polygonArea(edited.vertices)), Math.sign(beforeArea),
          `${sides}-side ${handleId} preserves winding`);
      }
    }
    assert.deepEqual(polygon, snapshot,
      `${sides}-side edge drags do not mutate their source after a body translation`);
  }
}

const restrictedPolygon = {
  ...polygonForEdgeOracle(5),
  channel: 'background',
  detail: 'half',
};
const restrictedEdge = shapeTransformHandles(restrictedPolygon)
  .find(({ id }) => id === 'edge:2');
const restrictedDelta = rotatedDelta({ x: 2, y: -1 }, restrictedPolygon.rotation);
const restrictedEdgeMove = transformShapeFromCageHandle(restrictedPolygon, 'edge:2', {
  x: restrictedEdge.x + restrictedDelta.x,
  y: restrictedEdge.y + restrictedDelta.y,
});
assert.deepEqual(
  changedVertexIndices(restrictedPolygon.vertices, restrictedEdgeMove.vertices),
  [2, 3],
  'a whole-cell constrained polygon still translates only its selected edge',
);
const polygonVertexMove = transformShapeFromHandle(
  pentagon,
  'vertex:2',
  { x: 4, y: 7 },
  { shift: true },
);
assert.deepEqual(polygonVertexMove.vertices, [
  { x: 2, y: 0 },
  { x: 4, y: 2 },
  { x: 4, y: 7 },
  { x: 1, y: 4 },
  { x: 0, y: 2 },
], 'a polygon vertex control moves only its targeted vertex under modifiers');

console.log('shape transform tests passed');
