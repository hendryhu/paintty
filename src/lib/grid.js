import { writable, derived, get } from 'svelte/store';
import { cmGet, cmSet, cmClone, cmTranslate, cmParse, cmFromGrid } from './cellmap.js';
import { blendHex } from './color.js';
import { applyEffectToGrid, colorLuminance } from './effects.js';
import { authoredEditsAllowed } from './playbackState.js';
import {
  MIN_VIDEO_CLIP_SECONDS,
  normalizeVideoClip,
} from './video.js';
import { mediaAssetById } from './mediaRegistry.js';
import { assertUuid, newUuid } from './uuid.js';
import { defaultProjectDraft } from './projectPresets.js';
import { layerDeleteClosure } from './layerActions.js';

const initialProjectDraft = defaultProjectDraft();
export const dims = writable({
  w: initialProjectDraft.columns,
  h: initialProjectDraft.rows,
});
export const cropPending = writable(null);
export let GRID_W = initialProjectDraft.columns;
export let GRID_H = initialProjectDraft.rows;
dims.subscribe(({ w, h }) => { GRID_W = w; GRID_H = h; });

let nextLayerNumber = 1;
let nextGroupNumber = 1;

function nextLayerName() {
  return 'Layer ' + nextLayerNumber++;
}
function nextGroupName() {
  return 'Group ' + nextGroupNumber++;
}
function syncLayerNameCounters(stack) {
  nextLayerNumber = Math.max(0, ...stack.map((layer) => {
    if (layer.type === 'group') return 0;
    const match = /^Layer (\d+)$/.exec(layer.name || '');
    return match ? +match[1] : 0;
  })) + 1;
  nextGroupNumber = Math.max(0, ...stack.map((layer) => {
    if (layer.type !== 'group') return 0;
    const match = /^Group (\d+)$/.exec(layer.name || '');
    return match ? +match[1] : 0;
  })) + 1;
}
function makeLayer(name, type = 'cell') {
  const layer = { id: newUuid('layer'), name, type, visible: true, cells: {} };
  if (type === 'effect') layer.effect = { kind: 'brightness', intensity: 0.25 };
  return layer;
}

function sameShallowObject(left, right) {
  const leftKeys = Object.keys(left || {});
  const rightKeys = Object.keys(right || {});
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.is(left[key], right[key]));
}

function seedLayers() {
  return [makeLayer(nextLayerName())];
}

export const layers = writable(seedLayers());
export const activeLayerId = writable(get(layers)[0].id);
export const activeLayerPart = writable('layer');
export const selectedLayerIds = writable(new Set([get(layers)[0].id]));
export const cellSelection = writable(new Set());

const layerStackEmptyHandlers = new Set();
const effectMaskChangeHandlers = new Set();
const authoredMutationSettledHandlers = new Set();
const authoredContentRevertedHandlers = new Set();
const shapeRasterizeHandlers = new Set();
let authoredMutationSettlementScheduled = false;

export function registerLayerStackEmptyHandler(handler) {
  layerStackEmptyHandlers.add(handler);
  return () => layerStackEmptyHandlers.delete(handler);
}

export function registerEffectMaskChangeHandler(handler) {
  effectMaskChangeHandlers.add(handler);
  return () => effectMaskChangeHandlers.delete(handler);
}

export function registerAuthoredMutationSettledHandler(handler) {
  authoredMutationSettledHandlers.add(handler);
  return () => authoredMutationSettledHandlers.delete(handler);
}

export function registerAuthoredContentRevertedHandler(handler) {
  authoredContentRevertedHandlers.add(handler);
  return () => authoredContentRevertedHandlers.delete(handler);
}

export function registerShapeRasterizeHandler(handler) {
  shapeRasterizeHandlers.add(handler);
  return () => shapeRasterizeHandlers.delete(handler);
}

function notifyAuthoredContentReverted() {
  for (const handler of authoredContentRevertedHandlers) handler();
}

function scheduleAuthoredMutationSettlement() {
  if (authoredMutationSettlementScheduled) return;
  authoredMutationSettlementScheduled = true;
  queueMicrotask(() => {
    authoredMutationSettlementScheduled = false;
    for (const handler of authoredMutationSettledHandlers) handler();
  });
}

function notifyLayerStackEmpty() { for (const handler of layerStackEmptyHandlers) handler(); }
function notifyEffectMaskChanged(id, present) {
  for (const handler of effectMaskChangeHandlers) handler(id, present);
}
function notifyShapeRasterize(ids) {
  for (const handler of shapeRasterizeHandlers) handler(ids);
}

export function cloneLayers(ls) {
  return ls.map((l) => {
    const {
      raster, videoElement, videoBlob, videoURL, runtimeMediaKey, ...durable
    } = l;
    return {
      ...durable,
      cells: cmClone(l.cells),
      runs: Array.isArray(l.runs) ? l.runs.map((run) => ({ ...run })) : l.runs,
      effect: l.effect ? { ...l.effect } : l.effect,
      mask: l.mask
        ? {
          ...l.mask,
          cells: cmClone(l.mask.cells || {}),
          offset: { x: l.mask.offset?.x || 0, y: l.mask.offset?.y || 0 },
        }
        : l.mask,
    };
  });
}

