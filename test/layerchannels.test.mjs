import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import {
  activeLayerId,
  applyBlinkPhase,
  attachVideoSource,
  addGroup,
  addLayer,
  canUndo,
  cellSelection,
  compositeWorld,
  convertImageLayer,
  cropPending,
  dims,
  groupActiveLayer,
  hasVisibleBlinkingGlyph,
  insertConvertedLayerPair,
  layerBox,
  layers,
  mergeCellChannels,
  moveLayerToGap,
  redo,
  removeLayer,
  renameLayer,
  resizeCanvas,
  selectLayer,
  selectLayerWithModifiers,
  selectedLayerIds,
  setEffectProperties,
  setLayerOpacity,
  setLayers,
  setShapeLayerProperties,
  snapshotLayerForConversion,
  toggleLayerBlink,
  toggleLayerVisible,
  undo,
  updateVideoClip,
} from '../src/lib/grid.js';
import {
  copyForPowerShell,
  frameToAnsi,
  frameToTerminalCommand,
  loadJSON,
  serializeJSON,
  videoFrameCells,
} from '../src/lib/fileio.js';
import { compositeFrameCells, setLayerRaster } from '../src/lib/frames.js';
import { renderShapeToCells } from '../src/lib/shapes.js';

const offsetGroup = { id: 90, type: 'group', visible: true, offset: { x: 3, y: -2 } };
const offsetText = {
  id: 91,
  type: 'text',
  visible: true,
  groupId: 90,
  offset: { x: -1, y: 4 },
  box: { x: 5, y: 6, w: 8, h: 2 },
};
assert.deepEqual(layerBox([offsetGroup, offsetText], offsetText), { x: 7, y: 8, w: 8, h: 2 });

resizeCanvas(3, 3, false);
setLayers([{ name: 'Resize', type: 'cell', visible: true, cells: {} }]);
resizeCanvas(3, 3);
assert.equal(get(canUndo), false, 'resizing to the current dimensions is not an edit');
cellSelection.set(new Set(['0,0', '2,2']));
cropPending.set({ x: 1, y: 1, w: 2, h: 2 });
resizeCanvas(2, 2);
assert.deepEqual([...get(cellSelection)], ['0,0'], 'resize drops selected cells outside the canvas');
assert.equal(get(cropPending), null, 'resize clears a stale crop window');
undo();
assert.deepEqual(get(dims), { w: 3, h: 3 });
assert.deepEqual([...get(cellSelection)], ['0,0', '2,2']);
redo();
assert.deepEqual(get(dims), { w: 2, h: 2 });
assert.deepEqual([...get(cellSelection)], ['0,0']);

setLayers([
  { name: 'A', type: 'cell', visible: true, cells: {} },
  { name: 'B', type: 'cell', visible: true, cells: {} },
  { name: 'C', type: 'cell', visible: true, cells: {} },
]);
const rowIds = get(layers).map((layer) => layer.id);
moveLayerToGap(rowIds[0], rowIds[1], false);
assert.equal(get(canUndo), false, 'dropping a layer into its existing gap is not an edit');
assert.deepEqual(get(layers).map((layer) => layer.id), rowIds);
selectLayerWithModifiers(rowIds[1], { ctrlKey: true });
selectLayerWithModifiers(rowIds[2]);
assert.deepEqual([...get(selectedLayerIds)], [rowIds[2]]);

renameLayer(rowIds[2], 'Market Midground');
assert.equal(get(layers).find((layer) => layer.id === rowIds[2]).name, 'Market Midground');
undo();
assert.equal(get(layers).find((layer) => layer.id === rowIds[2]).name, 'C');
redo();
assert.equal(get(layers).find((layer) => layer.id === rowIds[2]).name, 'Market Midground');
const renamedProject = serializeJSON();
loadJSON(renamedProject);
assert.deepEqual(get(layers).map(({ name, type }) => ({ name, type })), [
  { name: 'A', type: 'cell' },
  { name: 'B', type: 'cell' },
  { name: 'Market Midground', type: 'cell' },
]);

