import { get } from 'svelte/store';
import { canvasFont } from './font.js';
import { nerdGlyphs } from './nerdglyphs.js';


const N = 24;
const INK = 0.4;
const FALLBACK_BATCH_SIZE = 32;

let scratch;
function ctx2d() {
  if (!scratch) { scratch = document.createElement('canvas'); scratch.width = N; scratch.height = N; }
  return scratch.getContext('2d', { willReadFrequently: true });
}
function rasterizeChar(ch) {
  const ctx = ctx2d();
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, N, N);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `${N - 4}px ${get(canvasFont)}`;
  ctx.fillText(ch, N / 2, N / 2 + 1);
  const d = ctx.getImageData(0, 0, N, N).data;
  const bmp = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) bmp[i] = d[i * 4] / 255;
  return bmp;
}

function inkBounds(bmp) {
  let minx = N, miny = N, maxx = -1, maxy = -1;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
    if (bmp[y * N + x] > INK) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  return maxx < 0 ? null : { minx, miny, maxx, maxy };
}
function normalize(bmp) {
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
    out[y * N + x] = bmp[sy * N + sx];
  }
  return out;
}
function distanceField(bmp) {
  const INF = 1e6, d = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) d[i] = bmp[i] > INK ? 0 : INF;
  const at = (x, y) => d[y * N + x];
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
function features(norm) {
  const ink = [];
  for (let i = 0; i < N * N; i++) if (norm[i] > INK) ink.push(i);
  const bounds = inkBounds(norm);
  const aspect = bounds
    ? (bounds.maxx - bounds.minx + 1) / Math.max(1, bounds.maxy - bounds.miny + 1)
    : 1;
  return { ink, df: distanceField(norm), coverage: ink.length / (N * N), aspect };
}
function chamfer(a, b) {
  let s = 0;
  for (const i of a.ink) s += b.df[i];
  let t = 0;
  for (const i of b.ink) t += a.df[i];
  return s / (a.ink.length || 1) + t / (b.ink.length || 1);
}

function candidateDistance(a, b) {
  const aspectPenalty = Math.abs(Math.log(Math.max(1 / N, a.aspect) / Math.max(1 / N, b.aspect)));
  const coveragePenalty = Math.abs(a.coverage - b.coverage);
  return chamfer(a, b) + aspectPenalty * 0.8 + coveragePenalty * 4;
}

function finiteStrokePoints(strokes) {
  return (Array.isArray(strokes) ? strokes : []).map((stroke) =>
    (Array.isArray(stroke) ? stroke : []).filter((point) =>
      point && Number.isFinite(point.x) && Number.isFinite(point.y)));
}

export function meaningfulSketchStrokes(strokes, minimumLength = 3) {
  let length = 0;
  for (const stroke of finiteStrokePoints(strokes)) {
    for (let index = 1; index < stroke.length; index++) {
      length += Math.hypot(
        stroke[index].x - stroke[index - 1].x,
        stroke[index].y - stroke[index - 1].y,
      );
    }
  }
  return length >= Math.max(0, Number(minimumLength) || 0);
}

function segmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  if (!denominator) return Math.hypot(point.x - start.x, point.y - start.y);
  const progress = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator));
  return Math.hypot(point.x - (start.x + dx * progress), point.y - (start.y + dy * progress));
}

export function rasterizeSketchStrokes(strokes, options = {}) {
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
      const start = { x: stroke[index - 1].x * scaleX, y: stroke[index - 1].y * scaleY };
      const end = { x: stroke[index].x * scaleX, y: stroke[index].y * scaleY };
      const left = Math.max(0, Math.floor(Math.min(start.x, end.x) - radius - 1));
      const right = Math.min(N - 1, Math.ceil(Math.max(start.x, end.x) + radius + 1));
      const top = Math.max(0, Math.floor(Math.min(start.y, end.y) - radius - 1));
      const bottom = Math.min(N - 1, Math.ceil(Math.max(start.y, end.y) + radius + 1));
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const distance = segmentDistance({ x: x + 0.5, y: y + 0.5 }, start, end);
          const coverage = Math.max(0, Math.min(1, radius + 0.75 - distance));
          const offset = y * N + x;
          if (coverage > bitmap[offset]) bitmap[offset] = coverage;
        }
      }
    }
  }
  return bitmap;
}

