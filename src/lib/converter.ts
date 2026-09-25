import { GRID_W, GRID_H } from './grid.js';
import { rgbToHex } from './color.js';
import { composeGlyphCoverage, redrawCellBoundaryCoverage } from './render.js';
import type { CellValue } from './types/project-types.js';

type ColorChannel = 'r' | 'g' | 'b';
export type ConversionMode = 'auto' | 'blocks' | 'density' | 'glyph';
export type CharacterSetName = keyof typeof CHARACTER_SETS | 'custom';

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface RgbaColor extends RgbColor {
  a: number;
}

interface ConversionStats {
  uniqueColors: number;
  transparentRatio: number;
  opaqueRatio: number;
}

interface GlyphCandidate {
  ch: string;
  mask: Float32Array;
  coverage: number;
  hash: number;
  signature: Float32Array;
  width: number;
  height: number;
}

interface ConversionOptions {
  alphaThreshold?: number;
  background?: 'solid' | 'source' | string;
  backgroundColor?: string;
  batchCells?: number;
  charset?: CharacterSetName;
  characters?: string;
  colorLimit?: number;
  cols?: number;
  fontFamily?: string;
  glyphLimit?: number;
  invert?: boolean;
  mode?: ConversionMode;
  rows?: number;
  sampleH?: number;
  sampleW?: number;
}

interface ConversionJob {
  signal?: AbortSignal;
  batchCells: number;
  batchGlyphs: number;
  batchPixels: number;
  yieldControl: () => void | Promise<void>;
}

interface ConversionJobOptions {
  signal?: AbortSignal;
  batchCells?: number;
  batchGlyphs?: number;
  batchPixels?: number;
  yieldControl?: () => void | Promise<void>;
}

type ConversionCellMap = Record<string, CellValue>;

interface ConversionState {
  options: ConversionOptions;
  cols: number;
  rows: number;
  alphaThreshold: number;
  sampleW: number;
  sampleH: number;
  image: ImageData;
  stats: ConversionStats;
  mode: ConversionMode;
  characters: string[];
  palette: RgbColor[];
  foreground: ConversionCellMap;
  background: ConversionCellMap;
  shapeByAlpha: boolean;
  solidBackground: string | null;
}

export interface ConversionResult {
  foreground: ConversionCellMap;
  background: ConversionCellMap;
  meta: {
    mode: ConversionMode;
    uniqueColors: number;
    transparentRatio: number;
    palette: Array<string | null>;
    characters: string;
  };
}

interface ConversionPreviewOptions {
  cols?: number;
  rows?: number;
  cellWidth?: number;
  cellHeight?: number;
  fontFamily?: string;
}

const ASCII_ART_CHARACTERS = ' .\u0060^",:;Il!i~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
const BLOCK_CHARACTERS = ' ▏▎▍▌▋▊▉█▔▀▁▂▃▄▅▆▇▖▗▘▝▚▞▙▟▛▜░▒▓';
const TERMINAL_ART_CORE =
  ASCII_ART_CHARACTERS + BLOCK_CHARACTERS +
  '─│┌┐└┘├┤┬┴┼━┃┏┓┗┛┣┫┳┻╋═║╔╗╚╝╠╣╦╩╬╭╮╰╯' +
  '○●◇◆□■△▲▽▼◁◀▷▶♠♣♥♦⣿⣷⣯⣟⡿⢿⣻⣽';
const UNSAFE_TERMINAL_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{M}\p{Z}\p{Emoji_Presentation}]/u;

function characterRange(first: number, last: number): string {
  let value = '';
  for (let codepoint = first; codepoint <= last; codepoint++) {
    const character = String.fromCodePoint(codepoint);
    if (codepoint !== 0x2329 && codepoint !== 0x232a &&
      !UNSAFE_TERMINAL_CHARACTER.test(character)) value += character;
  }
  return value;
}

