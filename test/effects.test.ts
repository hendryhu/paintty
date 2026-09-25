import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { mixTerminalColor, transformTerminalColor } from '../src/lib/effects.ts';
import { loadJSON, serializeJSON } from '../src/lib/fileio.ts';
import {
  beginStroke,
  compositeWorld as compositeEditorWorld,
  endStroke,
  layers,
  setLayerOpacity,
  undo,
} from '../src/lib/grid.ts';
import * as F from '../src/lib/frames.ts';
import type {
  EditorBounds,
  EditorCell,
  EditorCellGrid,
  EditorCellLayer,
  EditorEffect,
  EditorEffectLayer,
  EditorLayer,
} from '../src/lib/types/editor-domain.ts';

const viewport = { x: 0, y: 0, w: 3, h: 1 };
const glyph = (fg: string, bg?: string): EditorCell => ({ c: '@', fg, ...(bg ? { bg } : {}) });
const effect = (
  kind: EditorEffect['kind'],
  intensity: number,
  extra: Record<string, unknown> = {},
): unknown => ({
  type: 'effect',
  visible: true,
  effect: kind === 'solid-color'
    ? { kind, color: (extra['color'] as string) || '#ffffff', intensity }
    : { kind, intensity },
  cells: {},
  ...extra,
});

function colorClipEffect(
  intensity: number,
  cells: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    type: 'effect',
    visible: true,
    effect: { kind: 'color-clip', intensity },
    clipped: true,
    cells,
    ...extra,
  };
}

function solidColorEffect(
  color: string,
  intensity: number,
  extra: Record<string, unknown> = {},
): unknown {
  return effect('solid-color', intensity, { color, ...extra });
}

function compositeWorld(fixtureLayers: unknown[], worldViewport: EditorBounds): EditorCellGrid {
  return compositeEditorWorld(fixtureLayers as EditorLayer[], worldViewport);
}

interface SavedEffectLayer {
  type: string;
  opacity?: number;
  effect?: unknown;
  clipped?: boolean;
  mask?: { cells: Record<string, unknown> };
}

interface SavedEffectTrack {
  id: string;
  layer?: SavedEffectLayer;
}

interface SavedEffectClip {
  trackId: string;
  frameKeys: Array<{ value: { mask?: unknown } }>;
}

interface SavedEffectProject {
  timeline: {
    tracks: SavedEffectTrack[];
    clips: SavedEffectClip[];
  };
}

{
  const art = { type: 'cell', visible: true, cells: { '0,0': glyph('#404040') } };
  const brightenThenContrast = compositeWorld([
    effect('contrast', 1),
    effect('brightness', 0.25),
    art,
  ], viewport)[0]![0];
  const contrastThenBrighten = compositeWorld([
    effect('brightness', 0.25),
    effect('contrast', 1),
    art,
  ], viewport)[0]![0];

  assert.equal(brightenThenContrast!.fg, '#828282');
  assert.equal(contrastThenBrighten!.fg, '#404040');
}

{
  const result = compositeWorld([
    effect('brightness', 0.25),
    { type: 'cell', visible: true, cells: { '0,0': glyph('#202020') } },
    { type: 'background', visible: true, cells: { '1,0': { bg: '#010203' } } },
  ], viewport)[0]!;

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
  ], viewport)[0]![0];
  assert.deepEqual(result, original, 'a hidden effect is inert');
}

{
  const result = compositeWorld([
    effect('brightness', 0.25, { clipped: true }),
    { type: 'cell', visible: true, cells: { '0,0': glyph('#202020') } },
    { type: 'background', visible: true, cells: { '0,0': { bg: '#010203' } } },
  ], viewport)[0]![0];
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
  ], viewport)[0]!.map((entry) => entry!.fg);
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
  ], groupedViewport)[0]!.map((entry) => entry!.fg);
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
  const saved = JSON.parse(serializeJSON()) as SavedEffectProject;
  const savedEffectTrack = saved.timeline.tracks.find((track) => track.layer?.type === 'effect')!;
  const savedEffectClip = saved.timeline.clips.find((clip) => clip.trackId === savedEffectTrack.id)!;
  assert.deepEqual({
    effect: savedEffectTrack.layer!.effect,
    clipped: savedEffectTrack.layer!.clipped,
    mask: savedEffectClip.frameKeys[0]!.value.mask,
  }, {
    effect: { kind: 'contrast', intensity: 0.35 },
    clipped: true,
    mask: { defaultStrength: 1, cells: { '0,0': { mask: 0.25 } }, offset: { x: 0, y: 0 } },
  });

  loadJSON(JSON.stringify(saved));
  const restored = get(layers);
  assert.equal(restored.find((layer) => layer.type === 'cell')!.opacity, 0.42);
  assert.deepEqual(restored.find((layer): layer is EditorEffectLayer => layer.type === 'effect')!.mask!.cells, {
    '0,0': { mask: 0.25 },
  });
}

