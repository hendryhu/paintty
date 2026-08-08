import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import * as F from '../src/lib/frames.js';
import * as G from '../src/lib/grid.js';
import {
  applyShapeBodyDrag,
  applyShapeGeometryEdit,
  blankShapeLayerAcceptsKind,
  captureShapeBodyDrag,
  shapeDirectEditEnabled,
} from '../src/lib/shapeBodyDrag.js';
import {
  editShapePathField,
  pathValueFromShape,
  shapePathComponentValue,
  shapeWithPathValue,
  translateShapePathKey,
  withShapePathComponentValue,
} from '../src/lib/shapePath.js';
import { shapeForAnchorComponentEdit } from '../src/lib/shapePathEditing.js';
import { shapeTransformHandles, transformShapeFromCageHandle } from '../src/lib/shapeTransform.js';
import { regularPolygonVertices, renderShapeToCells, resolvedShapeVertices } from '../src/lib/shapes.js';
import { getClipTimelineState } from '../src/lib/clipTimelineState.js';

const shape = {
  kind: 'rect', x0: 2, y0: 2, x1: 6, y1: 5,
  style: 'outline', detail: 'cell', channel: 'glyph',
  char: '#', fg: '#ffffff',
};

function shapeDocument(shapeValue = shape) {
  G.setLayers([{
    name: 'Castle wall',
    type: 'shape',
    visible: true,
    opacity: 1,
    shape: structuredClone(shapeValue),
    cells: renderShapeToCells(shapeValue),
  }]);
  F.initTimeline(get(G.layers));
  return get(G.activeLayerId);
}

function compensationKeyCount(layerId) {
  const state = getClipTimelineState();
  const track = state.tracks.find((candidate) => candidate.layer?.id === layerId);
  return state.clips.filter((clip) => clip.trackId === track?.id)
    .reduce((count, clip) =>
      count + (clip.propertyTracks?.shapeAnchorCompensation?.length || 0), 0);
}

assert.equal(shapeDirectEditEnabled('move', false), true);
for (const kind of ['line', 'rect', 'circle', 'polygon']) {
  assert.equal(shapeDirectEditEnabled(kind, false, kind), true,
    kind + ' must expose its newly created shape handles immediately');
}
for (const tool of ['brush', 'text', 'select', 'circle']) {
  assert.equal(shapeDirectEditEnabled(tool, false), false,
    tool + ' must not expose shape handles that intercept its canvas gesture');
}
assert.equal(shapeDirectEditEnabled('circle', false, 'rect'), false,
  'a different creation tool must remain available for drawing');
assert.equal(shapeDirectEditEnabled('move', true), false);

const blankShapeLayer = { type: 'shape', shape: null };
assert.equal(blankShapeLayerAcceptsKind(blankShapeLayer, true, 'rect', 'rect'), true,
  'a blank Path-enabled shape layer accepts its existing procedural kind');
assert.equal(blankShapeLayerAcceptsKind(blankShapeLayer, true, 'rect', 'circle'), false,
  'a different shape kind must route to a new layer instead of rewriting the Path track');
assert.equal(blankShapeLayerAcceptsKind(blankShapeLayer, false, null, 'circle'), true,
  'a blank shape layer without Path animation accepts a new procedural kind');
assert.equal(blankShapeLayerAcceptsKind({ ...blankShapeLayer, shape }, true, 'rect', 'rect'), false,
  'an occupied shape layer is never reused as a blank target');
for (const kind of ['line', 'rect', 'circle', 'polygon']) {
  assert.equal(blankShapeLayerAcceptsKind(blankShapeLayer, false, null, kind, true), true,
    `${kind}: a present active blank shape cel can be authored`);
  assert.equal(blankShapeLayerAcceptsKind(null, false, null, kind, false), false,
    `${kind}: an absent owner cannot receive hidden shape data`);
  assert.equal(blankShapeLayerAcceptsKind({ ...blankShapeLayer, visible: false }, false, null, kind, true), false,
    `${kind}: a hidden owner cannot receive shape data`);
  assert.equal(blankShapeLayerAcceptsKind({ type: 'cell', visible: true, shape: null }, false, null, kind, true), false,
    `${kind}: another layer type cannot receive shape data`);
  assert.equal(blankShapeLayerAcceptsKind(blankShapeLayer, false, null, kind, false), false,
    `${kind}: a timeline gap cannot reuse its blank resolved owner`);
}

function gapShape(kind) {
  if (kind === 'polygon') {
    return {
      ...shape,
      kind,
      sides: 4,
      vertices: regularPolygonVertices(shape.x0, shape.y0, shape.x1, shape.y1, 4),
    };
  }
  return { ...shape, kind };
}

for (const kind of ['line', 'rect', 'circle', 'polygon']) {
  const ownerId = shapeDocument(shape);
  const before = getClipTimelineState();
  const ownerTrack = before.tracks.find((track) => track.layer?.id === ownerId);
  const ownerClip = before.clips.find((clip) => clip.trackId === ownerTrack.id);
  F.moveClip(ownerClip.id, 5);
  F.seekTick(0);
  const gapOwner = get(G.layers).find((layer) => layer.id === ownerId);
  assert.equal(gapOwner?.shape, null, `${kind}: moved clip resolves as a blank gap owner`);
  assert.equal(blankShapeLayerAcceptsKind(gapOwner, false, null, kind, false), false);

  const createdId = G.createShapeLayer(gapShape(kind), renderShapeToCells);
  F.commitLayersToActiveFrame();
  const after = getClipTimelineState();
  const createdTrack = after.tracks.find((track) => track.layer?.id === createdId);
  const createdClip = after.clips.find((clip) => clip.trackId === createdTrack?.id);
  const retainedOwnerClip = after.clips.find((clip) => clip.id === ownerClip.id);
  assert.notEqual(createdId, ownerId, `${kind}: gap drawing allocates a new shape layer`);
  assert.ok(createdTrack, `${kind}: gap drawing allocates a new shape track`);
  assert.equal(createdClip?.startTick, 0, `${kind}: gap drawing allocates a clip at the playhead`);
  assert.equal(retainedOwnerClip?.startTick, 5, `${kind}: the moved selected clip remains untouched`);
}

