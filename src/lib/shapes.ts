
import { quadrantBit, glyphForMask } from './subcell.js';
import type {
  EditorBoxStyle,
  EditorCellMap,
  EditorPoint,
  EditorShape,
  EditorShapeAppearance,
  EditorShapeDetail,
  EditorShapeStyle,
  EditorStrokeAlign,
} from './types/editor-domain.js';

interface BoxGlyphSet {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
  t: string;
  r: string;
  b: string;
  l: string;
  cross: string;
}

interface ShapeGlyph extends EditorPoint {
  ch: string | undefined;
}

interface ShapeGeometry {
  points: EditorPoint[];
  closed: boolean;
}

const TL = 1, TR = 2, BL = 4, BR = 8;
const NORTH = 1, EAST = 2, SOUTH = 4, WEST = 8;
const CELL_HEIGHT_IN_COLUMNS = 2;
export const BOX_STYLES: Record<EditorBoxStyle, BoxGlyphSet> = {
  single:  { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', t: '┬', r: '┤', b: '┴', l: '├', cross: '┼' },
  rounded: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', t: '┬', r: '┤', b: '┴', l: '├', cross: '┼' },
  double:  { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║', t: '╦', r: '╣', b: '╩', l: '╠', cross: '╬' },
  heavy:   { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃', t: '┳', r: '┫', b: '┻', l: '┣', cross: '╋' },
};

export const BOX_STYLE_OPTIONS = [
  { value: 'single', swatch: '───', label: 'Single' },
  { value: 'rounded', swatch: '╭──', label: 'Rounded' },
  { value: 'double', swatch: '═══', label: 'Double' },
  { value: 'heavy', swatch: '━━━', label: 'Heavy' },
];

export const SLOPE_GLYPHS = {
  rising: ['', ''],
  falling: ['', ''],
  straight: '█',
};

export function lineStyleValue(shape: EditorShapeAppearance = {}): string {
  if (shape.style === 'slope') return 'slope';
  if (shape.style === 'special') {
    const boxStyle = shape.boxStyle === 'rounded' ? 'single' : (shape.boxStyle || 'single');
    return `special:${boxStyle}`;
  }
  return shape.detail === 'half' || shape.detail === 'quarter' ? shape.detail : 'cell';
}

export function lineStylePatch(value: string): EditorShapeAppearance {
  if (value === 'slope') return { style: 'slope' };
  if (value.startsWith('special:')) {
    return { style: 'special', boxStyle: value.slice('special:'.length) || 'single' };
  }
  return { style: 'outline', detail: value === 'half' || value === 'quarter' ? value : 'cell' };
}

export function isSlopeLine(shape: EditorShapeAppearance | null | undefined): boolean {
  return shape?.kind === 'line' && shape.style === 'slope';
}

const SPECIAL_SHAPE_STYLES = new Set<EditorShapeStyle>(['special', 'slope']);
const SHAPE_DETAILS = new Set<EditorShapeDetail>(['cell', 'half', 'quarter']);
const STROKE_ALIGNS = new Set<EditorStrokeAlign>(['center', 'inside', 'outside']);
const GEOMETRY_EPSILON = 1e-9;
const MASK_SHAPE_DEFAULTS = {
  style: 'outline' as const,
  thickness: 1,
  strokeAlign: 'center' as const,
};

function backgroundShapeStyle(style: EditorShapeStyle | undefined): 'filled' | 'outline' {
  return style === 'filled' ? 'filled' : 'outline';
}

export function updateShapeAppearance(
  current: EditorShapeAppearance = {},
  patch: EditorShapeAppearance = {},
): EditorShapeAppearance {
  const currentChannel = current.channel || 'glyph';
  const currentStyle = current.style || 'outline';
  let glyphStyle = current.glyphStyle ||
    (currentChannel === 'glyph' ? currentStyle : 'outline');
  let glyphDetail = current.glyphDetail || current.detail || 'cell';
  let glyphBoxStyle = current.glyphBoxStyle || current.boxStyle || 'single';
  let glyphWide = current.glyphWide ?? !!current.wide;
  let backgroundStyle = current.backgroundStyle || backgroundShapeStyle(currentStyle);
  const channel = patch.channel || currentChannel;

  if (Object.hasOwn(patch, 'style')) {
    if (channel !== 'glyph') backgroundStyle = backgroundShapeStyle(patch.style);
    else glyphStyle = patch.style || 'outline';
  }
  if (channel === 'glyph' && Object.hasOwn(patch, 'detail')) {
    glyphDetail = patch.detail || 'cell';
  }
  if (channel === 'glyph' && Object.hasOwn(patch, 'boxStyle')) {
    glyphBoxStyle = patch.boxStyle || 'single';
  }
  if (channel === 'glyph' && Object.hasOwn(patch, 'wide')) {
    glyphWide = !!patch.wide;
  }

  const next = {
    ...current,
    ...patch,
    channel,
    glyphStyle,
    glyphDetail,
    glyphBoxStyle,
    glyphWide,
    backgroundStyle,
    boxStyle: glyphBoxStyle,
  };
  if (channel !== 'glyph') {
    next.style = backgroundStyle;
    next.detail = 'cell';
    next.wide = false;
  } else {
    next.style = glyphStyle;
    next.detail = SPECIAL_SHAPE_STYLES.has(glyphStyle) ? 'cell' : glyphDetail;
    next.wide = !SPECIAL_SHAPE_STYLES.has(glyphStyle) &&
      glyphDetail === 'cell' && glyphWide;
  }
  return next;
}

// Mask-only shape choices must not overwrite the user's normal glyph preset.
export function maskShapeAppearance(current: EditorShapeAppearance = {}): EditorShapeAppearance {
  return {
    ...current,
    channel: 'background',
    style: current.maskStyle === 'filled' ? 'filled' : MASK_SHAPE_DEFAULTS.style,
    detail: 'cell',
    thickness: Math.max(1, Math.min(64,
      Math.round(Number(current.maskThickness) || MASK_SHAPE_DEFAULTS.thickness))),
    strokeAlign: STROKE_ALIGNS.has(current.maskStrokeAlign as EditorStrokeAlign)
      ? current.maskStrokeAlign
      : MASK_SHAPE_DEFAULTS.strokeAlign,
  };
}

export function updateMaskShapeAppearance(
  current: EditorShapeAppearance = {},
  patch: EditorShapeAppearance = {},
): EditorShapeAppearance {
  const next = { ...current };
  if (Object.hasOwn(patch, 'style')) {
    next.maskStyle = patch.style === 'filled' ? 'filled' : 'outline';
  }
  if (Object.hasOwn(patch, 'thickness')) {
    next.maskThickness = Math.max(1, Math.min(64,
      Math.round(Number(patch.thickness) || MASK_SHAPE_DEFAULTS.thickness)));
  }
  if (Object.hasOwn(patch, 'strokeAlign')) {
    next.maskStrokeAlign = STROKE_ALIGNS.has(patch.strokeAlign as EditorStrokeAlign)
      ? patch.strokeAlign
      : MASK_SHAPE_DEFAULTS.strokeAlign;
  }
  return next;
}

function specialGlyphForConnections(connections: number, style: string | undefined = 'single'): string {
  const set = BOX_STYLES[style as EditorBoxStyle] || BOX_STYLES.single;
  switch (connections) {
    case NORTH: case SOUTH: case NORTH | SOUTH: return set.v;
    case EAST: case WEST: case EAST | WEST: return set.h;
    case EAST | SOUTH: return set.tl;
    case WEST | SOUTH: return set.tr;
    case EAST | NORTH: return set.bl;
    case WEST | NORTH: return set.br;
    case EAST | WEST | SOUTH: return set.t;
    case NORTH | SOUTH | WEST: return set.r;
    case EAST | WEST | NORTH: return set.b;
    case NORTH | EAST | SOUTH: return set.l;
    case NORTH | EAST | SOUTH | WEST: return set.cross;
    default: return set.h;
  }
}

export function specialGlyphConnections(ch: string | null | undefined, style: string = 'single'): number {
  const set = BOX_STYLES[style as EditorBoxStyle] || BOX_STYLES.single;
  if (ch === set.h) return EAST | WEST;
  if (ch === set.v) return NORTH | SOUTH;
  if (ch === set.tl) return EAST | SOUTH;
  if (ch === set.tr) return WEST | SOUTH;
  if (ch === set.bl) return EAST | NORTH;
  if (ch === set.br) return WEST | NORTH;
  if (ch === set.t) return EAST | WEST | SOUTH;
  if (ch === set.r) return NORTH | SOUTH | WEST;
  if (ch === set.b) return EAST | WEST | NORTH;
  if (ch === set.l) return NORTH | EAST | SOUTH;
  if (ch === set.cross) return NORTH | EAST | SOUTH | WEST;
  return 0;
}

export function specialGlyph(connections: number, style: string = 'single'): string {
  return specialGlyphForConnections(connections, style);
}

export function hasShapeExtent(s: EditorShape): boolean {
  const hasSuppliedVertices = Array.isArray(s.vertices) && s.vertices.some(finitePoint);
  if (s.kind !== 'polygon' && !hasSuppliedVertices && !normalizedRotation(s.rotation)) {
    return Math.round(s.x0) !== Math.round(s.x1) || Math.round(s.y0) !== Math.round(s.y1);
  }
  const vertices = resolvedShapeVertices(s);
  if (vertices.length < 2) return false;
  const first = vertices[0]!;
  return vertices.some((point) =>
    Math.round(point.x * 2) !== Math.round(first.x * 2) ||
    Math.round(point.y * 2) !== Math.round(first.y * 2));
}

function finitePoint(point: unknown): point is EditorPoint {
  return !!point && typeof point === 'object' &&
    Number.isFinite((point as EditorPoint).x) && Number.isFinite((point as EditorPoint).y);
}

function rawBoxVertices(s: EditorShape): EditorPoint[] {
  if (![s.x0, s.y0, s.x1, s.y1].every(Number.isFinite)) return [];
  return [
    { x: s.x0, y: s.y0 },
    { x: s.x1, y: s.y0 },
    { x: s.x1, y: s.y1 },
    { x: s.x0, y: s.y1 },
  ];
}

export function regularPolygonVertices(x0: number, y0: number, x1: number, y1: number, sides = 3): EditorPoint[] {
  if (![x0, y0, x1, y1].every(Number.isFinite)) return [];
  const count = Math.max(3, Math.min(64, Math.round(Number(sides) || 3)));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = Math.abs(x1 - x0) / 2;
  const ry = Math.abs(y1 - y0) / 2;
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / count;
    return {
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle),
    };
  });
}

