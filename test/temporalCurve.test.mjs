import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import {
  activeLayerId,
  beginStroke,
  endStroke,
  redo,
  undo,
} from '../src/lib/grid.js';
import * as F from '../src/lib/frames.js';
import {
  selectedTemporalHandles,
  temporalCurveSegments,
  temporalHandleFromPoint,
  temporalHandleGeometry,
} from '../src/lib/temporalCurve.js';

let pass = 0;
let fail = 0;

function eq(name, got, want) {
  try {
    assert.deepStrictEqual(got, want);
    pass++;
  } catch (error) {
    fail++;
    console.error(`FAIL ${name}\n${error.message}`);
  }
}

function roundPoint(value) {
  return Object.fromEntries(Object.entries(value).map(([key, number]) => [key, +number.toFixed(3)]));
}

const geometry = { frameWidth: 22, height: 48, inset: 4, samples: 4 };

const legacy = temporalCurveSegments([
  { frame: 4, interpolation: 'linear' },
  { frame: 0, interpolation: 'ease-in' },
], geometry);
eq('legacy-segments-follow-authored-frame-spacing', {
  frames: legacy.map((segment) => [segment.sourceFrame, segment.destinationFrame]),
  custom: legacy[0].custom,
  path: legacy[0].path,
}, {
  frames: [[0, 4]],
  custom: false,
  path: 'M11 44 L33 41.5 L55 34 L77 21.5 L99 4',
});

const custom = temporalCurveSegments([
  { frame: 0, temporalEase: { out: { time: 0.2, value: 0.8 } } },
  { frame: 4, temporalEase: { in: { time: 0.4, value: 0.1 } } },
], geometry);
eq('custom-segment-path-uses-both-authored-controls', custom[0], {
  sourceFrame: 0,
  destinationFrame: 4,
  path: 'M11 44 C28.6 12 63.8 8 99 4',
  custom: true,
});

eq('zero-inset-keeps-the-curve-on-the-full-lane',
  temporalCurveSegments([
    { frame: 0, interpolation: 'linear' },
    { frame: 1, interpolation: 'linear' },
  ], { frameWidth: 20, height: 40, inset: 0, samples: 4 })[0].path,
  'M10 40 L15 30 L20 20 L25 10 L30 0');

const threeKeys = [
  { frame: 0, interpolation: 'ease-in' },
  { frame: 2, interpolation: 'linear' },
  { frame: 6, interpolation: 'ease-out' },
];
eq('selected-keys-expose-only-sides-with-a-neighbor',
  selectedTemporalHandles(threeKeys, new Set([0, 2, 6]), geometry)
    .map(({ frame, side, adjacentFrame }) => ({ frame, side, adjacentFrame })), [
    { frame: 0, side: 'out', adjacentFrame: 2 },
    { frame: 2, side: 'in', adjacentFrame: 0 },
    { frame: 2, side: 'out', adjacentFrame: 6 },
    { frame: 6, side: 'in', adjacentFrame: 2 },
  ]);

const legacyOutgoing = temporalHandleGeometry(threeKeys, 0, 'out', geometry);
const legacyIncoming = temporalHandleGeometry(threeKeys, 1, 'in', geometry);
eq('legacy-ease-in-handles-show-its-real-endpoint-tangents', {
  outgoing: roundPoint(legacyOutgoing.handle),
  incoming: roundPoint(legacyIncoming.handle),
  outgoingControl: roundPoint(legacyOutgoing.control),
  incomingControl: roundPoint(legacyIncoming.control),
}, {
  outgoing: { time: 0.333, value: 0 },
  incoming: { time: 0.333, value: 0.667 },
  outgoingControl: { x: 25.667, y: 44 },
  incomingControl: { x: 40.333, y: 30.667 },
});

eq('incoming-drag-normalizes-against-its-own-irregular-segment',
  temporalHandleFromPoint('in', 6, 2, 121, 24, geometry),
  { time: 0.25, value: 0.5 });

