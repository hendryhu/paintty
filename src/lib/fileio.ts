import { get } from 'svelte/store';
import {
  layers, GRID_W, GRID_H, dims, applyBlinkPhase, resetEditorStateForProjectLoad,
  authoredRevision, registerHistoryContributor,
} from './grid.js';
import { cmFromGrid } from './cellmap.js';
import { normalizeTextRuns } from './textLayer.js';
import { notifyError, notifyInfo } from './notifications.js';
import { normalizeTemporalEase } from './temporalEasing.js';
import { normalizeShapePathKey } from './shapePath.js';
import {
  activeFrameIndex,
  canonicalTimelineStateForSave,
  frames,
  loadCanonicalTimeline,
  fps,
  DEFAULT_FPS,
  compositeFrameCells,
  createTimelineFrameSource,
} from './frames.js';
import { moveState, selectMode } from './selection.js';
import { activeTool, altEyedrop, fileName, dirty } from './stores.js';
import { canvasFont } from './font.js';
import {
  createRecentProjectId,
  recentProjectIdentity,
} from './recentProjects.js';
import { normalizeVideoClip, releaseVideoSource as disposeVideoSource } from './video.js';
import { normalizeOutputGrid, paintOutputGrid } from './outputGrid.js';
import {
  audioAssets, audioClips, audioStateForSave, audioTracks, decodeAudioSource, normalizeAudioClip,
} from './audio.js';
import {
  audibleTimelineAudioAssetIds, createTimelineAudioPlan, encodeTimelineAudio,
  encodeTimelineWav, estimateAnimationAudioExportResources, preflightAacEncoder,
  validateDecodedAnimationAudioExportResources,
} from './audioExport.js';
import { decodeProjectArchive, encodeProjectArchive } from './projectArchive.js';
import { getProjectAsset, putProjectAssets, withMediaLease } from './projectAssets.js';
import { acquireMediaResource } from './mediaRuntime.js';
import {
  captureMediaRegistry,
  installMediaRegistryHistory,
  loadMediaRegistry,
  normalizeMediaRegistry,
  serializeMediaRegistry,
} from './mediaRegistry.js';
import { scheduleMediaCacheGc } from './mediaGc.js';
import {
  accountAnimationVisualFrame, createAnimationDocumentAssembler, encodeAnimationZip,
  estimateAnimationVisualExportResources, planAnimationExport, serializeAnimationJSON,
  validateAnimationVisualJsonResources,
} from './animationExport.js';
import {
  frameToAnsiText,
  frameToBashCommand,
  frameToPowerShellCommand as renderPowerShellCommand,
} from './terminalCopy.js';
import {
  advanceProjectRevision,
  captureProjectRevision,
  isProjectRevisionCurrent,
  notifyProjectCheckpoint,
  notifyProjectLoaded,
  notifyProjectReplaced,
  notifyProjectSaved,
} from './documentLifecycle.js';
import { projectId, replaceProjectId } from './projectIdentity.js';
import { assertUuid, uuidKey } from './uuid.js';
import {
  assertCanonicalClipTimelineState,
  getClipTimelineState,
} from './clipTimelineState.js';
import { CURRENT_PROJECT_VERSION } from './projectFormat.js';
import {
  clipTimelineDurationTicks,
  resolveClipTimelineLayers,
} from './clipTimelineResolver.js';
import {
  normalizeTimelineTags,
  runtimeTimelineTags,
  validateTimelineTagRange,
} from './timelineTags.js';
import {
  exportOutputSpec,
  normalizeExportFilename,
  pickExportFileTarget,
} from './exportDestination.js';
import type {
  AudioRuntimeAsset,
  MediaLease,
  MediaAsset,
  MediaRegistry,
  MutableMediaRegistry,
  ProjectAssetRecord,
} from './types/media-types.js';
import type {
  AudioClip,
  AudioTrack,
  ExportSpec,
  JsonValue,
  Point,
  ProjectCheckpointDetail,
  ProjectLoadedDetail,
  ProjectSavedDetail,
  SaveTarget,
  UnknownRecord,
} from './types/project-types.js';
import { errorText, isUnknownRecord } from './types/project-types.js';
import type { TimelineAudioPlan } from './audioExport.js';
import type { AnimationExportPlan } from './animationExport.js';
import type {
  EditorCell as CellValue,
  EditorCellGrid,
  EditorCellMap as CellMap,
  EditorLayer as ProjectLayer,
  EditorShapeKind,
} from './types/editor-domain.js';
import type {
  ClipTimelineState as CanonicalTimelineState,
  TimelineClip,
  TimelinePropertyTracks,
  TimelineStoredKey as TimelineKey,
  TimelineTrack,
} from './types/timeline-models.js';

interface AbortOptions {
  signal?: AbortSignal | undefined;
}

type ChooseTarget = (
  filename: string,
  type: string,
  description: string,
  options?: AbortOptions,
) => Promise<SaveTarget | null> | SaveTarget | null;

interface TextExportOptions extends AbortOptions {
  filename?: string;
  chooseTarget?: ChooseTarget;
}

interface SaveJsonOptions {
  saveAs?: boolean;
  chooseTarget?: ChooseTarget;
  serialize?: (mediaSnapshot?: MediaRegistry) => string;
  checkpoint?: (detail: ProjectCheckpointDetail) => void | Promise<void>;
  notifySaved?: (detail: ProjectSavedDetail) => void | Promise<void>;
  reportRecoveryError?: (error: unknown) => void;
  reportUnverifiedSave?: () => void;
}

interface ImageSnapshot {
  cells: OutputGrid;
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  font: string;
}

interface ImageExportDependencies extends AbortOptions {
  filename?: string;
  chooseTarget?: ChooseTarget;
  render?: (
    snapshot: ImageSnapshot,
    options: {
      format: string;
      type: string;
      createCanvas: () => HTMLCanvasElement;
      signal?: AbortSignal;
    },
  ) => Blob | Promise<Blob>;
  download?: boolean;
  createCanvas?: () => HTMLCanvasElement;
}

interface VideoFrameDefinition {
  hold?: number;
  [key: string]: unknown;
}

interface VideoFrameSample {
  sourceIndex: number;
  tick: number;
  timestamp: number;
  duration: number;
}

interface EncodedVideoSample {
  data: Uint8Array;
  key: boolean;
}

interface VideoRenderArgs {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  frameDefs: VideoFrameDefinition[];
  resolveFrame?: (index: number) => Parameters<typeof videoFrameCells>[0];
  plan: VideoFrameSample[];
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  font: string;
  rate: number;
  audioPlan: TimelineAudioPlan | null;
}

interface H264Preflight {
  VideoEncoderClass: typeof VideoEncoder;
  VideoFrameClass: typeof VideoFrame;
  createFrameImage: typeof createImageBitmap;
  config: VideoEncoderConfig;
}

interface VideoExportDependencies extends AbortOptions, UnknownRecord {
  VideoEncoderClass?: typeof VideoEncoder;
  VideoFrameClass?: typeof VideoFrame;
  createFrameImage?: typeof createImageBitmap;
  filename?: string;
  chooseTarget?: ChooseTarget;
  createFrameSource?: () => TimelineFrameSource;
  getAudioState?: () => UnknownRecord | (() => UnknownRecord);
  audioState?: UnknownRecord | (() => UnknownRecord);
  createAudioPlan?: (options: UnknownRecord) => TimelineAudioPlan | null;
  createCanvas?: () => HTMLCanvasElement;
  preflight?: (
    canvas: HTMLCanvasElement,
    rate: number,
    dependencies: VideoExportDependencies,
  ) => Promise<H264Preflight>;
  preflightAudio?: (
    plan: TimelineAudioPlan,
    dependencies: VideoExportDependencies,
  ) => Promise<Awaited<ReturnType<typeof preflightAacEncoder>>>;
  encodeVideo?: (
    args: VideoRenderArgs,
    dependencies: VideoExportDependencies,
    preflight: H264Preflight,
  ) => Promise<Uint8Array>;
  onProgress?: (progress: { completed: number; total: number; phase: string }) => void;
  yieldControl?: () => void | Promise<void>;
  mux?: Awaited<ReturnType<typeof loadH264Muxer>>;
  loadMux?: typeof loadH264Muxer;
  encodeTimelineAudio?: typeof encodeTimelineAudio;
  audioPreflight?: Awaited<ReturnType<typeof preflightAacEncoder>> | null;
}

type SavedAudioTrack = ReturnType<typeof audioStateForSave>['tracks'][number];
type TimelineFrameSource = ReturnType<typeof createTimelineFrameSource>;
type AnimationAssembler = ReturnType<typeof createAnimationDocumentAssembler>;
type AnimationRuntimeFrame = ReturnType<AnimationAssembler['frame']>;
type OutputGrid = ReturnType<typeof normalizeOutputGrid>;

interface CapturedAudioAsset extends UnknownRecord {
  id: string;
  size: number;
  duration: number;
  hash: string;
  generation: number;
  buffer: AudioBuffer | null;
}

type AnimationAudioDecoder = (
  blob: Blob,
  options: { asset: CapturedAudioAsset },
) => Promise<AudioBuffer | { buffer?: AudioBuffer | null }>;

interface AnimationSnapshot {
  filename: string;
  plan: AnimationExportPlan;
  source: TimelineFrameSource;
  resources: ReturnType<typeof estimateAnimationAudioExportResources> | null;
  visualResources: ReturnType<typeof estimateAnimationVisualExportResources>;
  dimensions: { w: number; h: number };
  fps: number;
  durationTicks: number;
  tags: UnknownRecord[];
  includeAudio: boolean;
  audioTracks: SavedAudioTrack[];
  audioAssets: CapturedAudioAsset[];
  hashes: string[];
}

interface AnimationExportDependencies extends AbortOptions, UnknownRecord {
  includeAudio?: boolean;
  filename?: string;
  download?: boolean;
  chooseTarget?: ChooseTarget;
  getAsset?: (hash: unknown) => Promise<ProjectAssetRecord | null>;
  estimateVisualResources?: typeof estimateAnimationVisualExportResources;
  estimateAudioResources?: typeof estimateAnimationAudioExportResources;
  createFrameSource?: () => TimelineFrameSource;
  visualYieldControl?: () => void | Promise<void>;
  visualYieldInterval?: number;
  compositeAnimationFrame?: typeof compositeFrameCells;
  createAnimationAssembler?: typeof createAnimationDocumentAssembler;
  accountVisualFrame?: typeof accountAnimationVisualFrame;
  validateVisualJson?: typeof validateAnimationVisualJsonResources;
  onProgress?: (progress: { completed: number; total: number; phase: string }) => void;
  decodeAudio?: AnimationAudioDecoder;
  validateDecodedAudioResources?: typeof validateDecodedAnimationAudioExportResources;
  createAudioPlan?: typeof createTimelineAudioPlan;
  encodeTimelineWav?: typeof encodeTimelineWav;
  zipYieldControl?: () => void | Promise<void>;
}

interface LayerInput extends UnknownRecord {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  visible?: unknown;
  cells?: unknown;
  overflow?: unknown;
  text?: unknown;
  box?: unknown;
  wrap?: unknown;
  fg?: unknown;
  runs?: unknown;
  shape?: unknown;
  offset?: unknown;
  transform?: unknown;
  assetId?: unknown;
  video?: unknown;
  videoPlacement?: unknown;
  groupId?: unknown;
  collapsed?: unknown;
  blink?: unknown;
  effect?: unknown;
  clipped?: unknown;
  mask?: unknown;
  contentMask?: unknown;
  opacity?: unknown;
}

interface TransformInput extends UnknownRecord {
  x?: unknown;
  y?: unknown;
  rot?: unknown;
  scale?: unknown;
  scaleX?: unknown;
  scaleY?: unknown;
}

interface CanonicalKeyInput extends UnknownRecord {
  tick?: unknown;
  value?: unknown;
}

interface CanonicalTrackInput extends UnknownRecord {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  locked?: unknown;
  parentTrackId?: unknown;
  layer?: unknown;
  propertyTracks?: unknown;
  volume?: unknown;
  muted?: unknown;
  shapePathKind?: unknown;
  shapePathComponents?: unknown;
}

interface CanonicalClipInput extends UnknownRecord {
  id?: unknown;
  trackId?: unknown;
  kind?: unknown;
  startTick?: unknown;
  inTick?: unknown;
  outTick?: unknown;
  sourceDuration?: unknown;
  frameKeys?: unknown;
  propertyTracks?: unknown;
  assetId?: unknown;
  inPoint?: unknown;
  outPoint?: unknown;
  playbackRate?: unknown;
  volume?: unknown;
  muted?: unknown;
  name?: unknown;
}

