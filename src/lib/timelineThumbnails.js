import { readThemeColors } from './themeColors.js';

const MAX_BACKING_WIDTH = 512;
const MAX_BACKING_HEIGHT = 96;
const MAX_MODEL_CELLS = 256;
const MAX_DEVICE_PIXEL_RATIO = 2;
const TARGET_TILE_WIDTH = 52;
const MIN_TILE_WIDTH = 40;
const MAX_TILE_WIDTH = 64;
const MAX_FILMSTRIP_SAMPLES = 64;
const THUMBNAIL_THEME_PROPERTIES = Object.freeze({
  emptySurface: '--thumbnail-empty-surface',
  emptyLine: '--thumbnail-empty-line',
  referenceSurface: '--thumbnail-reference-surface',
  referenceLine: '--thumbnail-reference-line',
  referenceText: '--thumbnail-reference-text',
});

function parsedCellEntry(key, cell, offset = { x: 0, y: 0 }) {
  const match = /^(-?\d+),(-?\d+)$/.exec(key);
  if (!match || !cell || typeof cell !== 'object') return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return Number.isSafeInteger(x) && Number.isSafeInteger(y)
    ? { x: x + offset.x, y: y + offset.y, cell }
    : null;
}

function compareEntries(first, second) {
  return first.y - second.y || first.x - second.x;
}

function gridDimensions(bounds, limit) {
  const ratio = bounds.width / Math.max(1, bounds.height);
  let columns = Math.max(1, Math.min(limit, Math.round(Math.sqrt(limit * ratio))));
  let rows = Math.max(1, Math.floor(limit / columns));
  columns = Math.min(columns, bounds.width);
  rows = Math.min(rows, bounds.height);
  while (columns * rows < limit) {
    const addColumn = columns < bounds.width && (columns + 1) * rows <= limit;
    const addRow = rows < bounds.height && columns * (rows + 1) <= limit;
    if (!addColumn && !addRow) break;
    if (addColumn && (!addRow || columns / bounds.width <= rows / bounds.height)) columns++;
    else rows++;
  }
  return { columns, rows };
}

function entrySignature(entry) {
  return [
    entry.cell.c || '',
    entry.cell.fg || '',
    entry.cell.bg || '',
    entry.cell.cont ? '1' : '0',
  ].join('\u0000');
}

function entrySampleRank(entry, bounds, grid, frequencies) {
  const normalizedX = bounds.width === 1 ? 0.5 : (entry.x - bounds.x) / (bounds.width - 1);
  const normalizedY = bounds.height === 1 ? 0.5 : (entry.y - bounds.y) / (bounds.height - 1);
  const column = Math.min(grid.columns - 1, Math.floor(normalizedX * grid.columns));
  const row = Math.min(grid.rows - 1, Math.floor(normalizedY * grid.rows));
  const centerX = (column + 0.5) / grid.columns;
  const centerY = (row + 0.5) / grid.rows;
  const contentRank = entry.cell.c && !entry.cell.cont ? 0 : entry.cell.bg ? 1 : 2;
  return {
    bin: row * grid.columns + column,
    contentRank,
    frequency: frequencies.get(entrySignature(entry)) || 0,
    distance: (normalizedX - centerX) ** 2 + (normalizedY - centerY) ** 2,
  };
}

function preferSample(candidate, current) {
  return candidate.rank.contentRank < current.rank.contentRank ||
    candidate.rank.contentRank === current.rank.contentRank && (
      candidate.rank.frequency < current.rank.frequency ||
      candidate.rank.frequency === current.rank.frequency && (
        candidate.rank.distance < current.rank.distance ||
        candidate.rank.distance === current.rank.distance &&
          compareEntries(candidate.entry, current.entry) < 0
      )
    );
}

// Oversized models retain one rare, content-rich sample per spatial bin rather than
// biasing thumbnails toward the first cells in object order.
function parsedCellEntries(cells, limit, options = {}) {
  const exact = [];
  let count = 0;
  let minimumX = Infinity;
  let minimumY = Infinity;
  let maximumX = -Infinity;
  let maximumY = -Infinity;
  const frequencies = new Map();
  for (const key in cells || {}) {
    if (!Object.prototype.hasOwnProperty.call(cells, key)) continue;
    const entry = parsedCellEntry(key, cells[key], options.offset);
    if (!entry) continue;
    if (options.frameBounds && (
      entry.x < options.frameBounds.x || entry.y < options.frameBounds.y ||
      entry.x >= options.frameBounds.x + options.frameBounds.width ||
      entry.y >= options.frameBounds.y + options.frameBounds.height
    )) continue;
    count++;
    if (exact.length < limit) exact.push(entry);
    minimumX = Math.min(minimumX, entry.x);
    minimumY = Math.min(minimumY, entry.y);
    maximumX = Math.max(maximumX, entry.x);
    maximumY = Math.max(maximumY, entry.y);
    const signature = entrySignature(entry);
    frequencies.set(signature, (frequencies.get(signature) || 0) + 1);
  }
  if (!count) return { entries: [], bounds: options.frameBounds || null, truncated: false };
  const contentBounds = {
    x: minimumX,
    y: minimumY,
    width: maximumX - minimumX + 1,
    height: maximumY - minimumY + 1,
  };
  const bounds = options.frameBounds || contentBounds;
  if (count <= limit) return { entries: exact.sort(compareEntries), bounds, truncated: false };

  const grid = gridDimensions(bounds, limit);
  const samples = new Map();
  for (const key in cells) {
    if (!Object.prototype.hasOwnProperty.call(cells, key)) continue;
    const entry = parsedCellEntry(key, cells[key], options.offset);
    if (!entry) continue;
    if (options.frameBounds && (
      entry.x < options.frameBounds.x || entry.y < options.frameBounds.y ||
      entry.x >= options.frameBounds.x + options.frameBounds.width ||
      entry.y >= options.frameBounds.y + options.frameBounds.height
    )) continue;
    const rank = entrySampleRank(entry, bounds, grid, frequencies);
    const current = samples.get(rank.bin);
    const candidate = { entry, rank };
    if (!current || preferSample(candidate, current)) samples.set(rank.bin, candidate);
  }
  return {
    entries: [...samples.values()].map((sample) => sample.entry).sort(compareEntries),
    bounds,
    truncated: true,
  };
}

