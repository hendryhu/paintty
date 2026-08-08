import {
  BOX_STYLES,
  constrainShape,
  isSlopeLine,
  lineStylePatch,
  lineStyleValue,
  maskShapeAppearance,
  normalizeShapeThickness,
  normalizeStrokeAlign,
  orthogonalLinePoints,
  regularPolygonVertices,
  renderShapeToCells,
  resolvedShapeAnchor,
  resolvedShapeVertices,
  shapeGlyphs,
  specialBrushGlyphs,
  updateMaskShapeAppearance,
  updateShapeAppearance,
} from '../src/lib/shapes.js';

let pass = 0;
let fail = 0;

function eq(name, got, want) {
  const actual = JSON.stringify(got);
  const expected = JSON.stringify(want);
  if (actual === expected) pass++;
  else {
    fail++;
    console.error('FAIL ' + name + '\n  got:  ' + actual + '\n  want: ' + expected);
  }
}

function ok(name, condition, detail = '') {
  if (condition) pass++;
  else {
    fail++;
    console.error('FAIL ' + name + (detail ? '\n  ' + detail : ''));
  }
}

const glyphPreset = {
  channel: 'glyph',
  style: 'special',
  detail: 'quarter',
  boxStyle: 'double',
  sides: 7,
  thickness: 3,
  strokeAlign: 'outside',
};
const withMaskPreset = updateMaskShapeAppearance(glyphPreset, {
  style: 'filled',
  sides: 4,
  thickness: 6,
  strokeAlign: 'inside',
});
ok('effect-mask-shape-options-do-not-create-a-dead-polygon-sides-preset',
  !Object.hasOwn(withMaskPreset, 'maskSides'));
eq('mask-shape-settings-preserve-the-normal-glyph-preset', {
  normal: {
    style: withMaskPreset.style,
    sides: withMaskPreset.sides,
    thickness: withMaskPreset.thickness,
    strokeAlign: withMaskPreset.strokeAlign,
  },
  mask: maskShapeAppearance(withMaskPreset),
}, {
  normal: {
    style: 'special',
    sides: 7,
    thickness: 3,
    strokeAlign: 'outside',
  },
  mask: {
    ...withMaskPreset,
    channel: 'background',
    style: 'filled',
    detail: 'cell',
    thickness: 6,
    strokeAlign: 'inside',
  },
});

eq('orthogonal-interpolation-never-takes-a-diagonal-step',
  orthogonalLinePoints(0, 0, 3, 2),
  [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 2, y: 2 },
    { x: 3, y: 2 },
  ]);

const turned = specialBrushGlyphs([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }], 'single');
eq('special-brush-selects-a-corner-when-the-stroke-turns',
  turned.map(({ x, y, ch }) => [x, y, ch]),
  [[0, 0, '─'], [1, 0, '─'], [2, 0, '┐'], [2, 1, '│'], [2, 2, '│']]);

eq('special-brush-applies-the-selected-line-family',
  specialBrushGlyphs([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }], 'double')
    .map(({ x, y, ch }) => [x, y, ch]),
  [[0, 0, '═'], [1, 0, '═'], [2, 0, '╗'], [2, 1, '║'], [2, 2, '║']]);

const crossed = specialBrushGlyphs([
  { x: 0, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 1 },
  { x: 1, y: 0 }, { x: 1, y: 2 },
], 'heavy');
eq('special-brush-resolves-a-self-crossing',
  crossed.find((point) => point.x === 1 && point.y === 1)?.ch,
  '╋');

const specialLine = {
  kind: 'line', style: 'special', boxStyle: 'heavy', detail: 'cell',
  channel: 'glyph', char: '@', fg: '#ffffff', x0: 1, y0: 2, x1: 7, y1: 4,
};
eq('special-line-snaps-to-its-dominant-axis',
  constrainShape(specialLine),
  { ...specialLine, x1: 7, y1: 2 });
eq('special-line-chooses-its-axis-in-visual-pixels',
  constrainShape({ ...specialLine, x0: 0, y0: 0, x1: 3, y1: 2 }),
  { ...specialLine, x0: 0, y0: 0, x1: 0, y1: 2 });
eq('special-line-uses-box-glyphs-instead-of-the-active-glyph',
  shapeGlyphs(specialLine).map(({ x, y, ch }) => [x, y, ch]),
  Array.from({ length: 7 }, (_, index) => [index + 1, 2, '━']));
ok('special-line-ignores-stale-wide-glyph-metadata',
  Object.values(renderShapeToCells({ ...specialLine, wide: true })).every((cell) => !cell.cont));

const verticalSpecial = shapeGlyphs({
  ...specialLine, boxStyle: 'double', x0: 3, y0: 1, x1: 4, y1: 6,
});
ok('special-line-can-snap-vertical',
  verticalSpecial.length === 6 && verticalSpecial.every((point) => point.x === 3 && point.ch === '║'));

