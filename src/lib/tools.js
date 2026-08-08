import { get } from 'svelte/store';
import {
  activeTool, activeChar, paintColor, toolOptions, recentColors,
} from './stores.js';
import {
  grid,
  layers,
  activeLayerId,
  cellSelection,
  setCell,
  setCells,
  getCell,
  getComposited,
  inBounds,
  GRID_W,
  GRID_H,
  isBackgroundLayer,
  isEditingEffectMask,
} from './grid.js';
import { bitsForStroke, applySubcell } from './subcell.js';
import { planSubcellFill } from './fill.js';
import { isWide } from './width.js';
import { colorLuminance } from './effects.js';
import {
  BOX_STYLES,
  constrainShape,
  specialBrushGlyphs,
  specialGlyph,
  specialGlyphConnections,
} from './shapes.js';

const SPECIAL_NEIGHBORS = [
  { bit: 1, opposite: 4, dx: 0, dy: -1 },
  { bit: 2, opposite: 8, dx: 1, dy: 0 },
  { bit: 4, opposite: 1, dx: 0, dy: 1 },
  { bit: 8, opposite: 2, dx: -1, dy: 0 },
];

function pushRecent(color) {
  if (!color) return;
  recentColors.update((list) => {
    const next = [color, ...list.filter((c) => c !== color)];
    return next.slice(0, 16);
  });
}

function paintingBackground() {
  const id = get(activeLayerId);
  return isBackgroundLayer(get(layers).find((layer) => layer.id === id));
}

function clearOverlappingWide(x, y) {
  const here = getCell(x, y);
  const left = getCell(x - 1, y);
  if (here && here.cont && left) setCell(x - 1, y, left.bg ? { ...left, c: '', cont: false } : null);
  else if (left && isWide(left.c)) setCell(x - 1, y, left.bg ? { ...left, c: '', cont: false } : null);
  if (here && isWide(here.c)) {
    const right = getCell(x + 1, y);
    if (right && right.cont) setCell(x + 1, y, right.bg ? { ...right, cont: false } : null);
  }
}

function paintBrush(x, y) {
  if (paintingBackground()) {
    const color = get(paintColor);
    const changed = setCell(x, y, { c: '', fg: null, bg: color });
    pushRecent(color);
    return changed;
  }
  const ch = get(activeChar);
  const wide = isWide(ch);
  clearOverlappingWide(x, y);
  if (wide) clearOverlappingWide(x + 1, y);
  const prev = getCell(x, y) || {};
  const cell = {
    c: ch,
    fg: get(paintColor),
    bg: prev.bg ?? null,
  };
  let changed = setCell(x, y, cell);
  if (wide) {
    const right = getCell(x + 1, y) || {};
    changed = setCell(x + 1, y, {
      c: '', fg: cell.fg, bg: right.bg ?? null, cont: true,
    }) || changed;
  }
  pushRecent(cell.fg);
  return changed;
}

function paintSubcell(x, y, fx, fy) {
  const res = get(toolOptions).subcell.mode || get(toolOptions).subcell.resolution || 'half';
  const top = fy < 0.5;
  const left = fx < 0.5;
  const bits = bitsForStroke(res, top, left);
  clearOverlappingWide(x, y);
  const prev = getCell(x, y);
  const fg = get(paintColor);
  const changed = setCell(x, y, applySubcell(prev, bits, fg));
  pushRecent(fg);
  return changed;
}

function existingSpecialConnections(x, y, style) {
  const current = specialGlyphConnections(getCell(x, y)?.c, style);
  if (!current) return 0;
  let connections = 0;
  for (const neighbor of SPECIAL_NEIGHBORS) {
    if (!(current & neighbor.bit)) continue;
    const adjacent = specialGlyphConnections(getCell(x + neighbor.dx, y + neighbor.dy)?.c, style);
    if (adjacent & neighbor.opposite) connections |= neighbor.bit;
  }
  return connections;
}

