const SHAPE_KINDS = new Set(['line', 'rect', 'circle', 'polygon']);

export const SHAPE_PATH_COMPONENT_PATH = 'path';
export const SHAPE_PATH_COMPONENT_ANCHOR = 'anchor';
export const SHAPE_PATH_COMPONENT_ROTATION = 'rotation';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function cleanNumber(value) {
  return Object.is(value, -0) ? 0 : value;
}

function normalizePoint(value) {
  if (!value || typeof value !== 'object' || !finite(value.x) || !finite(value.y)) {
    return null;
  }
  return { x: cleanNumber(value.x), y: cleanNumber(value.y) };
}

function normalizeVertices(value, kind) {
  if (!Array.isArray(value)) return null;
  const expected = kind === 'line' ? 2 : (kind === 'polygon' ? null : 4);
  if ((expected != null && value.length !== expected) ||
    (expected == null && value.length < 3)) return null;
  const vertices = value.map(normalizePoint);
  return vertices.every(Boolean) ? vertices : null;
}

function withAdvancedGeometry(normalized, value) {
  if (Object.prototype.hasOwnProperty.call(value, 'vertices')) {
    const vertices = normalizeVertices(value.vertices, normalized.kind);
    if (!vertices) return null;
    normalized.vertices = vertices;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'anchor')) {
    const anchor = normalizePoint(value.anchor);
    if (!anchor) return null;
    normalized.anchor = anchor;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'rotation')) {
    if (!finite(value.rotation)) return null;
    normalized.rotation = cleanNumber(value.rotation);
  }
  return normalized;
}

// Half-cell precision is valid only for renderers that can represent subcells.
function geometryQuantum(shape) {
  const subcell = shape.detail === 'half' || shape.detail === 'quarter';
  return subcell && shape.style !== 'special' && shape.style !== 'slope' ? 0.5 : 1;
}

function snapGeometry(value, quantum) {
  return cleanNumber(Math.round(value / quantum) * quantum);
}

function interpolateNumber(from, to, progress) {
  // Preserve authored endpoints exactly instead of carrying easing residue into them.
  if (progress === 0) return cleanNumber(from);
  if (progress === 1) return cleanNumber(to);
  return cleanNumber(from * (1 - progress) + to * progress);
}

export function normalizeShapePathKey(value, expectedKind) {
  if (!value || typeof value !== 'object' || !SHAPE_KINDS.has(value.kind)) return null;
  if (expectedKind !== undefined && value.kind !== expectedKind) return null;
  if (value.kind === 'polygon') {
    const vertices = normalizeVertices(value.vertices, 'polygon');
    if (!vertices) return null;
    return withAdvancedGeometry({ kind: 'polygon', vertices }, {
      ...value,
      vertices,
    });
  }
  if (value.kind === 'line') {
    if (![value.x0, value.y0, value.x1, value.y1].every(finite)) return null;
    return withAdvancedGeometry({
      kind: 'line',
      x0: cleanNumber(value.x0),
      y0: cleanNumber(value.y0),
      x1: cleanNumber(value.x1),
      y1: cleanNumber(value.y1),
    }, value);
  }
  if (![value.cx, value.cy, value.w, value.h].every(finite)) return null;
  return withAdvancedGeometry({
    kind: value.kind,
    cx: cleanNumber(value.cx),
    cy: cleanNumber(value.cy),
    w: cleanNumber(Math.max(1, value.w)),
    h: cleanNumber(Math.max(1, value.h)),
  }, value);
}

export function editShapePathField(current, field, value, gestureStart = null) {
  const path = normalizeShapePathKey(current);
  if (!path || !finite(value)) return null;
  // Scrubs stay relative to their start instead of accumulating snapped live values.
  const baseline = normalizeShapePathKey(gestureStart, path.kind) || path;
  const fields = path.kind === 'line'
    ? ['x0', 'y0', 'x1', 'y1']
    : (path.kind === 'polygon' ? [] : ['cx', 'cy', 'w', 'h']);
  if (!fields.includes(field)) return null;
  // Keep explicit line vertices authoritative after a free-distort edit.
  if (path.kind === 'line' && baseline.vertices) {
    const vertices = shapePathVertices(baseline);
    const index = field.endsWith('0') ? 0 : 1;
    const axis = field.startsWith('x') ? 'x' : 'y';
    vertices[index] = { ...vertices[index], [axis]: value };
    return normalizeShapePathKey({
      ...baseline,
      x0: vertices[0].x,
      y0: vertices[0].y,
      x1: vertices[1].x,
      y1: vertices[1].y,
      vertices,
    }, 'line');
  }
  return normalizeShapePathKey({ ...baseline, [field]: value }, path.kind);
}