{
  const cellLayer = get(layers).find((layer): layer is EditorCellLayer => layer.type === 'cell')!;
  beginStroke();
  setLayerOpacity(cellLayer.id, 0.2);
  setLayerOpacity(cellLayer.id, 0);
  endStroke();
  assert.equal(get(layers).find((layer) => layer.id === cellLayer.id)!.opacity, 0);
  undo();
  assert.equal(
    get(layers).find((layer) => layer.id === cellLayer.id)!.opacity,
    0.42,
    'a live opacity scrub is one undo step',
  );

  const effectLayer = get(layers).find((layer): layer is EditorEffectLayer => layer.type === 'effect')!;
  assert.equal(F.setEffectIntensityTrackEnabled(effectLayer.id, true), true);
  beginStroke();
  F.setEffectIntensityKey(effectLayer.id, 0, 0.1);
  F.setEffectIntensityKey(effectLayer.id, 0, 0);
  endStroke();
  assert.equal(F.effectIntensityAt(effectLayer.id, 0), 0);
  undo();
  assert.equal(F.effectIntensityAt(effectLayer.id, 0), 0.35, 'an animated scalar scrub is one undo step');
}

// Solid Color adjustment tests.
{
  // Basic mix: 50% red over gray foreground.
  const result = compositeWorld([
    solidColorEffect('#ff0000', 0.5, { clipped: true }),
    { type: 'cell', visible: true, cells: { '0,0': glyph('#808080') } },
  ], viewport)[0]![0];
  assert.deepEqual(result!.fg, mixTerminalColor('#808080', '#ff0000', 0.5),
    'solid color mixes toward the painted color by intensity');
}

{
  // Mix 0 is inert.
  const result = compositeWorld([
    solidColorEffect('#ff0000', 0, { clipped: true }),
    { type: 'cell', visible: true, cells: { '0,0': glyph('#808080') } },
  ], viewport)[0]![0];
  assert.equal(result!.fg, '#808080', 'zero mix leaves the target unchanged');
}

{
  // Full mix replaces color.
  const result = compositeWorld([
    solidColorEffect('#00ff00', 1, { clipped: true }),
    { type: 'cell', visible: true, cells: { '0,0': glyph('#808080') } },
  ], viewport)[0]![0];
  assert.equal(result!.fg, '#00ff00', 'full mix replaces the target color');
}

{
  // Missing channels are never created.
  const result = compositeWorld([
    solidColorEffect('#ff0000', 1, { clipped: true }),
    { type: 'background', visible: true, cells: { '0,0': { bg: '#404040' } } },
  ], viewport)[0]![0];
  assert.deepEqual(result, { bg: '#ff0000' },
    'solid color adjusts background without creating a foreground');
}

{
  // Transparent cell stays transparent.
  const result = compositeWorld([
    solidColorEffect('#ff0000', 1),
    { type: 'cell', visible: true, cells: {} },
  ], viewport)[0]![0];
  assert.equal(result, null, 'transparent cell remains transparent under solid color');
}

{
  // Mask controls spatial strength.
  const result = compositeWorld([
    solidColorEffect('#ff0000', 1, {
      mask: { defaultStrength: 1, cells: { '0,0': { mask: 0 }, '1,0': { mask: 0.5 } } },
    }),
    {
      type: 'cell', visible: true,
      cells: {
        '0,0': glyph('#808080'),
        '1,0': glyph('#808080'),
        '2,0': glyph('#808080'),
      },
    },
  ], viewport)[0]!.map((entry) => entry!.fg);
  assert.deepEqual(result, [
    '#808080',
    mixTerminalColor('#808080', '#ff0000', 0.5),
    '#ff0000',
  ], 'mask strength gates the solid color mix');
}

{
  // Stacked clipped effects share the same base target.
  const result = compositeWorld([
    solidColorEffect('#0000ff', 0.5, { clipped: true }),
    effect('brightness', 0.25, { clipped: true }),
    { type: 'cell', visible: true, cells: { '0,0': glyph('#404040') } },
  ], viewport)[0]![0];
  // Brightness applies first: #404040 + 25% = #808080.
  // Then Solid Color mixes #808080 toward #0000ff at 50%.
  const expected = mixTerminalColor('#808080', '#0000ff', 0.5);
  assert.equal(result!.fg, expected,
    'stacked clipped effects share the base target and apply bottom-to-top');
}