const staticPolygon = {
  kind: 'polygon', x0: 2, y0: 1, x1: 12, y1: 9, sides: 5,
  vertices: regularPolygonVertices(2, 1, 12, 9, 5),
  anchor: { x: 7, y: 5 }, rotation: 0,
  style: 'outline', detail: 'cell', channel: 'glyph',
  char: '#', fg: '#ffffff', thickness: 1, strokeAlign: 'center',
};
const staticPolygonId = shapeDocument(staticPolygon);
const staticPolygonBeforeDrag = structuredClone(get(G.layers)[0].shape);
assert.equal(F.isShapePathTrackEnabled(staticPolygonId), false,
  'a selected static polygon does not require Path animation');
const staticPolygonHandles = shapeTransformHandles(get(G.layers)[0].shape);
assert.equal(staticPolygonHandles.filter((handle) => handle.type === 'vertex').length, 5,
  'Move exposes every existing static polygon vertex');
const firstStaticHandle = staticPolygonHandles.find((handle) => handle.id === 'vertex:0');
const editedStaticPolygon = transformShapeFromCageHandle(
  get(G.layers)[0].shape,
  firstStaticHandle.id,
  { x: firstStaticHandle.x + 2, y: firstStaticHandle.y + 1 },
);
G.beginStroke();
assert.equal(applyShapeGeometryEdit(
  staticPolygonId,
  0,
  editedStaticPolygon,
  staticPolygonBeforeDrag,
), true);
G.endStroke();
assert.notDeepEqual(get(G.layers)[0].shape.vertices, staticPolygon.vertices);
assert.equal(get(G.layers)[0].shape.vertices.length, staticPolygon.sides);
assert.equal(get(G.layers)[0].shape.vertices.every(({ x, y }) =>
  Number.isFinite(x) && Number.isFinite(y)), true,
'dragging a static polygon vertex retains safe finite geometry and side semantics');
G.undo();
assert.deepEqual(get(G.layers)[0].shape, staticPolygonBeforeDrag,
  'one Undo restores the complete static polygon handle drag');
G.redo();
assert.deepEqual(get(G.layers)[0].shape.vertices, editedStaticPolygon.vertices);

const animatedId = shapeDocument();
F.addFrame();
F.addFrame();
F.togglePosKey(animatedId, 0);
F.setLayerOffsetById(2, animatedId, { x: 6, y: 0 });
F.gotoFrame(1);
const localCells = structuredClone(get(G.layers)[0].cells);
const animatedDrag = captureShapeBodyDrag(animatedId, 1);
assert.deepEqual(animatedDrag.offset, { x: 3, y: 0 });

G.beginStroke();
applyShapeBodyDrag(animatedDrag, 1, 2, 1);
applyShapeBodyDrag(animatedDrag, 1, 0, 0);
assert.deepEqual(get(G.layers)[0].offset, { x: 3, y: 0 },
  'returning to the pointer origin restores the starting pose');
G.cancelStroke();
assert.equal(F.positionKeys(animatedId).some((key) => key.frame === 1), false,
  'cancelling an away-and-back gesture leaves no position key');

G.beginStroke();
assert.equal(applyShapeBodyDrag(animatedDrag, 1, 2, 1), true);
G.endStroke();

assert.deepEqual(get(G.layers)[0].shape, shape,
  'dragging a keyed shape body must not rewrite its shared shape geometry');
assert.deepEqual(get(G.layers)[0].cells, localCells,
  'dragging a keyed shape body must leave local shape cells unchanged');
assert.deepEqual(F.positionKeys(animatedId).map(({ frame, x, y }) => ({ frame, x, y })), [
  { frame: 0, x: 0, y: 0 },
  { frame: 1, x: 5, y: 1 },
  { frame: 2, x: 6, y: 0 },
], 'the gesture authors only the active frame position');

F.gotoFrame(0);
assert.deepEqual(get(G.layers)[0].shape, shape);
assert.deepEqual(get(G.layers)[0].offset, { x: 0, y: 0 });
F.gotoFrame(2);
assert.deepEqual(get(G.layers)[0].shape, shape);
assert.deepEqual(get(G.layers)[0].offset, { x: 6, y: 0 });

G.undo();
assert.deepEqual(F.positionKeys(animatedId).map(({ frame, x, y }) => ({ frame, x, y })), [
  { frame: 0, x: 0, y: 0 },
  { frame: 2, x: 6, y: 0 },
], 'one undo removes only the body-drag position key');
assert.deepEqual(get(G.layers)[0].shape, shape);
G.redo();
assert.equal(F.positionKeys(animatedId).some((key) =>
  key.frame === 1 && key.x === 5 && key.y === 1), true);

const pathAnimatedId = shapeDocument();
F.addFrame();
F.addFrame();
F.gotoFrame(0);
F.setShapePathTrackEnabled(pathAnimatedId, true);
F.setShapePathById(2, pathAnimatedId, {
  kind: 'rect', cx: 12, cy: 8, w: 5, h: 4,
});
F.gotoFrame(1);
const pathDrag = captureShapeBodyDrag(pathAnimatedId, 1);

G.beginStroke();
assert.equal(applyShapeBodyDrag(pathDrag, 1, 2, -1), true);
G.endStroke();
assert.deepEqual(F.shapePathAt(pathAnimatedId, 1), {
  kind: 'rect', cx: 10, cy: 4.75, w: 5, h: 4,
}, 'a Path-animated body drag translates center without changing size');
assert.deepEqual(F.shapePathKeys(pathAnimatedId).map((key) => key.frame), [0, 1, 2]);

