import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { activeChar, activeTool, paintColor, toolOptions } from '../src/lib/stores.js';
import { isWide } from '../src/lib/width.js';
import {
  applyTool,
  constrainDraggedShapeEndpoint,
  displayedSampleCell,
  paintSpecialBrushPath,
  previewSpecialBrushGlyph,
  visibleColorFromCell,
} from '../src/lib/tools.js';
import {
  activeLayerPart,
  applyBlinkPhase,
  authoredRevision,
  beginStroke,
  canRedo,
  canUndo,
  cancelStroke,
  dims,
  endStroke,
  getCell,
  layers,
  redo,
  selectLayer,
  setCell,
  setLayers,
  undo,
} from '../src/lib/grid.js';
import { selection } from '../src/lib/selection.js';

let pass = 0;
let fail = 0;

function eq(name, got, want) {
  try {
    assert.deepStrictEqual(got, want);
    pass++;
  } catch (error) {
    fail++;
    console.error('FAIL ' + name + '\n' + error.message);
  }
}

eq('visible color prefers glyph foreground',
  visibleColorFromCell({ fg: '#112233', bg: '#445566' }), '#112233');
eq('background color preference follows the target channel',
  visibleColorFromCell({ fg: '#112233', bg: '#445566' }, true), '#445566');
eq('visible color falls back across empty channels', [
  visibleColorFromCell({ bg: '#445566' }),
  visibleColorFromCell({ fg: '#112233' }, true),
  visibleColorFromCell(null),
], ['#445566', '#112233', null]);

dims.set({ w: 12, h: 8 });
setLayers([
  { name: 'position group', type: 'group', visible: true, offset: { x: 4, y: -1 }, cells: {} },
  {
    name: 'positioned glyph',
    type: 'cell',
    visible: true,
    offset: { x: 2, y: 3 },
    cells: { '1,2': { c: 'S', fg: '#111111' } },
  },
]);
let [positionGroup, positionedGlyph] = get(layers);
positionedGlyph = { ...positionedGlyph, groupId: positionGroup.id };
layers.set([positionGroup, positionedGlyph]);
selectLayer(positionedGlyph.id);
eq('grouped-offset-active-cell-read-uses-world-coordinates',
  getCell(7, 4), { c: 'S', fg: '#111111' });
setCell(8, 5, { c: 'D', fg: '#222222' });
eq('grouped-offset-direct-write-stores-layer-local-coordinates', {
  local: get(layers)[1].cells['2,3'],
  doubled: get(layers)[1].cells['8,5'],
}, {
  local: { c: 'D', fg: '#222222' },
  doubled: undefined,
});
activeTool.set('brush');
activeChar.set('B');
paintColor.set('#334455');
applyTool(9, 6, {}, 'down');
eq('grouped-offset-brush-stays-under-the-world-space-pointer',
  get(layers)[1].cells['3,4'], { c: 'B', fg: '#334455', bg: null });
activeTool.set('eraser');
applyTool(9, 6, {}, 'down');
eq('grouped-offset-eraser-clears-the-same-local-cell', get(layers)[1].cells['3,4'], undefined);

setLayers([
  { name: 'background group', type: 'group', visible: true, offset: { x: -2, y: 1 }, cells: {} },
  { name: 'positioned background', type: 'background', visible: true, offset: { x: 1, y: 2 }, cells: {} },
]);
let [backgroundGroup, positionedBackground] = get(layers);
positionedBackground = { ...positionedBackground, groupId: backgroundGroup.id };
layers.set([backgroundGroup, positionedBackground]);
selectLayer(positionedBackground.id);
activeTool.set('brush');
paintColor.set('#556677');
applyTool(0, 4, {}, 'down');
eq('grouped-offset-background-brush-stores-layer-local-coordinates',
  get(layers)[1].cells['1,1'], { c: '', fg: null, bg: '#556677' });
activeTool.set('eraser');
applyTool(0, 4, {}, 'down');
eq('grouped-offset-background-eraser-clears-the-same-local-cell',
  get(layers)[1].cells['1,1'], undefined);

