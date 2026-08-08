import assert from 'node:assert/strict';
import {
  addEmptyTime,
  addTimelineClip,
  addTimelineTrack,
  clipContainsTick,
  clipDurationTicks,
  clipEndTick,
  clipSourceTickAt,
  cloneClipTimelineState,
  cloneTimelineValue,
  createClipTimelineController,
  createClipTimelineState,
  createTimelineClip,
  createVisualClip,
  deleteTimelineSelection,
  duplicateTimelineClips,
  editClipProperty,
  editVisualFrame,
  emptyClipTimelineState,
  findClipAtTick,
  findContiguousGap,
  maxClipEnd,
  moveTimelineClip,
  moveTimelineKeys,
  playbackDurationTicks,
  razorSplitAtTick,
  razorSplitClip,
  removeTimelineClip,
  removeTimelineTrack,
  resizeSelectedClipEdges,
  resolveClipProperty,
  resolveClipPropertyKey,
  resolveHeldFrame,
  resolveHeldFrameKey,
  resolveHeldKey,
  rippleDeleteGap,
  shiftClipLocalKeys,
  shiftTimelineClipKeys,
  setClipTimelineFps,
  trimTimelineClip,
  updateTimelineTrack,
  validateClipTimelineState,
} from '../src/lib/clipTimeline.js';
import {
  deterministicUuid,
  deterministicUuidGenerator as createStableClipTimelineIdGenerator,
} from './projectFixture.mjs';

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

function stateWith(tracks, clips) {
  return createClipTimelineState({ tracks, clips });
}

function clipById(state, id) {
  return state.clips.find((clip) => clip.id === id);
}

function frameTicks(clip) {
  return clip.frameKeys.map((key) => key.tick);
}

test('deterministic ids are stable and counted independently by kind', () => {
  const makeId = createStableClipTimelineIdGenerator(3);
  assert.deepEqual([
    makeId('track'),
    makeId('clip'),
    makeId('track'),
    makeId('clip'),
    makeId('asset'),
  ], [
    deterministicUuid('track', 3),
    deterministicUuid('clip', 3),
    deterministicUuid('track', 4),
    deterministicUuid('clip', 4),
    deterministicUuid('asset', 3),
  ]);
});

test('visual clips normalize half-open source bounds and sparse generic tracks', () => {
  const clip = createVisualClip({
    id: 'clip-a',
    trackId: 'track-a',
    startTick: '4.4',
    inTick: 1,
    outTick: 4,
    sourceDuration: 2,
    frameKeys: [
      { tick: 3, value: { pose: 'old' } },
      { tick: 0, value: { pose: 'first' } },
      { tick: 3, value: { pose: 'last' } },
      { tick: -1, value: { pose: 'discarded' } },
    ],
    propertyTracks: {
      position: {
        2: { x: 2, y: 3 },
        0: { x: 0, y: 0 },
      },
      visible: [{ tick: 5, value: false }],
    },
  });

  assert.equal(clip.kind, 'visual');
  assert.equal(clip.startTick, 4);
  assert.equal(clip.inTick, 1);
  assert.equal(clip.outTick, 4);
  assert.equal(clip.sourceDuration, 6);
  assert.deepEqual(frameTicks(clip), [0, 3]);
  assert.equal(clip.frameKeys[1].value.pose, 'last');
  assert.deepEqual(clip.propertyTracks.position, [
    { tick: 0, value: { x: 0, y: 0 } },
    { tick: 2, value: { x: 2, y: 3 } },
  ]);
  assert.equal(clipDurationTicks(clip), 3);
  assert.equal(clipEndTick(clip), 7);
});

test('audio clips preserve source metadata and derive tick bounds from seconds', () => {
  const clip = createTimelineClip({
    id: 'audio-a',
    trackId: 'audio-track',
    kind: 'audio',
    assetId: 'asset-a',
    volume: 0.4,
    startTick: 2,
    inPoint: 0.25,
    outPoint: 0.75,
    duration: 1,
  }, undefined, 10);
  assert.deepEqual({
    kind: clip.kind,
    assetId: clip.assetId,
    volume: clip.volume,
    startTick: clip.startTick,
    endTick: clipEndTick(clip),
  }, {
    kind: 'audio',
    assetId: 'asset-a',
    volume: 0.4,
    startTick: 2,
    endTick: 7,
  });
});

test('deep cloning isolates plain data, maps, sets, typed arrays, and cycles', () => {
  const value = {
    nested: { cells: [{ glyph: 'A' }] },
    map: new Map([['key', { x: 1 }]]),
    set: new Set([{ y: 2 }]),
    bytes: new Uint8Array([1, 2, 3]),
  };
  value.self = value;
  const copy = cloneTimelineValue(value);

  assert.notEqual(copy, value);
  assert.equal(copy.self, copy);
  assert.notEqual(copy.nested, value.nested);
  assert.notEqual(copy.map.get('key'), value.map.get('key'));
  assert.notEqual([...copy.set][0], [...value.set][0]);
  assert.notEqual(copy.bytes, value.bytes);
  copy.nested.cells[0].glyph = 'B';
  copy.map.get('key').x = 9;
  copy.bytes[0] = 8;
  assert.equal(value.nested.cells[0].glyph, 'A');
  assert.equal(value.map.get('key').x, 1);
  assert.equal(value.bytes[0], 1);
});

test('held frame and property resolution uses clip-local source ticks', () => {
  const clip = createVisualClip({
    id: 'held',
    trackId: 'visual',
    startTick: 10,
    inTick: 2,
    outTick: 6,
    sourceDuration: 7,
    frameKeys: [
      { tick: 0, value: { pose: 'A' } },
      { tick: 3, value: { pose: 'B' } },
      { tick: 5, value: { pose: 'C' } },
    ],
    propertyTracks: {
      position: [
        { tick: 1, value: { x: 1 } },
        { tick: 4, value: { x: 4 } },
      ],
    },
  });

  assert.equal(clipContainsTick(clip, 9), false);
  assert.equal(clipContainsTick(clip, 10), true);
  assert.equal(clipContainsTick(clip, 13), true);
  assert.equal(clipContainsTick(clip, 14), false);
  assert.equal(clipSourceTickAt(clip, 10), 2);
  assert.equal(clipSourceTickAt(clip, 13), 5);
  assert.equal(clipSourceTickAt(clip, 14), null);
  assert.deepEqual(resolveHeldFrame(clip, 10), { pose: 'A' });
  assert.deepEqual(resolveHeldFrame(clip, 11), { pose: 'B' });
  assert.deepEqual(resolveHeldFrame(clip, 13), { pose: 'C' });
  assert.equal(resolveHeldFrame(clip, 14), null);
  assert.deepEqual(resolveClipProperty(clip, 'position', 11), { x: 1 });
  assert.deepEqual(resolveClipProperty(clip, 'position', 12), { x: 4 });

  const key = resolveHeldFrameKey(clip, 11);
  const propertyKey = resolveClipPropertyKey(clip, 'position', 12);
  key.value.pose = 'mutated read';
  propertyKey.value.x = 99;
  assert.equal(clip.frameKeys[1].value.pose, 'B');
  assert.equal(clip.propertyTracks.position[1].value.x, 4);
  assert.deepEqual(resolveHeldKey(clip.frameKeys, 4), {
    tick: 3,
    value: { pose: 'B' },
  });
});

test('editing a held tick auto-keys a deep copy before applying the edit', () => {
  const original = stateWith(
    [{ id: 'visual', kind: 'visual' }],
    [{
      id: 'clip',
      trackId: 'visual',
      kind: 'visual',
      startTick: 5,
      inTick: 0,
      outTick: 4,
      sourceDuration: 4,
      frameKeys: [
        { tick: 0, value: { cells: [1] } },
        { tick: 3, value: { cells: [3] } },
      ],
    }],
  );
  const result = editVisualFrame(original, 'visual', 6, (draft) => {
    draft.cells.push(2);
  });
  const edited = clipById(result.state, 'clip');

  assert.equal(result.createdClip, false);
  assert.equal(result.createdKey, true);
  assert.deepEqual(frameTicks(edited), [0, 1, 3]);
  assert.deepEqual(edited.frameKeys[1].value, { cells: [1, 2] });
  assert.deepEqual(original.clips[0].frameKeys[0].value, { cells: [1] });
  assert.notEqual(edited.frameKeys[1].value, edited.frameKeys[0].value);

  const exact = editVisualFrame(result.state, 'visual', 6, { cells: [9] });
  assert.equal(exact.createdKey, false);
  assert.deepEqual(frameTicks(clipById(exact.state, 'clip')), [0, 1, 3]);
  assert.deepEqual(resolveHeldFrame(clipById(exact.state, 'clip'), 6), { cells: [9] });
});

test('editing a gap creates exactly one one-tick visual clip and first frame', () => {
  const makeId = createStableClipTimelineIdGenerator();
  const original = stateWith([{ id: 'visual' }], []);
  const result = editVisualFrame(original, 'visual', 12, (draft) => {
    draft.cells.push('X');
  }, {
    makeId,
    initialValue: { cells: [] },
  });
  const clip = result.state.clips[0];

  assert.equal(result.createdClip, true);
  assert.equal(result.createdKey, true);
  assert.equal(clip.id, deterministicUuid('clip', 1));
  assert.deepEqual({
    startTick: clip.startTick,
    inTick: clip.inTick,
    outTick: clip.outTick,
    sourceDuration: clip.sourceDuration,
    endTick: clipEndTick(clip),
  }, {
    startTick: 12,
    inTick: 0,
    outTick: 1,
    sourceDuration: 1,
    endTick: 13,
  });
  assert.deepEqual(clip.frameKeys, [{ tick: 0, value: { cells: ['X'] } }]);
  assert.equal(original.clips.length, 0);
});