const UNICODE_ART_CHARACTERS = [
  TERMINAL_ART_CORE,
  characterRange(0x20, 0x7e),
  characterRange(0xa1, 0xff),
  characterRange(0x370, 0x52f),
  characterRange(0x2000, 0x206f),
  characterRange(0x20a0, 0x20cf),
  characterRange(0x2100, 0x214f),
  characterRange(0x2190, 0x23ff),
  characterRange(0x2500, 0x27bf),
  characterRange(0x2800, 0x28ff),
  characterRange(0x2a00, 0x2aff),
  characterRange(0x2b00, 0x2bff),
].join('');

export const CHARACTER_SETS = Object.freeze({
  ascii: ' .,:;irsXA253hMHGS#9B&@',
  asciiArt: ASCII_ART_CHARACTERS,
  blocks: BLOCK_CHARACTERS,
  extended: ' .,:;irsXA253hMHGS#9B&@▏▎▍▌▋▊▉█▔▀▁▂▃▄▅▆▇▖▗▘▝▚▞▙▟▛▜░▒▓●○◆◇■□',
  unicodeArt: UNICODE_ART_CHARACTERS,
});

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function uniqueCharacters(value: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ch of [...(value || '')]) {
    if (!seen.has(ch)) {
      seen.add(ch);
      out.push(ch);
    }
  }
  if (!seen.has(' ')) out.unshift(' ');
  return out;
}

export function limitCharacters(
  value: string | string[],
  limit: number,
  ranked = false,
): string[] {
  const chars = Array.isArray(value) ? value : uniqueCharacters(value);
  const n = Math.max(2, Math.min(chars.length, Math.round(limit) || chars.length));
  if (chars.length <= n) return chars;
  if (ranked) return chars.slice(0, n);
  const out = [];
  for (let i = 0; i < n; i++) out.push(chars[Math.round(i * (chars.length - 1) / (n - 1))]);
  return uniqueCharacters(out.join(''));
}

export function analyzePixels(data: ArrayLike<number>, alphaThreshold = 32): ConversionStats {
  const colors = new Set<number>();
  let transparent = 0;
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < alphaThreshold) {
      transparent++;
      continue;
    }
    opaque++;
    if (colors.size < 257) {
      colors.add(((data[i]! >> 4) << 8) | ((data[i + 1]! >> 4) << 4) | (data[i + 2]! >> 4));
    }
  }
  const total = transparent + opaque;
  return {
    uniqueColors: colors.size,
    transparentRatio: total ? transparent / total : 1,
    opaqueRatio: total ? opaque / total : 0,
  };
}

export function chooseConversionMode(
  stats: ConversionStats,
  requested: ConversionMode = 'auto',
): ConversionMode {
  if (requested !== 'auto') return requested;
  if ((stats.transparentRatio > 0.005 && stats.uniqueColors <= 16) || stats.uniqueColors <= 4) return 'glyph';
  return 'blocks';
}

function channelRange(points: readonly RgbColor[], channel: ColorChannel): number {
  let lo = 255;
  let hi = 0;
  for (const point of points) {
    lo = Math.min(lo, point[channel]);
    hi = Math.max(hi, point[channel]);
  }
  return hi - lo;
}

export function medianCutPalette(points: readonly RgbColor[], requestedLimit: number): RgbColor[] {
  const limit = Math.max(1, Math.min(64, Math.round(requestedLimit) || 1));
  if (!points.length) return [];
  let boxes: RgbColor[][] = [points.slice()];
  while (boxes.length < limit) {
    let splitIndex = -1;
    let splitChannel: ColorChannel = 'r';
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i]!.length < 2) continue;
      for (const channel of ['r', 'g', 'b'] as const) {
        const score = channelRange(boxes[i]!, channel) * boxes[i]!.length;
        if (score > best) {
          best = score;
          splitIndex = i;
          splitChannel = channel;
        }
      }
    }
    if (splitIndex < 0) break;
    const box = boxes[splitIndex]!.slice().sort((a, b) => a[splitChannel] - b[splitChannel]);
    const middle = Math.floor(box.length / 2);
    boxes.splice(splitIndex, 1, box.slice(0, middle), box.slice(middle));
  }
  const palette = boxes.map((box) => {
    const sum = box.reduce((acc, point) => ({
      r: acc.r + point.r,
      g: acc.g + point.g,
      b: acc.b + point.b,
    }), { r: 0, g: 0, b: 0 });
    return { r: sum.r / box.length, g: sum.g / box.length, b: sum.b / box.length };
  });
  const seen = new Set<string>();
  return palette.filter((color) => {
    const key = Math.round(color.r) + ',' + Math.round(color.g) + ',' + Math.round(color.b);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nearestPalette(color: RgbColor | null, palette: readonly RgbColor[]): RgbColor | null {
  if (!color || !palette.length) return color;
  let best = palette[0]!;
  let bestDistance = Infinity;
  for (const entry of palette) {
    const dr = color.r - entry.r;
    const dg = color.g - entry.g;
    const db = color.b - entry.b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
    }
  }
  return best;
}

function averageColor(
  points: readonly RgbaColor[],
  weights: readonly number[] | null,
  alphaThreshold: number,
): RgbColor | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    if (point.a < alphaThreshold) continue;
    const weight = Math.max(0, weights ? weights[i]! : 1) * (point.a / 255);
    r += point.r * weight;
    g += point.g * weight;
    b += point.b * weight;
    total += weight;
  }
  if (!total) return null;
  return { r: r / total, g: g / total, b: b / total };
}

