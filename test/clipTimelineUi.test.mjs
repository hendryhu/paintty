import assert from 'node:assert/strict';
import {
  adaptAudioClipForTimeline,
  planAudioClipMove,
  planAudioClipTrim,
  planClipClick,
  planClipContext,
  planClipDuplicateMove,
  planClipMove,
  planClipPropertyKeyMarkers,
  planClipTrimHandleLayout,
  planTimelineKeyMarkerLayout,
  planClipTrim,
  planFrameKeyClick,
  planGapClick,
  planPropertyKeyClick,
  planRazorClick,
  planRazorDrag,
  planTimelineDelete,
  planTimelineDeleteKey,
  planTimelineKeyContext,
  planTimelineMarquee,
  planTimelinePointerIntent,
  planTrackHeaderClick,
  timelineSelectionLayerTarget,
} from '../src/lib/clipTimelineUi.js';

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

function visualClip(id, trackId, startTick, durationTicks, extra = {}) {
  return {
    id,
    trackId,
    kind: 'visual',
    startTick,
    inTick: 0,
    outTick: durationTicks,
    sourceDuration: durationTicks,
    frameKeys: [{ tick: 0 }, { tick: Math.max(0, durationTicks - 1) }],
    propertyTracks: {},
    ...extra,
  };
}

function selectionState() {
  return {
    tracks: [
      { id: 'a', kind: 'visual' },
      { id: 'b', kind: 'visual' },
      { id: 'group', kind: 'group' },
    ],
    clips: [
      visualClip('a1', 'a', 0, 3),
      visualClip('a2', 'a', 6, 2),
      visualClip('b1', 'b', 1, 3),
      visualClip('b2', 'b', 8, 2),
    ],
  };
}

test('track headers and clips support ordered range and toggle selection', () => {
  const state = selectionState();
  const firstTrack = planTrackHeaderClick(state, {}, 'a');
  const range = planTrackHeaderClick(
    state,
    firstTrack.selection,
    'group',
    { shiftKey: true },
    firstTrack.anchorTrackId,
  );
  assert.deepEqual([...range.selection.trackHeaderIds], ['a', 'b', 'group']);
  const toggled = planTrackHeaderClick(
    state,
    range.selection,
    'b',
    { ctrlKey: true },
    range.anchorTrackId,
  );
  assert.deepEqual([...toggled.selection.trackHeaderIds], ['a', 'group']);

  const firstClip = planClipClick(state, toggled.selection, 'a1');
  const clipRange = planClipClick(
    state,
    firstClip.selection,
    'b1',
    { shiftKey: true },
    firstClip.anchorClipId,
  );
  assert.deepEqual([...clipRange.selection.clipIds], ['a1', 'a2', 'b1']);
  const preserved = planClipClick(
    state,
    clipRange.selection,
    'a2',
    { preserveExisting: true },
    firstClip.anchorClipId,
  );
  assert.deepEqual([...preserved.selection.clipIds], ['a1', 'a2', 'b1']);
});

test('clip context targets one, two, or three selected clips without discarding other selection kinds', () => {
  const state = selectionState();
  state.clips[0].propertyTracks = { position: [{ tick: 0 }] };

  const one = planClipContext(state, {}, 'a1');
  assert.equal(one.deleteLabel, 'Delete clip');
  assert.equal(one.deleteCount, 1);
  assert.deepEqual([...one.selection.clipIds], ['a1']);
  assert.deepEqual([...one.deleteSelection.clipIds], ['a1']);

  const preservedSelection = {
    clipIds: ['a1', 'a2'],
    frameKeys: [{ clipId: 'a1', sourceTick: 0 }],
    propertyKeys: [{ clipId: 'a1', propertyName: 'position', sourceTick: 0 }],
    trackHeaderIds: ['a'],
    gap: { trackIds: ['a'], startTick: 3, endTick: 6 },
  };
  const two = planClipContext(state, preservedSelection, 'a1');
  assert.equal(two.deleteLabel, 'Delete 2 clips');
  assert.equal(two.deleteCount, 2);
  assert.deepEqual([...two.selection.clipIds], ['a1', 'a2']);
  assert.deepEqual(two.selection.frameKeys, preservedSelection.frameKeys);
  assert.deepEqual(two.selection.propertyKeys, preservedSelection.propertyKeys);
  assert.deepEqual(two.selection.gap, preservedSelection.gap);
  assert.deepEqual([...two.deleteSelection.clipIds], ['a1', 'a2']);

  const three = planClipContext(state, {
    ...preservedSelection,
    clipIds: ['a1', 'a2', 'b1'],
  }, 'b1');
  assert.equal(three.deleteLabel, 'Delete 3 clips');
  assert.equal(three.deleteCount, 3);

  const retargeted = planClipContext(state, preservedSelection, 'b2');
  assert.equal(retargeted.deleteLabel, 'Delete clip');
  assert.deepEqual([...retargeted.selection.clipIds], ['b2']);
  assert.deepEqual(retargeted.selection.frameKeys, []);
  assert.deepEqual(retargeted.selection.propertyKeys, []);
  assert.equal(retargeted.selection.gap, null);
  assert.equal(retargeted.selection.trackHeaderIds.size, 0);
});

