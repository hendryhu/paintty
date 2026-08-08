import {
  cmKey,
  cmParse,
  cmGet,
  cmHas,
  cmSet,
  cmClone,
  cmEqual,
  cmEntries,
  cmSize,
  cmTranslate,
  cmBounds,
  cmFromGrid,
  cmToGrid,
} from '../src/lib/cellmap.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.error(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`); }
}
const cell = (c) => ({ c, fg: '#fff', bg: null });

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const random = seededRandom(0xc311);
const seededMap = {};
const expected = new Map();
const lawFailures = [];
let sawNegative = false;
for (let index = 0; index < 32; index++) {
  const x = Math.floor(random() * 201) - 100;
  const y = Math.floor(random() * 201) - 100;
  const value = {
    c: String.fromCodePoint(33 + index % 90),
    fg: '#' + (index * 7919 % 0xffffff).toString(16).padStart(6, '0'),
    bg: index % 3 ? null : '#010203',
    ...(index % 5 === 0 ? { cont: true } : {}),
  };
  const key = cmKey(x, y);
  const point = cmParse(key);
  sawNegative ||= x < 0 || y < 0;
  if (point.x !== x || point.y !== y) lawFailures.push('parse ' + key);
  cmSet(seededMap, x, y, value);
  expected.set(key, { x, y, cell: value });
  if (!cmHas(seededMap, x, y)) lawFailures.push('has ' + key);
  if (JSON.stringify(cmGet(seededMap, x, y)) !== JSON.stringify(value)) {
    lawFailures.push('get ' + key);
  }
}
for (const [index, [key, entry]] of [...expected.entries()].entries()) {
  if (index % 3 !== 0) continue;
  cmSet(seededMap, entry.x, entry.y, null);
  expected.delete(key);
  if (cmHas(seededMap, entry.x, entry.y) || cmGet(seededMap, entry.x, entry.y) !== null) {
    lawFailures.push('delete ' + key);
  }
}
const normalizeEntries = (entries) => entries
  .map(({ x, y, cell: value }) => ({ x, y, cell: value }))
  .sort((left, right) => left.x - right.x || left.y - right.y);
eq('seeded set/get/has/delete/parse/entries law', {
  failures: lawFailures,
  sawNegative,
  size: cmSize(seededMap),
  entries: normalizeEntries(cmEntries(seededMap)),
}, {
  failures: [],
  sawNegative: true,
  size: expected.size,
  entries: normalizeEntries([...expected.values()]),
});

const original = {
  [cmKey(1, 2)]: { c: 'A', fg: '#112233', bg: null },
  [cmKey(-3, 4)]: { c: 'B', fg: '#445566', bg: '#778899', cont: true },
};
const cloned = cmClone(original);
cloned[cmKey(1, 2)].fg = '#abcdef';
cmSet(cloned, -3, 4, null);
cmSet(cloned, 9, 9, cell('C'));
eq('clone does not alias the map or its cells', {
  separateMap: cloned !== original,
  separateCell: cloned[cmKey(1, 2)] !== original[cmKey(1, 2)],
  original,
}, {
  separateMap: true,
  separateCell: true,
  original: {
    [cmKey(1, 2)]: { c: 'A', fg: '#112233', bg: null },
    [cmKey(-3, 4)]: { c: 'B', fg: '#445566', bg: '#778899', cont: true },
  },
});

const equalBase = { [cmKey(0, 0)]: { c: 'A', fg: '#112233', bg: '#445566', cont: true } };
eq('equality detects every meaningful field and key-set difference', [
  cmEqual(equalBase, { [cmKey(0, 0)]: { ...equalBase[cmKey(0, 0)] } }),
  cmEqual(equalBase, { [cmKey(0, 0)]: { ...equalBase[cmKey(0, 0)], c: 'B' } }),
  cmEqual(equalBase, { [cmKey(0, 0)]: { ...equalBase[cmKey(0, 0)], fg: '#ffffff' } }),
  cmEqual(equalBase, { [cmKey(0, 0)]: { ...equalBase[cmKey(0, 0)], bg: null } }),
  cmEqual(equalBase, { [cmKey(0, 0)]: { ...equalBase[cmKey(0, 0)], cont: false } }),
  cmEqual(equalBase, {}),
  cmEqual(equalBase, { ...equalBase, [cmKey(1, 0)]: cell('C') }),
], [true, false, false, false, false, false, false]);

const src = { [cmKey(0, 0)]: cell('a'), [cmKey(5, 5)]: cell('b') };
const t = cmTranslate(src, -10, 0);
eq('translate', [cmGet(t, -10, 0)?.c, cmGet(t, -5, 5)?.c], ['a', 'b']);
eq('translate-nonmutating', cmGet(src, 0, 0)?.c, 'a');

eq('bounds', cmBounds(src), { x0: 0, y0: 0, x1: 5, y1: 5 });
eq('bounds-neg', cmBounds({ [cmKey(-2, -3)]: cell('x'), [cmKey(1, 1)]: cell('y') }), { x0: -2, y0: -3, x1: 1, y1: 1 });
eq('bounds-empty', cmBounds({}), null);

const grid = [[null, cell('g')], [cell('h'), null]];
const overflow = { [cmKey(-1, 0)]: cell('o') };
const fm = cmFromGrid(grid, overflow);
eq('fromGrid', [cmGet(fm, 1, 0)?.c, cmGet(fm, 0, 1)?.c, cmGet(fm, -1, 0)?.c], ['g', 'h', 'o']);

const vpGrid = cmToGrid(src, { x: 0, y: 0, w: 3, h: 3 });
eq('toGrid-in', vpGrid[0][0]?.c, 'a');
eq('toGrid-out', vpGrid[2]?.[2] ?? null, null);
const shifted = cmToGrid(src, { x: 5, y: 5, w: 2, h: 2 });
eq('toGrid-window', shifted[0][0]?.c, 'b');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