setLayers([
  { name: 'mask group', type: 'group', visible: true, offset: { x: 2, y: 2 }, cells: {} },
  {
    name: 'positioned mask',
    type: 'effect',
    visible: true,
    offset: { x: 1, y: -1 },
    effect: { kind: 'brightness', intensity: 0.5 },
    mask: { defaultStrength: 1, cells: {}, offset: { x: -1, y: 3 } },
  },
]);
let [maskGroup, positionedMask] = get(layers);
positionedMask = { ...positionedMask, groupId: maskGroup.id };
layers.set([maskGroup, positionedMask]);
selectLayer(positionedMask.id);
activeLayerPart.set('mask');
setCell(4, 5, { mask: 0.25 });
eq('effect-mask-world-coordinate-mapping-still-includes-layer-group-and-mask-offsets', [
  get(layers)[1].mask.cells['2,1'],
  getCell(4, 5),
], [
  { mask: 0.25 },
  { mask: 0.25 },
]);
activeLayerPart.set('layer');

dims.set({ w: 80, h: 30 });
setLayers([{ name: 'fill', type: 'cell', visible: true, cells: {} }]);
activeTool.set('fill');
activeChar.set('#');
paintColor.set('#e06c6c');
toolOptions.update((options) => ({
  ...options,
  fill: { ...options.fill, contiguous: true, sampleAll: false },
}));

beginStroke();
applyTool(0, 0, {}, 'down');
endStroke();
const filled = get(layers)[0].cells;

eq('whole-canvas-fill-count', Object.keys(filled).length, 80 * 30);
eq('whole-canvas-fill-corners', [filled['0,0']?.c, filled['79,29']?.c], ['#', '#']);
undo();
eq('whole-canvas-fill-undo', Object.keys(get(layers)[0].cells).length, 0);

const border = {};
for (let x = 10; x <= 20; x++) {
  border[x + ',10'] = { c: '-', fg: '#ffffff', bg: null };
  border[x + ',15'] = { c: '-', fg: '#ffffff', bg: null };
}
for (let y = 10; y <= 15; y++) {
  border['10,' + y] = { c: '|', fg: '#ffffff', bg: null };
  border['20,' + y] = { c: '|', fg: '#ffffff', bg: null };
}
setLayers([{ name: 'bounded', type: 'cell', visible: true, cells: border }]);
activeChar.set('.');
applyTool(15, 12, {}, 'down');
const bounded = get(layers)[0].cells;

eq('bounded-fill-interior', bounded['15,12']?.c, '.');
eq('bounded-fill-does-not-escape', bounded['0,0'], undefined);

setLayers([{ name: 'selected fill', type: 'cell', visible: true, cells: {} }]);
selection.set(new Set(['1,1', '2,1', '1,2', '2,2']));
activeChar.set('+');
applyTool(1, 1, {}, 'down');
const selectedFill = get(layers)[0].cells;
eq('selection-clips-fill-count', Object.keys(selectedFill).length, 4);
eq('selection-clips-fill-bounds', [selectedFill['1,1']?.c, selectedFill['2,2']?.c, selectedFill['0,0']], ['+', '+', undefined]);

setLayers([{ name: 'outside selection', type: 'cell', visible: true, cells: {} }]);
selection.set(new Set(['1,1']));
applyTool(0, 0, {}, 'down');
eq('fill-outside-selection-is-no-op', Object.keys(get(layers)[0].cells).length, 0);
selection.set(new Set());


dims.set({ w: 3, h: 1 });
setLayers([{
  name: 'color boundary', type: 'cell', visible: true,
  cells: {
    '0,0': { c: '@', fg: '#ff0000', bg: null },
    '1,0': { c: '@', fg: '#ff0000', bg: null },
    '2,0': { c: '@', fg: '#0000ff', bg: null },
  },
}]);
activeChar.set('X');
paintColor.set('#00ff00');
applyTool(0, 0, {}, 'down');
const colorBoundary = get(layers)[0].cells;
eq('fill-stops-at-same-glyph-different-color', [
  colorBoundary['0,0'], colorBoundary['1,0'], colorBoundary['2,0'],
], [
  { c: 'X', fg: '#00ff00', bg: null },
  { c: 'X', fg: '#00ff00', bg: null },
  { c: '@', fg: '#0000ff', bg: null },
]);

