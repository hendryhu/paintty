import type {
  EditorBounds,
  EditorCell,
  EditorCellMap,
  EditorEffect,
  EditorEffectMask,
  EditorLayer,
  EditorPoint,
  EditorShape,
  EditorVideoClip,
} from './editor-domain.js';

export type TimelineId = string;
declare const timelineExtensionKind: unique symbol;
export type KnownTimelineTrackKind = 'visual' | 'group' | 'audio' | 'video' | 'media' | 'effect';
export type KnownTimelineClipKind = Exclude<KnownTimelineTrackKind, 'group'> | 'clip';
export type TimelineExtensionKind = string & { readonly [timelineExtensionKind]: true };
export type TimelineTrackKind = KnownTimelineTrackKind | TimelineExtensionKind;
export type TimelineClipKind = KnownTimelineClipKind | TimelineExtensionKind;
export type TimelinePropertyName = string;
export type TimelineEdge = 'start' | 'end';
export type TimelineEdgeInput = TimelineEdge | 'in' | 'out';

export type TimelinePoint = EditorPoint;
export type TimelineCell = EditorCell;
export type TimelineCellMap = EditorCellMap;
export type TimelineTextBox = EditorBounds;
export type TimelineShape = EditorShape;
export type TimelineEffect = EditorEffect;
export type TimelineMask = EditorEffectMask;
export type TimelineVideoSource = EditorVideoClip;
export type TimelineLayer = EditorLayer;

export interface TimelineTemporalHandle {
  time: number;
  value: number;
}

export type TimelineInterpolation = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
export type TimelineTemporalSide = 'in' | 'out';

export interface TimelineTemporalEase {
  in?: TimelineTemporalHandle;
  out?: TimelineTemporalHandle;
}

export interface TimelineKeyValue {
  interpolation?: TimelineInterpolation;
  temporalEase?: TimelineTemporalEase;
  [field: string]: unknown;
}

export interface TimelineStoredKey<T = unknown> {
  tick: number;
  value?: T;
  [field: string]: unknown;
}

export type TimelinePropertyTracks = Record<string, TimelineStoredKey[]>;

interface TimelineTrackBase {
  id: TimelineId;
  name?: string;
  locked: boolean;
  layer?: TimelineLayer;
  parentTrackId?: string;
  sourceLayerId?: string;
  stackIndex?: number;
  propertyTracks?: TimelinePropertyTracks;
  shapePathKind?: string | null;
  shapePathComponents?: string[];
  [field: string]: unknown;
}

export interface VisualTimelineTrack extends TimelineTrackBase {
  kind: 'visual';
}

export interface GroupTimelineTrack extends TimelineTrackBase {
  kind: 'group';
  propertyTracks?: TimelinePropertyTracks;
}

export interface AudioTimelineTrack extends TimelineTrackBase {
  kind: 'audio';
}

export interface VideoTimelineTrack extends TimelineTrackBase {
  kind: 'video';
}

export interface MediaTimelineTrack extends TimelineTrackBase {
  kind: 'media';
}

export interface EffectTimelineTrack extends TimelineTrackBase {
  kind: 'effect';
}

export interface ExtensionTimelineTrack extends TimelineTrackBase {
  kind: TimelineExtensionKind;
}

export type TimelineTrack =
  | VisualTimelineTrack
  | GroupTimelineTrack
  | AudioTimelineTrack
  | VideoTimelineTrack
  | MediaTimelineTrack
  | EffectTimelineTrack
  | ExtensionTimelineTrack;

interface TimelineClipBase {
  id: TimelineId;
  trackId: TimelineId;
  startTick: number;
  inTick: number;
  outTick: number;
  sourceDuration: number;
  frameKeys: TimelineStoredKey[];
  propertyTracks: TimelinePropertyTracks;
  [field: string]: unknown;
}

export interface VisualTimelineClip extends TimelineClipBase {
  kind: 'visual';
}

export interface VideoTimelineClip extends TimelineClipBase {
  kind: 'video';
  assetId?: unknown;
  sourceName?: unknown;
  inPoint?: unknown;
  outPoint?: unknown;
  playbackRate?: unknown;
  duration?: unknown;
  width?: unknown;
  height?: unknown;
}

export interface EffectTimelineClip extends TimelineClipBase {
  kind: 'effect';
}

export interface AudioTimelineClip extends TimelineClipBase {
  kind: 'audio';
  assetId?: unknown;
  duration: number;
  inPoint: number;
  outPoint: number;
  volume: number;
  muted: boolean;
  frameKeys: TimelineStoredKey[];
  propertyTracks: TimelinePropertyTracks;
}

export interface MediaTimelineClip extends TimelineClipBase {
  kind: 'media';
}

export interface GenericTimelineClip extends TimelineClipBase {
  kind: 'clip';
}

export interface ExtensionTimelineClip extends TimelineClipBase {
  kind: TimelineExtensionKind;
}

export type TimelineClip =
  | VisualTimelineClip
  | VideoTimelineClip
  | EffectTimelineClip
  | AudioTimelineClip
  | MediaTimelineClip
  | GenericTimelineClip
  | ExtensionTimelineClip;

export interface TimelineClipGeometry {
  id: string;
  trackId: string;
  kind: string;
  startTick: number;
  inTick: number;
  outTick: number;
  frameKeys?: TimelineStoredKey[];
}

export interface TimelineClipTiming {
  startTick: number;
  inTick: number;
  outTick: number;
}

