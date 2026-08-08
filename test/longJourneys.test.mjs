import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import * as F from '../src/lib/frames.js';
import * as G from '../src/lib/grid.js';
import * as S from '../src/lib/selection.js';
import { loadJSON, serializeJSON, serializeTXT } from '../src/lib/fileio.js';
import { renderShapeToCells } from '../src/lib/shapes.js';
import { activeChar, activeTool, paintColor } from '../src/lib/stores.js';
import { applyTool } from '../src/lib/tools.js';
import { getClipTimelineState } from '../src/lib/clipTimelineState.js';
import { validLoopRange } from '../src/lib/timelineTags.js';

function resetDocument(layerDefs, width, height) {
  G.dims.set({ w: width, h: height });
  G.setLayers(layerDefs);
  F.fps.set(12);
  F.initTimeline(get(G.layers));
}

function stroke(action) {
  G.beginStroke();
  action();
  G.endStroke();
}

function extendVisualClips(endTick) {
  G.beginStroke();
  for (const clip of getClipTimelineState().clips.filter((candidate) => candidate.kind === 'visual')) {
    F.trimClip(clip.id, 'end', endTick);
  }
  G.endStroke();
}

function frameSummary() {
  const { w, h } = get(G.dims);
  return get(F.frames).map((frame) => {
    const cells = F.compositeFrameCells(frame, w, h);
    const glyphs = [];
    const backgrounds = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cell = cells[y][x];
        if (cell?.c) glyphs.push(`${x},${y}:${cell.c}:${cell.fg}`);
        if (cell?.bg) backgrounds.push(`${x},${y}:${cell.bg}`);
      }
    }
    return { glyphs, backgrounds };
  });
}

function glyphPositions(glyph) {
  const { w, h } = get(G.dims);
  return get(F.frames).map((frame) => {
    const cells = F.compositeFrameCells(frame, w, h);
    const positions = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (cells[y][x]?.c === glyph) positions.push(`${x},${y}`);
      }
    }
    return positions;
  });
}

function renderedForegrounds() {
  const { w, h } = get(G.dims);
  assert.equal(h, 1);
  return get(F.frames).map((frame) =>
    F.compositeFrameCells(frame, w, h)[0].map((cell) => cell?.fg ?? null));
}

function glyphBoundsByFrame() {
  const { w, h } = get(G.dims);
  return get(F.frames).map((frame) => {
    const cells = F.compositeFrameCells(frame, w, h);
    const points = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (cells[y][x]?.c) points.push({ x, y });
      }
    }
    if (!points.length) return null;
    return {
      minX: Math.min(...points.map((point) => point.x)),
      maxX: Math.max(...points.map((point) => point.x)),
      minY: Math.min(...points.map((point) => point.y)),
      maxY: Math.max(...points.map((point) => point.y)),
    };
  });
}

