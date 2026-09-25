import type { AudioClip, AudioTrack, ProjectLayer, UnknownRecord } from './project-types.js';

export const MEDIA_KIND_VALUES = ['image', 'audio', 'video'] as const;
export type MediaKind = typeof MEDIA_KIND_VALUES[number];
export type Sha256 = string;
export type Uuid = string;

interface MediaAssetBase {
  assetId: Uuid;
  hash: Sha256;
  path: string;
  sourceName: string;
  mime: string;
  size: number;
  generation: number;
}

export interface ImageMediaAsset extends MediaAssetBase {
  kind: 'image';
  width: number;
  height: number;
}

export interface AudioMediaAsset extends MediaAssetBase {
  kind: 'audio';
  duration: number;
}

export interface VideoMediaAsset extends MediaAssetBase {
  kind: 'video';
  duration: number;
  width: number;
  height: number;
}

export type MediaAsset = ImageMediaAsset | AudioMediaAsset | VideoMediaAsset;

export interface MediaRegistry {
  generation: number;
  assets: readonly MediaAsset[];
}

export interface MutableMediaRegistry {
  generation: number;
  assets: MediaAsset[];
}

export interface MediaAssetInput extends UnknownRecord {
  assetId?: unknown;
  hash?: unknown;
  path?: unknown;
  sourceName?: unknown;
  mime?: unknown;
  size?: unknown;
  kind?: unknown;
  duration?: unknown;
  width?: unknown;
  height?: unknown;
  generation?: unknown;
}

export interface MediaRegistryInput extends UnknownRecord {
  generation?: unknown;
  assets?: unknown;
}

export interface MediaRuntimeStatus {
  state: string;
  hash: Sha256;
  generation: number;
  detail?: string;
}

export interface BlobLike {
  readonly size: number;
  readonly type: string;
  readonly name?: string;
  readonly lastModified?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ImageRuntime {
  raster: HTMLCanvasElement | ImageBitmap;
  blob: BlobLike;
}

export interface AudioRuntime {
  sourceName: string;
  mime: string;
  size: number;
  duration: number;
  blob: BlobLike | null;
  buffer: AudioBuffer | null;
  runtimeMediaKey?: string;
}

export interface VideoRuntime {
  element: HTMLVideoElement;
  raster: HTMLCanvasElement;
  url: string;
  blob: BlobLike;
  mime: string;
  duration: number;
  width: number;
  height: number;
  assetId?: string;
}

export type MediaRuntime = ImageRuntime | AudioRuntime | VideoRuntime;

export type MediaRuntimeFor<K extends MediaKind> =
  K extends 'image' ? ImageRuntime : K extends 'audio' ? AudioRuntime : VideoRuntime;

export interface MediaLease<T> {
  assetId: string;
  hash: string;
  value: T;
  release(): void;
}

export interface MediaResourceAsset {
  assetId: string;
  hash: string;
  kind: MediaKind;
}

export type ResourceState = 'pending' | 'ready' | 'error';

export interface MediaResourceEntry<A extends MediaResourceAsset, T> {
  key: string;
  kind: MediaKind;
  asset: A;
  refs: number;
  state: ResourceState;
  value: T | null;
  disposed: boolean;
  lastUsed: number;
  promise?: Promise<T>;
  invalidated?: boolean;
}

export interface MediaResourceManager<A extends MediaResourceAsset, T> {
  acquire(asset: A): Promise<MediaLease<T>>;
  invalidateAsset(assetId: string): void;
  activeHashes(): Set<string>;
  clear(): void;
  inspect(): Array<{
    key: string;
    kind: MediaKind;
    refs: number;
    state: ResourceState;
    disposed: boolean;
    invalidated: boolean;
    lastUsed: number;
  }>;
}

export interface ProjectAssetRecord {
  hash: string;
  blob: Blob;
  size: number;
  mime: string;
  createdAt: number;
  lastAccessedAt: number;
}

export interface ProjectAssetMetadata {
  size?: number;
  mime?: string;
  createdAt?: number;
}

export interface MediaUsageLayer extends Pick<ProjectLayer, 'type'> {
  assetId?: string;
  videoClip?: { assetId?: string } | null;
}

export interface MediaUsageClip {
  kind?: string;
  assetId?: unknown;
}

export interface AudioRuntimeAsset extends AudioRuntime {
  id: string;
}

export interface AudioState {
  assets: AudioRuntimeAsset[];
  tracks: AudioTrack[];
  clips: AudioClip[];
}

export type MediaBytesSource = BlobLike | ArrayBuffer | ArrayBufferView;
