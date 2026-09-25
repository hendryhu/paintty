import {
  constrainShape,
  resolvedShapeAnchor,
  resolvedShapeVertices,
} from './shapes.js';
import {
  pathValueFromShape,
  shapePathDefaultAnchor,
  shapePathVertices,
  shapeWithPathValue,
} from './shapePath.js';
import type {
  EditorPoint,
  EditorShape,
  EditorShapePath,
  EditorSize,
} from './types/editor-domain.js';

const EPSILON = 1e-9;
const ROTATION_SNAP_DEGREES = 15;
const RESTRICTED_STYLES = new Set(['special', 'slope']);
const UNCHANGED = Symbol('unchanged');
const HANDLE_HIT_PRIORITY = Object.freeze({
  vertex: 0,
  edge: 1,
  anchor: 2,
  rotation: 3,
});
const INCLUSIVE_CAGE_OFFSETS = Object.freeze([
  { x: -0.5, y: -0.5 },
  { x: 0.5, y: -0.5 },
  { x: 0.5, y: 0.5 },
  { x: -0.5, y: 0.5 },
]);

interface ShapeGeometry {
  path: EditorShapePath;
  vertices: EditorPoint[];
  anchor: EditorPoint;
  rotation: number;
  rotationAspect: number;
}

interface ShapeTransformModifiers {
  alt?: boolean | undefined;
  shift?: boolean | undefined;
  ctrl?: boolean | undefined;
  rotationDelta?: number | undefined;
  rotationAspect?: number | undefined;
}

type ParsedHandle =
  | { type: 'vertex'; index: number }
  | { type: 'edge'; index: number }
  | { type: 'anchor' }
  | { type: 'rotation' };

export interface ShapeTransformHandle extends EditorPoint {
  id: string;
  type: 'vertex' | 'edge' | 'anchor' | 'rotation';
  label: string;
  index?: number | undefined;
  from?: number | undefined;
  to?: number | undefined;
  targetX?: number | undefined;
  targetY?: number | undefined;
  freeDistort?: boolean | undefined;
  perspective?: boolean | undefined;
  scaleModifiers?: boolean | undefined;
  localMove?: boolean | undefined;
  skew?: boolean | undefined;
}

function finitePoint(point: unknown): point is EditorPoint {
  return !!point && typeof point === 'object' &&
    Number.isFinite((point as EditorPoint).x) && Number.isFinite((point as EditorPoint).y);
}

function clonePoint(point: EditorPoint): EditorPoint {
  return { x: point.x, y: point.y };
}

function midpoint(a: EditorPoint, b: EditorPoint): EditorPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function snapValue(value: number, quantum: number): number {
  const result = Math.round(value / quantum) * quantum;
  return Object.is(result, -0) ? 0 : result;
}

function rotatePoint(point: EditorPoint, anchor: EditorPoint, degrees: number, aspect = 1): EditorPoint {
  if (!degrees) return clonePoint(point);
  aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = (point.x - anchor.x) * aspect;
  const dy = point.y - anchor.y;
  return {
    x: anchor.x + (dx * cos - dy * sin) / aspect,
    y: anchor.y + dx * sin + dy * cos,
  };
}

export function shapeRotationAngle(point: unknown, anchor: unknown, aspect = 1): number | null {
  if (!finitePoint(point) || !finitePoint(anchor)) return null;
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return Math.atan2(point.y - anchor.y, (point.x - anchor.x) * safeAspect);
}