function colorHex(color: RgbColor | null, palette: readonly RgbColor[]): string | null {
  const q = nearestPalette(color, palette);
  return q ? rgbToHex(q.r, q.g, q.b) : null;
}

const GLYPH_ATLAS_CACHE_LIMIT = 3;
const glyphAtlasCache = new Map<string, GlyphCandidate[]>();

function atlasKey(characters: readonly string[], width: number, height: number, fontFamily: string): string {
  return width + 'x' + height + '|' + fontFamily + '|' + characters.join('');
}

function atlasContext(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return ctx!;
}

const GLYPH_SIGNATURE_SIZE = 4;

function maskSignature(mask: Float32Array, width: number, height: number): Float32Array {
  const sums = new Float32Array(GLYPH_SIGNATURE_SIZE * GLYPH_SIGNATURE_SIZE);
  const counts = new Float32Array(sums.length);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(GLYPH_SIGNATURE_SIZE - 1,
      Math.floor(y * GLYPH_SIGNATURE_SIZE / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(GLYPH_SIGNATURE_SIZE - 1,
        Math.floor(x * GLYPH_SIGNATURE_SIZE / width));
      const index = sy * GLYPH_SIGNATURE_SIZE + sx;
      sums[index] = sums[index]! + mask[y * width + x]!;
      counts[index] = counts[index]! + 1;
    }
  }
  for (let index = 0; index < sums.length; index++) {
    if (counts[index]) sums[index] = sums[index]! / counts[index]!;
  }
  return sums;
}

function glyphCandidate(
  ctx: CanvasRenderingContext2D,
  ch: string,
  width: number,
  height: number,
  fontFamily: string,
): GlyphCandidate {
  ctx.clearRect(0, 0, width, height);
  if (ch !== ' ') {
    ctx.fillStyle = '#ffffff';
    ctx.font = Math.round(height * 0.9) + 'px ' + fontFamily;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, width / 2, height / 2);
  }
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const mask = new Float32Array(width * height);
  let coverage = 0;
  let hash = 2166136261;
  for (let i = 0; i < mask.length; i++) {
    const alpha = rgba[i * 4 + 3]!;
    mask[i] = alpha / 255;
    coverage += mask[i]!;
    hash ^= alpha;
    hash = Math.imul(hash, 16777619);
  }
  return {
    ch,
    mask,
    coverage: coverage / mask.length,
    hash: hash >>> 0,
    signature: maskSignature(mask, width, height),
    width,
    height,
  };
}

function sameMask(left: Float32Array, right: Float32Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function finalizeAtlas(candidates: GlyphCandidate[]): GlyphCandidate[] {
  const hashes = new Map<number, Float32Array[]>();
  const atlas: GlyphCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.ch !== ' ' && candidate.coverage <= 0.001) continue;
    const matches = hashes.get(candidate.hash) || [];
    if (matches.some((mask) => sameMask(mask, candidate.mask))) continue;
    matches.push(candidate.mask);
    hashes.set(candidate.hash, matches);
    atlas.push(candidate);
  }
  return atlas.sort((a, b) => a.coverage - b.coverage);
}