test('visual editing respects locked, media, and structural track ownership', () => {
  const locked = stateWith([{ id: 'locked', locked: true }], []);
  const blocked = editVisualFrame(locked, 'locked', 0, { cells: ['X'] });
  assert.equal(blocked.changed, false);
  assert.equal(blocked.reason, 'locked-track');
  assert.equal(blocked.state.clips.length, 0);

  const media = stateWith(
    [{ id: 'media', kind: 'audio' }],
    [{
      id: 'audio', trackId: 'media', kind: 'audio', startTick: 0,
      inTick: 0, outTick: 2, sourceDuration: 2,
    }],
  );
  const wrongKind = editVisualFrame(media, 'media', 0, { cells: ['X'] });
  assert.equal(wrongKind.changed, false);
  assert.equal(wrongKind.reason, 'not-visual-track');

  const emptyMedia = stateWith([{ id: 'audio', kind: 'audio' }], []);
  const noMediaClip = editVisualFrame(emptyMedia, 'audio', 3, { cells: ['X'] });
  assert.equal(noMediaClip.changed, false);
  assert.equal(noMediaClip.reason, 'not-visual-track');
  assert.equal(noMediaClip.state.clips.length, 0);

  const groups = stateWith([{ id: 'group', kind: 'group' }], []);
  const noGroupClip = editVisualFrame(groups, 'group', 3, { cells: ['X'] });
  assert.equal(noGroupClip.changed, false);
  assert.equal(noGroupClip.reason, 'not-visual-track');
  assert.equal(noGroupClip.state.clips.length, 0);
});

test('generic property edits auto-key held values inside their owning clip', () => {
  const original = stateWith(
    [{ id: 'visual' }],
    [{
      id: 'clip', trackId: 'visual', kind: 'visual', startTick: 4,
      inTick: 1, outTick: 6, sourceDuration: 7,
      frameKeys: [{ tick: 0, value: { pose: 'A' } }],
      propertyTracks: {
        position: [{ tick: 0, value: { x: 1, y: 2 } }],
      },
    }],
  );
  const result = editClipProperty(original, 'clip', 'position', 6, (draft) => {
    draft.x = 8;
  });
  const clip = clipById(result.state, 'clip');

  assert.equal(result.createdKey, true);
  assert.deepEqual(clip.propertyTracks.position.map((key) => key.tick), [0, 3]);
  assert.deepEqual(resolveClipProperty(clip, 'position', 6), { x: 8, y: 2 });
  assert.deepEqual(original.clips[0].propertyTracks.position, [
    { tick: 0, value: { x: 1, y: 2 } },
  ]);

  const visibility = editClipProperty(
    result.state,
    'clip',
    'visibility',
    7,
    false,
    { initialValue: true },
  );
  assert.deepEqual(clipById(visibility.state, 'clip').propertyTracks.visibility, [
    { tick: 4, value: false },
  ]);
});

test('visual trim reveals hidden keys and extends their final holds beyond the source', () => {
  const original = stateWith(
    [{ id: 'visual' }],
    [{
      id: 'clip', trackId: 'visual', kind: 'visual', startTick: 0,
      inTick: 0, outTick: 5, sourceDuration: 5,
      frameKeys: [
        { tick: 0, value: 'A' },
        { tick: 2, value: 'B' },
        { tick: 4, value: 'C' },
      ],
      propertyTracks: {
        opacity: [{ tick: 0, value: 1 }, { tick: 4, value: 0 }],
      },
    }],
  );
  const trimmedIn = trimTimelineClip(original, 'clip', 'start', 2);
  const trimmedOut = trimTimelineClip(trimmedIn.state, 'clip', 'end', 4);
  const trimmed = clipById(trimmedOut.state, 'clip');

  assert.deepEqual({
    startTick: trimmed.startTick,
    inTick: trimmed.inTick,
    outTick: trimmed.outTick,
    sourceDuration: trimmed.sourceDuration,
  }, { startTick: 2, inTick: 2, outTick: 4, sourceDuration: 5 });
  assert.deepEqual(frameTicks(trimmed), [0, 2, 4]);
  assert.deepEqual(trimmed.propertyTracks.opacity.map((key) => key.tick), [0, 4]);
  assert.equal(resolveHeldFrame(trimmed, 2), 'B');

  const restoredIn = trimTimelineClip(trimmedOut.state, 'clip', 'start', 0);
  const restoredOut = trimTimelineClip(restoredIn.state, 'clip', 'end', 7);
  const restored = clipById(restoredOut.state, 'clip');
  assert.deepEqual({
    startTick: restored.startTick,
    inTick: restored.inTick,
    outTick: restored.outTick,
    sourceDuration: restored.sourceDuration,
  }, { startTick: 0, inTick: 0, outTick: 7, sourceDuration: 7 });
  assert.equal(resolveHeldFrame(restored, 4), 'C');
  assert.equal(resolveHeldFrame(restored, 6), 'C');
  assert.equal(resolveClipProperty(restored, 'opacity', 6), 0);
  assert.deepEqual(original, stateWith(original.tracks, original.clips));
});

test('trim clamps to one tick, hidden source, and neighboring clips', () => {
  const state = stateWith(
    [{ id: 'visual' }],
    [
      { id: 'before', trackId: 'visual', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 2, sourceDuration: 2 },
      { id: 'clip', trackId: 'visual', kind: 'visual', startTick: 3,
        inTick: 1, outTick: 4, sourceDuration: 6 },
      { id: 'after', trackId: 'visual', kind: 'visual', startTick: 7,
        inTick: 0, outTick: 2, sourceDuration: 2 },
    ],
  );
  const left = trimTimelineClip(state, 'clip', 'start', -20);
  assert.equal(clipById(left.state, 'clip').startTick, 2);
  assert.equal(clipById(left.state, 'clip').inTick, 0);

  const right = trimTimelineClip(state, 'clip', 'end', 99);
  assert.equal(clipEndTick(clipById(right.state, 'clip')), 7);
  assert.equal(clipById(right.state, 'clip').outTick, 5);

  const minimum = trimTimelineClip(state, 'clip', 'end', 3);
  assert.equal(clipEndTick(clipById(minimum.state, 'clip')), 4);
  assert.equal(clipDurationTicks(clipById(minimum.state, 'clip')), 1);
});

test('effect right edges extend held properties while media right edges stay source-bounded', () => {
  const state = stateWith(
    [
      { id: 'effect-track', kind: 'effect' },
      { id: 'audio-track', kind: 'audio' },
      { id: 'video-track', kind: 'video' },
      { id: 'media-track', kind: 'media' },
    ],
    [
      {
        id: 'effect', trackId: 'effect-track', kind: 'effect', startTick: 0,
        inTick: 0, outTick: 2, sourceDuration: 2,
        propertyTracks: {
          intensity: [{ tick: 0, value: 0.25 }, { tick: 1, value: 0.75 }],
        },
      },
      { id: 'audio', trackId: 'audio-track', kind: 'audio', assetId: 'audio-asset',
        startTick: 0, inPoint: 0, outPoint: 1 / 24, duration: 0.125 },
      { id: 'video', trackId: 'video-track', kind: 'video', startTick: 0,
        inTick: 0, outTick: 1, sourceDuration: 3 },
      { id: 'media', trackId: 'media-track', kind: 'media', startTick: 0,
        inTick: 0, outTick: 1, sourceDuration: 3 },
    ],
  );

  const trimmedEffect = trimTimelineClip(state, 'effect', 'end', 5);
  const trimEffectClip = clipById(trimmedEffect.state, 'effect');
  assert.equal(trimEffectClip.outTick, 5);
  assert.equal(trimEffectClip.sourceDuration, 5);
  assert.equal(resolveClipProperty(trimEffectClip, 'intensity', 4), 0.75);

  const resizedEffect = resizeSelectedClipEdges(state, ['effect'], 'end', 2, 3);
  const resizeEffectClip = clipById(resizedEffect.state, 'effect');
  assert.equal(resizeEffectClip.outTick, 5);
  assert.equal(resizeEffectClip.sourceDuration, 5);
  assert.equal(resolveClipProperty(resizeEffectClip, 'intensity', 4), 0.75);

  for (const kind of ['audio', 'video', 'media']) {
    const trimmed = trimTimelineClip(state, kind, 'end', 20);
    assert.equal(clipById(trimmed.state, kind).outTick, 3);
    assert.equal(clipById(trimmed.state, kind).sourceDuration, 3);

    const resized = resizeSelectedClipEdges(state, [kind], 'end', 1, 20);
    assert.equal(resized.deltaTicks, 2);
    assert.equal(clipById(resized.state, kind).outTick, 3);
    assert.equal(clipById(resized.state, kind).sourceDuration, 3);
  }
});

test('move changes only startTick and rejects overlap atomically', () => {
  const original = stateWith(
    [{ id: 'visual' }, { id: 'other' }],
    [
      { id: 'clip', trackId: 'visual', kind: 'visual', startTick: 0,
        inTick: 1, outTick: 4, sourceDuration: 5,
        frameKeys: [{ tick: 0, value: 'A' }, { tick: 2, value: 'B' }] },
      { id: 'blocker', trackId: 'visual', kind: 'visual', startTick: 8,
        inTick: 0, outTick: 2, sourceDuration: 2 },
    ],
  );
  const moved = moveTimelineClip(original, 'clip', 4);
  const clip = clipById(moved.state, 'clip');
  assert.equal(clip.startTick, 4);
  assert.deepEqual({
    inTick: clip.inTick,
    outTick: clip.outTick,
    sourceDuration: clip.sourceDuration,
    frameKeys: clip.frameKeys,
  }, {
    inTick: 1,
    outTick: 4,
    sourceDuration: 5,
    frameKeys: original.clips[0].frameKeys,
  });
  assert.equal(resolveHeldFrame(clip, 5), 'B');
  assert.equal(original.clips[0].startTick, 0);

  const blocked = moveTimelineClip(original, 'clip', 6);
  assert.equal(blocked.changed, false);
  assert.equal(blocked.reason, 'overlap');
  assert.equal(clipById(blocked.state, 'clip').startTick, 0);

  const otherTrack = moveTimelineClip(original, 'clip', 8, { trackId: 'other' });
  assert.equal(otherTrack.changed, true);
  assert.equal(clipById(otherTrack.state, 'clip').trackId, 'other');

  const lockedSource = updateTimelineTrack(original, 'visual', { locked: true });
  const lockedMove = moveTimelineClip(lockedSource.state, 'clip', 11, { trackId: 'other' });
  assert.equal(lockedMove.changed, false);
  assert.equal(lockedMove.reason, 'locked-track');
  assert.equal(clipById(lockedMove.state, 'clip').trackId, 'visual');
});

