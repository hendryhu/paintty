import type { MediaAsset, MediaRegistry } from './types/media-types.js';

interface MediaPurgePlanOptions {
  registry?: MediaRegistry | null;
  usageCounts?: ReadonlyMap<string, number>;
  serializedProject?: unknown;
}

interface MediaPurgeAvailability {
  playing?: boolean;
  unusedCount?: number;
  popupBusy?: boolean;
}

function utf8Size(value: unknown): number {
  return new TextEncoder().encode(String(value ?? '')).byteLength;
}

export function formatByteSize(value: unknown): string {
  const bytes = Math.max(0, Math.round(Number(value) || 0));
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function unusedMediaAssets(
  registry: MediaRegistry | null | undefined,
  usageCounts: ReadonlyMap<string, number> = new Map(),
): MediaAsset[] {
  return (registry?.assets || []).filter((asset) => (usageCounts.get(asset.assetId) || 0) === 0);
}

export function planUnusedMediaPurge({
  registry,
  usageCounts,
  serializedProject,
}: MediaPurgePlanOptions = {}) {
  const assets = registry?.assets || [];
  const unused = unusedMediaAssets(registry, usageCounts);
  const unusedIds = new Set(unused.map((asset) => asset.assetId));
  const retainedHashes = new Set(assets
    .filter((asset) => !unusedIds.has(asset.assetId))
    .map((asset) => asset.hash));
  const sizesByHash = new Map<string, number>();
  for (const asset of assets) {
    if (!sizesByHash.has(asset.hash)) sizesByHash.set(asset.hash, asset.size);
  }
  const freedHashes = new Set(unused
    .filter((asset) => !retainedHashes.has(asset.hash))
    .map((asset) => asset.hash));
  return {
    assets: unused,
    freedBytes: [...freedHashes].reduce((total, hash) => total + (sizesByHash.get(hash) || 0), 0),
    totalBytes: utf8Size(serializedProject) +
      [...sizesByHash.values()].reduce((total, size) => total + size, 0),
  };
}

export function canPurgeUnusedMedia({
  playing = false,
  unusedCount = 0,
  popupBusy = false,
}: MediaPurgeAvailability = {}): boolean {
  return !playing && !popupBusy && Number(unusedCount) > 0;
}
