import { get } from 'svelte/store';
import { canvasFont, fontCacheKey } from './font.js';
import { nerdGlyphs } from './nerdglyphs.js';
import { readSketchIndex, writeSketchIndex } from './sketchIndexCache.js';
import type { SketchCandidate, SketchFeatures } from './sketchIndexCache.js';
import { isUnknownRecord, type Point } from './types/project-types.js';


const N = 24;
const INK = 0.4;
const FALLBACK_BATCH_SIZE = 32;

interface InkBounds {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
}

interface SketchRasterOptions {
  minimumLength?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  lineWidth?: number;
}

interface GlyphBitmapCandidate {
  ch: string;
  bitmap: Float32Array;
}

interface ActiveBuild {
  generation: number;
  resolve: () => void;
}

let scratch: HTMLCanvasElement | null = null;
function ctx2d(): CanvasRenderingContext2D {
  if (!scratch) { scratch = document.createElement('canvas'); scratch.width = N; scratch.height = N; }
  return scratch.getContext('2d', { willReadFrequently: true })!;
}
function rasterizeChar(ch: string): Float32Array {
  const ctx = ctx2d();
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, N, N);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `${N - 4}px ${get(canvasFont)}`;
  ctx.fillText(ch, N / 2, N / 2 + 1);
  const d = ctx.getImageData(0, 0, N, N).data;
  const bmp = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) bmp[i] = d[i * 4]! / 255;
  return bmp;
}

function inkBounds(bmp: Float32Array): InkBounds | null {
  let minx = N, miny = N, maxx = -1, maxy = -1;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
    if (bmp[y * N + x]! > INK) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  return maxx < 0 ? null : { minx, miny, maxx, maxy };
}
function normalize(bmp: Float32Array): Float32Array | null {
  const b = inkBounds(bmp);
  if (!b) return null;
  const bw = b.maxx - b.minx + 1, bh = b.maxy - b.miny + 1;
  const out = new Float32Array(N * N);
  const scale = (N - 4) / Math.max(bw, bh);
  const width = Math.max(1, bw * scale);
  const height = Math.max(1, bh * scale);
  const left = (N - width) / 2;
  const top = (N - height) / 2;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (x < left || x >= left + width || y < top || y >= top + height) continue;
    const sx = b.minx + Math.min(bw - 1, Math.floor((x - left) / scale));
    const sy = b.miny + Math.min(bh - 1, Math.floor((y - top) / scale));
    out[y * N + x] = bmp[sy * N + sx]!;
  }
  return out;
}
function distanceField(bmp: Float32Array): Float32Array {
  const INF = 1e6, d = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) d[i] = bmp[i]! > INK ? 0 : INF;
  const at = (x: number, y: number): number => d[y * N + x]!;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = at(x, y);
    if (x > 0) v = Math.min(v, at(x - 1, y) + 1);
    if (y > 0) v = Math.min(v, at(x, y - 1) + 1);
    if (x > 0 && y > 0) v = Math.min(v, at(x - 1, y - 1) + 1.4);
    if (x < N - 1 && y > 0) v = Math.min(v, at(x + 1, y - 1) + 1.4);
    d[y * N + x] = v;
  }
  for (let y = N - 1; y >= 0; y--) for (let x = N - 1; x >= 0; x--) {
    let v = at(x, y);
    if (x < N - 1) v = Math.min(v, at(x + 1, y) + 1);
    if (y < N - 1) v = Math.min(v, at(x, y + 1) + 1);
    if (x < N - 1 && y < N - 1) v = Math.min(v, at(x + 1, y + 1) + 1.4);
    if (x > 0 && y < N - 1) v = Math.min(v, at(x - 1, y + 1) + 1.4);
    d[y * N + x] = v;
  }
  return d;
}
function features(norm: Float32Array): SketchFeatures {
  const ink: number[] = [];
  for (let i = 0; i < N * N; i++) if (norm[i]! > INK) ink.push(i);
  const bounds = inkBounds(norm);
  const aspect = bounds
    ? (bounds.maxx - bounds.minx + 1) / Math.max(1, bounds.maxy - bounds.miny + 1)
    : 1;
  return { ink, df: distanceField(norm), coverage: ink.length / (N * N), aspect };
}
function chamfer(a: SketchFeatures, b: SketchFeatures): number {
  let s = 0;
  for (const i of a.ink) s += b.df[i]!;
  let t = 0;
  for (const i of b.ink) t += a.df[i]!;
  return s / (a.ink.length || 1) + t / (b.ink.length || 1);
}