setLayers([
  { name: 'empty group', type: 'group', visible: true, cells: {} },
  { name: 'remove target', type: 'cell', visible: true, cells: {} },
  { name: 'replacement candidate', type: 'cell', visible: true, cells: {} },
  { name: 'selected survivor', type: 'cell', visible: true, cells: {} },
]);
const [emptyGroup, removeTarget, replacementCandidate, selectedSurvivor] = get(layers);
selectLayer(selectedSurvivor.id);
selectLayerWithModifiers(emptyGroup.id, { ctrlKey: true });
removeLayer(removeTarget.id);
assert.deepEqual(
  get(layers).map((layer) => layer.id),
  [emptyGroup.id, replacementCandidate.id, selectedSurvivor.id],
  'removing an unrelated row preserves an intentionally empty group',
);
assert.equal(get(activeLayerId), emptyGroup.id);
assert.deepEqual([...get(selectedLayerIds)], [selectedSurvivor.id, emptyGroup.id]);
undo();
assert.deepEqual(get(layers).map((layer) => layer.id), [
  emptyGroup.id,
  removeTarget.id,
  replacementCandidate.id,
  selectedSurvivor.id,
]);
assert.equal(get(activeLayerId), emptyGroup.id);
assert.deepEqual([...get(selectedLayerIds)], [selectedSurvivor.id, emptyGroup.id]);
redo();
assert.deepEqual(get(layers).map((layer) => layer.id), [
  emptyGroup.id,
  replacementCandidate.id,
  selectedSurvivor.id,
]);
assert.equal(get(activeLayerId), emptyGroup.id);
assert.deepEqual([...get(selectedLayerIds)], [selectedSurvivor.id, emptyGroup.id]);

const glyph = { c: '@', fg: '#ff0000' };
const background = { bg: '#001122' };
const glyphLayer = { id: 1, name: 'glyph', type: 'cell', visible: true, cells: { '0,0': glyph } };
const backgroundLayer = {
  id: 2,
  name: 'background',
  type: 'background',
  visible: true,
  cells: { '0,0': background },
};

for (const stack of [[backgroundLayer, glyphLayer], [glyphLayer, backgroundLayer]]) {
  assert.deepEqual(
    compositeWorld(stack, { x: 0, y: 0, w: 1, h: 1 })[0][0],
    { c: '@', fg: '#ff0000', bg: '#001122' },
  );
}

const fractionalOffset = compositeWorld([
  { ...glyphLayer, offset: { x: 0.4, y: 0.5 } },
], { x: 0, y: 0, w: 2, h: 2 });
assert.deepEqual(fractionalOffset, [
  [null, null],
  [{ c: '@', fg: '#ff0000' }, null],
]);

assert.deepEqual(
  mergeCellChannels(
    mergeCellChannels(null, { c: 'A', fg: '#111111' }, glyphLayer),
    { c: 'B', fg: '#eeeeee' },
    glyphLayer,
  ),
  { c: 'B', fg: '#eeeeee' },
);

const opacityLayers = [
  { id: 10, type: 'group', visible: true, opacity: 0.25, cells: {} },
  {
    id: 11,
    type: 'cell',
    visible: true,
    groupId: 10,
    opacity: 0.5,
    cells: { '0,0': { c: 'T', fg: '#ff0000' } },
  },
  { id: 12, type: 'cell', visible: true, cells: { '0,0': { c: 'B', fg: '#0000ff', bg: '#001122' } } },
];
const bakedOpacity = { bg: '#001122', c: 'T', fg: '#800080' };
assert.deepEqual(
  compositeWorld(opacityLayers, { x: 0, y: 0, w: 1, h: 1 })[0][0],
  bakedOpacity,
);
assert.deepEqual(compositeFrameCells({ layers: opacityLayers }, 1, 1)[0][0], bakedOpacity);
assert.equal(
  compositeFrameCells({ layers: opacityLayers }, 1, 1, 0)[0][0]?.c,
  'T',
  'group-only onion compositing includes its child artwork',
);
const terminalOpacity = { bg: '#001122', c: 'T', fg: '#ff0000' };
assert.deepEqual(
  compositeFrameCells(
    { layers: opacityLayers }, 1, 1, null, 0, 0, { referenceOpacity: false },
  )[0][0],
  terminalOpacity,
);
assert.deepEqual(videoFrameCells({ layers: opacityLayers }, 1, 1)[0][0], terminalOpacity);