{
  // An effect directly above a non-effect does not affect unrelated layers.
  const result = compositeWorld([
    solidColorEffect('#ff0000', 1, { clipped: true }),
    effect('brightness', 0.25, { clipped: true }),
    { type: 'cell', visible: true, cells: { '0,0': glyph('#404040') } },
    { type: 'background', visible: true, cells: { '1,0': { bg: '#101010' } } },
  ], { x: 0, y: 0, w: 2, h: 1 })[0]!;
  // The background at 1,0 remains outside the clipped stack's target coverage.
  assert.equal(result[1]!.bg, '#101010',
    'clipped stack does not affect layers below the base target');
}

assert.equal(mixTerminalColor('#808080', '#ff0000', 0), '#808080');
assert.equal(mixTerminalColor('#808080', '#ff0000', 1), '#ff0000');
assert.equal(mixTerminalColor('#000000', '#ffffff', 0.5), '#808080');

// Colour Clip Layer tests.
{
  // Basic: painted red at 50% mix over gray foreground.
  const result = compositeWorld([
    colorClipEffect(0.5, { '0,0': { c: '', fg: null, bg: '#ff0000' } }),
    { type: 'cell', visible: true, cells: { '0,0': glyph('#808080') } },
  ], viewport)[0]![0];
  assert.deepEqual(result!.fg, mixTerminalColor('#808080', '#ff0000', 0.5),
    'colour clip mixes painted per-cell color into target foreground');
}

{
  // An unpainted cell is inert.
  const result = compositeWorld([
    colorClipEffect(1, {}),
    { type: 'cell', visible: true, cells: { '0,0': glyph('#808080') } },
  ], viewport)[0]![0];
  assert.equal(result!.fg, '#808080', 'unpainted colour clip cell is inert');
}

{
  // Multiple colors remain independent per cell.
  const vp3 = { x: 0, y: 0, w: 3, h: 1 };
  const result = compositeWorld([
    colorClipEffect(1, {
      '0,0': { c: '', fg: null, bg: '#ff0000' },
      '1,0': { c: '', fg: null, bg: '#00ff00' },
      '2,0': { c: '', fg: null, bg: '#0000ff' },
    }),
    {
      type: 'cell', visible: true,
      cells: {
        '0,0': glyph('#808080'),
        '1,0': glyph('#808080'),
        '2,0': glyph('#808080'),
      },
    },
  ], vp3)[0]!.map((entry) => entry!.fg);
  assert.deepEqual(result, ['#ff0000', '#00ff00', '#0000ff'],
    'colour clip supports different colors per cell');
}

{
  // Missing channels are never created.
  const result = compositeWorld([
    colorClipEffect(1, { '0,0': { c: '', fg: null, bg: '#ff0000' } }),
    { type: 'background', visible: true, cells: { '0,0': { bg: '#404040' } } },
  ], viewport)[0]![0];
  assert.deepEqual(result, { bg: '#ff0000' },
    'colour clip adjusts background without creating foreground');
}

{
  // Transparent cells stay transparent.
  const result = compositeWorld([
    colorClipEffect(1, { '0,0': { c: '', fg: null, bg: '#ff0000' } }),
    { type: 'cell', visible: true, cells: {} },
  ], viewport)[0]![0];
  assert.equal(result, null, 'transparent cell remains transparent under colour clip');
}

{
  // Mix 0 is inert.
  const result = compositeWorld([
    colorClipEffect(0, { '0,0': { c: '', fg: null, bg: '#ff0000' } }),
    { type: 'cell', visible: true, cells: { '0,0': glyph('#808080') } },
  ], viewport)[0]![0];
  assert.equal(result!.fg, '#808080', 'zero mix leaves target unchanged');
}

{
  // A Colour Clip above Brightness shares the same clipped target.
  const result = compositeWorld([
    colorClipEffect(0.5, { '0,0': { c: '', fg: null, bg: '#0000ff' } }, { clipped: true }),
    effect('brightness', 0.25, { clipped: true }),
    { type: 'cell', visible: true, cells: { '0,0': glyph('#404040') } },
  ], viewport)[0]![0];
  // Brightness applies first: #404040 + 25% = #808080.
  // Then Colour Clip mixes #808080 toward #0000ff at 50%.
  const expected = mixTerminalColor('#808080', '#0000ff', 0.5);
  assert.equal(result!.fg, expected,
    'stacked colour clip and brightness share the base target');
}

{
  // Colour Clip does not affect layers below the target.
  const vp2 = { x: 0, y: 0, w: 2, h: 1 };
  const result = compositeWorld([
    colorClipEffect(1, { '0,0': { c: '', fg: null, bg: '#ff0000' } }),
    { type: 'cell', visible: true, cells: { '0,0': glyph('#404040') } },
    { type: 'background', visible: true, cells: { '1,0': { bg: '#101010' } } },
  ], vp2)[0]!;
  assert.equal(result[1]!.bg, '#101010',
    'clipped colour clip does not affect layers below the target');
}

