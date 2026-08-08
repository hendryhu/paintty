import assert from 'node:assert/strict';
import {
  buildClipExposureSegments,
  buildRowPrefixIndex,
  createLogicalScrollWindow,
  createTickPixelTransform,
  DEFAULT_MAX_TIMELINE_SCROLL_PIXELS,
  findCommonTrackGap,
  intersectClipRange,
  intersectTickIntervals,
  pixelToTick,
  planAnchoredTimelineZoom,
  planSelectedClipEdgeResize,
  projectFrameKeyMarkers,
  rebaseLogicalScrollWindow,
  resolveTimelineTrackScope,
  snapTimelineTick,
  tickToPixel,
  visibleRowRange,
  visibleTickRange,
  zoomTickPixelTransform,
} from '../src/lib/timelineViewport.js';

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

function clip(definition = {}) {
  return {
    id: definition.id ?? 'clip',
    trackId: definition.trackId ?? 'track',
    startTick: definition.startTick ?? 0,
    inTick: definition.inTick ?? 0,
    outTick: definition.outTick ?? 1,
    frameKeys: definition.frameKeys ?? [],
  };
}

test('tick and pixel transforms round-trip through fractional pan', () => {
  const transform = createTickPixelTransform({
    pixelsPerTick: 10,
    panTick: 5,
    originPixel: 20,
  });
  assert.equal(tickToPixel(5, transform), 20);
  assert.equal(tickToPixel(8, transform), 50);
  assert.equal(pixelToTick(0, transform), 3);
  assert.equal(pixelToTick(tickToPixel(7.25, transform), transform), 7.25);
});

test('zoom preserves the logical tick under the pointer anchor', () => {
  const initial = createTickPixelTransform({ pixelsPerTick: 10, panTick: 5, originPixel: 20 });
  const anchoredTick = pixelToTick(73, initial);
  const zoomed = zoomTickPixelTransform(initial, 24, 73);
  assert.ok(Math.abs(tickToPixel(anchoredTick, zoomed) - 73) < 1e-12);
  assert.equal(pixelToTick(73, zoomed), anchoredTick);
  assert.notEqual(tickToPixel(anchoredTick + 1, initial), tickToPixel(anchoredTick + 1, zoomed));
});

test('anchored wheel zoom cycles restore exact scroll at normal, minimum, and maximum zoom', () => {
  const scenarios = [
    {
      name: 'fractional DPR', originZoom: 14, nextZoom: 12,
      scrollLeft: 70.4, anchorPixel: 83.35, dpr: 1.25,
      nextMaximum: 900, originMaximum: 1_100,
    },
    {
      name: 'minimum zoom', originZoom: 4, nextZoom: 6,
      scrollLeft: 0, anchorPixel: 117.5, dpr: 2,
      nextMaximum: 300, originMaximum: 180,
    },
    {
      name: 'maximum zoom and clamped intermediate extent', originZoom: 48, nextZoom: 46,
      scrollLeft: 900, anchorPixel: 211.3, dpr: 1.5,
      nextMaximum: 500, originMaximum: 900,
    },
  ];
  for (const scenario of scenarios) {
    const outward = planAnchoredTimelineZoom({
      scrollLeft: scenario.scrollLeft,
      currentPixelsPerTick: scenario.originZoom,
      nextPixelsPerTick: scenario.nextZoom,
      anchorPixel: scenario.anchorPixel,
      maximumScrollLeft: scenario.nextMaximum,
      devicePixelRatio: scenario.dpr,
      geometryKey: scenario.name,
    });
    const returned = planAnchoredTimelineZoom({
      anchor: outward.anchor,
      scrollLeft: outward.scrollLeft,
      currentPixelsPerTick: scenario.nextZoom,
      nextPixelsPerTick: scenario.originZoom,
      anchorPixel: scenario.anchorPixel,
      maximumScrollLeft: scenario.originMaximum,
      devicePixelRatio: scenario.dpr,
      geometryKey: scenario.name,
    });
    assert.equal(returned.scrollLeft, scenario.scrollLeft, scenario.name);
    const initialScreenCoordinate =
      outward.anchor.anchorTick * scenario.originZoom - scenario.scrollLeft;
    assert.equal(
      returned.anchor.anchorTick * scenario.originZoom - returned.scrollLeft,
      initialScreenCoordinate,
      `${scenario.name}: the same logical tick returns to the same screen coordinate`,
    );
  }
});

