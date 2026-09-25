import { writable, get } from 'svelte/store';
import {
  activeLayerId, activeLayerPart, layers, beginStroke, endStroke, cancelStroke, cellSelection,
  addLayer, effContentMaskOffset, effMaskOffset, effOffset, isEditingContentMask, isEditingEffectMask, noteAuthoredMutation,
} from './grid.js';
import { cmClone, cmGet, cmSet, cmEntries } from './cellmap.js';
import { authoredEditsAllowed } from './playbackState.js';
import type {
  EditorBounds,
  EditorCell,
  EditorCellMap,
  EditorCellUpdate,
  EditorEffectLayer,
  EditorLayer,
  EditorPoint,
  EditorPointerModifiers,
} from './types/editor-domain.js';

type SelectionMode = 'new' | 'add' | 'sub';
type SelectionTarget = 'layer' | 'mask' | 'content-mask';
type SelectionMoveMode = 'move' | 'transform';
type TransformHandle = 'body' | typeof TRANSFORM_HANDLES[number];

interface LiftedCell extends EditorCellUpdate {
  cell: EditorCell;
  localX: number;
  localY: number;
}

interface CapturedSelection {
  lifted: LiftedCell[];
  offset: EditorPoint;
  selectionKeys: Set<string>;
}

interface SelectionMoveState {
  layerId: string;
  target: SelectionTarget;
  layerType: EditorLayer['type'];
  mode: SelectionMoveMode;
  hasCellSelection: boolean;
  offset: EditorPoint;
  lifted: LiftedCell[];
  sourceKeys: Set<string>;
  sourceBounds: EditorBounds;
  bounds: EditorBounds;
  baseCells: EditorCellMap;
  dx: number;
  dy: number;
  preview: EditorCellUpdate[];
}

export const selection = cellSelection;
export const selectMode = writable<SelectionMode>('new');
export const moveState = writable<SelectionMoveState | null>(null);

const MAX_TRANSFORM_SIZE = 256;
export const TRANSFORM_HANDLES = Object.freeze([
  'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w',
]);

export function key(x: number, y: number): string { return `${x},${y}`; }
export function hasSelection(): boolean { return get(selection).size > 0; }
export function isSelected(x: number, y: number): boolean {
  const selected = get(selection);
  return selected.size === 0 || selected.has(key(x, y));
}

export function clearSelection(): void {
  if (get(moveState)) cancelMove();
  selection.set(new Set());
}

export function selectionModeForModifiers(
  event: EditorPointerModifiers = {},
  fallback: SelectionMode = get(selectMode),
): SelectionMode {
  if (event.altKey) return 'sub';
  if (event.shiftKey) return 'add';
  return fallback;
}

export function applyRegion(cells: EditorPoint[], mode: SelectionMode = get(selectMode)): void {
  selection.update((previous) => {
    const next = mode === 'new' ? new Set<string>() : new Set(previous);
    for (const { x, y } of cells) {
      const position = key(x, y);
      if (mode === 'sub') next.delete(position);
      else next.add(position);
    }
    return next;
  });
}