const glyphShapeOptions = {
  channel: 'glyph', style: 'special', detail: 'quarter',
  boxStyle: 'double', wide: false,
};
const backgroundShapeOptions = updateShapeAppearance(glyphShapeOptions, { channel: 'background' });
eq('background-shape-mode-keeps-glyph-appearance-as-hidden-preferences', {
  channel: backgroundShapeOptions.channel,
  style: backgroundShapeOptions.style,
  detail: backgroundShapeOptions.detail,
  glyphStyle: backgroundShapeOptions.glyphStyle,
  glyphDetail: backgroundShapeOptions.glyphDetail,
  glyphBoxStyle: backgroundShapeOptions.glyphBoxStyle,
}, {
  channel: 'background',
  style: 'outline',
  detail: 'cell',
  glyphStyle: 'special',
  glyphDetail: 'quarter',
  glyphBoxStyle: 'double',
});
const filledBackgroundOptions = updateShapeAppearance(backgroundShapeOptions, { style: 'filled' });
const restoredGlyphOptions = updateShapeAppearance(filledBackgroundOptions, { channel: 'glyph' });
eq('shape-channel-round-trip-restores-special-glyph-settings', {
  channel: restoredGlyphOptions.channel,
  style: restoredGlyphOptions.style,
  detail: restoredGlyphOptions.detail,
  boxStyle: restoredGlyphOptions.boxStyle,
  backgroundStyle: restoredGlyphOptions.backgroundStyle,
}, {
  channel: 'glyph',
  style: 'special',
  detail: 'cell',
  boxStyle: 'double',
  backgroundStyle: 'filled',
});
const restoredDetailOptions = updateShapeAppearance(restoredGlyphOptions, { style: 'outline' });
eq('leaving-special-shape-mode-restores-the-previous-subcell-detail', {
  style: restoredDetailOptions.style,
  detail: restoredDetailOptions.detail,
}, {
  style: 'outline',
  detail: 'quarter',
});
eq('returning-to-background-restores-its-independent-style',
  updateShapeAppearance(restoredDetailOptions, { channel: 'background' }).style,
  'filled');
eq('line-style-dropdown-keeps-detail-and-special-families-distinct', [
  lineStyleValue({ style: 'outline', detail: 'cell' }),
  lineStyleValue({ style: 'outline', detail: 'half' }),
  lineStyleValue({ style: 'outline', detail: 'quarter' }),
  lineStyleValue({ style: 'special', boxStyle: 'double' }),
  lineStyleValue({ style: 'slope' }),
], ['cell', 'half', 'quarter', 'special:double', 'slope']);
eq('line-style-dropdown-values-map-to-complete-appearance-patches', [
  lineStylePatch('cell'),
  lineStylePatch('half'),
  lineStylePatch('quarter'),
  lineStylePatch('special:heavy'),
  lineStylePatch('slope'),
], [
  { style: 'outline', detail: 'cell' },
  { style: 'outline', detail: 'half' },
  { style: 'outline', detail: 'quarter' },
  { style: 'special', boxStyle: 'heavy' },
  { style: 'slope' },
]);
eq('only-an-authored-slope-line-locks-appearance-conversion', [
  isSlopeLine({ kind: 'line', style: 'slope' }),
  isSlopeLine({ kind: 'line', style: 'special' }),
  isSlopeLine({ kind: 'circle', style: 'slope' }),
], [true, false, false]);
const restoredSlopeOptions = updateShapeAppearance(
  updateShapeAppearance(
    { channel: 'glyph', style: 'slope', detail: 'half', boxStyle: 'heavy' },
    { channel: 'background' },
  ),
  { channel: 'glyph' },
);
eq('slope-settings-survive-a-background-round-trip', {
  style: restoredSlopeOptions.style,
  glyphDetail: restoredSlopeOptions.glyphDetail,
  boxStyle: restoredSlopeOptions.boxStyle,
}, {
  style: 'slope',
  glyphDetail: 'half',
  boxStyle: 'heavy',
});

const fallingSlope = {
  kind: 'line', style: 'slope', detail: 'cell', channel: 'glyph',
  char: '@', fg: '#ffffff', x0: 0, y0: 0, x1: 4, y1: 3,
};

function endpointPair(shape) {
  return [[shape.x0, shape.y0], [shape.x1, shape.y1]]
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}

function orderedCellMap(shape) {
  return Object.entries(renderShapeToCells(shape))
    .sort(([left], [right]) => {
      const [leftX, leftY] = left.split(',').map(Number);
      const [rightX, rightY] = right.split(',').map(Number);
      return leftY - rightY || leftX - rightX;
    });
}