function animatedGroupedSaveJourney() {
  resetDocument([
    { name: 'Glyphs', type: 'cell', visible: true, cells: {} },
  ], 7, 3);
  const glyphId = get(G.activeLayerId);

  activeTool.set('brush');
  activeChar.set('A');
  paintColor.set('#ff0000');
  stroke(() => applyTool(1, 1, {}, 'down'));

  G.addLayer('background');
  const backgroundId = get(G.activeLayerId);
  stroke(() => {
    G.setCell(1, 1, { c: '', fg: null, bg: '#101820' });
    G.setCell(2, 1, { c: '', fg: null, bg: '#203040' });
  });

  G.toggleLayerSelected(glyphId);
  G.groupActiveLayer();
  const groupId = get(G.activeLayerId);
  assert.deepEqual(
    get(G.layers).filter((layer) => layer.groupId === groupId).map((layer) => layer.id),
    [backgroundId, glyphId],
  );
  F.commitLayersToActiveFrame();

  extendVisualClips(7);
  F.gotoFrame(0);
  F.togglePosKey(groupId, 0);
  F.gotoFrame(6);
  F.setLayerOffsetById(6, groupId, { x: 3, y: 0 });
  F.gotoFrame(0);
  F.setVisibilityTrackEnabled(glyphId, true);
  F.setVisibilityKey(glyphId, 3, false);
  F.setVisibilityKey(glyphId, 6, true);

  const expected = [
    {
      glyphs: ['1,1:A:#ff0000'],
      backgrounds: ['1,1:#101820', '2,1:#203040'],
    },
    {
      glyphs: ['2,1:A:#ff0000'],
      backgrounds: ['2,1:#101820', '3,1:#203040'],
    },
    {
      glyphs: ['2,1:A:#ff0000'],
      backgrounds: ['2,1:#101820', '3,1:#203040'],
    },
    {
      glyphs: [],
      backgrounds: ['3,1:#101820', '4,1:#203040'],
    },
    {
      glyphs: [],
      backgrounds: ['3,1:#101820', '4,1:#203040'],
    },
    {
      glyphs: [],
      backgrounds: ['4,1:#101820', '5,1:#203040'],
    },
    {
      glyphs: ['4,1:A:#ff0000'],
      backgrounds: ['4,1:#101820', '5,1:#203040'],
    },
  ];
  assert.deepEqual(frameSummary(), expected);

  const saved = serializeJSON();
  loadJSON(saved);
  assert.deepEqual(frameSummary(), expected);
  assert.deepEqual(get(F.frames).map((frame) => frame.hold), Array(7).fill(1));

  F.gotoFrame(6);
  const restoredGlyph = get(G.layers).find((layer) => layer.name === 'Glyphs');
  G.selectLayer(restoredGlyph.id);
  stroke(() => G.setCell(5, 1, { c: 'B', fg: '#00ff00', bg: null }));
  F.commitLayersToActiveFrame();
  assert.deepEqual(frameSummary()[6].glyphs, [
    '4,1:A:#ff0000',
    '5,1:B:#00ff00',
  ]);
  G.undo();
  assert.deepEqual(frameSummary()[6].glyphs, ['4,1:A:#ff0000']);
  G.redo();
  assert.deepEqual(frameSummary()[6].glyphs, [
    '4,1:A:#ff0000',
    '5,1:B:#00ff00',
  ]);
}

function wideSelectionCropJourney() {
  resetDocument([
    { name: 'Source', type: 'cell', visible: true, cells: {} },
  ], 10, 5);

  activeTool.set('brush');
  paintColor.set('#ffffff');
  stroke(() => {
    activeChar.set('X');
    applyTool(0, 0, {}, 'down');
    activeChar.set('界');
    applyTool(7, 2, {}, 'down');
  });

  G.cellSelection.set(new Set(['7,2']));
  assert.equal(S.beginMove(), true);
  assert.deepEqual([...get(G.cellSelection)].sort(), ['7,2', '8,2']);
  S.updateMove(-3, 1);
  S.finalizeMove();
  F.commitLayersToActiveFrame();

  const extractedId = S.selectionToNewLayer(true);
  assert.ok(extractedId);
  G.groupActiveLayer();
  const groupId = get(G.activeLayerId);
  F.commitLayersToActiveFrame();

  F.addFrame();
  F.gotoFrame(0);
  F.togglePosKey(groupId, 0);
  F.gotoFrame(1);
  F.setLayerOffsetById(1, groupId, { x: 2, y: -1 });
  F.cropTimeline({ x: 1, y: 1, w: 8, h: 3 });

  assert.deepEqual(get(G.dims), { w: 8, h: 3 });
  assert.deepEqual(glyphPositions('界'), [['3,2'], ['5,1']]);
  assert.deepEqual(glyphPositions('X'), [[], []]);

  G.undo();
  assert.deepEqual(get(G.dims), { w: 10, h: 5 });
  assert.deepEqual(glyphPositions('界'), [['4,3'], ['6,2']]);
  assert.deepEqual(glyphPositions('X'), [['0,0'], ['0,0']]);
  G.redo();
  assert.deepEqual(get(G.dims), { w: 8, h: 3 });
  assert.deepEqual(glyphPositions('界'), [['3,2'], ['5,1']]);
  assert.deepEqual(glyphPositions('X'), [[], []]);

  F.gotoFrame(1);
  assert.deepEqual(Array.from(serializeTXT().split('\n')[1]), [
    ' ', ' ', ' ', ' ', ' ', '界', ' ',
  ]);
}