export function pathValueFromShape(shape) {
  if (!shape || typeof shape !== 'object' || !SHAPE_KINDS.has(shape.kind)) return null;
  if (shape.kind === 'polygon') return normalizeShapePathKey(shape, 'polygon');
  if (shape.kind === 'line') return normalizeShapePathKey(shape, 'line');
  if (![shape.x0, shape.y0, shape.x1, shape.y1].every(finite)) return null;
  const x0 = Math.min(shape.x0, shape.x1);
  const x1 = Math.max(shape.x0, shape.x1);
  const y0 = Math.min(shape.y0, shape.y1);
  const y1 = Math.max(shape.y0, shape.y1);
  return normalizeShapePathKey({
    kind: shape.kind,
    cx: cleanNumber((x0 + x1) / 2),
    cy: cleanNumber((y0 + y1) / 2),
    w: x1 - x0 + 1,
    h: y1 - y0 + 1,
    ...(Object.prototype.hasOwnProperty.call(shape, 'vertices')
      ? { vertices: shape.vertices }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(shape, 'anchor')
      ? { anchor: shape.anchor }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(shape, 'rotation')
      ? { rotation: shape.rotation }
      : {}),
  }, shape.kind);
}

export function shapeWithPathValue(shape, value) {
  if (!shape || typeof shape !== 'object') return shape;
  const path = normalizeShapePathKey(value, shape.kind);
  if (!path) return { ...shape };
  const quantum = geometryQuantum(shape);
  if (path.kind === 'polygon') {
    const xs = path.vertices.map(({ x }) => x);
    const ys = path.vertices.map(({ y }) => y);
    return {
      ...shape,
      sides: path.vertices.length,
      vertices: path.vertices.map((point) => ({ ...point })),
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs),
      y1: Math.max(...ys),
      ...(path.anchor ? { anchor: { ...path.anchor } } : {}),
      ...(Object.prototype.hasOwnProperty.call(path, 'rotation')
        ? { rotation: path.rotation }
        : {}),
    };
  }
  if (path.kind === 'line') {
    const vertices = path.vertices?.map((point) => ({ ...point }));
    const first = vertices?.[0];
    const second = vertices?.[1];
    const next = {
      ...shape,
      x0: snapGeometry(first?.x ?? path.x0, quantum),
      y0: snapGeometry(first?.y ?? path.y0, quantum),
      x1: snapGeometry(second?.x ?? path.x1, quantum),
      y1: snapGeometry(second?.y ?? path.y1, quantum),
      ...(vertices ? { vertices } : {}),
      ...(path.anchor ? { anchor: { ...path.anchor } } : {}),
      ...(Object.prototype.hasOwnProperty.call(path, 'rotation')
        ? { rotation: path.rotation }
        : {}),
    };
    if (!vertices) delete next.vertices;
    return next;
  }

  // Shape bounds are inclusive, so a five-cell width spans four coordinates.
  const width = Math.max(1, snapGeometry(path.w - 1, quantum) + 1);
  const height = Math.max(1, snapGeometry(path.h - 1, quantum) + 1);
  const x0 = snapGeometry(path.cx - (width - 1) / 2, quantum);
  const y0 = snapGeometry(path.cy - (height - 1) / 2, quantum);
  const next = {
    ...shape,
    x0,
    y0,
    x1: x0 + width - 1,
    y1: y0 + height - 1,
    ...(path.vertices
      ? { vertices: path.vertices.map((point) => ({ ...point })) }
      : {}),
    ...(path.anchor ? { anchor: { ...path.anchor } } : {}),
    ...(Object.prototype.hasOwnProperty.call(path, 'rotation')
      ? { rotation: path.rotation }
      : {}),
  };
  if (path.vertices) {
    next.x0 = Math.min(...path.vertices.map(({ x }) => x));
    next.y0 = Math.min(...path.vertices.map(({ y }) => y));
    next.x1 = Math.max(...path.vertices.map(({ x }) => x));
    next.y1 = Math.max(...path.vertices.map(({ y }) => y));
  } else {
    delete next.vertices;
  }
  return next;
}

