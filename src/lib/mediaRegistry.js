import { get, writable } from 'svelte/store';
import { assertSha256, mediaPackagePath } from './mediaHash.js';
import { assertUuid, newUuid, uuidKey } from './uuid.js';

export const MEDIA_KINDS = Object.freeze(['image', 'audio', 'video']);
const MEDIA_KIND_SET = new Set(MEDIA_KINDS);
const MEDIA_FIELDS = new Set([
  'assetId', 'hash', 'path', 'sourceName', 'mime', 'size', 'kind',
  'duration', 'width', 'height', 'generation',
]);

function nonnegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${label} must be nonnegative.`);
  return number;
}

function positiveDimension(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${label} must be a positive integer.`);
  return number;
}

function assertOnlyMediaFields(value, label) {
  for (const key of Object.keys(value || {})) {
    if (!MEDIA_FIELDS.has(key)) throw new TypeError(`${label} contains unsupported field ${key}.`);
  }
}

export function normalizeMediaAsset(value, label = 'Media asset') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  assertOnlyMediaFields(value, label);
  const assetId = assertUuid(value.assetId, `${label} ID`);
  const hash = assertSha256(value.hash, `${label} hash`);
  const path = mediaPackagePath(hash);
  if (value.path !== path) throw new TypeError(`${label} path must be ${path}.`);
  const kind = String(value.kind || '');
  if (!MEDIA_KIND_SET.has(kind)) throw new TypeError(`${label} kind must be image, audio, or video.`);
  const size = Number(value.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TypeError(`${label} size must be a nonnegative integer.`);
  }
  const generation = Number(value.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new TypeError(`${label} generation must be a positive integer.`);
  }
  const output = {
    assetId,
    hash,
    path,
    sourceName: String(value.sourceName || 'Media'),
    mime: String(value.mime || 'application/octet-stream'),
    size,
    kind,
    generation,
  };
  if (kind === 'audio' || kind === 'video') {
    output.duration = nonnegativeNumber(value.duration, `${label} duration`);
  } else if (value.duration != null) {
    throw new TypeError(`${label} image cannot declare duration.`);
  }
  if (kind === 'image' || kind === 'video') {
    output.width = positiveDimension(value.width, `${label} width`);
    output.height = positiveDimension(value.height, `${label} height`);
  } else if (value.width != null || value.height != null) {
    throw new TypeError(`${label} audio cannot declare dimensions.`);
  }
  return Object.freeze(output);
}

export function normalizeMediaRegistry(value, label = 'Media registry') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (key !== 'generation' && key !== 'assets') {
      throw new TypeError(`${label} contains unsupported field ${key}.`);
    }
  }
  if (!Array.isArray(value.assets)) throw new TypeError(`${label} assets must be an array.`);
  const generation = Number(value.generation);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError(`${label} generation must be a nonnegative integer.`);
  }
  const ids = new Set();
  const sizesByHash = new Map();
  const assets = value.assets.map((asset, index) => {
    const normalized = normalizeMediaAsset(asset, `${label} asset ${index + 1}`);
    const key = uuidKey(normalized.assetId);
    if (ids.has(key)) throw new Error(`Duplicate media asset ID: ${normalized.assetId}.`);
    ids.add(key);
    const sharedSize = sizesByHash.get(normalized.hash);
    if (sharedSize != null && sharedSize !== normalized.size) {
      throw new Error(`Media hash ${normalized.hash} has conflicting byte sizes.`);
    }
    sizesByHash.set(normalized.hash, normalized.size);
    return normalized;
  });
  return Object.freeze({ generation, assets: Object.freeze(assets) });
}

function cloneRegistry(value) {
  return {
    generation: value.generation,
    assets: value.assets.map((asset) => ({ ...asset })),
  };
}

const initialRegistry = normalizeMediaRegistry({ generation: 0, assets: [] });
export const projectMediaRegistry = writable(initialRegistry);
export const mediaRuntimeStatus = writable(new Map());

export function currentMediaRegistry() {
  return get(projectMediaRegistry);
}

export function mediaAssetById(assetId, registry = currentMediaRegistry()) {
  const key = typeof assetId === 'string' ? assetId.toLowerCase() : '';
  return registry.assets.find((asset) => asset.assetId.toLowerCase() === key) || null;
}

export function captureMediaRegistry() {
  return cloneRegistry(currentMediaRegistry());
}