function shortestDegrees(degrees: number): number {
  let normalized = degrees % 360;
  if (normalized <= -180) normalized += 360;
  if (normalized > 180) normalized -= 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function pathGeometry(shape: EditorShape | null): ShapeGeometry | null {
  const path = pathValueFromShape(shape);
  if (!path) return null;
  const vertices = shapePathVertices(path);
  const anchor = shapePathDefaultAnchor(path);
  if (!vertices.length || !anchor) return null;
  return {
    path,
    vertices,
    anchor,
    rotation: path.rotation || 0,
    rotationAspect: path.rotationAspect || 1,
  };
}

function isRestricted(shape: EditorShape | null | undefined): boolean {
  return !!shape && (RESTRICTED_STYLES.has(shape.style) || shape.channel === 'background');
}

function usesInclusiveCellCage(shape: EditorShape, geometry: ShapeGeometry): boolean {
  return (shape?.kind === 'rect' || shape?.kind === 'circle') &&
    (shape.detail || 'cell') === 'cell' &&
    geometry.vertices.length === 4;
}

function localShapeTransformCageVertices(shape: EditorShape, geometry: ShapeGeometry): EditorPoint[] {
  if (!usesInclusiveCellCage(shape, geometry)) {
    return geometry.vertices.map(clonePoint);
  }
  return geometry.vertices.map((point, index) => ({
    x: point.x + INCLUSIVE_CAGE_OFFSETS[index]!.x,
    y: point.y + INCLUSIVE_CAGE_OFFSETS[index]!.y,
  }));
}

function authoredVerticesFromCage(shape: EditorShape, cageVertices: EditorPoint[]): EditorPoint[] {
  if ((shape?.kind !== 'rect' && shape?.kind !== 'circle') ||
    (shape.detail || 'cell') !== 'cell' || cageVertices.length !== 4) {
    return cageVertices.map(clonePoint);
  }
  return cageVertices.map((point, index) => ({
    x: point.x - INCLUSIVE_CAGE_OFFSETS[index]!.x,
    y: point.y - INCLUSIVE_CAGE_OFFSETS[index]!.y,
  }));
}

function isClosed(shape: EditorShape): boolean {
  return shape?.kind !== 'line';
}

function transformEdgePairs(shape: EditorShape, vertexCount: number): Array<[number, number]> {
  return shape?.kind === 'line' ? [] : edgePairs(vertexCount, true);
}

function edgePairs(vertexCount: number, closed: boolean): Array<[number, number]> {
  if (vertexCount < 2) return [];
  const count = closed ? vertexCount : vertexCount - 1;
  return Array.from({ length: count }, (_, index) => [
    index,
    (index + 1) % vertexCount,
  ]);
}

function outwardNormal(
  from: EditorPoint,
  to: EditorPoint,
  edgeMidpoint: EditorPoint,
  anchor: EditorPoint,
  aspect = 1,
): EditorPoint {
  aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const dx = (to.x - from.x) * aspect;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < EPSILON) return { x: 0, y: -1 };
  let normal = { x: -dy / length, y: dx / length };
  const away = (edgeMidpoint.x - anchor.x) * aspect * normal.x +
    (edgeMidpoint.y - anchor.y) * normal.y;
  if (away < -EPSILON || (Math.abs(away) < EPSILON && normal.y > 0)) {
    normal = { x: -normal.x, y: -normal.y };
  }
  return { x: normal.x / aspect, y: normal.y };
}

function rotationHandlePoint(vertices: EditorPoint[], anchor: EditorPoint, offset: number, aspect = 1): EditorPoint {
  const [first, second] = vertices.length > 1 ? vertices : [anchor, anchor];
  const edgeMidpoint = midpoint(first!, second!);
  const normal = outwardNormal(first!, second!, edgeMidpoint, anchor, aspect);
  return {
    x: edgeMidpoint.x + normal.x * offset,
    y: edgeMidpoint.y + normal.y * offset,
  };
}

export function shapeTransformQuantum(shape: EditorShape | null | undefined): number {
  const subcell = shape?.detail === 'half' || shape?.detail === 'quarter';
  return subcell && !isRestricted(shape) ? 0.5 : 1;
}

export function snapShapeTransformPoint(shape: EditorShape, point: unknown): EditorPoint | null {
  if (!finitePoint(point)) return null;
  const quantum = shapeTransformQuantum(shape);
  return { x: snapValue(point.x, quantum), y: snapValue(point.y, quantum) };
}

export function shapeHandleDragTarget(
  handle: unknown,
  startPointer: unknown,
  currentPointer: unknown,
  cellSize: Partial<EditorSize> | null | undefined,
): EditorPoint | null {
  if (!finitePoint(handle) || !finitePoint(startPointer) || !finitePoint(currentPointer)) {
    return null;
  }
  const width = Number(cellSize?.w);
  const height = Number(cellSize?.h);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return null;
  }
  return {
    x: handle.x + (currentPointer.x - startPointer.x) / width,
    y: handle.y + (currentPointer.y - startPointer.y) / height,
  };
}

interface ShapeHandleHitTarget {
  id?: string | null | undefined;
  type?: keyof typeof HANDLE_HIT_PRIORITY | undefined;
  stackOrder?: number | undefined;
  rect?: Partial<DOMRect> | undefined;
}