function authoringVertices(s: EditorShape): EditorPoint[] {
  const supplied = Array.isArray(s.vertices) ? s.vertices.filter(finitePoint) : [];
  if (s.kind === 'polygon') {
    return supplied.length
      ? supplied
      : regularPolygonVertices(s.x0, s.y0, s.x1, s.y1, s.sides);
  }
  if (s.kind === 'line') {
    if (supplied.length >= 2) return supplied.slice(0, 2);
    return [s.x0, s.y0, s.x1, s.y1].every(Number.isFinite)
      ? [{ x: s.x0, y: s.y0 }, { x: s.x1, y: s.y1 }]
      : [];
  }
  if ((s.kind === 'rect' || s.kind === 'circle') && supplied.length >= 4) {
    return supplied.slice(0, 4);
  }
  if (s.kind === 'rect' || s.kind === 'circle') return rawBoxVertices(s);
  return [];
}

function boundsForPoints(points: EditorPoint[]) {
  if (!points.length) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys);
  return {
    x0,
    y0,
    x1,
    y1,
    width: x1 - x0,
    height: y1 - y0,
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
  };
}

export function resolvedShapeAnchor(s: EditorShape, vertices = authoringVertices(s)): EditorPoint {
  if (finitePoint(s?.anchor)) return { x: s.anchor.x, y: s.anchor.y };
  const bounds = boundsForPoints(vertices);
  return bounds ? { x: bounds.cx, y: bounds.cy } : { x: 0, y: 0 };
}

