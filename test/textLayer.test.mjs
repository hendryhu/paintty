import assert from 'node:assert/strict';
import {
  applyTextColor,
  cutTextToBox,
  layoutText,
  textLayoutColumns,
  normalizeTextRuns,
  remapTextColorRuns,
  renderTextToCells,
  textOverflowsBox,
} from '../src/lib/textLayer.js';

const narrow = () => false;
const wideCjk = (glyph) => glyph === '界';

function eq(name, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    console.log('ok -', name);
  } catch (error) {
    console.error('FAIL -', name);
    throw error;
  }
}

const overflow = renderTextToCells(
  'ABCDEFGHI',
  { x: 2, y: 3, w: 3, h: 1 },
  '#ffffff',
  true,
  [],
  narrow,
);
eq('wrapped text spills below its nominal box without reusing the bottom row', {
  first: overflow['2,3']?.c + overflow['3,3']?.c + overflow['4,3']?.c,
  second: overflow['2,4']?.c + overflow['3,4']?.c + overflow['4,4']?.c,
  third: overflow['2,5']?.c + overflow['3,5']?.c + overflow['4,5']?.c,
  count: Object.keys(overflow).length,
}, { first: 'ABC', second: 'DEF', third: 'GHI', count: 9 });

const offCanvas = renderTextToCells(
  'EDGE',
  { x: -2, y: -1, w: 2, h: 1 },
  '#abcdef',
  true,
  [],
  narrow,
);
const farOffCanvas = renderTextToCells(
  'RB',
  { x: 82, y: 33, w: 2, h: 1 },
  '#abcdef',
  true,
  [],
  narrow,
);
eq('text rendering retains sparse cells beyond every canvas boundary', {
  leftTopKeys: Object.keys(offCanvas).sort(),
  rightBottomKeys: Object.keys(farOffCanvas).sort(),
  colors: [...new Set([...Object.values(offCanvas), ...Object.values(farOffCanvas)].map((cell) => cell.fg))],
}, {
  leftTopKeys: ['-1,-1', '-1,0', '-2,-1', '-2,0'],
  rightBottomKeys: ['82,33', '83,33'],
  colors: ['#abcdef'],
});

const coloredRuns = applyTextColor([], 1, 4, '#ff0000', 5, '#ffffff');
const colored = renderTextToCells(
  'ABCDE',
  { x: 0, y: 0, w: 5, h: 1 },
  '#ffffff',
  true,
  coloredRuns,
  narrow,
);
eq('a selected substring gets its own durable color run', {
  runs: coloredRuns,
  colors: Object.values(colored).map((cell) => cell.fg),
}, {
  runs: [{ start: 1, end: 4, fg: '#ff0000' }],
  colors: ['#ffffff', '#ff0000', '#ff0000', '#ff0000', '#ffffff'],
});

const editedRuns = remapTextColorRuns(
  'ABCDE',
  'ABxyCDE',
  coloredRuns,
  '#ffffff',
);
eq('typing inside colored text preserves and extends the selected color', editedRuns, [
  { start: 1, end: 6, fg: '#ff0000' },
]);

const editedUnicodeRuns = remapTextColorRuns(
  'A😀BC',
  'A😀xBC',
  [{ start: 1, end: 4, fg: '#ff0000' }],
  '#ffffff',
);
eq('typing inside a colored Unicode range keeps textarea UTF-16 offsets aligned', editedUnicodeRuns, [
  { start: 1, end: 5, fg: '#ff0000' },
]);

const wide = renderTextToCells(
  '界A界',
  { x: 0, y: 0, w: 3, h: 1 },
  '#00ff00',
  true,
  [{ start: 1, end: 2, fg: '#ff00ff' }],
  wideCjk,
);
eq('wide glyphs wrap atomically and own one continuation cell', wide, {
  '0,0': { c: '界', fg: '#00ff00', bg: null },
  '1,0': { c: '', fg: '#00ff00', bg: null, cont: true },
  '2,0': { c: 'A', fg: '#ff00ff', bg: null },
  '0,1': { c: '界', fg: '#00ff00', bg: null },
  '1,1': { c: '', fg: '#00ff00', bg: null, cont: true },
});

