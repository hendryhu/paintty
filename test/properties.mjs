import { get } from 'svelte/store';
import * as G from '../src/lib/grid.js';
import { cmClone, cmKey, cmTranslate } from '../src/lib/cellmap.js';
import { blendHex, nearest256 } from '../src/lib/color.js';

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

let passed = 0;
let generatedCases = 0;
const laws = new Set();
const failures = [];

function check(name, condition, detail = '') {
  laws.add(name);
  generatedCases++;
  if (condition) passed++;
  else failures.push('FAIL ' + name + (detail ? ' — ' + detail : ''));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function randomHex(random) {
  const channel = () => Math.floor(random() * 256).toString(16).padStart(2, '0');
  return '#' + channel() + channel() + channel();
}

function parseHex(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function formatHex(channels) {
  return '#' + channels.map((value) => Math.max(0, Math.min(255, Math.round(value)))
    .toString(16).padStart(2, '0')).join('');
}

function referenceBlend(foreground, background, alpha) {
  const front = parseHex(foreground);
  const back = parseHex(background);
  return formatHex(front.map((value, index) => value * alpha + back[index] * (1 - alpha)));
}

const XTERM_STEPS = [0, 95, 135, 175, 215, 255];
const XTERM_PALETTE = [];
for (let red = 0; red < 6; red++) {
  for (let green = 0; green < 6; green++) {
    for (let blue = 0; blue < 6; blue++) {
      XTERM_PALETTE.push({
        index: 16 + red * 36 + green * 6 + blue,
        rgb: [XTERM_STEPS[red], XTERM_STEPS[green], XTERM_STEPS[blue]],
      });
    }
  }
}
for (let index = 0; index < 24; index++) {
  const value = 8 + index * 10;
  XTERM_PALETTE.push({ index: 232 + index, rgb: [value, value, value] });
}

function referenceNearest256(hex) {
  const source = parseHex(hex);
  let bestDistance = Infinity;
  let best = [];
  for (const candidate of XTERM_PALETTE) {
    const distance = candidate.rgb.reduce((sum, value, index) =>
      sum + (value - source[index]) ** 2, 0);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = [candidate];
    } else if (distance === bestDistance) {
      best.push(candidate);
    }
  }
  return best.map((candidate) => ({
    index: candidate.index,
    hex: formatHex(candidate.rgb),
  }));
}

function randomCellMap(random, count) {
  const cells = {};
  for (let index = 0; index < count; index++) {
    const x = Math.floor(random() * 16) - 5;
    const y = Math.floor(random() * 12) - 4;
    cells[cmKey(x, y)] = { c: '@', fg: randomHex(random), bg: randomHex(random) };
  }
  return cells;
}

{
  const random = rng(101);
  const boundaryColors = ['#000000', '#ffffff', '#080808', '#eeeeee', '#5f5f5f', '#878787'];
  const colors = boundaryColors.concat(Array.from({ length: 64 }, () => randomHex(random)));
  for (const color of colors) {
    const actual = nearest256(color);
    const expected = referenceNearest256(color);
    const isMinimum = expected.some((candidate) =>
      candidate.index === actual.index && candidate.hex === actual.hex);
    check('nearest-xterm-color', isMinimum,
      color + ': ' + JSON.stringify(actual) + ' not in ' + JSON.stringify(expected));
  }
}

{
  const random = rng(202);
  for (let index = 0; index < 32; index++) {
    const foreground = randomHex(random);
    const background = randomHex(random);
    for (const alpha of [0, random(), random(), 1]) {
      const actual = blendHex(foreground, background, alpha);
      const expected = referenceBlend(foreground, background, alpha);
      check('exact-alpha-blend', actual === expected,
        foreground + ' over ' + background + ' at ' + alpha + ': ' + actual + ' != ' + expected);
    }
  }
}

{
  const random = rng(303);
  for (let run = 0; run < 16; run++) {
    const group = {
      id: 1000 + run,
      type: 'group',
      visible: true,
      offset: { x: random() * 5 - 2.5, y: random() * 5 - 2.5 },
      cells: {},
    };
    const rawGlyphs = randomCellMap(random, 5 + Math.floor(random() * 8));
    const rawBackgrounds = randomCellMap(random, 5 + Math.floor(random() * 8));
    const glyph = {
      id: run * 10 + 1,
      type: 'cell',
      visible: true,
      groupId: group.id,
      opacity: [0.25, 0.5, 1][Math.floor(random() * 3)],
      blink: random() < 0.2,
      offset: { x: random() * 5 - 2.5, y: random() * 5 - 2.5 },
      cells: Object.fromEntries(Object.entries(rawGlyphs)
        .map(([key, cell]) => [key, { c: cell.c, fg: cell.fg }])),
    };
    const background = {
      id: run * 10 + 2,
      type: 'background',
      visible: true,
      groupId: group.id,
      opacity: [0.25, 0.5, 1][Math.floor(random() * 3)],
      offset: { x: random() * 5 - 2.5, y: random() * 5 - 2.5 },
      cells: Object.fromEntries(Object.entries(rawBackgrounds)
        .map(([key, cell]) => [key, { bg: cell.bg }])),
    };
    const viewport = {
      x: Math.floor(random() * 7) - 3,
      y: Math.floor(random() * 7) - 3,
      w: 8 + Math.floor(random() * 5),
      h: 7 + Math.floor(random() * 5),
    };
    const stack = [group, glyph, background];
    const grouped = G.compositeWorld(stack, viewport);
    const flatten = (layer) => ({
      ...layer,
      groupId: null,
      offset: {
        x: layer.offset.x + group.offset.x,
        y: layer.offset.y + group.offset.y,
      },
    });
    check(
      'group-offset-equivalence',
      sameValue(grouped, G.compositeWorld([
        flatten(glyph),
        flatten(background),
      ], viewport)),
      'run ' + run,
    );

    const dx = Math.floor(random() * 9) - 4;
    const dy = Math.floor(random() * 9) - 4;
    const shifted = [
      { ...group, offset: { x: group.offset.x + dx, y: group.offset.y + dy } },
      glyph,
      background,
    ];
    check(
      'world-translation-equivariance',
      sameValue(grouped, G.compositeWorld(shifted, {
        ...viewport,
        x: viewport.x + dx,
        y: viewport.y + dy,
      })),
      'run ' + run,
    );

    const hiddenNoise = {
      type: 'cell',
      visible: false,
      cells: randomCellMap(random, 12),
    };
    check(
      'hidden-layer-identity',
      sameValue(grouped, G.compositeWorld([hiddenNoise, ...stack], viewport)),
      'run ' + run,
    );

    const plainGlyph = { ...glyph, groupId: null, offset: { x: 0, y: 0 }, opacity: 1 };
    const plainBackground = { ...background, groupId: null, offset: { x: 0, y: 0 }, opacity: 1 };
    check(
      'independent-channels-commute',
      sameValue(
        G.compositeWorld([plainGlyph, plainBackground], viewport),
        G.compositeWorld([plainBackground, plainGlyph], viewport),
      ),
      'run ' + run,
    );
    check(
      'zero-opacity-is-identity',
      sameValue(
        G.compositeWorld([{ ...plainGlyph, opacity: 0 }, plainBackground], viewport),
        G.compositeWorld([plainBackground], viewport),
      ),
      'run ' + run,
    );
  }
}

{
  const random = rng(404);
  for (let index = 0; index < 32; index++) {
    const cells = randomCellMap(random, 5 + Math.floor(random() * 10));
    const firstX = Math.floor(random() * 40) - 20;
    const firstY = Math.floor(random() * 40) - 20;
    const secondX = Math.floor(random() * 40) - 20;
    const secondY = Math.floor(random() * 40) - 20;
    const composed = cmTranslate(cmTranslate(cells, firstX, firstY), secondX, secondY);
    const direct = cmTranslate(cells, firstX + secondX, firstY + secondY);
    const restored = cmTranslate(cmTranslate(cells, firstX, firstY), -firstX, -firstY);
    check('translation-adds', sameValue(composed, direct));
    check('translation-round-trips', sameValue(restored, cells));
  }
}

{
  const random = rng(505);
  for (let run = 0; run < 16; run++) {
    G.setLayers([{
      name: 'world cells',
      type: 'cell',
      visible: true,
      cells: randomCellMap(random, 20),
    }]);
    const before = cmClone(get(G.layers)[0].cells);
    G.resizeCanvas(1 + Math.floor(random() * 40), 1 + Math.floor(random() * 40));
    check('resize-preserves-world-cells', sameValue(before, get(G.layers)[0].cells), 'run ' + run);
  }
}

console.log(
  'properties: ' + laws.size + ' laws across ' + generatedCases + ' generated cases; '
  + passed + ' passed',
);
if (failures.length) {
  console.error('\nFOUND ' + failures.length + ' violation(s):\n');
  for (const failure of failures.slice(0, 20)) console.error('  ' + failure);
  if (failures.length > 20) console.error('  …and ' + (failures.length - 20) + ' more');
  process.exit(1);
}
console.log('\nPASS — all independent references and model laws hold.');