test('clip context excludes locked selections and disables a locked target', () => {
  const state = selectionState();
  state.tracks.find((track) => track.id === 'b').locked = true;
  const mixed = planClipContext(state, { clipIds: ['a1', 'b1', 'b2'] }, 'a1');
  assert.equal(mixed.locked, false);
  assert.equal(mixed.deleteCount, 1);
  assert.equal(mixed.deleteLabel, 'Delete clip');
  assert.deepEqual([...mixed.deleteSelection.clipIds], ['a1']);

  const lockedSelected = planClipContext(state, { clipIds: ['a1', 'b1'] }, 'b1');
  assert.equal(lockedSelected.locked, true);
  assert.equal(lockedSelected.deleteCount, 0);
  assert.equal(lockedSelected.deleteDisabled, true);
  assert.equal(lockedSelected.deleteSelection.clipIds.size, 0);

  const lockedRetargeted = planClipContext(state, { clipIds: ['a1'] }, 'b2');
  assert.deepEqual([...lockedRetargeted.selection.clipIds], ['b2']);
  assert.equal(lockedRetargeted.deleteDisabled, true);
});

test('frame-key clicks form sparse ranges and replace clip context', () => {
  const state = selectionState();
  state.clips[0].frameKeys = [{ tick: 0 }, { tick: 2 }, { tick: 5 }];
  state.clips[0].outTick = 6;
  state.clips[0].sourceDuration = 6;
  const first = planFrameKeyClick(state, { clipIds: ['a1'] }, 'a1', 0);
  const range = planFrameKeyClick(
    state,
    first.selection,
    'a1',
    5,
    { shiftKey: true },
    first.anchor,
  );
  assert.deepEqual(range.selection.frameKeys, [
    { clipId: 'a1', sourceTick: 0 },
    { clipId: 'a1', sourceTick: 2 },
    { clipId: 'a1', sourceTick: 5 },
  ]);
  assert.equal(range.selection.clipIds.size, 0);
  const toggled = planFrameKeyClick(
    state,
    range.selection,
    'a1',
    2,
    { metaKey: true },
    range.anchor,
  );
  assert.deepEqual(toggled.selection.frameKeys, [
    { clipId: 'a1', sourceTick: 0 },
    { clipId: 'a1', sourceTick: 5 },
  ]);
});

test('clip property markers project every track through trim and viewport bounds', () => {
  const clip = visualClip('clip', 'a', 10, 8, {
    inTick: 2,
    outTick: 8,
    sourceDuration: 9,
    propertyTracks: {
      position: [{ tick: 2 }, { tick: 5 }],
      visibility: [{ tick: 3 }],
      effectIntensity: [{ tick: 4 }],
      maskPosition: [{ tick: 5 }],
      maskOpacity: [{ tick: 6 }],
      shapePath: [{ tick: 7 }],
      customScalar: [{ tick: 4 }, { tick: 8 }],
    },
  });

  const markers = planClipPropertyKeyMarkers(clip, { startTick: 11, endTick: 16 });
  assert.deepEqual(markers.map((marker) => [
    marker.propertyName,
    marker.sourceTick,
    marker.timelineTick,
    marker.stackIndex,
    marker.stackCount,
  ]), [
    ['visibility', 3, 11, 0, 1],
    ['customScalar', 4, 12, 0, 2],
    ['effectIntensity', 4, 12, 1, 2],
    ['maskPosition', 5, 13, 0, 2],
    ['position', 5, 13, 1, 2],
    ['maskOpacity', 6, 14, 0, 1],
    ['shapePath', 7, 15, 0, 1],
  ]);
  assert.equal(markers.every((marker) => marker.clipId === 'clip'), true);
});

test('frame and property hit zones stay disjoint at tick zero and adjacent ticks', () => {
  const frameMarkers = [0, 1].map((timelineTick, keyIndex) => ({
    clipId: 'dense', keyIndex, sourceTick: timelineTick, timelineTick,
  }));
  const propertyMarkers = [0, 1].flatMap((timelineTick) =>
    ['position', 'visibility', 'effectIntensity'].map((propertyName, keyIndex) => ({
      clipId: 'dense', propertyName, keyIndex, sourceTick: timelineTick, timelineTick,
    })));

  for (const { zoom, rowHeight } of [
    { zoom: 4, rowHeight: 42 },
    { zoom: 14, rowHeight: 42 },
    { zoom: 48, rowHeight: 42 },
    { zoom: 4, rowHeight: 56 },
  ]) {
    const layout = planTimelineKeyMarkerLayout(frameMarkers, propertyMarkers, {
      pixelsPerTick: zoom,
      rowHeight,
    });
    assert.equal(layout.length, 8);
    const boxes = layout.map((entry) => ({
      ...entry,
      left: entry.timelineTick * zoom + entry.left,
      right: entry.timelineTick * zoom + entry.left + entry.width,
      bottom: entry.top + entry.height,
    }));
    for (let first = 0; first < boxes.length; first++) {
      assert.ok(boxes[first].width >= 4, `zoom ${zoom} keeps a usable horizontal target`);
      assert.ok(boxes[first].height >= 6, `row ${rowHeight} keeps a usable vertical target`);
      for (let second = first + 1; second < boxes.length; second++) {
        const overlaps = boxes[first].left < boxes[second].right &&
          boxes[second].left < boxes[first].right &&
          boxes[first].top < boxes[second].bottom &&
          boxes[second].top < boxes[first].bottom;
        assert.equal(overlaps, false,
          `zoom ${zoom}, row ${rowHeight}: ${boxes[first].kind} and ${boxes[second].kind} overlap`);
      }
    }
    const tickZero = boxes.filter((entry) => entry.timelineTick === 0);
    assert.equal(tickZero.every((entry) => entry.left >= -4), true,
      'tick-zero targets stay clear of the divider hit strip inside the header');
  }
});