const unicodeText = 'A😀éZ';
const unicodeRuns = applyTextColor([], 1, 5, '#3366ff', unicodeText, '#ffffff');
const combiningRun = applyTextColor([], 4, 5, '#ff6633', unicodeText, '#ffffff');
const unicode = renderTextToCells(
  unicodeText,
  { x: 0, y: 0, w: 8, h: 1 },
  '#ffffff',
  true,
  unicodeRuns,
  (glyph) => glyph === '😀',
);
eq('textarea UTF-16 offsets color emoji and combining graphemes without splitting them', {
  textLength: unicodeText.length,
  runs: unicodeRuns,
  combiningRun,
  glyphs: [unicode['0,0']?.c, unicode['1,0']?.c, unicode['3,0']?.c, unicode['4,0']?.c, unicode['5,0']?.c],
  colors: [unicode['0,0']?.fg, unicode['1,0']?.fg, unicode['3,0']?.fg, unicode['4,0']?.fg, unicode['5,0']?.fg],
  emojiContinuation: unicode['2,0'],
}, {
  textLength: 7,
  runs: [{ start: 1, end: 5, fg: '#3366ff' }],
  combiningRun: [{ start: 3, end: 5, fg: '#ff6633' }],
  glyphs: ['A', '😀', 'é', '', 'Z'],
  colors: ['#ffffff', '#3366ff', '#3366ff', '#ffffff', '#ffffff'],
  emojiContinuation: { c: '', fg: '#3366ff', bg: null, cont: true },
});
const cutSource = 'ABCDEF';
const cutRuns = [{ start: 1, end: 5, fg: '#ff0000' }];
eq('Cut off overflow truncates both text and runs at the box height', {
  overflows: textOverflowsBox(cutSource, { w: 3, h: 1 }, true, narrow),
  cut: cutTextToBox(cutSource, { w: 3, h: 1 }, true, cutRuns, '#ffffff', narrow),
}, {
  overflows: true,
  cut: {
    text: 'ABC',
    runs: [{ start: 1, end: 3, fg: '#ff0000' }],
  },
});

const noWrapSource = 'ABCDE\r\nFGHIJ\n界Z';
const noWrapRuns = [
  { start: 1, end: 4, fg: '#ff0000' },
  { start: 7, end: 10, fg: '#00ff00' },
];
eq('Cut off overflow clips every visible no-wrap row and remaps later color runs', {
  overflows: textOverflowsBox(noWrapSource, { w: 3, h: 2 }, false, wideCjk),
  cut: cutTextToBox(noWrapSource, { w: 3, h: 2 }, false, noWrapRuns, '#ffffff', wideCjk),
}, {
  overflows: true,
  cut: {
    text: 'ABC\r\nFGH',
    runs: [
      { start: 1, end: 3, fg: '#ff0000' },
      { start: 5, end: 8, fg: '#00ff00' },
    ],
  },
});

eq('horizontal overflow rejects a wide glyph that cannot fit atomically', {
  overflows: textOverflowsBox('A界B\nXY', { w: 2, h: 2 }, false, wideCjk),
  cut: cutTextToBox('A界B\nXY', { w: 2, h: 2 }, false, [], '#ffffff', wideCjk).text,
}, {
  overflows: true,
  cut: 'A\nXY',
});