const blinkLayers = [
  {
    id: 20,
    type: 'cell',
    visible: true,
    blink: true,
    cells: { '0,0': { c: 'X', fg: '#ffffff', bg: '#123456' } },
  },
  {
    id: 21,
    type: 'cell',
    visible: true,
    cells: { '0,0': { c: 'O', fg: '#abcdef' } },
  },
];
assert.deepEqual(
  compositeWorld(blinkLayers, { x: 0, y: 0, w: 1, h: 1 })[0][0],
  { c: 'X', fg: '#ffffff', bg: '#123456', blink: true },
);
const compositedBlink = compositeWorld(blinkLayers, { x: 0, y: 0, w: 1, h: 1 });
assert.deepEqual(applyBlinkPhase(compositedBlink, false)[0][0], { bg: '#123456' });
assert.deepEqual(compositedBlink[0][0], {
  c: 'X', fg: '#ffffff', bg: '#123456', blink: true,
});
const wideBlinkFrame = {
  layers: [
    {
      id: 24,
      type: 'cell',
      visible: true,
      blink: true,
      cells: {
        '0,0': { c: '界', fg: '#ffffff' },
        '1,0': { c: '', cont: true },
      },
    },
    {
      id: 25,
      type: 'background',
      visible: true,
      cells: {
        '0,0': { bg: '#112233' },
        '1,0': { bg: '#aabbcc' },
      },
    },
  ],
};
assert.deepEqual(
  videoFrameCells(wideBlinkFrame, 2, 1, 0.75),
  [[{ bg: '#112233' }, { bg: '#112233' }]],
  'blink-off video frames preserve the terminal-wide leader background',
);

const offCanvasBlinkLayers = [
  { id: 30, type: 'group', visible: true, offset: { x: -1, y: 0 }, cells: {} },
  {
    id: 31,
    type: 'cell',
    visible: true,
    groupId: 30,
    blink: true,
    cells: { '0,0': { c: 'X', fg: '#ffffff', bg: '#123456' } },
  },
];
const offCanvasBlink = compositeWorld(
  offCanvasBlinkLayers,
  { x: -1, y: 0, w: 1, h: 1 },
  { x: 0, y: 0, w: 1, h: 1 },
);
assert.equal(hasVisibleBlinkingGlyph(offCanvasBlinkLayers), true);
assert.deepEqual(offCanvasBlink[0][0], {
  c: 'X', fg: '#ffffff', bg: '#123456', blink: true, offCanvas: true,
});
assert.deepEqual(applyBlinkPhase(offCanvasBlink, false)[0][0], {
  bg: '#123456', offCanvas: true,
});
assert.equal(
  hasVisibleBlinkingGlyph([
    { ...offCanvasBlinkLayers[0], visible: false },
    offCanvasBlinkLayers[1],
  ]),
  false,
);

assert.deepEqual(
  compositeWorld([
    { type: 'background', visible: true, opacity: 0.5, cells: { '0,0': { bg: '#ff0000' } } },
    { type: 'cell', visible: true, cells: { '0,0': { c: 'B', fg: '#0000ff' } } },
  ], { x: 0, y: 0, w: 1, h: 1 })[0][0],
  { c: 'B', fg: '#0000ff', bg: '#800000' },
);

const backgroundShape = renderShapeToCells({
  kind: 'rect',
  style: 'filled',
  detail: 'cell',
  channel: 'background',
  char: '#',
  fg: '#334455',
  x0: 0,
  y0: 0,
  x1: 1,
  y1: 1,
});
assert.deepEqual(
  Object.fromEntries(Object.entries(backgroundShape).sort()),
  {
    '0,0': { c: '', fg: null, bg: '#334455' },
    '0,1': { c: '', fg: null, bg: '#334455' },
    '1,0': { c: '', fg: null, bg: '#334455' },
    '1,1': { c: '', fg: null, bg: '#334455' },
  },
);

const doubleBox = renderShapeToCells({
  kind: 'rect',
  style: 'special',
  boxStyle: 'double',
  detail: 'cell',
  channel: 'glyph',
  char: '#',
  fg: '#ffffff',
  x0: 3,
  y0: 2,
  x1: 0,
  y1: 0,
});
const doubleBoxRows = Array.from({ length: 3 }, (_, y) =>
  Array.from({ length: 4 }, (_, x) => doubleBox[`${x},${y}`]?.c || '.').join(''));