test('mounted geometry identity prevents resized or remounted lanes from reusing stale anchors', () => {
  const stale = planAnchoredTimelineZoom({
    scrollLeft: 96,
    currentPixelsPerTick: 14,
    nextPixelsPerTick: 12,
    anchorPixel: 140,
    maximumScrollLeft: 800,
    devicePixelRatio: 2,
    geometryKey: 'viewport-1:header-176',
  });
  for (const geometry of [
    { key: 'viewport-1:header-248', anchorPixel: 68 },
    { key: 'viewport-2:header-248', anchorPixel: 68 },
  ]) {
    const outward = planAnchoredTimelineZoom({
      anchor: stale.anchor,
      scrollLeft: stale.scrollLeft,
      currentPixelsPerTick: 12,
      nextPixelsPerTick: 10,
      anchorPixel: geometry.anchorPixel,
      maximumScrollLeft: 700,
      devicePixelRatio: 2,
      geometryKey: geometry.key,
    });
    assert.equal(outward.anchor.originPixelsPerTick, 12);
    assert.equal(outward.anchor.originScrollLeft, stale.scrollLeft);
    const returned = planAnchoredTimelineZoom({
      anchor: outward.anchor,
      scrollLeft: outward.scrollLeft,
      currentPixelsPerTick: 10,
      nextPixelsPerTick: 12,
      anchorPixel: geometry.anchorPixel,
      maximumScrollLeft: 800,
      devicePixelRatio: 2,
      geometryKey: geometry.key,
    });
    assert.equal(returned.scrollLeft, stale.scrollLeft);
  }
});

test('visible tick ranges are half-open, overscanned, and bounded', () => {
  const transform = createTickPixelTransform({ pixelsPerTick: 10, panTick: 5 });
  assert.deepEqual(visibleTickRange(transform, 35, { overscanPixels: 10 }), {
    startTick: 4,
    endTick: 10,
    durationTicks: 6,
  });
  assert.deepEqual(visibleTickRange(
    createTickPixelTransform({ pixelsPerTick: 10 }),
    100,
    { maximumTick: 8 },
  ), { startTick: 0, endTick: 8, durationTicks: 8 });
  assert.deepEqual(visibleTickRange(transform, 0), {
    startTick: 5,
    endTick: 5,
    durationTicks: 0,
  });
});

test('variable row heights use a prefix index and binary visible lookup', () => {
  const index = buildRowPrefixIndex([20, 30, 10, 40]);
  assert.deepEqual(index, {
    offsets: [0, 20, 50, 60, 100],
    rowCount: 4,
    totalHeight: 100,
  });
  assert.deepEqual(visibleRowRange(index, 20, 30), {
    startIndex: 1,
    endIndex: 2,
    startOffset: 20,
    endOffset: 50,
  });
  assert.deepEqual(visibleRowRange(index, 20, 30, 1), {
    startIndex: 0,
    endIndex: 3,
    startOffset: 0,
    endOffset: 60,
  });
});

test('row prefix indexes accept row records and skip zero-height rows', () => {
  const index = buildRowPrefixIndex(
    [{ size: 12 }, { size: 0 }, { size: 18 }],
    (row) => row.size,
  );
  assert.deepEqual(index.offsets, [0, 12, 12, 30]);
  assert.deepEqual(visibleRowRange(index, 12, 1), {
    startIndex: 2,
    endIndex: 3,
    startOffset: 12,
    endOffset: 30,
  });
});

