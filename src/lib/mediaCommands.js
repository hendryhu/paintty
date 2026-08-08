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

function sourceName(file, fallback) {
  return String(file?.name || fallback);
}

async function decodeFile(file, kind) {
  if (kind === 'image') {
    const raster = await loadImageToCanvas(file);
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

async function preparedFile(file, kind, options = {}) {
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
    sourceName: sourceName(file, kind[0].toUpperCase() + kind.slice(1)),
    mime: String(file.type || `${kind}/unknown`),
    size: file.size,
    kind,
    ...decoded.metadata,
  };
  return { ...decoded, metadata };
}

function discardPrepared(kind, runtime) {
  if (kind === 'video') releaseVideoSource(runtime);
  else if (kind === 'image') runtime?.raster?.close?.();
}

function addPlacement(asset, runtime, startTick = get(playheadTick)) {
  if (asset.kind === 'image') {
    return createImageLayer(asset.sourceName, runtime.raster, asset.assetId);
  }
  if (asset.kind === 'video') {
    return createVideoLayer(asset.sourceName, { ...runtime, assetId: asset.assetId }, startTick);
  }
  return createAudioTrack(runtime, startTick, {
    assetId: asset.assetId,
    sourceName: asset.sourceName,
    retainRuntime: false,
  });
}

export async function importMediaFile(file, kind, options = {}) {
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

export async function replaceMediaFile(assetId, file, options = {}) {
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
      const previousVideoClips = previous.kind === 'video'
        ? get(layers)
          .filter((layer) => layer.type === 'video' && layer.videoClip?.assetId === assetId)
          .map((layer) => ({ id: layer.id, clip: { ...layer.videoClip } }))
        : [];
      if (!beginStroke()) return null;
      let clamped = 0;
      try {
        const replacement = replaceMediaAsset(assetId, prepared.metadata).asset;
        if (previous.kind === 'image') {
          const changed = replaceImageAssetSource(
            assetId,
            previous,
            replacement,
          );
          if (!changed) noteAuthoredMutation();
        } else if (previous.kind === 'video') {
          const first = previousVideoClips[0];
          if (first) attachVideoSource(first.id, replacement.sourceName, {
            ...prepared.runtime,
            assetId,
          });
          const after = new Map(get(layers)
            .filter((layer) => layer.type === 'video' && layer.videoClip?.assetId === assetId)
            .map((layer) => [layer.id, layer.videoClip]));
          clamped = previousVideoClips.filter(({ id, clip }) => {
            const next = after.get(id);
            return next && (next.inPoint !== clip.inPoint || next.outPoint !== clip.outPoint);
          }).length;
          if (!first) noteAuthoredMutation();
        } else {
          const attached = attachAudioAsset(assetId, prepared.runtime, {
            sourceName: replacement.sourceName,
            retainRuntime: false,
          });
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

export async function placeMediaAsset(assetId, options = {}) {
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
  const counts = mediaUsageCounts(get(layers), getClipTimelineState().clips);
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
  return mediaUsageCounts(get(layers), getClipTimelineState().clips);
}
