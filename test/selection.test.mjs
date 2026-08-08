import assert from 'node:assert/strict';
import { Blob } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'svelte/store';
import { cmGet, cmKey } from '../src/lib/cellmap.js';
import * as F from '../src/lib/frames.js';
import * as G from '../src/lib/grid.js';
import * as S from '../src/lib/selection.js';
import { renderShapeToCells, shapeGlyphs } from '../src/lib/shapes.js';
import {
  PAINTTY_CLIPBOARD_MIME,
  PAINTTY_CLIPBOARD_TEXT,
  clipboardHasMatchingClipMarker,
  clipboardImageFile,
  clipboardMediaPlacementSucceeded,
  clipboardPasteIntent,
  clearClipClipboard,
  copyClipsForContext,
  hasClipClipboard,
  pasteClipsFromClipboard,
} from '../src/lib/clipboard.js';
import {
  getClipTimelineSelection,
  getClipTimelineState,
} from '../src/lib/clipTimelineState.js';
import { loadJSON, serializeJSON } from '../src/lib/fileio.js';
import { importMediaFile } from '../src/lib/mediaCommands.js';
import { mediaPackagePath } from '../src/lib/mediaHash.js';
import {
  loadMediaRegistry,
  mediaAssetById,
  purgeMediaAssets,
  replaceMediaAsset,
} from '../src/lib/mediaRegistry.js';
import {
  advanceProjectRevision,
  notifyProjectReplaced,
} from '../src/lib/documentLifecycle.js';

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  try {
    assert.deepStrictEqual(got, want);
    pass++;
  } catch (error) {
    fail++;
    console.error(`FAIL ${name}\n${error.message}`);
  }
}

const A = { c: 'A', fg: '#ffffff', bg: null };
const B = { c: 'B', fg: '#ffffff', bg: null };
const shape = {
  kind: 'line', x0: 0, y0: 0, x1: 1, y1: 0,
  style: 'outline', detail: 'cell', channel: 'glyph', char: 'A', fg: '#ffffff',
};

function reset(layerDefs) {
  G.setLayers(layerDefs);
  F.initTimeline(get(G.layers));
  return get(G.activeLayerId);
}
function activeLayer() {
  return get(G.layers).find((layer) => layer.id === get(G.activeLayerId));
}
function keys(layer) {
  return Object.keys(layer.cells).sort();
}
function maskState(layer) {
  return Object.entries(layer.mask.cells).sort(([a], [b]) => a.localeCompare(b))
    .map(([position, cell]) => [position, cell.mask]);
}
function selectionKeys() {
  return [...get(G.cellSelection)].sort();
}

function nativeClipboard({ files = [], items = [], data = {} } = {}) {
  const values = new Map(Object.entries(data));
  return {
    files: [...files],
    items: [...items],
    clearCount: 0,
    clearData() {
      values.clear();
      this.files = [];
      this.items = [];
      this.clearCount++;
    },
    setData(type, value) { values.set(type, String(value)); },
    getData(type) { return values.get(type) || ''; },
  };
}

const MEDIA_HASH_A = 'a'.repeat(64);
const MEDIA_HASH_B = 'b'.repeat(64);
const MEDIA_HASH_C = 'c'.repeat(64);

