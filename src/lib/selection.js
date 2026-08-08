import { writable, get } from 'svelte/store';
import {
  activeLayerId, activeLayerPart, layers, beginStroke, endStroke, cancelStroke, cellSelection,
  addLayer, effMaskOffset, effOffset, isEditingEffectMask, noteAuthoredMutation,
} from './grid.js';
import { cmClone, cmGet, cmSet, cmEntries } from './cellmap.js';
import { authoredEditsAllowed } from './playbackState.js';

export const selection = cellSelection;
export const selectMode = writable('new');
export const moveState = writable(null);

const MAX_TRANSFORM_SIZE = 256;
export const TRANSFORM_HANDLES = Object.freeze([
  'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w',
]);

export function key(x, y) { return `${x},${y}`; }
export function hasSelection() { return get(selection).size > 0; }
export function isSelected(x, y) {
  const selected = get(selection);
  return selected.size === 0 || selected.has(key(x, y));
}

export function clearSelection() {
  if (get(moveState)) cancelMove();
  selection.set(new Set());
}

export function selectionModeForModifiers(event = {}, fallback = get(selectMode)) {
  if (event.altKey) return 'sub';
  if (event.shiftKey) return 'add';
  return fallback;
}

export function applyRegion(cells, mode = get(selectMode)) {
  selection.update((previous) => {
    const next = mode === 'new' ? new Set() : new Set(previous);
    for (const { x, y } of cells) {
      const position = key(x, y);
      if (mode === 'sub') next.delete(position);
      else next.add(position);
    }
    return next;
  });
}

