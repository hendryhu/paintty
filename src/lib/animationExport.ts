import { AsyncZipDeflate, strToU8, Zip, ZipPassThrough } from 'fflate';
import {
  AUDIO_EXPORT_CHANNELS,
  AUDIO_EXPORT_SAMPLE_RATE,
  WAV_EXPORT_MIME,
} from './audioExport.js';
import { runtimeTimelineTags } from './timelineTags.js';
import { isUnknownRecord, type Point, type UnknownRecord } from './types/project-types.js';

interface AnimationVisualResources {
  frameCount: number;
  columns: number;
  rows: number;
  cellEntries: number;
  layerEntries: number;
  stringBytes: number;
  baseBytes: number;
  estimatedBytes: number;
}

interface AnimationCell {
  x: number;
  y: number;
  glyph: string | null;
  foreground: unknown;
  background: unknown;
  width: number;
  blink?: boolean;
}

interface RuntimeAnimationFrame {
  hold: number;
  layers: Array<{ layerId: number; cells: AnimationCell[] }>;
  composite: AnimationCell[];
}

interface AnimationCanvas {
  columns: number;
  rows: number;
}

interface AnimationLayer {
  id: number;
  name: string;
  order: number;
}

export interface AnimationExportPlan {
  kind: 'json' | 'zip';
  filename: string;
  jsonFilename: string;
  audioPath: string | null;
  mime: string;
  description: string;
  entries: string[];
  includeAudio: boolean;
  audibleAudioCount: number;
  buttonLabel: string;
}

interface AnimationDocument extends UnknownRecord {
  format: string;
  version: number;
  canvas: AnimationCanvas;
  timebase: { ticksPerSecond: number };
  tags: unknown[];
  layers: AnimationLayer[];
  frames: RuntimeAnimationFrame[];
  audio?: UnknownRecord;
}

interface AnimationSourceLayer {
  id?: string | number;
  layerId?: string | number;
  name?: unknown;
  type?: unknown;
  cells?: unknown;
  offset?: Partial<Point> | null | undefined;
  groupId?: string | number | null | undefined;
  visible?: boolean;
  effect?: unknown;
  shape?: unknown;
}

interface AnimationSourceFrame {
  hold?: unknown;
  layers?: AnimationSourceLayer[] | undefined;
  layerCells?: unknown;
  compositeCells?: unknown;
  composite?: unknown;
}

interface LayerMetadata {
  authorId: string | number;
  key: string;
  sourceIndex: number;
  source: AnimationSourceLayer;
  index: number;
  output: AnimationLayer;
}

interface AnimationAssemblerOptions extends UnknownRecord {
  dimensions?: UnknownRecord;
  canvas?: UnknownRecord;
  width?: unknown;
  height?: unknown;
  fps?: unknown;
  timebase?: UnknownRecord;
  frames?: AnimationSourceFrame[];
  layerMetadata?: AnimationSourceLayer[];
  layers?: AnimationSourceLayer[];
  layerCells?: unknown;
  compositeCells?: unknown;
  tags?: unknown;
  exportPlan?: AnimationExportPlan;
  plan?: AnimationExportPlan;
  audio?: UnknownRecord | null;
  fileName?: unknown;
}

interface AnimationExportPlanOptions {
  fileName?: unknown;
  hasAudio?: boolean;
  audioBytes?: unknown;
  audio?: unknown;
  includeAudio?: boolean;
  audioCount?: number;
}

interface AnimationZipOptions {
  plan?: AnimationExportPlan;
  document?: AnimationDocument;
  json?: string;
  audioBytes?: unknown;
  output?: 'blob' | 'uint8array';
  signal?: AbortSignal;
  yieldControl?: () => void | Promise<void>;
  ZipClass?: typeof Zip;
  AsyncZipDeflateClass?: typeof AsyncZipDeflate;
  ZipPassThroughClass?: typeof ZipPassThrough;
}

export const ANIMATION_FORMAT = 'paintty-animation';
export const ANIMATION_VERSION = 1;
export const ANIMATION_VISUAL_MAX_FRAMES = 20_000;
export const ANIMATION_VISUAL_MAX_DIMENSION = 256;
export const ANIMATION_VISUAL_MAX_CELL_ENTRIES = 500_000;
export const ANIMATION_VISUAL_MAX_ESTIMATED_BYTES = 128 * 1024 * 1024;