const reversibleSlopeDrags = [
  ['reported falling diagonal', { x: 3, y: 3 }, { x: 10, y: 8 }],
  ['exact visual forty-five degrees', { x: -4, y: 2 }, { x: 4, y: 6 }],
  ['horizontal threshold tie', { x: 0, y: 0 }, { x: 8, y: 2 }],
  ['just inside the horizontal threshold', { x: 0, y: 0 }, { x: 9, y: 2 }],
  ['vertical threshold tie', { x: 0, y: 0 }, { x: 2, y: 2 }],
  ['just inside the vertical threshold', { x: 0, y: 0 }, { x: 1, y: 2 }],
  ['rising negative off-canvas drag', { x: -10, y: 3 }, { x: -3, y: -2 }],
];
for (const [name, start, end] of reversibleSlopeDrags) {
  const forward = constrainShape({
    ...fallingSlope,
    x0: start.x,
    y0: start.y,
    x1: end.x,
    y1: end.y,
  });
  const reverse = constrainShape({
    ...fallingSlope,
    x0: end.x,
    y0: end.y,
    x1: start.x,
    y1: start.y,
  });
  eq(`${name} has a direction-independent snapped endpoint pair`,
    endpointPair(reverse), endpointPair(forward));
  eq(`${name} restores authored Start and End order after snapping`,
    [reverse.x0, reverse.y0, reverse.x1, reverse.y1],
    [forward.x1, forward.y1, forward.x0, forward.y0]);
  eq(`${name} has an identical forward and reverse cell map`,
    orderedCellMap(reverse), orderedCellMap(forward));
}
eq('reported diagonal-triangle drag keeps its forward endpoint order',
  [
    constrainShape({ ...fallingSlope, x0: 3, y0: 3, x1: 10, y1: 8 }).x0,
    constrainShape({ ...fallingSlope, x0: 3, y0: 3, x1: 10, y1: 8 }).y0,
    constrainShape({ ...fallingSlope, x0: 3, y0: 3, x1: 10, y1: 8 }).x1,
    constrainShape({ ...fallingSlope, x0: 3, y0: 3, x1: 10, y1: 8 }).y1,
  ],
  [3, 3, 8, 7]);
eq('zero-length slope input remains zero-length',
  constrainShape({ ...fallingSlope, x0: -3, y0: 4, x1: -3, y1: 4 }),
  { ...fallingSlope, x0: -3, y0: 4, x1: -3, y1: 4 });

const ordinaryBresenham = {
  ...fallingSlope,
  style: 'outline',
  x0: 0,
  y0: 0,
  x1: 4,
  y1: 3,
};
ok('slope normalization does not constrain ordinary cell lines',
  constrainShape(ordinaryBresenham) === ordinaryBresenham);
eq('ordinary falling diagonal cells share edges',
  shapeGlyphs(ordinaryBresenham).map(({ x, y }) => [x, y]),
  [
    [0, 0], [1, 0], [1, 1], [2, 1],
    [2, 2], [3, 2], [3, 3], [4, 3],
  ]);
eq('ordinary rising diagonal cells share edges',
  shapeGlyphs({ ...ordinaryBresenham, y0: 3, y1: 0 })
    .map(({ x, y }) => [x, y]),
  [
    [0, 3], [1, 3], [1, 2], [2, 2],
    [2, 1], [3, 1], [3, 0], [4, 0],
  ]);
eq('ordinary horizontal and vertical lines retain exact cells', [
  shapeGlyphs({ ...ordinaryBresenham, x1: 4, y0: 2, y1: 2 })
    .map(({ x, y }) => [x, y]),
  shapeGlyphs({ ...ordinaryBresenham, x0: 2, x1: 2, y0: -1, y1: 3 })
    .map(({ x, y }) => [x, y]),
], [
  [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2]],
  [[2, -1], [2, 0], [2, 1], [2, 2], [2, 3]],
]);
eq('ordinary short diagonal includes one edge-sharing bridge',
  shapeGlyphs({ ...ordinaryBresenham, x1: 1, y1: 1 })
    .map(({ x, y }) => [x, y]),
  [[0, 0], [1, 0], [1, 1]]);
const longOrdinaryDiagonal = [
  [0, 0], [1, 0], [1, 1], [2, 1], [3, 1], [4, 1],
  [4, 2], [5, 2], [6, 2], [7, 2], [7, 3], [8, 3],
];
eq('ordinary long diagonal uses a continuous minimal cover',
  shapeGlyphs({ ...ordinaryBresenham, x1: 8, y1: 3 })
    .map(({ x, y }) => [x, y]),
  longOrdinaryDiagonal);
eq('ordinary diagonal cell maps are identical in reverse', [
  shapeGlyphs({ ...ordinaryBresenham, x0: 4, y0: 3, x1: 0, y1: 0 })
    .map(({ x, y }) => [x, y]),
  shapeGlyphs({ ...ordinaryBresenham, x0: 4, y0: 0, x1: 0, y1: 3 })
    .map(({ x, y }) => [x, y]),
  shapeGlyphs({ ...ordinaryBresenham, x0: 8, y0: 3, x1: 0, y1: 0 })
    .map(({ x, y }) => [x, y]),
], [
  [
    [0, 0], [1, 0], [1, 1], [2, 1],
    [2, 2], [3, 2], [3, 3], [4, 3],
  ],
  [
    [0, 3], [1, 3], [1, 2], [2, 2],
    [2, 1], [3, 1], [3, 0], [4, 0],
  ],
  longOrdinaryDiagonal,
]);
eq('background lines use the same connected coordinates without glyph leakage',
  Object.entries(renderShapeToCells({
    ...ordinaryBresenham,
    channel: 'background',
    fg: '#123456',
  })).map(([key, cell]) => [key, cell]),
  [
    ['0,0', { c: '', fg: null, bg: '#123456' }],
    ['1,0', { c: '', fg: null, bg: '#123456' }],
    ['1,1', { c: '', fg: null, bg: '#123456' }],
    ['2,1', { c: '', fg: null, bg: '#123456' }],
    ['2,2', { c: '', fg: null, bg: '#123456' }],
    ['3,2', { c: '', fg: null, bg: '#123456' }],
    ['3,3', { c: '', fg: null, bg: '#123456' }],
    ['4,3', { c: '', fg: null, bg: '#123456' }],
  ]);