export function loadMediaRegistry(value) {
  const normalized = normalizeMediaRegistry(value);
  projectMediaRegistry.set(normalized);
  mediaRuntimeStatus.set(new Map());
  return normalized;
}

export function restoreMediaRegistry(value) {
  return loadMediaRegistry(value);
}

export function serializeMediaRegistry(registry = currentMediaRegistry()) {
  return cloneRegistry(registry);
}

export function registerMediaAsset(metadata, options = {}) {
  const registry = currentMediaRegistry();
  const draft = {
    ...metadata,
    assetId: metadata.assetId || newUuid('asset'),
    path: mediaPackagePath(metadata.hash),
    generation: metadata.generation || 1,
  };
  const normalized = normalizeMediaAsset(draft);
  if (options.dedupe !== false) {
    const existing = registry.assets.find((asset) =>
      asset.hash === normalized.hash && asset.kind === normalized.kind);
    if (existing) return { asset: existing, reused: true, changed: false };
  }
  if (mediaAssetById(normalized.assetId, registry)) {
    throw new Error(`Duplicate media asset ID: ${normalized.assetId}.`);
  }
  const next = normalizeMediaRegistry({
    generation: registry.generation + 1,
    assets: [...registry.assets, normalized],
  });
  projectMediaRegistry.set(next);
  return { asset: normalized, reused: false, changed: true };
}

export function replaceMediaAsset(assetId, metadata) {
  const registry = currentMediaRegistry();
  const current = mediaAssetById(assertUuid(assetId, 'Media asset ID'), registry);
  if (!current) throw new Error(`Unknown media asset: ${assetId}.`);
  const replacement = normalizeMediaAsset({
    ...metadata,
    assetId: current.assetId,
    path: mediaPackagePath(metadata.hash),
    generation: current.generation + 1,
  });
  if (replacement.kind !== current.kind) {
    throw new Error(`Replacement kind ${replacement.kind} does not match ${current.kind}.`);
  }
  const next = normalizeMediaRegistry({
    generation: registry.generation + 1,
    assets: registry.assets.map((asset) => asset.assetId === current.assetId ? replacement : asset),
  });
  projectMediaRegistry.set(next);
  mediaRuntimeStatus.update((statuses) => {
    const updated = new Map(statuses);
    updated.delete(current.assetId);
    return updated;
  });
  return { previous: current, asset: replacement };
}

export function purgeMediaAssets(assetIds) {
  const registry = currentMediaRegistry();
  const ids = new Set([...assetIds].map((id) => assertUuid(id, 'Purged media asset ID').toLowerCase()));
  const removed = registry.assets.filter((asset) => ids.has(asset.assetId.toLowerCase()));
  if (!removed.length) return [];
  const next = normalizeMediaRegistry({
    generation: registry.generation + 1,
    assets: registry.assets.filter((asset) => !ids.has(asset.assetId.toLowerCase())),
  });
  projectMediaRegistry.set(next);
  mediaRuntimeStatus.update((statuses) => new Map(
    [...statuses].filter(([id]) => !ids.has(String(id).toLowerCase())),
  ));
  return removed;
}

export function mediaUsageCounts(layerList = [], clips = [], registry = currentMediaRegistry()) {
  const counts = new Map(registry.assets.map((asset) => [asset.assetId, 0]));
  const canonicalIds = new Map(registry.assets.map((asset) => [
    asset.assetId.toLowerCase(),
    asset.assetId,
  ]));
  const increment = (assetId) => {
    const canonical = typeof assetId === 'string' ? canonicalIds.get(assetId.toLowerCase()) : null;
    if (!canonical) return;
    counts.set(canonical, counts.get(canonical) + 1);
  };
  for (const layer of layerList || []) {
    if (layer?.type === 'image') increment(layer.assetId);
    if (layer?.type === 'video') increment(layer.videoClip?.assetId);
  }
  for (const clip of clips || []) if (clip?.kind === 'audio') increment(clip.assetId);
  return counts;
}

export function registryHashes(value = currentMediaRegistry()) {
  return new Set(value.assets.map((asset) => asset.hash));
}

let historyInstalled = false;
export function installMediaRegistryHistory(registerHistoryContributor) {
  if (historyInstalled) return;
  historyInstalled = true;
  registerHistoryContributor(captureMediaRegistry, restoreMediaRegistry, {
    reachable(snapshot) { return registryHashes(snapshot); },
  });
}