test('half-open interval and clip intersections exclude touching boundaries', () => {
  assert.deepEqual(
    intersectTickIntervals(
      { startTick: 2, endTick: 8 },
      { startTick: 5, endTick: 10 },
    ),
    { startTick: 5, endTick: 8, durationTicks: 3 },
  );
  assert.equal(intersectTickIntervals(
    { startTick: 2, endTick: 5 },
    { startTick: 5, endTick: 8 },
  ), null);
  assert.deepEqual(intersectClipRange(
    clip({ startTick: 10, inTick: 2, outTick: 8 }),
    { startTick: 14, endTick: 20 },
  ), { startTick: 14, endTick: 16, durationTicks: 2 });
});

test('frame-key markers project only visible clip-local keys', () => {
  const visual = clip({
    id: 'visual',
    startTick: 10,
    inTick: 2,
    outTick: 8,
    frameKeys: [
      { tick: 0 },
      { tick: 2 },
      { tick: 5 },
      { tick: 8 },
      { tick: 9 },
    ],
  });
  const transform = createTickPixelTransform({ pixelsPerTick: 4, panTick: 10 });
  assert.deepEqual(projectFrameKeyMarkers(visual, transform), [
    { clipId: 'visual', keyIndex: 1, sourceTick: 2, timelineTick: 10, pixel: 0 },
    { clipId: 'visual', keyIndex: 2, sourceTick: 5, timelineTick: 13, pixel: 12 },
  ]);
  assert.deepEqual(
    projectFrameKeyMarkers(visual, transform, { startTick: 11, endTick: 14 }),
    [{ clipId: 'visual', keyIndex: 2, sourceTick: 5, timelineTick: 13, pixel: 12 }],
  );
});

test('sparse frame keys become held exposure intervals without per-tick entries', () => {
  const visual = clip({
    id: 'visual',
    startTick: 10,
    inTick: 2,
    outTick: 8,
    frameKeys: [{ tick: 0 }, { tick: 3 }, { tick: 6 }, { tick: 9 }],
  });
  assert.deepEqual(buildClipExposureSegments(visual), [
    {
      clipId: 'visual', keyIndex: 0, sourceTick: 0,
      startTick: 10, endTick: 11, durationTicks: 1,
      heldFromBeforeClip: true, continuesBefore: false, continuesAfter: false,
    },
    {
      clipId: 'visual', keyIndex: 1, sourceTick: 3,
      startTick: 11, endTick: 14, durationTicks: 3,
      heldFromBeforeClip: false, continuesBefore: false, continuesAfter: false,
    },
    {
      clipId: 'visual', keyIndex: 2, sourceTick: 6,
      startTick: 14, endTick: 16, durationTicks: 2,
      heldFromBeforeClip: false, continuesBefore: false, continuesAfter: false,
    },
  ]);
  assert.deepEqual(
    buildClipExposureSegments(visual, { startTick: 12, endTick: 15 }),
    [
      {
        clipId: 'visual', keyIndex: 1, sourceTick: 3,
        startTick: 12, endTick: 14, durationTicks: 2,
        heldFromBeforeClip: false, continuesBefore: true, continuesAfter: false,
      },
      {
        clipId: 'visual', keyIndex: 2, sourceTick: 6,
        startTick: 14, endTick: 15, durationTicks: 1,
        heldFromBeforeClip: false, continuesBefore: false, continuesAfter: true,
      },
    ],
  );

  const long = clip({
    outTick: 10_000,
    frameKeys: [{ tick: 0 }, { tick: 5_000 }, { tick: 9_999 }],
  });
  const segments = buildClipExposureSegments(long);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map((segment) => segment.durationTicks), [5_000, 4_999, 1]);
});

