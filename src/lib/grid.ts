import { writable, derived, get } from 'svelte/store';
import { cmGet, cmSet, cmClone, cmTranslate, cmParse, cmFromGrid } from './cellmap.js';
import { blendHex } from './color.js';
import { applyColorClipToGrid, applyEffectToGrid, colorLuminance } from './effects.js';
import { authoredEditsAllowed } from './playbackState.js';
import {
  MIN_VIDEO_CLIP_SECONDS,
  normalizeVideoClip,
} from './video.js';
import { mediaAssetById } from './mediaRegistry.js';
import { assertUuid, newUuid } from './uuid.js';
import { defaultProjectDraft } from './projectPresets.js';
import { layerDeleteClosure } from './layerActions.js';
import type {
  EditorBounds,
  EditorCell,
  EditorCellGrid,
  EditorCellMap,
  EditorCellUpdate,
  EditorCellValue,
  EditorEffect,
  EditorEffectLayer,
  EditorGroupLayer,
  EditorLayer,
  EditorLayerPart,
  EditorPoint,
  EditorRasterSource,
  EditorShape,
  EditorShapeLayer,
  EditorSize,
  EditorTextRun,
  EditorVideoClip,
} from './types/editor-domain.js';

type PaintLayerType = 'cell' | 'background' | 'effect' | 'color-clip';
type RenderText = (
  text: string,
  box: EditorBounds,
  fg: string,
  wrap: boolean,
  runs: EditorTextRun[],
) => EditorCellMap | EditorCellGrid;
type RenderShape = (shape: EditorShape) => EditorCellMap | EditorCellGrid;
type OptionalLayerId<T> = T extends EditorLayer
  ? Omit<T, 'id' | 'visible' | 'cells'> & {
    id?: string | undefined;
    srcId?: string | undefined;
    visible?: boolean | undefined;
    cells?: EditorCellMap | undefined;
  }
  : never;
type EditorLayerDefinition = OptionalLayerId<EditorLayer>;

interface CompositeOptions {
  referenceOpacity?: boolean | undefined;
}

interface CoverageChannels {
  fg?: boolean | undefined;
  bg?: boolean | undefined;
}

type CoverageGrid = Array<Array<CoverageChannels | null>>;

const initialProjectDraft = defaultProjectDraft();
export const dims = writable<EditorSize>({
  w: initialProjectDraft.columns,
  h: initialProjectDraft.rows,
});
export const cropPending = writable<EditorBounds | null>(null);
export let GRID_W = initialProjectDraft.columns;
export let GRID_H = initialProjectDraft.rows;
dims.subscribe(({ w, h }) => { GRID_W = w; GRID_H = h; });

let nextLayerNumber = 1;
let nextGroupNumber = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function nextLayerName(): string {
  return 'Layer ' + nextLayerNumber++;
}
function nextGroupName(): string {
  return 'Group ' + nextGroupNumber++;
}
function syncLayerNameCounters(stack: EditorLayer[]): void {
  nextLayerNumber = Math.max(0, ...stack.map((layer) => {
    if (layer.type === 'group') return 0;
    const match = /^Layer (\d+)$/.exec(layer.name || '');
    return match ? +match[1]! : 0;
  })) + 1;
  nextGroupNumber = Math.max(0, ...stack.map((layer) => {
    if (layer.type !== 'group') return 0;
    const match = /^Group (\d+)$/.exec(layer.name || '');
    return match ? +match[1]! : 0;
  })) + 1;
}
function makeLayer(name: string, type: PaintLayerType = 'cell'): EditorLayer {
  if (type === 'effect') {
    return {
      id: newUuid('layer'), name, type, visible: true, cells: {},
      effect: { kind: 'brightness', intensity: 0.25 },
      mask: { defaultStrength: 1, cells: {}, offset: { x: 0, y: 0 } },
    };
  }
  if (type === 'color-clip') {
    return {
      id: newUuid('layer'), name, type: 'effect', visible: true, cells: {},
      effect: { kind: 'color-clip', intensity: 1 },
      clipped: true,
    };
  }
  return { id: newUuid('layer'), name, type, visible: true, cells: {} };
}

function sameShallowObject(left: object | null | undefined, right: object | null | undefined): boolean {
  const leftRecord = (left || {}) as Record<string, unknown>;
  const rightRecord = (right || {}) as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.is(leftRecord[key], rightRecord[key]));
}

function seedLayers(): EditorLayer[] {
  return [makeLayer(nextLayerName())];
}

export const layers = writable<EditorLayer[]>(seedLayers());
export const activeLayerId = writable<string | null>(get(layers)[0]!.id);
export const activeLayerPart = writable<EditorLayerPart>('layer');
export const selectedLayerIds = writable<Set<string>>(new Set([get(layers)[0]!.id]));
export const cellSelection = writable<Set<string>>(new Set());

const layerStackEmptyHandlers = new Set<() => void>();
const effectMaskChangeHandlers = new Set<(id: string, present: boolean) => void>();
const authoredMutationSettledHandlers = new Set<() => void>();
const authoredContentRevertedHandlers = new Set<() => void>();
const shapeRasterizeHandlers = new Set<(ids: Set<string>) => void>();
let authoredMutationSettlementScheduled = false;

export function registerLayerStackEmptyHandler(handler: () => void): () => boolean {
  layerStackEmptyHandlers.add(handler);
  return () => layerStackEmptyHandlers.delete(handler);
}

export function registerEffectMaskChangeHandler(handler: (id: string, present: boolean) => void): () => boolean {
  effectMaskChangeHandlers.add(handler);
  return () => effectMaskChangeHandlers.delete(handler);
}

export function registerAuthoredMutationSettledHandler(handler: () => void): () => boolean {
  authoredMutationSettledHandlers.add(handler);
  return () => authoredMutationSettledHandlers.delete(handler);
}

export function registerAuthoredContentRevertedHandler(handler: () => void): () => boolean {
  authoredContentRevertedHandlers.add(handler);
  return () => authoredContentRevertedHandlers.delete(handler);
}

export function registerShapeRasterizeHandler(handler: (ids: Set<string>) => void): () => boolean {
  shapeRasterizeHandlers.add(handler);
  return () => shapeRasterizeHandlers.delete(handler);
}

function notifyAuthoredContentReverted(): void {
  for (const handler of authoredContentRevertedHandlers) handler();
}

function scheduleAuthoredMutationSettlement(): void {
  if (authoredMutationSettlementScheduled) return;
  authoredMutationSettlementScheduled = true;
  queueMicrotask(() => {
    authoredMutationSettlementScheduled = false;
    for (const handler of authoredMutationSettledHandlers) handler();
  });
}

function notifyLayerStackEmpty(): void { for (const handler of layerStackEmptyHandlers) handler(); }
function notifyEffectMaskChanged(id: string, present: boolean): void {
  for (const handler of effectMaskChangeHandlers) handler(id, present);
}
function notifyShapeRasterize(ids: Set<string>): void {
  for (const handler of shapeRasterizeHandlers) handler(ids);
}

export function cloneLayers(ls: EditorLayer[]): EditorLayer[] {
  return ls.map((layer): EditorLayer => {
    if (layer.type === 'video') {
      const { raster, videoElement, videoBlob, videoURL, runtimeMediaKey, ...durable } = layer;
      return { ...durable, cells: cmClone(layer.cells) };
    }
    if (layer.type === 'image') {
      const { raster, runtimeMediaKey, ...durable } = layer;
      return { ...durable, cells: cmClone(layer.cells) };
    }
    if (layer.type === 'text') {
      return {
        ...layer,
        cells: cmClone(layer.cells),
        runs: layer.runs.map((run) => ({ ...run })),
        contentMask: layer.contentMask
          ? {
            ...layer.contentMask,
            cells: cmClone(layer.contentMask.cells || {}),
            offset: { x: layer.contentMask.offset?.x || 0, y: layer.contentMask.offset?.y || 0 },
          }
          : layer.contentMask,
      };
    }
    if (layer.type === 'effect') {
      return {
        ...layer,
        cells: cmClone(layer.cells),
        effect: layer.effect ? { ...layer.effect } : layer.effect,
        mask: layer.mask
          ? {
            ...layer.mask,
            cells: cmClone(layer.mask.cells || {}),
            offset: { x: layer.mask.offset?.x || 0, y: layer.mask.offset?.y || 0 },
          }
          : layer.mask,
        contentMask: layer.contentMask
          ? {
            ...layer.contentMask,
            cells: cmClone(layer.contentMask.cells || {}),
            offset: { x: layer.contentMask.offset?.x || 0, y: layer.contentMask.offset?.y || 0 },
          }
          : layer.contentMask,
      };
    }
    return {
      ...layer,
      cells: cmClone(layer.cells),
      contentMask: layer.contentMask
        ? {
          ...layer.contentMask,
          cells: cmClone(layer.contentMask.cells || {}),
          offset: { x: layer.contentMask.offset?.x || 0, y: layer.contentMask.offset?.y || 0 },
        }
        : layer.contentMask,
    };
  });
}

// History restores durable data but reuses runtime media only when the current asset
// generation still matches the snapshot's reference.
function retainedLayerRuntime(snapshotLayer: EditorLayer, liveLayer: EditorLayer | undefined): Partial<EditorLayer> {
  if (!liveLayer || snapshotLayer.type !== liveLayer.type ||
    (snapshotLayer.type !== 'image' && snapshotLayer.type !== 'video')) return {};
  const snapshotAssetId = snapshotLayer.type === 'image'
    ? snapshotLayer.assetId
    : snapshotLayer.videoClip?.assetId;
  const liveAssetId = snapshotLayer.type === 'image'
    ? (liveLayer as Extract<EditorLayer, { type: 'image' }>).assetId
    : (liveLayer as Extract<EditorLayer, { type: 'video' }>).videoClip?.assetId;
  if (snapshotAssetId !== liveAssetId) return {};
  if (snapshotAssetId) {
    const asset = mediaAssetById(snapshotAssetId);
    const expectedKey = asset
      ? `${asset.assetId}:${asset.hash}:${asset.generation}`
      : null;
    if (!expectedKey || (liveLayer as Extract<EditorLayer, { type: 'image' | 'video' }>).runtimeMediaKey !== expectedKey) return {};
  } else if ((liveLayer as Extract<EditorLayer, { type: 'image' | 'video' }>).runtimeMediaKey) {
    return {};
  }
  const runtime: Record<string, unknown> = {};
  const liveRuntime = liveLayer as unknown as Record<string, unknown>;
  for (const field of ['raster', 'videoElement', 'videoBlob', 'videoURL', 'runtimeMediaKey'] as const) {
    if (liveRuntime[field] != null) runtime[field] = liveRuntime[field];
  }
  return runtime as Partial<EditorLayer>;
}
export function newLayerId(): string { return newUuid('layer'); }