function clearSpecialOverlap(x, y) {
  const here = getCell(x, y);
  const left = getCell(x - 1, y);
  if (here?.cont && left) setCell(x - 1, y, left.bg ? { ...left, c: '', cont: false } : null);
  else if (left && typeof document !== 'undefined' && isWide(left.c)) {
    setCell(x - 1, y, left.bg ? { ...left, c: '', cont: false } : null);
  }
  const right = getCell(x + 1, y);
  if (right?.cont) setCell(x + 1, y, right.bg ? { ...right, cont: false } : null);
}

function planSpecialBrushPath(points, style) {
  const selected = get(cellSelection);
  return specialBrushGlyphs(points, style)
    .filter(({ x, y }) => !selected.size || selected.has(`${x},${y}`))
    .map((glyph) => ({
      ...glyph,
      connections: glyph.connections | existingSpecialConnections(glyph.x, glyph.y, style),
    }));
}

export function previewSpecialBrushGlyph(points, x, y, style = 'single') {
  if (!BOX_STYLES[style]) return '';
  const glyph = planSpecialBrushPath(points, style).find((item) => item.x === x && item.y === y);
  return glyph ? specialGlyph(glyph.connections, style) : BOX_STYLES[style].h;
}

export function paintSpecialBrushPath(points, style = 'single') {
  if (!BOX_STYLES[style]) return 0;
  const first = points?.[0];
  if (!first || !(points || []).some((point) =>
    Math.round(point.x) !== Math.round(first.x) ||
    Math.round(point.y) !== Math.round(first.y))) return 0;
  const planned = planSpecialBrushPath(points, style);
  for (const glyph of planned) clearSpecialOverlap(glyph.x, glyph.y);
  const fg = get(paintColor);
  const updates = planned.map(({ x, y, connections }) => ({
    x,
    y,
    cell: { c: specialGlyph(connections, style), fg, bg: getCell(x, y)?.bg ?? null },
  }));
  if (!updates.length) return 0;
  setCells(updates);
  pushRecent(fg);
  return updates.length;
}

export function constrainDraggedShapeEndpoint(shape, which, x, y) {
  const constrainFromFixedStart = (value) => {
    const constrained = constrainShape(value);
    const dx = value.x0 - constrained.x0;
    const dy = value.y0 - constrained.y0;
    return !dx && !dy ? constrained : {
      ...constrained,
      x0: constrained.x0 + dx,
      y0: constrained.y0 + dy,
      x1: constrained.x1 + dx,
      y1: constrained.y1 + dy,
    };
  };
  if (which !== 'a') {
    return constrainFromFixedStart({ ...shape, x1: x, y1: y });
  }
  const reversed = constrainFromFixedStart({
    ...shape,
    x0: shape.x1,
    y0: shape.y1,
    x1: x,
    y1: y,
  });
  return {
    ...reversed,
    x0: reversed.x1,
    y0: reversed.y1,
    x1: reversed.x0,
    y1: reversed.y0,
  };
}

function erase(x, y) {
  if (paintingBackground()) {
    setCell(x, y, null);
    return;
  }
  clearOverlappingWide(x, y);
  const prev = getCell(x, y);
  if (!prev) return;
  const next = { ...prev, c: '', cont: false };
  setCell(x, y, next.bg ? next : null);
}

export function visibleColorFromCell(cell, preferBackground = false) {
  if (!cell) return null;
  return preferBackground ? cell.bg || cell.fg || null : cell.fg || cell.bg || null;
}

export function displayedSampleCell(terminalCell, rasterColor) {
  if (terminalCell) return terminalCell;
  return rasterColor ? { fg: rasterColor } : null;
}