export function interpolateShapePath(from, to, progress) {
  const left = normalizeShapePathKey(from);
  const right = normalizeShapePathKey(to);
  if (!left || !right || left.kind !== right.kind) return null;
  const t = Math.max(0, Math.min(1, finite(progress) ? progress : 0));
  let interpolated;
  if (left.kind === 'polygon') {
    if (left.vertices.length !== right.vertices.length) return null;
    interpolated = {
      kind: 'polygon',
      vertices: left.vertices.map((point, index) => ({
        x: interpolateNumber(point.x, right.vertices[index].x, t),
        y: interpolateNumber(point.y, right.vertices[index].y, t),
      })),
    };
  } else if (left.kind === 'line') {
    interpolated = {
      kind: 'line',
      x0: interpolateNumber(left.x0, right.x0, t),
      y0: interpolateNumber(left.y0, right.y0, t),
      x1: interpolateNumber(left.x1, right.x1, t),
      y1: interpolateNumber(left.y1, right.y1, t),
    };
  } else {
    interpolated = {
      kind: left.kind,
      cx: interpolateNumber(left.cx, right.cx, t),
      cy: interpolateNumber(left.cy, right.cy, t),
      w: interpolateNumber(left.w, right.w, t),
      h: interpolateNumber(left.h, right.h, t),
    };
  }
  if (left.kind !== 'polygon' && (left.vertices || right.vertices)) {
    const leftVertices = shapePathVertices(left);
    const rightVertices = shapePathVertices(right);
    if (leftVertices.length !== rightVertices.length) return null;
    interpolated.vertices = leftVertices.map((point, index) => ({
      x: interpolateNumber(point.x, rightVertices[index].x, t),
      y: interpolateNumber(point.y, rightVertices[index].y, t),
    }));
  }
  if (left.anchor || right.anchor) {
    const leftAnchor = shapePathDefaultAnchor(left);
    const rightAnchor = shapePathDefaultAnchor(right);
    interpolated.anchor = {
      x: interpolateNumber(leftAnchor.x, rightAnchor.x, t),
      y: interpolateNumber(leftAnchor.y, rightAnchor.y, t),
    };
  }
  if (Object.prototype.hasOwnProperty.call(left, 'rotation') ||
    Object.prototype.hasOwnProperty.call(right, 'rotation')) {
    interpolated.rotation = interpolateNumber(left.rotation || 0, right.rotation || 0, t);
  }
  return interpolated;
}

export function translateShapePathKey(value, dx, dy) {
  const path = normalizeShapePathKey(value);
  if (!path || !finite(dx) || !finite(dy)) return null;
  let translated;
  if (path.kind === 'polygon') {
    translated = {
      ...path,
      vertices: path.vertices.map((point) => ({
        x: cleanNumber(point.x + dx),
        y: cleanNumber(point.y + dy),
      })),
    };
  } else if (path.kind === 'line') {
    translated = {
      ...path,
      x0: cleanNumber(path.x0 + dx),
      y0: cleanNumber(path.y0 + dy),
      x1: cleanNumber(path.x1 + dx),
      y1: cleanNumber(path.y1 + dy),
    };
  } else {
    translated = {
      ...path,
      cx: cleanNumber(path.cx + dx),
      cy: cleanNumber(path.cy + dy),
    };
  }
  if (path.kind !== 'polygon' && path.vertices) {
    translated.vertices = path.vertices.map((point) => ({
      x: cleanNumber(point.x + dx),
      y: cleanNumber(point.y + dy),
    }));
  }
  if (path.anchor) {
    translated.anchor = {
      x: cleanNumber(path.anchor.x + dx),
      y: cleanNumber(path.anchor.y + dy),
    };
  }
  return translated;
}

export function cloneShapePathKey(value) {
  return normalizeShapePathKey(value);
}

export function shapePathVertices(value) {
  const path = normalizeShapePathKey(value);
  if (!path) return [];
  if (path.vertices) return path.vertices.map((point) => ({ ...point }));
  if (path.kind === 'line') {
    return [
      { x: path.x0, y: path.y0 },
      { x: path.x1, y: path.y1 },
    ];
  }
  const halfWidth = (path.w - 1) / 2;
  const halfHeight = (path.h - 1) / 2;
  return [
    { x: path.cx - halfWidth, y: path.cy - halfHeight },
    { x: path.cx + halfWidth, y: path.cy - halfHeight },
    { x: path.cx + halfWidth, y: path.cy + halfHeight },
    { x: path.cx - halfWidth, y: path.cy + halfHeight },
  ];
}

export function shapePathDefaultAnchor(value) {
  const path = normalizeShapePathKey(value);
  if (!path) return null;
  if (path.anchor) return { ...path.anchor };
  if (path.vertices) {
    const xs = path.vertices.map(({ x }) => x);
    const ys = path.vertices.map(({ y }) => y);
    return {
      x: cleanNumber((Math.min(...xs) + Math.max(...xs)) / 2),
      y: cleanNumber((Math.min(...ys) + Math.max(...ys)) / 2),
    };
  }
  if (path.kind === 'line') {
    return {
      x: cleanNumber((path.x0 + path.x1) / 2),
      y: cleanNumber((path.y0 + path.y1) / 2),
    };
  }
  return { x: path.cx, y: path.cy };
}