interface CanonicalTimelineInput extends UnknownRecord {
  tracks?: unknown;
  clips?: unknown;
  tags?: unknown;
}

interface ProjectInput extends UnknownRecord {
  format?: unknown;
  version?: unknown;
  projectId?: unknown;
  width?: unknown;
  height?: unknown;
  fps?: unknown;
  timeline?: unknown;
  media?: unknown;
}

installMediaRegistryHistory(registerHistoryContributor);

function serializeMask(mask: UnknownRecord): UnknownRecord {
  const offset = isUnknownRecord(mask['offset']) ? mask['offset'] : null;
  const serialized: UnknownRecord = {
    defaultStrength: mask['defaultStrength'] ?? 1,
    cells: mask['cells'] || {},
    offset: {
      x: Math.round(Number(offset?.['x']) || 0),
      y: Math.round(Number(offset?.['y']) || 0),
    },
  };
  if ('opacity' in mask) serialized['opacity'] = mask['opacity'];
  return serialized;
}

function normalizeContentMask(mask: unknown, label: string): UnknownRecord {
  if (!isRecord(mask)) throw new Error(`${label} must be an object`);
  assertOnlyKeys(mask, new Set(['defaultStrength', 'cells', 'offset']), label);
  const defaultStrength = mask['defaultStrength'] ?? 1;
  if (defaultStrength !== 0 && defaultStrength !== 1) {
    throw new Error(`${label} default strength must be 0 or 1`);
  }
  const offset = normalizeOptionalRecord(mask['offset'], `${label} offset`) || {};
  const source = recordOrEmpty(mask['cells'], `${label} cells`);
  const cells: UnknownRecord = {};
  for (const [key, cell] of Object.entries(source)) {
    validateCellKey(key, `${label} cells`);
    if (cell == null) continue;
    if (!isRecord(cell)) throw new Error(`${label} cell ${key} must be an object`);
    const color = typeof cell['bg'] === 'string' ? cell['bg'] : null;
    if (!color || !/^#[0-9a-f]{6}$/i.test(color) ||
      (Object.prototype.hasOwnProperty.call(cell, 'c') && cell['c'] !== '') ||
      (Object.prototype.hasOwnProperty.call(cell, 'fg') && cell['fg'] != null) ||
      Object.keys(cell).some((field) => field !== 'bg' && field !== 'fg' && field !== 'c')) {
      throw new Error(`${label} cell ${key} must contain only one #rrggbb color`);
    }
    cells[key] = { bg: color.toLowerCase() };
  }
  return {
    defaultStrength,
    cells,
    offset: {
      x: Math.round(Number(offset['x']) || 0),
      y: Math.round(Number(offset['y']) || 0),
    },
  };
}

function serializeContentMask(mask: UnknownRecord): UnknownRecord {
  return normalizeContentMask(mask, 'Content mask');
}

function serializeEffectLayer(
  layer: Extract<ProjectLayer, { type: 'effect' }>,
): UnknownRecord {
  const serialized: UnknownRecord = { effect: layer['effect'] };
  if (layer['clipped']) serialized['clipped'] = true;
  if (isUnknownRecord(layer.mask)) serialized['mask'] = serializeMask(layer.mask);
  return serialized;
}
function serializeLayerMeta(l: ProjectLayer): UnknownRecord {
  return {
    id: l.id, name: l.name, type: l.type, visible: l.visible,
    ...(l.type === 'text' ? { text: l.text, box: l.box, wrap: l.wrap, fg: l.fg, runs: l.runs } : {}),
    ...(l.type === 'shape' ? { shape: l.shape } : {}),
    ...(l.type === 'effect' ? serializeEffectLayer(l) : {}),
    ...(l.type === 'image' ? { transform: l.transform, assetId: l.assetId } : {}),
    ...(l.type === 'video' ? {
      transform: l.transform,
      assetId: (l as unknown as UnknownRecord)['assetId'],
    } : {}),
    ...(l.groupId != null ? { groupId: l.groupId } : {}),
    ...(l.type === 'group' ? { collapsed: !!l.collapsed } : {}),
    ...(l.type !== 'group' && l.type !== 'effect' && l.opacity != null && l.opacity !== 1 ? { opacity: l.opacity } : {}),
    ...(l.blink ? { blink: true } : {}),
    ...(isUnknownRecord(l as unknown as UnknownRecord) && (l as unknown as UnknownRecord)['contentMask']
      ? { contentMask: serializeContentMask((l as unknown as UnknownRecord)['contentMask'] as UnknownRecord) }
      : {}),
  };
}

function serializableDtoValue(
  value: unknown,
  label: string,
  seen = new WeakSet<object>(),
): JsonValue | undefined {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain finite numbers.`);
    return value;
  }
  if (typeof value !== 'object') throw new TypeError(`${label} contains a runtime value.`);
  if (seen.has(value)) throw new TypeError(`${label} must not contain cycles.`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} contains a runtime resource.`);
  }
  seen.add(value);
  const result = (Array.isArray(value) ? [] : {}) as Record<string, JsonValue>;
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    result[key] = serializableDtoValue(entry, `${label}.${key}`, seen)!;
  }
  seen.delete(value);
  return result as JsonValue;
}

function serializableCanonicalLayer(layer: ProjectLayer, label: string): UnknownRecord {
  const metadata = serializableDtoValue(serializeLayerMeta(layer), label) as UnknownRecord;
  return {
    ...metadata,
    cells: serializableDtoValue(layer?.cells || {}, `${label}.cells`),
    offset: {
      x: Math.round(Number(layer?.offset?.x) || 0),
      y: Math.round(Number(layer?.offset?.y) || 0),
    },
  };
}

function serializableCanonicalPayload(value: unknown, label: string): UnknownRecord {
  const output: UnknownRecord = {};
  for (const field of [
    'cells', 'text', 'box', 'wrap', 'fg', 'runs', 'shape', 'mask', 'contentMask',
  ]) {
    if (isUnknownRecord(value) && Object.prototype.hasOwnProperty.call(value, field) &&
      value[field] !== undefined) {
      if (field === 'contentMask' && value[field] == null) continue;
      output[field] = field === 'contentMask'
        ? serializeContentMask(value[field] as UnknownRecord)
        : serializableDtoValue(value[field], `${label}.${field}`)!;
    }
  }
  if (!Object.keys(output).length && value != null) {
    throw new TypeError(`${label} is not a canonical frame payload.`);
  }
  return output;
}

function serializableCanonicalKeys(
  keys: TimelineKey[] | null | undefined,
  label: string,
  valueSerializer: (value: unknown, label: string) => JsonValue | UnknownRecord | undefined = serializableDtoValue,
) {
  return (keys || []).map((key, index) => ({
    tick: key.tick,
    value: valueSerializer(key.value, `${label}[${index}].value`),
  }));
}

function serializableCanonicalProperties(
  properties: TimelinePropertyTracks | null | undefined,
  label: string,
) {
  return Object.fromEntries(Object.entries(properties || {}).map(([name, keys]) => [
    name,
    serializableCanonicalKeys(keys, `${label}.${name}`),
  ]));
}

export function canonicalTimelineDto(state: Partial<CanonicalTimelineState> | null | undefined) {
  const tracks = (state?.tracks || []).map((track, index) => {
    const visual = track.kind !== 'audio';
    const output: UnknownRecord = {
      id: track.id,
      kind: track.kind,
      locked: !!track.locked,
      ...(!visual ? { name: track.name } : {}),
      ...(track.parentTrackId != null ? { parentTrackId: track.parentTrackId } : {}),
      ...(track.shapePathKind != null ? { shapePathKind: track.shapePathKind } : {}),
      ...(Array.isArray(track.shapePathComponents) ? {
        shapePathComponents: [...track.shapePathComponents],
      } : {}),
      ...(track.layer ? {
        layer: serializableCanonicalLayer(track.layer, `Canonical track ${index + 1} layer`),
      } : {}),
      ...(Object.keys(track.propertyTracks || {}).length ? {
        propertyTracks: serializableCanonicalProperties(
          track.propertyTracks,
          `Canonical track ${index + 1} properties`,
        ),
      } : {}),
    };
    if (Number.isFinite(Number(track['volume']))) output['volume'] = Number(track['volume']);
    if (track['muted']) output['muted'] = true;
    return output;
  });
  const clips = (state?.clips || []).map((clip, index) => {
    const output: UnknownRecord = {
      id: clip.id,
      trackId: clip.trackId,
      kind: clip.kind,
      startTick: clip.startTick,
      inTick: clip.inTick,
      outTick: clip.outTick,
      sourceDuration: clip.sourceDuration,
      frameKeys: serializableCanonicalKeys(
        clip.frameKeys,
        `Canonical clip ${index + 1} frames`,
        serializableCanonicalPayload,
      ),
      propertyTracks: serializableCanonicalProperties(
        clip.propertyTracks,
        `Canonical clip ${index + 1} properties`,
      ),
    };
    for (const field of [
      'assetId', 'inPoint', 'outPoint', 'playbackRate', 'volume', 'muted', 'name',
    ]) {
      if (clip[field] !== undefined) output[field] = clip[field];
    }
    return output;
  });
  return {
    tracks,
    clips,
    tags: normalizeTimelineTags(state?.tags, { allowMissing: true }),
  };
}

function serializableProject(mediaSnapshot: MediaRegistry = captureMediaRegistry()) {
  const canonical = canonicalTimelineDto(canonicalTimelineStateForSave());
  return {
    format: 'paintty-sprite',
    version: CURRENT_PROJECT_VERSION,
    projectId: get(projectId),
    width: GRID_W,
    height: GRID_H,
    fps: get(fps),
    timeline: canonical,
    media: serializeMediaRegistry(mediaSnapshot),
  };
}

export function serializeJSON(mediaSnapshot?: MediaRegistry): string {
  return JSON.stringify(serializableProject(mediaSnapshot));
}

export function serializeRecoverySnapshot() {
  const project = serializableProject();
  // Preserve panel state in recovery contents but exclude it from content-change deduplication.
  const contents = JSON.stringify(project);
  for (const track of project.timeline.tracks) {
    const layer = isUnknownRecord(track['layer']) ? track['layer'] : null;
    if (layer?.['type'] === 'group') delete layer['collapsed'];
  }
  return { contents, contentKey: JSON.stringify(project) };
}

function serializePreviewLayer(layer: ProjectLayer): UnknownRecord {
  return {
    ...serializeLayerMeta(layer),
    cells: serializableDtoValue(layer?.cells || {}, 'Preview layer cells'),
    offset: {
      x: Math.round(Number(layer?.offset?.x) || 0),
      y: Math.round(Number(layer?.offset?.y) || 0),
    },
  };
}

export function serializeLivePreview() {
  const source = createTimelineFrameSource();
  return JSON.stringify({
    format: 'paintty-preview',
    version: 1,
    width: GRID_W,
    height: GRID_H,
    fps: get(fps),
    tags: runtimeTimelineTags(getClipTimelineState().tags, source.frameCount),
    ticks: Array.from({ length: source.frameCount }, (_, tick) => ({
      layers: source.resolve(tick).layers.map(serializePreviewLayer),
    })),
  });
}

function currentOutputGrid() {
  const { w, h } = get(dims);
  const frame = get(frames)[get(activeFrameIndex)] || { layers: [] };
  return compositeFrameCells(frame, w, h, null, 0, 0, { referenceOpacity: false });
}

export function serializeTXT() {
  const { w, h } = get(dims);
  const g = normalizeOutputGrid(currentOutputGrid(), w, h);
  return g.map((row) => row.map((cell) => (
    cell?.cont ? '' : cell?.c || ' '
  )).join('')).join('\n');
}

export async function copyAsText() {
  try { await navigator.clipboard.writeText(serializeTXT()); return true; }
  catch { return false; }
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 5000);
}

export function releaseVideoSource(source: Parameters<typeof disposeVideoSource>[0]): void {
  disposeVideoSource(source);
}

let projectSaveTarget: SaveTarget | null = null;
let latestOpenRequest = 0;
const projectSaveQueues = new Map<number, Promise<unknown>>();

// Queue saves per project revision so repeated writes stay ordered while replacements invalidate old work.
function queueProjectSave<T>(revision: number, operation: () => T | Promise<T>): Promise<T> {
  const previous = projectSaveQueues.get(revision) || Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const tail = result.catch(() => {});
  projectSaveQueues.set(revision, tail);
  tail.finally(() => {
    if (projectSaveQueues.get(revision) === tail) projectSaveQueues.delete(revision);
  });
  return result;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot) : '';
}