export function selectLayerPart(id: string, part: EditorLayerPart = 'layer', preserveSelection = false): boolean {
  const targetPart = part === 'mask' || part === 'content-mask' ? part : 'layer';
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (targetPart === 'mask' && (layer?.type !== 'effect' || !layer.mask)) return false;
  if (targetPart === 'content-mask' && !layer?.contentMask) return false;
  activeLayerId.set(id);
  activeLayerPart.set(targetPart);
  if (!preserveSelection || targetPart !== 'layer') selectedLayerIds.set(new Set([id]));
  return true;
}
export function selectLayer(id: string): boolean { return selectLayerPart(id); }
export function selectEffectMask(id: string): boolean { return selectLayerPart(id, 'mask'); }
export function selectContentMask(id: string): boolean { return selectLayerPart(id, 'content-mask'); }
export function clearLayerSelection(): boolean {
  const active = get(activeLayerId);
  const selected = get(selectedLayerIds);
  const changed = active == null
    ? selected.size > 0
    : selected.size !== 1 || !selected.has(active);
  if (changed) selectedLayerIds.set(active == null ? new Set() : new Set([active]));
  return changed;
}
export function isEditingEffectMask(layer: EditorLayer | null = null): boolean {
  const active = layer || get(layers).find((candidate) => candidate.id === get(activeLayerId));
  return get(activeLayerPart) === 'mask' && active?.type === 'effect' && !!active.mask;
}

export function isEditingContentMask(layer: EditorLayer | null = null): boolean {
  const active = layer || get(layers).find((candidate) => candidate.id === get(activeLayerId));
  return get(activeLayerPart) === 'content-mask' && !!active?.contentMask;
}
export function selectLayerWithModifiers(id: string, event: Pick<PointerEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'> | Record<string, never> = {}): void {
  activeLayerPart.set('layer');
  if (event.shiftKey) selectLayerRange(id);
  else if (event.ctrlKey || event.metaKey) toggleLayerSelected(id);
  else selectLayer(id);
}

export function toggleLayerSelected(id: string): void {
  let removed = false;
  selectedLayerIds.update((selected) => {
    const next = new Set(selected);
    if (!next.has(id)) {
      next.add(id);
    } else if (next.size > 1) {
      next.delete(id);
      removed = true;
    }
    return next;
  });

  if (!removed) {
    activeLayerId.set(id);
  } else {
    const activeId = get(activeLayerId);
    if (activeId != null && !get(selectedLayerIds).has(activeId)) {
      activeLayerId.set([...get(selectedLayerIds)][0] ?? null);
    }
  }
}
function selectLayerRange(id: string): void {
  const $l = get(layers);
  const collapsed = new Set($l.filter((layer) => layer.type === 'group' && layer.collapsed).map((layer) => layer.id));
  const visible = $l.filter((layer) => !(layer.groupId && collapsed.has(layer.groupId)));
  const active = $l.find((layer) => layer.id === get(activeLayerId));
  const anchorId = active && !visible.includes(active) ? active.groupId : active?.id;
  const a = visible.findIndex((l) => l.id === anchorId);
  const b = visible.findIndex((l) => l.id === id);
  if (a < 0 || b < 0) { selectLayer(id); return; }
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const set = new Set<string>();
  for (let i = lo; i <= hi; i++) set.add(visible[i]!.id);
  selectedLayerIds.set(set);
  activeLayerId.set(id);
}
function pruneSelection(): void {
  const ids = new Set(get(layers).map((layer) => layer.id));
  selectedLayerIds.update((selected) => {
    const next = new Set([...selected].filter((id) => ids.has(id)));
    const activeId = get(activeLayerId);
    if (activeId != null && ids.has(activeId)) next.add(activeId);
    return next;
  });
}

activeLayerId.subscribe(() => {
  const active = get(layers).find((candidate) => candidate.id === get(activeLayerId));
  const part = get(activeLayerPart);
  if (part === 'mask' && (active?.type !== 'effect' || !active.mask)) activeLayerPart.set('layer');
  if (part === 'content-mask' && !active?.contentMask) activeLayerPart.set('layer');
});

export function groupOf($layers: EditorLayer[], layer: EditorLayer): EditorGroupLayer | null {
  return layer.groupId
    ? $layers.find((candidate): candidate is EditorGroupLayer =>
      candidate.id === layer.groupId && candidate.type === 'group') || null
    : null;
}

export function effOffset($layers: EditorLayer[], layer: EditorLayer): EditorPoint {
  const group = groupOf($layers, layer);
  const x = layer.offset?.x || 0;
  const y = layer.offset?.y || 0;
  if (!group) return { x, y };
  return {
    x: x + (group.offset?.x || 0),
    y: y + (group.offset?.y || 0),
  };
}
export function effMaskOffset($layers: EditorLayer[], layer: EditorLayer): EditorPoint {
  const layerOffset = effOffset($layers, layer);
  const mask = layer.type === 'effect' ? layer.mask : null;
  return {
    x: layerOffset.x + (mask?.offset?.x || 0),
    y: layerOffset.y + (mask?.offset?.y || 0),
  };
}

export function effContentMaskOffset($layers: EditorLayer[], layer: EditorLayer): EditorPoint {
  const layerOffset = effOffset($layers, layer);
  return {
    x: layerOffset.x + (layer.contentMask?.offset?.x || 0),
    y: layerOffset.y + (layer.contentMask?.offset?.y || 0),
  };
}

function contentMaskAllows($layers: EditorLayer[], layer: EditorLayer, x: number, y: number): boolean {
  const allows = (owner: EditorLayer) => {
    const mask = owner.contentMask;
    if (!mask) return true;
    const offset = effContentMaskOffset($layers, owner);
    const cell = mask.cells[`${x - Math.round(offset.x)},${y - Math.round(offset.y)}`];
    const color = cell?.bg || cell?.fg;
    return color ? color.toLowerCase() === '#ffffff' : (mask.defaultStrength ?? 1) === 1;
  };
  return allows(layer) && (!groupOf($layers, layer) || allows(groupOf($layers, layer)!));
}
export function layerBox($layers: EditorLayer[], l: EditorLayer | null | undefined): EditorBounds | null {
  if (!l?.box) return null;
  const offset = effOffset($layers, l);
  return { ...l.box, x: l.box.x + offset.x, y: l.box.y + offset.y };
}
export function effVisible($layers: EditorLayer[], l: EditorLayer): boolean {
  const g = groupOf($layers, l);
  return l.visible && (!g || g.visible);
}

export function isBackgroundLayer(layer: EditorLayer | null | undefined): boolean {
  return layer?.type === 'background' || (layer?.type === 'shape' && layer.shape?.channel === 'background');
}

export function isColorClipShape(layer: EditorLayer | null | undefined): layer is EditorShapeLayer {
  return layer?.type === 'shape' && layer.shape?.channel === 'color-clip';
}

export function isReferenceOnlyLayer(layer: EditorLayer | null | undefined): boolean {
  return layer?.type === 'image' || layer?.type === 'video';
}

function layerContribution(cell: EditorCellValue, layer: EditorLayer, respectOpacity = true): EditorCell | null {
  if (!cell) return null;
  if (respectOpacity && (layer.opacity ?? 1) <= 0) return null;
  if (isBackgroundLayer(layer)) {
    const bg = cell.bg ?? cell.fg;
    return bg ? { bg } : null;
  }
  const out: EditorCell = {};
  if (cell.c || cell.cont) {
    out.c = cell.c || '';
    out.fg = cell.fg ?? null;
    if (cell.cont) out.cont = true;
  }
  if (cell.bg) out.bg = cell.bg;
  return out.c != null || out.bg ? out : null;
}

export function mergeCellChannels(
  base: EditorCellValue,
  cell: EditorCellValue,
  layer: EditorLayer,
  blink = false,
  options: CompositeOptions = {},
): EditorCell | null {
  const respectOpacity = options.referenceOpacity !== false;
  let over = layerContribution(cell, layer, respectOpacity);
  if (!over) return base ?? null;
  const opacity = respectOpacity ? layer.opacity ?? 1 : 1;
  if (opacity < 1) {
    if (over.bg) over.bg = blendHex(over.bg, base?.bg || '#000000', opacity);
    if (over.fg) over.fg = blendHex(over.fg, base?.fg || base?.bg || '#000000', opacity);
  }
  if (blink && over.c != null) over = { ...over, blink: true };
  const out = base ? { ...base } : {};
  if (over.bg) out.bg = over.bg;
  if (over.c != null) {
    out.c = over.c;
    out.fg = over.fg;
    if (over.cont) out.cont = true; else delete out.cont;
    if (over.blink) out.blink = true; else delete out.blink;
  }
  return out.c != null || out.bg ? out : null;
}

export function applyBlinkPhase(cells: EditorCellGrid, visible = true): EditorCellGrid {
  if (visible) return cells;
  return cells.map((row) => row.map((cell) => {
    if (!cell?.blink) return cell;
    if (!cell.bg) return null;
    return { bg: cell.bg, ...(cell.offCanvas ? { offCanvas: true } : {}) };
  }));
}

