import { get } from 'svelte/store';
import {
  attachAudioAsset,
  createAudioTrack,
} from './audio.js';
import { getClipTimelineState } from './clipTimelineState.js';
import { loadImageToCanvas } from './converter.js';
import {
  beginStroke,
  cancelStroke,
  createImageLayer,
  createVideoLayer,
  endStroke,
  layers,
  noteAuthoredMutation,
  replaceImageAssetSource,
  attachVideoSource,
} from './grid.js';
import { scheduleMediaCacheGc } from './mediaGc.js';
import { unusedMediaAssets } from './mediaPurge.js';
import { sha256Hex } from './mediaHash.js';
import {
  currentMediaRegistry,
  mediaAssetById,
  mediaUsageCounts,
  purgeMediaAssets,
  registerMediaAsset,
  replaceMediaAsset,
} from './mediaRegistry.js';
import { acquireMediaResource } from './mediaRuntime.js';
import { notifyInfo } from './notifications.js';
import { putProjectAsset, withMediaLease } from './projectAssets.js';
import { playheadTick, setAssetRuntime } from './frames.js';
import { decodeAudioSource } from './audio.js';
import { loadVideoSource, releaseVideoSource } from './video.js';
import type {
  AudioRuntime,
  ImageRuntime,
  ImageMediaAsset,
  MediaAsset,
  MediaAssetInput,
  MediaKind,
  MediaRuntime,
  ProjectAssetMetadata,
  VideoRuntime,
} from './types/media-types.js';
import type { ProjectLayer } from './types/project-types.js';

interface DecodedMediaFile {
  runtime: MediaRuntime;
  metadata: Pick<MediaAssetInput, 'duration' | 'width' | 'height'>;
}

interface PreparedMediaFile extends DecodedMediaFile {
  metadata: MediaAssetInput & {
    hash: string;
    sourceName: string;
    mime: string;
    size: number;
    kind: MediaKind;
  };
}

interface PrepareMediaOptions {
  hashFile?: (file: File) => Promise<string>;
  decodeFile?: (file: File, kind: MediaKind) => Promise<DecodedMediaFile>;
}

interface MediaCommandOptions extends PrepareMediaOptions {
  putAsset?: (
    hash: unknown,
    blob: Blob,
    metadata?: ProjectAssetMetadata,
  ) => unknown | Promise<unknown>;
  valid?: () => boolean;
  startTick?: number;
}

function sourceName(file: File, fallback: string): string {
  return String(file?.name || fallback);
}

async function decodeFile(file: File, kind: MediaKind): Promise<DecodedMediaFile> {
  if (kind === 'image') {
    const raster = await loadImageToCanvas(file) as HTMLCanvasElement;
    return {
      runtime: { raster, blob: file },
      metadata: { width: raster.width, height: raster.height },
    };
  }
  if (kind === 'audio') {
    const runtime = await decodeAudioSource(file);
    return { runtime, metadata: { duration: runtime.duration } };
  }
  const runtime = await loadVideoSource(file);
  return {
    runtime,
    metadata: {
      duration: runtime.duration,
      width: runtime.width,
      height: runtime.height,
    },
  };
}

async function preparedFile(
  file: File,
  kind: MediaKind,
  options: PrepareMediaOptions = {},
): Promise<PreparedMediaFile> {
  if (!file || typeof file.arrayBuffer !== 'function') throw new TypeError('A media file is required.');
  const [hashResult, decodeResult] = await Promise.allSettled([
    (options.hashFile || sha256Hex)(file),
    (options.decodeFile || decodeFile)(file, kind),
  ]);
  if (decodeResult.status === 'rejected') throw decodeResult.reason;
  if (hashResult.status === 'rejected') {
    discardPrepared(kind, decodeResult.value.runtime);
    throw hashResult.reason;
  }
  const hash = hashResult.value;
  const decoded = decodeResult.value;
  const metadata = {
    hash,
    sourceName: sourceName(file, kind.charAt(0).toUpperCase() + kind.slice(1)),
    mime: String(file.type || `${kind}/unknown`),
    size: file.size,
    kind,
    ...decoded.metadata,
  };
  return { ...decoded, metadata };
}

function discardPrepared(kind: MediaKind, runtime: MediaRuntime): void {
  if (kind === 'video') releaseVideoSource(runtime as VideoRuntime);
  else if (kind === 'image') {
    const raster = (runtime as ImageRuntime).raster;
    if ('close' in raster && typeof raster.close === 'function') raster.close();
  }
}

function addPlacement(
  asset: MediaAsset,
  runtime: MediaRuntime,
  startTick = get(playheadTick),
): unknown {
  if (asset.kind === 'image') {
    return createImageLayer(asset.sourceName, (runtime as ImageRuntime).raster, asset.assetId);
  }
  if (asset.kind === 'video') {
    return createVideoLayer(
      asset.sourceName,
      { ...(runtime as VideoRuntime), assetId: asset.assetId },
      startTick,
    );
  }
  return createAudioTrack(runtime as AudioRuntime as unknown as Parameters<typeof createAudioTrack>[0], startTick, {
    assetId: asset.assetId,
    sourceName: asset.sourceName,
    retainRuntime: false,
  });
}