export function selectionBounds(selected: Set<string> | null | undefined): EditorBounds | null {
  if (!selected?.size) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const position of selected) {
    const [x, y] = position.split(',').map(Number) as [number, number];
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

export function resizeTransformBounds(
  bounds: EditorBounds,
  handle: TransformHandle,
  pointerX: number,
  pointerY: number,
  minWidth = 1,
): EditorBounds {
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

function sanitizedBounds(bounds: Partial<EditorBounds>): EditorBounds {
  const x = bounds.x;
  const y = bounds.y;
  const w = bounds.w;
  const h = bounds.h;
  return {
    x: Math.round(typeof x === 'number' && Number.isFinite(x) ? x : 0),
    y: Math.round(typeof y === 'number' && Number.isFinite(y) ? y : 0),
    w: Math.max(1, Math.min(MAX_TRANSFORM_SIZE, Math.round(w ?? 0) || 1)),
    h: Math.max(1, Math.min(MAX_TRANSFORM_SIZE, Math.round(h ?? 0) || 1)),
  };
}

export function transformBoundsFromDrag(
  bounds: Partial<EditorBounds> | null | undefined,
  handle: TransformHandle,
  startPointer: EditorPoint | null | undefined,
  currentPointer: EditorPoint | null | undefined,
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

export function minimumTransformWidth(state: SelectionMoveState | null | undefined): number {
  if (!state || state.target !== 'layer' || state.layerType === 'background') return 1;
  return state.lifted?.some((point) => point.cell?.cont) ? 2 : 1;
}

function roundedOffset($layers: EditorLayer[], layer: EditorLayer, target: SelectionTarget = 'layer'): EditorPoint {
  const offset = target === 'mask'
    ? effMaskOffset($layers, layer)
    : target === 'content-mask'
      ? effContentMaskOffset($layers, layer)
    : effOffset($layers, layer);
  return { x: Math.round(offset.x), y: Math.round(offset.y) };
}

function targetCells(layer: EditorLayer, target: SelectionTarget): EditorCellMap {
  if (target === 'layer') return layer.cells || {};
  if (target === 'mask' && layer.type === 'effect' && layer.mask) return layer.mask.cells || {};
  return layer.contentMask?.cells || {};
}

function clearGlyphCell(cells: EditorCellMap, x: number, y: number): void {
  const cell = cmGet(cells, x, y);
  if (!cell) return;
  cmSet(cells, x, y, cell.bg != null ? { bg: cell.bg } : null);
}

function clearGlyphUnit(cells: EditorCellMap, x: number, y: number): void {
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
function capturedSelection(
  $layers: EditorLayer[],
  layer: EditorLayer,
  selected: Set<string>,
  target: SelectionTarget = 'layer',
): CapturedSelection {
  const offset = roundedOffset($layers, layer, target);
  const cells = targetCells(layer, target);
  const local = new Set<string>();
  for (const position of selected) {
    const [x, y] = position.split(',').map(Number) as [number, number];
    local.add(key(x - offset.x, y - offset.y));
  }
  if (target === 'layer' && layer.type !== 'background') {
    for (const position of [...local]) {
      const [x, y] = position.split(',').map(Number) as [number, number];
      const cell = cmGet(cells, x, y);
      if (cell?.cont && cmGet(cells, x - 1, y)) local.add(key(x - 1, y));
      if (cell && !cell.cont && cmGet(cells, x + 1, y)?.cont) local.add(key(x + 1, y));
    }
  }
  const lifted: LiftedCell[] = [];
  for (const position of local) {
    const [localX, localY] = position.split(',').map(Number) as [number, number];
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
    const [x, y] = position.split(',').map(Number) as [number, number];
    return key(x + offset.x, y + offset.y);
  }));
  return { lifted, offset, selectionKeys };
}

function selectionTarget(layer: EditorLayer, target: SelectionTarget): boolean {
  if (target === 'mask') return layer.type === 'effect' && !!layer.mask;
  if (target === 'content-mask') return !!layer.contentMask;
  return layer.type === 'cell' || layer.type === 'background';
}

function baseWithoutLifted(layer: EditorLayer, target: SelectionTarget, lifted: LiftedCell[]): EditorCellMap {
  const base = cmClone(targetCells(layer, target));
  for (const point of lifted) {
    if (target !== 'layer' || layer.type === 'background') cmSet(base, point.localX, point.localY, null);
    else clearGlyphUnit(base, point.localX, point.localY);
  }
  return base;
}

function sourceCellLookup(lifted: LiftedCell[]): Map<string, LiftedCell> {
  return new Map(lifted.map((point) => [key(point.x, point.y), point]));
}

function makeState(
  source: EditorLayer,
  target: SelectionTarget,
  captured: CapturedSelection,
  mode: SelectionMoveMode,
  hasCellSelection: boolean,
): SelectionMoveState {
  const sourceKeys = hasCellSelection
    ? captured.selectionKeys
    : new Set(captured.lifted.map((point) => key(point.x, point.y)));
  const sourceBounds = selectionBounds(sourceKeys)!;
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

function mappedSelection(sourceKeys: Set<string>, sourceBounds: EditorBounds, bounds: EditorBounds): Set<string> {
  const selected = new Set<string>();
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
function transformedCells(state: SelectionMoveState, bounds: EditorBounds): EditorCellUpdate[] {
  const lookup = sourceCellLookup(state.lifted);
  const output: EditorCellUpdate[] = [];
  const wideGroups = new Map<string, {
    primary: EditorCell;
    continuation: EditorCell;
    xs: Set<number>;
    y: number;
  }>();
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
      if (state.target !== 'layer' || state.layerType === 'background') {
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
          xs: new Set<number>(),
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
      while (end < xs.length && xs[end] === xs[end - 1]! + 1) end++;
      for (let index = start; index + 1 < end; index += 2) {
        output.push({ x: xs[index]!, y: group.y, cell: { ...group.primary, cont: false } });
        output.push({ x: xs[index + 1]!, y: group.y, cell: { ...group.continuation, cont: true } });
      }
      start = end;
    }
  }
  return output;
}

function stampCells(state: SelectionMoveState, output: EditorCellUpdate[]): EditorCellMap {
  const cells = cmClone(state.baseCells);
  if (state.target !== 'layer' || state.layerType === 'background') {
    for (const point of output) {
      cmSet(cells, point.x - state.offset.x, point.y - state.offset.y, { ...point.cell });
    }
    return cells;
  }
  for (const point of output) clearGlyphUnit(cells, point.x - state.offset.x, point.y - state.offset.y);
  for (const point of output) {
    const x = point.x - state.offset.x;
    const y = point.y - state.offset.y;
    const background = cmGet(cells, x, y)?.bg ?? point.cell?.bg ?? null;
    cmSet(cells, x, y, { ...point.cell, bg: background });
  }
  return cells;
}

function renderState(
  state: SelectionMoveState,
  nextBounds: Partial<EditorBounds>,
  recordMutation = true,
): SelectionMoveState | false {
  if (!authoredEditsAllowed()) return false;
  const bounds = sanitizedBounds(nextBounds);
  bounds.w = Math.max(bounds.w, minimumTransformWidth(state));
  const preview = transformedCells(state, bounds);
  const cells = stampCells(state, preview);
  layers.update(($layers) => $layers.map((layer) => {
    if (layer.id !== state.layerId) return layer;
    if (state.target === 'mask') {
      if (layer.type === 'effect' && layer.mask) {
        const effectLayer = layer as EditorEffectLayer;
        return { ...effectLayer, mask: { ...effectLayer.mask!, cells } };
      }
    }
    if (state.target === 'content-mask') return { ...layer, contentMask: { ...layer.contentMask!, cells } };
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

function startSelectionTransaction(mode: SelectionMoveMode): boolean {
  if (!authoredEditsAllowed()) return false;
  if (get(moveState)) finalizeMove();
  if (!hasSelection()) return false;
  const id = get(activeLayerId);
  const $layers = get(layers);
  const source = $layers.find((layer) => layer.id === id);
  if (!source) return false;
  const target = isEditingEffectMask(source) ? 'mask' : isEditingContentMask(source) ? 'content-mask' : 'layer';
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

export function beginMove(): boolean {
  return startSelectionTransaction('move');
}

export function beginTransformSelection(): boolean {
  return startSelectionTransaction('transform');
}

export function canMoveLayerTarget(layer: EditorLayer | null | undefined, target: SelectionTarget = 'layer'): boolean {
  let cells: EditorCellMap | null = null;
  if (target === 'mask') {
    if (layer?.type === 'effect' && layer.mask) cells = layer.mask.cells;
  } else if (target === 'content-mask') {
    if (layer?.contentMask) cells = layer.contentMask.cells;
  } else if (target === 'layer' && (layer?.type === 'cell' || layer?.type === 'background')) {
    cells = layer.cells;
  }
  return cmEntries(cells || {}).some((entry) => !!entry.cell);
}

export function beginLayerMove(): boolean {
  if (!authoredEditsAllowed()) return false;
  if (get(moveState)) finalizeMove();
  const id = get(activeLayerId);
  const $layers = get(layers);
  const source = $layers.find((layer) => layer.id === id);
  const target = isEditingEffectMask(source) ? 'mask' : isEditingContentMask(source) ? 'content-mask' : 'layer';
  if (!canMoveLayerTarget(source, target)) return false;
  const active = source!;
  const offset = roundedOffset($layers, active, target);
  const lifted: LiftedCell[] = cmEntries(targetCells(active, target))
    .filter((entry) => entry.cell)
    .map((entry) => ({
      x: entry.x + offset.x,
      y: entry.y + offset.y,
      localX: entry.x,
      localY: entry.y,
      cell: { ...entry.cell! },
    }));
  if (!lifted.length) return false;
  beginStroke();
  const state = makeState(active, target, {
    lifted,
    offset,
    selectionKeys: new Set(lifted.map((point) => key(point.x, point.y))),
  }, 'move', false);
  renderState(state, state.sourceBounds, false);
  return true;
}

function sameBounds(first: EditorBounds | null | undefined, second: EditorBounds | null | undefined): boolean {
  return !!first && !!second &&
    first.x === second.x && first.y === second.y &&
    first.w === second.w && first.h === second.h;
}

export function updateMove(dx: number, dy: number): false | void {
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

export function updateTransformBounds(bounds: Partial<EditorBounds>): false | void {
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
  const target = layer && isEditingEffectMask(layer) ? 'mask' : layer && isEditingContentMask(layer) ? 'content-mask' : 'layer';
  if ((!layer || !selectionTarget(layer, target)) && get(selection).size) selection.set(new Set());
});
activeLayerPart.subscribe((part) => {
  const current = get(moveState);
  const expected = part === 'mask' ? 'mask' : part === 'content-mask' ? 'content-mask' : 'layer';
  if (current && current.target !== expected) finalizeMove();
  const layer = get(layers).find((candidate) => candidate.id === get(activeLayerId));
  const target = expected;
  if ((!layer || !selectionTarget(layer, target)) && get(selection).size) selection.set(new Set());
});
if (typeof window !== 'undefined') {
  window.addEventListener('commit-move', () => {
    if (get(moveState)) finalizeMove();
  });
}

export function finalizeMove(): false | void {
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

export function selectionToNewLayer(cut = false): string | null | false {
  if (!authoredEditsAllowed()) return false;
  if (get(moveState)) finalizeMove();
  if (!hasSelection()) return null;
  const id = get(activeLayerId);
  const $layers = get(layers);
  const source = $layers.find((layer) => layer.id === id);
  const target = source && isEditingEffectMask(source) ? 'mask' : source && isEditingContentMask(source) ? 'content-mask' : 'layer';
  if (!source || target !== 'layer' || !selectionTarget(source, target)) {
    selection.set(new Set());
    return null;
  }
  const captured = capturedSelection($layers, source, get(selection));
  if (!captured.lifted.length) return null;
  const type = source.type === 'background' ? 'background' : 'cell';
  addLayer(type);
  const newId = get(activeLayerId);
  const createdLayer = get(layers).find((layer) => layer.id === newId);
  const createdOffset = effOffset(get(layers), createdLayer!);
  const cells: EditorCellMap = {};
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

export function cancelMove(): void {
  if (!get(moveState)) return;
  cancelStroke();
  moveState.set(null);
}
