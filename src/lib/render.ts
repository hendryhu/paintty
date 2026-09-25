import type { EditorCellGrid } from './types/editor-domain.js';

export interface EditorFontMetrics {
  cellW: number;
  cellH: number;
  baseline: number;
  fontPx: number;
  advance: number;
}

interface DrawGridOptions {
  disp?: ((hex: string | null | undefined) => string) | undefined;
  fontFamily?: string | undefined;
  canvasBg?: string | undefined;
  fillBg?: boolean | undefined;
  blinkOff?: boolean | undefined;
}

export function canvasBackingScale(
  value: unknown = typeof window === 'undefined' ? 1 : window.devicePixelRatio,
  cssWidth = 0,
  cssHeight = 0,
): number {
  const ratio = Number(value);
  const requested = Math.max(2, Math.ceil(Number.isFinite(ratio) ? ratio : 1));
  if (!(cssWidth > 0 && cssHeight > 0)) return requested;
  const pixelBudget = 64 * 1024 * 1024;
  const budgetScale = Math.floor(Math.sqrt(pixelBudget / (cssWidth * cssHeight)));
  return Math.max(1, Math.min(requested, budgetScale));
}

export function composeGlyphCoverage(
  ctx: CanvasRenderingContext2D,
  drawGlyphs: () => void,
  drawBackgrounds: () => void,
  repairBoundaryCoverage?: (() => void) | undefined,
): void {
  const previousOperation = ctx.globalCompositeOperation;
  try {
    ctx.globalCompositeOperation = 'source-over';
    drawGlyphs();
    repairBoundaryCoverage?.();
    ctx.globalCompositeOperation = 'destination-over';
    drawBackgrounds();
  } finally {
    ctx.globalCompositeOperation = previousOperation;
  }
}

export function redrawCellBoundaryCoverage(
  ctx: CanvasRenderingContext2D,
  columns: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
  backingScale: number,
  drawGlyphs: () => void,
  originX = 0,
  originY = 0,
  verticalBoundaryActive: (column: number, row: number) => boolean = () => true,
  horizontalBoundaryActive: (column: number, row: number) => boolean = () => true,
): void {
  if ((columns < 2 && rows < 2) ||
    cellWidth * backingScale < 2 || cellHeight * backingScale < 2) return;
  const fringe = 1 / Math.max(1, backingScale);
  const verticalHalfBand = Math.min(fringe * 4, cellWidth / 2);
  const horizontalHalfBand = Math.min(fringe * 4, cellHeight / 2);
  if (columns >= 2) {
    const boundaries: Array<readonly [column: number, row: number]> = [];
    for (let column = 1; column < columns; column++) {
      for (let row = 0; row < rows; row++) {
        if (!verticalBoundaryActive(column, row)) continue;
        boundaries.push([column, row]);
      }
    }
    if (boundaries.length) {
      ctx.save();
      ctx.beginPath();
      for (const [column, row] of boundaries) {
        ctx.rect(originX + column * cellWidth - verticalHalfBand,
          originY + row * cellHeight, verticalHalfBand * 2, cellHeight);
      }
      ctx.clip();
      for (const offset of [-fringe, fringe]) {
        ctx.save();
        ctx.translate(offset, 0);
        drawGlyphs();
        ctx.restore();
      }
      ctx.restore();
    }
  }
  if (rows >= 2) {
    const boundaries: Array<readonly [column: number, row: number]> = [];
    for (let row = 1; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        if (!horizontalBoundaryActive(column, row)) continue;
        boundaries.push([column, row]);
      }
    }
    if (boundaries.length) {
      ctx.save();
      ctx.beginPath();
      for (const [column, row] of boundaries) {
        ctx.rect(originX + column * cellWidth,
          originY + row * cellHeight - horizontalHalfBand,
          cellWidth, horizontalHalfBand * 2);
      }
      ctx.clip();
      for (const offset of [-fringe, fringe]) {
        ctx.save();
        ctx.translate(0, offset);
        drawGlyphs();
        ctx.restore();
      }
      ctx.restore();
    }
  }
}

export function measureFont(fontFamily: string, fontPx: number): EditorFontMetrics {
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.font = `${fontPx}px ${fontFamily}`;
  const metrics = ctx.measureText('M');
  const advance = metrics.width;
  const ascent = metrics.fontBoundingBoxAscent ??
    metrics.actualBoundingBoxAscent ??
    fontPx * 0.8;
  const descent = metrics.fontBoundingBoxDescent ??
    metrics.actualBoundingBoxDescent ??
    fontPx * 0.2;
  return {
    cellW: Math.round(advance),
    cellH: Math.round(ascent + descent),
    baseline: Math.round(ascent),
    fontPx,
    advance,
  };
}