eq('wide connected lines retain one continuation per glyph owner',
  Object.entries(renderShapeToCells({
    ...ordinaryBresenham,
    char: '界',
    wide: true,
  })).map(([key, cell]) => [key, cell.c, !!cell.cont]),
  [
    ['0,0', '界', false], ['1,0', '', true],
    ['1,1', '界', false], ['2,1', '', true],
    ['2,2', '界', false], ['3,2', '', true],
    ['3,3', '界', false], ['4,3', '', true],
  ]);
eq('rotated ordinary line raster follows rendered endpoints',
  shapeGlyphs({
    ...ordinaryBresenham,
    x0: 0, y0: 0, x1: 4, y1: 0,
    anchor: { x: 2, y: 0 },
    rotation: 90,
  }).map(({ x, y }) => [x, y]),
  [[2, -2], [2, -1], [2, 0], [2, 1], [2, 2]]);
eq('orthogonal line anchoring remains unchanged in either authored direction', [
  constrainShape({ ...specialLine, x0: 0, y0: 0, x1: 3, y1: 2 }),
  constrainShape({ ...specialLine, x0: 3, y0: 2, x1: 0, y1: 0 }),
], [
  { ...specialLine, x0: 0, y0: 0, x1: 0, y1: 2 },
  { ...specialLine, x0: 3, y0: 2, x1: 3, y1: 0 },
]);

eq('diagonal-triangle-line-snaps-to-edge-sharing-rows',
  constrainShape(fallingSlope),
  { ...fallingSlope, x1: 4, y1: 3 });
eq('falling-diagonal-triangle-pairs-share-an-edge-between-rows',
  shapeGlyphs(fallingSlope).map(({ x, y, ch }) => [x, y, ch]),
  [
    [0, 0, ''], [1, 0, ''], [1, 1, ''], [2, 1, ''],
    [2, 2, ''], [3, 2, ''], [3, 3, ''], [4, 3, ''],
  ]);

eq('rising-diagonal-triangle-pairs-share-an-edge-between-rows',
  shapeGlyphs({ ...fallingSlope, y0: 4, y1: 1 }).map(({ x, y, ch }) => [x, y, ch]),
  [
    [3, 1, ''], [4, 1, ''], [2, 2, ''], [3, 2, ''],
    [1, 3, ''], [2, 3, ''], [0, 4, ''], [1, 4, ''],
  ]);

const reversedFallingSlope = shapeGlyphs({
  ...constrainShape(fallingSlope),
  x0: 7, y0: 3, x1: 0, y1: 0,
});
eq('slope-rendering-does-not-depend-on-which-handle-started-the-drag',
  reversedFallingSlope.map(({ x, y, ch }) => [x, y, ch])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]),
  shapeGlyphs(fallingSlope).map(({ x, y, ch }) => [x, y, ch])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]));

const straightSlope = shapeGlyphs({ ...fallingSlope, x1: 6, y1: 1 });
ok('slope-mode-uses-blocks-for-a-straight-run',
  straightSlope.length === 7 && straightSlope.every((point) => point.y === 0 && point.ch === '█'));

const verticalSlope = shapeGlyphs({ ...fallingSlope, x1: 2, y1: 3 });
ok('slope-mode-chooses-a-visual-vertical-run',
  verticalSlope.length === 4 && verticalSlope.every((point) => point.x === 0 && point.ch === '█'));

const diagonalDrags = [[1, 1], [4, 3], [7, 3], [-5, 2], [5, -4], [-8, -3]];
ok('diagonal-triangle-runs-are-nonempty-edge-sharing-lines',
  diagonalDrags.every(([x1, y1]) => {
    const constrained = constrainShape({ ...fallingSlope, x1, y1 });
    const glyphs = shapeGlyphs({ ...fallingSlope, x1, y1 });
    const byRow = Map.groupBy(glyphs, (point) => point.y);
    const allowedPairs = Math.sign(x1) === Math.sign(y1)
      ? new Set([''])
      : new Set(['']);
    return glyphs.length > 1 &&
      Math.abs(constrained.x1 - constrained.x0) ===
        Math.abs(constrained.y1 - constrained.y0) + 1 &&
      [...byRow.values()].every((row) => {
        const pair = row.sort((a, b) => a.x - b.x).map((point) => point.ch).join('');
        return row.length === 2 && allowedPairs.has(pair);
      });
  }));

const circle = shapeGlyphs({
  kind: 'circle', style: 'special', boxStyle: 'double', detail: 'cell',
  channel: 'glyph', char: '@', fg: '#ffffff', x0: 0, y0: 0, x1: 8, y1: 6,
});
const doubleGlyphs = new Set(Object.values(BOX_STYLES.double));
ok('special-circle-is-a-connected-box-glyph-contour',
  circle.length > 16 && circle.every((point) => doubleGlyphs.has(point.ch)));