export function hasVisibleBlinkingGlyph($layers: EditorLayer[]): boolean {
  return $layers.some((layer) =>
    layer.type !== 'group'
    && layer.type !== 'effect'
    && !isColorClipShape(layer)
    && !isReferenceOnlyLayer(layer)
    && layer.blink
    && effVisible($layers, layer)
    && Object.values(layer.cells || {}).some((cell) => cell?.c || cell?.cont));
}
function markLayerCoverage(
  coverage: CoverageGrid,
  $layers: EditorLayer[],
  layer: EditorLayer,
  vp: EditorPoint & EditorSize,
  options: CompositeOptions,
): void {
  if (layer.type === 'group' || layer.type === 'effect' || isColorClipShape(layer) ||
      isReferenceOnlyLayer(layer) || !effVisible($layers, layer)) return;
  const offset = effOffset($layers, layer);
  const ox = Math.round(offset.x);
  const oy = Math.round(offset.y);
  for (const [key, cell] of Object.entries(layer.cells || {})) {
    const point = cmParse(key);
    if (!contentMaskAllows($layers, layer, point.x + ox, point.y + oy)) continue;
    const over = layerContribution(cell, layer, options.referenceOpacity !== false);
    if (!over) continue;
    const gx = point.x + ox - vp.x;
    const gy = point.y + oy - vp.y;
    if (gx < 0 || gy < 0 || gx >= vp.w || gy >= vp.h) continue;
    const row = coverage[gy]!;
    const channels = row[gx] || {};
    if (over.c != null) channels.fg = true;
    if (over.bg) channels.bg = true;
    row[gx] = channels;
  }
}

function isAlwaysClippedAdjustment(layer: EditorLayer): boolean {
  return (layer.type === 'effect' && !!layer.effect && layer.effect.kind === 'color-clip') ||
    isColorClipShape(layer);
}

function isAdjustmentLayer(layer: EditorLayer): boolean {
  return layer.type === 'effect' || isColorClipShape(layer);
}

function clippedEffectCoverage(
  $layers: EditorLayer[],
  effectIndex: number,
  vp: EditorPoint & EditorSize,
  options: CompositeOptions,
): CoverageGrid {
  const coverage: CoverageGrid = Array.from({ length: vp.h }, () => Array<CoverageChannels | null>(vp.w).fill(null));
  const effectLayer = $layers[effectIndex]!;
  const parentGroup = effectLayer.groupId;
  // Walk through a consecutive run of adjustment layers to find the first
  // non-adjustment base target. color-clip effects are always clipped;
  // ordinary effects are skipped only when their clipped flag is set.
  let targetIndex = effectIndex + 1;
  while (targetIndex < $layers.length) {
    const candidate = $layers[targetIndex];
    if (!candidate) break;
    // Stay within the same parent group scope.
    if (candidate.groupId !== parentGroup && candidate.type !== 'group') break;
    if (candidate.type === 'group' && candidate.id !== parentGroup) break;
    if (isAdjustmentLayer(candidate) && ((candidate.type === 'effect' && candidate.clipped) || isAlwaysClippedAdjustment(candidate))) {
      targetIndex++;
      continue;
    }
    break;
  }
  const target = $layers[targetIndex];
  if (!target) return coverage;
  if (target.type === 'group') {
    if (!target.visible) return coverage;
    for (const layer of $layers) {
      if (layer.groupId === target.id) markLayerCoverage(coverage, $layers, layer, vp, options);
    }
  } else {
    markLayerCoverage(coverage, $layers, target, vp, options);
  }
  return coverage;
}

// Layers are stored front-to-back, so reverse traversal lets effects modify composited content below them.
export function compositeWorld(
  $layers: EditorLayer[],
  vp: EditorPoint & EditorSize,
  canvasVP: (EditorPoint & EditorSize) | null = null,
  options: CompositeOptions = {},
): EditorCellGrid {
  const out: EditorCellGrid = Array.from({ length: vp.h }, () => Array<EditorCell | null>(vp.w).fill(null));
  for (let i = $layers.length - 1; i >= 0; i--) {
    const layer = $layers[i]!;
    if (isColorClipShape(layer)) {
      if (effVisible($layers, layer)) {
        const coverage = clippedEffectCoverage($layers, i, vp, options);
        const offset = effOffset($layers, layer);
        const sourceViewport = { ...vp, x: vp.x - Math.round(offset.x), y: vp.y - Math.round(offset.y) };
        applyColorClipToGrid(out, layer.cells, layer.shape?.mix ?? 1, sourceViewport, coverage);
      }
      continue;
    }
    if (layer.type === 'effect') {
      if (effVisible($layers, layer)) {
        const alwaysClipped = isAlwaysClippedAdjustment(layer);
        const coverage = (alwaysClipped || layer.clipped) ? clippedEffectCoverage($layers, i, vp, options) : null;
        const maskOffset = effMaskOffset($layers, layer);
        const contentMaskOffset = effContentMaskOffset($layers, layer);
        const maskViewport = { ...vp, x: vp.x - Math.round(maskOffset.x), y: vp.y - Math.round(maskOffset.y) };
        const contentMaskViewport = { ...vp, x: vp.x - Math.round(contentMaskOffset.x), y: vp.y - Math.round(contentMaskOffset.y) };
        applyEffectToGrid(out, layer, maskViewport, coverage, contentMaskViewport);
      }
      continue;
    }
    if (layer.type === 'group' || isReferenceOnlyLayer(layer)) continue;
    if (!effVisible($layers, layer)) continue;
    const offset = effOffset($layers, layer);
    const ox = Math.round(offset.x), oy = Math.round(offset.y);
    const blink = !!layer.blink;
    for (const k in layer.cells) {
      const cell = layer.cells[k]; if (!cell) continue;
      const p = cmParse(k);
      const wx = p.x + ox, wy = p.y + oy;
      const gx = wx - vp.x, gy = wy - vp.y;
      if (gx < 0 || gy < 0 || gx >= vp.w || gy >= vp.h) continue;
      if (!contentMaskAllows($layers, layer, wx, wy)) continue;
      const row = out[gy]!;
      let c = mergeCellChannels(row[gx], cell, layer, blink, options);
      if (!c) continue;
      if (canvasVP && (wx < canvasVP.x || wy < canvasVP.y || wx >= canvasVP.x + canvasVP.w || wy >= canvasVP.y + canvasVP.h)) {
        c = { ...c, offCanvas: true };
      }
      row[gx] = c;
    }
  }
  return out;
}

export const grid = derived([layers, activeLayerId, dims], ([$layers, , $dims]) =>
  compositeWorld($layers, { x: 0, y: 0, w: $dims.w, h: $dims.h })
);

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
}

export function resizeCanvas(w: number, h: number, recordHistory = true): boolean {
  if (!authoredEditsAllowed()) return false;
  w = Math.max(1, Math.min(256, w | 0));
  h = Math.max(1, Math.min(256, h | 0));
  const current = get(dims);
  if (current.w === w && current.h === h) return false;
  if (recordHistory) pushHistory();
  dims.set({ w, h });
  cropPending.set(null);
  cellSelection.update((selected) => new Set([...selected].filter((key) => {
    const point = cmParse(key);
    return point.x >= 0 && point.y >= 0 && point.x < w && point.y < h;
  })));
  return true;
}

export function setLayers(layerDefs: EditorLayerDefinition[]): void {
  const assigned = layerDefs.map((layer) => layer.id ?? layer.srcId ?? newLayerId());
  const idBySource = new Map(layerDefs.flatMap((layer, index) => {
    const source = layer.srcId ?? layer.id;
    return source == null ? [] : [[source, assigned[index]]];
  }));
  if (new Set(assigned).size !== assigned.length) throw new Error('Layer IDs must be unique.');
  const built = layerDefs.map((l, index): EditorLayer => {
    const { id, srcId, opacity, ...rest } = l;
    const type = l.type || 'cell';
    return {
      ...rest,
      id: assigned[index],
      type,
      visible: l.visible !== false,
      cells: l.cells || {},
      ...(l.groupId != null ? { groupId: idBySource.get(l.groupId) ?? l.groupId } : {}),
      ...(opacity != null ? { opacity } : {}),
    } as EditorLayer;
  });
  layers.set(built);
  layerHistoryAuthority?.initializeView?.(built);
  syncLayerNameCounters(built);
  const first = built[0]?.id ?? null;
  activeLayerId.set(first);
  activeLayerPart.set('layer');
  selectedLayerIds.set(first == null ? new Set() : new Set([first]));
  cellSelection.set(new Set());
  resetHistory();
}

export function resetEditorStateForProjectLoad(): void {
  const stack = get(layers);
  syncLayerNameCounters(stack);
  const first = stack[0]?.id ?? null;
  activeLayerId.set(first);
  activeLayerPart.set('layer');
  selectedLayerIds.set(first == null ? new Set() : new Set([first]));
  cellSelection.set(new Set());
  cropPending.set(null);
  resetHistory();
}

function asMap(gridOrMap: EditorCellGrid | EditorCellMap): EditorCellMap {
  return Array.isArray(gridOrMap) ? cmFromGrid(gridOrMap) : gridOrMap;
}

export function createTextLayer(
  box: EditorBounds,
  text: string,
  fg: string,
  wrap: boolean,
  renderFn: RenderText,
): string | false {
  if (!authoredEditsAllowed()) return false;
  pushHistory();
  const layer: Extract<EditorLayer, { type: 'text' }> = {
    id: newLayerId(), name: nextLayerName(), type: 'text', visible: true,
    text, box, wrap, fg, runs: [], cells: asMap(renderFn(text, box, fg, wrap, [])),
  };
  layers.update(($l) => [layer, ...$l]);
  selectLayer(layer.id);
  return layer.id;
}
export function updateTextLayer(
  id: string,
  patch: Partial<Pick<Extract<EditorLayer, { type: 'text' }>, 'text' | 'box' | 'wrap' | 'fg' | 'runs'>>,
  renderFn: RenderText,
): false | void {
  if (!authoredEditsAllowed()) return false;
  layers.update(($l) => $l.map((l) => {
    if (l.id !== id || l.type !== 'text') return l;
    const merged = { ...l, ...patch };
    merged.cells = asMap(renderFn(merged.text, merged.box, merged.fg, merged.wrap, merged.runs || []));
    return merged;
  }));
  noteAuthoredMutation();
}
export function getLayer(id: string | null): EditorLayer | null {
  return get(layers).find((l) => l.id === id) || null;
}