function candidateDistance(a: SketchFeatures, b: SketchFeatures): number {
  const aspectPenalty = Math.abs(Math.log(Math.max(1 / N, a.aspect) / Math.max(1 / N, b.aspect)));
  const coveragePenalty = Math.abs(a.coverage - b.coverage);
  return chamfer(a, b) + aspectPenalty * 0.8 + coveragePenalty * 4;
}

function finiteStrokePoints(strokes: unknown): Point[][] {
  return (Array.isArray(strokes) ? strokes : []).map((stroke: unknown) =>
    (Array.isArray(stroke) ? stroke : []).filter((point: unknown): point is Point =>
      isUnknownRecord(point) && typeof point['x'] === 'number' && Number.isFinite(point['x']) &&
      typeof point['y'] === 'number' && Number.isFinite(point['y'])));
}

export function meaningfulSketchStrokes(strokes: unknown, minimumLength = 3): boolean {
  let length = 0;
  for (const stroke of finiteStrokePoints(strokes)) {
    for (let index = 1; index < stroke.length; index++) {
      length += Math.hypot(
        stroke[index]!.x - stroke[index - 1]!.x,
        stroke[index]!.y - stroke[index - 1]!.y,
      );
    }
  }
  return length >= Math.max(0, Number(minimumLength) || 0);
}

function segmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  if (!denominator) return Math.hypot(point.x - start.x, point.y - start.y);
  const progress = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator));
  return Math.hypot(point.x - (start.x + dx * progress), point.y - (start.y + dy * progress));
}

export function rasterizeSketchStrokes(
  strokes: unknown,
  options: SketchRasterOptions = {},
): Float32Array | null {
  if (!meaningfulSketchStrokes(strokes, options.minimumLength ?? 3)) return null;
  const sourceWidth = Math.max(1, Number(options.sourceWidth) || N);
  const sourceHeight = Math.max(1, Number(options.sourceHeight) || N);
  const scaleX = N / sourceWidth;
  const scaleY = N / sourceHeight;
  const radius = Math.max(0.7,
    (Math.max(1, Number(options.lineWidth) || 1) * Math.sqrt(scaleX * scaleY)) / 2);
  const bitmap = new Float32Array(N * N);
  for (const stroke of finiteStrokePoints(strokes)) {
    for (let index = 1; index < stroke.length; index++) {
      const start = { x: stroke[index - 1]!.x * scaleX, y: stroke[index - 1]!.y * scaleY };
      const end = { x: stroke[index]!.x * scaleX, y: stroke[index]!.y * scaleY };
      const left = Math.max(0, Math.floor(Math.min(start.x, end.x) - radius - 1));
      const right = Math.min(N - 1, Math.ceil(Math.max(start.x, end.x) + radius + 1));
      const top = Math.max(0, Math.floor(Math.min(start.y, end.y) - radius - 1));
      const bottom = Math.min(N - 1, Math.ceil(Math.max(start.y, end.y) + radius + 1));
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const distance = segmentDistance({ x: x + 0.5, y: y + 0.5 }, start, end);
          const coverage = Math.max(0, Math.min(1, radius + 0.75 - distance));
          const offset = y * N + x;
          if (coverage > bitmap[offset]!) bitmap[offset] = coverage;
        }
      }
    }
  }
  return bitmap;
}

export function rankGlyphBitmaps(
  sketchBitmap: Float32Array,
  glyphs: readonly GlyphBitmapCandidate[],
  k = 12,
): string[] {
  const normalizedSketch = normalize(sketchBitmap);
  if (!normalizedSketch) return [];
  const sketch = features(normalizedSketch);
  if (sketch.ink.length < 4) return [];
  return (glyphs || []).flatMap((candidate, index) => {
    const normalized = normalize(candidate?.bitmap);
    return normalized ? [{ ch: candidate.ch, index, feature: features(normalized) }] : [];
  }).map((candidate) => ({
    ...candidate,
    distance: candidateDistance(sketch, candidate.feature),
  })).sort((left, right) => left.distance - right.distance || left.index - right.index)
    .slice(0, Math.max(0, Math.floor(k)))
    .map((candidate) => candidate.ch);
}

let candidates: SketchCandidate[] = [];
let candFont: string | null = null;
let candFontKey: string | null = null;
let building = false;
let buildPromise = Promise.resolve();
let activeBuild: ActiveBuild | null = null;
let buildGeneration = 0;

function idle(fn: (deadline: IdleDeadline, maxItems?: number) => void): void {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(fn);
    return;
  }
  // The synthetic deadline never expires, so the batch cap guarantees a yield.
  setTimeout(() => fn({ didTimeout: false, timeRemaining: () => Infinity }, FALLBACK_BATCH_SIZE), 0);
}

