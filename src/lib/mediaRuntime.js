import { writable } from 'svelte/store';
import { clearAudioRuntime, decodeAudioSource, setAudioAssetRuntime } from './audio.js';
import { loadImageToCanvas } from './converter.js';
import { setAssetRuntime } from './frames.js';
import { sha256Hex } from './mediaHash.js';
import {
  currentMediaRegistry,
  mediaAssetById,
  mediaRuntimeStatus,
  projectMediaRegistry,
} from './mediaRegistry.js';
import { createMediaResourceManager, StaleMediaResourceError } from './mediaResources.js';
import { getProjectAsset, withMediaLease } from './projectAssets.js';
import { loadVideoSource, releaseVideoSource } from './video.js';
import { onProjectReplaced } from './documentLifecycle.js';

function mediaGenerationKey(asset) {
  return `${asset.assetId}:${asset.hash}:${asset.generation}`;
}

function publishStatus(asset, state, detail = null) {
  const current = mediaAssetById(asset.assetId);
  if (!current || current.hash !== asset.hash || current.generation !== asset.generation) return;
  mediaRuntimeStatus.update((statuses) => {
    const next = new Map(statuses);
    next.set(asset.assetId, {
      state,
      hash: asset.hash,
      generation: asset.generation,
      ...(detail ? { detail: String(detail) } : {}),
    });
    return next;
  });
}

async function verifiedBlob(asset) {
  const record = await getProjectAsset(asset.hash);
  if (!record?.blob) {
    publishStatus(asset, 'missing');
    throw new Error(`Media bytes are missing for ${asset.sourceName}.`);
  }
  if (record.size !== asset.size || record.blob.size !== asset.size) {
    throw new Error(`Cached media size mismatch for ${asset.sourceName}.`);
  }
  if (await sha256Hex(record.blob) !== asset.hash) {
    throw new Error(`Cached media hash mismatch for ${asset.sourceName}.`);
  }
  return record.blob.type === asset.mime
    ? record.blob
    : record.blob.slice(0, record.blob.size, asset.mime);
}

async function decodeMedia(asset) {
  publishStatus(asset, 'pending');
  return withMediaLease(asset.hash, async () => {
    try {
      const blob = await verifiedBlob(asset);
      let value;
      if (asset.kind === 'image') {
        value = { raster: await loadImageToCanvas(blob), blob };
      } else if (asset.kind === 'audio') {
        value = await decodeAudioSource(blob);
      } else {
        value = await loadVideoSource(blob);
      }
      publishStatus(asset, 'ready');
      return value;
    } catch (error) {
      if (!(error instanceof StaleMediaResourceError)) {
        const missing = /missing/i.test(error?.message || '');
        publishStatus(asset, missing ? 'missing' : 'decode-failed', error?.message);
      }
      throw error;
    }
  });
}

function disposeMedia(value, asset) {
  if (asset.kind === 'video') releaseVideoSource(value);
  else if (asset.kind === 'image') value?.raster?.close?.();
}

export const mediaResourceManager = createMediaResourceManager({
  decode: decodeMedia,
  dispose: disposeMedia,
  isCurrent(asset) {
    const current = mediaAssetById(asset.assetId);
    return current?.hash === asset.hash && current.generation === asset.generation;
  },
});

export function acquireMediaResource(assetId) {
  const asset = mediaAssetById(assetId);
  if (!asset) return Promise.reject(new Error(`Unknown media asset: ${assetId}.`));
  return mediaResourceManager.acquire(asset);
}

const visualLeases = new Map();
const visualOwners = new Map();
export const visualMediaRequestRevision = writable(0);
let visualSequence = 0;

function visibleReferenceAssets(layerList, requestedClipIds) {
  const groups = new Map((layerList || [])
    .filter((layer) => layer.type === 'group')
    .map((group) => [group.id, group]));
  const desired = new Set();
  for (const layer of layerList || []) {
    if (layer.type !== 'image' && layer.type !== 'video') continue;
    const requested = requestedClipIds?.has(layer.id);
    const group = layer.groupId == null ? null : groups.get(layer.groupId);
    const visible = layer.visible !== false && (layer.opacity ?? 1) > 0 && group?.visible !== false;
    if (!visible && !requested) continue;
    const assetId = layer.type === 'image' ? layer.assetId : layer.videoClip?.assetId;
    if (assetId) desired.add(assetId);
  }
  for (const assetIds of visualOwners.values()) {
    for (const assetId of assetIds) desired.add(assetId);
  }
  return desired;
}

function visualReferencesHaveRuntime(layerList, assetId, key) {
  const references = (layerList || []).filter((layer) => (
    layer.type === 'image' ? layer.assetId === assetId :
      layer.type === 'video' && layer.videoClip?.assetId === assetId
  ));
  return references.length > 0 && references.every((layer) => layer.runtimeMediaKey === key);
}