// History restores durable data but reuses runtime media only when the current asset
// generation still matches the snapshot's reference.
function retainedLayerRuntime(snapshotLayer, liveLayer) {
  if (!liveLayer || snapshotLayer.type !== liveLayer.type ||
    (snapshotLayer.type !== 'image' && snapshotLayer.type !== 'video')) return {};
  const snapshotAssetId = snapshotLayer.type === 'image'
    ? snapshotLayer.assetId
    : snapshotLayer.videoClip?.assetId;
  const liveAssetId = liveLayer.type === 'image'
    ? liveLayer.assetId
    : liveLayer.videoClip?.assetId;
  if (snapshotAssetId !== liveAssetId) return {};
  if (snapshotAssetId) {
    const asset = mediaAssetById(snapshotAssetId);
    const expectedKey = asset
      ? `${asset.assetId}:${asset.hash}:${asset.generation}`
      : null;
    if (!expectedKey || liveLayer.runtimeMediaKey !== expectedKey) return {};
  } else if (liveLayer.runtimeMediaKey) {
    return {};
  }
  const runtime = {};
  for (const field of ['raster', 'videoElement', 'videoBlob', 'videoURL', 'runtimeMediaKey']) {
    if (liveLayer[field] != null) runtime[field] = liveLayer[field];
  }
  return runtime;
}
export function newLayerId() { return newUuid('layer'); }

export function selectLayerPart(id, part = 'layer', preserveSelection = false) {
  const targetPart = part === 'mask' ? 'mask' : 'layer';
  if (targetPart === 'mask') {
    const layer = get(layers).find((candidate) => candidate.id === id);
    if (layer?.type !== 'effect' || !layer.mask) return false;
  }
  activeLayerId.set(id);
  activeLayerPart.set(targetPart);
  if (!preserveSelection || targetPart === 'mask') selectedLayerIds.set(new Set([id]));
  return true;
}
export function selectLayer(id) { return selectLayerPart(id); }
export function selectEffectMask(id) { return selectLayerPart(id, 'mask'); }
export function clearLayerSelection() {
  const active = get(activeLayerId);
  const selected = get(selectedLayerIds);
  const changed = active == null
    ? selected.size > 0
    : selected.size !== 1 || !selected.has(active);
  if (changed) selectedLayerIds.set(active == null ? new Set() : new Set([active]));
  return changed;
}
export function isEditingEffectMask(layer = null) {
  const active = layer || get(layers).find((candidate) => candidate.id === get(activeLayerId));
  return get(activeLayerPart) === 'mask' && active?.type === 'effect' && !!active.mask;
}
export function selectLayerWithModifiers(id, event = {}) {
  activeLayerPart.set('layer');
  if (event.shiftKey) selectLayerRange(id);
  else if (event.ctrlKey || event.metaKey) toggleLayerSelected(id);
  else selectLayer(id);
}

export function toggleLayerSelected(id) {
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
  } else if (!get(selectedLayerIds).has(get(activeLayerId))) {
    activeLayerId.set([...get(selectedLayerIds)][0]);
  }
}
function selectLayerRange(id) {
  const $l = get(layers);
  const collapsed = new Set($l.filter((layer) => layer.type === 'group' && layer.collapsed).map((layer) => layer.id));
  const visible = $l.filter((layer) => !(layer.groupId && collapsed.has(layer.groupId)));
  const active = $l.find((layer) => layer.id === get(activeLayerId));
  const anchorId = active && !visible.includes(active) ? active.groupId : active?.id;
  const a = visible.findIndex((l) => l.id === anchorId);
  const b = visible.findIndex((l) => l.id === id);
  if (a < 0 || b < 0) { selectLayer(id); return; }
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const set = new Set();
  for (let i = lo; i <= hi; i++) set.add(visible[i].id);
  selectedLayerIds.set(set);
  activeLayerId.set(id);
}
function pruneSelection() {
  const ids = new Set(get(layers).map((layer) => layer.id));
  selectedLayerIds.update((selected) => {
    const next = new Set([...selected].filter((id) => ids.has(id)));
    const activeId = get(activeLayerId);
    if (activeId != null && ids.has(activeId)) next.add(activeId);
    return next;
  });
}

activeLayerId.subscribe(() => {
  const layer = get(layers).find((candidate) => candidate.id === get(activeLayerId));
  if (get(activeLayerPart) === 'mask' && !layer?.mask) activeLayerPart.set('layer');
});

export function groupOf($layers, layer) {
  return layer.groupId
    ? $layers.find((candidate) =>
      candidate.id === layer.groupId && candidate.type === 'group')
    : null;
}

export function effOffset($layers, layer) {
  const group = groupOf($layers, layer);
  const x = layer.offset?.x || 0;
  const y = layer.offset?.y || 0;
  if (!group) return { x, y };
  return {
    x: x + (group.offset?.x || 0),
    y: y + (group.offset?.y || 0),
  };
}
export function effMaskOffset($layers, layer) {
  const layerOffset = effOffset($layers, layer);
  return {
    x: layerOffset.x + (layer.mask?.offset?.x || 0),
    y: layerOffset.y + (layer.mask?.offset?.y || 0),
  };
}
export function layerBox($layers, l) {
  if (!l?.box) return null;
  const offset = effOffset($layers, l);
  return { ...l.box, x: l.box.x + offset.x, y: l.box.y + offset.y };
}
export function effVisible($layers, l) {
  const g = groupOf($layers, l);
  return l.visible && (!g || g.visible);
}

