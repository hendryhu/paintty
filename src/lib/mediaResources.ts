import { assertSha256 } from './mediaHash.js';
import { assertUuid } from './uuid.js';
import type {
  MediaKind,
  MediaLease,
  MediaResourceAsset,
  MediaResourceEntry,
  MediaResourceManager,
} from './types/media-types.js';

interface MediaResourceManagerOptions<A extends MediaResourceAsset, T> {
  decode?: (asset: A) => T | Promise<T>;
  dispose?: (value: T, asset: A) => void;
  isCurrent?: (asset: A) => boolean;
  now?: () => number;
  capacities?: Partial<Record<MediaKind, number>>;
}

export class StaleMediaResourceError extends Error {
  constructor(assetId: string) {
    super(`Media asset ${assetId} changed while it was decoding.`);
    this.name = 'StaleMediaResourceError';
  }
}

function resourceKey(asset: MediaResourceAsset): string {
  return `${assertUuid(asset.assetId, 'Media resource asset ID')}:${assertSha256(asset.hash)}`;
}

export function createMediaResourceManager<A extends MediaResourceAsset, T>(
  options: MediaResourceManagerOptions<A, T> = {},
): MediaResourceManager<A, T> {
  const decodeOption = options.decode;
  const dispose = options.dispose || (() => {});
  const isCurrent = options.isCurrent || (() => true);
  const now = options.now || (() => Date.now());
  const capacities: Record<MediaKind, number> = {
    image: 4,
    audio: 4,
    video: 2,
    ...(options.capacities || {}),
  };
  if (typeof decodeOption !== 'function') throw new TypeError('Media resource manager requires a decoder.');
  const decode = decodeOption;
  const entries = new Map<string, MediaResourceEntry<A, T>>();
  const detached = new Set<MediaResourceEntry<A, T>>();

  function disposeEntry(entry: MediaResourceEntry<A, T>): void {
    if (entry.disposed || entry.value == null) return;
    entry.disposed = true;
    dispose(entry.value, entry.asset);
  }

  function evict(kind: MediaKind): void {
    const limit = Math.max(0, Math.floor(Number(capacities[kind]) || 0));
    const idle = [...entries.values()]
      .filter((entry) => entry.kind === kind && entry.state === 'ready' && entry.refs === 0)
      .sort((left, right) => left.lastUsed - right.lastUsed || left.key.localeCompare(right.key));
    while (idle.length > limit) {
      const entry = idle.shift()!;
      entries.delete(entry.key);
      disposeEntry(entry);
    }
  }

  function releaseEntry(entry: MediaResourceEntry<A, T>): void {
    if (entry.refs <= 0) return;
    entry.refs--;
    entry.lastUsed = now();
    if (entry.refs !== 0) return;
    if (entry.invalidated) {
      disposeEntry(entry);
      detached.delete(entry);
    }
    else evict(entry.kind);
  }

  // UUID+hash entries share one pending decode while each caller receives its own
  // release-once lease.
  async function acquire(asset: A): Promise<MediaLease<T>> {
    const key = resourceKey(asset);
    let entry = entries.get(key);
    if (!entry) {
      const created: MediaResourceEntry<A, T> = {
        key,
        kind: asset.kind,
        asset,
        refs: 0,
        state: 'pending',
        value: null,
        disposed: false,
        lastUsed: now(),
      };
      created.promise = Promise.resolve()
        .then(() => decode(asset))
        .then((value) => {
          created.value = value;
          created.state = 'ready';
          if (created.invalidated || !isCurrent(asset)) {
            entries.delete(key);
            disposeEntry(created);
            throw new StaleMediaResourceError(asset.assetId);
          }
          return value;
        })
        .catch((error) => {
          created.state = 'error';
          if (entries.get(key) === created) entries.delete(key);
          throw error;
        });
      entry = created;
      entries.set(key, created);
    }
    entry.refs++;
    entry.lastUsed = now();
    try {
      const value: T = entry.state === 'ready' ? entry.value! : await entry.promise!;
      let released = false;
      return {
        assetId: asset.assetId,
        hash: asset.hash,
        value,
        release() {
          if (released) return;
          released = true;
          releaseEntry(entry);
        },
      };
    } catch (error) {
      releaseEntry(entry);
      throw error;
    }
  }

  // Ready entries with outstanding leases detach until final release; a pending
  // decode instead rejects itself as stale before publishing.
  function invalidateAsset(assetId: string): void {
    const id = String(assertUuid(assetId, 'Invalidated media asset ID'));
    for (const entry of [...entries.values()]) {
      if (entry.asset.assetId !== id) continue;
      entries.delete(entry.key);
      entry.invalidated = true;
      if (entry.refs === 0) disposeEntry(entry);
      else detached.add(entry);
    }
  }

  function activeHashes(): Set<string> {
    return new Set([...entries.values(), ...detached]
      .filter((entry) => entry.state === 'pending' || entry.refs > 0)
      .map((entry) => entry.asset.hash));
  }

  function clear(): void {
    for (const entry of entries.values()) {
      entry.invalidated = true;
      if (entry.refs > 0) detached.add(entry);
      disposeEntry(entry);
    }
    entries.clear();
    for (const entry of detached) disposeEntry(entry);
    detached.clear();
  }

  function inspect() {
    return [...entries.values()].map((entry) => ({
      key: entry.key,
      kind: entry.kind,
      refs: entry.refs,
      state: entry.state,
      disposed: entry.disposed,
      invalidated: !!entry.invalidated,
      lastUsed: entry.lastUsed,
    }));
  }

  return { acquire, invalidateAsset, activeHashes, clear, inspect };
}