test('clip duplication allocates fresh IDs, preserves payloads, and leaves originals untouched', () => {
  const makeId = createStableClipTimelineIdGenerator();
  const original = stateWith(
    [{ id: 'visual', kind: 'visual' }],
    [{
      id: 'source', trackId: 'visual', kind: 'visual', startTick: 1,
      inTick: 0, outTick: 2, sourceDuration: 2,
      frameKeys: [{ tick: 0, value: { cells: { '0,0': { c: 'A' } }, shape: { x0: 1 } } }],
      propertyTracks: { position: [{ tick: 0, value: { x: 4, y: 2 } }] },
      mediaMetadata: { assetId: 'retained-asset' },
    }],
  );
  const before = structuredClone(original);
  const result = duplicateTimelineClips(original, [{
    clipId: 'source', targetStartTick: 3,
  }], { makeId });
  const copy = clipById(result.state, deterministicUuid('clip', 1));

  assert.equal(result.changed, true);
  assert.deepEqual(result.duplicatedClipIds, [deterministicUuid('clip', 1)]);
  assert.notEqual(copy.id, 'source');
  assert.equal(copy.startTick, 3);
  assert.deepEqual({ ...copy, id: 'source', startTick: 1 }, clipById(original, 'source'));
  assert.notEqual(copy.frameKeys, clipById(original, 'source').frameKeys);
  assert.notEqual(copy.frameKeys[0].value, clipById(original, 'source').frameKeys[0].value);
  assert.deepEqual(original, before);
});

test('clip duplication rejects an invalid batch atomically while audio overlap remains valid', () => {
  const visual = stateWith(
    [{ id: 'visual', kind: 'visual' }, { id: 'locked', kind: 'visual', locked: true }],
    [
      { id: 'first', trackId: 'visual', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 2, sourceDuration: 2, frameKeys: [{ tick: 0, value: 'A' }] },
      { id: 'second', trackId: 'locked', kind: 'visual', startTick: 4,
        inTick: 0, outTick: 2, sourceDuration: 2, frameKeys: [{ tick: 0, value: 'B' }] },
    ],
  );
  const overlap = duplicateTimelineClips(visual, [{
    clipId: 'first', targetStartTick: 1,
  }]);
  assert.equal(overlap.changed, false);
  assert.equal(overlap.reason, 'overlap');
  assert.deepEqual(overlap.state, visual);

  const mixedFailure = duplicateTimelineClips(visual, [
    { clipId: 'first', targetStartTick: 2 },
    { clipId: 'second', targetStartTick: 6 },
  ]);
  assert.equal(mixedFailure.changed, false);
  assert.equal(mixedFailure.reason, 'locked-track');
  assert.deepEqual(mixedFailure.state, visual);

  const copiesCollide = stateWith(
    [{ id: 'same-track', kind: 'visual' }],
    [
      { id: 'left', trackId: 'same-track', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 2, sourceDuration: 2, frameKeys: [{ tick: 0, value: 'L' }] },
      { id: 'right', trackId: 'same-track', kind: 'visual', startTick: 3,
        inTick: 0, outTick: 2, sourceDuration: 2, frameKeys: [{ tick: 0, value: 'R' }] },
    ],
  );
  const selfOverlap = duplicateTimelineClips(copiesCollide, [
    { clipId: 'left', targetStartTick: 10 },
    { clipId: 'right', targetStartTick: 10 },
  ]);
  assert.equal(selfOverlap.changed, false);
  assert.equal(selfOverlap.reason, 'overlap');
  assert.deepEqual(selfOverlap.state, copiesCollide);

  const audio = createClipTimelineState({
    fps: 10,
    tracks: [{ id: 'audio', kind: 'audio' }],
    clips: [{
      id: 'voice', trackId: 'audio', kind: 'audio', assetId: 'asset', startTick: 2,
      inPoint: 0, outPoint: 0.5, duration: 1, volume: 0.75, muted: false,
    }],
  });
  const audioCopy = duplicateTimelineClips(audio, [{
    clipId: 'voice', targetStartTick: 2,
  }], { makeId: createStableClipTimelineIdGenerator(9) });
  assert.equal(audioCopy.changed, true);
  assert.equal(audioCopy.state.clips.length, 2);
  assert.deepEqual(audioCopy.state.clips.map((clip) => clip.startTick), [2, 2]);
  assert.equal(audioCopy.state.clips[1].assetId, 'asset');
  assert.deepEqual(validateClipTimelineState(audioCopy.state), []);
});

test('Razor splits at an exact source boundary with deep-independent sources', () => {
  const original = stateWith(
    [{ id: 'visual' }],
    [{
      id: 'source', trackId: 'visual', kind: 'visual', startTick: 10,
      inTick: 1, outTick: 7, sourceDuration: 8,
      frameKeys: [
        { tick: 0, value: { pose: 'A', cells: [{ c: 'A' }] } },
        { tick: 3, value: { pose: 'B', cells: [{ c: 'B' }] } },
        { tick: 6, value: { pose: 'C', cells: [{ c: 'C' }] } },
      ],
      propertyTracks: {
        position: [
          { tick: 0, value: { x: 0 } },
          { tick: 2, value: { x: 2 } },
          { tick: 6, value: { x: 6 } },
        ],
      },
    }],
  );
  const split = razorSplitClip(original, 'source', 13, { rightClipId: 'right' });
  const left = clipById(split.state, 'source');
  const right = clipById(split.state, 'right');

  assert.equal(split.sourceTick, 4);
  assert.deepEqual({
    leftStart: left.startTick,
    leftIn: left.inTick,
    leftOut: left.outTick,
    leftEnd: clipEndTick(left),
    rightStart: right.startTick,
    rightIn: right.inTick,
    rightOut: right.outTick,
    rightEnd: clipEndTick(right),
  }, {
    leftStart: 10,
    leftIn: 1,
    leftOut: 4,
    leftEnd: 13,
    rightStart: 13,
    rightIn: 4,
    rightOut: 7,
    rightEnd: 16,
  });
  assert.deepEqual(resolveHeldFrame(left, 12), { pose: 'B', cells: [{ c: 'B' }] });
  assert.deepEqual(resolveHeldFrame(right, 13), { pose: 'B', cells: [{ c: 'B' }] });
  assert.deepEqual(resolveClipProperty(right, 'position', 13), { x: 2 });
  assert.equal(right.frameKeys.some((key) => key.tick === 4), true);
  assert.equal(right.propertyTracks.position.some((key) => key.tick === 4), true);
  assert.equal(left.frameKeys.some((key) => key.tick === 6), true);
  assert.equal(right.frameKeys.some((key) => key.tick === 0), true);

  right.frameKeys.find((key) => key.tick === 4).value.cells[0].c = 'R';
  right.propertyTracks.position.find((key) => key.tick === 4).value.x = 99;
  assert.equal(left.frameKeys.find((key) => key.tick === 3).value.cells[0].c, 'B');
  assert.equal(left.propertyTracks.position.find((key) => key.tick === 2).value.x, 2);
  assert.equal(original.clips[0].frameKeys[1].value.cells[0].c, 'B');
  assert.notEqual(left.frameKeys, right.frameKeys);
  assert.notEqual(left.propertyTracks.position, right.propertyTracks.position);
});

test('Razor rejects clip edges without consuming a deterministic id', () => {
  const makeId = createStableClipTimelineIdGenerator();
  const state = stateWith(
    [{ id: 'visual' }],
    [{ id: 'source', trackId: 'visual', kind: 'visual', startTick: 2,
      inTick: 0, outTick: 3, sourceDuration: 3 }],
  );
  const edge = razorSplitClip(state, 'source', 2, { makeId });
  assert.equal(edge.changed, false);
  const valid = razorSplitClip(state, 'source', 3, { makeId });
  assert.equal(valid.right.id, deterministicUuid('clip', 1));
});

test('multi-track Razor splits every crossing unlocked clip only', () => {
  const makeId = createStableClipTimelineIdGenerator();
  const state = stateWith(
    [
      { id: 'one' },
      { id: 'locked', locked: true },
      { id: 'three' },
    ],
    [
      { id: 'a', trackId: 'one', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 5, sourceDuration: 5 },
      { id: 'b', trackId: 'locked', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 5, sourceDuration: 5 },
      { id: 'c', trackId: 'three', kind: 'visual', startTick: 1,
        inTick: 0, outTick: 4, sourceDuration: 4 },
      { id: 'd', trackId: 'three', kind: 'visual', startTick: 8,
        inTick: 0, outTick: 2, sourceDuration: 2 },
    ],
  );
  const split = razorSplitAtTick(state, 3, { allUnlocked: true, makeId });

  assert.equal(split.changed, true);
  assert.deepEqual(split.splits.map((entry) => entry.originalId), ['a', 'c']);
  assert.deepEqual(split.splits.map((entry) => entry.rightId), [
    deterministicUuid('clip', 1),
    deterministicUuid('clip', 2),
  ]);
  assert.equal(split.state.clips.filter((clip) => clip.trackId === 'one').length, 2);
  assert.equal(split.state.clips.filter((clip) => clip.trackId === 'locked').length, 1);
  assert.equal(split.state.clips.filter((clip) => clip.trackId === 'three').length, 3);
});

test('mixed-track Razor splits visual and audio clips with one project-tick boundary', () => {
  const state = createClipTimelineState({
    fps: 10,
    tracks: [
      { id: 'visual', kind: 'visual' },
      { id: 'audio', kind: 'audio' },
      { id: 'locked-audio', kind: 'audio', locked: true },
    ],
    clips: [
      {
        id: 'visual-clip', trackId: 'visual', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 6, sourceDuration: 6,
        frameKeys: [{ tick: 0, value: 'A' }],
      },
      {
        id: 'audio-clip', trackId: 'audio', kind: 'audio', assetId: 'audio-asset',
        startTick: 1, inPoint: 0.2, outPoint: 0.7, duration: 1,
        volume: 0.8, muted: false,
      },
      {
        id: 'locked-clip', trackId: 'locked-audio', kind: 'audio', assetId: 'locked-asset',
        startTick: 0, inPoint: 0, outPoint: 1, duration: 1,
      },
    ],
  });
  const result = razorSplitAtTick(state, 3, {
    allUnlocked: true,
    makeId: createStableClipTimelineIdGenerator(),
  });

  assert.deepEqual(result.splits.map((split) => split.originalId), [
    'visual-clip',
    'audio-clip',
  ]);
  const audioPieces = result.state.clips
    .filter((clip) => clip.trackId === 'audio')
    .sort((first, second) => first.startTick - second.startTick);
  assert.equal(audioPieces.length, 2);
  assert.equal(audioPieces[0].outPoint, 0.4);
  assert.equal(audioPieces[1].inPoint, 0.4);
  assert.equal(audioPieces[1].startTick, 3);
  assert.deepEqual(audioPieces.map((clip) => [
    clip.startTick,
    clip.startTick + clipDurationTicks(clip),
  ]), [[1, 3], [3, 6]]);
  assert.deepEqual(validateClipTimelineState(result.state), []);
  assert.equal(result.state.clips.filter((clip) => clip.trackId === 'locked-audio').length, 1);
});