export function createShapeLayer(shape: EditorShape, renderFn: RenderShape): string | false {
  if (!authoredEditsAllowed()) return false;
  pushHistory();
  const layer: EditorShapeLayer = {
    id: newLayerId(), name: nextLayerName(), type: 'shape', visible: true,
    opacity: 1, shape, cells: asMap(renderFn(shape)),
  };
  layers.update(($l) => [layer, ...$l]);
  selectLayer(layer.id);
  return layer.id;
}

export function createPaintLayer(type: 'cell' | 'background' = 'cell'): string | false {
  if (!authoredEditsAllowed() || (type !== 'cell' && type !== 'background')) return false;
  pushHistory();
  const layer = makeLayer(nextLayerName(), type);
  layers.update(($layers) => [layer, ...$layers]);
  selectLayer(layer.id);
  return layer.id;
}

export function updateShapeLayer(id: string, patch: Partial<EditorShape>, renderFn: RenderShape): false | void {
  if (!authoredEditsAllowed()) return false;
  let removedContentMask = false;
  layers.update(($l) => $l.map((l) => {
    if (l.id !== id || l.type !== 'shape') return l;
    const shape = { ...l.shape, ...patch } as EditorShape;
    removedContentMask = shape.channel === 'color-clip' && !!l.contentMask;
    return {
      ...l,
      shape,
      cells: asMap(renderFn(shape)),
      ...(shape.channel === 'color-clip' ? { contentMask: null } : {}),
    };
  }));
  if (removedContentMask && get(activeLayerId) === id && get(activeLayerPart) === 'content-mask') {
    activeLayerPart.set('layer');
  }
  noteAuthoredMutation();
}
export function setShapeLayerProperties(id: string, patch: Partial<EditorShape>, renderFn: RenderShape): boolean {
  if (!authoredEditsAllowed()) return false;
  const layer = getLayer(id);
  if (layer?.type !== 'shape') return false;
  const nextShape = { ...layer.shape, ...patch } as EditorShape;
  if (sameShallowObject(layer.shape, nextShape)) return false;
  pushHistory();
  updateShapeLayer(id, patch, renderFn);
  return true;
}
export function rasterizeLayer(id: string): boolean {
  if (!authoredEditsAllowed()) return false;
  const sel = get(selectedLayerIds);
  const ids = sel.has(id) ? new Set(sel) : new Set([id]);
  if (!get(layers).some((layer) => ids.has(layer.id) && layer.type === 'shape')) return false;
  pushHistory();
  // Materialize procedural frames after the Undo snapshot and before removing shape metadata.
  notifyShapeRasterize(ids);
  layers.update(($l) => $l.map((l): EditorLayer => {
    if (!ids.has(l.id) || l.type !== 'shape') return l;
    const { shape, ...rest } = l;
    if (shape?.channel === 'color-clip') {
      return {
        ...rest,
        type: 'effect',
        effect: { kind: 'color-clip', intensity: Math.max(0, Math.min(1, shape.mix ?? 1)) },
        clipped: true,
      };
    }
    return { ...rest, type: shape?.channel === 'background' ? 'background' : 'cell' };
  }));
  return true;
}

export function createImageLayer(name: string, raster: EditorRasterSource, assetId: unknown): string | false {
  if (!authoredEditsAllowed()) return false;
  pushHistory();
  const cw = GRID_W, ch = GRID_H * 2;
  const iw = raster.width, ih = raster.height;
  const fit = Math.min(1, cw / iw, ch / ih);
  const layer: Extract<EditorLayer, { type: 'image' }> = {
    id: newLayerId(), name, type: 'image', visible: true,
    assetId: assertUuid(assetId, 'Image asset ID'), cells: {},
    sourceWidth: iw, sourceHeight: ih,
    transform: { x: GRID_W / 2, y: GRID_H / 2, scale: fit, rot: 0 },
  };
  layers.update(($l) => [...$l, layer]);
  selectLayer(layer.id);
  return layer.id;
}

export function createVideoLayer(
  name: string,
  source: { assetId: unknown; width: number; height: number; duration: number },
  startTick = 0,
): string | false {
  if (!authoredEditsAllowed()) return false;
  pushHistory();
  const cw = GRID_W, ch = GRID_H * 2;
  const fit = Math.min(1, cw / source.width, ch / source.height);
  const layer: Extract<EditorLayer, { type: 'video' }> = {
    id: newLayerId(), name, type: 'video', visible: true,
    cells: {},
    videoClip: normalizeVideoClip({
      assetId: assertUuid(source.assetId, 'Video asset ID'),
      startTick: Math.max(0, Math.round(startTick) || 0),
      inPoint: 0,
      outPoint: source.duration,
      playbackRate: 1,
      duration: source.duration,
      width: source.width,
      height: source.height,
    }) as unknown as EditorVideoClip,
    transform: { x: GRID_W / 2, y: GRID_H / 2, scale: fit, rot: 0 },
  };
  layers.update(($l) => [...$l, layer]);
  selectLayer(layer.id);
  return layer.id;
}

// Relinking preserves on-canvas size and follows a new duration only when the old trim ended at EOF.
export function attachVideoSource(
  id: string,
  name: string,
  source: { assetId?: unknown; width: number; height: number; duration: number },
): boolean {
  if (!authoredEditsAllowed()) return false;
  const current = getLayer(id);
  if (!current || current.type !== 'video') return false;
  const assetId = (normalizeVideoClip(current.videoClip) as unknown as EditorVideoClip).assetId;
  const duration = Math.max(0, Number(source.duration) || 0);
  const sourceWidth = Math.max(0, Number(source.width) || 0);
  const sourceHeight = Math.max(0, Number(source.height) || 0);
  pushHistory();
  layers.update(($l) => $l.map((l) => {
    if (l.type !== 'video' || (normalizeVideoClip(l.videoClip) as unknown as EditorVideoClip).assetId !== assetId) return l;
    const previous = normalizeVideoClip(l.videoClip) as unknown as EditorVideoClip;
    const previousWidth = Math.max(0,
      Number(previous.width) || Number(l.raster?.width) || sourceWidth);
    const previousHeight = Math.max(0,
      Number(previous.height) || Number(l.raster?.height) || sourceHeight);
    const priorTransform = l.transform;
    const transform = priorTransform && sourceWidth > 0 && sourceHeight > 0
      ? {
        ...priorTransform,
        scaleX: (priorTransform.scaleX ?? priorTransform.scale ?? 1) *
          previousWidth / sourceWidth,
        scaleY: (priorTransform.scaleY ?? priorTransform.scale ?? 1) *
          previousHeight / sourceHeight,
      }
      : priorTransform;
    const followedSourceEnd = l.videoClip?.outPoint == null ||
      Math.abs(previous.outPoint - previous.duration) < MIN_VIDEO_CLIP_SECONDS;
    const videoClip = normalizeVideoClip({
      ...previous,
      outPoint: followedSourceEnd ? duration : previous.outPoint,
      duration,
      width: source.width,
      height: source.height,
    }) as unknown as EditorVideoClip;
    return {
      ...l,
      name: l.name || name,
      videoClip,
      transform,
    };
  }));
  return true;
}

export function replaceImageAssetSource(
  assetId: string,
  previousAsset: { width: number; height: number },
  nextAsset: { width: number; height: number },
): boolean {
  if (!authoredEditsAllowed()) return false;
  let changed = false;
  layers.update(($layers) => $layers.map((layer) => {
    if (layer.type !== 'image' || layer.assetId !== assetId) return layer;
    changed = true;
    const priorTransform = layer.transform;
    const transform = priorTransform && nextAsset.width > 0 && nextAsset.height > 0
      ? {
        ...priorTransform,
        scaleX: (priorTransform.scaleX ?? priorTransform.scale ?? 1) *
          previousAsset.width / nextAsset.width,
        scaleY: (priorTransform.scaleY ?? priorTransform.scale ?? 1) *
          previousAsset.height / nextAsset.height,
      }
      : priorTransform;
    return {
      ...layer,
      sourceWidth: nextAsset.width,
      sourceHeight: nextAsset.height,
      transform,
    };
  }));
  if (changed) noteAuthoredMutation();
  return changed;
}

export function updateVideoClip(id: string, patch: Partial<EditorVideoClip>, history = true): boolean {
  if (!authoredEditsAllowed()) return false;
  const layer = getLayer(id);
  if (!layer || layer.type !== 'video') return false;
  const current = normalizeVideoClip(layer.videoClip) as unknown as EditorVideoClip;
  const next = normalizeVideoClip({ ...current, ...patch }) as unknown as EditorVideoClip;
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  if (history) pushHistory();
  layers.update(($l) => $l.map((l) => l.id === id ? { ...l, videoClip: next } : l));
  if (!history) noteAuthoredMutation();
  return true;
}

function rasterizeImageLayer(
  src: Extract<EditorLayer, { type: 'image' | 'video' }> & { raster: EditorRasterSource },
  sampleScale = 8,
): HTMLCanvasElement {
  const size = get(dims);
  const offset = effOffset(get(layers), src);
  const w = size.w * sampleScale, h = size.h * 2 * sampleScale;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const t = src.transform || { x: size.w / 2, y: size.h / 2, scale: 1, rot: 0 };
  const scX = t.scaleX ?? t.scale ?? 1, scY = t.scaleY ?? t.scale ?? 1;
  ctx.save();
  ctx.scale(sampleScale, sampleScale);
  ctx.translate(t.x + offset.x, (t.y + offset.y) * 2);
  ctx.rotate((t.rot || 0) * Math.PI / 180);
  ctx.scale(scX, scY);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src.raster, -src.raster.width / 2, -src.raster.height / 2);
  ctx.restore();
  return c;
}