export function pickShapeTransformHandle(
  targets: ShapeHandleHitTarget[] | null | undefined,
  point: unknown,
): string | null {
  if (!finitePoint(point)) return null;
  let best: { id: string; distance: number; priority: number; stackOrder: number } | null = null;
  for (const [index, target] of (targets || []).entries()) {
    const rect = target?.rect;
    const left = Number(rect?.left);
    const top = Number(rect?.top);
    const right = Number.isFinite(Number(rect?.right))
      ? Number(rect?.right)
      : left + Number(rect?.width);
    const bottom = Number.isFinite(Number(rect?.bottom))
      ? Number(rect?.bottom)
      : top + Number(rect?.height);
    if (target?.id == null || ![left, top, right, bottom].every(Number.isFinite) ||
      right <= left || bottom <= top ||
      point.x < left || point.x > right || point.y < top || point.y > bottom) continue;
    const dx = point.x - (left + right) / 2;
    const dy = point.y - (top + bottom) / 2;
    const candidate = {
      id: target.id,
      distance: dx * dx + dy * dy,
      priority: target.type ? HANDLE_HIT_PRIORITY[target.type] : -1,
      stackOrder: Number.isFinite(Number(target.stackOrder)) ? Number(target.stackOrder) : index,
    };
    if (!best || candidate.distance < best.distance - EPSILON ||
      (Math.abs(candidate.distance - best.distance) <= EPSILON &&
        (candidate.priority > best.priority ||
          (candidate.priority === best.priority && candidate.stackOrder > best.stackOrder)))) {
      best = candidate;
    }
  }
  return best?.id ?? null;
}

// Rectangle and circle cell endpoints address centers; their cage frames whole cells.
export function shapeTransformCageVertices(shape: EditorShape): EditorPoint[] {
  const geometry = pathGeometry(shape);
  if (!geometry) return [];
  const vertices = localShapeTransformCageVertices(shape, geometry);
  return vertices.map((point) =>
    rotatePoint(point, geometry.anchor, geometry.rotation, geometry.rotationAspect));
}

export function shapeTransformHandles(
  shape: EditorShape,
  options: {
    rotationOffset?: number | undefined;
    rotationAspect?: number | undefined;
  } = {},
): ShapeTransformHandle[] {
  const geometry = pathGeometry(shape);
  if (!geometry) return [];
  const targetVertices = resolvedShapeVertices(shape);
  const vertices = shapeTransformCageVertices(shape);
  if (!vertices.length || vertices.length !== targetVertices.length) return [];
  const anchor = resolvedShapeAnchor(shape);
  const restricted = isRestricted(shape);
  const localPolygonControls = shape.kind === 'polygon';
  const handles: ShapeTransformHandle[] = vertices.map((point, index) => ({
    id: `vertex:${index}`,
    type: 'vertex',
    index,
    x: point.x,
    y: point.y,
    targetX: targetVertices[index]!.x,
    targetY: targetVertices[index]!.y,
    label: shape.kind === 'line'
      ? (index === 0 ? 'Start' : 'End')
      : `Vertex ${index + 1}`,
    freeDistort: !restricted && !localPolygonControls,
    perspective: !restricted && !localPolygonControls && vertices.length === 4,
    scaleModifiers: !localPolygonControls && !(restricted && shape.kind === 'line'),
    ...(localPolygonControls ? { localMove: true } : {}),
  }));
  for (const [index, [from, to]] of transformEdgePairs(shape, vertices.length).entries()) {
    const point = midpoint(vertices[from]!, vertices[to]!);
    const target = midpoint(targetVertices[from]!, targetVertices[to]!);
    handles.push({
      id: `edge:${index}`,
      type: 'edge',
      index,
      from,
      to,
      x: point.x,
      y: point.y,
      targetX: target.x,
      targetY: target.y,
      label: `Edge ${index + 1}`,
      ...(shape.kind === 'polygon'
        ? { localMove: true }
        : { skew: !restricted && vertices.length >= 3 }),
    });
  }
  if (!restricted) {
    handles.push({
      id: 'anchor',
      type: 'anchor',
      x: anchor.x,
      y: anchor.y,
      label: 'Anchor point',
    });
  }
  if (!restricted) {
    const requestedAspect = Number(options.rotationAspect);
    const point = rotationHandlePoint(
      vertices,
      anchor,
      Math.max(0.5, Number(options.rotationOffset) || 2),
      Number.isFinite(requestedAspect) && requestedAspect > 0
        ? requestedAspect
        : geometry.rotationAspect,
    );
    handles.push({
      id: 'rotation',
      type: 'rotation',
      x: point.x,
      y: point.y,
      label: 'Rotation',
    });
  }
  return handles;
}