assert.deepEqual(doubleBoxRows, ['╔══╗', '║..║', '╚══╝']);

setLayers([{ name: 'only', type: 'cell', visible: true, cells: {} }]);
removeLayer(get(activeLayerId));
assert.deepEqual({ count: get(layers).length, active: get(activeLayerId) }, { count: 0, active: null });
undo();
assert.equal(get(layers).length, 1);
redo();
assert.deepEqual({ count: get(layers).length, active: get(activeLayerId) }, { count: 0, active: null });
addLayer('background');
assert.deepEqual({
  count: get(layers).length,
  type: get(layers)[0].type,
  name: get(layers)[0].name,
  selected: get(activeLayerId) === get(layers)[0].id,
}, { count: 1, type: 'background', name: 'Layer 1', selected: true });

setLayers([
  { name: 'Layer 7', type: 'cell', visible: true, cells: {} },
  { name: 'Imported logo', type: 'image', visible: true, cells: {} },
]);
addLayer('background');
removeLayer(get(activeLayerId));
addLayer('cell');
assert.equal(get(layers)[0].name, 'Layer 9');

groupActiveLayer();
assert.equal(get(layers)[0].name, 'Group 1');
assert.equal(get(layers)[1].groupId, get(layers)[0].id);
const firstGeneratedGroup = get(layers)[0];
addLayer('cell');
assert.deepEqual(
  get(layers).slice(0, 3).map((layer) => [layer.name, layer.groupId ?? null]),
  [
    ['Group 1', null],
    ['Layer 10', firstGeneratedGroup.id],
    ['Layer 9', firstGeneratedGroup.id],
  ],
);
const originalGroupedChild = get(layers)[2];
selectLayer(originalGroupedChild.id);
addLayer('background');
assert.deepEqual(
  get(layers).slice(0, 4).map((layer) => [layer.name, layer.type, layer.groupId ?? null]),
  [
    ['Group 1', 'group', null],
    ['Layer 10', 'cell', firstGeneratedGroup.id],
    ['Layer 11', 'background', firstGeneratedGroup.id],
    ['Layer 9', 'cell', firstGeneratedGroup.id],
  ],
);

setLayers([
  { name: 'top', type: 'cell', visible: true, cells: {} },
  { name: 'middle', type: 'cell', visible: true, cells: {} },
  { name: 'bottom', type: 'cell', visible: true, cells: {} },
]);
selectLayer(get(layers)[1].id);
addLayer('cell');
assert.deepEqual(
  get(layers).map((layer) => layer.name),
  ['top', 'Layer 1', 'middle', 'bottom'],
);

setLayers([
  { name: 'group member', type: 'cell', visible: true, cells: {} },
  { name: 'outside survivor', type: 'cell', visible: true, cells: {} },
]);
const groupedForDelete = get(layers)[0];
const outsideForDelete = get(layers)[1];
selectLayer(groupedForDelete.id);
groupActiveLayer();
const deleteGroupId = get(activeLayerId);
removeLayer(deleteGroupId);
assert.deepEqual(
  get(layers).map((layer) => layer.id),
  [outsideForDelete.id],
  'deleting a group deletes its contents rather than silently ungrouping them',
);
undo();
assert.deepEqual(
  get(layers).map((layer) => [layer.type, layer.name]),
  [['group', 'Group 1'], ['cell', 'group member'], ['cell', 'outside survivor']],
);

setLayers([{ name: 'Layer 1', type: 'cell', visible: true, cells: {} }]);
addGroup();
assert.deepEqual(
  get(layers).map((layer) => [layer.name, layer.type, layer.groupId ?? null]),
  [['Group 1', 'group', null], ['Layer 1', 'cell', null]],
);

setLayers([
  { name: 'top', type: 'cell', visible: true, cells: {} },
  { name: 'middle', type: 'cell', visible: true, cells: {} },
  { name: 'bottom', type: 'cell', visible: true, cells: {} },
]);
selectLayer(get(layers)[1].id);
addGroup();
assert.deepEqual(get(layers).map((layer) => layer.name), ['top', 'Group 1', 'middle', 'bottom']);

