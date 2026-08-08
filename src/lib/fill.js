import { applySubcell, maskFromChar, quadrantBit } from './subcell.js';

const TOP = 1 | 2;
const BOTTOM = 4 | 8;

function sameCell(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return a.c === b.c && a.fg === b.fg && a.bg === b.bg && !!a.cont === !!b.cont;
}

function logicalPoint(resolution, x, y, fx, fy) {
  return {
    x: resolution === 'quarter' ? x * 2 + (fx < 0.5 ? 0 : 1) : x,
    y: y * 2 + (fy < 0.5 ? 0 : 1),
  };
}

function physicalPoint(resolution, x, y) {
  return {
    x: resolution === 'quarter' ? Math.floor(x / 2) : x,
    y: Math.floor(y / 2),
    left: resolution === 'quarter' ? x % 2 === 0 : true,
    top: y % 2 === 0,
  };
}

function slotBits(resolution, point) {
  if (resolution === 'half') return point.top ? TOP : BOTTOM;
  return quadrantBit(point.top, point.left);
}

function slotSignature(cell, resolution, bits) {
  if (cell?.cont) return null;
  const mask = maskFromChar(cell?.c);
  if (cell?.c && !mask) return null;
  const occupied = mask & bits;
  if (resolution === 'half' && occupied !== 0 && occupied !== bits) return null;
  return occupied ? `occupied:${cell?.fg ?? ''}` : 'empty';
}

export function planSubcellFill({
  width,
  height,
  x,
  y,
  fx = 0.5,
  fy = 0.5,
  resolution,
  contiguous = true,
  selected = new Set(),
  sampleCell,
  activeCell,
  color,
}) {
  if (resolution !== 'half' && resolution !== 'quarter') return [];
  const logicalWidth = width * (resolution === 'quarter' ? 2 : 1);
  const logicalHeight = height * 2;
  const start = logicalPoint(resolution, x, y, fx, fy);
  const allowed = (point) => selected.size === 0 || selected.has(`${point.x},${point.y}`);
  const signatureAt = (lx, ly) => {
    if (lx < 0 || ly < 0 || lx >= logicalWidth || ly >= logicalHeight) return null;
    const point = physicalPoint(resolution, lx, ly);
    if (!allowed(point)) return null;
    const bits = slotBits(resolution, point);
    if (slotSignature(activeCell(point.x, point.y), resolution, bits) == null) return null;
    return slotSignature(sampleCell(point.x, point.y), resolution, bits);
  };
  const target = signatureAt(start.x, start.y);
  if (target == null) return [];

  const matches = [];
  if (contiguous) {
    const stack = [[start.x, start.y]];
    const seen = new Set();
    while (stack.length) {
      const [lx, ly] = stack.pop();
      const key = `${lx},${ly}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (signatureAt(lx, ly) !== target) continue;
      matches.push([lx, ly]);
      stack.push([lx + 1, ly], [lx - 1, ly], [lx, ly + 1], [lx, ly - 1]);
    }
  } else {
    for (let ly = 0; ly < logicalHeight; ly++) {
      for (let lx = 0; lx < logicalWidth; lx++) {
        if (signatureAt(lx, ly) === target) matches.push([lx, ly]);
      }
    }
  }

  const additions = new Map();
  for (const [lx, ly] of matches) {
    const point = physicalPoint(resolution, lx, ly);
    const key = `${point.x},${point.y}`;
    additions.set(key, (additions.get(key) || 0) | slotBits(resolution, point));
  }

  const updates = [];
  for (const [key, bits] of additions) {
    const [cx, cy] = key.split(',').map(Number);
    const previous = activeCell(cx, cy);
    const cell = applySubcell(previous, bits, color);
    if (!sameCell(previous, cell)) updates.push({ x: cx, y: cy, cell });
  }
  return updates;
}
