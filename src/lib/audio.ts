import { derived, get, writable } from 'svelte/store';
import {
  canonicalClipTimelineController,
  createCanonicalClipTimelineController,
} from './clipTimelineState.js';
import { newUuid } from './uuid.js';
import { projectMediaRegistry } from './mediaRegistry.js';
import type { Readable, Writable } from 'svelte/store';
import type {
  AudioRuntime,
  AudioRuntimeAsset,
  AudioState,
  BlobLike,
  MediaRegistry,
} from './types/media-types.js';
import type {
  AudioClip,
  AudioTrack,
  CanonicalTimelineState,
  TimelineClip,
  TimelineTrack,
  UnknownRecord,
} from './types/project-types.js';
import { isUnknownRecord } from './types/project-types.js';

interface NormalizedAudioClip extends UnknownRecord {
  id?: string;
  trackId?: string;
  assetId?: string;
  kind?: string;
  startTick: number;
  inPoint: number;
  outPoint: number;
  volume: number;
  muted: boolean;
  duration: number;
}

interface AudioSourceRecord extends UnknownRecord {
  id?: unknown;
  sourceName?: unknown;
  name?: unknown;
  mime?: unknown;
  size?: unknown;
  duration?: unknown;
  blob?: BlobLike | null;
  file?: BlobLike | null;
  bytes?: BlobLike | null;
  buffer?: AudioBuffer | null;
  runtimeMediaKey?: unknown;
}

interface AudioDecodeOptions {
  audioContext?: AudioContext;
  decodeAudioData?: (bytes: ArrayBuffer, blob: BlobLike) => AudioBuffer | Promise<AudioBuffer>;
  decode?: (bytes: ArrayBuffer, blob: BlobLike) => AudioBuffer | Promise<AudioBuffer>;
  AudioContext?: typeof AudioContext;
}

interface AudioCreateOptions extends UnknownRecord {
  buffer?: AudioBuffer | null;
  duration?: number;
  assetId?: string;
  trackId?: string;
  clipId?: string;
  sourceName?: string;
  trackName?: string;
  inPoint?: number;
  outPoint?: number;
  volume?: number;
  muted?: boolean;
  retainRuntime?: boolean;
  decodeOptions?: AudioDecodeOptions;
}

interface CanonicalTransactionResult {
  state: CanonicalTimelineState;
  changed: boolean;
  clip?: TimelineClip | null;
  track?: TimelineTrack | null;
}

interface CanonicalController {
  timeline: Readable<CanonicalTimelineState>;
  getState(): CanonicalTimelineState;
  transact(
    operation: string,
    callback: (state: CanonicalTimelineState) =>
      | false
      | { state: CanonicalTimelineState; changed: boolean },
  ): CanonicalTransactionResult;
  updateClip(id: string, patch: UnknownRecord): CanonicalTransactionResult;
  updateTrack(id: string, patch: UnknownRecord): CanonicalTransactionResult;
  removeTrack(id: string): unknown;
}

interface AudioControllerOptions {
  makeId?: (kind: string) => unknown;
  idGenerator?: (kind: string) => unknown;
  initialState?: unknown;
  blobs?: AudioBlobSource;
  canonicalController?: CanonicalController;
  clipTimelineController?: CanonicalController;
  fps?: number;
  canonicalOptions?: UnknownRecord;
  decodeAudioSource?: typeof decodeAudioSource;
  decode?: typeof decodeAudioSource;
  registryStore?: Readable<MediaRegistry>;
}

type AudioBlobEntry = BlobLike | { blob?: BlobLike; file?: BlobLike; bytes?: BlobLike; buffer?: AudioBuffer };
type AudioBlobSource =
  | ReadonlyMap<string, AudioBlobEntry>
  | Record<string, AudioBlobEntry | undefined>
  | ((id: string) => AudioBlobEntry | null | undefined);

const createCanonicalController = createCanonicalClipTimelineController as unknown as (
  options: UnknownRecord,
) => CanonicalController;
const defaultCanonicalController = canonicalClipTimelineController as unknown as CanonicalController;

export const DEFAULT_AUDIO_FPS = 24;
export const MIN_AUDIO_CLIP_SECONDS = 1e-6;

function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonnegativeDuration(value: unknown): number {
  return Math.max(0, finiteNumber(value));
}

function isBlobLike(value: unknown): value is BlobLike {
  return value !== null && typeof value === 'object' &&
    'arrayBuffer' in value && typeof value.arrayBuffer === 'function';
}

function sourceBlob(source: unknown): BlobLike | null {
  if (isBlobLike(source)) return source;
  if (!isUnknownRecord(source)) return null;
  if (isBlobLike(source['blob'])) return source['blob'];
  if (isBlobLike(source['file'])) return source['file'];
  if (isBlobLike(source['bytes'])) return source['bytes'];
  return null;
}