dims.set({ w: 2, h: 1 });
setLayers([{
  name: 'half fill', type: 'cell', visible: true,
  cells: {
    '0,0': { c: '▄', fg: '#111111', bg: '#010203' },
    '1,0': { c: '▄', fg: '#111111', bg: '#040506' },
  },
}]);
selection.set(new Set());
activeTool.set('fill');
paintColor.set('#abcdef');
toolOptions.update((options) => ({
  ...options,
  fill: { ...options.fill, contiguous: true, sampleAll: false, resolution: 'half' },
}));
applyTool(0, 0, {}, 'down', 0.25, 0.25);
eq('half-fill-writes-logical-halves-through-the-real-tool-path', get(layers)[0].cells, {
  '0,0': { c: '█', fg: '#abcdef', bg: '#010203' },
  '1,0': { c: '█', fg: '#abcdef', bg: '#040506' },
});

dims.set({ w: 1, h: 1 });
setLayers([
  { name: 'active', type: 'cell', visible: true, cells: {} },
  { name: 'sample', type: 'cell', visible: true, cells: { '0,0': { c: '▝', fg: '#123456' } } },
]);
toolOptions.update((options) => ({
  ...options,
  fill: { ...options.fill, sampleAll: true, resolution: 'quarter' },
}));
applyTool(0, 0, {}, 'down', 0.75, 0.25);
eq('quarter-fill-samples-the-composite-and-writes-only-the-active-layer', [
  get(layers)[0].cells,
  get(layers)[1].cells,
], [
  { '0,0': { c: '▝', fg: '#abcdef', bg: null } },
  { '0,0': { c: '▝', fg: '#123456' } },
]);

dims.set({ w: 2, h: 1 });
setLayers([{ name: 'background', type: 'background', visible: true, cells: {} }]);
toolOptions.update((options) => ({
  ...options,
  fill: { ...options.fill, sampleAll: false, resolution: 'quarter' },
}));
paintColor.set('#334455');
applyTool(0, 0, {}, 'down', 0.25, 0.25);
eq('background-fill-ignores-stale-subpixel-resolution', get(layers)[0].cells, {
  '0,0': { c: '', fg: null, bg: '#334455' },
  '1,0': { c: '', fg: null, bg: '#334455' },
});

dims.set({ w: 1, h: 1 });
setLayers([{
  name: 'legacy background', type: 'cell', visible: true,
  cells: { '0,0': { c: '@', fg: '#111111', bg: '#778899' } },
}]);
activeChar.set('X');
paintColor.set('#00ff00');
toolOptions.update((options) => ({
  ...options,
  fill: { ...options.fill, sampleAll: false, resolution: 'cell' },
}));
applyTool(0, 0, {}, 'down');
eq('whole-glyph-fill-preserves-the-active-cell-background', get(layers)[0].cells, {
  '0,0': { c: 'X', fg: '#00ff00', bg: '#778899' },
});

dims.set({ w: 2, h: 1 });
setLayers([{
  name: 'transparent glyph channel', type: 'cell', visible: true,
  cells: { '1,0': { c: '', fg: null, bg: '#778899' } },
}]);
activeChar.set('X');
paintColor.set('#00ff00');
toolOptions.update((options) => ({
  ...options,
  fill: { ...options.fill, sampleAll: false, resolution: 'cell' },
}));
applyTool(0, 0, {}, 'down');
eq('whole-glyph-fill-ignores-background-when-matching-empty-cells', [
  get(layers)[0].cells['0,0'],
  get(layers)[0].cells['1,0'],
], [
  { c: 'X', fg: '#00ff00', bg: null },
  { c: 'X', fg: '#00ff00', bg: '#778899' },
]);

setLayers([
  { name: 'active background', type: 'background', visible: true, cells: {} },
  { name: 'visible glyph', type: 'cell', visible: true, cells: { '0,0': { c: '@', fg: '#ffffff' } } },
]);
paintColor.set('#334455');
toolOptions.update((options) => ({
  ...options,
  fill: { ...options.fill, sampleAll: true, resolution: 'quarter' },
}));
applyTool(0, 0, {}, 'down', 0.25, 0.25);
eq('background-sample-all-ignores-visible-glyphs-when-matching', [
  get(layers)[0].cells,
  get(layers)[1].cells,
], [
  {
    '0,0': { c: '', fg: null, bg: '#334455' },
    '1,0': { c: '', fg: null, bg: '#334455' },
  },
  { '0,0': { c: '@', fg: '#ffffff' } },
]);

