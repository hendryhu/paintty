import { isWide } from './width.js';

function extent(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function backgroundOnly(cell) {
  return cell?.bg ? { bg: cell.bg } : null;
}

function glyphIsWide(cell, wideFn) {
  return typeof cell?.c === 'string' && cell.c.length > 0 && wideFn(cell.c);
}

export function normalizeOutputGrid(rows, width = null, height = null, wideFn = isWide) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const inferredWidth = sourceRows.reduce(
    (largest, row) => Math.max(largest, Array.isArray(row) ? row.length : 0),
    0,
  );
  const outputWidth = extent(width, inferredWidth);
  const outputHeight = extent(height, sourceRows.length);
  const output = Array.from({ length: outputHeight }, () => Array(outputWidth).fill(null));

  for (let y = 0; y < outputHeight; y++) {
    const row = Array.isArray(sourceRows[y]) ? sourceRows[y] : [];
    for (let x = 0; x < outputWidth; x++) {
      const cell = row[x];
      if (!cell) continue;

      if (cell.cont) {
        const leader = row[x - 1];
        if (x > 0 && !leader?.cont && glyphIsWide(leader, wideFn)) {
          const continuation = { ...cell, c: '', cont: true };
          if (leader.bg) continuation.bg = leader.bg;
          else delete continuation.bg;
          output[y][x] = continuation;
        } else {
          output[y][x] = backgroundOnly(cell);
        }
        continue;
      }

      if (glyphIsWide(cell, wideFn)) {
        if (x + 1 >= outputWidth || !row[x + 1]?.cont) {
          output[y][x] = backgroundOnly(cell);
          continue;
        }
      }

      output[y][x] = { ...cell };
    }
  }

  return output;
}

export function paintOutputGrid(ctx, rows, width, height, cellWidth, cellHeight) {
  const cells = normalizeOutputGrid(rows, width, height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cells[y]?.[x];
      if (!cell?.bg) continue;
      ctx.fillStyle = cell.bg;
      ctx.fillRect(x * cellWidth, y * cellHeight, cellWidth, cellHeight);
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = cells[y]?.[x];
      if (!cell?.c || cell.cont) continue;
      const span = cells[y]?.[x + 1]?.cont ? 2 : 1;
      ctx.fillStyle = cell.fg || '#fff';
      ctx.fillText(
        cell.c,
        x * cellWidth + span * cellWidth / 2,
        y * cellHeight + cellHeight / 2,
      );
    }
  }

  return cells;
}