function animatedEffectJourney() {
  const cells = Object.fromEntries(Array.from({ length: 5 }, (_, x) => [
    `${x},0`,
    { c: String(x), fg: '#202020', bg: null },
  ]));
  resetDocument([
    { name: 'Numbers', type: 'cell', visible: true, cells },
  ], 5, 1);

  G.addLayer('effect');
  const effectId = get(G.activeLayerId);
  G.setEffectProperties(effectId, { kind: 'brightness', intensity: 0.25 });
  G.toggleEffectMask(effectId);
  stroke(() => G.setCell(0, 0, { mask: 0 }));
  F.commitLayersToActiveFrame();

  extendVisualClips(10);
  F.gotoFrame(0);
  F.setEffectIntensityTrackEnabled(effectId, true);
  F.setEffectIntensityKey(effectId, 0, 0.25);
  F.setEffectIntensityKey(effectId, 9, 0.5);
  F.setMaskPositionTrackEnabled(effectId, true);
  F.setMaskPositionById(0, effectId, { x: 0, y: 0 });
  F.setMaskPositionById(9, effectId, { x: 3, y: 0 });

  const before = renderedForegrounds();
  assert.equal(before.length, 10);
  assert.deepEqual(before[0], [
    '#202020', '#606060', '#606060', '#606060', '#606060',
  ]);
  assert.deepEqual(before[9], [
    '#a0a0a0', '#a0a0a0', '#a0a0a0', '#202020', '#a0a0a0',
  ]);

  const authored = renderedForegrounds();
  assert.deepEqual(authored, before);
  assert.deepEqual(get(F.frames).map((frame) => frame.hold), Array(10).fill(1));

  loadJSON(serializeJSON());
  assert.deepEqual(renderedForegrounds(), authored);
  const restoredEffect = get(G.layers).find((layer) => layer.type === 'effect');
  assert.deepEqual(F.effectIntensityKeys(restoredEffect.id), [
    { frame: 0, value: 0.25 },
    { frame: 9, value: 0.5 },
  ]);
  assert.deepEqual(F.maskPositionKeys(restoredEffect.id).map(({ frame, x, y }) => (
    { frame, x, y }
  )), [
    { frame: 0, x: 0, y: 0 },
    { frame: 9, x: 3, y: 0 },
  ]);

  const restoredState = getClipTimelineState();
  const effectTrack = restoredState.tracks.find((track) => track.layer?.id === restoredEffect.id);
  const effectClip = restoredState.clips.find((clip) => clip.trackId === effectTrack.id);
  const movedSelection = {
    propertyKeys: [
      { clipId: effectClip.id, propertyName: 'effectIntensity', sourceTick: 9 },
      { clipId: effectClip.id, propertyName: 'maskPosition', sourceTick: 9 },
    ],
  };
  stroke(() => assert.equal(F.moveTimelineKeys(movedSelection, -1).changed, true));
  assert.deepEqual(F.effectIntensityKeys(restoredEffect.id).map((key) => key.frame), [0, 8]);
  assert.deepEqual(F.maskPositionKeys(restoredEffect.id).map((key) => key.frame), [0, 8]);
  G.undo();
  assert.deepEqual(F.effectIntensityKeys(restoredEffect.id).map((key) => key.frame), [0, 9]);
  G.redo();
  loadJSON(serializeJSON());
  const movedEffect = get(G.layers).find((layer) => layer.type === 'effect');
  assert.deepEqual(F.effectIntensityKeys(movedEffect.id).map((key) => key.frame), [0, 8]);
  assert.deepEqual(F.maskPositionKeys(movedEffect.id).map((key) => key.frame), [0, 8]);
}