test('clip trim targets stay inside a final one-tick clip at every zoom and DPR', () => {
  const workspaceRight = 540;
  for (const zoom of [4, 14, 48]) {
    const clipLeft = workspaceRight - zoom;
    const handles = planClipTrimHandleLayout(zoom);
    assert.deepEqual(handles.start, {
      left: 0,
      right: Math.min(12, zoom / 2),
      width: Math.min(12, zoom / 2),
    });
    assert.deepEqual(handles.end, {
      left: zoom - Math.min(12, zoom / 2),
      right: zoom,
      width: Math.min(12, zoom / 2),
    });
    assert.equal(handles.start.left >= 0 && handles.start.right <= zoom, true);
    assert.equal(handles.end.left >= 0 && handles.end.right <= zoom, true);
    assert.equal(handles.start.right <= handles.end.left, true,
      `trim targets do not overlap at ${zoom}px zoom`);
    for (const dpr of [1, 1.25, 2]) {
      assert.equal((clipLeft + handles.end.right) * dpr <= workspaceRight * dpr, true,
        `final trim remains on the workspace side at ${zoom}px zoom and DPR ${dpr}`);
    }
  }

  const denseKeys = planTimelineKeyMarkerLayout(
    [{ clipId: 'clip', sourceTick: 0, timelineTick: 0 }],
    ['position', 'visibility', 'effectIntensity'].map((propertyName) => ({
      clipId: 'clip', propertyName, sourceTick: 0, timelineTick: 0,
    })),
    { pixelsPerTick: 4, rowHeight: 42 },
  );
  const trimTop = 42 - 10 - 8;
  assert.equal(Math.max(...denseKeys.map((key) => key.top + key.height)), trimTop,
    'dense key targets end exactly above the lower trim zone');
});

test('property-key clicks select sparse same-track ranges and combine explicit tracks', () => {
  const state = selectionState();
  state.clips[0].outTick = 6;
  state.clips[0].sourceDuration = 6;
  state.clips[0].propertyTracks = {
    position: [{ tick: 0 }, { tick: 2 }, { tick: 5 }],
    visibility: [{ tick: 1 }],
    customScalar: [{ tick: 2 }],
  };

  const first = planPropertyKeyClick(
    state,
    { clipIds: ['a1'], frameKeys: [{ clipId: 'a1', sourceTick: 0 }] },
    'a1',
    'position',
    0,
  );
  const range = planPropertyKeyClick(
    state,
    first.selection,
    'a1',
    'position',
    5,
    { shiftKey: true },
    first.anchor,
  );
  assert.deepEqual(range.selection.propertyKeys, [
    { clipId: 'a1', sourceTick: 0, propertyName: 'position' },
    { clipId: 'a1', sourceTick: 2, propertyName: 'position' },
    { clipId: 'a1', sourceTick: 5, propertyName: 'position' },
  ]);
  assert.equal(range.selection.clipIds.size, 0);
  assert.deepEqual(range.selection.frameKeys, []);

  const toggled = planPropertyKeyClick(
    state,
    range.selection,
    'a1',
    'position',
    2,
    { ctrlKey: true },
    range.anchor,
  );
  const combined = planPropertyKeyClick(
    state,
    toggled.selection,
    'a1',
    'visibility',
    1,
    { metaKey: true },
    toggled.anchor,
  );
  assert.deepEqual(combined.selection.propertyKeys, [
    { clipId: 'a1', sourceTick: 0, propertyName: 'position' },
    { clipId: 'a1', sourceTick: 5, propertyName: 'position' },
    { clipId: 'a1', sourceTick: 1, propertyName: 'visibility' },
  ]);

  const otherTrack = planPropertyKeyClick(
    state,
    combined.selection,
    'a1',
    'customScalar',
    2,
    { shiftKey: true },
    combined.anchor,
  );
  assert.deepEqual(otherTrack.selection.propertyKeys, [
    { clipId: 'a1', sourceTick: 2, propertyName: 'customScalar' },
  ]);
});