export function metricsForCellWidth(fontFamily: string, targetCellW: number): EditorFontMetrics {
  let low = 4;
  let high = 200;
  let best: EditorFontMetrics | null = null;
  for (let iteration = 0; iteration < 24; iteration++) {
    const midpoint = (low + high) / 2;
    const metrics = measureFont(fontFamily, midpoint);
    if (metrics.advance > targetCellW) high = midpoint;
    else {
      best = metrics;
      low = midpoint;
    }
  }
  return best || measureFont(fontFamily, targetCellW * 1.6);
}

export function drawGrid(
  canvas: HTMLCanvasElement,
  cells: EditorCellGrid,
  metrics: EditorFontMetrics,
  options: DrawGridOptions = {},
): void {
  const { cellW, cellH, fontPx } = metrics;
  const rows = cells.length;
  const columns = cells[0]?.length || 0;
  const displayColor = options.disp || ((hex: string | null | undefined) => hex as string);
  const fontFamily = options.fontFamily || 'monospace';
  const width = columns * cellW;
  const height = rows * cellH;
  const pixelRatio = canvasBackingScale(undefined, width, height);

  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';

  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.font = `${fontPx}px ${fontFamily}`;
  ctx.fontKerning = 'none';
  const drawGlyphs = () => {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const cell = cells[y]![x];
        if (!cell?.c) continue;
        if (cell.blink && options.blinkOff) continue;
        drawGlyph(
          ctx,
          cell.c,
          displayColor(cell.fg) || '#fff',
          x,
          y,
          metrics,
        );
      }
    }
  };
  composeGlyphCoverage(ctx, drawGlyphs, () => {
    for (let y = rows - 1; y >= 0; y--) {
      for (let x = columns - 1; x >= 0; x--) {
        const cell = cells[y]![x];
        if (!cell?.bg) continue;
        ctx.fillStyle = displayColor(cell.bg);
        fillCellBackground(ctx, x, y, metrics, pixelRatio);
      }
    }
    if (options.canvasBg && options.fillBg !== false) {
      ctx.fillStyle = options.canvasBg;
      ctx.fillRect(0, 0, width, height);
    }
  }, () => redrawCellBoundaryCoverage(
    ctx,
    columns,
    rows,
    metrics.cellW,
    metrics.cellH,
    pixelRatio,
    drawGlyphs,
    0,
    0,
    (column, row) => {
      const left = cells[row]?.[column - 1];
      const right = cells[row]?.[column];
      return !!(left && (left.c || left.cont) && !(left.blink && options.blinkOff) &&
        right && (right.c || right.cont) && !(right.blink && options.blinkOff));
    },
    (column, row) => {
      const top = cells[row - 1]?.[column];
      const bottom = cells[row]?.[column];
      return !!(top && (top.c || top.cont) && !(top.blink && options.blinkOff) &&
        bottom && (bottom.c || bottom.cont) && !(bottom.blink && options.blinkOff));
    },
  ));
}

export function fillCellBackground(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  metrics: EditorFontMetrics,
  scaleX = 1,
  scaleY = scaleX,
): void {
  const overlapX = 1 / Math.max(0.01, scaleX);
  const overlapY = 1 / Math.max(0.01, scaleY);
  ctx.fillRect(
    x * metrics.cellW,
    y * metrics.cellH,
    metrics.cellW + overlapX,
    metrics.cellH + overlapY,
  );
}

export function drawOnionCells(
  ctx: CanvasRenderingContext2D,
  cells: EditorCellGrid,
  metrics: EditorFontMetrics,
  tint: string,
  alpha: number,
): void {
  const previousAlpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = tint;
  for (let y = 0; y < cells.length; y++) {
    const row = cells[y]!;
    for (let x = 0; x < row.length; x++) {
      if (row[x]?.bg) {
        ctx.fillRect(x * metrics.cellW, y * metrics.cellH, metrics.cellW, metrics.cellH);
      }
    }
  }
  for (let y = 0; y < cells.length; y++) {
    const row = cells[y]!;
    for (let x = 0; x < row.length; x++) {
      const glyph = row[x]?.c;
      if (glyph) drawGlyph(ctx, glyph, tint, x, y, metrics);
    }
  }
  ctx.globalAlpha = previousAlpha;
}

export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: string,
  color: string | null | undefined,
  x: number,
  y: number,
  metrics: EditorFontMetrics,
): void {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color || '#fff';
  ctx.fillText(
    glyph,
    x * metrics.cellW,
    y * metrics.cellH + metrics.baseline,
  );
}