export async function chooseSaveTarget(
  filename: string,
  type: string,
  description: string,
  { signal }: AbortOptions = {},
): Promise<SaveTarget | null> {
  throwIfAborted(signal);
  const selected = await pickExportFileTarget(filename, {
    extension: extensionOf(filename),
    mime: type,
    description,
  }, signal ? { signal } : {});
  if (selected !== undefined) return selected;
  throwIfAborted(signal);
  return {
    name: filename,
    durable: false,
    async write(blob: Blob, { signal: writeSignal = signal }: AbortOptions = {}) {
      throwIfAborted(writeSignal);
      downloadBlob(filename, blob);
      throwIfAborted(writeSignal);
    },
  };
}

async function saveText(
  filename: string,
  text: string,
  type: string,
  description: string,
  options: TextExportOptions = {},
): Promise<SaveTarget | false> {
  const { signal, chooseTarget = chooseSaveTarget } = options;
  throwIfAborted(signal);
  const blob = new Blob([text], { type });
  const target = await abortable(
    chooseTarget(filename, type, description, signal ? { signal } : {}),
    signal,
  );
  throwIfAborted(signal);
  if (!target) return false;
  await abortable(target.write(blob, signal ? { signal } : {}), signal);
  throwIfAborted(signal);
  return target;
}

async function withMediaLeases<T>(
  hashes: string[],
  operation: () => T | Promise<T>,
  index = 0,
): Promise<T> {
  if (index >= hashes.length) return operation();
  return withMediaLease(hashes[index]!, () => withMediaLeases(hashes, operation, index + 1));
}

// Lease every captured hash before reading any blob so GC cannot remove bytes from
// an archive while it is being assembled.
async function encodeRegistrySnapshot(contents: string, registry: MediaRegistry): Promise<Blob> {
  const hashes = [...new Set(registry.assets.map((asset) => asset.hash))];
  return withMediaLeases(hashes, async () => {
    const mediaBlobs = new Map();
    for (const asset of registry.assets) {
      if (mediaBlobs.has(asset.hash)) continue;
      const record = await getProjectAsset(asset.hash);
      if (!record?.blob) throw new Error(`Media bytes are missing for ${asset.sourceName}.`);
      mediaBlobs.set(asset.hash, record.blob);
    }
    return await encodeProjectArchive({ document: contents, mediaRegistry: registry, mediaBlobs }) as Blob;
  });
}

export async function saveJSON({
  saveAs = false,
  chooseTarget = chooseSaveTarget,
  serialize = serializeJSON,
  checkpoint = notifyProjectCheckpoint,
  notifySaved = notifyProjectSaved,
  reportRecoveryError = (error: unknown) => console.warn('Recovery could not record the saved project.', error),
  reportUnverifiedSave = () => notifyInfo('Download created; project remains unsaved.'),
}: SaveJsonOptions = {}): Promise<boolean> {
  const revision = captureProjectRevision();
  const name = get(fileName) || 'untitled';
  const packaged = serialize === serializeJSON && (saveAs || !/\.json$/i.test(name));
  // Freeze document text and media metadata before entering the per-revision queue;
  // later edits cannot change the bytes represented by this save.
  const mediaSnapshot = packaged ? captureMediaRegistry() : null;
  const contents = mediaSnapshot ? serialize(mediaSnapshot) : serialize();
  const blobPromise = packaged
    ? encodeRegistrySnapshot(contents, mediaSnapshot!)
    : Promise.resolve(new Blob([contents], { type: 'application/json' }));
  const checkpointResult = Promise.resolve()
    .then(() => checkpoint({ contents, fileName: name }))
    .then(
      () => ({ ok: true } as const),
      (error: unknown) => ({ ok: false, error } as const),
    );
  return queueProjectSave(revision, async () => {
    const checkpointStatus = await checkpointResult;
    if (!checkpointStatus.ok) reportRecoveryError(checkpointStatus.error);
    if (!isProjectRevisionCurrent(revision)) return false;
    const target = !saveAs && projectSaveTarget
      ? projectSaveTarget
      : await chooseTarget(
         packaged
           ? `${name.replace(/\.(?:paintty|json)$/i, '') || 'untitled'}.paintty`
           : (/\.json$/i.test(name) ? name : `${name}.json`),
         packaged ? 'application/zip' : 'application/json',
         packaged ? 'Paintty project' : 'Paintty JSON project',
      );
    if (!target) return false;
    if (!isProjectRevisionCurrent(revision)) return false;
    await target.write(await blobPromise);
    if (!isProjectRevisionCurrent(revision)) return true;
    if (target.durable === false) {
      // A browser download cannot prove durable completion, so it never clears dirty state.
      reportUnverifiedSave();
      return true;
    }
    projectSaveTarget = target;
    fileName.set(target.name);
    let currentContents = null;
    try { currentContents = serialize(); } catch {}
    const unchanged = currentContents === contents;
    dirty.set(!unchanged);
    try {
      let recentId = saveAs ? null : get(recentProjectIdentity);
      if (!recentId) {
        recentId = createRecentProjectId();
        recentProjectIdentity.set(recentId);
      }
      await notifySaved({ contents, currentContents, fileName: target.name, recentId });
    } catch (error) {
      reportRecoveryError(error);
    }
    scheduleMediaCacheGc();
    return true;
  });
}

export function saveJSONAs(options: SaveJsonOptions = {}): Promise<boolean> {
  return saveJSON({ ...options, saveAs: true });
}

export async function exportTXT(options: TextExportOptions = {}): Promise<boolean> {
  throwIfAborted(options.signal);
  const name = (get(fileName) || 'untitled').replace(/\.json$/i, '');
  const filename = normalizeExportFilename(options.filename ?? name, '.txt', name);
  return !!(await saveText(filename, serializeTXT(), 'text/plain', 'Text', options));
}

export async function exportANSI(options: TextExportOptions = {}): Promise<boolean> {
  throwIfAborted(options.signal);
  const name = (get(fileName) || 'untitled').replace(/\.json$/i, '');
  const filename = normalizeExportFilename(options.filename ?? name, '.ans', name);
  return !!(await saveText(filename, frameToAnsi(), 'text/plain', 'ANSI text', options));
}

export async function exportJSON(download = false): Promise<boolean> {
  if (!download) return saveJSONAs();
  const name = (get(fileName) || 'untitled').replace(/\.json$/i, '');
  const filename = `${name}.json`;
  downloadBlob(filename, new Blob([serializeJSON()], { type: 'application/json' }));
  return true;
}

export function currentAnimationExportPlan({
  includeAudio = false,
}: { includeAudio?: boolean } = {}): AnimationExportPlan {
  const audioState = audioStateForSave();
  const registry = captureMediaRegistry();
  const durationTicks = clipTimelineDurationTicks(getClipTimelineState());
  const captured = capturedAudibleAudioAssets(audioState.tracks, registry, {
    durationTicks,
    fps: Math.max(1, Number(get(fps)) || DEFAULT_FPS),
  });
  return planAnimationExport({
    fileName: get(fileName),
    includeAudio,
    hasAudio: captured.length > 0,
    audioCount: captured.length,
  });
}

function capturedAudibleAudioAssets(
  tracks: SavedAudioTrack[],
  registry: MediaRegistry,
  {
  durationTicks,
  fps: rate,
  runtimeAssets = [],
}: {
  durationTicks: number;
  fps: number;
  runtimeAssets?: AudioRuntimeAsset[];
}): CapturedAudioAsset[] {
  const registryAudio = registry.assets
    .filter((asset) => asset.kind === 'audio')
    .map((asset) => ({ ...asset, id: asset.assetId }));
  const audible = audibleTimelineAudioAssetIds({
    assets: registryAudio,
    tracks,
    durationTicks,
    fps: rate,
  });
  const runtimeById = new Map(runtimeAssets.map((asset) => [String(asset.id), asset]));
  return registry.assets
    .filter((asset): asset is Extract<MediaAsset, { kind: 'audio' }> => (
      asset.kind === 'audio' && audible.has(String(asset.assetId))
    ))
    .map((asset) => {
      const runtime = runtimeById.get(String(asset.assetId));
      const key = `${asset.assetId}:${asset.hash}:${asset.generation}`;
      const buffer = runtime?.buffer &&
        (!runtime.runtimeMediaKey || runtime.runtimeMediaKey === key)
        ? runtime.buffer
        : null;
      return {
        id: asset.assetId,
        size: asset.size,
        duration: asset.duration,
        hash: asset.hash,
        generation: asset.generation,
        buffer,
      };
    });
}

// Capture durable state and enforce memory bounds before resolving every visual frame.
function prepareAnimationExport(
  { includeAudio, filename }: { includeAudio: boolean; filename?: string },
  dependencies: AnimationExportDependencies = {},
): AnimationSnapshot {
  const size = get(dims);
  const dimensions = { w: size.w, h: size.h };
  const rate = Math.max(1, Number(get(fps)) || DEFAULT_FPS);
  const timelineState = getClipTimelineState();
  const initialDurationTicks = clipTimelineDurationTicks(timelineState);
  const estimateVisualResources = dependencies.estimateVisualResources ||
    estimateAnimationVisualExportResources;
  let visualResources = estimateVisualResources({
    frameCount: initialDurationTicks,
    columns: dimensions.w,
    rows: dimensions.h,
  });
  const audioState = audioStateForSave();
  const mediaSnapshot = captureMediaRegistry();
  const audioAssetSnapshots: CapturedAudioAsset[] = includeAudio ? capturedAudibleAudioAssets(
    audioState.tracks,
    mediaSnapshot,
    {
      durationTicks: initialDurationTicks,
      fps: rate,
      runtimeAssets: get(audioAssets),
    },
  ) : [];
  const estimateResources = dependencies.estimateAudioResources ||
    estimateAnimationAudioExportResources;
  let resources = audioAssetSnapshots.length ? estimateResources({
    assets: audioAssetSnapshots,
    durationTicks: initialDurationTicks,
    fps: rate,
  }) : null;
  const createFrameSource = dependencies.createFrameSource || createTimelineFrameSource;
  const source = createFrameSource();
  if (source.frameCount !== initialDurationTicks) {
    visualResources = estimateVisualResources({
      frameCount: source.frameCount,
      columns: dimensions.w,
      rows: dimensions.h,
    });
  }
  if (resources && source.frameCount !== initialDurationTicks) {
    resources = estimateResources({
      assets: audioAssetSnapshots,
      durationTicks: source.frameCount,
      fps: rate,
    });
  }
  const plan = planAnimationExport({
    fileName: filename ?? get(fileName),
    includeAudio,
    hasAudio: audioAssetSnapshots.length > 0,
    audioCount: audioAssetSnapshots.length,
  });
  const tags = timelineState.tags.map((tag) => ({ ...tag }));
  return Object.freeze({
    filename: filename ?? get(fileName),
    plan,
    source,
    resources,
    visualResources,
    dimensions,
    fps: rate,
    durationTicks: source.frameCount,
    tags,
    includeAudio: !!includeAudio,
    audioTracks: audioState.tracks,
    audioAssets: audioAssetSnapshots,
    hashes: [...new Set(audioAssetSnapshots.map((asset) => asset.hash))],
  });
}

async function resolveAnimationVisuals(
  snapshot: AnimationSnapshot,
  dependencies: AnimationExportDependencies = {},
) {
  const { signal, onProgress = () => {} } = dependencies;
  const yieldControl = dependencies.visualYieldControl || defaultYield;
  const yieldInterval = Math.max(1, Math.round(Number(dependencies.visualYieldInterval)) || 8);
  const composite = dependencies.compositeAnimationFrame || compositeFrameCells;
  const createAssembler = dependencies.createAnimationAssembler || createAnimationDocumentAssembler;
  const accountFrame = dependencies.accountVisualFrame || accountAnimationVisualFrame;
  const validateJson = dependencies.validateVisualJson || validateAnimationVisualJsonResources;
  const resolvedFrames: AnimationRuntimeFrame[] = [];
  let assembler: AnimationAssembler | null = null;
  let resources = snapshot.visualResources;
  onProgress({ completed: 0, total: snapshot.source.frameCount, phase: 'resolving-animation' });
  for (let index = 0; index < snapshot.source.frameCount; index++) {
    throwIfAborted(signal);
    const resolved = snapshot.source.resolve(index);
    throwIfAborted(signal);
    const compositeCells = composite(
      resolved,
      snapshot.dimensions.w,
      snapshot.dimensions.h,
    );
    assembler ||= createAssembler({
      dimensions: snapshot.dimensions,
      fps: snapshot.fps,
      frames: [resolved],
      layerMetadata: resolved?.layers || [],
    });
    const runtimeFrame = assembler.frame(
      resolved,
      index,
      snapshot.source.frameCount,
      compositeCells,
    );
    resources = accountFrame(resources, runtimeFrame);
    resolvedFrames.push(runtimeFrame);
    onProgress({
      completed: index + 1,
      total: snapshot.source.frameCount,
      phase: 'resolving-animation',
    });
    if ((index + 1) % yieldInterval === 0 && index + 1 < snapshot.source.frameCount) {
      await abortable(yieldControl(), signal);
    }
  }
  resources = validateJson(resources, { layers: assembler!.layers, tags: snapshot.tags });
  return { assembler: assembler!, frames: resolvedFrames, resources };
}

