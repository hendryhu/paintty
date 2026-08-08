import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { transformTerminalColor } from '../src/lib/effects.js';
import { loadJSON, serializeJSON } from '../src/lib/fileio.js';
import { beginStroke, compositeWorld, endStroke, layers, setLayerOpacity, undo } from '../src/lib/grid.js';
import * as F from '../src/lib/frames.js';

const viewport = { x: 0, y: 0, w: 3, h: 1 };
const glyph = (fg, bg) => ({ c: '@', fg, ...(bg ? { bg } : {}) });
const effect = (kind, intensity, extra = {}) => ({
  type: 'effect',
  visible: true,
  effect: { kind, intensity },
  cells: {},
  ...extra,
});

{
  const art = { type: 'cell', visible: true, cells: { '0,0': glyph('#404040') } };
  const brightenThenContrast = compositeWorld([
    effect('contrast', 1),
    effect('brightness', 0.25),
    art,
  ], viewport)[0][0];
  const contrastThenBrighten = compositeWorld([
    effect('brightness', 0.25),
    effect('contrast', 1),
    art,
  ], viewport)[0][0];

  assert.equal(brightenThenContrast.fg, '#828282');
  assert.equal(contrastThenBrighten.fg, '#404040');
}

{
  const result = compositeWorld([
    effect('brightness', 0.25),
    { type: 'cell', visible: true, cells: { '0,0': glyph('#202020') } },
    { type: 'background', visible: true, cells: { '1,0': { bg: '#010203' } } },
  ], viewport)[0];

  assert.deepEqual(result, [
    { c: '@', fg: '#606060' },
    { bg: '#414243' },
    null,
  ], 'effects transform existing terminal channels without creating content');
}

{
  const original = glyph('#123456', '#654321');
  const result = compositeWorld([
    effect('brightness', 1, { visible: false }),
    { type: 'cell', visible: true, cells: { '0,0': original } },
  ], viewport)[0][0];
  assert.deepEqual(result, original, 'a hidden effect is inert');
}

{
  const result = compositeWorld([
    effect('brightness', 0.25, { clipped: true }),
    { type: 'cell', visible: true, cells: { '0,0': glyph('#202020') } },
    { type: 'background', visible: true, cells: { '0,0': { bg: '#010203' } } },
  ], viewport)[0][0];
  assert.deepEqual(result, glyph('#606060', '#010203'));
}

{
  const result = compositeWorld([
    effect('brightness', 0.5, {
      mask: { defaultStrength: 1, cells: { '0,0': { mask: 0 }, '1,0': { mask: 0.5 } } },
    }),
    {
      type: 'cell',
      visible: true,
      cells: { '0,0': glyph('#202020'), '1,0': glyph('#202020'), '2,0': glyph('#202020') },
    },
  ], viewport)[0].map((entry) => entry.fg);
  assert.deepEqual(result, ['#202020', '#606060', '#a0a0a0']);
}

{
  const groupedViewport = { x: 0, y: 0, w: 4, h: 1 };
  const result = compositeWorld([
    effect('brightness', 0.5, {
      id: 1,
      groupId: 9,
      offset: { x: 1, y: 0 },
      mask: {
        defaultStrength: 1,
        offset: { x: 1, y: 0 },
        cells: { '0,0': { mask: 0 } },
      },
    }),
    {
      type: 'cell', visible: true,
      cells: Object.fromEntries([0, 1, 2, 3].map((x) => [`${x},0`, glyph('#202020')])),
    },
    { id: 9, type: 'group', visible: true, offset: { x: 1, y: 0 }, cells: {} },
  ], groupedViewport)[0].map((entry) => entry.fg);
  assert.deepEqual(result, ['#a0a0a0', '#a0a0a0', '#a0a0a0', '#202020']);
}

assert.equal(transformTerminalColor('#404040', 'contrast', 1), '#000000');
assert.equal(transformTerminalColor('#c0c0c0', 'contrast', 1), '#ffffff');
assert.equal(transformTerminalColor('#abcdef', 'brightness', 0), '#abcdef');
assert.equal(transformTerminalColor('#ff4000', 'hue', 0.5), '#73a500');
assert.equal(transformTerminalColor('#ff4000', 'saturation', -1), '#919191');