const REFERENCE_LAYER_TYPES = new Set(['image', 'video']);
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MIXED_AUDIO_PATH = 'audio.wav';
const ZIP_CHUNK_BYTES = 1024 * 1024;
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0);
const VISUAL_FRAME_BYTES = 256;
const VISUAL_CELL_BYTES = 192;
const VISUAL_LAYER_ENTRY_BYTES = 128;
const VISUAL_GRID_SLOT_BYTES = 8;
const VISUAL_STATIC_JSON_BYTES = 4096;

function visualLimitError(message: string): RangeError & { code: string } {
  const error = new RangeError(message) as RangeError & { code: string };
  error.code = 'ANIMATION_VISUAL_RESOURCE_LIMIT';
  return error;
}

function checkedVisualInteger(value: unknown, label: string, minimum = 0): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw visualLimitError(`${label} cannot be represented safely for Animation export.`);
  }
  return number;
}

function checkedVisualMultiply(label: string, ...values: unknown[]): number {
  let result = 1;
  for (const value of values) {
    result *= checkedVisualInteger(value, label);
    if (!Number.isSafeInteger(result)) {
      throw visualLimitError(`${label} cannot be represented safely for Animation export.`);
    }
  }
  return result;
}

function checkedVisualAdd(label: string, ...values: unknown[]): number {
  let result = 0;
  for (const value of values) {
    result += checkedVisualInteger(value, label);
    if (!Number.isSafeInteger(result)) {
      throw visualLimitError(`${label} cannot be represented safely for Animation export.`);
    }
  }
  return result;
}

function assertVisualBytes(estimatedBytes: number): void {
  if (estimatedBytes > ANIMATION_VISUAL_MAX_ESTIMATED_BYTES) {
    throw visualLimitError(
      'Animation visuals exceed the 128 MiB safe object/JSON estimate. ' +
      'Shorten the sequence, reduce the canvas, or remove dense cells.',
    );
  }
}

export function estimateAnimationVisualExportResources({
  frameCount,
  columns,
  rows,
}: {
  frameCount?: unknown;
  columns?: unknown;
  rows?: unknown;
} = {}): AnimationVisualResources {
  const frames = checkedVisualInteger(frameCount, 'Animation frame count', 1);
  const width = checkedVisualInteger(columns, 'Animation canvas width', 1);
  const height = checkedVisualInteger(rows, 'Animation canvas height', 1);
  if (frames > ANIMATION_VISUAL_MAX_FRAMES) {
    throw visualLimitError(
      `Animation export exceeds the ${ANIMATION_VISUAL_MAX_FRAMES.toLocaleString('en-US')}-frame ` +
      'visual limit. Shorten the sequence or reduce long holds.',
    );
  }
  if (width > ANIMATION_VISUAL_MAX_DIMENSION || height > ANIMATION_VISUAL_MAX_DIMENSION) {
    throw visualLimitError(
      `Animation canvas exceeds the ${ANIMATION_VISUAL_MAX_DIMENSION}x` +
      `${ANIMATION_VISUAL_MAX_DIMENSION} visual export limit.`,
    );
  }
  const workingGridBytes = checkedVisualMultiply(
    'Animation composite working grid',
    width,
    height,
    VISUAL_GRID_SLOT_BYTES,
  );
  const frameBytes = checkedVisualMultiply('Animation frame metadata', frames, VISUAL_FRAME_BYTES);
  const baseBytes = checkedVisualAdd(
    'Animation base visual estimate',
    VISUAL_STATIC_JSON_BYTES,
    workingGridBytes,
    frameBytes,
  );
  assertVisualBytes(baseBytes);
  return {
    frameCount: frames,
    columns: width,
    rows: height,
    cellEntries: 0,
    layerEntries: 0,
    stringBytes: 0,
    baseBytes,
    estimatedBytes: baseBytes,
  };
}

function runtimeFrameCounts(frame: Partial<RuntimeAnimationFrame> | null | undefined) {
  const layerEntries = Array.isArray(frame?.layers) ? frame.layers.length : 0;
  let cellEntries = Array.isArray(frame?.composite) ? frame.composite.length : 0;
  let stringBytes = 0;
  const countCells = (cells: AnimationCell[] | null | undefined): void => {
    for (const cell of cells || []) {
      cellEntries++;
      for (const value of [cell?.glyph, cell?.foreground, cell?.background]) {
        if (typeof value === 'string') {
          stringBytes = checkedVisualAdd(
            'Animation cell text estimate',
            stringBytes,
            checkedVisualMultiply('Animation cell text estimate', value.length, 3),
          );
        }
      }
    }
  };
  for (const layer of frame?.layers || []) countCells(layer?.cells);
  for (const cell of frame?.composite || []) {
    for (const value of [cell?.glyph, cell?.foreground, cell?.background]) {
      if (typeof value === 'string') {
        stringBytes = checkedVisualAdd(
          'Animation composite text estimate',
          stringBytes,
          checkedVisualMultiply('Animation composite text estimate', value.length, 3),
        );
      }
    }
  }
  return { cellEntries, layerEntries, stringBytes };
}