async function shapePathLifecycleJourney() {
  const shape = {
    kind: 'rect',
    x0: 2,
    y0: 2,
    x1: 4,
    y1: 4,
    channel: 'glyph',
    style: 'filled',
    detail: 'cell',
    char: '#',
    color: '#ffffff',
  };
  resetDocument([
    {
      name: 'Path rectangle',
      type: 'shape',
      visible: true,
      shape,
      cells: renderShapeToCells(shape),
    },
  ], 14, 9);
  const shapeId = get(G.activeLayerId);

  extendVisualClips(4);
  F.gotoFrame(0);
  F.setShapePathTrackEnabled(shapeId, true);
  stroke(() => F.setShapePathById(3, shapeId, {
    kind: 'rect',
    cx: 7,
    cy: 4,
    w: 5,
    h: 3,
  }));
  F.togglePosKey(shapeId, 0);
  F.setLayerOffsetById(3, shapeId, { x: 2, y: 1 });

  const originalPoses = glyphBoundsByFrame();
  assert.deepEqual(originalPoses[0], { minX: 2, maxX: 4, minY: 2, maxY: 4 });
  assert.deepEqual(originalPoses[3], { minX: 7, maxX: 11, minY: 4, maxY: 6 });

  const originalClip = getClipTimelineState().clips.find((clip) => clip.kind === 'visual');
  const split = F.razorClip(originalClip.id, 2);
  F.moveClip(split.right.id, 3);
  const reorderedPoses = glyphBoundsByFrame();
  assert.deepEqual(reorderedPoses, [
    originalPoses[0],
    originalPoses[1],
    null,
    originalPoses[2],
    originalPoses[3],
  ]);

  F.gotoFrame(3);
  assert.equal(G.rasterizeLayer(shapeId), true);
  await Promise.resolve();
  assert.equal(get(G.layers).find((layer) => layer.id === shapeId)?.type, 'cell');
  assert.deepEqual(glyphBoundsByFrame(), reorderedPoses);

  G.undo();
  assert.equal(get(G.layers).find((layer) => layer.id === shapeId)?.type, 'shape');
  assert.equal(F.isShapePathTrackEnabled(shapeId), true);
  assert.deepEqual(glyphBoundsByFrame(), reorderedPoses);

  loadJSON(serializeJSON());
  const restoredShape = get(G.layers).find((layer) => layer.name === 'Path rectangle');
  assert.equal(restoredShape?.type, 'shape');
  assert.equal(F.isShapePathTrackEnabled(restoredShape.id), true);
  assert.deepEqual(glyphBoundsByFrame(), reorderedPoses);
}

function sequenceTagLifecycleJourney() {
  resetDocument([
    { name: 'Tagged sequence', type: 'cell', visible: true, cells: { '0,0': { c: 'T', fg: '#ffffff' } } },
  ], 4, 2);
  extendVisualClips(6);
  stroke(() => F.setLoopStartTag(1));
  stroke(() => F.setLoopEndTag(5));
  stroke(() => F.addCustomTimelineTag(5, 'spawn:世界'));
  const authored = structuredClone(getClipTimelineState().tags);
  assert.deepEqual(authored.map((tag) => [tag.tick, tag.type, tag.value]), [
    [1, 'loop-start', undefined],
    [5, 'loop-end', undefined],
    [5, 'custom', 'spawn:世界'],
  ]);

  loadJSON(serializeJSON());
  assert.deepEqual(getClipTimelineState().tags, authored);
  const custom = authored.find((tag) => tag.type === 'custom');
  stroke(() => F.removeTimelineTag(custom.id));
  assert.equal(getClipTimelineState().tags.some((tag) => tag.id === custom.id), false);
  G.undo();
  assert.deepEqual(getClipTimelineState().tags, authored);

  const clip = getClipTimelineState().clips.find((candidate) => candidate.kind === 'visual');
  stroke(() => F.trimClip(clip.id, 'end', 3));
  assert.deepEqual(getClipTimelineState().tags.map((tag) => tag.tick), [1, 2, 2]);
  G.undo();
  assert.deepEqual(getClipTimelineState().tags, authored);

  const loopEnd = authored.find((tag) => tag.type === 'loop-end');
  stroke(() => F.removeTimelineTag(loopEnd.id));
  const openEnded = structuredClone(getClipTimelineState().tags);
  assert.deepEqual(validLoopRange(openEnded, get(F.durationTicks)), { startTick: 1, endTick: 5 });
  loadJSON(serializeJSON());
  assert.deepEqual(getClipTimelineState().tags, openEnded);
}

const journeys = [
  ['grouped channels animate, round-trip, and keep editing history isolated', animatedGroupedSaveJourney],
  ['wide-glyph selection moves, extracts, animates, crops, and exports', wideSelectionCropJourney],
  ['animated effect and mask keys move, undo, and round-trip across ten ticks', animatedEffectJourney],
  ['shape path combines Position, clip gaps, rasterize Undo, and save/load', shapePathLifecycleJourney],
  ['sequence tags survive save, deletion Undo, clamping, and an open loop', sequenceTagLifecycleJourney],
];

const startedAt = performance.now();
let failed = 0;
for (const [name, run] of journeys) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n${error.stack || error.message}`);
  }
}

console.log(
  `long journeys: ${journeys.length - failed}/${journeys.length} passed `
  + `in ${Math.round(performance.now() - startedAt)} ms`,
);
process.exit(failed ? 1 : 0);