test('one, two, and three mixed key selections survive Ctrl-click and context planning', () => {
  const state = selectionState();
  state.clips[0].outTick = 3;
  state.clips[0].sourceDuration = 3;
  state.clips[0].frameKeys = [{ tick: 0 }, { tick: 2 }];
  state.clips[0].propertyTracks = Object.fromEntries([
    'position',
    'visibility',
    'effectIntensity',
    'maskPosition',
    'maskOpacity',
    'shapePath',
  ].map((name) => [name, [{ tick: 0 }, { tick: 2 }]]));

  const one = planFrameKeyClick(state, {}, 'a1', 0);
  const oneContext = planTimelineKeyContext(state, one.selection, {
    kind: 'frame', clipId: 'a1', sourceTick: 0,
  });
  assert.equal(oneContext.title, 'Frame key');
  assert.equal(oneContext.deleteLabel, 'Delete key');
  assert.equal(oneContext.deleteCount, 1);

  const two = planPropertyKeyClick(
    state,
    one.selection,
    'a1',
    'position',
    2,
    { ctrlKey: true },
  );
  assert.deepEqual(two.selection.frameKeys, [{ clipId: 'a1', sourceTick: 0 }]);
  assert.deepEqual(two.selection.propertyKeys, [
    { clipId: 'a1', sourceTick: 2, propertyName: 'position' },
  ]);
  const twoContext = planTimelineKeyContext(state, two.selection, {
    kind: 'property', clipId: 'a1', propertyName: 'position', sourceTick: 2,
  });
  assert.equal(twoContext.title, '2 keys');
  assert.equal(twoContext.deleteLabel, 'Delete 2 keys');
  assert.equal(twoContext.deleteCount, 2);
  assert.deepEqual(twoContext.selection.frameKeys, two.selection.frameKeys);
  assert.deepEqual(twoContext.selection.propertyKeys, two.selection.propertyKeys);

  const three = planPropertyKeyClick(
    state,
    two.selection,
    'a1',
    'visibility',
    0,
    { metaKey: true },
    two.anchor,
  );
  const threeContext = planTimelineKeyContext(state, three.selection, {
    kind: 'frame', clipId: 'a1', sourceTick: 0,
  });
  assert.equal(threeContext.title, '3 keys');
  assert.equal(threeContext.deleteLabel, 'Delete 3 keys');
  assert.equal(threeContext.deleteCount, 3);
  assert.deepEqual(threeContext.deleteSelection.frameKeys, [
    { clipId: 'a1', sourceTick: 0 },
  ]);
  assert.deepEqual(threeContext.deleteSelection.propertyKeys, [
    { clipId: 'a1', sourceTick: 2, propertyName: 'position' },
    { clipId: 'a1', sourceTick: 0, propertyName: 'visibility' },
  ]);

  const retargeted = planTimelineKeyContext(state, three.selection, {
    kind: 'frame', clipId: 'a1', sourceTick: 2,
  });
  assert.equal(retargeted.title, 'Frame key');
  assert.equal(retargeted.deleteLabel, 'Delete key');
  assert.deepEqual(retargeted.selection.frameKeys, [{ clipId: 'a1', sourceTick: 2 }]);
  assert.deepEqual(retargeted.selection.propertyKeys, []);

  const labels = new Map([
    ['position', 'Position key'],
    ['visibility', 'Visibility key'],
    ['effectIntensity', 'Effect intensity key'],
    ['maskPosition', 'Mask position key'],
    ['maskOpacity', 'Mask opacity key'],
    ['shapePath', 'Shape path key'],
  ]);
  for (const [propertyName, title] of labels) {
    const planned = planTimelineKeyContext(state, {}, {
      kind: 'property', clipId: 'a1', propertyName, sourceTick: 0,
    });
    assert.equal(planned.title, title);
    assert.equal(planned.deleteLabel, 'Delete key');
    assert.equal(planned.deleteCount, 1);
  }
});

test('key context excludes locked keys and disables a locked target', () => {
  const state = selectionState();
  state.tracks.find((track) => track.id === 'b').locked = true;
  state.clips[0].frameKeys = [{ tick: 0 }, { tick: 2 }];
  state.clips[2].frameKeys = [{ tick: 0 }, { tick: 2 }];
  state.clips[0].propertyTracks = { position: [{ tick: 0 }] };
  state.clips[2].propertyTracks = { position: [{ tick: 0 }] };
  const selection = {
    frameKeys: [
      { clipId: 'a1', sourceTick: 0 },
      { clipId: 'b1', sourceTick: 0 },
    ],
    propertyKeys: [
      { clipId: 'a1', propertyName: 'position', sourceTick: 0 },
      { clipId: 'b1', propertyName: 'position', sourceTick: 0 },
    ],
  };

  const editable = planTimelineKeyContext(state, selection, {
    kind: 'frame', clipId: 'a1', sourceTick: 0,
  });
  assert.equal(editable.title, '2 keys');
  assert.equal(editable.deleteCount, 2);
  assert.deepEqual(editable.deleteSelection.frameKeys, [{ clipId: 'a1', sourceTick: 0 }]);
  assert.deepEqual(editable.deleteSelection.propertyKeys, [
    { clipId: 'a1', sourceTick: 0, propertyName: 'position' },
  ]);

  const locked = planTimelineKeyContext(state, selection, {
    kind: 'frame', clipId: 'b1', sourceTick: 0,
  });
  assert.equal(locked.title, 'Frame key');
  assert.equal(locked.locked, true);
  assert.equal(locked.deleteCount, 0);
  assert.equal(locked.deleteDisabled, true);
  assert.deepEqual(locked.deleteSelection.frameKeys, []);
});

test('gap clicks intersect selected tracks and deletion retains that ripple scope', () => {
  const state = selectionState();
  const planned = planGapClick(
    state,
    { trackHeaderIds: ['a', 'b'] },
    'a',
    5,
    { maximumTick: 12 },
  );
  assert.equal(planned.kind, 'gap');
  assert.deepEqual(planned.gap, {
    trackIds: ['a', 'b'],
    startTick: 4,
    endTick: 6,
    durationTicks: 2,
  });
  const deletion = planTimelineDelete(planned.selection);
  assert.equal(deletion.kind, 'gap');
  assert.deepEqual([...deletion.selection.trackHeaderIds], ['a', 'b']);
  assert.deepEqual(deletion.selection.gap, planned.gap);
  assert.equal(planGapClick(
    state,
    { trackHeaderIds: ['a', 'b'] },
    'a',
    2,
    { maximumTick: 12 },
  ).kind, 'none');

  const hovered = planGapClick(state, {}, 'b', 5, { maximumTick: 12 });
  assert.deepEqual(hovered.gap, {
    trackIds: ['b'], startTick: 4, endTick: 8, durationTicks: 4,
  });
  assert.deepEqual([...hovered.selection.trackHeaderIds], ['b']);
});