eq('layout reports all visual rows instead of clamping to box height',
  layoutText('1234567', 3, true, narrow).lineCount,
  3,
);

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
function graphemes(text) {
  return [...graphemeSegmenter.segment(text)].map(({ segment, index }) => ({
    index,
    end: index + segment.length,
  }));
}
function runColorAt(runs, index, base = '#ffffff') {
  return runs.find((run) => index >= run.start && index < run.end)?.fg || base;
}
function assertRunsValid(text, runs, base = '#ffffff') {
  const boundaries = new Set([0, text.length]);
  for (const segment of graphemes(text)) {
    boundaries.add(segment.index);
    boundaries.add(segment.end);
  }
  let previousEnd = 0;
  for (const run of runs) {
    assert.ok(run.start >= previousEnd, 'runs must be sorted and disjoint');
    assert.ok(run.start < run.end, 'runs must not be empty');
    assert.ok(run.start >= 0 && run.end <= text.length, 'runs must stay in the text');
    assert.ok(boundaries.has(run.start) && boundaries.has(run.end), 'runs must follow grapheme boundaries');
    assert.match(run.fg, /^#[0-9a-f]{6}$/, 'run colors must be normalized hex');
    assert.notEqual(run.fg, base, 'base-colored spans must not be stored as runs');
    previousEnd = run.end;
  }
}
function snappedRange(text, start, end) {
  let from = Math.max(0, Math.min(text.length, start));
  let to = Math.max(from, Math.min(text.length, end));
  for (const segment of graphemes(text)) {
    if (from > segment.index && from < segment.end) from = segment.index;
    if (to > segment.index && to < segment.end) to = segment.end;
  }
  return { from, to };
}

const propertyTexts = [
  'ABCDE',
  'A😀BC',
  'écho',
  '界A😀éZ',
  '👨‍👩‍👧‍👦x',
];
let rangePropertyCount = 0;
for (const text of propertyTexts) {
  const source = normalizeTextRuns([
    { start: 0, end: text.length, fg: '#AA0000' },
    { start: 2, end: Math.max(2, text.length - 1), fg: '#0000AA' },
    { start: -5, end: text.length + 5, fg: 'invalid' },
  ], text, '#ffffff');
  assertRunsValid(text, source);
  for (let start = 0; start <= text.length; start++) {
    for (let end = start; end <= text.length; end++) {
      const color = (start + end) % 2 ? '#00BB00' : '#ffffff';
      const updated = applyTextColor(source, start, end, color, text, '#ffffff');
      assertRunsValid(text, updated);
      const selected = snappedRange(text, start, end);
      for (const segment of graphemes(text)) {
        if (segment.end <= selected.from || segment.index >= selected.to) {
          assert.equal(
            runColorAt(updated, segment.index),
            runColorAt(source, segment.index),
            `color escaped ${start}:${end} in ${JSON.stringify(text)}`,
          );
        }
      }
      rangePropertyCount++;
    }
  }
}
console.log('ok - color runs stay valid and range edits preserve every outside grapheme (' + rangePropertyCount + ' cases)');

const sentinelLayouts = [
  layoutText('ABCDE', 2, true, narrow),
  layoutText('A界B', 3, true, wideCjk),
  layoutText('A😀B', 3, true, (glyph) => glyph === '😀'),
];

const veryLongLayout = layoutText('A'.repeat(150000), 1, false, narrow);
eq('long-overflow-layout-computes-its-extent-without-an-argument-spread',
  textLayoutColumns(veryLongLayout, 1), 150000);
eq('layout matches independent ASCII and wide-glyph sentinels', sentinelLayouts, [
  {
    glyphs: [
      { glyph: 'A', index: 0, end: 1, x: 0, y: 0, width: 1 },
      { glyph: 'B', index: 1, end: 2, x: 1, y: 0, width: 1 },
      { glyph: 'C', index: 2, end: 3, x: 0, y: 1, width: 1 },
      { glyph: 'D', index: 3, end: 4, x: 1, y: 1, width: 1 },
      { glyph: 'E', index: 4, end: 5, x: 0, y: 2, width: 1 },
    ],
    lineCount: 3,
    rowStarts: [0, 2, 4],
  },
  {
    glyphs: [
      { glyph: 'A', index: 0, end: 1, x: 0, y: 0, width: 1 },
      { glyph: '界', index: 1, end: 2, x: 1, y: 0, width: 2 },
      { glyph: 'B', index: 2, end: 3, x: 0, y: 1, width: 1 },
    ],
    lineCount: 2,
    rowStarts: [0, 2],
  },
  {
    glyphs: [
      { glyph: 'A', index: 0, end: 1, x: 0, y: 0, width: 1 },
      { glyph: '😀', index: 1, end: 3, x: 1, y: 0, width: 2 },
      { glyph: 'B', index: 3, end: 4, x: 0, y: 1, width: 1 },
    ],
    lineCount: 2,
    rowStarts: [0, 3],
  },
]);

const cutSentinels = [
  { text: 'ABCDE', box: { w: 2, h: 2 }, wide: narrow, expected: 'ABCD' },
  { text: '界A界B', box: { w: 3, h: 1 }, wide: wideCjk, expected: '界A' },
  { text: 'A😀B', box: { w: 3, h: 1 }, wide: (glyph) => glyph === '😀', expected: 'A😀' },
];
for (const sample of cutSentinels) {
  const runs = normalizeTextRuns([
    { start: 1, end: sample.text.length, fg: '#ff0000' },
  ], sample.text, '#ffffff');
  const cut = cutTextToBox(
    sample.text,
    sample.box,
    true,
    runs,
    '#ffffff',
    sample.wide,
  );
  assert.equal(cut.text, sample.expected, 'cut must stop at the independent row boundary');
  assert.ok(sample.text.startsWith(cut.text), 'cut text must remain a source prefix');
  assertRunsValid(cut.text, cut.runs);
}
console.log('ok - overflow cuts match independent ASCII, CJK, and surrogate-pair boundaries');