ok('special-circle-reaches-each-side-of-its-bounds',
  [0, 8].every((x) => circle.some((point) => point.x === x)) &&
  [0, 6].every((y) => circle.some((point) => point.y === y)));
ok('special-circle-never-leaks-the-active-glyph',
  circle.every((point) => point.ch !== '@'));

const DIRECTIONS = [
  { bit: 1, dx: 0, dy: -1, opposite: 4 },
  { bit: 2, dx: 1, dy: 0, opposite: 8 },
  { bit: 4, dx: 0, dy: 1, opposite: 1 },
  { bit: 8, dx: -1, dy: 0, opposite: 2 },
];
const SINGLE_CONNECTIONS = new Map([
  ['│', 1 | 4], ['─', 2 | 8],
  ['┌', 2 | 4], ['┐', 8 | 4], ['└', 2 | 1], ['┘', 8 | 1],
  ['┬', 2 | 8 | 4], ['┤', 1 | 4 | 8], ['┴', 2 | 8 | 1], ['├', 1 | 2 | 4],
  ['┼', 1 | 2 | 4 | 8],
]);
const bitCount = (value) => DIRECTIONS.reduce((count, { bit }) => count + ((value & bit) ? 1 : 0), 0);
const mirrorXConnections = (value) =>
  (value & 1) | (value & 4) | ((value & 2) ? 8 : 0) | ((value & 8) ? 2 : 0);
const mirrorYConnections = (value) =>
  (value & 2) | (value & 8) | ((value & 1) ? 4 : 0) | ((value & 4) ? 1 : 0);

function inspectSpecialCircle(width, height) {
  const xa = -3, ya = 5, xb = xa + width, yb = ya + height;
  const glyphs = shapeGlyphs({
    kind: 'circle', style: 'special', boxStyle: 'single', detail: 'cell',
    channel: 'glyph', char: '@', fg: '#ffffff', x0: xa, y0: ya, x1: xb, y1: yb,
  });
  const map = new Map(glyphs.map((point) => [`${point.x},${point.y}`, SINGLE_CONNECTIONS.get(point.ch)]));
  return { xa, ya, xb, yb, glyphs, map };
}

const inspectedCircles = [];
for (let width = 2; width <= 16; width++) {
  for (let height = 2; height <= 12; height++) inspectedCircles.push(inspectSpecialCircle(width, height));
}

ok('special-circle-contours-have-no-branches-or-endpoints',
  inspectedCircles.every(({ glyphs, map }) =>
    map.size === glyphs.length && [...map.values()].every((connections) => bitCount(connections) === 2)));

ok('special-circle-contours-have-reciprocal-orthogonal-connections',
  inspectedCircles.every(({ glyphs, map }) => glyphs.every(({ x, y }) => {
    const connections = map.get(`${x},${y}`);
    return DIRECTIONS.every(({ bit, dx, dy, opposite }) => !(connections & bit) ||
      ((map.get(`${x + dx},${y + dy}`) || 0) & opposite));
  })));

ok('special-circle-contours-are-bilaterally-symmetric',
  inspectedCircles.every(({ xa, ya, xb, yb, glyphs, map }) => glyphs.every(({ x, y }) => {
    const connections = map.get(`${x},${y}`);
    return map.get(`${xa + xb - x},${y}`) === mirrorXConnections(connections) &&
      map.get(`${x},${ya + yb - y}`) === mirrorYConnections(connections);
  })));

ok('special-circle-contours-form-one-closed-loop',
  inspectedCircles.every(({ glyphs, map }) => {
    const start = glyphs[0];
    const seen = new Set([`${start.x},${start.y}`]);
    const pending = [start];
    while (pending.length) {
      const { x, y } = pending.pop();
      const connections = map.get(`${x},${y}`);
      for (const { bit, dx, dy } of DIRECTIONS) {
        const key = `${x + dx},${y + dy}`;
        if ((connections & bit) && !seen.has(key)) {
          seen.add(key);
          pending.push({ x: x + dx, y: y + dy });
        }
      }
    }
    return seen.size === glyphs.length;
  }));

eq('ordinary-line-rendering-remains-active-glyph-based',
  Object.values(renderShapeToCells({
    kind: 'line', style: 'outline', detail: 'cell', channel: 'glyph',
    char: '@', fg: '#abcdef', x0: 0, y0: 0, x1: 2, y1: 1,
  })).map((cell) => cell.c),
  ['@', '@', '@', '@']);