const pendingAnimationAudioDecodes = new Map<string, Promise<AudioBuffer>>();

function capturedAudioDecodeKey(asset: CapturedAudioAsset): string {
  return `${asset.hash}:${asset.generation}`;
}

function sharedAnimationAudioDecode(
  asset: CapturedAudioAsset,
  blob: Blob,
  decodeAudio: AnimationAudioDecoder,
): Promise<AudioBuffer> {
  const key = capturedAudioDecodeKey(asset);
  const existing = pendingAnimationAudioDecodes.get(key);
  if (existing) return existing;
  const pending = Promise.resolve()
    .then(() => decodeAudio(blob, { asset }))
    .then((decoded) => decoded instanceof AudioBuffer ? decoded : decoded.buffer!);
  pendingAnimationAudioDecodes.set(key, pending);
  const release = () => {
    if (pendingAnimationAudioDecodes.get(key) === pending) {
      pendingAnimationAudioDecodes.delete(key);
    }
  };
  pending.then(release, release);
  return pending;
}

async function resolveCapturedAudioBuffers(
  assets: CapturedAudioAsset[],
  {
    signal,
    getAsset,
    decodeAudio,
  }: {
    signal?: AbortSignal;
    getAsset: (hash: unknown) => Promise<ProjectAssetRecord | null>;
    decodeAudio: AnimationAudioDecoder;
  },
) {
  const buffers = new Map<string, AudioBuffer>();
  for (const asset of assets) {
    const key = capturedAudioDecodeKey(asset);
    if (asset.buffer && !buffers.has(key)) buffers.set(key, asset.buffer);
  }
  for (const asset of assets) {
    const key = capturedAudioDecodeKey(asset);
    if (buffers.has(key)) continue;
    throwIfAborted(signal);
    const record = await abortable(getAsset(asset.hash), signal);
    throwIfAborted(signal);
    if (!record?.blob) throw new Error('Captured Animation audio bytes are missing.');
    if (record.hash !== asset.hash || record.blob.size !== asset.size) {
      throw new Error('Captured Animation audio bytes changed before decoding.');
    }
    const pendingDecode = sharedAnimationAudioDecode(asset, record.blob, decodeAudio);
    const decoded = await abortable(pendingDecode, signal);
    throwIfAborted(signal);
    const buffer = decoded;
    if (!buffer || !Number.isFinite(Number(buffer.duration)) || Number(buffer.duration) <= 0) {
      throw new Error('Animation audio decoding did not return a valid PCM buffer.');
    }
    buffers.set(key, buffer);
  }
  return assets.map((asset) => ({
    id: asset.id,
    hash: asset.hash,
    generation: asset.generation,
    size: asset.size,
    buffer: buffers.get(capturedAudioDecodeKey(asset))!,
  }));
}

async function acquireReferencedAudioRuntime(): Promise<{
  assets: AudioRuntimeAsset[];
  release(): void;
}> {
  const leases = new Map<string, MediaLease<unknown>>();
  const assetIds = new Set(get(audioClips).map((clip) => clip.assetId));
  await Promise.all([...assetIds].map(async (assetId) => {
    try {
      leases.set(assetId, await acquireMediaResource(assetId));
    } catch {}
  }));
  return {
    assets: get(audioAssets).map((asset) => ({
      ...asset,
      buffer: (leases.get(asset.id)?.value as { buffer?: AudioBuffer } | undefined)?.buffer ||
        asset.buffer || null,
    })),
    release() {
      for (const lease of leases.values()) lease.release();
      leases.clear();
    },
  };
}

export async function exportAnimation(
  options: AnimationExportDependencies = {},
): Promise<boolean> {
  const {
    includeAudio = false,
    filename,
    download = false,
    chooseTarget = chooseSaveTarget,
    getAsset = getProjectAsset,
    signal,
  } = options;
  throwIfAborted(signal);
  const snapshot = prepareAnimationExport({
    includeAudio,
    ...(filename !== undefined ? { filename } : {}),
  }, options);
  throwIfAborted(signal);
  let pendingTarget: Promise<SaveTarget | null> | null = null;
  if (!download) {
    // Invoke the selector in the original click turn so the native picker retains user activation.
    pendingTarget = Promise.resolve(chooseTarget(
      snapshot.plan.filename,
      snapshot.plan.mime,
      snapshot.plan.description,
      signal ? { signal } : {},
    ));
  }
  return withMediaLeases(snapshot.hashes, async () => {
    const target = download ? null : await abortable(pendingTarget, signal);
    throwIfAborted(signal);
    if (!download && !target) return false;
    const visual = await resolveAnimationVisuals(snapshot, options);
    throwIfAborted(signal);
    const decodeAudio = options.decodeAudio ||
      decodeAudioSource as unknown as AnimationAudioDecoder;
    const runtimeAudio = snapshot.audioAssets.length
      ? await resolveCapturedAudioBuffers(snapshot.audioAssets, {
        ...(signal ? { signal } : {}),
        getAsset,
        decodeAudio,
      })
      : [];
    throwIfAborted(signal);
    if (runtimeAudio.length) {
      const validateResources = options.validateDecodedAudioResources ||
        validateDecodedAnimationAudioExportResources;
      validateResources({
        assets: runtimeAudio,
        numberOfFrames: snapshot.resources!.numberOfFrames,
      });
    }
    const createAudioPlan = options.createAudioPlan || createTimelineAudioPlan;
    const audioPlan = runtimeAudio.length ? createAudioPlan({
      assets: runtimeAudio,
      tracks: snapshot.audioTracks,
      durationTicks: snapshot.durationTicks,
      fps: snapshot.fps,
      exactDuration: true,
    }) : null;
    if (snapshot.plan.includeAudio && !audioPlan) {
      throw new Error('Captured audible Animation audio could not be mixed.');
    }
    if (audioPlan && audioPlan.numberOfFrames !== snapshot.resources!.numberOfFrames) {
      throw new Error('Animation audio duration changed after resource preflight.');
    }
    const encodeWav = options.encodeTimelineWav || encodeTimelineWav;
    const audioBytes = audioPlan
      ? await encodeWav(
        audioPlan,
        options as unknown as Parameters<typeof encodeTimelineWav>[1],
      )
      : null;
    throwIfAborted(signal);
    const document = visual.assembler.document(visual.frames, {
      tags: snapshot.tags,
      exportPlan: snapshot.plan,
      ...(audioPlan && audioBytes ? { audio: { durationUs: audioPlan.durationUs } } : {}),
    });
    const json = serializeAnimationJSON(document);
    const blob: Blob = snapshot.plan.kind === 'zip'
      ? await encodeAnimationZip({
        plan: snapshot.plan,
        json,
        audioBytes,
        output: 'blob',
        ...(signal ? { signal } : {}),
        ...(options.zipYieldControl ? { yieldControl: options.zipYieldControl } : {}),
      }) as Blob
      : new Blob([json], { type: 'application/json' });
    throwIfAborted(signal);
    if (download) {
      downloadBlob(snapshot.plan.filename, blob);
      throwIfAborted(signal);
      return true;
    }
    await abortable(target!.write(blob, signal ? { signal } : {}), signal);
    throwIfAborted(signal);
    return true;
  });
}

export function frameToAnsi() {
  return frameToAnsiText(currentOutputGrid());
}

export function frameToTerminalCommand() {
  return frameToBashCommand(currentOutputGrid());
}

function frameToPowerShellCommand() {
  return renderPowerShellCommand(currentOutputGrid());
}

export async function copyForTerminal() {
  try { await navigator.clipboard.writeText(frameToTerminalCommand()); return true; }
  catch { return false; }
}
export async function copyForPowerShell() {
  try { await navigator.clipboard.writeText(frameToPowerShellCommand()); return true; }
  catch { return false; }
}

async function renderImageSnapshot(
  snapshot: ImageSnapshot,
  {
    format,
    type,
    createCanvas,
    signal,
  }: {
    format: string;
    type: string;
    createCanvas: () => HTMLCanvasElement;
    signal?: AbortSignal;
  },
): Promise<Blob> {
  throwIfAborted(signal);
  const { cells, width, height, cellWidth, cellHeight, font } = snapshot;
  const canvas = createCanvas();
  canvas.width = width * cellWidth;
  canvas.height = height * cellHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(cellHeight * 0.9)}px ${font}`;
  paintOutputGrid(ctx, cells, width, height, cellWidth, cellHeight,
    format === 'jpg' || format === 'jpeg' ? '#000' : undefined);
  const blob = await abortable(new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error('Could not encode image.')),
    type,
    0.92,
  )), signal);
  throwIfAborted(signal);
  return blob;
}

export async function saveAsImage(
  format = 'png',
  cellPx = 16,
  dependencies: ImageExportDependencies = {},
): Promise<boolean> {
  const { signal } = dependencies;
  throwIfAborted(signal);
  const normalizedFormat = format === 'jpeg' ? 'jpg' : format;
  const spec = exportOutputSpec(normalizedFormat);
  const type = spec.mime;
  const name = (get(fileName) || 'untitled').replace(/\.json$/i, '');
  const filename = normalizeExportFilename(dependencies.filename ?? name, spec.extension, name);
  const size = get(dims);
  // Rendering and picker work are asynchronous, so capture cells, geometry, and font first.
  const snapshot = {
    cells: normalizeOutputGrid(currentOutputGrid(), size.w, size.h),
    width: size.w,
    height: size.h,
    cellWidth: cellPx,
    cellHeight: cellPx * 2,
    font: get(canvasFont),
  };
  const chooseTarget = dependencies.chooseTarget || chooseSaveTarget;
  const render = dependencies.render || renderImageSnapshot;
  const download = dependencies.download === true;
  const pendingTarget = download ? null : Promise.resolve(chooseTarget(
    filename,
    type,
    spec.description,
    signal ? { signal } : {},
  ));
  const target = download ? null : await abortable(pendingTarget, signal);
  throwIfAborted(signal);
  if (!download && !target) return false;
  const blob = await abortable(Promise.resolve().then(() => render(snapshot, {
    format,
    type,
    createCanvas: dependencies.createCanvas || (() => document.createElement('canvas')),
    ...(signal ? { signal } : {}),
  })), signal);
  throwIfAborted(signal);
  if (download) {
    downloadBlob(filename, blob);
    throwIfAborted(signal);
    return true;
  }
  await abortable(target!.write(blob, signal ? { signal } : {}), signal);
  throwIfAborted(signal);
  return true;
}

function paintFrameToCtx(
  ctx: CanvasRenderingContext2D,
  cells: OutputGrid,
  w: number,
  h: number,
  cw: number,
  ch: number,
  font: string,
): void {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(ch * 0.9)}px ${font}`;
  paintOutputGrid(ctx, cells, w, h, cw, ch, '#000');
}

export function videoFramePlan(
  frameDefs: VideoFrameDefinition[],
  frameRate: unknown,
): VideoFrameSample[] {
  const rate = Math.max(1, Number(frameRate) || DEFAULT_FPS);
  const duration = 1 / rate;
  const plan: VideoFrameSample[] = [];
  let outputIndex = 0;
  for (let sourceIndex = 0; sourceIndex < frameDefs.length; sourceIndex++) {
    const frame = frameDefs[sourceIndex]!;
    const ticks = Math.max(1, frame.hold || 1);
    for (let tick = 0; tick < ticks; tick++) {
      plan.push({
        sourceIndex,
        tick,
        timestamp: outputIndex / rate,
        duration,
      });
      outputIndex++;
    }
  }
  return plan;
}