export function accountAnimationVisualFrame(
  resources: AnimationVisualResources,
  frame: Partial<RuntimeAnimationFrame>,
): AnimationVisualResources {
  const counts = runtimeFrameCounts(frame);
  const cellEntries = checkedVisualAdd(
    'Animation resolved cell entries',
    resources?.cellEntries ?? 0,
    counts.cellEntries,
  );
  if (cellEntries > ANIMATION_VISUAL_MAX_CELL_ENTRIES) {
    throw visualLimitError(
      `Animation export exceeds the ${ANIMATION_VISUAL_MAX_CELL_ENTRIES.toLocaleString('en-US')} ` +
      'resolved-cell limit. Shorten the sequence or remove dense cells.',
    );
  }
  const layerEntries = checkedVisualAdd(
    'Animation resolved layer entries',
    resources?.layerEntries ?? 0,
    counts.layerEntries,
  );
  const stringBytes = checkedVisualAdd(
    'Animation resolved text estimate',
    resources?.stringBytes ?? 0,
    counts.stringBytes,
  );
  const estimatedBytes = checkedVisualAdd(
    'Animation visual object/JSON estimate',
    resources?.baseBytes ?? 0,
    checkedVisualMultiply('Animation cell object estimate', cellEntries, VISUAL_CELL_BYTES),
    checkedVisualMultiply('Animation layer object estimate', layerEntries, VISUAL_LAYER_ENTRY_BYTES),
    stringBytes,
  );
  assertVisualBytes(estimatedBytes);
  return { ...resources, cellEntries, layerEntries, stringBytes, estimatedBytes };
}

export function validateAnimationVisualJsonResources(
  resources: AnimationVisualResources,
  {
    layers = [],
    tags = [],
  }: {
    layers?: Array<{ name?: unknown }>;
    tags?: Array<{ value?: unknown }>;
  } = {},
): AnimationVisualResources {
  let metadataBytes = 0;
  for (const value of [
    ...layers.map((layer) => layer?.name),
    ...tags.map((tag) => tag?.value),
  ]) {
    if (typeof value !== 'string') continue;
    metadataBytes = checkedVisualAdd(
      'Animation metadata text estimate',
      metadataBytes,
      checkedVisualMultiply('Animation metadata text estimate', value.length, 3),
    );
  }
  const estimatedBytes = checkedVisualAdd(
    'Animation final JSON estimate',
    resources?.estimatedBytes ?? 0,
    metadataBytes,
  );
  assertVisualBytes(estimatedBytes);
  return { ...resources, estimatedBytes };
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  if (typeof DOMException === 'function') {
    return new DOMException('Animation export cancelled.', 'AbortError');
  }
  const error = new Error('Animation export cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortable<T>(promise: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  const pending = Promise.resolve(promise);
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = <V>(callback: (value: V) => void, value: V): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      callback(value);
    };
    const cancel = () => finish(reject, abortError(signal));
    signal.addEventListener('abort', cancel, { once: true });
    pending.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) cancel();
  });
}