eq('outgoing-drag-clamps-outside-the-graph', [
  temporalHandleFromPoint('out', 2, 6, -200, 500, geometry),
  temporalHandleFromPoint('out', 2, 6, 500, -200, geometry),
], [
  { time: 0, value: 0 },
  { time: 1, value: 1 },
]);

eq('invalid-or-missing-handle-sides-are-rejected', [
  temporalHandleGeometry(threeKeys, 0, 'in', geometry),
  temporalHandleGeometry(threeKeys, 2, 'out', geometry),
  temporalHandleGeometry(threeKeys, 0.5, 'out', geometry),
  temporalHandleFromPoint('sideways', 0, 2, 20, 20, geometry),
  temporalHandleFromPoint('out', 2, 2, 20, 20, geometry),
], [null, null, null, null, null]);

const denseKeys = Array.from({ length: 720 }, (_, frame) => ({ frame, interpolation: 'linear' }));
const denseHandles = selectedTemporalHandles(denseKeys, new Set(denseKeys.map((key) => key.frame)), geometry);
eq('dense-selected-track-keeps-only-the-two-terminal-sides-hidden', {
  count: denseHandles.length,
  first: { frame: denseHandles[0].frame, side: denseHandles[0].side },
  last: { frame: denseHandles.at(-1).frame, side: denseHandles.at(-1).side },
}, {
  count: 1438,
  first: { frame: 0, side: 'out' },
  last: { frame: 719, side: 'in' },
});

F.loadCanonicalTimeline({
  tracks: [{
    id: 'curve-track',
    kind: 'visual',
    locked: false,
    shapePathKind: 'line',
    shapePathComponents: ['vertex:0'],
    layer: {
      id: 'curve-history', name: 'Curve history', type: 'shape', visible: true,
      cells: {}, offset: { x: 0, y: 0 }, shape: null,
    },
  }],
  clips: [{
    id: 'curve-clip', trackId: 'curve-track', kind: 'visual',
    startTick: 0, inTick: 0, outTick: 3, sourceDuration: 3,
    frameKeys: [{ tick: 0, value: {
      cells: {},
      shape: {
       kind: 'line',
      x0: 0,
      y0: 0,
      x1: 6,
      y1: 0,
      channel: 'glyph',
      style: 'outline',
      detail: 'cell',
      char: '#',
      fg: '#ffffff',
      },
    } }],
    propertyTracks: {
      shapePath: [0, 1, 2].map((frame) => ({
        tick: frame,
        value: {
          components: {
            'vertex:0': { x: frame, y: 0, interpolation: 'linear' },
          },
        },
      })),
    },
  }],
});
const curveLayerId = get(activeLayerId);
const middleEase = () => F.shapePathComponentKeys(curveLayerId, 'vertex:0')
  .find(({ frame }) => frame === 1).temporalEase;
F.setShapePathComponentKeyTemporalPreset(
  curveLayerId,
  'vertex:0',
  [1],
  'ease-in-out',
);
const presetEase = middleEase();
const structureRevision = get(F.timelineStructureRevision);
beginStroke();
F.setShapePathComponentKeyTemporalEase(
  curveLayerId,
  'vertex:0',
  [1],
  'in',
  { time: 0.2, value: 0.7 },
);
F.setShapePathComponentKeyTemporalEase(
  curveLayerId,
  'vertex:0',
  [1],
  'in',
  { time: 0.25, value: 0.65 },
);
endStroke();
const customEase = middleEase();
undo();
eq('one-undo-restores-the-preset-before-a-grouped-handle-drag', {
  ease: middleEase(),
  structureRevision: get(F.timelineStructureRevision),
}, {
  ease: presetEase,
  structureRevision,
});
redo();
eq('one-redo-restores-the-final-custom-handle-without-clearing-selection', {
  ease: middleEase(),
  structureRevision: get(F.timelineStructureRevision),
}, {
  ease: customEase,
  structureRevision,
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