dims.set({ w: 2, h: 1 });
setLayers([{
  name: 'wide replacement', type: 'cell', visible: true,
  cells: {
    '0,0': { c: '界', fg: '#111111', bg: '#010203' },
    '1,0': { c: '', fg: '#111111', bg: '#040506', cont: true },
  },
}]);
activeChar.set('X');
paintColor.set('#00ff00');
toolOptions.update((options) => ({
  ...options,
  fill: { ...options.fill, sampleAll: false, resolution: 'cell' },
}));
applyTool(0, 0, {}, 'down');
eq('whole-fill-clears-the-replaced-wide-continuation', get(layers)[0].cells, {
  '0,0': { c: 'X', fg: '#00ff00', bg: '#010203' },
  '1,0': { c: '', fg: null, bg: '#040506' },
});

const originalDocument = globalThis.document;
globalThis.document = {
  createElement() {
    return { getContext: () => ({ measureText: (glyph) => ({ width: glyph === '界' ? 2 : 1 }) }) };
  },
};
eq('unicode-wide-glyphs-stay-wide-when-font-fallback-measures-one-cell', isWide('漢'), true);
dims.set({ w: 1, h: 1 });
setLayers([{ name: 'wide off-canvas', type: 'cell', visible: true, cells: {} }]);
selection.set(new Set());
activeTool.set('brush');
activeChar.set('界');
paintColor.set('#123456');
applyTool(0, 0, {}, 'down');
eq('wide-brush-keeps-off-canvas-continuation', get(layers)[0].cells, {
  '0,0': { c: '界', fg: '#123456', bg: null },
  '1,0': { c: '', fg: '#123456', bg: null, cont: true },
});

dims.set({ w: 3, h: 1 });
setLayers([{ name: 'wide fill', type: 'cell', visible: true, cells: {} }]);
activeTool.set('fill');
activeChar.set('界');
paintColor.set('#654321');
toolOptions.update((options) => ({
  ...options,
  fill: { ...options.fill, contiguous: true, sampleAll: false, resolution: 'cell' },
}));
applyTool(0, 0, {}, 'down');
eq('wide-fill-builds-complete-nonoverlapping-pairs', get(layers)[0].cells, {
  '0,0': { c: '界', fg: '#654321', bg: null },
  '1,0': { c: '', fg: '#654321', bg: null, cont: true },
});
setLayers([{
  name: 'legacy wide overlap',
  type: 'cell',
  visible: true,
  cells: { '0,0': { c: '界', fg: '#111111' } },
}]);
paintColor.set('#e0a458');
paintSpecialBrushPath([{ x: 1, y: 0 }, { x: 2, y: 0 }], 'single');
eq('special-brush-clears-unmarked-wide-leader-to-its-left', get(layers)[0].cells, {
  '1,0': { c: '─', fg: '#e0a458', bg: null },
  '2,0': { c: '─', fg: '#e0a458', bg: null },
});
globalThis.document = originalDocument;

dims.set({ w: 1, h: 1 });
setLayers([{
  name: 'effect mask fill',
  type: 'effect',
  visible: true,
  effect: { kind: 'brightness', intensity: 0.5 },
  mask: { defaultStrength: 1, cells: { '0,0': { mask: 0 } } },
}]);
activeLayerPart.set('mask');
activeTool.set('fill');
paintColor.set('#ffffff');
toolOptions.update((options) => ({
  ...options,
  fill: { ...options.fill, contiguous: true, sampleAll: false, resolution: 'quarter' },
}));
applyTool(0, 0, {}, 'down', 0.25, 0.25);
eq('effect-mask-fill-ignores-stale-subpixel-resolution',
  Math.round(get(layers)[0].mask.cells['0,0'].mask * 1e6) / 1e6, 1);
activeLayerPart.set('layer');