const flatCircle = {
  kind: 'circle', style: 'outline', detail: 'cell', channel: 'glyph',
  char: '@', fg: '#abcdef',
};
function localGlyphCoordinates(shape) {
  const xa = Math.min(shape.x0, shape.x1);
  const ya = Math.min(shape.y0, shape.y1);
  return shapeGlyphs(shape).map(({ x, y }) => [x - xa, y - ya])
    .sort((left, right) => left[1] - right[1] || left[0] - right[0]);
}
const positionSensitiveCircle = {
  ...flatCircle, x0: 0, y0: 0, x1: 19, y1: 6,
};
eq('equal ellipse bounds rasterize identically at every canvas position', [
  localGlyphCoordinates(positionSensitiveCircle),
  localGlyphCoordinates({ ...positionSensitiveCircle, x0: 17, y0: 9, x1: 36, y1: 15 }),
  localGlyphCoordinates({ ...positionSensitiveCircle, x0: 36, y0: 15, x1: 17, y1: 9 }),
  localGlyphCoordinates({ ...positionSensitiveCircle, x0: -21, y0: -8, x1: -2, y1: -2 }),
], Array(4).fill(localGlyphCoordinates(positionSensitiveCircle)));
eq('equal filled ellipses are also position-independent',
  localGlyphCoordinates({
    ...positionSensitiveCircle,
    style: 'filled',
    x0: 17, y0: 9, x1: 36, y1: 15,
  }),
  localGlyphCoordinates({ ...positionSensitiveCircle, style: 'filled' }));
eq('one-row-ordinary-circle-spans-its-dragged-width',
  shapeGlyphs({ ...flatCircle, x0: 2, y0: 5, x1: 8, y1: 5 })
    .map(({ x, y }) => [x, y]),
  [[2, 5], [3, 5], [4, 5], [5, 5], [6, 5], [7, 5], [8, 5]]);
eq('one-column-filled-circle-spans-its-dragged-height',
  shapeGlyphs({ ...flatCircle, style: 'filled', x0: 3, y0: 7, x1: 3, y1: 2 })
    .map(({ x, y }) => [x, y]),
  [[3, 2], [3, 3], [3, 4], [3, 5], [3, 6], [3, 7]]);

const legacyGeometryShapes = [
  {
    kind: 'line', style: 'outline', detail: 'cell', channel: 'glyph',
    char: '@', fg: '#abcdef', x0: 1, y0: 2, x1: 7, y1: 5,
    vertices: [{ x: 1, y: 2 }, { x: 7, y: 5 }],
  },
  {
    kind: 'rect', style: 'outline', detail: 'half', channel: 'glyph',
    char: '@', fg: '#abcdef', x0: 1, y0: 2, x1: 7, y1: 5,
    vertices: [
      { x: 1, y: 2 }, { x: 7, y: 2 }, { x: 7, y: 5 }, { x: 1, y: 5 },
    ],
  },
  {
    kind: 'circle', style: 'filled', detail: 'quarter', channel: 'glyph',
    char: '@', fg: '#abcdef', x0: 1, y0: 2, x1: 7, y1: 5,
    vertices: [
      { x: 1, y: 2 }, { x: 7, y: 2 }, { x: 7, y: 5 }, { x: 1, y: 5 },
    ],
  },
];
ok('default-transform-metadata-is-byte-for-cell-compatible-with-legacy-shapes',
  legacyGeometryShapes.every(({ vertices, ...legacy }) =>
    JSON.stringify(renderShapeToCells(legacy)) ===
    JSON.stringify(renderShapeToCells({
      ...legacy,
      vertices,
      anchor: { x: 4, y: 3.5 },
      rotation: 0,
      thickness: 1,
      strokeAlign: 'center',
    }))));

const fixedWidthSpecial = {
  kind: 'rect', style: 'special', boxStyle: 'heavy', detail: 'cell',
  channel: 'glyph', char: '@', fg: '#ffffff', x0: 0, y0: 0, x1: 6, y1: 4,
};
ok('special-and-slope-families-stay-fixed-width',
  JSON.stringify(shapeGlyphs(fixedWidthSpecial)) ===
    JSON.stringify(shapeGlyphs({
      ...fixedWidthSpecial, thickness: 8, strokeAlign: 'outside',
    })) &&
  JSON.stringify(shapeGlyphs(fallingSlope)) ===
    JSON.stringify(shapeGlyphs({
      ...fallingSlope, thickness: 8, strokeAlign: 'inside',
    })));

eq('thickness-and-alignment-values-normalize-to-supported-settings', [
  normalizeShapeThickness(undefined),
  normalizeShapeThickness(-4),
  normalizeShapeThickness(1.26),
  normalizeShapeThickness(2.24),
  normalizeStrokeAlign('inside'),
  normalizeStrokeAlign('outside'),
  normalizeStrokeAlign('sideways'),
], [1, 1, 1.5, 2, 'inside', 'outside', 'center']);

const squareVertices = regularPolygonVertices(0, 0, 4, 4, 4)
  .map(({ x, y }) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);
eq('regular-polygon-helper-is-clockwise-and-starts-at-top',
  squareVertices,
  [[2, 0], [4, 2], [2, 4], [0, 2]]);
eq('regular-polygon-helper-clamps-its-side-count',
  [regularPolygonVertices(0, 0, 4, 4, 1).length,
    regularPolygonVertices(0, 0, 4, 4, 100).length],
  [3, 64]);