test('common gaps intersect the empty intervals of every selected track', () => {
  const clips = [
    clip({ id: 'a1', trackId: 'a', startTick: 0, outTick: 2 }),
    clip({ id: 'a2', trackId: 'a', startTick: 5, outTick: 2 }),
    clip({ id: 'b1', trackId: 'b', startTick: 0, outTick: 3 }),
    clip({ id: 'b2', trackId: 'b', startTick: 6, outTick: 2 }),
  ];
  assert.deepEqual(findCommonTrackGap(clips, ['a', 'b'], 4), {
    trackIds: ['a', 'b'],
    startTick: 3,
    endTick: 5,
    durationTicks: 2,
  });
  assert.equal(findCommonTrackGap(clips, ['a', 'b'], 2), null);
  assert.equal(findCommonTrackGap(clips, ['a', 'b'], 5), null);
  assert.deepEqual(findCommonTrackGap(clips, ['a', 'b'], 9, { maximumTick: 12 }), {
    trackIds: ['a', 'b'],
    startTick: 8,
    endTick: 12,
    durationTicks: 4,
  });
});

test('track scope gives ruler-all, selected headers, then hovered track precedence', () => {
  const allTrackIds = ['a', 'b', 'c'];
  assert.deepEqual(resolveTimelineTrackScope({
    allTrackIds,
    selectedTrackIds: ['c', 'a'],
    hoveredTrackId: 'b',
    rulerAll: true,
  }), { kind: 'ruler-all', trackIds: ['a', 'b', 'c'] });
  assert.deepEqual(resolveTimelineTrackScope({
    allTrackIds,
    selectedTrackIds: ['c', 'a'],
    hoveredTrackId: 'b',
  }), { kind: 'selected', trackIds: ['a', 'c'] });
  assert.deepEqual(resolveTimelineTrackScope({ allTrackIds, hoveredTrackId: 'b' }), {
    kind: 'hovered', trackIds: ['b'],
  });
  assert.deepEqual(resolveTimelineTrackScope({ allTrackIds, hoveredTrackId: 'missing' }), {
    kind: 'none', trackIds: [],
  });
});

test('snapping chooses nearby playhead, clip edges, and visible frame keys', () => {
  const visual = clip({
    id: 'visual',
    trackId: 'a',
    startTick: 10,
    inTick: 2,
    outTick: 8,
    frameKeys: [{ tick: 0 }, { tick: 2 }, { tick: 5 }, { tick: 8 }],
  });
  const frame = snapTimelineTick(12.6, {
    clips: [visual], pixelsPerTick: 10, thresholdPixels: 6,
  });
  assert.equal(frame.tick, 13);
  assert.deepEqual(frame.target, {
    kind: 'frame-key', tick: 13, clipId: 'visual', trackId: 'a', sourceTick: 5,
  });
  const edge = snapTimelineTick(15.6, {
    clips: [visual], pixelsPerTick: 10, thresholdPixels: 6,
  });
  assert.equal(edge.tick, 16);
  assert.equal(edge.target.kind, 'clip-end');

  const tie = snapTimelineTick(12.5, {
    playheadTick: 12,
    clips: [visual],
    pixelsPerTick: 10,
    thresholdPixels: 6,
  });
  assert.equal(tie.tick, 12);
  assert.equal(tie.target.kind, 'playhead');
});

test('snap tolerance is pixel-stable across zoom and Alt bypasses candidates', () => {
  const visual = clip({
    id: 'visual', trackId: 'a', startTick: 10, inTick: 0, outTick: 10,
    frameKeys: [{ tick: 3 }],
  });
  assert.equal(snapTimelineTick(12.6, {
    clips: [visual], pixelsPerTick: 10, thresholdPixels: 6,
  }).tick, 13);
  assert.equal(snapTimelineTick(12.6, {
    clips: [visual], pixelsPerTick: 20, thresholdPixels: 6,
  }).snapped, false);
  assert.deepEqual(snapTimelineTick(12.6, {
    clips: [visual], pixelsPerTick: 10, thresholdPixels: 6, altKey: true,
  }), {
    requestedTick: 12.6,
    tick: 12.6,
    snapped: false,
    distanceTicks: 0,
    distancePixels: 0,
    target: null,
  });
  assert.equal(snapTimelineTick(12.6, {
    clips: [visual], pixelsPerTick: 10, thresholdPixels: 6, excludeClipIds: ['visual'],
  }).snapped, false);
});