function parseHandle(shape: EditorShape, id: unknown): ParsedHandle | null {
  if (id === 'anchor' || id === 'rotation') return { type: id };
  const match = /^(vertex|edge):(\d+)$/.exec(String(id));
  if (!match) return null;
  const vertices = resolvedShapeVertices(shape);
  const index = Number(match[2]);
  const limit = match[1] === 'edge'
    ? transformEdgePairs(shape, vertices.length).length
    : vertices.length;
  const type = match[1] as 'vertex' | 'edge';
  return index < limit ? { type, index } : null;
}

function axisQuad(vertices: EditorPoint[]): boolean {
  if (vertices.length !== 4) return false;
  const [tl, tr, br, bl] = vertices as [EditorPoint, EditorPoint, EditorPoint, EditorPoint];
  return Math.abs(tl.y - tr.y) < EPSILON &&
    Math.abs(tr.x - br.x) < EPSILON &&
    Math.abs(br.y - bl.y) < EPSILON &&
    Math.abs(bl.x - tl.x) < EPSILON;
}

function canonicalAxisQuad(vertices: EditorPoint[]): boolean {
  return axisQuad(vertices) &&
    vertices[0]!.x <= vertices[1]!.x &&
    vertices[0]!.y <= vertices[3]!.y;
}