export interface ClipTimelineState {
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  tags: TimelineTag[];
  fps?: number;
  tickDuration?: number;
  [field: string]: unknown;
}

export interface TimelineTrackDefinition {
  id?: unknown;
  kind?: unknown;
  type?: unknown;
  locked?: unknown;
  clips?: TimelineClipDefinition[];
  layer?: TimelineLayer;
  propertyTracks?: unknown;
  [field: string]: unknown;
}

export interface TimelineClipDefinition {
  id?: unknown;
  trackId?: unknown;
  kind?: unknown;
  startTick?: unknown;
  startFrame?: unknown;
  inTick?: unknown;
  outTick?: unknown;
  sourceDuration?: unknown;
  frameKeys?: unknown;
  propertyTracks?: unknown;
  assetId?: unknown;
  duration?: unknown;
  inPoint?: unknown;
  outPoint?: unknown;
  volume?: unknown;
  muted?: unknown;
  playbackRate?: unknown;
  [field: string]: unknown;
}

export interface ClipTimelineStateDefinition {
  tracks?: TimelineTrackDefinition[];
  clips?: TimelineClipDefinition[];
  tags?: unknown;
  fps?: unknown;
  tickDuration?: unknown;
  [field: string]: unknown;
}

export type TimelineOperationResult<TDetails extends object = Record<string, never>> =
  | ({ state: ClipTimelineState; changed: true } & TDetails)
  | ({ state: ClipTimelineState; changed: false; reason: string } & Partial<TDetails>);

interface TimelineTagBase {
  id: string;
  tick: number;
}

export interface LoopStartTimelineTag extends TimelineTagBase {
  type: 'loop-start';
}

export interface LoopEndTimelineTag extends TimelineTagBase {
  type: 'loop-end';
}

export interface CustomTimelineTag extends TimelineTagBase {
  type: 'custom';
  value: string;
}

export type TimelineTag = LoopStartTimelineTag | LoopEndTimelineTag | CustomTimelineTag;
export type RuntimeTimelineTag =
  | { tick: number; type: 'loop-start' }
  | { tick: number; type: 'loop-end' }
  | { tick: number; type: 'custom'; value: string };
export type TimelineTagType = TimelineTag['type'];

export interface TimelineFrameKeyReference {
  kind: 'frame';
  clipId: string;
  sourceTick: number;
}

export interface TimelinePropertyKeyReference {
  kind: 'property';
  clipId: string;
  propertyName: string;
  sourceTick: number;
}

export type TimelineKeyReference = TimelineFrameKeyReference | TimelinePropertyKeyReference;

export interface TimelineFrameSelectionKey {
  clipId: string;
  sourceTick: number;
}

export interface TimelinePropertySelectionKey extends TimelineFrameSelectionKey {
  propertyName: string;
}

export interface TimelineTickRange {
  startTick: number;
  endTick: number;
}

export interface TimelineGapSelection extends TimelineTickRange {
  trackIds: string[];
}

export interface ClipTimelineSelection {
  clipIds: Set<string>;
  frameKeys: TimelineFrameSelectionKey[];
  propertyKeys: TimelinePropertySelectionKey[];
  trackHeaderIds: Set<string>;
  gap: TimelineGapSelection | null;
  rulerRange: TimelineTickRange | null;
}

export type TimelineSelectionFocus =
  | { kind: 'none' }
  | { kind: 'clips'; clipIds: string[] }
  | { kind: 'keys'; keys: TimelineKeyReference[] }
  | { kind: 'gap'; range: TimelineGapSelection }
  | { kind: 'track-headers'; trackIds: string[] }
  | { kind: 'ruler-range'; range: TimelineTickRange };

export type TimelineSnapTarget =
  | { kind: 'playhead'; tick: number }
  | { kind: 'clip-start'; tick: number; clipId: string; trackId: string }
  | { kind: 'clip-end'; tick: number; clipId: string; trackId: string }
  | {
    kind: 'frame-key';
    tick: number;
    clipId: string;
    trackId: string;
    sourceTick: number;
  };

export type TimelinePointerIntent =
  | { kind: 'none' }
  | { kind: 'seek'; tick: number }
  | { kind: 'tag'; tick: number }
  | { kind: 'razor'; tick: number };

export interface TimelineFrameKeyMove {
  kind: 'frame';
  clipId: string;
  sourceTick: number;
  destinationSourceTick: number;
  projectTick: number;
  destinationProjectTick: number;
}

export interface TimelinePropertyKeyMove {
  kind: 'property';
  clipId: string;
  propertyName: string;
  sourceTick: number;
  destinationSourceTick: number;
  projectTick: number;
  destinationProjectTick: number;
}

export type TimelineKeyMove = TimelineFrameKeyMove | TimelinePropertyKeyMove;

export type TimelineKeyMotionPlan =
  | {
    valid: false;
    changed: false;
    reason: 'missing-or-locked-key' | 'missing-key-selection' | 'key-collision';
    deltaTicks: number;
    moves: TimelineKeyMove[];
  }
  | {
    valid: true;
    changed: boolean;
    reason: 'unchanged' | null;
    requestedDeltaTicks: number;
    deltaTicks: number;
    moves: TimelineKeyMove[];
    selection: ClipTimelineSelection;
  };

export type TimelineIdSource = string | number | Iterable<unknown> | null | undefined;
export type TimelineIdFactory = (kind: string) => unknown;