test('common-edge resize planning selects exact edges and applies one clamp', () => {
  const state = {
    tracks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    clips: [
      clip({ id: 'a', trackId: 'a', startTick: 0, outTick: 4 }),
      clip({ id: 'a-next', trackId: 'a', startTick: 8, outTick: 2 }),
      clip({ id: 'b', trackId: 'b', startTick: 1, outTick: 3 }),
      clip({ id: 'b-next', trackId: 'b', startTick: 7, outTick: 2 }),
      clip({ id: 'c', trackId: 'c', startTick: 0, outTick: 5 }),
    ],
  };
  const before = structuredClone(state);
  assert.deepEqual(planSelectedClipEdgeResize(state, ['a', 'b', 'c'], 'end', 4, 5), {
    edge: 'end',
    sharedEdgeTick: 4,
    requestedDeltaTicks: 5,
    minimumDeltaTicks: -2,
    maximumDeltaTicks: 3,
    deltaTicks: 3,
    targetEdgeTick: 7,
    clipIds: ['a', 'b'],
  });
  assert.deepEqual(state, before);
});

test('common-edge start planning honors zero, neighbors, locks, and one-tick clips', () => {
  const state = {
    tracks: [{ id: 'a' }, { id: 'b', locked: true }],
    clips: [
      clip({ id: 'before', trackId: 'a', startTick: 0, outTick: 2 }),
      clip({ id: 'a', trackId: 'a', startTick: 4, outTick: 3 }),
      clip({ id: 'b', trackId: 'b', startTick: 4, outTick: 1 }),
    ],
  };
  assert.deepEqual(planSelectedClipEdgeResize(state, ['a', 'b'], 'start', 4, -99), {
    edge: 'start',
    sharedEdgeTick: 4,
    requestedDeltaTicks: -99,
    minimumDeltaTicks: -2,
    maximumDeltaTicks: 2,
    deltaTicks: -2,
    targetEdgeTick: 2,
    clipIds: ['a'],
  });
  assert.equal(planSelectedClipEdgeResize(state, ['b'], 'start', 4, 1), null);
});

test('short logical scroll windows use native dimensions without rebasing', () => {
  const window = createLogicalScrollWindow({
    totalTicks: 100,
    pixelsPerTick: 10,
    viewportWidth: 500,
    logicalStartTick: 30,
  });
  assert.equal(window.scrollWidth, 1_000);
  assert.equal(window.logicalOriginTick, 0);
  assert.equal(window.scrollLeft, 300);
  assert.equal(window.logicalStartTick, 30);
  assert.equal(window.rebased, false);
  assert.ok(window.scrollWidth <= DEFAULT_MAX_TIMELINE_SCROLL_PIXELS);
});

