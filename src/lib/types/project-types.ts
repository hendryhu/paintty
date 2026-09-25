import type { Readable, Writable } from 'svelte/store';

export type UnknownRecord = Record<string, unknown>;
export type TimerHandle = ReturnType<typeof setTimeout>;
export type Unsubscribe = () => void;
export type VoidCallback = () => void;
export type AsyncVoidCallback = () => void | Promise<void>;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface Point {
  x: number;
  y: number;
}

export interface CellValue extends UnknownRecord {
  c?: string;
  glyph?: string;
  fg?: string | null;
  foreground?: string | null;
  bg?: string | null;
  background?: string | null;
  cont?: boolean;
  blink?: boolean;
  width?: number;
  x?: number;
  y?: number;
}

export type CellMap = Record<string, CellValue | null>;

export interface TimelineKey<T = unknown> {
  tick: number;
  value: T;
}

export interface ProjectLayer extends UnknownRecord {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  cells: CellMap;
  offset?: Point | null;
  groupId?: string | null;
  collapsed?: boolean;
  opacity?: number;
  assetId?: string;
  videoClip?: VideoClip | null;
  videoElement?: HTMLVideoElement | null;
  videoURL?: string | null;
  raster?: HTMLCanvasElement | null;
  runtimeMediaKey?: string | null;
  mask?: UnknownRecord | null;
}

export interface TimelineTrack extends UnknownRecord {
  id: string;
  kind: string;
  name?: string;
  locked: boolean;
  parentTrackId?: string;
  layer?: ProjectLayer;
  propertyTracks?: Record<string, TimelineKey[]>;
  volume?: number;
  muted?: boolean;
  shapePathKind?: string;
  shapePathComponents?: string[];
}

export interface TimelineClip extends UnknownRecord {
  id: string;
  trackId: string;
  kind: string;
  startTick: number;
  inTick: number;
  outTick: number;
  sourceDuration: number;
  frameKeys: TimelineKey<UnknownRecord>[];
  propertyTracks: Record<string, TimelineKey[]>;
  assetId?: string;
  inPoint?: number;
  outPoint?: number;
  playbackRate?: number;
  volume?: number;
  muted?: boolean;
  name?: string;
  duration?: number;
}

export interface AudioClip extends UnknownRecord {
  id: string;
  trackId: string;
  assetId: string;
  kind: 'audio';
  startTick: number;
  inPoint: number;
  outPoint: number;
  volume: number;
  muted: boolean;
  duration: number;
}

export interface VideoClip extends UnknownRecord {
  startTick: number;
  inPoint: number;
  outPoint: number;
  playbackRate: number;
  duration: number;
  assetId?: string;
}

export interface AudioTrack extends UnknownRecord {
  id: string;
  kind: 'audio';
  name: string;
  locked: boolean;
  volume?: number;
  muted?: boolean;
  clips?: AudioClip[];
}

export interface CanonicalTimelineState extends UnknownRecord {
  tracks: Array<TimelineTrack | AudioTrack>;
  clips: Array<TimelineClip | AudioClip>;
  tags: TimelineTag[];
  fps: number;
  tickDuration: number;
}

export interface TimelineTag extends UnknownRecord {
  id: string;
  tick: number;
  type: string;
  value?: string;
}

export interface ProjectDraft {
  columns: number;
  rows: number;
  baseFps: number;
}

export interface ProjectPreset extends ProjectDraft {
  id: string;
  name: string;
  builtIn?: boolean;
}

export interface ProjectPresetSettings {
  version: number;
  userPresets: ProjectPreset[];
  defaultPresetId: string;
  lastUsed: {
    presetId: string;
    draft: ProjectDraft;
  };
}

export interface SaveTarget {
  name: string;
  durable: boolean;
  write(blob: Blob, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface ExportSpec {
  extension: string;
  mime: string;
  description: string;
}

export interface ProjectSavedDetail {
  contents: string;
  currentContents?: string | null;
  fileName: string;
  recentId?: string | null;
  recent?: boolean;
}

export interface ProjectLoadedDetail {
  contents: string;
  fileName: string;
  recentId?: string | null;
  recent?: boolean;
}

export interface ProjectCheckpointDetail {
  contents: string;
  fileName: string;
}

export interface ProjectReplacedDetail {
  revision?: number;
}

export interface RevisionTracker {
  capture(): number;
  advance(): number;
  isCurrent(candidate: number): boolean;
}

export interface LatestRequest<K> {
  key: K;
  sequence: number;
}

export interface LatestRequestSettleOptions<T> {
  valid?: boolean;
  accept?(value: T): boolean | void;
  discard?(value: T): void;
}

export interface StorageLike {
  readonly length?: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
  key?(index: number): string | null;
}

export interface FileSystemWritableLike {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface FileSystemFileHandleLike {
  readonly name: string;
  createWritable(): Promise<FileSystemWritableLike>;
  getFile(): Promise<File>;
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export interface FileSystemDirectoryHandleLike {
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export type DatabaseOpener = () => Promise<IDBDatabase>;

export interface StoreLike<T> extends Readable<T> {
  set?(value: T): void;
}

export interface RequiredStore<T> extends Writable<T> {}

export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