export function enumerateShapePathComponents(value) {
  const path = normalizeShapePathKey(value);
  if (!path) return [];
  return [
    ...shapePathVertices(path).map((_, index) => ({
      id: `vertex:${index}`,
      type: 'vertex',
      index,
      label: `Vertex ${index + 1}`,
    })),
    {
      id: SHAPE_PATH_COMPONENT_ANCHOR,
      type: 'anchor',
      label: 'Anchor point',
    },
    {
      id: SHAPE_PATH_COMPONENT_ROTATION,
      type: 'rotation',
      label: 'Rotation',
    },
  ];
}

export function normalizeShapePathComponentId(componentId, value) {
  const path = normalizeShapePathKey(value);
  if (!path) return null;
  if (componentId === SHAPE_PATH_COMPONENT_ANCHOR ||
    componentId === SHAPE_PATH_COMPONENT_ROTATION) return componentId;
  const match = /^vertex:(\d+)$/.exec(String(componentId));
  if (!match) return null;
  const index = Number(match[1]);
  return index < shapePathVertices(path).length ? `vertex:${index}` : null;
}

export function shapePathComponentValue(value, componentId) {
  const path = normalizeShapePathKey(value);
  const component = normalizeShapePathComponentId(componentId, path);
  if (!path || !component) return null;
  if (component === SHAPE_PATH_COMPONENT_ANCHOR) return shapePathDefaultAnchor(path);
  if (component === SHAPE_PATH_COMPONENT_ROTATION) return path.rotation || 0;
  const index = Number(component.slice('vertex:'.length));
  return { ...shapePathVertices(path)[index] };
}

export function normalizeShapePathComponentValue(componentId, value) {
  if (componentId === SHAPE_PATH_COMPONENT_ROTATION) {
    return finite(value) ? cleanNumber(value) : null;
  }
  return normalizePoint(value);
}

export function withShapePathComponentValue(value, componentId, componentValue) {
  const path = normalizeShapePathKey(value);
  const component = normalizeShapePathComponentId(componentId, path);
  const normalizedValue = component
    ? normalizeShapePathComponentValue(component, componentValue)
    : null;
  if (!path || !component || normalizedValue == null) return null;
  if (component === SHAPE_PATH_COMPONENT_ANCHOR) {
    return normalizeShapePathKey({ ...path, anchor: normalizedValue }, path.kind);
  }
  if (component === SHAPE_PATH_COMPONENT_ROTATION) {
    return normalizeShapePathKey({ ...path, rotation: normalizedValue }, path.kind);
  }
  const vertices = shapePathVertices(path);
  vertices[Number(component.slice('vertex:'.length))] = normalizedValue;
  return normalizeShapePathKey({ ...path, vertices }, path.kind);
}

export function interpolateShapePathComponent(componentId, from, to, progress) {
  const left = normalizeShapePathComponentValue(componentId, from);
  const right = normalizeShapePathComponentValue(componentId, to);
  if (left == null || right == null) return null;
  const t = Math.max(0, Math.min(1, finite(progress) ? progress : 0));
  if (componentId === SHAPE_PATH_COMPONENT_ROTATION) {
    return interpolateNumber(left, right, t);
  }
  return {
    x: interpolateNumber(left.x, right.x, t),
    y: interpolateNumber(left.y, right.y, t),
  };
}

export function shapePathComponentEqual(componentId, first, second) {
  const left = normalizeShapePathComponentValue(componentId, first);
  const right = normalizeShapePathComponentValue(componentId, second);
  if (left == null || right == null) return left === right;
  return componentId === SHAPE_PATH_COMPONENT_ROTATION
    ? left === right
    : left.x === right.x && left.y === right.y;
}

export function shapePathEqual(a, b) {
  if (a == null || b == null) return a == null && b == null;
  const left = normalizeShapePathKey(a);
  const right = normalizeShapePathKey(b);
  if (!left || !right || left.kind !== right.kind) return false;
  const geometryEqual = left.kind === 'polygon'
    ? true
    : (left.kind === 'line'
      ? left.x0 === right.x0 && left.y0 === right.y0 &&
        left.x1 === right.x1 && left.y1 === right.y1
      : left.cx === right.cx && left.cy === right.cy &&
        left.w === right.w && left.h === right.h);
  if (!geometryEqual) return false;
  if (!!left.vertices !== !!right.vertices) return false;
  if (left.vertices && (
    left.vertices.length !== right.vertices.length ||
    left.vertices.some((point, index) =>
      point.x !== right.vertices[index].x || point.y !== right.vertices[index].y)
  )) return false;
  if (!!left.anchor !== !!right.anchor) return false;
  if (left.anchor && (
    left.anchor.x !== right.anchor.x || left.anchor.y !== right.anchor.y
  )) return false;
  return Object.prototype.hasOwnProperty.call(left, 'rotation') ===
    Object.prototype.hasOwnProperty.call(right, 'rotation') &&
    (!Object.prototype.hasOwnProperty.call(left, 'rotation') ||
      left.rotation === right.rotation);
}