// An Undo branch restores visible naming state without reusing object IDs.
setLayers([]);
addLayer('cell');
const undoneGeneratedLayer = get(layers)[0];
undo();
addLayer('cell');
assert.equal(get(layers)[0].name, 'Layer 1');
assert.notEqual(get(layers)[0].id, undoneGeneratedLayer.id);

setLayers([]);
addGroup();
const undoneGeneratedGroup = get(layers)[0];
undo();
addGroup();
assert.equal(get(layers)[0].name, 'Group 1');
assert.notEqual(get(layers)[0].id, undoneGeneratedGroup.id);

setLayers([
  { name: 'Group 1', type: 'group', visible: true, collapsed: true, cells: {} },
  { name: 'hidden child', type: 'cell', visible: true, cells: {} },
  { name: 'outside', type: 'cell', visible: true, cells: {} },
]);
let [collapsedGroup, hiddenChild, outsideLayer] = get(layers);
hiddenChild = { ...hiddenChild, groupId: collapsedGroup.id };
layers.set([collapsedGroup, hiddenChild, outsideLayer]);
selectLayer(hiddenChild.id);
selectLayerWithModifiers(outsideLayer.id, { shiftKey: true });
assert.deepEqual([...get(selectedLayerIds)], [collapsedGroup.id, outsideLayer.id]);

setLayers([{
  name: 'reference',
  type: 'video',
  visible: true,
  cells: {},
  videoClip: { sourceName: 'long.mp4', startTick: 0, inPoint: 8, duration: 10 },
}]);
const referenceId = get(activeLayerId);
assert.equal(attachVideoSource(referenceId, 'short.mp4', {
  element: {}, raster: {}, url: 'blob:short', duration: 2, width: 640, height: 480,
}), true);
assert.deepEqual(get(layers)[0].videoClip, {
  sourceName: 'long.mp4', startTick: 0, inPoint: 1.999999, outPoint: 2,
  playbackRate: 1, duration: 2, width: 640, height: 480,
});
undo();
assert.deepEqual(get(layers)[0].videoClip, {
  sourceName: 'long.mp4', startTick: 0, inPoint: 8, outPoint: 10,
  playbackRate: 1, duration: 10, width: 0, height: 0,
});

setLayers([{
  name: 'trimmed reference',
  type: 'video',
  visible: true,
  cells: {},
  videoClip: {
    sourceName: 'original.mp4', startTick: 0, inPoint: 1, outPoint: 8,
    playbackRate: 0.5, duration: 10,
  },
}]);
assert.equal(attachVideoSource(get(activeLayerId), 'replacement.mp4', {
  element: {}, raster: {}, url: 'blob:replacement', duration: 6, width: 1280, height: 720,
}), true);
assert.deepEqual(get(layers)[0].videoClip, {
  sourceName: 'original.mp4', startTick: 0, inPoint: 1, outPoint: 6,
  playbackRate: 0.5, duration: 6, width: 1280, height: 720,
});

setLayers([{
  name: 'sized reference',
  type: 'video',
  visible: true,
  cells: {},
  raster: { width: 640, height: 360 },
  transform: { x: 12, y: 9, scale: 0.5, rot: 15 },
  videoClip: {
    sourceName: 'original.mp4', startTick: 0, inPoint: 0, outPoint: 4,
    playbackRate: 1, duration: 4, width: 640, height: 360,
  },
}]);
assert.equal(attachVideoSource(get(activeLayerId), 'different-size.mp4', {
  element: {}, raster: { width: 1280, height: 180 }, url: 'blob:different',
  duration: 4, width: 1280, height: 180,
}), true);
assert.deepEqual(get(layers)[0].transform, {
  x: 12, y: 9, scale: 0.5, scaleX: 0.25, scaleY: 1, rot: 15,
});

assert.equal('videoElement' in get(layers)[0], false,
  'durable video edits do not retain decoded elements in layer history');
assert.equal('videoURL' in get(layers)[0], false,
  'durable video edits do not retain object URLs in layer history');

setLayers([{
  name: 'reference',
  type: 'video',
  visible: true,
  cells: {},
  videoClip: { sourceName: 'same.mp4', startTick: 0, inPoint: 0, duration: 2 },
}]);
assert.equal(updateVideoClip(get(activeLayerId), { startTick: 0, inPoint: 0 }), false);
assert.equal(get(canUndo), false);