function defaultYield(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function pathLeaf(value: unknown): string {
  const parts = String(value ?? '').replace(/\\/g, '/').split('/');
  return (parts[parts.length - 1] || '').trim();
}

function splitExtension(name: string): { stem: string; extension: string } {
  const index = name.lastIndexOf('.');
  return index > 0
    ? { stem: name.slice(0, index), extension: name.slice(index) }
    : { stem: name, extension: '' };
}

function safeLeafName(value: unknown, fallback: string): string {
  let name = pathLeaf(value)
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  let { stem, extension } = splitExtension(name);
  stem = stem.replace(/^[-. ]+|[-. ]+$/g, '');
  extension = extension.replace(/[-. ]+$/g, '');
  if (!stem) {
    name = fallback;
    ({ stem, extension } = splitExtension(name));
  } else {
    name = `${stem}${extension}`;
  }
  const firstDot = name.indexOf('.');
  const firstStem = firstDot < 0 ? name : name.slice(0, firstDot);
  if (WINDOWS_RESERVED_NAME.test(firstStem)) {
    name = `${firstStem}-file${firstDot < 0 ? '' : name.slice(firstDot)}`;
  }
  if (name.length > 180) {
    ({ stem, extension } = splitExtension(name));
    name = `${stem.slice(0, Math.max(1, 180 - extension.length))}${extension}`;
  }
  return name || fallback;
}

export function animationExportBaseName(fileName: unknown): string {
  let name = pathLeaf(fileName);
  while (/\.(?:json|paintty|zip)$/i.test(name)) {
    name = name.replace(/\.(?:json|paintty|zip)$/i, '');
  }
  return safeLeafName(name, 'untitled');
}

export function planAnimationExport(
  options: AnimationExportPlanOptions = {},
): AnimationExportPlan {
  const baseName = animationExportBaseName(options.fileName);
  const hasAudio = options.hasAudio === true || options.audioBytes != null || options.audio != null;
  const includeAudio = !!options.includeAudio && hasAudio;
  const zipOutput = includeAudio;
  const jsonFilename = `${baseName}.json`;
  const filename = `${baseName}.${zipOutput ? 'zip' : 'json'}`;
  return {
    kind: zipOutput ? 'zip' : 'json',
    filename,
    jsonFilename,
    audioPath: includeAudio ? MIXED_AUDIO_PATH : null,
    mime: zipOutput ? 'application/zip' : 'application/json',
    description: zipOutput ? 'Paintty Animation ZIP' : 'Paintty Animation JSON',
    entries: includeAudio ? [jsonFilename, MIXED_AUDIO_PATH] : [jsonFilename],
    includeAudio,
    audibleAudioCount: includeAudio ? Math.max(1, Math.round(Number(options.audioCount)) || 1) : 0,
    buttonLabel: zipOutput ? 'Export ZIP' : 'Export Animation JSON',
  };
}

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return number;
}

function dimensionsOf(options: AnimationAssemblerOptions): AnimationCanvas {
  const source = options.dimensions || options.canvas || {};
  return {
    columns: positiveInteger(
      source['columns'] ?? source['w'] ?? source['width'] ?? options.width,
      'Animation width',
    ),
    rows: positiveInteger(
      source['rows'] ?? source['h'] ?? source['height'] ?? options.height,
      'Animation height',
    ),
  };
}

function layerId(layer: AnimationSourceLayer | null | undefined): string | number {
  const id = layer?.layerId ?? layer?.id;
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).length) {
    throw new Error('Animation source layer requires an authoring ID.');
  }
  return id;
}

function layerKey(id: unknown): string {
  return String(id);
}

function isReferenceLayer(layer: unknown): boolean {
  return isUnknownRecord(layer) &&
    REFERENCE_LAYER_TYPES.has(String(layer['type'] || '').toLowerCase());
}

function isNonEmittingLayer(layer: unknown): boolean {
  if (!isUnknownRecord(layer)) return false;
  if (String(layer['type'] || '').toLowerCase() === 'effect') return true;
  const shape = isUnknownRecord(layer['shape']) ? layer['shape'] : null;
  return String(layer['type'] || '').toLowerCase() === 'shape' &&
    shape?.['channel'] === 'color-clip';
}

function normalizeLayerMetadata(
  source: AnimationSourceLayer[] | undefined,
  frames: AnimationSourceFrame[],
): LayerMetadata[] {
  const values = Array.isArray(source)
    ? source
    : Array.isArray(frames[0]?.layers) ? frames[0].layers : [];
  const seen = new Set<string>();
  const eligible = values.flatMap((layer, sourceIndex) => {
    if (!layer || typeof layer !== 'object' || isReferenceLayer(layer) || isNonEmittingLayer(layer)) return [];
    const id = layerId(layer);
    const key = layerKey(id);
    if (seen.has(key)) throw new Error(`Duplicate animation layer ID: ${key}`);
    seen.add(key);
    return [{
      authorId: id,
      key,
      sourceIndex,
      source: layer,
    }];
  });
  // Authoring layers are front-to-back; runtime IDs must be dense back-to-front.
  eligible.reverse();
  return eligible.map((layer, index) => ({
    ...layer,
    index,
    output: {
      id: index,
      name: String(layer.source.name ?? `Layer ${index + 1}`),
      order: index,
    },
  }));
}

function looksLikeFlatCellList(value: unknown): value is Array<UnknownRecord | null> {
  if (!Array.isArray(value)) return false;
  const first = value.find((entry) => entry != null);
  return first == null || (
    !Array.isArray(first) && typeof first === 'object' &&
    isUnknownRecord(first) && Number.isFinite(Number(first['x'])) && Number.isFinite(Number(first['y']))
  );
}

