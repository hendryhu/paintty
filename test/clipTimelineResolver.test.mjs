import assert from 'node:assert/strict';
import { createClipTimelineState } from '../src/lib/clipTimeline.js';
import {
  CLIP_TIMELINE_PROPERTIES,
  clipTimelineDurationTicks,
  clipTimelineTickDuration,
  createClipTimelineResolver,
  findClipAtProjectTick,
  lookupClipAtProjectTick,
  projectTickToClipLocal,
  resolveClipPropertyAtTick,
  resolveClipTimelineAtTick,
  resolveClipTimelineLayers,
} from '../src/lib/clipTimelineResolver.js';

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

const lineAppearance = {
  kind: 'line', x0: 0, y0: 0, x1: 2, y1: 0,
  style: 'outline', detail: 'cell', channel: 'glyph', char: '#', fg: '#ffffff',
};

function manualState() {
  return createClipTimelineState({
    fps: 20,
    tracks: [
      {
        id: 'group-track', kind: 'group',
        layer: {
          id: 'group', name: 'Group', type: 'group', visible: true,
          collapsed: false, cells: {}, offset: { x: 0, y: 0 },
        },
        propertyTracks: {
          position: [
            { tick: 0, value: { x: 0, y: 0 } },
            { tick: 4, value: { x: 4, y: 0 } },
          ],
        },
      },
      {
        id: 'cell-track', kind: 'visual',
        layer: {
          id: 'cell', name: 'Cell', type: 'cell', groupId: 'group', visible: true,
          cells: {}, offset: { x: 0, y: 0 },
        },
      },
    ],
    clips: [{
      id: 'cell-clip', trackId: 'cell-track', kind: 'visual',
      startTick: 2, inTick: 0, outTick: 3, sourceDuration: 3,
      frameKeys: [{ tick: 0, value: { cells: { '0,0': cell('A') } } }],
      propertyTracks: {
        position: [
          { tick: 0, value: { x: 0, y: 0, interpolation: 'linear' } },
          { tick: 2, value: { x: 4, y: 2, interpolation: 'linear' } },
        ],
        visibility: [
          { tick: 0, value: true },
          { tick: 2, value: false },
        ],
      },
    }],
  });
}

test('resolver returns complete ordered stacks and blank shells in clip gaps', () => {
  const state = manualState();
  assert.deepEqual(resolveClipTimelineLayers(state, 0), [
    {
      id: 'group', name: 'Group', type: 'group', visible: true,
      collapsed: false, cells: {}, offset: { x: 0, y: 0 },
    },
    {
      id: 'cell', name: 'Cell', type: 'cell', groupId: 'group', visible: true,
      cells: {}, offset: { x: 0, y: 0 },
    },
  ]);
  const middle = resolveClipTimelineLayers(state, 3);
  assert.deepEqual(middle.map((layer) => layer.id), ['group', 'cell']);
  assert.equal(middle[1].cells['0,0'].c, 'A');
  assert.deepEqual(middle[1].offset, { x: 2, y: 1 });
  assert.equal(middle[1].visible, true);
  const last = resolveClipTimelineLayers(state, 4)[1];
  assert.equal(last.visible, false);
  assert.deepEqual(last.offset, { x: 4, y: 2 });
});

test('groups resolve project-tick position and visibility without owning clips', () => {
  const state = createClipTimelineState({
    tracks: [{
      id: 'group-track', kind: 'group', layer: {
        id: 'group', name: 'Group', type: 'group', visible: true,
        collapsed: false, cells: {}, offset: { x: 0, y: 0 },
      },
      propertyTracks: {
        position: [
          { tick: 0, value: { x: 0, y: 0 } },
          { tick: 2, value: { x: 4, y: 2 } },
        ],
        visibility: [
          { tick: 0, value: true },
          { tick: 2, value: false },
        ],
      },
    }],
    clips: [],
  });
  assert.equal(clipTimelineDurationTicks(state), 3);
  const middle = resolveClipTimelineLayers(state, 1)[0];
  assert.deepEqual(middle.offset, { x: 2, y: 1 });
  assert.equal(middle.visible, true);
  assert.equal(resolveClipTimelineLayers(state, 2)[0].visible, false);
});