const resizedPathStartShape = { ...get(G.layers)[0].shape };
const resizedPathShape = {
  ...resizedPathStartShape,
  x1: resizedPathStartShape.x1 + 2,
};
G.beginStroke();
assert.equal(applyShapeGeometryEdit(
  pathAnimatedId,
  1,
  resizedPathShape,
  resizedPathStartShape,
), true);
G.endStroke();
assert.deepEqual(F.shapePathAt(pathAnimatedId, 1), {
  kind: 'rect', cx: 11, cy: 4.75, w: 7, h: 4,
}, 'a handle edit changes one Path axis without drifting the other');

F.togglePosKey(pathAnimatedId, 1);
const positionPriorityDrag = captureShapeBodyDrag(pathAnimatedId, 1);
const pathBeforePositionDrag = F.shapePathAt(pathAnimatedId, 1);
G.beginStroke();
assert.equal(applyShapeBodyDrag(positionPriorityDrag, 1, 3, 2), true);
G.endStroke();
assert.deepEqual(F.shapePathAt(pathAnimatedId, 1), pathBeforePositionDrag,
  'Position animation takes priority over Path when both tracks are enabled');
assert.deepEqual(get(G.layers)[0].offset, { x: 3, y: 2 });

const evenPathId = shapeDocument();
F.addFrame();
F.setShapePathTrackEnabled(evenPathId, true);
F.setShapePathById(1, evenPathId, {
  kind: 'rect', cx: 8, cy: 5, w: 4, h: 4,
});
F.gotoFrame(1);
assert.equal((get(G.layers)[0].shape.x0 + get(G.layers)[0].shape.x1) / 2, 8.5,
  'the rendered inclusive bounds expose the half-cell snap this regression exercises');
const evenPathDrag = captureShapeBodyDrag(evenPathId, 1);
G.beginStroke();
assert.equal(applyShapeBodyDrag(evenPathDrag, 1, 1, 0), true);
G.endStroke();
assert.equal(F.shapePathAt(evenPathId, 1).cx, 9,
  'an even-width Path key moved by one cell advances its authored center by exactly one');

const componentShape = {
  ...shape,
  vertices: [
    { x: 2, y: 2 },
    { x: 6, y: 1.5 },
    { x: 6.5, y: 5 },
    { x: 2, y: 5 },
  ],
  anchor: { x: 4.25, y: 3.25 },
  rotation: 12,
};
const componentAnimatedId = shapeDocument(componentShape);
F.addFrame();
F.addFrame();
F.gotoFrame(0);
F.setShapePathComponentTrackEnabled(componentAnimatedId, 'vertex:0', true);
F.setShapePathComponentValues(2, componentAnimatedId, [{
  componentId: 'vertex:0',
  value: { x: 4, y: 1 },
}]);
const componentPathsBeforeDrag = [0, 1, 2].map((frame) =>
  F.shapePathAt(componentAnimatedId, frame));
const componentKeysBeforeDrag = F.shapePathComponentKeys(
  componentAnimatedId,
  'vertex:0',
);
const translatedComponentPaths = componentPathsBeforeDrag.map((path) => ({
  ...path,
  cx: path.cx + 3,
  cy: path.cy - 1,
  vertices: path.vertices.map(({ x, y }) => ({ x: x + 3, y: y - 1 })),
  anchor: { x: path.anchor.x + 3, y: path.anchor.y - 1 },
}));
const translatedComponentKeys = componentKeysBeforeDrag.map((key) => ({
  ...key,
  value: { x: key.value.x + 3, y: key.value.y - 1 },
}));
F.gotoFrame(1);
const componentReturnDrag = captureShapeBodyDrag(componentAnimatedId, 1);
G.beginStroke();
assert.equal(applyShapeBodyDrag(componentReturnDrag, 1, 2, 1), true);
assert.equal(applyShapeBodyDrag(componentReturnDrag, 1, 0, 0), true);
assert.deepEqual([0, 1, 2].map((frame) =>
  F.shapePathAt(componentAnimatedId, frame)), componentPathsBeforeDrag,
'returning to the pointer origin restores every component curve');
G.cancelStroke();
const componentDrag = captureShapeBodyDrag(componentAnimatedId, 1);

G.beginStroke();
assert.equal(applyShapeBodyDrag(componentDrag, 1, 1, -1), true);
assert.equal(applyShapeBodyDrag(componentDrag, 1, 3, -1), true);
G.endStroke();

assert.deepEqual([0, 1, 2].map((frame) =>
  F.shapePathAt(componentAnimatedId, frame)), translatedComponentPaths,
'a static whole-shape drag translates every animated and disabled component rigidly');
assert.deepEqual(F.shapePathComponentKeys(
  componentAnimatedId,
  'vertex:0'), translatedComponentKeys,
'the independently animated vertex curve translates without changing its timing');
assert.deepEqual(F.positionKeys(componentAnimatedId), [],
'Position-off movement must not silently create a Position key');
for (const frame of [0, 1, 2]) {
  F.gotoFrame(frame);
  assert.deepEqual(F.shapePathAt(componentAnimatedId, frame),
    translatedComponentPaths[frame],
    `the rigid component geometry must not jump when scrubbing to frame ${frame}`);
  assert.deepEqual(get(G.layers)[0].offset, { x: 0, y: 0 },
    'static shape movement remains separate from Position');
}

G.undo();
assert.deepEqual(F.positionKeys(componentAnimatedId), [],
  'Undo does not leave a synthetic Position key behind');
assert.deepEqual([0, 1, 2].map((frame) =>
  F.shapePathAt(componentAnimatedId, frame)), componentPathsBeforeDrag,
'one Undo restores every geometry component to its pre-drag curve');
assert.deepEqual(F.shapePathComponentKeys(
  componentAnimatedId,
  'vertex:0'), componentKeysBeforeDrag,
'Undo restores all component key values and timing');
G.redo();
assert.deepEqual([0, 1, 2].map((frame) =>
  F.shapePathAt(componentAnimatedId, frame)), translatedComponentPaths,
'one Redo restores the global rigid translation');
const translatedTimeline = structuredClone(F.canonicalTimelineStateForSave());
F.loadCanonicalTimeline(translatedTimeline);
const recoveredComponentId = get(G.activeLayerId);
assert.deepEqual([0, 1, 2].map((frame) =>
  F.shapePathAt(recoveredComponentId, frame)), translatedComponentPaths,
'the rigid translation survives a sparse timeline recovery');
assert.deepEqual(F.shapePathComponentKeys(
  recoveredComponentId,
  'vertex:0'), translatedComponentKeys,
'recovery preserves translated component keys and their timing');
assert.deepEqual(F.positionKeys(recoveredComponentId), [],
'recovery does not invent Position animation');

