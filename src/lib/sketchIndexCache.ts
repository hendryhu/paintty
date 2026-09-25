import { openPainttyDatabase, SKETCH_INDEX_STORE } from './browserDb.js';
import { isUnknownRecord, type DatabaseOpener } from './types/project-types.js';

export interface SketchFeatures {
  ink: number[] | Uint16Array;
  df: Float32Array;
  coverage: number;
  aspect: number;
}

export interface SketchCandidate {
  ch: string;
  f: SketchFeatures;
}

interface PackedSketchIndex {
  format: number;
  chars: string[];
  inkOffsets: Uint32Array;
  ink: Uint16Array;
  df: Uint8Array;
  coverage: Float32Array;
  aspect: Float32Array;
}

export const SKETCH_INDEX_ALGORITHM_VERSION = 'sketch-v2-n24-ink04';
export const GLYPH_CATALOG_VERSION = 'nerd-fonts-v3.2.1';
export const SKETCH_INDEX_CACHE_FORMAT = 3;
const SAMPLE_COUNT = 24 * 24;
const MAX_CANDIDATES = 20_000;
const DISTANCE_SCALE = 7;

function requestResult<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error || new Error('Sketch cache request failed.'));
  });
}

export function sketchIndexCacheId(fontKey: string): string {
  return `${SKETCH_INDEX_ALGORITHM_VERSION}:${GLYPH_CATALOG_VERSION}:${fontKey}`;
}

export function validCachedSketchCandidates(value: unknown): value is SketchCandidate[] {
  if (!Array.isArray(value) || value.length > MAX_CANDIDATES) return false;
  return value.every((candidate: unknown) => {
    if (!isUnknownRecord(candidate) || typeof candidate['ch'] !== 'string' || !candidate['ch'] ||
      !isUnknownRecord(candidate['f'])) return false;
    const feature = candidate['f'];
    const ink = feature['ink'];
    return (Array.isArray(ink) || ink instanceof Uint16Array) &&
      ink.every((index: number) => Number.isInteger(index) && index >= 0 && index < SAMPLE_COUNT) &&
      feature['df'] instanceof Float32Array && feature['df'].length === SAMPLE_COUNT &&
      Number.isFinite(feature['coverage']) && Number.isFinite(feature['aspect']);
  });
}

export function packSketchCandidates(candidates: unknown): PackedSketchIndex | null {
  if (!validCachedSketchCandidates(candidates)) return null;
  const count = candidates.length;
  const inkLength = candidates.reduce((total, candidate) => total + candidate.f.ink.length, 0);
  const inkOffsets = new Uint32Array(count + 1);
  const ink = new Uint16Array(inkLength);
  const df = new Uint8Array(count * SAMPLE_COUNT);
  const coverage = new Float32Array(count);
  const aspect = new Float32Array(count);
  const chars = new Array(count);
  let inkCursor = 0;
  candidates.forEach((candidate, index) => {
    chars[index] = candidate.ch;
    inkOffsets[index] = inkCursor;
    ink.set(candidate.f.ink, inkCursor);
    inkCursor += candidate.f.ink.length;
    const dfOffset = index * SAMPLE_COUNT;
    for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
      df[dfOffset + sample] = Math.min(255, Math.round(candidate.f.df[sample]! * DISTANCE_SCALE));
    }
    coverage[index] = candidate.f.coverage;
    aspect[index] = candidate.f.aspect;
  });
  inkOffsets[count] = inkCursor;
  return { format: SKETCH_INDEX_CACHE_FORMAT, chars, inkOffsets, ink, df, coverage, aspect };
}

export function unpackSketchCandidates(record: unknown): SketchCandidate[] | null {
  if (!isUnknownRecord(record)) return null;
  const chars = record['chars'];
  if (!Array.isArray(chars)) return null;
  const count = chars.length;
  const inkOffsets = record['inkOffsets'];
  const ink = record['ink'];
  const df = record['df'];
  const coverage = record['coverage'];
  const aspect = record['aspect'];
  if (record['format'] !== SKETCH_INDEX_CACHE_FORMAT || !Number.isInteger(count) ||
    count < 0 || count > MAX_CANDIDATES ||
    !(inkOffsets instanceof Uint32Array) || inkOffsets.length !== count + 1 ||
    !(ink instanceof Uint16Array) ||
    !(df instanceof Uint8Array) || df.length !== count * SAMPLE_COUNT ||
    !(coverage instanceof Float32Array) || coverage.length !== count ||
    !(aspect instanceof Float32Array) || aspect.length !== count ||
    inkOffsets[count] !== ink.length) return null;
  for (let index = 0; index < count; index++) {
    if (typeof chars[index] !== 'string' || !chars[index] ||
      inkOffsets[index]! > inkOffsets[index + 1]!) return null;
  }
  if (!ink.every((index) => index < SAMPLE_COUNT) ||
    !coverage.every(Number.isFinite) || !aspect.every(Number.isFinite)) return null;
  const decodedDf = new Float32Array(df.length);
  for (let index = 0; index < df.length; index++) decodedDf[index] = df[index]! / DISTANCE_SCALE;
  return (chars as string[]).map((ch, index) => ({
    ch,
    f: {
      ink: ink.subarray(inkOffsets[index]!, inkOffsets[index + 1]!),
      df: decodedDf.subarray(index * SAMPLE_COUNT, (index + 1) * SAMPLE_COUNT),
      coverage: coverage[index]!,
      aspect: aspect[index]!,
    },
  }));
}

export async function readSketchIndex(
  fontKey: string,
  openDatabase: DatabaseOpener = openPainttyDatabase,
): Promise<SketchCandidate[] | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(SKETCH_INDEX_STORE, 'readonly');
    const record = await requestResult(transaction.objectStore(SKETCH_INDEX_STORE)
      .get(sketchIndexCacheId(fontKey)));
    return unpackSketchCandidates(record);
  } finally {
    database.close();
  }
}

export async function writeSketchIndex(
  fontKey: string,
  candidates: unknown,
  openDatabase: DatabaseOpener = openPainttyDatabase,
): Promise<boolean> {
  const packed = packSketchCandidates(candidates);
  if (!packed) return false;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(SKETCH_INDEX_STORE, 'readwrite');
    await requestResult(transaction.objectStore(SKETCH_INDEX_STORE).put({
      id: sketchIndexCacheId(fontKey),
      ...packed,
    }));
    return true;
  } finally {
    database.close();
  }
}