test('long logical scroll windows cap pixels and rebase without moving time', () => {
  const window = createLogicalScrollWindow({
    totalTicks: 1_000_000_000,
    pixelsPerTick: 20,
    viewportWidth: 1_000,
    maxScrollPixels: 100_000,
    rebaseMarginPixels: 10_000,
    logicalStartTick: 500_000,
  });
  assert.equal(window.scrollWidth, 100_000);
  assert.equal(window.scrollLeft, 49_500);
  const physicalScrollLeft = window.maxScrollLeft - 10;
  const logicalBefore = window.logicalOriginTick + physicalScrollLeft / window.pixelsPerTick;
  const rebased = rebaseLogicalScrollWindow(window, physicalScrollLeft);
  assert.equal(rebased.rebased, true);
  assert.equal(rebased.logicalStartTick, logicalBefore);
  assert.equal(
    rebased.logicalOriginTick + rebased.scrollLeft / rebased.pixelsPerTick,
    logicalBefore,
  );
  assert.equal(rebased.scrollWidth, 100_000);
  assert.ok(rebased.scrollLeft > rebased.rebaseMarginPixels);
  assert.ok(rebased.scrollLeft < rebased.maxScrollLeft - rebased.rebaseMarginPixels);

  const stable = rebaseLogicalScrollWindow(rebased, rebased.scrollLeft);
  assert.equal(stable.rebased, false);
  assert.equal(stable.logicalStartTick, logicalBefore);
});

test('logical scroll boundaries and zoom changes preserve valid extents', () => {
  const start = createLogicalScrollWindow({
    totalTicks: 1_000_000_000_000,
    pixelsPerTick: 40,
    viewportWidth: 1_200,
    logicalStartTick: 0,
  });
  assert.equal(start.logicalOriginTick, 0);
  assert.equal(rebaseLogicalScrollWindow(start, 0).rebased, false);
  assert.ok(start.scrollWidth <= DEFAULT_MAX_TIMELINE_SCROLL_PIXELS);

  const end = createLogicalScrollWindow({
    totalTicks: 1_000_000_000_000,
    pixelsPerTick: 40,
    viewportWidth: 1_200,
    logicalStartTick: 1_000_000_000_000,
  });
  assert.equal(end.scrollLeft, end.maxScrollLeft);
  assert.equal(end.logicalEndTick, end.totalTicks);
  assert.equal(rebaseLogicalScrollWindow(end, end.maxScrollLeft).rebased, false);

  const zoomed = createLogicalScrollWindow({
    ...end,
    pixelsPerTick: 80,
    logicalStartTick: end.logicalStartTick,
  });
  assert.equal(zoomed.logicalStartTick, end.logicalStartTick);
  assert.equal(zoomed.scrollWidth, DEFAULT_MAX_TIMELINE_SCROLL_PIXELS);
});

test('100 tracks by 10k ticks allocate only visible rows and sparse intervals', () => {
  const tracks = Array.from({ length: 100 }, (_, index) => ({
    id: `track-${index}`,
    height: 18 + (index % 4) * 3,
  }));
  const clips = tracks.map((track, index) => clip({
    id: `clip-${index}`,
    trackId: track.id,
    startTick: 0,
    inTick: 0,
    outTick: 10_000,
    frameKeys: [{ tick: 0 }, { tick: 5_000 }, { tick: 9_999 }],
  }));
  const rows = buildRowPrefixIndex(tracks, (track) => track.height);
  const visibleRows = visibleRowRange(rows, 700, 300, 40);
  assert.equal(rows.offsets.length, 101);
  assert.ok(visibleRows.endIndex - visibleRows.startIndex < 20);

  const transform = createTickPixelTransform({ pixelsPerTick: 2, panTick: 4_500 });
  const ticks = visibleTickRange(transform, 1_000, { overscanPixels: 100, maximumTick: 10_000 });
  assert.deepEqual(ticks, { startTick: 4_450, endTick: 5_050, durationTicks: 600 });

  let markerCount = 0;
  let segmentCount = 0;
  for (const visual of clips) {
    markerCount += projectFrameKeyMarkers(visual, transform, ticks).length;
    const segments = buildClipExposureSegments(visual, ticks);
    assert.equal(segments.length, 2);
    segmentCount += segments.length;
  }
  assert.equal(markerCount, 100);
  assert.equal(segmentCount, 200);
  assert.equal(clips.reduce((count, visual) => count + visual.frameKeys.length, 0), 300);
});

if (failed) {
  console.error(`${failed} timeline viewport test(s) failed; ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`ok - ${passed} timeline viewport tests`);
}
