import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import * as F from '../src/lib/frames.ts';
import * as G from '../src/lib/grid.ts';
import {
  applyRasterBodyDrag as applyEditorRasterBodyDrag,
  captureRasterBodyDrag as captureEditorRasterBodyDrag,
  rasterBodyDelta as editorRasterBodyDelta,
} from '../src/lib/rasterBodyDrag.ts';
import {
  planTimelinePositionEdit as planEditorTimelinePositionEdit,
  rasterDisplayGeometry as editorRasterDisplayGeometry,
  rasterLayerSourceSize as editorRasterLayerSourceSize,
  rasterScaleFromDrag,
  renderedRasterPosition as renderedEditorRasterPosition,
  timelinePositionEditor as editorTimelinePositionEditor,
} from '../src/lib/layerPosition.ts';
import type {
  EditorImageLayer,
  EditorLayer,
  EditorLayerTransform,
  EditorPoint,
  EditorVideoLayer,
} from '../src/lib/types/editor-domain.ts';

type RasterFixture = object;
type RasterDrag = NonNullable<ReturnType<typeof captureEditorRasterBodyDrag>>;
type PositionEdit = NonNullable<ReturnType<typeof planEditorTimelinePositionEdit>> & {
  items: EditorLayer[];
  value: EditorPoint;
};

const setEditorLayers = G.setLayers;
function setLayers(definitions: unknown[]): void {
  setEditorLayers(definitions as Parameters<typeof setEditorLayers>[0]);
}

function rasterLayerSourceSize(layer: RasterFixture): { width: number; height: number } {
  return editorRasterLayerSourceSize(layer as EditorImageLayer | EditorVideoLayer)!;
}

function rasterDisplayGeometry(
  items: RasterFixture[],
  layer: RasterFixture,
  size: { w: number; h: number },
): NonNullable<ReturnType<typeof editorRasterDisplayGeometry>> {
  return editorRasterDisplayGeometry(
    items as EditorLayer[],
    layer as EditorImageLayer | EditorVideoLayer,
    size,
  )!;
}

function timelinePositionEditor(
  items: RasterFixture[],
  layer: RasterFixture | null,
  animated: boolean,
  size: { w: number; h: number },
): NonNullable<ReturnType<typeof editorTimelinePositionEditor>> {
  return editorTimelinePositionEditor(items as EditorLayer[], layer as EditorLayer, animated, size);
}

function planTimelinePositionEdit(
  items: RasterFixture[],
  layerId: string,
  animated: boolean,
  value: EditorPoint,
  size: { w: number; h: number },
): PositionEdit {
  return planEditorTimelinePositionEdit(
    items as EditorLayer[],
    layerId,
    animated,
    value,
    size,
  ) as PositionEdit;
}

function renderedRasterPosition(
  items: RasterFixture[],
  layer: RasterFixture,
  size: { w: number; h: number },
): EditorPoint {
  return renderedEditorRasterPosition(
    items as EditorLayer[],
    layer as EditorImageLayer | EditorVideoLayer,
    size,
  );
}

function captureRasterBodyDrag(layerId: string): RasterDrag {
  return captureEditorRasterBodyDrag(layerId)!;
}

function applyRasterBodyDrag(
  drag: RasterDrag,
  frame: number,
  dx: number,
  dy: number,
): boolean {
  return applyEditorRasterBodyDrag(drag, frame, dx, dy);
}

function rasterBodyDelta(
  drag: RasterDrag | null,
  dx: number,
  dy: number,
  snap?: { w: number; h: number },
): NonNullable<ReturnType<typeof editorRasterBodyDelta>> {
  return editorRasterBodyDelta(drag, dx, dy, snap)!;
}

function currentLayer(index = 0): EditorLayer {
  return get(G.layers)[index]!;
}

function currentRasterLayer(index = 0): EditorImageLayer | EditorVideoLayer {
  return currentLayer(index) as EditorImageLayer | EditorVideoLayer;
}

function activeId(): string {
  return get(G.activeLayerId)!;
}

assert.deepEqual(
  rasterScaleFromDrag({ x: 2, y: 3 }, { x: 10, y: 20 }, { x: 15, y: 20 }, 'x'),
  { x: 3, y: 4.5 },
  'a side handle scales both axes proportionally by default',
);
assert.deepEqual(
  rasterScaleFromDrag({ x: 2, y: 3 }, { x: 10, y: 20 }, { x: 15, y: 20 }, 'x', true),
  { x: 3, y: 3 },
  'Shift makes a side handle scale only its own axis',
);
assert.deepEqual(
  rasterScaleFromDrag(
    { x: 2, y: 3 },
    { x: 10, y: 20 },
    { x: 20, y: 10 },
    'both' as unknown as 'x',
    true,
  ),
  { x: 4, y: 1.5 },
  'Shift makes a corner handle scale both axes freely',
);

