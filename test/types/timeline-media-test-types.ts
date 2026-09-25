import assert from 'node:assert/strict';
import type { SaveTarget } from '../../src/lib/types/project-types.ts';
import type {
  MediaAsset,
  MediaKind,
  MediaResourceAsset,
  ProjectAssetRecord,
} from '../../src/lib/types/media-types.ts';
import type { EditorCell, EditorCellMap, EditorLayer } from '../../src/lib/types/editor-domain.ts';
import type {
  ClipTimelineSelection,
  ClipTimelineState,
  AudioTimelineClip,
  EffectTimelineClip,
  TimelineClip,
  TimelineStoredKey,
  TimelineTag,
  TimelineTrack,
  VideoTimelineClip,
  VisualTimelineClip,
  VisualTimelineTrack,
} from '../../src/lib/types/timeline-models.ts';

export type TestRun = () => void | Promise<void>;
export type TestValue = string | number | boolean | null | undefined | object;

export function errorStack(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

export function requireValue<T>(value: T | null | undefined, message = 'Expected a value'): T {
  assert.ok(value != null, message);
  return value;
}

export function expectChanged<T extends { changed: boolean }>(result: T): Extract<T, { changed: true }> {
  assert.equal(result.changed, true);
  return result as Extract<T, { changed: true }>;
}

export function editorCell(c: string, fg = '#ffffff', bg: string | null = null): EditorCell {
  return { c, fg, bg };
}

export function visualTimelineTrack(
  overrides: Partial<VisualTimelineTrack> = {},
): VisualTimelineTrack {
  return {
    id: 'track',
    kind: 'visual',
    locked: false,
    ...overrides,
  };
}

export function visualTimelineClip(
  overrides: Partial<VisualTimelineClip> = {},
): VisualTimelineClip {
  const outTick = overrides.outTick ?? 1;
  return {
    id: 'clip',
    trackId: 'track',
    kind: 'visual',
    startTick: 0,
    inTick: 0,
    outTick,
    sourceDuration: Math.max(1, outTick),
    frameKeys: [],
    propertyTracks: {},
    ...overrides,
  };
}

export function audioTimelineClip(
  overrides: Partial<AudioTimelineClip> = {},
): AudioTimelineClip {
  return {
    id: 'audio-clip',
    trackId: 'audio-track',
    kind: 'audio',
    startTick: 0,
    inTick: 0,
    outTick: 1,
    sourceDuration: 1,
    frameKeys: [],
    propertyTracks: {},
    duration: 1,
    inPoint: 0,
    outPoint: 1,
    volume: 1,
    muted: false,
    ...overrides,
  };
}

export function videoTimelineClip(
  overrides: Partial<VideoTimelineClip> = {},
): VideoTimelineClip {
  return {
    id: 'video-clip',
    trackId: 'video-track',
    kind: 'video',
    startTick: 0,
    inTick: 0,
    outTick: 1,
    sourceDuration: 1,
    frameKeys: [],
    propertyTracks: {},
    ...overrides,
  };
}

export function effectTimelineClip(
  overrides: Partial<EffectTimelineClip> = {},
): EffectTimelineClip {
  return {
    id: 'effect-clip',
    trackId: 'effect-track',
    kind: 'effect',
    startTick: 0,
    inTick: 0,
    outTick: 1,
    sourceDuration: 1,
    frameKeys: [],
    propertyTracks: {},
    ...overrides,
  };
}

export function timelineTrack(
  id: string,
  kind: TimelineTrack['kind'] = 'visual',
  locked = false,
): TimelineTrack {
  switch (kind) {
    case 'group': return { id, kind: 'group', locked };
    case 'audio': return { id, kind: 'audio', locked };
    case 'video': return { id, kind: 'video', locked };
    case 'media': return { id, kind: 'media', locked };
    case 'effect': return { id, kind: 'effect', locked };
    default: return { id, kind: 'visual', locked };
  }
}

export function clipTimelineState(overrides: {
  tracks?: TimelineTrack[];
  clips?: TimelineClip[];
  tags?: TimelineTag[];
  fps?: number;
  tickDuration?: number;
} = {}): ClipTimelineState {
  return {
    tracks: overrides.tracks ?? [],
    clips: overrides.clips ?? [],
    tags: overrides.tags ?? [],
    ...(overrides.fps === undefined ? {} : { fps: overrides.fps }),
    ...(overrides.tickDuration === undefined ? {} : { tickDuration: overrides.tickDuration }),
  };
}

export function clipTimelineSelection(overrides: {
  clipIds?: Iterable<string>;
  frameKeys?: ClipTimelineSelection['frameKeys'];
  propertyKeys?: ClipTimelineSelection['propertyKeys'];
  trackHeaderIds?: Iterable<string>;
  gap?: ClipTimelineSelection['gap'];
  rulerRange?: ClipTimelineSelection['rulerRange'];
} = {}): ClipTimelineSelection {
  return {
    clipIds: new Set(overrides.clipIds ?? []),
    frameKeys: overrides.frameKeys ?? [],
    propertyKeys: overrides.propertyKeys ?? [],
    trackHeaderIds: new Set(overrides.trackHeaderIds ?? []),
    gap: overrides.gap ?? null,
    rulerRange: overrides.rulerRange ?? null,
  };
}

export function namedFile(
  contents: BlobPart,
  type: string,
  name: string,
): File {
  return new File([contents], name, { type });
}

export class TestAudioBuffer implements AudioBuffer {
  readonly duration: number;
  readonly length: number;
  readonly numberOfChannels = 1;
  readonly numberOfFrames: number;
  readonly sampleRate = 48_000;
  private readonly samples: Float32Array<ArrayBuffer>;

  constructor(duration: number, value = 0.125) {
    this.duration = duration;
    this.samples = new Float32Array(Math.round(duration * this.sampleRate)).fill(value);
    this.length = this.samples.length;
    this.numberOfFrames = this.samples.length;
  }

  copyFromChannel(
    destination: Float32Array<ArrayBuffer>,
    _channelNumber: number,
    startInChannel = 0,
  ): void {
    destination.set(this.samples.subarray(startInChannel, startInChannel + destination.length));
  }

  copyToChannel(
    source: Float32Array<ArrayBuffer>,
    _channelNumber: number,
    startInChannel = 0,
  ): void {
    this.samples.set(source, startInChannel);
  }

  getChannelData(_channel: number): Float32Array<ArrayBuffer> {
    return this.samples;
  }
}

export function audioBuffer(duration: number, value = 0.125): TestAudioBuffer {
  return new TestAudioBuffer(duration, value);
}

export function saveTarget(
  write: SaveTarget['write'] = async () => {},
  name = 'test-output',
  durable = true,
): SaveTarget {
  return { name, durable, write };
}

export function canvasElement(
  context: CanvasRenderingContext2D = Object.create(null) as CanvasRenderingContext2D,
): HTMLCanvasElement {
  const canvas = Object.assign(Object.create(null) as HTMLCanvasElement, {
    width: 0,
    height: 0,
  });
  Object.defineProperty(canvas, 'getContext', {
    configurable: true,
    value: (contextId: string) => contextId === '2d' ? context : null,
  });
  return canvas;
}

export function mediaResourceAsset(
  assetId: string,
  hash: string,
  kind: MediaKind = 'image',
): MediaResourceAsset {
  return { assetId, hash, kind };
}

export function projectAssetRecord(
  hash: string,
  createdAt: number,
  lastAccessedAt: number,
): ProjectAssetRecord {
  return {
    hash,
    blob: new Blob(),
    size: 0,
    mime: 'application/octet-stream',
    createdAt,
    lastAccessedAt,
  };
}

export type {
  ClipTimelineState,
  ClipTimelineSelection,
  AudioTimelineClip,
  EffectTimelineClip,
  EditorCell,
  EditorCellMap,
  EditorLayer,
  MediaAsset,
  MediaKind,
  MediaResourceAsset,
  ProjectAssetRecord,
  SaveTarget,
  TimelineClip,
  TimelineStoredKey,
  TimelineTag,
  TimelineTrack,
  VideoTimelineClip,
  VisualTimelineClip,
  VisualTimelineTrack,
};