const rotatedBox = {
  kind: 'rect', x0: 0, y0: 0, x1: 6, y1: 4,
  anchor: { x: 2, y: 1 }, rotation: 90,
};
eq('shape-anchor-prefers-an-explicit-pivot',
  resolvedShapeAnchor(rotatedBox),
  { x: 2, y: 1 });
eq('shape-vertices-rotate-in-degrees-around-the-anchor',
  resolvedShapeVertices(rotatedBox).map(({ x, y }) => [
    Math.round(x * 1e6) / 1e6,
    Math.round(y * 1e6) / 1e6,
  ]),
  [[3, -1], [3, 5], [-1, 5], [-1, -1]]);

const basePolygon = {
  kind: 'polygon', style: 'outline', detail: 'quarter', channel: 'glyph',
  char: '@', fg: '#abcdef',
  vertices: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 5, y: 5 }, { x: 1, y: 4 }],
};
const convexPolygonKeys = new Set(shapeGlyphs(basePolygon).map(({ x, y }) => `${x},${y}`));
ok('convex-polygon-outline-renders-each-authored-side',
  convexPolygonKeys.has('0,0') &&
  convexPolygonKeys.has('6,0') &&
  convexPolygonKeys.has('5,5') &&
  convexPolygonKeys.has('1,4') &&
  !convexPolygonKeys.has('3,2'));

const concavePolygon = {
  ...basePolygon,
  style: 'filled',
  detail: 'cell',
  vertices: [
    { x: 0, y: 0 }, { x: 7, y: 0 }, { x: 7, y: 6 }, { x: 5, y: 6 },
    { x: 5, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 6 }, { x: 0, y: 6 },
  ],
};
const concaveCells = new Set(shapeGlyphs(concavePolygon).map(({ x, y }) => `${x},${y}`));
ok('concave-filled-polygon-keeps-its-cutout',
  concaveCells.has('1,4') && concaveCells.has('6,4') && !concaveCells.has('3,4'));
eq('polygon-winding-does-not-change-filled-rasterization',
  [...new Set(shapeGlyphs({
    ...concavePolygon,
    vertices: [...concavePolygon.vertices].reverse(),
  }).map(({ x, y }) => `${x},${y}`))].sort(),
  [...concaveCells].sort());

eq('polygon-special-and-slope-styles-normalize-to-an-ordinary-outline', [
  shapeGlyphs({ ...basePolygon, style: 'special', boxStyle: 'double' }),
  shapeGlyphs({ ...basePolygon, style: 'slope' }),
], [
  shapeGlyphs(basePolygon),
  shapeGlyphs(basePolygon),
]);

const regularPentagon = {
  kind: 'polygon', style: 'outline', detail: 'cell', channel: 'glyph',
  char: '@', fg: '#abcdef', x0: 0, y0: 0, x1: 8, y1: 6, sides: 5,
};
ok('polygon-sides-provide-a-renderable-fallback-when-vertices-are-absent',
  shapeGlyphs(regularPentagon).length > 8 &&
  resolvedShapeVertices(regularPentagon).length === 5);