const positionedComponentId = shapeDocument(componentShape);
F.addFrame();
F.addFrame();
F.gotoFrame(0);
F.setShapePathComponentTrackEnabled(positionedComponentId, 'vertex:0', true);
F.setShapePathComponentValues(2, positionedComponentId, [{
  componentId: 'vertex:0',
  value: { x: 4, y: 1 },
}]);
F.togglePosKey(positionedComponentId, 0);
F.setLayerOffsetById(2, positionedComponentId, { x: 6, y: 0 });
const positionedComponentPaths = [0, 1, 2].map((frame) =>
  F.shapePathAt(positionedComponentId, frame));
const positionedComponentKeys = F.shapePathComponentKeys(
  positionedComponentId,
  'vertex:0',
);
F.gotoFrame(1);
const positionedComponentDrag = captureShapeBodyDrag(positionedComponentId, 1);
G.beginStroke();
assert.equal(applyShapeBodyDrag(positionedComponentDrag, 1, 2, 1), true);
G.endStroke();
assert.deepEqual([0, 1, 2].map((frame) =>
  F.shapePathAt(positionedComponentId, frame)), positionedComponentPaths,
'Position-on movement leaves the complete component geometry untouched');
assert.deepEqual(F.shapePathComponentKeys(
  positionedComponentId,
  'vertex:0'), positionedComponentKeys,
'Position-on movement leaves the component animation curve untouched');
assert.deepEqual(F.positionKeys(positionedComponentId).map(
  ({ frame, x, y }) => ({ frame, x, y }),
), [
  { frame: 0, x: 0, y: 0 },
  { frame: 1, x: 5, y: 1 },
  { frame: 2, x: 6, y: 0 },
], 'Position-on movement changes only the active-frame Position pose');
G.undo();
assert.deepEqual(F.positionKeys(positionedComponentId).map(
  ({ frame, x, y }) => ({ frame, x, y }),
), [
  { frame: 0, x: 0, y: 0 },
  { frame: 2, x: 6, y: 0 },
], 'one Undo removes only the active-frame Position edit');
assert.deepEqual(F.shapePathComponentKeys(
  positionedComponentId,
  'vertex:0'), positionedComponentKeys,
'undoing a Position drag does not alter the component curve');

const mixedPathId = shapeDocument(componentShape);
F.addFrame();
F.addFrame();
F.gotoFrame(0);
F.setShapePathTrackEnabled(mixedPathId, true);
F.setShapePathById(2, mixedPathId, translateShapePathKey(
  F.shapePathAt(mixedPathId, 0),
  4,
  2,
));
F.setShapePathComponentTrackEnabled(mixedPathId, 'vertex:0', true);
F.setShapePathComponentValues(2, mixedPathId, [{
  componentId: 'vertex:0',
  value: { x: 8, y: 2 },
}]);
F.gotoFrame(1);
const mixedPathBeforeHandle = F.shapePathAt(mixedPathId, 1);
const mixedWholeKeysBeforeHandle = F.shapePathWholeKeys(mixedPathId);
const mixedComponentKeysBeforeHandle = F.shapePathComponentKeys(
  mixedPathId,
  'vertex:0',
);
const vertexOne = shapePathComponentValue(mixedPathBeforeHandle, 'vertex:1');
const handlePath = withShapePathComponentValue(
  mixedPathBeforeHandle,
  'vertex:1',
  { x: vertexOne.x + 3, y: vertexOne.y - 1 },
);
const mixedHandleStart = get(G.layers)[0].shape;
const mixedHandleShape = shapeWithPathValue(mixedHandleStart, handlePath);

G.beginStroke();
assert.equal(applyShapeGeometryEdit(
  mixedPathId,
  1,
  mixedHandleShape,
  mixedHandleStart,
), true);
G.endStroke();
assert.deepEqual(
  shapePathComponentValue(F.shapePathAt(mixedPathId, 1), 'vertex:1'),
  { x: vertexOne.x + 3, y: vertexOne.y - 1 },
  'a disabled handle component edits the visible whole-Path pose',
);
assert.deepEqual(
  F.shapePathComponentKeys(mixedPathId, 'vertex:0'),
  mixedComponentKeysBeforeHandle,
  'editing a disabled handle leaves the independently animated component curve intact',
);
assert.deepEqual(
  F.shapePathWholeKeys(mixedPathId).map(({ frame }) => frame),
  [0, 1, 2],
  'a disabled handle component authors an active-frame whole-Path key',
);
G.undo();
assert.deepEqual(F.shapePathAt(mixedPathId, 1), mixedPathBeforeHandle,
  'one Undo restores the mixed whole-Path pose after a handle edit');
assert.deepEqual(F.shapePathWholeKeys(mixedPathId), mixedWholeKeysBeforeHandle);
assert.deepEqual(
  F.shapePathComponentKeys(mixedPathId, 'vertex:0'),
  mixedComponentKeysBeforeHandle,
);

const anchorPathBefore = F.shapePathAt(mixedPathId, 1);
const anchorShapeBefore = shapeWithPathValue(
  get(G.layers)[0].shape,
  anchorPathBefore,
);
const anchorTarget = {
  x: anchorPathBefore.anchor.x + 3,
  y: anchorPathBefore.anchor.y - 2,
};
const anchorShapeAfter = shapeForAnchorComponentEdit(
  anchorShapeBefore,
  anchorPathBefore,
  anchorTarget,
);
const authoredAnchorTarget = pathValueFromShape(anchorShapeAfter).anchor;
const visibleBeforeAnchor = resolvedShapeVertices(anchorShapeBefore);
const wholeKeysBeforeAnchor = F.shapePathWholeKeys(mixedPathId);
const componentKeysBeforeAnchor = F.shapePathComponentKeys(
  mixedPathId,
  'vertex:0',
);
G.beginStroke();
assert.equal(applyShapeGeometryEdit(
  mixedPathId,
  1,
  anchorShapeAfter,
  anchorShapeBefore,
), true);
G.endStroke();
const anchorPathAfter = F.shapePathAt(mixedPathId, 1);
assert.deepEqual(anchorPathAfter.anchor, authoredAnchorTarget,
  'numeric anchor editing reaches the mixed whole-Path pose');