function looksLikeGrid(value: unknown): value is unknown[][] {
  if (!Array.isArray(value) || looksLikeFlatCellList(value)) return false;
  const firstRow = value.find((row) => Array.isArray(row));
  if (!firstRow) return value.length === 0;
  return !firstRow.some((cell) => Array.isArray(cell));
}

function normalizeCell(
  cell: UnknownRecord | null | undefined,
  x: number,
  y: number,
  wide: boolean,
): AnimationCell | null {
  if (!cell || cell['cont']) return null;
  const glyphValue = Object.prototype.hasOwnProperty.call(cell, 'glyph')
    ? cell['glyph']
    : cell['c'];
  const glyph = typeof glyphValue === 'string' && glyphValue.length ? glyphValue : null;
  const foreground = cell['foreground'] ?? cell['fg'] ?? null;
  const background = cell['background'] ?? cell['bg'] ?? null;
  if (!glyph && !background) return null;
  const output: AnimationCell = {
    x,
    y,
    glyph,
    foreground: glyph ? foreground : null,
    background,
    width: glyph && (cell['width'] === 2 || wide) ? 2 : 1,
  };
  if (cell['blink']) output.blink = true;
  return output;
}

function inCanvas(x: number, y: number, columns: number, rows: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) &&
    x >= 0 && y >= 0 && x < columns && y < rows;
}

function cellsToRecords(
  cells: unknown,
  columns: number,
  rows: number,
  offset: Partial<Point> = { x: 0, y: 0 },
): AnimationCell[] {
  if (cells == null) return [];
  const dx = Math.round(Number(offset?.x) || 0);
  const dy = Math.round(Number(offset?.y) || 0);
  const output: AnimationCell[] = [];
  if (looksLikeFlatCellList(cells)) {
    for (const cell of cells) {
      if (!cell) continue;
      const x = Math.round(Number(cell['x'])) + dx;
      const y = Math.round(Number(cell['y'])) + dy;
      if (!inCanvas(x, y, columns, rows)) continue;
      const normalized = normalizeCell(cell, x, y, cell['width'] === 2);
      if (normalized) output.push(normalized);
    }
  } else if (looksLikeGrid(cells)) {
    for (let y = 0; y < Math.min(rows, cells.length); y++) {
      const rowValue = cells[y];
      const row: unknown[] = Array.isArray(rowValue) ? rowValue : [];
      for (let x = 0; x < Math.min(columns, row.length); x++) {
        const cellValue = row[x];
        const nextValue = row[x + 1];
        const cell = isUnknownRecord(cellValue) ? cellValue : null;
        const next = isUnknownRecord(nextValue) ? nextValue : null;
        const normalized = normalizeCell(cell, x, y, !!next?.['cont']);
        if (normalized) output.push(normalized);
      }
    }
  } else {
    const entries: Array<[unknown, unknown]> = cells instanceof Map
      ? [...cells.entries()]
      : isUnknownRecord(cells) ? Object.entries(cells) : [];
    const byKey = new Map<unknown, unknown>(entries);
    for (const [key, cell] of entries) {
      const match = /^(-?\d+),(-?\d+)$/.exec(String(key));
      if (!match || !cell) continue;
      const sourceX = Number(match[1]);
      const sourceY = Number(match[2]);
      const x = sourceX + dx;
      const y = sourceY + dy;
      if (!inCanvas(x, y, columns, rows)) continue;
      const next = byKey.get(`${sourceX + 1},${sourceY}`);
      const normalized = normalizeCell(
        isUnknownRecord(cell) ? cell : null,
        x,
        y,
        isUnknownRecord(next) && !!next['cont'],
      );
      if (normalized) output.push(normalized);
    }
  }
  output.sort((first, second) => first.y - second.y || first.x - second.x);
  return output;
}

function valueForLayer(container: unknown, metadata: LayerMetadata): unknown {
  if (container == null) return null;
  if (container instanceof Map) {
    return container.get(metadata.authorId) ?? container.get(metadata.key) ?? null;
  }
  if (Array.isArray(container)) {
    const identified = container.find((value: unknown) =>
      isUnknownRecord(value) &&
      layerKey(layerId(value as AnimationSourceLayer)) === metadata.key);
    return identified ?? null;
  }
  if (isUnknownRecord(container)) {
    return Object.prototype.hasOwnProperty.call(container, metadata.key)
      ? container[metadata.key]
      : null;
  }
  return null;
}