test('audio move, trim, split, and FPS changes keep source seconds canonical', () => {
  const original = createClipTimelineState({
    fps: 10,
    tracks: [{ id: 'audio', kind: 'audio' }],
    clips: [{
      id: 'clip', trackId: 'audio', kind: 'audio', assetId: 'asset',
      startTick: 3, inPoint: 0.25, outPoint: 1.25, duration: 2,
      volume: 0.6, muted: false,
    }],
  });
  const moved = moveTimelineClip(original, 'clip', 5);
  const trimmedIn = trimTimelineClip(moved.state, 'clip', 'start', 7);
  const trimmedOut = trimTimelineClip(trimmedIn.state, 'clip', 'end', 12);
  const split = razorSplitClip(trimmedOut.state, 'clip', 9, { rightClipId: 'right' });
  const beforeFps = split.state.clips.map((clip) => ({
    id: clip.id,
    startTick: clip.startTick,
    inPoint: clip.inPoint,
    outPoint: clip.outPoint,
  }));
  const retimed = setClipTimelineFps(split.state, 20);

  assert.deepEqual(beforeFps, [
    { id: 'clip', startTick: 7, inPoint: 0.45, outPoint: 0.65 },
    { id: 'right', startTick: 9, inPoint: 0.65, outPoint: 0.95 },
  ]);
  assert.deepEqual(retimed.state.clips.map((clip) => ({
    id: clip.id,
    startTick: clip.startTick,
    inPoint: clip.inPoint,
    outPoint: clip.outPoint,
    durationTicks: clipDurationTicks(clip),
  })), [
    { id: 'clip', startTick: 7, inPoint: 0.45, outPoint: 0.65, durationTicks: 4 },
    { id: 'right', startTick: 9, inPoint: 0.65, outPoint: 0.95, durationTicks: 6 },
  ]);
  assert.deepEqual(validateClipTimelineState(retimed.state), []);
});

test('selected middle frame/property deletion reconnects preceding holds', () => {
  const state = stateWith(
    [{ id: 'visual' }],
    [
      {
        id: 'clip', trackId: 'visual', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 6, sourceDuration: 6,
        frameKeys: [
          { tick: 0, value: 'A' },
          { tick: 2, value: 'B' },
          { tick: 4, value: 'C' },
        ],
        propertyTracks: {
          opacity: [{ tick: 1, value: 1 }, { tick: 3, value: 0.5 }],
        },
      },
      { id: 'later', trackId: 'visual', kind: 'visual', startTick: 8,
        inTick: 0, outTick: 2, sourceDuration: 2 },
    ],
  );
  const keysDeleted = deleteTimelineSelection(state, {
    keys: [
      { clipId: 'clip', kind: 'frame', sourceTick: 2 },
      { clipId: 'clip', kind: 'property', propertyName: 'opacity', sourceTick: 3 },
    ],
  });
  const clip = clipById(keysDeleted.state, 'clip');

  assert.equal(keysDeleted.removedKeys, 2);
  assert.deepEqual(frameTicks(clip), [0, 4]);
  assert.equal(resolveHeldFrame(clip, 3), 'A');
  assert.deepEqual(clip.propertyTracks.opacity, [{ tick: 1, value: 1 }]);
  assert.deepEqual(frameTicks(state.clips[0]), [0, 2, 4]);

  const clipDeleted = deleteTimelineSelection(keysDeleted.state, { clipIds: ['clip'] });
  assert.equal(clipDeleted.removedClips, 1);
  assert.equal(findClipAtTick(clipDeleted.state, 'visual', 2), null);
  assert.equal(clipById(clipDeleted.state, 'later').startTick, 8);
});

test('deleting the first visible frame key advances the clip to create real blank time', () => {
  const state = stateWith(
    [{ id: 'visual' }],
    [{
      id: 'clip', trackId: 'visual', kind: 'visual', startTick: 10,
      inTick: 2, outTick: 8, sourceDuration: 8,
      frameKeys: [
        { tick: 2, value: 'A' },
        { tick: 5, value: 'B' },
        { tick: 7, value: 'C' },
      ],
    }],
  );
  const originalEnd = clipEndTick(clipById(state, 'clip'));
  const deleted = deleteTimelineSelection(state, {
    frameKeys: [{ clipId: 'clip', sourceTick: 2 }],
  });
  const clip = clipById(deleted.state, 'clip');

  assert.deepEqual({
    changed: deleted.changed,
    removedKeys: deleted.removedKeys,
    removedClips: deleted.removedClips,
  }, { changed: true, removedKeys: 1, removedClips: 0 });
  assert.deepEqual({
    startTick: clip.startTick,
    inTick: clip.inTick,
    outTick: clip.outTick,
    endTick: clipEndTick(clip),
  }, { startTick: 13, inTick: 5, outTick: 8, endTick: originalEnd });
  assert.equal(findClipAtTick(deleted.state, 'visual', 12), null);
  assert.equal(findClipAtTick(deleted.state, 'visual', 13).id, 'clip');
  assert.equal(resolveHeldFrame(clip, 13), 'B');
  assert.deepEqual(frameTicks(clip), [5, 7]);
});

test('a hidden pre-in frame keeps the clip resolved when its first visible key is deleted', () => {
  const state = stateWith(
    [{ id: 'visual' }],
    [{
      id: 'clip', trackId: 'visual', kind: 'visual', startTick: 10,
      inTick: 2, outTick: 6, sourceDuration: 6,
      frameKeys: [
        { tick: 0, value: 'hidden' },
        { tick: 2, value: 'visible' },
        { tick: 4, value: 'later' },
      ],
    }],
  );
  const deleted = deleteTimelineSelection(state, {
    frameKeys: [{ clipId: 'clip', sourceTick: 2 }],
  });
  const clip = clipById(deleted.state, 'clip');

  assert.equal(clip.startTick, 10);
  assert.equal(clip.inTick, 2);
  assert.deepEqual(frameTicks(clip), [0, 4]);
  assert.equal(resolveHeldFrame(clip, 10), 'hidden');
  assert.deepEqual(validateClipTimelineState(deleted.state), []);
});

test('deleting the only visible frame removes its clip in the same transaction', () => {
  const initialState = stateWith(
    [{ id: 'visual' }],
    [{
      id: 'clip', trackId: 'visual', kind: 'visual', startTick: 4,
      inTick: 1, outTick: 4, sourceDuration: 4,
      frameKeys: [{ tick: 1, value: 'only' }],
    }],
  );
  const controller = createClipTimelineController({ initialState });
  const deleted = controller.deleteSelection({
    frameKeys: [{ clipId: 'clip', sourceTick: 1 }],
  });

  assert.deepEqual({
    changed: deleted.changed,
    removedKeys: deleted.removedKeys,
    removedClips: deleted.removedClips,
    remainingClips: deleted.state.clips.length,
  }, { changed: true, removedKeys: 1, removedClips: 1, remainingClips: 0 });
  assert.equal(initialState.clips.length, 1);
  assert.equal(controller.getState().clips.length, 0);
});

test('video frame-key deletion advances its start and removes its final unresolved clip', () => {
  const state = stateWith(
    [{ id: 'video', kind: 'video' }],
    [{
      id: 'video-clip', trackId: 'video', kind: 'video', startTick: 10,
      inTick: 2, outTick: 6, sourceDuration: 6,
      frameKeys: [
        { tick: 2, value: { frame: 'first' } },
        { tick: 4, value: { frame: 'second' } },
      ],
    }],
  );
  const advanced = deleteTimelineSelection(state, {
    frameKeys: [{ clipId: 'video-clip', sourceTick: 2 }],
  });
  const clip = clipById(advanced.state, 'video-clip');
  assert.deepEqual({
    startTick: clip.startTick,
    inTick: clip.inTick,
    endTick: clipEndTick(clip),
    frameTicks: frameTicks(clip),
  }, { startTick: 12, inTick: 4, endTick: 14, frameTicks: [4] });
  assert.deepEqual(validateClipTimelineState(advanced.state), []);

  const removed = deleteTimelineSelection(advanced.state, {
    frameKeys: [{ clipId: 'video-clip', sourceTick: 4 }],
  });
  assert.equal(removed.removedKeys, 1);
  assert.equal(removed.removedClips, 1);
  assert.deepEqual(removed.state.clips, []);
  assert.deepEqual(removed.state.tracks.map((track) => track.id), ['video']);
});

test('earliest and final property-key deletion preserves clip bounds and neighboring metadata', () => {
  const state = stateWith(
    [{ id: 'visual' }],
    [{
      id: 'clip', trackId: 'visual', kind: 'visual', startTick: 3,
      inTick: 0, outTick: 5, sourceDuration: 5,
      frameKeys: [{ tick: 0, value: 'A' }],
      propertyTracks: {
        position: [
          { tick: 0, value: { x: 0, y: 0 }, temporalEase: { out: { x: 0.2, y: 0.3 } } },
          { tick: 2, value: { x: 2, y: 0 } },
          { tick: 4, value: { x: 8, y: 0 }, temporalEase: { in: { x: 0.8, y: 0.7 } } },
        ],
      },
    }],
  );
  const earliest = deleteTimelineSelection(state, {
    propertyKeys: [{ clipId: 'clip', propertyName: 'position', sourceTick: 0 }],
  });
  const final = deleteTimelineSelection(earliest.state, {
    propertyKeys: [{ clipId: 'clip', propertyName: 'position', sourceTick: 4 }],
  });
  const clip = clipById(final.state, 'clip');

  assert.equal(earliest.removedKeys, 1);
  assert.equal(final.removedKeys, 1);
  assert.deepEqual({ startTick: clip.startTick, inTick: clip.inTick, outTick: clip.outTick }, {
    startTick: 3, inTick: 0, outTick: 5,
  });
  assert.deepEqual(clip.frameKeys, [{ tick: 0, value: 'A' }]);
  assert.deepEqual(clip.propertyTracks.position, [{ tick: 2, value: { x: 2, y: 0 } }]);
});

