import type {
  TimelineCell,
  TimelineClip,
  TimelinePoint,
  TimelineStoredKey,
  TimelineTag,
  TimelineTickRange,
} from './timeline-models.js';

export interface TimelineKeyboardEventLike {
  key?: string;
  code?: string;
  repeat?: boolean;
  defaultPrevented?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  deltaY?: number;
  target?: EventTarget | null;
}

export interface TimelineModifierState {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  preserveExisting?: boolean;
}

export interface TickPixelTransform {
  pixelsPerTick: number;
  panTick: number;
  originPixel: number;
}

export interface TimelineBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TimelineThumbnailCellEntry extends TimelinePoint {
  cell: TimelineCell;
}

export interface TimelineThumbnailModel {
  empty: boolean;
  reference?: boolean;
  cells: TimelineThumbnailCellEntry[];
  bounds: TimelineBounds | null;
  truncated: boolean;
}

export interface TimelineExposureSegment extends TimelineTickRange {
  clipId: string;
  keyIndex: number;
  sourceTick: number;
  durationTicks: number;
  heldFromBeforeClip: boolean;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface TimelineFilmstripSample extends TimelineTickRange {
  index: number;
  projectTick: number;
  sourceTick: number;
  pixelWidth: number;
}

export interface TimelineCurveKey {
  frame: number;
  interpolation?: string;
  temporalEase?: unknown;
  [field: string]: unknown;
}

export type TimelineTagMarker = TimelineTag & {
  stackIndex: number;
  cluster?: boolean;
  customCount?: number;
  customIds?: string[];
  customValues?: string[];
};

export interface TimelineRowModel {
  id: string;
  type?: string;
  height?: number;
  keyFrames?: number[];
  visibilityKeyFrames?: number[];
  effectIntensityKeyFrames?: number[];
  maskOpacityKeyFrames?: number[];
  maskPositionKeyFrames?: number[];
  shapePathKeyFrames?: number[];
  maskPositionTrackEnabled?: boolean;
  visibilityTrackEnabled?: boolean;
  effectIntensityTrackEnabled?: boolean;
  maskOpacityTrackEnabled?: boolean;
  shapePathTrackEnabled?: boolean;
  [field: string]: unknown;
}

export interface TimelineFrameLike {
  layers?: unknown[];
}

export type TimelineClipWithKeys = TimelineClip & { frameKeys: TimelineStoredKey[] };