setLayers([{
  name: 'Layer 1', type: 'cell', visible: true, opacity: 0.5, cells: {},
}]);
const unchangedLayerId = get(activeLayerId);
assert.equal(renameLayer(unchangedLayerId, 'Layer 1'), false);
assert.equal(setLayerOpacity(unchangedLayerId, 0.5), false);
assert.equal(setLayerOpacity(unchangedLayerId, Number.NaN), false);
assert.equal(toggleLayerBlink(-1), false);
assert.equal(toggleLayerVisible(-1), false);
assert.equal(get(canUndo), false, 'unchanged and invalid layer edits do not create undo entries');

setLayers([{
  name: 'effect', type: 'effect', visible: true, cells: {},
  effect: { kind: 'contrast', intensity: 0.25 },
}]);
assert.equal(setEffectProperties(get(activeLayerId), { kind: 'contrast', intensity: 0.25 }), false);
assert.equal(get(canUndo), false, 'unchanged effect properties do not create an undo entry');

setLayers([{
  name: 'shape', type: 'shape', visible: true, cells: {},
  shape: { kind: 'rect', x0: 0, y0: 0, x1: 2, y1: 2, style: 'outline' },
}]);
assert.equal(
  setShapeLayerProperties(get(activeLayerId), { style: 'outline' }, () => {
    throw new Error('an unchanged shape should not be rendered');
  }),
  false,
);
assert.equal(get(canUndo), false, 'unchanged shape properties do not create an undo entry');

setLayers([
  { name: 'Layer 7', type: 'cell', visible: true, cells: {} },
  { name: 'Group 3', type: 'group', visible: true, cells: {} },
]);
addLayer('cell');
assert.equal(get(layers)[0].name, 'Layer 8');
groupActiveLayer();
assert.equal(get(layers)[0].name, 'Group 4');

const originalDocumentForConversion = globalThis.document;
const conversionTranslations = [];
const conversionOperations = [];
globalThis.document = {
  createElement() {
    const context = {
      save() { conversionOperations.push(['save']); },
      scale(x, y) { conversionOperations.push(['scale', x, y]); },
      translate(x, y) {
        conversionTranslations.push([x, y]);
        conversionOperations.push(['translate', x, y]);
      },
      rotate(angle) { conversionOperations.push(['rotate', angle]); },
      drawImage(source, x, y) {
        conversionOperations.push(['draw', x, y, source.width, source.height]);
      },
      restore() { conversionOperations.push(['restore']); },
      imageSmoothingEnabled: false,
    };
    return { width: 0, height: 0, getContext: () => context };
  },
};
try {
  resizeCanvas(13, 7, false);
  setLayers([{
    name: 'Imported logo',
    type: 'image',
    visible: true,
    raster: { width: 1, height: 1 },
    transform: { x: 0, y: 0, scale: 1, rot: 0 },
  }]);
  const sourceId = get(layers)[0].id;
  const sourceLayer = get(layers)[0];
  const snapshot = snapshotLayerForConversion(sourceId);
  assert.ok(snapshot);
  assert.deepEqual([snapshot.width, snapshot.height], [104, 112]);
  assert.equal(get(layers)[0], sourceLayer, 'preview snapshot does not replace the source layer');
  assert.equal(get(canUndo), false, 'preview snapshot does not create history');
  const converted = {
    foreground: { '0,0': { c: '@', fg: '#abcdef', bg: null } },
    background: { '0,0': { c: '', fg: null, bg: '#123456' } },
    meta: { mode: 'glyph' },
  };
  assert.deepEqual(insertConvertedLayerPair(sourceId, converted), converted.meta);
  assert.deepEqual(
    get(layers).slice(0, 3).map((layer) => [layer.name, layer.type]),
    [['Group 1', 'group'], ['Layer 1', 'cell'], ['Layer 2', 'background']],
  );
  assert.equal(get(layers)[3].id, sourceLayer.id, 'conversion keeps the source layer');
  assert.equal(get(layers)[3].raster, sourceLayer.raster);
  assert.equal(get(layers)[3].visible, false, 'the generated pair is the visible result');
  assert.deepEqual(get(layers)[1].cells, converted.foreground);
  assert.deepEqual(get(layers)[2].cells, converted.background);
  undo();
  assert.equal(get(layers).length, 1, 'one undo removes the complete converted pair');
  assert.equal(get(layers)[0].id, sourceLayer.id);
  assert.equal(get(layers)[0].raster, sourceLayer.raster,
    'Undo preserves a still-current decoded runtime without storing it durably');
  setLayerRaster(sourceId, sourceLayer.raster);
  convertImageLayer(sourceId, () => ({ foreground: {}, background: {} }));
  assert.deepEqual(get(layers).slice(0, 3).map((layer) => layer.type),
    ['group', 'cell', 'background']);

  setLayers([
    { name: 'Group 8', type: 'group', visible: true, cells: {} },
    {
      name: 'Grouped image',
      type: 'image',
      visible: true,
      raster: { width: 1, height: 1 },
      transform: { x: 0, y: 0, scale: 1, rot: 0 },
    },
  ]);
  const groupedHeader = get(layers)[0];
  const groupedSource = get(layers)[1];
  layers.update((items) => items.map((layer) => (
    layer.id === groupedHeader.id
      ? { ...layer, offset: { x: 2, y: 3 } }
      : layer.id === groupedSource.id
        ? {
            ...layer,
            groupId: groupedHeader.id,
            offset: { x: 4, y: 5 },
            transform: { ...layer.transform, x: 7, y: 11 },
          }
        : layer
  )));
  snapshotLayerForConversion(groupedSource.id);
  assert.deepEqual(
    conversionTranslations.at(-1),
    [13, 38],
    'conversion samples the same layer and group position shown on canvas',
  );
  assert.deepEqual(
    conversionOperations.slice(-7),
    [
      ['save'],
      ['scale', 8, 8],
      ['translate', 13, 38],
      ['rotate', 0],
      ['scale', 1, 1],
      ['draw', -0.5, -0.5, 1, 1],
      ['restore'],
    ],
    'conversion applies sampling, world placement, media transform, and raster draw in canvas order',
  );
  insertConvertedLayerPair(groupedSource.id, converted);
  assert.deepEqual(get(layers).map((layer) => layer.type),
    ['group', 'cell', 'background', 'group', 'image']);
  assert.equal(get(layers)[4].groupId, groupedHeader.id);
  assert.equal(get(layers)[4].visible, false);

  setLayers([]);
  assert.equal(insertConvertedLayerPair(sourceId, converted), null);
  assert.deepEqual(get(layers), []);
  assert.equal(get(canUndo), false, 'a deleted source cannot commit a stale preview');
} finally {
  globalThis.document = originalDocumentForConversion;
}