test('key deletion accepts timeline coordinates and no selection is a no-op', () => {
  const state = stateWith(
    [{ id: 'visual' }],
    [{
      id: 'clip', trackId: 'visual', kind: 'visual', startTick: 5,
      inTick: 2, outTick: 6, sourceDuration: 6,
      frameKeys: [{ tick: 2, value: 'A' }, { tick: 4, value: 'B' }],
    }],
  );
  const deleted = deleteTimelineSelection(state, {
    frameKeys: [{ clipId: 'clip', timelineTick: 7 }],
  });
  assert.deepEqual(frameTicks(clipById(deleted.state, 'clip')), [2]);

  const none = deleteTimelineSelection(state, {});
  assert.equal(none.changed, false);
  assert.equal(none.reason, 'nothing-selected');
  assert.deepEqual(none.state, state);
  assert.notEqual(none.state, state);
});

test('selected clips and keys on locked tracks are not deleted', () => {
  const state = stateWith(
    [{ id: 'locked', locked: true }],
    [{
      id: 'clip', trackId: 'locked', kind: 'visual', startTick: 0,
      inTick: 0, outTick: 2, sourceDuration: 2,
      frameKeys: [{ tick: 0, value: 'A' }, { tick: 1, value: 'B' }],
    }],
  );
  const clipDelete = deleteTimelineSelection(state, { clipIds: ['clip'] });
  const keyDelete = deleteTimelineSelection(state, {
    frameKeys: [{ clipId: 'clip', sourceTick: 1 }],
  });
  assert.equal(clipDelete.changed, false);
  assert.equal(keyDelete.changed, false);
  assert.equal(clipDelete.state.clips.length, 1);
  assert.deepEqual(frameTicks(keyDelete.state.clips[0]), [0, 1]);
});

test('mixed frame and property key motion is immutable, collision-safe, and preserves values', () => {
  const state = stateWith(
    [{ id: 'visual' }],
    [{
      id: 'clip', trackId: 'visual', kind: 'visual', startTick: 5,
      inTick: 1, outTick: 7, sourceDuration: 7,
      frameKeys: [
        { tick: 1, value: { pose: 'held' } },
        { tick: 3, value: { pose: 'move' } },
        { tick: 6, value: { pose: 'tail' } },
      ],
      propertyTracks: {
        position: [{ tick: 2, value: { x: 2 } }, { tick: 5, value: { x: 5 } }],
        visibility: [{ tick: 4, value: false }],
        effectIntensity: [{ tick: 3, value: 0.25 }],
        maskPosition: [{ tick: 2, value: { x: 1, y: 2 } }],
        maskOpacity: [{ tick: 4, value: 0.5 }],
        shapePath: [{ tick: 5, value: { path: { kind: 'line' } } }],
      },
    }],
  );
  const selection = {
    frameKeys: [{ clipId: 'clip', sourceTick: 3 }],
    propertyKeys: [
      { clipId: 'clip', propertyName: 'position', sourceTick: 2 },
      { clipId: 'clip', propertyName: 'visibility', sourceTick: 4 },
      { clipId: 'clip', propertyName: 'effectIntensity', sourceTick: 3 },
      { clipId: 'clip', propertyName: 'maskPosition', sourceTick: 2 },
      { clipId: 'clip', propertyName: 'maskOpacity', sourceTick: 4 },
      { clipId: 'clip', propertyName: 'shapePath', sourceTick: 5 },
    ],
  };
  const moved = moveTimelineKeys(state, selection, 1);
  const clip = clipById(moved.state, 'clip');

  assert.equal(moved.changed, true);
  assert.equal(moved.deltaTicks, 1);
  assert.deepEqual(frameTicks(clip), [1, 4, 6]);
  assert.deepEqual(Object.fromEntries(Object.entries(clip.propertyTracks)
    .map(([name, keys]) => [name, keys.map((key) => key.tick)])), {
    position: [3, 5],
    visibility: [5],
    effectIntensity: [4],
    maskPosition: [3],
    maskOpacity: [5],
    shapePath: [6],
  });
  assert.deepEqual(clip.frameKeys.find((key) => key.tick === 4).value, { pose: 'move' });
  assert.deepEqual(clip.propertyTracks.shapePath[0].value, { path: { kind: 'line' } });
  assert.deepEqual(frameTicks(clipById(state, 'clip')), [1, 3, 6]);
  assert.deepEqual(moved.selection.frameKeys, [{ clipId: 'clip', sourceTick: 4 }]);

  const collision = moveTimelineKeys(state, {
    propertyKeys: [{ clipId: 'clip', propertyName: 'position', sourceTick: 2 }],
  }, 3);
  assert.equal(collision.changed, false);
  assert.equal(collision.reason, 'key-collision');
  assert.deepEqual(collision.state, state);
});

test('moving an opening frame advances clip source/project bounds without changing its end', () => {
  const state = stateWith(
    [{ id: 'visual' }],
    [{
      id: 'clip', trackId: 'visual', kind: 'visual', startTick: 5,
      inTick: 0, outTick: 4, sourceDuration: 4,
      frameKeys: [{ tick: 0, value: 'A' }, { tick: 3, value: 'B' }],
      propertyTracks: { position: [{ tick: 0, value: { x: 0 } }] },
    }],
  );
  const moved = moveTimelineKeys(state, {
    frameKeys: [{ clipId: 'clip', sourceTick: 0 }],
  }, 1);
  const clip = clipById(moved.state, 'clip');

  assert.equal(moved.changed, true);
  assert.deepEqual(frameTicks(clip), [1, 3]);
  assert.deepEqual({ startTick: clip.startTick, inTick: clip.inTick, endTick: clipEndTick(clip) }, {
    startTick: 6, inTick: 1, endTick: 9,
  });
  assert.deepEqual(clip.propertyTracks.position, [{ tick: 0, value: { x: 0 } }]);
  assert.deepEqual(moved.selection.frameKeys, [{ clipId: 'clip', sourceTick: 1 }]);
  assert.deepEqual(validateClipTimelineState(moved.state), []);
});

test('contiguous gap discovery returns maximal single/common and trailing gaps', () => {
  const state = stateWith(
    [{ id: 'a' }, { id: 'b' }, { id: 'empty' }],
    [
      { id: 'a1', trackId: 'a', startTick: 0, inTick: 0, outTick: 2, sourceDuration: 2 },
      { id: 'a2', trackId: 'a', startTick: 5, inTick: 0, outTick: 2, sourceDuration: 2 },
      { id: 'b1', trackId: 'b', startTick: 0, inTick: 0, outTick: 3, sourceDuration: 3 },
      { id: 'b2', trackId: 'b', startTick: 6, inTick: 0, outTick: 2, sourceDuration: 2 },
    ],
  );

  assert.deepEqual(findContiguousGap(state, 'a', 3), {
    trackIds: ['a'],
    startTick: 2,
    endTick: 5,
    durationTicks: 3,
  });
  assert.deepEqual(findContiguousGap(state, ['a', 'b'], 4), {
    trackIds: ['a', 'b'],
    startTick: 3,
    endTick: 5,
    durationTicks: 2,
  });
  assert.equal(findContiguousGap(state, ['a', 'b'], 2), null);
  assert.deepEqual(findContiguousGap(state, ['a', 'b'], 9), {
    trackIds: ['a', 'b'],
    startTick: 8,
    endTick: Infinity,
    durationTicks: Infinity,
  });
  assert.deepEqual(findContiguousGap(state, 'empty', 0, { endTick: 12 }), {
    trackIds: ['empty'],
    startTick: 0,
    endTick: 12,
    durationTicks: 12,
  });
});

test('ripple-delete shifts later clips equally on only selected track ids', () => {
  const state = stateWith(
    [{ id: 'a' }, { id: 'b' }, { id: 'unselected' }],
    [
      { id: 'a1', trackId: 'a', startTick: 0, inTick: 0, outTick: 3, sourceDuration: 3 },
      { id: 'a2', trackId: 'a', startTick: 5, inTick: 0, outTick: 2, sourceDuration: 2 },
      { id: 'b1', trackId: 'b', startTick: 0, inTick: 0, outTick: 3, sourceDuration: 3 },
      { id: 'b2', trackId: 'b', startTick: 6, inTick: 0, outTick: 2, sourceDuration: 2 },
      { id: 'u', trackId: 'unselected', startTick: 7, inTick: 0, outTick: 2, sourceDuration: 2 },
    ],
  );
  const ripple = rippleDeleteGap(state, ['a', 'b'], 3, 5);

  assert.equal(ripple.changed, true);
  assert.equal(ripple.deltaTicks, -2);
  assert.deepEqual(ripple.shiftedClipIds, ['a2', 'b2']);
  assert.equal(clipById(ripple.state, 'a2').startTick, 3);
  assert.equal(clipById(ripple.state, 'b2').startTick, 4);
  assert.equal(clipById(ripple.state, 'u').startTick, 7);
  assert.equal(clipById(state, 'a2').startTick, 5);
});

test('selected visual and audio track gaps ripple together', () => {
  const state = createClipTimelineState({
    fps: 10,
    tracks: [
      { id: 'visual', kind: 'visual' },
      { id: 'audio', kind: 'audio' },
      { id: 'untouched', kind: 'visual' },
    ],
    clips: [
      { id: 'visual-first', trackId: 'visual', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 2, sourceDuration: 2, frameKeys: [{ tick: 0, value: 'A' }] },
      { id: 'visual-later', trackId: 'visual', kind: 'visual', startTick: 5,
        inTick: 0, outTick: 2, sourceDuration: 2, frameKeys: [{ tick: 0, value: 'B' }] },
      { id: 'audio-later', trackId: 'audio', kind: 'audio', assetId: 'asset',
        startTick: 5, inPoint: 0, outPoint: 0.2, duration: 0.2 },
      { id: 'untouched-clip', trackId: 'untouched', kind: 'visual', startTick: 6,
        inTick: 0, outTick: 1, sourceDuration: 1, frameKeys: [{ tick: 0, value: 'U' }] },
    ],
  });
  const result = deleteTimelineSelection(state, {
    trackIds: ['visual', 'audio'],
    gap: { trackIds: ['visual', 'audio'], startTick: 2, endTick: 5 },
  });

  assert.deepEqual(result.shiftedClipIds, ['visual-later', 'audio-later']);
  assert.equal(clipById(result.state, 'visual-later').startTick, 2);
  assert.deepEqual({
    startTick: clipById(result.state, 'audio-later').startTick,
    inPoint: clipById(result.state, 'audio-later').inPoint,
    outPoint: clipById(result.state, 'audio-later').outPoint,
    outTick: clipById(result.state, 'audio-later').outTick,
  }, { startTick: 2, inPoint: 0, outPoint: 0.2, outTick: 2 });
  assert.equal(clipById(result.state, 'untouched-clip').startTick, 6);
});