function positionValues(layerId: string) {
  return F.positionKeys(layerId).map(({ frame, x, y }) => ({ frame, x, y }));
}

function rasterDocument(
  type: 'image' | 'video',
  transform: Partial<EditorLayerTransform> = {},
): string {
  G.dims.set({ w: 40, h: 20 });
  setLayers([{
    name: type === 'video' ? 'Castle reference' : 'Castle still',
    type,
    visible: true,
    cells: {},
    raster: { width: 12, height: 8 },
    transform: { x: 12, y: 7, scaleX: 1.25, scaleY: 0.75, rot: 17, ...transform },
    ...(type === 'video'
      ? { videoClip: { startTick: 0, inPoint: 0, duration: 10 } }
      : {}),
  }]);
  F.initTimeline(get(G.layers));
  return activeId();
}

const editorGroup = {
  id: 'group', name: 'Group', type: 'group', offset: { x: 3, y: -2 },
};
const editorImage = {
  id: 'image', name: 'Still', type: 'image', groupId: editorGroup.id,
  offset: { x: 2, y: 1 },
  transform: { x: 12.5, y: 7.25, scaleX: 1.25, scaleY: 0.75, rot: 17 },
};
const editorVideo = {
  id: 'video', name: 'Reference', type: 'video', offset: { x: -1, y: 2 },
  transform: { x: 6, y: 4, scale: 0.5, rot: -8 },
  videoClip: { startTick: 0, inPoint: 0, duration: 10 },
};
const editorCell = {
  id: 'cell', name: 'Cells', type: 'cell', offset: { x: 4, y: 5 }, cells: {},
};
const editorLayers = [editorGroup, editorImage, editorVideo, editorCell];
const editorSize = { w: 40, h: 20 };

const missingVideo = {
  ...editorVideo,
  groupId: editorGroup.id,
  opacity: 0.35,
  raster: null,
  videoClip: { ...editorVideo.videoClip, width: 320, height: 180 },
};
assert.deepEqual(rasterLayerSourceSize(missingVideo), { width: 320, height: 180 });
assert.deepEqual(rasterDisplayGeometry(editorLayers, missingVideo, editorSize), {
  x: 8,
  y: 4,
  width: 160,
  height: 45,
  scaleX: 0.5,
  scaleY: 0.5,
  rot: -8,
  opacity: 0.35,
}, 'an offline video derives the same pose and opacity from its persisted source metadata');
assert.deepEqual(rasterDisplayGeometry(editorLayers, {
  ...missingVideo,
  raster: { width: 320, height: 180 },
}, editorSize), rasterDisplayGeometry(editorLayers, missingVideo, editorSize),
  'relinking an equal-sized video source leaves its display geometry unchanged');
assert.deepEqual(rasterLayerSourceSize({
  ...missingVideo,
  raster: { width: 640, height: 360 },
}), { width: 320, height: 180 },
  'a video gizmo follows persisted clip dimensions rather than a stale decoded frame');
assert.equal(rasterLayerSourceSize({
  ...missingVideo,
  videoClip: { ...missingVideo.videoClip, width: 0, height: 0 },
}), null, 'a missing video without saved dimensions cannot expose a transform gizmo');

assert.deepEqual(timelinePositionEditor(editorLayers, editorImage, false, editorSize), {
  editable: true,
  mode: 'raster-transform',
  value: { x: 17.5, y: 6.25 },
}, 'an unkeyed grouped image exposes its rendered document position');
assert.deepEqual(timelinePositionEditor(editorLayers, editorVideo, false, editorSize), {
  editable: true,
  mode: 'raster-transform',
  value: { x: 5, y: 6 },
}, 'an unkeyed video exposes its rendered document position');
assert.deepEqual(timelinePositionEditor(editorLayers, editorImage, true, editorSize), {
  editable: true,
  mode: 'offset-track',
  value: { x: 17.5, y: 6.25 },
}, 'enabling image animation preserves the rendered document coordinates');
assert.deepEqual(timelinePositionEditor(editorLayers, editorVideo, true, editorSize), {
  editable: true,
  mode: 'offset-track',
  value: { x: 5, y: 6 },
}, 'enabling video animation preserves the rendered document coordinates');
assert.deepEqual(timelinePositionEditor(editorLayers, editorGroup, false, editorSize), {
  editable: false,
  mode: 'offset-track',
  value: { x: 3, y: -2 },
}, 'a static group does not gain an unrelated base-position editor');
assert.deepEqual(timelinePositionEditor(editorLayers, editorCell, false, editorSize), {
  editable: false,
  mode: 'offset-track',
  value: { x: 4, y: 5 },
}, 'a static cell layer keeps the existing disabled offset controls');