function frameIndexedValue(source: unknown, index: number, frameCount: number): unknown {
  if (source == null) return null;
  if (source instanceof Map) return source.get(index) ?? source.get(String(index)) ?? null;
  if (Array.isArray(source)) {
    if (frameCount === 1 && (looksLikeGrid(source) || looksLikeFlatCellList(source))) return source;
    return source[index] ?? null;
  }
  if (isUnknownRecord(source)) return source[String(index)] ?? null;
  return null;
}

function frameLayerSource(
  options: AnimationAssemblerOptions,
  frame: AnimationSourceFrame,
  frameIndex: number,
  metadata: LayerMetadata,
  frameCount: number,
): unknown {
  if (typeof options.layerCells === 'function') {
    return options.layerCells(frame, frameIndex, metadata.source, metadata.sourceIndex);
  }
  const supplied = frameIndexedValue(options.layerCells, frameIndex, frameCount);
  return valueForLayer(supplied, metadata) ??
    valueForLayer(frame?.layerCells, metadata) ??
    valueForLayer(frame?.layers, metadata);
}

function layerOffset(
  source: AnimationSourceLayer,
  frame: AnimationSourceFrame,
): Point | null {
  const offset = { x: Number(source.offset?.x) || 0, y: Number(source.offset?.y) || 0 };
  const groupId = source.groupId;
  if (groupId == null || !Array.isArray(frame?.layers)) return offset;
  const group = frame.layers.find((candidate) =>
    layerKey(layerId(candidate)) === layerKey(groupId));
  if (group?.visible === false) return null;
  return {
    x: offset.x + (Number(group?.offset?.x) || 0),
    y: offset.y + (Number(group?.offset?.y) || 0),
  };
}

function compositeSource(
  options: AnimationAssemblerOptions,
  frame: AnimationSourceFrame,
  index: number,
  frameCount: number,
): unknown {
  if (typeof options.compositeCells === 'function') {
    return options.compositeCells(frame, index);
  }
  return frameIndexedValue(options.compositeCells, index, frameCount) ??
    frame?.compositeCells ?? frame?.composite ?? [];
}

function mixedAudioDescriptor(value: UnknownRecord, source = MIXED_AUDIO_PATH): UnknownRecord {
  const durationUs = Number(value['durationUs']);
  if (!Number.isSafeInteger(durationUs) || durationUs < 0) {
    throw new TypeError('Mixed Animation audio durationUs must be a nonnegative safe integer.');
  }
  return {
    source,
    mime: WAV_EXPORT_MIME,
    sampleRate: AUDIO_EXPORT_SAMPLE_RATE,
    channels: AUDIO_EXPORT_CHANNELS,
    durationUs,
  };
}

function runtimeAnimationFrame(
  options: AnimationAssemblerOptions,
  metadata: LayerMetadata[],
  canvas: AnimationCanvas,
  frame: AnimationSourceFrame,
  frameIndex: number,
  frameCount: number,
  composite?: unknown,
): RuntimeAnimationFrame {
  const layers = metadata.flatMap((layer) => {
    const source = frameLayerSource(options, frame, frameIndex, layer, frameCount);
    if (source == null || isReferenceLayer(source) || isNonEmittingLayer(source) ||
      (isUnknownRecord(source) && source['visible'] === false)) return [];
    const sourceLayer = isUnknownRecord(source) ? source as AnimationSourceLayer : null;
    const offset = sourceLayer ? layerOffset(sourceLayer, frame) : { x: 0, y: 0 };
    if (offset == null) return [];
    const cells = cellsToRecords(
      sourceLayer?.cells ?? source,
      canvas.columns,
      canvas.rows,
      offset,
    );
    return cells.length ? [{ layerId: layer.index, cells }] : [];
  });
  return {
    hold: positiveInteger(frame?.hold ?? 1, `Frame ${frameIndex + 1} hold`),
    layers,
    composite: cellsToRecords(
      composite === undefined
        ? compositeSource(options, frame, frameIndex, frameCount)
        : composite,
      canvas.columns,
      canvas.rows,
    ),
  };
}