export function snapshotLayerForConversion(id: string): HTMLCanvasElement | null {
  const src = getLayer(id);
  if (!src || (src.type !== 'image' && src.type !== 'video') || !src.raster) return null;
  return rasterizeImageLayer(src as typeof src & { raster: EditorRasterSource });
}

interface ConvertedLayerPair {
  foreground?: EditorCellMap | EditorCellGrid;
  background?: EditorCellMap | EditorCellGrid;
  meta?: unknown;
}

export function insertConvertedLayerPair(
  id: string,
  converted: ConvertedLayerPair | EditorCellMap | EditorCellGrid | null | undefined,
): unknown {
  if (!authoredEditsAllowed()) return false;
  const src = getLayer(id);
  if (!src || (src.type !== 'image' && src.type !== 'video') || !src.raster) return null;
  const pair = converted as ConvertedLayerPair | null | undefined;
  const foreground = asMap(pair?.foreground ?? (converted as EditorCellMap | EditorCellGrid | null | undefined) ?? {});
  const background = asMap(pair?.background ?? {});
  pushHistory();
  const groupId = newLayerId();
  const foregroundId = newLayerId();
  const group: EditorGroupLayer = {
    id: groupId, name: nextGroupName(), type: 'group', visible: true, collapsed: false, cells: {},
  };
  const glyphLayer: Extract<EditorLayer, { type: 'cell' | 'background' }> = {
    id: foregroundId, name: nextLayerName(), type: 'cell', visible: true,
    groupId, cells: foreground,
  };
  const backgroundLayer: Extract<EditorLayer, { type: 'cell' | 'background' }> = {
    id: newLayerId(), name: nextLayerName(), type: 'background', visible: true,
    groupId, cells: background,
  };
  layers.update(($l) => {
    const next = $l.map((layer) => (
      layer.id === id ? { ...layer, visible: false } : layer
    ));
    const sourceIndex = next.findIndex((layer) => layer.id === id);
    const insertAt = src.groupId
      ? next.findIndex((layer) => layer.id === src.groupId)
      : sourceIndex;
    next.splice(Math.max(0, insertAt), 0, group, glyphLayer, backgroundLayer);
    return next;
  });
  selectLayer(foregroundId);
  return pair?.meta || null;
}

export function convertImageLayer(id: string, converter: (raster: HTMLCanvasElement) => ConvertedLayerPair): unknown {
  if (!authoredEditsAllowed()) return false;
  const raster = snapshotLayerForConversion(id);
  if (!raster) return null;
  return insertConvertedLayerPair(id, converter(raster));
}
function activeLayer($layers: EditorLayer[], id: string | null): EditorLayer | null {
  return $layers.find((l) => l.id === id) || $layers[0] || null;
}

function maskCellFromPaint(cell: EditorCellValue): EditorCell {
  if (!cell) return { mask: 0 };
  if (typeof cell.mask === 'number' && Number.isFinite(cell.mask)) return { mask: Math.max(0, Math.min(1, cell.mask)) };
  return { mask: colorLuminance(cell.bg || cell.fg || '#ffffff') };
}

function sameCellValue(first: EditorCellValue, second: EditorCellValue): boolean {
  if (first === second) return true;
  if (!first || !second) return false;
  const firstKeys = Object.keys(first) as Array<keyof EditorCell>;
  const secondKeys = Object.keys(second) as Array<keyof EditorCell>;
  return firstKeys.length === secondKeys.length &&
    firstKeys.every((key) => first[key] === second[key]);
}

function updateActiveCells(updates: EditorCellUpdate[]): false | void | true {
  if (!authoredEditsAllowed()) return false;
  if (!updates.length) return;
  const id = get(activeLayerId);
  const active = get(layers).find((layer) => layer.id === id);
  if (!active) return;
  const editingEffectMask = isEditingEffectMask(active);
  const editingContentMask = isEditingContentMask(active);
  if (active.type === 'group' && !editingContentMask) return;

  const $layers = get(layers);
  let changed = false;
  const nextLayers = $layers.map((layer) => {
    if (layer.id !== id) return layer;
    const effectLayer = editingEffectMask ? layer as EditorEffectLayer : null;
    let cells: EditorCellMap;
    let offset: EditorPoint;
    if (editingEffectMask) {
      cells = { ...(effectLayer?.mask?.cells || {}) };
      offset = effMaskOffset($layers, layer);
    } else if (editingContentMask) {
      cells = { ...(layer.contentMask?.cells || {}) };
      offset = effContentMaskOffset($layers, layer);
    } else {
      cells = { ...layer.cells };
      offset = effOffset($layers, layer);
    }
    const ox = Math.round(offset.x);
    const oy = Math.round(offset.y);
    for (const { x, y, cell } of updates) {
      const localX = x - ox;
      const localY = y - oy;
      let nextCell: EditorCellValue;
      if (editingEffectMask) nextCell = maskCellFromPaint(cell);
      else if (editingContentMask) nextCell = cell;
      else nextCell = cell;
      if (sameCellValue(cmGet(cells, localX, localY), nextCell)) continue;
      cmSet(cells, localX, localY, nextCell);
      changed = true;
    }
    if (!changed) return layer;
    if (editingEffectMask) return { ...effectLayer!, mask: { ...(effectLayer!.mask || { defaultStrength: 1 }), cells } };
    if (editingContentMask) return { ...layer, contentMask: { ...layer.contentMask!, cells } };
    return { ...layer, cells };
  });
  if (!changed) return false;
  layers.set(nextLayers);
  noteAuthoredMutation();
  return true;
}

export function setCell(x: number, y: number, cell: EditorCellValue): false | void | true {
  return updateActiveCells([{ x, y, cell }]);
}

export function setCells(updates: EditorCellUpdate[]): false | void | true {
  return updateActiveCells(updates);
}

export function getCell(x: number, y: number): EditorCellValue {
  const id = get(activeLayerId);
  const $layers = get(layers);
  const layer = activeLayer($layers, id);
  if (!layer) return null;
  const editingEffectMask = isEditingEffectMask(layer);
  const editingContentMask = isEditingContentMask(layer);
  const offset = editingEffectMask
    ? effMaskOffset($layers, layer)
    : editingContentMask
      ? effContentMaskOffset($layers, layer)
      : effOffset($layers, layer);
  const cells = editingEffectMask
    ? (layer as EditorEffectLayer).mask!.cells
    : editingContentMask
      ? layer.contentMask!.cells
      : layer.cells;
  return cmGet(cells, x - Math.round(offset.x), y - Math.round(offset.y));
}

export function getComposited(x: number, y: number): EditorCellValue {
  if (!inBounds(x, y)) return null;
  return get(grid)[y]?.[x] ?? null;
}

export function addLayer(type: PaintLayerType = 'cell'): boolean {
  if (!authoredEditsAllowed()) return false;
  pushHistory();
  const layer = makeLayer(nextLayerName(), type);
  const active = get(activeLayerId);
  layers.update(($l) => {
    const activeIndex = $l.findIndex((candidate) => candidate.id === active);
    if (activeIndex < 0) return [layer, ...$l];
    const target = $l[activeIndex]!;
    const inserted = target.type === 'group'
      ? { ...layer, groupId: target.id }
      : target.groupId
        ? { ...layer, groupId: target.groupId }
        : layer;
    const next = $l.map((candidate) => (
      target.type === 'group' && candidate.type === 'group' && candidate.id === target.id && candidate.collapsed
        ? { ...candidate, collapsed: false }
        : candidate
    ));
    next.splice(activeIndex + (target.type === 'group' ? 1 : 0), 0, inserted);
    return next;
  });
  selectLayer(layer.id);
  return true;
}
export function addGroup(): false | void {
  if (!authoredEditsAllowed()) return false;
  pushHistory();
  const group: EditorLayer = { id: newLayerId(), name: nextGroupName(), type: 'group', visible: true, collapsed: false, cells: {} };
  const active = get(activeLayerId);
  layers.update(($l) => {
    let at = $l.findIndex((layer) => layer.id === active);
    if (at < 0) at = 0;
    const parentId = $l[at]?.groupId;
    if (parentId) at = Math.max(0, $l.findIndex((layer) => layer.id === parentId));
    const next = $l.slice();
    next.splice(at, 0, group);
    return next;
  });
  selectLayer(group.id);
}
export function removeLayers(
  requestedIds: Iterable<string> | null | undefined,
  { includeGroupDescendants = true }: { includeGroupDescendants?: boolean } = {},
): boolean {
  if (!authoredEditsAllowed()) return false;
  const $all = get(layers);
  const requested = includeGroupDescendants
    ? layerDeleteClosure($all, requestedIds)
    : [...(requestedIds || [])];
  const available = new Set($all.map((layer) => layer.id));
  const ids = new Set(requested.filter((id) => available.has(id)));
  if (!ids.size) return false;
  pushHistory();
  layers.update(($l) => {
    const next = $l.filter((l) => !ids.has(l.id));
    return next.length ? next : [];
  });
  const $l = get(layers);
  if (!$l.some((l) => l.id === get(activeLayerId))) activeLayerId.set($l[0]?.id ?? null);
  pruneSelection();
  if (!$l.length) notifyLayerStackEmpty();
  return true;
}
export function removeSelectedLayers(): boolean {
  const selected = get(selectedLayerIds);
  const active = get(activeLayerId);
  return removeLayers(selected.size ? selected : (active == null ? [] : [active]));
}
export function removeLayer(id: string): boolean {
  const selected = get(selectedLayerIds);
  return removeLayers(selected.has(id) ? selected : [id]);
}