{
  const effectLayerId = '11111111-1111-4111-8111-111111111111';
  const artLayerId = '22222222-2222-4222-8222-222222222222';
  const effectTrackId = '33333333-3333-4333-8333-333333333333';
  const artTrackId = '44444444-4444-4444-8444-444444444444';
  const source = {
    format: 'paintty-sprite',
    version: 13,
    projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    width: 3,
    height: 1,
    fps: 12,
    timeline: {
      tags: [],
      tracks: [
        {
          id: effectTrackId,
          kind: 'visual',
          locked: false,
          layer: {
            id: effectLayerId, name: 'Light', type: 'effect', visible: true,
            effect: { kind: 'contrast', intensity: 0.35 }, clipped: true,
            mask: { defaultStrength: 1, cells: {}, offset: { x: 0, y: 0 } },
            cells: {}, offset: { x: 0, y: 0 },
          },
        },
        {
          id: artTrackId,
          kind: 'visual',
          locked: false,
          layer: {
            id: artLayerId, name: 'Art', type: 'cell', visible: true,
            opacity: 0.42, cells: {}, offset: { x: 0, y: 0 },
          },
        },
      ],
      clips: [
        {
          id: '55555555-5555-4555-8555-555555555555', trackId: effectTrackId,
          kind: 'visual', startTick: 0, inTick: 0, outTick: 1, sourceDuration: 1,
          frameKeys: [{ tick: 0, value: {
            cells: {},
            mask: {
              defaultStrength: 1, cells: { '0,0': { mask: 0.25 } }, offset: { x: 0, y: 0 },
            },
          } }],
          propertyTracks: {},
        },
        {
          id: '66666666-6666-4666-8666-666666666666', trackId: artTrackId,
          kind: 'visual', startTick: 0, inTick: 0, outTick: 1, sourceDuration: 1,
          frameKeys: [{ tick: 0, value: { cells: { '0,0': glyph('#808080') } } }],
          propertyTracks: {},
        },
      ],
    },
    media: { generation: 0, assets: [] },
  };

  loadJSON(JSON.stringify(source));
  const saved = JSON.parse(serializeJSON());
  const savedEffectTrack = saved.timeline.tracks.find((track) => track.layer?.type === 'effect');
  const savedEffectClip = saved.timeline.clips.find((clip) => clip.trackId === savedEffectTrack.id);
  assert.deepEqual({
    effect: savedEffectTrack.layer.effect,
    clipped: savedEffectTrack.layer.clipped,
    mask: savedEffectClip.frameKeys[0].value.mask,
  }, {
    effect: { kind: 'contrast', intensity: 0.35 },
    clipped: true,
    mask: { defaultStrength: 1, cells: { '0,0': { mask: 0.25 } }, offset: { x: 0, y: 0 } },
  });

  loadJSON(JSON.stringify(saved));
  const restored = get(layers);
  assert.equal(restored.find((layer) => layer.type === 'cell').opacity, 0.42);
  assert.deepEqual(restored.find((layer) => layer.type === 'effect').mask.cells, {
    '0,0': { mask: 0.25 },
  });
}

{
  const cellLayer = get(layers).find((layer) => layer.type === 'cell');
  beginStroke();
  setLayerOpacity(cellLayer.id, 0.2);
  setLayerOpacity(cellLayer.id, 0);
  endStroke();
  assert.equal(get(layers).find((layer) => layer.id === cellLayer.id).opacity, 0);
  undo();
  assert.equal(
    get(layers).find((layer) => layer.id === cellLayer.id).opacity,
    0.42,
    'a live opacity scrub is one undo step',
  );

  const effectLayer = get(layers).find((layer) => layer.type === 'effect');
  assert.equal(F.setEffectIntensityTrackEnabled(effectLayer.id, true), true);
  beginStroke();
  F.setEffectIntensityKey(effectLayer.id, 0, 0.1);
  F.setEffectIntensityKey(effectLayer.id, 0, 0);
  endStroke();
  assert.equal(F.effectIntensityAt(effectLayer.id, 0), 0);
  undo();
  assert.equal(F.effectIntensityAt(effectLayer.id, 0), 0.35, 'an animated scalar scrub is one undo step');
}

console.log('effects: passed');