dims.set({ w: 5, h: 4 });
setLayers([{
  name: 'special brush',
  type: 'cell',
  visible: true,
  cells: {
    '2,0': { c: '界', fg: '#111111', bg: '#010203' },
    '3,0': { c: '', fg: '#111111', bg: '#040506', cont: true },
  },
}]);
selection.set(new Set());
paintColor.set('#e0a458');
beginStroke();
paintSpecialBrushPath([{ x: 0, y: 0 }, { x: 3, y: 0 }], 'double');
paintSpecialBrushPath([{ x: 3, y: 0 }, { x: 3, y: 2 }], 'double');
endStroke();
eq('special-brush-revises-the-turn-and-clears-wide-metadata', get(layers)[0].cells, {
  '2,0': { c: '═', fg: '#e0a458', bg: '#010203' },
  '3,0': { c: '╗', fg: '#e0a458', bg: '#040506' },
  '0,0': { c: '═', fg: '#e0a458', bg: null },
  '1,0': { c: '═', fg: '#e0a458', bg: null },
  '3,1': { c: '║', fg: '#e0a458', bg: null },
  '3,2': { c: '║', fg: '#e0a458', bg: null },
});
undo();
eq('special-brush-is-one-undoable-stroke', get(layers)[0].cells, {
  '2,0': { c: '界', fg: '#111111', bg: '#010203' },
  '3,0': { c: '', fg: '#111111', bg: '#040506', cont: true },
});
setLayers([{ name: 'outside special brush', type: 'cell', visible: true, cells: {} }]);
selection.set(new Set());
paintSpecialBrushPath([{ x: 0, y: 0 }, { x: -2, y: 0 }], 'single');
eq('special-brush-paints-past-the-canvas-edge-without-a-marquee', get(layers)[0].cells, {
  '0,0': { c: '─', fg: '#e0a458', bg: null },
  '-1,0': { c: '─', fg: '#e0a458', bg: null },
  '-2,0': { c: '─', fg: '#e0a458', bg: null },
});
setLayers([{ name: 'clipped special brush', type: 'cell', visible: true, cells: {} }]);
selection.set(new Set(['2,1', '3,2']));
paintSpecialBrushPath([{ x: 2, y: 0 }, { x: 2, y: 1 }], 'single');
paintSpecialBrushPath([{ x: 2, y: 2 }, { x: 3, y: 2 }], 'single');
eq('selection-clips-cells-without-changing-segment-orientation', get(layers)[0].cells, {
  '2,1': { c: '│', fg: '#e0a458', bg: null },
  '3,2': { c: '─', fg: '#e0a458', bg: null },
});
selection.set(new Set());
setLayers([{ name: 'special brush preview', type: 'cell', visible: true, cells: {} }]);
eq('special-brush-hover-follows-a-vertical-segment',
  previewSpecialBrushGlyph([{ x: 1, y: 0 }, { x: 1, y: 2 }], 1, 2, 'double'), '║');
paintSpecialBrushPath([{ x: 0, y: 0 }, { x: 2, y: 0 }], 'single');
eq('special-brush-hover-resolves-an-existing-corner',
  previewSpecialBrushGlyph([{ x: 2, y: 0 }, { x: 2, y: 1 }], 2, 0, 'single'), '┐');

for (const style of ['single', 'rounded', 'double', 'heavy']) {
  setLayers([{ name: `${style} zero-motion`, type: 'cell', visible: true, cells: {} }]);
  selection.set(new Set());
  activeTool.set('subcell');
  toolOptions.update((options) => ({
    ...options,
    subcell: { ...options.subcell, mode: style },
  }));
  beginStroke();
  setCell(4, 3, { c: 'R', fg: '#ffffff' });
  endStroke();
  undo();
  const beforeRevision = get(authoredRevision);
  const beforeLayers = structuredClone(get(layers));
  beginStroke();
  const painted = paintSpecialBrushPath([
    { x: 2, y: 1 },
    { x: 2, y: 1 },
  ], style);
  const changed = endStroke();
  eq(`${style} semantic brush zero-motion gesture is a complete no-op`, {
    painted,
    changed,
    layers: get(layers),
    layerCount: get(layers).length,
    revision: get(authoredRevision),
    canUndo: get(canUndo),
    canRedo: get(canRedo),
  }, {
    painted: 0,
    changed: false,
    layers: beforeLayers,
    layerCount: 1,
    revision: beforeRevision,
    canUndo: false,
    canRedo: true,
  });
  redo();
  eq(`${style} semantic brush no-op preserves the existing Redo target`,
    getCell(4, 3), { c: 'R', fg: '#ffffff' });
}