function mediaDefinition(assetId, kind, hash, extra = {}) {
  return {
    assetId,
    hash,
    path: mediaPackagePath(hash),
    sourceName: `${kind}-source`,
    mime: `${kind}/test`,
    size: 4,
    kind,
    generation: 1,
    ...(kind === 'image' || kind === 'video' ? { width: 32, height: 16 } : {}),
    ...(kind === 'audio' || kind === 'video' ? { duration: 2 } : {}),
    ...extra,
  };
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canvasSource = fs.readFileSync(path.join(root, 'src/components/Canvas.svelte'), 'utf8');
assert.match(canvasSource, /class="transform-body"[^>]+aria-label="Move transform preview"/,
  'Canvas gives the transform preview a dedicated body gesture target');
assert.match(canvasSource, /width:\s*max\([^;]+48px\).*height:\s*max\([^;]+48px\)/,
  'Canvas separates all transform controls on a usable minimum-size cage');
assert.match(canvasSource, /transformBoundsFromDrag\(/,
  'Canvas transform wiring uses pointer deltas instead of ambiguous tiny-cage coordinates');

S.selectMode.set('new');
G.cellSelection.set(new Set([cmKey(0, 0)]));
S.applyRegion([{ x: 2, y: 0 }], S.selectionModeForModifiers({ shiftKey: true }));
eq('shift-gesture-adds-without-changing-the-toolbar-mode', [
  selectionKeys(),
  get(S.selectMode),
], [[cmKey(0, 0), cmKey(2, 0)], 'new']);
S.applyRegion([{ x: 0, y: 0 }], S.selectionModeForModifiers({ altKey: true }));
eq('alt-gesture-subtracts-without-changing-the-toolbar-mode', [
  selectionKeys(),
  get(S.selectMode),
], [[cmKey(2, 0)], 'new']);
eq('alt-wins-when-both-selection-modifiers-are-held',
  S.selectionModeForModifiers({ altKey: true, shiftKey: true }),
  'sub');

reset([{
  name: 'deselect move', type: 'cell', visible: true,
  cells: { [cmKey(0, 0)]: A },
}]);
G.cellSelection.set(new Set([cmKey(0, 0)]));
const deselectMoveBefore = structuredClone(activeLayer().cells);
S.beginMove();
S.updateMove(2, 1);
S.clearSelection();
eq('deselect-cancels-a-move-without-history-or-durable-change', {
  cells: activeLayer().cells,
  selection: selectionKeys(),
  moveState: get(S.moveState),
  canUndo: get(G.canUndo),
}, {
  cells: deselectMoveBefore,
  selection: [],
  moveState: null,
  canUndo: false,
});

let id = reset([{
  name: 'live shape', type: 'shape', visible: true, shape: { ...shape },
  offset: { x: 3, y: 2 }, cells: { [cmKey(0, 0)]: A, [cmKey(1, 0)]: B },
}]);
G.cellSelection.set(new Set([cmKey(3, 2), cmKey(4, 2)]));
eq('shape-rejects-cell-move-and-clears-stale-selection', [
  S.beginMove(),
  activeLayer().type,
  activeLayer().shape?.kind,
  selectionKeys(),
], [false, 'shape', 'line', []]);
G.cellSelection.set(new Set([cmKey(3, 2)]));
eq('shape-rejects-transform-and-clears-stale-selection', [
  S.beginTransformSelection(),
  selectionKeys(),
], [false, []]);
G.cellSelection.set(new Set([cmKey(3, 2)]));
eq('shape-rejects-selection-to-layer-without-rasterizing', [
  S.selectionToNewLayer(true),
  get(G.layers).length,
  activeLayer().type,
  selectionKeys(),
], [null, 1, 'shape', []]);

reset([
  { name: 'cells', type: 'cell', visible: true, cells: { [cmKey(0, 0)]: A } },
  { name: 'Group 1', type: 'group', visible: true, cells: {} },
]);
G.cellSelection.set(new Set([cmKey(0, 0)]));
const staleGroupId = get(G.layers).find((layer) => layer.type === 'group').id;
G.selectLayer(staleGroupId);
eq('selecting-group-clears-raster-marquee-and-rejects-move', [
  activeLayer().type,
  selectionKeys(),
  S.beginMove(),
], ['group', [], false]);

id = reset([{
  name: 'positioned cells', type: 'cell', visible: true,
  offset: { x: 3, y: 2 }, cells: { [cmKey(0, 0)]: A, [cmKey(1, 0)]: B },
}]);
G.cellSelection.set(new Set([cmKey(3, 2), cmKey(4, 2), cmKey(3, 3)]));
eq('positioned-begin-opens-one-move-transaction', S.beginMove(), true);
eq('positioned-begin-preserves-empty-marquee-cell', selectionKeys(), [cmKey(3, 2), cmKey(3, 3), cmKey(4, 2)].sort());
S.updateMove(2, 1);
let moved = activeLayer();
eq('positioned-preview-stamps-from-immutable-local-source', keys(moved), [cmKey(2, 1), cmKey(3, 1)]);
eq('positioned-preview-renders-at-world-destination', G.compositeWorld(get(G.layers), { x: 0, y: 0, w: 8, h: 6 })[3][5]?.c, 'A');
eq('positioned-preview-moves-full-marquee', selectionKeys(), [cmKey(5, 3), cmKey(5, 4), cmKey(6, 3)].sort());
S.finalizeMove();
F.commitLayersToActiveFrame();
G.undo();
let restored = activeLayer();
eq('positioned-undo-restores-source-and-marquee', [
  keys(restored),
  selectionKeys(),
], [
  [cmKey(0, 0), cmKey(1, 0)],
  [cmKey(3, 2), cmKey(3, 3), cmKey(4, 2)].sort(),
]);
G.redo();
moved = activeLayer();
eq('positioned-redo-restores-one-move-without-duplication', [
  keys(moved),
  selectionKeys(),
], [
  [cmKey(2, 1), cmKey(3, 1)],
  [cmKey(5, 3), cmKey(5, 4), cmKey(6, 3)].sort(),
]);
id = reset([{
  name: 'offset cells', type: 'cell', visible: true,
  offset: { x: 3, y: 2 }, cells: { [cmKey(1, 0)]: A },
}]);
G.cellSelection.set(new Set([cmKey(4, 2), cmKey(4, 3)]));
let newId = S.selectionToNewLayer(false);
let source = get(G.layers).find((layer) => layer.id === id);
let created = get(G.layers).find((layer) => layer.id === newId);
eq('copy-creates-world-aligned-layer', [get(G.layers).length, cmGet(created.cells, 4, 2)?.c, cmGet(source.cells, 1, 0)?.c], [2, 'A', 'A']);
eq('copy-preserves-marquee-geometry', selectionKeys(), [cmKey(4, 2), cmKey(4, 3)]);
G.undo();
eq('copy-undo-is-one-step', [get(G.layers).length, get(G.activeLayerId), cmGet(activeLayer().cells, 1, 0)?.c], [1, id, 'A']);
newId = S.selectionToNewLayer(true);
source = get(G.layers).find((layer) => layer.id === id);
created = get(G.layers).find((layer) => layer.id === newId);
eq('cut-creates-layer-and-clears-source', [cmGet(created.cells, 4, 2)?.c, cmGet(source.cells, 1, 0)?.c], ['A', undefined]);
G.undo();
eq('cut-undo-is-one-step', [get(G.layers).length, cmGet(activeLayer().cells, 1, 0)?.c], [1, 'A']);

reset([
  { name: 'Group 1', type: 'group', visible: true, offset: { x: 4, y: 2 }, cells: {} },
  { name: 'grouped source', type: 'cell', visible: true, offset: { x: 1, y: 0 }, cells: { [cmKey(2, 1)]: A } },
]);
let [copyGroup, groupedSource] = get(G.layers);
groupedSource = { ...groupedSource, groupId: copyGroup.id };
G.layers.set([copyGroup, groupedSource]);
F.initTimeline(get(G.layers));
G.selectLayer(groupedSource.id);
G.cellSelection.set(new Set([cmKey(7, 3)]));
newId = S.selectionToNewLayer(false);
created = get(G.layers).find((layer) => layer.id === newId);
eq('grouped-copy-localizes-world-cells-against-the-parent-offset', [
  created.groupId,
  cmGet(created.cells, 3, 1)?.c,
  G.compositeWorld(get(G.layers), { x: 7, y: 3, w: 1, h: 1 })[0][0]?.c,
], [copyGroup.id, 'A', 'A']);

id = reset([{
  name: 'wide', type: 'cell', visible: true, offset: { x: 2, y: 1 }, cells: {
    [cmKey(0, 0)]: { c: '界', fg: '#ffffff', bg: null },
    [cmKey(1, 0)]: { c: '', fg: '#ffffff', bg: null, cont: true },
  },
}]);
F.togglePosKey(id, 0);
F.addFrame();
F.setLayerOffsetById(1, id, { x: 5, y: 3 });
G.cellSelection.set(new Set([cmKey(5, 3)]));
S.beginMove();
eq('wide-selection-expands-to-continuation', selectionKeys(), [cmKey(5, 3), cmKey(6, 3)]);
S.updateMove(2, 1);
S.finalizeMove();
F.commitLayersToActiveFrame();
eq('wide-move-keeps-position-keys', F.positionKeys(id), [
  { frame: 0, x: 2, y: 1, interpolation: 'linear' },
  { frame: 1, x: 5, y: 3, interpolation: 'linear' },
]);
eq('wide-move-keeps-one-primary-and-continuation', [
  keys(activeLayer()),
  cmGet(activeLayer().cells, 2, 1)?.c,
  cmGet(activeLayer().cells, 3, 1)?.cont,
  selectionKeys(),
], [
  [cmKey(2, 1), cmKey(3, 1)],
  '界',
  true,
  [cmKey(7, 4), cmKey(8, 4)],
]);
G.undo();
eq('wide-move-undo-restores-frame-pose', [
  keys(activeLayer()),
  selectionKeys(),
  F.positionKeys(id),
], [
  [cmKey(0, 0), cmKey(1, 0)],
  [cmKey(5, 3)],
  [
    { frame: 0, x: 2, y: 1, interpolation: 'linear' },
    { frame: 1, x: 5, y: 3, interpolation: 'linear' },
  ],
]);
G.redo();
eq('wide-move-redo-restores-end-state', [
  keys(activeLayer()),
  selectionKeys(),
  G.compositeWorld(get(G.layers), { x: 0, y: 0, w: 10, h: 6 })[4][7]?.c,
], [
  [cmKey(2, 1), cmKey(3, 1)],
  [cmKey(7, 4), cmKey(8, 4)],
  '界',
]);
F.gotoFrame(0);
eq('wide-move-leaves-earlier-frame-unchanged', [
  keys(activeLayer()),
  G.compositeWorld(get(G.layers), { x: 0, y: 0, w: 10, h: 6 })[1][2]?.c,
], [
  [cmKey(0, 0), cmKey(1, 0)],
  '界',
]);

id = reset([{
  name: 'masked effect', type: 'effect', visible: true, cells: {}, offset: { x: 2, y: 1 },
  effect: { kind: 'brightness', intensity: 1 },
  mask: {
    defaultStrength: 1, opacity: 0.8,
    cells: { [cmKey(0, 0)]: { mask: 0 }, [cmKey(1, 0)]: { mask: 0.5 } },
  },
}, {
  name: 'underlay', type: 'cell', visible: true, cells: {
    [cmKey(2, 1)]: { c: 'A', fg: '#202020', bg: null },
    [cmKey(3, 1)]: { c: 'B', fg: '#202020', bg: null },
  },
}]);
G.selectEffectMask(id);
G.cellSelection.set(new Set([cmKey(2, 1)]));
const originalMask = maskState(activeLayer());
const renderedMaskColors = () => {
  const rendered = G.compositeWorld(get(G.layers), { x: 0, y: 0, w: 6, h: 4 });
  return [rendered[1][2]?.fg, rendered[1][3]?.fg];
};
eq('mask-move-starts-with-authored-composite', renderedMaskColors()[0], '#202020');
S.beginMove();
S.updateMove(1, 0);
eq('mask-move-preview-updates-effect-coverage-without-moving-effect-layer', {
  colors: renderedMaskColors(),
  mask: maskState(activeLayer()),
  offset: activeLayer().offset,
}, {
  colors: ['#ececec', '#202020'],
  mask: [[cmKey(1, 0), 0]],
  offset: { x: 2, y: 1 },
});
S.cancelMove();
eq('mask-move-cancel-restores-collided-cell-exactly', {
  mask: maskState(activeLayer()),
  colors: renderedMaskColors(),
  selection: selectionKeys(),
}, {
  mask: originalMask,
  colors: ['#202020', '#868686'],
  selection: [cmKey(2, 1)],
});
S.beginMove();
S.updateMove(1, 0);
S.finalizeMove();
F.commitLayersToActiveFrame();
eq('mask-move-finalizes-mask-and-marquee', {
  mask: maskState(activeLayer()),
  selection: selectionKeys(),
}, {
  mask: [[cmKey(1, 0), 0]],
  selection: [cmKey(3, 1)],
});
G.undo();
eq('mask-move-undo-restores-source-and-overwritten-destination', {
  mask: maskState(activeLayer()),
  selection: selectionKeys(),
}, {
  mask: originalMask,
  selection: [cmKey(2, 1)],
});
G.redo();
eq('mask-move-redo-restores-final-mask', {
  mask: maskState(activeLayer()),
  selection: selectionKeys(),
}, {
  mask: [[cmKey(1, 0), 0]],
  selection: [cmKey(3, 1)],
});

id = reset([{
  name: 'whole mask', type: 'effect', visible: true, cells: {}, offset: { x: 4, y: -2 },
  effect: { kind: 'contrast', intensity: 0.4 },
  mask: {
    defaultStrength: 0.25, opacity: 0.6,
    cells: { [cmKey(-1, 2)]: { mask: 0 }, [cmKey(3, 4)]: { mask: 1 } },
  },
}]);
G.selectEffectMask(id);
G.beginStroke();
G.translateEffectMaskCells(id, 2, -3);
G.endStroke();
eq('whole-mask-translation-preserves-mask-metadata-and-effect-position', {
  cells: maskState(activeLayer()),
  defaultStrength: activeLayer().mask.defaultStrength,
  opacity: activeLayer().mask.opacity,
  offset: activeLayer().offset,
}, {
  cells: [[cmKey(1, -1), 0], [cmKey(5, 1), 1]],
  defaultStrength: 0.25,
  opacity: 0.6,
  offset: { x: 4, y: -2 },
});
G.undo();
eq('whole-mask-translation-undo-restores-sparse-map', maskState(activeLayer()), [
  [cmKey(-1, 2), 0],
  [cmKey(3, 4), 1],
]);
id = reset([{
  name: 'offset mask', type: 'effect', visible: true, cells: {}, offset: { x: 2, y: 1 },
  effect: { kind: 'brightness', intensity: 0.5 },
  mask: {
    defaultStrength: 1,
    offset: { x: 3, y: 0 },
    cells: { [cmKey(0, 0)]: { mask: 0 } },
  },
}, {
  name: 'offset underlay', type: 'cell', visible: true,
  cells: { [cmKey(5, 1)]: { c: 'A', fg: '#202020', bg: null } },
}]);
G.selectEffectMask(id);
G.cellSelection.set(new Set([cmKey(5, 1)]));
S.beginMove();
eq('mask-selection-subtracts-layer-and-mask-position', {
  target: get(S.moveState)?.target,
  lifted: get(S.moveState)?.lifted.map(({ x, y, cell }) => [x, y, cell.mask]),
}, {
  target: 'mask',
  lifted: [[5, 1, 0]],
});
S.updateMove(1, 0);
eq('moving-selection-keeps-mask-transform-independent', {
  cells: maskState(activeLayer()),
  maskOffset: activeLayer().mask.offset,
  layerOffset: activeLayer().offset,
}, {
  cells: [[cmKey(1, 0), 0]],
  maskOffset: { x: 3, y: 0 },
  layerOffset: { x: 2, y: 1 },
});
S.cancelMove();
eq('cancel-offset-mask-selection-restores-local-cell', maskState(activeLayer()), [
  [cmKey(0, 0), 0],
]);

eq('transform-resize-keeps-one-cell-and-never-flips', [
  S.resizeTransformBounds({ x: 2, y: 3, w: 4, h: 5 }, 'e', -100, 0),
  S.resizeTransformBounds({ x: 2, y: 3, w: 4, h: 5 }, 'nw', 100, 100),
], [
  { x: 2, y: 3, w: 1, h: 5 },
  { x: 5, y: 7, w: 1, h: 1 },
]);
eq('transform-resize-allows-offcanvas-and-caps-each-axis-at-256', [
  S.resizeTransformBounds({ x: 2, y: 3, w: 4, h: 5 }, 'nw', -1000, -1000),
  S.resizeTransformBounds({ x: 2, y: 3, w: 4, h: 5 }, 'se', 1000, 1000),
], [
  { x: -250, y: -248, w: 256, h: 256 },
  { x: 2, y: 3, w: 256, h: 256 },
]);

const dragBounds = { x: 10, y: 8, w: 4, h: 3 };
const dragStart = { x: 103.25, y: -17.75 };
const outwardTransformCases = new Map([
  ['nw', [{ x: -2, y: -1 }, { x: 8, y: 7, w: 6, h: 4 }]],
  ['n', [{ x: 0, y: -1 }, { x: 10, y: 7, w: 4, h: 4 }]],
  ['ne', [{ x: 2, y: -1 }, { x: 10, y: 7, w: 6, h: 4 }]],
  ['e', [{ x: 2, y: 0 }, { x: 10, y: 8, w: 6, h: 3 }]],
  ['se', [{ x: 2, y: 1 }, { x: 10, y: 8, w: 6, h: 4 }]],
  ['s', [{ x: 0, y: 1 }, { x: 10, y: 8, w: 4, h: 4 }]],
  ['sw', [{ x: -2, y: 1 }, { x: 8, y: 8, w: 6, h: 4 }]],
  ['w', [{ x: -2, y: 0 }, { x: 8, y: 8, w: 6, h: 3 }]],
]);
const inwardTransformCases = new Map([
  ['nw', [{ x: 2, y: 1 }, { x: 12, y: 9, w: 2, h: 2 }]],
  ['n', [{ x: 0, y: 1 }, { x: 10, y: 9, w: 4, h: 2 }]],
  ['ne', [{ x: -2, y: 1 }, { x: 10, y: 9, w: 2, h: 2 }]],
  ['e', [{ x: -2, y: 0 }, { x: 10, y: 8, w: 2, h: 3 }]],
  ['se', [{ x: -2, y: -1 }, { x: 10, y: 8, w: 2, h: 2 }]],
  ['s', [{ x: 0, y: -1 }, { x: 10, y: 8, w: 4, h: 2 }]],
  ['sw', [{ x: 2, y: -1 }, { x: 12, y: 8, w: 2, h: 2 }]],
  ['w', [{ x: 2, y: 0 }, { x: 12, y: 8, w: 2, h: 3 }]],
]);
for (const cases of [outwardTransformCases, inwardTransformCases]) {
  for (const [handle, [delta, expected]] of cases) {
    eq(`transform-${handle}-${cases === outwardTransformCases ? 'outward' : 'reverse'}-drag`,
      S.transformBoundsFromDrag(dragBounds, handle, dragStart, {
        x: dragStart.x + delta.x,
        y: dragStart.y + delta.y,
      }), expected);
  }
}
eq('transform-body-drag-translates-without-resizing', S.transformBoundsFromDrag(
  dragBounds,
  'body',
  dragStart,
  { x: dragStart.x + 3, y: dragStart.y - 2 },
), { x: 13, y: 6, w: 4, h: 3 });
eq('transform-click-without-movement-keeps-exact-bounds', S.transformBoundsFromDrag(
  dragBounds,
  'body',
  dragStart,
  dragStart,
), dragBounds);
eq('transform-wide-minimum-applies-to-delta-based-west-handle', S.transformBoundsFromDrag(
  dragBounds,
  'w',
  dragStart,
  { x: dragStart.x + 100, y: dragStart.y },
  2,
), { x: 12, y: 8, w: 2, h: 3 });

const oneCellOutwardDeltas = new Map([
  ['nw', { x: -2, y: -2 }], ['n', { x: 0, y: -2 }],
  ['ne', { x: 2, y: -2 }], ['e', { x: 2, y: 0 }],
  ['se', { x: 2, y: 2 }], ['s', { x: 0, y: 2 }],
  ['sw', { x: -2, y: 2 }], ['w', { x: -2, y: 0 }],
]);
for (const handle of S.TRANSFORM_HANDLES) {
  reset([{
    name: `one-cell ${handle}`, type: 'cell', visible: true,
    cells: { [cmKey(2, 3)]: A },
  }]);
  G.cellSelection.set(new Set([cmKey(2, 3)]));
  assert.equal(S.beginTransformSelection(), true);
  const startBounds = get(S.moveState).bounds;
  const delta = oneCellOutwardDeltas.get(handle);
  const nextBounds = S.transformBoundsFromDrag(startBounds, handle, dragStart, {
    x: dragStart.x + delta.x,
    y: dragStart.y + delta.y,
  });
  S.updateTransformBounds(nextBounds);
  eq(`one-cell-${handle}-control-produces-a-visible-scaled-preview`, {
    bounds: get(S.moveState).bounds,
    previewCount: get(S.moveState).preview.length,
    selectionCount: selectionKeys().length,
  }, {
    bounds: nextBounds,
    previewCount: nextBounds.w * nextBounds.h,
    selectionCount: nextBounds.w * nextBounds.h,
  });
  S.cancelMove();
  eq(`one-cell-${handle}-cancel-is-exact`, {
    cells: keys(activeLayer()),
    selection: selectionKeys(),
    canUndo: get(G.canUndo),
  }, {
    cells: [cmKey(2, 3)],
    selection: [cmKey(2, 3)],
    canUndo: false,
  });
}

reset([{
  name: 'body transform', type: 'cell', visible: true,
  cells: { [cmKey(2, 3)]: A },
}]);
G.cellSelection.set(new Set([cmKey(2, 3)]));
S.beginTransformSelection();
S.updateTransformBounds(S.transformBoundsFromDrag(
  get(S.moveState).bounds,
  'body',
  dragStart,
  { x: dragStart.x + 4, y: dragStart.y - 2 },
));
eq('transform-body-updates-the-visible-preview-and-bounds', {
  bounds: get(S.moveState).bounds,
  source: cmGet(activeLayer().cells, 2, 3)?.c,
  destination: cmGet(activeLayer().cells, 6, 1)?.c,
  selection: selectionKeys(),
}, {
  bounds: { x: 6, y: 1, w: 1, h: 1 },
  source: undefined,
  destination: 'A',
  selection: [cmKey(6, 1)],
});
S.finalizeMove();
F.commitLayersToActiveFrame();
G.undo();
eq('transform-body-apply-is-one-exact-undo-step', {
  cells: keys(activeLayer()),
  selection: selectionKeys(),
  canUndo: get(G.canUndo),
}, {
  cells: [cmKey(2, 3)],
  selection: [cmKey(2, 3)],
  canUndo: false,
});
G.redo();
eq('transform-body-redo-restores-the-exact-preview-result', {
  cells: keys(activeLayer()),
  selection: selectionKeys(),
}, {
  cells: [cmKey(6, 1)],
  selection: [cmKey(6, 1)],
});

reset([{
  name: 'no-op transform', type: 'cell', visible: true,
  cells: { [cmKey(1, 1)]: A },
}]);
G.cellSelection.set(new Set([cmKey(1, 1)]));
S.beginTransformSelection();
const noOpBounds = get(S.moveState).bounds;
S.updateTransformBounds(S.transformBoundsFromDrag(
  noOpBounds,
  'body',
  dragStart,
  dragStart,
));
S.finalizeMove();
eq('transform-control-click-without-movement-adds-no-history', {
  cells: keys(activeLayer()),
  selection: selectionKeys(),
  canUndo: get(G.canUndo),
  moveState: get(S.moveState),
}, {
  cells: [cmKey(1, 1)],
  selection: [cmKey(1, 1)],
  canUndo: false,
  moveState: null,
});
G.cellSelection.set(new Set());
eq('empty-selection-cannot-open-transform-controls', S.beginTransformSelection(), false);

reset([
  { name: 'transform group', type: 'group', visible: true, offset: { x: 5, y: 4 }, cells: {} },
  { name: 'grouped transform child', type: 'cell', visible: true,
    offset: { x: 2, y: -1 }, cells: { [cmKey(1, 1)]: A } },
]);
let [transformGroup, transformChild] = get(G.layers);
transformChild = { ...transformChild, groupId: transformGroup.id };
G.layers.set([transformGroup, transformChild]);
F.initTimeline(get(G.layers));
G.selectLayer(transformChild.id);
G.cellSelection.set(new Set([cmKey(8, 4)]));
S.beginTransformSelection();
S.updateTransformBounds(S.transformBoundsFromDrag(
  get(S.moveState).bounds,
  'body',
  dragStart,
  { x: dragStart.x + 3, y: dragStart.y - 2 },
));
S.finalizeMove();
F.commitLayersToActiveFrame();
let transformedChild = activeLayer();
eq('grouped-transform-preserves-layer-and-parent-identity', {
  layerId: transformedChild.id,
  groupId: transformedChild.groupId,
  layerOffset: transformedChild.offset,
  groupOffset: get(G.layers).find(({ id }) => id === transformGroup.id).offset,
  cells: keys(transformedChild),
  worldGlyph: G.compositeWorld(get(G.layers), { x: 0, y: 0, w: 16, h: 10 })[2][11]?.c,
}, {
  layerId: transformChild.id,
  groupId: transformGroup.id,
  layerOffset: { x: 2, y: -1 },
  groupOffset: { x: 5, y: 4 },
  cells: [cmKey(4, -1)],
  worldGlyph: 'A',
});
G.undo();
transformedChild = activeLayer();
eq('grouped-transform-undo-restores-local-source-with-identities', {
  layerId: transformedChild.id,
  groupId: transformedChild.groupId,
  cells: keys(transformedChild),
  selection: selectionKeys(),
}, {
  layerId: transformChild.id,
  groupId: transformGroup.id,
  cells: [cmKey(1, 1)],
  selection: [cmKey(8, 4)],
});
G.redo();
eq('grouped-transform-redo-restores-local-destination', {
  cells: keys(activeLayer()),
  selection: selectionKeys(),
}, {
  cells: [cmKey(4, -1)],
  selection: [cmKey(11, 2)],
});

id = reset([{
  name: 'scale glyphs', type: 'cell', visible: true, cells: {
    [cmKey(0, 0)]: A,
    [cmKey(1, 0)]: B,
    [cmKey(0, 1)]: { c: 'C', fg: '#ffffff', bg: null },
    [cmKey(1, 1)]: { c: 'D', fg: '#ffffff', bg: null },
  },
}]);
G.cellSelection.set(new Set([cmKey(0, 0), cmKey(1, 0), cmKey(0, 1), cmKey(1, 1)]));
eq('transform-opens-with-source-bounds', [
  S.beginTransformSelection(),
  get(S.moveState)?.mode,
  get(S.moveState)?.bounds,
], [true, 'transform', { x: 0, y: 0, w: 2, h: 2 }]);
S.updateTransformBounds({ x: -1, y: -1, w: 4, h: 3 });
eq('transform-nearest-neighbor-scales-from-immutable-source', [
  cmGet(activeLayer().cells, -1, -1)?.c,
  cmGet(activeLayer().cells, 0, -1)?.c,
  cmGet(activeLayer().cells, 1, -1)?.c,
  cmGet(activeLayer().cells, 2, 1)?.c,
  selectionKeys().length,
  selectionKeys().includes(cmKey(-1, -1)),
], ['A', 'A', 'B', 'D', 12, true]);
S.finalizeMove();
F.commitLayersToActiveFrame();
G.undo();
eq('transform-apply-is-one-undo-step', [
  keys(activeLayer()),
  selectionKeys(),
  get(G.canUndo),
], [
  [cmKey(0, 0), cmKey(0, 1), cmKey(1, 0), cmKey(1, 1)].sort(),
  [cmKey(0, 0), cmKey(0, 1), cmKey(1, 0), cmKey(1, 1)].sort(),
  false,
]);
G.redo();
eq('transform-redo-restores-scaled-offcanvas-result', [
  cmGet(activeLayer().cells, -1, -1)?.c,
  cmGet(activeLayer().cells, 2, 1)?.c,
  selectionKeys().length,
], ['A', 'D', 12]);

id = reset([{
  name: 'collision backgrounds', type: 'cell', visible: true, cells: {
    [cmKey(0, 0)]: { c: 'A', fg: '#ffffff', bg: '#101010' },
    [cmKey(4, 0)]: { c: 'X', fg: '#cccccc', bg: '#202020' },
  },
}]);
G.cellSelection.set(new Set([cmKey(0, 0)]));
S.beginMove();
S.updateMove(4, 0);
S.finalizeMove();
eq('moving-glyph-preserves-source-and-destination-backgrounds', [
  cmGet(activeLayer().cells, 0, 0),
  cmGet(activeLayer().cells, 4, 0),
], [
  { bg: '#101010' },
  { c: 'A', fg: '#ffffff', bg: '#202020' },
]);

id = reset([{
  name: 'cancel redo', type: 'cell', visible: true,
  cells: { [cmKey(0, 0)]: A },
}]);
G.beginStroke();
G.setCell(1, 0, B);
G.endStroke();
G.undo();
G.cellSelection.set(new Set([cmKey(0, 0)]));
S.beginTransformSelection();
S.updateTransformBounds({ x: 3, y: 2, w: 2, h: 2 });
const openPreview = keys(activeLayer());
G.undo();
G.redo();
eq('raw-history-commands-cannot-cross-an-open-transform', [
  keys(activeLayer()),
  get(S.moveState)?.mode,
], [openPreview, 'transform']);
S.cancelMove();
eq('cancel-restores-exact-source-selection-and-redo-availability', [
  keys(activeLayer()),
  selectionKeys(),
  get(G.canRedo),
  get(S.moveState),
], [
  [cmKey(0, 0)],
  [cmKey(0, 0)],
  true,
  null,
]);
G.redo();
eq('redo-survives-a-cancelled-transform', [
  keys(activeLayer()),
  cmGet(activeLayer().cells, 1, 0)?.c,
], [[cmKey(0, 0), cmKey(1, 0)], 'B']);

id = reset([{
  name: 'background scale', type: 'background', visible: true, cells: {
    [cmKey(0, 0)]: { bg: '#110000' },
    [cmKey(1, 0)]: { bg: '#000011' },
  },
}]);
G.cellSelection.set(new Set([cmKey(0, 0), cmKey(1, 0)]));
S.beginTransformSelection();
S.updateTransformBounds({ x: -2, y: 2, w: 4, h: 1 });
eq('background-transform-scales-its-channel-offcanvas', [
  [-2, -1, 0, 1].map((x) => cmGet(activeLayer().cells, x, 2)?.bg),
  selectionKeys(),
], [
  ['#110000', '#110000', '#000011', '#000011'],
  [cmKey(-2, 2), cmKey(-1, 2), cmKey(0, 2), cmKey(1, 2)].sort(),
]);
S.cancelMove();
eq('background-transform-cancel-restores-sparse-map', keys(activeLayer()), [cmKey(0, 0), cmKey(1, 0)]);

id = reset([{
  name: 'scale mask', type: 'effect', visible: true, cells: {},
  effect: { kind: 'brightness', intensity: 0.5 },
  mask: {
    defaultStrength: 1,
    offset: { x: 2, y: 1 },
    cells: {
      [cmKey(0, 0)]: { mask: 0 },
      [cmKey(1, 0)]: { mask: 1 },
    },
  },
}]);
G.selectEffectMask(id);
G.cellSelection.set(new Set([cmKey(2, 1), cmKey(3, 1)]));
S.beginTransformSelection();
S.updateTransformBounds({ x: 2, y: 1, w: 4, h: 2 });
eq('effect-mask-transform-nearest-neighbor-scales-strengths', [
  maskState(activeLayer()),
  selectionKeys().length,
], [
  [
    [cmKey(0, 0), 0], [cmKey(0, 1), 0],
    [cmKey(1, 0), 0], [cmKey(1, 1), 0],
    [cmKey(2, 0), 1], [cmKey(2, 1), 1],
    [cmKey(3, 0), 1], [cmKey(3, 1), 1],
  ].sort(([a], [b]) => a.localeCompare(b)),
  8,
]);
S.cancelMove();

id = reset([{
  name: 'cell move no-op', type: 'cell', visible: true, cells: {
    [cmKey(0, 0)]: A,
    [cmKey(3, 0)]: B,
  },
}]);
G.cellSelection.set(new Set([cmKey(0, 0)]));
S.beginMove();
S.updateMove(3, 0);
eq('move-away-preview-replaces-the-destination', [
  cmGet(activeLayer().cells, 0, 0)?.c,
  cmGet(activeLayer().cells, 3, 0)?.c,
], [undefined, 'A']);
S.updateMove(0, 0);
S.finalizeMove();
eq('move-away-and-back-cancels-history-and-restores-collisions', {
  source: cmGet(activeLayer().cells, 0, 0),
  destination: cmGet(activeLayer().cells, 3, 0),
  selection: selectionKeys(),
  canUndo: get(G.canUndo),
  moveState: get(S.moveState),
}, {
  source: A,
  destination: B,
  selection: [cmKey(0, 0)],
  canUndo: false,
  moveState: null,
});

id = reset([{
  name: 'wide transform', type: 'cell', visible: true, cells: {
    [cmKey(0, 0)]: { c: '界', fg: '#ffffff', bg: '#010101' },
    [cmKey(1, 0)]: { c: '', fg: '#ffffff', bg: '#020202', cont: true },
    [cmKey(4, 0)]: { c: '旧', fg: '#aaaaaa', bg: '#040404' },
    [cmKey(5, 0)]: { c: '', fg: '#aaaaaa', bg: '#050505', cont: true },
  },
}]);
G.cellSelection.set(new Set([cmKey(0, 0)]));
S.beginTransformSelection();
S.updateTransformBounds({ x: 2, y: 0, w: 1, h: 1 });
eq('wide-transform-clamps-to-a-valid-two-cell-glyph', [
  [cmGet(activeLayer().cells, 2, 0)?.c, !!cmGet(activeLayer().cells, 3, 0)?.cont],
  get(S.moveState).bounds.w,
  selectionKeys(),
], [['界', true], 2, [cmKey(2, 0), cmKey(3, 0)]]);
S.updateTransformBounds({ x: 4, y: 0, w: 4, h: 1 });
const wideResult = activeLayer().cells;
eq('wide-transform-rebuilds-pairs-from-source-and-clears-collisions', [
  [4, 5, 6, 7].map((x) => [cmGet(wideResult, x, 0)?.c, !!cmGet(wideResult, x, 0)?.cont]),
  [cmGet(wideResult, 4, 0)?.bg, cmGet(wideResult, 5, 0)?.bg],
  Object.entries(wideResult).filter(([, cell]) => cell?.cont)
    .every(([position]) => {
      const [x, y] = position.split(',').map(Number);
      const left = cmGet(wideResult, x - 1, y);
      return !!left && !left.cont;
    }),
], [
  [['界', false], ['', true], ['界', false], ['', true]],
  ['#040404', '#050505'],
  true,
]);
S.cancelMove();

id = reset([{
  name: 'text selection', type: 'text', visible: true,
  text: 'AB', box: { x: 0, y: 0, w: 2, h: 1 }, wrap: true, fg: '#ffffff',
  runs: [{ start: 1, end: 2, fg: '#ff0000' }],
  cells: { [cmKey(0, 0)]: A, [cmKey(1, 0)]: { ...B, fg: '#ff0000' } },
}]);
const liveText = structuredClone(activeLayer());
G.cellSelection.set(new Set([cmKey(1, 0)]));
eq('text-rejects-cell-move-without-rasterizing-or-adding-history', [
  S.beginMove(),
  activeLayer(),
  get(G.layers).length,
  get(G.canUndo),
  get(S.moveState),
], [false, liveText, 1, false, null]);
G.cellSelection.set(new Set([cmKey(1, 0)]));
eq('text-rejects-cell-transform-without-rasterizing-or-adding-history', [
  S.beginTransformSelection(),
  activeLayer(),
  get(G.canUndo),
  get(S.moveState),
], [false, liveText, false, null]);
G.cellSelection.set(new Set([cmKey(1, 0)]));
eq('text-rejects-selection-cut-without-rasterizing-or-adding-a-layer', [
  S.selectionToNewLayer(true),
  activeLayer(),
  get(G.layers).length,
  get(G.canUndo),
], [null, liveText, 1, false]);
const wideShape = {
  kind: 'line', x0: 0, y0: 0, x1: 4, y1: 0,
  style: 'outline', detail: 'cell', channel: 'glyph', char: '界', fg: '#ffffff', wide: true,
};
eq('wide-shape-skips-overlapping-primaries', shapeGlyphs(wideShape).map((p) => p.x), [0, 2, 4]);
const wideCells = renderShapeToCells(wideShape);
eq('wide-shape-writes-terminal-continuations', Object.keys(wideCells).sort(), [0, 1, 2, 3, 4, 5].map((x) => cmKey(x, 0)).sort());
eq('wide-shape-continuations-are-marked', [
  wideCells[cmKey(1, 0)].cont,
  wideCells[cmKey(3, 0)].cont,
  wideCells[cmKey(5, 0)].cont,
], [true, true, true]);

const zeroDistanceShape = { ...shape, x1: shape.x0, y1: shape.y0, char: 'X' };
eq('zero-distance-shape-has-no-preview-glyph', shapeGlyphs(zeroDistanceShape), []);
eq('zero-distance-special-shape-does-not-use-active-glyph', renderShapeToCells({
  ...zeroDistanceShape, kind: 'rect', style: 'special', boxStyle: 'double',
}), {});

const clipboardImage = { name: 'clipboard.png', type: 'image/png' };
eq('clipboard-prefers-direct-image-file', clipboardImageFile({
  files: [clipboardImage], items: [],
}), clipboardImage);
eq('clipboard-accepts-image-item', clipboardImageFile({
  files: [],
  items: [{ kind: 'file', type: 'image/png', getAsFile: () => clipboardImage }],
}), clipboardImage);
eq('clipboard-rejects-non-image-file', clipboardImageFile({
  files: [{ name: 'notes.txt', type: 'text/plain' }], items: [],
}), null);
eq('bitmap-success-requires-an-actual-media-placement', [
  clipboardMediaPlacementSucceeded(null),
  clipboardMediaPlacementSucceeded({ changed: false }),
  clipboardMediaPlacementSucceeded({ placement: 'layer-id' }),
], [false, false, true]);

loadMediaRegistry({ generation: 0, assets: [] });
clearClipClipboard();
let clipboardSourceId = reset([{
  name: 'Two clips', type: 'cell', visible: true,
  cells: { [cmKey(0, 0)]: A },
}]);
let clipboardState = getClipTimelineState();
let clipboardTrack = clipboardState.tracks[0];
const firstClipboardClip = {
  ...clipboardState.clips[0],
  id: 'clipboard-first', startTick: 0, inTick: 0, outTick: 2, sourceDuration: 2,
  frameKeys: [{ tick: 0, value: { cells: { [cmKey(0, 0)]: A } } }],
};
const secondClipboardClip = {
  ...firstClipboardClip,
  id: 'clipboard-second', startTick: 4,
  frameKeys: [{ tick: 0, value: { cells: { [cmKey(0, 0)]: B } } }],
};
F.loadCanonicalTimeline({
  ...clipboardState,
  tracks: [clipboardTrack],
  clips: [firstClipboardClip, secondClipboardClip],
});
G.resetEditorStateForProjectLoad();
F.seekTick(1);
const layerPayload = F.captureLayerClipClipboard();
eq('layer-copy-captures-only-the-active-playhead-clip', {
  clips: layerPayload.clips.map((clip) => clip.id),
  media: layerPayload.media,
}, { clips: ['clipboard-first'], media: [] });
let systemClipboard = nativeClipboard({ files: [clipboardImage] });
eq('native-copy-replaces-an-old-bitmap-with-an-opaque-marker-and-text-fallback', {
  copied: copyClipsForContext('layers', systemClipboard),
  available: hasClipClipboard(),
  clearCount: systemClipboard.clearCount,
  files: systemClipboard.files,
  markerMatches: clipboardHasMatchingClipMarker(systemClipboard),
  text: systemClipboard.getData('text/plain'),
  markerLeaksPayload: systemClipboard.getData(PAINTTY_CLIPBOARD_MIME).includes('clipboard-first'),
}, {
  copied: 1,
  available: true,
  clearCount: 1,
  files: [],
  markerMatches: true,
  text: `${PAINTTY_CLIPBOARD_TEXT} (1)`,
  markerLeaksPayload: false,
});
const matchingMarker = systemClipboard.getData(PAINTTY_CLIPBOARD_MIME);
eq('matching-private-marker-is-required-in-layers-or-timeline-context', [
  clipboardPasteIntent(systemClipboard, 'layers').kind,
  clipboardPasteIntent(systemClipboard, 'timeline').kind,
  clipboardPasteIntent(systemClipboard, 'canvas').kind,
], ['clips', 'clips', 'none']);
const unrelatedClipboard = nativeClipboard({ data: { 'text/plain': 'ordinary text' } });
const beforeUnrelatedPaste = structuredClone(getClipTimelineState());
eq('unrelated-native-clipboard-data-cannot-invoke-internal-paste', {
  intent: clipboardPasteIntent(unrelatedClipboard, 'timeline').kind,
  result: pasteClipsFromClipboard(unrelatedClipboard).reason,
  state: getClipTimelineState(),
}, { intent: 'none', result: 'clipboard-marker', state: beforeUnrelatedPaste });
const bitmapWithMarker = nativeClipboard({
  files: [clipboardImage],
  data: { [PAINTTY_CLIPBOARD_MIME]: matchingMarker },
});
eq('bitmap-paste-still-wins-over-a-matching-private-marker',
  clipboardPasteIntent(bitmapWithMarker, 'timeline'),
  { kind: 'image', file: clipboardImage });
F.seekTick(5);
let clipboardPaste = pasteClipsFromClipboard(systemClipboard);
let pastedTimeline = getClipTimelineState();
eq('layer-copy-pastes-only-that-clip-on-one-new-named-track', {
  clipCount: clipboardPaste.clipIds.length,
  layerCount: clipboardPaste.layerIds.length,
  startTick: pastedTimeline.clips.find((clip) => clip.id === clipboardPaste.clipIds[0]).startTick,
  glyph: pastedTimeline.clips.find((clip) => clip.id === clipboardPaste.clipIds[0])
    .frameKeys[0].value.cells[cmKey(0, 0)].c,
  name: pastedTimeline.tracks.find((track) => track.id === clipboardPaste.trackIds[0]).name,
  sourceClipCount: pastedTimeline.clips.filter((clip) => clip.trackId === clipboardTrack.id).length,
}, {
  clipCount: 1,
  layerCount: 1,
  startTick: 5,
  glyph: 'A',
  name: 'Two clips copy',
  sourceClipCount: 2,
});

clearClipClipboard();
reset([
  { name: 'Timeline A', type: 'cell', visible: true, cells: { [cmKey(0, 0)]: A } },
  { name: 'Timeline B', type: 'cell', visible: true, cells: { [cmKey(0, 0)]: B } },
]);
clipboardState = getClipTimelineState();
const [timelineTrackA, timelineTrackB] = clipboardState.tracks;
const timelineClipA = {
  ...clipboardState.clips.find((clip) => clip.trackId === timelineTrackA.id),
  id: 'timeline-copy-a', startTick: 1, inTick: 0, outTick: 2, sourceDuration: 2,
};
const timelineClipB = {
  ...clipboardState.clips.find((clip) => clip.trackId === timelineTrackB.id),
  id: 'timeline-copy-b', startTick: 4, inTick: 0, outTick: 1, sourceDuration: 1,
};
F.loadCanonicalTimeline({
  ...clipboardState,
  tracks: [timelineTrackA, timelineTrackB],
  clips: [timelineClipA, timelineClipB],
});
G.resetEditorStateForProjectLoad();
F.setClipSelection({ clipIds: ['timeline-copy-a', 'timeline-copy-b'] });
systemClipboard = nativeClipboard();
eq('timeline-context-copies-the-selected-clips',
  copyClipsForContext('timeline', systemClipboard), 2);
F.seekTick(4);
clipboardPaste = pasteClipsFromClipboard(systemClipboard);
pastedTimeline = getClipTimelineState();
const relativePasteClips = clipboardPaste.clipIds.map((clipId) =>
  pastedTimeline.clips.find((clip) => clip.id === clipId));
eq('timeline-multiclip-paste-preserves-relative-starts-and-per-source-adjacency', {
  starts: relativePasteClips.map((clip) => clip.startTick),
  trackIds: relativePasteClips.map((clip) => clip.trackId),
  names: clipboardPaste.trackIds.map((trackId) =>
    pastedTimeline.tracks.find((track) => track.id === trackId).name),
  indexes: clipboardPaste.trackIds.map((trackId) =>
    pastedTimeline.tracks.findIndex((track) => track.id === trackId)),
  selectedClips: [...getClipTimelineSelection().clipIds],
  selectedLayers: [...get(G.selectedLayerIds)],
}, {
  starts: [4, 7],
  trackIds: clipboardPaste.trackIds,
  names: ['Timeline A copy', 'Timeline B copy'],
  indexes: [0, 2],
  selectedClips: clipboardPaste.clipIds,
  selectedLayers: clipboardPaste.layerIds,
});
G.undo();
eq('clip-paste-undo-is-one-step', {
  tracks: getClipTimelineState().tracks.length,
  clips: getClipTimelineState().clips.length,
  canUndo: get(G.canUndo),
}, { tracks: 2, clips: 2, canUndo: false });
G.redo();
eq('clip-paste-redo-restores-the-complete-selection', {
  tracks: getClipTimelineState().tracks.length,
  clips: getClipTimelineState().clips.length,
  selection: [...getClipTimelineSelection().clipIds],
}, { tracks: 4, clips: 4, selection: clipboardPaste.clipIds });

const AUDIO_ASSET_ID = 'a7f8b394-89a4-4f4f-9130-a7ba8f71f743';
loadMediaRegistry({
  generation: 1,
  assets: [mediaDefinition(AUDIO_ASSET_ID, 'audio', MEDIA_HASH_A)],
});
clearClipClipboard();
reset([{
  name: 'Audio paste visual', type: 'cell', visible: true, cells: { [cmKey(0, 0)]: A },
}]);
clipboardState = getClipTimelineState();
const audioSourceTrack = {
  id: 'clipboard-audio-track', kind: 'audio', name: 'Voice', locked: false,
};
const audioSourceClip = {
  id: 'clipboard-audio-clip', trackId: audioSourceTrack.id, kind: 'audio',
  assetId: AUDIO_ASSET_ID, startTick: 2, inPoint: 0.25, outPoint: 0.75,
  duration: 2, volume: 0.6, muted: false,
};
F.loadCanonicalTimeline({
  ...clipboardState,
  fps: 24,
  tracks: [...clipboardState.tracks, audioSourceTrack],
  clips: [...clipboardState.clips, audioSourceClip],
});
G.resetEditorStateForProjectLoad();
F.setClipSelection({ clipIds: [audioSourceClip.id] });
systemClipboard = nativeClipboard();
copyClipsForContext('timeline', systemClipboard);
F.seekTick(4);
clipboardPaste = pasteClipsFromClipboard(systemClipboard);
pastedTimeline = getClipTimelineState();
const pastedAudioTrack = pastedTimeline.tracks.find((track) =>
  track.id === clipboardPaste.trackIds[0]);
const pastedAudioClip = pastedTimeline.clips.find((clip) =>
  clip.id === clipboardPaste.clipIds[0]);
eq('audio-paste-creates-a-fresh-uniquely-named-track-and-reuses-the-exact-asset', {
  trackKind: pastedAudioTrack.kind,
  name: pastedAudioTrack.name,
  trackFresh: pastedAudioTrack.id !== audioSourceTrack.id,
  clipFresh: pastedAudioClip.id !== audioSourceClip.id,
  startTick: pastedAudioClip.startTick,
  assetId: pastedAudioClip.assetId,
  layerIds: clipboardPaste.layerIds,
}, {
  trackKind: 'audio',
  name: 'Voice copy',
  trackFresh: true,
  clipFresh: true,
  startTick: 4,
  assetId: AUDIO_ASSET_ID,
  layerIds: [],
});
G.undo();
const beforePurgedAudioPaste = structuredClone(getClipTimelineState());
purgeMediaAssets([AUDIO_ASSET_ID]);
const purgedAudioPaste = pasteClipsFromClipboard(systemClipboard);
eq('purged-audio-media-rejects-paste-without-consuming-redo', {
  reason: purgedAudioPaste.reason,
  state: getClipTimelineState(),
  canRedo: get(G.canRedo),
  available: hasClipClipboard(),
}, {
  reason: 'stale-media',
  state: beforePurgedAudioPaste,
  canRedo: true,
  available: false,
});

loadMediaRegistry({ generation: 0, assets: [] });
clearClipClipboard();
reset([{
  name: 'Editable shape', type: 'shape', visible: true,
  shape: {
    kind: 'rect', x0: 1, y0: 2, x1: 6, y1: 5,
    style: 'outline', detail: 'cell', channel: 'glyph', char: '#', fg: '#ffffff',
  },
  cells: { [cmKey(1, 2)]: { c: '#', fg: '#ffffff', bg: null } },
}]);
clipboardState = getClipTimelineState();
const sourceShapeClip = clipboardState.clips[0];
const shapePropertyTracks = {
  position: [{ tick: 0, value: { x: 3, y: 4 }, interpolation: 'linear' }],
  shapePath: [{
    tick: 0,
    value: { path: sourceShapeClip.frameKeys[0].value.shape },
    interpolation: 'hold',
  }],
};
F.loadCanonicalTimeline({
  ...clipboardState,
  clips: [{
    ...sourceShapeClip,
    propertyTracks: shapePropertyTracks,
    editableMetadata: { handles: ['nw', 'se'] },
  }],
});
G.resetEditorStateForProjectLoad();
const clipboardOriginalShape = get(G.layers)[0];
systemClipboard = nativeClipboard();
copyClipsForContext('layers', systemClipboard);
clipboardPaste = pasteClipsFromClipboard(systemClipboard);
const clipboardShape = get(G.layers).find((layer) => layer.id === clipboardPaste.layerIds[0]);
const clipboardShapeClip = getClipTimelineState().clips.find((clip) =>
  clip.id === clipboardPaste.clipIds[0]);
eq('clip-paste-preserves-editable-shape-geometry-with-fresh-identities', {
  type: clipboardShape.type,
  name: clipboardShape.name,
  shape: clipboardShape.shape,
  propertyTracks: clipboardShapeClip.propertyTracks,
  editableMetadata: clipboardShapeClip.editableMetadata,
  sameShapeObject: clipboardShape.shape === clipboardOriginalShape.shape,
  sameLayerId: clipboardShape.id === clipboardOriginalShape.id,
  selected: get(G.selectedLayerIds).has(clipboardShape.id),
}, {
  type: 'shape',
  name: 'Editable shape copy',
  shape: clipboardOriginalShape.shape,
  propertyTracks: shapePropertyTracks,
  editableMetadata: { handles: ['nw', 'se'] },
  sameShapeObject: false,
  sameLayerId: false,
  selected: true,
});

clearClipClipboard();
reset([
  { name: 'Group A', type: 'group', visible: true, cells: {} },
  { name: 'Member', type: 'cell', visible: true, cells: { [cmKey(0, 0)]: A } },
  { name: 'Group B', type: 'group', visible: true, cells: {} },
  { name: 'Member', type: 'cell', visible: true, cells: { [cmKey(1, 0)]: B } },
]);
let [groupA, memberA, groupB, memberB] = get(G.layers);
memberA = { ...memberA, groupId: groupA.id };
memberB = { ...memberB, groupId: groupB.id };
G.layers.set([groupA, memberA, groupB, memberB]);
F.initTimeline(get(G.layers));
G.resetEditorStateForProjectLoad();
G.selectedLayerIds.set(new Set([groupA.id, groupB.id]));
G.activeLayerId.set(groupB.id);
systemClipboard = nativeClipboard();
eq('two-selected-groups-copy-only-their-active-descendant-clips',
  copyClipsForContext('layers', systemClipboard), 2);
clipboardPaste = pasteClipsFromClipboard(systemClipboard);
pastedTimeline = getClipTimelineState();
const pastedGroupLayers = get(G.layers);
const copiedGroupTracks = clipboardPaste.trackIds.map((trackId) =>
  pastedTimeline.tracks.find((track) => track.id === trackId));
eq('per-source-insertion-keeps-two-group-blocks-contiguous-and-copy-names-unique', {
  layout: pastedGroupLayers.map((layer) => [layer.name, layer.groupId || null]),
  parents: copiedGroupTracks.map((track) => track.layer.groupId),
}, {
  layout: [
    ['Group A', null],
    ['Member copy', groupA.id],
    ['Member', groupA.id],
    ['Group B', null],
    ['Member copy 2', groupB.id],
    ['Member', groupB.id],
  ],
  parents: [groupA.id, groupB.id],
});

clearClipClipboard();
reset([
  { name: 'Existing group', type: 'group', visible: true, cells: {} },
  { name: 'Removed source', type: 'cell', visible: true, cells: { [cmKey(0, 0)]: A } },
]);
let [existingGroup, removedSource] = get(G.layers);
removedSource = { ...removedSource, groupId: existingGroup.id };
G.layers.set([existingGroup, removedSource]);
F.initTimeline(get(G.layers));
G.resetEditorStateForProjectLoad();
G.selectLayer(removedSource.id);
systemClipboard = nativeClipboard();
copyClipsForContext('layers', systemClipboard);
G.removeLayer(removedSource.id);
await Promise.resolve();
await Promise.resolve();
clipboardPaste = pasteClipsFromClipboard(systemClipboard);
const orphanCopyTrack = getClipTimelineState().tracks.find((track) =>
  track.id === clipboardPaste.trackIds[0]);
eq('a-missing-source-appends-its-copy-ungrouped', {
  lastLayer: get(G.layers).at(-1).id,
  copiedLayer: clipboardPaste.layerIds[0],
  groupId: orphanCopyTrack.layer.groupId || null,
  parentTrackId: orphanCopyTrack.parentTrackId || null,
}, {
  lastLayer: clipboardPaste.layerIds[0],
  copiedLayer: clipboardPaste.layerIds[0],
  groupId: null,
  parentTrackId: null,
});

const IMAGE_ASSET_ID = 'd7f8b394-89a4-4f4f-9130-a7ba8f71f742';
F.loadCanonicalTimeline({ fps: get(F.fps), tracks: [], clips: [], tags: [] });
loadMediaRegistry({
  generation: 1,
  assets: [mediaDefinition(IMAGE_ASSET_ID, 'image', MEDIA_HASH_A)],
});
clearClipClipboard();
reset([{
  name: 'Reference', type: 'image', visible: true,
  assetId: IMAGE_ASSET_ID,
  sourceWidth: 32, sourceHeight: 16, cells: {},
  transform: { x: 10, y: 6, scale: 1, rot: 0 },
}]);
const imagePayload = F.captureLayerClipClipboard();
eq('image-clipboard-captures-the-exact-media-identity', imagePayload.media, [{
  assetId: IMAGE_ASSET_ID,
  hash: MEDIA_HASH_A,
  generation: 1,
  kind: 'image',
}]);
systemClipboard = nativeClipboard();
copyClipsForContext('layers', systemClipboard);
clipboardPaste = pasteClipsFromClipboard(systemClipboard);
const clipboardPastedImage = get(G.layers)
  .find((layer) => layer.id === clipboardPaste.layerIds[0]);
eq('image-paste-reuses-the-retained-asset-and-gets-a-copy-name', {
  type: clipboardPastedImage.type,
  assetId: clipboardPastedImage.assetId,
  name: clipboardPastedImage.name,
}, { type: 'image', assetId: IMAGE_ASSET_ID, name: 'Reference copy' });
const acceptedImageProject = serializeJSON();
loadJSON(acceptedImageProject);
eq('accepted-media-paste-survives-save-reload-with-a-valid-identity-graph', {
  imageLayers: get(G.layers).filter((layer) => layer.type === 'image')
    .map((layer) => [layer.name, layer.assetId]),
  registryAsset: mediaAssetById(IMAGE_ASSET_ID)?.assetId,
  clipboardAvailable: hasClipClipboard(),
  oldMarkerMatches: clipboardHasMatchingClipMarker(systemClipboard),
}, {
  imageLayers: [['Reference copy', IMAGE_ASSET_ID], ['Reference', IMAGE_ASSET_ID]],
  registryAsset: IMAGE_ASSET_ID,
  clipboardAvailable: false,
  oldMarkerMatches: false,
});

const VIDEO_ASSET_ID = 'b7f8b394-89a4-4f4f-9130-a7ba8f71f744';
loadMediaRegistry({
  generation: 1,
  assets: [mediaDefinition(VIDEO_ASSET_ID, 'video', MEDIA_HASH_A)],
});
clearClipClipboard();
reset([{
  name: 'Video reference', type: 'video', visible: true, cells: {},
  videoClip: {
    assetId: VIDEO_ASSET_ID, startTick: 0, inPoint: 0, outPoint: 2,
    playbackRate: 1, duration: 2, width: 32, height: 16,
  },
  transform: { x: 10, y: 6, scale: 1, rot: 0 },
}]);
const videoPayload = F.captureLayerClipClipboard();
eq('video-clipboard-captures-the-exact-media-identity', videoPayload.media, [{
  assetId: VIDEO_ASSET_ID,
  hash: MEDIA_HASH_A,
  generation: 1,
  kind: 'video',
}]);
systemClipboard = nativeClipboard();
copyClipsForContext('layers', systemClipboard);
clipboardPaste = pasteClipsFromClipboard(systemClipboard);
eq('video-paste-keeps-media-identity-and-an-understandable-copy-name', {
  name: get(G.layers).find((layer) => layer.id === clipboardPaste.layerIds[0]).name,
  assetId: getClipTimelineState().clips.find((clip) =>
    clip.id === clipboardPaste.clipIds[0]).assetId,
}, { name: 'Video reference copy', assetId: VIDEO_ASSET_ID });
G.undo();
systemClipboard = nativeClipboard();
copyClipsForContext('layers', systemClipboard);
replaceMediaAsset(VIDEO_ASSET_ID, {
  ...mediaDefinition(VIDEO_ASSET_ID, 'video', MEDIA_HASH_B),
  sourceName: 'replacement-video',
});
const beforeReplacedVideoPaste = structuredClone(getClipTimelineState());
const replacedVideoPaste = pasteClipsFromClipboard(systemClipboard);
eq('replacement-generation-rejects-video-paste-without-consuming-redo', {
  reason: replacedVideoPaste.reason,
  generation: mediaAssetById(VIDEO_ASSET_ID).generation,
  state: getClipTimelineState(),
  canRedo: get(G.canRedo),
}, {
  reason: 'stale-media',
  generation: 2,
  state: beforeReplacedVideoPaste,
  canRedo: true,
});

loadMediaRegistry({ generation: 0, assets: [] });
clearClipClipboard();
reset([{
  name: 'Import baseline', type: 'cell', visible: true, cells: { [cmKey(0, 0)]: A },
}]);
const importedImageFile = new Blob(['test'], { type: 'image/png' });
Object.defineProperty(importedImageFile, 'name', { value: 'imported.png' });
const importedImage = await importMediaFile(importedImageFile, 'image', {
  hashFile: async () => MEDIA_HASH_C,
  decodeFile: async () => ({
    runtime: { raster: { width: 4, height: 2, close() {} }, blob: importedImageFile },
    metadata: { width: 4, height: 2 },
  }),
  putAsset: async () => {},
});
G.selectLayer(importedImage.placement);
systemClipboard = nativeClipboard();
eq('a-newly-imported-image-clip-can-be-copied-with-its-generation',
  copyClipsForContext('layers', systemClipboard), 1);
const importedAssetId = get(G.layers).find((layer) => layer.id === importedImage.placement).assetId;
G.undo();
const beforeUndoneImportPaste = structuredClone(getClipTimelineState());
const undoneImportPaste = pasteClipsFromClipboard(systemClipboard);
eq('copy-import-undo-paste-rejects-removed-media-without-changing-history-or-redo', {
  reason: undoneImportPaste.reason,
  asset: mediaAssetById(importedAssetId),
  state: getClipTimelineState(),
  canUndo: get(G.canUndo),
  canRedo: get(G.canRedo),
  clipboardAvailable: hasClipClipboard(),
}, {
  reason: 'stale-media',
  asset: null,
  state: beforeUndoneImportPaste,
  canUndo: false,
  canRedo: true,
  clipboardAvailable: false,
});

clearClipClipboard();
clipboardSourceId = reset([{
  name: 'Stale source', type: 'cell', visible: true, cells: { [cmKey(0, 0)]: A },
}]);
const stalePayload = F.captureLayerClipClipboard();
stalePayload.projectRevision++;
const beforeStalePaste = structuredClone(getClipTimelineState());
const stalePaste = F.pasteClipClipboard(stalePayload);
eq('stale-project-clipboards-are-rejected-without-history-or-partial-state', {
  reason: stalePaste.reason,
  state: getClipTimelineState(),
  canUndo: get(G.canUndo),
  activeLayerId: get(G.activeLayerId),
}, {
  reason: 'stale-project',
  state: beforeStalePaste,
  canUndo: false,
  activeLayerId: clipboardSourceId,
});

clearClipClipboard();
clipboardSourceId = reset([{
  name: 'FPS source', type: 'cell', visible: true, cells: { [cmKey(0, 0)]: A },
}]);
const staleFpsPayload = F.captureLayerClipClipboard();
staleFpsPayload.fps += 1;
const beforeStaleFpsPaste = structuredClone(getClipTimelineState());
const staleFpsPaste = F.pasteClipClipboard(staleFpsPayload);
eq('frame-rate-changed-clipboards-are-rejected-without-history', {
  reason: staleFpsPaste.reason,
  state: getClipTimelineState(),
  canUndo: get(G.canUndo),
  activeLayerId: get(G.activeLayerId),
}, {
  reason: 'stale-fps',
  state: beforeStaleFpsPaste,
  canUndo: false,
  activeLayerId: clipboardSourceId,
});

systemClipboard = nativeClipboard();
copyClipsForContext('layers', systemClipboard);
const replacementRevision = advanceProjectRevision();
notifyProjectReplaced({ revision: replacementRevision });
reset([{
  name: 'New project layer', type: 'cell', visible: true, cells: {},
}]);
eq('project-replacement-clears-internal-clips-and-invalidates-old-native-markers', {
  available: hasClipClipboard(),
  markerMatches: clipboardHasMatchingClipMarker(systemClipboard),
  intent: clipboardPasteIntent(systemClipboard, 'layers').kind,
}, { available: false, markerMatches: false, intent: 'none' });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