test('gap planning excludes locked headers and never selects a locked hovered row alone', () => {
  const state = selectionState();
  state.tracks[1].locked = true;
  const scoped = planGapClick(
    state,
    { trackHeaderIds: ['a', 'b'] },
    'b',
    5,
    { maximumTick: 12 },
  );
  assert.equal(scoped.kind, 'gap');
  assert.deepEqual(scoped.gap, {
    trackIds: ['a'],
    startTick: 3,
    endTick: 6,
    durationTicks: 3,
  });
  assert.deepEqual([...scoped.selection.trackHeaderIds], ['a']);

  const lockedOnly = planGapClick(
    state,
    {},
    'b',
    5,
    { maximumTick: 12 },
  );
  assert.equal(lockedOnly.kind, 'none');
  assert.deepEqual(lockedOnly.scope.trackIds, []);
});

test('Delete plans keys before clips and clips before a selected gap', () => {
  const selection = {
    frameKeys: [{ clipId: 'a1', sourceTick: 2 }],
    propertyKeys: [{ clipId: 'a1', sourceTick: 1, propertyName: 'position' }],
    clipIds: ['a1'],
    trackHeaderIds: ['a'],
    gap: { trackIds: ['a'], startTick: 3, endTick: 6 },
  };
  const keys = planTimelineDelete(selection);
  assert.equal(keys.kind, 'keys');
  assert.equal(keys.selection.clipIds.size, 0);
  assert.equal(keys.selection.frameKeys.length, 1);
  assert.equal(keys.selection.propertyKeys.length, 1);
  const clips = planTimelineDelete({ ...selection, frameKeys: [], propertyKeys: [] });
  assert.equal(clips.kind, 'clips');
  assert.deepEqual([...clips.selection.clipIds], ['a1']);
});

test('Delete and Backspace require live Timeline context and yield to editing controls', () => {
  const selection = { clipIds: ['a1'] };
  const deletion = planTimelineDeleteKey(
    { key: 'Delete', target: { tagName: 'DIV' } },
    selection,
    { contextOwned: true },
  );
  assert.equal(deletion.handled, true);
  assert.equal(deletion.kind, 'clips');

  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    const native = planTimelineDeleteKey(
      { key: 'Backspace', target: { tagName } },
      selection,
      { contextOwned: true },
    );
    assert.equal(native.handled, false, `${tagName} should retain native deletion`);
  }
  assert.equal(planTimelineDeleteKey(
    { key: 'Delete', target: { tagName: 'DIV', isContentEditable: true } },
    selection,
    { contextOwned: true },
  ).handled, false);
  assert.equal(planTimelineDeleteKey(
    { key: 'Delete', target: { tagName: 'DIV' } },
    selection,
    { contextOwned: false },
  ).handled, false);
  const playback = planTimelineDeleteKey(
    { key: 'Delete', target: { tagName: 'DIV' } },
    selection,
    { contextOwned: true, playing: true },
  );
  assert.equal(playback.handled, true);
  assert.equal(playback.kind, 'none');
  assert.equal(planTimelineDeleteKey(
    { key: 'Delete', defaultPrevented: true, target: { tagName: 'DIV' } },
    selection,
    { contextOwned: true },
  ).handled, false);
  assert.equal(planTimelineDeleteKey(
    { key: 'Backspace', target: { tagName: 'DIV' } },
    {},
    { contextOwned: true },
  ).kind, 'none');
});

test('Razor targets one hovered clip and distinguishes locked, edge, and gap points', () => {
  const state = {
    tracks: [
      { id: 'a', kind: 'visual' },
      { id: 'b', kind: 'visual', locked: true },
      { id: 'c', kind: 'effect' },
      { id: 'group', kind: 'group' },
    ],
    clips: [
      visualClip('a1', 'a', 0, 5),
      visualClip('b1', 'b', 0, 5),
      visualClip('c1', 'c', 1, 4, { kind: 'effect' }),
    ],
  };
  assert.deepEqual(planRazorClick(state, { tick: 2, hoveredClipId: 'a1' }), {
    kind: 'razor-clip',
    tick: 2,
    clipId: 'a1',
    clipIds: ['a1'],
    trackId: 'a',
    options: {},
  });
  assert.equal(planRazorClick(state, {
    tick: 2,
    hoveredClipId: 'a1',
    shiftKey: true,
  }).clipId, 'a1', 'Shift does not widen a Razor click');
  assert.equal(planRazorClick(state, {
    tick: 2,
    hoveredTrackId: 'b',
  }).reason, 'locked');
  assert.equal(planRazorClick(state, {
    tick: 0,
    hoveredTrackId: 'a',
  }).reason, 'edge');
  assert.equal(planRazorClick(state, {
    tick: 8,
    hoveredTrackId: 'a',
  }).reason, 'gap');
  assert.equal(planRazorClick(state, { tick: null, hoveredTrackId: 'a' }).reason, 'outside');
});