const staticImageEdit = planTimelinePositionEdit(
  editorLayers, editorImage.id, false, { x: 20.5, y: 10.25 }, editorSize,
);
const editedImage = staticImageEdit.items.find((layer) => layer.id === editorImage.id)! as EditorImageLayer;
assert.equal(staticImageEdit.mode, 'raster-transform');
assert.deepEqual(editedImage.transform, {
  x: 15.5, y: 11.25, scaleX: 1.25, scaleY: 0.75, rot: 17,
}, 'editing static Position changes only the image base center');
assert.deepEqual(
  renderedRasterPosition(staticImageEdit.items, editedImage, editorSize),
  { x: 20.5, y: 10.25 },
  'the edited coordinates equal the image position rendered through its group and offset',
);
assert.deepEqual(editorImage.transform, {
  x: 12.5, y: 7.25, scaleX: 1.25, scaleY: 0.75, rot: 17,
}, 'planning a position edit does not mutate the current layer stack');

const staticVideoEdit = planTimelinePositionEdit(
  editorLayers, editorVideo.id, false, { x: 13.5, y: 8.5 }, editorSize,
);
const editedVideo = staticVideoEdit.items.find((layer) => layer.id === editorVideo.id)! as EditorVideoLayer;
assert.deepEqual(editedVideo.transform, {
  x: 14.5, y: 6.5, scale: 0.5, rot: -8,
}, 'editing static Position changes only the video base center');
assert.deepEqual(
  renderedRasterPosition(staticVideoEdit.items, editedVideo, editorSize),
  { x: 13.5, y: 8.5 },
  'the edited coordinates equal the ungrouped video position on the canvas',
);

assert.deepEqual(
  planTimelinePositionEdit(editorLayers, editorImage.id, true, { x: 20.6, y: 3.3 }, editorSize),
  { mode: 'offset-track', value: { x: 5, y: -2 } },
  'a grouped image converts document coordinates to whole-cell offset keys',
);
assert.deepEqual(
  planTimelinePositionEdit(editorLayers, editorVideo.id, true, { x: 9, y: 1 }, editorSize),
  { mode: 'offset-track', value: { x: 3, y: -3 } },
  'a video converts document coordinates to whole-cell offset keys',
);
assert.deepEqual(
  planTimelinePositionEdit(editorLayers, editorGroup.id, true, { x: -3.6, y: 7.2 }, editorSize),
  { mode: 'offset-track', value: { x: -4, y: 7 } },
  'keyed group edits retain offset-track semantics',
);
assert.deepEqual(
  planTimelinePositionEdit(editorLayers, editorCell.id, true, { x: 8.4, y: 9.6 }, editorSize),
  { mode: 'offset-track', value: { x: 8, y: 10 } },
  'keyed cell edits retain offset-track semantics',
);
assert.equal(planTimelinePositionEdit(
  editorLayers, editorGroup.id, false, { x: 0, y: 0 }, editorSize,
), null);
assert.equal(planTimelinePositionEdit(
  editorLayers, editorCell.id, false, { x: 0, y: 0 }, editorSize,
), null);

setLayers([
  { name: 'Cells', type: 'cell', visible: true, cells: {} },
  { name: 'Still', type: 'image', visible: true, cells: {} },
  { name: 'Reference', type: 'video', visible: true, cells: {} },
]);
F.initTimeline(get(G.layers));
const guardLayers = get(G.layers);
assert.equal(captureRasterBodyDrag(guardLayers[0]!.id), null);
assert.equal(captureRasterBodyDrag(guardLayers[1]!.id)?.layerType, 'image');
assert.equal(captureRasterBodyDrag(guardLayers[2]!.id)?.layerType, 'video');
assert.equal(captureRasterBodyDrag(-1 as unknown as string), null);