function setPathVertices(shape: EditorShape, vertices: EditorPoint[], {
  anchor = UNCHANGED,
  rotation = UNCHANGED,
  forceExplicit = false,
}: {
  anchor?: EditorPoint | typeof UNCHANGED;
  rotation?: number | typeof UNCHANGED;
  forceExplicit?: boolean;
} = {}): EditorShape | null {
  const geometry = pathGeometry(shape);
  if (!geometry || vertices.some((point) => !finitePoint(point))) return null;
  const path = { ...geometry.path };
  const explicit = forceExplicit ||
    path.kind === 'polygon' ||
    Array.isArray(path.vertices) ||
    (path.kind !== 'line' && !axisQuad(vertices));

  if (explicit) {
    path.vertices = vertices.map(clonePoint);
  } else if (path.kind === 'line') {
    path.x0 = vertices[0]!.x;
    path.y0 = vertices[0]!.y;
    path.x1 = vertices[1]!.x;
    path.y1 = vertices[1]!.y;
  } else {
    const xs = vertices.map(({ x }) => x);
    const ys = vertices.map(({ y }) => y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    path.cx = (x0 + x1) / 2;
    path.cy = (y0 + y1) / 2;
    path.w = x1 - x0 + 1;
    path.h = y1 - y0 + 1;
  }

  if (anchor !== UNCHANGED) path.anchor = clonePoint(anchor);
  if (rotation !== UNCHANGED) path.rotation = rotation;
  return shapeWithPathValue(shape, path);
}

function oppositeVertex(vertices: EditorPoint[], selected: number): number {
  if (vertices.length === 2) return 1 - selected;
  if (vertices.length === 4) return (selected + 2) % 4;
  let opposite = selected;
  let distance = -1;
  for (let index = 0; index < vertices.length; index++) {
    const dx = vertices[index]!.x - vertices[selected]!.x;
    const dy = vertices[index]!.y - vertices[selected]!.y;
    const candidate = dx * dx + dy * dy;
    if (candidate > distance) {
      distance = candidate;
      opposite = index;
    }
  }
  return opposite;
}

function scaleRatio(target: number, pivot: number, source: number): number {
  const denominator = source - pivot;
  return Math.abs(denominator) < EPSILON ? 1 : (target - pivot) / denominator;
}

function proportionalRatio(xRatio: number, yRatio: number, source: EditorPoint, pivot: EditorPoint): number {
  const xUsable = Math.abs(source.x - pivot.x) >= EPSILON;
  const yUsable = Math.abs(source.y - pivot.y) >= EPSILON;
  const selected = !xUsable
    ? yRatio
    : !yUsable
      ? xRatio
      : Math.abs(xRatio - 1) >= Math.abs(yRatio - 1) ? xRatio : yRatio;
  return Math.max(0.02, Math.abs(selected));
}

// Scale the outer cell cage, then remove its half-cell padding without breaking inversions.
function scaleInclusiveCellCageFromVertex(
  vertices: EditorPoint[],
  cageVertices: EditorPoint[],
  index: number,
  target: EditorPoint,
  anchor: EditorPoint,
  modifiers: ShapeTransformModifiers,
): EditorPoint[] {
  const source = cageVertices[index]!;
  const authoredSource = vertices[index]!;
  const targetCage = {
    x: target.x + source.x - authoredSource.x,
    y: target.y + source.y - authoredSource.y,
  };
  const pivot = modifiers.alt
    ? anchor
    : cageVertices[oppositeVertex(cageVertices, index)]!;
  const ratio = proportionalRatio(
    scaleRatio(targetCage.x, pivot.x, source.x),
    scaleRatio(targetCage.y, pivot.y, source.y),
    source,
    pivot,
  );
  return cageVertices.map((point, vertexIndex) => ({
    x: pivot.x + (point.x - pivot.x) * ratio -
      (cageVertices[vertexIndex]!.x - vertices[vertexIndex]!.x),
    y: pivot.y + (point.y - pivot.y) * ratio -
      (cageVertices[vertexIndex]!.y - vertices[vertexIndex]!.y),
  }));
}

function scaleFromVertex(
  vertices: EditorPoint[],
  index: number,
  target: EditorPoint,
  anchor: EditorPoint,
  modifiers: ShapeTransformModifiers,
  cageVertices: EditorPoint[] | null = null,
): EditorPoint[] {
  if (modifiers.shift && cageVertices) {
    return scaleInclusiveCellCageFromVertex(
      vertices,
      cageVertices,
      index,
      target,
      anchor,
      modifiers,
    );
  }
  const source = vertices[index]!;
  const pivot = modifiers.alt
    ? anchor
    : vertices[oppositeVertex(vertices, index)]!;
  let scaleX = scaleRatio(target.x, pivot.x, source.x);
  let scaleY = scaleRatio(target.y, pivot.y, source.y);
  if (modifiers.shift) {
    const ratio = proportionalRatio(scaleX, scaleY, source, pivot);
    scaleX = ratio;
    scaleY = ratio;
  }
  return vertices.map((point) => ({
    x: pivot.x + (point.x - pivot.x) * scaleX,
    y: pivot.y + (point.y - pivot.y) * scaleY,
  }));
}

function oppositeEdgeMidpoint(vertices: EditorPoint[], edgeIndex: number, anchor: EditorPoint): EditorPoint {
  const pairs = edgePairs(vertices.length, true);
  if (!pairs.length) return clonePoint(anchor);
  if (pairs.length === 4) {
    const pair = pairs[(edgeIndex + 2) % pairs.length]!;
    return midpoint(vertices[pair[0]]!, vertices[pair[1]]!);
  }
  const sourcePair = pairs[edgeIndex]!;
  const source = midpoint(vertices[sourcePair[0]]!, vertices[sourcePair[1]]!);
  let pivot = clonePoint(anchor);
  let greatestDistance = -1;
  pairs.forEach((pair, index) => {
    if (index === edgeIndex) return;
    const candidate = midpoint(vertices[pair[0]]!, vertices[pair[1]]!);
    const distance = (candidate.x - source.x) ** 2 + (candidate.y - source.y) ** 2;
    if (distance > greatestDistance) {
      greatestDistance = distance;
      pivot = candidate;
    }
  });
  return pivot;
}

function scaleFromEdge(
  vertices: EditorPoint[],
  edgeIndex: number,
  target: EditorPoint,
  anchor: EditorPoint,
  closed: boolean,
  fromAnchor: boolean | undefined,
): EditorPoint[] {
  const pair = edgePairs(vertices.length, closed)[edgeIndex]!;
  const from = vertices[pair[0]]!;
  const to = vertices[pair[1]]!;
  const source = midpoint(from, to);
  const pivot = fromAnchor ? anchor : oppositeEdgeMidpoint(vertices, edgeIndex, anchor);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < EPSILON) return vertices.map(clonePoint);
  const normal = { x: -dy / length, y: dx / length };
  const sourceDistance = (source.x - pivot.x) * normal.x +
    (source.y - pivot.y) * normal.y;
  if (Math.abs(sourceDistance) < EPSILON) return vertices.map(clonePoint);
  const targetDistance = (target.x - pivot.x) * normal.x +
    (target.y - pivot.y) * normal.y;
  const scale = targetDistance / sourceDistance;
  return vertices.map((point) => {
    const relative = { x: point.x - pivot.x, y: point.y - pivot.y };
    const tangentDistance = relative.x * (dx / length) + relative.y * (dy / length);
    const normalDistance = relative.x * normal.x + relative.y * normal.y;
    return {
      x: pivot.x + tangentDistance * (dx / length) + normalDistance * scale * normal.x,
      y: pivot.y + tangentDistance * (dy / length) + normalDistance * scale * normal.y,
    };
  });
}