setLayers([{ name: 'semantic path movement', type: 'cell', visible: true, cells: {} }]);
selection.set(new Set());
beginStroke();
const outward = paintSpecialBrushPath([{ x: 1, y: 1 }, { x: 2, y: 1 }], 'single');
const returned = paintSpecialBrushPath([{ x: 2, y: 1 }, { x: 1, y: 1 }], 'single');
eq('semantic brush movement that leaves and re-enters its start cell commits normally', {
  outward,
  returned,
  changed: endStroke(),
  cells: get(layers)[0].cells,
}, {
  outward: 2,
  returned: 2,
  changed: true,
  cells: {
    '1,1': { c: '─', fg: '#e0a458', bg: null },
    '2,1': { c: '─', fg: '#e0a458', bg: null },
  },
});

undo();
const cancelledBaseline = structuredClone(get(layers));
beginStroke();
paintSpecialBrushPath([{ x: 1, y: 1 }, { x: 2, y: 1 }], 'single');
cancelStroke();
eq('semantic brush pointer cancellation restores cells and history exactly', {
  layers: get(layers),
  canUndo: get(canUndo),
  canRedo: get(canRedo),
}, {
  layers: cancelledBaseline,
  canUndo: false,
  canRedo: true,
});

for (const [mode, fx, fy] of [['half', 0.5, 0.25], ['quarter', 0.25, 0.25]]) {
  setLayers([{ name: `${mode} click`, type: 'cell', visible: true, cells: {} }]);
  activeTool.set('subcell');
  toolOptions.update((options) => ({
    ...options,
    subcell: { ...options.subcell, mode },
  }));
  beginStroke();
  applyTool(0, 0, {}, 'down', fx, fy);
  const changed = endStroke();
  eq(`${mode} sub-cell brush click remains a one-cell edit`, {
    changed,
    cells: Object.keys(get(layers)[0].cells),
  }, {
    changed: true,
    cells: ['0,0'],
  });
}

setLayers([{ name: 'ordinary brush click', type: 'cell', visible: true, cells: {} }]);
activeTool.set('brush');
activeChar.set('B');
paintColor.set('#123456');
beginStroke();
applyTool(0, 0, {}, 'down');
eq('ordinary cell Brush click remains a one-cell edit', {
  changed: endStroke(),
  cell: getCell(0, 0),
}, {
  changed: true,
  cell: { c: 'B', fg: '#123456', bg: null },
});

const specialLine = { kind: 'line', style: 'special', x0: 1, y0: 2, x1: 7, y1: 6 };
const specialA = constrainDraggedShapeEndpoint(specialLine, 'a', 0, 5);
eq('special-line-handle-a-keeps-handle-b-fixed',
  [specialA.x0, specialA.y0, specialA.x1, specialA.y1], [0, 6, 7, 6]);
const specialB = constrainDraggedShapeEndpoint(specialLine, 'b', 8, 4);
eq('special-line-handle-b-keeps-handle-a-fixed',
  [specialB.x0, specialB.y0, specialB.x1, specialB.y1], [1, 2, 8, 2]);
const slopeLine = { kind: 'line', style: 'slope', x0: 2, y0: 2, x1: 6, y1: 6 };
const slopeA = constrainDraggedShapeEndpoint(slopeLine, 'a', 1, 5);
eq('slope-line-handle-a-keeps-handle-b-fixed',
  [slopeA.x0, slopeA.y0, slopeA.x1, slopeA.y1], [1, 6, 6, 6]);
const slopeB = constrainDraggedShapeEndpoint(slopeLine, 'b', 7, 3);
eq('slope-line-handle-b-keeps-handle-a-fixed',
  [slopeB.x0, slopeB.y0, slopeB.x1, slopeB.y1], [2, 2, 7, 2]);

