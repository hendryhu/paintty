import { cmGet } from './cellmap.js';
import { layoutText } from './textLayer.js';

function containsBox(layer, x, y, helpers) {
  const box = helpers.boxOf(layer);
  return x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
}

export function textLayerHasGlyph(layer, x, y, helpers) {
  if (!layer) return false;
  const offset = helpers.offsetOf?.(layer) || { x: 0, y: 0 };
  const localX = x - Math.round(Number(offset.x) || 0);
  const localY = y - Math.round(Number(offset.y) || 0);
  return !!cmGet(layer.cells, localX, localY);
}

export function textLayerAt(layers, activeId, x, y, helpers) {
  const isVisible = helpers.isVisible;
  const eligible = (layer) =>
    layer.type === 'text' && layer.box && isVisible(layer);

  const active = layers.find((layer) => layer.id === activeId && eligible(layer));
  if (active && textLayerHasGlyph(active, x, y, helpers)) return active;

  // Rendered text wins over another layer's transparent text-box interior.
  const glyphLayer = layers.find((layer) =>
    eligible(layer) && textLayerHasGlyph(layer, x, y, helpers));
  if (glyphLayer) return glyphLayer;

  if (active && containsBox(active, x, y, helpers)) return active;

  return layers.find((layer) => {
    if (!eligible(layer)) return false;
    return containsBox(layer, x, y, helpers);
  }) || null;
}

function pointFraction(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0.5;
}

export function beginTextGesture(x, y, layerId = null, within = {}) {
  const fx = pointFraction(within.x);
  const fy = pointFraction(within.y);
  return {
    x0: x,
    y0: y,
    fx0: fx,
    fy0: fy,
    x1: x,
    y1: y,
    fx1: fx,
    fy1: fy,
    layerId,
    startsOnGlyph: !!within.onGlyph,
    dragged: false,
  };
}

export function moveTextGesture(gesture, x, y, within = {}) {
  if (!gesture) return null;
  return {
    ...gesture,
    x1: x,
    y1: y,
    fx1: pointFraction(within.x),
    fy1: pointFraction(within.y),
    dragged: gesture.dragged || x !== gesture.x0 || y !== gesture.y0,
  };
}

export function textGestureBox(gesture) {
  // A glyph drag edits its text; a drag from blank box space may create a new box.
  if (!gesture || (gesture.layerId != null && (!gesture.dragged || gesture.startsOnGlyph))) return null;
  const x = Math.min(gesture.x0, gesture.x1);
  const y = Math.min(gesture.y0, gesture.y1);
  return {
    x,
    y,
    w: Math.abs(gesture.x1 - gesture.x0) + 1,
    h: Math.abs(gesture.y1 - gesture.y0) + 1,
  };
}

export function resolveTextGesture(gesture) {
  if (!gesture) return null;
  const box = textGestureBox(gesture);
  if (box) return { action: 'create', box };
  return gesture.layerId != null ? { action: 'edit', layerId: gesture.layerId } : null;
}

function textIndexAtPoint(layout, textLength, box, point, tieDirection) {
  // Resolve against layout boundaries so wide glyphs and UTF-16 ranges stay atomic.
  const row = Math.floor(point.y - box.y + point.fy);
  if (row < 0) return 0;
  if (row >= layout.lineCount) return textLength;

  const column = point.x - box.x + point.fx;
  const boundaries = [{ column: 0, index: layout.rowStarts[row] ?? textLength }];
  for (const glyph of layout.glyphs) {
    if (glyph.y !== row) continue;
    boundaries.push({ column: glyph.x, index: glyph.index });
    boundaries.push({ column: glyph.x + glyph.width, index: glyph.end });
  }

  let best = boundaries[0];
  let distance = Math.abs(column - best.column);
  for (const boundary of boundaries.slice(1)) {
    const nextDistance = Math.abs(column - boundary.column);
    const winsTie = nextDistance === distance && (
      tieDirection === 'forward'
        ? boundary.index > best.index
        : boundary.index < best.index
    );
    if (nextDistance < distance || winsTie) {
      best = boundary;
      distance = nextDistance;
    }
  }
  return best.index;
}

export function textGestureSelection(layer, box, gesture, wideFn) {
  if (!layer || !box || !gesture) return null;
  const text = String(layer.text ?? '');
  const layout = layoutText(text, box.w, layer.wrap !== false, wideFn);
  const firstPoint = { x: gesture.x0, y: gesture.y0, fx: gesture.fx0, fy: gesture.fy0 };
  const lastPoint = { x: gesture.x1, y: gesture.y1, fx: gesture.fx1, fy: gesture.fy1 };
  const samePoint = firstPoint.x === lastPoint.x && firstPoint.y === lastPoint.y &&
    firstPoint.fx === lastPoint.fx && firstPoint.fy === lastPoint.fy;
  if (samePoint) {
    const caret = textIndexAtPoint(layout, text.length, box, firstPoint, 'forward');
    return { start: caret, end: caret, direction: 'none' };
  }
  const movesForward = lastPoint.y > firstPoint.y ||
    (lastPoint.y === firstPoint.y && lastPoint.x + lastPoint.fx >= firstPoint.x + firstPoint.fx);
  const first = textIndexAtPoint(layout, text.length, box, firstPoint, movesForward ? 'backward' : 'forward');
  const last = textIndexAtPoint(layout, text.length, box, lastPoint, movesForward ? 'forward' : 'backward');
  return {
    start: Math.min(first, last),
    end: Math.max(first, last),
    direction: first === last ? 'none' : (movesForward ? 'forward' : 'backward'),
  };
}