export function groupActiveLayer(): false | void {
  if (!authoredEditsAllowed()) return false;
  const sel = get(selectedLayerIds);
  const members = get(layers).filter((layer) => sel.has(layer.id) && layer.type !== 'group');
  if (!members.length) { addGroup(); return; }
  pushHistory();
  const groupId = newLayerId();
  layers.update(($l) => {
    const group: EditorLayer = { id: groupId, name: nextGroupName(), type: 'group', visible: true, collapsed: false, cells: {} };
    const memberSet = new Set(members);
    const topIdx = Math.min(...members.map((m) => $l.indexOf(m)));
    const rest = $l.filter((l) => !memberSet.has(l));
    const removedAbove = $l.slice(0, topIdx).filter((l) => memberSet.has(l)).length;
    const insertAt = topIdx - removedAbove;
    const block = members.map((member) => reparentedLayer($l, member, groupId));
    const next = rest.slice();
    next.splice(insertAt, 0, group, ...block);
    return normalizeGroups(next);
  });
  selectLayer(groupId);
}
export function toggleGroupCollapsed(id: string): boolean {
  if (!authoredEditsAllowed()) return false;
  const group = get(layers).find((layer): layer is EditorGroupLayer => layer.id === id && layer.type === 'group');
  if (!group) return false;
  layers.update(($l) => $l.map((l) => (l.id === id && l.type === 'group' ? { ...l, collapsed: !l.collapsed } : l)));
  layerPanelRevision.update((revision) => revision + 1);
  return true;
}
export function setLayerOpacity(id: string, opacity: unknown): boolean {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((l) => l.id === id);
  const numeric = Number(opacity);
  if (!layer || layer.type === 'group' || layer.type === 'effect' || !Number.isFinite(numeric)) return false;
  const next = Math.max(0, Math.min(1, numeric));
  if ((layer.opacity ?? 1) === next) return false;
  pushHistory();
  layers.update(($l) => $l.map((l) => (l.id === id ? { ...l, opacity: next } : l)));
  return true;
}
const EFFECT_KINDS = new Set(['brightness', 'contrast', 'saturation', 'hue', 'solid-color', 'color-clip']);

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function normalizeEffectColor(value: unknown): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : '#ffffff';
}

export function setEffectProperties(id: string, patch: Partial<EditorEffect>): boolean {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (layer?.type !== 'effect') return false;
  const current = layer.effect || { kind: 'brightness' as const, intensity: 0.25 };
  const nextKind = patch.kind || current.kind;
  if (!EFFECT_KINDS.has(nextKind)) return false;
  let effect: EditorEffect;
  if (nextKind === 'solid-color') {
    const color = patch.kind === 'solid-color' && 'color' in patch
      ? normalizeEffectColor(patch.color)
      : (current.kind === 'solid-color' ? current.color : '#ffffff');
    const intensity = patch.intensity != null
      ? Math.max(0, Math.min(1, Number(patch.intensity) || 0))
      : (current.kind === 'solid-color' ? clampSolidColorIntensity(current.intensity) : 1);
    effect = { kind: 'solid-color', color, intensity };
  } else if (nextKind === 'color-clip') {
    const intensity = patch.intensity != null
      ? Math.max(0, Math.min(1, Number(patch.intensity) || 0))
      : (current.kind === 'color-clip' ? clampSolidColorIntensity(current.intensity) : 1);
    effect = { kind: 'color-clip', intensity };
  } else {
    const intensity = Math.max(-1, Math.min(1, Number(patch.intensity ?? current.intensity) || 0));
    effect = { kind: nextKind as 'brightness' | 'contrast' | 'saturation' | 'hue', intensity };
  }
  if (sameShallowObject(current, effect)) return false;
  pushHistory();
  layers.update(($layers) => $layers.map((candidate) => candidate.id === id ? { ...candidate, effect } : candidate));
  return true;
}

function clampSolidColorIntensity(value: unknown): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function setEffectMaskOpacity(id: string, opacity: unknown): false | void {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (layer?.type !== 'effect' || !layer.mask) return;
  const next = Math.max(0, Math.min(1, Number(opacity) || 0));
  if ((layer.mask.opacity ?? 1) === next) return;
  pushHistory();
  layers.update(($layers) => $layers.map((candidate) => candidate.id === id && candidate.type === 'effect'
    ? { ...candidate, mask: { ...candidate.mask!, opacity: next } }
    : candidate));
}

export function toggleEffectClipped(id: string): false | void {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (layer?.type !== 'effect') return;
  if (layer.effect?.kind === 'color-clip') return;
  pushHistory();
  layers.update(($layers) => $layers.map((candidate) => candidate.id === id && candidate.type === 'effect' ? { ...candidate, clipped: !candidate.clipped } : candidate));
}

export function toggleEffectMask(id: string): false | void {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (layer?.type !== 'effect') return;
  if (layer.effect?.kind === 'color-clip') return;
  pushHistory();
  layers.update(($layers) => $layers.map((candidate) => candidate.id === id && candidate.type === 'effect'
    ? { ...candidate, mask: candidate.mask ? null : { defaultStrength: 1, cells: {}, offset: { x: 0, y: 0 } } }
    : candidate));
  const next = get(layers).find((candidate) => candidate.id === id);
  if (next?.type === 'effect' && next.mask) selectEffectMask(id);
  else activeLayerPart.set('layer');
  notifyEffectMaskChanged(id, next?.type === 'effect' && !!next.mask);
}

export function createEffectMask(id: string, strength: 0 | 1): false | void {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (layer?.type !== 'effect' || layer.mask) return;
  if (layer.effect?.kind === 'color-clip') return;
  pushHistory();
  layers.update(($layers) => $layers.map((candidate) => candidate.id === id && candidate.type === 'effect'
    ? { ...candidate, mask: { defaultStrength: strength, cells: {}, offset: { x: 0, y: 0 } } }
    : candidate));
  notifyEffectMaskChanged(id, true);
}

export function fillEffectMask(id: string, strength: 0 | 1): false | void {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (layer?.type !== 'effect' || !layer.mask) return;
  pushHistory();
  layers.update(($layers) => $layers.map((candidate) => candidate.id === id && candidate.type === 'effect'
    ? { ...candidate, mask: { ...candidate.mask!, defaultStrength: strength, cells: {} } }
    : candidate));
}

export function invertEffectMask(id: string): false | void {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (layer?.type !== 'effect' || !layer.mask) return;
  pushHistory();
  const current = layer.mask;
  const invertedDefault = current.defaultStrength == null ? 0 : 1 - clamp(current.defaultStrength, 0, 1);
  const cells: EditorCellMap = {};
  for (const [key, cell] of Object.entries(current.cells || {})) {
    if (!cell) continue;
    const strength = typeof cell.mask === 'number' && Number.isFinite(cell.mask)
      ? clamp(cell.mask, 0, 1)
      : colorLuminance(cell.bg || cell.fg || '#000000');
    cells[key] = { mask: 1 - strength };
  }
  layers.update(($layers) => $layers.map((candidate) => candidate.id === id && candidate.type === 'effect'
    ? { ...candidate, mask: { ...current, defaultStrength: invertedDefault, cells } }
    : candidate));
}

export function isContentMaskable(layer: EditorLayer | null | undefined): boolean {
  if (!layer) return false;
  if (layer.type === 'effect' && layer.effect?.kind === 'color-clip') return false;
  if (isColorClipShape(layer)) return false;
  if (layer.type === 'image' || layer.type === 'video') return false;
  return true;
}

export function toggleContentMask(id: string): false | void {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (!isContentMaskable(layer)) return;
  pushHistory();
  layers.update(($layers) => $layers.map((candidate) => candidate.id === id
    ? { ...candidate, contentMask: candidate.contentMask ? null : { defaultStrength: 1, cells: {}, offset: { x: 0, y: 0 } } }
    : candidate));
  const next = get(layers).find((candidate) => candidate.id === id);
  if (next?.contentMask) selectContentMask(id);
  else activeLayerPart.set('layer');
  notifyEffectMaskChanged(id, !!next?.contentMask);
}

export function createContentMask(id: string, strength: 0 | 1): false | void {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (!isContentMaskable(layer) || layer?.contentMask) return;
  pushHistory();
  layers.update(($layers) => $layers.map((candidate) => candidate.id === id
    ? { ...candidate, contentMask: { defaultStrength: strength, cells: {}, offset: { x: 0, y: 0 } } }
    : candidate));
  notifyEffectMaskChanged(id, true);
}

export function fillContentMask(id: string, strength: 0 | 1): false | void {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (!layer?.contentMask) return;
  pushHistory();
  layers.update(($layers) => $layers.map((candidate) => candidate.id === id
    ? { ...candidate, contentMask: { ...candidate.contentMask!, defaultStrength: strength, cells: {} } }
    : candidate));
}

export function invertContentMask(id: string): false | void {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (!layer?.contentMask) return;
  pushHistory();
  const current = layer.contentMask;
  const invertedDefault = current.defaultStrength == null ? 0 : 1 - clamp(current.defaultStrength, 0, 1);
  const cells: EditorCellMap = {};
  for (const [key, cell] of Object.entries(current.cells || {})) {
    if (!cell) continue;
    const isWhite = cell.bg ? cell.bg.toLowerCase() === '#ffffff' : false;
    cells[key] = isWhite ? { bg: '#000000' } : { bg: '#ffffff' };
  }
  layers.update(($layers) => $layers.map((candidate) => candidate.id === id
    ? { ...candidate, contentMask: { ...current, defaultStrength: invertedDefault, cells } }
    : candidate));
}
export function toggleLayerBlink(id: string): boolean {
  if (!authoredEditsAllowed()) return false;
  if (!get(layers).some((layer) => layer.id === id)) return false;
  pushHistory();
  layers.update(($l) => $l.map((l) => (l.id === id ? { ...l, blink: !l.blink } : l)));
  return true;
}
export function setLayerOffsetDirect(id: string, offset: EditorPoint): false | void {
  if (!authoredEditsAllowed()) return false;
  layers.update(($l) => $l.map((l) => (l.id === id ? { ...l, offset: { ...offset } } : l)));
  noteAuthoredMutation();
}
export function setEffectMaskOffsetDirect(id: string, offset: Partial<EditorPoint> | null | undefined): false | void {
  if (!authoredEditsAllowed()) return false;
  const next = { x: Math.round(Number(offset?.x) || 0), y: Math.round(Number(offset?.y) || 0) };
  layers.update(($layers) => $layers.map((layer) => (
    layer.id === id && layer.type === 'effect' && layer.mask
      ? { ...layer, mask: { ...layer.mask, offset: next } }
      : layer
  )));
  noteAuthoredMutation();
}