function eyedrop(x, y, ev, sampledCell) {
  const cell = sampledCell === undefined ? getComposited(x, y) : sampledCell;
  if (!cell) return;
  const options = get(toolOptions).eyedropper;
  const background = paintingBackground();
  let pick = background ? 'color' : options.pick;
  if (ev?.shiftKey) pick = 'color';
  else if (ev?.ctrlKey || ev?.metaKey) pick = 'both';
  if (pick === 'char' || pick === 'both') { if (cell.c) activeChar.set(cell.c); }
  if (pick === 'color' || pick === 'both') {
    const color = visibleColorFromCell(cell, background);
    if (color) {
      paintColor.set(color);
      pushRecent(color);
    }
  }
}

function fill(x, y, fx, fy) {
  const g = get(grid);
  const opts = get(toolOptions).fill;
  const selected = get(cellSelection);
  const allowed = (cx, cy) => selected.size === 0 || selected.has(`${cx},${cy}`);
  if (!allowed(x, y)) return false;
  const comp = opts.sampleAll ? g : null;
  const sample = opts.sampleAll ? (cx, cy) => (inBounds(cx, cy) ? comp[cy][cx] : null) : (cx, cy) => getCell(cx, cy);
  const target = sample(x, y);
  const bgLayer = paintingBackground();
  const resolution = bgLayer ? 'cell' : (opts.resolution || 'cell');
  if (resolution === 'half' || resolution === 'quarter') {
    const updates = planSubcellFill({
      width: GRID_W,
      height: GRID_H,
      x,
      y,
      fx,
      fy,
      resolution,
      contiguous: opts.contiguous,
      selected,
      sampleCell: sample,
      activeCell: getCell,
      color: get(paintColor),
    });
    if (updates.length) {
      pushRecent(get(paintColor));
      return setCells(updates);
    }
    return false;
  }

  const sameCell = (a, b) => {
    if (bgLayer) return (a?.bg ?? null) === (b?.bg ?? null);
    const kind = (cell) => cell?.cont ? 'continuation' : (cell?.c ? 'glyph' : 'empty');
    const aKind = kind(a);
    const bKind = kind(b);
    if (aKind !== bKind) return false;
    if (aKind === 'empty') return true;
    if (aKind === 'continuation') return a.fg === b.fg;
    return a.c === b.c && a.fg === b.fg;
  };
  const newCell = bgLayer
    ? { c: '', fg: null, bg: get(paintColor) }
    : { c: get(activeChar), fg: get(paintColor), bg: null };
  if (!opts.sampleAll && sameCell(target, newCell)) return false;

  const points = [];
  if (opts.contiguous) {
    const seen = new Set();
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (!inBounds(cx, cy) || !allowed(cx, cy)) continue;
      const key = cx + ',' + cy;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!sameCell(sample(cx, cy), target)) continue;
      points.push({ x: cx, y: cy });
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  } else {
    for (let yy = 0; yy < GRID_H; yy++)
      for (let xx = 0; xx < GRID_W; xx++)
        if (allowed(xx, yy) && sameCell(sample(xx, yy), target)) points.push({ x: xx, y: yy });
  }

  const updateMap = new Map();
  const queue = (cx, cy, cell) => updateMap.set(`${cx},${cy}`, { x: cx, y: cy, cell });
  if (bgLayer) {
    for (const point of points) queue(point.x, point.y, { ...newCell });
  } else {
    const targetKeys = new Set(points.map((point) => `${point.x},${point.y}`));
    const writePoints = [];
    const wide = typeof document !== 'undefined' && isWide(newCell.c);
    if (wide) {
      const consumed = new Set();
      const ordered = [...points].sort((a, b) => a.y - b.y || a.x - b.x);
      for (const point of ordered) {
        const key = `${point.x},${point.y}`;
        const rightKey = `${point.x + 1},${point.y}`;
        if (consumed.has(key) || !targetKeys.has(rightKey)) continue;
        consumed.add(key);
        consumed.add(rightKey);
        writePoints.push({ ...point, leader: true }, { x: point.x + 1, y: point.y, leader: false });
      }
    } else {
      writePoints.push(...points.map((point) => ({ ...point, leader: true })));
    }

    for (const point of writePoints) {
      const previous = getCell(point.x, point.y);
      if (previous?.cont) {
        const leader = getCell(point.x - 1, point.y);
        if (leader) {
          queue(
            point.x - 1,
            point.y,
            leader.bg ? { c: '', fg: null, bg: leader.bg } : null,
          );
        }
      }
      if (previous) {
        const continuation = getCell(point.x + 1, point.y);
        if (continuation?.cont) {
          queue(
            point.x + 1,
            point.y,
            continuation.bg ? { c: '', fg: null, bg: continuation.bg } : null,
          );
        }
      }
    }

    for (const point of writePoints) {
      const previous = getCell(point.x, point.y);
      queue(
        point.x,
        point.y,
        point.leader
          ? { ...newCell, bg: previous?.bg ?? null }
          : { c: '', fg: newCell.fg, bg: previous?.bg ?? null, cont: true },
      );
    }
  }
  const updates = [...updateMap.values()];
  if (!updates.length) return false;
  pushRecent(bgLayer ? newCell.bg : newCell.fg);
  return setCells(updates);
}