function runtimeAnimationDocument(
  options: AnimationAssemblerOptions,
  canvas: AnimationCanvas,
  fps: number,
  layers: AnimationLayer[],
  frames: RuntimeAnimationFrame[],
): AnimationDocument {
  const document: AnimationDocument = {
    format: ANIMATION_FORMAT,
    version: ANIMATION_VERSION,
    canvas,
    timebase: { ticksPerSecond: fps },
    tags: runtimeTimelineTags(options.tags, Math.max(
      1,
      frames.reduce((total, frame) => total + frame.hold, 0),
    )),
    layers,
    frames,
  };
  const suppliedPlan = options.exportPlan ?? options.plan;
  const includeAudio = suppliedPlan?.includeAudio ?? options.audio != null;
  if (includeAudio) {
    const plan = suppliedPlan ?? planAnimationExport({
      fileName: options.fileName,
      includeAudio: true,
      hasAudio: options.audio != null,
    });
    if (!plan.includeAudio || options.audio == null) {
      throw new TypeError('Mixed Animation audio is required for an audio ZIP.');
    }
    document.audio = mixedAudioDescriptor(options.audio, plan.audioPath as string);
  }
  return document;
}

export function createAnimationDocumentAssembler(options: AnimationAssemblerOptions = {}) {
  const canvas = dimensionsOf(options);
  const fps = Number(options.fps ?? options.timebase?.['ticksPerSecond']);
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new TypeError('Animation FPS must be a positive number.');
  }
  const sourceFrames = Array.isArray(options.frames) ? options.frames : [];
  const metadata = normalizeLayerMetadata(options.layerMetadata ?? options.layers, sourceFrames);
  const layers = metadata.map((layer) => layer.output);
  return {
    canvas,
    fps,
    layers,
    frame(
      frame: AnimationSourceFrame,
      frameIndex: number,
      frameCount: number,
      composite?: unknown,
    ): RuntimeAnimationFrame {
      return runtimeAnimationFrame(
        options,
        metadata,
        canvas,
        frame,
        frameIndex,
        frameCount,
        composite,
      );
    },
    document(
      frames: RuntimeAnimationFrame[],
      overrides: AnimationAssemblerOptions = {},
    ): AnimationDocument {
      return runtimeAnimationDocument({ ...options, ...overrides }, canvas, fps, layers, frames);
    },
  };
}

export function buildAnimationDocument(
  options: AnimationAssemblerOptions = {},
): AnimationDocument {
  const frames = Array.isArray(options.frames) ? options.frames : [];
  const assembler = createAnimationDocumentAssembler(options);
  return assembler.document(frames.map((frame, frameIndex) => assembler.frame(
    frame,
    frameIndex,
    frames.length,
  )));
}