export function thumbnailFrameValue(clip, segment) {
  const exact = clip?.frameKeys?.[segment?.keyIndex];
  if (exact?.tick === segment?.sourceTick) return exact.value || {};
  let held = null;
  for (const key of clip?.frameKeys || []) {
    if (key.tick > Number(segment?.sourceTick)) break;
    held = key;
  }
  return held?.value || {};
}

function clipEndTick(clip) {
  return Number(clip?.startTick) + Math.max(1, Number(clip?.outTick) - Number(clip?.inTick));
}

// Partition only the visible clip span into bounded-width tiles; each midpoint tick
// chooses a stable frame while zoom changes the sample count.
export function buildFilmstripSamples(clip, visibleRange, pixelsPerTick, options = {}) {
  const clipStart = Number(clip?.startTick);
  const clipEnd = clipEndTick(clip);
  const rangeStart = Number(visibleRange?.startTick);
  const rangeEnd = Number(visibleRange?.endTick);
  const scale = Math.max(Number.EPSILON, Number(pixelsPerTick) || 1);
  if (![clipStart, clipEnd, rangeStart, rangeEnd].every(Number.isFinite)) return [];
  const startTick = Math.max(clipStart, rangeStart);
  const endTick = Math.min(clipEnd, rangeEnd);
  if (endTick <= startTick) return [];
  const pixelWidth = (endTick - startTick) * scale;
  const target = Math.max(1, Number(options.targetTileWidth) || TARGET_TILE_WIDTH);
  const minimum = Math.max(1, Number(options.minimumTileWidth) || MIN_TILE_WIDTH);
  const maximum = Math.max(minimum, Number(options.maximumTileWidth) || MAX_TILE_WIDTH);
  const cap = Math.max(1, Math.min(MAX_FILMSTRIP_SAMPLES,
    Math.floor(Number(options.maxSamples) || MAX_FILMSTRIP_SAMPLES)));
  const minimumCount = Math.max(1, Math.ceil(pixelWidth / maximum));
  const maximumCount = Math.max(1, Math.floor(pixelWidth / minimum));
  const preferred = Math.max(1, Math.round(pixelWidth / target));
  const count = Math.min(cap, minimumCount <= maximumCount
    ? Math.max(minimumCount, Math.min(maximumCount, preferred))
    : preferred);
  return Array.from({ length: count }, (_, index) => {
    const tileStart = startTick + (endTick - startTick) * index / count;
    const tileEnd = startTick + (endTick - startTick) * (index + 1) / count;
    const projectTick = Math.min(Math.ceil(endTick) - 1,
      Math.max(Math.floor(startTick), Math.floor((tileStart + tileEnd) / 2)));
    return {
      index,
      startTick: tileStart,
      endTick: tileEnd,
      projectTick,
      sourceTick: Number(clip.inTick) + projectTick - clipStart,
      pixelWidth: (tileEnd - tileStart) * scale,
    };
  });
}

export function buildFrameThumbnailModel(frameValue, options = {}) {
  const limit = Math.max(1, Math.min(MAX_MODEL_CELLS, Math.round(options.maxCells) || MAX_MODEL_CELLS));
  const frameWidth = Math.max(0, Math.floor(Number(options.frameWidth) || 0));
  const frameHeight = Math.max(0, Math.floor(Number(options.frameHeight) || 0));
  const frameBounds = frameWidth && frameHeight
    ? { x: 0, y: 0, width: frameWidth, height: frameHeight }
    : null;
  if (options.reference) {
    return { empty: false, reference: true, cells: [], bounds: frameBounds, truncated: false };
  }
  const offset = {
    x: Math.round(Number(options.offset?.x) || 0),
    y: Math.round(Number(options.offset?.y) || 0),
  };
  const { entries, bounds, truncated } = parsedCellEntries(frameValue?.cells, limit, {
    frameBounds,
    offset,
  });
  if (!entries.length) {
    return { empty: true, cells: [], bounds: frameBounds, truncated: false };
  }
  return {
    empty: false,
    cells: entries,
    bounds,
    truncated,
  };
}