test('the ruler owns transport in every tool and playback state without null wrapping', () => {
  for (const tool of ['select', 'razor', 'tag']) {
    for (const playing of [false, true]) {
      assert.deepEqual(planTimelinePointerIntent(tool, 7, {
        playing,
        editable: false,
        surface: 'ruler',
      }), { kind: 'seek', tick: 7 });
    }
    assert.deepEqual(planTimelinePointerIntent(tool, 7, { playing: true }), {
      kind: 'seek', tick: 7,
    });
  }
  assert.deepEqual(planTimelinePointerIntent('tag', 7), { kind: 'tag', tick: 7 });
  assert.deepEqual(planTimelinePointerIntent('razor', 7), { kind: 'razor', tick: 7 });
  assert.deepEqual(planTimelinePointerIntent('select', 7), { kind: 'seek', tick: 7 });
  assert.deepEqual(planTimelinePointerIntent('tag', 7, { editable: false }), { kind: 'none' });
  assert.deepEqual(planTimelinePointerIntent('razor', 7, { editable: false }), { kind: 'none' });
  assert.deepEqual(planTimelinePointerIntent('select', -1, { playing: true }), { kind: 'none' });
  assert.deepEqual(planTimelinePointerIntent('tag', null), { kind: 'none' });
});

test('Select marquee intersects unlocked clips and sparse keys across rows', () => {
  const state = selectionState();
  state.tracks[1].locked = true;
  state.clips[0].frameKeys = [{ tick: 0 }, { tick: 2 }];
  state.clips[0].propertyTracks = { position: [{ tick: 1 }, { tick: 2 }] };
  const before = structuredClone(state);
  const planned = planTimelineMarquee(state, {}, {
    startTick: 0.5,
    endTick: 3.25,
    trackIds: ['a', 'b', 'group'],
  });

  assert.equal(planned.kind, 'marquee');
  assert.deepEqual([...planned.selection.clipIds], ['a1']);
  assert.deepEqual(planned.selection.frameKeys, [{ clipId: 'a1', sourceTick: 2 }]);
  assert.deepEqual(planned.selection.propertyKeys, [
    { clipId: 'a1', sourceTick: 1, propertyName: 'position' },
    { clipId: 'a1', sourceTick: 2, propertyName: 'position' },
  ]);
  assert.deepEqual(planned.trackIds, ['a']);

  const added = planTimelineMarquee(state, { clipIds: ['a2'] }, {
    startTick: 0,
    endTick: 2,
    trackIds: ['a'],
    shiftKey: true,
  });
  assert.deepEqual([...added.selection.clipIds], ['a2', 'a1']);
  const toggled = planTimelineMarquee(state, added.selection, {
    startTick: 6,
    endTick: 7,
    trackIds: ['a'],
    ctrlKey: true,
  });
  assert.deepEqual([...toggled.selection.clipIds], ['a1']);
  const empty = planTimelineMarquee(state, added.selection, {
    startTick: 20,
    endTick: 21,
    trackIds: ['a'],
  });
  assert.equal(empty.hitCount, 0);
  assert.equal(empty.selection.clipIds.size, 0, 'an unmodified empty marquee clears selection');
  assert.deepEqual(state, before, 'discarding a marquee preview leaves canonical state exact');
});

test('Razor path follows horizontal ticks and vertical rows without duplicate or locked cuts', () => {
  const state = {
    tracks: [
      { id: 'a', kind: 'visual' },
      { id: 'b', kind: 'visual' },
      { id: 'locked', kind: 'visual', locked: true },
    ],
    clips: [
      visualClip('a1', 'a', 0, 6),
      visualClip('b1', 'b', 0, 6),
      visualClip('locked1', 'locked', 0, 6),
    ],
  };
  const rowTracks = ['a', 'b', 'locked'];
  const horizontal = planRazorDrag(state, [
    { tick: 1, row: 0.5 },
    { tick: 4, row: 0.5 },
    { tick: 2, row: 0.5 },
  ], rowTracks);
  assert.deepEqual(horizontal.cuts.map((cut) => [cut.clipId, cut.tick]), [
    ['a1', 1], ['a1', 2], ['a1', 3], ['a1', 4],
  ]);
  const vertical = planRazorDrag(state, [
    { tick: 3, row: 0.5 },
    { tick: 3, row: 2.5 },
  ], rowTracks);
  assert.deepEqual(vertical.cuts.map((cut) => [cut.clipId, cut.tick]), [
    ['a1', 3], ['b1', 3],
  ]);
  assert.equal(vertical.current.reason, 'locked');
  const edges = planRazorDrag(state, [
    { tick: 0, row: 0.5 },
    { tick: 6, row: 0.5 },
  ], rowTracks);
  assert.deepEqual(edges.cuts.map((cut) => cut.tick), [1, 2, 3, 4, 5]);
});

test('an unambiguous Timeline target identifies the active layer and property part', () => {
  const state = selectionState();
  state.tracks[0].layer = { id: 'layer-a', type: 'cell' };
  state.tracks[1].layer = { id: 'layer-b', type: 'effect', mask: {} };
  state.clips[2].propertyTracks = { maskOpacity: [{ tick: 0 }] };
  assert.deepEqual(timelineSelectionLayerTarget(state, { clipIds: ['a1'] }), {
    layerId: 'layer-a', part: 'layer',
  });
  assert.deepEqual(timelineSelectionLayerTarget(state, {
    propertyKeys: [{ clipId: 'b1', propertyName: 'maskOpacity', sourceTick: 0 }],
  }), { layerId: 'layer-b', part: 'mask' });
  assert.equal(timelineSelectionLayerTarget(state, { clipIds: ['a1', 'b1'] }), null);
  assert.equal(timelineSelectionLayerTarget(state, {
    trackHeaderIds: ['a'],
    gap: { trackIds: ['a'], startTick: 3, endTick: 4 },
  }), null);
});