export function buildCandidatesAsync(): Promise<void> {
  const font = get(canvasFont);
  const fontKey = get(fontCacheKey);
  if (building && candFont === font && candFontKey === fontKey) return buildPromise;
  if (!building && candFont === font && candFontKey === fontKey && candidates.length) {
    return Promise.resolve();
  }
  activeBuild?.resolve();
  const generation = ++buildGeneration;
  const nextCandidates: SketchCandidate[] = [];
  let resolveBuild!: () => void;
  let rejectBuild!: (error: unknown) => void;
  candFont = font;
  candFontKey = fontKey;
  building = true;
  candidates = nextCandidates;
  buildPromise = new Promise((resolve, reject) => {
    resolveBuild = resolve;
    rejectBuild = reject;
  });
  activeBuild = { generation, resolve: resolveBuild };

  let chars: string[] = [];
  let tofuFeat: SketchFeatures | null = null;
  let seen = new Set<string>();
  let i = 0;
  const step = (deadline: IdleDeadline, maxItems = Infinity): void => {
    if (activeBuild?.generation !== generation || candFont !== font) return;
    try {
      let processed = 0;
      while (i < chars.length && processed < maxItems && deadline.timeRemaining() > 3) {
        const ch = chars[i++]!;
        processed++;
        if (seen.has(ch)) continue;
        seen.add(ch);
        const norm = normalize(rasterizeChar(ch));
        if (!norm) continue;
        const f = features(norm);
        if (tofuFeat && candidateDistance(f, tofuFeat) < 0.6) continue;
        nextCandidates.push({ ch, f });
      }
      if (i < chars.length) {
        idle(step);
      } else {
        building = false;
        activeBuild = null;
        writeSketchIndex(fontKey, nextCandidates).catch(() => false).finally(resolveBuild);
      }
    } catch (error) {
      building = false;
      activeBuild = null;
      candidates = [];
      candFont = null;
      rejectBuild(error);
    }
  };

  const startBuild = (): void => {
    if (activeBuild?.generation !== generation || candFont !== font || candFontKey !== fontKey) return;
    chars = [];
    const ranges: Array<readonly [number, number]> = [[0x21, 0x7E], [0x2500, 0x259F], [0x25A0, 0x25FF], [0x2190, 0x21FF], [0x2600, 0x26FF]];
    for (const [a, b] of ranges) for (let cp = a; cp <= b; cp++) chars.push(String.fromCodePoint(cp));
    for (const glyph of get(nerdGlyphs).all) chars.push(glyph.char);
    const tofuN = normalize(rasterizeChar('\u{10FFFF}'));
    tofuFeat = tofuN ? features(tofuN) : null;
    seen = new Set();
    i = 0;
    try {
      idle(step);
    } catch (error) {
      building = false;
      activeBuild = null;
      candidates = [];
      candFont = null;
      candFontKey = null;
      rejectBuild(error);
    }
  };

  readSketchIndex(fontKey).then((cached) => {
    if (activeBuild?.generation !== generation || candFont !== font || candFontKey !== fontKey) return;
    if (!cached) {
      startBuild();
      return;
    }
    candidates = cached;
    building = false;
    activeBuild = null;
    resolveBuild();
  }).catch(startBuild);
  return buildPromise;
}

export function resetSketchCandidates(): void {
  activeBuild?.resolve();
  activeBuild = null;
  buildGeneration++;
  candidates = [];
  candFont = null;
  candFontKey = null;
  building = false;
  buildPromise = Promise.resolve();
}

export function bitmapFromCanvas(srcCanvas: CanvasImageSource): Float32Array {
  const ctx = ctx2d();
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, N, N);
  ctx.drawImage(srcCanvas, 0, 0, N, N);
  const d = ctx.getImageData(0, 0, N, N).data;
  const bmp = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) bmp[i] = (d[i * 4]! + d[i * 4 + 1]! + d[i * 4 + 2]!) / (3 * 255);
  return bmp;
}

export function matchGlyphs(sketchBmp: Float32Array, k = 12): string[] {
  if (candFont !== get(canvasFont)) buildCandidatesAsync();
  const norm = normalize(sketchBmp);
  if (!norm) return [];
  const sketch = features(norm);
  if (sketch.ink.length < 4) return [];

  return candidates
    .map((c): [string, number] => [c.ch, candidateDistance(sketch, c.f)])
    .sort((a, b) => a[1] - b[1])
    .slice(0, k)
    .map(([ch]) => ch);
}

export async function matchGlyphsAsync(sketchBmp: Float32Array, k = 12): Promise<string[]> {
  const font = get(canvasFont);
  await buildCandidatesAsync();
  if (font !== get(canvasFont)) return matchGlyphsAsync(sketchBmp, k);
  return matchGlyphs(sketchBmp, k);
}