function fillEffectMask(active, x, y) {
  const opts = get(toolOptions).fill;
  const selected = get(cellSelection);
  const allowed = (cx, cy) => selected.size === 0 || selected.has(`${cx},${cy}`);
  if (!allowed(x, y)) return false;
  const fallback = active.mask?.defaultStrength ?? 1;
  const strengthAt = (cx, cy) => getCell(cx, cy)?.mask ?? fallback;
  const target = strengthAt(x, y);
  const color = get(paintColor);
  const nextStrength = colorLuminance(color);
  if (target === nextStrength) return false;
  const updates = [];
  if (opts.contiguous) {
    const seen = new Set();
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (!inBounds(cx, cy) || !allowed(cx, cy)) continue;
      const key = `${cx},${cy}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (strengthAt(cx, cy) !== target) continue;
      updates.push({ x: cx, y: cy, cell: { mask: nextStrength } });
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  } else {
    for (let cy = 0; cy < GRID_H; cy++) {
      for (let cx = 0; cx < GRID_W; cx++) {
        if (allowed(cx, cy) && strengthAt(cx, cy) === target) updates.push({ x: cx, y: cy, cell: { mask: nextStrength } });
      }
    }
  }
  const changed = setCells(updates);
  pushRecent(color);
  return changed;
}

function pickEffectMask(active, x, y) {
  const strength = getCell(x, y)?.mask ?? active.mask?.defaultStrength ?? 1;
  const byte = Math.round(strength * 255).toString(16).padStart(2, '0');
  const color = `#${byte}${byte}${byte}`;
  paintColor.set(color);
  pushRecent(color);
}

export function applyTool(x, y, ev, kind, fx = 0.5, fy = 0.5, sampledCell) {
  const tool = get(activeTool);
  const active = get(layers).find((layer) => layer.id === get(activeLayerId));
  if (isEditingEffectMask(active)) {
    if (tool === 'brush') {
      const color = get(paintColor);
      const changed = setCell(x, y, { fg: color });
      pushRecent(color);
      return changed;
    } else if (tool === 'eraser') {
      return setCell(x, y, null);
    } else if (tool === 'fill' && kind === 'down') {
      return fillEffectMask(active, x, y);
    } else if (tool === 'eyedropper' && kind === 'down') {
      pickEffectMask(active, x, y);
    }
    return false;
  }
  switch (tool) {
    case 'brush':      return paintBrush(x, y);
    case 'eraser':     return erase(x, y);
    case 'subcell': {
      const mode = get(toolOptions).subcell.mode || get(toolOptions).subcell.resolution || 'half';
      return BOX_STYLES[mode]
        ? paintSpecialBrushPath([{ x, y }], mode)
        : paintSubcell(x, y, fx, fy);
    }
    case 'eyedropper': if (kind === 'down') eyedrop(x, y, ev, sampledCell); return false;
    case 'fill':       return kind === 'down' ? fill(x, y, fx, fy) : false;
    default: return false;
  }
}