export async function importMediaFile(
  file: File,
  kind: MediaKind,
  options: MediaCommandOptions = {},
) {
  const prepared = await preparedFile(file, kind, options);
  try {
    return await withMediaLease(prepared.metadata.hash, async () => {
      await (options.putAsset || putProjectAsset)(
        prepared.metadata.hash,
        file,
        prepared.metadata,
      );
      if (options.valid && !options.valid()) return null;
      if (!beginStroke()) return null;
      try {
        const registered = registerMediaAsset(prepared.metadata);
        const placement = addPlacement(registered.asset, prepared.runtime, options.startTick);
        if (!placement) throw new Error(`Could not place ${kind} media.`);
        if (kind === 'audio') noteAuthoredMutation();
        endStroke();
        return { ...registered, placement };
      } catch (error) {
        cancelStroke();
        throw error;
      }
    });
  } finally {
    discardPrepared(kind, prepared.runtime);
  }
}

export async function replaceMediaFile(
  assetId: string,
  file: File,
  options: MediaCommandOptions = {},
) {
  const previous = mediaAssetById(assetId);
  if (!previous) throw new Error(`Unknown media asset: ${assetId}.`);
  const prepared = await preparedFile(file, previous.kind, options);
  try {
    return await withMediaLease(prepared.metadata.hash, async () => {
      await (options.putAsset || putProjectAsset)(
        prepared.metadata.hash,
        file,
        prepared.metadata,
      );
      const current = mediaAssetById(assetId);
      if (!current || current.hash !== previous.hash || current.generation !== previous.generation ||
          (options.valid && !options.valid())) return null;
      const layerList = get(layers) as ProjectLayer[];
      const previousVideoClips = previous.kind === 'video'
        ? layerList
          .filter((layer) => layer.type === 'video' && layer.videoClip?.assetId === assetId)
          .map((layer) => ({ id: layer.id, clip: { ...layer.videoClip! } }))
        : [];
      if (!beginStroke()) return null;
      let clamped = 0;
      try {
        const replacement = replaceMediaAsset(assetId, prepared.metadata).asset;
        if (previous.kind === 'image') {
          const changed = replaceImageAssetSource(
            assetId,
            previous,
            replacement as ImageMediaAsset,
          );
          if (!changed) noteAuthoredMutation();
        } else if (previous.kind === 'video') {
          const first = previousVideoClips[0];
          if (first) attachVideoSource(first.id, replacement.sourceName, {
            ...(prepared.runtime as VideoRuntime),
            assetId,
          });
          const after = new Map<string, ProjectLayer['videoClip']>(
            (get(layers) as ProjectLayer[])
              .filter((layer) => layer.type === 'video' && layer.videoClip?.assetId === assetId)
              .map((layer) => [layer.id, layer.videoClip] as const),
          );
          clamped = previousVideoClips.filter(({ id, clip }) => {
            const next = after.get(id);
            return next && (next.inPoint !== clip.inPoint || next.outPoint !== clip.outPoint);
          }).length;
          if (!first) noteAuthoredMutation();
        } else {
          const attached = attachAudioAsset(
            assetId,
            prepared.runtime as AudioRuntime as unknown as Parameters<typeof attachAudioAsset>[1],
            {
              sourceName: replacement.sourceName,
              retainRuntime: false,
            },
          );
          clamped = attached?.clamped || 0;
          noteAuthoredMutation();
        }
        endStroke();
        if (previous.kind === 'image' || previous.kind === 'video') {
          setAssetRuntime(assetId, null);
        }
        if (clamped) {
          notifyInfo(`Replaced ${previous.sourceName}; clamped ${clamped} affected usage${clamped === 1 ? '' : 's'}.`);
        }
        return { asset: replacement, clamped };
      } catch (error) {
        cancelStroke();
        throw error;
      }
    });
  } finally {
    discardPrepared(previous.kind, prepared.runtime);
  }
}

export async function placeMediaAsset(assetId: string, options: MediaCommandOptions = {}) {
  const asset = mediaAssetById(assetId);
  if (!asset) throw new Error(`Unknown media asset: ${assetId}.`);
  const lease = await acquireMediaResource(assetId);
  try {
    const current = mediaAssetById(assetId);
    if (!current || current.hash !== asset.hash || current.generation !== asset.generation ||
        (options.valid && !options.valid())) return null;
    if (!beginStroke()) return null;
    try {
      const placement = addPlacement(asset, lease.value, options.startTick);
      if (!placement) {
        cancelStroke();
        return null;
      }
      if (asset.kind === 'audio') noteAuthoredMutation();
      endStroke();
      return placement;
    } catch (error) {
      cancelStroke();
      throw error;
    }
  } finally {
    lease.release();
  }
}

export function purgeUnusedMedia() {
  const counts = mediaUsageCounts(
    get(layers) as ProjectLayer[],
    getClipTimelineState().clips,
  );
  const unused = unusedMediaAssets(currentMediaRegistry(), counts)
    .map((asset) => asset.assetId);
  if (!unused.length) return 0;
  if (!beginStroke()) return 0;
  purgeMediaAssets(unused);
  noteAuthoredMutation();
  endStroke();
  scheduleMediaCacheGc();
  return unused.length;
}

export function currentMediaUsageCounts() {
  return mediaUsageCounts(
    get(layers) as ProjectLayer[],
    getClipTimelineState().clips,
  );
}