dims.set({ w: 1, h: 1 });
setLayers([
  { name: 'active glyph', type: 'cell', visible: true, cells: { '0,0': { c: '@', fg: '#112233' } } },
]);
activeTool.set('eyedropper');
paintColor.set('#abcdef');
toolOptions.update((options) => ({
  ...options,
  eyedropper: { ...options.eyedropper, pick: 'color' },
}));
applyTool(0, 0, {}, 'down');
eq('glyph-eyedropper-picks-the-visible-glyph-color', get(paintColor), '#112233');
const blinkOffSample = displayedSampleCell(applyBlinkPhase([[
  { c: '@', fg: '#112233', bg: '#778899', blink: true },
]], false)[0][0], null);
applyTool(0, 0, {}, 'down', 0.5, 0.5, blinkOffSample);
eq('eyedropper-picks-the-displayed-background-during-blink-off', get(paintColor), '#778899');
const rasterSample = displayedSampleCell(null, '#334455');
applyTool(0, 0, {}, 'down', 0.5, 0.5, rasterSample);
eq('eyedropper-picks-a-raster-pixel-when-no-terminal-cell-covers-it', get(paintColor), '#334455');

setLayers([
  { name: 'active background', type: 'background', visible: true, cells: { '0,0': { bg: '#445566' } } },
]);
paintColor.set('#abcdef');
applyTool(0, 0, {}, 'down');
eq('background-eyedropper-picks-the-background-color', get(paintColor), '#445566');

setLayers([{
  name: 'effect mask',
  type: 'effect',
  visible: true,
  effect: { kind: 'brightness', intensity: 0.5 },
  mask: { defaultStrength: 1, cells: { '0,0': { mask: 0.25 } } },
}]);
activeLayerPart.set('mask');
paintColor.set('#abcdef');
applyTool(0, 0, {}, 'down');
eq('effect-mask-eyedropper-picks-luminance', get(paintColor), '#404040');
activeLayerPart.set('layer');

setLayers([{
  name: 'no-op history', type: 'cell', visible: true,
  cells: { '0,0': { c: 'A', fg: '#ffffff' } },
}]);
const revisionBeforeGesture = get(authoredRevision);
beginStroke();
eq('starting-a-gesture-does-not-claim-an-authored-change',
  get(authoredRevision), revisionBeforeGesture);
cancelStroke();
eq('canceling-an-untouched-gesture-keeps-the-authored-revision',
  get(authoredRevision), revisionBeforeGesture);
beginStroke();
setCell(0, 0, { c: 'B', fg: '#ffffff' });
endStroke();
undo();
eq('seeded-no-op-test-has-a-real-redo-target', {
  cell: getCell(0, 0), canUndo: get(canUndo), canRedo: get(canRedo),
}, {
  cell: { c: 'A', fg: '#ffffff' }, canUndo: false, canRedo: true,
});
const noOpGestures = [
  {
    name: 'empty erasure',
    mutate: () => setCell(1, 0, null),
    revisionChanges: false,
  },
  {
    name: 'identical paint',
    mutate: () => setCell(0, 0, { c: 'A', fg: '#ffffff' }),
    revisionChanges: false,
  },
  {
    name: 'round trip',
    mutate: () => {
      setCell(0, 0, { c: 'B', fg: '#ffffff' });
      setCell(0, 0, { c: 'A', fg: '#ffffff' });
    },
    revisionChanges: true,
  },
];
for (const sample of noOpGestures) {
  const beforeRevision = get(authoredRevision);
  beginStroke();
  sample.mutate();
  const changed = endStroke();
  eq(`${sample.name}-preserves-history-and-the-existing-redo-target`, {
    changed,
    cell: getCell(0, 0),
    canUndo: get(canUndo),
    canRedo: get(canRedo),
    revisionChanged: get(authoredRevision) !== beforeRevision,
  }, {
    changed: false,
    cell: { c: 'A', fg: '#ffffff' },
    canUndo: false,
    canRedo: true,
    revisionChanged: sample.revisionChanges,
  });
}
redo();
eq('redo-still-reaches-the-same-authored-target-after-every-no-op',
  getCell(0, 0), { c: 'B', fg: '#ffffff' });
setLayers([{ name: 'recovery signal', type: 'cell', visible: true, cells: {} }]);
beginStroke();
setCell(0, 0, { c: 'A', fg: '#ffffff' });
const firstGestureRevision = get(authoredRevision);
setCell(1, 0, { c: 'B', fg: '#ffffff' });
eq('long-gesture-mutations-keep-publishing-recovery-revisions',
  get(authoredRevision) > firstGestureRevision, true);
endStroke();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
