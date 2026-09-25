import type {
  EditorBounds,
  EditorCell,
  EditorCellGrid,
  EditorCellMap,
  EditorCellValue,
  EditorPoint,
} from './types/editor-domain.js';

// Cell maps use sparse world-space keys so off-canvas content survives crop changes.
export function cmKey(x: number, y: number): string {
  return x + ',' + y;
}

export function cmParse(key: string): EditorPoint {
  const separator = key.indexOf(',');
  return {
    x: Number(key.slice(0, separator)),
    y: Number(key.slice(separator + 1)),
  };
}

export function cmGet<T extends EditorCellValue>(map: Record<string, T>, x: number, y: number): T | null {
  return map[cmKey(x, y)] ?? null;
}

export function cmHas<T extends EditorCellValue>(map: Record<string, T>, x: number, y: number): boolean {
  return map[cmKey(x, y)] != null;
}

export function cmSet(map: EditorCellMap, x: number, y: number, value: EditorCellValue): EditorCellMap {
  const key = cmKey(x, y);
  if (value == null) delete map[key];
  else map[key] = value;
  return map;
}

export function cmClone(map: EditorCellMap): EditorCellMap {
  const clone: EditorCellMap = {};
  for (const key in map) {
    const cell = map[key];
    clone[key] = (cell ? { ...cell } : cell) as EditorCell | null;
  }
  return clone;
}

export function cmEntries(map: EditorCellMap): Array<EditorPoint & { cell: EditorCellValue }> {
  return Object.entries(map).map(([key, cell]) => {
    const { x, y } = cmParse(key);
    return { x, y, cell };
  });
}

export function cmSize(map: EditorCellMap): number {
  return Object.keys(map).length;
}

export function cmEqual(first: EditorCellMap, second: EditorCellMap): boolean {
  const firstKeys = Object.keys(first);
  const secondKeys = Object.keys(second);
  if (firstKeys.length !== secondKeys.length) return false;

  for (const key of firstKeys) {
    const a = first[key];
    const b = second[key];
    if (!a || !b) return false;
    if (a.c !== b.c || a.fg !== b.fg || a.bg !== b.bg || !!a.cont !== !!b.cont) {
      return false;
    }
  }
  return true;
}

export function cmTranslate<T extends EditorCellValue>(map: Record<string, T>, dx: number, dy: number): Record<string, T> {
  if (!dx && !dy) return cmClone(map as EditorCellMap) as Record<string, T>;
  const translated: Record<string, T> = {};
  for (const key in map) {
    const { x, y } = cmParse(key);
    translated[cmKey(x + dx, y + dy)] = map[key]!;
  }
  return translated;
}

export function cmBounds(map: EditorCellMap): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let found = false;

  for (const key in map) {
    found = true;
    const { x, y } = cmParse(key);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return found ? { x0, y0, x1, y1 } : null;
}

export function cmFromGrid(grid: EditorCellGrid, overflow?: EditorCellMap | null): EditorCellMap {
  const map: EditorCellMap = {};
  if (Array.isArray(grid)) {
    for (let y = 0; y < grid.length; y++) {
      const row = grid[y];
      if (!row) continue;
      for (let x = 0; x < row.length; x++) {
        const cell = row[x];
        if (cell) map[cmKey(x, y)] = cell;
      }
    }
  }
  const overflowCells = overflow || {};
  for (const key in overflowCells) {
    if (overflowCells[key]) map[key] = overflowCells[key]!;
  }
  return map;
}

export function cmToGrid(map: EditorCellMap, viewport: EditorPoint & { w: number; h: number }): EditorCellGrid {
  const { x: originX, y: originY, w, h } = viewport;
  const grid: EditorCellGrid = Array.from({ length: h }, () => Array<EditorCell | null>(w).fill(null));
  for (const key in map) {
    const point = cmParse(key);
    const x = point.x - originX;
    const y = point.y - originY;
    if (x >= 0 && y >= 0 && x < w && y < h) grid[y]![x] = map[key];
  }
  return grid;
}