export function setContentMaskOffsetDirect(id: string, offset: Partial<EditorPoint> | null | undefined): false | void {
  if (!authoredEditsAllowed()) return false;
  const next = { x: Math.round(Number(offset?.x) || 0), y: Math.round(Number(offset?.y) || 0) };
  layers.update(($layers) => $layers.map((layer) => (
    layer.id === id && layer.contentMask
      ? { ...layer, contentMask: { ...layer.contentMask, offset: next } }
      : layer
  )));
  noteAuthoredMutation();
}
export function translateLayerCells(id: string, dx: number, dy: number): false | void {
  if (!authoredEditsAllowed()) return false;
  if (!dx && !dy) return;
  const selected = get(selectedLayerIds);
  const ids = selected.has(id) && selected.size > 1
    ? selected
    : new Set([id]);
  layers.update(($layers) => $layers.map((layer) => {
    const movable = layer.type === 'cell' || layer.type === 'background';
    return ids.has(layer.id) && movable
      ? { ...layer, cells: cmTranslate(layer.cells, dx, dy) }
      : layer;
  }));
  noteAuthoredMutation();
}
export function translateEffectMaskCells(id: string, dx: number, dy: number): false | void {
  if (!authoredEditsAllowed()) return false;
  if (!dx && !dy) return;
  layers.update(($layers) => $layers.map((layer) => {
    if (layer.id !== id || layer.type !== 'effect' || !layer.mask) return layer;
    return {
      ...layer,
      mask: { ...layer.mask, cells: cmTranslate(layer.mask.cells || {}, dx, dy) },
    };
  }));
  noteAuthoredMutation();
}
export function toggleLayerVisible(id: string): boolean {
  if (!authoredEditsAllowed()) return false;
  if (!get(layers).some((layer) => layer.id === id)) return false;
  pushHistory();
  layers.update(($l) => $l.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));
  return true;
}
export function renameLayer(id: string, name: string): boolean {
  if (!authoredEditsAllowed()) return false;
  const layer = getLayer(id);
  if (!layer || layer.name === name) return false;
  pushHistory();
  layers.update(($l) => $l.map((l) => (l.id === id ? { ...l, name } : l)));
  return true;
}
export function normalizeGroups(list: EditorLayer[]): EditorLayer[] {
  const groupIds = new Set(list.filter((l) => l.type === 'group').map((l) => l.id));
  return list.map((l, i) => {
    if (!l.groupId) return l;
    if (!groupIds.has(l.groupId)) return { ...l, groupId: null };
    let ok = false;
    for (let j = i - 1; j >= 0; j--) {
      const p = list[j]!;
      if (p.type === 'group' && p.id === l.groupId) { ok = true; break; }
      if (p.groupId === l.groupId) continue;
      break;
    }
    return ok ? l : { ...l, groupId: null };
  });
}

// Offsets are parent-local, so subtract the new parent and add the old parent to keep
// the layer fixed in world space while ownership changes.
function reparentedLayer(stack: EditorLayer[], layer: EditorLayer, groupId: string | null): EditorLayer {
  const previousGroupId = layer.groupId || null;
  const nextGroupId = groupId || null;
  if (previousGroupId === nextGroupId) return layer;
  const groupOffset = (id: string | null): EditorPoint => {
    const group = id == null ? null : stack.find((candidate) => candidate.id === id);
    return {
      x: Number(group?.offset?.x) || 0,
      y: Number(group?.offset?.y) || 0,
    };
  };
  const previous = groupOffset(previousGroupId);
  const next = groupOffset(nextGroupId);
  const offset = {
    x: (Number(layer.offset?.x) || 0) + previous.x - next.x,
    y: (Number(layer.offset?.y) || 0) + previous.y - next.y,
  };
  return {
    ...layer,
    groupId: nextGroupId,
    ...(layer.offset || offset.x || offset.y ? { offset } : {}),
  };
}

export function computeGapMove(
  stack: EditorLayer[],
  fromId: string,
  beforeId: string | null,
  intoGroup: boolean,
): EditorLayer[] {
  const moved = stack.find((layer) => layer.id === fromId);
  if (moved == null || fromId === beforeId) return stack;

  const block = [moved];
  if (moved.type === 'group') {
    const groupIndex = stack.indexOf(moved);
    for (let i = groupIndex + 1; i < stack.length && stack[i]!.groupId === moved.id; i++) {
      block.push(stack[i]!);
    }
  }
  const blockSet = new Set(block);
  if (block.some((layer) => layer.id === beforeId)) return stack;
  const rest = stack.filter((layer) => !blockSet.has(layer));

  let at = beforeId == null ? rest.length : rest.findIndex((layer) => layer.id === beforeId);
  if (at < 0) at = rest.length;

  if (moved.type === 'group') {
    let a = at;
    const above = rest[a - 1];
    const enclosingId = above ? (above.groupId || (above.type === 'group' ? above.id : null)) : null;
    if (enclosingId != null) {
      while (a < rest.length && rest[a]!.groupId === enclosingId) a++;
    }
    const next = rest.slice();
    next.splice(a, 0, ...block);
    return next;
  }

  const above = rest[at - 1], below = rest[at];
  const encl = (row: EditorLayer | undefined): string | null => row ? (row.type === 'group' ? row.id : (row.groupId || null)) : null;
  const enclAbove = encl(above);
  const enclBelow = below && below.type !== 'group' ? (below.groupId || null) : null;
  const gid = intoGroup ? (enclAbove ?? enclBelow ?? null) : null;

  if (gid != null) {
    const header = rest.findIndex((layer) => layer.id === gid);
    const lo = header + 1;
    let end = lo;
    while (end < rest.length && rest[end]!.groupId === gid) end++;
    at = Math.max(lo, Math.min(at, end));
  } else if (enclAbove != null && enclAbove === enclBelow) {
    const groupId = enclAbove;
    while (at < rest.length && rest[at]!.groupId === groupId) at++;
  }
  const next = rest.slice();
  next.splice(at, 0, reparentedLayer(stack, moved, gid));
  return next;
}

export function moveLayerToGap(fromId: string, beforeId: string | null, intoGroup: boolean): false | void {
  if (!authoredEditsAllowed()) return false;
  const current = get(layers);
  const next = normalizeGroups(computeGapMove(current, fromId, beforeId, intoGroup));
  if (sameLayerOrder(current, next)) return;
  pushHistory();
  layers.set(next);
}

export function computeSelectedGapMove(
  stack: EditorLayer[],
  selectedIds: Iterable<string>,
  beforeId: string | null,
  intoGroup: boolean,
): EditorLayer[] {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const moving: EditorLayer[] = [];
  let containsGroup = false;
  for (let i = 0; i < stack.length; i++) {
    const layer = stack[i]!;
    if (layer.type === 'group' && selected.has(layer.id)) {
      containsGroup = true;
      moving.push(layer);
      while (i + 1 < stack.length && stack[i + 1]!.groupId === layer.id) moving.push(stack[++i]!);
    } else if (selected.has(layer.id)) {
      moving.push(layer);
    }
  }
  if (!moving.length) return stack;

  const movingIds = new Set(moving.map((layer) => layer.id));
  if (beforeId != null && movingIds.has(beforeId)) {
    const sourceIndex = stack.findIndex((layer) => layer.id === beforeId);
    beforeId = stack.slice(sourceIndex + 1).find((layer) => !movingIds.has(layer.id))?.id ?? null;
  }
  const rest = stack.filter((layer) => !movingIds.has(layer.id));
  let at = beforeId == null ? rest.length : rest.findIndex((layer) => layer.id === beforeId);
  if (at < 0) at = rest.length;

  let block: EditorLayer[];
  if (containsGroup) {
    const above = rest[at - 1];
    const enclosingId = above ? (above.groupId || (above.type === 'group' ? above.id : null)) : null;
    if (enclosingId != null) while (at < rest.length && rest[at]!.groupId === enclosingId) at++;
    block = moving.map((layer) => (
      layer.type === 'group' || (layer.groupId && movingIds.has(layer.groupId))
        ? layer
        : reparentedLayer(stack, layer, null)
    ));
  } else {
    const above = rest[at - 1], below = rest[at];
    const encl = (row: EditorLayer | undefined): string | null => row ? (row.type === 'group' ? row.id : (row.groupId || null)) : null;
    const enclAbove = encl(above);
    const enclBelow = below && below.type !== 'group' ? (below.groupId || null) : null;
    const groupId = intoGroup ? (enclAbove ?? enclBelow ?? null) : null;
    if (!intoGroup && enclAbove != null && enclAbove === enclBelow) {
      while (at < rest.length && rest[at]!.groupId === enclAbove) at++;
    }
    block = moving.map((layer) => reparentedLayer(stack, layer, groupId));
  }

  const next = rest.slice();
  next.splice(at, 0, ...block);
  return normalizeGroups(next);
}

export function canonicalLayerDropGap(
  stack: EditorLayer[],
  selectedIds: Iterable<string>,
  dragFromId: string,
  beforeId: string | null,
  intoGroup: boolean,
): { beforeId: string | null; intoGroup: boolean } | null {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const roots = selected.has(dragFromId) && selected.size > 1
    ? new Set(selected)
    : new Set([dragFromId]);
  const movingIds = new Set(roots);
  for (const layer of stack) {
    if (layer.groupId && roots.has(layer.groupId)) movingIds.add(layer.id);
  }
  const preview = roots.size > 1
    ? computeSelectedGapMove(stack, roots, beforeId, intoGroup)
    : computeGapMove(stack, dragFromId, beforeId, intoGroup);
  const movingRows = preview.filter((layer) => movingIds.has(layer.id));
  if (!movingRows.length) return null;
  const lastMovingIndex = Math.max(
    ...movingRows.map((layer) => preview.findIndex((candidate) => candidate.id === layer.id)),
  );
  const next = preview.slice(lastMovingIndex + 1).find((layer) => !movingIds.has(layer.id));
  const firstRoot = preview.find((layer) => roots.has(layer.id));
  return {
    beforeId: next?.id ?? null,
    intoGroup: firstRoot?.type !== 'group' && firstRoot?.groupId != null,
  };
}