export function isBackgroundLayer(layer) {
  return layer?.type === 'background' || (layer?.type === 'shape' && layer.shape?.channel === 'background');
}

export function isReferenceOnlyLayer(layer) {
  return layer?.type === 'image' || layer?.type === 'video';
}

function layerContribution(cell, layer, respectOpacity = true) {
  if (!cell) return null;
  if (respectOpacity && (layer.opacity ?? 1) <= 0) return null;
  if (isBackgroundLayer(layer)) {
    const bg = cell.bg ?? cell.fg;
    return bg ? { bg } : null;
  }
  const out = {};
  if (cell.c || cell.cont) {
    out.c = cell.c || '';
    out.fg = cell.fg ?? null;
    if (cell.cont) out.cont = true;
  }
  if (cell.bg) out.bg = cell.bg;
  return out.c != null || out.bg ? out : null;
}

export function mergeCellChannels(base, cell, layer, blink = false, options = {}) {
  const respectOpacity = options.referenceOpacity !== false;
  let over = layerContribution(cell, layer, respectOpacity);
  if (!over) return base;
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

export function applyBlinkPhase(cells, visible = true) {
  if (visible) return cells;
  return cells.map((row) => row.map((cell) => {
    if (!cell?.blink) return cell;
    if (!cell.bg) return null;
    return { bg: cell.bg, ...(cell.offCanvas ? { offCanvas: true } : {}) };
  }));
}

export function hasVisibleBlinkingGlyph($layers) {
  return $layers.some((layer) =>
    layer.type !== 'group'
    && layer.type !== 'effect'
    && !isReferenceOnlyLayer(layer)
    && layer.blink
    && effVisible($layers, layer)
    && Object.values(layer.cells || {}).some((cell) => cell?.c || cell?.cont));
}
function markLayerCoverage(coverage, $layers, layer, vp, options) {
  if (layer.type === 'group' || layer.type === 'effect' ||
      isReferenceOnlyLayer(layer) || !effVisible($layers, layer)) return;
  const offset = effOffset($layers, layer);
  const ox = Math.round(offset.x);
  const oy = Math.round(offset.y);
  for (const [key, cell] of Object.entries(layer.cells || {})) {
    const over = layerContribution(cell, layer, options.referenceOpacity !== false);
    if (!over) continue;
    const point = cmParse(key);
    const gx = point.x + ox - vp.x;
    const gy = point.y + oy - vp.y;
    if (gx < 0 || gy < 0 || gx >= vp.w || gy >= vp.h) continue;
    const channels = coverage[gy][gx] || {};
    if (over.c != null) channels.fg = true;
    if (over.bg) channels.bg = true;
    coverage[gy][gx] = channels;
  }
}

function clippedEffectCoverage($layers, effectIndex, vp, options) {
  const coverage = Array.from({ length: vp.h }, () => Array(vp.w).fill(null));
  const target = $layers[effectIndex + 1];
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
export function compositeWorld($layers, vp, canvasVP = null, options = {}) {
  const out = Array.from({ length: vp.h }, () => Array(vp.w).fill(null));
  for (let i = $layers.length - 1; i >= 0; i--) {
    const layer = $layers[i];
    if (layer.type === 'effect') {
      if (effVisible($layers, layer)) {
        const coverage = layer.clipped ? clippedEffectCoverage($layers, i, vp, options) : null;
        const offset = effMaskOffset($layers, layer);
        const maskViewport = { ...vp, x: vp.x - Math.round(offset.x), y: vp.y - Math.round(offset.y) };
        applyEffectToGrid(out, layer, maskViewport, coverage);
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
      let c = mergeCellChannels(out[gy][gx], cell, layer, blink, options);
      if (!c) continue;
      if (canvasVP && (wx < canvasVP.x || wy < canvasVP.y || wx >= canvasVP.x + canvasVP.w || wy >= canvasVP.y + canvasVP.h)) {
        c = { ...c, offCanvas: true };
      }
      out[gy][gx] = c;
    }
  }
  return out;
}

export const grid = derived([layers, activeLayerId, dims], ([$layers, , $dims]) =>
  compositeWorld($layers, { x: 0, y: 0, w: $dims.w, h: $dims.h })
);

export function inBounds(x, y) {
  return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
}

export function resizeCanvas(w, h, recordHistory = true) {
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

export function setLayers(layerDefs) {
  const assigned = layerDefs.map((layer) => layer.id ?? layer.srcId ?? newLayerId());
  const idBySource = new Map(layerDefs.flatMap((layer, index) => {
    const source = layer.srcId ?? layer.id;
    return source == null ? [] : [[source, assigned[index]]];
  }));
  if (new Set(assigned).size !== assigned.length) throw new Error('Layer IDs must be unique.');
  const built = layerDefs.map((l, index) => {
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
    };
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

export function resetEditorStateForProjectLoad() {
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

function asMap(gridOrMap) {
  return Array.isArray(gridOrMap) ? cmFromGrid(gridOrMap) : gridOrMap;
}

export function createTextLayer(box, text, fg, wrap, renderFn) {
  if (!authoredEditsAllowed()) return false;
  pushHistory();
  const layer = {
    id: newLayerId(), name: nextLayerName(), type: 'text', visible: true,
    text, box, wrap, fg, runs: [], cells: asMap(renderFn(text, box, fg, wrap, [])),
  };
  layers.update(($l) => [layer, ...$l]);
  selectLayer(layer.id);
  return layer.id;
}
export function updateTextLayer(id, patch, renderFn) {
  if (!authoredEditsAllowed()) return false;
  layers.update(($l) => $l.map((l) => {
    if (l.id !== id || l.type !== 'text') return l;
    const merged = { ...l, ...patch };
    merged.cells = asMap(renderFn(merged.text, merged.box, merged.fg, merged.wrap, merged.runs || []));
    return merged;
  }));
  noteAuthoredMutation();
}
export function getLayer(id) {
  return get(layers).find((l) => l.id === id) || null;
}

export function createShapeLayer(shape, renderFn) {
  if (!authoredEditsAllowed()) return false;
  pushHistory();
  const layer = {
    id: newLayerId(), name: nextLayerName(), type: 'shape', visible: true,
    opacity: 1, shape, cells: asMap(renderFn(shape)),
  };
  layers.update(($l) => [layer, ...$l]);
  selectLayer(layer.id);
  return layer.id;
}

export function createPaintLayer(type = 'cell') {
  if (!authoredEditsAllowed() || (type !== 'cell' && type !== 'background')) return false;
  pushHistory();
  const layer = makeLayer(nextLayerName(), type);
  layers.update(($layers) => [layer, ...$layers]);
  selectLayer(layer.id);
  return layer.id;
}

export function updateShapeLayer(id, patch, renderFn) {
  if (!authoredEditsAllowed()) return false;
  layers.update(($l) => $l.map((l) => {
    if (l.id !== id || l.type !== 'shape') return l;
    const shape = { ...l.shape, ...patch };
    return { ...l, shape, cells: asMap(renderFn(shape)) };
  }));
  noteAuthoredMutation();
}
export function setShapeLayerProperties(id, patch, renderFn) {
  if (!authoredEditsAllowed()) return false;
  const layer = getLayer(id);
  if (layer?.type !== 'shape') return false;
  const nextShape = { ...layer.shape, ...patch };
  if (sameShallowObject(layer.shape, nextShape)) return false;
  pushHistory();
  updateShapeLayer(id, patch, renderFn);
  return true;
}
export function rasterizeLayer(id) {
  if (!authoredEditsAllowed()) return false;
  const sel = get(selectedLayerIds);
  const ids = sel.has(id) ? new Set(sel) : new Set([id]);
  if (!get(layers).some((layer) => ids.has(layer.id) && layer.type === 'shape')) return false;
  pushHistory();
  // Materialize procedural frames after the Undo snapshot and before removing shape metadata.
  notifyShapeRasterize(ids);
  layers.update(($l) => $l.map((l) => {
    if (!ids.has(l.id) || l.type !== 'shape') return l;
    const { shape, ...rest } = l;
    return { ...rest, type: shape?.channel === 'background' ? 'background' : 'cell' };
  }));
  return true;
}

export function createImageLayer(name, raster, assetId) {
  if (!authoredEditsAllowed()) return false;
  pushHistory();
  const cw = GRID_W, ch = GRID_H * 2;
  const iw = raster.width, ih = raster.height;
  const fit = Math.min(1, cw / iw, ch / ih);
  const layer = {
    id: newLayerId(), name, type: 'image', visible: true,
    assetId: assertUuid(assetId, 'Image asset ID'), cells: {},
    sourceWidth: iw, sourceHeight: ih,
    transform: { x: GRID_W / 2, y: GRID_H / 2, scale: fit, rot: 0 },
  };
  layers.update(($l) => [...$l, layer]);
  selectLayer(layer.id);
  return layer.id;
}

export function createVideoLayer(name, source, startTick = 0) {
  if (!authoredEditsAllowed()) return false;
  pushHistory();
  const cw = GRID_W, ch = GRID_H * 2;
  const fit = Math.min(1, cw / source.width, ch / source.height);
  const layer = {
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
    }),
    transform: { x: GRID_W / 2, y: GRID_H / 2, scale: fit, rot: 0 },
  };
  layers.update(($l) => [...$l, layer]);
  selectLayer(layer.id);
  return layer.id;
}

// Relinking preserves on-canvas size and follows a new duration only when the old trim ended at EOF.
export function attachVideoSource(id, name, source) {
  if (!authoredEditsAllowed()) return false;
  const current = getLayer(id);
  if (!current || current.type !== 'video') return false;
  const assetId = normalizeVideoClip(current.videoClip).assetId;
  const duration = Math.max(0, Number(source.duration) || 0);
  const sourceWidth = Math.max(0, Number(source.width) || 0);
  const sourceHeight = Math.max(0, Number(source.height) || 0);
  pushHistory();
  layers.update(($l) => $l.map((l) => {
    if (l.type !== 'video' || normalizeVideoClip(l.videoClip).assetId !== assetId) return l;
    const previous = normalizeVideoClip(l.videoClip);
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
    });
    return {
      ...l,
      name: l.name || name,
      videoClip,
      transform,
    };
  }));
  return true;
}

export function replaceImageAssetSource(assetId, previousAsset, nextAsset) {
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

export function updateVideoClip(id, patch, history = true) {
  if (!authoredEditsAllowed()) return false;
  const layer = getLayer(id);
  if (!layer || layer.type !== 'video') return false;
  const current = normalizeVideoClip(layer.videoClip);
  const next = normalizeVideoClip({ ...current, ...patch });
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  if (history) pushHistory();
  layers.update(($l) => $l.map((l) => l.id === id ? { ...l, videoClip: next } : l));
  if (!history) noteAuthoredMutation();
  return true;
}

function rasterizeImageLayer(src, sampleScale = 8) {
  const size = get(dims);
  const offset = effOffset(get(layers), src);
  const w = size.w * sampleScale, h = size.h * 2 * sampleScale;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
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

export function snapshotLayerForConversion(id) {
  const src = getLayer(id);
  if (!src || (src.type !== 'image' && src.type !== 'video') || !src.raster) return null;
  return rasterizeImageLayer(src);
}

export function insertConvertedLayerPair(id, converted) {
  if (!authoredEditsAllowed()) return false;
  const src = getLayer(id);
  if (!src || (src.type !== 'image' && src.type !== 'video') || !src.raster) return null;
  const foreground = asMap(converted?.foreground ?? converted ?? {});
  const background = asMap(converted?.background ?? {});
  pushHistory();
  const groupId = newLayerId();
  const foregroundId = newLayerId();
  const group = {
    id: groupId, name: nextGroupName(), type: 'group', visible: true, collapsed: false, cells: {},
  };
  const glyphLayer = {
    id: foregroundId, name: nextLayerName(), type: 'cell', visible: true,
    groupId, cells: foreground,
  };
  const backgroundLayer = {
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
  return converted?.meta || null;
}

export function convertImageLayer(id, converter) {
  if (!authoredEditsAllowed()) return false;
  const raster = snapshotLayerForConversion(id);
  if (!raster) return null;
  return insertConvertedLayerPair(id, converter(raster));
}
function activeLayer($layers, id) {
  return $layers.find((l) => l.id === id) || $layers[0] || null;
}

function maskCellFromPaint(cell) {
  if (!cell) return { mask: 0 };
  if (Number.isFinite(cell.mask)) return { mask: Math.max(0, Math.min(1, cell.mask)) };
  return { mask: colorLuminance(cell.bg || cell.fg || '#ffffff') };
}

function sameCellValue(first, second) {
  if (first === second) return true;
  if (!first || !second) return false;
  const firstKeys = Object.keys(first);
  const secondKeys = Object.keys(second);
  return firstKeys.length === secondKeys.length &&
    firstKeys.every((key) => first[key] === second[key]);
}

function updateActiveCells(updates) {
  if (!authoredEditsAllowed()) return false;
  if (!updates.length) return;
  const id = get(activeLayerId);
  const active = get(layers).find((layer) => layer.id === id);
  if (!active || active.type === 'group') return;
  const editingMask = isEditingEffectMask(active);

  const $layers = get(layers);
  let changed = false;
  const nextLayers = $layers.map((layer) => {
    if (layer.id !== id) return layer;
    const cells = { ...(editingMask ? layer.mask?.cells : layer.cells) };
    const offset = editingMask ? effMaskOffset($layers, layer) : effOffset($layers, layer);
    const ox = Math.round(offset.x);
    const oy = Math.round(offset.y);
    for (const { x, y, cell } of updates) {
      const localX = x - ox;
      const localY = y - oy;
      const nextCell = editingMask ? maskCellFromPaint(cell) : cell;
      if (sameCellValue(cmGet(cells, localX, localY), nextCell)) continue;
      cmSet(cells, localX, localY, nextCell);
      changed = true;
    }
    if (!changed) return layer;
    return editingMask
      ? { ...layer, mask: { ...(layer.mask || { defaultStrength: 1 }), cells } }
      : { ...layer, cells };
  });
  if (!changed) return false;
  layers.set(nextLayers);
  noteAuthoredMutation();
  return true;
}

export function setCell(x, y, cell) {
  return updateActiveCells([{ x, y, cell }]);
}

export function setCells(updates) {
  return updateActiveCells(updates);
}

export function getCell(x, y) {
  const id = get(activeLayerId);
  const $layers = get(layers);
  const layer = activeLayer($layers, id);
  if (!layer) return null;
  const editingMask = isEditingEffectMask(layer);
  const offset = editingMask ? effMaskOffset($layers, layer) : effOffset($layers, layer);
  const cells = editingMask ? layer.mask.cells : layer.cells;
  return cmGet(cells, x - Math.round(offset.x), y - Math.round(offset.y));
}

export function getComposited(x, y) {
  if (!inBounds(x, y)) return null;
  return get(grid)[y][x];
}

export function addLayer(type = 'cell') {
  if (!authoredEditsAllowed()) return false;
  pushHistory();
  const layer = makeLayer(nextLayerName(), type);
  const active = get(activeLayerId);
  layers.update(($l) => {
    const activeIndex = $l.findIndex((candidate) => candidate.id === active);
    if (activeIndex < 0) return [layer, ...$l];
    const target = $l[activeIndex];
    const inserted = target.type === 'group'
      ? { ...layer, groupId: target.id }
      : target.groupId
        ? { ...layer, groupId: target.groupId }
        : layer;
    const next = $l.map((candidate) => (
      target.type === 'group' && candidate.id === target.id && candidate.collapsed
        ? { ...candidate, collapsed: false }
        : candidate
    ));
    next.splice(activeIndex + (target.type === 'group' ? 1 : 0), 0, inserted);
    return next;
  });
  selectLayer(layer.id);
  return true;
}
export function addGroup() {
  if (!authoredEditsAllowed()) return false;
  pushHistory();
  const group = { id: newLayerId(), name: nextGroupName(), type: 'group', visible: true, collapsed: false, cells: {} };
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
export function removeLayers(requestedIds, { includeGroupDescendants = true } = {}) {
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
export function removeSelectedLayers() {
  const selected = get(selectedLayerIds);
  const active = get(activeLayerId);
  return removeLayers(selected.size ? selected : (active == null ? [] : [active]));
}
export function removeLayer(id) {
  const selected = get(selectedLayerIds);
  return removeLayers(selected.has(id) ? selected : [id]);
}

export function groupActiveLayer() {
  if (!authoredEditsAllowed()) return false;
  const sel = get(selectedLayerIds);
  const members = get(layers).filter((layer) => sel.has(layer.id) && layer.type !== 'group');
  if (!members.length) { addGroup(); return; }
  pushHistory();
  const groupId = newLayerId();
  layers.update(($l) => {
    const group = { id: groupId, name: nextGroupName(), type: 'group', visible: true, collapsed: false, cells: {} };
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
export function toggleGroupCollapsed(id) {
  if (!authoredEditsAllowed()) return false;
  const group = get(layers).find((layer) => layer.id === id && layer.type === 'group');
  if (!group) return false;
  layers.update(($l) => $l.map((l) => (l.id === id ? { ...l, collapsed: !l.collapsed } : l)));
  layerPanelRevision.update((revision) => revision + 1);
  return true;
}
export function setLayerOpacity(id, opacity) {
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
const EFFECT_KINDS = new Set(['brightness', 'contrast', 'saturation', 'hue']);

export function setEffectProperties(id, patch) {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (layer?.type !== 'effect') return false;
  const current = layer.effect || { kind: 'brightness', intensity: 0.25 };
  const effect = { ...current, ...patch };
  if (!EFFECT_KINDS.has(effect.kind)) return false;
  effect.intensity = Math.max(-1, Math.min(1, Number(effect.intensity) || 0));
  if (sameShallowObject(current, effect)) return false;
  pushHistory();
  layers.update(($layers) => $layers.map((candidate) => candidate.id === id ? { ...candidate, effect } : candidate));
  return true;
}

export function setEffectMaskOpacity(id, opacity) {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (layer?.type !== 'effect' || !layer.mask) return;
  const next = Math.max(0, Math.min(1, Number(opacity) || 0));
  if ((layer.mask.opacity ?? 1) === next) return;
  pushHistory();
  layers.update(($layers) => $layers.map((candidate) => candidate.id === id
    ? { ...candidate, mask: { ...candidate.mask, opacity: next } }
    : candidate));
}

export function toggleEffectClipped(id) {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (layer?.type !== 'effect') return;
  pushHistory();
  layers.update(($layers) => $layers.map((candidate) => candidate.id === id ? { ...candidate, clipped: !candidate.clipped } : candidate));
}

export function toggleEffectMask(id) {
  if (!authoredEditsAllowed()) return false;
  const layer = get(layers).find((candidate) => candidate.id === id);
  if (layer?.type !== 'effect') return;
  pushHistory();
  layers.update(($layers) => $layers.map((candidate) => candidate.id === id
    ? { ...candidate, mask: candidate.mask ? null : { defaultStrength: 1, cells: {}, offset: { x: 0, y: 0 } } }
    : candidate));
  const next = get(layers).find((candidate) => candidate.id === id);
  if (next?.mask) selectEffectMask(id);
  else activeLayerPart.set('layer');
  notifyEffectMaskChanged(id, !!next?.mask);
}
export function toggleLayerBlink(id) {
  if (!authoredEditsAllowed()) return false;
  if (!get(layers).some((layer) => layer.id === id)) return false;
  pushHistory();
  layers.update(($l) => $l.map((l) => (l.id === id ? { ...l, blink: !l.blink } : l)));
  return true;
}
export function setLayerOffsetDirect(id, offset) {
  if (!authoredEditsAllowed()) return false;
  layers.update(($l) => $l.map((l) => (l.id === id ? { ...l, offset: { ...offset } } : l)));
  noteAuthoredMutation();
}
export function setEffectMaskOffsetDirect(id, offset) {
  if (!authoredEditsAllowed()) return false;
  const next = { x: Math.round(Number(offset?.x) || 0), y: Math.round(Number(offset?.y) || 0) };
  layers.update(($layers) => $layers.map((layer) => (
    layer.id === id && layer.type === 'effect' && layer.mask
      ? { ...layer, mask: { ...layer.mask, offset: next } }
      : layer
  )));
  noteAuthoredMutation();
}
export function translateLayerCells(id, dx, dy) {
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
export function translateEffectMaskCells(id, dx, dy) {
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
export function toggleLayerVisible(id) {
  if (!authoredEditsAllowed()) return false;
  if (!get(layers).some((layer) => layer.id === id)) return false;
  pushHistory();
  layers.update(($l) => $l.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));
  return true;
}
export function renameLayer(id, name) {
  if (!authoredEditsAllowed()) return false;
  const layer = getLayer(id);
  if (!layer || layer.name === name) return false;
  pushHistory();
  layers.update(($l) => $l.map((l) => (l.id === id ? { ...l, name } : l)));
  return true;
}
export function normalizeGroups(list) {
  const groupIds = new Set(list.filter((l) => l.type === 'group').map((l) => l.id));
  return list.map((l, i) => {
    if (!l.groupId) return l;
    if (!groupIds.has(l.groupId)) return { ...l, groupId: null };
    let ok = false;
    for (let j = i - 1; j >= 0; j--) {
      const p = list[j];
      if (p.type === 'group' && p.id === l.groupId) { ok = true; break; }
      if (p.groupId === l.groupId) continue;
      break;
    }
    return ok ? l : { ...l, groupId: null };
  });
}

// Offsets are parent-local, so subtract the new parent and add the old parent to keep
// the layer fixed in world space while ownership changes.
function reparentedLayer(stack, layer, groupId) {
  const previousGroupId = layer.groupId || null;
  const nextGroupId = groupId || null;
  if (previousGroupId === nextGroupId) return layer;
  const groupOffset = (id) => {
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

export function computeGapMove(stack, fromId, beforeId, intoGroup) {
  const moved = stack.find((layer) => layer.id === fromId);
  if (moved == null || fromId === beforeId) return stack;

  const block = [moved];
  if (moved.type === 'group') {
    const groupIndex = stack.indexOf(moved);
    for (let i = groupIndex + 1; i < stack.length && stack[i].groupId === moved.id; i++) {
      block.push(stack[i]);
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
      while (a < rest.length && rest[a].groupId === enclosingId) a++;
    }
    const next = rest.slice();
    next.splice(a, 0, ...block);
    return next;
  }

  const above = rest[at - 1], below = rest[at];
  const encl = (row) => row ? (row.type === 'group' ? row.id : (row.groupId || null)) : null;
  const enclAbove = encl(above);
  const enclBelow = below && below.type !== 'group' ? (below.groupId || null) : null;
  const gid = intoGroup ? (enclAbove ?? enclBelow ?? null) : null;

  if (gid != null) {
    const header = rest.findIndex((layer) => layer.id === gid);
    const lo = header + 1;
    let end = lo;
    while (end < rest.length && rest[end].groupId === gid) end++;
    at = Math.max(lo, Math.min(at, end));
  } else if (enclAbove != null && enclAbove === enclBelow) {
    const groupId = enclAbove;
    while (at < rest.length && rest[at].groupId === groupId) at++;
  }
  const next = rest.slice();
  next.splice(at, 0, reparentedLayer(stack, moved, gid));
  return next;
}

export function moveLayerToGap(fromId, beforeId, intoGroup) {
  if (!authoredEditsAllowed()) return false;
  const current = get(layers);
  const next = normalizeGroups(computeGapMove(current, fromId, beforeId, intoGroup));
  if (sameLayerOrder(current, next)) return;
  pushHistory();
  layers.set(next);
}

export function computeSelectedGapMove(stack, selectedIds, beforeId, intoGroup) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const moving = [];
  let containsGroup = false;
  for (let i = 0; i < stack.length; i++) {
    const layer = stack[i];
    if (layer.type === 'group' && selected.has(layer.id)) {
      containsGroup = true;
      moving.push(layer);
      while (i + 1 < stack.length && stack[i + 1].groupId === layer.id) moving.push(stack[++i]);
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

  let block;
  if (containsGroup) {
    const above = rest[at - 1];
    const enclosingId = above ? (above.groupId || (above.type === 'group' ? above.id : null)) : null;
    if (enclosingId != null) while (at < rest.length && rest[at].groupId === enclosingId) at++;
    block = moving.map((layer) => (
      layer.type === 'group' || (layer.groupId && movingIds.has(layer.groupId))
        ? layer
        : reparentedLayer(stack, layer, null)
    ));
  } else {
    const above = rest[at - 1], below = rest[at];
    const encl = (row) => row ? (row.type === 'group' ? row.id : (row.groupId || null)) : null;
    const enclAbove = encl(above);
    const enclBelow = below && below.type !== 'group' ? (below.groupId || null) : null;
    const groupId = intoGroup ? (enclAbove ?? enclBelow ?? null) : null;
    if (!intoGroup && enclAbove != null && enclAbove === enclBelow) {
      while (at < rest.length && rest[at].groupId === enclAbove) at++;
    }
    block = moving.map((layer) => reparentedLayer(stack, layer, groupId));
  }

  const next = rest.slice();
  next.splice(at, 0, ...block);
  return normalizeGroups(next);
}

export function canonicalLayerDropGap(stack, selectedIds, dragFromId, beforeId, intoGroup) {
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

export function reorderSelectedLayers(beforeId, intoGroup) {
  if (!authoredEditsAllowed()) return false;
  const current = get(layers);
  const next = computeSelectedGapMove(current, get(selectedLayerIds), beforeId, intoGroup);
  if (sameLayerOrder(current, next)) return;
  pushHistory();
  layers.set(next);
}

function sameLayerOrder(first, second) {
  return first.length === second.length && first.every((layer, index) => (
    layer.id === second[index]?.id &&
    (layer.groupId || null) === (second[index]?.groupId || null)
  ));
}

const undoStack = [];
const redoStack = [];
export const canUndo = writable(false);
export const canRedo = writable(false);
export const authoredRevision = writable(0);
export const layerPanelRevision = writable(0);
const MAX_HISTORY = 100;
const historyContributors = [];
let layerHistoryAuthority = null;

export function registerLayerHistoryAuthority(authority) {
  layerHistoryAuthority = authority;
  return () => {
    if (layerHistoryAuthority === authority) layerHistoryAuthority = null;
  };
}

export function registerHistoryContributor(capture, restore, options = {}) {
  const contributor = { capture, restore, reachable: options.reachable };
  historyContributors.push(contributor);
  return () => {
    const index = historyContributors.indexOf(contributor);
    if (index >= 0) historyContributors.splice(index, 1);
  };
}

export function collectHistoryReachability() {
  const output = new Set();
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

function snapshot() {
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

function sameHistoryValue(first, second) {
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
  const firstKeys = Object.keys(first);
  const secondKeys = Object.keys(second);
  return firstKeys.length === secondKeys.length &&
    firstKeys.every((key) => Object.prototype.hasOwnProperty.call(second, key) &&
      sameHistoryValue(first[key], second[key]));
}

function restore(snap) {
  const liveById = new Map(get(layers).map((layer) => [layer.id, layer]));
  snap.contributed?.forEach((state, index) => historyContributors[index]?.restore(state));
  nextLayerNumber = snap.nextLayerNumber;
  nextGroupNumber = snap.nextGroupNumber;
  const restoredLayers = snap.layers
    ? snap.layers.map((layer) => ({
      ...layer,
      ...retainedLayerRuntime(layer, liveById.get(layer.id)),
    }))
    : layerHistoryAuthority?.restoreView?.(liveById) || get(layers);
  if (snap.layers) layers.set(restoredLayers);
  dims.set({ ...snap.dims });
  const ids = new Set(restoredLayers.map((l) => l.id));
  activeLayerId.set(ids.has(snap.activeId)
    ? snap.activeId
    : (restoredLayers[0]?.id ?? null));
  const maskActive = snap.activePart === 'mask' &&
    restoredLayers.some((layer) => layer.id === snap.activeId && layer.mask);
  activeLayerPart.set(maskActive ? 'mask' : 'layer');
  selectedLayerIds.set(new Set([...snap.selected].filter((id) => ids.has(id))));
  cellSelection.set(new Set(snap.cellSelection));
  if (!get(selectedLayerIds).size && get(activeLayerId) != null) {
    selectedLayerIds.set(new Set([get(activeLayerId)]));
  }
}

function syncFlags() {
  canUndo.set(undoStack.length > 0);
  canRedo.set(redoStack.length > 0);
}

function resetHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  strokeOpen = false;
  strokeSnapshot = null;
  strokeRedo = null;
  strokeMutated = false;
  syncFlags();
}

let strokeOpen = false;
let strokeSnapshot = null;
let strokeRedo = null;
let strokeMutated = false;
export function noteAuthoredMutation() {
  if (strokeOpen) strokeMutated = true;
  else scheduleAuthoredMutationSettlement();
  authoredRevision.update((revision) => revision + 1);
}

// A stroke owns one pre-edit snapshot and temporarily removes redo; no-op or cancel
// restores that redo branch instead of manufacturing a history entry.
export function beginStroke() {
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
export function endStroke() {
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
export function cancelStroke() {
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
function pushHistory() {
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
export function checkpointHistory() {
  pushHistory();
}
export function undo() {
  if (!authoredEditsAllowed()) return false;
  if (strokeOpen || !undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  noteAuthoredMutation();
  syncFlags();
  notifyAuthoredContentReverted();
}
export function redo() {
  if (!authoredEditsAllowed()) return false;
  if (strokeOpen || !redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  noteAuthoredMutation();
  syncFlags();
  notifyAuthoredContentReverted();
}