function drawEmpty(context, width, height, colors) {
  context.fillStyle = colors.emptySurface;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = colors.emptyLine;
  context.beginPath();
  context.moveTo(0, height);
  context.lineTo(width, 0);
  context.stroke();
}

function drawReference(context, width, height, colors) {
  context.fillStyle = colors.referenceSurface;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = colors.referenceLine;
  context.strokeRect?.(1, 1, Math.max(0, width - 2), Math.max(0, height - 2));
  context.beginPath();
  context.moveTo(1, height - 1);
  context.lineTo(width - 1, 1);
  context.stroke();
  if (width >= 36) {
    context.fillStyle = colors.referenceText;
    context.font = `${Math.max(7, Math.floor(height * 0.24))}px monospace`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('VIDEO', width / 2, height / 2, width - 6);
  }
}

export function drawFrameThumbnail(node, model, options = {}) {
  const rect = node.getBoundingClientRect();
  const ratio = Math.max(1, Math.min(MAX_DEVICE_PIXEL_RATIO,
    Number(options.devicePixelRatio) || 1));
  const width = Math.max(1, Math.min(MAX_BACKING_WIDTH, Math.round(rect.width * ratio)));
  const height = Math.max(1, Math.min(MAX_BACKING_HEIGHT, Math.round(rect.height * ratio)));
  if (node.width !== width) node.width = width;
  if (node.height !== height) node.height = height;
  const context = node.getContext('2d');
  const colors = options.themeColors || readThemeColors(THUMBNAIL_THEME_PROPERTIES, node);
  context.clearRect(0, 0, width, height);
  if (model?.reference) {
    drawReference(context, width, height, colors);
    return { width, height, renderedCells: 0 };
  }
  if (!model || model.empty || !model.bounds) {
    drawEmpty(context, width, height, colors);
    return { width, height, renderedCells: 0 };
  }

  const bounds = model.bounds;
  const scale = Math.max(Number.EPSILON, Math.min(
    width / Math.max(1, bounds.width),
    height / Math.max(1, bounds.height * 2),
  ));
  const contentWidth = bounds.width * scale;
  const contentHeight = bounds.height * scale * 2;
  const offsetX = (width - contentWidth) / 2;
  const offsetY = (height - contentHeight) / 2;
  let renderedCells = 0;
  for (const { x, y, cell } of model.cells) {
    const left = offsetX + (x - bounds.x) * scale;
    const top = offsetY + (y - bounds.y) * scale * 2;
    const background = cell.bg || (options.backgroundChannel ? cell.fg : null);
    if (background) {
      context.fillStyle = background;
      context.fillRect(left, top, Math.ceil(scale), Math.ceil(scale * 2));
    }
    if (cell.c && !cell.cont) {
      context.fillStyle = cell.fg || '#ffffff';
      if (scale >= 5) {
        context.font = `${Math.max(7, Math.floor(scale * 1.75))}px ${options.fontFamily || 'monospace'}`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(cell.c, left + scale / 2, top + scale, scale * 1.8);
      } else {
        context.fillRect(left + scale * 0.22, top + scale * 0.3,
          Math.max(1, scale * 0.56), Math.max(1, scale * 1.4));
      }
    }
    renderedCells++;
  }
  return { width, height, renderedCells };
}

export function createFrameThumbnailAction(dependencies = {}) {
  const Observer = dependencies.ResizeObserver ?? globalThis.ResizeObserver;
  const devicePixelRatio = dependencies.devicePixelRatio ?? (() => globalThis.devicePixelRatio || 1);
  return function frameThumbnail(node, params) {
    let current = params || {};
    const themeColors = dependencies.themeColors?.(node) || readThemeColors(THUMBNAIL_THEME_PROPERTIES, node);
    const draw = () => drawFrameThumbnail(node, current.model, {
      backgroundChannel: current.backgroundChannel,
      fontFamily: current.fontFamily,
      devicePixelRatio: devicePixelRatio(),
      themeColors,
    });
    const observer = typeof Observer === 'function' ? new Observer(draw) : null;
    observer?.observe(node);
    draw();
    return {
      update(next) {
        current = next || {};
        draw();
      },
      destroy() {
        observer?.disconnect();
        const context = node.getContext?.('2d');
        context?.clearRect?.(0, 0, node.width || 0, node.height || 0);
      },
    };
  };
}

export const frameThumbnail = createFrameThumbnailAction();
export const FRAME_THUMBNAIL_LIMITS = Object.freeze({
  maxBackingWidth: MAX_BACKING_WIDTH,
  maxBackingHeight: MAX_BACKING_HEIGHT,
  maxModelCells: MAX_MODEL_CELLS,
  maxDevicePixelRatio: MAX_DEVICE_PIXEL_RATIO,
  targetTileWidth: TARGET_TILE_WIDTH,
  minimumTileWidth: MIN_TILE_WIDTH,
  maximumTileWidth: MAX_TILE_WIDTH,
  maxFilmstripSamples: MAX_FILMSTRIP_SAMPLES,
});