function bufferDuration(buffer: unknown): number | null {
  const duration = Number(isUnknownRecord(buffer) ? buffer['duration'] : undefined);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function normalizeAudioClip(clip: UnknownRecord = {}): NormalizedAudioClip {
  const normalized = { ...(clip || {}) };
  delete normalized['startFrame'];
  const duration = nonnegativeDuration(clip['duration']);
  const startTick = Math.max(0, Math.round(finiteNumber(clip['startTick'])));
  const volumeValue = Number(clip['volume']);
  const volume = Number.isFinite(volumeValue)
    ? Math.max(0, Math.min(1, volumeValue))
    : 1;
  const muted = Boolean(clip['muted']);

  if (duration === 0) {
    return {
      ...normalized,
      startTick,
      inPoint: 0,
      outPoint: 0,
      volume,
      muted,
      duration,
    };
  }

  const minimum = Math.min(MIN_AUDIO_CLIP_SECONDS, duration);
  const inValue = Number(clip['inPoint']);
  const inPoint = Math.max(0, Math.min(
    duration - minimum,
    Number.isFinite(inValue) ? inValue : 0,
  ));
  const outValue = clip['outPoint'] == null ? duration : Number(clip['outPoint']);
  const outPoint = Math.max(
    inPoint + minimum,
    Math.min(duration, Number.isFinite(outValue) ? outValue : duration),
  );

  return {
    ...normalized,
    startTick,
    inPoint,
    outPoint,
    volume,
    muted,
    duration,
  };
}

export function audioClipDurationTicks(clip: UnknownRecord, fps = DEFAULT_AUDIO_FPS): number {
  const normalized = normalizeAudioClip(clip);
  const rate = Math.max(1, finiteNumber(fps, DEFAULT_AUDIO_FPS));
  const scaled = Math.max(0, normalized.outPoint - normalized.inPoint) * rate;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 32;
  return Math.ceil(Math.max(0, scaled - tolerance));
}

export function splitAudioClip(
  clip: UnknownRecord,
  splitTick: unknown,
  fps = DEFAULT_AUDIO_FPS,
  rightClipId: string | null = null,
): { left: NormalizedAudioClip; right: NormalizedAudioClip } | null {
  const normalized = normalizeAudioClip(clip);
  const boundary = Math.max(0, Math.round(finiteNumber(splitTick)));
  if (boundary <= normalized.startTick) return null;

  const rate = Math.max(1, finiteNumber(fps, DEFAULT_AUDIO_FPS));
  const splitPoint = normalized.inPoint + (boundary - normalized.startTick) / rate;
  const scale = Math.max(1, normalized.inPoint, normalized.outPoint, splitPoint);
  const tolerance = Number.EPSILON * scale * 32;
  if (splitPoint <= normalized.inPoint + tolerance ||
    splitPoint >= normalized.outPoint - tolerance) return null;

  const left = normalizeAudioClip({ ...normalized, outPoint: splitPoint });
  const right = normalizeAudioClip({
    ...normalized,
    id: rightClipId || newUuid('clip'),
    startTick: boundary,
    inPoint: splitPoint,
  });
  return { left, right };
}

function runtimeAsset(source: AudioSourceRecord = {}): AudioRuntimeAsset {
  const blob = sourceBlob(source);
  const buffer = source.buffer ?? null;
  const decodedDuration = bufferDuration(buffer);
  const duration = decodedDuration ?? nonnegativeDuration(source?.duration);
  const sizeValue = Number(source?.size ?? blob?.size);
  const size = Number.isFinite(sizeValue) && sizeValue >= 0 ? Math.floor(sizeValue) : 0;
  const sourceName = String(source?.sourceName || blob?.name || source?.name || 'Audio');
  const mime = String(source?.mime || blob?.type || '');
  return Object.freeze({
    id: String(source?.id || ''),
    sourceName,
    mime,
    size,
    duration,
    blob,
    buffer,
    ...(source?.runtimeMediaKey ? { runtimeMediaKey: String(source.runtimeMediaKey) } : {}),
  });
}

export function createImportedAudioAsset(
  source: BlobLike | AudioSourceRecord,
  options: AudioSourceRecord = {},
): AudioRuntimeAsset {
  const input = isBlobLike(source)
    ? { ...options, blob: source }
    : { ...(source || {}), ...options };
  const blob = sourceBlob(input);
  if (!input.id) throw new TypeError('An imported audio asset requires an id.');
  if (!blob) throw new TypeError('An imported audio asset requires Blob or File bytes.');
  if (bufferDuration(input.buffer) == null) {
    throw new TypeError('An imported audio asset requires a decoded AudioBuffer.');
  }
  return runtimeAsset(input as AudioSourceRecord);
}

export async function decodeAudioSource(
  blob: BlobLike,
  dependencies: AudioDecodeOptions | AudioDecodeOptions['decodeAudioData'] = {},
): Promise<AudioRuntime> {
  if (!isBlobLike(blob)) throw new TypeError('Audio source must be a Blob or File.');
  const options = typeof dependencies === 'function'
    ? { decodeAudioData: dependencies }
    : dependencies;
  let context = options.audioContext || null;
  let ownsContext = false;
  let decode = options.decodeAudioData || options.decode || null;

  if (!decode) {
    const AudioContextClass = options.AudioContext || globalThis.AudioContext ||
      (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!context) {
      if (!AudioContextClass) throw new Error('Web Audio is unavailable.');
      context = new AudioContextClass();
      ownsContext = true;
    }
    decode = (bytes: ArrayBuffer) => context!.decodeAudioData(bytes);
  }

  try {
    const bytes = await blob.arrayBuffer();
    const buffer = await decode(bytes.slice(0), blob);
    if (bufferDuration(buffer) == null) {
      throw new TypeError('Audio decoder did not return an AudioBuffer.');
    }
    return Object.freeze({
      sourceName: String(blob.name || 'Audio'),
      mime: String(blob.type || ''),
      size: Number.isFinite(Number(blob.size)) ? Number(blob.size) : 0,
      duration: buffer.duration,
      blob,
      buffer,
    });
  } finally {
    if (ownsContext && typeof context?.close === 'function') {
      try { await context.close(); } catch {}
    }
  }
}

export function emptyAudioState(): AudioState {
  return { assets: [], tracks: [], clips: [] };
}

function stateValue(value: unknown): AudioState {
  return isUnknownRecord(value) ? value as unknown as AudioState : emptyAudioState();
}

function cloneRuntimeAssets(value: unknown): AudioRuntimeAsset[] {
  return (Array.isArray(value) ? value : []).map((asset) =>
    Object.isFrozen(asset) ? asset : runtimeAsset(asset));
}

function stripRuntimeMedia(value: UnknownRecord | null | undefined): UnknownRecord {
  const next = { ...(value || {}) };
  for (const field of ['asset', 'audioBuffer', 'blob', 'buffer', 'bytes', 'file']) {
    delete next[field];
  }
  return next;
}

function audioTrackDefinition(value: UnknownRecord = {}): AudioTrack {
  const track = stripRuntimeMedia(value);
  delete track['clips'];
  delete track['volume'];
  delete track['muted'];
  const hasVolume = Object.prototype.hasOwnProperty.call(value, 'volume');
  const hasMuted = Object.prototype.hasOwnProperty.call(value, 'muted');
  const volume = Number(value['volume']);
  return {
    ...track,
    id: String(value['id']),
    kind: 'audio',
    name: String(value['name'] || 'Audio'),
    locked: Boolean(value['locked']),
    ...(hasVolume ? {
      volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1,
    } : {}),
    ...(hasMuted ? { muted: Boolean(value['muted']) } : {}),
  };
}

function audioClipDefinition(
  value: UnknownRecord = {},
  duration: unknown = value['duration'],
): AudioClip {
  return stripRuntimeMedia(normalizeAudioClip({
    ...value,
    kind: 'audio',
    duration,
  })) as unknown as AudioClip;
}

function idOf(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return id || null;
}

function audioMetadata(value: unknown) {
  const state = stateValue(value);
  const clips = Array.isArray(state.clips) ? state.clips : [];
  const referencedAssetIds = new Set(clips.map((clip) => String(clip.assetId)));
  return {
    assets: (Array.isArray(state.assets) ? state.assets : [])
      .filter((asset) => referencedAssetIds.has(String(asset.id)))
      .map((asset) => ({
      id: String(asset.id),
      sourceName: String(asset.sourceName || 'Audio'),
      mime: String(asset.mime || ''),
      size: Math.max(0, Math.floor(finiteNumber(asset.size))),
      duration: nonnegativeDuration(asset.duration),
      })),
    tracks: (Array.isArray(state.tracks) ? state.tracks : []).map((track) => ({
      id: String(track.id),
      name: String(track.name || 'Audio'),
      ...(Number.isFinite(Number(track.volume))
        ? { volume: Math.max(0, Math.min(1, Number(track.volume))) }
        : {}),
      ...(track.muted ? { muted: true } : {}),
      clips: clips
        .filter((clip) => clip.trackId === track.id)
        .map((clip) => {
          const normalized = normalizeAudioClip(clip);
          return {
            id: String(normalized.id),
            assetId: String(normalized.assetId),
            startTick: normalized.startTick,
            inPoint: normalized.inPoint,
            outPoint: normalized.outPoint,
            volume: normalized.volume,
            muted: normalized.muted,
            duration: normalized.duration,
          };
        }),
    })),
  };
}

function blobEntry(blobMap: AudioBlobSource | undefined, id: string): AudioBlobEntry | null {
  if (!blobMap) return null;
  if (typeof blobMap === 'function') return blobMap(id) ?? null;
  if (blobMap instanceof Map) return blobMap.get(id) ?? null;
  return Object.prototype.hasOwnProperty.call(blobMap, id)
    ? (blobMap as Record<string, AudioBlobEntry | undefined>)[id] ?? null
    : null;
}

function runtimeStateFromSerialized(
  serialized: unknown,
  suppliedBlobs?: AudioBlobSource,
): AudioState {
  const wrapper = isUnknownRecord(serialized) ? serialized : {};
  const metadataValue = wrapper['metadata'] || wrapper['state'] || wrapper;
  const metadata = isUnknownRecord(metadataValue) ? metadataValue : {};
  const blobs = suppliedBlobs ?? wrapper['blobs'] as AudioBlobSource | undefined;
  const assetDefs = metadata['assets'] || metadata['audioAssets'] || [];
  const trackDefs = metadata['tracks'] || metadata['audioTracks'] || [];
  const topLevelClips = metadata['clips'] || metadata['audioClips'];

  const assets: AudioRuntimeAsset[] = [];
  const assetIds = new Set<string>();
  for (const definition of Array.isArray(assetDefs) ? assetDefs : []) {
    if (!isUnknownRecord(definition)) continue;
    const id = idOf(definition['id']);
    if (!id || assetIds.has(id)) continue;
    const entry = blobEntry(blobs, id);
    const blob = isBlobLike(entry) ? entry : sourceBlob(entry);
    const buffer = isBlobLike(entry) || !isUnknownRecord(entry) ? null : entry['buffer'] ?? null;
    assets.push(runtimeAsset({ ...definition, id, blob, buffer }));
    assetIds.add(id);
  }

  const tracks: AudioTrack[] = [];
  const trackIds = new Set<string>();
  for (const definition of Array.isArray(trackDefs) ? trackDefs : []) {
    if (!isUnknownRecord(definition)) continue;
    const id = idOf(definition['id']);
    if (!id || trackIds.has(id)) continue;
    tracks.push(audioTrackDefinition({ ...definition, id }));
    trackIds.add(id);
  }

  const clipDefs = Array.isArray(topLevelClips)
    ? topLevelClips
    : (Array.isArray(trackDefs) ? trackDefs : []).flatMap((track) =>
      (isUnknownRecord(track) && Array.isArray(track['clips']) ? track['clips'] : []).map((clip: unknown) => ({
        ...(isUnknownRecord(clip) ? clip : {}),
        trackId: isUnknownRecord(track) ? track['id'] : undefined,
      })));
  const clips: AudioClip[] = [];
  const clipIds = new Set<string>();
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  for (const definition of clipDefs) {
    if (!isUnknownRecord(definition)) continue;
    const id = idOf(definition['id']);
    const trackId = idOf(definition['trackId']);
    const assetId = idOf(definition['assetId']);
    if (!id || !trackId || !assetId || clipIds.has(id) ||
      !trackIds.has(trackId) || !assetIds.has(assetId)) continue;
    clips.push(audioClipDefinition({
      ...definition,
      id,
      trackId,
      assetId,
    }, assetById.get(assetId)!.duration));
    clipIds.add(id);
  }

  return { assets, tracks, clips };
}

function isAudioTrack(track: TimelineTrack | AudioTrack): track is AudioTrack {
  return track.kind === 'audio';
}

function isAudioClip(clip: TimelineClip | AudioClip): clip is AudioClip {
  return clip.kind === 'audio';
}

export function createAudioController(options: AudioControllerOptions = {}) {
  const makeId = options.makeId || options.idGenerator || ((kind) => newUuid(kind));
  const initialState = options.initialState
    ? runtimeStateFromSerialized(options.initialState, options.blobs)
    : emptyAudioState();
  const injectedCanonical = options.canonicalController || options.clipTimelineController || null;
  const canonical = injectedCanonical || createCanonicalController({
    initialState: {
      fps: Math.max(1, finiteNumber(options.fps, DEFAULT_AUDIO_FPS)),
      tracks: initialState.tracks,
      clips: initialState.clips,
    },
    ...(options.canonicalOptions || {}),
  });
  const runtimeAssets = writable<AudioRuntimeAsset[]>(cloneRuntimeAssets(initialState.assets));
  const decodeSource = options.decodeAudioSource || options.decode || decodeAudioSource;
  const registryStore = options.registryStore || null;
  let registryManagedIds = new Set<string>();

  registryStore?.subscribe((registry) => {
    const definitions = (registry?.assets || []).filter((asset) => asset.kind === 'audio');
    const nextManagedIds = new Set(definitions.map((asset) => asset.assetId));
    runtimeAssets.update((current) => [
      ...current.filter((asset) => !registryManagedIds.has(asset.id) && !nextManagedIds.has(asset.id)),
      ...definitions.map((definition) => {
        const runtime = current.find((asset) => asset.id === definition.assetId);
        const runtimeMediaKey = `${definition.assetId}:${definition.hash}:${definition.generation}`;
        const preserveRuntime = runtime?.runtimeMediaKey === runtimeMediaKey;
        return runtimeAsset({
          ...definition,
          id: definition.assetId,
          blob: preserveRuntime ? runtime.blob : null,
          buffer: preserveRuntime ? runtime.buffer : null,
          ...(preserveRuntime ? { runtimeMediaKey } : {}),
        });
      }),
    ]);
    registryManagedIds = nextManagedIds;
  });

  function canonicalAudioState(): { tracks: AudioTrack[]; clips: AudioClip[] } {
    const state = canonical.getState();
    const trackIds = new Set(state.tracks
      .filter(isAudioTrack)
      .map((track) => track.id));
    return {
      tracks: state.tracks.filter(isAudioTrack).filter((track) => trackIds.has(track.id)),
      clips: state.clips.filter(isAudioClip).filter((clip) => trackIds.has(clip.trackId)),
    };
  }

  function currentState({ retainedAssets = false }: { retainedAssets?: boolean } = {}): AudioState {
    const placement = canonicalAudioState();
    const referenced = new Set(placement.clips.map((clip) => String(clip.assetId)));
    const assets = cloneRuntimeAssets(get(runtimeAssets))
      .filter((asset) => retainedAssets || referenced.has(String(asset.id)));
    return {
      assets,
      tracks: placement.tracks.map((track) => ({ ...track })),
      clips: placement.clips.map((clip) => ({ ...clip })),
    };
  }

  function replaceCanonicalAudio(
    trackValues: unknown,
    clipValues: unknown,
    operation = 'replace-audio',
  ): CanonicalTransactionResult {
    const nextTracks = (Array.isArray(trackValues) ? trackValues : [])
      .filter(isUnknownRecord)
      .map(audioTrackDefinition);
    const nextTrackIds = new Set(nextTracks.map((track) => track.id));
    const nextClips = (Array.isArray(clipValues) ? clipValues : [])
      .filter(isUnknownRecord)
      .filter((clip) => nextTrackIds.has(String(clip['trackId'])))
      .map((clip) => audioClipDefinition(clip));
    return canonical.transact(operation, (state) => {
      const audioTrackIds = new Set(state.tracks
        .filter((track) => track.kind === 'audio')
        .map((track) => track.id));
      state.tracks = [
        ...state.tracks.filter((track) => track.kind !== 'audio'),
        ...nextTracks,
      ];
      state.clips = [
        ...state.clips.filter((clip) =>
          clip.kind !== 'audio' && !audioTrackIds.has(clip.trackId)),
        ...nextClips,
      ];
      return { state, changed: true };
    });
  }

  function usedIds(state: AudioState): Set<string> {
    const timeline = canonical.getState();
    return new Set([
      ...state.assets.map((asset) => asset.id),
      ...timeline.tracks.map((track) => track.id),
      ...timeline.clips.map((clip) => clip.id),
    ]);
  }

  function allocateId(
    kind: string,
    preferred: unknown,
    reserved = usedIds(currentState({ retainedAssets: true })),
  ): string {
    const requested = idOf(preferred);
    if (requested) {
      if (reserved.has(requested)) throw new Error(`Duplicate audio id: ${requested}`);
      reserved.add(requested);
      return requested;
    }
    const generated = new Set();
    while (generated.size < 1000) {
      const candidate = idOf(makeId(kind));
      if (!candidate) continue;
      if (!reserved.has(candidate)) {
        reserved.add(candidate);
        return candidate;
      }
      if (generated.has(candidate)) break;
      generated.add(candidate);
    }
    throw new Error(`Could not allocate a unique ${kind} UUID.`);
  }

  function createAudioTrack(
    source: BlobLike | AudioSourceRecord,
    startTick = 0,
    clipOptions: AudioCreateOptions = {},
  ) {
    const state = currentState({ retainedAssets: true });
    const reserved = usedIds(state);
    const sourceValue: AudioSourceRecord = isBlobLike(source)
      ? {
        blob: source,
        ...(clipOptions.buffer !== undefined ? { buffer: clipOptions.buffer } : {}),
        ...(clipOptions.duration !== undefined ? { duration: clipOptions.duration } : {}),
      }
      : source || {};
    const requestedAssetId = idOf(clipOptions.assetId || sourceValue.id);
    const retainedAsset = requestedAssetId
      ? state.assets.find((candidate) => candidate.id === requestedAssetId)
      : null;
    const assetId = retainedAsset
      ? retainedAsset.id
      : allocateId('asset', requestedAssetId, reserved);
    const trackId = allocateId('track', clipOptions.trackId, reserved);
    const clipId = allocateId('clip', clipOptions.clipId, reserved);
    const asset = createImportedAudioAsset(sourceValue, {
      id: assetId,
      ...(clipOptions.sourceName ? { sourceName: clipOptions.sourceName } : {}),
    });
    const track = {
      id: trackId,
      kind: 'audio',
      name: String(clipOptions.trackName || asset.sourceName || 'Audio'),
      locked: false,
      stackIndex: canonical.getState().tracks.length,
    };
    const clip = audioClipDefinition({
      id: clipId,
      trackId,
      assetId,
      startTick,
      inPoint: clipOptions.inPoint,
      outPoint: clipOptions.outPoint,
      volume: clipOptions.volume,
      muted: clipOptions.muted,
      duration: asset.duration,
    });
    const result = canonical.transact('create-audio-track', (timeline) => {
      timeline.tracks.push(track);
      timeline.clips.push(clip);
      return { state: timeline, changed: true };
    });
    if (!result.changed) return null;
    const retainedRuntime = clipOptions.retainRuntime !== false
      ? asset
      : runtimeAsset({ ...asset, blob: null, buffer: null });
    runtimeAssets.set(retainedAsset
      ? state.assets.map((candidate) => candidate.id === assetId ? retainedRuntime : candidate)
      : [...state.assets, retainedRuntime]);
    return {
      asset,
      track: result.state.tracks.find((candidate) => candidate.id === trackId),
      clip: result.state.clips.find((candidate) => candidate.id === clipId),
    };
  }

  async function importAudioSource(
    blob: BlobLike,
    startTick = 0,
    createOptions: AudioCreateOptions = {},
  ) {
    const source = await decodeSource(blob, createOptions.decodeOptions || {});
    return createAudioTrack(source as unknown as AudioSourceRecord, startTick, createOptions);
  }

  function attachAudioAsset(
    assetId: string,
    source: BlobLike | AudioSourceRecord,
    assetOptions: { sourceName?: string; retainRuntime?: boolean } = {},
  ) {
    const state = currentState({ retainedAssets: true });
    const index = state.assets.findIndex((asset) => asset.id === assetId);
    if (index < 0) return null;
    const prior = state.assets[index]!;
    const replacement = createImportedAudioAsset(source, {
      id: prior.id,
      sourceName: assetOptions.sourceName ||
        (!isBlobLike(source) ? String(source.sourceName || '') : '') || prior.sourceName,
    });
    let clamped = 0;
    canonical.transact('attach-audio-asset', (timeline) => {
      let changed = false;
      timeline.clips = timeline.clips.map((clip) => {
        if (clip.kind !== 'audio' || clip.assetId !== assetId) return clip;
        const normalized = audioClipDefinition({ ...clip, duration: replacement.duration });
        if (normalized.inPoint !== clip.inPoint || normalized.outPoint !== clip.outPoint) clamped++;
        if (JSON.stringify(normalized) === JSON.stringify(clip)) return clip;
        changed = true;
        return normalized;
      });
      return changed ? { state: timeline, changed: true } : false;
    });
    if (assetOptions.retainRuntime !== false) {
      const nextAssets = [...state.assets];
      nextAssets[index] = replacement;
      runtimeAssets.set(nextAssets);
    }
    return { ...replacement, clamped };
  }

  function setAudioAssetRuntime(assetId: string, source: Partial<AudioRuntime> | null) {
    const state = currentState({ retainedAssets: true });
    const index = state.assets.findIndex((asset) => asset.id === assetId);
    if (index < 0) return null;
    const prior = state.assets[index]!;
    const replacement = runtimeAsset(source ? {
      ...prior,
      ...source,
      id: prior.id,
      sourceName: prior.sourceName,
      mime: prior.mime,
      size: prior.size,
      duration: prior.duration,
    } : {
      ...prior,
      blob: null,
      buffer: null,
    });
    const next = [...state.assets];
    next[index] = replacement;
    runtimeAssets.set(next);
    return replacement;
  }

  function updateAudioClip(trackId: string, clipId: string, patch: UnknownRecord = {}) {
    const state = canonical.getState();
    const current = state.clips.find((clip) =>
      clip.kind === 'audio' && clip.id === clipId && clip.trackId === trackId);
    if (!current) return null;
    const result = canonical.updateClip(clipId, {
      ...stripRuntimeMedia(patch),
      id: current.id,
      trackId: current.trackId,
      kind: 'audio',
      assetId: current.assetId,
      duration: current.duration,
    });
    return result.clip || null;
  }

  function updateAudioTrack(trackId: string, patch: UnknownRecord = {}) {
    const current = canonical.getState().tracks.find((track) =>
      track.kind === 'audio' && track.id === trackId);
    if (!current) return null;
    const result = canonical.updateTrack(trackId, audioTrackDefinition({
      ...current,
      ...stripRuntimeMedia(patch),
      id: current.id,
      kind: 'audio',
      name: String(patch['name'] ?? current.name),
    }));
    return result.track || null;
  }

  function removeAudioClip(trackId: string, clipId: string): AudioClip | null {
    const state = currentState();
    const removed = state.clips.find((clip) => clip.id === clipId && clip.trackId === trackId);
    if (!removed) return null;
    canonical.transact('remove-audio-clip', (timeline) => {
      timeline.clips = timeline.clips.filter((clip) => clip.id !== clipId);
      if (!timeline.clips.some((clip) => clip.trackId === trackId)) {
        timeline.tracks = timeline.tracks.filter((track) => track.id !== trackId);
      }
      return { state: timeline, changed: true };
    });
    return removed;
  }

  function removeAudioTrack(trackId: string): AudioTrack | null {
    const state = currentState();
    const removed = state.tracks.find((track) => track.id === trackId);
    if (!removed) return null;
    canonical.removeTrack(trackId);
    return removed;
  }

  function removeAudioAsset(assetId: string): AudioRuntimeAsset | null {
    const state = currentState();
    const removed = state.assets.find((asset) => asset.id === assetId);
    if (!removed) return null;
    canonical.transact('remove-audio-asset', (timeline) => {
      const affectedTrackIds = new Set(timeline.clips
        .filter((clip) => clip.kind === 'audio' && clip.assetId === assetId)
        .map((clip) => clip.trackId));
      timeline.clips = timeline.clips.filter((clip) =>
        clip.kind !== 'audio' || clip.assetId !== assetId);
      timeline.tracks = timeline.tracks.filter((track) =>
        !affectedTrackIds.has(track.id) ||
        timeline.clips.some((clip) => clip.trackId === track.id));
      return { state: timeline, changed: true };
    });
    return removed;
  }

  function splitAudioClipAtTick(
    trackId: string,
    clipId: string,
    splitTick: unknown,
    fps = DEFAULT_AUDIO_FPS,
  ) {
    const state = currentState({ retainedAssets: true });
    const index = state.clips.findIndex((clip) =>
      clip.id === clipId && clip.trackId === trackId);
    if (index < 0) return null;
    const split = splitAudioClip(state.clips[index]!, splitTick, fps, '__split__');
    if (!split) return null;
    const rightId = allocateId('clip', null, usedIds(state));
    const rate = Math.max(1, finiteNumber(fps, DEFAULT_AUDIO_FPS));
    const result = canonical.transact('split-audio-clip', (timeline) => {
      const timelineIndex = timeline.clips.findIndex((clip) =>
        clip.id === clipId && clip.trackId === trackId && clip.kind === 'audio');
      if (timelineIndex < 0) return false;
      timeline.fps = rate;
      timeline.tickDuration = 1000 / rate;
      timeline.clips.splice(
        timelineIndex,
        1,
        audioClipDefinition(split.left),
        audioClipDefinition({ ...split.right, id: rightId }),
      );
      return { state: timeline, changed: true };
    });
    if (!result.changed) return null;
    return {
      left: result.state.clips.find((clip) => clip.id === split.left.id),
      right: result.state.clips.find((clip) => clip.id === rightId),
    };
  }

  function audioStateForSave(source: unknown = currentState()) {
    return audioMetadata(source);
  }

  function serializeAudioState(source: unknown = currentState()) {
    const state = stateValue(source);
    const metadata = audioMetadata(state);
    const blobs = new Map<string, BlobLike>();
    const referenced = new Set(metadata.assets.map((asset) => asset.id));
    for (const asset of get(runtimeAssets)) {
      if (!referenced.has(String(asset.id))) continue;
      if (isBlobLike(asset.blob)) blobs.set(asset.id, asset.blob);
    }
    return {
      metadata,
      blobs,
      assetIds: metadata.assets.map((asset) => asset.id),
    };
  }

  function loadAudioState(serialized: unknown, blobMap?: AudioBlobSource): AudioState {
    const loaded = runtimeStateFromSerialized(serialized, blobMap);
    replaceCanonicalAudio(loaded.tracks, loaded.clips, 'load-audio');
    runtimeAssets.set(cloneRuntimeAssets(loaded.assets));
    return currentState();
  }

  function loadAudioAssets(serialized: unknown, blobMap?: AudioBlobSource): AudioRuntimeAsset[] {
    const wrapper = isUnknownRecord(serialized) ? serialized : {};
    const loaded = runtimeStateFromSerialized({ assets: wrapper['assets'] || [] }, blobMap);
    runtimeAssets.set(cloneRuntimeAssets(loaded.assets));
    return cloneRuntimeAssets(loaded.assets);
  }

  function captureAudioState(): AudioState {
    return currentState();
  }

  function restoreAudioState(snapshot: unknown): AudioState {
    const source = stateValue(snapshot);
    const restored = {
      assets: cloneRuntimeAssets(source.assets),
      tracks: Array.isArray(source.tracks) ? source.tracks.map(audioTrackDefinition) : [],
      clips: Array.isArray(source.clips) ? source.clips.map((clip) => audioClipDefinition(clip)) : [],
    };
    replaceCanonicalAudio(restored.tracks, restored.clips, 'restore-audio');
    runtimeAssets.set(restored.assets);
    return currentState();
  }

  function resetAudioState(): void {
    replaceCanonicalAudio([], [], 'reset-audio');
    runtimeAssets.set([]);
  }

  function clearAudioRuntime(): void {
    runtimeAssets.set([]);
  }

  const trackReadable = derived(canonical.timeline, (state): AudioTrack[] =>
    (state?.tracks || []).filter(isAudioTrack));
  const clipReadable = derived(canonical.timeline, (state): AudioClip[] =>
    (state?.clips || []).filter(isAudioClip));
  const assetReadable = derived(
    [runtimeAssets, clipReadable],
    ([$assets, $clips]) => {
      const referenced = new Set($clips.map((clip) => String(clip.assetId)));
      return $assets.filter((asset) => referenced.has(String(asset.id)));
    },
  );
  const timelineReadable = derived(
    [assetReadable, trackReadable, clipReadable],
    ([$assets, $tracks, $clips]) => ({
      assets: $assets,
      tracks: $tracks,
      clips: $clips,
    }),
  );

  const assets = {
    subscribe: assetReadable.subscribe,
    set(value: AudioRuntimeAsset[]) { runtimeAssets.set(cloneRuntimeAssets(value)); },
    update(updater: (value: AudioRuntimeAsset[]) => AudioRuntimeAsset[]) {
      assets.set(updater(get(assetReadable)));
    },
  };
  const tracks = {
    subscribe: trackReadable.subscribe,
    set(value: AudioTrack[]) {
      const next = Array.isArray(value) ? value : [];
      const ids = new Set(next.map((track) => String(track.id)));
      replaceCanonicalAudio(
        next,
        get(clipReadable).filter((clip) => ids.has(String(clip.trackId))),
        'set-audio-tracks',
      );
    },
    update(updater: (value: AudioTrack[]) => AudioTrack[]) {
      tracks.set(updater(get(trackReadable)));
    },
  };
  const clips = {
    subscribe: clipReadable.subscribe,
    set(value: AudioClip[]) {
      replaceCanonicalAudio(get(trackReadable), value, 'set-audio-clips');
    },
    update(updater: (value: AudioClip[]) => AudioClip[]) {
      clips.set(updater(get(clipReadable)));
    },
  };
  const audioTimeline = {
    subscribe: timelineReadable.subscribe,
    set(value: AudioState) { restoreAudioState(value); },
    update(updater: (value: AudioState) => AudioState) {
      restoreAudioState(updater(currentState()));
    },
  };

  if (injectedCanonical && options.initialState) {
    replaceCanonicalAudio(initialState.tracks, initialState.clips, 'initialize-audio');
  }

  return {
    canonicalController: canonical,
    audioTimeline,
    audioAssets: assets,
    audioTracks: tracks,
    audioClips: clips,
    createAudioTrack,
    importAudioSource,
    attachAudioAsset,
    setAudioAssetRuntime,
    updateAudioClip,
    updateAudioTrack,
    removeAudioClip,
    removeAudioTrack,
    removeAudioAsset,
    splitAudioClipAtTick,
    audioStateForSave,
    serializeAudioState,
    loadAudioState,
    loadAudioAssets,
    captureAudioState,
    restoreAudioState,
    resetAudioState,
    clearAudioRuntime,
  };
}

export const createAudioState = createAudioController;

const defaultAudio = createAudioController({
  canonicalController: defaultCanonicalController,
  registryStore: projectMediaRegistry,
});

export const audioTimeline = defaultAudio.audioTimeline;
export const audioState = audioTimeline;
export const audioAssets = defaultAudio.audioAssets;
export const audioTracks = defaultAudio.audioTracks;
export const audioClips = defaultAudio.audioClips;

export const createAudioTrack = (...args: Parameters<typeof defaultAudio.createAudioTrack>) =>
  defaultAudio.createAudioTrack(...args);
export const importAudioSource = (...args: Parameters<typeof defaultAudio.importAudioSource>) =>
  defaultAudio.importAudioSource(...args);
export const attachAudioAsset = (...args: Parameters<typeof defaultAudio.attachAudioAsset>) =>
  defaultAudio.attachAudioAsset(...args);
export const setAudioAssetRuntime = (...args: Parameters<typeof defaultAudio.setAudioAssetRuntime>) =>
  defaultAudio.setAudioAssetRuntime(...args);
export const updateAudioClip = (...args: Parameters<typeof defaultAudio.updateAudioClip>) =>
  defaultAudio.updateAudioClip(...args);
export const updateAudioTrack = (...args: Parameters<typeof defaultAudio.updateAudioTrack>) =>
  defaultAudio.updateAudioTrack(...args);
export const removeAudioClip = (...args: Parameters<typeof defaultAudio.removeAudioClip>) =>
  defaultAudio.removeAudioClip(...args);
export const removeAudioTrack = (...args: Parameters<typeof defaultAudio.removeAudioTrack>) =>
  defaultAudio.removeAudioTrack(...args);
export const removeAudioAsset = (...args: Parameters<typeof defaultAudio.removeAudioAsset>) =>
  defaultAudio.removeAudioAsset(...args);
export const splitAudioClipAtTick = (...args: Parameters<typeof defaultAudio.splitAudioClipAtTick>) =>
  defaultAudio.splitAudioClipAtTick(...args);
export const audioStateForSave = (...args: Parameters<typeof defaultAudio.audioStateForSave>) =>
  defaultAudio.audioStateForSave(...args);
export const serializeAudioState = (...args: Parameters<typeof defaultAudio.serializeAudioState>) =>
  defaultAudio.serializeAudioState(...args);
export const loadAudioState = (...args: Parameters<typeof defaultAudio.loadAudioState>) =>
  defaultAudio.loadAudioState(...args);
export const loadAudioAssets = (...args: Parameters<typeof defaultAudio.loadAudioAssets>) =>
  defaultAudio.loadAudioAssets(...args);
export const captureAudioState = (...args: Parameters<typeof defaultAudio.captureAudioState>) =>
  defaultAudio.captureAudioState(...args);
export const restoreAudioState = (...args: Parameters<typeof defaultAudio.restoreAudioState>) =>
  defaultAudio.restoreAudioState(...args);
export const resetAudioState = (...args: Parameters<typeof defaultAudio.resetAudioState>) =>
  defaultAudio.resetAudioState(...args);
export const clearAudioRuntime = (...args: Parameters<typeof defaultAudio.clearAudioRuntime>) =>
  defaultAudio.clearAudioRuntime(...args);