{
  // Colour Clip is always clipped even without a clipped flag.
  const result = compositeWorld([
    colorClipEffect(1, { '0,0': { c: '', fg: null, bg: '#ff0000' } }, { clipped: false }),
    { type: 'cell', visible: true, cells: { '0,0': glyph('#404040') } },
    { type: 'cell', visible: true, cells: { '1,0': glyph('#202020') } },
  ], { x: 0, y: 0, w: 2, h: 1 })[0]!;
  assert.equal(result[0]!.fg, '#ff0000', 'colour clip applies to target');
  assert.equal(result[1]!.fg, '#202020', 'colour clip does not affect non-target layers even without clipped flag');
}

{
  // Colour Clip with a group target sits directly above the group header.
  const vp3 = { x: 0, y: 0, w: 3, h: 1 };
  const result = compositeWorld([
    colorClipEffect(1, {
      '0,0': { c: '', fg: null, bg: '#ff0000' },
      '1,0': { c: '', fg: null, bg: '#00ff00' },
    }, { groupId: 9 }),
    { id: 9, type: 'group', visible: true, cells: {} },
    { id: 1, type: 'cell', visible: true, groupId: 9, cells: { '0,0': glyph('#808080') } },
    { id: 2, type: 'cell', visible: true, groupId: 9, cells: { '1,0': glyph('#808080') } },
  ], vp3)[0]!.map((entry) => entry?.fg ?? null);
  assert.deepEqual(result, ['#ff0000', '#00ff00', null],
    'colour clip above group header targets group children coverage');
}

// Binary content mask tests.
{
  const result = compositeWorld([
    {
      type: 'cell', visible: true,
      contentMask: { defaultStrength: 0, cells: { '0,0': { bg: '#ffffff' } } },
      cells: {
        '0,0': glyph('#ff0000'),
        '1,0': glyph('#00ff00'),
      },
    },
  ], viewport)[0]!;
  assert.equal(result[0]?.fg, '#ff0000', 'white content-mask cells reveal their source channel');
  assert.equal(result[1], null, 'a black content-mask default blocks unpainted content');
}

{
  const result = compositeWorld([
    {
      type: 'cell', visible: true,
      contentMask: { defaultStrength: 1, cells: { '0,0': { bg: '#e06c6c' } } },
      cells: { '0,0': glyph('#ff0000'), '1,0': glyph('#00ff00') },
    },
  ], viewport)[0]!;
  assert.equal(result[0], null, 'every non-white content-mask color blocks content');
  assert.equal(result[1]?.fg, '#00ff00', 'a white content-mask default reveals content');
}

{
  const result = compositeWorld([
    {
      type: 'effect', visible: true,
      effect: { kind: 'brightness', intensity: 0.5 },
      contentMask: { defaultStrength: 0, cells: { '1,0': { bg: '#ffffff' } } },
      cells: {},
    },
    { type: 'cell', visible: true, cells: { '0,0': glyph('#202020'), '1,0': glyph('#202020') } },
  ], viewport)[0]!;
  assert.equal(result[0]?.fg, '#202020', 'a black effect content-mask default blocks the adjustment');
  assert.equal(result[1]?.fg, '#a0a0a0', 'a white effect content-mask cell reveals the adjustment');
}

{
  const result = compositeWorld([
    { id: 9, type: 'group', visible: true, contentMask: { defaultStrength: 0, cells: { '1,0': { bg: '#ffffff' } } }, cells: {} },
    { id: 1, type: 'cell', groupId: 9, visible: true, cells: { '0,0': glyph('#ff0000'), '1,0': glyph('#00ff00') } },
  ], viewport)[0]!;
  assert.equal(result[0], null, 'a group content mask blocks child content at its black default');
  assert.equal(result[1]?.fg, '#00ff00', 'a group content mask reveals child content at white cells');
}

{
  const result = compositeWorld([
    {
      type: 'shape', visible: true,
      shape: {
        kind: 'rect', x0: 0, y0: 0, x1: 0, y1: 0,
        style: 'filled', detail: 'cell', channel: 'color-clip', fg: '#ff0000', mix: 0.5,
      },
      cells: { '0,0': { bg: '#ff0000' } },
    },
    { type: 'cell', visible: true, cells: { '0,0': glyph('#808080') } },
  ], viewport)[0]![0];
  assert.equal(result?.fg, mixTerminalColor('#808080', '#ff0000', 0.5),
    'a Colour Clip shape mixes its source color without emitting a background');
}

console.log('effects: passed');