function rememberAtlas(key: string, atlas: GlyphCandidate[]): GlyphCandidate[] {
  glyphAtlasCache.delete(key);
  glyphAtlasCache.set(key, atlas);
  while (glyphAtlasCache.size > GLYPH_ATLAS_CACHE_LIMIT) {
    const oldest = glyphAtlasCache.keys().next().value;
    if (oldest !== undefined) glyphAtlasCache.delete(oldest);
  }
  return atlas;
}

function glyphAtlas(
  characters: readonly string[],
  width: number,
  height: number,
  fontFamily: string,
): GlyphCandidate[] {
  const key = atlasKey(characters, width, height, fontFamily);
  if (glyphAtlasCache.has(key)) return glyphAtlasCache.get(key)!;
  const ctx = atlasContext(width, height);
  const candidates = characters.map((ch) => glyphCandidate(ctx, ch, width, height, fontFamily));
  return rememberAtlas(key, finalizeAtlas(candidates));
}

function abortError() {
  if (typeof DOMException !== 'undefined') return new DOMException('Conversion canceled', 'AbortError');
  const error = new Error('Conversion canceled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function defaultYieldControl(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function glyphAtlasAsync(
  characters: readonly string[],
  width: number,
  height: number,
  fontFamily: string,
  job: ConversionJob,
): Promise<GlyphCandidate[]> {
  const key = atlasKey(characters, width, height, fontFamily);
  throwIfAborted(job.signal);
  if (glyphAtlasCache.has(key)) return glyphAtlasCache.get(key)!;
  const ctx = atlasContext(width, height);
  const candidates: GlyphCandidate[] = [];
  const batchGlyphs = Math.max(1, Math.round(job.batchGlyphs || 24));
  for (let index = 0; index < characters.length; index++) {
    candidates.push(glyphCandidate(ctx, characters[index]!, width, height, fontFamily));
    if ((index + 1) % batchGlyphs === 0 && index + 1 < characters.length) {
      await job.yieldControl();
      throwIfAborted(job.signal);
    }
  }
  throwIfAborted(job.signal);
  return rememberAtlas(key, finalizeAtlas(candidates));
}

function closestShapeCandidates(
  target: Float32Array,
  targetCoverage: number,
  atlas: GlyphCandidate[],
): GlyphCandidate[] {
  const targetSignature = maskSignature(target, atlas[0]!.width, atlas[0]!.height);
  const shortlist: Array<{ candidate: GlyphCandidate; score: number }> = [];
  for (const candidate of atlas) {
    let score = Math.abs(candidate.coverage - targetCoverage) * 0.08;
    for (let index = 0; index < targetSignature.length; index++) {
      const difference = targetSignature[index]! - candidate.signature[index]!;
      score += difference * difference;
    }
    let at = 0;
    while (at < shortlist.length && shortlist[at]!.score <= score) at++;
    if (at >= 12) continue;
    shortlist.splice(at, 0, { candidate, score });
    if (shortlist.length > 12) shortlist.pop();
  }
  return shortlist.map((entry) => entry.candidate);
}

function bestGlyph(target: Float32Array, atlas: GlyphCandidate[], densityOnly: boolean): GlyphCandidate {
  let targetCoverage = 0;
  for (const value of target) targetCoverage += value;
  targetCoverage /= target.length;
  if (densityOnly) {
    let low = 0;
    let high = atlas.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (atlas[middle]!.coverage < targetCoverage) low = middle + 1;
      else high = middle;
    }
    const upper = atlas[Math.min(low, atlas.length - 1)]!;
    const lower = atlas[Math.max(0, low - 1)]!;
    return Math.abs(lower.coverage - targetCoverage) <=
      Math.abs(upper.coverage - targetCoverage) ? lower : upper;
  }

  const candidates = closestShapeCandidates(target, targetCoverage, atlas);
  let best = candidates[0]!;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    let score = 0;
    for (let i = 0; i < target.length; i++) {
      const d = target[i]! - candidate.mask[i]!;
      score += d * d;
    }
    score /= target.length;
    score += Math.abs(candidate.coverage - targetCoverage) * 0.08;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function sampledCanvas(
  srcCanvas: CanvasImageSource,
  cols: number,
  rows: number,
  sampleW: number,
  sampleH: number,
): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = cols * sampleW;
  canvas.height = rows * sampleH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(srcCanvas, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function paletteSamples(data: Uint8ClampedArray, alphaThreshold: number): RgbaColor[] {
  const count = data.length / 4;
  const sampleCount = Math.min(12000, count);
  let step = Math.max(1, Math.floor(count * 0.61803398875));
  const gcd = (left: number, right: number): number => {
    while (right) [left, right] = [right, left % right];
    return left;
  };
  while (gcd(step, count) !== 1) step++;
  let pixel = Math.floor(count * 0.38196601125);
  const points: RgbaColor[] = [];
  for (let sample = 0; sample < sampleCount; sample++) {
    const i = pixel * 4;
    if (data[i + 3]! >= alphaThreshold) {
      points.push({ r: data[i]!, g: data[i + 1]!, b: data[i + 2]!, a: data[i + 3]! });
    }
    pixel = (pixel + step) % count;
  }
  return points;
}

function charactersFor(options: ConversionOptions, mode: ConversionMode): string[] {
  let source: string;
  if (options.charset === 'custom') source = options.characters || '';
  else if (mode === 'blocks') source = CHARACTER_SETS.blocks;
  else source = options.charset
    ? CHARACTER_SETS[options.charset]
    : CHARACTER_SETS.extended;
  return limitCharacters(
    source,
    options.glyphLimit || 64,
    mode !== 'blocks' && options.charset === 'unicodeArt',
  );
}

export function imageToLayerPair(
  srcCanvas: CanvasImageSource,
  options: ConversionOptions = {},
): ConversionResult {
  const state = prepareConversion(srcCanvas, options);
  const atlas = glyphAtlas(
    state.characters,
    state.sampleW,
    state.sampleH,
    options.fontFamily || 'monospace',
  );
  for (let cy = 0; cy < state.rows; cy++) {
    for (let cx = 0; cx < state.cols; cx++) convertCell(state, atlas, cx, cy);
  }
  return conversionResult(state, atlas);
}

function conversionState(
  options: ConversionOptions,
  image: ImageData,
  stats: ConversionStats,
  palette: RgbColor[],
  cols: number,
  rows: number,
  sampleW: number,
  sampleH: number,
): ConversionState {
  const alphaThreshold = options.alphaThreshold ?? 32;
  const mode = chooseConversionMode(stats, options.mode || 'auto');
  return {
    options,
    cols,
    rows,
    alphaThreshold,
    sampleW,
    sampleH,
    image,
    stats,
    mode,
    characters: charactersFor(options, mode),
    palette,
    foreground: {},
    background: {},
    shapeByAlpha: stats.transparentRatio > 0.005 && stats.uniqueColors <= 16,
    solidBackground: options.background === 'solid'
      ? (options.backgroundColor || '#000000')
      : null,
  };
}

function prepareConversion(srcCanvas: CanvasImageSource, options: ConversionOptions): ConversionState {
  const cols = options.cols || GRID_W;
  const rows = options.rows || GRID_H;
  const alphaThreshold = options.alphaThreshold ?? 32;
  const sampleW = options.sampleW || 8;
  const sampleH = options.sampleH || 16;
  const image = sampledCanvas(srcCanvas, cols, rows, sampleW, sampleH);
  const stats = analyzePixels(image.data, alphaThreshold);
  const palette = medianCutPalette(paletteSamples(image.data, alphaThreshold), options.colorLimit || 16);
  return conversionState(options, image, stats, palette, cols, rows, sampleW, sampleH);
}

async function analyzePixelsAsync(
  data: Uint8ClampedArray,
  alphaThreshold: number,
  job: ConversionJob,
): Promise<ConversionStats> {
  const colors = new Set<number>();
  let transparent = 0;
  let opaque = 0;
  const count = data.length / 4;
  for (let pixel = 0; pixel < count; pixel++) {
    const index = pixel * 4;
    if (data[index + 3]! < alphaThreshold) transparent++;
    else {
      opaque++;
      if (colors.size < 257) {
        colors.add(((data[index]! >> 4) << 8) |
          ((data[index + 1]! >> 4) << 4) |
          (data[index + 2]! >> 4));
      }
    }
    if ((pixel + 1) % job.batchPixels === 0 && pixel + 1 < count) {
      await job.yieldControl();
      throwIfAborted(job.signal);
    }
  }
  const total = transparent + opaque;
  return {
    uniqueColors: colors.size,
    transparentRatio: total ? transparent / total : 1,
    opaqueRatio: total ? opaque / total : 0,
  };
}

async function prepareConversionAsync(
  srcCanvas: CanvasImageSource,
  options: ConversionOptions,
  job: ConversionJob,
): Promise<ConversionState> {
  const cols = options.cols || GRID_W;
  const rows = options.rows || GRID_H;
  const alphaThreshold = options.alphaThreshold ?? 32;
  const sampleW = options.sampleW || 8;
  const sampleH = options.sampleH || 16;
  const image = sampledCanvas(srcCanvas, cols, rows, sampleW, sampleH);
  await job.yieldControl();
  throwIfAborted(job.signal);
  const stats = await analyzePixelsAsync(image.data, alphaThreshold, job);
  const palette = medianCutPalette(
    paletteSamples(image.data, alphaThreshold),
    options.colorLimit || 16,
  );
  throwIfAborted(job.signal);
  return conversionState(options, image, stats, palette, cols, rows, sampleW, sampleH);
}

function convertCell(
  state: ConversionState,
  atlas: GlyphCandidate[],
  cx: number,
  cy: number,
): void {
  const {
    alphaThreshold, background, foreground, image, mode, options, palette,
    sampleH, sampleW, shapeByAlpha, solidBackground,
  } = state;
  const points: RgbaColor[] = [];
  const target = new Float32Array(sampleW * sampleH);
  let opaque = 0;
  for (let py = 0; py < sampleH; py++) {
    for (let px = 0; px < sampleW; px++) {
      const sourceIndex = (((cy * sampleH + py) * image.width) + cx * sampleW + px) * 4;
      const point = {
        r: image.data[sourceIndex]!,
        g: image.data[sourceIndex + 1]!,
        b: image.data[sourceIndex + 2]!,
        a: image.data[sourceIndex + 3]!,
      };
      const index = py * sampleW + px;
      points.push(point);
      if (point.a >= alphaThreshold) opaque++;
      let value = shapeByAlpha
        ? point.a / 255
        : (1 - luminance(point.r, point.g, point.b) / 255) * (point.a / 255);
      if (options.invert) value = (point.a / 255) - value;
      target[index] = Math.max(0, Math.min(1, value));
    }
  }

  const key = cx + ',' + cy;
  if (solidBackground) background[key] = { c: '', fg: null, bg: solidBackground };
  if (!opaque) return;

  const match = bestGlyph(target, atlas, mode === 'density');
  const fgWeights = [...target];
  const bgWeights = fgWeights.map((value) => 1 - value);
  const average = averageColor(points, null, alphaThreshold);
  const fg = colorHex(averageColor(points, fgWeights, alphaThreshold) || average, palette);
  const bg = colorHex(averageColor(points, bgWeights, alphaThreshold) || average, palette);

  if (match.ch !== ' ' && match.coverage > 0.001 && fg) {
    foreground[key] = { c: match.ch, fg, bg: null };
  }
  if (options.background === 'source' && bg) {
    background[key] = { c: '', fg: null, bg };
  }
}

function conversionResult(state: ConversionState, atlas: GlyphCandidate[]): ConversionResult {
  return {
    foreground: state.foreground,
    background: state.background,
    meta: {
      mode: state.mode,
      uniqueColors: state.stats.uniqueColors,
      transparentRatio: state.stats.transparentRatio,
      palette: state.palette.map((color) => colorHex(color, [])),
      characters: atlas.map((candidate) => candidate.ch).join(''),
    },
  };
}

export function convertImage(
  srcCanvas: CanvasImageSource,
  mode: ConversionMode = 'auto',
  options: ConversionOptions = {},
): ConversionResult {
  return imageToLayerPair(srcCanvas, { ...options, mode });
}

export async function convertImageAsync(
  srcCanvas: CanvasImageSource,
  mode: ConversionMode = 'auto',
  options: ConversionOptions = {},
  jobOptions: ConversionJobOptions = {},
): Promise<ConversionResult> {
  const job: ConversionJob = {
    ...(jobOptions.signal ? { signal: jobOptions.signal } : {}),
    batchCells: Math.max(1, Math.round(jobOptions.batchCells || 24)),
    batchGlyphs: Math.max(1, Math.round(jobOptions.batchGlyphs || 24)),
    batchPixels: Math.max(1, Math.round(jobOptions.batchPixels || 65536)),
    yieldControl: jobOptions.yieldControl || defaultYieldControl,
  };
  throwIfAborted(job.signal);
  const state = await prepareConversionAsync(srcCanvas, { ...options, mode }, job);
  const atlas = await glyphAtlasAsync(
    state.characters,
    state.sampleW,
    state.sampleH,
    options.fontFamily || 'monospace',
    job,
  );
  let completedCells = 0;
  for (let cy = 0; cy < state.rows; cy++) {
    for (let cx = 0; cx < state.cols; cx++) {
      convertCell(state, atlas, cx, cy);
      completedCells++;
      if (completedCells % job.batchCells === 0 &&
        completedCells < state.cols * state.rows) {
        await job.yieldControl();
        throwIfAborted(job.signal);
      }
    }
  }
  throwIfAborted(job.signal);
  return conversionResult(state, atlas);
}

function previewEntries(
  cells: ConversionCellMap | ReadonlyMap<string, CellValue> | null | undefined,
): Iterable<[string, CellValue]> {
  return cells instanceof Map ? cells.entries() : Object.entries(cells || {});
}

export function drawConversionPreview(
  canvas: HTMLCanvasElement,
  pair: Partial<ConversionResult> | null | undefined,
  options: ConversionPreviewOptions = {},
): void {
  const cols = options.cols || GRID_W;
  const rows = options.rows || GRID_H;
  const cellWidth = options.cellWidth || 5;
  const cellHeight = options.cellHeight || 10;
  canvas.width = cols * cellWidth;
  canvas.height = rows * cellHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const backgroundEntries = [...previewEntries(pair?.background)];
  const foregroundEntries = [...previewEntries(pair?.foreground)];
  const occupied = new Set(foregroundEntries
    .filter(([, cell]) => !!(cell?.c || cell?.cont))
    .map(([key]) => key));
  ctx.font = Math.max(6, Math.floor(cellHeight * 0.85)) + 'px ' +
    (options.fontFamily || 'monospace');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const drawGlyphs = () => {
    for (const [key, cell] of foregroundEntries) {
      const [x, y] = key.split(',').map(Number);
      if (x! < 0 || y! < 0 || x! >= cols || y! >= rows || !cell?.c || !cell?.fg) continue;
      ctx.fillStyle = cell.fg;
      ctx.fillText(cell.c, x! * cellWidth + cellWidth / 2, y! * cellHeight + cellHeight / 2);
    }
  };
  composeGlyphCoverage(ctx, drawGlyphs, () => {
    for (let index = backgroundEntries.length - 1; index >= 0; index--) {
      const [key, cell] = backgroundEntries[index]!;
      const [x, y] = key.split(',').map(Number);
      if (x! < 0 || y! < 0 || x! >= cols || y! >= rows || !cell?.bg) continue;
      ctx.fillStyle = cell.bg;
      ctx.fillRect(x! * cellWidth, y! * cellHeight, cellWidth, cellHeight);
    }
  }, () => redrawCellBoundaryCoverage(
    ctx, cols, rows, cellWidth, cellHeight, 1, drawGlyphs, 0, 0,
    (column, row) => occupied.has(`${column - 1},${row}`) && occupied.has(`${column},${row}`),
    (column, row) => occupied.has(`${column},${row - 1}`) && occupied.has(`${column},${row}`),
  ));
}

export function loadImageToCanvas(file: Blob): Promise<HTMLCanvasElement> {
  return new Promise<HTMLCanvasElement>((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')!.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not load image'));
    };
    img.src = url;
  });
}