test('contextual audio Delete removes only selected clips and empty audio rows', () => {
  const state = createClipTimelineState({
    fps: 10,
    tracks: [{ id: 'visual' }, { id: 'audio', kind: 'audio' }],
    clips: [
      { id: 'visual-clip', trackId: 'visual', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 2, sourceDuration: 2, frameKeys: [{ tick: 0, value: 'V' }] },
      { id: 'audio-clip', trackId: 'audio', kind: 'audio', assetId: 'asset',
        startTick: 0, inPoint: 0, outPoint: 0.2, duration: 0.2 },
    ],
  });
  const result = deleteTimelineSelection(state, { clipIds: ['audio-clip'] });

  assert.equal(result.removedClips, 1);
  assert.deepEqual(result.removedTrackIds, ['audio']);
  assert.deepEqual(result.state.tracks.map((track) => track.id), ['visual']);
  assert.deepEqual(result.state.clips.map((clip) => clip.id), ['visual-clip']);
});

test('mixed multi-clip Delete leaves time in place and removes only newly empty audio rows', () => {
  const state = createClipTimelineState({
    fps: 10,
    tracks: [
      { id: 'visual', kind: 'visual' },
      { id: 'video', kind: 'video' },
      { id: 'audio', kind: 'audio' },
      { id: 'empty-audio', kind: 'audio' },
      { id: 'locked', kind: 'visual', locked: true },
    ],
    clips: [
      { id: 'visual-selected', trackId: 'visual', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 1, sourceDuration: 1, frameKeys: [{ tick: 0, value: 'V' }] },
      { id: 'visual-later', trackId: 'visual', kind: 'visual', startTick: 5,
        inTick: 0, outTick: 2, sourceDuration: 2, frameKeys: [{ tick: 0, value: 'L' }] },
      { id: 'video-selected', trackId: 'video', kind: 'video', startTick: 1,
        inTick: 0, outTick: 2, sourceDuration: 2, frameKeys: [{ tick: 0, value: 'M' }] },
      { id: 'audio-selected', trackId: 'audio', kind: 'audio', assetId: 'asset',
        startTick: 2, inPoint: 0.25, outPoint: 0.45, duration: 1 },
      { id: 'audio-later', trackId: 'audio', kind: 'audio', assetId: 'asset',
        startTick: 8, inPoint: 0.45, outPoint: 0.75, duration: 1 },
      { id: 'locked-selected', trackId: 'locked', kind: 'visual', startTick: 3,
        inTick: 0, outTick: 1, sourceDuration: 1, frameKeys: [{ tick: 0, value: 'K' }] },
    ],
  });
  const mixed = deleteTimelineSelection(state, {
    clipIds: ['visual-selected', 'video-selected', 'audio-selected', 'locked-selected'],
  });

  assert.equal(mixed.removedClips, 3);
  assert.deepEqual(mixed.removedTrackIds, []);
  assert.deepEqual(mixed.state.clips.map((clip) => [clip.id, clip.startTick]), [
    ['visual-later', 5],
    ['audio-later', 8],
    ['locked-selected', 3],
  ]);
  assert.deepEqual(mixed.state.tracks.map((track) => track.id), [
    'visual', 'video', 'audio', 'empty-audio', 'locked',
  ]);

  const finalAudio = deleteTimelineSelection(mixed.state, { clipIds: ['audio-later'] });
  assert.deepEqual(finalAudio.removedTrackIds, ['audio']);
  assert.deepEqual(finalAudio.state.tracks.map((track) => track.id), [
    'visual', 'video', 'empty-audio', 'locked',
  ]);
  assert.equal(clipById(finalAudio.state, 'visual-later').startTick, 5);
  assert.equal(clipById(finalAudio.state, 'locked-selected').startTick, 3);
});

test('ripple-delete is atomic for occupied editable tracks and ignores locked scope entries', () => {
  const occupiedState = stateWith(
    [{ id: 'a' }, { id: 'b' }],
    [
      { id: 'crossing', trackId: 'a', startTick: 2, inTick: 0, outTick: 3, sourceDuration: 3 },
      { id: 'later', trackId: 'b', startTick: 7, inTick: 0, outTick: 2, sourceDuration: 2 },
    ],
  );
  const occupied = rippleDeleteGap(occupiedState, ['a', 'b'], 3, 5);
  assert.equal(occupied.changed, false);
  assert.equal(occupied.reason, 'occupied');
  assert.equal(clipById(occupied.state, 'later').startTick, 7);

  const lockedState = stateWith(
    [{ id: 'a' }, { id: 'b', locked: true }],
    [
      { id: 'later', trackId: 'a', startTick: 5, inTick: 0, outTick: 2, sourceDuration: 2 },
      { id: 'locked', trackId: 'b', startTick: 4, inTick: 0, outTick: 2, sourceDuration: 2 },
    ],
  );
  const locked = rippleDeleteGap(lockedState, ['a', 'b'], 0, 3);
  assert.equal(locked.changed, true);
  assert.deepEqual(locked.shiftedClipIds, ['later']);
  assert.equal(clipById(locked.state, 'later').startTick, 2);
  assert.equal(clipById(locked.state, 'locked').startTick, 4);

  const lockedOnly = rippleDeleteGap(lockedState, ['b'], 0, 3);
  assert.equal(lockedOnly.changed, false);
  assert.equal(lockedOnly.reason, 'locked-track');
  assert.equal(clipById(lockedOnly.state, 'locked').startTick, 4);
});

test('Delete on a selected finite gap delegates to scoped ripple behavior', () => {
  const state = stateWith(
    [{ id: 'a' }],
    [
      { id: 'first', trackId: 'a', startTick: 0, inTick: 0, outTick: 2, sourceDuration: 2 },
      { id: 'second', trackId: 'a', startTick: 5, inTick: 0, outTick: 2, sourceDuration: 2 },
    ],
  );
  const result = deleteTimelineSelection(state, {
    gap: { trackIds: ['a'], startTick: 2, endTick: 5 },
  });
  assert.equal(result.changed, true);
  assert.equal(clipById(result.state, 'second').startTick, 2);
});

test('Delete ripple-closes a one-tick gap without collapsing either one-tick clip', () => {
  const state = stateWith(
    [{ id: 'a' }],
    [
      { id: 'first', trackId: 'a', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 1, sourceDuration: 1, frameKeys: [{ tick: 0, value: 'A' }] },
      { id: 'second', trackId: 'a', kind: 'visual', startTick: 2,
        inTick: 0, outTick: 1, sourceDuration: 1, frameKeys: [{ tick: 0, value: 'B' }] },
    ],
  );
  const result = deleteTimelineSelection(state, {
    gap: { trackIds: ['a'], startTick: 1, endTick: 2 },
  });

  assert.equal(result.deltaTicks, -1);
  assert.equal(clipById(result.state, 'first').startTick, 0);
  assert.equal(clipDurationTicks(clipById(result.state, 'first')), 1);
  assert.equal(clipById(result.state, 'second').startTick, 1);
  assert.equal(clipDurationTicks(clipById(result.state, 'second')), 1);
  assert.equal(playbackDurationTicks(result.state), 2);
});

test('global Add Empty Time moves later clips and splits crossing clips', () => {
  const makeId = createStableClipTimelineIdGenerator();
  const original = stateWith(
    [{ id: 'a' }, { id: 'b' }],
    [
      {
        id: 'crossing', trackId: 'a', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 6, sourceDuration: 6,
        frameKeys: [
          { tick: 0, value: { pose: 'A' } },
          { tick: 2, value: { pose: 'B' } },
          { tick: 5, value: { pose: 'C' } },
        ],
      },
      { id: 'at-boundary', trackId: 'b', kind: 'visual', startTick: 3,
        inTick: 0, outTick: 2, sourceDuration: 2,
        frameKeys: [{ tick: 0, value: { pose: 'X' } }] },
    ],
  );
  const result = addEmptyTime(original, 3, 2, { makeId });
  const splitId = deterministicUuid('clip', 1);
  const left = clipById(result.state, 'crossing');
  const right = clipById(result.state, splitId);
  const later = clipById(result.state, 'at-boundary');

  assert.equal(result.changed, true);
  assert.deepEqual(result.splitClipIds, [splitId]);
  assert.equal(clipEndTick(left), 3);
  assert.equal(right.startTick, 5);
  assert.equal(right.inTick, 3);
  assert.equal(clipEndTick(right), 8);
  assert.equal(later.startTick, 5);
  assert.deepEqual(resolveHeldFrame(right, 5), { pose: 'B' });
  assert.deepEqual(findContiguousGap(result.state, ['a', 'b'], 4), {
    trackIds: ['a', 'b'],
    startTick: 3,
    endTick: 5,
    durationTicks: 2,
  });
  assert.equal(maxClipEnd(result.state), 8);
  assert.equal(maxClipEnd(original), 6);

  right.frameKeys.find((key) => key.tick === 3).value.pose = 'changed';
  assert.equal(left.frameKeys.find((key) => key.tick === 2).value.pose, 'B');
  assert.equal(original.clips[0].frameKeys[1].value.pose, 'B');
});

test('Add Empty Time does not retain trailing duration without content', () => {
  const empty = addEmptyTime(emptyClipTimelineState(), 0, 20);
  assert.equal(empty.changed, false);
  assert.equal(maxClipEnd(empty.state), 0);
  assert.equal(playbackDurationTicks(empty.state), 1);

  const state = stateWith(
    [{ id: 'a' }],
    [{ id: 'clip', trackId: 'a', startTick: 0, inTick: 0, outTick: 2, sourceDuration: 2 }],
  );
  const trailing = addEmptyTime(state, 5, 4);
  assert.equal(trailing.changed, false);
  assert.equal(maxClipEnd(trailing.state), 2);
});