// Each map entry owns one generation-keyed lease; an asynchronous decode may attach
// only while that exact entry still represents a requested asset.
export function syncVisibleMediaResources(layerList, requestedClipIds = new Set()) {
  const sequence = ++visualSequence;
  const desired = visibleReferenceAssets(layerList, requestedClipIds);
  for (const [assetId, entry] of [...visualLeases]) {
    const asset = mediaAssetById(assetId);
    const key = asset ? mediaGenerationKey(asset) : null;
    if (desired.has(assetId) && entry.key === key) continue;
    visualLeases.delete(assetId);
    entry.lease?.release();
    setAssetRuntime(assetId, null);
  }
  for (const assetId of desired) {
    const asset = mediaAssetById(assetId);
    if (!asset || (asset.kind !== 'image' && asset.kind !== 'video')) continue;
    const key = mediaGenerationKey(asset);
    const existing = visualLeases.get(assetId);
    if (existing?.key === key) {
      if (existing.lease && !visualReferencesHaveRuntime(layerList, assetId, key)) {
        setAssetRuntime(assetId, { ...existing.lease.value, key });
      }
      continue;
    }
    const entry = { key, lease: null, sequence };
    visualLeases.set(assetId, entry);
    acquireMediaResource(assetId).then((lease) => {
      if (visualLeases.get(assetId) !== entry || sequence !== visualSequence && !desired.has(assetId)) {
        lease.release();
        return;
      }
      entry.lease = lease;
      setAssetRuntime(assetId, { ...lease.value, key });
    }).catch((error) => {
      if (visualLeases.get(assetId) === entry) visualLeases.delete(assetId);
      if (!(error instanceof StaleMediaResourceError) && !/missing/i.test(error?.message || '')) {
        console.warn(`Could not decode media asset ${assetId}.`, error);
      }
    });
  }
}

export function syncVisualMediaRequests(owner, assetIds) {
  const next = new Set(assetIds || []);
  const previous = visualOwners.get(owner);
  if (previous?.size === next.size && [...next].every((assetId) => previous.has(assetId))) return;
  visualOwners.set(owner, next);
  visualMediaRequestRevision.update((revision) => revision + 1);
}

export function releaseVisualMediaRequests(owner) {
  if (!visualOwners.delete(owner)) return;
  visualMediaRequestRevision.update((revision) => revision + 1);
}

export function releaseVisibleMediaResources() {
  visualSequence++;
  for (const [assetId, entry] of visualLeases) {
    entry.lease?.release();
    setAssetRuntime(assetId, null);
  }
  visualLeases.clear();
}

const audioOwners = new Map();
const audioLeases = new Map();

function requestedAudioIds() {
  const output = new Set();
  for (const ids of audioOwners.values()) for (const id of ids) output.add(id);
  return output;
}

function reconcileAudioRequests() {
  const desired = requestedAudioIds();
  for (const [assetId, entry] of [...audioLeases]) {
    const asset = mediaAssetById(assetId);
    const key = asset ? mediaGenerationKey(asset) : null;
    if (desired.has(assetId) && entry.key === key) continue;
    audioLeases.delete(assetId);
    entry.lease?.release();
    setAudioAssetRuntime(assetId, null);
  }
  for (const assetId of desired) {
    const asset = mediaAssetById(assetId);
    if (!asset || asset.kind !== 'audio') continue;
    const key = mediaGenerationKey(asset);
    if (audioLeases.get(assetId)?.key === key) continue;
    const entry = { key, lease: null };
    audioLeases.set(assetId, entry);
    acquireMediaResource(assetId).then((lease) => {
      if (audioLeases.get(assetId) !== entry) {
        lease.release();
        return;
      }
      entry.lease = lease;
      setAudioAssetRuntime(assetId, { ...lease.value, runtimeMediaKey: key });
    }).catch((error) => {
      if (audioLeases.get(assetId) === entry) audioLeases.delete(assetId);
      if (!(error instanceof StaleMediaResourceError) && !/missing/i.test(error?.message || '')) {
        console.warn(`Could not decode audio asset ${assetId}.`, error);
      }
    });
  }
}

export function syncAudioMediaRequests(owner, assetIds) {
  audioOwners.set(owner, new Set(assetIds || []));
  reconcileAudioRequests();
}

export function releaseAudioMediaRequests(owner) {
  audioOwners.delete(owner);
  reconcileAudioRequests();
}

export function activeMediaResourceHashes() {
  return mediaResourceManager.activeHashes();
}

export function resetMediaRuntime() {
  releaseVisibleMediaResources();
  visualOwners.clear();
  visualMediaRequestRevision.update((revision) => revision + 1);
  audioOwners.clear();
  reconcileAudioRequests();
  mediaResourceManager.clear();
  clearAudioRuntime();
  mediaRuntimeStatus.set(new Map());
}

onProjectReplaced(resetMediaRuntime);

let previousRegistryHashes = new Map(
  currentMediaRegistry().assets.map((asset) => [asset.assetId, mediaGenerationKey(asset)]),
);
projectMediaRegistry.subscribe((registry) => {
  // Generation changes invalidate decodes even when the asset UUID stays stable, so
  // a replacement can never receive its predecessor's runtime object.
  const current = new Map(registry.assets.map((asset) => [asset.assetId, mediaGenerationKey(asset)]));
  for (const [assetId, key] of previousRegistryHashes) {
    if (current.get(assetId) !== key) mediaResourceManager.invalidateAsset(assetId);
  }
  previousRegistryHashes = current;
  reconcileAudioRequests();
});
