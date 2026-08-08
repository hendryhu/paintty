import {
  normalizeShapePathKey,
  shapePathDefaultAnchor,
  shapePathVertices,
  shapeWithPathValue,
  translateShapePathKey,
} from './shapePath.js';
import {
  constrainShape,
  regularPolygonVertices,
} from './shapes.js';
import { transformShapeFromHandle } from './shapeTransform.js';

const EPSILON = 1e-9;

function finite(value) {
  return Number.isFinite(value);
}

function closeNumber(first, second) {
  return Math.abs(first - second) < EPSILON;
}

function closePoints(first, second) {
  return first.length === second.length && first.every((point, index) =>
    closeNumber(point.x, second[index].x) &&
    closeNumber(point.y, second[index].y));
}

function verticesWithUpdatedBounds(path, vertices) {
  const xs = vertices.map(({ x }) => x);
  const ys = vertices.map(({ y }) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return normalizeShapePathKey({
    ...path,
    ...(path.kind === 'polygon'
      ? {}
      : {
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        w: maxX - minX + 1,
        h: maxY - minY + 1,
      }),
    vertices,
  }, path.kind);
}

// Center and size describe inclusive cell bounds, not raw vertex spans.
export function shapePathAggregateMetrics(value) {
  const path = normalizeShapePathKey(value);
  if (!path || path.kind === 'line') return null;
  const vertices = shapePathVertices(path);
  const xs = vertices.map(({ x }) => x);
  const ys = vertices.map(({ y }) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
  };
}

function polygonSideCount(shape) {
  return Math.max(3, Math.min(64,
    Math.round(Number(shape?.sides) || shape?.vertices?.length || 3)));
}

function clonePolygonShape(shape) {
  return {
    ...shape,
    ...(Array.isArray(shape.vertices)
      ? { vertices: shape.vertices.map((point) => ({ ...point })) }
      : {}),
    ...(shape.anchor ? { anchor: { ...shape.anchor } } : {}),
  };
}

function regularPolygonForMetrics(metrics, sides) {
  const vertices = regularPolygonVertices(-1, -1, 1, 1, sides);
  const xs = vertices.map(({ x }) => x);
  const ys = vertices.map(({ y }) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const targetMinX = metrics.cx - (metrics.w - 1) / 2;
  const targetMaxX = metrics.cx + (metrics.w - 1) / 2;
  const targetMinY = metrics.cy - (metrics.h - 1) / 2;
  const targetMaxY = metrics.cy + (metrics.h - 1) / 2;
  return {
    bounds: [targetMinX, targetMinY, targetMaxX, targetMaxY],
    vertices: vertices.map((point) => ({
      x: targetMinX + (point.x - minX) / (maxX - minX) *
        (targetMaxX - targetMinX),
      y: targetMinY + (point.y - minY) / (maxY - minY) *
        (targetMaxY - targetMinY),
    })),
  };
}

// A scrub is always recomputed from its start so returning home restores custom vertices.
export function editPolygonSides(value, nextSides, gestureStart = null) {
  const current = value?.kind === 'polygon' ? value : null;
  const baseline = gestureStart?.kind === 'polygon' ? gestureStart : current;
  if (!current || !baseline || !finite(nextSides)) return null;
  const sides = Math.max(3, Math.min(64, Math.round(nextSides)));

  let edited;
  if (sides === polygonSideCount(baseline)) {
    edited = clonePolygonShape(baseline);
  } else {
    const aggregate = shapePathAggregateMetrics(baseline);
    if (!aggregate) return null;
    const { bounds, vertices } = regularPolygonForMetrics(aggregate, sides);
    if (vertices.length !== sides) return null;
    edited = {
      ...clonePolygonShape(baseline),
      sides,
      vertices,
      x0: bounds[0],
      y0: bounds[1],
      x1: bounds[2],
      y1: bounds[3],
    };
  }

  return polygonSideCount(current) === polygonSideCount(edited) &&
    closePoints(current.vertices || [], edited.vertices || [])
    ? null
    : edited;
}

// Aggregate size changes scale authored vertices around the transform anchor.
export function editShapePathAggregate(value, field, nextValue, gestureStart = null) {
  const current = normalizeShapePathKey(value);
  const baseline = normalizeShapePathKey(gestureStart, current?.kind) || current;
  if (!current || !baseline || !finite(nextValue) ||
    !['rect', 'circle', 'polygon'].includes(baseline.kind)) return null;
  const metrics = shapePathAggregateMetrics(baseline);
  if (!metrics || !Object.hasOwn(metrics, field)) return null;
  if (field === 'cx' || field === 'cy') {
    const dx = field === 'cx' ? nextValue - metrics.cx : 0;
    const dy = field === 'cy' ? nextValue - metrics.cy : 0;
    return translateShapePathKey(baseline, dx, dy);
  }

  const requestedSize = Math.max(1, nextValue);
  const oldSpan = Math.max(0, metrics[field] - 1);
  const newSpan = requestedSize - 1;
  const scale = oldSpan < EPSILON ? 1 : newSpan / oldSpan;
  const axis = field === 'w' ? 'x' : 'y';
  const anchor = shapePathDefaultAnchor(baseline);

  if (!baseline.vertices && baseline.kind !== 'polygon') {
    const centerField = field === 'w' ? 'cx' : 'cy';
    return normalizeShapePathKey({
      ...baseline,
      [field]: requestedSize,
      [centerField]: anchor[axis] +
        (baseline[centerField] - anchor[axis]) * scale,
    }, baseline.kind);
  }

  let vertices = shapePathVertices(baseline);
  if (oldSpan < EPSILON && newSpan >= EPSILON) {
    const normalized = baseline.kind === 'polygon'
      ? vertices.map((_, index) => {
        const angle = -Math.PI / 2 + index * 2 * Math.PI / vertices.length;
        return axis === 'x' ? Math.cos(angle) : Math.sin(angle);
      })
      : (axis === 'x' ? [-1, 1, 1, -1] : [-1, -1, 1, 1]);
    const min = Math.min(...normalized);
    const max = Math.max(...normalized);
    vertices = vertices.map((point, index) => ({
      ...point,
      [axis]: anchor[axis] +
        ((normalized[index] - min) / Math.max(EPSILON, max - min) - 0.5) * newSpan,
    }));
  } else {
    vertices = vertices.map((point) => ({
      ...point,
      [axis]: anchor[axis] + (point[axis] - anchor[axis]) * scale,
    }));
  }
  return verticesWithUpdatedBounds(baseline, vertices);
}

export function shapeForAnchorComponentEdit(shape, path, anchor) {
  if (!shape || !anchor || !finite(anchor.x) || !finite(anchor.y)) return null;
  const resolved = shapeWithPathValue(shape, path);
  // Move the authored pivot through the transform route so rendered vertices stay fixed.
  return transformShapeFromHandle(resolved, 'anchor', anchor);
}

function wholeCell(value) {
  return finite(value) && closeNumber(value, Math.round(value));
}

function wholeCellPoint(point) {
  return point && wholeCell(point.x) && wholeCell(point.y);
}

// Polygon detail changes only the rasterizer; authored vertices are never quantized.
export function canConvertShapeDetailToCell(shape, geometryAnimated = false) {
  if (!shape || shape.detail === 'cell') return true;
  if (shape.kind === 'polygon') return true;
  if (geometryAnimated) return false;
  const vertices = Array.isArray(shape.vertices) ? shape.vertices : [];
  if (shape.anchor && !wholeCellPoint(shape.anchor)) return false;
  if (vertices.length) return vertices.every(wholeCellPoint);
  return [shape.x0, shape.y0, shape.x1, shape.y1].every(wholeCell);
}

export function shapeForStaticPathEdit(shape, path) {
  return constrainShape(shapeWithPathValue(shape, path));
}