export function reorderSelectedLayers(beforeId: string | null, intoGroup: boolean): false | void {
  if (!authoredEditsAllowed()) return false;
  const current = get(layers);
  const next = computeSelectedGapMove(current, get(selectedLayerIds), beforeId, intoGroup);
  if (sameLayerOrder(current, next)) return;
  pushHistory();
  layers.set(next);
}

function sameLayerOrder(first: EditorLayer[], second: EditorLayer[]): boolean {
  return first.length === second.length && first.every((layer, index) => (
    layer.id === second[index]?.id &&
    (layer.groupId || null) === (second[index]?.groupId || null)
  ));
}

interface HistorySnapshot {
  layers: EditorLayer[] | null;
  dims: EditorSize;
  activeId: string | null;
  activePart: EditorLayerPart;
  selected: Set<string>;
  cellSelection: Set<string>;
  nextLayerNumber: number;
  nextGroupNumber: number;
  contributed: unknown[];
}

interface HistoryContributor {
  capture: () => unknown;
  restore: (state: unknown) => void;
  reachable?: ((state: unknown) => Iterable<string> | null | undefined) | undefined;
}

interface LayerHistoryAuthority {
  initializeView?: ((layers: EditorLayer[]) => void) | undefined;
  restoreView?: ((liveById: Map<string, EditorLayer>) => EditorLayer[]) | undefined;
}

const undoStack: HistorySnapshot[] = [];
const redoStack: HistorySnapshot[] = [];
export const canUndo = writable<boolean>(false);
export const canRedo = writable<boolean>(false);
export const authoredRevision = writable<number>(0);
export const layerPanelRevision = writable<number>(0);
const MAX_HISTORY = 100;
const historyContributors: HistoryContributor[] = [];
let layerHistoryAuthority: LayerHistoryAuthority | null = null;

export function registerLayerHistoryAuthority(authority: LayerHistoryAuthority): () => void {
  layerHistoryAuthority = authority;
  return () => {
    if (layerHistoryAuthority === authority) layerHistoryAuthority = null;
  };
}

export function registerHistoryContributor<T>(
  capture: () => T,
  restore: (state: T) => void,
  options: { reachable?: ((state: T) => Iterable<string> | null | undefined) | undefined } = {},
): () => void {
  const contributor: HistoryContributor = {
    capture,
    restore: (state) => restore(state as T),
    ...(options.reachable
      ? { reachable: (state) => options.reachable!(state as T) }
      : {}),
  };
  historyContributors.push(contributor);
  return () => {
    const index = historyContributors.indexOf(contributor);
    if (index >= 0) historyContributors.splice(index, 1);
  };
}

export function collectHistoryReachability(): Set<string> {
  const output = new Set<string>();
  const snapshots = [
    ...undoStack,
    ...redoStack,
    ...(strokeSnapshot ? [strokeSnapshot] : []),
    ...(strokeRedo || []),
  ];
  for (const snap of snapshots) {
    snap.contributed?.forEach((state, index) => {
      const values = historyContributors[index]?.reachable?.(state);
      if (values) for (const value of values) output.add(value);
    });
  }
  return output;
}

function snapshot(): HistorySnapshot {
  return {
    layers: layerHistoryAuthority ? null : cloneLayers(get(layers)),
    dims: { ...get(dims) },
    activeId: get(activeLayerId),
    activePart: get(activeLayerPart),
    selected: new Set(get(selectedLayerIds)),
    cellSelection: new Set(get(cellSelection)),
    nextLayerNumber,
    nextGroupNumber,
    contributed: historyContributors.map(({ capture }) => capture()),
  };
}

function sameHistoryValue(first: unknown, second: unknown): boolean {
  if (first === second) return true;
  if (first == null || second == null || typeof first !== typeof second) return false;
  if (first instanceof Set || second instanceof Set) {
    if (!(first instanceof Set) || !(second instanceof Set) || first.size !== second.size) return false;
    return [...first].every((value) => second.has(value));
  }
  if (Array.isArray(first) || Array.isArray(second)) {
    return Array.isArray(first) && Array.isArray(second) &&
      first.length === second.length &&
      first.every((value, index) => sameHistoryValue(value, second[index]));
  }
  if (typeof first !== 'object') return false;
  const firstPrototype = Object.getPrototypeOf(first);
  const secondPrototype = Object.getPrototypeOf(second);
  if (firstPrototype !== secondPrototype || (firstPrototype !== Object.prototype && firstPrototype !== null)) {
    return false;
  }
  const firstRecord = first as Record<string, unknown>;
  const secondRecord = second as Record<string, unknown>;
  const firstKeys = Object.keys(firstRecord);
  const secondKeys = Object.keys(secondRecord);
  return firstKeys.length === secondKeys.length &&
    firstKeys.every((key) => Object.prototype.hasOwnProperty.call(secondRecord, key) &&
      sameHistoryValue(firstRecord[key], secondRecord[key]));
}

function restore(snap: HistorySnapshot): void {
  const liveById = new Map(get(layers).map((layer) => [layer.id, layer]));
  snap.contributed?.forEach((state, index) => historyContributors[index]?.restore(state));
  nextLayerNumber = snap.nextLayerNumber;
  nextGroupNumber = snap.nextGroupNumber;
  const restoredLayers: EditorLayer[] = snap.layers
    ? snap.layers.map((layer): EditorLayer => ({
      ...layer,
      ...retainedLayerRuntime(layer, liveById.get(layer.id)),
    }) as EditorLayer)
    : layerHistoryAuthority?.restoreView?.(liveById) || get(layers);
  if (snap.layers) layers.set(restoredLayers);
  dims.set({ ...snap.dims });
  const ids = new Set(restoredLayers.map((l) => l.id));
  activeLayerId.set(snap.activeId != null && ids.has(snap.activeId)
    ? snap.activeId
    : (restoredLayers[0]?.id ?? null));
  const maskActive = snap.activePart === 'mask' &&
    restoredLayers.some((layer) => layer.id === snap.activeId && layer.type === 'effect' && layer.mask);
  const contentMaskActive = snap.activePart === 'content-mask' &&
    restoredLayers.some((layer) => layer.id === snap.activeId && !!layer.contentMask);
  activeLayerPart.set(maskActive ? 'mask' : contentMaskActive ? 'content-mask' : 'layer');
  selectedLayerIds.set(new Set([...snap.selected].filter((id) => ids.has(id))));
  cellSelection.set(new Set(snap.cellSelection));
  if (!get(selectedLayerIds).size && get(activeLayerId) != null) {
    selectedLayerIds.set(new Set([get(activeLayerId)!]));
  }
}

function syncFlags(): void {
  canUndo.set(undoStack.length > 0);
  canRedo.set(redoStack.length > 0);
}

function resetHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;
  strokeOpen = false;
  strokeSnapshot = null;
  strokeRedo = null;
  strokeMutated = false;
  syncFlags();
}

let strokeOpen = false;
let strokeSnapshot: HistorySnapshot | null = null;
let strokeRedo: HistorySnapshot[] | null = null;
let strokeMutated = false;
export function noteAuthoredMutation(): void {
  if (strokeOpen) strokeMutated = true;
  else scheduleAuthoredMutationSettlement();
  authoredRevision.update((revision) => revision + 1);
}

// A stroke owns one pre-edit snapshot and temporarily removes redo; no-op or cancel
// restores that redo branch instead of manufacturing a history entry.
export function beginStroke(): false | void | true {
  if (!authoredEditsAllowed()) return false;
  if (strokeOpen) return;
  strokeOpen = true;
  strokeMutated = false;
  strokeSnapshot = snapshot();
  strokeRedo = redoStack.splice(0);
  undoStack.push(strokeSnapshot);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  syncFlags();
  return true;
}
export function endStroke(): boolean {
  if (!strokeOpen) return false;
  const entry = strokeSnapshot ? undoStack.lastIndexOf(strokeSnapshot) : -1;
  const savedRedo = strokeRedo || [];
  const mutated = strokeMutated;
  const changed = mutated && !sameHistoryValue(strokeSnapshot, snapshot());
  if (!changed && entry >= 0) undoStack.splice(entry, 1);
  strokeOpen = false;
  strokeSnapshot = null;
  strokeRedo = null;
  strokeMutated = false;
  if (!changed) {
    redoStack.length = 0;
    redoStack.push(...savedRedo);
    syncFlags();
  }
  if (changed && !mutated) noteAuthoredMutation();
  else if (changed) scheduleAuthoredMutationSettlement();
  else if (mutated) notifyAuthoredContentReverted();
  return changed;
}
export function cancelStroke(): boolean {
  if (!strokeOpen || !strokeSnapshot) return false;
  const entry = undoStack.lastIndexOf(strokeSnapshot);
  if (entry >= 0) undoStack.splice(entry, 1);
  const start = strokeSnapshot;
  const savedRedo = strokeRedo || [];
  const changed = strokeMutated;
  strokeOpen = false;
  strokeSnapshot = null;
  strokeRedo = null;
  strokeMutated = false;
  restore(start);
  if (changed) noteAuthoredMutation();
  redoStack.length = 0;
  redoStack.push(...savedRedo);
  syncFlags();
  if (changed) notifyAuthoredContentReverted();
  return true;
}
function pushHistory(): void {
  if (strokeOpen) {
    noteAuthoredMutation();
    return;
  }
  undoStack.push(snapshot());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.splice(0);
  noteAuthoredMutation();
  syncFlags();
}
export function checkpointHistory(): void {
  pushHistory();
}
export function undo(): false | void {
  if (!authoredEditsAllowed()) return false;
  if (strokeOpen || !undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop()!);
  noteAuthoredMutation();
  syncFlags();
  notifyAuthoredContentReverted();
}
export function redo(): false | void {
  if (!authoredEditsAllowed()) return false;
  if (strokeOpen || !redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop()!);
  noteAuthoredMutation();
  syncFlags();
  notifyAuthoredContentReverted();
}
