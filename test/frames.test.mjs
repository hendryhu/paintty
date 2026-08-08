import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import * as F from '../src/lib/frames.js';
import * as G from '../src/lib/grid.js';
import {
  getClipTimelineSelection,
  getClipTimelineState,
  transactClipTimeline,
} from '../src/lib/clipTimelineState.js';
import { resolveClipTimelineLayers } from '../src/lib/clipTimelineResolver.js';
import { loadJSON, serializeJSON } from '../src/lib/fileio.js';
import { pathValueFromShape, translateShapePathKey } from '../src/lib/shapePath.js';
import { editPolygonSides, shapePathAggregateMetrics } from '../src/lib/shapePathEditing.js';
import {
  regularPolygonVertices,
  renderShapeToCells,
  updateShapeAppearance,
} from '../src/lib/shapes.js';

let passed = 0;
let failed = 0;

async function test(name, run) {
  try {
    await run();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}

const cell = (c, fg = '#ffffff', bg = null) => ({ c, fg, bg });

function reset(layerDefs) {
  G.setLayers(layerDefs);
  G.resetEditorStateForProjectLoad();
  return get(G.layers)[0]?.id ?? null;
}

function visualTrack(id, layer, extra = {}) {
  return { id, kind: layer.type === 'group' ? 'group' : layer.type === 'video' ? 'video' : 'visual',
    locked: false, layer, ...extra };
}

function visualClip(id, trackId, startTick, inTick, outTick, frameKeys, extra = {}) {
  return {
    id, trackId, kind: 'visual', startTick, inTick, outTick,
    sourceDuration: Math.max(outTick, ...frameKeys.map((key) => key.tick + 1)),
    frameKeys, propertyTracks: {}, ...extra,
  };
}

await test('old global-frame authorities and mutation adapters are absent', async () => {
  const module = await import('../src/lib/frames.js');
  for (const name of [
    'timelineStateForSave', 'loadSparseTimeline', 'loadFrames', 'setFrameHold',
    'deleteFrame', 'duplicateFrame', 'moveFrame', 'reverseFrames',
    'clipShadowParityReport', 'assertClipShadowParity', 'prepareProjectedCanonicalTimeline',
  ]) assert.equal(name in module, false, `${name} must not remain exported`);
  assert.equal(typeof module.addFrame, 'function',
    'the sole broad-call-site alias inserts canonical ticks directly');
});

await test('zero visual tracks resolve one transparent transport tick', () => {
  reset([]);
  assert.deepEqual(getClipTimelineState().tracks, []);
  assert.deepEqual(getClipTimelineState().clips, []);
  assert.equal(get(F.durationTicks), 1);
  assert.equal(get(F.frames).length, 1);
  assert.deepEqual(get(F.frames)[0].layers, []);
  assert.equal(get(F.activeFrameIndex), 0);
  assert.equal(get(F.playheadTick), 0);
  assert.equal(get(F.activeFrameTick), 0);
});

await test('one layer initializes one canonical UUID track and one sparse clip', () => {
  const id = reset([{ name: 'Ink', type: 'cell', visible: true, cells: { '0,0': cell('A') } }]);
  const state = getClipTimelineState();
  assert.equal(state.tracks.length, 1);
  assert.equal(state.clips.length, 1);
  assert.equal(state.tracks[0].layer.id, id);
  assert.deepEqual(state.clips[0].frameKeys, [{
    tick: 0,
    value: { cells: { '0,0': cell('A') } },
  }]);
  assert.equal(state.clips[0].sourceLayerId, undefined);
  assert.equal(state.tracks[0].layerType, undefined);
});

await test('Timeline edits and history preserve transport while a Razor drag undoes atomically', () => {
  const layer = {
    id: 'transport-layer', name: 'Transport', type: 'cell', visible: true,
    cells: { '0,0': cell('T') }, offset: { x: 0, y: 0 },
  };
  F.loadCanonicalTimeline({
    fps: 24,
    tracks: [visualTrack('transport-track', layer)],
    clips: [visualClip('transport-clip', 'transport-track', 0, 0, 10, [
      { tick: 0, value: { cells: { '0,0': cell('T') } } },
    ])],
  });
  G.resetEditorStateForProjectLoad();

  F.seekTick(6);
  G.beginStroke();
  assert.equal(F.moveClip('transport-clip', 1).changed, true);
  assert.equal(G.endStroke(), true);
  assert.equal(get(F.playheadTick), 6, 'moving a clip does not seek');

  F.seekTick(4);
  G.undo();
  assert.equal(get(F.playheadTick), 4, 'Undo keeps the current transport tick');
  assert.equal(getClipTimelineState().clips[0].startTick, 0);
  G.redo();
  assert.equal(get(F.playheadTick), 4, 'Redo keeps the current transport tick');
  assert.equal(getClipTimelineState().clips[0].startTick, 1);

  G.beginStroke();
  assert.equal(F.trimClip('transport-clip', 'end', 10).changed, true);
  assert.equal(G.endStroke(), true);
  assert.equal(get(F.playheadTick), 4, 'trimming a clip does not seek');

  G.beginStroke();
  const cut = F.razorClips([
    { clipId: 'transport-clip', tick: 3 },
    { clipId: 'transport-clip', tick: 6 },
    { clipId: 'transport-clip', tick: 3 },
  ]);
  assert.equal(cut.changed, true);
  assert.equal(cut.splits.length, 2);
  assert.equal(G.endStroke(), true);
  assert.equal(get(F.playheadTick), 4, 'cutting a clip does not seek');
  assert.equal(getClipTimelineState().clips.length, 3);

  F.seekTick(7);
  G.undo();
  assert.equal(get(F.playheadTick), 7);
  assert.deepEqual(getClipTimelineState().clips.map((clip) => clip.id), ['transport-clip'],
    'one Undo restores the whole Razor drag');
  G.redo();
  assert.equal(get(F.playheadTick), 7);
  assert.equal(getClipTimelineState().clips.length, 3);
});

await test('context-style clip deletion is isolated from prior layer artwork across Undo and Redo', async () => {
  reset(Array.from({ length: 4 }, (_, index) => ({
    name: `Layer ${index + 1}`,
    type: 'cell',
    visible: true,
    cells: index === 3 ? { '0,0': cell('4') } : {},
  })));
  const layer4 = get(G.layers).find((layer) => layer.name === 'Layer 4');
  assert.ok(layer4);
  assert.equal(G.addLayer('cell'), true);
  const layer5 = get(G.layers).find((layer) => layer.name === 'Layer 5');
  assert.ok(layer5);

  G.beginStroke();
  assert.equal(G.setCell(5, 5, cell('5')), true);
  assert.equal(G.endStroke(), true);
  await Promise.resolve();

  const layer4Track = getClipTimelineState().tracks.find((track) => track.layer?.id === layer4.id);
  const layer4Clip = getClipTimelineState().clips.find((clip) => clip.trackId === layer4Track.id);
  assert.ok(layer4Clip);
  G.beginStroke();
  assert.equal(F.deleteClipSelection({ clipIds: [layer4Clip.id] }).changed, true);
  assert.equal(G.endStroke(), true);
  await Promise.resolve();

  const hasLayer4Clip = () => getClipTimelineState().clips.some((clip) => clip.id === layer4Clip.id);
  const layer5Artwork = () => get(G.layers).find((layer) => layer.id === layer5.id)?.cells?.['5,5']?.c;
  assert.equal(hasLayer4Clip(), false);
  assert.equal(layer5Artwork(), '5');

  G.undo();
  assert.equal(hasLayer4Clip(), true, 'one Undo restores only the context-deleted clip');
  assert.equal(layer5Artwork(), '5', 'unrelated Layer 5 artwork survives clip Undo');
  G.undo();
  assert.equal(layer5Artwork(), undefined, 'the prior artwork remains a separate history entry');
  G.redo();
  assert.equal(layer5Artwork(), '5');
  assert.equal(hasLayer4Clip(), true);
  G.redo();
  assert.equal(hasLayer4Clip(), false, 'the second Redo removes only the clip again');
  assert.equal(layer5Artwork(), '5');
});

await test('multi-clip and key context deletions each occupy one exact history entry', () => {
  const layers = [
    { id: 'context-a', name: 'Context A', type: 'cell', visible: true,
      cells: { '0,0': cell('A') }, offset: { x: 0, y: 0 } },
    { id: 'context-b', name: 'Context B', type: 'cell', visible: true,
      cells: { '0,0': cell('B') }, offset: { x: 0, y: 0 } },
  ];
  F.loadCanonicalTimeline({
    fps: 24,
    tracks: [
      visualTrack('context-track-a', layers[0]),
      visualTrack('context-track-b', layers[1]),
    ],
    clips: [
      visualClip('context-clip-a', 'context-track-a', 0, 0, 5, [
        { tick: 0, value: { cells: { '0,0': cell('A') } } },
        { tick: 2, value: { cells: { '0,0': cell('a') } } },
        { tick: 4, value: { cells: { '0,0': cell('Z') } } },
      ], {
        propertyTracks: {
          position: [
            { tick: 0, value: { x: 0, y: 0 } },
            { tick: 2, value: { x: 2, y: 0 } },
            { tick: 4, value: { x: 4, y: 0 } },
          ],
        },
      }),
      visualClip('context-clip-b', 'context-track-b', 0, 0, 2, [
        { tick: 0, value: { cells: { '0,0': cell('B') } } },
      ]),
    ],
  });
  G.resetEditorStateForProjectLoad();

  G.beginStroke();
  assert.equal(F.deleteClipSelection({
    clipIds: ['context-clip-a', 'context-clip-b'],
  }).removedClips, 2);
  assert.equal(G.endStroke(), true);
  assert.deepEqual(getClipTimelineState().clips, []);
  G.undo();
  assert.deepEqual(getClipTimelineState().clips.map((clip) => clip.id), [
    'context-clip-a', 'context-clip-b',
  ]);
  G.redo();
  assert.deepEqual(getClipTimelineState().clips, []);
  G.undo();

  const beforeKeys = structuredClone(getClipTimelineState().clips[0]);
  G.beginStroke();
  const keysDeleted = F.deleteClipSelection({
    frameKeys: [
      { clipId: 'context-clip-a', sourceTick: 0 },
      { clipId: 'context-clip-a', sourceTick: 2 },
    ],
  });
  assert.equal(keysDeleted.removedKeys, 2);
  assert.equal(G.endStroke(), true);
  const afterFrameDelete = structuredClone(getClipTimelineState().clips[0]);
  assert.equal(afterFrameDelete.startTick, 4,
    'deleting selected earliest frame keys advances to the next resolvable key');
  assert.equal(afterFrameDelete.outTick, 5);
  assert.deepEqual(afterFrameDelete.frameKeys.map((key) => key.tick), [4]);
  G.undo();
  assert.deepEqual(getClipTimelineState().clips[0], beforeKeys);
  G.redo();
  assert.deepEqual(getClipTimelineState().clips[0], afterFrameDelete);
  G.undo();

  G.beginStroke();
  const propertiesDeleted = F.deleteClipSelection({
    propertyKeys: [
      { clipId: 'context-clip-a', propertyName: 'position', sourceTick: 0 },
      { clipId: 'context-clip-a', propertyName: 'position', sourceTick: 2 },
    ],
  });
  assert.equal(propertiesDeleted.removedKeys, 2);
  assert.equal(G.endStroke(), true);
  const afterPropertyDelete = structuredClone(getClipTimelineState().clips[0]);
  assert.deepEqual({
    startTick: afterPropertyDelete.startTick,
    inTick: afterPropertyDelete.inTick,
    outTick: afterPropertyDelete.outTick,
  }, { startTick: 0, inTick: 0, outTick: 5 });
  assert.deepEqual(afterPropertyDelete.propertyTracks.position.map((key) => key.tick), [4]);
  G.undo();
  assert.deepEqual(getClipTimelineState().clips[0], beforeKeys);
  G.redo();
  assert.deepEqual(getClipTimelineState().clips[0], afterPropertyDelete);
});

await test('mixed frame and property deletion restores exact bounds, keys, selection, and isolation', () => {
  const primaryLayer = {
    id: 'mixed-layer', name: 'Mixed', type: 'cell', visible: true,
    cells: { '0,0': cell('A') }, offset: { x: 0, y: 0 },
  };
  const unrelatedLayer = {
    id: 'unrelated-layer', name: 'Unrelated', type: 'cell', visible: true,
    cells: { '1,0': cell('U') }, offset: { x: 0, y: 0 },
  };
  F.loadCanonicalTimeline({
    fps: 24,
    tracks: [
      visualTrack('mixed-track', primaryLayer),
      visualTrack('unrelated-track', unrelatedLayer),
    ],
    clips: [
      visualClip('mixed-clip', 'mixed-track', 0, 0, 5, [
        { tick: 0, value: { cells: { '0,0': cell('A') } } },
        { tick: 2, value: { cells: { '0,0': cell('B') } } },
        { tick: 4, value: { cells: { '0,0': cell('C') } } },
      ], {
        propertyTracks: {
          position: [
            { tick: 0, value: { x: 0, y: 0 }, temporalEase: { out: { x: 0.2, y: 0.3 } } },
            { tick: 2, value: { x: 100, y: 0 } },
            { tick: 4, value: { x: 8, y: 0 }, temporalEase: { in: { x: 0.8, y: 0.7 } } },
          ],
        },
      }),
      visualClip('unrelated-clip', 'unrelated-track', 1, 0, 3, [
        { tick: 0, value: { cells: { '1,0': cell('U') } } },
      ]),
    ],
  });
  G.resetEditorStateForProjectLoad();
  const selected = {
    frameKeys: [
      { clipId: 'mixed-clip', sourceTick: 0 },
      { clipId: 'mixed-clip', sourceTick: 2 },
    ],
    propertyKeys: [
      { clipId: 'mixed-clip', propertyName: 'position', sourceTick: 2 },
    ],
  };
  F.setClipSelection(selected);
  const before = structuredClone(getClipTimelineState());
  const unrelatedBefore = structuredClone(
    before.clips.find((clip) => clip.id === 'unrelated-clip'),
  );

  assert.equal(G.beginStroke(), true);
  const deleted = F.deleteClipSelection();
  assert.equal(deleted.removedKeys, 3);
  assert.equal(G.endStroke(), true);
  const after = structuredClone(getClipTimelineState());
  const mixedAfter = after.clips.find((clip) => clip.id === 'mixed-clip');
  assert.deepEqual({
    startTick: mixedAfter.startTick,
    inTick: mixedAfter.inTick,
    outTick: mixedAfter.outTick,
    frameTicks: mixedAfter.frameKeys.map((key) => key.tick),
  }, { startTick: 4, inTick: 4, outTick: 5, frameTicks: [4] });
  assert.deepEqual(mixedAfter.propertyTracks.position, [
    { tick: 0, value: { x: 0, y: 0 }, temporalEase: { out: { x: 0.2, y: 0.3 } } },
    { tick: 4, value: { x: 8, y: 0 }, temporalEase: { in: { x: 0.8, y: 0.7 } } },
  ]);
  assert.deepEqual(
    after.clips.find((clip) => clip.id === 'unrelated-clip'),
    unrelatedBefore,
  );
  assert.deepEqual(getClipTimelineSelection().frameKeys, []);
  assert.deepEqual(getClipTimelineSelection().propertyKeys, []);

  G.undo();
  assert.deepEqual(getClipTimelineState(), before);
  assert.deepEqual(getClipTimelineSelection().frameKeys, selected.frameKeys);
  assert.deepEqual(getClipTimelineSelection().propertyKeys, selected.propertyKeys);
  assert.equal(get(G.canUndo), false, 'the mixed deletion is one isolated history entry');

  G.redo();
  assert.deepEqual(getClipTimelineState(), after);
  assert.deepEqual(getClipTimelineSelection().frameKeys, []);
  assert.deepEqual(getClipTimelineSelection().propertyKeys, []);
  assert.deepEqual(
    getClipTimelineState().clips.find((clip) => clip.id === 'unrelated-clip'),
    unrelatedBefore,
  );
});

await test('a Canvas edit on a hold creates one sparse frame key and one authored revision', async () => {
  const id = reset([{ name: 'Held', type: 'cell', visible: true, cells: { '0,0': cell('A') } }]);
  const clipId = getClipTimelineState().clips[0].id;
  G.beginStroke();
  assert.equal(F.trimClip(clipId, 'end', 5).changed, true);
  assert.equal(G.endStroke(), true);
  F.seekTick(3);
  assert.equal(get(G.layers)[0].cells['0,0'].c, 'A');
  const revision = get(G.authoredRevision);
  G.beginStroke();
  G.setCell(1, 0, cell('B'));
  assert.equal(G.endStroke(), true);
  await Promise.resolve();
  assert.equal(get(G.authoredRevision), revision + 1);
  const clip = getClipTimelineState().clips.find((candidate) => candidate.id === clipId);
  assert.deepEqual(clip.frameKeys.map((key) => key.tick), [0, 3]);
  assert.equal(clip.frameKeys[0].value.cells['1,0'], undefined);
  assert.equal(clip.frameKeys[1].value.cells['1,0'].c, 'B');
  G.undo();
  assert.equal(get(G.layers)[0].cells['1,0'], undefined);
  G.redo();
  assert.equal(get(G.layers)[0].cells['1,0'].c, 'B');
  assert.equal(get(G.activeLayerId), id);
});

await test('a Canvas edit in a gap creates one one-tick clip without moving neighbors', async () => {
  const layer = {
    id: 'layer-gap', name: 'Gap', type: 'cell', visible: true, cells: {}, offset: { x: 0, y: 0 },
  };
  F.loadCanonicalTimeline({
    fps: 24,
    tracks: [visualTrack('track-gap', layer)],
    clips: [
      visualClip('left', 'track-gap', 0, 0, 2, [
        { tick: 0, value: { cells: { '0,0': cell('L') } } },
      ]),
      visualClip('right', 'track-gap', 4, 4, 5, [
        { tick: 4, value: { cells: { '0,0': cell('R') } } },
      ]),
    ],
  });
  G.resetEditorStateForProjectLoad();
  F.seekTick(3);
  assert.deepEqual(get(G.layers)[0].cells, {});
  G.beginStroke();
  G.setCell(1, 0, cell('G'));
  assert.equal(G.endStroke(), true);
  await Promise.resolve();
  const state = getClipTimelineState();
  assert.deepEqual(state.clips.map((clip) => [clip.id, clip.startTick, clip.outTick]), [
    ['left', 0, 2],
    ['right', 4, 5],
    [state.clips[2].id, 3, 1],
  ]);
  assert.equal(state.clips[2].outTick - state.clips[2].inTick, 1);
  assert.equal(state.clips[2].frameKeys[0].value.cells['1,0'].c, 'G');
});

await test('fresh paint ownership is one cancellable, undoable, recoverable visible clip', async () => {
  const originalId = reset([{
    name: 'Absent owner', type: 'cell', visible: true, cells: {}, offset: { x: 0, y: 0 },
  }]);
  F.initTimeline(get(G.layers));
  const absentState = structuredClone(getClipTimelineState());
  absentState.clips[0].startTick = 2;
  F.loadCanonicalTimeline(absentState);
  G.resetEditorStateForProjectLoad();
  F.seekTick(0);

  assert.equal(G.beginStroke(), true);
  const cancelledId = G.createPaintLayer('cell');
  assert.ok(cancelledId);
  G.setCell(1, 0, cell('X'));
  assert.equal(G.cancelStroke(), true);
  await Promise.resolve();
  assert.equal(getClipTimelineState().tracks.some((track) => track.layer?.id === cancelledId), false);
  assert.equal(get(G.activeLayerId), originalId);
  assert.equal(get(G.canUndo), false);

  assert.equal(G.beginStroke(), true);
  const freshId = G.createPaintLayer('cell');
  assert.ok(freshId);
  G.setCell(1, 0, cell('P', '#123456'));
  assert.equal(G.endStroke(), true);
  await Promise.resolve();

  const committed = getClipTimelineState();
  const freshTrack = committed.tracks.find((track) => track.layer?.id === freshId);
  const freshClip = committed.clips.find((clip) => clip.trackId === freshTrack?.id);
  const originalClip = committed.clips.find((clip) =>
    committed.tracks.find((track) => track.id === clip.trackId)?.layer?.id === originalId);
  assert.equal(freshTrack?.layer?.visible, true);
  assert.equal(freshClip?.startTick, 0);
  assert.equal(freshClip?.outTick - freshClip?.inTick, 1);
  assert.equal(freshClip?.frameKeys[0].value.cells['1,0'].c, 'P');
  assert.equal(originalClip?.startTick, 2, 'the absent selected owner remains untouched');
  const recoveredJSON = serializeJSON();

  G.undo();
  assert.equal(getClipTimelineState().tracks.some((track) => track.layer?.id === freshId), false);
  assert.equal(get(G.canUndo), false, 'owner creation and painting consume one history entry');
  G.redo();
  assert.equal(getClipTimelineState().tracks.some((track) => track.layer?.id === freshId), true);

  loadJSON(recoveredJSON);
  const recovered = getClipTimelineState();
  const recoveredTrack = recovered.tracks.find((track) => track.layer?.id === freshId);
  const recoveredClip = recovered.clips.find((clip) => clip.trackId === recoveredTrack?.id);
  assert.equal(recoveredTrack?.layer?.visible, true);
  assert.equal(recoveredClip?.frameKeys[0].value.cells['1,0'].c, 'P');
});

await test('group key motion preserves exact records through history and recovery', () => {
  reset([{
    name: 'Motion recovery', type: 'cell', visible: true,
    cells: { '0,0': cell('A') }, offset: { x: 0, y: 0 },
  }]);
  F.initTimeline(get(G.layers));
  const authored = structuredClone(getClipTimelineState());
  const clip = authored.clips[0];
  clip.outTick = 5;
  clip.sourceDuration = 5;
  clip.frameKeys.push({ tick: 2, value: { cells: { '0,0': cell('B', '#abcdef') } } });
  clip.propertyTracks.position = [{
    tick: 1,
    value: {
      x: 3,
      y: -2,
      interpolation: 'linear',
      temporalEase: { out: { time: 0.2, value: 0.3 } },
    },
  }, {
    tick: 3,
    value: {
      x: 9,
      y: 4,
      interpolation: 'linear',
      temporalEase: { in: { time: 0.2, value: 0.3 } },
    },
  }];
  F.loadCanonicalTimeline(authored);
  G.resetEditorStateForProjectLoad();
  const selection = {
    frameKeys: [{ clipId: clip.id, sourceTick: 2 }],
    propertyKeys: [
      { clipId: clip.id, propertyName: 'position', sourceTick: 1 },
      { clipId: clip.id, propertyName: 'position', sourceTick: 3 },
    ],
  };
  const exactFrame = structuredClone(clip.frameKeys[1]);
  const exactPosition = structuredClone(clip.propertyTracks.position);

  assert.equal(G.beginStroke(), true);
  assert.equal(F.moveTimelineKeys(selection, 1).changed, true);
  assert.equal(G.endStroke(), true);
  let moved = getClipTimelineState().clips.find((candidate) => candidate.id === clip.id);
  assert.deepEqual(moved.frameKeys.find((key) => key.tick === 3), { ...exactFrame, tick: 3 });
  assert.deepEqual(moved.propertyTracks.position, exactPosition.map((key) => ({
    ...key, tick: key.tick + 1,
  })));
  assert.deepEqual(getClipTimelineSelection().frameKeys, [{ clipId: clip.id, sourceTick: 3 }]);
  const recoveredJSON = serializeJSON();

  G.undo();
  moved = getClipTimelineState().clips.find((candidate) => candidate.id === clip.id);
  assert.deepEqual(moved.frameKeys.find((key) => key.tick === 2), exactFrame);
  assert.deepEqual(moved.propertyTracks.position, exactPosition);
  assert.equal(get(G.canUndo), false, 'mixed key movement is one history entry');
  G.redo();
  moved = getClipTimelineState().clips.find((candidate) => candidate.id === clip.id);
  assert.deepEqual(moved.propertyTracks.position, exactPosition.map((key) => ({
    ...key, tick: key.tick + 1,
  })));

  loadJSON(recoveredJSON);
  const recovered = getClipTimelineState().clips.find((candidate) => candidate.id === clip.id);
  assert.deepEqual(recovered.frameKeys.find((key) => key.tick === 3), { ...exactFrame, tick: 3 });
  assert.deepEqual(recovered.propertyTracks.position, exactPosition.map((key) => ({
    ...key, tick: key.tick + 1,
  })));
});

await test('position and visibility keys are clip-local but exposed in project ticks', () => {
  const id = reset([{ name: 'Motion', type: 'cell', visible: true, cells: { '0,0': cell('M') } }]);
  const clipId = getClipTimelineState().clips[0].id;
  G.beginStroke();
  F.trimClip(clipId, 'end', 5);
  G.endStroke();
  F.seekTick(0);
  assert.equal(F.togglePosKey(id, 0), true);
  assert.equal(F.setLayerOffsetById(4, id, { x: 8, y: -2 }), true);
  assert.equal(F.setVisibilityTrackEnabled(id, true), true);
  assert.equal(F.setVisibilityKey(id, 4, false), true);
  assert.deepEqual(F.positionKeys(id).map(({ frame, x, y }) => ({ frame, x, y })), [
    { frame: 0, x: 0, y: 0 },
    { frame: 4, x: 8, y: -2 },
  ]);
  assert.deepEqual(resolveClipTimelineLayers(getClipTimelineState(), 2)[0].offset, { x: 4, y: -1 });
  assert.equal(resolveClipTimelineLayers(getClipTimelineState(), 3)[0].visible, true);
  assert.equal(resolveClipTimelineLayers(getClipTimelineState(), 4)[0].visible, false);
});

await test('effect and mask scalar/position keys share canonical history', () => {
  const id = reset([{
    name: 'Light', type: 'effect', visible: true, cells: {},
    effect: { kind: 'brightness', intensity: 0 },
    mask: { defaultStrength: 1, opacity: 1, offset: { x: 0, y: 0 }, cells: {} },
  }]);
  const clipId = getClipTimelineState().clips[0].id;
  G.beginStroke();
  F.trimClip(clipId, 'end', 5);
  G.endStroke();
  F.setEffectIntensityTrackEnabled(id, true);
  F.setEffectIntensityKey(id, 4, 1);
  F.setMaskOpacityTrackEnabled(id, true);
  F.setMaskOpacityKey(id, 4, 0);
  F.setMaskPositionTrackEnabled(id, true);
  F.setMaskPositionById(4, id, { x: 4, y: 2 });
  const middle = resolveClipTimelineLayers(getClipTimelineState(), 2)[0];
  assert.equal(middle.effect.intensity, 0.5);
  assert.equal(middle.mask.opacity, 0.5);
  assert.deepEqual(middle.mask.offset, { x: 2, y: 1 });
});

await test('text, shape, background, image, effect, group, and video payloads resolve in track order', () => {
  const shape = {
    kind: 'line', x0: 0, y0: 0, x1: 2, y1: 0,
    style: 'outline', detail: 'cell', channel: 'glyph', char: '#', fg: '#ffffff',
  };
  const definitions = [
    { id: 'group', name: 'Group', type: 'group', visible: true, cells: {}, offset: { x: 0, y: 0 } },
    { id: 'glyph', name: 'Glyph', type: 'cell', visible: true, cells: {}, offset: { x: 0, y: 0 } },
    { id: 'background', name: 'Background', type: 'background', visible: true, cells: {}, offset: { x: 0, y: 0 } },
    { id: 'text', name: 'Text', type: 'text', visible: true, cells: {}, offset: { x: 0, y: 0 } },
    { id: 'shape', name: 'Shape', type: 'shape', visible: true, cells: {}, offset: { x: 0, y: 0 } },
    { id: 'image', name: 'Image', type: 'image', visible: true, cells: {}, offset: { x: 0, y: 0 }, assetId: 'image-asset' },
    { id: 'effect', name: 'Effect', type: 'effect', visible: true, cells: {}, offset: { x: 0, y: 0 }, effect: { kind: 'contrast', intensity: 0.25 } },
    { id: 'video', name: 'Video', type: 'video', visible: true, cells: {}, offset: { x: 0, y: 0 }, assetId: 'video-asset' },
  ];
  const tracks = definitions.map((layer, index) => visualTrack(`track-${index}`, layer,
    layer.id === 'glyph' ? { parentTrackId: 'track-0' } : {}));
  const clips = tracks.flatMap((track, index) => track.kind === 'group' ? [] : [{
    ...visualClip(`clip-${index}`, track.id, 0, 0, 2, [{
      tick: 0,
      value: definitions[index].type === 'text'
        ? { cells: {}, text: 'Hi', box: { x: 0, y: 0, w: 2, h: 1 }, wrap: false, fg: '#fff', runs: [] }
        : definitions[index].type === 'shape'
          ? { cells: renderShapeToCells(shape), shape }
          : definitions[index].type === 'effect'
            ? { cells: {}, mask: { defaultStrength: 1, cells: { '0,0': { mask: 0.5 } }, offset: { x: 0, y: 0 } } }
            : { cells: { '0,0': cell(String(index)) } },
    }]),
    ...(track.kind === 'video' ? {
      kind: 'video', assetId: 'video-asset', inPoint: 0, outPoint: 2 / 24,
      playbackRate: 1, duration: 1, width: 2, height: 2,
    } : {}),
  }]);
  F.loadCanonicalTimeline({ fps: 24, tracks, clips });
  const resolved = resolveClipTimelineLayers(getClipTimelineState(), 1);
  assert.deepEqual(resolved.map((layer) => layer.type),
    ['group', 'cell', 'background', 'text', 'shape', 'image', 'effect', 'video']);
  assert.equal(resolved.find((layer) => layer.type === 'text').cells['0,0'].c, 'H');
  assert.deepEqual(Object.keys(resolved.find((layer) => layer.type === 'shape').cells),
    ['0,0', '1,0', '2,0']);
  assert.equal(resolved.find((layer) => layer.type === 'video').videoClip.startTick, 0);
});

await test('groups are structural and audio extends transport without entering visual resolution', () => {
  F.fps.set(10);
  const group = { id: 'g', name: 'G', type: 'group', visible: true, cells: {}, offset: { x: 0, y: 0 } };
  const art = { id: 'a', name: 'A', type: 'cell', visible: true, groupId: 'g', cells: {}, offset: { x: 0, y: 0 } };
  F.loadCanonicalTimeline({
    fps: 10,
    tracks: [
      visualTrack('group-track', group),
      visualTrack('art-track', art, { parentTrackId: 'group-track' }),
      { id: 'audio-track', kind: 'audio', name: 'Audio', locked: false },
    ],
    clips: [
      visualClip('art-clip', 'art-track', 0, 0, 2, [{ tick: 0, value: { cells: { '0,0': cell('A') } } }]),
      {
        id: 'audio-clip', trackId: 'audio-track', kind: 'audio', assetId: 'audio-asset',
        startTick: 7, inPoint: 0, outPoint: 1, duration: 1, volume: 1, muted: false,
      },
    ],
  });
  const state = getClipTimelineState();
  assert.equal(state.clips.some((clip) => clip.trackId === 'group-track'), false);
  assert.equal(get(F.durationTicks), 17);
  assert.deepEqual(resolveClipTimelineLayers(state, 16).map((layer) => layer.id), ['g', 'a']);
  assert.equal(resolveClipTimelineLayers(state, 16)[1].cells['0,0'], undefined);
});

await test('animated-group reparent preserves a 720-tick world trajectory sparsely', () => {
  F.fps.set(24);
  G.setLayers([
    {
      id: 'reparent-group', name: 'Group', type: 'group', visible: true,
      cells: {}, offset: { x: 0, y: 0 }, collapsed: false,
    },
    {
      id: 'reparent-child', name: 'Child', type: 'cell', visible: true,
      cells: { '0,0': cell('C') }, offset: { x: 7, y: 4 },
    },
  ]);
  const childClip = getClipTimelineState().clips.find((candidate) => candidate.kind === 'visual');
  G.beginStroke();
  F.trimClip(childClip.id, 'end', 720);
  G.endStroke();
  F.seekTick(0);
  F.togglePosKey('reparent-group', 0);
  F.setLayerOffsetById(719, 'reparent-group', { x: 200, y: 80 });
  F.setPosKeyTemporalPreset('reparent-group', [0], 'ease-out');

  const worldBefore = Array.from({ length: 720 }, (_, tick) =>
    resolveClipTimelineLayers(getClipTimelineState(), tick)
      .find((layer) => layer.id === 'reparent-child').offset);
  G.layers.update((stack) => stack.map((layer) => layer.id === 'reparent-child'
    ? { ...layer, groupId: 'reparent-group' }
    : layer));
  assert.equal(F.commitLayersToActiveFrame(), true);

  const state = getClipTimelineState();
  const worldAfter = Array.from({ length: 720 }, (_, tick) => {
    const resolved = resolveClipTimelineLayers(state, tick);
    const child = resolved.find((layer) => layer.id === 'reparent-child').offset;
    const group = resolved.find((layer) => layer.id === 'reparent-group').offset;
    return { x: child.x + group.x, y: child.y + group.y };
  });
  assert.deepEqual(worldAfter, worldBefore);
  const childKeys = F.positionKeys('reparent-child');
  assert.equal(childKeys.length < 50, true,
    'a smooth 720-tick compensation must remain sparse rather than keying every tick');
  assert.deepEqual(childKeys[0].temporalEase, F.positionKeys('reparent-group')[0].temporalEase);
});

await test('video canonical clip boundaries survive exact resolver and capture state', () => {
  F.fps.set(24);
  const layer = {
    id: 'video-layer', name: 'Reference', type: 'video', visible: true,
    cells: {}, offset: { x: 0, y: 0 }, assetId: 'video-asset',
  };
  F.loadCanonicalTimeline({
    fps: 24,
    tracks: [visualTrack('video-track', layer)],
    clips: [{
      id: 'video-clip', trackId: 'video-track', kind: 'video',
      startTick: 9, inTick: 0, outTick: 18, sourceDuration: 18,
      frameKeys: [{ tick: 0, value: { cells: {} } }], propertyTracks: {},
      assetId: 'video-asset', inPoint: 1.25, outPoint: 2, playbackRate: 1,
      duration: 3, width: 16, height: 9,
    }],
  });
  const clip = F.canonicalTimelineStateForSave().clips[0];
  assert.deepEqual({
    startTick: clip.startTick, inTick: clip.inTick, outTick: clip.outTick,
    inPoint: clip.inPoint, outPoint: clip.outPoint, playbackRate: clip.playbackRate,
  }, {
    startTick: 9, inTick: 0, outTick: 18,
    inPoint: 1.25, outPoint: 2, playbackRate: 1,
  });
  assert.equal(resolveClipTimelineLayers(getClipTimelineState(), 8)[0].videoClip.startTick, 9);
  assert.equal(resolveClipTimelineLayers(getClipTimelineState(), 9)[0].videoClip.inPoint, 1.25);

  assert.equal(F.trimClip('video-clip', 'start', 12).changed, true);
  const trimmed = getClipTimelineState().clips.find((candidate) => candidate.id === 'video-clip');
  assert.deepEqual({
    startTick: trimmed.startTick,
    inTick: trimmed.inTick,
    outTick: trimmed.outTick,
    sourceDuration: trimmed.sourceDuration,
    inPoint: trimmed.inPoint,
    outPoint: trimmed.outPoint,
  }, {
    startTick: 12, inTick: 0, outTick: 15, sourceDuration: 15,
    inPoint: 1.375, outPoint: 2,
  });
  const split = F.razorClip('video-clip', 17);
  assert.equal(split.changed, true);
  const videoHalves = getClipTimelineState().clips
    .filter((candidate) => candidate.kind === 'video')
    .sort((first, second) => first.startTick - second.startTick);
  assert.deepEqual(videoHalves.map((candidate) => ({
    startTick: candidate.startTick,
    ticks: candidate.outTick,
    inPoint: candidate.inPoint,
    outPoint: candidate.outPoint,
  })), [
    { startTick: 12, ticks: 5, inPoint: 1.375, outPoint: 19 / 12 },
    { startTick: 17, ticks: 10, inPoint: 19 / 12, outPoint: 2 },
  ]);
  F.setFps(12);
  assert.deepEqual(getClipTimelineState().clips
    .filter((candidate) => candidate.kind === 'video')
    .sort((first, second) => first.startTick - second.startTick)
    .map((candidate) => candidate.outTick), [3, 5]);
});

await test('720 ticks stay lazy, tick-native, and free of a second authored revision', async () => {
  const id = reset([{ name: 'Long', type: 'cell', visible: true, cells: { '0,0': cell('A') } }]);
  const clipId = getClipTimelineState().clips[0].id;
  G.beginStroke();
  F.trimClip(clipId, 'end', 720);
  G.endStroke();
  assert.equal(get(F.frames).length, 720);
  assert.equal(F.frameStartTick(719), 719);
  assert.deepEqual(F.frameAtProjectTick(719), {
    frameIndex: 719, localTick: 0, start: 719, end: 720,
  });
  F.seekTick(719);
  const revision = get(G.authoredRevision);
  G.beginStroke();
  G.setCell(1, 0, cell('Z'));
  G.endStroke();
  await Promise.resolve();
  assert.equal(get(G.authoredRevision), revision + 1);
  assert.deepEqual(getClipTimelineState().clips[0].frameKeys.map((key) => key.tick), [0, 719]);
  assert.equal(F.createTimelineTickSource().durationTicks, 720);
  assert.equal(get(G.layers).find((layer) => layer.id === id).cells['1,0'].c, 'Z');
});

await test('canonical mutations reject duplicate topology before publication', () => {
  reset([{ name: 'Probe', type: 'cell', visible: true, cells: {} }]);
  const baseline = F.canonicalTimelineStateForSave();
  assert.throws(() => transactClipTimeline('duplicate-probe', (state) => {
    state.tracks.push({ ...state.tracks[0] });
    return { state, changed: true };
  }), /Duplicate timeline id/);
  assert.deepEqual(F.canonicalTimelineStateForSave(), baseline);
});

await test('polygon side changes remain canonical through animation, history, and reopen', async () => {
  const original = {
    kind: 'polygon', style: 'outline', detail: 'cell', channel: 'glyph',
    char: '#', fg: '#ffffff', sides: 5,
    x0: 2, y0: 2, x1: 12, y1: 8,
    vertices: regularPolygonVertices(2, 2, 12, 8, 5),
    anchor: { x: 5, y: 6 }, rotation: 17,
  };
  const id = reset([{
    name: 'Polygon', type: 'shape', visible: true,
    shape: original, cells: renderShapeToCells(original),
  }]);
  const originalMetrics = shapePathAggregateMetrics(pathValueFromShape(original));
  const roundedMetrics = (metrics) => Object.fromEntries(Object.entries(metrics)
    .map(([key, value]) => [key, Math.round(value * 1e12) / 1e12]));
  const edited = editPolygonSides(original, 12);
  assert.ok(edited);
  assert.equal(F.setShapePathById(0, id, pathValueFromShape(edited)), true);

  let polygon = get(G.layers)[0];
  const twelveSideCells = structuredClone(polygon.cells);
  assert.deepEqual({
    sides: polygon.shape.sides,
    vertices: polygon.shape.vertices.length,
    metrics: roundedMetrics(shapePathAggregateMetrics(pathValueFromShape(polygon.shape))),
    anchor: polygon.shape.anchor,
    rotation: polygon.shape.rotation,
  }, {
    sides: 12,
    vertices: 12,
    metrics: roundedMetrics(originalMetrics),
    anchor: original.anchor,
    rotation: original.rotation,
  });
  assert.equal(F.canAnimateShapePath(id), true);
  assert.equal(F.setShapePathWholeTrackEnabled(id, true), true);
  assert.equal(F.isShapePathWholeTrackEnabled(id), true);
  assert.equal(F.shapePathWholeKeys(id)[0].vertices.length, 12);
  assert.deepEqual(get(G.layers)[0].cells, twelveSideCells,
    'enabling the whole Path must not alter the visible twelve-sided artwork');

  G.undo();
  assert.equal(F.isShapePathWholeTrackEnabled(id), false);
  assert.equal(get(G.layers)[0].shape.sides, 12);
  assert.equal(F.setShapePathComponentTrackEnabled(id, 'vertex:11', true), true);
  assert.equal(F.isShapePathComponentEnabled(id, 'vertex:11'), true);
  assert.equal(F.shapePathComponentKeys(id, 'vertex:11').length, 1);
  assert.equal(F.setShapePathWholeTrackEnabled(id, true), true,
    'whole Path creation must safely fill an entry that currently contains only component keys');
  assert.deepEqual(get(G.layers)[0].cells, twelveSideCells);

  const assertTwelveSideAuthorities = () => {
    const state = getClipTimelineState();
    const track = state.tracks.find((candidate) => candidate.layer?.id === id);
    const clips = state.clips.filter((clip) => clip.trackId === track.id);
    const framePaths = clips.flatMap((clip) => clip.frameKeys)
      .map((key) => pathValueFromShape(key.value?.shape)).filter(Boolean);
    const wholePaths = clips.flatMap((clip) => clip.propertyTracks?.shapePath || [])
      .map((key) => key.value?.path || (key.value?.kind ? key.value : null)).filter(Boolean);
    assert.ok(framePaths.length > 0);
    assert.ok(framePaths.every((path) => path.kind !== 'polygon' || path.vertices.length === 12));
    assert.ok(wholePaths.every((path) => path.kind !== 'polygon' || path.vertices.length === 12));
    assert.deepEqual(track.shapePathComponents, ['vertex:11']);
    assert.equal(F.shapePathAt(id, 0).vertices.length, 12);
    assert.equal(get(G.layers)[0].shape.sides, 12);
    assert.deepEqual(get(G.layers)[0].cells, twelveSideCells);
  };
  assertTwelveSideAuthorities();

  G.undo();
  assert.equal(F.isShapePathWholeTrackEnabled(id), false);
  assert.equal(F.isShapePathComponentEnabled(id, 'vertex:11'), true);
  G.undo();
  assert.equal(F.isShapePathTrackEnabled(id), false);
  assert.equal(get(G.layers)[0].shape.sides, 12);
  G.undo();
  assert.equal(get(G.layers)[0].shape.sides, 5);
  assert.equal(get(G.layers)[0].shape.vertices.length, 5);
  G.redo();
  G.redo();
  G.redo();
  assert.equal(F.isShapePathWholeTrackEnabled(id), true);
  assert.equal(F.isShapePathComponentEnabled(id, 'vertex:11'), true);
  assertTwelveSideAuthorities();

  const saved = serializeJSON();
  loadJSON(saved);
  await Promise.resolve();
  assert.equal(get(G.layers)[0].id, id);
  assert.equal(F.isShapePathWholeTrackEnabled(id), true);
  assert.equal(F.isShapePathComponentEnabled(id, 'vertex:11'), true);
  assertTwelveSideAuthorities();
  assert.equal(serializeJSON(), saved,
    'canonical polygon Path and component keys must save and reopen without stale side data');
});

await test('polygon detail round trips preserve geometry, tracks, identity, and history', async () => {
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const configurations = [
    { sides: 3, grouped: false, keyed: false, offset: { x: 0, y: 0 } },
    { sides: 5, grouped: true, keyed: true, offset: { x: 3, y: -2 } },
    { sides: 8, grouped: true, keyed: false, offset: { x: -4, y: 3 } },
  ];

  for (const configuration of configurations) {
    const layerId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    const shape = {
      kind: 'polygon', style: 'outline', detail: 'cell', channel: 'glyph',
      char: '█', fg: '#abcdef', sides: configuration.sides,
      thickness: 1, strokeAlign: 'center',
      x0: 2, y0: 2, x1: 14, y1: 10,
      anchor: { x: 8, y: 6 }, rotation: 23,
    };
    shape.vertices = regularPolygonVertices(
      shape.x0, shape.y0, shape.x1, shape.y1, shape.sides,
    );
    const polygon = {
      id: layerId,
      name: `${configuration.sides}-side detail polygon`,
      type: 'shape',
      visible: true,
      offset: configuration.offset,
      ...(configuration.grouped ? { groupId } : {}),
      shape,
      cells: renderShapeToCells(shape),
    };
    G.setLayers(configuration.grouped
      ? [{
        id: groupId, name: 'Detail group', type: 'group', visible: true,
        collapsed: false, offset: { x: -2, y: 4 }, cells: {},
      }, polygon]
      : [polygon]);
    G.selectLayer(layerId);

    const editTick = configuration.keyed ? 5 : 0;
    if (configuration.keyed) {
      const state = getClipTimelineState();
      const track = state.tracks.find((candidate) => candidate.layer?.id === layerId);
      const clip = state.clips.find((candidate) => candidate.trackId === track.id);
      G.beginStroke();
      assert.equal(F.trimClip(clip.id, 'end', 6).changed, true);
      assert.equal(G.endStroke(), true);
      F.seekTick(0);
      assert.equal(F.togglePosKey(layerId, 0), true);
      assert.equal(F.setLayerOffsetById(5, layerId, { x: 9, y: -5 }), true);
      assert.equal(F.setShapePathWholeTrackEnabled(layerId, true), true);
      assert.equal(F.setShapePathById(
        5,
        layerId,
        translateShapePathKey(F.shapePathAt(layerId, 0), 1.5, -0.5),
      ), true);
    }
    F.seekTick(editTick);
    G.resetEditorStateForProjectLoad();
    G.selectLayer(layerId);
    await settle();

    const currentLayer = () => get(G.layers).find((layer) => layer.id === layerId);
    const stableState = () => {
      const layer = currentLayer();
      const currentShape = layer.shape;
      const state = getClipTimelineState();
      return structuredClone({
        layer: {
          id: layer.id,
          groupId: layer.groupId,
          offset: layer.offset,
        },
        geometry: {
          bounds: [currentShape.x0, currentShape.y0, currentShape.x1, currentShape.y1],
          vertices: currentShape.vertices,
          sides: currentShape.sides,
          anchor: currentShape.anchor,
          rotation: currentShape.rotation,
          path: F.shapePathAt(layerId, editTick),
        },
        tracks: state.tracks.map((track) => ({
          id: track.id,
          layerId: track.layer?.id,
          parentTrackId: track.parentTrackId,
          shapePathKind: track.shapePathKind ?? null,
          shapePathComponents: track.shapePathComponents,
          propertyTracks: track.propertyTracks || {},
        })),
        clips: state.clips.map((clip) => ({
          id: clip.id,
          trackId: clip.trackId,
          startTick: clip.startTick,
          inTick: clip.inTick,
          outTick: clip.outTick,
          propertyTracks: clip.propertyTracks,
        })),
      });
    };
    const baselineState = stableState();
    const baselineCells = structuredClone(currentLayer().cells);
    let previousDetail = 'cell';
    let previousCells = baselineCells;

    for (const detail of ['half', 'quarter', 'cell']) {
      const before = currentLayer().shape;
      const next = updateShapeAppearance(before, { detail });
      assert.equal(G.setShapeLayerProperties(layerId, next, renderShapeToCells), true);
      await settle();

      const changed = currentLayer();
      const changedCells = structuredClone(changed.cells);
      assert.equal(changed.shape.detail, detail);
      assert.equal(changed.shape.glyphDetail, detail);
      assert.equal(changed.shape.channel, 'glyph');
      assert.deepEqual(changed.cells, renderShapeToCells(changed.shape));
      assert.deepEqual(stableState(), baselineState,
        `${configuration.sides} sides must retain geometry and tracks at ${detail} detail`);
      if (detail === 'cell') assert.deepEqual(changedCells, baselineCells);

      G.undo();
      await settle();
      assert.equal(currentLayer().shape.detail, previousDetail);
      assert.deepEqual(currentLayer().cells, previousCells);
      assert.equal(get(G.canUndo), false,
        'one Undo must consume the complete detail change after reopen');
      G.redo();
      await settle();
      assert.equal(currentLayer().shape.detail, detail);
      assert.deepEqual(currentLayer().cells, changedCells);

      const saved = serializeJSON();
      loadJSON(saved);
      await settle();
      F.seekTick(editTick);
      G.selectLayer(layerId);
      await settle();
      assert.equal(serializeJSON(), saved,
        `${configuration.sides} sides must reopen ${detail} detail exactly`);
      assert.equal(currentLayer().shape.detail, detail);
      assert.deepEqual(currentLayer().cells, changedCells);
      assert.deepEqual(stableState(), baselineState);
      previousDetail = detail;
      previousCells = changedCells;
    }
  }
});

await test('tag set and delete are exact one-step authored history edits', async () => {
  reset([{ name: 'Tagged', type: 'cell', visible: true, cells: { '0,0': cell('T') } }]);
  const clipId = getClipTimelineState().clips[0].id;
  G.beginStroke();
  F.trimClip(clipId, 'end', 4);
  G.endStroke();
  G.resetEditorStateForProjectLoad();

  const beforeRevision = get(G.authoredRevision);
  G.beginStroke();
  const added = F.setTimelineTag({ tick: 3, type: 'custom', value: '世界' });
  assert.equal(added.changed, true);
  assert.equal(G.endStroke(), true);
  await Promise.resolve();
  const exact = structuredClone(getClipTimelineState().tags[0]);
  assert.equal(get(G.authoredRevision), beforeRevision + 1);

  G.undo();
  assert.deepEqual(getClipTimelineState().tags, []);
  G.redo();
  assert.deepEqual(getClipTimelineState().tags, [exact]);

  G.beginStroke();
  assert.equal(F.trimClip(clipId, 'end', 2).changed, true);
  assert.equal(G.endStroke(), true);
  assert.equal(getClipTimelineState().tags[0].tick, 1,
    'duration shrink clamps tags in the same canonical edit');
  G.undo();
  assert.deepEqual(getClipTimelineState().tags, [exact]);
  assert.equal(getClipTimelineState().clips[0].outTick, 4);

  G.beginStroke();
  assert.equal(F.removeTimelineTag(exact.id).changed, true);
  assert.equal(G.endStroke(), true);
  assert.deepEqual(getClipTimelineState().tags, []);
  G.undo();
  assert.deepEqual(getClipTimelineState().tags, [exact]);
});

if (failed) {
  console.error(`${failed} canonical frame integration test(s) failed; ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`ok - ${passed} canonical frame integration tests`);
}