resolvedShapeVertices(
  shapeWithPathValue(get(G.layers)[0].shape, anchorPathAfter),
).forEach((point, index) => {
  assert.ok(Math.abs(point.x - visibleBeforeAnchor[index].x) < 1e-9);
  assert.ok(Math.abs(point.y - visibleBeforeAnchor[index].y) < 1e-9);
});
G.undo();
assert.deepEqual(F.shapePathAt(mixedPathId, 1), anchorPathBefore,
  'one Undo restores both whole-Path and component changes from an anchor edit');
assert.deepEqual(F.shapePathWholeKeys(mixedPathId), wholeKeysBeforeAnchor);
assert.deepEqual(
  F.shapePathComponentKeys(mixedPathId, 'vertex:0'),
  componentKeysBeforeAnchor,
);

const visibleBeforeDisable = F.shapePathAt(mixedPathId, 1);
const componentKeysBeforeDisable = F.shapePathComponentKeys(
  mixedPathId,
  'vertex:0',
);
assert.equal(F.setShapePathComponentTrackEnabled(
  mixedPathId,
  'vertex:0',
  false,
), true);
assert.deepEqual(F.shapePathAt(mixedPathId, 1), visibleBeforeDisable,
  'disabling a component bakes its visible pose into the whole Path without a jump');
assert.equal(F.isShapePathComponentEnabled(mixedPathId, 'vertex:0'), false);
for (const frame of [0, 2]) {
  assert.deepEqual(
    shapePathComponentValue(F.shapePathAt(mixedPathId, frame), 'vertex:0'),
    shapePathComponentValue(visibleBeforeDisable, 'vertex:0'),
    'the disabled component becomes one static whole-Path value',
  );
}
G.undo();
assert.equal(F.isShapePathComponentEnabled(mixedPathId, 'vertex:0'), true,
  'one Undo restores the disabled component track');
assert.deepEqual(F.shapePathAt(mixedPathId, 1), visibleBeforeDisable);
assert.deepEqual(
  F.shapePathComponentKeys(mixedPathId, 'vertex:0'),
  componentKeysBeforeDisable,
);

const ordinaryLine = {
  kind: 'line', x0: 2, y0: 3, x1: 9, y1: 6,
  style: 'outline', detail: 'cell', channel: 'glyph',
  char: '#', fg: '#ffffff',
};
const horizontalLine = {
  ...ordinaryLine,
  x0: 4,
  y0: 8,
  x1: 12,
  y1: 8,
};
const endpointDragId = shapeDocument(horizontalLine);
assert.equal(F.setShapePathComponentTrackEnabled(
  endpointDragId,
  'vertex:0',
  true,
), true);
const endpointPathBefore = F.shapePathAt(endpointDragId, 0);
const endpointStartBefore = shapePathComponentValue(endpointPathBefore, 'vertex:0');
const endpointEndBefore = shapePathComponentValue(endpointPathBefore, 'vertex:1');
const endpointShapeBefore = shapeWithPathValue(horizontalLine, endpointPathBefore);
const endpointShapeAfter = transformShapeFromCageHandle(
  endpointShapeBefore,
  'vertex:0',
  {
    x: endpointStartBefore.x + 1,
    y: endpointStartBefore.y - 2,
  },
);
G.beginStroke();
assert.equal(applyShapeGeometryEdit(
  endpointDragId,
  0,
  endpointShapeAfter,
  endpointShapeBefore,
), true);
G.endStroke();
const endpointPathAfter = F.shapePathAt(endpointDragId, 0);
assert.deepEqual(
  shapePathComponentValue(endpointPathAfter, 'vertex:0'),
  { x: endpointStartBefore.x + 1, y: endpointStartBefore.y - 2 },
  'dragging an animated horizontal line Start changes both endpoint axes',
);
assert.deepEqual(
  shapePathComponentValue(endpointPathAfter, 'vertex:1'),
  endpointEndBefore,
  'dragging an animated line Start leaves End exact',
);
assert.deepEqual(
  F.shapePathComponentKeys(endpointDragId, 'vertex:0')
    .map(({ frame, value }) => ({ frame, value })),
  [{
    frame: 0,
    value: { x: endpointStartBefore.x + 1, y: endpointStartBefore.y - 2 },
  }],
  'the active Start component track records the complete endpoint pose',
);

const implicitAnchorId = shapeDocument(ordinaryLine);
F.setShapePathComponentTrackEnabled(implicitAnchorId, 'vertex:0', true);
const implicitPathBefore = F.shapePathAt(implicitAnchorId, 0);
const implicitEndBefore = shapePathComponentValue(implicitPathBefore, 'vertex:1');
const implicitMovedPath = withShapePathComponentValue(
  implicitPathBefore,
  'vertex:1',
  { x: implicitEndBefore.x + 2, y: implicitEndBefore.y + 1 },
);
const implicitShapeBefore = shapeWithPathValue(ordinaryLine, implicitPathBefore);
const implicitShapeAfter = shapeWithPathValue(ordinaryLine, implicitMovedPath);
G.beginStroke();
assert.equal(applyShapeGeometryEdit(
  implicitAnchorId,
  0,
  implicitShapeAfter,
  implicitShapeBefore,
), true);
G.endStroke();
const implicitPathAfter = F.shapePathAt(implicitAnchorId, 0);
assert.equal(Object.hasOwn(implicitPathAfter, 'anchor'), false,
  'a direct geometry edit does not author a changing derived anchor');