test('multi-clip move snaps once, clamps as a group, and orders collision-safe commits', () => {
  const state = {
    tracks: [{ id: 'a' }, { id: 'b' }],
    clips: [
      visualClip('a-before', 'a', 0, 1),
      visualClip('a', 'a', 2, 2),
      visualClip('a-block', 'a', 8, 2),
      visualClip('b', 'b', 1, 2),
      visualClip('b-block', 'b', 7, 2),
    ],
  };
  const before = structuredClone(state);
  const plan = planClipMove(state, ['a', 'b'], 'a', 6.4, {
    playheadTick: 7,
    pixelsPerTick: 10,
  });
  assert.equal(plan.snapped.tick, 7);
  assert.equal(plan.requestedDeltaTicks, 5);
  assert.equal(plan.minimumDeltaTicks, -1);
  assert.equal(plan.maximumDeltaTicks, 4);
  assert.equal(plan.deltaTicks, 4);
  assert.deepEqual(plan.operations, [
    { clipId: 'a', targetStartTick: 6 },
    { clipId: 'b', targetStartTick: 5 },
  ]);
  const bypassed = planClipMove(state, ['a', 'b'], 'a', 6.4, {
    playheadTick: 7,
    pixelsPerTick: 10,
    altKey: true,
  });
  assert.equal(bypassed.snapped.snapped, false);
  assert.equal(bypassed.requestedDeltaTicks, 4);
  assert.deepEqual(state, before);
});

test('duplicate-move planning snaps a multi-selection and keeps originals as collision targets', () => {
  const state = {
    tracks: [{ id: 'a', kind: 'visual' }, { id: 'b', kind: 'visual' }],
    clips: [
      visualClip('a', 'a', 0, 3),
      visualClip('b', 'b', 1, 2),
    ],
  };
  const before = structuredClone(state);
  const plan = planClipDuplicateMove(state, ['a', 'b'], 'a', 2.6, {
    pixelsPerTick: 10,
  });

  assert.equal(plan.valid, true);
  assert.equal(plan.snapped.tick, 3);
  assert.equal(plan.deltaTicks, 3);
  assert.deepEqual(plan.operations, [
    { clipId: 'a', trackId: 'a', targetStartTick: 3 },
    { clipId: 'b', trackId: 'b', targetStartTick: 4 },
  ]);
  const overlap = planClipDuplicateMove(state, ['a', 'b'], 'a', 1, {
    pixelsPerTick: 10,
    altKey: true,
  });
  assert.equal(overlap.valid, false);
  assert.equal(overlap.reason, 'overlap');
  assert.deepEqual(overlap.operations.map((operation) => operation.targetStartTick), [1, 2]);
  const unselectedTarget = planClipDuplicateMove(state, ['a'], 'b', 3, {
    pixelsPerTick: 10,
    altKey: true,
  });
  assert.equal(unselectedTarget.valid, true);
  assert.deepEqual(unselectedTarget.clipIds, ['b']);
  assert.deepEqual(unselectedTarget.operations, [{
    clipId: 'b', trackId: 'b', targetStartTick: 3,
  }]);
  assert.deepEqual(state, before);
});

test('duplicate-move planning reports negative and stationary overlap but permits audio overlap', () => {
  const state = {
    tracks: [
      { id: 'visual', kind: 'visual' },
      { id: 'audio', kind: 'audio' },
    ],
    clips: [
      visualClip('source', 'visual', 2, 2),
      visualClip('stationary', 'visual', 6, 2),
      {
        id: 'audio-source', trackId: 'audio', kind: 'audio', startTick: 0,
        inTick: 0, outTick: 3, sourceDuration: 3,
      },
    ],
  };
  const negative = planClipDuplicateMove(state, ['source'], 'source', -1, {
    pixelsPerTick: 10,
    altKey: true,
  });
  assert.equal(negative.valid, false);
  assert.equal(negative.reason, 'negative-start');

  const blocked = planClipDuplicateMove(state, ['source'], 'source', 5, {
    pixelsPerTick: 10,
    altKey: true,
  });
  assert.equal(blocked.valid, false);
  assert.equal(blocked.reason, 'overlap');

  const audio = planClipDuplicateMove(state, ['audio-source'], 'audio-source', 0, {
    pixelsPerTick: 10,
    altKey: true,
  });
  assert.equal(audio.valid, true);
  assert.deepEqual(audio.operations, [{
    clipId: 'audio-source', trackId: 'audio', targetStartTick: 0,
  }]);
});

test('trim plans shared edges without changing source data and honors media bounds', () => {
  const state = {
    tracks: [{ id: 'a' }, { id: 'b' }, { id: 'video' }],
    clips: [
      visualClip('a', 'a', 0, 4),
      visualClip('a-next', 'a', 8, 2),
      visualClip('b', 'b', 1, 3),
      visualClip('b-next', 'b', 6, 2),
      visualClip('video', 'video', 10, 4, {
        kind: 'video', inTick: 1, outTick: 5, sourceDuration: 6,
      }),
    ],
  };
  const before = structuredClone(state);
  const shared = planClipTrim(state, ['a', 'b'], 'a', 'end', 9, {
    pixelsPerTick: 20,
    altKey: true,
  });
  assert.equal(shared.deltaTicks, 2);
  assert.deepEqual(shared.operations, [
    { clipId: 'a', edge: 'end', targetTick: 6 },
    { clipId: 'b', edge: 'end', targetTick: 6 },
  ]);
  const media = planClipTrim(state, ['video'], 'video', 'end', 99, {
    pixelsPerTick: 20,
    altKey: true,
  });
  assert.equal(media.maximumDeltaTicks, 1);
  assert.equal(media.targetEdgeTick, 15);
  assert.deepEqual(state, before);
});

