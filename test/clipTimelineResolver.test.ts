import assert from 'node:assert/strict';
import { createClipTimelineState } from '../src/lib/clipTimeline.ts';
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
} from '../src/lib/clipTimelineResolver.ts';
import type { EditorEffectLayer, EditorShape, EditorShapeLayer, EditorVideoLayer } from '../src/lib/types/editor-domain.ts';
import {
  editorCell,
  errorStack,
  requireValue,
} from './types/timeline-media-test-types.ts';

let passed = 0;
let failed = 0;

function test(name: string, run: () => void): void {
  try {
    run();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n${errorStack(error)}`);
  }
}

function cell(glyph: string, fg = '#ffffff') {
  return editorCell(glyph, fg);
}

const lineAppearance: EditorShape = {
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
  const middleCellLayer = requireValue(middle[1]);
  assert.equal(requireValue(middleCellLayer.cells['0,0']).c, 'A');
  assert.deepEqual(middleCellLayer.offset, { x: 2, y: 1 });
  assert.equal(middleCellLayer.visible, true);
  const last = requireValue(resolveClipTimelineLayers(state, 4)[1]);
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
  const middle = requireValue(resolveClipTimelineLayers(state, 1)[0]);
  assert.deepEqual(middle.offset, { x: 2, y: 1 });
  assert.equal(middle.visible, true);
  assert.equal(requireValue(resolveClipTimelineLayers(state, 2)[0]).visible, false);
});

test('clip lookup exposes project-to-local and trimmed source mapping', () => {
  const state = manualState();
  const clip = requireValue(findClipAtProjectTick(state, 'cell', 3));
  assert.equal(clip.id, 'cell-clip');
  assert.equal(findClipAtProjectTick(state, 'cell-track', 1), null);
  assert.deepEqual(projectTickToClipLocal(clip, 3), {
    projectTick: 3,
    clipLocalTick: 1,
    sourceTick: 1,
  });
  const lookup = requireValue(lookupClipAtProjectTick(state, 'cell', 4));
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
  const clip = requireValue(createClipTimelineState({
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
  }).clips[0]);
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
  const layer = requireValue(resolveClipTimelineLayers(state, 1)[0]);
  assert.equal(layer.type, 'shape');
  const shapeLayer = layer as EditorShapeLayer;
  const shape = requireValue(shapeLayer.shape);
  assert.deepEqual({ x0: shape.x0, x1: shape.x1 }, { x0: 2, x1: 4 });
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
          transform: { x: 5, y: 3, scale: 0.5, rot: 10 },
          videoClip: {
            assetId: 'media', width: 1, height: 1, startTick: 0,
            inPoint: 0.25, outPoint: 2, playbackRate: 1.5, duration: 3,
          },
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
  assert.equal(effect?.type, 'effect');
  assert.equal(video?.type, 'video');
  const effectLayer = requireValue(effect) as EditorEffectLayer;
  const videoLayer = requireValue(video) as EditorVideoLayer;
  assert.deepEqual({
    intensity: requireValue(effectLayer.effect).intensity,
    opacity: requireValue(effectLayer.mask).opacity,
    offset: requireValue(effectLayer.mask).offset,
  }, { intensity: 0.5, opacity: 0.75, offset: { x: 1, y: 2 } });
  assert.equal(videoLayer.videoClip.assetId, 'media');
  assert.deepEqual(videoLayer.transform, { x: 5, y: 3, scale: 0.5, rot: 10 });
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
  requireValue(requireValue(read[1]).cells['0,0']).c = 'changed';
  assert.equal(requireValue(requireValue(resolver.resolveLayers(3)[1]).cells['0,0']).c, 'A');
  assert.throws(() => resolver.resolve(5), /outside/);
  assert.deepEqual(resolveClipTimelineLayers(state, 5), []);
});

test('effectColor interpolates via OKLCH shortest hue path', () => {
  const state = createClipTimelineState({
    fps: 10,
    tracks: [{
      id: 'effect-track', kind: 'visual', locked: false,
      layer: {
        id: 'effect-layer', name: 'Adjust', type: 'effect', visible: true, cells: {},
        effect: { kind: 'solid-color', color: '#ff0000', intensity: 1 },
        mask: { defaultStrength: 1, cells: {}, offset: { x: 0, y: 0 } },
        offset: { x: 0, y: 0 },
      },
    }],
    clips: [{
      id: 'clip', trackId: 'effect-track', kind: 'visual',
      startTick: 0, inTick: 0, outTick: 10, sourceDuration: 10,
      frameKeys: [], propertyTracks: {
        effectColor: [
          { tick: 0, value: '#0000ff' },
          { tick: 10, value: '#00ff00' },
        ],
      },
    }],
  });

  const at0 = resolveClipPropertyAtTick(
    state.clips[0]!, CLIP_TIMELINE_PROPERTIES.effectColor, 0, '#ff0000');
  assert.equal(at0, '#0000ff', 'color at first key is the key value');

  const at9 = resolveClipPropertyAtTick(
    state.clips[0]!, CLIP_TIMELINE_PROPERTIES.effectColor, 9, '#ff0000');
  // Tick 9 is just before the last key; it should be close to #00ff00 but not exactly.
  assert.ok(typeof at9 === 'string' && /^#[0-9a-f]{6}$/i.test(at9),
    `color near last key is a hex string, got ${at9}`);

  const mid = resolveClipPropertyAtTick(
    state.clips[0]!, CLIP_TIMELINE_PROPERTIES.effectColor, 5, '#ff0000');
  // Blue to green should go through cyan-ish, not through red.
  // #0000ff in OKLCH ~ (L=0.45, C=0.31, H=264).
  // #00ff00 in OKLCH ~ (L=0.87, C=0.29, H=142).
  // The shortest hue path goes backward from 264 to 142 degrees.
  // The midpoint should be around hue 203, between blue and cyan.
  assert.ok(typeof mid === 'string' && /^#[0-9a-f]{6}$/i.test(mid),
    `mid color is a hex string, got ${mid}`);
  // The midpoint should not be red/magenta, which would indicate the long way around.
  const midHex = String(mid);
  const r = parseInt(midHex.slice(1, 3), 16);
  const g = parseInt(midHex.slice(3, 5), 16);
  const b = parseInt(midHex.slice(5, 7), 16);
  assert.ok(b > r && g >= r,
    `mid point favors blue/green over red, got ${mid} (r=${r} g=${g} b=${b})`);
});

test('effectColor handles gray-to-chromatic without hue spin', () => {
  const state = createClipTimelineState({
    fps: 10,
    tracks: [{
      id: 'gray-track', kind: 'visual', locked: false,
      layer: {
        id: 'gray-layer', name: 'Gray', type: 'effect', visible: true, cells: {},
        effect: { kind: 'solid-color', color: '#808080', intensity: 1 },
        mask: { defaultStrength: 1, cells: {}, offset: { x: 0, y: 0 } },
        offset: { x: 0, y: 0 },
      },
    }],
    clips: [{
      id: 'gray-clip', trackId: 'gray-track', kind: 'visual',
      startTick: 0, inTick: 0, outTick: 10, sourceDuration: 10,
      frameKeys: [], propertyTracks: {
        effectColor: [
          { tick: 0, value: '#808080' },
          { tick: 10, value: '#ff0000' },
        ],
      },
    }],
  });

  const mid = resolveClipPropertyAtTick(
    state.clips[0]!, CLIP_TIMELINE_PROPERTIES.effectColor, 5, '#808080');
  // Gray to red should go through a pinkish light-red, not through green or blue.
  const midHex = String(mid);
  const r = parseInt(midHex.slice(1, 3), 16);
  const g = parseInt(midHex.slice(3, 5), 16);
  const b = parseInt(midHex.slice(5, 7), 16);
  assert.ok(r > g && r > b,
    `gray-to-red midpoint favors red, got ${mid} (r=${r} g=${g} b=${b})`);
});

test('group content masks resolve from held group property keys', () => {
  const state = createClipTimelineState({
    fps: 12,
    tracks: [{
      id: 'group-track', kind: 'group', locked: false,
      layer: {
        id: 'group-layer', name: 'Group', type: 'group', visible: true, cells: {},
        contentMask: { defaultStrength: 1, cells: {}, offset: { x: 0, y: 0 } },
      },
      propertyTracks: {
        contentMask: [{
          tick: 2,
          value: {
            defaultStrength: 0,
            cells: { '1,0': { bg: '#ffffff' } },
            offset: { x: 3, y: -1 },
          },
        }],
      },
    }],
    clips: [],
  });

  const before = requireValue(resolveClipTimelineLayers(state, 1)[0]);
  assert.deepEqual(before.contentMask, { defaultStrength: 1, cells: {}, offset: { x: 0, y: 0 } });
  const held = requireValue(resolveClipTimelineLayers(state, 2)[0]);
  assert.deepEqual(held.contentMask, {
    defaultStrength: 0,
    cells: { '1,0': { bg: '#ffffff' } },
    offset: { x: 3, y: -1 },
  });
});

test('Colour Clip shape mix interpolates as a scalar property', () => {
  const state = createClipTimelineState({
    fps: 10,
    tracks: [{
      id: 'shape-track', kind: 'visual', locked: false,
      layer: {
        id: 'shape-layer', name: 'Clip shape', type: 'shape', visible: true,
        shape: {
          kind: 'rect', x0: 0, y0: 0, x1: 1, y1: 1,
          style: 'filled', detail: 'cell', channel: 'color-clip', fg: '#ff0000', mix: 0,
        },
        cells: {}, offset: { x: 0, y: 0 },
      },
    }],
    clips: [{
      id: 'shape-clip', trackId: 'shape-track', kind: 'visual',
      startTick: 0, inTick: 0, outTick: 10, sourceDuration: 10,
      frameKeys: [], propertyTracks: {
        shapeMix: [{ tick: 0, value: 0 }, { tick: 9, value: 1 }],
      },
    }],
  });

  const layer = requireValue(resolveClipTimelineLayers(state, 4)[0]);
  assert.equal(layer.type, 'shape');
  assert.ok(Math.abs((layer.shape?.mix ?? 0) - 4 / 9) < 1e-6,
    'Colour Clip shape mix resolves from its interpolated property track');
});

if (failed) {
  console.error(`${failed} clip timeline resolver test(s) failed; ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`ok - ${passed} clip timeline resolver tests`);
}