export function videoFrameCells(
  frame: Parameters<typeof compositeFrameCells>[0],
  w: number,
  h: number,
  timestamp = 0,
) {
  const blinkVisible = Math.floor(Math.max(0, timestamp) * 2) % 2 === 0;
  const cells = compositeFrameCells(frame, w, h, null, 0, 0, { referenceOpacity: false });
  return applyBlinkPhase(normalizeOutputGrid(cells, w, h), blinkVisible);
}

export const MP4_EXPORT_FORMAT = Object.freeze({
  label: 'MP4',
  extension: 'mp4',
  mime: 'video/mp4',
  pickerMime: 'video/mp4',
  description: 'MP4 video',
});

export function videoRenderGeometry(width: unknown, height: unknown, cellPx: unknown) {
  let cellWidth = Math.max(1, Math.round(Number(cellPx) || 16));
  if (cellWidth % 2) cellWidth++;
  const cellHeight = cellWidth * 2;
  return {
    width: Math.max(1, Math.round(Number(width) || 1)),
    height: Math.max(1, Math.round(Number(height) || 1)),
    cellWidth,
    cellHeight,
  };
}

const H264_CODEC = 'avc1.420028';
const VIDEO_BITRATE = 8_000_000;

export function selectVideoExportFormat({
  VideoEncoderClass = globalThis.VideoEncoder,
  VideoFrameClass = globalThis.VideoFrame,
  createFrameImage = globalThis.createImageBitmap,
}: {
  VideoEncoderClass?: typeof VideoEncoder;
  VideoFrameClass?: typeof VideoFrame;
  createFrameImage?: typeof createImageBitmap;
} = {}): typeof MP4_EXPORT_FORMAT | null {
  const hasWebCodecs = typeof VideoEncoderClass === 'function'
    && typeof VideoFrameClass === 'function'
    && typeof VideoEncoderClass.isConfigSupported === 'function'
    && typeof createFrameImage === 'function';
  return hasWebCodecs ? MP4_EXPORT_FORMAT : null;
}

function h264EncoderConfig(width: number, height: number, rate: number): VideoEncoderConfig {
  return {
    codec: H264_CODEC,
    width,
    height,
    bitrate: VIDEO_BITRATE,
    framerate: rate,
    latencyMode: 'realtime',
    avc: { format: 'avc' },
  };
}

function copyBytes(source: AllowSharedBufferSource): Uint8Array {
  if (source instanceof Uint8Array) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  }
  return new Uint8Array(source);
}

function encodedTicks(plan: VideoFrameSample[], rate: number) {
  return plan.map((sample, outputIndex) => {
    const timestamp = Math.round(outputIndex * 1_000_000 / rate);
    const end = Math.round((outputIndex + 1) * 1_000_000 / rate);
    return { ...sample, timestamp, duration: end - timestamp };
  });
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  if (typeof DOMException === 'function') return new DOMException('Export cancelled.', 'AbortError');
  const error = new Error('Export cancelled.');
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

async function createImmutableFrameImage(
  canvas: HTMLCanvasElement,
  createFrameImage: typeof createImageBitmap,
  signal?: AbortSignal,
): Promise<ImageBitmap> {
  const pending = Promise.resolve().then(() => createFrameImage(canvas));
  let image: ImageBitmap | null = null;
  try {
    image = await abortable(pending, signal);
    throwIfAborted(signal);
    return image;
  } catch (error) {
    if (image) image.close?.();
    else if (signal?.aborted) pending.then((value) => value?.close?.()).catch(() => {});
    throw error;
  }
}

async function waitForEncoderCapacity(
  encoder: VideoEncoder,
  signal: AbortSignal | undefined,
  yieldControl: () => void | Promise<void>,
  outputError: () => Error | null,
  limit = 8,
): Promise<void> {
  while (encoder.encodeQueueSize >= limit) {
    await abortable(yieldControl(), signal);
    throwIfAborted(signal);
    const error = outputError();
    if (error) throw error;
  }
}

function unsupportedH264(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = 'H264_UNSUPPORTED';
  return error;
}

async function loadH264Muxer() {
  const { muxH264Mp4 } = await import('./mp4.js');
  return muxH264Mp4;
}

async function preflightH264Encoder(canvas: HTMLCanvasElement, rate: number, {
  VideoEncoderClass = globalThis.VideoEncoder,
  VideoFrameClass = globalThis.VideoFrame,
  createFrameImage = globalThis.createImageBitmap,
}: VideoExportDependencies = {}): Promise<H264Preflight> {
  if (typeof VideoEncoderClass !== 'function' || typeof VideoFrameClass !== 'function') {
    throw unsupportedH264('This browser does not provide WebCodecs H.264 encoding.');
  }
  if (typeof VideoEncoderClass.isConfigSupported !== 'function') {
    throw unsupportedH264('This browser cannot check H.264 encoder support.');
  }
  if (typeof createFrameImage !== 'function') {
    throw unsupportedH264('This browser cannot create stable video frame snapshots.');
  }

  const config = h264EncoderConfig(canvas.width, canvas.height, rate);
  const support = await VideoEncoderClass.isConfigSupported(config);
  if (!support?.supported) {
    throw unsupportedH264('This browser does not support H.264 MP4 encoding at this size.');
  }
  return { VideoEncoderClass, VideoFrameClass, createFrameImage, config };
}

async function encodeVideoWithSupportedH264({
  canvas,
  ctx,
  frameDefs,
  resolveFrame,
  plan,
  width,
  height,
  cellWidth,
  cellHeight,
  font,
  rate,
  audioPlan,
}: VideoRenderArgs, dependencies: VideoExportDependencies = {}, {
  VideoEncoderClass,
  VideoFrameClass,
  createFrameImage,
  config,
}: H264Preflight): Promise<Uint8Array> {
  const {
    mux,
    loadMux = loadH264Muxer,
    signal,
    onProgress = () => {},
    yieldControl = defaultYield,
  } = dependencies;
  const ticks = encodedTicks(plan, rate);
  const samples: EncodedVideoSample[] = [];
  let avcDecoderConfig: Uint8Array | null = null;
  let outputError: Error | null = null;
  let encoderClosed = false;
  throwIfAborted(signal);
  const encoder = new VideoEncoderClass({
    output(chunk, metadata) {
      const expected = ticks[samples.length];
      if (!expected) {
        outputError ||= new Error('The H.264 encoder produced extra frames.');
        return;
      }
      if (chunk.timestamp !== expected.timestamp) {
        outputError ||= new Error('The H.264 encoder returned frames out of order.');
      }
      if (chunk.duration != null && chunk.duration !== expected.duration) {
        outputError ||= new Error('The H.264 encoder changed a frame duration.');
      }
      if (!avcDecoderConfig && metadata?.decoderConfig?.description) {
        avcDecoderConfig = copyBytes(metadata.decoderConfig.description);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, key: chunk.type === 'key' });
    },
    error(error) {
      outputError ||= error instanceof Error ? error : new Error(String(error));
    },
  });

  const closeEncoder = () => {
    if (encoderClosed) return;
    encoderClosed = true;
    try { encoder.close?.(); } catch {}
  };
  const cancelEncoding = () => closeEncoder();
  signal?.addEventListener('abort', cancelEncoding, { once: true });

  let activeSourceIndex = -1;
  let activeFrame: Parameters<typeof videoFrameCells>[0] | null = null;
  try {
    encoder.configure(config);
    onProgress({ completed: 0, total: ticks.length, phase: 'rendering' });
    for (let outputIndex = 0; outputIndex < ticks.length; outputIndex++) {
      throwIfAborted(signal);
      const tick = ticks[outputIndex]!;
      if (tick.sourceIndex !== activeSourceIndex) {
        activeFrame = (resolveFrame
          ? resolveFrame(tick.sourceIndex)
          : frameDefs[tick.sourceIndex]) as Parameters<typeof videoFrameCells>[0];
        activeSourceIndex = tick.sourceIndex;
      }
      const cells = videoFrameCells(activeFrame!, width, height, tick.timestamp / 1_000_000);
      paintFrameToCtx(ctx, cells, width, height, cellWidth, cellHeight, font);
      const frameImage = await createImmutableFrameImage(canvas, createFrameImage, signal);
      let videoFrame = null;
      try {
        if (outputError) throw outputError;
        videoFrame = new VideoFrameClass(frameImage, {
          timestamp: tick.timestamp,
          duration: tick.duration,
        });
        encoder.encode(videoFrame, { keyFrame: outputIndex % rate === 0 });
      } finally {
        videoFrame?.close();
        frameImage?.close?.();
      }
      await waitForEncoderCapacity(encoder, signal, yieldControl, () => outputError);
      if (outputError) throw outputError;
      onProgress({ completed: outputIndex + 1, total: ticks.length, phase: 'rendering' });
      if ((outputIndex + 1) % 8 === 0 && outputIndex + 1 < ticks.length) {
        await abortable(yieldControl(), signal);
      }
    }
    activeFrame = null;
    throwIfAborted(signal);
    await abortable(encoder.flush(), signal);
  } finally {
    activeFrame = null;
    signal?.removeEventListener('abort', cancelEncoding);
    closeEncoder();
  }

  throwIfAborted(signal);
  if (outputError) throw outputError;
  if (samples.length !== ticks.length) {
    throw new Error('The H.264 encoder produced ' + samples.length + ' of ' + ticks.length + ' frames.');
  }
  const finalAvcDecoderConfig = avcDecoderConfig as Uint8Array | null;
  if (!finalAvcDecoderConfig?.length) {
    throw new Error('The H.264 encoder did not provide an AVC decoder configuration.');
  }
  let audio = null;
  if (audioPlan) {
    const encodeAudioTrack = dependencies.encodeTimelineAudio || encodeTimelineAudio;
    audio = await encodeAudioTrack(
      audioPlan,
      dependencies as unknown as Parameters<typeof encodeTimelineAudio>[1],
      dependencies.audioPreflight,
    );
    throwIfAborted(signal);
  }
  const muxVideo = (mux || await loadMux()) as unknown as (
    options: UnknownRecord,
  ) => Uint8Array;
  throwIfAborted(signal);
  const muxArgs = {
    samples,
    avcDecoderConfig: finalAvcDecoderConfig,
    width: canvas.width,
    height: canvas.height,
    timescale: rate,
    ...(audio ? { audio } : {}),
  };
  const output = muxVideo(muxArgs as UnknownRecord);
  throwIfAborted(signal);
  return output;
}

export async function encodeVideoWithWebCodecs(
  args: VideoRenderArgs,
  dependencies: VideoExportDependencies = {},
): Promise<Uint8Array> {
  throwIfAborted(dependencies.signal);
  const preflight = await preflightH264Encoder(args.canvas, args.rate, dependencies);
  throwIfAborted(dependencies.signal);
  return encodeVideoWithSupportedH264(args, dependencies, preflight);
}