function boundsCenter(vertices: EditorPoint[]): EditorPoint {
  const xs = vertices.map(({ x }) => x);
  const ys = vertices.map(({ y }) => y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

function resizedAnchor(geometry: ShapeGeometry, vertices: EditorPoint[], modifiers: ShapeTransformModifiers): EditorPoint {
  if (modifiers.alt) return clonePoint(geometry.anchor);
  const before = boundsCenter(geometry.vertices);
  const after = boundsCenter(vertices);
  return {
    x: geometry.anchor.x + after.x - before.x,
    y: geometry.anchor.y + after.y - before.y,
  };
}

function commitResizedGeometry(
  shape: EditorShape,
  geometry: ShapeGeometry,
  vertices: EditorPoint[],
  modifiers: ShapeTransformModifiers,
  forceExplicit: boolean,
): EditorShape | null {
  const provisional = setPathVertices(shape, vertices, { forceExplicit });
  const normalized = pathGeometry(provisional);
  if (!normalized) return null;
  const snappedVertices = normalized.vertices;
  const nextAnchor = shape.kind === 'line'
    ? clonePoint(geometry.anchor)
    : resizedAnchor(geometry, snappedVertices, modifiers);
  const hasAuthoredAnchor = Object.prototype.hasOwnProperty.call(geometry.path, 'anchor');
  if (!geometry.rotation) {
    return setPathVertices(shape, snappedVertices, {
      anchor: hasAuthoredAnchor ? nextAnchor : UNCHANGED,
      forceExplicit,
    });
  }

  const resizedGeometry = { ...geometry, vertices: snappedVertices };
  const localCage = localShapeTransformCageVertices(shape, resizedGeometry);
  const worldCage = localCage.map((point) => rotatePoint(
    point,
    geometry.anchor,
    geometry.rotation,
    geometry.rotationAspect,
  ));
  const worldAnchor = rotatePoint(
    nextAnchor,
    geometry.anchor,
    geometry.rotation,
    geometry.rotationAspect,
  );
  const reauthoredCage = worldCage.map((point) => rotatePoint(
    point,
    worldAnchor,
    -geometry.rotation,
    geometry.rotationAspect,
  ));
  const reauthored = authoredVerticesFromCage(shape, reauthoredCage);
  return setPathVertices(shape, reauthored, {
    anchor: worldAnchor,
    forceExplicit: true,
  });
}

function translatePolygonEdge(vertices: EditorPoint[], edgeIndex: number, target: EditorPoint, quantum: number): EditorPoint[] | null {
  const pair = edgePairs(vertices.length, true)[edgeIndex];
  if (!pair) return null;
  const source = midpoint(vertices[pair[0]]!, vertices[pair[1]]!);
  const delta = {
    x: snapValue(target.x - source.x, quantum),
    y: snapValue(target.y - source.y, quantum),
  };
  return vertices.map((point, index) => pair.includes(index)
    ? { x: point.x + delta.x, y: point.y + delta.y }
    : clonePoint(point));
}

function skewEdge(vertices: EditorPoint[], edgeIndex: number, target: EditorPoint, closed: boolean): EditorPoint[] {
  const pair = edgePairs(vertices.length, closed)[edgeIndex]!;
  const from = vertices[pair[0]]!;
  const to = vertices[pair[1]]!;
  const source = midpoint(from, to);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < EPSILON) return vertices.map(clonePoint);
  const tangent = { x: dx / length, y: dy / length };
  const shift = (target.x - source.x) * tangent.x +
    (target.y - source.y) * tangent.y;
  return vertices.map((point, index) => pair.includes(index)
    ? { x: point.x + tangent.x * shift, y: point.y + tangent.y * shift }
    : clonePoint(point));
}

// Perspective changes the two edges meeting the dragged corner as mirrored pairs.
function perspectiveCorner(vertices: EditorPoint[], index: number, target: EditorPoint): EditorPoint[] | null {
  if (vertices.length !== 4) return null;
  const next = vertices.map(clonePoint);
  const dx = target.x - vertices[index]!.x;
  const dy = target.y - vertices[index]!.y;
  const horizontalPartner = [1, 0, 3, 2][index]!;
  const verticalPartner = [3, 2, 1, 0][index]!;
  next[index] = clonePoint(target);
  next[horizontalPartner]!.x -= dx;
  next[verticalPartner]!.y -= dy;
  return next;
}

function restrictedTransform(
  shape: EditorShape,
  handle: ParsedHandle,
  target: EditorPoint,
  modifiers: ShapeTransformModifiers,
): EditorShape | null {
  const visible = resolvedShapeVertices(shape);
  if (shape.kind === 'line' && handle.type === 'vertex') {
    const next = visible.map(clonePoint);
    next[handle.index] = target;
    const { vertices, anchor, rotation, ...legacy } = shape;
    return constrainShape({
      ...legacy,
      x0: next[0]!.x,
      y0: next[0]!.y,
      x1: next[1]!.x,
      y1: next[1]!.y,
    });
  }
  if (shape.kind === 'line' || handle.type === 'rotation') return null;
  if (handle.type === 'anchor') return {
    ...shape,
    anchor: clonePoint(target),
  };
  const geometry = pathGeometry(shape);
  if (!geometry || (handle.type !== 'vertex' && handle.type !== 'edge')) return null;
  const localTarget = target;
  const next = handle.type === 'vertex'
    ? scaleFromVertex(geometry.vertices, handle.index, localTarget, geometry.anchor, {
      alt: modifiers.alt,
      shift: modifiers.shift,
    }, usesInclusiveCellCage(shape, geometry)
      ? localShapeTransformCageVertices(shape, geometry)
      : null)
    : scaleFromEdge(
      geometry.vertices,
      handle.index,
      localTarget,
      geometry.anchor,
      true,
      modifiers.alt,
    );
  const { vertices, rotation, ...legacy } = shape;
  return setPathVertices(legacy, next);
}

function moveAnchor(shape: EditorShape, target: EditorPoint, geometry: ShapeGeometry): EditorShape | null {
  if (!geometry.rotation) {
    return setPathVertices(shape, geometry.vertices, { anchor: target });
  }
  // Re-author rotated vertices around the new anchor without moving their rendered positions.
  const visible = resolvedShapeVertices(shape);
  const reauthored = visible.map((point) =>
    rotatePoint(point, target, -geometry.rotation, geometry.rotationAspect));
  return setPathVertices(shape, reauthored, {
    anchor: target,
    forceExplicit: true,
  });
}

function rotateFromHandle(
  shape: EditorShape,
  target: EditorPoint,
  geometry: ShapeGeometry,
  authoredDelta: number | undefined,
  requestedAspect: number | undefined,
  snap: boolean,
): EditorShape | null {
  const aspect = typeof requestedAspect === 'number' && Number.isFinite(requestedAspect) && requestedAspect > 0
    ? requestedAspect
    : geometry.rotationAspect;
  const handle = shapeTransformHandles(shape, { rotationAspect: aspect })
    .find(({ id }) => id === 'rotation');
  if (!handle) return null;
  const initial = shapeRotationAngle(handle, geometry.anchor, aspect);
  const current = shapeRotationAngle(target, geometry.anchor, aspect);
  if (current == null || initial == null || !Number.isFinite(current) || Math.hypot(
    target.x - geometry.anchor.x,
    target.y - geometry.anchor.y,
  ) < EPSILON) return null;
  const delta = typeof authoredDelta === 'number' && Number.isFinite(authoredDelta)
    ? authoredDelta
    : shortestDegrees((current - initial) * 180 / Math.PI);
  const unsnappedRotation = geometry.rotation + delta;
  const rawRotation = snap
    ? Math.round(unsnappedRotation / ROTATION_SNAP_DEGREES) * ROTATION_SNAP_DEGREES
    : unsnappedRotation;
  const rotation = ((rawRotation % 360) + 360) % 360;
  const next = setPathVertices(shape, geometry.vertices, { rotation });
  return next ? { ...next, rotationAspect: aspect } : null;
}

export function transformShapeFromHandle(
  shape: EditorShape | null,
  handleId: unknown,
  target: unknown,
  modifiers: ShapeTransformModifiers = {},
): EditorShape | null {
  if (!shape || !finitePoint(target)) return null;
  const handle = parseHandle(shape, handleId);
  const geometry = pathGeometry(shape);
  if (!handle || !geometry) return null;
  if (shape.kind === 'polygon' && (handle.type === 'vertex' || handle.type === 'edge')) {
    // Polygon controls are rotated world points, while authored vertices remain unrotated.
    const localTarget = rotatePoint(
      target,
      geometry.anchor,
      -geometry.rotation,
      geometry.rotationAspect,
    );
    let vertices;
    if (handle.type === 'vertex') {
      vertices = geometry.vertices.map(clonePoint);
      vertices[handle.index] = snapShapeTransformPoint(shape, localTarget)!;
    } else {
      vertices = translatePolygonEdge(
        geometry.vertices,
        handle.index,
        localTarget,
        shapeTransformQuantum(shape),
      );
    }
    return vertices
      ? commitResizedGeometry(shape, geometry, vertices, modifiers, true)
      : null;
  }
  if (isRestricted(shape)) {
    if (handle.type === 'anchor' || handle.type === 'rotation') return null;
    return restrictedTransform(
      shape,
      handle,
      snapShapeTransformPoint(shape, target)!,
      modifiers,
    );
  }
  if (handle.type === 'anchor') return moveAnchor(shape, target, geometry);
  if (handle.type === 'rotation') {
    return rotateFromHandle(
      shape,
      target,
      geometry,
      modifiers.rotationDelta,
      modifiers.rotationAspect,
      !!modifiers.shift,
    );
  }

  // Transform and snap in authored space so rotated handles still land on the pointer.
  const localTarget = snapShapeTransformPoint(
    shape,
    rotatePoint(target, geometry.anchor, -geometry.rotation, geometry.rotationAspect),
  )!;
  let vertices: EditorPoint[] | null;
  let forceExplicit = false;
  if (handle.type === 'vertex') {
    if (modifiers.ctrl && modifiers.alt && modifiers.shift) {
      vertices = perspectiveCorner(geometry.vertices, handle.index, localTarget);
      forceExplicit = true;
    } else if (modifiers.ctrl) {
      vertices = geometry.vertices.map(clonePoint);
      vertices[handle.index] = localTarget;
      forceExplicit = shape.kind !== 'line';
    } else if (shape.kind === 'line' && !modifiers.alt && !modifiers.shift) {
      // A horizontal or vertical line has no scale ratio on its collapsed axis.
      vertices = geometry.vertices.map(clonePoint);
      vertices[handle.index] = localTarget;
    } else {
      vertices = scaleFromVertex(
        geometry.vertices,
        handle.index,
        localTarget,
        geometry.anchor,
        modifiers,
        usesInclusiveCellCage(shape, geometry)
          ? localShapeTransformCageVertices(shape, geometry)
          : null,
      );
      forceExplicit = shape.kind !== 'line' &&
        !Array.isArray(geometry.path.vertices) &&
        axisQuad(vertices) &&
        !canonicalAxisQuad(vertices);
    }
  } else if (modifiers.ctrl && modifiers.shift) {
    vertices = skewEdge(
      geometry.vertices,
      handle.index,
      localTarget,
      isClosed(shape),
    );
    forceExplicit = true;
  } else {
    vertices = scaleFromEdge(
      geometry.vertices,
      handle.index,
      localTarget,
      geometry.anchor,
      isClosed(shape),
      modifiers.alt,
    );
    forceExplicit = shape.kind !== 'line' &&
      !Array.isArray(geometry.path.vertices) &&
      axisQuad(vertices) &&
      !canonicalAxisQuad(vertices);
  }
  if (!vertices) return null;
  return commitResizedGeometry(shape, geometry, vertices, modifiers, forceExplicit);
}

// Reconcile authored cell centers with the outer cage so a dragged handle never jumps.
export function transformShapeFromCageHandle(
  shape: EditorShape | null,
  handleId: unknown,
  cageTarget: unknown,
  modifiers: ShapeTransformModifiers = {},
): EditorShape | null {
  if (!shape || !finitePoint(cageTarget)) return null;
  const initial = shapeTransformHandles(shape).find(({ id }) => id === handleId);
  if (!initial || (initial.type !== 'vertex' && initial.type !== 'edge')) {
    return transformShapeFromHandle(shape, handleId, cageTarget, modifiers);
  }
  let authoredTarget = {
    x: (initial.targetX ?? initial.x) + cageTarget.x - initial.x,
    y: (initial.targetY ?? initial.y) + cageTarget.y - initial.y,
  };
  let result: EditorShape | null = null;
  for (let iteration = 0; iteration < 8; iteration++) {
    result = transformShapeFromHandle(shape, handleId, authoredTarget, modifiers);
    if (!result) return null;
    if (modifiers.shift && initial.type === 'vertex') return result;
    const settled = shapeTransformHandles(result)
      .find(({ id }) => id === handleId);
    if (!settled) return result;
    const dx = cageTarget.x - settled.x;
    const dy = cageTarget.y - settled.y;
    if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) return result;
    authoredTarget = {
      x: authoredTarget.x + dx,
      y: authoredTarget.y + dy,
    };
  }
  return result;
}