const staticId = rasterDocument('image');
const staticDrag = captureRasterBodyDrag(staticId);
const staticTransform = structuredClone(currentRasterLayer().transform);
G.beginStroke();
assert.equal(applyRasterBodyDrag(staticDrag, 0, -2.5, 3), true);
G.endStroke();
assert.deepEqual(currentRasterLayer().transform, {
  ...staticTransform,
  x: staticTransform.x - 2.5,
  y: staticTransform.y + 3,
}, 'a static image drag changes only its base transform position');
assert.deepEqual(positionValues(staticId), []);
G.undo();
assert.deepEqual(currentRasterLayer().transform, staticTransform);
G.redo();
assert.equal(currentRasterLayer().transform.x, staticTransform.x - 2.5);

const animatedVideoId = rasterDocument('video');
F.addFrame();
F.addFrame();
F.gotoFrame(0);
const animatedVideoBefore = timelinePositionEditor(
  get(G.layers), G.getLayer(animatedVideoId), false, get(G.dims),
);
F.togglePosKey(animatedVideoId, 0);
assert.deepEqual(
  timelinePositionEditor(get(G.layers), G.getLayer(animatedVideoId), true, get(G.dims)).value,
  animatedVideoBefore.value,
  'turning on Position animation does not numerically jump',
);
const absoluteEdit = planTimelinePositionEdit(
  get(G.layers), animatedVideoId, true, { x: 17, y: 4 }, get(G.dims),
);
G.beginStroke();
F.setLayerOffsetById(0, animatedVideoId, absoluteEdit.value);
G.endStroke();
assert.deepEqual((G.getLayer(animatedVideoId) as EditorVideoLayer).transform, {
  x: 12, y: 7, scaleX: 1.25, scaleY: 0.75, rot: 17,
}, 'editing animated Position preserves the raster base transform');
assert.deepEqual(
  timelinePositionEditor(get(G.layers), G.getLayer(animatedVideoId), true, get(G.dims)).value,
  { x: 17, y: 4 },
  'the edited animated coordinates equal the rendered document position',
);
G.undo();
assert.deepEqual(positionValues(animatedVideoId), [
  { frame: 0, x: 0, y: 0 },
], 'one Undo restores the original Position key');
assert.deepEqual(
  timelinePositionEditor(get(G.layers), G.getLayer(animatedVideoId), true, get(G.dims)).value,
  animatedVideoBefore.value,
  'Undo restores the original rendered coordinates without disabling animation',
);
const laterAbsoluteEdit = planTimelinePositionEdit(
  get(G.layers), animatedVideoId, true, { x: 20, y: 11 }, get(G.dims),
);
assert.deepEqual(laterAbsoluteEdit.value, { x: 8, y: 4 });
F.setLayerOffsetById(2, animatedVideoId, laterAbsoluteEdit.value);
F.gotoFrame(1);
assert.deepEqual(
  timelinePositionEditor(get(G.layers), G.getLayer(animatedVideoId), true, get(G.dims)).value,
  { x: 16, y: 9 },
  'an absolute-coordinate edit produces visible interpolation at the next frame',
);
const animatedVideoDrag = captureRasterBodyDrag(animatedVideoId);
assert.deepEqual(animatedVideoDrag.offset, { x: 4, y: 2 });
const animatedVideoTransform = structuredClone(currentRasterLayer().transform);

G.beginStroke();
applyRasterBodyDrag(animatedVideoDrag, 1, 3, -1);
applyRasterBodyDrag(animatedVideoDrag, 1, 0, 0);
assert.equal(G.cancelStroke(), true);
assert.deepEqual(currentRasterLayer().transform, animatedVideoTransform,
  'cancelling a keyed video drag restores the transform exactly');
assert.deepEqual(positionValues(animatedVideoId), [
  { frame: 0, x: 0, y: 0 },
  { frame: 2, x: 8, y: 4 },
], 'cancelling a keyed video drag leaves no active-frame position key');

G.beginStroke();
assert.equal(applyRasterBodyDrag(animatedVideoDrag, 1, 3, -1), true);
G.endStroke();
assert.deepEqual(currentRasterLayer().transform, animatedVideoTransform,
  'a keyed video drag preserves scale, rotation, and base position');
assert.deepEqual(positionValues(animatedVideoId), [
  { frame: 0, x: 0, y: 0 },
  { frame: 1, x: 7, y: 1 },
  { frame: 2, x: 8, y: 4 },
], 'a keyed video drag changes only the active frame position');