const derivedAnchor = shapePathComponentValue(implicitPathAfter, 'anchor');
const explicitAnchor = { x: derivedAnchor.x + 1, y: derivedAnchor.y - 1 };
const explicitAnchorPath = withShapePathComponentValue(
  implicitPathAfter,
  'anchor',
  explicitAnchor,
);
G.beginStroke();
assert.equal(applyShapeGeometryEdit(
  implicitAnchorId,
  0,
  shapeWithPathValue(ordinaryLine, explicitAnchorPath),
  shapeWithPathValue(ordinaryLine, implicitPathAfter),
), true);
G.endStroke();
assert.deepEqual(F.shapePathAt(implicitAnchorId, 0).anchor, explicitAnchor,
  'a direct implicit-to-explicit anchor edit remains detectable');

const editedAnchor = { x: explicitAnchor.x + 2, y: explicitAnchor.y + 3 };
const editedAnchorPath = withShapePathComponentValue(
  F.shapePathAt(implicitAnchorId, 0),
  'anchor',
  editedAnchor,
);
G.beginStroke();
assert.equal(applyShapeGeometryEdit(
  implicitAnchorId,
  0,
  shapeWithPathValue(ordinaryLine, editedAnchorPath),
  shapeWithPathValue(ordinaryLine, F.shapePathAt(implicitAnchorId, 0)),
), true);
G.endStroke();
assert.deepEqual(F.shapePathAt(implicitAnchorId, 0).anchor, editedAnchor,
  'a direct explicit anchor edit remains detectable');

const mixedLineId = shapeDocument(ordinaryLine);
F.addFrame();
F.addFrame();
F.gotoFrame(0);
F.setShapePathTrackEnabled(mixedLineId, true);
F.setShapePathById(2, mixedLineId, {
  kind: 'line', x0: 4, y0: 4, x1: 13, y1: 8,
});
F.setShapePathComponentTrackEnabled(mixedLineId, 'vertex:0', true);
F.setShapePathComponentValues(2, mixedLineId, [{
  componentId: 'vertex:0',
  value: { x: 7, y: 5 },
}]);
F.gotoFrame(1);
const mixedLineBefore = F.shapePathAt(mixedLineId, 1);
const mixedLineWholeKeysBefore = F.shapePathWholeKeys(mixedLineId);
const mixedLineStartKeysBefore = F.shapePathComponentKeys(mixedLineId, 'vertex:0');
const mixedLineStartBefore = shapePathComponentValue(mixedLineBefore, 'vertex:0');
const mixedLineEndBefore = shapePathComponentValue(mixedLineBefore, 'vertex:1');
const mixedLineTarget = editShapePathField(
  mixedLineBefore,
  'x0',
  mixedLineStartBefore.x - 2,
);
G.beginStroke();
assert.equal(F.setShapePathById(1, mixedLineId, mixedLineTarget), true);
assert.deepEqual(F.setShapePathComponentValues(
  1,
  mixedLineId,
  [{
    componentId: 'vertex:0',
    value: shapePathComponentValue(mixedLineTarget, 'vertex:0'),
  }],
), ['vertex:0']);
G.endStroke();
const mixedLineAfter = F.shapePathAt(mixedLineId, 1);
assert.deepEqual(shapePathComponentValue(mixedLineAfter, 'vertex:0'), {
  ...mixedLineStartBefore,
  x: mixedLineStartBefore.x - 2,
}, 'whole line Path editing reaches an independently animated visible endpoint');
assert.deepEqual(shapePathComponentValue(mixedLineAfter, 'vertex:1'), mixedLineEndBefore,
  'whole line Path editing leaves the other visible endpoint untouched');
assert.equal(Object.hasOwn(mixedLineAfter, 'anchor'), Object.hasOwn(mixedLineBefore, 'anchor'),
  'ordinary endpoint editing keeps an implicit line anchor implicit');
assert.deepEqual(F.shapePathWholeKeys(mixedLineId).map(({ frame }) => frame), [0, 1, 2],
  'the whole line Path gains its active-frame key');
assert.deepEqual(
  F.shapePathComponentKeys(mixedLineId, 'vertex:0').map(({ frame }) => frame),
  [0, 1, 2],
  'the independently animated endpoint gains the matching active-frame key');
G.undo();
assert.deepEqual(F.shapePathAt(mixedLineId, 1), mixedLineBefore,
  'one Undo restores the line pose before the mixed whole-Path edit');
assert.deepEqual(F.shapePathWholeKeys(mixedLineId), mixedLineWholeKeysBefore);
assert.deepEqual(
  F.shapePathComponentKeys(mixedLineId, 'vertex:0'),
  mixedLineStartKeysBefore,
);

const staticId = shapeDocument();
const staticDrag = captureShapeBodyDrag(staticId, 0);
G.beginStroke();
assert.equal(applyShapeBodyDrag(staticDrag, 0, -1, 2), true);
G.endStroke();
assert.deepEqual(get(G.layers)[0].shape, {
  ...shape, x0: 1, y0: 4, x1: 5, y1: 7,
}, 'a shape without Position animation still moves its base geometry');
assert.deepEqual(F.positionKeys(staticId), []);

let compensatedAnchorId = shapeDocument({
  ...componentShape,
  rotation: 0,
});
for (let frame = 1; frame <= 10; frame++) F.addFrame();
F.gotoFrame(0);
assert.equal(F.setShapePathComponentTrackEnabled(
  compensatedAnchorId,
  'rotation',
  true,
), true);
assert.deepEqual(F.setShapePathComponentValues(10, compensatedAnchorId, [{
  componentId: 'rotation',
  value: 90,
}]), ['rotation']);
assert.equal(F.setShapePathComponentTrackEnabled(
  compensatedAnchorId,
  'anchor',
  true,
), true);
const anchorBaseline = Array.from({ length: 11 }, (_, frame) =>
  resolvedShapeVertices(shapeWithPathValue(
    componentShape,
    F.shapePathAt(compensatedAnchorId, frame),
  )));
