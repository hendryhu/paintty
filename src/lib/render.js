export function measureFont(fontFamily, fontPx) {
  const ctx = document.createElement('canvas').getContext('2d');
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

export function metricsForCellWidth(fontFamily, targetCellW) {
  let low = 4;
  let high = 200;
  let best = null;
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

export function drawGrid(canvas, cells, metrics, options = {}) {
  const { cellW, cellH, fontPx } = metrics;
  const rows = cells.length;
  const columns = cells[0]?.length || 0;
  const pixelRatio = window.devicePixelRatio || 1;
  const displayColor = options.disp || ((hex) => hex);
  const fontFamily = options.fontFamily || 'monospace';
  const width = columns * cellW;
  const height = rows * cellH;

  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (options.canvasBg && options.fillBg !== false) {
    ctx.fillStyle = options.canvasBg;
    ctx.fillRect(0, 0, width, height);
  }

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const cell = cells[y][x];
      if (!cell?.bg) continue;
      ctx.fillStyle = displayColor(cell.bg);
      ctx.fillRect(x * cellW, y * cellH, cellW, cellH);
    }
  }

  ctx.font = `${fontPx}px ${fontFamily}`;
  ctx.fontKerning = 'none';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const cell = cells[y][x];
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
}

export function drawOnionCells(ctx, cells, metrics, tint, alpha) {
  const previousAlpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = tint;
  for (let y = 0; y < cells.length; y++) {
    for (let x = 0; x < (cells[y]?.length || 0); x++) {
      if (cells[y][x]?.bg) {
        ctx.fillRect(x * metrics.cellW, y * metrics.cellH, metrics.cellW, metrics.cellH);
      }
    }
  }
  for (let y = 0; y < cells.length; y++) {
    for (let x = 0; x < (cells[y]?.length || 0); x++) {
      const glyph = cells[y][x]?.c;
      if (glyph) drawGlyph(ctx, glyph, tint, x, y, metrics);
    }
  }
  ctx.globalAlpha = previousAlpha;
}

export function drawGlyph(ctx, glyph, color, x, y, metrics) {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color || '#fff';
  ctx.fillText(
    glyph,
    x * metrics.cellW,
    y * metrics.cellH + metrics.baseline,
  );
}