export async function exportVideo(
  cellPx = 16,
  download = false,
  dependencies: VideoExportDependencies = {},
): Promise<boolean> {
  const { signal } = dependencies;
  throwIfAborted(signal);
  const format = MP4_EXPORT_FORMAT;
  const name = (get(fileName) || 'untitled').replace(/\.json$/i, '');
  const filename = normalizeExportFilename(
    dependencies.filename ?? name,
    `.${format.extension}`,
    name,
  );
  const geometry = videoRenderGeometry(get(dims).w, get(dims).h, cellPx);
  const { width, height, cellWidth, cellHeight } = geometry;
  const font = get(canvasFont);
  const rate = Math.max(1, Math.round(Number(get(fps)) || DEFAULT_FPS));
  const createFrameSource = dependencies.createFrameSource || createTimelineFrameSource;
  const frameSource = createFrameSource();
  const frameDefs = frameSource.holds.map((hold: number) => ({ hold }));
  const plan = videoFramePlan(frameDefs, rate);
  const suppliedAudioState = typeof dependencies.getAudioState === 'function'
    ? dependencies.getAudioState()
    : dependencies.audioState;
  const audioState = typeof suppliedAudioState === 'function'
    ? suppliedAudioState()
    : suppliedAudioState;
  const hasSuppliedAudioState = audioState != null;
  const chooseTarget = dependencies.chooseTarget || chooseSaveTarget;
  const pendingTarget = download ? null : Promise.resolve(chooseTarget(
    filename,
    format.pickerMime,
    format.description,
    signal ? { signal } : {},
  ));
  const target = download ? null : await abortable(pendingTarget, signal);
  throwIfAborted(signal);
  if (!download && !target) return false;
  const suppliedAssets = isUnknownRecord(audioState) && Array.isArray(audioState['assets'])
    ? audioState['assets'].filter(isUnknownRecord)
    : [];
  const suppliedTracks = isUnknownRecord(audioState) && Array.isArray(audioState['tracks'])
    ? audioState['tracks'].filter(isUnknownRecord)
    : [];
  const suppliedClips = isUnknownRecord(audioState) && Array.isArray(audioState['clips'])
    ? audioState['clips'].filter(isUnknownRecord)
    : undefined;
  const audioRuntime = hasSuppliedAudioState
    ? { assets: suppliedAssets, release() {} }
    : await acquireReferencedAudioRuntime();
  try {
    const planAudio = dependencies.createAudioPlan || createTimelineAudioPlan;
    const audioPlan = planAudio({
      assets: audioRuntime.assets,
      tracks: hasSuppliedAudioState ? suppliedTracks : get(audioTracks),
      ...(hasSuppliedAudioState
        ? (suppliedClips ? { clips: suppliedClips } : {})
        : { clips: get(audioClips) }),
      durationTicks: plan.length,
      fps: rate,
    });
    const canvas = dependencies.createCanvas?.() || document.createElement('canvas');
    canvas.width = width * cellWidth;
    canvas.height = height * cellHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create the MP4 render canvas.');
    const preflight = await (dependencies.preflight || preflightH264Encoder)(
      canvas,
      rate,
      dependencies,
    );
    throwIfAborted(signal);
    let audioPreflight: Awaited<ReturnType<typeof preflightAacEncoder>> | null = null;
    if (audioPlan) {
      audioPreflight = dependencies.preflightAudio
        ? await dependencies.preflightAudio(audioPlan, dependencies)
        : await preflightAacEncoder(
          dependencies as unknown as Parameters<typeof preflightAacEncoder>[0],
        );
      throwIfAborted(signal);
    }

    const args = {
      canvas,
      ctx,
      frameDefs,
      resolveFrame: frameSource.resolve,
      plan,
      width,
      height,
      cellWidth,
      cellHeight,
      font,
      rate,
      audioPlan,
    };
    let output;
    try {
      const encodeVideo = dependencies.encodeVideo || encodeVideoWithSupportedH264;
      const encodeDependencies = audioPlan
        ? { ...dependencies, audioPreflight }
        : dependencies;
      output = await encodeVideo(args, encodeDependencies, preflight);
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw abortError(signal);
      }
      if (isUnknownRecord(error) &&
        (error['code'] === 'H264_UNSUPPORTED' || error['code'] === 'AAC_UNSUPPORTED')) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`H.264 MP4 encoding failed before the file was saved: ${detail}`, { cause: error });
    }

    throwIfAborted(signal);
    dependencies.onProgress?.({
      completed: plan.length,
      total: plan.length,
      phase: 'saving',
    });
    const blobOutput = output.buffer instanceof ArrayBuffer
      ? new Uint8Array(output.buffer, output.byteOffset, output.byteLength)
      : new Uint8Array(output);
    const blob = new Blob([blobOutput], { type: format.mime });
    if (download) downloadBlob(filename, blob);
    else await target!.write(blob, signal ? { signal } : {});
    throwIfAborted(signal);
    return true;
  } finally {
    audioRuntime.release();
  }
}
function isRecord(value: unknown): value is UnknownRecord {
  return isUnknownRecord(value);
}

function recordOrEmpty(value: unknown, label: string): UnknownRecord {
  if (value == null) return {};
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function validateCell(cell: unknown, label: string): void {
  if (cell == null) return;
  if (!isRecord(cell)) throw new Error(`${label} must be a cell object`);
}

function validateCellKey(key: string, label: string): void {
  if (!/^-?\d+,-?\d+$/.test(key)) throw new Error(`${label} has an invalid cell position`);
  const [x, y] = key.split(',').map(Number);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new Error(`${label} has an invalid cell position`);
  }
}

function normalizeCells(src: unknown, overflow: unknown, label = 'Layer cells'): CellMap {
  const extra = recordOrEmpty(overflow, `${label} overflow`);
  if (Array.isArray(src)) {
    src.forEach((row, y) => {
      if (row == null) return;
      if (!Array.isArray(row)) throw new Error(`${label} row ${y} must be an array`);
      row.forEach((cell, x) => validateCell(cell, `${label} at ${x},${y}`));
    });
    for (const [key, cell] of Object.entries(extra)) {
      validateCellKey(key, `${label} overflow`);
      validateCell(cell, `${label} overflow at ${key}`);
    }
    return cmFromGrid(
      src,
      extra as Parameters<typeof cmFromGrid>[1],
    ) as CellMap;
  }
  const source = recordOrEmpty(src, label);
  const cells: CellMap = {};
  for (const [key, cell] of Object.entries(source)) {
    validateCellKey(key, label);
    validateCell(cell, `${label} at ${key}`);
    if (cell != null) cells[key] = { ...(cell as UnknownRecord) };
  }
  return cells;
}

function normalizeOptionalRecord(value: unknown, label: string): UnknownRecord | null | undefined {
  if (value == null) return value;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return { ...value };
}

function normalizeMask(mask: unknown, label: string): UnknownRecord {
  if (!isRecord(mask)) throw new Error(`${label} must be an object`);
  const offset = normalizeOptionalRecord(mask['offset'], `${label} offset`) || {};
  const normalized: UnknownRecord = {
    defaultStrength: mask['defaultStrength'] ?? 1,
    cells: normalizeCells(mask['cells'], null, `${label} cells`),
    offset: {
      x: Math.round(Number(offset['x']) || 0),
      y: Math.round(Number(offset['y']) || 0),
    },
  };
  if ('opacity' in mask) {
    normalized['opacity'] = Math.max(0, Math.min(1, Number(mask['opacity'])));
  }
  return normalized;
}

const EFFECT_KINDS = new Set(['brightness', 'contrast', 'saturation', 'hue', 'solid-color', 'color-clip']);

function normalizeEffectLayer(layer: UnknownRecord, label: string): UnknownRecord {
  const rawEffect = normalizeOptionalRecord(layer['effect'], `${label} effect`)
    || { kind: 'brightness', intensity: 0.25 };
  const kind = typeof rawEffect['kind'] === 'string' && EFFECT_KINDS.has(rawEffect['kind'])
    ? rawEffect['kind']
    : 'brightness';
  const intensity = Number(rawEffect['intensity']);
  const minIntensity = (kind === 'solid-color' || kind === 'color-clip') ? 0 : -1;
  const defaultIntensity = (kind === 'solid-color' || kind === 'color-clip') ? 1 : 0.25;
  const clampedIntensity = Number.isFinite(intensity)
    ? Math.max(minIntensity, Math.min(1, intensity))
    : defaultIntensity;
  const effect: UnknownRecord = { kind, intensity: clampedIntensity };
  if (kind === 'solid-color') {
    const color = typeof rawEffect['color'] === 'string' && /^#[0-9a-f]{6}$/i.test(rawEffect['color'])
      ? rawEffect['color'].toLowerCase()
      : '#ffffff';
    effect['color'] = color;
  }
  // color-clip is always clipped and never has a mask.
  const isColorClip = kind === 'color-clip';
  return {
    effect,
    clipped: isColorClip ? true : !!layer['clipped'],
    ...(isColorClip ? {} : (layer['mask'] ? { mask: normalizeMask(layer['mask'], `${label} mask`) } : {})),
  };
}

function normalizeMediaTransform(layer: ProjectLayer, width: number, height: number): ProjectLayer {
  if (layer.type !== 'image' && layer.type !== 'video') return layer;
  const transform = layer.transform || {};
  const numberOr = (value: unknown, fallback: number): number => {
    if (value == null) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  const scale = numberOr(transform.scale, 1);
  return {
    ...layer,
    transform: {
      ...transform,
      x: numberOr(transform.x, width / 2),
      y: numberOr(transform.y, height / 2),
      rot: numberOr(transform.rot, 0),
      ...(transform.scale != null || (transform.scaleX == null && transform.scaleY == null)
        ? { scale }
        : {}),
      ...(transform.scaleX != null ? { scaleX: numberOr(transform.scaleX, scale) } : {}),
      ...(transform.scaleY != null ? { scaleY: numberOr(transform.scaleY, scale) } : {}),
    },
  };
}

const VIDEO_PLACEMENT_FIELDS = new Set([
  'assetId', 'startTick', 'inPoint', 'outPoint', 'playbackRate',
]);

function normalizeVideoPlacement(value: unknown, label: string): UnknownRecord {
  const placement = normalizeOptionalRecord(value, label) || {};
  assertOnlyKeys(placement, VIDEO_PLACEMENT_FIELDS, label);
  return placement;
}

function normalizeLayer(l: LayerInput, label = 'Layer'): ProjectLayer {
  if (!isRecord(l)) throw new Error(`${label} must be an object`);
  const id = assertUuid(l.id, `${label} ID`);
  const type = l.type || 'cell';
  if (typeof type !== 'string') throw new Error(`${label} type must be text`);
  const text = typeof l.text === 'string' ? l.text : '';
  const fg = typeof l.fg === 'string' ? l.fg : '#ffffff';
  const box = normalizeOptionalRecord(l.box, `${label} text box`);
  const runs = type === 'text'
    ? normalizeTextRuns(l.runs as Parameters<typeof normalizeTextRuns>[0], text, fg)
    : l.runs;
  const videoPlacement = type === 'video'
    ? normalizeVideoPlacement(l.video, `${label} video`)
    : null;
  const effectLayer = type === 'effect' ? normalizeEffectLayer(l, label) : null;
  const contentMask = isRecord(l) && l['contentMask'] != null
    ? normalizeContentMask(l['contentMask'], `${label} content mask`)
    : null;
  if (effectLayer?.['effect'] && isRecord(effectLayer['effect']) &&
    effectLayer['effect']['kind'] === 'color-clip' && contentMask) {
    throw new Error(`${label} color clips cannot have content masks`);
  }
  return {
    id, name: typeof l.name === 'string' ? l.name : 'layer',
    type, visible: l.visible !== false,
    cells: normalizeCells(l.cells, l.overflow, `${label} cells`),
    text: type === 'text' ? text : l.text,
    box,
    wrap: type === 'text' ? l.wrap !== false : l.wrap,
    fg: type === 'text' ? fg : l.fg,
    runs,
    shape: normalizeOptionalRecord(l.shape, `${label} shape`),
    offset: normalizeOptionalRecord(l.offset, `${label} offset`),
    transform: normalizeOptionalRecord(l.transform, `${label} transform`),
    assetId: type === 'image' ? l.assetId : undefined,
    videoClip: type === 'video'
      ? normalizeVideoClip(videoPlacement!)
      : normalizeOptionalRecord(l.video, `${label} video`),
    videoPlacement: type === 'video' ? videoPlacement : undefined,
    groupId: l.groupId, collapsed: l.collapsed, blink: l.blink,
    ...(effectLayer || {}),
    ...(type !== 'group' && type !== 'effect' && l.opacity != null ? { opacity: l.opacity } : {}),
    ...(contentMask ? { contentMask } : {}),
  } as unknown as ProjectLayer;
}

const POSITION_INTERPOLATIONS = new Set(['linear', 'ease-in', 'ease-out', 'ease-in-out']);

function boundedInteger(
  value: unknown,
  fallback: number | null,
  label: string,
  min: number,
  max: number,
): number {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || typeof number !== 'number' || number < min || number > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return number as number;
}

function assertOnlyKeys(value: UnknownRecord, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value || {})) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