const originalAnchorKeys = F.shapePathComponentKeys(compensatedAnchorId, 'anchor');
F.gotoFrame(10);
const lastAnchor = shapePathComponentValue(
  F.shapePathAt(compensatedAnchorId, 10),
  'anchor',
);
assert.deepEqual(F.setShapePathComponentValues(10, compensatedAnchorId, [{
  componentId: 'anchor',
  value: { x: lastAnchor.x + 4, y: lastAnchor.y - 3 },
}]), ['anchor']);
for (let frame = 0; frame <= 10; frame++) {
  const visible = resolvedShapeVertices(shapeWithPathValue(
    componentShape,
    F.shapePathAt(compensatedAnchorId, frame),
  ));
  visible.forEach((point, index) => {
    assert.ok(Math.abs(point.x - anchorBaseline[frame][index].x) < 1e-9,
      `animated anchor compensation preserves vertex ${index} x at frame ${frame}`);
    assert.ok(Math.abs(point.y - anchorBaseline[frame][index].y) < 1e-9,
      `animated anchor compensation preserves vertex ${index} y at frame ${frame}`);
  });
}
for (let index = 0; index < 4; index++) {
  assert.equal(F.isShapePathComponentEnabled(
    compensatedAnchorId,
    `vertex:${index}`,
  ), false, 'generated anchor compensation does not enable a visible vertex track');
  assert.deepEqual(F.shapePathComponentKeys(
    compensatedAnchorId,
    `vertex:${index}`,
  ), [], 'generated anchor compensation does not create visible vertex keys');
}
const compensatedState = structuredClone(F.canonicalTimelineStateForSave());
const compensatedClip = compensatedState.clips.find((clip) =>
  compensatedState.tracks.find((track) => track.id === clip.trackId)?.layer?.id === compensatedAnchorId);
assert.ok((compensatedClip.propertyTracks.shapeAnchorCompensation || []).length > 1,
  'coupled anchor and rotation animation stores one canonical compensation curve');
assert.deepEqual(
  F.dopeRows()[0].shapePathComponentTracks.map(({ id }) => id),
  ['anchor', 'rotation'],
  'generated compensation does not add Timeline component rows',
);
G.undo();
assert.deepEqual(
  F.shapePathComponentKeys(compensatedAnchorId, 'anchor'),
  originalAnchorKeys,
  'one Undo restores the original anchor curve',
);
for (let index = 0; index < 4; index++) {
  assert.equal(F.isShapePathComponentEnabled(
    compensatedAnchorId,
    `vertex:${index}`,
  ), false, 'one Undo leaves vertex tracks ungenerated');
}
assert.equal(
  F.canonicalTimelineStateForSave().clips.some((clip) =>
    clip.propertyTracks?.shapeAnchorCompensation?.length),
  false,
  'one Undo removes the shared anchor compensation track',
);
G.redo();
F.loadCanonicalTimeline(compensatedState);
compensatedAnchorId = get(G.activeLayerId);
for (let frame = 0; frame <= 10; frame++) {
  const visible = resolvedShapeVertices(shapeWithPathValue(
    componentShape,
    F.shapePathAt(compensatedAnchorId, frame),
  ));
  visible.forEach((point, index) => {
    assert.ok(Math.abs(point.x - anchorBaseline[frame][index].x) < 1e-9);
    assert.ok(Math.abs(point.y - anchorBaseline[frame][index].y) < 1e-9);
  });
}
F.gotoFrame(10);
const beforeLaterRotation = F.shapePathAt(compensatedAnchorId, 10);
const expectedLaterRotation = withShapePathComponentValue(
  beforeLaterRotation,
  'rotation',
  180,
);
assert.deepEqual(F.setShapePathComponentValues(10, compensatedAnchorId, [{
  componentId: 'rotation',
  value: 180,
}]), ['rotation']);
const actualLaterRotationVertices = resolvedShapeVertices(shapeWithPathValue(
  componentShape,
  F.shapePathAt(compensatedAnchorId, 10),
));
const expectedLaterRotationVertices = resolvedShapeVertices(shapeWithPathValue(
  componentShape,
  expectedLaterRotation,
));
actualLaterRotationVertices.forEach((point, index) => {
  assert.ok(Math.abs(point.x - expectedLaterRotationVertices[index].x) < 1e-9);
  assert.ok(Math.abs(point.y - expectedLaterRotationVertices[index].y) < 1e-9);
});
G.undo();

F.gotoFrame(5);
const beforeExplicitVertexEdit = Array.from({ length: 11 }, (_, frame) =>
  F.shapePathAt(compensatedAnchorId, frame));
const editedVertex = shapePathComponentValue(
  beforeExplicitVertexEdit[5],
  'vertex:0',
);
assert.deepEqual(F.setShapePathComponentValues(5, compensatedAnchorId, [{
  componentId: 'vertex:0',
  value: { x: editedVertex.x + 1, y: editedVertex.y },
}]), ['vertex:0']);
assert.equal(F.canonicalTimelineStateForSave().clips.some((clip) =>
  clip.propertyTracks?.shapeAnchorCompensation?.length), false,
'a later vertex edit materializes the hidden compensation into canonical vertex curves');
for (let index = 0; index < 4; index++) {
  assert.equal(F.isShapePathComponentEnabled(
    compensatedAnchorId,
    `vertex:${index}`,
  ), index === 0,
  'materialization exposes only the explicitly edited rectangle vertex');
}
assert.deepEqual(
  F.dopeRows()[0].shapePathComponentTracks.map(({ id }) => id),
  ['vertex:0', 'anchor', 'rotation'],
  'internal rectangle compensation channels do not become Timeline rows',
);
for (let frame = 0; frame <= 10; frame++) {
  const actual = F.shapePathAt(compensatedAnchorId, frame);
  for (let index = 0; index < 4; index++) {
    const component = `vertex:${index}`;
    const expected = frame === 5 && index === 0
      ? { x: editedVertex.x + 1, y: editedVertex.y }
      : shapePathComponentValue(beforeExplicitVertexEdit[frame], component);
    assert.deepEqual(shapePathComponentValue(actual, component), expected,
      `rectangle vertex ${index} keeps its exact discrete pose at frame ${frame}`);
  }
}
G.undo();
for (let index = 0; index < 4; index++) {
  assert.equal(F.isShapePathComponentEnabled(
    compensatedAnchorId,
    `vertex:${index}`,
  ), false, 'materialization and the vertex edit share one Undo step');
}