test('clip lookup exposes project-to-local and trimmed source mapping', () => {
  const state = manualState();
  const clip = findClipAtProjectTick(state, 'cell', 3);
  assert.equal(clip.id, 'cell-clip');
  assert.equal(findClipAtProjectTick(state, 'cell-track', 1), null);
  assert.deepEqual(projectTickToClipLocal(clip, 3), {
    projectTick: 3,
    clipLocalTick: 1,
    sourceTick: 1,
  });
  const lookup = lookupClipAtProjectTick(state, 'cell', 4);
  assert.deepEqual({
    track: lookup.track.id,
    clip: lookup.clip.id,
    projectTick: lookup.projectTick,
    clipLocalTick: lookup.clipLocalTick,
    sourceTick: lookup.sourceTick,
  }, {
    track: 'cell-track',
    clip: 'cell-clip',
    projectTick: 4,
    clipLocalTick: 2,
    sourceTick: 2,
  });
});

test('generic clip properties interpolate position, scalars, masks, and shape paths', () => {
  const clip = createClipTimelineState({
    tracks: [{ id: 'track' }],
    clips: [{
      id: 'clip', trackId: 'track', startTick: 10, inTick: 1, outTick: 4,
      sourceDuration: 5,
      propertyTracks: {
        position: [
          { tick: 1, value: { x: 0, y: 0, interpolation: 'linear' } },
          { tick: 3, value: { x: 6, y: -2, interpolation: 'linear' } },
        ],
        effectIntensity: [{ tick: 1, value: -1 }, { tick: 3, value: 1 }],
        maskOpacity: [{ tick: 1, value: 1 }, { tick: 3, value: 0 }],
        maskPosition: [
          { tick: 1, value: { x: -2, y: 0 } },
          { tick: 3, value: { x: 2, y: 4 } },
        ],
        shapePath: [
          { tick: 1, value: { kind: 'line', x0: 0, y0: 0, x1: 2, y1: 0 } },
          { tick: 3, value: { kind: 'line', x0: 4, y0: 2, x1: 6, y1: 2 } },
        ],
      },
    }],
  }).clips[0];
  assert.deepEqual(resolveClipPropertyAtTick(
    clip, CLIP_TIMELINE_PROPERTIES.position, 11,
  ), { x: 3, y: -1 });
  assert.equal(resolveClipPropertyAtTick(
    clip, CLIP_TIMELINE_PROPERTIES.effectIntensity, 11,
  ), 0);
  assert.equal(resolveClipPropertyAtTick(
    clip, CLIP_TIMELINE_PROPERTIES.maskOpacity, 11,
  ), 0.5);
  assert.deepEqual(resolveClipPropertyAtTick(
    clip, CLIP_TIMELINE_PROPERTIES.maskPosition, 11,
  ), { x: 0, y: 2 });
  assert.deepEqual(resolveClipPropertyAtTick(
    clip, CLIP_TIMELINE_PROPERTIES.shapePath, 11,
  ), { kind: 'line', x0: 2, y0: 1, x1: 4, y1: 1 });
});

test('shape clips resolve path interpolation into shape metadata and cells', () => {
  const state = createClipTimelineState({
    tracks: [{
      id: 'shape-track', kind: 'visual',
      layer: {
        id: 'shape', name: 'Shape', type: 'shape', visible: true,
        shape: lineAppearance, cells: {}, offset: { x: 0, y: 0 },
      },
    }],
    clips: [{
      id: 'shape-clip', trackId: 'shape-track', startTick: 0,
      inTick: 0, outTick: 3, sourceDuration: 3,
      frameKeys: [{ tick: 0, value: { shape: lineAppearance, cells: {} } }],
      propertyTracks: {
        shapePath: [
          { tick: 0, value: { kind: 'line', x0: 0, y0: 0, x1: 2, y1: 0 } },
          { tick: 2, value: { kind: 'line', x0: 4, y0: 0, x1: 6, y1: 0 } },
        ],
      },
    }],
  });
  const layer = resolveClipTimelineLayers(state, 1)[0];
  assert.deepEqual({ x0: layer.shape.x0, x1: layer.shape.x1 }, { x0: 2, x1: 4 });
  assert.deepEqual(Object.keys(layer.cells), ['2,0', '3,0', '4,0']);
});