test('sequence duration is furthest clip end with a one-tick empty minimum', () => {
  assert.equal(maxClipEnd(emptyClipTimelineState()), 0);
  assert.equal(playbackDurationTicks(emptyClipTimelineState()), 1);
  const state = stateWith(
    [{ id: 'a' }, { id: 'b' }],
    [
      { id: 'short', trackId: 'a', startTick: 2, inTick: 1, outTick: 4, sourceDuration: 5 },
      { id: 'long', trackId: 'b', startTick: 7, inTick: 3, outTick: 8, sourceDuration: 8 },
    ],
  );
  assert.equal(maxClipEnd(state), 12);
  assert.equal(maxClipEnd(state, ['a']), 5);
  assert.equal(playbackDurationTicks(state), 12);
});

test('clip-local key shifts retime frame and every generic property track', () => {
  const original = createVisualClip({
    id: 'clip',
    trackId: 'visual',
    startTick: 5,
    inTick: 1,
    outTick: 5,
    sourceDuration: 5,
    frameKeys: [{ tick: 0, value: 'A' }, { tick: 3, value: 'B' }],
    propertyTracks: {
      position: [{ tick: 1, value: { x: 1 } }, { tick: 4, value: { x: 4 } }],
      visibility: [{ tick: 0, value: true }],
    },
  });
  const shifted = shiftClipLocalKeys(original, 2, 3);

  assert.deepEqual(frameTicks(shifted), [0, 5]);
  assert.deepEqual(shifted.propertyTracks.position.map((key) => key.tick), [1, 6]);
  assert.deepEqual(shifted.propertyTracks.visibility.map((key) => key.tick), [0]);
  assert.equal(shifted.sourceDuration, 7);
  assert.equal(shifted.startTick, 5);
  assert.equal(shifted.inTick, 1);
  assert.equal(shifted.outTick, 5);
  assert.deepEqual(frameTicks(original), [0, 3]);
  assert.notEqual(shifted.frameKeys, original.frameKeys);
  assert.notEqual(shifted.propertyTracks.position, original.propertyTracks.position);
});

test('clip-local shifts reject negative and colliding keys without mutation', () => {
  const clip = createVisualClip({
    id: 'clip', trackId: 'visual', sourceDuration: 6,
    frameKeys: [{ tick: 2, value: 'A' }, { tick: 4, value: 'B' }],
  });
  assert.throws(() => shiftClipLocalKeys(clip, -2, 4), /collide/);
  assert.throws(() => shiftClipLocalKeys(clip, -3, 2), /before source tick zero/);
  assert.deepEqual(frameTicks(clip), [2, 4]);
});

test('state-level key shifting is immutable and honors track locks', () => {
  const state = stateWith(
    [{ id: 'open' }, { id: 'locked', locked: true }],
    [
      { id: 'open-clip', trackId: 'open', kind: 'visual', sourceDuration: 4,
        frameKeys: [{ tick: 1, value: 'A' }] },
      { id: 'locked-clip', trackId: 'locked', kind: 'visual', sourceDuration: 4,
        frameKeys: [{ tick: 1, value: 'B' }] },
    ],
  );
  const shifted = shiftTimelineClipKeys(state, 'open-clip', 1, 0);
  assert.deepEqual(frameTicks(clipById(shifted.state, 'open-clip')), [2]);
  assert.deepEqual(frameTicks(clipById(state, 'open-clip')), [1]);

  const locked = shiftTimelineClipKeys(state, 'locked-clip', 1, 0);
  assert.equal(locked.changed, false);
  assert.equal(locked.reason, 'locked-track');
});

test('direct multi-selection edge resize touches only clips sharing the edge', () => {
  const original = stateWith(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    [
      { id: 'a', trackId: 'a', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 4, sourceDuration: 4,
        frameKeys: [{ tick: 0, value: 'A' }, { tick: 3, value: 'B' }] },
      { id: 'a-next', trackId: 'a', kind: 'visual', startTick: 8,
        inTick: 0, outTick: 2, sourceDuration: 2 },
      { id: 'b', trackId: 'b', kind: 'visual', startTick: 1,
        inTick: 0, outTick: 3, sourceDuration: 3,
        frameKeys: [{ tick: 0, value: 'X' }] },
      { id: 'b-next', trackId: 'b', kind: 'visual', startTick: 7,
        inTick: 0, outTick: 2, sourceDuration: 2 },
      { id: 'c', trackId: 'c', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 5, sourceDuration: 5 },
    ],
  );
  const resized = resizeSelectedClipEdges(original, ['a', 'b', 'c'], 'end', 4, 5);
  const a = clipById(resized.state, 'a');
  const b = clipById(resized.state, 'b');
  const c = clipById(resized.state, 'c');

  assert.equal(resized.changed, true);
  assert.equal(resized.requestedDeltaTicks, 5);
  assert.equal(resized.deltaTicks, 3);
  assert.deepEqual(resized.resizedClipIds, ['a', 'b']);
  assert.equal(clipEndTick(a), 7);
  assert.equal(a.outTick, 7);
  assert.equal(a.sourceDuration, 7);
  assert.equal(clipEndTick(b), 7);
  assert.equal(b.outTick, 6);
  assert.equal(b.sourceDuration, 6);
  assert.equal(clipEndTick(c), 5);
  assert.equal(resolveHeldFrame(a, 6), 'B');
  assert.equal(resolveHeldFrame(b, 6), 'X');
  assert.equal(clipEndTick(clipById(original, 'a')), 4);
});

test('shared edge resize applies one common clamp and keeps every clip one tick', () => {
  const state = stateWith(
    [{ id: 'a' }, { id: 'b' }],
    [
      { id: 'a', trackId: 'a', startTick: 0, inTick: 0, outTick: 4, sourceDuration: 4 },
      { id: 'b', trackId: 'b', startTick: 1, inTick: 0, outTick: 3, sourceDuration: 3 },
    ],
  );
  const resized = resizeSelectedClipEdges(state, ['a', 'b'], 'end', 4, -99);
  assert.equal(resized.deltaTicks, -2);
  assert.equal(clipEndTick(clipById(resized.state, 'a')), 2);
  assert.equal(clipDurationTicks(clipById(resized.state, 'a')), 2);
  assert.equal(clipEndTick(clipById(resized.state, 'b')), 2);
  assert.equal(clipDurationTicks(clipById(resized.state, 'b')), 1);
});

test('left-edge extension prepends held source state and shifts local keys', () => {
  const state = stateWith(
    [{ id: 'visual' }],
    [{
      id: 'clip', trackId: 'visual', kind: 'visual', startTick: 3,
      inTick: 0, outTick: 2, sourceDuration: 2,
      frameKeys: [{ tick: 0, value: { pose: 'A' } }, { tick: 1, value: { pose: 'B' } }],
      propertyTracks: {
        position: [{ tick: 0, value: { x: 1 } }],
      },
    }],
  );
  const extended = resizeSelectedClipEdges(state, ['clip'], 'start', 3, -2);
  const clip = clipById(extended.state, 'clip');

  assert.equal(clip.startTick, 1);
  assert.equal(clipEndTick(clip), 5);
  assert.equal(clip.inTick, 0);
  assert.equal(clip.outTick, 4);
  assert.equal(clip.sourceDuration, 4);
  assert.deepEqual(frameTicks(clip), [0, 2, 3]);
  assert.deepEqual(resolveHeldFrame(clip, 1), { pose: 'A' });
  assert.deepEqual(resolveHeldFrame(clip, 3), { pose: 'A' });
  assert.deepEqual(resolveHeldFrame(clip, 4), { pose: 'B' });
  assert.deepEqual(resolveClipProperty(clip, 'position', 1), { x: 1 });
  assert.deepEqual(frameTicks(clipById(state, 'clip')), [0, 1]);
});

test('edge resize remains non-destructive when trimmed inward and reextended past source', () => {
  const state = stateWith(
    [{ id: 'visual' }],
    [{
      id: 'clip', trackId: 'visual', kind: 'visual', startTick: 0,
      inTick: 0, outTick: 5, sourceDuration: 5,
      frameKeys: [{ tick: 0, value: 'A' }, { tick: 4, value: 'B' }],
    }],
  );
  const inward = resizeSelectedClipEdges(state, ['clip'], 'end', 5, -2);
  const hidden = clipById(inward.state, 'clip');
  assert.equal(hidden.outTick, 3);
  assert.equal(hidden.sourceDuration, 5);
  assert.deepEqual(frameTicks(hidden), [0, 4]);

  const outward = resizeSelectedClipEdges(inward.state, ['clip'], 'end', 3, 4);
  const restored = clipById(outward.state, 'clip');
  assert.equal(restored.outTick, 7);
  assert.equal(restored.sourceDuration, 7);
  assert.equal(resolveHeldFrame(restored, 4), 'B');
  assert.equal(resolveHeldFrame(restored, 6), 'B');
});

test('track and clip state helpers preserve ids, reject overlap, and cascade removal', () => {
  const makeId = createStableClipTimelineIdGenerator();
  const trackId = deterministicUuid('track', 1);
  const firstClipId = deterministicUuid('clip', 1);
  const secondClipId = deterministicUuid('clip', 2);
  const empty = emptyClipTimelineState();
  const trackAdded = addTimelineTrack(empty, { name: 'Layer' }, { makeId });
  assert.equal(trackAdded.track.id, trackId);
  assert.equal(empty.tracks.length, 0);

  const clipAdded = addTimelineClip(trackAdded.state, {
    trackId,
    kind: 'visual',
    startTick: 2,
    inTick: 0,
    outTick: 3,
    sourceDuration: 3,
  }, { makeId });
  assert.equal(clipAdded.clip.id, firstClipId);

  const overlap = addTimelineClip(clipAdded.state, {
    trackId,
    kind: 'visual',
    startTick: 4,
    inTick: 0,
    outTick: 2,
    sourceDuration: 2,
  }, { makeId });
  assert.equal(overlap.changed, false);
  assert.equal(overlap.reason, 'overlap');
  assert.equal(overlap.state.clips.length, 1);

  const afterRejected = addTimelineClip(overlap.state, {
    trackId,
    kind: 'visual',
    startTick: 8,
    inTick: 0,
    outTick: 2,
    sourceDuration: 2,
  }, { makeId });
  assert.equal(afterRejected.clip.id, secondClipId);

  const groupAdded = addTimelineTrack(afterRejected.state, {
    kind: 'group',
  }, { makeId });
  const structural = addTimelineClip(groupAdded.state, {
    trackId: groupAdded.track.id,
    kind: 'visual',
    startTick: 0,
    inTick: 0,
    outTick: 1,
    sourceDuration: 1,
  }, { makeId });
  assert.equal(structural.changed, false);
  assert.equal(structural.reason, 'structural-track');

  const updated = updateTimelineTrack(clipAdded.state, trackId, {
    id: 'ignored',
    name: 'Renamed',
    locked: true,
  });
  assert.equal(updated.track.id, trackId);
  assert.equal(updated.track.name, 'Renamed');
  assert.equal(updated.track.locked, true);

  const clipRemoved = removeTimelineClip(clipAdded.state, firstClipId);
  assert.equal(clipRemoved.state.clips.length, 0);
  assert.equal(clipAdded.state.clips.length, 1);

  const trackRemoved = removeTimelineTrack(clipAdded.state, trackId);
  assert.equal(trackRemoved.state.tracks.length, 0);
  assert.equal(trackRemoved.state.clips.length, 0);
  assert.equal(trackRemoved.clips[0].id, firstClipId);
});

