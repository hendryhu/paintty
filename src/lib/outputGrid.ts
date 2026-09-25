import { isWide } from './width.js';
import { composeGlyphCoverage, redrawCellBoundaryCoverage } from './render.js';
import type { EditorCell, EditorCellGrid, EditorCellValue } from './types/editor-domain.js';

type WideFunction = (glyph: string) => boolean;

function extent(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function backgroundOnly(cell: EditorCellValue): Pick<EditorCell, 'bg'> | null {
  return cell?.bg ? { bg: cell.bg } : null;
}

function glyphIsWide(cell: EditorCellValue, wideFn: WideFunction): boolean {
  return typeof cell?.c === 'string' && cell.c.length > 0 && wideFn(cell.c);
}

export function normalizeOutputGrid(
  rows: EditorCellGrid | null | undefined,
  width: unknown = null,
  height: unknown = null,
  wideFn: WideFunction = isWide,
): EditorCellGrid {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const inferredWidth = sourceRows.reduce(
    (largest, row) => Math.max(largest, Array.isArray(row) ? row.length : 0),
    0,
  );
  const outputWidth = extent(width, inferredWidth);
  const outputHeight = extent(height, sourceRows.length);
  const output: EditorCellGrid = Array.from(
    { length: outputHeight },
    () => Array<EditorCell | null>(outputWidth).fill(null),
  );

  for (let y = 0; y < outputHeight; y++) {
    const row = Array.isArray(sourceRows[y]) ? sourceRows[y]! : [];
    const outputRow = output[y]!;
    for (let x = 0; x < outputWidth; x++) {
      const cell = row[x];
      if (!cell) continue;

      if (cell.cont) {
        const leader = row[x - 1];
        if (x > 0 && !leader?.cont && glyphIsWide(leader, wideFn)) {
          const continuation = { ...cell, c: '', cont: true };
          if (leader!.bg) continuation.bg = leader!.bg;
          else delete continuation.bg;
          outputRow[x] = continuation;
        } else {
          outputRow[x] = backgroundOnly(cell);
        }
        continue;
      }

      if (glyphIsWide(cell, wideFn)) {
        if (x + 1 >= outputWidth || !row[x + 1]?.cont) {
          outputRow[x] = backgroundOnly(cell);
          continue;
        }
      }

      outputRow[x] = { ...cell };
    }
  }

  return output;
}

export function paintOutputGrid(
  ctx: CanvasRenderingContext2D,
  rows: EditorCellGrid,
  width: number,
  height: number,
  cellWidth: number,
  cellHeight: number,
  canvasBackground?: string,
): EditorCellGrid {
  const cells = normalizeOutputGrid(rows, width, height);
  ctx.clearRect(0, 0, width * cellWidth, height * cellHeight);
  const occupied = (x: number, y: number) => {
    const cell = cells[y]?.[x];
    return !!(cell?.c || cell?.cont);
  };

  const drawGlyphs = () => {
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
  };
  composeGlyphCoverage(ctx, drawGlyphs, () => {
    for (let y = height - 1; y >= 0; y--) {
      for (let x = width - 1; x >= 0; x--) {
        const cell = cells[y]?.[x];
        if (!cell?.bg) continue;
        ctx.fillStyle = cell.bg;
        ctx.fillRect(x * cellWidth, y * cellHeight, cellWidth, cellHeight);
      }
    }
    if (canvasBackground) {
      ctx.fillStyle = canvasBackground;
      ctx.fillRect(0, 0, width * cellWidth, height * cellHeight);
    }
  }, () => redrawCellBoundaryCoverage(
    ctx, width, height, cellWidth, cellHeight, 1, drawGlyphs, 0, 0,
    (column, row) => occupied(column - 1, row) && occupied(column, row),
    (column, row) => occupied(column, row - 1) && occupied(column, row),
  ));

  return cells;
}
