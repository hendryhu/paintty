import { derived, get, writable } from 'svelte/store';
import type { Readable } from 'svelte/store';
import {
  activeLayerId,
  activeLayerPart,
  authoredRevision,
  beginStroke,
  cancelStroke,
  cellSelection,
  checkpointHistory,
  compositeWorld,
  dims,
  endStroke,
  layers,
  noteAuthoredMutation,
  registerAuthoredMutationSettledHandler,
  registerEffectMaskChangeHandler,
  registerHistoryContributor,
  registerLayerHistoryAuthority,
  registerLayerStackEmptyHandler,
  registerShapeRasterizeHandler,
  resizeCanvas,
  selectedLayerIds,
} from './grid.js';
import { cmClone, cmKey, cmParse, cmTranslate } from './cellmap.js';
import { playing } from './playbackState.js';
import {
  LINEAR_TEMPORAL_HANDLE,
  SLOW_TEMPORAL_HANDLE,
  normalizeTemporalEase,
  normalizeTemporalHandle,
  temporalHandleEqual,
  validInterpolation,
  withTemporalEaseSide,
} from './temporalEasing.js';
import {
  enumerateShapePathComponents,
  normalizeShapePathComponentId,
  normalizeShapePathComponentValue,
  normalizeShapePathKey,
  pathValueFromShape,
  shapePathComponentEqual,
  shapePathComponentValue,
  shapePathEqual,
  shapePathVertices,
  shapeWithPathValue,
  translateShapePathKey,
  withShapePathComponentValue,
  SHAPE_PATH_COMPONENT_ANCHOR,
  SHAPE_PATH_COMPONENT_ROTATION,
} from './shapePath.js';
import { renderShapeToCells } from './shapes.js';
import { shapeForAnchorComponentEdit } from './shapePathEditing.js';
import { normalizeTextRuns } from './textLayer.js';
import {
  addEmpty as addCanonicalEmpty,
  addCustomTimelineTag as addCanonicalCustomTag,
  canonicalClipTimeline,
  captureClipTimelineState,
  clearClipTimelineSelection as clearCanonicalClipSelection,
  deleteSelection as deleteCanonicalSelection,
  duplicateClips as duplicateCanonicalClips,
  durationTicks as canonicalDurationTicks,
  getClipTimelineSelection,
  getClipTimelineState,
  initializeClipTimelineState,
  moveClip as moveCanonicalClip,
  moveClips as moveCanonicalClips,
  moveTimelineKeys as moveCanonicalTimelineKeys,
  playheadTick as canonicalPlayheadTick,
  razor as razorCanonicalClips,
  razorPath as razorCanonicalPath,
  removeTimelineTag as removeCanonicalTag,
  restoreClipTimelineState,
  ripple as rippleCanonicalClips,
  seekClipTimelineTick,
  setLoopEndTag as setCanonicalLoopEnd,
  setLoopStartTag as setCanonicalLoopStart,
  setTimelineTag as setCanonicalTimelineTag,
  setClipTimelineFps,
  setClipTimelineSelection as setCanonicalClipSelection,
  transactClipTimeline,
  trimClip as trimCanonicalClip,
  trimClips as trimCanonicalClips,
  updateCustomTimelineTag as updateCanonicalCustomTag,
} from './clipTimelineState.js';
import {
  clipTimelineDurationTicks,
  resolveClipPropertyAtTick,
  resolveClipTimelineLayers,
} from './clipTimelineResolver.js';
import {
  clipContainsTick,
  clipSourceTickAt,
  cloneTimelineValue,
  validateClipTimelineState,
} from './clipTimeline.js';
import { captureProjectRevision } from './documentLifecycle.js';
import { currentMediaRegistry, mediaAssetById } from './mediaRegistry.js';
import { newUuid } from './uuid.js';
import { nextPlaybackTick, playbackStartTick } from './timelineTags.js';
import type {
  ClipTimelineSelection,
  ClipTimelineState,
  TimelineClip,
  TimelineIdFactory,
  TimelineIdSource,
  TimelineLayer,
  TimelineMask,
  TimelinePoint,
  TimelinePropertyTracks,
  TimelineStoredKey,
  TimelineTemporalHandle,
  TimelineTrack,
} from './types/timeline-models.js';
import type {
  EditorCellMap,
  EditorBounds,
  EditorLayer,
  EditorRasterSource,
  EditorShape,
  EditorShapeKind,
  EditorShapePath,
  EditorTextRun,
  EditorVideoClip,
} from './types/editor-domain.js';

export { playing };
export const DEFAULT_FPS = 24;
export const fps = writable(DEFAULT_FPS);
export const looping = writable(true);
export const onionSkin = writable('off');
export const activeFrameIndex = canonicalPlayheadTick;
export const playheadTick = canonicalPlayheadTick;
export const durationTicks = canonicalDurationTicks;
export const activeFrameTick = derived(canonicalPlayheadTick, () => 0);
export const timelineStructureRevision = writable(0);

let playbackCycleId = 0;
const playbackCyclePublisher = writable<Readonly<{ id: number; tick: number }>>(
  Object.freeze({ id: playbackCycleId, tick: 0 }),
);
export const playbackCycle = { subscribe: playbackCyclePublisher.subscribe };

const RUNTIME_FIELDS = new Set([
  'raster', 'videoElement', 'videoBlob', 'videoURL', 'runtimeMediaKey',
  'blob', 'buffer', 'audioBuffer', 'decoder', 'objectURL',
]);
const SHAPE_PATH_KINDS = new Set(['line', 'rect', 'circle', 'polygon']);
const SHAPE_ANCHOR_COMPENSATION = 'shapeAnchorCompensation';

let publishingResolvedView = false;
let synchronizedAuthoredRevision = -1;
let timelineStructureToken = 0;
let playbackTimer: ReturnType<typeof setTimeout> | null = null;
let observedFps = get(fps);

interface FramePayload {
  cells: EditorCellMap;
  text?: string;
  box?: EditorBounds | null;
  wrap?: boolean;
  fg?: string;
  runs?: EditorTextRun[];
  shape?: EditorShape | null;
  mask?: TimelineMask | null;
  contentMask?: TimelineMask | null;
}

interface PropertyRecord {
  owner: TimelineTrack | TimelineClip;
  clip: TimelineClip | null;
  sourceTick: number;
  projectTick: number;
  key: TimelineStoredKey;
}

interface PositionRecord {
  projectTick: number;
  value: unknown;
}

type ShapeComponentId = 'anchor' | 'rotation' | `vertex:${number}`;
type ShapeComponentValue = TimelinePoint | number;

interface ShapePropertyRecord extends PropertyRecord {
  componentKey: unknown;
}

interface PropertyContextValue {
  track: TimelineTrack;
  owner: TimelineTrack | TimelineClip | null;
  sourceTick: number | null;
  clip: TimelineClip | null;
}

export interface ClipClipboardPayload {
  format: string;
  version: number;
  projectRevision: unknown;
  fps?: number;
  sourceStartTick: number;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  media: Array<{
    assetId: string;
    hash: string;
    generation: number;
    kind: string;
  }>;
}

interface FrameReadEntry {
  id: number;
  index: number;
  duration: number;
  tickDuration: number;
  hold: number;
  readonly layers: TimelineLayer[];
}

interface CanonicalOperationResult extends Record<string, unknown> {
  changed: boolean;
  reason?: string;
  state: ClipTimelineState;
  playheadTick: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return record(value) ? cloneDurable(value) : {};
}

function isTimelineTrack(value: unknown): value is TimelineTrack {
  return record(value) && typeof value['id'] === 'string' &&
    typeof value['kind'] === 'string' && typeof value['locked'] === 'boolean';
}

function isTimelineClip(value: unknown): value is TimelineClip {
  return record(value) && typeof value['id'] === 'string' &&
    typeof value['trackId'] === 'string' && typeof value['kind'] === 'string' &&
    typeof value['startTick'] === 'number' && typeof value['inTick'] === 'number' &&
    typeof value['outTick'] === 'number' && typeof value['sourceDuration'] === 'number' &&
    Array.isArray(value['frameKeys']) && record(value['propertyTracks']);
}

function isEditorCellMap(value: unknown): value is EditorCellMap {
  return record(value) && Object.values(value).every((cell) =>
    cell == null || record(cell));
}

function idsFrom(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if ((typeof value !== 'object' && typeof value !== 'function') || !isIterable(value)) return [];
  return Array.from(value, String);
}

function isIterable(value: object): value is object & Iterable<unknown> {
  return typeof Reflect.get(value, Symbol.iterator) === 'function';
}

function isRasterSource(value: unknown): value is EditorRasterSource {
  return value !== null && typeof value === 'object' &&
    'width' in value && typeof value.width === 'number' &&
    'height' in value && typeof value.height === 'number';
}

function isEditorShape(value: unknown): value is EditorShape {
  return record(value) &&
    (value['kind'] === 'line' || value['kind'] === 'rect' ||
      value['kind'] === 'circle' || value['kind'] === 'polygon') &&
    typeof value['x0'] === 'number' && typeof value['y0'] === 'number' &&
    typeof value['x1'] === 'number' && typeof value['y1'] === 'number';
}

function integer(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function tickIndex(value: unknown, state: ClipTimelineState = getClipTimelineState()) {
  const tick = Number(value);
  const duration = clipTimelineDurationTicks(state);
  return Number.isInteger(tick) && tick >= 0 && tick < duration ? tick : null;
}

function boundedTick(value: unknown, state: ClipTimelineState = getClipTimelineState()) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(clipTimelineDurationTicks(state) - 1, Math.round(number)));
}

function cloneDurable<T>(value: T): T;
function cloneDurable(value: unknown, seen?: WeakMap<object, unknown>): unknown;
function cloneDurable(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    value.forEach((entry) => copy.push(cloneDurable(entry, seen)));
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    if (!RUNTIME_FIELDS.has(key)) copy[key] = cloneDurable(entry, seen);
  }
  return copy;
}

