import { cmBounds, cmEntries } from './cellmap.js';
import { effectMaskStrength } from './effects.js';

export const THUMBNAIL_WIDTH = 56;
export const THUMBNAIL_HEIGHT = 44;
export function drawEffectMaskThumbnail(canvas, mask, width, height, effectiveOffset = null) {
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = THUMBNAIL_HEIGHT;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const maskWidth = Math.max(1, Math.floor(width) || 1);
  const maskHeight = Math.max(1, Math.floor(height) || 1);
  const offset = effectiveOffset || mask?.offset;
  const offsetX = Math.round(Number(offset?.x) || 0);
  const offsetY = Math.round(Number(offset?.y) || 0);
  for (let py = 0; py < THUMBNAIL_HEIGHT; py++) {
    const y = Math.min(maskHeight - 1, Math.floor(py * maskHeight / THUMBNAIL_HEIGHT));
    for (let px = 0; px < THUMBNAIL_WIDTH; px++) {
      const x = Math.min(maskWidth - 1, Math.floor(px * maskWidth / THUMBNAIL_WIDTH));
      const value = Math.round(effectMaskStrength(mask, x - offsetX, y - offsetY) * 255);
      const index = (py * THUMBNAIL_WIDTH + px) * 4;
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}


export function drawLayerThumbnail(canvas, layer, fontFamily = 'monospace') {
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = THUMBNAIL_HEIGHT;
  const ctx = canvas.getContext('2d');
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);

  if (layer.type === 'image' && layer.raster?.width && layer.raster?.height) {
    const scale = Math.min(
      THUMBNAIL_WIDTH / layer.raster.width,
      THUMBNAIL_HEIGHT / layer.raster.height,
    );
    const width = layer.raster.width * scale;
    const height = layer.raster.height * scale;
    ctx.globalAlpha = layer.opacity ?? 1;
    ctx.drawImage(
      layer.raster,
      (THUMBNAIL_WIDTH - width) / 2,
      (THUMBNAIL_HEIGHT - height) / 2,
      width,
      height,
    );
    ctx.globalAlpha = 1;
    return;
  }

  const bounds = cmBounds(layer.cells);
  if (!bounds) return;
  const columns = bounds.x1 - bounds.x0 + 1;
  const rows = bounds.y1 - bounds.y0 + 1;
  const cellWidth = Math.min(
    THUMBNAIL_WIDTH / columns,
    THUMBNAIL_HEIGHT / (rows * 2),
  );
  const cellHeight = cellWidth * 2;
  const offsetX = (THUMBNAIL_WIDTH - columns * cellWidth) / 2;
  const offsetY = (THUMBNAIL_HEIGHT - rows * cellHeight) / 2;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.max(2, cellHeight * 0.82)}px ${fontFamily}`;
  for (const { x, y, cell } of cmEntries(layer.cells)) {
    if (!cell) continue;
    const px = offsetX + (x - bounds.x0) * cellWidth;
    const py = offsetY + (y - bounds.y0) * cellHeight;
    if (cell.bg) {
      ctx.fillStyle = cell.bg;
      ctx.fillRect(px, py, cellWidth, cellHeight);
    }
    if (cell.c && !cell.cont) {
      ctx.fillStyle = cell.fg || '#fff';
      ctx.fillText(cell.c, px + cellWidth / 2, py + cellHeight / 2);
    }
  }
}