test('trim-start cannot expose time before the earliest resolvable frame key', () => {
  const state = {
    tracks: [{ id: 'visual', kind: 'visual' }],
    clips: [visualClip('opening-moved', 'visual', 3, 3, {
      inTick: 1,
      outTick: 4,
      sourceDuration: 4,
      frameKeys: [{ tick: 1, value: { cells: {} } }],
    })],
  };
  const plan = planClipTrim(
    state,
    ['opening-moved'],
    'opening-moved',
    'start',
    2,
    { pixelsPerTick: 46, altKey: true },
  );
  assert.equal(plan.minimumDeltaTicks, 0);
  assert.equal(plan.deltaTicks, 0);
  assert.equal(plan.targetEdgeTick, 3);
  assert.deepEqual(plan.operations, [{
    clipId: 'opening-moved', edge: 'start', targetTick: 3,
  }]);
});

test('audio adapters and edit plans preserve source media while changing timeline bounds', () => {
  const clips = [
    {
      id: 'voice', trackId: 'voice-track', assetId: 'asset', startTick: 10,
      inPoint: 1, outPoint: 4, duration: 5, volume: 0.5, muted: false,
    },
    {
      id: 'music', trackId: 'music-track', assetId: 'music-asset', startTick: 5,
      inPoint: 0, outPoint: 2, duration: 2, volume: 1, muted: false,
    },
  ];
  assert.deepEqual(adaptAudioClipForTimeline(clips[0], 10), {
    id: 'audio:voice',
    audioClipId: 'voice',
    trackId: 'audio:voice-track',
    startTick: 10,
    inTick: 0,
    outTick: 30,
    sourceDuration: 30,
    frameKeys: [],
    kind: 'audio',
  });
  const moved = planAudioClipMove(clips, ['voice', 'music'], 'voice', 0, {
    fps: 10,
    pixelsPerTick: 10,
    altKey: true,
  });
  assert.equal(moved.deltaTicks, -5);
  assert.deepEqual(moved.operations.map((operation) => operation.patch.startTick), [5, 0]);

  const start = planAudioClipTrim(clips[0], 'start', 5, 10);
  assert.deepEqual(start.patch, { startTick: 5, inPoint: 0.5 });
  assert.equal(start.clip.assetId, 'asset');
  assert.equal(start.clip.outPoint, 4);
  const end = planAudioClipTrim(clips[0], 'end', 60, 10);
  assert.equal(end.targetTick, 50);
  assert.deepEqual(end.patch, { outPoint: 5 });
  assert.equal(end.clip.inPoint, 1);
});

test('canonical UI plans mixed visual and audio selection, move, Razor, and gap scope', () => {
  const state = {
    fps: 10,
    tracks: [
      { id: 'visual', kind: 'visual' },
      { id: 'audio', kind: 'audio' },
    ],
    clips: [
      visualClip('visual-clip', 'visual', 2, 2),
      {
        id: 'audio-clip', trackId: 'audio', kind: 'audio', assetId: 'asset',
        startTick: 1, inTick: 0, outTick: 4, sourceDuration: 4,
        inPoint: 0.2, outPoint: 0.6, duration: 1,
      },
      visualClip('visual-later', 'visual', 6, 2),
      {
        id: 'audio-later', trackId: 'audio', kind: 'audio', assetId: 'asset',
        startTick: 6, inTick: 0, outTick: 2, sourceDuration: 2,
        inPoint: 0.6, outPoint: 0.8, duration: 1,
      },
    ],
  };
  const firstHeader = planTrackHeaderClick(state, {}, 'visual');
  const headers = planTrackHeaderClick(
    state,
    firstHeader.selection,
    'audio',
    { shiftKey: true },
    firstHeader.anchorTrackId,
  );
  assert.deepEqual([...headers.selection.trackHeaderIds], ['visual', 'audio']);

  const move = planClipMove(
    state,
    ['visual-clip', 'audio-clip'],
    'visual-clip',
    4,
    { altKey: true, pixelsPerTick: 10 },
  );
  assert.deepEqual(move.operations, [
    { clipId: 'visual-clip', targetStartTick: 4 },
    { clipId: 'audio-clip', targetStartTick: 3 },
  ]);

  const razor = planRazorDrag(state, [
    { tick: 3, row: 0.5 },
    { tick: 3, row: 1.5 },
  ], ['visual', 'audio']);
  assert.deepEqual(razor.cuts.map((cut) => cut.clipId), ['visual-clip', 'audio-clip']);

  const gap = planGapClick(
    state,
    headers.selection,
    'audio',
    5,
    { maximumTick: 10 },
  );
  assert.deepEqual(gap.gap, {
    trackIds: ['visual', 'audio'],
    startTick: 5,
    endTick: 6,
    durationTicks: 1,
  });
});

if (failed) {
  console.error(`${failed} clip timeline UI planning test(s) failed; ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`ok - ${passed} clip timeline UI planning tests`);
}