test('effect and media payloads retain complete state while resolving properties', () => {
  const state = createClipTimelineState({
    tracks: [
      {
        id: 'effect-track', kind: 'effect', layer: {
          id: 'effect', name: 'Effect', type: 'effect', visible: true, cells: {},
          offset: { x: 0, y: 0 }, effect: { kind: 'brightness', intensity: 0 },
          mask: { defaultStrength: 1, opacity: 1, offset: { x: 0, y: 0 }, cells: {} },
        },
      },
      {
        id: 'video-track', kind: 'video', layer: {
          id: 'video', name: 'Video', type: 'video', visible: true, cells: {},
          offset: { x: 0, y: 0 }, assetId: 'media',
          transform: { x: 5, y: 3, scale: 0.5, rot: 10 },
        },
      },
    ],
    clips: [
      {
        id: 'effect-clip', trackId: 'effect-track', kind: 'effect', startTick: 0,
        inTick: 0, outTick: 3, sourceDuration: 3,
        frameKeys: [{ tick: 0, value: {} }],
        propertyTracks: {
          effectIntensity: [{ tick: 0, value: 0 }, { tick: 2, value: 1 }],
          maskOpacity: [{ tick: 0, value: 1 }, { tick: 2, value: 0.5 }],
          maskPosition: [
            { tick: 0, value: { x: 0, y: 0 } },
            { tick: 2, value: { x: 2, y: 4 } },
          ],
        },
      },
      {
        id: 'video-clip', trackId: 'video-track', kind: 'video', startTick: 0,
        inTick: 0, outTick: 3, sourceDuration: 3,
        assetId: 'media', inPoint: 0.25, outPoint: 2, playbackRate: 1.5, duration: 3,
        frameKeys: [{ tick: 0, value: { cells: {} } }],
      },
    ],
  });
  const [effect, video] = resolveClipTimelineLayers(state, 1);
  assert.deepEqual({
    intensity: effect.effect.intensity,
    opacity: effect.mask.opacity,
    offset: effect.mask.offset,
  }, { intensity: 0.5, opacity: 0.75, offset: { x: 1, y: 2 } });
  assert.equal(video.videoClip.assetId, 'media');
  assert.deepEqual(video.transform, { x: 5, y: 3, scale: 0.5, rot: 10 });
});

test('frame and controller APIs expose tick duration, max end, and immutable reads', () => {
  const state = manualState();
  assert.equal(clipTimelineDurationTicks(state), 5);
  assert.equal(clipTimelineTickDuration(state), 50);
  const frame = resolveClipTimelineAtTick(state, 3);
  assert.deepEqual({
    tick: frame.tick,
    duration: frame.duration,
    tickDuration: frame.tickDuration,
    hold: frame.hold,
    layerIds: frame.layers.map((layer) => layer.id),
  }, {
    tick: 3,
    duration: 50,
    tickDuration: 50,
    hold: 1,
    layerIds: ['group', 'cell'],
  });
  const resolver = createClipTimelineResolver(state);
  assert.equal(resolver.durationTicks, 5);
  assert.equal(resolver.tickDuration, 50);
  const read = resolver.resolveLayers(3);
  read[1].cells['0,0'].c = 'changed';
  assert.equal(resolver.resolveLayers(3)[1].cells['0,0'].c, 'A');
  assert.throws(() => resolver.resolve(5), /outside/);
  assert.deepEqual(resolveClipTimelineLayers(state, 5), []);
});

if (failed) {
  console.error(`${failed} clip timeline resolver test(s) failed; ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`ok - ${passed} clip timeline resolver tests`);
}