function normalizedRotation(rotation: number | undefined): number {
  if (typeof rotation !== 'number' || !Number.isFinite(rotation)) return 0;
  const normalized = ((rotation % 360) + 360) % 360;
  return Math.abs(normalized) < GEOMETRY_EPSILON ||
    Math.abs(normalized - 360) < GEOMETRY_EPSILON ? 0 : normalized;
}

export function shapeRotationAspect(shape: EditorShape | null | undefined): number {
  const aspect = Number(shape?.rotationAspect);
  return Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
}

export function rotateShapePoint(point: EditorPoint, anchor: EditorPoint, degrees: number, aspect = 1): EditorPoint {
  if (!degrees) return { ...point };
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = (point.x - anchor.x) * safeAspect;
  const dy = point.y - anchor.y;
  return {
    x: anchor.x + (dx * cos - dy * sin) / safeAspect,
    y: anchor.y + dx * sin + dy * cos,
  };
}

export function resolvedShapeVertices(s: EditorShape): EditorPoint[] {
  const vertices = authoringVertices(s);
  const rotation = normalizedRotation(s.rotation);
  if (!rotation || !vertices.length) return vertices.map((point) => ({ ...point }));
  const anchor = resolvedShapeAnchor(s, vertices);
  const aspect = shapeRotationAspect(s);
  return vertices.map((point) => rotateShapePoint(point, anchor, rotation, aspect));
}

export function normalizeShapeThickness(value: unknown): number {
  const thickness = Number(value);
  if (!Number.isFinite(thickness)) return 1;
  return Math.max(1, Math.round(thickness * 2) / 2);
}

export function normalizeStrokeAlign(value: unknown): EditorStrokeAlign {
  return STROKE_ALIGNS.has(value as EditorStrokeAlign) ? value as EditorStrokeAlign : 'center';
}

function shapePoints(s: EditorShape): EditorPoint[] {
  const x0 = Math.round(s.x0), y0 = Math.round(s.y0), x1 = Math.round(s.x1), y1 = Math.round(s.y1);
  if (s.kind === 'line') return linePoints(x0, y0, x1, y1);
  if (s.kind === 'rect') return rectPoints(x0, y0, x1, y1, s.style === 'filled');
  if (s.kind === 'circle') return ellipsePoints(x0, y0, x1, y1, s.style === 'filled');
  return [];
}

export function constrainShape(s: EditorShape): EditorShape {
  if (s.kind !== 'line' || (s.style !== 'special' && s.style !== 'slope')) return s;
  const x0 = Math.round(s.x0), y0 = Math.round(s.y0);
  const rawX = Math.round(s.x1), rawY = Math.round(s.y1);
  const dx = rawX - x0, dy = rawY - y0;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  const visualX = ax, visualY = ay * CELL_HEIGHT_IN_COLUMNS;
  if (s.style === 'special') {
    return visualX >= visualY
      ? { ...s, x0, y0, x1: rawX, y1: y0 }
      : { ...s, x0, y0, x1: x0, y1: rawY };
  }
  if (!ax && !ay) return { ...s, x0, y0, x1: x0, y1: y0 };

  const authoredStart = { x: x0, y: y0 };
  const authoredEnd = { x: rawX, y: rawY };
  const canonicalOrder = (axis: keyof EditorPoint) => {
    const other = axis === 'x' ? 'y' : 'x';
    const reversed = authoredStart[axis] > authoredEnd[axis] ||
      (authoredStart[axis] === authoredEnd[axis] &&
        authoredStart[other] > authoredEnd[other]);
    return {
      first: reversed ? authoredEnd : authoredStart,
      second: reversed ? authoredStart : authoredEnd,
      reversed,
    };
  };
  const restoreOrder = (first: EditorPoint, second: EditorPoint, reversed: boolean): EditorShape => {
    const start = reversed ? second : first;
    const end = reversed ? first : second;
    return { ...s, x0: start.x, y0: start.y, x1: end.x, y1: end.y };
  };

  if (visualY * 2 < visualX) {
    const { first, second, reversed } = canonicalOrder('x');
    return restoreOrder(first, { x: second.x, y: first.y }, reversed);
  }
  if (visualX * 2 < visualY) {
    const { first, second, reversed } = canonicalOrder('y');
    return restoreOrder(first, { x: first.x, y: second.y }, reversed);
  }
  const rows = Math.max(1, Math.round((visualX + visualY) / (CELL_HEIGHT_IN_COLUMNS * 2)));
  // Each row owns a two-triangle pair, so an n-row diagonal spans n + 1 columns.
  const columns = rows + 1;
  const { first, second, reversed } = canonicalOrder('x');
  const maxX = first.x + columns;
  const minY = Math.min(first.y, second.y);
  const maxY = minY + rows;
  const descending = first.y > second.y;
  return restoreOrder(
    { x: first.x, y: descending ? maxY : minY },
    { x: maxX, y: descending ? minY : maxY },
    reversed,
  );
}

function samePoint(a: EditorPoint, b: EditorPoint): boolean {
  return Math.abs(a.x - b.x) < GEOMETRY_EPSILON &&
    Math.abs(a.y - b.y) < GEOMETRY_EPSILON;
}

function samePoints(a: EditorPoint[], b: EditorPoint[]): boolean {
  return a.length === b.length && a.every((point, index) => samePoint(point, b[index]!));
}