resizeCanvas(1, 1, false);
setLayers([{ type: 'cell', visible: true, opacity: 0, cells: { '0,0': { c: 'A', fg: '#ff0000' } } }]);
assert.equal(
  frameToTerminalCommand(),
  "printf '%b' '\\033[38;2;255;0;0mA\\033[0m\\n'",
);

resizeCanvas(3, 1, false);
setLayers([
  { type: 'background', visible: true, cells: { '0,0': { bg: '#040506' } } },
  {
    type: 'cell',
    visible: true,
    blink: true,
    cells: {
      '0,0': { c: 'A', fg: '#010203' },
      '1,0': { c: '界', fg: '#070809' },
      '2,0': { c: '', fg: null, cont: true },
    },
  },
]);
const escape = '\x1b';
assert.equal(
  frameToAnsi(),
  `${escape}[5m${escape}[38;2;1;2;3m${escape}[48;2;4;5;6mA`
    + `${escape}[0m${escape}[5m${escape}[38;2;7;8;9m界${escape}[0m\n`,
);
assert.equal(
  frameToTerminalCommand(),
  "printf '%b' '\\033[5m\\033[38;2;1;2;3m\\033[48;2;4;5;6mA"
    + "\\033[0m\\033[5m\\033[38;2;7;8;9m界\\033[0m\\n'",
);

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let copiedPowerShell = '';
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async (value) => { copiedPowerShell = value; } } },
});
try {
  assert.equal(await copyForPowerShell(), true);
  assert.equal(
    copiedPowerShell,
    '& { $e=[char]27; Write-Host -NoNewline "$e[5m$e[38;2;1;2;3m$e[48;2;4;5;6mA'
      + '$e[0m$e[5m$e[38;2;7;8;9m界$e[0m`n" }',
  );
} finally {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
}

console.log('layer channels: passed');
