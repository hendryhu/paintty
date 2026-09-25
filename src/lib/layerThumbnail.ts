import { cmBounds, cmEntries } from './cellmap.js';
import { effectMaskStrength } from './effects.js';
import { composeGlyphCoverage, redrawCellBoundaryCoverage } from './render.js';
import type { TimelineLayer, TimelineMask, TimelinePoint } from './types/timeline-models.js';
import type { EditorContentMask } from './types/editor-domain.js';

export const THUMBNAIL_WIDTH = 56;
export const THUMBNAIL_HEIGHT = 44;
export function drawEffectMaskThumbnail(
  canvas: HTMLCanvasElement,
  mask: TimelineMask | null | undefined,
  width: number,
  height: number,
  effectiveOffset: TimelinePoint | null = null,
): void {
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = THUMBNAIL_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new TypeError('Effect mask thumbnail requires a 2D canvas context.');
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

export function drawContentMaskThumbnail(
  canvas: HTMLCanvasElement,
  mask: EditorContentMask | null | undefined,
  width: number,
  height: number,
  effectiveOffset: TimelinePoint | null = null,
): void {
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = THUMBNAIL_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new TypeError('Content mask thumbnail requires a 2D canvas context.');
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
      const cell = mask?.cells[`${x - offsetX},${y - offsetY}`];
      const color = cell?.bg || cell?.fg;
      const value = color ? color.toLowerCase() === '#ffffff' ? 255 : 0 : (mask?.defaultStrength ?? 1) === 1 ? 255 : 0;
      const index = (py * THUMBNAIL_WIDTH + px) * 4;
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}


export function drawLayerThumbnail(
  canvas: HTMLCanvasElement,
  layer: TimelineLayer,
  fontFamily = 'monospace',
): void {
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = THUMBNAIL_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new TypeError('Layer thumbnail requires a 2D canvas context.');
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

  const bounds = cmBounds(layer.cells || {});
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
  const entries = [...cmEntries(layer.cells || {})];
  const occupied = new Set(entries
    .filter(({ cell }) => !!(cell?.c || cell?.cont))
    .map(({ x, y }) => `${x},${y}`));
  const drawGlyphs = () => {
    for (const { x, y, cell } of entries) {
      if (!cell?.c || cell.cont) continue;
      const px = offsetX + (x - bounds.x0) * cellWidth;
      const py = offsetY + (y - bounds.y0) * cellHeight;
      ctx.fillStyle = cell.fg || '#fff';
      ctx.fillText(cell.c, px + cellWidth / 2, py + cellHeight / 2);
    }
  };
  composeGlyphCoverage(ctx, drawGlyphs, () => {
    for (let index = entries.length - 1; index >= 0; index--) {
      const { x, y, cell } = entries[index]!;
      if (!cell?.bg) continue;
      const px = offsetX + (x - bounds.x0) * cellWidth;
      const py = offsetY + (y - bounds.y0) * cellHeight;
      ctx.fillStyle = cell.bg;
      ctx.fillRect(px, py, cellWidth, cellHeight);
    }
  }, () => redrawCellBoundaryCoverage(
    ctx, columns, rows, cellWidth, cellHeight, 1, drawGlyphs, offsetX, offsetY,
    (column, row) => occupied.has(`${bounds.x0 + column - 1},${bounds.y0 + row}`) &&
      occupied.has(`${bounds.x0 + column},${bounds.y0 + row}`),
    (column, row) => occupied.has(`${bounds.x0 + column},${bounds.y0 + row - 1}`) &&
      occupied.has(`${bounds.x0 + column},${bounds.y0 + row}`),
  ));
}