const CANONICAL_LAYER_FIELDS = new Set([
  'id', 'name', 'type', 'visible', 'cells', 'offset', 'text', 'box', 'wrap', 'fg', 'runs',
  'shape', 'effect', 'clipped', 'mask', 'contentMask', 'transform', 'assetId', 'groupId', 'collapsed',
  'opacity', 'blink',
]);
const CANONICAL_PAYLOAD_FIELDS = new Set([
  'cells', 'text', 'box', 'wrap', 'fg', 'runs', 'shape', 'mask', 'contentMask',
]);
const CANONICAL_TRACK_FIELDS = new Set([
  'id', 'kind', 'name', 'locked', 'parentTrackId', 'layer',
  'propertyTracks', 'volume', 'muted', 'shapePathKind', 'shapePathComponents',
]);
const CANONICAL_CLIP_FIELDS = new Set([
  'id', 'trackId', 'kind', 'startTick', 'inTick', 'outTick',
  'sourceDuration', 'frameKeys', 'propertyTracks', 'assetId', 'inPoint', 'outPoint',
  'playbackRate', 'volume', 'muted', 'name',
]);
const CANONICAL_PROPERTY_NAMES = new Set([
  'position', 'visibility', 'effectIntensity', 'effectColor', 'contentMask', 'maskOpacity', 'maskPosition', 'shapeMix',
  'shapePath', 'shapeAnchorCompensation',
]);
function normalizeCanonicalLayer(value: unknown, label: string): ProjectLayer {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertOnlyKeys(value, CANONICAL_LAYER_FIELDS, label);
  const layer = value as LayerInput;
  const normalized = normalizeLayer(layer.type === 'video'
    ? { ...layer, video: { assetId: layer.assetId } }
    : layer, label);
  const normalizedRecord = normalized as unknown as UnknownRecord;
  const offset = isRecord(layer.offset) ? layer.offset : {};
  normalizedRecord['offset'] = {
    x: Math.round(Number(offset['x']) || 0),
    y: Math.round(Number(offset['y']) || 0),
  };
  if (layer.type === 'video') {
    normalizedRecord['assetId'] = layer.assetId;
    delete normalizedRecord['videoClip'];
    delete normalizedRecord['videoPlacement'];
  }
  return normalized;
}

function normalizeCanonicalPayload(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertOnlyKeys(value, CANONICAL_PAYLOAD_FIELDS, label);
  const payload = serializableDtoValue(value, label) as UnknownRecord;
  if (Object.prototype.hasOwnProperty.call(value, 'cells')) {
    payload['cells'] = normalizeCells(value['cells'], null, `${label} cells`);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'offset')) {
    if (!isRecord(value['offset'])) throw new Error(`${label} offset must be an object`);
    payload['offset'] = {
      x: Math.round(Number(value['offset']['x']) || 0),
      y: Math.round(Number(value['offset']['y']) || 0),
    };
  }
  if (Object.prototype.hasOwnProperty.call(value, 'mask') && value['mask'] != null) {
    payload['mask'] = normalizeMask(value['mask'], `${label} mask`);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'contentMask') && value['contentMask'] != null) {
    payload['contentMask'] = normalizeContentMask(value['contentMask'], `${label} content mask`);
  }
  return payload;
}

function normalizeCanonicalKeys<T>(
  source: unknown,
  label: string,
  normalizeValue: (value: unknown, label: string) => T,
): TimelineKey<T>[] {
  if (!Array.isArray(source)) throw new Error(`${label} must be an array`);
  let previous = -1;
  return source.map((key, index) => {
    const keyLabel = `${label} key ${index + 1}`;
    if (!isRecord(key)) throw new Error(`${keyLabel} must be an object`);
    assertOnlyKeys(key, new Set(['tick', 'value']), keyLabel);
    const tick = key['tick'];
    if (!Number.isSafeInteger(tick) || typeof tick !== 'number' || tick < 0 || tick <= previous) {
      throw new Error(`${label} ticks must be unique and strictly increasing`);
    }
    if (!Object.prototype.hasOwnProperty.call(key, 'value')) {
      throw new Error(`${keyLabel} must contain a value`);
    }
    previous = tick;
    const value = normalizeValue(key['value'], `${keyLabel} value`);
    return { tick, value };
  });
}

function normalizeCanonicalProperties(
  source: unknown,
  label: string,
  shapeKind: string | null = null,
): Record<string, TimelineKey[]> {
  const properties = recordOrEmpty(source, label);
  return Object.fromEntries(Object.entries(properties).map(([name, keys]) => {
    if (!CANONICAL_PROPERTY_NAMES.has(name)) {
      throw new Error(`${label} contains unsupported property ${name || '(empty)'}`);
    }
    const normalizeValue = (value: unknown, valueLabel: string): unknown => {
      if (name === 'shapeAnchorCompensation') {
        if (!isRecord(value) || typeof value['x'] !== 'number' || typeof value['y'] !== 'number' ||
          !Number.isFinite(value['x']) || !Number.isFinite(value['y'])) {
          throw new Error(`${valueLabel} must contain finite x/y numbers`);
        }
        const interpolation = typeof value['interpolation'] === 'string' &&
          POSITION_INTERPOLATIONS.has(value['interpolation'])
          ? value['interpolation']
          : null;
        const temporalEase = normalizeTemporalEase(value['temporalEase']);
        return {
          x: value['x'],
          y: value['y'],
          ...(interpolation ? { interpolation } : {}),
          ...(temporalEase ? { temporalEase } : {}),
        };
      }
      if (name === 'position' || name === 'maskPosition') {
        if (!isRecord(value)) throw new Error(`${valueLabel} must be an object`);
        if (!Number.isInteger(value['x']) || !Number.isInteger(value['y'])) {
          throw new Error(`${valueLabel} must contain integer x/y values`);
        }
        const interpolation = typeof value['interpolation'] === 'string' &&
          POSITION_INTERPOLATIONS.has(value['interpolation'])
          ? value['interpolation']
          : null;
        const temporalEase = normalizeTemporalEase(value['temporalEase']);
        return {
          x: value['x'],
          y: value['y'],
          ...(interpolation ? { interpolation } : {}),
          ...(temporalEase ? { temporalEase } : {}),
        };
      }
      if (name === 'visibility') {
        if (typeof value !== 'boolean') throw new Error(`${valueLabel} must be boolean`);
        return value;
      }
      if (name === 'effectIntensity' || name === 'maskOpacity' || name === 'shapeMix') {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error(`${valueLabel} must be finite`);
        const min = name === 'effectIntensity' ? -1 : 0;
        if (number < min || number > 1) throw new Error(`${valueLabel} is outside its range`);
        return number;
      }
      if (name === 'effectColor') {
        if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
          throw new Error(`${valueLabel} must be a #rrggbb hex color`);
        }
        return value.toLowerCase();
      }
      if (name === 'contentMask') return normalizeContentMask(value, valueLabel);
      if (name === 'shapePath') {
        if (!isRecord(value)) throw new Error(`${valueLabel} must be an object`);
        const envelope = Object.prototype.hasOwnProperty.call(value, 'path') ||
          Object.prototype.hasOwnProperty.call(value, 'components');
        const path = envelope ? value['path'] : value;
        if (path != null && !normalizeShapePathKey(
          path,
          shapeKind as EditorShapeKind | undefined,
        )) {
          throw new Error(`${valueLabel} has invalid shape geometry`);
        }
        if (envelope) {
          assertOnlyKeys(value, new Set(['path', 'components']), valueLabel);
          if (value['components'] != null && !isRecord(value['components'])) {
            throw new Error(`${valueLabel} components must be an object`);
          }
          const components = isRecord(value['components']) ? value['components'] : {};
          for (const [componentId, component] of Object.entries(components)) {
            if (!componentId || !isRecord(component)) {
              throw new Error(`${valueLabel} has an invalid shape component`);
            }
            const raw = componentId === 'rotation' ? component['value'] : component;
            if (componentId === 'rotation') {
              if (!Number.isFinite(raw)) throw new Error(`${valueLabel} rotation must be finite`);
            } else if (!isRecord(raw) || !Number.isFinite(raw['x']) || !Number.isFinite(raw['y'])) {
              throw new Error(`${valueLabel} component ${componentId} must contain finite x/y`);
            }
          }
        }
        return serializableDtoValue(value, valueLabel);
      }
      return serializableDtoValue(value, valueLabel);
    };
    return [name, normalizeCanonicalKeys(keys, `${label} ${name}`, normalizeValue)];
  }));
}

function normalizeCanonicalTimeline(
  timeline: CanonicalTimelineInput,
  rate: number,
): CanonicalTimelineState {
  if (!Array.isArray(timeline.tracks)) throw new Error('Canonical timeline tracks must be an array');
  if (!Array.isArray(timeline.clips)) throw new Error('Canonical timeline clips must be an array');
  const tracks: TimelineTrack[] = timeline.tracks.map((value, index) => {
    const label = `Canonical track ${index + 1}`;
    if (!isRecord(value)) throw new Error(`${label} must be an object`);
    assertOnlyKeys(value, CANONICAL_TRACK_FIELDS, label);
    const input = value as CanonicalTrackInput;
    const kind = String(input.kind || '');
    if (!['visual', 'video', 'group', 'audio'].includes(kind)) {
      throw new Error(`${label} kind is invalid`);
    }
    if (kind !== 'audio' && input.name != null) {
      throw new Error(`${label} duplicates its layer name`);
    }
    if (input.shapePathComponents != null && !Array.isArray(input.shapePathComponents)) {
      throw new Error(`${label} shape path components must be an array`);
    }
    const layerName = isRecord(input.layer) ? input.layer['name'] : undefined;
    const track = {
      id: assertUuid(input.id, `${label} ID`),
      kind: kind as TimelineTrack['kind'],
      name: String(input.name || (kind === 'audio' ? 'Audio' : layerName || 'Layer')),
      locked: !!input.locked,
      ...(input.parentTrackId != null
        ? { parentTrackId: assertUuid(input.parentTrackId, `${label} parent track ID`) }
        : {}),
      ...(input.shapePathKind != null ? { shapePathKind: String(input.shapePathKind) } : {}),
      ...(Array.isArray(input.shapePathComponents)
        ? { shapePathComponents: input.shapePathComponents.map(String) }
        : {}),
      ...(input.layer != null ? { layer: normalizeCanonicalLayer(input.layer, `${label} layer`) } : {}),
      propertyTracks: normalizeCanonicalProperties(
        input.propertyTracks,
        `${label} properties`,
        input.shapePathKind == null ? null : String(input.shapePathKind),
      ),
    } as TimelineTrack;
    if (input.volume != null) {
      const volume = Number(input.volume);
      if (!Number.isFinite(volume)) throw new Error(`${label} volume must be finite`);
      track['volume'] = Math.max(0, Math.min(1, volume));
    }
    if (input.muted) track['muted'] = true;
    return track;
  });
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const clips: TimelineClip[] = timeline.clips.map((value, index) => {
    const label = `Canonical clip ${index + 1}`;
    if (!isRecord(value)) throw new Error(`${label} must be an object`);
    assertOnlyKeys(value, CANONICAL_CLIP_FIELDS, label);
    const input = value as CanonicalClipInput;
    const trackId = assertUuid(input.trackId, `${label} owner track ID`);
    const track = trackById.get(trackId);
    const startTick = boundedInteger(input.startTick, null, `${label} startTick`, 0, 1000000);
    const inTick = boundedInteger(input.inTick, null, `${label} inTick`, 0, 1000000);
    const outTick = boundedInteger(input.outTick, null, `${label} outTick`, 1, 1000001);
    const sourceDuration = boundedInteger(
      input.sourceDuration,
      null,
      `${label} sourceDuration`,
      1,
      1000001,
    );
    if (outTick <= inTick || outTick > sourceDuration) {
      throw new Error(`${label} has invalid source tick bounds`);
    }
    const clip = {
      id: assertUuid(input.id, `${label} ID`),
      trackId,
      kind: String(input.kind || '') as TimelineClip['kind'],
      startTick,
      inTick,
      outTick,
      sourceDuration,
      frameKeys: normalizeCanonicalKeys(
        input.frameKeys,
        `${label} frames`,
        normalizeCanonicalPayload,
      ),
      propertyTracks: normalizeCanonicalProperties(
        input.propertyTracks,
        `${label} properties`,
        track?.shapePathKind,
      ),
    } as TimelineClip;
    for (const field of [
      'assetId', 'inPoint', 'outPoint', 'playbackRate', 'volume', 'muted', 'name',
    ]) {
      if (input[field] !== undefined) clip[field] = input[field];
    }
    if (track?.kind === 'audio' && clip.assetId != null) {
      clip.assetId = assertUuid(clip.assetId, `${label} asset ID`);
    }
    return clip;
  });
  const state = {
    tracks,
    clips,
    tags: normalizeTimelineTags(timeline.tags),
    fps: rate,
    tickDuration: 1000 / rate,
  };
  validateTimelineTagRange(state.tags, clipTimelineDurationTicks(state));
  return state;
}