export function serializeAnimationJSON(document: unknown): string {
  if (!isUnknownRecord(document) || document['format'] !== ANIMATION_FORMAT ||
    document['version'] !== ANIMATION_VERSION) {
    throw new TypeError('Expected a paintty-animation v1 document.');
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function encodeAnimationJSON(options: AnimationAssemblerOptions): string {
  return serializeAnimationJSON(buildAnimationDocument(options));
}

function assertSafeArchivePath(path: unknown): string {
  const value = String(path || '');
  const parts = value.split('/');
  if (!value || value.startsWith('/') || value.includes('\\') ||
      parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe ZIP entry path: ${value || '(empty)'}`);
  }
  return value;
}

async function binaryBytes(value: unknown, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    const bytes = await abortable(value.arrayBuffer(), signal);
    throwIfAborted(signal);
    return new Uint8Array(bytes);
  }
  throw new TypeError('Mixed WAV data must be a Blob, ArrayBuffer, or typed array.');
}

function outputBytes(
  bytes: Uint8Array<ArrayBuffer>,
  mime: string,
  output: 'blob' | 'uint8array',
): Blob | Uint8Array<ArrayBuffer> {
  if (output === 'uint8array') return bytes;
  if (output === 'blob') {
    if (typeof Blob === 'undefined') throw new Error('Blob output is not available in this environment.');
    return new Blob([bytes], { type: mime });
  }
  throw new TypeError("Output must be 'blob' or 'uint8array'.");
}

function jsonTextOf(json: string | undefined, document: AnimationDocument | undefined): string {
  if (typeof json === 'string') return json;
  if (document) return serializeAnimationJSON(document);
  throw new TypeError('Animation JSON text or document is required.');
}

async function concatenateZipChunks(
  chunks: Uint8Array[],
  total: number,
  signal: AbortSignal | undefined,
  yieldControl: () => void | Promise<void>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError('Animation ZIP output is too large to assemble safely.');
  }
  let bytes;
  try {
    bytes = new Uint8Array(total);
  } catch (error) {
    throw new RangeError('Could not allocate the Animation ZIP output.', { cause: error });
  }
  let offset = 0;
  let nextYield = ZIP_CHUNK_BYTES;
  for (const chunk of chunks) {
    throwIfAborted(signal);
    bytes.set(chunk, offset);
    offset += chunk.length;
    if (offset >= nextYield && offset < total) {
      nextYield = offset + ZIP_CHUNK_BYTES;
      await abortable(yieldControl(), signal);
    }
  }
  throwIfAborted(signal);
  return bytes;
}

async function encodeZipEntries(
  {
    jsonPath,
    jsonBytes,
    audioPath,
    audioBytes,
    signal,
  }: {
    jsonPath: string;
    jsonBytes: Uint8Array;
    audioPath: string;
    audioBytes: Uint8Array;
    signal?: AbortSignal;
  },
  options: AnimationZipOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  const ZipClass = options.ZipClass || Zip;
  const JsonEntryClass = options.AsyncZipDeflateClass || AsyncZipDeflate;
  const AudioEntryClass = options.ZipPassThroughClass || ZipPassThrough;
  const yieldControl = options.yieldControl || defaultYield;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let archive: Zip | null = null;
  let settled = false;
  let resolveCompletion!: (result: { chunks: Uint8Array[]; total: number }) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<{ chunks: Uint8Array[]; total: number }>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  completion.catch(() => {});
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    rejectCompletion(error);
  };
  const cancel = () => {
    try { archive?.terminate(); } catch {}
    fail(abortError(signal));
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    throwIfAborted(signal);
    archive = new ZipClass((error, chunk, final) => {
      if (settled) return;
      if (error) {
        fail(error);
        return;
      }
      if (chunk?.length) {
        total += chunk.length;
        if (!Number.isSafeInteger(total)) {
          fail(new RangeError('Animation ZIP output is too large to assemble safely.'));
          try { archive?.terminate(); } catch {}
          return;
        }
        chunks.push(chunk);
      }
      if (final) {
        settled = true;
        resolveCompletion({ chunks, total });
      }
    });
    const jsonEntry = new JsonEntryClass(jsonPath, { level: 6 });
    jsonEntry.mtime = ZIP_MTIME;
    const audioEntry = new AudioEntryClass(audioPath);
    audioEntry.mtime = ZIP_MTIME;
    archive.add(jsonEntry);
    archive.add(audioEntry);
    jsonEntry.push(jsonBytes, true);

    for (let offset = 0; offset < audioBytes.length || offset === 0; offset += ZIP_CHUNK_BYTES) {
      throwIfAborted(signal);
      const end = Math.min(audioBytes.length, offset + ZIP_CHUNK_BYTES);
      const final = end === audioBytes.length;
      audioEntry.push(audioBytes.subarray(offset, end), final);
      if (!final) await abortable(yieldControl(), signal);
      if (audioBytes.length === 0) break;
    }
    throwIfAborted(signal);
    archive.end();
    const result = await completion;
    return await concatenateZipChunks(result.chunks, result.total, signal, yieldControl);
  } catch (error) {
    try { archive?.terminate(); } catch {}
    if (signal?.aborted) throw abortError(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export async function encodeAnimationZip(
  options: AnimationZipOptions = {},
): Promise<Blob | Uint8Array<ArrayBuffer>> {
  const { plan, document, output = 'uint8array', signal } = options;
  throwIfAborted(signal);
  if (!plan || plan.kind !== 'zip') throw new TypeError('A ZIP animation export plan is required.');
  const json = jsonTextOf(options.json, document);
  const jsonPath = assertSafeArchivePath(plan.jsonFilename);
  const audioPath = assertSafeArchivePath(plan.audioPath);
  if (jsonPath.normalize('NFC').toLowerCase() === audioPath.normalize('NFC').toLowerCase()) {
    throw new Error(`Duplicate ZIP entry path: ${audioPath}`);
  }
  throwIfAborted(signal);
  const audioBytes = await binaryBytes(options.audioBytes, signal);
  throwIfAborted(signal);
  const bytes = await encodeZipEntries({
    jsonPath,
    jsonBytes: strToU8(json),
    audioPath,
    audioBytes,
    ...(signal ? { signal } : {}),
  }, options);
  throwIfAborted(signal);
  return outputBytes(bytes, 'application/zip', output);
}

export async function encodeAnimationExport(
  options: AnimationZipOptions = {},
): Promise<Blob | Uint8Array<ArrayBuffer>> {
  const { plan, document, output = 'uint8array', signal } = options;
  throwIfAborted(signal);
  if (!plan) throw new TypeError('An animation export plan is required.');
  const json = jsonTextOf(options.json, document);
  if (plan.kind === 'zip') {
    return encodeAnimationZip({ ...options, json, output });
  }
  throwIfAborted(signal);
  return outputBytes(strToU8(json), 'application/json', output);
}