const joinedPentagon = {
  ...regularPentagon,
  vertices: regularPolygonVertices(0, 0, 16, 12, 5),
};
const joinedPentagonCells = new Set(
  shapeGlyphs(joinedPentagon).map(({ x, y }) => `${x},${y}`),
);
eq('five-sided polygon closes its literal top join coordinates',
  [...joinedPentagonCells]
    .map((key) => key.split(',').map(Number))
    .filter(([, y]) => y <= 1)
    .sort((left, right) => left[1] - right[1] || left[0] - right[0]),
  [
    [7, 0], [8, 0], [9, 0],
    [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [11, 1],
  ]);
const connectedPentagon = new Set();
const pendingPentagon = [[...joinedPentagonCells][0]];
while (pendingPentagon.length) {
  const key = pendingPentagon.pop();
  if (connectedPentagon.has(key)) continue;
  connectedPentagon.add(key);
  const [x, y] = key.split(',').map(Number);
  for (const neighbor of [`${x - 1},${y}`, `${x + 1},${y}`, `${x},${y - 1}`, `${x},${y + 1}`]) {
    if (joinedPentagonCells.has(neighbor) && !connectedPentagon.has(neighbor)) {
      pendingPentagon.push(neighbor);
    }
  }
}
ok('five-sided polygon outline is one edge-connected closed contour',
  connectedPentagon.size === joinedPentagonCells.size);
eq('five-sided polygon outline is identical with reversed winding',
  [...new Set(shapeGlyphs({
    ...joinedPentagon,
    vertices: [...joinedPentagon.vertices].reverse(),
  }).map(({ x, y }) => `${x},${y}`))].sort(),
  [...joinedPentagonCells].sort());

const degeneratePolygon = {
  ...basePolygon,
  vertices: [{ x: 0, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 1 }],
};
ok('degenerate-polygon-falls-back-to-a-visible-open-segment',
  shapeGlyphs(degeneratePolygon).length > 0);
eq('single-vertex-polygon-is-empty',
  shapeGlyphs({ ...basePolygon, vertices: [{ x: 2, y: 2 }] }),
  []);
ok('filled-degenerate-polygon-ignores-stale-thickness',
  JSON.stringify(shapeGlyphs({ ...degeneratePolygon, style: 'filled', thickness: 1 })) ===
  JSON.stringify(shapeGlyphs({
    ...degeneratePolygon, style: 'filled', thickness: 9, strokeAlign: 'outside',
  })));

const perspectiveQuad = [
  { x: 0, y: 0 }, { x: 6, y: 1 }, { x: 5, y: 5 }, { x: -1, y: 3 },
];
const perspectiveRect = {
  kind: 'rect', style: 'outline', detail: 'quarter', channel: 'glyph',
  char: '@', fg: '#abcdef', x0: 0, y0: 0, x1: 6, y1: 5,
  vertices: perspectiveQuad,
};
const perspectiveRectCells = new Set(
  shapeGlyphs(perspectiveRect).map(({ x, y }) => `${x},${y}`),
);
ok('rectangle-quad-renders-skewed-and-perspective-authored-corners',
  perspectiveQuad.every(({ x, y }) => perspectiveRectCells.has(`${x},${y}`)));

const perspectiveCircle = { ...perspectiveRect, kind: 'circle' };
const perspectiveCircleCells = new Set(
  shapeGlyphs(perspectiveCircle).map(({ x, y }) => `${x},${y}`),
);
ok('deformed-circle-samples-its-ellipse-through-the-quad',
  perspectiveCircleCells.has('3,0') &&
  perspectiveCircleCells.has('5,3') &&
  perspectiveCircleCells.has('2,4') &&
  perspectiveCircleCells.has('-1,2') &&
  !perspectiveCircleCells.has('3,2'));
ok('filled-deformed-circle-includes-its-mapped-center',
  shapeGlyphs({ ...perspectiveCircle, style: 'filled', detail: 'cell' })
    .some(({ x, y }) => x === 3 && y === 2));
ok('rotation-changes-rendered-geometry-without-rewriting-authoring-vertices',
  JSON.stringify(shapeGlyphs(perspectiveRect)) !==
    JSON.stringify(shapeGlyphs({ ...perspectiveRect, rotation: 30 })) &&
  JSON.stringify(perspectiveRect.vertices) === JSON.stringify(perspectiveQuad));

const alignedRect = {
  kind: 'rect', style: 'outline', detail: 'quarter', channel: 'glyph',
  char: '@', fg: '#abcdef', x0: 0, y0: 0, x1: 6, y1: 6, thickness: 2,
};
function glyphKeySet(shape) {
  return new Set(shapeGlyphs(shape).map(({ x, y }) => `${x},${y}`));
}
const centeredRect = glyphKeySet({ ...alignedRect, strokeAlign: 'center' });
const insideRect = glyphKeySet({ ...alignedRect, strokeAlign: 'inside' });
const outsideRect = glyphKeySet({ ...alignedRect, strokeAlign: 'outside' });
ok('closed-stroke-alignment-expands-center-inside-and-outside-on-the-correct-side',
  centeredRect.has('-1,3') && !centeredRect.has('-2,3') &&
  insideRect.has('1,3') && !insideRect.has('-1,3') &&
  outsideRect.has('-2,3') && !outsideRect.has('1,3'));

const alignedLine = {
  ...alignedRect, kind: 'line', x0: 0, y0: 2, x1: 6, y1: 2,
};
const insideLine = glyphKeySet({ ...alignedLine, strokeAlign: 'inside' });
const outsideLine = glyphKeySet({ ...alignedLine, strokeAlign: 'outside' });
ok('open-line-alignment-uses-the-two-directed-sides-of-the-line',
  insideLine.has('3,4') && !insideLine.has('3,0') &&
  outsideLine.has('3,0') && !outsideLine.has('3,4'));

const thicknessCases = [
  { kind: 'line', x0: 0, y0: 1, x1: 7, y1: 4 },
  { kind: 'rect', x0: 0, y0: 0, x1: 7, y1: 5 },
  { kind: 'circle', x0: 0, y0: 0, x1: 7, y1: 5 },
  {
    kind: 'polygon',
    vertices: [{ x: 0, y: 0 }, { x: 7, y: 1 }, { x: 5, y: 5 }, { x: 1, y: 4 }],
  },
];
ok('line-rect-circle-and-polygon-support-thicker-glyph-half-and-quarter-strokes',
  thicknessCases.every((geometry) => ['cell', 'half', 'quarter'].every((detail) => {
    const shape = {
      ...geometry, style: 'outline', detail, channel: 'glyph',
      char: '@', fg: '#abcdef', thickness: 1,
    };
    return shapeGlyphs({ ...shape, thickness: 1.5 }).length >
      shapeGlyphs(shape).length;
  })));
ok('filled-closed-shapes-ignore-thickness-and-stroke-alignment',
  [concavePolygon, { ...flatCircle, x0: 0, y0: 0, x1: 8, y1: 6 }].every((shape) =>
    JSON.stringify(shapeGlyphs({ ...shape, style: 'filled', thickness: 1 })) ===
    JSON.stringify(shapeGlyphs({
      ...shape, style: 'filled', thickness: 8, strokeAlign: 'outside',
    }))));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