F.gotoFrame(0);
assert.deepEqual(currentRasterLayer().offset, { x: 0, y: 0 });
F.gotoFrame(2);
assert.deepEqual(currentRasterLayer().offset, { x: 8, y: 4 });
assert.deepEqual(currentRasterLayer().transform, animatedVideoTransform);

G.undo();
assert.deepEqual(positionValues(animatedVideoId), [
  { frame: 0, x: 0, y: 0 },
  { frame: 2, x: 8, y: 4 },
], 'one Undo removes the complete video body drag');
G.redo();
assert.equal(positionValues(animatedVideoId).some((key) =>
  key.frame === 1 && key.x === 7 && key.y === 1), true,
  'one Redo restores the complete video body drag');

G.dims.set({ w: 40, h: 20 });
setLayers([
  { name: 'Group', type: 'group', visible: true, cells: {} },
  {
    name: 'Grouped still', type: 'image', visible: true, cells: {},
    raster: { width: 12, height: 8 },
    transform: { x: 12, y: 7, scale: 1, rot: 0 },
  },
]);
let group = currentLayer();
let groupedImage = currentRasterLayer(1);
G.layers.update((items) => items.map((layer) =>
  layer.id === groupedImage.id ? { ...layer, groupId: group.id } : layer));
F.initTimeline(get(G.layers));
F.togglePosKey(group.id, 0);
F.setLayerOffsetById(0, group.id, { x: 3, y: -2 });
F.togglePosKey(groupedImage.id, 0);
F.setLayerOffsetById(0, groupedImage.id, { x: 2, y: 1 });
groupedImage = G.getLayer(groupedImage.id) as EditorImageLayer;
const groupedDrag = captureRasterBodyDrag(groupedImage.id);
assert.deepEqual(groupedDrag.visibleCenter, { x: 17, y: 6 });
assert.deepEqual(groupedDrag.visibleHalfExtent, { x: 6, y: 2 });
assert.deepEqual(rasterBodyDelta(groupedDrag, 2.6, 3.6, { w: 40, h: 20 }), {
  dx: 3,
  dy: 4,
  guides: { x: 20, y: 10 },
}, 'center snapping is calculated from the rendered gizmo center');
const unsnapped = rasterBodyDelta(groupedDrag, 2.6, 3.6);
assert.ok(Math.abs(unsnapped.dx - 2.6) < 1e-9 && Math.abs(unsnapped.dy - 3.6) < 1e-9,
  'holding the snap bypass keeps the raw pointer delta');
assert.deepEqual(unsnapped.guides, { x: null, y: null });
assert.deepEqual(rasterBodyDelta(groupedDrag, -10.6, -3.6, { w: 40, h: 20 }), {
  dx: -11,
  dy: -4,
  guides: { x: 0, y: 0 },
}, 'the rendered left and top edges snap to the canvas edges');
assert.deepEqual(rasterBodyDelta(groupedDrag, 16.6, 11.6, { w: 40, h: 20 }), {
  dx: 17,
  dy: 12,
  guides: { x: 40, y: 20 },
}, 'the rendered right and bottom edges snap to the canvas edges');
G.beginStroke();
applyRasterBodyDrag(groupedDrag, 0, 3, 4);
G.endStroke();
group = G.getLayer(group.id)!;
groupedImage = G.getLayer(groupedImage.id) as EditorImageLayer;
assert.deepEqual(groupedImage.transform, { x: 12, y: 7, scale: 1, rot: 0 });
assert.deepEqual(groupedImage.offset, { x: 5, y: 5 });
assert.deepEqual({
  x: groupedImage.transform.x + group.offset!.x + groupedImage.offset!.x,
  y: groupedImage.transform.y + group.offset!.y + groupedImage.offset!.y,
}, { x: 20, y: 10 }, 'snapping does not apply group or layer offsets twice');

const staleDrag = captureRasterBodyDrag(groupedImage.id);
G.layers.update((items) => items.map((layer) =>
  layer.id === groupedImage.id ? { ...layer, type: 'cell' } : layer));
assert.equal(applyRasterBodyDrag(staleDrag, 0, 1, 1), false,
  'a stale raster drag cannot mutate a layer that changed type');
assert.equal(rasterBodyDelta(null, 1, 1), null);
assert.equal(applyRasterBodyDrag(staleDrag, 0, Number.NaN, 1), false);

console.log('raster body drag tests passed');
