// Cell maps use sparse world-space keys so off-canvas content survives crop changes.
export function cmKey(x, y) {
  return x + ',' + y;
}

export function cmParse(key) {
  const separator = key.indexOf(',');
  return {
    x: Number(key.slice(0, separator)),
    y: Number(key.slice(separator + 1)),
  };
}

export function cmGet(map, x, y) {
  return map[cmKey(x, y)] ?? null;
}

export function cmHas(map, x, y) {
  return map[cmKey(x, y)] != null;
}

export function cmSet(map, x, y, value) {
  const key = cmKey(x, y);
  if (value == null) delete map[key];
  else map[key] = value;
  return map;
}

export function cmClone(map) {
  const clone = {};
  for (const key in map) {
    const cell = map[key];
    clone[key] = cell ? { ...cell } : cell;
  }
  return clone;
}

export function cmEntries(map) {
  return Object.entries(map).map(([key, cell]) => {
    const { x, y } = cmParse(key);
    return { x, y, cell };
  });
}

export function cmSize(map) {
  return Object.keys(map).length;
}

export function cmEqual(first, second) {
  const firstKeys = Object.keys(first);
  const secondKeys = Object.keys(second);
  if (firstKeys.length !== secondKeys.length) return false;

  for (const key of firstKeys) {
    const a = first[key];
    const b = second[key];
    if (!b) return false;
    if (a.c !== b.c || a.fg !== b.fg || a.bg !== b.bg || !!a.cont !== !!b.cont) {
      return false;
    }
  }
  return true;
}

export function cmTranslate(map, dx, dy) {
  if (!dx && !dy) return cmClone(map);
  const translated = {};
  for (const key in map) {
    const { x, y } = cmParse(key);
    translated[cmKey(x + dx, y + dy)] = map[key];
  }
  return translated;
}

export function cmBounds(map) {
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

export function cmFromGrid(grid, overflow) {
  const map = {};
  if (Array.isArray(grid)) {
    for (let y = 0; y < grid.length; y++) {
      const row = grid[y];
      if (!row) continue;
      for (let x = 0; x < row.length; x++) {
        if (row[x]) map[cmKey(x, y)] = row[x];
      }
    }
  }
  for (const key in overflow || {}) {
    if (overflow[key]) map[key] = overflow[key];
  }
  return map;
}

export function cmToGrid(map, viewport) {
  const { x: originX, y: originY, w, h } = viewport;
  const grid = Array.from({ length: h }, () => Array(w).fill(null));
  for (const key in map) {
    const point = cmParse(key);
    const x = point.x - originX;
    const y = point.y - originY;
    if (x >= 0 && y >= 0 && x < w && y < h) grid[y][x] = map[key];
  }
  return grid;
}
