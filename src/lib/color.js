export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function blendHex(fg, bg, alpha) {
  const foreground = hexToRgb(fg);
  const background = hexToRgb(bg);
  const mix = (channel) =>
    foreground[channel] * alpha + background[channel] * (1 - alpha);
  return rgbToHex(mix('r'), mix('g'), mix('b'));
}

const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

function nearestCubeChannel(v) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < CUBE_STEPS.length; i++) {
    const d = Math.abs(CUBE_STEPS[i] - v);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export function nearest256(hex) {
  const { r, g, b } = hexToRgb(hex);

  const ri = nearestCubeChannel(r);
  const gi = nearestCubeChannel(g);
  const bi = nearestCubeChannel(b);
  const cr = CUBE_STEPS[ri];
  const cg = CUBE_STEPS[gi];
  const cb = CUBE_STEPS[bi];
  const cubeIndex = 16 + 36 * ri + 6 * gi + bi;
  const cubeDist = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;

  const gray = (r + g + b) / 3;
  let gi2 = Math.round((gray - 8) / 10);
  gi2 = Math.max(0, Math.min(23, gi2));
  const gv = 8 + gi2 * 10;
  const grayIndex = 232 + gi2;
  const grayDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;

  if (grayDist < cubeDist) return { index: grayIndex, hex: rgbToHex(gv, gv, gv) };
  return { index: cubeIndex, hex: rgbToHex(cr, cg, cb) };
}

function srgbToLinear(channel) {
  const value = channel / 255;
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel) {
  const value = channel <= 0.0031308
    ? 12.92 * channel
    : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, value)) * 255);
}

export function hexToOklch(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const C = Math.hypot(a, bb);
  let H = Math.atan2(bb, a) * 180 / Math.PI; if (H < 0) H += 360;
  return { L, C, H };
}

export function oklchToHex(L, C, H) {
  const hr = H * Math.PI / 180;
  const a = C * Math.cos(hr), bb = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * bb;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return rgbToHex(linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb));
}

export function oklchInGamut(L, C, H) {
  const hr = H * Math.PI / 180;
  const a = C * Math.cos(hr), bb = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * bb) ** 3;
  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const ok = (v) => v >= -0.001 && v <= 1.001;
  return ok(lr) && ok(lg) && ok(lb);
}

export function maxChroma(L, H) {
  let lo = 0, hi = 0.4;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (oklchInGamut(L, mid, H)) lo = mid; else hi = mid;
  }
  return lo;
}