export function rankGlyphBitmaps(sketchBitmap, glyphs, k = 12) {
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

let candidates = [];
let candFont = null;
let building = false;
let buildPromise = Promise.resolve();
let activeBuild = null;
let buildGeneration = 0;

function idle(fn) {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(fn);
    return;
  }
  // The synthetic deadline never expires, so the batch cap guarantees a yield.
  setTimeout(() => fn({ timeRemaining: () => Infinity }, FALLBACK_BATCH_SIZE), 0);
}

export function buildCandidatesAsync() {
  const font = get(canvasFont);
  if (building && candFont === font) return buildPromise;
  if (!building && candFont === font && candidates.length) return Promise.resolve();
  activeBuild?.resolve();
  const generation = ++buildGeneration;
  const nextCandidates = [];
  let resolveBuild, rejectBuild;
  candFont = font;
  building = true;
  candidates = nextCandidates;
  buildPromise = new Promise((resolve, reject) => {
    resolveBuild = resolve;
    rejectBuild = reject;
  });
  activeBuild = { generation, resolve: resolveBuild };

  const chars = [];
  const ranges = [[0x21, 0x7E], [0x2500, 0x259F], [0x25A0, 0x25FF], [0x2190, 0x21FF], [0x2600, 0x26FF]];
  for (const [a, b] of ranges) for (let cp = a; cp <= b; cp++) chars.push(String.fromCodePoint(cp));
  for (const g of get(nerdGlyphs).all) chars.push(g.char);

  const tofuN = normalize(rasterizeChar('\u{10FFFF}'));
  const tofuFeat = tofuN ? features(tofuN) : null;

  const seen = new Set();
  let i = 0;
  const step = (deadline, maxItems = Infinity) => {
    if (activeBuild?.generation !== generation || candFont !== font) return;
    try {
      let processed = 0;
      while (i < chars.length && processed < maxItems && deadline.timeRemaining() > 3) {
        const ch = chars[i++];
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
        resolveBuild();
      }
    } catch (error) {
      building = false;
      activeBuild = null;
      candidates = [];
      candFont = null;
      rejectBuild(error);
    }
  };
  try {
    idle(step);
  } catch (error) {
    building = false;
    activeBuild = null;
    candidates = [];
    candFont = null;
    rejectBuild(error);
  }
  return buildPromise;
}

export function resetSketchCandidates() {
  activeBuild?.resolve();
  activeBuild = null;
  buildGeneration++;
  candidates = [];
  candFont = null;
  building = false;
  buildPromise = Promise.resolve();
}

export function bitmapFromCanvas(srcCanvas) {
  const ctx = ctx2d();
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, N, N);
  ctx.drawImage(srcCanvas, 0, 0, N, N);
  const d = ctx.getImageData(0, 0, N, N).data;
  const bmp = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) bmp[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / (3 * 255);
  return bmp;
}

export function matchGlyphs(sketchBmp, k = 12) {
  if (candFont !== get(canvasFont)) buildCandidatesAsync();
  const norm = normalize(sketchBmp);
  if (!norm) return [];
  const sketch = features(norm);
  if (sketch.ink.length < 4) return [];

  return candidates
    .map((c) => [c.ch, candidateDistance(sketch, c.f)])
    .sort((a, b) => a[1] - b[1])
    .slice(0, k)
    .map(([ch]) => ch);
}

export async function matchGlyphsAsync(sketchBmp, k = 12) {
  const font = get(canvasFont);
  await buildCandidatesAsync();
  if (font !== get(canvasFont)) return matchGlyphsAsync(sketchBmp, k);
  return matchGlyphs(sketchBmp, k);
}