test('every state transaction provides undo-friendly deep independence', () => {
  const original = stateWith(
    [{ id: 'a', metadata: { color: 'red' } }, { id: 'b' }],
    [
      { id: 'a1', trackId: 'a', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 2, sourceDuration: 2,
        frameKeys: [{ tick: 0, value: { cells: [{ c: 'A' }] } }] },
      { id: 'b1', trackId: 'b', kind: 'visual', startTick: 4,
        inTick: 0, outTick: 2, sourceDuration: 2,
        frameKeys: [{ tick: 0, value: { cells: [{ c: 'B' }] } }] },
    ],
  );
  const moved = moveTimelineClip(original, 'a1', 1);
  moved.state.tracks[0].metadata.color = 'blue';
  clipById(moved.state, 'b1').frameKeys[0].value.cells[0].c = 'X';

  assert.equal(original.tracks[0].metadata.color, 'red');
  assert.equal(clipById(original, 'b1').frameKeys[0].value.cells[0].c, 'B');
  assert.notEqual(moved.state.tracks[1], original.tracks[1]);
  assert.notEqual(clipById(moved.state, 'b1'), clipById(original, 'b1'));

  const cloned = cloneClipTimelineState(original);
  cloned.clips[0].frameKeys[0].value.cells[0].c = 'Y';
  assert.equal(original.clips[0].frameKeys[0].value.cells[0].c, 'A');
});

test('controller snapshots restore exactly and never expose mutable internal state', () => {
  const controller = createClipTimelineController({
    idGenerator: createStableClipTimelineIdGenerator(),
  });
  const track = controller.addTrack({ name: 'Visual' }).track;
  const clip = controller.addVisualClip(track.id, {
    startTick: 0,
    inTick: 0,
    outTick: 3,
    sourceDuration: 3,
    frameKeys: [{ tick: 0, value: { cells: ['A'] } }],
  }).clip;
  assert.deepEqual([track.id, clip.id], [
    deterministicUuid('track', 1),
    deterministicUuid('clip', 1),
  ]);

  const snapshot = controller.captureState();
  controller.editVisualFrame(track.id, 1, (draft) => {
    draft.cells[0] = 'B';
  });
  assert.deepEqual(frameTicks(controller.getState().clips[0]), [0, 1]);
  assert.deepEqual(frameTicks(snapshot.clips[0]), [0]);

  const exposed = controller.getState();
  exposed.tracks[0].name = 'Mutated outside';
  exposed.clips[0].frameKeys[0].value.cells[0] = 'X';
  assert.equal(controller.getState().tracks[0].name, 'Visual');
  assert.equal(controller.getState().clips[0].frameKeys[0].value.cells[0], 'A');

  controller.restoreState(snapshot);
  assert.deepEqual(controller.getState(), snapshot);
  const split = controller.razorSplitClip(clip.id, 1);
  assert.equal(split.right.id, deterministicUuid('clip', 2));
  split.state.clips[0].frameKeys[0].value.cells[0] = 'outside';
  assert.equal(controller.getState().clips[0].frameKeys[0].value.cells[0], 'A');

  controller.restoreState(snapshot);
  const nextSplit = controller.razorSplitClip(clip.id, 2);
  assert.equal(nextSplit.right.id, deterministicUuid('clip', 3));
});

test('controller exposes the complete pure editing surface with deterministic results', () => {
  const controller = createClipTimelineController({
    makeId: createStableClipTimelineIdGenerator(5),
  });
  const trackA = controller.addTrack({}).track.id;
  const trackB = controller.addTrack({}).track.id;
  assert.deepEqual([trackA, trackB], [
    deterministicUuid('track', 5),
    deterministicUuid('track', 6),
  ]);

  const clipA = controller.addVisualClip(trackA, {
    startTick: 0, inTick: 0, outTick: 2, sourceDuration: 2,
    frameKeys: [{ tick: 0, value: 'A' }],
  }).clip.id;
  const clipB = controller.addVisualClip(trackB, {
    startTick: 0, inTick: 0, outTick: 2, sourceDuration: 2,
    frameKeys: [{ tick: 0, value: 'B' }],
  }).clip.id;
  assert.deepEqual([clipA, clipB], [
    deterministicUuid('clip', 5),
    deterministicUuid('clip', 6),
  ]);

  controller.resizeSelectedClipEdges([clipA, clipB], 'end', 2, 2);
  assert.equal(maxClipEnd(controller.getState()), 4);
  controller.addEmptyTime(2, 1);
  assert.equal(findContiguousGap(controller.getState(), [trackA, trackB], 2).durationTicks, 1);
  controller.deleteSelection({
    gap: { trackIds: [trackA, trackB], startTick: 2, endTick: 3 },
  });
  assert.equal(maxClipEnd(controller.getState()), 4);
  controller.shiftClipKeys(clipA, 1, 0);
  assert.deepEqual(frameTicks(clipById(controller.getState(), clipA)), [1]);
  controller.resetState();
  assert.deepEqual(controller.getState(), emptyClipTimelineState());
});

test('state validation requires a resolvable visual frame but not generic effect/media frames', () => {
  const valid = stateWith(
    [
      { id: 'visual' },
      { id: 'effect', kind: 'effect' },
      { id: 'audio', kind: 'audio' },
      { id: 'video', kind: 'video' },
      { id: 'media', kind: 'media' },
    ],
    [
      { id: 'visual-clip', trackId: 'visual', kind: 'visual', startTick: 0,
        inTick: 2, outTick: 4, sourceDuration: 4,
        frameKeys: [{ tick: 1, value: 'held at in' }] },
      { id: 'effect-clip', trackId: 'effect', kind: 'effect', startTick: 0,
        inTick: 0, outTick: 2, sourceDuration: 2 },
      { id: 'audio-clip', trackId: 'audio', kind: 'audio', assetId: 'asset', startTick: 0,
        inPoint: 0, outPoint: 2 / 24, duration: 2 / 24 },
      { id: 'video-clip', trackId: 'video', kind: 'video', startTick: 0,
        inTick: 0, outTick: 2, sourceDuration: 2 },
      { id: 'media-clip', trackId: 'media', kind: 'media', startTick: 0,
        inTick: 0, outTick: 2, sourceDuration: 2 },
    ],
  );
  assert.deepEqual(validateClipTimelineState(valid), []);

  const unresolved = stateWith(
    [{ id: 'visual' }],
    [{
      id: 'unresolved', trackId: 'visual', kind: 'visual', startTick: 0,
      inTick: 2, outTick: 4, sourceDuration: 4,
      frameKeys: [{ tick: 3, value: 'too late' }],
    }],
  );
  assert.equal(validateClipTimelineState(unresolved).some(
    (error) => error.includes('no resolvable frame at inTick'),
  ), true);
});

test('state validation reports duplicate ids, missing tracks, invalid bounds, and overlap', () => {
  const invalid = {
    tracks: [{ id: 'same' }, { id: 'same' }],
    clips: [
      { id: 'same', trackId: 'missing', startTick: -1, inTick: 2, outTick: 1, sourceDuration: 1 },
      { id: 'second', trackId: 'same', startTick: 0, inTick: 0, outTick: 3, sourceDuration: 3 },
      { id: 'third', trackId: 'same', startTick: 2, inTick: 0, outTick: 2, sourceDuration: 2 },
    ],
  };
  const errors = validateClipTimelineState(invalid);
  assert.equal(errors.some((error) => error.includes('Duplicate timeline id')), true);
  assert.equal(errors.some((error) => error.includes('has no track')), true);
  assert.equal(errors.some((error) => error.includes('invalid startTick')), true);
  assert.equal(errors.some((error) => error.includes('invalid source bounds')), true);
  assert.equal(errors.some((error) => error.includes('overlap')), true);

  const structural = {
    tracks: [{ id: 'group', kind: 'group' }],
    clips: [{
      id: 'clip', trackId: 'group', startTick: 0,
      inTick: 0, outTick: 1, sourceDuration: 1,
    }],
  };
  assert.equal(validateClipTimelineState(structural).some(
    (error) => error.includes('cannot contain clips'),
  ), true);
});

test('canonical audio state strips runtime media from tracks, clips, and snapshots', () => {
  const runtimeBuffer = { duration: 1 };
  const state = createClipTimelineState({
    fps: 10,
    tracks: [{ id: 'audio', kind: 'audio', buffer: runtimeBuffer, blob: new Blob() }],
    clips: [{
      id: 'clip', trackId: 'audio', kind: 'audio', assetId: 'asset',
      startTick: 0, inPoint: 0, outPoint: 1, duration: 1,
      buffer: runtimeBuffer, blob: new Blob(), asset: { id: 'asset' },
    }],
  });

  assert.deepEqual(validateClipTimelineState(state), []);
  assert.equal(JSON.stringify(state).includes('buffer'), false);
  assert.equal(JSON.stringify(state).includes('blob'), false);
  assert.equal('asset' in state.clips[0], false);
});

if (failed) {
  console.error(`${failed} clip timeline test(s) failed; ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`ok - ${passed} clip timeline core tests`);
}