export function selectionBounds(selected) {
  if (!selected?.size) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const position of selected) {
    const [x, y] = position.split(',').map(Number);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

export function resizeTransformBounds(bounds, handle, pointerX, pointerY, minWidth = 1) {
  let left = bounds.x;
  let top = bounds.y;
  let right = bounds.x + bounds.w;
  let bottom = bounds.y + bounds.h;
  const x = Math.round(pointerX);
  const y = Math.round(pointerY);
  const minimumWidth = Math.max(1, Math.min(MAX_TRANSFORM_SIZE, Math.round(minWidth) || 1));
  if (handle.includes('w')) left = Math.max(right - MAX_TRANSFORM_SIZE, Math.min(x, right - minimumWidth));
  if (handle.includes('e')) right = Math.min(left + MAX_TRANSFORM_SIZE, Math.max(x, left + minimumWidth));
  if (handle.includes('n')) top = Math.max(bottom - MAX_TRANSFORM_SIZE, Math.min(y, bottom - 1));
  if (handle.includes('s')) bottom = Math.min(top + MAX_TRANSFORM_SIZE, Math.max(y, top + 1));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function sanitizedBounds(bounds) {
  return {
    x: Math.round(Number.isFinite(bounds.x) ? bounds.x : 0),
    y: Math.round(Number.isFinite(bounds.y) ? bounds.y : 0),
    w: Math.max(1, Math.min(MAX_TRANSFORM_SIZE, Math.round(bounds.w) || 1)),
    h: Math.max(1, Math.min(MAX_TRANSFORM_SIZE, Math.round(bounds.h) || 1)),
  };
}

export function transformBoundsFromDrag(
  bounds,
  handle,
  startPointer,
  currentPointer,
  minWidth = 1,
) {
  const source = sanitizedBounds(bounds || {});
  if (!startPointer || !currentPointer ||
    !Number.isFinite(startPointer.x) || !Number.isFinite(startPointer.y) ||
    !Number.isFinite(currentPointer.x) || !Number.isFinite(currentPointer.y)) {
    return source;
  }
  const dx = Math.round(currentPointer.x - startPointer.x);
  const dy = Math.round(currentPointer.y - startPointer.y);
  if (handle === 'body') return { ...source, x: source.x + dx, y: source.y + dy };
  if (!TRANSFORM_HANDLES.includes(handle)) return source;
  const pointerX = handle.includes('w') ? source.x + dx : source.x + source.w + dx;
  const pointerY = handle.includes('n') ? source.y + dy : source.y + source.h + dy;
  return resizeTransformBounds(source, handle, pointerX, pointerY, minWidth);
}

export function minimumTransformWidth(state) {
  if (!state || state.target === 'mask' || state.layerType === 'background') return 1;
  return state.lifted?.some((point) => point.cell?.cont) ? 2 : 1;
}

function roundedOffset($layers, layer, target = 'layer') {
  const offset = target === 'mask'
    ? effMaskOffset($layers, layer)
    : effOffset($layers, layer);
  return { x: Math.round(offset.x), y: Math.round(offset.y) };
}

function targetCells(layer, target) {
  return target === 'mask' ? (layer.mask?.cells || {}) : (layer.cells || {});
}

function clearGlyphCell(cells, x, y) {
  const cell = cmGet(cells, x, y);
  if (!cell) return;
  cmSet(cells, x, y, cell.bg != null ? { bg: cell.bg } : null);
}

function clearGlyphUnit(cells, x, y) {
  const cell = cmGet(cells, x, y);
  if (!cell) return;
  const left = cell.cont ? cmGet(cells, x - 1, y) : null;
  if (cell.cont && left && !left.cont) {
    clearGlyphCell(cells, x - 1, y);
    clearGlyphCell(cells, x, y);
    return;
  }
  if (!cell.cont && cmGet(cells, x + 1, y)?.cont) {
    clearGlyphCell(cells, x, y);
    clearGlyphCell(cells, x + 1, y);
    return;
  }
  clearGlyphCell(cells, x, y);
}

// Selections are world-space; capture converts them to target-local coordinates and
// expands partial wide glyphs into complete leader/continuation units.
function capturedSelection($layers, layer, selected, target = 'layer') {
  const offset = roundedOffset($layers, layer, target);
  const cells = targetCells(layer, target);
  const local = new Set();
  for (const position of selected) {
    const [x, y] = position.split(',').map(Number);
    local.add(key(x - offset.x, y - offset.y));
  }
  if (target === 'layer' && layer.type !== 'background') {
    for (const position of [...local]) {
      const [x, y] = position.split(',').map(Number);
      const cell = cmGet(cells, x, y);
      if (cell?.cont && cmGet(cells, x - 1, y)) local.add(key(x - 1, y));
      if (cell && !cell.cont && cmGet(cells, x + 1, y)?.cont) local.add(key(x + 1, y));
    }
  }
  const lifted = [];
  for (const position of local) {
    const [localX, localY] = position.split(',').map(Number);
    const cell = cmGet(cells, localX, localY);
    if (!cell) continue;
    lifted.push({
      x: localX + offset.x,
      y: localY + offset.y,
      localX,
      localY,
      cell: { ...cell },
    });
  }
  const selectionKeys = new Set([...local].map((position) => {
    const [x, y] = position.split(',').map(Number);
    return key(x + offset.x, y + offset.y);
  }));
  return { lifted, offset, selectionKeys };
}

function selectionTarget(layer, target) {
  if (target === 'mask') return !!layer.mask;
  return layer.type === 'cell' || layer.type === 'background';
}

function baseWithoutLifted(layer, target, lifted) {
  const base = cmClone(targetCells(layer, target));
  for (const point of lifted) {
    if (target === 'mask' || layer.type === 'background') cmSet(base, point.localX, point.localY, null);
    else clearGlyphUnit(base, point.localX, point.localY);
  }
  return base;
}

function sourceCellLookup(lifted) {
  return new Map(lifted.map((point) => [key(point.x, point.y), point]));
}

function makeState(source, target, captured, mode, hasCellSelection) {
  const sourceKeys = hasCellSelection
    ? captured.selectionKeys
    : new Set(captured.lifted.map((point) => key(point.x, point.y)));
  const sourceBounds = selectionBounds(sourceKeys);
  return {
    layerId: source.id,
    target,
    layerType: source.type,
    mode,
    hasCellSelection,
    offset: captured.offset,
    lifted: captured.lifted.map((point) => ({ ...point, cell: { ...point.cell } })),
    sourceKeys: new Set(sourceKeys),
    sourceBounds: { ...sourceBounds },
    bounds: { ...sourceBounds },
    baseCells: baseWithoutLifted(source, target, captured.lifted),
    dx: 0,
    dy: 0,
    preview: [],
  };
}

function mappedSelection(sourceKeys, sourceBounds, bounds) {
  const selected = new Set();
  for (let y = 0; y < bounds.h; y++) {
    const sourceY = sourceBounds.y + Math.min(sourceBounds.h - 1, Math.floor((y * sourceBounds.h) / bounds.h));
    for (let x = 0; x < bounds.w; x++) {
      const sourceX = sourceBounds.x + Math.min(sourceBounds.w - 1, Math.floor((x * sourceBounds.w) / bounds.w));
      if (sourceKeys.has(key(sourceX, sourceY))) selected.add(key(bounds.x + x, bounds.y + y));
    }
  }
  return selected;
}

// Nearest-neighbor resampling preserves the sparse selection mask; wide glyph pairs
// are rebuilt only from adjacent destination columns.
function transformedCells(state, bounds) {
  const lookup = sourceCellLookup(state.lifted);
  const output = [];
  const wideGroups = new Map();
  for (let y = 0; y < bounds.h; y++) {
    const sourceY = state.sourceBounds.y + Math.min(
      state.sourceBounds.h - 1,
      Math.floor((y * state.sourceBounds.h) / bounds.h),
    );
    for (let x = 0; x < bounds.w; x++) {
      const sourceX = state.sourceBounds.x + Math.min(
        state.sourceBounds.w - 1,
        Math.floor((x * state.sourceBounds.w) / bounds.w),
      );
      if (!state.sourceKeys.has(key(sourceX, sourceY))) continue;
      const point = lookup.get(key(sourceX, sourceY));
      if (!point) continue;
      const destination = { x: bounds.x + x, y: bounds.y + y, cell: { ...point.cell } };
      if (state.target === 'mask' || state.layerType === 'background') {
        output.push(destination);
        continue;
      }
      const leftPoint = point.cell.cont ? lookup.get(key(sourceX - 1, sourceY)) : point;
      const rightPoint = leftPoint && !leftPoint.cell.cont
        ? lookup.get(key(leftPoint.x + 1, leftPoint.y))
        : null;
      if (leftPoint && rightPoint?.cell.cont) {
        const groupKey = key(leftPoint.x, leftPoint.y) + ':' + destination.y;
        const group = wideGroups.get(groupKey) || {
          primary: { ...leftPoint.cell },
          continuation: { ...rightPoint.cell },
          xs: new Set(),
          y: destination.y,
        };
        group.xs.add(destination.x);
        wideGroups.set(groupKey, group);
      } else if (!point.cell.cont) {
        output.push(destination);
      }
    }
  }
  for (const group of wideGroups.values()) {
    const xs = [...group.xs].sort((a, b) => a - b);
    let start = 0;
    while (start < xs.length) {
      let end = start + 1;
      while (end < xs.length && xs[end] === xs[end - 1] + 1) end++;
      for (let index = start; index + 1 < end; index += 2) {
        output.push({ x: xs[index], y: group.y, cell: { ...group.primary, cont: false } });
        output.push({ x: xs[index + 1], y: group.y, cell: { ...group.continuation, cont: true } });
      }
      start = end;
    }
  }
  return output;
}

function stampCells(state, output) {
  const cells = cmClone(state.baseCells);
  if (state.target === 'mask' || state.layerType === 'background') {
    for (const point of output) {
      cmSet(cells, point.x - state.offset.x, point.y - state.offset.y, { ...point.cell });
    }
    return cells;
  }
  for (const point of output) clearGlyphUnit(cells, point.x - state.offset.x, point.y - state.offset.y);
  for (const point of output) {
    const x = point.x - state.offset.x;
    const y = point.y - state.offset.y;
    const background = cmGet(cells, x, y)?.bg ?? point.cell.bg ?? null;
    cmSet(cells, x, y, { ...point.cell, bg: background });
  }
  return cells;
}

function renderState(state, nextBounds, recordMutation = true) {
  if (!authoredEditsAllowed()) return false;
  const bounds = sanitizedBounds(nextBounds);
  bounds.w = Math.max(bounds.w, minimumTransformWidth(state));
  const preview = transformedCells(state, bounds);
  const cells = stampCells(state, preview);
  layers.update(($layers) => $layers.map((layer) => {
    if (layer.id !== state.layerId) return layer;
    if (state.target === 'mask') return { ...layer, mask: { ...layer.mask, cells } };
    return { ...layer, cells };
  }));
  if (recordMutation) noteAuthoredMutation();
  if (state.hasCellSelection) selection.set(mappedSelection(state.sourceKeys, state.sourceBounds, bounds));
  const next = {
    ...state,
    bounds,
    dx: bounds.x - state.sourceBounds.x,
    dy: bounds.y - state.sourceBounds.y,
    preview,
  };
  moveState.set(next);
  return next;
}

function startSelectionTransaction(mode) {
  if (!authoredEditsAllowed()) return false;
  if (get(moveState)) finalizeMove();
  if (!hasSelection()) return false;
  const id = get(activeLayerId);
  const $layers = get(layers);
  const source = $layers.find((layer) => layer.id === id);
  if (!source) return false;
  const target = isEditingEffectMask(source) ? 'mask' : 'layer';
  if (!selectionTarget(source, target)) {
    selection.set(new Set());
    return false;
  }
  const captured = capturedSelection($layers, source, get(selection), target);
  if (!captured.lifted.length || !captured.selectionKeys.size) return false;
  beginStroke();
  const state = makeState(source, target, captured, mode, true);
  renderState(state, state.sourceBounds, false);
  return true;
}

export function beginMove() {
  return startSelectionTransaction('move');
}

export function beginTransformSelection() {
  return startSelectionTransaction('transform');
}

export function canMoveLayerTarget(layer, target = 'layer') {
  let cells = null;
  if (target === 'mask') {
    if (layer?.type === 'effect' && layer.mask) cells = layer.mask.cells;
  } else if (target === 'layer' && (layer?.type === 'cell' || layer?.type === 'background')) {
    cells = layer.cells;
  }
  return cmEntries(cells || {}).some((entry) => !!entry.cell);
}

export function beginLayerMove() {
  if (!authoredEditsAllowed()) return false;
  if (get(moveState)) finalizeMove();
  const id = get(activeLayerId);
  const $layers = get(layers);
  const source = $layers.find((layer) => layer.id === id);
  const target = isEditingEffectMask(source) ? 'mask' : 'layer';
  if (!canMoveLayerTarget(source, target)) return false;
  const offset = roundedOffset($layers, source, target);
  const lifted = cmEntries(targetCells(source, target))
    .filter((entry) => entry.cell)
    .map((entry) => ({
      x: entry.x + offset.x,
      y: entry.y + offset.y,
      localX: entry.x,
      localY: entry.y,
      cell: { ...entry.cell },
    }));
  if (!lifted.length) return false;
  beginStroke();
  const state = makeState(source, target, {
    lifted,
    offset,
    selectionKeys: new Set(lifted.map((point) => key(point.x, point.y))),
  }, 'move', false);
  renderState(state, state.sourceBounds, false);
  return true;
}

function sameBounds(first, second) {
  return !!first && !!second &&
    first.x === second.x && first.y === second.y &&
    first.w === second.w && first.h === second.h;
}

export function updateMove(dx, dy) {
  if (!authoredEditsAllowed()) return false;
  const current = get(moveState);
  if (!current) return;
  const bounds = {
    ...current.bounds,
    x: current.sourceBounds.x + Math.round(dx),
    y: current.sourceBounds.y + Math.round(dy),
  };
  if (!sameBounds(bounds, current.bounds)) renderState(current, bounds);
}

export function updateTransformBounds(bounds) {
  if (!authoredEditsAllowed()) return false;
  const current = get(moveState);
  if (!current || current.mode !== 'transform') return;
  const next = sanitizedBounds(bounds);
  next.w = Math.max(next.w, minimumTransformWidth(current));
  if (!sameBounds(next, current.bounds)) renderState(current, next);
}

activeLayerId.subscribe((id) => {
  const current = get(moveState);
  if (current && current.layerId !== id) finalizeMove();
  const layer = get(layers).find((candidate) => candidate.id === id);
  const target = layer && isEditingEffectMask(layer) ? 'mask' : 'layer';
  if ((!layer || !selectionTarget(layer, target)) && get(selection).size) selection.set(new Set());
});
activeLayerPart.subscribe((part) => {
  const current = get(moveState);
  if (current && (current.target === 'mask') !== (part === 'mask')) finalizeMove();
  const layer = get(layers).find((candidate) => candidate.id === get(activeLayerId));
  const target = part === 'mask' ? 'mask' : 'layer';
  if ((!layer || !selectionTarget(layer, target)) && get(selection).size) selection.set(new Set());
});
if (typeof window !== 'undefined') {
  window.addEventListener('commit-move', () => {
    if (get(moveState)) finalizeMove();
  });
}

export function finalizeMove() {
  if (!authoredEditsAllowed()) return false;
  const current = get(moveState);
  if (!current) return;
  if (sameBounds(current.bounds, current.sourceBounds)) {
    cancelStroke();
    moveState.set(null);
    return;
  }
  endStroke();
  moveState.set(null);
}

export function selectionToNewLayer(cut = false) {
  if (!authoredEditsAllowed()) return false;
  if (get(moveState)) finalizeMove();
  if (!hasSelection()) return null;
  const id = get(activeLayerId);
  const $layers = get(layers);
  const source = $layers.find((layer) => layer.id === id);
  const target = source && isEditingEffectMask(source) ? 'mask' : 'layer';
  if (!source || target === 'mask' || !selectionTarget(source, target)) {
    selection.set(new Set());
    return null;
  }
  const captured = capturedSelection($layers, source, get(selection));
  if (!captured.lifted.length) return null;
  const type = source.type === 'background' ? 'background' : 'cell';
  addLayer(type);
  const newId = get(activeLayerId);
  const createdLayer = get(layers).find((layer) => layer.id === newId);
  const createdOffset = effOffset(get(layers), createdLayer);
  const cells = {};
  for (const point of captured.lifted) {
    cmSet(
      cells,
      point.x - Math.round(createdOffset.x),
      point.y - Math.round(createdOffset.y),
      { ...point.cell },
    );
  }
  layers.update(($layers) => $layers.map((layer) => {
    if (layer.id === newId) return { ...layer, cells };
    if (!cut || layer.id !== id) return layer;
    const sourceCells = cmClone(layer.cells);
    for (const point of captured.lifted) {
      if (layer.type === 'background') cmSet(sourceCells, point.localX, point.localY, null);
      else clearGlyphUnit(sourceCells, point.localX, point.localY);
    }
    return { ...layer, cells: sourceCells };
  }));
  selection.set(captured.selectionKeys);
  return newId;
}

export function cancelMove() {
  if (!get(moveState)) return;
  cancelStroke();
  moveState.set(null);
}
