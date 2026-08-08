import { AsyncZipDeflate, strToU8, Zip, ZipPassThrough } from 'fflate';
import {
  AUDIO_EXPORT_CHANNELS,
  AUDIO_EXPORT_SAMPLE_RATE,
  WAV_EXPORT_MIME,
} from './audioExport.js';
import { runtimeTimelineTags } from './timelineTags.js';

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

function visualLimitError(message) {
  const error = new RangeError(message);
  error.code = 'ANIMATION_VISUAL_RESOURCE_LIMIT';
  return error;
}

function checkedVisualInteger(value, label, minimum = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw visualLimitError(`${label} cannot be represented safely for Animation export.`);
  }
  return number;
}

function checkedVisualMultiply(label, ...values) {
  let result = 1;
  for (const value of values) {
    result *= checkedVisualInteger(value, label);
    if (!Number.isSafeInteger(result)) {
      throw visualLimitError(`${label} cannot be represented safely for Animation export.`);
    }
  }
  return result;
}

function checkedVisualAdd(label, ...values) {
  let result = 0;
  for (const value of values) {
    result += checkedVisualInteger(value, label);
    if (!Number.isSafeInteger(result)) {
      throw visualLimitError(`${label} cannot be represented safely for Animation export.`);
    }
  }
  return result;
}

