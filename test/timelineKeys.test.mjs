import {
  editorEscapeAction,
  editorModalOpen,
  getKeyboardContext,
  keyboardContextOwns,
  keyboardDeleteAction,
  isEditingTarget,
  isPlaybackShortcut,
  keyFramesForRow,
  noteKeyboardContext,
  planSelectionDeselect,
  planTimelineKeyMotion,
  releaseKeyboardContext,
  resetKeyboardContext,
  selectTimelineKey,
  setKeyboardContext,
  timelineContainsTarget,
  timelineKeyPasteCompatible,
  timelineKeyTrackAvailable,
  timelineKeyTargetsMask,
} from '../src/lib/timelineKeys.js';

let pass = 0;
let fail = 0;

function eq(name, got, want) {
  const actual = JSON.stringify(got);
  const expected = JSON.stringify(want);
  if (actual === expected) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  got:  ${actual}\n  want: ${expected}`);
  }
}

function snapshot(result) {
  return {
    layerId: result.selection.layerId,
    kind: result.selection.kind,
    frames: [...result.selection.frames].sort((a, b) => a - b),
    anchor: result.anchor,
  };
}

const effectRow = {
  id: 11,
  type: 'effect',
  keyFrames: [0, 3],
  visibilityTrackEnabled: true,
  visibilityKeyFrames: [2, 6],
  effectIntensityTrackEnabled: true,
  effectIntensityKeyFrames: [1, 4, 7],
  maskOpacityTrackEnabled: true,
  maskOpacityKeyFrames: [0, 5, 7],
  maskPositionTrackEnabled: true,
  maskPositionKeyFrames: [2, 5, 8],
};
const otherEffectRow = {
  ...effectRow,
  id: 22,
};
const shapeRow = {
  id: 33,
  type: 'shape',
  shapePathTrackEnabled: true,
  shapePathKeyFrames: [1, 5, 8],
};

eq('timeline-key-kinds-map-to-distinct-property-rows', [
  keyFramesForRow(effectRow, 'position'),
  keyFramesForRow(effectRow, 'visibility'),
  keyFramesForRow(effectRow, 'intensity'),
  keyFramesForRow(effectRow, 'mask-opacity'),
  keyFramesForRow(effectRow, 'mask-position'),
  keyFramesForRow(shapeRow, 'shape-path'),
], [
  [0, 3],
  [2, 6],
  [1, 4, 7],
  [0, 5, 7],
  [2, 5, 8],
  [1, 5, 8],
]);

eq('layer-selection-exposes-only-layer-key-tracks', [
  timelineKeyTrackAvailable(effectRow, 'position', false),
  timelineKeyTrackAvailable(effectRow, 'visibility', false),
  timelineKeyTrackAvailable(effectRow, 'intensity', false),
  timelineKeyTrackAvailable(effectRow, 'mask-position', false),
  timelineKeyTrackAvailable(effectRow, 'mask-opacity', false),
], [true, true, true, false, false]);

eq('mask-selection-exposes-only-mask-key-tracks', [
  timelineKeyTrackAvailable(effectRow, 'position', true),
  timelineKeyTrackAvailable(effectRow, 'visibility', true),
  timelineKeyTrackAvailable(effectRow, 'intensity', true),
  timelineKeyTrackAvailable(effectRow, 'mask-position', true),
  timelineKeyTrackAvailable(effectRow, 'mask-opacity', true),
], [false, false, false, true, true]);

eq('shape-selection-exposes-only-an-enabled-shape-path-track', [
  timelineKeyTrackAvailable(shapeRow, 'shape-path', false),
  timelineKeyTrackAvailable({ ...shapeRow, shapePathTrackEnabled: false }, 'shape-path', false),
  timelineKeyTrackAvailable(effectRow, 'shape-path', false),
  timelineKeyTrackAvailable(shapeRow, 'shape-path', true),
], [true, false, false, false]);

eq('disabled-or-missing-tracks-do-not-preserve-hidden-key-selection', [
  timelineKeyTrackAvailable({ ...effectRow, maskPositionTrackEnabled: false }, 'mask-position', true),
  timelineKeyTrackAvailable({ ...effectRow, maskOpacityTrackEnabled: false }, 'mask-opacity', true),
  timelineKeyTrackAvailable({ ...effectRow, keyFrames: [] }, 'position', false),
  timelineKeyTrackAvailable(null, 'position', false),
], [false, false, false, false]);

eq('mask-key-targeting-keeps-mask-rows-and-layer-rows-separate', [
  timelineKeyTargetsMask('mask-position'),
  timelineKeyTargetsMask('mask-opacity'),
  timelineKeyTargetsMask('position'),
  timelineKeyTargetsMask('intensity'),
  timelineKeyTargetsMask('visibility'),
  timelineKeyTargetsMask('shape-path'),
], [true, true, false, false, false, false]);

const rectanglePathClipboard = {
  type: 'shape-path',
  shapeKind: 'rect',
  keys: [{ frame: 0, kind: 'rect', cx: 4, cy: 3, w: 6, h: 5 }],
};
eq('shape-path-paste-requires-the-same-authored-shape-kind', [
  timelineKeyPasteCompatible(rectanglePathClipboard, 'shape-path', 'rect'),
  timelineKeyPasteCompatible(rectanglePathClipboard, 'shape-path', 'circle'),
  timelineKeyPasteCompatible(rectanglePathClipboard, 'shape-path', 'line'),
  timelineKeyPasteCompatible(rectanglePathClipboard, 'position', 'rect'),
  timelineKeyPasteCompatible(null, 'shape-path', 'rect'),
], [true, false, false, false, false]);
eq('non-shape-key-paste-keeps-the-existing-track-kind-rule', [
  timelineKeyPasteCompatible({ type: 'position', keys: [] }, 'position'),
  timelineKeyPasteCompatible({ type: 'visibility', keys: [] }, 'visibility'),
  timelineKeyPasteCompatible({ type: 'position', keys: [] }, 'visibility'),
], [true, true, false]);

const timelineNode = { nodeType: 1 };
const timelineContainer = {
  contains(target) {
    if (typeof target?.nodeType !== 'number') throw new TypeError('not a DOM node');
    return target === timelineNode;
  },
};
eq('timeline shortcuts ignore command events without a DOM target', [
  timelineContainsTarget(timelineContainer, timelineNode),
  timelineContainsTarget(timelineContainer, { type: 'menu-command' }),
  timelineContainsTarget(timelineContainer, null),
], [true, false, false]);

const timelineContextMarker = {
  getAttribute: (name) => name === 'data-keyboard-context' ? 'timeline' : null,
};
const layersContextMarker = {
  getAttribute: (name) => name === 'data-keyboard-context' ? 'layers' : null,
};
const canvasContextMarker = {
  getAttribute: (name) => name === 'data-keyboard-context' ? 'canvas' : null,
};
const neutralContextMarker = {
  getAttribute: (name) => name === 'data-keyboard-context' ? 'neutral' : null,
};
const outsideTarget = { closest: () => null };
const timelineTarget = {
  closest: (selector) => selector === '[data-keyboard-context]' ? timelineContextMarker : null,
};
const layersTarget = {
  closest: (selector) => selector === '[data-keyboard-context]' ? layersContextMarker : null,
};
const canvasTarget = {
  closest: (selector) => selector === '[data-keyboard-context]' ? canvasContextMarker : null,
};
const neutralTarget = {
  closest: (selector) => selector === '[data-keyboard-context]' ? neutralContextMarker : null,
};

resetKeyboardContext();
noteKeyboardContext({ target: timelineTarget });
eq('last-pointer-context-routes-one-delete-owner', [
  keyboardContextOwns('timeline', { target: outsideTarget }, outsideTarget),
  keyboardContextOwns('layers', { target: outsideTarget }, outsideTarget),
], [true, false]);
eq('focused-elements-cannot-override-explicit-pointer-context', [
  keyboardContextOwns('timeline', { target: outsideTarget }, layersTarget),
  keyboardContextOwns('layers', { target: outsideTarget }, layersTarget),
], [true, false]);
noteKeyboardContext({ target: layersTarget }, timelineTarget);
eq('a-new-panel-pointer-interaction-transfers-context', [
  keyboardContextOwns('timeline', { target: outsideTarget }, timelineTarget),
  keyboardContextOwns('layers', { target: outsideTarget }, timelineTarget),
], [false, true]);
noteKeyboardContext({ target: neutralTarget }, layersTarget);
eq('neutral-controls-preserve-the-current-selection-owner', [
  getKeyboardContext(),
  keyboardContextOwns('layers', { target: neutralTarget }),
  keyboardContextOwns('timeline', { target: neutralTarget }),
], ['layers', true, false]);
noteKeyboardContext({ target: timelineTarget }, neutralTarget);
eq('explicit-content-context-wins-after-a-neutral-control', [
  keyboardContextOwns('layers', { target: timelineTarget }),
  keyboardContextOwns('timeline', { target: timelineTarget }),
], [false, true]);
noteKeyboardContext({ target: outsideTarget });
eq('pointer-outside-editor-panels-clears-delete-owner', [
  keyboardContextOwns('canvas', { target: outsideTarget }, outsideTarget),
  keyboardContextOwns('timeline', { target: outsideTarget }, outsideTarget),
  keyboardContextOwns('layers', { target: outsideTarget }, outsideTarget),
], [false, false, false]);
noteKeyboardContext({ target: canvasTarget });
eq('canvas-pointer-acquires-the-canvas-selection-owner', [
  getKeyboardContext(),
  keyboardContextOwns('canvas', { target: outsideTarget }),
  keyboardContextOwns('layers', { target: outsideTarget }),
  keyboardContextOwns('timeline', { target: outsideTarget }),
], ['canvas', true, false, false]);
let activeElement = timelineTarget;
const timelineTargetWithBlur = {
  closest: () => timelineContextMarker,
  blur: () => {
    activeElement = outsideTarget;
  },
};
activeElement = timelineTargetWithBlur;
noteKeyboardContext({ target: timelineTarget }, activeElement);
noteKeyboardContext({ target: outsideTarget }, activeElement);
eq('canvas-pointer-blurs-stale-panel-focus-before-delete-routing', [
  activeElement === outsideTarget,
  keyboardContextOwns('timeline', { target: outsideTarget }, activeElement),
  keyboardContextOwns('layers', { target: outsideTarget }, activeElement),
], [true, false, false]);
activeElement = timelineTargetWithBlur;
setKeyboardContext('timeline');
releaseKeyboardContext('timeline', activeElement);
eq('timeline operations and Undo can release focused Delete context explicitly', [
  activeElement === outsideTarget,
  keyboardContextOwns('timeline', { target: outsideTarget }, activeElement),
], [true, false]);
activeElement = layersTarget;
resetKeyboardContext();
eq('focused layer rows cannot resurrect reset project context', [
  keyboardContextOwns('layers', { target: layersTarget }, activeElement),
  keyboardContextOwns('timeline', { target: timelineTarget }, activeElement),
], [false, false]);
setKeyboardContext('layers');
noteKeyboardContext({ target: { closest: (selector) => selector.startsWith('input') ? {} : layersContextMarker } });
eq('editing targets release explicit layer context', [
  keyboardContextOwns('layers', { target: layersTarget }),
], [false]);
eq('handled-delete-cannot-leak-into-the-other-panel-handler', [
  keyboardContextOwns('timeline', { target: timelineTarget, defaultPrevented: true }, timelineTarget),
  keyboardContextOwns('layers', { target: layersTarget, defaultPrevented: true }, layersTarget),
], [false, false]);

eq('delete-contract-leaves-timeline-selection-to-the-canonical-planner', [
  keyboardDeleteAction('timeline', { activeLayerId: 9, selectedKeyCount: 3 }),
  keyboardDeleteAction('layers', { activeLayerId: 9, selectedLayerCount: 3 }),
  keyboardDeleteAction('layers', { activeLayerId: 9, selectedLayerCount: 0 }),
  keyboardDeleteAction('layers', { activeLayerId: null, selectedLayerCount: 3 }),
  keyboardDeleteAction('timeline', { activeLayerId: 9, editing: true }),
  keyboardDeleteAction('layers', { activeLayerId: 9, selectedLayerCount: 3, playing: true }),
], [null, 'layer', null, null, null, null]);

const ctrlD = { key: 'd', ctrlKey: true };
const metaD = { key: 'D', metaKey: true };
eq('deselect-planner-routes-the-exact-command-to-each-current-owner', [
  planSelectionDeselect(ctrlD, { context: 'canvas' }),
  planSelectionDeselect(ctrlD, { context: 'layers' }),
  planSelectionDeselect(metaD, { context: 'timeline' }),
  planSelectionDeselect(ctrlD, { context: null }),
], [
  { handled: true, context: 'canvas' },
  { handled: true, context: 'layers' },
  { handled: true, context: 'timeline' },
  { handled: true, context: null },
]);
eq('deselect-planner-yields-to-typing-popups-and-other-modifier-chords', [
  planSelectionDeselect(ctrlD, { context: 'canvas', typing: true }),
  planSelectionDeselect(ctrlD, { context: 'layers', popupOpen: true }),
  planSelectionDeselect({ ...ctrlD, shiftKey: true }, { context: 'timeline' }),
  planSelectionDeselect({ ...ctrlD, altKey: true }, { context: 'timeline' }),
  planSelectionDeselect({ key: 'd' }, { context: 'canvas' }),
  planSelectionDeselect({ ...ctrlD, defaultPrevented: true }, { context: 'canvas' }),
], Array.from({ length: 6 }, () => ({ handled: false, context: null })));

eq('playback-shortcut-accepts-one-unmodified-k-press', [
  isPlaybackShortcut({ key: 'k' }),
  isPlaybackShortcut({ key: 'K', shiftKey: true }),
  isPlaybackShortcut({ key: 'k', repeat: true }),
  isPlaybackShortcut({ key: 'k', ctrlKey: true }),
  isPlaybackShortcut({ key: 'k', altKey: true }),
  isPlaybackShortcut({ key: 'k', metaKey: true }),
  isPlaybackShortcut({ key: 'k' }, true),
  isPlaybackShortcut({ key: 'j' }),
  isPlaybackShortcut({ key: ' ', code: 'Space' }, false, 'timeline'),
  isPlaybackShortcut({ key: ' ', code: 'Space' }, false, 'canvas'),
  isPlaybackShortcut({ key: ' ', code: 'Space', shiftKey: true }, false, 'timeline'),
], [true, true, false, false, false, false, false, false, true, false, false]);

const editingControl = { closest: () => editingControl };
eq('playback-shortcuts-yield-to-every-editing-control', [
  isEditingTarget(editingControl),
  isPlaybackShortcut({ key: 'k' }, isEditingTarget(editingControl)),
  isEditingTarget({ closest: () => null }),
], [true, false, false]);

const rangeInput = {
  type: 'range',
  closest: (selector) => selector === 'input' ? rangeInput : null,
};
const textInput = {
  type: 'text',
  closest: (selector) => selector === 'input' ? textInput : null,
};
eq('application-shortcuts-remain-available-on-non-text-inputs', [
  isEditingTarget(rangeInput),
  isEditingTarget(textInput),
], [false, true]);

eq('document input is blocked by every editor modal', [
  editorModalOpen({ exportOpen: true }),
  editorModalOpen({ prefsOpen: true }),
  editorModalOpen({ helperOpen: true }),
  editorModalOpen({ convertOpen: true }),
  editorModalOpen({ discardOpen: true }),
  editorModalOpen({}),
], [true, true, true, true, true, false]);

eq('editor-escape-honors-frontmost-ui-before-crop', [
  editorEscapeAction({ menuOpen: true, activeTool: 'crop', cropPending: true }),
  editorEscapeAction({ sketchOpen: true, activeTool: 'crop', cropPending: true }),
  editorEscapeAction({ colorEditActive: true, activeTool: 'crop', cropPending: true }),
  editorEscapeAction({ moveActive: true, activeTool: 'crop', cropPending: true }),
], ['menu', 'sketch', 'color', 'move']);
eq('editor-escape-cancels-only-a-pending-active-crop', [
  editorEscapeAction({ activeTool: 'crop', cropPending: true }),
  editorEscapeAction({ activeTool: 'crop', cropPending: false }),
  editorEscapeAction({ activeTool: 'brush', cropPending: true }),
  editorEscapeAction({ typing: true, activeTool: 'crop', cropPending: true }),
], ['crop', null, null, null]);

let selection = { layerId: null, kind: null, frames: new Set() };
let anchor = null;
let result = selectTimelineKey(selection, anchor, effectRow, 'intensity', 1);
selection = result.selection;
anchor = result.anchor;
result = selectTimelineKey(selection, anchor, effectRow, 'intensity', 7, { ctrlKey: true });
selection = result.selection;
anchor = result.anchor;
eq('ctrl-add-keeps-selection-on-one-scalar-track', snapshot(result), {
  layerId: 11,
  kind: 'intensity',
  frames: [1, 7],
  anchor: { layerId: 11, kind: 'intensity', frame: 7 },
});

result = selectTimelineKey(selection, anchor, effectRow, 'intensity', 4, { shiftKey: true });
selection = result.selection;
anchor = result.anchor;
eq('shift-selects-authored-keys-between-the-anchor-and-target', snapshot(result), {
  layerId: 11,
  kind: 'intensity',
  frames: [4, 7],
  anchor: { layerId: 11, kind: 'intensity', frame: 7 },
});

result = selectTimelineKey(selection, anchor, effectRow, 'visibility', 2, { ctrlKey: true });
selection = result.selection;
anchor = result.anchor;
eq('ctrl-on-another-key-kind-replaces-rather-than-mixes-selection', snapshot(result), {
  layerId: 11,
  kind: 'visibility',
  frames: [2],
  anchor: { layerId: 11, kind: 'visibility', frame: 2 },
});

result = selectTimelineKey(selection, anchor, otherEffectRow, 'visibility', 6, { metaKey: true });
eq('modifier-selection-on-another-layer-replaces-the-previous-layer', snapshot(result), {
  layerId: 22,
  kind: 'visibility',
  frames: [6],
  anchor: { layerId: 22, kind: 'visibility', frame: 6 },
});

const motionState = {
  tracks: [{ id: 'motion-track', kind: 'visual' }, { id: 'locked-track', kind: 'visual', locked: true }],
  clips: [{
    id: 'motion-clip', trackId: 'motion-track', kind: 'visual',
    startTick: 10, inTick: 2, outTick: 8, sourceDuration: 8,
    frameKeys: [{ tick: 2 }, { tick: 4 }, { tick: 7 }],
    propertyTracks: {
      position: [{ tick: 3 }, { tick: 7 }],
      visibility: [{ tick: 5 }],
      effectIntensity: [{ tick: 6 }],
      maskPosition: [{ tick: 3 }],
      maskOpacity: [{ tick: 4 }],
      shapePath: [{ tick: 5 }],
    },
  }, {
    id: 'locked-clip', trackId: 'locked-track', kind: 'visual',
    startTick: 0, inTick: 0, outTick: 2, sourceDuration: 2,
    frameKeys: [{ tick: 0 }], propertyTracks: {},
  }],
};
const mixedMotion = planTimelineKeyMotion(motionState, {
  frameKeys: [{ clipId: 'motion-clip', sourceTick: 4 }],
  propertyKeys: [
    ['position', 3],
    ['visibility', 5],
    ['effectIntensity', 6],
    ['maskPosition', 3],
    ['maskOpacity', 4],
    ['shapePath', 5],
  ].map(([propertyName, sourceTick]) => ({ clipId: 'motion-clip', propertyName, sourceTick })),
}, 99);
eq('mixed-frame-and-every-property-key-clamp-as-one-project-space-group', {
  valid: mixedMotion.valid,
  changed: mixedMotion.changed,
  requested: mixedMotion.requestedDeltaTicks,
  delta: mixedMotion.deltaTicks,
  projects: mixedMotion.moves.map((move) => [move.projectTick, move.destinationProjectTick]),
  sources: mixedMotion.moves.map((move) => [move.sourceTick, move.destinationSourceTick]),
}, {
  valid: true,
  changed: true,
  requested: 99,
  delta: 1,
  projects: [[12, 13], [11, 12], [13, 14], [14, 15], [11, 12], [12, 13], [13, 14]],
  sources: [[4, 5], [3, 4], [5, 6], [6, 7], [3, 4], [4, 5], [5, 6]],
});
eq('key-motion-selection-follows-destination-identities', {
  frames: mixedMotion.selection.frameKeys,
  properties: mixedMotion.selection.propertyKeys,
}, {
  frames: [{ clipId: 'motion-clip', sourceTick: 5 }],
  properties: [
    { clipId: 'motion-clip', propertyName: 'position', sourceTick: 4 },
    { clipId: 'motion-clip', propertyName: 'visibility', sourceTick: 6 },
    { clipId: 'motion-clip', propertyName: 'effectIntensity', sourceTick: 7 },
    { clipId: 'motion-clip', propertyName: 'maskPosition', sourceTick: 4 },
    { clipId: 'motion-clip', propertyName: 'maskOpacity', sourceTick: 5 },
    { clipId: 'motion-clip', propertyName: 'shapePath', sourceTick: 6 },
  ],
});
const crossClipMotion = planTimelineKeyMotion({
  tracks: [...motionState.tracks, { id: 'offset-track', kind: 'visual' }],
  clips: [...motionState.clips, {
    id: 'offset-clip', trackId: 'offset-track', kind: 'visual',
    startTick: 2, inTick: 5, outTick: 10, sourceDuration: 10,
    frameKeys: [{ tick: 5 }],
    propertyTracks: { visibility: [{ tick: 7 }] },
  }],
}, {
  propertyKeys: [
    { clipId: 'motion-clip', propertyName: 'position', sourceTick: 3 },
    { clipId: 'offset-clip', propertyName: 'visibility', sourceTick: 7 },
  ],
}, 1);
eq('cross-clip-motion-maps-source-ticks-through-distinct-project-origins',
  crossClipMotion.moves.map((move) => ({
    source: move.sourceTick,
    destinationSource: move.destinationSourceTick,
    project: move.projectTick,
    destinationProject: move.destinationProjectTick,
  })), [
    { source: 3, destinationSource: 4, project: 11, destinationProject: 12 },
    { source: 7, destinationSource: 8, project: 4, destinationProject: 5 },
  ]);
eq('unselected-destination-collision-rejects-the-complete-key-group',
  planTimelineKeyMotion(motionState, {
    propertyKeys: [{ clipId: 'motion-clip', propertyName: 'position', sourceTick: 3 }],
  }, 4).reason,
  'key-collision');
eq('selected-key-vacates-a-destination-before-another-selected-key-enters-it',
  planTimelineKeyMotion({
    ...motionState,
    clips: [{ ...motionState.clips[0], propertyTracks: { position: [{ tick: 3 }, { tick: 4 }] } }],
  }, {
    propertyKeys: [
      { clipId: 'motion-clip', propertyName: 'position', sourceTick: 3 },
      { clipId: 'motion-clip', propertyName: 'position', sourceTick: 4 },
    ],
  }, 1).valid,
  true);
eq('opening-frame-motion-remains-valid-for-canonical-boundary-advance', {
  valid: planTimelineKeyMotion(motionState, {
    frameKeys: [{ clipId: 'motion-clip', sourceTick: 2 }],
  }, 1).valid,
  destination: planTimelineKeyMotion(motionState, {
    frameKeys: [{ clipId: 'motion-clip', sourceTick: 2 }],
  }, 1).moves[0].destinationProjectTick,
}, { valid: true, destination: 11 });
eq('locked-key-motion-is-atomic',
  planTimelineKeyMotion(motionState, {
    frameKeys: [
      { clipId: 'motion-clip', sourceTick: 4 },
      { clipId: 'locked-clip', sourceTick: 0 },
    ],
  }, 1).reason,
  'missing-or-locked-key');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
