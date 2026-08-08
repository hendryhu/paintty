import { planSubcellFill } from '../src/lib/fill.js';
import { maskFromChar } from '../src/lib/subcell.js';

let pass = 0;
let fail = 0;

function eq(name, got, want) {
  const actual = JSON.stringify(got);
  const expected = JSON.stringify(want);
  if (actual === expected) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  got:  ${actual}\n  want: ${expected}`);
  }
}

function reader(cells) {
  return (x, y) => cells[`${x},${y}`] || null;
}

const halfBase = {
  '0,0': { c: '▄', fg: '#111111', bg: '#010203' },
  '1,0': { c: '▄', fg: '#111111', bg: '#040506' },
};
eq('half-fill-floods-logical-top-row-and-preserves-backgrounds', planSubcellFill({
  width: 2, height: 1, x: 0, y: 0, fx: 0.25, fy: 0.25,
  resolution: 'half', color: '#abcdef', sampleCell: reader(halfBase),
  activeCell: reader(halfBase),
}), [
  { x: 0, y: 0, cell: { c: '█', fg: '#abcdef', bg: '#010203' } },
  { x: 1, y: 0, cell: { c: '█', fg: '#abcdef', bg: '#040506' } },
]);

const mixedHalf = { '0,0': { c: '▘', fg: '#111111', bg: '#222222' } };
eq('half-fill-treats-a-mixed-half-as-a-barrier', planSubcellFill({
  width: 1, height: 1, x: 0, y: 0, fx: 0.25, fy: 0.25,
  resolution: 'half', color: '#abcdef', sampleCell: reader(mixedHalf),
  activeCell: reader(mixedHalf),
}), []);

eq('quarter-fill-can-recolor-one-quadrant-of-a-mixed-block', planSubcellFill({
  width: 1, height: 1, x: 0, y: 0, fx: 0.25, fy: 0.25,
  resolution: 'quarter', color: '#abcdef', sampleCell: reader(mixedHalf),
  activeCell: reader(mixedHalf),
}), [
  { x: 0, y: 0, cell: { c: '▘', fg: '#abcdef', bg: '#222222' } },
]);

const ordinary = { '0,0': { c: '@', fg: '#111111', bg: '#222222' } };
for (const resolution of ['half', 'quarter']) {
  eq(`${resolution}-fill-does-not-rewrite-an-ordinary-glyph`, planSubcellFill({
    width: 1, height: 1, x: 0, y: 0, fx: 0.25, fy: 0.25,
    resolution, color: '#abcdef', sampleCell: reader(ordinary),
    activeCell: reader(ordinary),
  }), []);
}

const continuation = { '0,0': { c: '', fg: '#111111', cont: true } };
eq('quarter-fill-does-not-rewrite-a-wide-continuation', planSubcellFill({
  width: 1, height: 1, x: 0, y: 0, fx: 0.25, fy: 0.25,
  resolution: 'quarter', color: '#abcdef', sampleCell: reader(continuation),
  activeCell: reader(continuation),
}), []);

const composite = { '0,0': { c: '▝', fg: '#fedcba', bg: '#010101' } };
eq('sample-all-reads-the-composite-but-writes-the-active-layer', planSubcellFill({
  width: 1, height: 1, x: 0, y: 0, fx: 0.75, fy: 0.25,
  resolution: 'quarter', color: '#abcdef', sampleCell: reader(composite),
  activeCell: reader({}),
}), [
  { x: 0, y: 0, cell: { c: '▝', fg: '#abcdef', bg: null } },
]);

eq('selection-gates-whole-physical-cells', planSubcellFill({
  width: 2, height: 1, x: 0, y: 0, fx: 0.25, fy: 0.25,
  resolution: 'quarter', color: '#abcdef', selected: new Set(['0,0']),
  sampleCell: reader({}), activeCell: reader({}),
}), [
  { x: 0, y: 0, cell: { c: '█', fg: '#abcdef', bg: null } },
]);

const separated = {
  '0,0': { c: '▘', fg: '#111111' },
  '1,0': { c: '▝', fg: '#222222' },
  '2,0': { c: '▘', fg: '#111111' },
};
eq('noncontiguous-quarter-fill-visits-each-matching-slot-once', planSubcellFill({
  width: 3, height: 1, x: 0, y: 0, fx: 0.25, fy: 0.25,
  resolution: 'quarter', contiguous: false, color: '#abcdef',
  sampleCell: reader(separated), activeCell: reader(separated),
}), [
  { x: 0, y: 0, cell: { c: '▘', fg: '#abcdef', bg: null } },
  { x: 2, y: 0, cell: { c: '▘', fg: '#abcdef', bg: null } },
]);

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(0x51bf11);
const blockGlyphs = ['', '▘', '▝', '▖', '▗', '▀', '▄', '▌', '▐', '▚', '▞', '▛', '▜', '▙', '▟', '█'];
let propertyFailure = null;
for (let run = 0; run < 32 && !propertyFailure; run++) {
  const width = 1 + Math.floor(random() * 5);
  const height = 1 + Math.floor(random() * 4);
  const cells = {};
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const roll = random();
      if (roll < 0.58) {
        const c = blockGlyphs[Math.floor(random() * blockGlyphs.length)];
        if (c) {
          cells[`${x},${y}`] = {
            c,
            fg: random() < 0.5 ? '#112233' : '#445566',
            bg: random() < 0.3 ? '#010203' : null,
          };
        }
      } else if (roll < 0.73) {
        cells[`${x},${y}`] = { c: '@', fg: '#778899', bg: null };
      } else if (roll < 0.78) {
        cells[`${x},${y}`] = { c: '', fg: '#778899', bg: null, cont: true };
      }
    }
  }
  const selected = new Set();
  if (random() < 0.45) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (random() < 0.6) selected.add(`${x},${y}`);
      }
    }
  }
  const x = Math.floor(random() * width);
  const y = Math.floor(random() * height);
  if (selected.size && !selected.has(`${x},${y}`)) selected.add(`${x},${y}`);
  const resolution = random() < 0.5 ? 'half' : 'quarter';
  const args = {
    width, height, x, y,
    fx: random() < 0.5 ? 0.25 : 0.75,
    fy: random() < 0.5 ? 0.25 : 0.75,
    resolution,
    contiguous: random() < 0.7,
    selected,
    sampleCell: reader(cells),
    activeCell: reader(cells),
    color: '#abcdef',
  };
  const updates = planSubcellFill(args);
  const keys = updates.map((update) => `${update.x},${update.y}`);
  const valid = new Set(keys).size === keys.length && updates.every((update) => {
    const key = `${update.x},${update.y}`;
    const previous = cells[key];
    return update.x >= 0 && update.x < width && update.y >= 0 && update.y < height
      && (!selected.size || selected.has(key))
      && !update.cell?.cont
      && maskFromChar(update.cell?.c) > 0
      && (update.cell?.bg ?? null) === (previous?.bg ?? null)
      && !previous?.cont
      && (!previous?.c || maskFromChar(previous.c) > 0);
  });
  if (!valid) {
    propertyFailure = { run, kind: 'invalid update', cells, selected: [...selected], updates };
    break;
  }
  const next = { ...cells };
  for (const update of updates) next[`${update.x},${update.y}`] = update.cell;
  const repeat = planSubcellFill({ ...args, sampleCell: reader(next), activeCell: reader(next) });
  if (repeat.length) {
    propertyFailure = { run, kind: 'not idempotent', cells, selected: [...selected], updates, repeat };
  }
}
eq('seeded-subcell-fill-preserves-canonical-cell-invariants', propertyFailure, null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
