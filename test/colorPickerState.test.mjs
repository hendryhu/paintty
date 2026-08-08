import assert from 'node:assert/strict';
import { hexToOklch, oklchToHex } from '../src/lib/color.js';
import {
  pickerStateFromHex,
  pickerStateFromOklch,
  setPickerChroma,
  setPickerHue,
  setPickerLightness,
} from '../src/lib/colorPickerState.js';

function near(label, actual, expected, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} differs from ${expected} by more than ${tolerance}`,
  );
}

function rgb(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function assertRgbNear(label, actual, expected, tolerance = 1) {
  const actualRgb = rgb(actual);
  const expectedRgb = rgb(expected);
  assert.equal(
    actualRgb.every((channel, index) =>
      Math.abs(channel - expectedRgb[index]) <= tolerance),
    true,
    `${label}: ${actual} is not within ${tolerance} RGB level of ${expected}`,
  );
}

// Reference values for the sRGB primaries under the standard OKLab matrices.
const knownVectors = [
  ['#ff0000', 0.6279553606, 0.2576833077, 29.2338851923],
  ['#00ff00', 0.8664396115, 0.2948272403, 142.4953388878],
  ['#0000ff', 0.4520137184, 0.3132143717, 264.0520206381],
];

for (const [hex, expectedL, expectedC, expectedH] of knownVectors) {
  const state = pickerStateFromHex(hex.toUpperCase());
  near(`${hex} lightness`, state.L, expectedL);
  near(`${hex} chroma`, state.C, expectedC);
  near(`${hex} hue`, state.H, expectedH);
  assertRgbNear(`${hex} known-vector inverse`, oklchToHex(expectedL, expectedC, expectedH), hex);
}

for (const hex of [
  '#000000',
  '#ffffff',
  '#ff0000',
  '#5fb37a',
  '#a86fc9',
  '#123456',
  '#f0a500',
]) {
  const state = pickerStateFromHex(hex);
  const restored = pickerStateFromOklch(state.L, state.C, state.H);
  assertRgbNear(`${hex} RGB round-trip`, restored.hex, hex);

  const decoded = hexToOklch(restored.hex);
  near(`${hex} round-trip lightness`, decoded.L, state.L, 0.004);
  if (state.C > 0.001) near(`${hex} round-trip hue`, decoded.H, state.H, 0.6);
}

function referenceLinearRgb(L, C, H) {
  const hue = H * Math.PI / 180;
  const a = C * Math.cos(hue);
  const b = C * Math.sin(hue);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

function referenceMaxChroma(L, H, tolerance = 0) {
  let lower = 0;
  let upper = 0.4;
  for (let iteration = 0; iteration < 40; iteration++) {
    const middle = (lower + upper) / 2;
    const channels = referenceLinearRgb(L, middle, H);
    if (channels.every((channel) =>
      channel >= -tolerance && channel <= 1 + tolerance)) lower = middle;
    else upper = middle;
  }
  return lower;
}

for (const [L, H] of [[0.35, 30], [0.6, 140], [0.75, 260]]) {
  const state = pickerStateFromOklch(L, 10, H);
  const expectedMax = referenceMaxChroma(L, H, 0.001);
  near(`supported gamut boundary at ${L}/${H}`, state.C, expectedMax, 1e-6);
  assert.equal(
    referenceLinearRgb(state.L, state.C, state.H)
      .every((channel) => channel >= -0.0011 && channel <= 1.0011),
    true,
    `clamped picker state at ${L}/${H} must remain inside the supported sRGB tolerance`,
  );
}

const seed = pickerStateFromHex('#5fb37a');
const lighter = setPickerLightness(seed, 45);
near('lightness setter uses percentage input', lighter.L, 0.45);
near('lightness setter preserves hue', lighter.H, seed.H);

const rehuing = setPickerHue(seed, 220);
near('hue setter updates hue', rehuing.H, 220);
near('hue setter preserves lightness', rehuing.L, seed.L);

const saturated = setPickerChroma(seed, 10);
near('chroma setter clamps to the independent gamut boundary',
  saturated.C, referenceMaxChroma(seed.L, seed.H, 0.001), 1e-6);

assert.deepEqual(pickerStateFromHex('not-a-color'), {
  L: 0,
  C: 0,
  H: 0,
  hex: '#000000',
});
assert.deepEqual(pickerStateFromOklch(Number.NaN, Number.NaN, Number.NaN), {
  L: 0,
  C: 0,
  H: 0,
  hex: '#000000',
});
assert.deepEqual(pickerStateFromOklch(-1, -2, -30), {
  L: 0,
  C: 0,
  H: 0,
  hex: '#000000',
});
assert.deepEqual(pickerStateFromOklch(2, -2, 720), {
  L: 1,
  C: 0,
  H: 360,
  hex: '#ffffff',
});
assert.equal(setPickerLightness(seed, 'not-a-number').L, 0);
assert.equal(setPickerHue(seed, Number.POSITIVE_INFINITY).H, 0);
assert.equal(setPickerChroma(seed, -5).C, 0);

console.log('color picker state: independent vectors, round-trips, and bounds passed');