function assertVisualBytes(estimatedBytes) {
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
} = {}) {
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

function runtimeFrameCounts(frame) {
  const layerEntries = Array.isArray(frame?.layers) ? frame.layers.length : 0;
  let cellEntries = Array.isArray(frame?.composite) ? frame.composite.length : 0;
  let stringBytes = 0;
  const countCells = (cells) => {
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

export function accountAnimationVisualFrame(resources, frame) {
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

export function validateAnimationVisualJsonResources(resources, { layers = [], tags = [] } = {}) {
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

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  if (typeof DOMException === 'function') {
    return new DOMException('Animation export cancelled.', 'AbortError');
  }
  const error = new Error('Animation export cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortable(promise, signal) {
  const pending = Promise.resolve(promise);
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
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

function defaultYield() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function pathLeaf(value) {
  const parts = String(value ?? '').replace(/\\/g, '/').split('/');
  return (parts[parts.length - 1] || '').trim();
}

function splitExtension(name) {
  const index = name.lastIndexOf('.');
  return index > 0
    ? { stem: name.slice(0, index), extension: name.slice(index) }
    : { stem: name, extension: '' };
}

function safeLeafName(value, fallback) {
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

export function animationExportBaseName(fileName) {
  let name = pathLeaf(fileName);
  while (/\.(?:json|paintty|zip)$/i.test(name)) {
    name = name.replace(/\.(?:json|paintty|zip)$/i, '');
  }
  return safeLeafName(name, 'untitled');
}

export function planAnimationExport(options = {}) {
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

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return number;
}

function dimensionsOf(options) {
  const source = options.dimensions || options.canvas || {};
  return {
    columns: positiveInteger(
      source.columns ?? source.w ?? source.width ?? options.width,
      'Animation width',
    ),
    rows: positiveInteger(
      source.rows ?? source.h ?? source.height ?? options.height,
      'Animation height',
    ),
  };
}

function layerId(layer) {
  const id = layer?.layerId ?? layer?.id;
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).length) {
    throw new Error('Animation source layer requires an authoring ID.');
  }
  return id;
}

function layerKey(id) {
  return String(id);
}

function isReferenceLayer(layer) {
  return REFERENCE_LAYER_TYPES.has(String(layer?.type || '').toLowerCase());
}

function normalizeLayerMetadata(source, frames) {
  const values = Array.isArray(source)
    ? source
    : Array.isArray(frames[0]?.layers) ? frames[0].layers : [];
  const seen = new Set();
  const eligible = values.flatMap((layer, sourceIndex) => {
    if (!layer || typeof layer !== 'object' || isReferenceLayer(layer)) return [];
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

function looksLikeFlatCellList(value) {
  if (!Array.isArray(value)) return false;
  const first = value.find((entry) => entry != null);
  return first == null || (
    !Array.isArray(first) && typeof first === 'object' &&
    Number.isFinite(Number(first.x)) && Number.isFinite(Number(first.y))
  );
}

function looksLikeGrid(value) {
  if (!Array.isArray(value) || looksLikeFlatCellList(value)) return false;
  const firstRow = value.find((row) => Array.isArray(row));
  if (!firstRow) return value.length === 0;
  return !firstRow.some((cell) => Array.isArray(cell));
}

function normalizeCell(cell, x, y, wide) {
  if (!cell || cell.cont) return null;
  const glyphValue = Object.prototype.hasOwnProperty.call(cell, 'glyph')
    ? cell.glyph
    : cell.c;
  const glyph = typeof glyphValue === 'string' && glyphValue.length ? glyphValue : null;
  const foreground = cell.foreground ?? cell.fg ?? null;
  const background = cell.background ?? cell.bg ?? null;
  if (!glyph && !background) return null;
  const output = {
    x,
    y,
    glyph,
    foreground: glyph ? foreground : null,
    background,
    width: glyph && (cell.width === 2 || wide) ? 2 : 1,
  };
  if (cell.blink) output.blink = true;
  return output;
}

function inCanvas(x, y, columns, rows) {
  return Number.isInteger(x) && Number.isInteger(y) &&
    x >= 0 && y >= 0 && x < columns && y < rows;
}

function cellsToRecords(cells, columns, rows, offset = { x: 0, y: 0 }) {
  if (cells == null) return [];
  const dx = Math.round(Number(offset?.x) || 0);
  const dy = Math.round(Number(offset?.y) || 0);
  const output = [];
  if (looksLikeFlatCellList(cells)) {
    for (const cell of cells) {
      if (!cell) continue;
      const x = Math.round(Number(cell.x)) + dx;
      const y = Math.round(Number(cell.y)) + dy;
      if (!inCanvas(x, y, columns, rows)) continue;
      const normalized = normalizeCell(cell, x, y, cell.width === 2);
      if (normalized) output.push(normalized);
    }
  } else if (looksLikeGrid(cells)) {
    for (let y = 0; y < Math.min(rows, cells.length); y++) {
      const row = Array.isArray(cells[y]) ? cells[y] : [];
      for (let x = 0; x < Math.min(columns, row.length); x++) {
        const normalized = normalizeCell(row[x], x, y, !!row[x + 1]?.cont);
        if (normalized) output.push(normalized);
      }
    }
  } else {
    const entries = cells instanceof Map ? [...cells.entries()] : Object.entries(cells || {});
    const byKey = new Map(entries);
    for (const [key, cell] of entries) {
      const match = /^(-?\d+),(-?\d+)$/.exec(String(key));
      if (!match || !cell) continue;
      const sourceX = Number(match[1]);
      const sourceY = Number(match[2]);
      const x = sourceX + dx;
      const y = sourceY + dy;
      if (!inCanvas(x, y, columns, rows)) continue;
      const next = byKey.get(`${sourceX + 1},${sourceY}`);
      const normalized = normalizeCell(cell, x, y, !!next?.cont);
      if (normalized) output.push(normalized);
    }
  }
  output.sort((first, second) => first.y - second.y || first.x - second.x);
  return output;
}

function valueForLayer(container, metadata) {
  if (container == null) return null;
  if (container instanceof Map) {
    return container.get(metadata.authorId) ?? container.get(metadata.key) ?? null;
  }
  if (Array.isArray(container)) {
    const identified = container.find((value) =>
      value && typeof value === 'object' &&
      layerKey(layerId(value)) === metadata.key);
    return identified ?? null;
  }
  if (typeof container === 'object') {
    return Object.prototype.hasOwnProperty.call(container, metadata.key)
      ? container[metadata.key]
      : null;
  }
  return null;
}

function frameIndexedValue(source, index, frameCount) {
  if (source == null) return null;
  if (source instanceof Map) return source.get(index) ?? source.get(String(index)) ?? null;
  if (Array.isArray(source)) {
    if (frameCount === 1 && (looksLikeGrid(source) || looksLikeFlatCellList(source))) return source;
    return source[index] ?? null;
  }
  if (typeof source === 'object') return source[index] ?? source[String(index)] ?? null;
  return null;
}

function frameLayerSource(options, frame, frameIndex, metadata, frameCount) {
  if (typeof options.layerCells === 'function') {
    return options.layerCells(frame, frameIndex, metadata.source, metadata.sourceIndex);
  }
  const supplied = frameIndexedValue(options.layerCells, frameIndex, frameCount);
  return valueForLayer(supplied, metadata) ??
    valueForLayer(frame?.layerCells, metadata) ??
    valueForLayer(frame?.layers, metadata);
}

function layerOffset(source, frame) {
  const offset = { x: Number(source?.offset?.x) || 0, y: Number(source?.offset?.y) || 0 };
  const groupId = source?.groupId;
  if (groupId == null || !Array.isArray(frame?.layers)) return offset;
  const group = frame.layers.find((candidate) =>
    layerKey(layerId(candidate)) === layerKey(groupId));
  if (group?.visible === false) return null;
  return {
    x: offset.x + (Number(group?.offset?.x) || 0),
    y: offset.y + (Number(group?.offset?.y) || 0),
  };
}

function compositeSource(options, frame, index, frameCount) {
  if (typeof options.compositeCells === 'function') {
    return options.compositeCells(frame, index);
  }
  return frameIndexedValue(options.compositeCells, index, frameCount) ??
    frame?.compositeCells ?? frame?.composite ?? [];
}

function mixedAudioDescriptor(value, source = MIXED_AUDIO_PATH) {
  const durationUs = Number(value?.durationUs);
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

function runtimeAnimationFrame(options, metadata, canvas, frame, frameIndex, frameCount, composite) {
  const layers = metadata.flatMap((layer) => {
    const source = frameLayerSource(options, frame, frameIndex, layer, frameCount);
    if (source == null || isReferenceLayer(source) || source?.visible === false) return [];
    const offset = layerOffset(source, frame);
    if (offset == null) return [];
    const cells = cellsToRecords(source?.cells ?? source, canvas.columns, canvas.rows, offset);
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

function runtimeAnimationDocument(options, canvas, fps, layers, frames) {
  const document = {
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
    document.audio = mixedAudioDescriptor(options.audio, plan.audioPath);
  }
  return document;
}

export function createAnimationDocumentAssembler(options = {}) {
  const canvas = dimensionsOf(options);
  const fps = Number(options.fps ?? options.timebase?.ticksPerSecond);
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
    frame(frame, frameIndex, frameCount, composite) {
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
    document(frames, overrides = {}) {
      return runtimeAnimationDocument({ ...options, ...overrides }, canvas, fps, layers, frames);
    },
  };
}

export function buildAnimationDocument(options = {}) {
  const frames = Array.isArray(options.frames) ? options.frames : [];
  const assembler = createAnimationDocumentAssembler(options);
  return assembler.document(frames.map((frame, frameIndex) => assembler.frame(
    frame,
    frameIndex,
    frames.length,
  )));
}

export function serializeAnimationJSON(document) {
  if (!document || document.format !== ANIMATION_FORMAT || document.version !== ANIMATION_VERSION) {
    throw new TypeError('Expected a paintty-animation v1 document.');
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function encodeAnimationJSON(options) {
  return serializeAnimationJSON(buildAnimationDocument(options));
}

function assertSafeArchivePath(path) {
  const value = String(path || '');
  const parts = value.split('/');
  if (!value || value.startsWith('/') || value.includes('\\') ||
      parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe ZIP entry path: ${value || '(empty)'}`);
  }
  return value;
}

async function binaryBytes(value, signal) {
  throwIfAborted(signal);
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
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

function outputBytes(bytes, mime, output) {
  if (output === 'uint8array') return bytes;
  if (output === 'blob') {
    if (typeof Blob === 'undefined') throw new Error('Blob output is not available in this environment.');
    return new Blob([bytes], { type: mime });
  }
  throw new TypeError("Output must be 'blob' or 'uint8array'.");
}

function jsonTextOf(json, document) {
  if (typeof json === 'string') return json;
  if (document) return serializeAnimationJSON(document);
  throw new TypeError('Animation JSON text or document is required.');
}

async function concatenateZipChunks(chunks, total, signal, yieldControl) {
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

async function encodeZipEntries({ jsonPath, jsonBytes, audioPath, audioBytes, signal }, options) {
  const ZipClass = options.ZipClass || Zip;
  const JsonEntryClass = options.AsyncZipDeflateClass || AsyncZipDeflate;
  const AudioEntryClass = options.ZipPassThroughClass || ZipPassThrough;
  const yieldControl = options.yieldControl || defaultYield;
  const chunks = [];
  let total = 0;
  let archive = null;
  let settled = false;
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  completion.catch(() => {});
  const fail = (error) => {
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

export async function encodeAnimationZip(options = {}) {
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
    signal,
  }, options);
  throwIfAborted(signal);
  return outputBytes(bytes, 'application/zip', output);
}

export async function encodeAnimationExport(options = {}) {
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