function hasCustomVertices(s: EditorShape): boolean {
  if (!Array.isArray(s.vertices)) return false;
  const supplied = s.vertices.filter(finitePoint);
  if (s.kind === 'polygon') return supplied.length > 0;
  if (s.kind === 'line' && supplied.length >= 2) {
    const legacy = [s.x0, s.y0, s.x1, s.y1].every(Number.isFinite)
      ? [{ x: s.x0, y: s.y0 }, { x: s.x1, y: s.y1 }]
      : [];
    return !samePoints(supplied.slice(0, 2), legacy);
  }
  if ((s.kind === 'rect' || s.kind === 'circle') && supplied.length >= 4) {
    return !samePoints(supplied.slice(0, 4), rawBoxVertices(s));
  }
  return false;
}

function hasGeometryTransform(s: EditorShape): boolean {
  return normalizedRotation(s.rotation) !== 0 || hasCustomVertices(s);
}

function effectiveShapeForRaster(s: EditorShape): EditorShape {
  if (s.kind === 'polygon') {
    return {
      ...s,
      style: s.style === 'filled' ? 'filled' : 'outline',
      detail: SHAPE_DETAILS.has(s.detail as EditorShapeDetail) ? s.detail : 'cell',
    };
  }
  if (s.kind !== 'line' && s.style === 'slope') {
    return { ...s, style: 'outline' };
  }
  return s;
}

function bilinearPoint(
  [tl, tr, br, bl]: [EditorPoint, EditorPoint, EditorPoint, EditorPoint],
  u: number,
  v: number,
): EditorPoint {
  const topWeight = 1 - v;
  const leftWeight = 1 - u;
  return {
    x: tl.x * leftWeight * topWeight +
      tr.x * u * topWeight +
      br.x * u * v +
      bl.x * leftWeight * v,
    y: tl.y * leftWeight * topWeight +
      tr.y * u * topWeight +
      br.y * u * v +
      bl.y * leftWeight * v,
  };
}

function pointDistance(a: EditorPoint, b: EditorPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function ellipseBoundaryThroughQuad(quad: EditorPoint[]): EditorPoint[] {
  if (quad.length < 4) return quad;
  const span = Math.max(
    pointDistance(quad[0]!, quad[1]!),
    pointDistance(quad[1]!, quad[2]!),
    pointDistance(quad[2]!, quad[3]!),
    pointDistance(quad[3]!, quad[0]!),
  );
  const steps = Math.max(32, Math.min(2048, Math.ceil(span * 16)));
  return Array.from({ length: steps }, (_, index) => {
    const angle = index * 2 * Math.PI / steps;
    return bilinearPoint(
      quad as [EditorPoint, EditorPoint, EditorPoint, EditorPoint],
      0.5 + 0.5 * Math.cos(angle),
      0.5 + 0.5 * Math.sin(angle),
    );
  });
}

function cleanGeometryPoints(points: EditorPoint[]): EditorPoint[] {
  const clean: EditorPoint[] = [];
  for (const point of points) {
    if (!finitePoint(point)) continue;
    if (!clean.length || !samePoint(point, clean[clean.length - 1]!)) clean.push(point);
  }
  if (clean.length > 1 && samePoint(clean[0]!, clean[clean.length - 1]!)) clean.pop();
  return clean;
}

function shapeBoundaryGeometry(s: EditorShape): ShapeGeometry {
  const vertices = resolvedShapeVertices(s);
  if (s.kind === 'circle') {
    return { points: cleanGeometryPoints(ellipseBoundaryThroughQuad(vertices)), closed: true };
  }
  if (s.kind === 'rect') return { points: cleanGeometryPoints(vertices), closed: true };
  if (s.kind === 'polygon') {
    const points = cleanGeometryPoints(vertices);
    return { points, closed: points.length >= 3 };
  }
  if (s.kind === 'line') return { points: cleanGeometryPoints(vertices), closed: false };
  return { points: [], closed: false };
}

function distanceToSegment(point: EditorPoint, from: EditorPoint, to: EditorPoint): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < GEOMETRY_EPSILON) return pointDistance(point, from);
  const projection = Math.max(0, Math.min(1,
    ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared));
  return Math.hypot(
    point.x - (from.x + projection * dx),
    point.y - (from.y + projection * dy),
  );
}