const compensatedLineShape = {
  kind: 'line',
  x0: 2,
  y0: 3,
  x1: 10,
  y1: 6,
  anchor: { x: 6, y: 4.5 },
  rotation: 0,
  style: 'outline',
  detail: 'cell',
  channel: 'glyph',
  char: '#',
  fg: '#ffffff',
};
const compensatedLineId = shapeDocument(compensatedLineShape);
for (let frame = 1; frame <= 4; frame++) F.addFrame();
F.gotoFrame(0);
assert.equal(F.setShapePathComponentTrackEnabled(
  compensatedLineId,
  'rotation',
  true,
), true);
assert.deepEqual(F.setShapePathComponentValues(4, compensatedLineId, [{
  componentId: 'rotation',
  value: 90,
}]), ['rotation']);
assert.equal(F.setShapePathComponentTrackEnabled(
  compensatedLineId,
  'anchor',
  true,
), true);
F.gotoFrame(4);
const lineAnchor = shapePathComponentValue(
  F.shapePathAt(compensatedLineId, 4),
  'anchor',
);
assert.deepEqual(F.setShapePathComponentValues(4, compensatedLineId, [{
  componentId: 'anchor',
  value: { x: lineAnchor.x + 3, y: lineAnchor.y - 2 },
}]), ['anchor']);
const compensatedLinePaths = Array.from({ length: 5 }, (_, frame) =>
  F.shapePathAt(compensatedLineId, frame));
const assertSameLinePose = (actual, expected, message) => {
  assert.deepEqual(
    resolvedShapeVertices(shapeWithPathValue(compensatedLineShape, actual)),
    resolvedShapeVertices(shapeWithPathValue(compensatedLineShape, expected)),
    message,
  );
  assert.deepEqual(
    shapePathComponentValue(actual, 'anchor'),
    shapePathComponentValue(expected, 'anchor'),
    message,
  );
  assert.equal(
    shapePathComponentValue(actual, 'rotation'),
    shapePathComponentValue(expected, 'rotation'),
    message,
  );
};
assert.equal(compensationKeyCount(compensatedLineId) > 0, true,
  'the line fixture has hidden anchor compensation');

assert.equal(F.setShapePathComponentTrackEnabled(
  compensatedLineId,
  'vertex:0',
  true,
), true);
assert.equal(F.isShapePathComponentEnabled(
  compensatedLineId,
  'vertex:0',
), true);
assert.equal(F.isShapePathComponentEnabled(
  compensatedLineId,
  'vertex:1',
), false, 'enabling Start leaves End internal and unexposed');
assert.deepEqual(
  F.dopeRows()[0].shapePathComponentTracks.map(({ id }) => id),
  ['vertex:0', 'anchor', 'rotation'],
  'enabling Start adds one endpoint row, not both endpoint rows',
);
assert.deepEqual(
  F.shapePathComponentKeys(compensatedLineId, 'vertex:1')
    .map(({ frame, value }) => ({ frame, value })),
  compensatedLinePaths.map((path, frame) => ({
    frame,
    value: shapePathComponentValue(path, 'vertex:1'),
  })),
  'hidden End materializes to exact internal keys without becoming a row',
);
for (let frame = 0; frame < 5; frame++) {
  assertSameLinePose(F.shapePathAt(compensatedLineId, frame),
    compensatedLinePaths[frame],
  `enabling Start preserves the exact line pose at frame ${frame}`);
}
G.undo();
assert.equal(compensationKeyCount(compensatedLineId) > 0, true,
  'one Undo restores hidden line compensation');
assert.equal(F.isShapePathComponentEnabled(
  compensatedLineId,
  'vertex:0',
), false, 'the same Undo removes the explicitly enabled Start row');

F.gotoFrame(2);
const lineStart = shapePathComponentValue(compensatedLinePaths[2], 'vertex:0');
assert.deepEqual(F.setShapePathComponentValues(2, compensatedLineId, [{
  componentId: 'vertex:0',
  value: { x: lineStart.x - 1, y: lineStart.y + 0.5 },
}]), ['vertex:0']);
assert.equal(F.isShapePathComponentEnabled(
  compensatedLineId,
  'vertex:0',
), true, 'editing Start exposes only its required materialized track');
assert.equal(F.isShapePathComponentEnabled(
  compensatedLineId,
  'vertex:1',
), false);
for (let frame = 0; frame < 5; frame++) {
  const actual = F.shapePathAt(compensatedLineId, frame);
  assert.deepEqual(shapePathComponentValue(actual, 'vertex:0'),
    frame === 2
      ? { x: lineStart.x - 1, y: lineStart.y + 0.5 }
      : shapePathComponentValue(compensatedLinePaths[frame], 'vertex:0'),
  `editing Start preserves its exact neighboring pose at frame ${frame}`);
  assert.deepEqual(
    shapePathComponentValue(actual, 'vertex:1'),
    shapePathComponentValue(compensatedLinePaths[frame], 'vertex:1'),
    `editing Start never changes End at frame ${frame}`,
  );
}
G.undo();
for (let frame = 0; frame < 5; frame++) {
  assertSameLinePose(F.shapePathAt(compensatedLineId, frame),
    compensatedLinePaths[frame],
  `one Undo restores the compensated line pose at frame ${frame}`);
}
assert.equal(F.isShapePathComponentEnabled(
  compensatedLineId,
  'vertex:0',
), false);
assert.equal(F.isShapePathComponentEnabled(
  compensatedLineId,
  'vertex:1',
), false);

console.log('shape body drag tests passed');