function validateIdentityGraph(
  project: { projectId: string },
  canonical: CanonicalTimelineState,
  media: MediaRegistry,
): void {
  const definitions = new Map<string, string>();
  const define = (id: string, label: string): void => {
    const key = uuidKey(id);
    const previous = definitions.get(key);
    if (previous) throw new Error(`Duplicate UUID ${id} for ${previous} and ${label}`);
    definitions.set(key, label);
  };
  define(project.projectId, 'project');
  for (const [index, asset] of media.assets.entries()) define(asset.assetId, `media asset ${index + 1}`);
  for (const [index, track] of canonical.tracks.entries()) define(track.id, `track ${index + 1}`);
  for (const [index, track] of canonical.tracks.entries()) {
    if (track.layer) define(track.layer.id, `layer ${index + 1}`);
  }
  for (const [index, clip] of canonical.clips.entries()) define(clip.id, `clip ${index + 1}`);
  for (const [index, tag] of canonical.tags.entries()) define(tag.id, `timeline tag ${index + 1}`);

  const mediaById = new Map(media.assets.map((asset) => [asset.assetId, asset]));
  const trackById = new Map(canonical.tracks.map((track) => [track.id, track]));
  const visualTracks = canonical.tracks.filter((track) => track.kind !== 'audio');
  const trackByLayerId = new Map(visualTracks.map((track) => [track.layer?.id, track]));
  for (const track of canonical.tracks) {
    if (track.kind === 'audio') {
      if (track.layer != null || track.parentTrackId != null) {
        throw new Error(`Audio track ${track.id} cannot own a visual layer`);
      }
      continue;
    }
    const layer = track.layer;
    if (!layer) throw new Error(`Visual track ${track.id} must own one layer`);
    const expectedKind = layer.type === 'group'
      ? 'group'
      : layer.type === 'video' ? 'video' : 'visual';
    if (track.kind !== expectedKind) {
      throw new Error(`Track ${track.id} kind does not match layer ${layer.id}`);
    }
    const expectedParent = layer.groupId == null
      ? null
      : trackByLayerId.get(layer.groupId)?.id || null;
    if ((track.parentTrackId || null) !== expectedParent) {
      throw new Error(`Track ${track.id} has a dangling or mismatched parent track reference`);
    }
    if (layer.type === 'group' && track.parentTrackId) {
      throw new Error(`Group ${layer.id} cannot have a parent group`);
    }
    if (layer.type === 'image' || layer.type === 'video') {
      const layerAssetId = (layer as unknown as UnknownRecord)['assetId'] as string;
      const asset = mediaById.get(layerAssetId);
      if (!asset || asset.kind !== layer.type) {
        throw new Error(`${layer.type === 'video' ? 'Video' : 'Image'} layer ${layer.id} has a dangling or wrong-kind asset reference`);
      }
    }
  }
  if (trackByLayerId.size !== visualTracks.length) {
    throw new Error('Every visual track must own a distinct layer UUID');
  }
  for (const clip of canonical.clips) {
    const owner = trackById.get(clip.trackId);
    if (!owner) throw new Error(`Clip ${clip.id} has a dangling owner track reference`);
    if (owner.kind === 'audio') {
      if (mediaById.get(clip.assetId as string)?.kind !== 'audio') {
        throw new Error(`Audio clip ${clip.id} has a dangling or wrong-kind asset reference`);
      }
      continue;
    }
    if (!owner.layer || owner.layer.type === 'group') {
      throw new Error(`Clip ${clip.id} has an invalid visual owner`);
    }
    const expectedKind = owner.layer.type === 'video' ? 'video' : 'visual';
    if (clip.kind !== expectedKind) {
      throw new Error(`Clip ${clip.id} kind does not match its owner layer`);
    }
    if (owner.layer.type === 'video') {
      const asset = mediaById.get(clip.assetId as string);
      const layerAssetId = (owner.layer as unknown as UnknownRecord)['assetId'];
      if (!asset || asset.kind !== 'video' || clip.assetId !== layerAssetId) {
        throw new Error(`Video clip ${clip.id} has a dangling or wrong-kind asset reference`);
      }
      const playbackRate = Number(clip.playbackRate);
      const inPoint = Number(clip.inPoint);
      const outPoint = Number(clip.outPoint);
      if (!Number.isFinite(playbackRate) || playbackRate <= 0 ||
        !Number.isFinite(inPoint) || !Number.isFinite(outPoint) ||
        inPoint < 0 || outPoint <= inPoint || outPoint > asset.duration) {
        throw new Error(`Video clip ${clip.id} has invalid source bounds`);
      }
      const expectedTicks = Math.max(1, Math.ceil(
        ((outPoint - inPoint) / playbackRate) * canonical.fps! - Number.EPSILON * 32,
      ));
      if (clip.inTick !== 0 || clip.outTick !== expectedTicks ||
        clip.sourceDuration !== expectedTicks) {
        throw new Error(`Video clip ${clip.id} has stale canonical tick bounds`);
      }
    }
  }
}

function enrichMediaLayer(
  layer: ProjectLayer,
  mediaById: ReadonlyMap<string, MediaAsset>,
  label: string,
): ProjectLayer {
  if (layer.type === 'image') {
    const assetId = assertUuid(layer.assetId, `${label} asset ID`);
    const asset = mediaById.get(assetId);
    if (!asset || asset.kind !== 'image') return { ...layer, assetId };
    return {
      ...layer,
      assetId,
      sourceWidth: asset.width,
      sourceHeight: asset.height,
    };
  }
  if (layer.type !== 'video') return layer;
  const assetId = assertUuid(
    (layer as unknown as UnknownRecord)['assetId'],
    `${label} asset ID`,
  );
  const asset = mediaById.get(assetId);
  return {
    ...layer,
    assetId,
    ...(asset?.kind === 'video' ? {
      sourceWidth: asset.width,
      sourceHeight: asset.height,
      sourceDuration: asset.duration,
    } : {}),
  } as unknown as ProjectLayer;
}

function enrichCanonicalMedia(
  canonical: CanonicalTimelineState,
  mediaById: ReadonlyMap<string, MediaAsset>,
): CanonicalTimelineState {
  canonical.tracks = canonical.tracks.map((track, index) => track.layer ? {
    ...track,
    layer: enrichMediaLayer(track.layer, mediaById, `Canonical track ${index + 1} layer`),
  } : track);
  canonical.clips = canonical.clips.map((clip) => {
    if (clip.kind === 'video') {
      const asset = mediaById.get(clip.assetId as string);
      return asset?.kind === 'video'
        ? { ...clip, duration: asset.duration, width: asset.width, height: asset.height }
        : clip;
    }
    if (clip.kind !== 'audio') return clip;
    const asset = mediaById.get(clip.assetId as string);
    if (!asset || asset.kind !== 'audio') return clip;
    return normalizeAudioClip({ ...clip, duration: asset.duration }) as unknown as TimelineClip;
  });
  return canonical;
}

function validateCanonicalMediaState(canonical: CanonicalTimelineState): void {
  assertCanonicalClipTimelineState(canonical, 'saved canonical timeline');
  const duration = clipTimelineDurationTicks(canonical);
  for (let tick = 0; tick < duration; tick++) resolveClipTimelineLayers(canonical, tick);
}

function prepareProject(data: unknown): {
  projectId: string;
  width: number;
  height: number;
  rate: number;
  media: MediaRegistry;
  canonical: CanonicalTimelineState;
} {
  if (!isRecord(data) || data['format'] !== 'paintty-sprite') {
    throw new Error('Not a paintty sprite file');
  }
  assertOnlyKeys(data, new Set([
    'format', 'version', 'projectId', 'width', 'height', 'fps', 'timeline', 'media',
  ]), 'Project');
  const project = data as ProjectInput;
  if (project.version !== CURRENT_PROJECT_VERSION) {
    throw new Error(`Development project schema mismatch. Expected ${CURRENT_PROJECT_VERSION}.`);
  }
  const loadedProjectId = assertUuid(project.projectId, 'Project ID');
  const currentDimensions = get(dims);
  const width = boundedInteger(project.width, currentDimensions.w, 'Width', 1, 256);
  const height = boundedInteger(project.height, currentDimensions.h, 'Height', 1, 256);
  const rate = boundedInteger(project.fps, null, 'Frame rate', 1, 60);
  if (!isRecord(project.timeline)) throw new Error('Timeline must be an object');
  assertOnlyKeys(project.timeline, new Set(['tracks', 'clips', 'tags']), 'Timeline');
  const media = normalizeMediaRegistry(project.media, 'Project media registry');
  const mediaById = new Map(media.assets.map((asset) => [asset.assetId, asset]));
  const canonical = enrichCanonicalMedia(
    normalizeCanonicalTimeline(project.timeline as CanonicalTimelineInput, rate),
    mediaById,
  );
  canonical.tracks = canonical.tracks.map((track) => track.layer ? {
    ...track,
    layer: normalizeMediaTransform(track.layer, width, height),
  } : track);
  validateIdentityGraph({ projectId: loadedProjectId }, canonical, media);
  validateCanonicalMediaState(canonical);
  return {
    projectId: loadedProjectId,
    width,
    height,
    rate,
    media,
    canonical,
  };
}

export function loadJSON(text: string): void {
  const data: unknown = JSON.parse(text);
  const prepared = prepareProject(data);
  const previousVideoSources = get(layers).filter((layer): layer is Extract<ProjectLayer, { type: 'video' }> => (
    layer.type === 'video' && !!layer.videoURL && !layer.runtimeMediaKey
  ));
  const revision = advanceProjectRevision();

  replaceProjectId(prepared.projectId);
  loadMediaRegistry(prepared.media);
  dims.set({ w: prepared.width, h: prepared.height });
  fps.set(prepared.rate);
  loadCanonicalTimeline(prepared.canonical);
  moveState.set(null);
  resetEditorStateForProjectLoad();
  projectSaveTarget = null;
  recentProjectIdentity.set(null);
  dirty.set(false);
  notifyProjectReplaced({ revision });
  activeTool.set('brush');
  altEyedrop.set(false);
  selectMode.set('new');
  previousVideoSources.forEach((source) => releaseVideoSource(source));
}

export function openFileDialog({
  createInput = () => document.createElement('input'),
  createReader = () => new FileReader(),
  showError = notifyError,
  serializeCurrent = serializeJSON,
  decodeArchive = decodeProjectArchive,
  storeAssets = putProjectAssets,
  loadProject = loadJSON,
}: {
  createInput?: () => HTMLInputElement;
  createReader?: () => FileReader;
  showError?: (message: unknown) => unknown;
  serializeCurrent?: () => string;
  decodeArchive?: typeof decodeProjectArchive;
  storeAssets?: typeof putProjectAssets;
  loadProject?: (contents: string) => void;
} = {}): boolean {
  // A delayed picker or reader may apply only if revision and serialized contents
  // still match the document that opened it.
  const request = ++latestOpenRequest;
  const revision = captureProjectRevision();
  const generation = get(authoredRevision);
  const initialContents = serializeCurrent();
  const requestIsCurrent = () => request === latestOpenRequest &&
    isProjectRevisionCurrent(revision) && get(authoredRevision) === generation &&
    serializeCurrent() === initialContents;
  const input = createInput();
  input.type = 'file';
  input.accept = '.paintty,.json,application/zip,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (/\.paintty$/i.test(file.name) && typeof file.arrayBuffer === 'function') {
      try {
        const decoded = await decodeArchive(await file.arrayBuffer());
        if (!requestIsCurrent()) return;
        const contents = JSON.stringify(decoded.document);
        await storeAssets([...decoded.mediaBlobs].map(([hash, blob]) => ({
          hash,
          blob,
          size: blob.size,
          mime: blob.type,
        })));
        if (!requestIsCurrent()) return;
        loadProject(contents);
        fileName.set(file.name);
        const recentId = createRecentProjectId();
        recentProjectIdentity.set(recentId);
        notifyProjectLoaded({ contents: serializeJSON(), fileName: file.name, recentId });
        scheduleMediaCacheGc();
      } catch (error) {
        if (requestIsCurrent()) {
          showError('Could not load file: ' + errorText(error));
        }
      }
      return;
    }
    const reader = createReader();
    const fail = (error: unknown): void => {
      if (!requestIsCurrent()) return;
      latestOpenRequest++;
      showError('Could not load file: ' + (
        error instanceof Error ? error.message : 'Could not read file.'
      ));
    };
    reader.onload = () => {
      if (!requestIsCurrent()) return;
      try {
        const contents = String(reader.result);
        loadProject(contents);
        fileName.set(file.name);
        const recentId = createRecentProjectId();
        recentProjectIdentity.set(recentId);
        notifyProjectLoaded({ contents: serializeJSON(), fileName: file.name, recentId });
        scheduleMediaCacheGc();
      } catch (err) {
        fail(err);
      }
    };
    reader.onerror = () => fail(reader.error);
    try {
      reader.readAsText(file);
    } catch (error) {
      fail(error);
    }
  };
  input.click();
  return true;
}