function sameValue(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function numericPosition(value: unknown): TimelinePoint {
  const source = record(value) ? value : {};
  return {
    x: Number(source['x']) || 0,
    y: Number(source['y']) || 0,
  };
}

function roundedPosition(value: unknown): TimelinePoint {
  const point = numericPosition(value);
  return { x: Math.round(point.x) || 0, y: Math.round(point.y) || 0 };
}

function textPayload(layer: TimelineLayer | null | undefined) {
  const text = layer?.type === 'text' ? layer.text : '';
  const fg = layer?.type === 'text' ? layer.fg : '#ffffff';
  return {
    text,
    box: layer?.type === 'text' && layer.box ? { ...layer.box } : null,
    wrap: layer?.type !== 'text' || layer.wrap !== false,
    fg,
    runs: normalizeTextRuns(layer?.type === 'text' ? layer.runs : [], text, fg),
  };
}

function shapePayload(layer: TimelineLayer | null | undefined) {
  if (layer?.type !== 'shape' || !layer.shape) return null;
  return cloneDurable(layer.shape);
}

function maskValue(mask: TimelineMask | null | undefined, includeCells = true): TimelineMask | null {
  if (!mask) return null;
  return {
    ...cloneDurable(mask),
    ...(includeCells ? { cells: cmClone(mask.cells || {}) } : { cells: {} }),
    offset: roundedPosition(mask.offset),
  };
}

function framePayload(layer: TimelineLayer | null | undefined): FramePayload {
  const payload: FramePayload = { cells: cmClone(layer?.cells || {}) };
  if (layer?.type === 'text') Object.assign(payload, textPayload(layer));
  if (layer?.type === 'shape') payload.shape = shapePayload(layer);
  if (layer?.type === 'effect') payload.mask = maskValue(layer.mask);
  if (layer?.contentMask) payload.contentMask = maskValue(layer.contentMask);
  return payload;
}

function layerBase(layer: TimelineLayer): TimelineLayer {
  const base = cloneDurable(layer);
  base.cells = {};
  base.offset = roundedPosition(layer?.offset);
  base.visible = layer?.visible !== false;
  if (base.type === 'text') {
    base.text = '';
    Reflect.set(base, 'box', null);
    base.wrap = true;
    base.fg = '#ffffff';
    base.runs = [];
  }
  if (base.type === 'shape') Reflect.set(base, 'shape', null);
  if (base.type === 'effect' && base.mask) base.mask = maskValue(base.mask, false);
  if (base.contentMask) base.contentMask = maskValue(base.contentMask, false);
  if (base.type === 'video' && layer.type === 'video') {
    const source = layer.videoClip;
    Reflect.set(base, 'assetId', source?.assetId ?? Reflect.get(base, 'assetId'));
    Reflect.deleteProperty(base, 'videoClip');
  }
  for (const field of RUNTIME_FIELDS) Reflect.deleteProperty(base, field);
  return base;
}

function visualTracks(state: ClipTimelineState = getClipTimelineState()): TimelineTrack[] {
  return (state.tracks || []).filter((track) => track.kind !== 'audio');
}

function trackLayerId(track: TimelineTrack | null | undefined): string | null {
  return track?.layer?.id ?? null;
}

function trackForLayer(state: ClipTimelineState, layerId: unknown): TimelineTrack | null {
  return (state?.tracks || []).find((track) =>
    track.kind !== 'audio' && String(trackLayerId(track)) === String(layerId)) || null;
}

function clipsForTrack(state: ClipTimelineState, trackId: string): TimelineClip[] {
  return (state?.clips || []).filter((clip) => clip.trackId === trackId && clip.kind !== 'audio');
}

function clipAtTick(state: ClipTimelineState, trackId: string, tick: number): TimelineClip | null {
  return (state?.clips || []).find((clip) =>
    clip.trackId === trackId && clip.kind !== 'audio' && clipContainsTick(clip, tick)) || null;
}

function sourceTickAt(clip: TimelineClip, tick: number): number | null {
  return clipSourceTickAt(clip, tick);
}

function projectTickAt(clip: TimelineClip, sourceTick: number): number {
  return clip.startTick + sourceTick - clip.inTick;
}

function generatedId(state: ClipTimelineState, makeId: TimelineIdFactory | null, kind: string): string {
  const used = new Set([
    ...state.tracks.map((track) => track.id),
    ...state.clips.map((clip) => clip.id),
  ]);
  let id;
  do id = String(makeId?.(kind) || newUuid(kind)); while (!id || used.has(id));
  return id;
}

function trackKind(layer: TimelineLayer): 'group' | 'video' | 'visual' {
  if (layer?.type === 'group') return 'group';
  if (layer?.type === 'video') return 'video';
  return 'visual';
}

function clipKind(layer: TimelineLayer): 'video' | 'visual' {
  return layer?.type === 'video' ? 'video' : 'visual';
}

function clipDuration(clip: TimelineClip): number {
  return Math.max(1, integer(clip?.outTick, 1) - integer(clip?.inTick));
}

function sourceDurationTicks(seconds: number, playbackRate: number, rate: number): number {
  return Math.max(1, Math.ceil((seconds / playbackRate) * rate - Number.EPSILON * 32));
}

function videoClipDefinition(
  layer: Extract<TimelineLayer, { type: 'video' }>,
  trackId: string,
  id: string,
  rate = get(fps),
): TimelineClip {
  const source: Partial<EditorVideoClip> = layer.videoClip ?? {};
  const playbackRate = Math.max(0.01, Number(source.playbackRate) || 1);
  const inPoint = Math.max(0, Number(source.inPoint) || 0);
  const outPoint = Math.max(inPoint, Number(source.outPoint) || Number(source.duration) || inPoint);
  const sourceDuration = sourceDurationTicks(outPoint - inPoint, playbackRate, rate);
  return {
    id,
    trackId,
    kind: 'video',
    startTick: Math.max(0, integer(source.startTick)),
    inTick: 0,
    outTick: sourceDuration,
    sourceDuration,
    assetId: source.assetId,
    sourceName: Reflect.get(source, 'sourceName'),
    inPoint,
    outPoint,
    playbackRate,
    duration: Math.max(0, Number(source.duration) || outPoint),
    width: Math.max(0, Number(source.width) || 0),
    height: Math.max(0, Number(source.height) || 0),
    frameKeys: [{ tick: 0, value: framePayload(layer) }],
    propertyTracks: {},
  };
}

function normalizeVideoSourceBounds(
  operation: string = 'normalize-video-source-bounds',
  retime = false,
  previousRate: number | null = null,
) {
  return transactClipTimeline(operation, (state) => {
    const rate = Math.max(1, Number(state.fps) || get(fps) || DEFAULT_FPS);
    let changed = false;
    for (const clip of state.clips) {
      if (clip.kind !== 'video') continue;
      const track = state.tracks.find((candidate) => candidate.id === clip.trackId);
      const resolved = resolveClipTimelineLayers(state, clip.startTick)
        .find((layer) => layer.id === track?.layer?.id);
      const playbackRate = Math.max(0.01, Number(clip.playbackRate) || 1);
      const baseInPoint = Math.max(0, Number(clip.inPoint) || 0);
      const baseOutPoint = Math.max(baseInPoint, Number(clip.outPoint) || baseInPoint);
      const sourceIn = clip.inTick;
      const sourceOut = clip.outTick;
      const inPoint = retime
        ? baseInPoint
        : baseInPoint + (sourceIn * playbackRate) / rate;
      const outPoint = retime
        ? baseOutPoint
        : Math.min(baseOutPoint, baseInPoint + (sourceOut * playbackRate) / rate);
      const duration = retime
        ? sourceDurationTicks(outPoint - inPoint, playbackRate, rate)
        : Math.max(1, sourceOut - sourceIn);
      if (sourceIn === 0 && sourceOut === duration &&
        clip.sourceDuration === duration && clip.inPoint === inPoint && clip.outPoint === outPoint) {
        continue;
      }
      const propertyBoundaries = Object.fromEntries(Object.keys(clip.propertyTracks || {}).map(
        (name) => {
          let fallback = null;
          if (name === 'position') fallback = resolved?.offset;
          else if (name === 'visibility') fallback = resolved?.visible;
          else if (name === 'effectIntensity') {
            fallback = resolved?.type === 'effect' ? resolved.effect?.intensity : null;
          } else if (name === 'maskOpacity') {
            fallback = resolved?.type === 'effect' ? resolved.mask?.opacity : null;
          } else if (name === 'maskPosition') {
            fallback = resolved?.type === 'effect' ? resolved.mask?.offset : null;
          } else if (name === 'shapePath') {
            fallback = resolved?.type === 'shape' ? pathValueFromShape(resolved.shape) : null;
          }
          return [name, resolveClipPropertyAtTick(clip, name, clip.startTick, fallback)];
        },
      ));
      const remapKeys = (keys: TimelineStoredKey[]) => {
        const remapped = new Map<number, TimelineStoredKey>();
        for (const key of keys) {
          if (key.tick < sourceIn || key.tick >= sourceOut) continue;
          const tick = retime
            ? Math.max(0, Math.min(
              duration - 1,
              Math.round((key.tick - sourceIn) * rate / Math.max(1, previousRate || rate)),
            ))
            : key.tick - sourceIn;
          remapped.set(tick, { ...key, tick });
        }
        return [...remapped.values()].sort((first, second) => first.tick - second.tick);
      };
      clip.inPoint = inPoint;
      clip.outPoint = outPoint;
      clip.inTick = 0;
      clip.outTick = duration;
      clip.sourceDuration = duration;
      let heldFrame = null;
      for (const key of clip.frameKeys) {
        if (key.tick > sourceIn) break;
        heldFrame = key;
      }
      clip.frameKeys = remapKeys(clip.frameKeys);
      if (heldFrame && !clip.frameKeys.some((key) => key.tick === 0)) {
        clip.frameKeys.unshift({ tick: 0, value: cloneDurable(heldFrame.value) });
      }
      clip.propertyTracks = Object.fromEntries(Object.entries(clip.propertyTracks || {}).map(
        ([name, keys]) => {
          const shifted = remapKeys(keys);
          if (!shifted.some((key) => key.tick === 0)) {
            const value = propertyBoundaries[name];
            shifted.unshift({
              tick: 0,
              value: name === 'shapePath' ? { path: value } : cloneDurable(value),
            });
          }
          return [name, shifted];
        },
      ));
      changed = true;
    }
    return changed ? { state, changed: true } : false;
  });
}

function visualClipDefinition(
  layer: TimelineLayer,
  trackId: string,
  id: string,
  startTick = 0,
): TimelineClip {
  if (layer?.type === 'video') return videoClipDefinition(layer, trackId, id);
  return {
    id,
    trackId,
    kind: 'visual',
    startTick: Math.max(0, integer(startTick)),
    inTick: 0,
    outTick: 1,
    sourceDuration: 1,
    frameKeys: [{ tick: 0, value: framePayload(layer) }],
    propertyTracks: {},
  };
}

function initialTrack(layer: TimelineLayer, id: string): TimelineTrack {
  const kind = trackKind(layer);
  const common = {
    id,
    name: layer.name,
    locked: false,
    layer: layerBase(layer),
  };
  if (kind === 'group') return { ...common, kind, propertyTracks: {} };
  if (kind === 'video') return { ...common, kind };
  return {
    ...common,
    kind: 'visual',
    ...(layer.type === 'shape' ? { shapePathKind: null, shapePathComponents: [] } : {}),
  };
}

function initialVisualTimeline(
  initialLayers: TimelineLayer[],
  retainedAudio: { tracks: TimelineTrack[]; clips: TimelineClip[] } = { tracks: [], clips: [] },
): ClipTimelineState {
  const trackIds = new Map<string, string>();
  const tracks: TimelineTrack[] = initialLayers.map((layer) => {
    const id = newUuid('track');
    trackIds.set(layer.id, id);
    return initialTrack(layer, id);
  });
  tracks.forEach((track) => {
    const groupId = track.layer?.groupId;
    const parentTrackId = groupId == null ? null : trackIds.get(groupId);
    if (parentTrackId) track.parentTrackId = parentTrackId;
  });
  const clips = tracks.flatMap((track, index) => {
    const layer = initialLayers[index];
    return track.kind === 'group' || !layer ? [] : [
      visualClipDefinition(layer, track.id, newUuid('clip'), 0),
    ];
  });
  return {
    fps: get(fps),
    tickDuration: 1000 / get(fps),
    tracks: [...tracks, ...retainedAudio.tracks],
    clips: [...clips, ...retainedAudio.clips],
    tags: [],
  };
}

function propertyOwners(
  state: ClipTimelineState,
  track: TimelineTrack | null,
  name: string,
): Array<TimelineTrack | TimelineClip> {
  if (!track) return [];
  if (track.kind === 'group' || track.layer?.type === 'group') return [track];
  return clipsForTrack(state, track.id).filter((clip) => clip.propertyTracks?.[name]);
}

function propertyEnabled(state: ClipTimelineState, track: TimelineTrack | null, name: string): boolean {
  return propertyOwners(state, track, name).some((owner) =>
    (owner.propertyTracks?.[name] || []).length > 0);
}

function upsertKey(keys: TimelineStoredKey[] | undefined, tick: number, value: unknown) {
  const next = [...(keys || [])];
  const index = next.findIndex((key) => key.tick === tick);
  const previous = index >= 0 ? next[index] : null;
  const key = {
    ...(previous || {}),
    tick,
    value: cloneDurable(value),
  };
  if (previous && sameValue(previous, key)) return { keys: next, changed: false };
  if (index >= 0) next[index] = key;
  else next.push(key);
  next.sort((first, second) => first.tick - second.tick);
  return { keys: next, changed: true };
}

function resolvedLayer(state: ClipTimelineState, layerId: unknown, tick: number): TimelineLayer | null {
  return resolveClipTimelineLayers(state, tick)
    .find((layer) => String(layer.id) === String(layerId)) || null;
}

function retainedRuntime(layer: TimelineLayer, live: TimelineLayer | undefined): TimelineLayer {
  if (!live || live.type !== layer.type) return layer;
  const runtime: Record<string, unknown> = {};
  for (const field of ['raster', 'videoElement', 'videoBlob', 'videoURL', 'runtimeMediaKey']) {
    const value = Reflect.get(live, field);
    if (value != null) runtime[field] = value;
  }
  return Object.keys(runtime).length ? Object.assign(layer, runtime) : layer;
}

function resolveView(
  state: ClipTimelineState,
  tick: number,
  liveById: Map<string, TimelineLayer> | null = null,
): TimelineLayer[] {
  const live = liveById || new Map(get(layers).map((layer) => [layer.id, layer]));
  return resolveClipTimelineLayers(state, tick)
    .map((layer) => retainedRuntime(layer, live.get(layer.id)));
}

function publishResolvedTick(
  tick: number = get(canonicalPlayheadTick),
  liveById: Map<string, TimelineLayer> | null = null,
) {
  const state = getClipTimelineState();
  const target = boundedTick(tick, state) ?? 0;
  const view = resolveView(state, target, liveById);
  publishingResolvedView = true;
  try {
    layers.set(view);
  } finally {
    publishingResolvedView = false;
  }
  if (!view.some((layer) => layer.id === get(activeLayerId))) {
    activeLayerId.set(view[0]?.id ?? null);
  }
  return view;
}

function structureSignature(state: ClipTimelineState): string {
  return JSON.stringify({
    tracks: state.tracks.map((track) => [track.id, track.parentTrackId || null, trackLayerId(track)]),
    clips: state.clips.map((clip) => [clip.id, clip.trackId, clip.startTick, clip.inTick, clip.outTick]),
  });
}

function preserveAnimatedBase(
  state: ClipTimelineState,
  track: TimelineTrack,
  _live: TimelineLayer,
  base: TimelineLayer,
): TimelineLayer {
  const previous = track.layer;
  if (!previous) return base;
  if (propertyEnabled(state, track, 'position')) base.offset = roundedPosition(previous.offset);
  if (propertyEnabled(state, track, 'visibility')) base.visible = previous.visible !== false;
  if (base.type === 'effect' && previous.type === 'effect' && base.effect && previous.effect &&
    propertyEnabled(state, track, 'effectIntensity')) {
    base.effect.intensity = previous.effect.intensity;
  }
  if (base.type === 'effect' && previous.type === 'effect' &&
    base.effect?.kind === 'solid-color' && previous.effect?.kind === 'solid-color' &&
    propertyEnabled(state, track, 'effectColor')) {
    base.effect.color = previous.effect.color;
  }
  if (base.type === 'shape' && previous.type === 'shape' &&
    base.shape?.channel === 'color-clip' && previous.shape?.channel === 'color-clip' &&
    propertyEnabled(state, track, 'shapeMix')) {
    base.shape.mix = previous.shape.mix;
  }
  if (base.type === 'effect' && previous.type === 'effect' && base.mask && previous.mask) {
    if (propertyEnabled(state, track, 'maskPosition')) {
      base.mask.offset = roundedPosition(previous.mask.offset);
    }
    if (propertyEnabled(state, track, 'maskOpacity')) {
      if ('opacity' in previous.mask) base.mask.opacity = previous.mask.opacity;
      else delete base.mask.opacity;
    }
  }
  return base;
}

function positionRecordsForTrack(state: ClipTimelineState, track: TimelineTrack | undefined | null) {
  if (!track) return [];
  if (track.kind === 'group' || track.layer?.type === 'group') {
    return (track.propertyTracks?.['position'] || []).map((key) => ({
      projectTick: key.tick,
      value: key.value,
    }));
  }
  return clipsForTrack(state, track.id).flatMap((clip) =>
    (clip.propertyTracks?.['position'] || []).map((key) => ({
      projectTick: projectTickAt(clip, key.tick),
      value: key.value,
    })).filter((record) => clipContainsTick(clip, record.projectTick)));
}

function groupOffsetAt(state: ClipTimelineState, trackId: string | null, tick: number): TimelinePoint {
  if (!trackId) return { x: 0, y: 0 };
  const track = state.tracks.find((candidate) => candidate.id === trackId);
  if (!track) return { x: 0, y: 0 };
  const fallback = roundedPosition(track.layer?.offset);
  const duration = Math.max(1, clipTimelineDurationTicks(state), tick + 1);
  return roundedPosition(resolveClipPropertyAtTick({
    startTick: 0,
    inTick: 0,
    outTick: duration,
    propertyTracks: { position: track.propertyTracks?.['position'] || [] },
  }, 'position', tick, fallback));
}

function resolvedPositionFromKeys(keys: TimelineStoredKey[], offset: number): TimelinePoint {
  const duration = Math.max(1, (keys.at(-1)?.tick ?? 0) + 1, offset + 1);
  return roundedPosition(resolveClipPropertyAtTick({
    startTick: 0,
    inTick: 0,
    outTick: duration,
    propertyTracks: { position: keys },
  }, 'position', offset, { x: 0, y: 0 }));
}

function positionKeysMatchSamples(keys: TimelineStoredKey[], samples: TimelinePoint[]): boolean {
  return samples.every((sample, offset) => {
    const resolved = resolvedPositionFromKeys(keys, offset);
    return resolved.x === sample.x && resolved.y === sample.y;
  });
}

function sparsePositionKeys(samples: TimelinePoint[]): TimelineStoredKey[] {
  if (!samples.length) return [];
  if (samples.length === 1) return [{ tick: 0, value: { ...samples[0] } }];
  const retained = new Set([0, samples.length - 1]);
  const segments: Array<[number, number]> = [[0, samples.length - 1]];
  while (segments.length) {
    const segmentBounds = segments.pop();
    if (!segmentBounds) continue;
    const [start, end] = segmentBounds;
    if (end <= start + 1) continue;
    const startSample = samples[start];
    const endSample = samples[end];
    if (!startSample || !endSample) continue;
    const segment = [
      { tick: start, value: { ...startSample } },
      { tick: end, value: { ...endSample } },
    ];
    let split = -1;
    let largestError = 0;
    for (let offset = start + 1; offset < end; offset++) {
      const resolved = resolvedPositionFromKeys(segment, offset);
      const expected = samples[offset];
      if (!expected) continue;
      const error = Math.abs(resolved.x - expected.x) + Math.abs(resolved.y - expected.y);
      if (error > largestError) {
        largestError = error;
        split = offset;
      }
    }
    if (split < 0) continue;
    retained.add(split);
    segments.push([start, split], [split, end]);
  }
  return [...retained].sort((first, second) => first - second)
    .flatMap((tick) => {
      const sample = samples[tick];
      return sample ? [{ tick, value: { ...sample } }] : [];
    });
}

function positionKeysForSamples(
  samples: TimelinePoint[],
  clip: TimelineClip,
  sourceRecords: PositionRecord[],
): TimelineStoredKey[] {
  const last = Math.max(0, samples.length - 1);
  const offsets = new Set([0, last]);
  for (const record of sourceRecords) {
    const offset = record.projectTick - clip.startTick;
    if (offset >= 0 && offset <= last) offsets.add(offset);
  }
  const candidate = [...offsets].sort((first, second) => first - second).map((offset) => {
    const projectTick = clip.startTick + offset;
    const rawSource = sourceRecords.find((record) => record.projectTick === projectTick)?.value;
    const source = record(rawSource) ? rawSource : {};
    const sample = samples[offset];
    return sample ? { tick: offset, value: { ...source, ...sample } } : null;
  });
  const validCandidate = candidate.flatMap((key) => key ? [key] : []);
  const local = positionKeysMatchSamples(validCandidate, samples)
    ? validCandidate
    : sparsePositionKeys(samples);
  return local.map((key) => ({ ...key, tick: clip.inTick + key.tick }));
}

function preserveReparentedPosition(
  state: ClipTimelineState,
  before: ClipTimelineState,
  track: TimelineTrack,
  previousParentId: string | null,
  nextParentId: string | null,
): boolean {
  const previousTrack = trackForLayer(before, track.layer?.id);
  if (!previousTrack || !track.layer || previousParentId === nextParentId) return false;
  const layerId = track.layer.id;
  const duration = Math.max(1, clipTimelineDurationTicks(before), clipTimelineDurationTicks(state));
  const deltas = Array.from({ length: duration }, (_, tick) => {
    const previous = groupOffsetAt(before, previousParentId, tick);
    const next = groupOffsetAt(state, nextParentId, tick);
    return { x: previous.x - next.x, y: previous.y - next.y };
  });
  const firstDelta = deltas[0] || { x: 0, y: 0 };
  const constant = deltas.every((delta) =>
    delta.x === firstDelta.x && delta.y === firstDelta.y);
  if (constant) {
    const delta = deltas[0] || { x: 0, y: 0 };
    track.layer.offset = {
      x: roundedPosition(previousTrack.layer?.offset).x + delta.x,
      y: roundedPosition(previousTrack.layer?.offset).y + delta.y,
    };
    if (track.propertyTracks?.['position']) {
      track.propertyTracks['position'] = track.propertyTracks['position'].map((key) => ({
        ...key,
        value: {
          ...(record(key.value) ? key.value : {}),
          x: (Number(record(key.value) ? key.value['x'] : 0) || 0) + delta.x,
          y: (Number(record(key.value) ? key.value['y'] : 0) || 0) + delta.y,
        },
      }));
    }
    for (const clip of clipsForTrack(state, track.id)) {
      if (!clip.propertyTracks?.['position']) continue;
      clip.propertyTracks['position'] = clip.propertyTracks['position'].map((key) => ({
        ...key,
        value: {
          ...(record(key.value) ? key.value : {}),
          x: (Number(record(key.value) ? key.value['x'] : 0) || 0) + delta.x,
          y: (Number(record(key.value) ? key.value['y'] : 0) || 0) + delta.y,
        },
      }));
    }
    return true;
  }

  const sourceRecords = [
    ...positionRecordsForTrack(before, previousTrack),
    ...positionRecordsForTrack(before, before.tracks.find((candidate) =>
      candidate.id === previousParentId)),
    ...positionRecordsForTrack(state, state.tracks.find((candidate) =>
      candidate.id === nextParentId)),
  ];
  for (const clip of clipsForTrack(state, track.id)) {
    const samples = Array.from({ length: clipDuration(clip) }, (_, offset) => {
      const tick = clip.startTick + offset;
      const local = resolvedLayer(before, layerId, tick)?.offset || previousTrack.layer?.offset;
      const delta = deltas[tick] || deltas.at(-1) || { x: 0, y: 0 };
      return {
        x: roundedPosition(local).x + delta.x,
        y: roundedPosition(local).y + delta.y,
      };
    });
    clip.propertyTracks = {
      ...(clip.propertyTracks || {}),
      position: positionKeysForSamples(samples, clip, sourceRecords),
    };
  }
  return true;
}

function ensureClipForTick(
  state: ClipTimelineState,
  track: TimelineTrack,
  layer: TimelineLayer,
  tick: number,
  makeId: TimelineIdFactory | null,
): TimelineClip | null {
  let clip = clipAtTick(state, track.id, tick);
  if (clip || track.kind === 'group' || layer?.type === 'group') return clip;
  if (track.kind === 'video' || layer?.type === 'video') return null;
  clip = visualClipDefinition(layer, track.id, generatedId(state, makeId, 'clip'), tick);
  state.clips.push(clip);
  return clip;
}

function upsertProperty(
  owner: TimelineTrack | TimelineClip,
  name: string,
  tick: number,
  value: unknown,
): boolean {
  owner.propertyTracks = { ...(owner.propertyTracks || {}) };
  const result = upsertKey(owner.propertyTracks[name], tick, value);
  if (result.changed) owner.propertyTracks[name] = result.keys;
  return result.changed;
}

function livePropertyValue(layer: TimelineLayer | null | undefined, name: string): unknown {
  if (name === 'position') return roundedPosition(layer?.offset);
  if (name === 'visibility') return layer?.visible !== false;
  if (name === 'effectIntensity') return Math.max(-1, Math.min(1,
    Number(layer?.type === 'effect' ? layer.effect?.intensity : 0) || 0));
  if (name === 'effectColor') {
    if (layer?.type === 'effect' && layer.effect?.kind === 'solid-color') return layer.effect.color;
    return null;
  }
  if (name === 'contentMask') return layer?.contentMask ? maskValue(layer.contentMask) : null;
  if (name === 'shapeMix') return layer?.type === 'shape' && layer.shape?.channel === 'color-clip'
    ? Math.max(0, Math.min(1, Number(layer.shape.mix ?? 1)))
    : 1;
  if (name === 'maskOpacity') return Math.max(0, Math.min(1,
    Number(layer?.type === 'effect' ? layer.mask?.opacity ?? 1 : 1)));
  if (name === 'maskPosition') return roundedPosition(
    layer?.type === 'effect' ? layer.mask?.offset : null);
  if (name === 'shapePath') return pathValueFromShape(layer?.type === 'shape' ? layer.shape : null);
  return null;
}

// `layers` is the editable projection; settling diffs its live values back into the
// canonical timeline without replacing animated bases with resolved values.
function reconcileLiveLayers(
  activeTick: number = get(canonicalPlayheadTick),
  options: { publish?: boolean } = {},
) {
  if (publishingResolvedView) return false;
  const liveLayers = get(layers).map((layer) => cloneDurable(layer));
  const tick = Math.max(0, integer(activeTick));
  let structureChanged = false;
  const before = getClipTimelineState();
  const result = transactClipTimeline('settle-canvas', (state, context) => {
    const liveIds = new Set(liveLayers.map((layer) => String(layer.id)));
    const retainedTracks = state.tracks.filter((track) =>
      track.kind === 'audio' || liveIds.has(String(trackLayerId(track))));
    const retainedIds = new Set(retainedTracks.map((track) => track.id));
    if (retainedTracks.length !== state.tracks.length) {
      state.tracks = retainedTracks;
      state.clips = state.clips.filter((clip) => retainedIds.has(clip.trackId));
      structureChanged = true;
    }

    const tracksByLayer = new Map(visualTracks(state).map((track) => [String(trackLayerId(track)), track]));
    for (const layer of liveLayers) {
      if (tracksByLayer.has(String(layer.id))) continue;
      const track = initialTrack(layer, generatedId(state, context.makeId, 'track'));
      state.tracks.push(track);
      tracksByLayer.set(String(layer.id), track);
      if (layer.type !== 'group') {
        state.clips.push(visualClipDefinition(
          layer,
          track.id,
          generatedId(state, context.makeId, 'clip'),
          tick,
        ));
      }
      structureChanged = true;
    }

    const trackIdByLayer = new Map([...tracksByLayer].map(([layerId, track]) => [layerId, track.id]));
    const resolvedById = new Map(resolveClipTimelineLayers(before, Math.min(
      clipTimelineDurationTicks(before) - 1,
      tick,
    )).map((layer) => [String(layer.id), layer]));

    const orderedVisual: TimelineTrack[] = [];
    const orderedTrackIds = new Set<string>();
    for (const [stackIndex, layer] of liveLayers.entries()) {
      const track = tracksByLayer.get(String(layer.id));
      if (!track || orderedTrackIds.has(track.id)) continue;
      orderedTrackIds.add(track.id);
      const previousParent = track.parentTrackId || null;
      const parentTrackId = layer.groupId == null
        ? null
        : trackIdByLayer.get(String(layer.groupId)) || null;
      const base = preserveAnimatedBase(state, track, layer, layerBase(layer));
      track.kind = trackKind(layer);
      track.name = layer.name;
      track.stackIndex = stackIndex;
      track.layer = base;
      if (parentTrackId) track.parentTrackId = parentTrackId;
      else delete track.parentTrackId;
      const reparented = preserveReparentedPosition(
        state,
        before,
        track,
        previousParent,
        parentTrackId,
      );
      if (previousParent !== parentTrackId) structureChanged = true;
      orderedVisual.push(track);

      const resolved = resolvedById.get(String(layer.id));
      const propertyNames = ['position', 'visibility', 'effectIntensity', 'shapeMix', 'maskOpacity', 'maskPosition'];
      for (const name of propertyNames) {
        if (name === 'position' && reparented) continue;
        if (!propertyEnabled(state, track, name)) continue;
        const value = livePropertyValue(layer, name);
        const previous = livePropertyValue(resolved, name);
        if (sameValue(value, previous)) continue;
        if (track.kind === 'group') {
          upsertProperty(track, name, tick, value);
        } else {
          const clip = ensureClipForTick(state, track, layer, tick, context.makeId);
          const sourceTick = clip ? sourceTickAt(clip, tick) : null;
          if (clip && sourceTick != null) upsertProperty(clip, name, sourceTick, value);
        }
      }

      if (layer.type === 'group') {
        const value = livePropertyValue(layer, 'contentMask');
        const previous = livePropertyValue(resolved, 'contentMask');
        if (!sameValue(value, previous)) upsertProperty(track, 'contentMask', tick, value);
        continue;
      }
      let clip = clipAtTick(state, track.id, tick);
      if (layer.type === 'video') {
        clip ||= clipsForTrack(state, track.id).find((candidate) => candidate.kind === 'video') || null;
        const exact = videoClipDefinition(
          layer,
          track.id,
          clip?.id || generatedId(state, context.makeId, 'clip'),
        );
        if (clip) {
          exact.frameKeys = clip.frameKeys;
          exact.propertyTracks = clip.propertyTracks;
          Object.assign(clip, exact);
        }
        else state.clips.push(exact);
        clip = exact;
        structureChanged = true;
      }
      const payload = framePayload(layer);
      const previousPayload = framePayload(resolved);
      if (!clip && !sameValue(payload, previousPayload)) {
        clip = ensureClipForTick(state, track, layer, tick, context.makeId);
        structureChanged = true;
      }
      if (clip && !sameValue(payload, previousPayload)) {
        const sourceTick = sourceTickAt(clip, tick);
        if (sourceTick == null) continue;
        const updated = upsertKey(clip.frameKeys, sourceTick, payload);
        if (updated.changed) clip.frameKeys = updated.keys;
      }
    }
    state.tracks = [
      ...orderedVisual,
      ...state.tracks.filter((track) => track.kind === 'audio'),
    ];
    state.fps = get(fps);
    state.tickDuration = 1000 / get(fps);
    return sameValue(state, before) ? false : { state, changed: true };
  });
  if (!result.changed) return false;
  if (structureChanged) {
    timelineStructureToken++;
    timelineStructureRevision.update((value) => value + 1);
  }
  if (options.publish !== false) publishResolvedTick(result.playheadTick);
  return true;
}

export function commitLayersToActiveFrame(options: { publish?: boolean } = {}) {
  return reconcileLiveLayers(get(canonicalPlayheadTick), options);
}

const CLIP_CLIPBOARD_FORMAT = 'paintty-clips';
const CLIP_CLIPBOARD_VERSION = 1;

function selectedClipTracks(state: ClipTimelineState, requestedLayerIds: Iterable<unknown>) {
  const requested = new Set([...requestedLayerIds].map(String));
  const visual = visualTracks(state);
  const selectedGroups = new Set(visual
    .filter((track) => track.kind === 'group' && requested.has(String(trackLayerId(track))))
    .map((track) => String(track.id)));
  return visual.filter((track) => {
    if (track.kind === 'group') return false;
    if (requested.has(String(trackLayerId(track)))) return true;
    let parentId = track.parentTrackId == null ? null : String(track.parentTrackId);
    const seen = new Set();
    while (parentId && !seen.has(parentId)) {
      if (selectedGroups.has(parentId)) return true;
      seen.add(parentId);
      const parent = visual.find((candidate) => String(candidate.id) === parentId);
      parentId = parent?.parentTrackId == null ? null : String(parent.parentTrackId);
    }
    return false;
  });
}

function capturedClipPayload(
  state: ClipTimelineState,
  selectedClips: TimelineClip[],
): ClipClipboardPayload | null {
  if (!selectedClips.length) return null;
  const trackIds = new Set(selectedClips.map((clip) => String(clip.trackId)));
  const tracks = state.tracks.filter((track) => trackIds.has(String(track.id)));
  if (tracks.length !== trackIds.size) return null;
  const media = clipboardMediaIdentities(tracks, selectedClips);
  if (!media) return null;
  const sourceStartTick = Math.min(...selectedClips.map((clip) => Number(clip.startTick)));
  return {
    format: CLIP_CLIPBOARD_FORMAT,
    version: CLIP_CLIPBOARD_VERSION,
    projectRevision: captureProjectRevision(),
    ...(state.fps === undefined ? {} : { fps: state.fps }),
    sourceStartTick,
    tracks: tracks.map((track) => cloneDurable(track)),
    clips: selectedClips.map((clip) => cloneDurable(clip)),
    media,
  };
}

function clipboardMediaReferences(tracks: TimelineTrack[], clips: TimelineClip[]) {
  const references = new Map<string, string>();
  const add = (assetId: unknown, kind: string) => {
    const id = String(assetId || '');
    if (!id) return false;
    const previous = references.get(id);
    if (previous && previous !== kind) return false;
    references.set(id, kind);
    return true;
  };
  for (const track of tracks) {
    const type = track.layer?.type;
    const assetId = track.layer?.type === 'image'
      ? track.layer.assetId
      : track.layer?.type === 'video' ? Reflect.get(track.layer, 'assetId') : null;
    if ((type === 'image' || type === 'video') && !add(assetId, type)) return null;
  }
  for (const clip of clips) {
    if ((clip.kind === 'audio' || clip.kind === 'video') && !add(clip.assetId, clip.kind)) {
      return null;
    }
  }
  return references;
}

function clipboardMediaIdentities(
  tracks: TimelineTrack[],
  clips: TimelineClip[],
  registry = currentMediaRegistry(),
) {
  const references = clipboardMediaReferences(tracks, clips);
  if (!references) return null;
  const identities: ClipClipboardPayload['media'] = [];
  for (const [assetId, kind] of references) {
    const asset = mediaAssetById(assetId, registry);
    if (!asset || asset.kind !== kind) return null;
    identities.push({
      assetId: asset.assetId,
      hash: asset.hash,
      generation: asset.generation,
      kind: asset.kind,
    });
  }
  return identities;
}

export function captureLayerClipClipboard(
  layerIds: Iterable<unknown> = get(selectedLayerIds),
  playhead: number = get(canonicalPlayheadTick),
): ClipClipboardPayload | null {
  if (get(playing)) return null;
  commitLayersToActiveFrame();
  const state = getClipTimelineState();
  const clips = selectedClipTracks(state, layerIds || [])
    .map((track) => clipAtTick(state, track.id, playhead))
    .filter((clip): clip is TimelineClip => clip !== null);
  return capturedClipPayload(state, clips);
}

export function captureTimelineClipClipboard(
  clipIds: Iterable<unknown> = getClipTimelineSelection().clipIds,
): ClipClipboardPayload | null {
  if (get(playing)) return null;
  commitLayersToActiveFrame();
  const state = getClipTimelineState();
  const selected = new Set([...(clipIds || [])].map(String));
  return capturedClipPayload(
    state,
    state.clips.filter((clip) => selected.has(String(clip.id))),
  );
}

function clipClipboardFailure(reason: string, details: Record<string, unknown> = {}) {
  return {
    changed: false,
    reason,
    clipIds: [],
    trackIds: [],
    layerIds: [],
    ...details,
  };
}

function validateClipClipboard(payload: unknown) {
  if (!record(payload)) return clipClipboardFailure('invalid-clipboard');
  if (payload['format'] !== CLIP_CLIPBOARD_FORMAT ||
    payload['version'] !== CLIP_CLIPBOARD_VERSION) return clipClipboardFailure('invalid-clipboard');
  if (payload['projectRevision'] !== captureProjectRevision()) {
    return clipClipboardFailure('stale-project');
  }
  if (!Array.isArray(payload['tracks']) || !payload['tracks'].length ||
    !Array.isArray(payload['clips']) || !payload['clips'].length) {
    return clipClipboardFailure('empty-clipboard');
  }
  if (Number(payload['fps']) !== Number(getClipTimelineState().fps)) {
    return clipClipboardFailure('stale-fps');
  }
  const tracks = payload['tracks'].map((track) => cloneDurable(track));
  const clips = payload['clips'].map((clip) => cloneDurable(clip));
  if (!tracks.every(isTimelineTrack) || !clips.every(isTimelineClip)) {
    return clipClipboardFailure('invalid-clipboard');
  }
  const trackIds = new Set(tracks.map((track) => String(track?.id || '')));
  const clipIds = new Set(clips.map((clip) => String(clip?.id || '')));
  if (trackIds.has('') || trackIds.size !== tracks.length ||
    clipIds.has('') || clipIds.size !== clips.length) {
    return clipClipboardFailure('invalid-clipboard');
  }
  const referencedTrackIds = new Set(clips.map((clip) => String(clip.trackId || '')));
  if (referencedTrackIds.has('') || referencedTrackIds.size !== tracks.length ||
    [...trackIds].some((id) => !referencedTrackIds.has(id))) {
    return clipClipboardFailure('invalid-clipboard');
  }
  if (tracks.some((track) => track.kind === 'group' ||
    (track.kind !== 'audio' && trackLayerId(track) == null))) {
    return clipClipboardFailure('invalid-clipboard');
  }
  const sourceStartTick = Math.min(...clips.map((clip) => Number(clip.startTick)));
  if (!Number.isSafeInteger(sourceStartTick) || payload['sourceStartTick'] !== sourceStartTick) {
    return clipClipboardFailure('invalid-clipboard');
  }
  const errors = validateClipTimelineState({
    ...(typeof payload['fps'] === 'number' ? { fps: payload['fps'] } : {}),
    tracks,
    clips,
    tags: [],
  });
  if (errors.length) return clipClipboardFailure('invalid-clipboard', { errors });
  const references = clipboardMediaReferences(tracks, clips);
  if (!references || !Array.isArray(payload['media']) || payload['media'].length !== references.size) {
    return clipClipboardFailure('invalid-clipboard');
  }
  const identities = new Map();
  for (const identity of payload['media']) {
    if (!record(identity)) return clipClipboardFailure('invalid-clipboard');
    const assetId = String(identity['assetId'] || '');
    const hash = String(identity['hash'] || '');
    const kind = String(identity['kind'] || '');
    const generation = Number(identity['generation']);
    if (!assetId || identities.has(assetId) || references.get(assetId) !== kind ||
      !/^[a-f0-9]{64}$/i.test(hash) || !Number.isSafeInteger(generation) || generation < 1) {
      return clipClipboardFailure('invalid-clipboard');
    }
    identities.set(assetId, { assetId, hash, generation, kind });
  }
  const registry = currentMediaRegistry();
  for (const [assetId, kind] of references) {
    const expected = identities.get(assetId);
    if (!expected) return clipClipboardFailure('invalid-clipboard');
    const current = mediaAssetById(assetId, registry);
    if (!current || current.kind !== kind || current.hash !== expected.hash ||
      current.generation !== expected.generation) {
      return clipClipboardFailure('stale-media');
    }
  }
  return { valid: true, tracks, clips, sourceStartTick };
}

function allocateClipboardId(
  state: ClipTimelineState,
  makeId: TimelineIdFactory | null,
  kind: string,
  reserved: Set<string>,
): string {
  const generated = new Set();
  while (generated.size < 1000) {
    const candidate = String(makeId?.(kind) || newUuid(kind));
    if (candidate && !reserved.has(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
    if (generated.has(candidate)) break;
    generated.add(candidate);
  }
  throw new Error(`Could not allocate a unique ${kind} UUID.`);
}

function interleaveCopiedTracks(
  existing: TimelineTrack[],
  copiesBySource: Map<string, TimelineTrack>,
): TimelineTrack[] {
  const placed = new Set<string>();
  const ordered: TimelineTrack[] = [];
  for (const track of existing) {
    const sourceId = String(track.id);
    const copy = copiesBySource.get(sourceId);
    if (copy) {
      ordered.push(copy);
      placed.add(sourceId);
    }
    ordered.push(track);
  }
  for (const [sourceId, copy] of copiesBySource) {
    if (!placed.has(sourceId)) ordered.push(copy);
  }
  return ordered;
}

function uniqueCopyName(value: unknown, used: Set<string>, fallback: string): string {
  const source = String(value || fallback).trim() || fallback;
  const priorCopy = /^(.*\S) copy(?: \d+)?$/i.exec(source);
  const base = priorCopy?.[1] || source;
  let suffix = 1;
  let candidate = `${base} copy`;
  while (used.has(candidate.toLocaleLowerCase())) {
    suffix++;
    candidate = `${base} copy ${suffix}`;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

export function pasteClipClipboard(payload: unknown) {
  if (get(playing)) return clipClipboardFailure('playing');
  const validated = validateClipClipboard(payload);
  if (!('valid' in validated) || validated.valid !== true) return validated;
  commitLayersToActiveFrame();
  if (beginStroke() !== true) return clipClipboardFailure('history-busy');
  try {
    const pasteTick = get(canonicalPlayheadTick);
    let committedClipIds: string[] = [];
    let committedLayerIds: string[] = [];
    const result = transactClipTimeline('paste-clips', (state, context) => {
      const reserved = new Set([
        ...state.tracks.map((track) => String(track.id)),
        ...state.clips.map((clip) => String(clip.id)),
        ...(state.tags || []).map((tag) => String(tag.id)),
        ...state.tracks.map((track) => String(trackLayerId(track) || '')).filter(Boolean),
        ...validated.tracks.map((track) => String(track.id)),
        ...validated.clips.map((clip) => String(clip.id)),
        ...validated.tracks
          .map((track) => String(trackLayerId(track) || ''))
          .filter(Boolean),
      ]);
      const currentTracks = new Map(state.tracks.map((track) => [String(track.id), track]));
      const currentGroupsByLayer = new Map(state.tracks
        .filter((track) => track.kind === 'group' && trackLayerId(track) != null)
        .map((track) => [String(trackLayerId(track)), track]));
      const usedNames = new Set(state.tracks.flatMap((track) => [track.name, track.layer?.name])
        .map((name) => String(name || '').trim().toLocaleLowerCase())
        .filter(Boolean));
      const newTrackIds = new Map<string, string>();
      const newLayerIds = new Map<string, string>();
      for (const source of validated.tracks) {
        newTrackIds.set(
          String(source.id),
          allocateClipboardId(state, context.makeId, 'track', reserved),
        );
        if (source.kind !== 'audio') {
          newLayerIds.set(
            String(trackLayerId(source)),
            allocateClipboardId(state, context.makeId, 'layer', reserved),
          );
        }
      }

      const copiesBySource = new Map<string, TimelineTrack>();
      const pastedLayerIds: string[] = [];
      for (const source of validated.tracks) {
        const sourceId = String(source.id);
        const copy = cloneDurable(source);
        const copiedTrackId = newTrackIds.get(sourceId);
        if (!copiedTrackId) continue;
        copy.id = copiedTrackId;
        delete copy['clips'];
        if (source.kind !== 'audio') {
          const sourceLayerId = String(trackLayerId(source));
          const layerId = newLayerIds.get(sourceLayerId);
          if (!layerId || !source.layer) continue;
          copy.layer = cloneDurable(source.layer);
          copy.layer.id = layerId;
          copy.layer.name = uniqueCopyName(
            source.layer?.name || source.name,
            usedNames,
            'Layer',
          );
          copy.name = copy.layer.name;
          if ('sourceLayerId' in copy) copy.sourceLayerId = layerId;
          pastedLayerIds.push(layerId);

          const currentSource = currentTracks.get(sourceId);
          let parent = currentSource?.parentTrackId == null
            ? null
            : currentTracks.get(String(currentSource.parentTrackId));
          if (currentSource && parent?.kind !== 'group') {
            const groupId = currentSource.layer?.groupId == null
              ? null
              : String(currentSource.layer.groupId);
            parent = groupId ? currentGroupsByLayer.get(groupId) : null;
          }
          if (currentSource && parent?.kind === 'group' && trackLayerId(parent) != null) {
            copy.parentTrackId = parent.id;
            copy.layer.groupId = trackLayerId(parent);
          } else {
            delete copy.parentTrackId;
            delete copy.layer.groupId;
          }
        } else {
          copy.name = uniqueCopyName(source.name, usedNames, 'Audio');
        }
        copiesBySource.set(sourceId, copy);
      }

      const pastedClips = validated.clips.map((source) => ({
        ...cloneDurable(source),
        id: allocateClipboardId(state, context.makeId, 'clip', reserved),
        trackId: newTrackIds.get(String(source.trackId)) || '',
        startTick: pasteTick + Number(source.startTick) - validated.sourceStartTick,
      }));
      const visualSources = validated.tracks.filter((track) => track.kind !== 'audio');
      const audioSources = validated.tracks.filter((track) => track.kind === 'audio');
      const visualCopies = new Map<string, TimelineTrack>(visualSources.flatMap((track) => {
        const copy = copiesBySource.get(String(track.id));
        return copy ? [[String(track.id), copy]] : [];
      }));
      const audioCopies = new Map<string, TimelineTrack>(audioSources.flatMap((track) => {
        const copy = copiesBySource.get(String(track.id));
        return copy ? [[String(track.id), copy]] : [];
      }));
      state.tracks = [
        ...interleaveCopiedTracks(
          state.tracks.filter((track) => track.kind !== 'audio'),
          visualCopies,
        ),
        ...interleaveCopiedTracks(
          state.tracks.filter((track) => track.kind === 'audio'),
          audioCopies,
        ),
      ];
      state.tracks.forEach((track, index) => { track.stackIndex = index; });
      state.clips.push(...pastedClips);
      committedClipIds = pastedClips.map((clip) => clip.id);
      committedLayerIds = pastedLayerIds;
      return {
        state,
        changed: true,
        clipIds: pastedClips.map((clip) => clip.id),
        trackIds: [...copiesBySource.values()].map((track) => track.id),
        layerIds: pastedLayerIds,
      };
    });
    if (!result.changed) {
      endStroke();
      return clipClipboardFailure(result.reason || 'invalid-result', {
        ...(result['errors'] ? { errors: result['errors'] } : {}),
      });
    }
    noteAuthoredMutation();
    publishResolvedTick(result.playheadTick);
    setCanonicalClipSelection({ clipIds: committedClipIds });
    if (committedLayerIds.length) {
      selectedLayerIds.set(new Set(committedLayerIds));
      activeLayerId.set(committedLayerIds[0] ?? null);
      activeLayerPart.set('layer');
      cellSelection.set(new Set());
    }
    endStroke();
    return result;
  } catch (error) {
    cancelStroke();
    throw error;
  }
}

export function initTimeline(initialLayers: TimelineLayer[]) {
  stop();
  const current = getClipTimelineState();
  const audioTracks = current.tracks.filter((track) => track.kind === 'audio')
    .map((track) => cloneDurable(track));
  const audioTrackIds = new Set(audioTracks.map((track) => track.id));
  const audioClips = current.clips.filter((clip) =>
    clip.kind === 'audio' && audioTrackIds.has(clip.trackId))
    .map((clip) => cloneDurable(clip));
  const state = initialVisualTimeline(initialLayers, { tracks: audioTracks, clips: audioClips });
  const result = initializeClipTimelineState(state, {
    playheadTick: 0,
    projectRevision: captureProjectRevision(),
  });
  if (result?.changed === false) throw new Error('Could not initialize the canonical timeline.');
  timelineStructureToken++;
  timelineStructureRevision.update((value) => value + 1);
  synchronizedAuthoredRevision = get(authoredRevision);
  publishResolvedTick(0);
}

export function loadCanonicalTimeline(state: ClipTimelineState) {
  stop();
  const result = initializeClipTimelineState({
    ...cloneDurable(state),
    fps: get(fps),
    tickDuration: 1000 / get(fps),
  }, {
    playheadTick: 0,
    projectRevision: captureProjectRevision(),
  });
  if (result?.changed === false) throw new Error('Could not initialize the canonical timeline.');
  timelineStructureToken++;
  timelineStructureRevision.update((value) => value + 1);
  synchronizedAuthoredRevision = get(authoredRevision);
  publishResolvedTick(0);
}

export function canonicalTimelineStateForSave() {
  commitLayersToActiveFrame();
  return getClipTimelineState();
}

export function frameStartTick(index: unknown) {
  return tickIndex(index) == null ? null : Number(index);
}

export function frameAtProjectTick(tick: unknown) {
  const index = tickIndex(tick);
  return index == null ? null : {
    frameIndex: index,
    localTick: 0,
    start: index,
    end: index + 1,
  };
}

export function frameReadModel(
  count: unknown,
  active: number,
  _holds: unknown,
  rate: unknown,
  layersAt: (index: number, active: boolean) => TimelineLayer[],
): FrameReadEntry[] {
  const safeRate = Math.max(1, Number(rate) || DEFAULT_FPS);
  return Array.from({ length: Math.max(0, integer(count)) }, (_, index) => {
    let cachedLayers: TimelineLayer[] | undefined;
    return {
      id: index,
      index,
      duration: 1000 / safeRate,
      tickDuration: 1000 / safeRate,
      hold: 1,
      get layers() {
        if (!cachedLayers) cachedLayers = layersAt(index, index === active);
        return cachedLayers;
      },
    };
  });
}

export const frames: Readable<FrameReadEntry[]> = derived(
  [canonicalClipTimeline, canonicalPlayheadTick, fps, playing],
  ([$state, $active, $rate, $playing], set: (value: FrameReadEntry[]) => void) => {
    if ($playing) return;
    const count = clipTimelineDurationTicks($state);
    set(frameReadModel(count, $active, null, $rate, (tick, active) => (
      active
        ? get(layers).map((layer) => ({ ...layer }))
        : resolveClipTimelineLayers($state, tick)
    )));
  },
  new Array<FrameReadEntry>(),
);

export function compositeFrameCells(
  frame: { layers?: TimelineLayer[] } | null | undefined,
  w: number,
  h: number,
  layerIdx: number | null = null,
  x0 = 0,
  y0 = 0,
  options: object = {},
) {
  const viewport = { x: x0, y: y0, w, h };
  const all = frame?.layers || [];
  if (layerIdx == null) return compositeWorld(all, viewport, null, options);
  const target = all[layerIdx];
  if (!target) return compositeWorld([], viewport, null, options);
  if (target.type === 'group') {
    return compositeWorld(all.filter((layer) =>
      layer.id === target.id || layer.groupId === target.id), viewport, null, options);
  }
  const group = target.groupId
    ? all.find((layer) => layer.id === target.groupId && layer.type === 'group')
    : null;
  return compositeWorld(group ? [target, group] : [target], viewport, null, options);
}

export function gotoFrame(value: unknown) {
  return seekTick(value);
}

export function seekTick(value: unknown) {
  const tick = boundedTick(value);
  if (tick == null) return false;
  if (get(playing)) stop({ preserveTick: true });
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('commit-move'));
  commitLayersToActiveFrame();
  const changed = seekClipTimelineTick(tick);
  publishResolvedTick(tick);
  return changed || tick === get(canonicalPlayheadTick);
}

export function setFps(value: unknown) {
  if (get(playing)) return false;
  const number = Number(value);
  if (!Number.isFinite(number)) return false;
  const next = Math.max(1, Math.min(60, Math.round(number)));
  if (next === get(fps)) return false;
  checkpointHistory();
  fps.set(next);
  return true;
}

function runCanonicalClipOperation(operation: () => CanonicalOperationResult) {
  commitLayersToActiveFrame();
  const result = operation();
  if (!result?.changed) return result;
  normalizeVideoSourceBounds();
  noteAuthoredMutation();
  publishResolvedTick(result.playheadTick);
  return { ...result, state: getClipTimelineState() };
}

export function moveClip(
  clipId: string,
  targetStartTick: unknown,
  options: Record<string, unknown> = {},
) {
  return runCanonicalClipOperation(() => moveCanonicalClip(clipId, targetStartTick, options));
}

export function moveClips(operations: unknown, options: Record<string, unknown> = {}) {
  return runCanonicalClipOperation(() => moveCanonicalClips(operations, options));
}

export function duplicateClips(operations: unknown, options: Record<string, unknown> = {}) {
  return runCanonicalClipOperation(() => duplicateCanonicalClips(operations, options));
}

export function moveTimelineKeys(
  selection: unknown,
  deltaTicks: unknown,
  options: Record<string, unknown> = {},
) {
  return runCanonicalClipOperation(() =>
    moveCanonicalTimelineKeys(selection, deltaTicks, options));
}

export function trimClip(
  clipId: string,
  edge: unknown,
  targetTick: unknown,
  options: Record<string, unknown> = {},
) {
  return runCanonicalClipOperation(() => trimCanonicalClip(clipId, edge, targetTick, options));
}

export function trimClips(operations: unknown, options: Record<string, unknown> = {}) {
  return runCanonicalClipOperation(() => trimCanonicalClips(operations, options));
}

export function setTimelineTag(
  definition: { id?: unknown; tick?: unknown; type?: unknown; value?: unknown },
  options: Record<string, unknown> = {},
) {
  return runCanonicalClipOperation(() => setCanonicalTimelineTag(definition, options));
}

export function setLoopStartTag(tick: unknown, options: Record<string, unknown> = {}) {
  return runCanonicalClipOperation(() => setCanonicalLoopStart(tick, options));
}

export function setLoopEndTag(tick: unknown, options: Record<string, unknown> = {}) {
  return runCanonicalClipOperation(() => setCanonicalLoopEnd(tick, options));
}

export function addCustomTimelineTag(
  tick: unknown,
  value: unknown,
  options: Record<string, unknown> = {},
) {
  return runCanonicalClipOperation(() => addCanonicalCustomTag(tick, value, options));
}

export function updateCustomTimelineTag(
  tagId: string,
  patch: { tick?: unknown; value?: unknown },
  options: Record<string, unknown> = {},
) {
  return runCanonicalClipOperation(() => updateCanonicalCustomTag(tagId, patch, options));
}

export function removeTimelineTag(tagId: string, options: Record<string, unknown> = {}) {
  return runCanonicalClipOperation(() => removeCanonicalTag(tagId, options));
}

function razorBoundaryValues(tick: unknown) {
  const projectTick = integer(tick, -1);
  if (projectTick < 0) return new Map<string, Record<string, unknown>>();
  const state = getClipTimelineState();
  const tracks = new Map(state.tracks.map((track) => [track.id, track]));
  const resolved = new Map(resolveClipTimelineLayers(state, projectTick)
    .map((layer) => [layer.id, layer]));
  return new Map<string, Record<string, unknown>>(state.clips.flatMap((clip) => {
    const track = tracks.get(clip.trackId);
    if (clip.kind === 'audio' || track?.locked ||
      projectTick <= clip.startTick || !clipContainsTick(clip, projectTick)) return [];
    const layerId = track?.layer?.id;
    const layer = layerId ? resolved.get(layerId) : undefined;
    const values: Record<string, unknown> = {};
    for (const name of [
      'position', 'visibility', 'effectIntensity', 'maskOpacity', 'maskPosition', 'shapePath',
    ]) {
      if (!(clip.propertyTracks?.[name] || []).length) continue;
      let fallback;
      if (name === 'position') fallback = layer?.offset;
      else if (name === 'visibility') fallback = layer?.visible;
      else if (name === 'effectIntensity') {
        fallback = layer?.type === 'effect' ? layer.effect?.intensity : null;
      } else if (name === 'maskOpacity') {
        fallback = layer?.type === 'effect' ? layer.mask?.opacity : null;
      } else if (name === 'maskPosition') {
        fallback = layer?.type === 'effect' ? layer.mask?.offset : null;
      } else fallback = pathValueFromShape(layer?.type === 'shape' ? layer.shape : null);
      values[name] = resolveClipPropertyAtTick(clip, name, projectTick, fallback);
    }
    return [[clip.id, values]];
  }));
}

interface RazorSplitDetail {
  originalId: string;
  rightId: string;
  sourceTick: number;
  tick?: number;
}

function razorSplitDetails(result: Record<string, unknown>): RazorSplitDetail[] {
  if (Array.isArray(result['splits'])) {
    return result['splits'].flatMap((split) => {
      if (!record(split) || typeof split['originalId'] !== 'string' ||
        typeof split['rightId'] !== 'string' || typeof split['sourceTick'] !== 'number') return [];
      return [{
        originalId: split['originalId'],
        rightId: split['rightId'],
        sourceTick: split['sourceTick'],
        ...(typeof split['tick'] === 'number' ? { tick: split['tick'] } : {}),
      }];
    });
  }
  const left = record(result['left']) ? result['left'] : null;
  const right = record(result['right']) ? result['right'] : null;
  return left && right && typeof left['id'] === 'string' && typeof right['id'] === 'string' &&
    typeof result['sourceTick'] === 'number'
    ? [{ originalId: left['id'], rightId: right['id'], sourceTick: result['sourceTick'] }]
    : [];
}

export function razorClip(
  ...args: [first?: unknown, second?: unknown, third?: Record<string, unknown>]
) {
  const tick = Number.isFinite(Number(args[1])) ? Number(args[1]) : Number(args[0]);
  commitLayersToActiveFrame();
  const boundaryValues = razorBoundaryValues(tick);
  const result = razorCanonicalClips(...args);
  if (!result?.changed) return result;
  const splits = razorSplitDetails(result);
  if (splits.length) {
    transactClipTimeline('materialize-razor-right-boundaries', (state) => {
      let changed = false;
      for (const split of splits) {
        const clip = state.clips.find((candidate) => candidate.id === split.rightId);
        const values = boundaryValues.get(split.originalId);
        if (!clip || !values) continue;
        for (const [name, value] of Object.entries(values)) {
          changed = upsertProperty(
            clip,
            name,
            split.sourceTick,
            name === 'shapePath' ? { path: value } : value,
          ) || changed;
        }
      }
      return changed ? { state, changed: true } : false;
    });
  }
  normalizeVideoSourceBounds();
  noteAuthoredMutation();
  publishResolvedTick(result.playheadTick);
  return { ...result, state: getClipTimelineState() };
}

export function razorClips(cuts: unknown, options: Record<string, unknown> = {}) {
  const requested = Array.isArray(cuts) ? cuts.filter(record) : [];
  commitLayersToActiveFrame();
  const boundaryValues = new Map<string, Record<string, unknown>>();
  for (const cut of requested) {
    const tick = integer(cut['tick'], -1);
    const clipId = String(cut['clipId'] ?? '');
    if (!clipId || tick < 0) continue;
    const values = razorBoundaryValues(tick).get(clipId);
    if (values) boundaryValues.set(`${clipId}\u0000${tick}`, values);
  }
  const result = razorCanonicalPath(requested, options);
  if (!result?.changed) return result;
  const splits = razorSplitDetails(result);
  if (splits.length) {
    transactClipTimeline('materialize-razor-path-boundaries', (state) => {
      let changed = false;
      for (const split of splits) {
        if (split.tick == null) continue;
        const clip = state.clips.find((candidate) => candidate.id === split.rightId);
        const values = boundaryValues.get(`${split.originalId}\u0000${split.tick}`);
        if (!clip || !values) continue;
        for (const [name, value] of Object.entries(values)) {
          changed = upsertProperty(
            clip,
            name,
            split.sourceTick,
            name === 'shapePath' ? { path: value } : value,
          ) || changed;
        }
      }
      return changed ? { state, changed: true } : false;
    });
  }
  normalizeVideoSourceBounds();
  noteAuthoredMutation();
  publishResolvedTick(result.playheadTick);
  return { ...result, state: getClipTimelineState() };
}

export function deleteClipSelection(
  selection: unknown = getClipTimelineSelection(),
  options: Record<string, unknown> = {},
) {
  return runCanonicalClipOperation(() => deleteCanonicalSelection(selection, options));
}

export function rippleClips(
  ...args: [
    first?: unknown,
    startTick?: unknown,
    endTick?: unknown,
    options?: Record<string, unknown>,
  ]
) {
  return runCanonicalClipOperation(() => rippleCanonicalClips(...args));
}

export function addEmptyClipTime(
  tick: unknown,
  ticks: unknown,
  options: Record<string, unknown> = {},
) {
  return runCanonicalClipOperation(() => addCanonicalEmpty(tick, ticks, options));
}

export function setClipSelection(selection: unknown) {
  return setCanonicalClipSelection(selection);
}

export function clearClipSelection() {
  return clearCanonicalClipSelection();
}

export const razor = razorClip;
export const deleteSelection = deleteClipSelection;
export const ripple = rippleClips;
export const addEmpty = addEmptyClipTime;

export function appendProjectTick(blankActive = false) {
  if (get(playing)) return false;
  const state = getClipTimelineState();
  const at = get(canonicalPlayheadTick) + 1;
  const activeId = get(activeLayerId);
  checkpointHistory();
  const result = transactClipTimeline('insert-project-tick', (draft) => {
    let changed = false;
    for (const track of draft.tracks) {
      if (track.kind !== 'group' || !track.propertyTracks) continue;
      track.propertyTracks = Object.fromEntries(Object.entries(track.propertyTracks).map(
        ([name, keys]) => [name, keys.map((key) => ({
          ...key,
          tick: key.tick >= at ? key.tick + 1 : key.tick,
        }))],
      ));
    }
    for (const clip of draft.clips) {
      if (clip.kind === 'audio') continue;
      const end = clip.startTick + clipDuration(clip);
      if (clip.startTick >= at) {
        clip.startTick++;
        changed = true;
        continue;
      }
      if (end < at) continue;
      const sourceTick = clip.inTick + at - clip.startTick;
      clip.frameKeys = clip.frameKeys.map((key) => ({
        ...key,
        tick: key.tick >= sourceTick ? key.tick + 1 : key.tick,
      }));
      clip.propertyTracks = Object.fromEntries(Object.entries(clip.propertyTracks || {}).map(
        ([name, keys]) => [name, keys.map((key) => ({
          ...key,
          tick: key.tick >= sourceTick ? key.tick + 1 : key.tick,
        }))],
      ));
      clip.outTick++;
      clip.sourceDuration++;
      changed = true;
      if (blankActive) {
        const track = draft.tracks.find((candidate) => candidate.id === clip.trackId);
        if (track?.layer?.id === activeId && ['cell', 'background', 'text', 'shape'].includes(
          track.layer.type,
        )) {
          const blank: FramePayload = { cells: {} };
          if (track.layer.type === 'text') Object.assign(blank, {
            text: '', box: null, wrap: true, fg: '#ffffff', runs: [],
          });
          if (track.layer.type === 'shape') blank.shape = null;
          clip.frameKeys.push({ tick: sourceTick, value: blank });
          clip.frameKeys.sort((first, second) => first.tick - second.tick);
        }
      }
    }
    return changed ? { state: draft, changed: true } : false;
  });
  if (!result.changed) return false;
  seekClipTimelineTick(at);
  publishResolvedTick(at);
  return true;
}

// Temporary call-site alias only. It has no persisted compatibility contract and
// delegates to canonical clip/tick state; no global frame collection exists.
export const addFrame = appendProjectTick;

function propertyContext(
  state: ClipTimelineState,
  layerId: unknown,
  projectTick: number,
  makeId: TimelineIdFactory | null = null,
  create = false,
): PropertyContextValue | null {
  const track = trackForLayer(state, layerId);
  if (!track) return null;
  if (track.kind === 'group' || track.layer?.type === 'group') {
    return { track, owner: track, sourceTick: projectTick, clip: null };
  }
  let clip = clipAtTick(state, track.id, projectTick);
  if (!clip && create) {
    const live = get(layers).find((layer) => layer.id === layerId) || track.layer;
    if (live) clip = ensureClipForTick(state, track, live, projectTick, makeId);
  }
  if (!clip) return { track, owner: null, sourceTick: null, clip: null };
  const sourceTick = sourceTickAt(clip, projectTick);
  return sourceTick == null
    ? { track, owner: null, sourceTick: null, clip: null }
    : { track, owner: clip, sourceTick, clip };
}

function propertyRecords(
  state: ClipTimelineState,
  layerId: unknown,
  name: string,
): PropertyRecord[] {
  const track = trackForLayer(state, layerId);
  if (!track) return [];
  if (track.kind === 'group' || track.layer?.type === 'group') {
    return (track.propertyTracks?.[name] || []).map((key) => ({
      owner: track,
      clip: null,
      sourceTick: key.tick,
      projectTick: key.tick,
      key,
    }));
  }
  return clipsForTrack(state, track.id).flatMap((clip) =>
    (clip.propertyTracks?.[name] || []).map((key) => ({
      owner: clip,
      clip,
      sourceTick: key.tick,
      projectTick: projectTickAt(clip, key.tick),
      key,
    })).filter((record) => clipContainsTick(clip, record.projectTick)));
}

function propertyAt(layerId: unknown, name: string, tick: number, fallback: unknown): unknown {
  const state = getClipTimelineState();
  const context = propertyContext(state, layerId, tick);
  if (!context?.track) return cloneDurable(fallback);
  if (!context.clip) {
    const keys = context.track.propertyTracks?.[name];
    return resolveClipPropertyAtTick({
      startTick: 0,
      inTick: 0,
      outTick: clipTimelineDurationTicks(state),
      propertyTracks: { [name]: keys || [] },
    }, name, tick, fallback);
  }
  return resolveClipPropertyAtTick(context.clip, name, tick, fallback);
}

function updateBaseProperty(layer: TimelineLayer, name: string, value: unknown): void {
  if (name === 'position') layer.offset = roundedPosition(value);
  else if (name === 'visibility') layer.visible = value !== false;
  else if (name === 'effectIntensity' && layer.type === 'effect' && layer.effect) {
    layer.effect = { ...layer.effect, intensity: Number(value) };
  } else if (name === 'effectColor' && layer.type === 'effect' && layer.effect?.kind === 'solid-color') {
    layer.effect = { ...layer.effect, color: String(value) };
  } else if (name === 'contentMask' && layer.contentMask && record(value)) {
    layer.contentMask = {
      ...layer.contentMask,
      ...value,
      cells: cmClone(value['cells'] as EditorCellMap),
      offset: roundedPosition(value['offset']),
    };
  } else if (name === 'shapeMix' && layer.type === 'shape' && layer.shape?.channel === 'color-clip') {
    layer.shape = { ...layer.shape, mix: Math.max(0, Math.min(1, Number(value) || 0)) };
  } else if (name === 'maskOpacity' && layer.type === 'effect' && layer.mask) {
    layer.mask = { ...layer.mask, opacity: Number(value) };
  } else if (name === 'maskPosition' && layer.type === 'effect' && layer.mask) {
    layer.mask = { ...layer.mask, offset: roundedPosition(value) };
  }
}

function setPropertyKey(layerId: unknown, projectTick: unknown, name: string, value: unknown): boolean {
  const tick = tickIndex(projectTick);
  if (tick == null || get(playing)) return false;
  const state = getClipTimelineState();
  const current = propertyContext(state, layerId, tick);
  const existing = current?.owner?.propertyTracks?.[name]
    ?.find((key) => key.tick === current.sourceTick);
  if (existing && sameValue(existing.value, value)) return false;
  checkpointHistory();
  const result = transactClipTimeline(`set-${name}-key`, (draft, context) => {
    const target = propertyContext(draft, layerId, tick, context.makeId, true);
    if (!target?.owner || target.sourceTick == null) return false;
    const changed = upsertProperty(target.owner, name, target.sourceTick, value);
    return changed ? { state: draft, changed: true } : false;
  });
  if (result.changed) publishResolvedTick();
  return !!result.changed;
}

function setStaticProperty(layerId: unknown, name: string, value: unknown): boolean {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  if (!track || sameValue(livePropertyValue(track.layer, name), value)) return false;
  checkpointHistory();
  const result = transactClipTimeline(`set-static-${name}`, (draft) => {
    const target = trackForLayer(draft, layerId);
    if (!target?.layer) return false;
    target.layer = { ...target.layer };
    updateBaseProperty(target.layer, name, value);
    return { state: draft, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return !!result.changed;
}

function setPropertyTrackEnabled(
  layerId: unknown,
  name: string,
  enabled: unknown,
  fallback: (layer: TimelineLayer) => unknown,
): boolean {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  if (!track?.layer) return false;
  const current = propertyEnabled(state, track, name);
  const next = !!enabled;
  if (current === next) return false;
  const tick = get(canonicalPlayheadTick);
  const value = propertyAt(layerId, name, tick, fallback(track.layer));
  checkpointHistory();
  const result = transactClipTimeline(`${next ? 'enable' : 'disable'}-${name}`, (draft, context) => {
    const targetTrack = trackForLayer(draft, layerId);
    if (!targetTrack) return false;
    if (next) {
      const target = propertyContext(draft, layerId, tick, context.makeId, true);
      if (!target?.owner || target.sourceTick == null) return false;
      upsertProperty(target.owner, name, target.sourceTick, value);
    } else {
      if (!targetTrack.layer) return false;
      targetTrack.layer = { ...targetTrack.layer };
      updateBaseProperty(targetTrack.layer, name, value);
      if (targetTrack.propertyTracks?.[name]) {
        targetTrack.propertyTracks = { ...targetTrack.propertyTracks };
        delete targetTrack.propertyTracks[name];
      }
      for (const clip of clipsForTrack(draft, targetTrack.id)) {
        if (!clip.propertyTracks?.[name]) continue;
        clip.propertyTracks = { ...clip.propertyTracks };
        delete clip.propertyTracks[name];
      }
    }
    return { state: draft, changed: true };
  });
  if (result.changed) publishResolvedTick(tick);
  return !!result.changed;
}

function deletePropertyKeys(layerId: unknown, name: string, ticks: Iterable<unknown>): number[] {
  const requested = new Set([...(ticks || [])].map(Number));
  const selected = propertyRecords(getClipTimelineState(), layerId, name)
    .filter((record) => requested.has(record.projectTick));
  if (!selected.length) return [];
  checkpointHistory();
  const identities = new Set(selected.map((record) =>
    `${record.owner.id}\u0000${record.sourceTick}`));
  const result = transactClipTimeline(`delete-${name}-keys`, (state) => {
    for (const track of state.tracks) {
      if (identities.size && track.propertyTracks?.[name]) {
        track.propertyTracks[name] = track.propertyTracks[name].filter((key) =>
          !identities.has(`${track.id}\u0000${key.tick}`));
      }
    }
    for (const clip of state.clips) {
      if (!clip.propertyTracks?.[name]) continue;
      clip.propertyTracks[name] = clip.propertyTracks[name].filter((key) =>
        !identities.has(`${clip.id}\u0000${key.tick}`));
    }
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return selected.map((record) => record.projectTick);
}

function movePropertyKeys(
  layerId: unknown,
  name: string,
  ticks: Iterable<unknown>,
  delta: unknown,
): number[] {
  const state = getClipTimelineState();
  const requested = new Set([...(ticks || [])].map(Number));
  const selected = propertyRecords(state, layerId, name)
    .filter((record) => requested.has(record.projectTick));
  const shift = integer(delta);
  if (!selected.length || !shift) return [];
  if (selected.some((record) => {
    const destination = record.projectTick + shift;
    return destination < 0 || (record.clip && !clipContainsTick(record.clip, destination));
  })) return [];
  checkpointHistory();
  const edits = new Map(selected.map((record) => [
    `${record.owner.id}\u0000${record.sourceTick}`,
    record.sourceTick + shift,
  ]));
  const result = transactClipTimeline(`move-${name}-keys`, (draft) => {
    for (const owner of [...draft.tracks, ...draft.clips]) {
      const keys = owner.propertyTracks?.[name];
      if (!keys) continue;
      owner.propertyTracks = { ...owner.propertyTracks };
      const next = keys.map((key) => ({
        ...key,
        tick: edits.get(`${owner.id}\u0000${key.tick}`) ?? key.tick,
      })).sort((a, b) => a.tick - b.tick);
      if (new Set(next.map((key) => key.tick)).size !== next.length) return false;
      owner.propertyTracks[name] = next;
    }
    return { state: draft, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return result.changed
    ? selected.map((record) => record.projectTick + shift).sort((a, b) => a - b)
    : [];
}

function copyPropertyKeys(
  layerId: unknown,
  name: string,
  ticks: Iterable<unknown>,
  type: string,
  mapValue: (value: unknown) => unknown = (value) => cloneDurable(value),
) {
  const requested = new Set([...(ticks || [])].map(Number));
  const selected = propertyRecords(getClipTimelineState(), layerId, name)
    .filter((record) => requested.has(record.projectTick))
    .sort((a, b) => a.projectTick - b.projectTick);
  const origin = selected[0]?.projectTick || 0;
  return {
    type,
    origin,
    keys: selected.map((record) => ({
      frame: record.projectTick - origin,
      value: mapValue(record.key.value),
    })),
  };
}

function pastePropertyKeys(
  layerId: unknown,
  name: string,
  destination: unknown,
  payload: unknown,
  type: string,
  normalize: (value: unknown) => unknown = cloneDurable,
): number[] {
  if (!record(payload)) return [];
  const start = integer(destination, -1);
  if (payload['type'] !== type || !Array.isArray(payload['keys']) || start < 0) return [];
  const keys = payload['keys'].flatMap((entry) => {
    if (!record(entry)) return [];
    const tick = start + integer(entry['frame']);
    const value = normalize(entry['value'] ?? entry);
    return tickIndex(tick) == null || value == null ? [] : [{ tick, value }];
  });
  if (!keys.length) return [];
  checkpointHistory();
  const result = transactClipTimeline(`paste-${name}-keys`, (state, context) => {
    let changed = false;
    for (const key of keys) {
      const target = propertyContext(state, layerId, key.tick, context.makeId, true);
      if (target?.owner && target.sourceTick != null) changed = upsertProperty(
        target.owner,
        name,
        target.sourceTick,
        key.value,
      ) || changed;
    }
    return changed ? { state, changed: true } : false;
  });
  if (result.changed) publishResolvedTick();
  return result.changed ? [...new Set(keys.map((key) => key.tick))].sort((a, b) => a - b) : [];
}

function temporalPresetEdits(preset: unknown): Partial<Record<'in' | 'out', TimelineTemporalHandle>> | null {
  if (preset === 'linear') return { in: LINEAR_TEMPORAL_HANDLE, out: LINEAR_TEMPORAL_HANDLE };
  if (preset === 'ease-in') return { in: SLOW_TEMPORAL_HANDLE };
  if (preset === 'ease-out') return { out: SLOW_TEMPORAL_HANDLE };
  if (preset === 'ease-in-out') return { in: SLOW_TEMPORAL_HANDLE, out: SLOW_TEMPORAL_HANDLE };
  return null;
}

function editPropertyKeyMetadata(
  layerId: unknown,
  name: string,
  ticks: Iterable<unknown>,
  edit: (value: unknown, record: PropertyRecord, selected: PropertyRecord[]) => unknown,
): number[] {
  const requested = new Set([...(ticks || [])].map(Number));
  const selected = propertyRecords(getClipTimelineState(), layerId, name)
    .filter((record) => requested.has(record.projectTick));
  if (!selected.length) return [];
  const changes = new Map();
  for (const record of selected) {
    const next = edit(cloneDurable(record.key.value), record, selected);
    if (next && !sameValue(next, record.key.value)) {
      changes.set(`${record.owner.id}\u0000${record.sourceTick}`, next);
    }
  }
  if (!changes.size) return [];
  checkpointHistory();
  const result = transactClipTimeline(`edit-${name}-key-metadata`, (state) => {
    for (const owner of [...state.tracks, ...state.clips]) {
      if (!owner.propertyTracks?.[name]) continue;
      owner.propertyTracks[name] = owner.propertyTracks[name].map((key) => {
        const value = changes.get(`${owner.id}\u0000${key.tick}`);
        return value ? { ...key, value } : key;
      });
    }
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return selected.map((record) => record.projectTick);
}

export function setLayerOffsetById(frameValue: unknown, layerId: unknown, offset: unknown) {
  const value = roundedPosition(offset);
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  if (!track) return false;
  return propertyEnabled(state, track, 'position')
    ? setPropertyKey(layerId, Number(frameValue), 'position', value)
    : setStaticProperty(layerId, 'position', value);
}

export function hasPosKey(layerId: unknown, frameValue: unknown) {
  const tick = Number(frameValue);
  return propertyRecords(getClipTimelineState(), layerId, 'position')
    .some((record) => record.projectTick === tick);
}

export function setPosKey(layerId: unknown, frameValue: unknown, keyed: unknown) {
  const tick = tickIndex(frameValue);
  if (tick == null) return false;
  const owns = hasPosKey(layerId, tick);
  if (owns === !!keyed) return false;
  if (!keyed) return deletePropertyKeys(layerId, 'position', [tick]).length > 0;
  const layer = resolvedLayer(getClipTimelineState(), layerId, tick);
  return setPropertyKey(layerId, tick, 'position', roundedPosition(layer?.offset));
}

export function togglePosKey(layerId: unknown, frameValue: unknown) {
  return setPosKey(layerId, frameValue, !hasPosKey(layerId, frameValue));
}

export function anyPosKeys(layerId: unknown) {
  return propertyRecords(getClipTimelineState(), layerId, 'position').length > 0;
}

export function clearPosKeys(layerId: unknown) {
  return setPropertyTrackEnabled(layerId, 'position', false, (layer) => layer.offset || { x: 0, y: 0 });
}

export function positionKeys(layerId: unknown) {
  return propertyRecords(getClipTimelineState(), layerId, 'position')
    .map((entry) => ({
      frame: entry.projectTick,
      ...roundedPosition(entry.key.value),
      interpolation: validInterpolation(record(entry.key.value)
        ? entry.key.value['interpolation'] : null),
      ...(normalizeTemporalEase(record(entry.key.value) ? entry.key.value['temporalEase'] : null)
        ? { temporalEase: normalizeTemporalEase(record(entry.key.value)
          ? entry.key.value['temporalEase'] : null) }
        : {}),
    })).sort((a, b) => a.frame - b.frame);
}

export function deletePosKeys(layerId: unknown, ticks: Iterable<unknown>) {
  return deletePropertyKeys(layerId, 'position', ticks);
}

export function movePosKeys(layerId: unknown, ticks: Iterable<unknown>, delta: unknown) {
  return movePropertyKeys(layerId, 'position', ticks, delta);
}

export function copyPosKeys(layerId: unknown, ticks: Iterable<unknown>) {
  const payload = copyPropertyKeys(layerId, 'position', ticks, 'position');
  return {
    ...payload,
    keys: payload.keys.map(({ frame, value }) => ({
      frame,
      ...(record(value) ? cloneDurable(value) : {}),
    })),
  };
}

export function pastePosKeys(layerId: unknown, destinationFrame: unknown, payload: unknown) {
  const normalized = record(payload) && payload['type'] === 'position'
    ? {
      ...payload,
      keys: (Array.isArray(payload['keys']) ? payload['keys'] : []).flatMap((key) => record(key) ? [{
        frame: key['frame'],
        value: {
          x: integer(key['x']),
          y: integer(key['y']),
          interpolation: validInterpolation(key['interpolation']),
          ...(normalizeTemporalEase(key['temporalEase'])
            ? { temporalEase: normalizeTemporalEase(key['temporalEase']) }
            : {}),
        },
      }] : []),
    }
    : payload;
  return pastePropertyKeys(layerId, 'position', destinationFrame, normalized, 'position');
}

export function setPosKeyInterpolation(
  layerId: unknown,
  ticks: Iterable<unknown>,
  interpolation: unknown,
) {
  const preset = validInterpolation(interpolation);
  return editPropertyKeyMetadata(layerId, 'position', ticks, (value) => ({
    ...(record(value) ? value : {}),
    interpolation: preset,
  }));
}

function setPropertyTemporalEase(
  layerId: unknown,
  name: string,
  ticks: Iterable<unknown>,
  edits: Partial<Record<'in' | 'out', TimelineTemporalHandle | null>> | null,
) {
  if (!edits) return [];
  const ordered = propertyRecords(getClipTimelineState(), layerId, name)
    .sort((a, b) => a.projectTick - b.projectTick);
  const indexByIdentity = new Map(ordered.map((record, index) => [
    `${record.owner.id}\u0000${record.sourceTick}`,
    index,
  ]));
  return editPropertyKeyMetadata(layerId, name, ticks, (value, record) => {
    const index = indexByIdentity.get(`${record.owner.id}\u0000${record.sourceTick}`);
    let key = value;
    for (const [side, handle] of Object.entries(edits)) {
      if ((side === 'in' && index === 0) || (side === 'out' && index === ordered.length - 1)) continue;
      key = withTemporalEaseSide(key, side, handle);
    }
    return key;
  });
}

export function setPosKeyTemporalEase(
  layerId: unknown,
  ticks: Iterable<unknown>,
  side: unknown,
  handle: unknown,
) {
  if ((side !== 'in' && side !== 'out') ||
    (handle != null && !normalizeTemporalHandle(handle))) return [];
  return setPropertyTemporalEase(layerId, 'position', ticks, { [side]: handle });
}

export function setPosKeyTemporalPreset(layerId: unknown, ticks: Iterable<unknown>, preset: unknown) {
  return setPropertyTemporalEase(layerId, 'position', ticks, temporalPresetEdits(preset));
}

export function isVisibilityTrackEnabled(layerId: unknown) {
  const state = getClipTimelineState();
  return propertyEnabled(state, trackForLayer(state, layerId), 'visibility');
}

export function visibilityAt(layerId: unknown, frameIdx: unknown) {
  const tick = tickIndex(frameIdx);
  if (tick == null) return false;
  return propertyAt(layerId, 'visibility', tick,
    trackForLayer(getClipTimelineState(), layerId)?.layer?.visible !== false) !== false;
}

export function visibilityKeys(layerId: unknown) {
  return propertyRecords(getClipTimelineState(), layerId, 'visibility')
    .map((record) => ({ frame: record.projectTick, visible: record.key.value !== false }))
    .sort((a, b) => a.frame - b.frame);
}

export function hasVisibilityKey(layerId: unknown, frameIdx: unknown) {
  const tick = Number(frameIdx);
  return propertyRecords(getClipTimelineState(), layerId, 'visibility')
    .some((record) => record.projectTick === tick);
}

export function setVisibilityTrackEnabled(layerId: unknown, enabled: unknown) {
  return setPropertyTrackEnabled(layerId, 'visibility', enabled, (layer) => layer.visible !== false);
}

export function setVisibilityKey(layerId: unknown, frameIdx: unknown, visible: unknown) {
  return setPropertyKey(layerId, Number(frameIdx), 'visibility', !!visible);
}

export function toggleVisibilityKey(layerId: unknown, frameIdx: unknown) {
  const tick = tickIndex(frameIdx);
  if (tick == null) return false;
  return hasVisibilityKey(layerId, tick)
    ? deletePropertyKeys(layerId, 'visibility', [tick]).length > 0
    : setPropertyKey(layerId, tick, 'visibility', visibilityAt(layerId, tick));
}

export function deleteVisibilityKeys(layerId: unknown, ticks: Iterable<unknown>) {
  return deletePropertyKeys(layerId, 'visibility', ticks);
}

export function moveVisibilityKeys(layerId: unknown, ticks: Iterable<unknown>, delta: unknown) {
  return movePropertyKeys(layerId, 'visibility', ticks, delta);
}

export function copyVisibilityKeys(layerId: unknown, ticks: Iterable<unknown>) {
  const payload = copyPropertyKeys(layerId, 'visibility', ticks, 'visibility');
  return {
    ...payload,
    keys: payload.keys.map(({ frame, value }) => ({ frame, visible: value !== false })),
  };
}

export function pasteVisibilityKeys(layerId: unknown, destinationFrame: unknown, payload: unknown) {
  const normalized = record(payload) && payload['type'] === 'visibility'
    ? {
      ...payload,
      keys: (Array.isArray(payload['keys']) ? payload['keys'] : []).flatMap((key) =>
        record(key) ? [{ frame: key['frame'], value: key['visible'] !== false }] : []),
    }
    : payload;
  return pastePropertyKeys(layerId, 'visibility', destinationFrame, normalized, 'visibility');
}

type ScalarPropertyName = 'effectIntensity' | 'maskOpacity' | 'shapeMix';
interface ScalarPropertyConfig {
  min: number;
  max: number;
  fallback: number;
  supports: (layer: TimelineLayer | null | undefined) => boolean;
  base: (layer: TimelineLayer) => number;
  payloadType: string;
}

const SCALAR_PROPERTIES: Record<ScalarPropertyName, ScalarPropertyConfig> = {
  effectIntensity: {
    min: -1,
    max: 1,
    fallback: 0,
    supports: (layer) => layer?.type === 'effect' && !!layer.effect,
    base: (layer) => layer.type === 'effect' ? layer.effect?.intensity ?? 0 : 0,
    payloadType: 'effect-intensity',
  },
  maskOpacity: {
    min: 0,
    max: 1,
    fallback: 1,
    supports: (layer) => layer?.type === 'effect' && !!layer.mask,
    base: (layer) => layer.type === 'effect' ? layer.mask?.opacity ?? 1 : 1,
    payloadType: 'mask-opacity',
  },
  shapeMix: {
    min: 0,
    max: 1,
    fallback: 1,
    supports: (layer) => layer?.type === 'shape' && layer.shape?.channel === 'color-clip',
    base: (layer) => layer.type === 'shape' ? layer.shape?.mix ?? 1 : 1,
    payloadType: 'shape-mix',
  },
};

function clampScalar(value: unknown, config: ScalarPropertyConfig): number {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(config.min, Math.min(config.max, number))
    : config.fallback;
}

function scalarAt(layerId: unknown, frameIdx: unknown, name: ScalarPropertyName): number {
  const config = SCALAR_PROPERTIES[name];
  const tick = tickIndex(frameIdx);
  const track = trackForLayer(getClipTimelineState(), layerId);
  if (tick == null || !track?.layer || !config.supports(track.layer)) return config.fallback;
  return clampScalar(propertyAt(layerId, name, tick, config.base(track.layer)), config);
}

function scalarTrackEnabled(layerId: unknown, name: ScalarPropertyName): boolean {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  return !!SCALAR_PROPERTIES[name]?.supports(track?.layer) && propertyEnabled(state, track, name);
}

function hasScalarKey(layerId: unknown, frameIdx: unknown, name: ScalarPropertyName): boolean {
  const tick = Number(frameIdx);
  return propertyRecords(getClipTimelineState(), layerId, name)
    .some((record) => record.projectTick === tick);
}

function setScalarTrackEnabled(layerId: unknown, enabled: unknown, name: ScalarPropertyName): boolean {
  const config = SCALAR_PROPERTIES[name];
  const track = trackForLayer(getClipTimelineState(), layerId);
  if (!track?.layer || !config.supports(track.layer)) return false;
  return setPropertyTrackEnabled(layerId, name, enabled, config.base);
}

function setScalarKey(
  layerId: unknown,
  frameIdx: unknown,
  value: unknown,
  name: ScalarPropertyName,
): boolean {
  const config = SCALAR_PROPERTIES[name];
  const track = trackForLayer(getClipTimelineState(), layerId);
  if (!track?.layer || !config.supports(track.layer)) return false;
  return setPropertyKey(layerId, Number(frameIdx), name, clampScalar(value, config));
}

function toggleScalarKey(layerId: unknown, frameIdx: unknown, name: ScalarPropertyName): boolean {
  const tick = tickIndex(frameIdx);
  if (tick == null) return false;
  return hasScalarKey(layerId, tick, name)
    ? deletePropertyKeys(layerId, name, [tick]).length > 0
    : setScalarKey(layerId, tick, scalarAt(layerId, tick, name), name);
}

function scalarKeys(layerId: unknown, name: ScalarPropertyName) {
  const config = SCALAR_PROPERTIES[name];
  return propertyRecords(getClipTimelineState(), layerId, name)
    .map((record) => ({ frame: record.projectTick, value: clampScalar(record.key.value, config) }))
    .sort((a, b) => a.frame - b.frame);
}

function copyScalarKeys(layerId: unknown, ticks: Iterable<unknown>, name: ScalarPropertyName) {
  const config = SCALAR_PROPERTIES[name];
  const payload = copyPropertyKeys(layerId, name, ticks, config.payloadType,
    (value) => clampScalar(value, config));
  return { ...payload, keys: payload.keys.map(({ frame, value }) => ({ frame, value })) };
}

function pasteScalarKeys(
  layerId: unknown,
  destination: unknown,
  payload: unknown,
  name: ScalarPropertyName,
) {
  const config = SCALAR_PROPERTIES[name];
  return pastePropertyKeys(
    layerId,
    name,
    destination,
    payload,
    config.payloadType,
    (value) => clampScalar(value, config),
  );
}

export const effectIntensityAt = (layerId: unknown, frame: unknown) =>
  scalarAt(layerId, frame, 'effectIntensity');
export const isEffectIntensityTrackEnabled = (layerId: unknown) =>
  scalarTrackEnabled(layerId, 'effectIntensity');
export const hasEffectIntensityKey = (layerId: unknown, frame: unknown) =>
  hasScalarKey(layerId, frame, 'effectIntensity');
export const setEffectIntensityTrackEnabled = (layerId: unknown, enabled: unknown) =>
  setScalarTrackEnabled(layerId, enabled, 'effectIntensity');
export const setEffectIntensityKey = (layerId: unknown, frame: unknown, value: unknown) =>
  setScalarKey(layerId, frame, value, 'effectIntensity');
export const toggleEffectIntensityKey = (layerId: unknown, frame: unknown) =>
  toggleScalarKey(layerId, frame, 'effectIntensity');
export const effectIntensityKeys = (layerId: unknown) => scalarKeys(layerId, 'effectIntensity');
export const deleteEffectIntensityKeys = (layerId: unknown, ticks: Iterable<unknown>) =>
  deletePropertyKeys(layerId, 'effectIntensity', ticks);
export const moveEffectIntensityKeys = (
  layerId: unknown,
  ticks: Iterable<unknown>,
  delta: unknown,
) =>
  movePropertyKeys(layerId, 'effectIntensity', ticks, delta);
export const copyEffectIntensityKeys = (layerId: unknown, ticks: Iterable<unknown>) =>
  copyScalarKeys(layerId, ticks, 'effectIntensity');
export const pasteEffectIntensityKeys = (layerId: unknown, destination: unknown, payload: unknown) =>
  pasteScalarKeys(layerId, destination, payload, 'effectIntensity');

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
function normalizeEffectColor(value: unknown): string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value) ? value.toLowerCase() : '#ffffff';
}
function supportsEffectColor(layer: TimelineLayer | null | undefined): boolean {
  return layer?.type === 'effect' && layer.effect?.kind === 'solid-color';
}
function effectColorBase(layer: TimelineLayer): string {
  return layer.type === 'effect' && layer.effect?.kind === 'solid-color'
    ? normalizeEffectColor(layer.effect.color)
    : '#ffffff';
}
export function effectColorAt(layerId: unknown, frame: unknown): string {
  const tick = tickIndex(frame);
  const track = trackForLayer(getClipTimelineState(), layerId);
  if (tick == null || !track?.layer || !supportsEffectColor(track.layer)) return '#ffffff';
  return normalizeEffectColor(propertyAt(layerId, 'effectColor', tick, effectColorBase(track.layer)));
}
export function isEffectColorTrackEnabled(layerId: unknown): boolean {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  return supportsEffectColor(track?.layer) && propertyEnabled(state, track, 'effectColor');
}
export function hasEffectColorKey(layerId: unknown, frame: unknown): boolean {
  const tick = Number(frame);
  return propertyRecords(getClipTimelineState(), layerId, 'effectColor')
    .some((record) => record.projectTick === tick);
}
export function setEffectColorTrackEnabled(layerId: unknown, enabled: unknown): boolean {
  const track = trackForLayer(getClipTimelineState(), layerId);
  if (!supportsEffectColor(track?.layer)) return false;
  return setPropertyTrackEnabled(layerId, 'effectColor', enabled, effectColorBase);
}
export function setEffectColorKey(layerId: unknown, frame: unknown, value: unknown): boolean {
  const track = trackForLayer(getClipTimelineState(), layerId);
  if (!supportsEffectColor(track?.layer)) return false;
  return setPropertyKey(layerId, Number(frame), 'effectColor', normalizeEffectColor(value));
}
export function toggleEffectColorKey(layerId: unknown, frame: unknown): boolean {
  const tick = tickIndex(frame);
  if (tick == null) return false;
  return hasEffectColorKey(layerId, tick)
    ? deletePropertyKeys(layerId, 'effectColor', [tick]).length > 0
    : setEffectColorKey(layerId, tick, effectColorAt(layerId, tick));
}
export function deleteEffectColorKeys(layerId: unknown, ticks: Iterable<unknown>) {
  return deletePropertyKeys(layerId, 'effectColor', ticks);
}
export function moveEffectColorKeys(
  layerId: unknown,
  ticks: Iterable<unknown>,
  delta: unknown,
) {
  return movePropertyKeys(layerId, 'effectColor', ticks, delta);
}
export function effectColorKeys(layerId: unknown) {
  return propertyRecords(getClipTimelineState(), layerId, 'effectColor')
    .map((record) => ({ frame: record.projectTick, value: normalizeEffectColor(record.key.value) }));
}

export const maskOpacityAt = (layerId: unknown, frame: unknown) => scalarAt(layerId, frame, 'maskOpacity');
export const isMaskOpacityTrackEnabled = (layerId: unknown) => scalarTrackEnabled(layerId, 'maskOpacity');
export const hasMaskOpacityKey = (layerId: unknown, frame: unknown) =>
  hasScalarKey(layerId, frame, 'maskOpacity');
export const setMaskOpacityTrackEnabled = (layerId: unknown, enabled: unknown) =>
  setScalarTrackEnabled(layerId, enabled, 'maskOpacity');
export const setMaskOpacityKey = (layerId: unknown, frame: unknown, value: unknown) =>
  setScalarKey(layerId, frame, value, 'maskOpacity');
export const toggleMaskOpacityKey = (layerId: unknown, frame: unknown) =>
  toggleScalarKey(layerId, frame, 'maskOpacity');
export const maskOpacityKeys = (layerId: unknown) => scalarKeys(layerId, 'maskOpacity');
export const deleteMaskOpacityKeys = (layerId: unknown, ticks: Iterable<unknown>) =>
  deletePropertyKeys(layerId, 'maskOpacity', ticks);
export const moveMaskOpacityKeys = (layerId: unknown, ticks: Iterable<unknown>, delta: unknown) =>
  movePropertyKeys(layerId, 'maskOpacity', ticks, delta);
export const copyMaskOpacityKeys = (layerId: unknown, ticks: Iterable<unknown>) =>
  copyScalarKeys(layerId, ticks, 'maskOpacity');
export const pasteMaskOpacityKeys = (layerId: unknown, destination: unknown, payload: unknown) =>
  pasteScalarKeys(layerId, destination, payload, 'maskOpacity');

export const shapeMixAt = (layerId: unknown, frame: unknown) => scalarAt(layerId, frame, 'shapeMix');
export const isShapeMixTrackEnabled = (layerId: unknown) => scalarTrackEnabled(layerId, 'shapeMix');
export const hasShapeMixKey = (layerId: unknown, frame: unknown) => hasScalarKey(layerId, frame, 'shapeMix');
export const setShapeMixTrackEnabled = (layerId: unknown, enabled: unknown) =>
  setScalarTrackEnabled(layerId, enabled, 'shapeMix');
export const setShapeMixKey = (layerId: unknown, frame: unknown, value: unknown) =>
  setScalarKey(layerId, frame, value, 'shapeMix');
export const toggleShapeMixKey = (layerId: unknown, frame: unknown) =>
  toggleScalarKey(layerId, frame, 'shapeMix');

function supportsMaskPosition(
  layer: TimelineLayer | null | undefined,
): layer is Extract<TimelineLayer, { type: 'effect' }> & { mask: NonNullable<TimelineMask> } {
  return layer?.type === 'effect' && !!layer.mask;
}

export function maskPositionAt(layerId: unknown, frameValue: unknown) {
  const tick = tickIndex(frameValue);
  const track = trackForLayer(getClipTimelineState(), layerId);
  const layer = track?.layer;
  if (tick == null || !supportsMaskPosition(layer)) return { x: 0, y: 0 };
  return roundedPosition(propertyAt(layerId, 'maskPosition', tick, layer.mask.offset));
}

export function isMaskPositionTrackEnabled(layerId: unknown) {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  return supportsMaskPosition(track?.layer) && propertyEnabled(state, track, 'maskPosition');
}

export function setMaskPositionTrackEnabled(layerId: unknown, enabled: unknown) {
  const track = trackForLayer(getClipTimelineState(), layerId);
  if (!supportsMaskPosition(track?.layer)) return false;
  return setPropertyTrackEnabled(layerId, 'maskPosition', enabled,
    (layer) => layer.type === 'effect' ? layer.mask?.offset || { x: 0, y: 0 } : { x: 0, y: 0 });
}

export function setMaskPositionById(frameValue: unknown, layerId: unknown, offset: unknown) {
  if (!isMaskPositionTrackEnabled(layerId)) return false;
  return setPropertyKey(layerId, Number(frameValue), 'maskPosition', roundedPosition(offset));
}

export function hasMaskPositionKey(layerId: unknown, frameValue: unknown) {
  const tick = Number(frameValue);
  return propertyRecords(getClipTimelineState(), layerId, 'maskPosition')
    .some((record) => record.projectTick === tick);
}

export function toggleMaskPositionKey(layerId: unknown, frameValue: unknown) {
  const tick = tickIndex(frameValue);
  if (tick == null) return false;
  return hasMaskPositionKey(layerId, tick)
    ? deletePropertyKeys(layerId, 'maskPosition', [tick]).length > 0
    : setPropertyKey(layerId, tick, 'maskPosition', maskPositionAt(layerId, tick));
}

export function clearMaskPositionKeys(layerId: unknown) {
  return setMaskPositionTrackEnabled(layerId, false);
}

export function maskPositionKeys(layerId: unknown) {
  return propertyRecords(getClipTimelineState(), layerId, 'maskPosition')
    .map((entry) => ({
      frame: entry.projectTick,
      ...roundedPosition(entry.key.value),
      interpolation: validInterpolation(record(entry.key.value)
        ? entry.key.value['interpolation'] : null),
      ...(normalizeTemporalEase(record(entry.key.value) ? entry.key.value['temporalEase'] : null)
        ? { temporalEase: normalizeTemporalEase(record(entry.key.value)
          ? entry.key.value['temporalEase'] : null) }
        : {}),
    })).sort((a, b) => a.frame - b.frame);
}

export const deleteMaskPositionKeys = (layerId: unknown, ticks: Iterable<unknown>) =>
  deletePropertyKeys(layerId, 'maskPosition', ticks);
export const moveMaskPositionKeys = (layerId: unknown, ticks: Iterable<unknown>, delta: unknown) =>
  movePropertyKeys(layerId, 'maskPosition', ticks, delta);

export function copyMaskPositionKeys(layerId: unknown, ticks: Iterable<unknown>) {
  const payload = copyPropertyKeys(layerId, 'maskPosition', ticks, 'mask-position');
  return {
    ...payload,
    keys: payload.keys.map(({ frame, value }) => ({
      frame,
      ...(record(value) ? cloneDurable(value) : {}),
    })),
  };
}

export function pasteMaskPositionKeys(layerId: unknown, destination: unknown, payload: unknown) {
  const normalized = record(payload) && payload['type'] === 'mask-position'
    ? {
      ...payload,
      keys: (Array.isArray(payload['keys']) ? payload['keys'] : []).flatMap((key) => record(key) ? [{
        frame: key['frame'],
        value: {
          x: integer(key['x']),
          y: integer(key['y']),
          interpolation: validInterpolation(key['interpolation']),
          ...(normalizeTemporalEase(key['temporalEase'])
            ? { temporalEase: normalizeTemporalEase(key['temporalEase']) }
            : {}),
        },
      }] : []),
    }
    : payload;
  return pastePropertyKeys(layerId, 'maskPosition', destination, normalized, 'mask-position');
}

export function setMaskPositionKeyInterpolation(
  layerId: unknown,
  ticks: Iterable<unknown>,
  interpolation: unknown,
) {
  const preset = validInterpolation(interpolation);
  return editPropertyKeyMetadata(layerId, 'maskPosition', ticks, (value) => ({
    ...(record(value) ? value : {}),
    interpolation: preset,
  }));
}

export function setMaskPositionKeyTemporalEase(
  layerId: unknown,
  ticks: Iterable<unknown>,
  side: unknown,
  handle: unknown,
) {
  if ((side !== 'in' && side !== 'out') ||
    (handle != null && !normalizeTemporalHandle(handle))) return [];
  return setPropertyTemporalEase(layerId, 'maskPosition', ticks, { [side]: handle });
}

export function setMaskPositionKeyTemporalPreset(
  layerId: unknown,
  ticks: Iterable<unknown>,
  preset: unknown,
) {
  return setPropertyTemporalEase(layerId, 'maskPosition', ticks, temporalPresetEdits(preset));
}

function shapePathEntryIsEnvelope(value: unknown): value is Record<string, unknown> {
  return record(value) &&
    (Object.prototype.hasOwnProperty.call(value, 'path') ||
      Object.prototype.hasOwnProperty.call(value, 'components'));
}

function shapePathEntryPath(value: unknown): unknown {
  return shapePathEntryIsEnvelope(value) ? value['path'] : value;
}

function shapePathEntryComponents(value: unknown): Record<string, unknown> {
  const components = shapePathEntryIsEnvelope(value) ? value['components'] : null;
  return record(components)
    ? components
    : {};
}

function shapePathEntry(path: unknown, components: Record<string, unknown> = {}): unknown {
  const componentEntries = Object.entries(components).filter(([, value]) => value != null);
  if (!componentEntries.length) return path || null;
  return {
    ...(path ? { path } : {}),
    components: Object.fromEntries(componentEntries),
  };
}

function shapePathMotionKey(value: unknown, expectedKind: EditorShapeKind | null = null) {
  const path = normalizeShapePathKey(value, expectedKind || undefined);
  if (!path) return null;
  const source = record(value) ? value : {};
  const temporalEase = normalizeTemporalEase(source['temporalEase']);
  return {
    ...path,
    interpolation: validInterpolation(source['interpolation']),
    ...(temporalEase ? { temporalEase } : {}),
  };
}

function componentMotionKey(componentId: ShapeComponentId, value: unknown) {
  const source = record(value) ? value : {};
  const raw = componentId === SHAPE_PATH_COMPONENT_ROTATION
    ? (typeof value === 'number' ? value : source['value'])
    : value;
  const normalized = normalizeShapePathComponentValue(componentId, raw);
  if (normalized == null) return null;
  const temporalEase = normalizeTemporalEase(source['temporalEase']);
  const motionValue: Record<string, unknown> = {};
  if (componentId === SHAPE_PATH_COMPONENT_ROTATION) motionValue['value'] = normalized;
  else if (record(normalized)) Object.assign(motionValue, normalized);
  return {
    ...motionValue,
    interpolation: validInterpolation(source['interpolation']),
    ...(temporalEase ? { temporalEase } : {}),
  };
}

function componentMotionValue(componentId: ShapeComponentId, value: unknown) {
  const source = record(value) ? value : {};
  return normalizeShapePathComponentValue(
    componentId,
    componentId === SHAPE_PATH_COMPONENT_ROTATION ? source['value'] : value,
  );
}

function withAnchorCompensation(path: EditorShapePath | null, offset: unknown) {
  const pointOffset = numericPosition(offset);
  if (!path || (!pointOffset.x && !pointOffset.y)) return path;
  if (path.kind === 'polygon') {
    return normalizeShapePathKey({
      ...path,
      vertices: path.vertices.map((point) => ({
        x: point.x + pointOffset.x,
        y: point.y + pointOffset.y,
      })),
    }, path.kind);
  }
  if (path.kind === 'line') {
    return normalizeShapePathKey({
      ...path,
      x0: path.x0 + pointOffset.x,
      y0: path.y0 + pointOffset.y,
      x1: path.x1 + pointOffset.x,
      y1: path.y1 + pointOffset.y,
      ...(path.vertices ? {
        vertices: path.vertices.map((point) => ({
          x: point.x + pointOffset.x,
          y: point.y + pointOffset.y,
        })),
      } : {}),
    }, path.kind);
  }
  return normalizeShapePathKey({
    ...path,
    cx: path.cx + pointOffset.x,
    cy: path.cy + pointOffset.y,
    ...(path.vertices ? {
      vertices: path.vertices.map((point) => ({
        x: point.x + pointOffset.x,
        y: point.y + pointOffset.y,
      })),
    } : {}),
  }, path.kind);
}

function pathForStateAt(
  state: ClipTimelineState,
  layerId: unknown,
  tick: number,
): EditorShapePath | null {
  const track = trackForLayer(state, layerId);
  const clip = track && clipAtTick(state, track.id, tick);
  if (!clip) {
    const layer = resolvedLayer(state, layerId, tick);
    return pathValueFromShape(layer?.type === 'shape' ? layer.shape : null);
  }
  const sourceTick = sourceTickAt(clip, tick);
  if (sourceTick == null) return null;
  let frameKey: TimelineStoredKey | null = null;
  for (const key of clip.frameKeys || []) {
    if (key.tick > sourceTick) break;
    frameKey = key;
  }
  const frameValue = record(frameKey?.value) ? frameKey.value : {};
  const frameShape = isEditorShape(frameValue['shape']) ? frameValue['shape'] : null;
  const fallback = pathValueFromShape(frameShape ||
    (track.layer?.type === 'shape' ? track.layer.shape : null));
  let path = normalizeShapePathKey(resolveClipPropertyAtTick(clip, 'shapePath', tick, fallback));
  const compensation = resolveClipPropertyAtTick(
    clip,
    SHAPE_ANCHOR_COMPENSATION,
    tick,
    { x: 0, y: 0 },
  );
  const compensationPoint = numericPosition(compensation);
  if (path && (compensationPoint.x || compensationPoint.y)) {
    path = withAnchorCompensation(path, compensationPoint);
  }
  return path;
}

function pathForLayerAt(layerId: unknown, tick: number) {
  return pathForStateAt(getClipTimelineState(), layerId, tick);
}

function shapeKindsForTrack(state: ClipTimelineState, track: TimelineTrack) {
  const kinds = new Set<EditorShapeKind>();
  for (const clip of clipsForTrack(state, track.id)) {
    for (const key of clip.frameKeys || []) {
      const value = record(key.value) ? key.value : {};
      const kind = pathValueFromShape(isEditorShape(value['shape']) ? value['shape'] : null)?.kind;
      if (kind) kinds.add(kind);
    }
    for (const key of clip.propertyTracks?.['shapePath'] || []) {
      const kind = normalizeShapePathKey(shapePathEntryPath(key.value))?.kind;
      if (kind) kinds.add(kind);
    }
  }
  return kinds;
}

function polygonCountsForTrack(state: ClipTimelineState, track: TimelineTrack) {
  const counts = new Set<number>();
  for (const clip of clipsForTrack(state, track.id)) {
    for (const key of clip.frameKeys || []) {
      const value = record(key.value) ? key.value : {};
      const path = pathValueFromShape(isEditorShape(value['shape']) ? value['shape'] : null);
      if (path?.kind === 'polygon') counts.add(path.vertices.length);
    }
    for (const key of clip.propertyTracks?.['shapePath'] || []) {
      const path = normalizeShapePathKey(shapePathEntryPath(key.value));
      if (path?.kind === 'polygon') counts.add(path.vertices.length);
    }
  }
  return counts;
}

export function canAnimateShapePath(layerId: unknown) {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  if (track?.layer?.type !== 'shape') return false;
  const path = pathForLayerAt(layerId, get(canonicalPlayheadTick));
  if (!path || !SHAPE_PATH_KINDS.has(path.kind)) return false;
  const kinds = shapeKindsForTrack(state, track);
  return kinds.size <= 1 && (path.kind !== 'polygon' || polygonCountsForTrack(state, track).size <= 1);
}

export function shapePathAt(layerId: unknown, frameValue: unknown) {
  const tick = tickIndex(frameValue);
  const path = tick == null ? null : pathForLayerAt(layerId, tick);
  return path ? cloneDurable(path) : null;
}

export function shapePathComponentAt(layerId: unknown, componentId: unknown, frameValue: unknown) {
  const path = shapePathAt(layerId, frameValue);
  const component = normalizeShapePathComponentId(componentId, path);
  return component ? shapePathComponentValue(path, component) : null;
}

function shapePathRecords(state: ClipTimelineState, layerId: unknown) {
  return propertyRecords(state, layerId, 'shapePath');
}

function shapePathComponentRecords(
  state: ClipTimelineState,
  layerId: unknown,
  componentId: ShapeComponentId,
): ShapePropertyRecord[] {
  return shapePathRecords(state, layerId).flatMap((record) => {
    const key = shapePathEntryComponents(record.key.value)[componentId];
    return key == null ? [] : [{ ...record, componentKey: key }];
  });
}

export function isShapePathTrackEnabled(layerId: unknown) {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  return canAnimateShapePath(layerId) && (
    shapePathRecords(state, layerId).length > 0 ||
    (track?.shapePathComponents || []).length > 0
  );
}

export function isShapePathWholeTrackEnabled(layerId: unknown) {
  return shapePathRecords(getClipTimelineState(), layerId)
    .some((record) => !!shapePathEntryPath(record.key.value));
}

export function hasShapePathWholeKey(layerId: unknown, frameValue: unknown) {
  const tick = Number(frameValue);
  return shapePathRecords(getClipTimelineState(), layerId).some((record) =>
    record.projectTick === tick && !!shapePathEntryPath(record.key.value));
}

export function hasShapePathKey(layerId: unknown, frameValue: unknown) {
  return hasShapePathWholeKey(layerId, frameValue);
}

function mutateShapeEntry(
  layerId: unknown,
  tick: unknown,
  operation: string,
  callback: (prior: unknown, state: ClipTimelineState, target: PropertyContextValue) => unknown,
  create = true,
  finalize: ((state: ClipTimelineState, target: PropertyContextValue) => void) | null = null,
) {
  const projectTick = tickIndex(tick);
  if (projectTick == null || !canAnimateShapePath(layerId)) return false;
  checkpointHistory();
  const result = transactClipTimeline(operation, (state, context) => {
    const target = propertyContext(state, layerId, projectTick, context.makeId, create);
    if (!target?.owner) return false;
    const keys = [...(target.owner.propertyTracks?.['shapePath'] || [])];
    const index = keys.findIndex((key) => key.tick === target.sourceTick);
    const priorKey = index >= 0 ? keys[index] : null;
    const prior = priorKey ? cloneDurable(priorKey.value) : null;
    const next = callback(prior, state, target);
    if (sameValue(prior, next)) return false;
    target.owner.propertyTracks = { ...(target.owner.propertyTracks || {}) };
    if (next == null) {
      if (index < 0) return false;
      keys.splice(index, 1);
    } else if (index >= 0 && priorKey) keys[index] = { ...priorKey, value: next };
    else if (target.sourceTick != null) keys.push({ tick: target.sourceTick, value: next });
    keys.sort((a, b) => a.tick - b.tick);
    if (keys.length) target.owner.propertyTracks['shapePath'] = keys;
    else delete target.owner.propertyTracks['shapePath'];
    if (finalize) finalize(state, target);
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return !!result.changed;
}

function setFrameShape(layerId: unknown, tick: unknown, path: EditorShapePath) {
  const projectTick = tickIndex(tick);
  if (projectTick == null) return false;
  checkpointHistory();
  const result = transactClipTimeline('set-static-shape-path', (state, context) => {
    const track = trackForLayer(state, layerId);
    if (!track) return false;
    const live = get(layers).find((layer) => layer.id === layerId) ||
      resolvedLayer(state, layerId, projectTick) || track.layer;
    if (!live || live.type !== 'shape') return false;
    const clip = ensureClipForTick(state, track, live, projectTick, context.makeId);
    if (!clip) return false;
    const sourceTick = sourceTickAt(clip, projectTick);
    if (sourceTick == null) return false;
    const rawPayload = cloneDurable((clip.frameKeys || [])
      .filter((key) => key.tick <= sourceTick).at(-1)?.value);
    let payload: FramePayload = record(rawPayload)
      ? { ...rawPayload, cells: isEditorCellMap(rawPayload['cells']) ? rawPayload['cells'] : {} }
      : framePayload(live);
    const shape = payload.shape || live.shape;
    payload = {
      ...payload,
      shape: shape ? shapeWithPathValue(shape, path) : null,
    };
    payload.cells = payload.shape ? renderShapeToCells(payload.shape) : {};
    const updated = upsertKey(clip.frameKeys, sourceTick, payload);
    if (!updated.changed) return false;
    clip.frameKeys = updated.keys;
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return !!result.changed;
}

export function setShapePathById(frameValue: unknown, layerId: unknown, value: unknown) {
  const tick = tickIndex(frameValue);
  const current = tick == null ? null : shapePathAt(layerId, tick);
  const normalized = normalizeShapePathKey(value, current?.kind);
  if (!normalized || shapePathEqual(current, normalized)) return false;
  if (!isShapePathTrackEnabled(layerId)) return setFrameShape(layerId, tick, normalized);
  return mutateShapeEntry(layerId, tick, 'set-shape-path-key', (entry) => {
    const prior = shapePathEntryPath(entry);
    const key = shapePathMotionKey({ ...(record(prior) ? prior : {}), ...normalized }, normalized.kind);
    return shapePathEntry(key, shapePathEntryComponents(entry));
  });
}

export function setShapePathWholeTrackEnabled(layerId: unknown, enabled: unknown) {
  const next = !!enabled;
  if (!canAnimateShapePath(layerId) || isShapePathWholeTrackEnabled(layerId) === next) return false;
  const tick = get(canonicalPlayheadTick);
  const path = shapePathAt(layerId, tick);
  if (!path) return false;
  if (next) {
    const changed = mutateShapeEntry(layerId, tick, 'enable-shape-path', (entry) =>
      shapePathEntry(shapePathMotionKey(path, path.kind), shapePathEntryComponents(entry)));
    if (changed) {
      transactClipTimeline('record-shape-path-kind', (state) => {
        const track = trackForLayer(state, layerId);
        if (!track) return false;
        track.shapePathKind = path.kind;
        return { state, changed: true };
      });
    }
    return changed;
  }

  checkpointHistory();
  const result = transactClipTimeline('disable-shape-path', (state) => {
    const track = trackForLayer(state, layerId);
    if (!track) return false;
    for (const clip of clipsForTrack(state, track.id)) {
      clip.frameKeys = clip.frameKeys.map((key) => {
        const keyValue = record(key.value) ? key.value : {};
        const shape = isEditorShape(keyValue['shape']) ? keyValue['shape'] : null;
        if (!shape) return key;
        return {
          ...key,
          value: {
            ...keyValue,
            shape: shapeWithPathValue(shape, path),
            cells: renderShapeToCells(shapeWithPathValue(shape, path)),
          },
        };
      });
      const keys = clip.propertyTracks?.['shapePath'];
      if (!keys) continue;
      clip.propertyTracks = { ...clip.propertyTracks };
      clip.propertyTracks['shapePath'] = keys.flatMap((key) => {
        const value = shapePathEntry(null, shapePathEntryComponents(key.value));
        return value ? [{ ...key, value }] : [];
      });
      if (!clip.propertyTracks['shapePath']?.length) delete clip.propertyTracks['shapePath'];
    }
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick(tick);
  return !!result.changed;
}

export function setShapePathTrackEnabled(layerId: unknown, enabled: unknown) {
  const next = !!enabled;
  if (isShapePathTrackEnabled(layerId) === next) return false;
  if (next) return setShapePathWholeTrackEnabled(layerId, true);
  const tick = get(canonicalPlayheadTick);
  const path = shapePathAt(layerId, tick);
  if (!path) return false;
  checkpointHistory();
  const result = transactClipTimeline('disable-all-shape-animation', (state) => {
    const track = trackForLayer(state, layerId);
    if (!track) return false;
    for (const clip of clipsForTrack(state, track.id)) {
      clip.frameKeys = clip.frameKeys.map((key) => {
        const keyValue = record(key.value) ? key.value : {};
        const shape = isEditorShape(keyValue['shape']) ? keyValue['shape'] : null;
        if (!shape) return key;
        const baked = shapeWithPathValue(shape, path);
        return { ...key, value: { ...keyValue, shape: baked, cells: renderShapeToCells(baked) } };
      });
      if (clip.propertyTracks?.['shapePath']) {
        clip.propertyTracks = { ...clip.propertyTracks };
        delete clip.propertyTracks['shapePath'];
      }
    }
    track.shapePathComponents = [];
    delete track.shapePathKind;
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick(tick);
  return !!result.changed;
}

export function toggleShapePathWholeKey(layerId: unknown, frameValue: unknown) {
  const tick = tickIndex(frameValue);
  if (tick == null) return false;
  if (hasShapePathWholeKey(layerId, tick)) {
    return mutateShapeEntry(layerId, tick, 'delete-shape-path-key', (entry) =>
      shapePathEntry(null, shapePathEntryComponents(entry)), false);
  }
  const path = shapePathAt(layerId, tick);
  return path ? mutateShapeEntry(layerId, tick, 'add-shape-path-key', (entry) =>
    shapePathEntry(shapePathMotionKey(path, path.kind), shapePathEntryComponents(entry)), true,
  (state) => {
    const track = trackForLayer(state, layerId);
    if (track) track.shapePathKind = path.kind;
  }) : false;
}

export const toggleShapePathKey = toggleShapePathWholeKey;

export function shapePathWholeKeys(layerId: unknown) {
  return shapePathRecords(getClipTimelineState(), layerId).flatMap((record) => {
    const path = shapePathMotionKey(shapePathEntryPath(record.key.value));
    return path ? [{ frame: record.projectTick, ...path }] : [];
  }).sort((a, b) => a.frame - b.frame);
}

export const shapePathKeys = shapePathWholeKeys;

export function deleteShapePathWholeKeys(layerId: unknown, ticks: Iterable<unknown>) {
  const requested = new Set([...(ticks || [])].map(Number));
  const selected = shapePathRecords(getClipTimelineState(), layerId)
    .filter((record) => requested.has(record.projectTick) && shapePathEntryPath(record.key.value));
  if (!selected.length) return [];
  const changed = selected.map((record) => mutateShapeEntry(
    layerId,
    record.projectTick,
    'delete-shape-path-key',
    (entry) => shapePathEntry(null, shapePathEntryComponents(entry)),
    false,
  ));
  return changed.some(Boolean) ? selected.map((record) => record.projectTick) : [];
}

export const deleteShapePathKeys = deleteShapePathWholeKeys;

function moveShapeSubset(
  layerId: unknown,
  ticks: Iterable<unknown>,
  delta: unknown,
  componentId: ShapeComponentId | null = null,
) {
  const state = getClipTimelineState();
  const requested = new Set([...(ticks || [])].map(Number));
  const records = componentId
    ? shapePathComponentRecords(state, layerId, componentId)
    : shapePathRecords(state, layerId).filter((record) => shapePathEntryPath(record.key.value));
  const selected = records.filter((record) => requested.has(record.projectTick));
  const shift = integer(delta);
  if (!selected.length || !shift || selected.some((record) =>
    record.projectTick + shift < 0 ||
    (record.clip && !clipContainsTick(record.clip, record.projectTick + shift)))) return [];
  checkpointHistory();
  const identities = new Map(selected.map((record) => [
    `${record.owner.id}\u0000${record.sourceTick}`,
    record.sourceTick + shift,
  ]));
  const result = transactClipTimeline('move-shape-keys', (draft) => {
    for (const owner of [...draft.tracks, ...draft.clips]) {
      const keys = owner.propertyTracks?.['shapePath'];
      if (!keys) continue;
      owner.propertyTracks = { ...owner.propertyTracks };
      if (!componentId) {
        const moved = keys.map((key) => ({
          ...key,
          tick: identities.get(`${owner.id}\u0000${key.tick}`) ?? key.tick,
        })).sort((a, b) => a.tick - b.tick);
        if (new Set(moved.map((key) => key.tick)).size !== moved.length) return false;
        owner.propertyTracks['shapePath'] = moved;
        continue;
      }
      const extracted: Array<{ tick: number; value: unknown }> = [];
      owner.propertyTracks['shapePath'] = keys.flatMap((key) => {
        const destination = identities.get(`${owner.id}\u0000${key.tick}`);
        const components = { ...shapePathEntryComponents(key.value) };
        if (destination == null || components[componentId] == null) return [key];
        extracted.push({ tick: destination, value: components[componentId] });
        delete components[componentId];
        const value = shapePathEntry(shapePathEntryPath(key.value), components);
        return value ? [{ ...key, value }] : [];
      });
      for (const moved of extracted) {
        const shapeKeys: TimelineStoredKey[] = owner.propertyTracks['shapePath'] || [];
        const index = shapeKeys.findIndex((key) => key.tick === moved.tick);
        const prior = index >= 0 ? shapeKeys[index] : { tick: moved.tick, value: null };
        if (!prior) continue;
        const value = shapePathEntry(shapePathEntryPath(prior.value), {
          ...shapePathEntryComponents(prior.value),
          [componentId]: moved.value,
        });
        if (index >= 0) shapeKeys[index] = { ...prior, value };
        else shapeKeys.push({ tick: moved.tick, value });
        owner.propertyTracks['shapePath'] = shapeKeys;
      }
      owner.propertyTracks['shapePath']?.sort((a, b) => a.tick - b.tick);
    }
    return { state: draft, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return result.changed
    ? selected.map((record) => record.projectTick + shift).sort((a, b) => a - b)
    : [];
}

export const moveShapePathWholeKeys = (
  layerId: unknown,
  ticks: Iterable<unknown>,
  delta: unknown,
) =>
  moveShapeSubset(layerId, ticks, delta);
export const moveShapePathKeys = moveShapePathWholeKeys;

function shapePathPayload(
  layerId: unknown,
  ticks: Iterable<unknown>,
  componentId: string | null = null,
) {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  const requested = new Set([...(ticks || [])].map(Number));
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const normalizedComponent = componentId
    ? normalizeShapePathComponentId(componentId, path)
    : null;
  const records = (normalizedComponent
    ? shapePathComponentRecords(state, layerId, normalizedComponent)
    : shapePathRecords(state, layerId).filter((record) => shapePathEntryPath(record.key.value)))
    .filter((record) => requested.has(record.projectTick))
    .sort((a, b) => a.projectTick - b.projectTick);
  const origin = records[0]?.projectTick || 0;
  return {
    type: componentId ? 'shape-path-component' : 'shape-path',
    ...(componentId ? { componentId } : {}),
    shapeKind: path?.kind || track?.shapePathKind || null,
    ...(path?.kind === 'polygon' ? { vertexCount: path.vertices.length } : {}),
    origin,
    keys: records.map((entry) => ({
      frame: entry.projectTick - origin,
      ...cloneRecord(componentId && 'componentKey' in entry
        ? entry.componentKey
        : shapePathEntryPath(entry.key.value)),
    })),
  };
}

export const copyShapePathWholeKeys = (layerId: unknown, ticks: Iterable<unknown>) =>
  shapePathPayload(layerId, ticks);
export const copyShapePathKeys = copyShapePathWholeKeys;

function pasteShapeKeys(
  layerId: unknown,
  componentId: ShapeComponentId | null,
  destination: unknown,
  payload: unknown,
) {
  if (!record(payload)) return [];
  const start = integer(destination, -1);
  const path = shapePathAt(layerId, Math.max(0, start));
  const expectedType = componentId ? 'shape-path-component' : 'shape-path';
  if (!path || start < 0 || payload['type'] !== expectedType || payload['shapeKind'] !== path.kind ||
    (path.kind === 'polygon' && payload['vertexCount'] !== path.vertices.length) ||
    !Array.isArray(payload['keys'])) return [];
  const changed: number[] = [];
  for (const key of payload['keys']) {
    if (!record(key)) continue;
    const tick = start + integer(key['frame']);
    if (tickIndex(tick) == null) continue;
    const success = componentId
      ? mutateShapeEntry(layerId, tick, 'paste-shape-component-key', (entry) => {
        const components = { ...shapePathEntryComponents(entry) };
        const motion = componentMotionKey(componentId, key);
        if (!motion) return entry;
        components[componentId] = motion;
        return shapePathEntry(shapePathEntryPath(entry), components);
      })
      : mutateShapeEntry(layerId, tick, 'paste-shape-path-key', (entry) => {
        const motion = shapePathMotionKey(key, path.kind);
        return motion ? shapePathEntry(motion, shapePathEntryComponents(entry)) : entry;
      });
    if (success) changed.push(tick);
  }
  return [...new Set(changed)].sort((a, b) => a - b);
}

export const pasteShapePathWholeKeys = (layerId: unknown, destination: unknown, payload: unknown) =>
  pasteShapeKeys(layerId, null, destination, payload);
export const pasteShapePathKeys = pasteShapePathWholeKeys;

function editShapePathMetadata(
  layerId: unknown,
  ticks: Iterable<unknown>,
  componentId: ShapeComponentId | null,
  edit: (value: unknown) => unknown,
) {
  const requested = new Set([...(ticks || [])].map(Number));
  const records = (componentId
    ? shapePathComponentRecords(getClipTimelineState(), layerId, componentId)
    : shapePathRecords(getClipTimelineState(), layerId).filter((record) =>
      shapePathEntryPath(record.key.value)))
    .filter((record) => requested.has(record.projectTick));
  const changed: number[] = [];
  for (const record of records) {
    if (mutateShapeEntry(layerId, record.projectTick, 'edit-shape-key-metadata', (entry) => {
      if (componentId) {
        const components = { ...shapePathEntryComponents(entry) };
        components[componentId] = edit(components[componentId]);
        return shapePathEntry(shapePathEntryPath(entry), components);
      }
      return shapePathEntry(edit(shapePathEntryPath(entry)), shapePathEntryComponents(entry));
    }, false)) changed.push(record.projectTick);
  }
  return changed;
}

export function setShapePathWholeKeyInterpolation(
  layerId: unknown,
  ticks: Iterable<unknown>,
  interpolation: unknown,
) {
  const preset = validInterpolation(interpolation);
  return editShapePathMetadata(layerId, ticks, null, (key) => ({
    ...(record(key) ? key : {}),
    interpolation: preset,
  }));
}

export const setShapePathKeyInterpolation = setShapePathWholeKeyInterpolation;

function setShapeTemporalEase(
  layerId: unknown,
  ticks: Iterable<unknown>,
  componentId: ShapeComponentId | null,
  edits: Partial<Record<'in' | 'out', TimelineTemporalHandle | null>> | null,
) {
  if (!edits) return [];
  return editShapePathMetadata(layerId, ticks, componentId, (value) => {
    let next = value;
    for (const [side, handle] of Object.entries(edits)) next = withTemporalEaseSide(next, side, handle);
    return next;
  });
}

export function setShapePathWholeKeyTemporalEase(
  layerId: unknown,
  ticks: Iterable<unknown>,
  side: unknown,
  handle: unknown,
) {
  if ((side !== 'in' && side !== 'out') ||
    (handle != null && !normalizeTemporalHandle(handle))) return [];
  return setShapeTemporalEase(layerId, ticks, null, { [side]: handle });
}

export const setShapePathKeyTemporalEase = setShapePathWholeKeyTemporalEase;

export function setShapePathWholeKeyTemporalPreset(
  layerId: unknown,
  ticks: Iterable<unknown>,
  preset: unknown,
) {
  return setShapeTemporalEase(layerId, ticks, null, temporalPresetEdits(preset));
}

export const setShapePathKeyTemporalPreset = setShapePathWholeKeyTemporalPreset;

export function isShapePathComponentEnabled(layerId: unknown, componentId: unknown) {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  return !!component && (track?.shapePathComponents || []).includes(component);
}

export function hasShapePathComponentKey(
  layerId: unknown,
  componentId: unknown,
  frameValue: unknown,
) {
  const path = shapePathAt(layerId, frameValue);
  const component = normalizeShapePathComponentId(componentId, path);
  const tick = Number(frameValue);
  return !!component && shapePathComponentRecords(getClipTimelineState(), layerId, component)
    .some((record) => record.projectTick === tick);
}

export function shapePathComponentKeys(layerId: unknown, componentId: unknown) {
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  if (!component) return [];
  return shapePathComponentRecords(getClipTimelineState(), layerId, component)
    .map((entry) => ({
      frame: entry.projectTick,
      value: componentMotionValue(component, entry.componentKey),
      interpolation: validInterpolation(record(entry.componentKey)
        ? entry.componentKey['interpolation'] : null),
      ...(normalizeTemporalEase(record(entry.componentKey) ? entry.componentKey['temporalEase'] : null)
        ? { temporalEase: normalizeTemporalEase(record(entry.componentKey)
          ? entry.componentKey['temporalEase'] : null) }
        : {}),
    })).sort((a, b) => a.frame - b.frame);
}

export function shapePathAnimationComponents(
  layerId: unknown,
  frameValue: unknown = get(canonicalPlayheadTick),
) {
  const path = shapePathAt(layerId, frameValue);
  if (!path) return [];
  return enumerateShapePathComponents(path).map((component) => ({
    ...component,
    value: shapePathComponentValue(path, component.id),
    enabled: isShapePathComponentEnabled(layerId, component.id),
    keyed: hasShapePathComponentKey(layerId, component.id, frameValue),
  }));
}

function bakeComponentIntoPayloads(
  state: ClipTimelineState,
  track: TimelineTrack,
  componentId: ShapeComponentId,
  value: ShapeComponentValue | null,
): void {
  for (const clip of clipsForTrack(state, track.id)) {
    clip.frameKeys = clip.frameKeys.map((key) => {
      const keyValue = record(key.value) ? key.value : {};
        const shape = isEditorShape(keyValue['shape']) ? keyValue['shape'] : null;
      const path = pathValueFromShape(shape);
      const bakedPath = path && withShapePathComponentValue(path, componentId, value);
      if (!shape || !bakedPath) return key;
      const baked = shapeWithPathValue(shape, bakedPath);
      return { ...key, value: { ...keyValue, shape: baked, cells: renderShapeToCells(baked) } };
    });
    const keys = clip.propertyTracks?.['shapePath'];
    if (!keys) continue;
    clip.propertyTracks['shapePath'] = keys.flatMap((key) => {
      const path = shapePathEntryPath(key.value);
      const bakedPath = path && withShapePathComponentValue(path, componentId, value);
      const components = { ...shapePathEntryComponents(key.value) };
      delete components[componentId];
      const entry = shapePathEntry(bakedPath || path, components);
      return entry ? [{ ...key, value: entry }] : [];
    });
  }
}

export function setShapePathComponentTrackEnabled(
  layerId: unknown,
  componentId: unknown,
  enabled: unknown,
) {
  const tick = get(canonicalPlayheadTick);
  const path = shapePathAt(layerId, tick);
  const component = normalizeShapePathComponentId(componentId, path);
  if (!component || !path) return false;
  const current = isShapePathComponentEnabled(layerId, component);
  const next = !!enabled;
  if (current === next) return false;
  const value = shapePathComponentValue(path, component);
  const baseline = getClipTimelineState();
  const shouldMaterialize = shapePathRecords(baseline, layerId).length > 0;
  const baselineTrack = trackForLayer(baseline, layerId);
  const hasCompensation = baselineTrack
    ? clipsForTrack(baseline, baselineTrack.id)
      .some((clip) => clip.propertyTracks?.[SHAPE_ANCHOR_COMPENSATION]?.length)
    : false;
  checkpointHistory();
  const result = transactClipTimeline(`${next ? 'enable' : 'disable'}-shape-component`, (state, context) => {
    const track = trackForLayer(state, layerId);
    if (!track) return false;
    track.shapePathKind = path.kind;
    if (next) {
      track.shapePathComponents = [...new Set([...(track.shapePathComponents || []), component])];
      if (shouldMaterialize) {
        if (hasCompensation && component.startsWith('vertex:')) {
          materializeCompensatedVertices(state, baseline, layerId);
        } else {
          materializeShapeComponent(state, baseline, layerId, component);
        }
      }
      const target = propertyContext(state, layerId, tick, context.makeId, true);
      if (!target?.owner) return false;
      const keys = [...(target.owner.propertyTracks?.['shapePath'] || [])];
      const index = keys.findIndex((key) => key.tick === target.sourceTick);
      const priorKey = index >= 0 ? keys[index] : null;
      const prior = priorKey?.value ?? null;
      const entry = shapePathEntry(shapePathEntryPath(prior), {
        ...shapePathEntryComponents(prior),
        [component]: componentMotionKey(component, value),
      });
      if (index >= 0 && priorKey) keys[index] = { ...priorKey, value: entry };
      else if (target.sourceTick != null) keys.push({ tick: target.sourceTick, value: entry });
      keys.sort((a, b) => a.tick - b.tick);
      target.owner.propertyTracks = {
        ...(target.owner.propertyTracks || {}),
        shapePath: keys,
      };
    } else {
      bakeComponentIntoPayloads(state, track, component, value);
      track.shapePathComponents = (track.shapePathComponents || [])
        .filter((candidate) => candidate !== component);
      if (!track.shapePathComponents.length && !shapePathRecords(state, layerId)
        .some((record) => shapePathEntryPath(record.key.value))) delete track.shapePathKind;
    }
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick(tick);
  return !!result.changed;
}

export function toggleShapePathComponentKey(
  layerId: unknown,
  componentId: unknown,
  frameValue: unknown,
) {
  const tick = tickIndex(frameValue);
  const path = tick == null ? null : shapePathAt(layerId, tick);
  const component = normalizeShapePathComponentId(componentId, path);
  if (!component || !isShapePathComponentEnabled(layerId, component)) return false;
  const owns = hasShapePathComponentKey(layerId, component, tick);
  return mutateShapeEntry(layerId, tick, 'toggle-shape-component-key', (entry) => {
    const components = { ...shapePathEntryComponents(entry) };
    if (owns) delete components[component];
    else components[component] = componentMotionKey(
      component,
      shapePathComponentValue(path, component),
    );
    return shapePathEntry(shapePathEntryPath(entry), components);
  }, !owns) ? !owns : false;
}

function sparsePointSamples(samples: TimelinePoint[]): TimelineStoredKey<TimelinePoint>[] {
  if (!samples.length) return [];
  const onlySample = samples[0];
  if (samples.length === 1) return onlySample ? [{ tick: 0, value: onlySample }] : [];
  const retained = new Set([0, samples.length - 1]);
  const segments: Array<[number, number]> = [[0, samples.length - 1]];
  while (segments.length) {
    const segment = segments.pop();
    if (!segment) continue;
    const [start, end] = segment;
    if (end <= start + 1) continue;
    const first = samples[start];
    const last = samples[end];
    if (!first || !last) continue;
    let split = -1;
    let error = 1e-9;
    for (let tick = start + 1; tick < end; tick++) {
      const progress = (tick - start) / (end - start);
      const expected = {
        x: first.x + (last.x - first.x) * progress,
        y: first.y + (last.y - first.y) * progress,
      };
      const sample = samples[tick];
      if (!sample) continue;
      const difference = Math.abs(sample.x - expected.x) +
        Math.abs(sample.y - expected.y);
      if (difference > error) {
        error = difference;
        split = tick;
      }
    }
    if (split < 0) continue;
    retained.add(split);
    segments.push([start, split], [split, end]);
  }
  return [...retained].sort((a, b) => a - b).flatMap((tick) => {
    const sample = samples[tick];
    return sample ? [{ tick, value: { ...sample, interpolation: 'linear' } }] : [];
  });
}

function sparseScalarSamples(samples: number[]) {
  return sparsePointSamples(samples.map((value) => ({ x: Number(value) || 0, y: 0 })))
    .map((key) => ({ tick: key.tick, value: key.value?.x ?? 0 }));
}

function materializeShapeComponent(
  state: ClipTimelineState,
  baselineState: ClipTimelineState,
  layerId: unknown,
  componentId: ShapeComponentId,
): void {
  const track = trackForLayer(state, layerId);
  if (!track) return;
  for (const clip of clipsForTrack(state, track.id)) {
    const values = Array.from({ length: clipDuration(clip) }, (_, offset) => {
      const path = pathForStateAt(baselineState, layerId, clip.startTick + offset);
      return shapePathComponentValue(path, componentId);
    });
    const sampled = componentId === SHAPE_PATH_COMPONENT_ROTATION
      ? sparseScalarSamples(values.map((value) => Number(value) || 0))
      : sparsePointSamples(values.map(numericPosition));
    clip.propertyTracks = { ...(clip.propertyTracks || {}) };
    const keys = [...(clip.propertyTracks['shapePath'] || [])];
    for (const sample of sampled) {
      const sourceTick = clip.inTick + sample.tick;
      const index = keys.findIndex((key) => key.tick === sourceTick);
      const prior = index >= 0 ? keys[index] : { tick: sourceTick, value: null };
      if (!prior) continue;
      const value = shapePathEntry(shapePathEntryPath(prior.value), {
        ...shapePathEntryComponents(prior.value),
        [componentId]: componentMotionKey(componentId, sample.value),
      });
      if (index >= 0) keys[index] = { ...prior, value };
      else keys.push({ tick: sourceTick, value });
    }
    keys.sort((first, second) => first.tick - second.tick);
    clip.propertyTracks['shapePath'] = keys;
  }
}

function materializeCompensatedVertices(
  state: ClipTimelineState,
  baselineState: ClipTimelineState,
  layerId: unknown,
): void {
  const path = pathForStateAt(baselineState, layerId, 0) ||
    pathForStateAt(baselineState, layerId, get(canonicalPlayheadTick));
  for (const component of enumerateShapePathComponents(path || {})) {
    if (component.type === 'vertex') {
      materializeShapeComponent(state, baselineState, layerId, component.id);
    }
  }
  const track = trackForLayer(state, layerId);
  if (!track) return;
  for (const clip of clipsForTrack(state, track.id)) {
    if (!clip.propertyTracks?.[SHAPE_ANCHOR_COMPENSATION]) continue;
    clip.propertyTracks = { ...clip.propertyTracks };
    delete clip.propertyTracks[SHAPE_ANCHOR_COMPENSATION];
  }
}

// Moving an animated pivot must not move rendered vertices, so a sparse hidden track
// records the geometry delta needed to preserve the baseline image.
function applyAnchorCompensation(
  state: ClipTimelineState,
  baselineState: ClipTimelineState,
  layerId: unknown,
): void {
  const track = trackForLayer(state, layerId);
  if (!track) return;
  for (const clip of clipsForTrack(state, track.id)) {
    const samples = [];
    for (let offset = 0; offset < clipDuration(clip); offset++) {
      const tick = clip.startTick + offset;
      const baselinePath = pathForStateAt(baselineState, layerId, tick);
      const previewPath = pathForStateAt(state, layerId, tick);
      const anchor = shapePathComponentValue(previewPath, SHAPE_PATH_COMPONENT_ANCHOR);
      const baselineTrack = trackForLayer(baselineState, layerId);
      const baselineClip = baselineTrack && clipAtTick(baselineState, baselineTrack.id, tick);
      const baselineSourceTick = baselineClip && sourceTickAt(baselineClip, tick);
      let baselineFrameKey = null;
      for (const key of baselineClip?.frameKeys || []) {
        if (baselineSourceTick == null || key.tick > baselineSourceTick) break;
        baselineFrameKey = key;
      }
      const baselineValue = record(baselineFrameKey?.value) ? baselineFrameKey.value : {};
      const appearanceValue = baselineValue['shape'] ||
        (baselineTrack?.layer?.type === 'shape' ? baselineTrack.layer.shape : null);
      const appearance = isEditorShape(appearanceValue) ? appearanceValue : null;
      const anchorPoint = record(anchor) ? numericPosition(anchor) : null;
      const compensated = appearance && baselinePath && previewPath && anchorPoint
        ? pathValueFromShape(shapeForAnchorComponentEdit(appearance, baselinePath, anchorPoint))
        : null;
      const previewVertex = shapePathVertices(previewPath || {})[0];
      const compensatedVertex = shapePathVertices(compensated || {})[0];
      const existing = baselineClip
        ? resolveClipPropertyAtTick(
          baselineClip,
          SHAPE_ANCHOR_COMPENSATION,
          tick,
          { x: 0, y: 0 },
        )
        : { x: 0, y: 0 };
      const existingPoint = numericPosition(existing);
      samples.push(previewVertex && compensatedVertex
        ? {
          x: existingPoint.x + compensatedVertex.x - previewVertex.x,
          y: existingPoint.y + compensatedVertex.y - previewVertex.y,
        }
        : { x: 0, y: 0 });
    }
    const localKeys = sparsePointSamples(samples).map((key) => ({
      ...key,
      tick: clip.inTick + key.tick,
    }));
    clip.propertyTracks = { ...(clip.propertyTracks || {}) };
    if (localKeys.some((key) => key.value && (key.value.x || key.value.y))) {
      clip.propertyTracks[SHAPE_ANCHOR_COMPENSATION] = localKeys;
    } else {
      delete clip.propertyTracks[SHAPE_ANCHOR_COMPENSATION];
    }
  }
}

export function setShapePathComponentValues(
  frameValue: unknown,
  layerId: unknown,
  entries: unknown,
) {
  const tick = tickIndex(frameValue);
  const path = tick == null ? null : shapePathAt(layerId, tick);
  if (!path) return [];
  const requested: unknown[] = Array.isArray(entries)
    ? entries
    : record(entries)
      ? Object.entries(entries).map(([componentId, value]) => ({ componentId, value }))
      : [];
  const changes: Array<[ShapeComponentId, ShapeComponentValue]> = [];
  let visiblePath = path;
  for (const entry of requested) {
    const entryRecord = record(entry) ? entry : {};
    const componentId = Array.isArray(entry) ? entry[0]
      : entryRecord['componentId'] ?? entryRecord['id'];
    const raw = Array.isArray(entry) ? entry[1] : entryRecord['value'];
    const component = normalizeShapePathComponentId(componentId, path);
    const value = component ? normalizeShapePathComponentValue(component, raw) : null;
    if (!component || value == null || shapePathComponentEqual(
      component,
      shapePathComponentValue(path, component),
      value,
    )) continue;
    visiblePath = withShapePathComponentValue(visiblePath, component, value) || visiblePath;
    changes.push([component, value]);
  }
  if (!changes.length) return [];
  const stateBeforeEdit = getClipTimelineState();
  const trackBeforeEdit = trackForLayer(stateBeforeEdit, layerId);
  const hasCompensation = trackBeforeEdit
    ? clipsForTrack(stateBeforeEdit, trackBeforeEdit.id)
      .some((clip) => clip.propertyTracks?.[SHAPE_ANCHOR_COMPENSATION]?.length)
    : false;
  const animatedComponents = new Set(changes.flatMap(([component]) => (
    isShapePathComponentEnabled(layerId, component) ||
    (hasCompensation && component.startsWith('vertex:'))
      ? [component]
      : []
  )));
  const animatedAnchor = animatedComponents.has(SHAPE_PATH_COMPONENT_ANCHOR);
  const newlyAnimatedComponents = [...animatedComponents].filter((component) =>
    !isShapePathComponentEnabled(layerId, component));
  const whole = isShapePathWholeTrackEnabled(layerId);
  let changed = false;
  if (animatedComponents.size || whole) {
    const baseline = stateBeforeEdit;
    changed = mutateShapeEntry(layerId, tick, 'set-shape-components', (entry) => {
      let keyPath = shapePathEntryPath(entry);
      const components = { ...shapePathEntryComponents(entry) };
      for (const [component, value] of changes) {
        if (animatedComponents.has(component)) {
          const valueFields: Record<string, unknown> = {};
          if (component === SHAPE_PATH_COMPONENT_ROTATION) valueFields['value'] = value;
          else if (record(value)) Object.assign(valueFields, value);
          components[component] = componentMotionKey(component, {
            ...(record(components[component]) ? components[component] : {}),
            ...valueFields,
          });
        } else if (whole) {
          keyPath = withShapePathComponentValue(
            keyPath || path,
            component,
            value,
          );
        }
      }
      return shapePathEntry(keyPath ? shapePathMotionKey(keyPath, path.kind) : null, components);
    }, true, (state, target) => {
      const track = trackForLayer(state, layerId);
      if (track) {
        track.shapePathComponents = [...new Set([
          ...(track.shapePathComponents || []),
          ...animatedComponents,
        ])];
      }
      const materializeVertices = hasCompensation && newlyAnimatedComponents
        .some((component) => component.startsWith('vertex:'));
      if (materializeVertices) materializeCompensatedVertices(state, baseline, layerId);
      for (const component of newlyAnimatedComponents) {
        if (!materializeVertices || !component.startsWith('vertex:')) {
          materializeShapeComponent(state, baseline, layerId, component);
        }
      }
      if (newlyAnimatedComponents.length && target?.owner) {
        const keys = target.owner.propertyTracks?.['shapePath'] || [];
        const index = keys.findIndex((key) => key.tick === target.sourceTick);
        if (index >= 0) {
          const selectedKey = keys[index];
          if (!selectedKey) return;
          const entry = selectedKey.value;
          const components = { ...shapePathEntryComponents(entry) };
          for (const [component, value] of changes) {
            if (!animatedComponents.has(component)) continue;
            const valueFields: Record<string, unknown> = {};
            if (component === SHAPE_PATH_COMPONENT_ROTATION) valueFields['value'] = value;
            else if (record(value)) Object.assign(valueFields, value);
            components[component] = componentMotionKey(component, {
              ...(record(components[component]) ? components[component] : {}),
              ...valueFields,
            });
          }
          keys[index] = {
            ...selectedKey,
            value: shapePathEntry(shapePathEntryPath(entry), components),
          };
        }
      }
      if (animatedAnchor) applyAnchorCompensation(state, baseline, layerId);
    });
  } else {
    changed = setFrameShape(layerId, tick, visiblePath);
  }
  return changed ? changes.map(([component]) => component) : [];
}

export function setShapePathComponentValue(
  frameValue: unknown,
  layerId: unknown,
  componentId: unknown,
  value: unknown,
) {
  return setShapePathComponentValues(frameValue, layerId, [{ componentId, value }]).length > 0;
}

export function deleteShapePathComponentKeys(
  layerId: unknown,
  componentId: unknown,
  ticks: Iterable<unknown>,
) {
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  if (!component) return [];
  const requested = new Set([...(ticks || [])].map(Number));
  const records = shapePathComponentRecords(getClipTimelineState(), layerId, component)
    .filter((record) => requested.has(record.projectTick));
  const changed = records.filter((record) => mutateShapeEntry(
    layerId,
    record.projectTick,
    'delete-shape-component-key',
    (entry) => {
      const components = { ...shapePathEntryComponents(entry) };
      delete components[component];
      return shapePathEntry(shapePathEntryPath(entry), components);
    },
    false,
  ));
  return changed.map((record) => record.projectTick);
}

export function moveShapePathComponentKeys(
  layerId: unknown,
  componentId: unknown,
  ticks: Iterable<unknown>,
  delta: unknown,
) {
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  return component ? moveShapeSubset(layerId, ticks, delta, component) : [];
}

export function copyShapePathComponentKeys(
  layerId: unknown,
  componentId: unknown,
  ticks: Iterable<unknown>,
) {
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  return shapePathPayload(layerId, ticks, component || String(componentId));
}

export function pasteShapePathComponentKeys(
  layerId: unknown,
  componentId: unknown,
  destination: unknown,
  payload: unknown,
) {
  const path = shapePathAt(layerId, destination);
  const component = normalizeShapePathComponentId(componentId, path);
  if (!component || !record(payload) || payload['componentId'] !== component) return [];
  return pasteShapeKeys(layerId, component, destination, payload);
}

export function setShapePathComponentKeyInterpolation(
  layerId: unknown,
  componentId: unknown,
  ticks: Iterable<unknown>,
  interpolation: unknown,
) {
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  const preset = validInterpolation(interpolation);
  return component
    ? editShapePathMetadata(layerId, ticks, component, (key) => ({
      ...(record(key) ? key : {}), interpolation: preset,
    }))
    : [];
}

export function setShapePathComponentKeyTemporalEase(
  layerId: unknown,
  componentId: unknown,
  ticks: Iterable<unknown>,
  side: unknown,
  handle: unknown,
) {
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  if (!component || (side !== 'in' && side !== 'out') ||
    (handle != null && !normalizeTemporalHandle(handle))) return [];
  return setShapeTemporalEase(layerId, ticks, component, { [side]: handle });
}

export function setShapePathComponentKeyTemporalPreset(
  layerId: unknown,
  componentId: unknown,
  ticks: Iterable<unknown>,
  preset: unknown,
) {
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  return component
    ? setShapeTemporalEase(layerId, ticks, component, temporalPresetEdits(preset))
    : [];
}

export function clearShapePathKeys(layerId: unknown) {
  return setShapePathTrackEnabled(layerId, false);
}

function translatePayload(payload: unknown, dx: number, dy: number): FramePayload {
  const source = record(payload) ? cloneDurable(payload) : {};
  const cells = isEditorCellMap(source['cells']) ? source['cells'] : {};
  const next: FramePayload = { ...source, cells: cmTranslate(cells, dx, dy) };
  if (next.box) next.box = { ...next.box, x: next.box.x + dx, y: next.box.y + dy };
  if (next.shape) {
    const path = translateShapePathKey(pathValueFromShape(next.shape), dx, dy);
    if (path) next.shape = shapeWithPathValue(next.shape, path);
    next.cells = next.shape ? renderShapeToCells(next.shape) : {};
  }
  if (next.mask) {
    next.mask = { ...next.mask, cells: cmTranslate(next.mask.cells || {}, dx, dy) };
  }
  if (next.contentMask) {
    next.contentMask = { ...next.contentMask, cells: cmTranslate(next.contentMask.cells || {}, dx, dy) };
  }
  return next;
}

function translateBase(base: TimelineLayer, dx: number, dy: number): TimelineLayer {
  const next = cloneDurable(base);
  if (next.box) next.box = { ...next.box, x: next.box.x + dx, y: next.box.y + dy };
  if (next.type === 'shape' && next.shape) {
    const path = translateShapePathKey(pathValueFromShape(next.shape), dx, dy);
    if (path) next.shape = shapeWithPathValue(next.shape, path);
  }
  if (next.type === 'effect' && next.mask) {
    next.mask = { ...next.mask, cells: cmTranslate(next.mask.cells || {}, dx, dy) };
  }
  if (next.contentMask) {
    next.contentMask = { ...next.contentMask, cells: cmTranslate(next.contentMask.cells || {}, dx, dy) };
  }
  if (next.type === 'image' || next.type === 'video') {
    const size = get(dims);
    const transform = next.transform || { x: size.w / 2, y: size.h / 2, scale: 1, rot: 0 };
    next.transform = { ...transform, x: transform.x + dx, y: transform.y + dy };
  }
  return next;
}

function translateTrackContent(
  state: ClipTimelineState,
  track: TimelineTrack,
  dx: number,
  dy: number,
): void {
  if (!track.layer) return;
  track.layer = translateBase(track.layer, dx, dy);
  for (const clip of clipsForTrack(state, track.id)) {
    clip.frameKeys = clip.frameKeys.map((key) => ({
      ...key,
      value: translatePayload(key.value, dx, dy),
    }));
    const keys = clip.propertyTracks?.['shapePath'];
    if (!keys) continue;
    clip.propertyTracks['shapePath'] = keys.map((key) => {
      const path = shapePathEntryPath(key.value);
      const translated = translateShapePathKey(path, dx, dy);
      const components = Object.fromEntries(Object.entries(shapePathEntryComponents(key.value)).map(
        ([componentId, value]) => {
          if (componentId === SHAPE_PATH_COMPONENT_ROTATION) return [componentId, value];
          const point = numericPosition(value);
          return [componentId, {
            ...(record(value) ? value : {}),
            x: point.x + dx,
            y: point.y + dy,
          }];
        },
      ));
      return {
        ...key,
        value: shapePathEntry(
          translated ? { ...(record(path) ? path : {}), ...translated } : path,
          components,
        ),
      };
    });
  }
}

export function translateShapeLayerBaseById(
  layerId: unknown,
  dxValue: unknown,
  dyValue: unknown,
) {
  const dx = integer(dxValue);
  const dy = integer(dyValue);
  const track = trackForLayer(getClipTimelineState(), layerId);
  if (get(playing) || track?.layer?.type !== 'shape' || (!dx && !dy)) return false;
  checkpointHistory();
  const result = transactClipTimeline('translate-shape-base', (state) => {
    const target = trackForLayer(state, layerId);
    if (!target) return false;
    translateTrackContent(state, target, dx, dy);
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return !!result.changed;
}

export function cropTimeline(rect: unknown) {
  if (get(playing)) return false;
  const crop = record(rect) ? rect : {};
  const x = integer(crop['x']);
  const y = integer(crop['y']);
  const w = Math.max(1, Math.min(256, integer(crop['w'], 1)));
  const h = Math.max(1, Math.min(256, integer(crop['h'], 1)));
  checkpointHistory();
  if (x || y) {
    transactClipTimeline('crop-translate', (state) => {
      for (const track of visualTracks(state)) {
        if (track.kind !== 'group' && track.layer?.type !== 'group') {
          translateTrackContent(state, track, -x, -y);
        }
      }
      return { state, changed: true };
    });
    cellSelection.update((selected) => new Set([...selected].map((key) => {
      const point = cmParse(key);
      return cmKey(point.x - x, point.y - y);
    })));
  }
  resizeCanvas(w, h, false);
  publishResolvedTick();
  return true;
}

export function materializeShapePathsForRasterize(layerIds: unknown) {
  const ids = new Set(idsFrom(layerIds));
  if (!ids.size) return false;
  const snapshot = getClipTimelineState();
  const result = transactClipTimeline('materialize-shape-paths', (state) => {
    let changed = false;
    for (const id of ids) {
      const track = trackForLayer(state, id);
      if (track?.layer?.type !== 'shape') continue;
      for (const clip of clipsForTrack(state, track.id)) {
        const keys: TimelineStoredKey[] = [];
        for (let offset = 0; offset < clipDuration(clip); offset++) {
          const projectTick = clip.startTick + offset;
          const sourceTick = clip.inTick + offset;
          const layer = resolvedLayer(snapshot, id, projectTick);
          if (layer?.type !== 'shape' || !layer.shape) continue;
          let held: TimelineStoredKey | null = null;
          for (const key of clip.frameKeys) {
            if (key.tick > sourceTick) break;
            held = key;
          }
          keys.push({
            tick: sourceTick,
            value: {
              ...(record(held?.value) ? held.value : {}),
              shape: cloneDurable(layer.shape),
              cells: renderShapeToCells(layer.shape),
            },
          });
        }
        if (keys.length) {
          clip.frameKeys = keys;
          changed = true;
        }
        if (clip.propertyTracks?.['shapePath']) {
          clip.propertyTracks = { ...clip.propertyTracks };
          delete clip.propertyTracks['shapePath'];
        }
      }
      track.shapePathComponents = [];
      delete track.shapePathKind;
    }
    return changed ? { state, changed: true } : false;
  });
  if (result.changed) publishResolvedTick();
  return !!result.changed;
}

export function setLayerRaster(id: unknown, raster: EditorRasterSource | undefined) {
  let found = false;
  layers.update((stack) => stack.map((layer) => {
    if (layer.id !== id) return layer;
    found = true;
    return { ...layer, raster };
  }));
  return found;
}

export function setAssetRuntime(assetId: unknown, runtime: unknown = null) {
  let found = false;
  layers.update((stack) => stack.map((layer) => {
    const layerAssetId = layer.type === 'image'
      ? layer.assetId
      : layer.type === 'video' ? layer.videoClip?.assetId : null;
    if (layerAssetId !== assetId) return layer;
    found = true;
    const durable = cloneDurable(layer);
    for (const field of ['raster', 'videoElement', 'videoBlob', 'videoURL', 'runtimeMediaKey']) {
      Reflect.deleteProperty(durable, field);
    }
    if (!runtime) return durable;
    const runtimeRecord = record(runtime) ? runtime : {};
    if (layer.type === 'image') {
      const raster = isRasterSource(runtimeRecord['raster'])
        ? runtimeRecord['raster']
        : isRasterSource(runtime) ? runtime : null;
      if (raster) Reflect.set(durable, 'raster', raster);
      if (typeof runtimeRecord['key'] === 'string') {
        Reflect.set(durable, 'runtimeMediaKey', runtimeRecord['key']);
      }
      return durable;
    }
    if (isRasterSource(runtimeRecord['raster'])) {
      Reflect.set(durable, 'raster', runtimeRecord['raster']);
    }
    const runtimeFields: Array<[string, string]> = [
      ['videoElement', 'element'],
      ['videoBlob', 'blob'],
      ['videoURL', 'url'],
      ['runtimeMediaKey', 'key'],
    ];
    for (const [target, source] of runtimeFields) {
      const value = runtimeRecord[source];
      if (value != null) Reflect.set(durable, target, value);
    }
    return durable;
  }));
  return found;
}

export function shapePathCelsForSave() {
  return null;
}

export function dopeRows() {
  const state = getClipTimelineState();
  return visualTracks(state).map((track) => {
    const id = trackLayerId(track);
    const clips = clipsForTrack(state, track.id);
    const celFrames = clips.flatMap((clip) => clip.frameKeys.map((key) => projectTickAt(clip, key.tick)))
      .filter((tick) => clipAtTick(state, track.id, tick))
      .sort((a, b) => a - b);
    const heldFrames = [];
    for (const clip of clips) {
      for (let tick = clip.startTick; tick < clip.startTick + clipDuration(clip); tick++) {
        if (!celFrames.includes(tick)) heldFrames.push(tick);
      }
    }
    return {
      id,
      name: track.layer?.name || track.name,
      type: track.layer?.type,
      groupId: track.layer?.groupId || null,
      visible: track.layer?.visible !== false,
      celFrames,
      heldFrames,
      keyFrames: positionKeys(id).map((key) => key.frame),
      visibilityKeyFrames: visibilityKeys(id).map((key) => key.frame),
      visibilityTrackEnabled: isVisibilityTrackEnabled(id),
      effectIntensityKeyFrames: effectIntensityKeys(id).map((key) => key.frame),
      effectIntensityTrackEnabled: isEffectIntensityTrackEnabled(id),
      maskOpacityKeyFrames: maskOpacityKeys(id).map((key) => key.frame),
      maskOpacityTrackEnabled: isMaskOpacityTrackEnabled(id),
      maskPositionKeyFrames: maskPositionKeys(id).map((key) => key.frame),
      maskPositionTrackEnabled: isMaskPositionTrackEnabled(id),
      shapePathKeyFrames: shapePathWholeKeys(id).map((key) => key.frame),
      shapePathTrackEnabled: isShapePathWholeTrackEnabled(id),
      shapePathWholeTrackEnabled: isShapePathWholeTrackEnabled(id),
      shapePathComponentTracks: shapePathAnimationComponents(id).filter((component) => component.enabled)
        .map((component) => ({
          id: component.id,
          label: component.label,
          keyFrames: shapePathComponentKeys(id, component.id).map((key) => key.frame),
        })),
    };
  });
}

export function isSimpleTimeline() {
  const state = getClipTimelineState();
  const tracks = visualTracks(state);
  return tracks.filter((track) => track.kind !== 'group').length <= 1 &&
    !tracks.some((track) => track.kind === 'group') &&
    tracks.every((track) => !Object.keys(track.propertyTracks || {}).length &&
      clipsForTrack(state, track.id).every((clip) => !Object.keys(clip.propertyTracks || {}).length));
}

export function createTimelineTickSource() {
  commitLayersToActiveFrame();
  const state = cloneDurable(getClipTimelineState());
  const rate = Math.max(1, Number(get(fps)) || DEFAULT_FPS);
  const total = clipTimelineDurationTicks(state);
  const tickDuration = 1000 / rate;
  return Object.freeze({
    fps: rate,
    durationTicks: total,
    tickDuration,
    layerStack: Object.freeze(resolveClipTimelineLayers(state, 0)),
    frameAtProjectTick(tick: unknown) {
      const projectTick = Number(tick);
      return Number.isInteger(projectTick) && projectTick >= 0 && projectTick < total
        ? { frameIndex: projectTick, localTick: 0, start: projectTick, end: projectTick + 1 }
        : null;
    },
    resolve(tick: unknown) {
      const projectTick = Number(tick);
      if (!Number.isInteger(projectTick) || projectTick < 0 || projectTick >= total) {
        throw new RangeError('Project tick is outside the timeline.');
      }
      return {
        id: projectTick,
        index: projectTick,
        tick: projectTick,
        duration: tickDuration,
        tickDuration,
        hold: 1,
        frameIndex: projectTick,
        localTick: 0,
        start: projectTick,
        end: projectTick + 1,
        layers: resolveClipTimelineLayers(state, projectTick),
      };
    },
  });
}

export function createTimelineFrameSource() {
  const source = createTimelineTickSource();
  return {
    frameCount: source.durationTicks,
    holds: Array(source.durationTicks).fill(1),
    resolve(index: number) {
      const frame = source.resolve(index);
      return {
        id: index,
        index,
        duration: source.tickDuration,
        hold: 1,
        layers: frame.layers,
      };
    },
  };
}

function playbackNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function play() {
  const loopEnabled = get(looping);
  if (get(playing)) return false;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('commit-move'));
  commitLayersToActiveFrame();
  const total = get(canonicalDurationTicks);
  if (total <= 1 && !loopEnabled) return false;
  const state = getClipTimelineState();
  let current = playbackStartTick(get(canonicalPlayheadTick), state.tags, total, loopEnabled);
  if (current !== get(canonicalPlayheadTick)) {
    seekClipTimelineTick(current);
    publishResolvedTick(current);
  }
  let publishedCurrent = current;
  playing.set(true);
  let nextDeadline = playbackNow() + 1000 / (get(fps) || DEFAULT_FPS);
  const advance = (duration: number) => {
    const next = nextPlaybackTick(current, getClipTimelineState().tags, duration, get(looping));
    current = next.tick;
    return next;
  };
  const step = () => {
    const duration = get(canonicalDurationTicks);
    let next = advance(duration);
    let wraps = next.wrapped ? 1 : 0;
    nextDeadline += 1000 / (get(fps) || DEFAULT_FPS);
    while (!next.stopped && nextDeadline <= playbackNow()) {
      next = advance(duration);
      if (next.wrapped) wraps++;
      nextDeadline += 1000 / (get(fps) || DEFAULT_FPS);
    }
    if (!next.stopped || wraps || current !== publishedCurrent) {
      seekClipTimelineTick(current);
      publishResolvedTick(current);
      publishedCurrent = current;
    }
    for (let cycle = 0; cycle < wraps; cycle++) {
      playbackCyclePublisher.set(Object.freeze({ id: ++playbackCycleId, tick: current }));
    }
    if (next.stopped) {
      stop({ preserveTick: true });
      return;
    }
    playbackTimer = setTimeout(step, Math.max(0, nextDeadline - playbackNow()));
  };
  playbackTimer = setTimeout(step, Math.max(0, nextDeadline - playbackNow()));
  return true;
}

export function stop({ preserveTick = false }: { preserveTick?: boolean } = {}) {
  const wasPlaying = get(playing);
  if (playbackTimer) clearTimeout(playbackTimer);
  playbackTimer = null;
  if (!preserveTick && wasPlaying) {
    seekClipTimelineTick(0);
    publishResolvedTick(0);
  }
  if (wasPlaying) playing.set(false);
}

export function togglePlay() {
  return get(playing) ? stop({ preserveTick: true }) : play();
}

// History captures canonical state only after the editable projection has settled,
// keeping one undo entry authoritative for both views.
function captureTimeline() {
  const revision = get(authoredRevision);
  if (synchronizedAuthoredRevision !== revision) {
    commitLayersToActiveFrame({ publish: false });
    synchronizedAuthoredRevision = revision;
  }
  return {
    canonical: captureClipTimelineState(),
    fps: get(fps),
    structureToken: timelineStructureToken,
  };
}

function restoreTimeline(snapshot: {
  canonical: ReturnType<typeof captureClipTimelineState>;
  fps: number;
  structureToken: number;
}) {
  stop();
  const structureChanged = snapshot.structureToken !== timelineStructureToken;
  fps.set(snapshot.fps);
  const restored = restoreClipTimelineState(snapshot.canonical, {
    playheadTick: get(canonicalPlayheadTick),
  });
  timelineStructureToken = snapshot.structureToken;
  if (structureChanged) timelineStructureRevision.update((value) => value + 1);
  if (restored.changed) publishResolvedTick(restored.playheadTick);
  synchronizedAuthoredRevision = get(authoredRevision);
}

function restoreTimelineView(liveById: Map<string, EditorLayer>) {
  return publishResolvedTick(get(canonicalPlayheadTick), liveById);
}

function settleAuthoredTimelineMutation() {
  const revision = get(authoredRevision);
  if (synchronizedAuthoredRevision !== revision) {
    commitLayersToActiveFrame();
    synchronizedAuthoredRevision = revision;
  }
}

function resetTimelineForEmptyLayerStack() {
  reconcileLiveLayers(get(canonicalPlayheadTick));
}

function resetEffectMaskTracks(layerId: unknown) {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  if (!track) return;
  transactClipTimeline('reset-effect-mask-tracks', (draft) => {
    const target = trackForLayer(draft, layerId);
    if (!target) return false;
    for (const clip of clipsForTrack(draft, target.id)) {
      if (!clip.propertyTracks) continue;
      clip.propertyTracks = { ...clip.propertyTracks };
      delete clip.propertyTracks['maskOpacity'];
      delete clip.propertyTracks['maskPosition'];
    }
    return { state: draft, changed: true };
  });
}

registerHistoryContributor(captureTimeline, restoreTimeline);
registerLayerHistoryAuthority({
  initializeView: initTimeline,
  restoreView: restoreTimelineView,
});
registerLayerStackEmptyHandler(resetTimelineForEmptyLayerStack);
registerEffectMaskChangeHandler(resetEffectMaskTracks);
registerShapeRasterizeHandler(materializeShapePathsForRasterize);
registerAuthoredMutationSettledHandler(settleAuthoredTimelineMutation);

initTimeline(get(layers));

fps.subscribe((rate) => {
  if (Object.is(rate, observedFps)) return;
  const previousRate = observedFps;
  observedFps = rate;
  const result = setClipTimelineFps(rate);
  if (result.changed) {
    normalizeVideoSourceBounds('retime-video-source-bounds', true, previousRate);
    publishResolvedTick(result.playheadTick);
  }
});

let lastStructureSignature = structureSignature(getClipTimelineState());
canonicalClipTimeline.subscribe((state) => {
  const signature = structureSignature(state);
  if (signature !== lastStructureSignature) {
    lastStructureSignature = signature;
    timelineStructureToken++;
    timelineStructureRevision.update((value) => value + 1);
  }
});
