import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { validateClipTimelineState } from '../src/lib/clipTimeline.js';
import {
  deterministicUuid,
  deterministicUuidGenerator as createStableClipTimelineIdGenerator,
} from './projectFixture.mjs';
import {
  ClipTimelineStateValidationError,
  clipTimelineSelectionTrackScope,
  createCanonicalClipTimelineController,
  createClipTimelineSelection,
  emptyClipTimelineSelection,
} from '../src/lib/clipTimelineState.js';

let passed = 0;
let failed = 0;

function test(name, run) {
  try {
    run();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}

function cell(glyph, fg = '#ffffff') {
  return { c: glyph, fg, bg: null };
}

function visualTrack(id, extra = {}) {
  return {
    id,
    kind: 'visual',
    sourceLayerId: `layer-${id}`,
    layer: {
      id: `layer-${id}`,
      name: id,
      type: 'cell',
      visible: true,
      cells: {},
      offset: { x: 0, y: 0 },
    },
    ...extra,
  };
}

function visualClip(id, trackId, startTick, durationTicks, extra = {}) {
  return {
    id,
    trackId,
    kind: 'visual',
    startTick,
    inTick: 0,
    outTick: durationTicks,
    sourceDuration: durationTicks,
    frameKeys: [{ tick: 0, value: { cells: { '0,0': cell(id[0].toUpperCase()) } } }],
    ...extra,
  };
}

function clipById(state, id) {
  return state.clips.find((clip) => clip.id === id);
}

function operationState() {
  return {
    tracks: [visualTrack('visual')],
    clips: [
      visualClip('base', 'visual', 0, 4, {
        frameKeys: [
          { tick: 0, value: { cells: { '0,0': cell('A') } } },
          { tick: 3, value: { cells: { '0,0': cell('D') } } },
        ],
      }),
      visualClip('later', 'visual', 8, 2),
    ],
  };
}

test('canonical stores publish validated transactions and mutation revisions', () => {
  const controller = createCanonicalClipTimelineController({
    initialState: {
      tracks: [visualTrack('visual')],
      clips: [visualClip('clip', 'visual', 0, 4)],
    },
    playheadTick: 99,
  });
  const views = [];
  const unsubscribe = controller.subscribe((view) => views.push(view));

  assert.equal(typeof controller.timeline.set, 'function');
  assert.equal(typeof controller.timeline.update, 'function');
  assert.equal(typeof controller.playheadTick.set, 'function');
  assert.equal(typeof controller.durationTicks.set, 'undefined');
  assert.equal(get(controller.durationTicks), 4);
  assert.equal(get(controller.playheadTick), 3);
  assert.equal(controller.getMutationRevision(), 0);
  assert.deepEqual(views[0].tracks.map((track) => track.id), ['visual']);

  const unchanged = controller.move('clip', 0);
  assert.equal(unchanged.changed, false);
  assert.equal(controller.getMutationRevision(), 0);
  assert.equal(views.length, 1);

  const edited = controller.editVisualFrame('visual', 1, (draft) => {
    draft.cells['0,0'].c = 'B';
  });
  assert.equal(edited.changed, true);
  assert.equal(edited.previousMutationRevision, 0);
  assert.equal(edited.mutationRevision, 1);
  assert.equal(controller.getMutationRevision(), 1);
  assert.deepEqual(clipById(controller.getState(), 'clip').frameKeys.map((key) => key.tick), [0, 1]);
  assert.equal(views.at(-1).mutationRevision, 1);
  assert.equal(views.at(-1).state.clips[0].frameKeys[1].value.cells['0,0'].c, 'B');

  controller.timeline.update((state) => ({ ...state, label: 'canonical' }));
  assert.equal(controller.getState().label, 'canonical');
  assert.equal(controller.getMutationRevision(), 2);
  const updatePlayhead = controller.playheadTick.update;
  updatePlayhead(() => 2);
  assert.equal(controller.getPlayheadTick(), 2);
  const updateSelection = controller.selection.update;
  updateSelection(() => ({ clipIds: ['clip'] }));
  assert.deepEqual([...controller.getSelection().clipIds], ['clip']);
  unsubscribe();
});

test('injected ids also canonicalize missing initial track and nested clip ids', () => {
  const controller = createCanonicalClipTimelineController({
    makeId: createStableClipTimelineIdGenerator(30),
    initialState: {
      tracks: [{
        kind: 'visual',
        layer: {
          id: 'source-layer', name: 'Source', type: 'cell', visible: true,
          cells: {}, offset: { x: 0, y: 0 },
        },
        clips: [{
          kind: 'visual', startTick: 0, inTick: 0, outTick: 1, sourceDuration: 1,
          frameKeys: [{ tick: 0, value: { cells: { '0,0': cell('A') } } }],
        }],
      }],
      clips: [],
    },
  });
  const trackId = deterministicUuid('track', 30);
  const clipId = deterministicUuid('clip', 30);
  assert.deepEqual(controller.getState().tracks.map((track) => track.id), [trackId]);
  assert.deepEqual(controller.getState().clips.map((clip) => [clip.id, clip.trackId]), [
    [clipId, trackId],
  ]);
});

test('capture, restore, and reset isolate history snapshots and context', () => {
  const controller = createCanonicalClipTimelineController({
    initialState: {
      tracks: [visualTrack('visual')],
      clips: [visualClip('clip', 'visual', 0, 3, {
        frameKeys: [{
          tick: 0,
          value: { cells: { '0,0': cell('A') }, nested: { value: 1 } },
        }],
      })],
    },
    playheadTick: 2,
  });
  controller.setSelection({ clipIds: ['clip'], trackHeaderIds: ['visual'] });
  const isolated = controller.capture();
  isolated.state.clips[0].frameKeys[0].value.nested.value = 99;
  isolated.selection.clipIds.clear();
  assert.equal(controller.getState().clips[0].frameKeys[0].value.nested.value, 1);
  assert.deepEqual([...controller.getSelection().clipIds], ['clip']);

  const history = controller.captureState();
  controller.editVisualFrame('visual', 1, { cells: { '0,0': cell('B') } });
  assert.deepEqual(clipById(controller.getState(), 'clip').frameKeys.map((key) => key.tick), [0, 1]);
  const restored = controller.restore(history);
  assert.equal(restored.changed, true);
  assert.deepEqual(clipById(controller.getState(), 'clip').frameKeys.map((key) => key.tick), [0]);
  assert.equal(controller.getPlayheadTick(), 2);
  assert.deepEqual([...controller.getSelection().clipIds], ['clip']);

  const reset = controller.reset();
  assert.equal(reset.changed, true);
  assert.deepEqual(controller.getState(), { tracks: [], clips: [], tags: [] });
  assert.deepEqual(controller.getSelection(), emptyClipTimelineSelection());
  assert.equal(controller.getPlayheadTick(), 0);
  assert.equal(controller.getDurationTicks(), 1);

  controller.restore(history);
  assert.equal(controller.getState().clips[0].frameKeys[0].value.nested.value, 1);
  assert.equal(controller.getMutationRevision(), 4);
});

test('edit, property, move, trim, razor, delete, ripple, and add-empty are atomic wrappers', () => {
  const controller = createCanonicalClipTimelineController({
    initialState: operationState(),
    makeId: createStableClipTimelineIdGenerator(),
  });

  const frame = controller.editVisualFrame('visual', 1, (draft) => {
    draft.cells['0,0'].c = 'B';
  });
  assert.equal(frame.createdKey, true);
  const property = controller.editProperty('base', 'position', 2, { x: 4, y: 2 }, {
    initialValue: { x: 0, y: 0 },
  });
  assert.equal(property.createdKey, true);
  assert.deepEqual(clipById(controller.getState(), 'base').propertyTracks.position, [
    { tick: 2, value: { x: 4, y: 2 } },
  ]);

  assert.equal(controller.move('later', 9).changed, true);
  assert.equal(clipById(controller.getState(), 'later').startTick, 9);
  assert.equal(controller.trim('base', 'end', 5).edgeTick, 5);
  assert.equal(clipById(controller.getState(), 'base').outTick, 5);

  const split = controller.razor('base', 2, { rightClipId: 'right' });
  assert.equal(split.changed, true);
  assert.equal(split.right.id, 'right');
  assert.equal(clipById(controller.getState(), 'base').outTick, 2);
  assert.equal(clipById(controller.getState(), 'right').startTick, 2);

  controller.setSelection({ clipIds: ['right'] });
  const deleted = controller.deleteSelection(controller.getSelection());
  assert.equal(deleted.removedClips, 1);
  assert.equal(clipById(controller.getState(), 'right'), undefined);
  assert.equal(controller.getSelection().clipIds.size, 0);

  controller.setSelection({
    trackHeaderIds: ['visual'],
    gap: { startTick: 2, endTick: 4 },
  });
  const rippled = controller.ripple();
  assert.deepEqual(rippled.shiftedClipIds, ['later']);
  assert.equal(clipById(controller.getState(), 'later').startTick, 7);

  const inserted = controller.addEmpty(1, 2);
  const insertedClipId = deterministicUuid('clip', 1);
  assert.equal(inserted.changed, true);
  assert.deepEqual(inserted.splitClipIds, [insertedClipId]);
  assert.equal(clipById(controller.getState(), 'base').outTick, 1);
  assert.equal(clipById(controller.getState(), insertedClipId).startTick, 3);
  assert.equal(clipById(controller.getState(), 'later').startTick, 9);
  assert.equal(controller.getMutationRevision(), 8);
  assert.deepEqual(validateClipTimelineState(controller.getState()), []);

  const noMove = controller.move('later', 9);
  assert.equal(noMove.changed, false);
  assert.equal(controller.getMutationRevision(), 8);
});

function selectionState() {
  return {
    tracks: [visualTrack('a'), visualTrack('b'), visualTrack('c')],
    clips: [
      visualClip('a1', 'a', 0, 2, {
        frameKeys: [
          { tick: 0, value: { cells: { '0,0': cell('A') } } },
          { tick: 1, value: { cells: { '0,0': cell('B') } } },
        ],
        propertyTracks: {
          position: [
            { tick: 0, value: { x: 0, y: 0 } },
            { tick: 1, value: { x: 1, y: 0 } },
          ],
        },
      }),
      visualClip('a2', 'a', 5, 2),
      visualClip('b1', 'b', 0, 2),
      visualClip('b2', 'b', 6, 2),
      visualClip('c2', 'c', 7, 2),
    ],
  };
}

test('selection models every target kind and scopes ripple to selected headers', () => {
  const controller = createCanonicalClipTimelineController({ initialState: selectionState() });
  controller.setSelection({
    clipIds: ['a1'],
    frameKeys: [{ clipId: 'a1', timelineTick: 1 }],
    propertyKeys: [{ clipId: 'a1', propertyName: 'position', sourceTick: 1 }],
    trackHeaderIds: ['a', 'b'],
    gap: { startTick: 2, endTick: 5 },
    rulerRange: { startTick: 1, endTick: 4 },
  });
  const selected = controller.getSelection();
  assert.deepEqual([...selected.clipIds], ['a1']);
  assert.deepEqual(selected.frameKeys, [{ clipId: 'a1', sourceTick: 1 }]);
  assert.deepEqual(selected.propertyKeys, [
    { clipId: 'a1', sourceTick: 1, propertyName: 'position' },
  ]);
  assert.deepEqual([...selected.trackHeaderIds], ['a', 'b']);
  assert.deepEqual(selected.gap, { startTick: 2, endTick: 5, trackIds: ['a', 'b'] });
  assert.deepEqual(selected.rulerRange, { startTick: 1, endTick: 4 });
  assert.deepEqual(clipTimelineSelectionTrackScope(controller.getState(), selected), {
    kind: 'gap',
    trackIds: ['a', 'b'],
  });

  const ripple = controller.ripple();
  assert.deepEqual(ripple.shiftedClipIds, ['a2', 'b2']);
  assert.equal(clipById(controller.getState(), 'a2').startTick, 2);
  assert.equal(clipById(controller.getState(), 'b2').startTick, 3);
  assert.equal(clipById(controller.getState(), 'c2').startTick, 7);
  assert.equal(controller.getSelection().gap, null);
  assert.equal(controller.getSelection().rulerRange, null);
  assert.deepEqual([...controller.getSelection().trackHeaderIds], ['a', 'b']);

  const rulerOnly = createClipTimelineSelection({
    rulerRange: { startTick: 0, endTick: 2 },
  }, controller.getState());
  assert.deepEqual(clipTimelineSelectionTrackScope(controller.getState(), rulerOnly), {
    kind: 'ruler-range',
    trackIds: ['a', 'b', 'c'],
  });
});

test('clearing every Timeline selection kind is context-only', () => {
  const controller = createCanonicalClipTimelineController({ initialState: selectionState() });
  controller.setSelection({
    clipIds: ['a1'],
    frameKeys: [{ clipId: 'a1', sourceTick: 1 }],
    propertyKeys: [{ clipId: 'a1', propertyName: 'position', sourceTick: 1 }],
    trackHeaderIds: ['a', 'b'],
    gap: { trackIds: ['a', 'b'], startTick: 2, endTick: 5 },
    rulerRange: { startTick: 1, endTick: 4 },
  });
  const before = controller.getState();
  const revision = controller.getMutationRevision();

  controller.clearSelection();

  assert.deepEqual(controller.getSelection(), emptyClipTimelineSelection());
  assert.deepEqual(controller.getState(), before);
  assert.equal(controller.getMutationRevision(), revision);
});

test('a deduplicated Razor path cuts distinct unlocked boundaries in one mutation', () => {
  const state = selectionState();
  state.tracks.find((track) => track.id === 'c').locked = true;
  const controller = createCanonicalClipTimelineController({
    initialState: state,
    makeId: createStableClipTimelineIdGenerator(),
    playheadTick: 4,
  });
  const result = controller.razorPath([
    { clipId: 'a1', tick: 1 },
    { clipId: 'a1', tick: 1 },
    { clipId: 'b1', tick: 1 },
    { clipId: 'c2', tick: 8 },
  ]);

  assert.deepEqual(result.splits.map((split) => split.originalId), ['a1', 'b1']);
  assert.equal(controller.getMutationRevision(), 1);
  assert.equal(controller.getPlayheadTick(), 4);
  assert.equal(controller.getState().clips.filter((clip) => clip.trackId === 'a').length, 3);
  assert.equal(controller.getState().clips.filter((clip) => clip.trackId === 'b').length, 3);
  assert.equal(controller.getState().clips.filter((clip) => clip.trackId === 'c').length, 1);
});

test('move, trim, and Razor preserve the playhead when duration still contains it', () => {
  const controller = createCanonicalClipTimelineController({
    initialState: operationState(),
    makeId: createStableClipTimelineIdGenerator(20),
    playheadTick: 3,
  });
  assert.equal(controller.move('later', 9).changed, true);
  assert.equal(controller.getPlayheadTick(), 3);
  assert.equal(controller.trim('base', 'end', 5).changed, true);
  assert.equal(controller.getPlayheadTick(), 3);
  assert.equal(controller.razorPath([
    { clipId: 'base', tick: 1 },
    { clipId: 'base', tick: 3 },
  ]).changed, true);
  assert.equal(controller.getPlayheadTick(), 3);
});

test('frame and property key selection drives deletion without touching unselected keys', () => {
  const controller = createCanonicalClipTimelineController({ initialState: selectionState() });
  controller.setSelection({
    frameKeys: [{ clipId: 'a1', sourceTick: 1 }],
    propertyKeys: [{ clipId: 'a1', propertyName: 'position', sourceTick: 1 }],
  });
  const revision = controller.getMutationRevision();
  const deleted = controller.deleteSelection(controller.getSelection());
  const clip = clipById(controller.getState(), 'a1');
  assert.equal(deleted.removedKeys, 2);
  assert.deepEqual(clip.frameKeys.map((key) => key.tick), [0]);
  assert.deepEqual(clip.propertyTracks.position, [{ tick: 0, value: { x: 0, y: 0 } }]);
  assert.equal(controller.getState().clips.length, 5);
  assert.deepEqual(controller.getSelection(), emptyClipTimelineSelection());
  assert.equal(controller.getMutationRevision(), revision + 1);

  const emptyDelete = controller.deleteSelection();
  assert.equal(emptyDelete.changed, false);
  assert.equal(controller.getMutationRevision(), revision + 1);
});

test('middle frame and property deletion reconnects the canonical hold and interpolation', () => {
  const controller = createCanonicalClipTimelineController({
    initialState: {
      tracks: [visualTrack('visual')],
      clips: [visualClip('clip', 'visual', 0, 5, {
        frameKeys: [
          { tick: 0, value: { cells: { '0,0': cell('A') } } },
          { tick: 2, value: { cells: { '0,0': cell('B') } } },
          { tick: 4, value: { cells: { '0,0': cell('C') } } },
        ],
        propertyTracks: {
          position: [
            { tick: 0, value: { x: 0, y: 0 } },
            { tick: 2, value: { x: 100, y: 0 } },
            { tick: 4, value: { x: 8, y: 0 } },
          ],
        },
      })],
    },
  });
  controller.setSelection({
    frameKeys: [{ clipId: 'clip', sourceTick: 2 }],
    propertyKeys: [{ clipId: 'clip', propertyName: 'position', sourceTick: 2 }],
  });
  const result = controller.deleteSelection();
  const resolved = controller.resolveLayersAtTick(2)[0];

  assert.equal(result.removedKeys, 2);
  assert.equal(resolved.cells['0,0'].c, 'A');
  assert.deepEqual(resolved.offset, { x: 4, y: 0 });
  assert.deepEqual(clipById(controller.getState(), 'clip').propertyTracks.position, [
    { tick: 0, value: { x: 0, y: 0 } },
    { tick: 4, value: { x: 8, y: 0 } },
  ]);
});

test('locked and structural tracks are excluded from header, gap, and ruler ripple scope', () => {
  const state = {
    tracks: [
      visualTrack('a'),
      visualTrack('locked', { locked: true }),
      { id: 'group', kind: 'group', propertyTracks: {} },
    ],
    clips: [visualClip('a1', 'a', 0, 2), visualClip('locked1', 'locked', 0, 2)],
  };
  assert.deepEqual(clipTimelineSelectionTrackScope(state, createClipTimelineSelection({
    trackHeaderIds: ['a', 'locked', 'group'],
  }, state)), { kind: 'track-headers', trackIds: ['a'] });
  assert.deepEqual(clipTimelineSelectionTrackScope(state, createClipTimelineSelection({
    trackHeaderIds: ['a', 'locked'],
    gap: { trackIds: ['a', 'locked'], startTick: 2, endTick: 3 },
  }, state)), { kind: 'gap', trackIds: ['a'] });
  assert.deepEqual(clipTimelineSelectionTrackScope(state, createClipTimelineSelection({
    rulerRange: { startTick: 0, endTick: 1 },
  }, state)), { kind: 'ruler-range', trackIds: ['a'] });
});

test('a blocked contextual Delete clears its selection without creating a mutation', () => {
  const controller = createCanonicalClipTimelineController({
    initialState: {
      tracks: [visualTrack('locked', { locked: true })],
      clips: [visualClip('clip', 'locked', 0, 1)],
    },
  });
  controller.setSelection({ clipIds: ['clip'], trackHeaderIds: ['locked'] });
  const result = controller.deleteSelection();

  assert.equal(result.changed, false);
  assert.equal(result.reason, 'nothing-selected');
  assert.equal(controller.getMutationRevision(), 0);
  assert.deepEqual(controller.getSelection(), emptyClipTimelineSelection());
  assert.deepEqual(result.selection, emptyClipTimelineSelection());
  assert.equal(controller.getState().clips.length, 1);
});

test('project and mutation revision guards reject stale transactions and history', () => {
  let projectRevision = 1;
  const controller = createCanonicalClipTimelineController({
    initialState: {
      tracks: [visualTrack('visual')],
      clips: [visualClip('clip', 'visual', 0, 2)],
    },
    projectRevision,
    captureProjectRevision: () => projectRevision,
    isProjectRevisionCurrent: (candidate) => candidate === projectRevision,
  });
  const history = controller.capture();
  const guard = controller.captureRevisionGuard();
  assert.equal(controller.isRevisionGuardCurrent(guard), true);

  const moved = controller.move('clip', 1, { guard });
  assert.equal(moved.changed, true);
  assert.equal(controller.isRevisionGuardCurrent(guard), false);
  const staleMutation = controller.move('clip', 2, { guard });
  assert.deepEqual({
    changed: staleMutation.changed,
    reason: staleMutation.reason,
    revision: staleMutation.mutationRevision,
  }, { changed: false, reason: 'stale-mutation', revision: 1 });

  projectRevision = 2;
  const staleProject = controller.move('clip', 2);
  assert.equal(staleProject.changed, false);
  assert.equal(staleProject.reason, 'stale-project');
  assert.equal(controller.getState().clips[0].startTick, 1);

  const initialized = controller.initializeState({
    tracks: [visualTrack('new')],
    clips: [visualClip('new-clip', 'new', 0, 1)],
  }, { projectRevision });
  assert.equal(initialized.changed, true);
  assert.equal(controller.getProjectRevision(), 2);
  assert.equal(controller.getMutationRevision(), 2);
  const staleHistory = controller.restore(history);
  assert.equal(staleHistory.changed, false);
  assert.equal(staleHistory.reason, 'stale-project');
  assert.equal(controller.getState().tracks[0].id, 'new');
});

test('gesture guards preserve Undo, Redo, replacement, and no-op mutations', () => {
  let projectRevision = 1;
  const controller = createCanonicalClipTimelineController({
    initialState: {
      tracks: [visualTrack('visual')],
      clips: [visualClip('clip', 'visual', 0, 2)],
    },
    projectRevision,
    captureProjectRevision: () => projectRevision,
    isProjectRevisionCurrent: (candidate) => candidate === projectRevision,
  });
  const initial = controller.capture();
  const noOpGuard = controller.captureRevisionGuard();
  assert.equal(controller.move('clip', 0).changed, false);
  assert.equal(controller.isRevisionGuardCurrent(noOpGuard), true,
    'a semantic no-op does not cancel an active gesture');

  assert.equal(controller.move('clip', 1).changed, true);
  const redoSnapshot = controller.capture();
  const gestureBeforeUndo = controller.captureRevisionGuard();
  assert.equal(controller.restore(initial).changed, true);
  const staleAfterUndo = controller.move('clip', 2, { guard: gestureBeforeUndo });
  assert.equal(staleAfterUndo.reason, 'stale-mutation');
  assert.equal(controller.getState().clips[0].startTick, 0,
    'the Undo that invalidated the gesture remains authoritative');
  assert.equal(controller.restore(redoSnapshot).changed, true);
  assert.equal(controller.getState().clips[0].startTick, 1,
    'the retained Redo snapshot remains restorable after the rejected gesture');

  const gestureBeforeReplacement = controller.captureRevisionGuard();
  projectRevision = 2;
  assert.equal(controller.initializeState({
    tracks: [visualTrack('replacement')],
    clips: [visualClip('replacement-clip', 'replacement', 0, 1)],
  }, { projectRevision }).changed, true);
  const staleAfterReplacement = controller.move('clip', 3, {
    guard: gestureBeforeReplacement,
  });
  assert.equal(staleAfterReplacement.reason, 'stale-project');
  assert.deepEqual(controller.getState().clips.map((clip) => clip.id), ['replacement-clip']);
});

test('canonical duplication selects fresh copies and rejects a stale gesture guard', () => {
  const controller = createCanonicalClipTimelineController({
    initialState: {
      tracks: [visualTrack('visual')],
      clips: [visualClip('source', 'visual', 0, 2)],
    },
    makeId: createStableClipTimelineIdGenerator(40),
  });
  const guard = controller.captureRevisionGuard();
  const duplicated = controller.duplicateClips([{
    clipId: 'source', targetStartTick: 2,
  }], { guard });
  const copyId = deterministicUuid('clip', 40);

  assert.equal(duplicated.changed, true);
  assert.deepEqual(duplicated.duplicatedClipIds, [copyId]);
  assert.deepEqual([...controller.getSelection().clipIds], [copyId]);
  assert.deepEqual(controller.getState().clips.map((clip) => [clip.id, clip.startTick]), [
    ['source', 0],
    [copyId, 2],
  ]);
  const stale = controller.duplicateClips([{
    clipId: 'source', targetStartTick: 4,
  }], { guard });
  assert.equal(stale.changed, false);
  assert.equal(stale.reason, 'stale-mutation');
  assert.equal(controller.getState().clips.length, 2);
});

test('validation failures expose diagnostics without publishing invalid state', () => {
  assert.throws(() => createCanonicalClipTimelineController({
    initialState: {
      tracks: [{ id: 'same' }, { id: 'same' }],
      clips: [],
    },
  }), (error) => {
    assert.equal(error instanceof ClipTimelineStateValidationError, true);
    assert.equal(error.errors.some((message) => message.includes('Duplicate timeline id')), true);
    return true;
  });

  const controller = createCanonicalClipTimelineController({
    initialState: {
      tracks: [visualTrack('visual')],
      clips: [visualClip('clip', 'visual', 0, 3)],
    },
  });
  const before = controller.getState();
  assert.throws(() => controller.transact('invalid-overlap', (state) => ({
    state: {
      ...state,
      clips: [...state.clips, visualClip('overlap', 'visual', 2, 2)],
    },
    changed: true,
  })), (error) => {
    assert.equal(error instanceof ClipTimelineStateValidationError, true);
    assert.equal(error.errors.some((message) => message.includes('overlap')), true);
    return true;
  });
  assert.deepEqual(controller.getState(), before);
  assert.equal(controller.getMutationRevision(), 0);

  assert.throws(() => controller.setSelection({ clipIds: ['missing'] }), (error) => {
    assert.equal(error instanceof ClipTimelineStateValidationError, true);
    assert.equal(error.operation, 'timeline selection');
    assert.equal(error.errors[0], 'Selected clip missing does not exist.');
    return true;
  });
  assert.throws(() => controller.timeline.set({ tracks: [] }), /clips must be an array/);
  assert.deepEqual(controller.getState(), before);
});

test('derived duration owns playhead clamping across grow, shrink, and empty state', () => {
  const controller = createCanonicalClipTimelineController({
    initialState: {
      tracks: [visualTrack('visual')],
      clips: [visualClip('clip', 'visual', 0, 6)],
    },
  });
  controller.playheadTick.set(999);
  assert.equal(get(controller.playheadTick), 5);
  controller.playheadTick.set(-50);
  assert.equal(get(controller.playheadTick), 0);
  controller.seekTick(5);
  assert.equal(get(controller.playheadTick), 5);

  controller.trim('clip', 'end', 2);
  assert.equal(get(controller.durationTicks), 2);
  assert.equal(get(controller.playheadTick), 1);
  controller.move('clip', 7);
  assert.equal(get(controller.durationTicks), 9);
  assert.equal(get(controller.playheadTick), 1);
  controller.seekTick(99);
  assert.equal(get(controller.playheadTick), 8);

  controller.removeClip('clip');
  assert.equal(get(controller.durationTicks), 1);
  assert.equal(get(controller.playheadTick), 0);
  assert.equal(controller.seekTick(Number.NaN), false);
  assert.equal(get(controller.playheadTick), 0);
});

test('canonical audio clips extend transport and remain in timeline history state', () => {
  const controller = createCanonicalClipTimelineController({
    initialState: {
      fps: 10,
      tracks: [visualTrack('visual'), { id: 'audio', kind: 'audio', name: 'Audio' }],
      clips: [
        visualClip('clip', 'visual', 0, 2),
        {
          id: 'audio-clip', trackId: 'audio', kind: 'audio', assetId: 'asset',
          startTick: 7, inPoint: 0.25, outPoint: 0.75, duration: 1,
          volume: 0.5, muted: false,
        },
      ],
    },
  });
  assert.equal(get(controller.durationTicks), 12);
  assert.equal(controller.seekTick(99), true);
  assert.equal(get(controller.playheadTick), 11);
  assert.deepEqual(controller.resolveAtTick(11), {
    id: 11,
    index: 11,
    tick: 11,
    duration: 100,
    tickDuration: 100,
    hold: 1,
    layers: [{
      id: 'layer-visual', name: 'visual', type: 'cell', visible: true,
      cells: {}, offset: { x: 0, y: 0 },
    }],
  });

  const history = controller.captureState();
  assert.equal('durationTicks' in history.state, false);
  assert.equal(history.state.clips.some((clip) => clip.kind === 'audio'), true);
  controller.removeClip('audio-clip');
  assert.equal(get(controller.durationTicks), 2);
  assert.equal(get(controller.playheadTick), 1);
  controller.restoreState(history);
  assert.equal(get(controller.durationTicks), 12);
  assert.equal(get(controller.playheadTick), 11);
});

test('sequence tags keep stable UUIDs, branch safely, and clamp when duration shrinks', () => {
  const makeId = createStableClipTimelineIdGenerator(70);
  const controller = createCanonicalClipTimelineController({
    makeId,
    initialState: {
      tracks: [visualTrack('visual')],
      clips: [visualClip('clip', 'visual', 0, 6)],
      tags: [],
    },
  });
  const start = controller.setLoopStart(0).tag;
  const end = controller.setLoopEnd(5).tag;
  const first = controller.addCustomTag(5, 'event').tag;
  const second = controller.addCustomTag(5, 'event').tag;
  assert.notEqual(first.id, second.id);
  assert.deepEqual(controller.getState().tags.map((tag) => [tag.type, tag.tick, tag.value]), [
    ['loop-start', 0, undefined],
    ['loop-end', 5, undefined],
    ['custom', 5, 'event'],
    ['custom', 5, 'event'],
  ]);

  const movedStart = controller.setLoopStart(3).tag;
  assert.equal(movedStart.id, start.id, 'moving a singleton loop marker retains its UUID');
  assert.equal(controller.getState().tags.filter((tag) => tag.type === 'loop-start').length, 1);
  const history = controller.captureState();
  assert.equal(controller.updateCustomTag(first.id, { value: '世界' }).tag.id, first.id);
  assert.equal(controller.removeTag(second.id).changed, true);
  controller.restoreState(history);
  assert.deepEqual(controller.getState().tags, history.state.tags,
    'history restores exact tag IDs and values');

  controller.removeTag(first.id);
  const branch = controller.addCustomTag(5, 'branch').tag;
  assert.notEqual(branch.id, first.id, 'a new history branch never reuses an abandoned tag UUID');
  assert.equal(controller.trim('clip', 'end', 2).changed, true);
  assert.deepEqual(controller.getState().tags.map((tag) => tag.tick), [1, 1, 1, 1]);
  assert.equal(controller.getState().tags.find((tag) => tag.id === end.id).tick, 1);
});

if (failed) {
  console.error(`${failed} canonical clip timeline state test(s) failed; ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`ok - ${passed} canonical clip timeline state tests`);
}