// Bucket segments by stroke reach so each subpixel checks only nearby geometry.
function geometryDistanceLookup(geometry: ShapeGeometry, limit: number): (point: EditorPoint) => number {
  const segmentCount = geometry.points.length - 1 + (geometry.closed ? 1 : 0);
  if (segmentCount < 1) {
    const only = geometry.points[0];
    return (point) => only ? pointDistance(point, only) : Infinity;
  }
  const segments = Array.from({ length: segmentCount }, (_, index) => ({
    from: geometry.points[index]!,
    to: geometry.points[(index + 1) % geometry.points.length]!,
  }));
  const radius = Math.max(0.5, limit) + GEOMETRY_EPSILON;
  const bucketSize = Math.max(2, radius);
  const buckets = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    const minX = Math.floor((Math.min(segment.from.x, segment.to.x) - radius) / bucketSize);
    const maxX = Math.floor((Math.max(segment.from.x, segment.to.x) + radius) / bucketSize);
    const minY = Math.floor((Math.min(segment.from.y, segment.to.y) - radius) / bucketSize);
    const maxY = Math.floor((Math.max(segment.from.y, segment.to.y) + radius) / bucketSize);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const key = `${x},${y}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(index);
        else buckets.set(key, [index]);
      }
    }
  });
  return (point) => {
    const key = `${Math.floor(point.x / bucketSize)},${Math.floor(point.y / bucketSize)}`;
    const candidates = buckets.get(key) || [];
    let distance = Infinity;
    for (const index of candidates) {
      distance = Math.min(distance, distanceToSegment(
        point,
        segments[index]!.from,
        segments[index]!.to,
      ));
    }
    return distance;
  };
}

function scanlineIntersections(points: EditorPoint[], y: number): number[] {
  const intersections: number[] = [];
  for (let current = 0, previous = points.length - 1;
    current < points.length;
    previous = current++) {
    const a = points[current]!;
    const b = points[previous]!;
    if ((a.y > y) === (b.y > y)) continue;
    intersections.push((b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x);
  }
  return intersections.sort((first, second) => first - second);
}

function insideScanline(x: number, intersections: number[]): boolean {
  let lower = 0;
  let upper = intersections.length;
  while (lower < upper) {
    const middle = (lower + upper) >> 1;
    if (intersections[middle]! <= x) lower = middle + 1;
    else upper = middle;
  }
  return (intersections.length - lower) % 2 === 1;
}

function strokeContains(
  point: EditorPoint,
  geometry: ShapeGeometry,
  thickness: number,
  align: EditorStrokeAlign,
  lineSideAlignment: boolean,
  distance: number,
  inside: boolean,
): boolean {
  if (align === 'center' || geometry.points.length < 2) {
    return distance <= thickness / 2 + GEOMETRY_EPSILON;
  }
  if (geometry.closed) {
    if (align === 'inside') {
      return (inside || distance < GEOMETRY_EPSILON) &&
        distance <= thickness + GEOMETRY_EPSILON;
    }
    return (!inside || distance < GEOMETRY_EPSILON) &&
      distance <= thickness + GEOMETRY_EPSILON;
  }
  if (!lineSideAlignment) return distance <= thickness / 2 + GEOMETRY_EPSILON;
  const from = geometry.points[0]!;
  const to = geometry.points[geometry.points.length - 1]!;
  const side = (to.x - from.x) * (point.y - from.y) -
    (to.y - from.y) * (point.x - from.x);
  const allowedSide = align === 'inside'
    ? side >= -GEOMETRY_EPSILON
    : side <= GEOMETRY_EPSILON;
  return allowedSide && distance <= thickness + GEOMETRY_EPSILON;
}

// Rasterize on a 2× lattice, then pack samples into cell, half, or quarter glyphs.
function geometrySubpixels(s: EditorShape, geometry: ShapeGeometry): Array<{ subX: number; subY: number }> {
  const requestedFill = s.style === 'filled';
  const filled = requestedFill && geometry.closed;
  const thickness = requestedFill ? 1 : normalizeShapeThickness(s.thickness);
  const align = requestedFill ? 'center' : normalizeStrokeAlign(s.strokeAlign);
  const bounds = boundsForPoints(geometry.points);
  if (!bounds) return [];
  const pad = filled ? 1 : (align === 'center' ? thickness / 2 + 0.5 : thickness + 0.5);
  const distanceLimit = filled
    ? 0.5
    : (align === 'center' ? thickness / 2 : thickness);
  const distanceAt = geometryDistanceLookup(geometry, distanceLimit);
  const minX = Math.floor((bounds.x0 - pad) * 2) - 2;
  const maxX = Math.ceil((bounds.x1 + pad) * 2) + 2;
  const minY = Math.floor((bounds.y0 - pad) * 2) - 2;
  const maxY = Math.ceil((bounds.y1 + pad) * 2) + 2;
  const selected: Array<{ subX: number; subY: number }> = [];
  for (let subY = minY; subY <= maxY; subY++) {
    const y = subY / 2 - 0.25;
    const intersections = geometry.closed
      ? scanlineIntersections(geometry.points, y)
      : [];
    for (let subX = minX; subX <= maxX; subX++) {
      const point = { x: subX / 2 - 0.25, y };
      const distance = distanceAt(point);
      const inside = geometry.closed && insideScanline(point.x, intersections);
      const included = filled
        ? inside ||
          distance <= 0.5 + GEOMETRY_EPSILON
        : strokeContains(
          point,
          geometry,
          thickness,
          align,
          s.kind === 'line',
          distance,
          inside,
        );
      if (included) selected.push({ subX, subY });
    }
  }
  return selected;
}

function positiveParity(value: number): number {
  return ((value % 2) + 2) % 2;
}

function glyphsFromSubpixels(
  subpixels: Array<{ subX: number; subY: number }>,
  detail: EditorShapeDetail,
  ch: string | undefined,
): ShapeGlyph[] {
  if (detail === 'cell') {
    const cells = new Map<string, ShapeGlyph>();
    for (const { subX, subY } of subpixels) {
      const x = Math.floor(subX / 2);
      const y = Math.floor(subY / 2);
      cells.set(`${x},${y}`, { x, y, ch });
    }
    return [...cells.values()];
  }
  const masks = new Map<string, number>();
  for (const { subX, subY } of subpixels) {
    const x = Math.floor(subX / 2);
    const y = Math.floor(subY / 2);
    const top = positiveParity(subY) === 0;
    const left = positiveParity(subX) === 0;
    const bit = detail === 'half'
      ? (top ? (TL | TR) : (BL | BR))
      : quadrantBit(top, left);
    const key = `${x},${y}`;
    masks.set(key, (masks.get(key) || 0) | bit);
  }
  return [...masks].flatMap(([key, mask]) => {
    const glyph = glyphForMask(mask);
    if (!glyph) return [];
    const [x, y] = key.split(',').map(Number);
    return [{ x: x!, y: y!, ch: glyph }];
  });
}

function geometryGlyphs(s: EditorShape): ShapeGlyph[] {
  const geometry = shapeBoundaryGeometry(s);
  return glyphsFromSubpixels(
    geometrySubpixels(s, geometry),
    SHAPE_DETAILS.has(s.detail as EditorShapeDetail) ? s.detail as EditorShapeDetail : 'cell',
    s.char,
  );
}

function connectedCellLinePoints(x0: number, y0: number, x1: number, y1: number): EditorPoint[] {
  if (![x0, y0, x1, y1].every(Number.isFinite)) return [];
  let from = { x: Math.round(x0), y: Math.round(y0) };
  let to = { x: Math.round(x1), y: Math.round(y1) };
  // Canonical ordering makes the staircase tie-break independent of drag direction.
  if (from.x > to.x || (from.x === to.x && from.y > to.y)) {
    [from, to] = [to, from];
  }
  return orthogonalLinePoints(from.x, from.y, to.x, to.y);
}

function closeCellPathNotches(points: EditorPoint[], polygon: EditorPoint[]): EditorPoint[] {
  const cells = new Map<string, EditorPoint>(points.map((point) => [`${point.x},${point.y}`, point]));
  const candidates = new Set<string>();
  for (const { x, y } of points) {
    for (const key of [`${x - 1},${y}`, `${x + 1},${y}`, `${x},${y - 1}`, `${x},${y + 1}`]) {
      if (!cells.has(key)) candidates.add(key);
    }
  }
  for (const key of candidates) {
    const [x, y] = key.split(',').map(Number) as [number, number];
    const neighbors = [
      `${x - 1},${y}`, `${x + 1},${y}`, `${x},${y - 1}`, `${x},${y + 1}`,
    ];
    const inside = insideScanline(x, scanlineIntersections(polygon, y));
    // Closed edge joins can leave an interior one-cell notch at acute raster corners.
    if (inside && neighbors.filter((neighbor) => cells.has(neighbor)).length === 3) {
      cells.set(key, { x, y });
    }
  }
  return [...cells.values()];
}

function connectedCellPolygonPoints(s: EditorShape): EditorPoint[] {
  const vertices = resolvedShapeVertices(s)
    .map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) }));
  if (vertices.length < 2) return vertices;
  const cells = new Map<string, EditorPoint>();
  for (let index = 0; index < vertices.length; index++) {
    const from = vertices[index]!;
    const to = vertices[(index + 1) % vertices.length]!;
    for (const point of connectedCellLinePoints(from.x, from.y, to.x, to.y)) {
      cells.set(`${point.x},${point.y}`, point);
    }
  }
  return closeCellPathNotches([...cells.values()], vertices);
}

function usesConnectedCellStroke(s: EditorShape): boolean {
  return (s.kind === 'line' || s.kind === 'polygon') &&
    s.style === 'outline' && (s.detail || 'cell') === 'cell' &&
    normalizeShapeThickness(s.thickness) === 1 &&
    normalizeStrokeAlign(s.strokeAlign) === 'center';
}

function transformedSpecialGlyphs(s: EditorShape): Array<ShapeGlyph & { connections: number }> {
  const geometry = shapeBoundaryGeometry(s);
  if (!geometry.points.length) return [];
  return connectedSpecialGlyphs(
    geometry.points.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })),
    s.boxStyle,
    geometry.closed,
  );
}

function needsGeometryRaster(s: EditorShape): boolean {
  if (s.kind === 'polygon') return true;
  if (SPECIAL_SHAPE_STYLES.has(s.style)) return false;
  if (hasGeometryTransform(s)) return true;
  if (s.style === 'filled') return false;
  return normalizeShapeThickness(s.thickness) !== 1 ||
    normalizeStrokeAlign(s.strokeAlign) !== 'center';
}

function wideGlyphs(glyphs: ShapeGlyph[]): ShapeGlyph[] {
  const occupied = new Set();
  const out: ShapeGlyph[] = [];
  for (const point of glyphs.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const key = `${point.x},${point.y}`;
    if (occupied.has(key)) continue;
    out.push(point);
    occupied.add(key);
    occupied.add(`${point.x + 1},${point.y}`);
  }
  return out;
}

export function shapeGlyphs(s: EditorShape): ShapeGlyph[] {
  s = constrainShape(s);
  if (!hasShapeExtent(s)) return [];
  s = effectiveShapeForRaster(s);
  const detail = s.detail || 'cell';
  if (s.style === 'special' && detail === 'cell') {
    if ((s.kind === 'rect' || s.kind === 'circle') && hasGeometryTransform(s)) {
      return transformedSpecialGlyphs(s);
    }
    if (s.kind === 'rect') return specialBoxGlyphs(s);
    if (s.kind === 'circle') return specialCircleGlyphs(s);
    if (s.kind === 'line') return specialLineGlyphs(s);
  }
  if (s.kind === 'line' && s.style === 'slope' && detail === 'cell') return slopeLineGlyphs(s);
  if (usesConnectedCellStroke(s)) {
    const vertices = s.kind === 'line' ? resolvedShapeVertices(s) : null;
    const points = s.kind === 'line'
      ? connectedCellLinePoints(
        vertices![0]!.x, vertices![0]!.y,
        vertices![1]!.x, vertices![1]!.y,
      )
      : connectedCellPolygonPoints(s);
    const glyphs = points.map((point) => ({ ...point, ch: s.char }));
    return s.wide ? wideGlyphs(glyphs) : glyphs;
  }
  if (needsGeometryRaster(s)) {
    const glyphs = geometryGlyphs(s);
    return detail === 'cell' && s.wide ? wideGlyphs(glyphs) : glyphs;
  }
  if (detail === 'cell') {
    const glyphs = shapePoints(s).map((p) => ({ x: p.x, y: p.y, ch: s.char }));
    if (!s.wide) return glyphs;
    return wideGlyphs(glyphs);
  }
  const sx = 2, sy = 2;
  const scale = (v: number) => Math.round(v * 2);
  const sub = { kind: s.kind, style: s.style, x0: scale(s.x0), y0: scale(s.y0), x1: scale(s.x1), y1: scale(s.y1) };
  const pts = s.kind === 'line' ? linePoints(sub.x0, sub.y0, sub.x1, sub.y1)
    : s.kind === 'rect' ? rectPoints(sub.x0, sub.y0, sub.x1, sub.y1, s.style === 'filled')
    : ellipsePoints(sub.x0, sub.y0, sub.x1, sub.y1, s.style === 'filled');
  const masks = new Map<string, number>();
  for (const p of pts) {
    const cx = Math.floor(p.x / sx), cy = Math.floor(p.y / sy);
    const top = (p.y % sy) === 0, left = (p.x % sx) === 0;
    const bit = detail === 'half' ? (top ? (TL | TR) : (BL | BR)) : quadrantBit(top, left);
    const k = `${cx},${cy}`;
    masks.set(k, (masks.get(k) || 0) | bit);
  }
  const out: ShapeGlyph[] = [];
  for (const [k, mask] of masks) {
    const [x, y] = k.split(',').map(Number) as [number, number];
    const ch = glyphForMask(mask);
    if (ch) out.push({ x, y, ch });
  }
  return out;
}

interface ConnectedPoint extends EditorPoint {
  connections: number;
}

function addConnection(map: Map<string, ConnectedPoint>, point: EditorPoint, direction: number): void {
  const key = `${point.x},${point.y}`;
  const entry = map.get(key) || { x: point.x, y: point.y, connections: 0 };
  entry.connections |= direction;
  map.set(key, entry);
}

function directionBetween(from: EditorPoint, to: EditorPoint): [number, number] {
  if (to.x > from.x) return [EAST, WEST];
  if (to.x < from.x) return [WEST, EAST];
  if (to.y > from.y) return [SOUTH, NORTH];
  return [NORTH, SOUTH];
}

export function orthogonalLinePoints(x0: number, y0: number, x1: number, y1: number): EditorPoint[] {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  const out = [{ x: x0, y: y0 }];
  let x = x0, y = y0, movedX = 0, movedY = 0;
  while (x !== x1 || y !== y1) {
    const nextX = x === x1 ? Infinity : (movedX + 0.5) / Math.max(1, dx);
    const nextY = y === y1 ? Infinity : (movedY + 0.5) / Math.max(1, dy);
    if (nextX <= nextY) { x += sx; movedX++; }
    else { y += sy; movedY++; }
    out.push({ x, y });
  }
  return out;
}

export function orthogonalPathPoints(points: EditorPoint[] | null | undefined, closed = false): EditorPoint[] {
  const clean: EditorPoint[] = [];
  for (const point of points || []) {
    const next = { x: Math.round(point.x), y: Math.round(point.y) };
    const last = clean[clean.length - 1];
    if (!last || last.x !== next.x || last.y !== next.y) clean.push(next);
  }
  if (clean.length < 2) return clean;
  const out: EditorPoint[] = [clean[0]!];
  const count = clean.length - 1 + (closed ? 1 : 0);
  for (let i = 0; i < count; i++) {
    const from = clean[i % clean.length]!;
    const to = clean[(i + 1) % clean.length]!;
    out.push(...orthogonalLinePoints(from.x, from.y, to.x, to.y).slice(1));
  }
  return out;
}

function connectedSpecialGlyphs(points: EditorPoint[], style: string | undefined, closed = false): Array<ShapeGlyph & { connections: number }> {
  const path = orthogonalPathPoints(points, closed);
  if (!path.length) return [];
  const connections = new Map<string, ConnectedPoint>();
  addConnection(connections, path[0]!, 0);
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1]!, to = path[i]!;
    if (from.x === to.x && from.y === to.y) continue;
    const [forward, back] = directionBetween(from, to);
    addConnection(connections, from, forward);
    addConnection(connections, to, back);
  }
  return [...connections.values()].map((point) => ({
    ...point,
    ch: specialGlyphForConnections(point.connections, style),
  }));
}

export function specialBrushGlyphs(points: EditorPoint[], style: string = 'single'): Array<ShapeGlyph & { connections: number }> {
  return connectedSpecialGlyphs(points, style, false);
}

function ellipseQuarterPath(xa: number, ya: number, xb: number, yb: number): EditorPoint[] {
  const width = xb - xa, height = yb - ya;
  const cx = (xa + xb) / 2, cy = (ya + yb) / 2;
  const rx = width / 2, ry = height / 2;
  const endX = xb, endY = Math.floor(cy);
  let x = Math.ceil(cx), y = ya;
  const points = [{ x, y }];
  const errorAt = (nextX: number, nextY: number) => {
    const nx = (nextX - cx) / rx;
    const ny = (nextY - cy) / ry;
    return Math.abs(nx * nx + ny * ny - 1);
  };

  while (x !== endX || y !== endY) {
    const canMoveEast = x < endX;
    const canMoveSouth = y < endY;
    const firstStepMustMoveEast = points.length === 1 && width % 2 === 0;
    const lastStepMustMoveSouth = height % 2 === 0 && endY - y === 1;
    if (canMoveEast && (firstStepMustMoveEast || lastStepMustMoveSouth || !canMoveSouth ||
      errorAt(x + 1, y) <= errorAt(x, y + 1))) {
      x++;
    } else {
      y++;
    }
    points.push({ x, y });
  }
  return points;
}

function ellipseOutlinePath(s: EditorShape): EditorPoint[] {
  const xa = Math.min(Math.round(s.x0), Math.round(s.x1));
  const xb = Math.max(Math.round(s.x0), Math.round(s.x1));
  const ya = Math.min(Math.round(s.y0), Math.round(s.y1));
  const yb = Math.max(Math.round(s.y0), Math.round(s.y1));
  if (xa === xb || ya === yb) return linePoints(xa, ya, xb, yb);
  const xSum = xa + xb, ySum = ya + yb;
  const northeast = ellipseQuarterPath(xa, ya, xb, yb);
  const reflectX = (point: EditorPoint): EditorPoint => ({ x: xSum - point.x, y: point.y });
  const reflectY = (point: EditorPoint): EditorPoint => ({ x: point.x, y: ySum - point.y });
  const path = [...northeast];
  const append = (points: EditorPoint[]) => {
    for (const point of points) {
      const last = path[path.length - 1]!;
      if (last.x !== point.x || last.y !== point.y) path.push(point);
    }
  };
  append(northeast.map(reflectY).reverse());
  append(northeast.map((point) => reflectX(reflectY(point))));
  append(northeast.map(reflectX).reverse());
  if (path.length > 1) {
    const first = path[0]!, last = path[path.length - 1]!;
    if (first.x === last.x && first.y === last.y) path.pop();
  }
  return path;
}

function specialCircleGlyphs(s: EditorShape): Array<ShapeGlyph & { connections: number }> {
  return connectedSpecialGlyphs(ellipseOutlinePath(s), s.boxStyle, true);
}

function specialLineGlyphs(s: EditorShape): ShapeGlyph[] {
  const set = BOX_STYLES[s.boxStyle as EditorBoxStyle] || BOX_STYLES.single;
  const horizontal = Math.round(s.y0) === Math.round(s.y1);
  return linePoints(Math.round(s.x0), Math.round(s.y0), Math.round(s.x1), Math.round(s.y1))
    .map((point) => ({ ...point, ch: horizontal ? set.h : set.v }));
}

function slopeLineGlyphs(s: EditorShape): ShapeGlyph[] {
  const x0 = Math.round(s.x0), y0 = Math.round(s.y0), x1 = Math.round(s.x1), y1 = Math.round(s.y1);
  const straight = x0 === x1 || y0 === y1;
  const points = linePoints(x0, y0, x1, y1);
  if (straight) return points.map((point) => ({ ...point, ch: SLOPE_GLYPHS.straight }));
  const pair = Math.sign(x1 - x0) === Math.sign(y1 - y0)
    ? SLOPE_GLYPHS.falling
    : SLOPE_GLYPHS.rising;
  const sx = Math.sign(x1 - x0);
  const sy = Math.sign(y1 - y0);
  const rows = Math.abs(y1 - y0);
  const glyphs: ShapeGlyph[] = [];
  for (let index = 0; index <= rows; index++) {
    const firstX = x0 + sx * index;
    const secondX = firstX + sx;
    const left = Math.min(firstX, secondX);
    const y = y0 + sy * index;
    glyphs.push(
      { x: left, y, ch: pair[0] },
      { x: left + 1, y, ch: pair[1] },
    );
  }
  return glyphs.sort((a, b) => a.y - b.y || a.x - b.x);
}

function specialBoxGlyphs(s: EditorShape): ShapeGlyph[] {
  const set = BOX_STYLES[s.boxStyle as EditorBoxStyle] || BOX_STYLES.single;
  const xa = Math.min(Math.round(s.x0), Math.round(s.x1));
  const xb = Math.max(Math.round(s.x0), Math.round(s.x1));
  const ya = Math.min(Math.round(s.y0), Math.round(s.y1));
  const yb = Math.max(Math.round(s.y0), Math.round(s.y1));
  if (xa === xb && ya === yb) return [];
  if (ya === yb) return Array.from({ length: xb - xa + 1 }, (_, i) => ({ x: xa + i, y: ya, ch: set.h }));
  if (xa === xb) return Array.from({ length: yb - ya + 1 }, (_, i) => ({ x: xa, y: ya + i, ch: set.v }));
  const out: ShapeGlyph[] = [];
  for (let x = xa + 1; x < xb; x++) {
    out.push({ x, y: ya, ch: set.h }, { x, y: yb, ch: set.h });
  }
  for (let y = ya + 1; y < yb; y++) {
    out.push({ x: xa, y, ch: set.v }, { x: xb, y, ch: set.v });
  }
  out.push({ x: xa, y: ya, ch: set.tl }, { x: xb, y: ya, ch: set.tr });
  out.push({ x: xa, y: yb, ch: set.bl }, { x: xb, y: yb, ch: set.br });
  return out;
}

export function renderShapeToCells(s: EditorShape): EditorCellMap {
  const cells: EditorCellMap = {};
  const wide = !!s.wide && s.style !== 'special' && s.style !== 'slope';
  for (const { x, y, ch } of shapeGlyphs(s)) {
    cells[x + ',' + y] = s.channel !== 'glyph'
      ? { c: '', fg: null, bg: s.fg }
      : { c: ch, fg: s.fg, bg: null };
    if (wide && s.channel === 'glyph') {
      cells[(x + 1) + ',' + y] = { c: '', fg: s.fg, bg: null, cont: true };
    }
  }
  return cells;
}

export function linePoints(x0: number, y0: number, x1: number, y1: number): EditorPoint[] {
  const pts: EditorPoint[] = [];
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0, y = y0;
  while (true) {
    pts.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return pts;
}

export function rectPoints(x0: number, y0: number, x1: number, y1: number, filled: boolean): EditorPoint[] {
  const pts: EditorPoint[] = [];
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const edge = x === xa || x === xb || y === ya || y === yb;
      if (filled || edge) pts.push({ x, y });
    }
  }
  return pts;
}

export function ellipsePoints(x0: number, y0: number, x1: number, y1: number, filled: boolean): EditorPoint[] {
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
  const rx = (xb - xa) / 2, ry = (yb - ya) / 2;
  const height = yb - ya;
  const set = new Set<string>();
  const add = (x: number, y: number) => set.add(`${Math.round(x)},${Math.round(y)}`);
  if (rx < 0.5 || ry < 0.5) {
    return linePoints(Math.round(xa), Math.round(ya), Math.round(xb), Math.round(yb));
  }
  else {
    const steps = Math.ceil(2 * Math.PI * Math.max(rx, ry)) * 2;
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * 2 * Math.PI;
      add(rx + rx * Math.cos(t), ry + ry * Math.sin(t));
    }
    if (filled) {
      for (let y = 0; y <= height; y++) {
        const dy = (y - ry) / ry;
        if (Math.abs(dy) > 1) continue;
        const half = rx * Math.sqrt(1 - dy * dy);
        for (let x = Math.ceil(rx - half); x <= rx + half; x++) add(x, y);
      }
    }
  }
  return [...set].map((s) => {
    const [x, y] = s.split(',').map(Number);
    return { x: xa + x!, y: ya + y! };
  });
}
