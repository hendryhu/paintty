import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import {
  DEFAULT_AUDIO_FPS,
  MIN_AUDIO_CLIP_SECONDS,
  audioClipDurationTicks,
  audioAssets as projectAudioAssets,
  audioClips as projectAudioClips,
  createAudioController,
  createAudioTrack as createProjectAudioTrack,
  loadAudioState as loadProjectAudioState,
  normalizeAudioClip,
  removeAudioClip,
  resetAudioState,
  updateAudioClip as updateProjectAudioClip,
  updateAudioTrack as updateProjectAudioTrack,
} from '../src/lib/audio.ts';
import {
  deterministicUuid,
  deterministicUuidGenerator as createStableAudioIdGenerator,
} from './projectFixture.ts';
import {
  audibleTimelineAudioAssetIds,
  ANIMATION_AUDIO_PEAK_MAX_BYTES,
  createTimelineAudioPlan,
  encodePcmWav,
  encodeTimelineWav,
  estimateAnimationAudioExportResources,
  mixTimelineAudio,
  validateDecodedAnimationAudioExportResources,
  WAV_EXPORT_MAX_BYTES,
} from '../src/lib/audioExport.ts';
import {
  closeAudioPreview,
  planAudioPreviewClip,
  startAudioPreview,
} from '../src/lib/audioPlayback.ts';
import {
  fps as projectFps,
  initTimeline,
  moveClip,
  razorClip,
  trimClip,
} from '../src/lib/frames.ts';
import {
  authoredRevision,
  beginStroke,
  endStroke,
  noteAuthoredMutation,
  redo,
  undo,
} from '../src/lib/grid.ts';
import {
  createCanonicalClipTimelineController,
  getClipTimelineState,
} from '../src/lib/clipTimelineState.ts';
import { validLoopRange } from '../src/lib/timelineTags.ts';
import {
  errorStack,
  namedFile,
  requireValue,
  TestAudioBuffer,
  type TestRun,
} from './types/timeline-media-test-types.ts';

Object.defineProperty(globalThis, 'AudioBuffer', {
  configurable: true,
  value: TestAudioBuffer,
});

let passed = 0;
let failed = 0;

async function test(name: string, run: TestRun): Promise<void> {
  try {
    await run();
    passed++;
  } catch (error) {
    failed++;
    console.error('FAIL ' + name, errorStack(error));
  }
}

function source(name = 'voice.ogg', duration = 4) {
  const blob = namedFile(new Uint8Array([1, 2, 3, 4]), 'audio/ogg', name);
  return { blob, buffer: new TestAudioBuffer(duration), duration };
}

class PcmAudioBuffer implements AudioBuffer {
  readonly duration: number;
  readonly length: number;
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly sampleRate: number;
  private readonly data: Array<Float32Array<ArrayBuffer>>;

  constructor(channels: number[][], sampleRate = 48_000) {
    this.data = channels.map((channel) => Float32Array.from(channel));
    this.length = this.data[0]?.length ?? 0;
    assert.equal(this.data.every((channel) => channel.length === this.length), true);
    this.duration = this.length / sampleRate;
    this.numberOfFrames = this.length;
    this.numberOfChannels = this.data.length;
    this.sampleRate = sampleRate;
  }

  copyFromChannel(
    destination: Float32Array<ArrayBuffer>,
    channelNumber: number,
    startInChannel = 0,
  ): void {
    const source = requireValue(this.data[channelNumber]);
    destination.set(source.subarray(startInChannel, startInChannel + destination.length));
  }

  copyToChannel(
    source: Float32Array<ArrayBuffer>,
    channelNumber: number,
    startInChannel = 0,
  ): void {
    requireValue(this.data[channelNumber]).set(source, startInChannel);
  }

  getChannelData(channel: number): Float32Array<ArrayBuffer> {
    return requireValue(this.data[channel]);
  }
}

function pcmBuffer(channels: number[][], sampleRate = 48_000): PcmAudioBuffer {
  return new PcmAudioBuffer(channels, sampleRate);
}

function wavView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

await test('clip timing, volume, and mute normalize to safe values', () => {
  assert.deepEqual(normalizeAudioClip({
    id: 'clip',
    startTick: '2.6',
    inPoint: 0.5,
    duration: 4,
    volume: 9,
    muted: 1,
  }), {
    id: 'clip',
    startTick: 3,
    inPoint: 0.5,
    outPoint: 4,
    volume: 1,
    muted: true,
    duration: 4,
  });

  const malformed = normalizeAudioClip({
    startTick: -8,
    startFrame: 99,
    inPoint: 99,
    outPoint: -2,
    volume: -3,
    duration: 2,
  });
  assert.equal(malformed.startTick, 0);
  assert.equal('startFrame' in malformed, false);
  assert.equal(malformed.volume, 0);
  assert.equal(malformed.muted, false);
  assert.equal(malformed.outPoint, 2);
  assert.ok(Math.abs(malformed.outPoint - malformed.inPoint - MIN_AUDIO_CLIP_SECONDS) < 1e-12);
});

await test('visible clip duration rounds source seconds up to project ticks', () => {
  assert.equal(DEFAULT_AUDIO_FPS, 24);
  assert.equal(audioClipDurationTicks({ duration: 1, inPoint: 0.1, outPoint: 0.3 }), 5);
  assert.equal(audioClipDurationTicks({ duration: 1, inPoint: 0.1, outPoint: 0.3 }, 10), 2);
  assert.equal(audioClipDurationTicks({
    duration: 1,
    inPoint: 0.3333333333333333,
    outPoint: 0.43333333333333335,
  }, 10), 1);
});

await test('one import creates stable asset, track, and clip state', () => {
  const audio = createAudioController({
    idGenerator: createStableAudioIdGenerator(),
  });
  const firstSource = source('voice.ogg', 3.5);
  const first = requireValue(audio.createAudioTrack(firstSource, 7));
  const second = requireValue(audio.createAudioTrack(source('music.wav', 8), 0));
  const firstTrack = requireValue(first.track);
  const firstClip = requireValue(first.clip);
  const secondTrack = requireValue(second.track);
  const secondClip = requireValue(second.clip);

  assert.deepEqual([
    first.asset.id,
    firstTrack.id,
    firstClip.id,
    second.asset.id,
    secondTrack.id,
    secondClip.id,
  ], [
    deterministicUuid('asset', 1),
    deterministicUuid('track', 1),
    deterministicUuid('clip', 1),
    deterministicUuid('asset', 2),
    deterministicUuid('track', 2),
    deterministicUuid('clip', 2),
  ]);
  assert.equal(Object.isFrozen(first.asset), true);
  assert.equal(first.asset.blob, firstSource.blob);
  assert.equal(first.asset.buffer, firstSource.buffer);
  assert.equal(firstClip.startTick, 7);
  assert.equal(firstClip.outPoint, 3.5);
  assert.equal(get(audio.audioAssets).length, 2);
  assert.equal(get(audio.audioTracks).length, 2);
  assert.equal(get(audio.audioClips).length, 2);
});

await test('injected canonical controllers preserve visual state without duplicate timelines', () => {
  const canonical = createCanonicalClipTimelineController({
    initialState: {
      fps: 12,
      tracks: [{
        id: 'visual', kind: 'visual',
        layer: { id: 'layer', name: 'Layer', type: 'cell', visible: true, cells: {} },
      }],
      clips: [{
        id: 'visual-clip', trackId: 'visual', kind: 'visual', startTick: 0,
        inTick: 0, outTick: 1, sourceDuration: 1,
        frameKeys: [{ tick: 0, value: { cells: {} } }],
      }],
    },
  });
  const audioOptions: Parameters<typeof createAudioController>[0] = {};
  Object.defineProperty(audioOptions, 'canonicalController', { value: canonical });
  const audio = createAudioController(audioOptions);
  const created = requireValue(audio.createAudioTrack(source('shared.wav', 1), 2));

  assert.equal(audio.canonicalController, canonical);
  assert.deepEqual(canonical.getState().tracks.map((track) => track.kind), ['visual', 'audio']);
  assert.equal(requireValue(canonical.getState().clips.find(
    (clip) => clip.id === requireValue(created.clip).id,
  )).assetId, created.asset.id);
  assert.deepEqual(get(audio.audioTracks).map((track) => track.id), [requireValue(created.track).id]);
});

await test('split uses exact project-tick boundaries and preserves continuous source time', () => {
  const audio = createAudioController();
  const created = requireValue(audio.createAudioTrack(source('held.wav', 5), 0, {
    inPoint: 0.5,
    outPoint: 4,
    volume: 0.35,
    muted: true,
  }));
  const split = requireValue(audio.splitAudioClipAtTick(
    requireValue(created.track).id,
    requireValue(created.clip).id,
    3,
    4,
  ));
  const left = requireValue(split.left);
  const right = requireValue(split.right);

  assert.ok(split);
  assert.equal(left.outPoint, 1.25);
  assert.equal(right.inPoint, left.outPoint);
  assert.equal(right.startTick, 3);
  assert.equal(left.assetId, right.assetId);
  assert.equal(left.volume, 0.35);
  assert.equal(right.volume, 0.35);
  assert.equal(left.muted, true);
  assert.equal(right.muted, true);
  assert.equal(get(audio.audioClips).length, 2);
  assert.equal(audio.splitAudioClipAtTick(
    requireValue(created.track).id,
    right.id,
    3,
    4,
  ), null);
});

await test('clip gain and mute updates remain normalized', () => {
  const audio = createAudioController();
  const { track: maybeTrack, clip: maybeClip } = requireValue(audio.createAudioTrack(source(), 0));
  const track = requireValue(maybeTrack);
  const clip = requireValue(maybeClip);
  const quiet = requireValue(audio.updateAudioClip(track.id, clip.id, { volume: 0.2, muted: true }));
  const clamped = requireValue(audio.updateAudioClip(track.id, clip.id, { volume: 2, muted: false }));

  assert.deepEqual(
    [quiet.volume, quiet.muted, clamped.volume, clamped.muted],
    [0.2, true, 1, false],
  );
});

await test('loaded track volume clamps for save and export while mute survives', () => {
  const audio = createAudioController();
  const highBuffer = pcmBuffer([[0.25, 0.25, 0.25, 0.25]]);
  const lowBuffer = pcmBuffer([[0.5, 0.5, 0.5, 0.5]]);
  const highBlob = new Blob([new Uint8Array([1])], { type: 'audio/wav' });
  const lowBlob = new Blob([new Uint8Array([2])], { type: 'audio/wav' });
  audio.loadAudioState({
    assets: [
      { id: 'high-asset', duration: highBuffer.duration, sourceName: 'high.wav' },
      { id: 'low-asset', duration: lowBuffer.duration, sourceName: 'low.wav' },
    ],
    tracks: [{
      id: 'high-track', name: 'High', volume: 2, muted: false,
      clips: [{
        id: 'high-clip', assetId: 'high-asset', startTick: 0,
        inPoint: 0, outPoint: highBuffer.duration, volume: 1,
      }],
    }, {
      id: 'low-track', name: 'Low', volume: -3, muted: true,
      clips: [{
        id: 'low-clip', assetId: 'low-asset', startTick: 0,
        inPoint: 0, outPoint: lowBuffer.duration, volume: 1,
      }],
    }],
  }, new Map([
    ['high-asset', { blob: highBlob, buffer: highBuffer }],
    ['low-asset', { blob: lowBlob, buffer: lowBuffer }],
  ]));

  const loadedTracks = get(audio.audioTracks);
  assert.deepEqual(loadedTracks.map((track) => [track.volume, track.muted]), [
    [1, false],
    [0, true],
  ]);
  assert.deepEqual(audio.audioStateForSave().tracks.map((track) => [track.volume, track.muted]), [
    [1, undefined],
    [0, true],
  ]);
  const plan = requireValue(createTimelineAudioPlan({
    assets: get(audio.audioAssets),
    tracks: loadedTracks,
    clips: get(audio.audioClips),
    durationTicks: 4,
    fps: 48_000,
    exactDuration: true,
  }));
  assert.equal(plan.clips.length, 1);
  assert.equal(requireValue(plan.clips[0]).assetId, 'high-asset');
  assert.equal(requireValue(plan.clips[0]).gain, 1);
});

await test('canonical visual clip edits never remap project-tick audio', () => {
  resetAudioState();
  projectFps.set(12);
  initTimeline([{
    id: 'visual', name: 'Visual', type: 'cell', visible: true, cells: {},
  }]);
  const created = requireValue(createProjectAudioTrack(source('fixed.wav', 5), 7, {
    inPoint: 0.25,
  }));
  const visual = requireValue(getClipTimelineState().clips.find((clip) => clip.kind === 'visual'));
  const extended = trimClip(visual.id, 'end', 4);
  const split = razorClip(visual.id, 2);
  const right = split['right'];
  if (!right || typeof right !== 'object' || !('id' in right) || typeof right.id !== 'string') {
    throw new Error('Expected razor split to return a right clip.');
  }
  const moved = moveClip(right.id, 5);

  assert.deepEqual([extended.changed, split.changed, moved.changed], [true, true, true]);
  assert.equal(requireValue(get(projectAudioClips)[0]).startTick, 7);
  assert.equal(requireValue(get(projectAudioClips)[0]).inPoint, 0.25);
  assert.equal(requireValue(get(projectAudioClips)[0]).id, requireValue(created.clip).id);
  resetAudioState();
});

await test('serialization separates Blob bytes and omits all runtime fields', () => {
  const audio = createAudioController();
  const imported = source('serialize.ogg', 6);
  const created = requireValue(audio.createAudioTrack(imported, 3, { volume: 0.75 }));
  const serialized = audio.serializeAudioState();

  assert.deepEqual(serialized.assetIds, [created.asset.id]);
  assert.deepEqual([...serialized.blobs.keys()], [created.asset.id]);
  assert.equal(serialized.blobs.get(created.asset.id), imported.blob);
  assert.equal('blob' in requireValue(serialized.metadata.assets[0]), false);
  assert.equal('buffer' in requireValue(serialized.metadata.assets[0]), false);
  assert.equal(JSON.stringify(serialized.metadata).includes('buffer'), false);
  const serializedTrack = requireValue(serialized.metadata.tracks[0]);
  const serializedClip = requireValue(serializedTrack.clips?.[0]);
  assert.equal(serializedClip.assetId, created.asset.id);
  assert.equal(serializedClip.startTick, 3);
  assert.equal('startFrame' in serializedClip, false);

  const loaded = createAudioController();
  loaded.loadAudioState(serialized.metadata, serialized.blobs);
  assert.equal(requireValue(get(loaded.audioAssets)[0]).blob, imported.blob);
  assert.equal(requireValue(get(loaded.audioAssets)[0]).buffer, null);
  assert.deepEqual(loaded.audioStateForSave(), serialized.metadata);

  const decoded = createAudioController();
  decoded.loadAudioState(serialized.metadata, new Map([[
    created.asset.id,
    { blob: imported.blob, buffer: imported.buffer },
  ]]));
  assert.equal(requireValue(get(decoded.audioAssets)[0]).buffer, imported.buffer);

});

await test('history capture and restore share immutable media but isolate edit metadata', () => {
  const audio = createAudioController();
  const capturedTrack = requireValue(audio.createAudioTrack(source(), 2));
  const asset = capturedTrack.asset;
  const track = requireValue(capturedTrack.track);
  const clip = requireValue(capturedTrack.clip);
  const captured = audio.captureAudioState();
  audio.updateAudioClip(track.id, clip.id, { startTick: 9, volume: 0.1 });
  audio.restoreAudioState(captured);

  const restored = audio.captureAudioState();
  assert.equal(restored.assets[0], asset);
  assert.equal(requireValue(restored.clips[0]).startTick, 2);
  assert.equal(requireValue(restored.clips[0]).volume, 1);
  assert.notEqual(restored.clips[0], captured.clips[0]);
});

await test('default audio placement Undo and Redo retain runtime media outside canonical history', () => {
  resetAudioState();
  projectFps.set(10);
  initTimeline([]);
  const revisionBeforeImport = get(authoredRevision);
  beginStroke();
  const created = requireValue(createProjectAudioTrack(source('history.wav', 2), 3, {
    inPoint: 0.25,
    outPoint: 1.25,
  }));
  const createdClipId = requireValue(created.clip).id;
  const createdBuffer = created.asset.buffer;
  noteAuthoredMutation();
  assert.equal(endStroke(), true);
  assert.equal(get(authoredRevision), revisionBeforeImport + 1);
  assert.equal(requireValue(get(projectAudioClips)[0]).startTick, 3);
  assert.equal(JSON.stringify(getClipTimelineState()).includes('buffer'), false);

  undo();
  assert.equal(get(projectAudioClips).length, 0);
  redo();
  assert.equal(requireValue(get(projectAudioClips)[0]).id, createdClipId);
  assert.equal(requireValue(get(projectAudioAssets)[0]).buffer, createdBuffer);

  const revisionBeforeMove = get(authoredRevision);
  beginStroke();
  const moved = requireValue(get(projectAudioClips)[0]);
  const updated = updateProjectAudioClip(
    moved.trackId,
    moved.id,
    { startTick: 7 },
  );
  assert.equal(requireValue(updated).startTick, 7);
  noteAuthoredMutation();
  assert.equal(endStroke(), true);
  assert.equal(get(authoredRevision), revisionBeforeMove + 1);
  undo();
  assert.equal(requireValue(get(projectAudioClips)[0]).startTick, 3);
  redo();
  assert.equal(requireValue(get(projectAudioClips)[0]).startTick, 7);

  beginStroke();
  const current = requireValue(get(projectAudioClips)[0]);
  assert.ok(removeAudioClip(current.trackId, current.id));
  noteAuthoredMutation();
  assert.equal(endStroke(), true);
  assert.equal(get(projectAudioClips).length, 0);
  undo();
  assert.equal(requireValue(get(projectAudioClips)[0]).id, createdClipId);
  assert.equal(requireValue(get(projectAudioAssets)[0]).buffer, createdBuffer);
  redo();
  assert.equal(get(projectAudioClips).length, 0);
  resetAudioState();
});

await test('export audio planning uses absolute ticks and lets clips extend duration', () => {
  const readyBuffer = { duration: 2 };
  const plan = requireValue(createTimelineAudioPlan({
    assets: [
      { id: 'ready', buffer: readyBuffer },
      { id: 'not-decoded', buffer: null },
    ],
    tracks: [
      { id: 'audible', gain: 0.5 },
      { id: 'muted-track', muted: true },
    ],
    clips: [
      {
        id: 'kept', trackId: 'audible', assetId: 'ready', startTick: 1,
        inPoint: 0.25, outPoint: 1, volume: 0.4,
      },
      { id: 'muted', trackId: 'audible', assetId: 'ready', muted: true, outPoint: 1 },
      { id: 'muted-parent', trackId: 'muted-track', assetId: 'ready', outPoint: 1 },
      { id: 'missing-track', trackId: 'gone', assetId: 'ready', outPoint: 1 },
      { id: 'missing-asset', trackId: 'audible', assetId: 'gone', outPoint: 1 },
      { id: 'not-ready', trackId: 'audible', assetId: 'not-decoded', outPoint: 1 },
    ],
    durationTicks: 6,
    fps: 12,
  }));
  const plannedClip = requireValue(plan.clips[0]);

  assert.equal(plan.sampleRate, 48_000);
  assert.equal(plan.numberOfChannels, 2);
  assert.equal(plan.numberOfFrames, 40_000);
  assert.equal(plan.duration, 5 / 6);
  assert.equal(plan.totalTicks, 10);
  assert.equal(plan.clips.length, 1);
  assert.deepEqual({
    id: plannedClip.id,
    buffer: plannedClip.buffer,
    gain: plannedClip.gain,
    inPoint: plannedClip.inPoint,
    outPoint: plannedClip.outPoint,
    startTick: plannedClip.startTick,
    startSample: plannedClip.startSample,
    startTime: plannedClip.startTime,
    duration: plannedClip.duration,
  }, {
    id: 'kept',
    buffer: readyBuffer,
    gain: 0.2,
    inPoint: 0.25,
    outPoint: 1,
    startTick: 1,
    startSample: 4_000,
    startTime: 1 / 12,
    duration: 0.75,
  });
});

await test('preview uses normalized loaded track volume', async () => {
  resetAudioState();
  const buffer = pcmBuffer([[0.25, 0.25, 0.25, 0.25]]);
  const blob = new Blob([new Uint8Array([1])], { type: 'audio/wav' });
  const load = (volume: number) => loadProjectAudioState({
    assets: [{ id: 'preview-asset', duration: buffer.duration, sourceName: 'preview.wav' }],
    tracks: [{
      id: 'preview-track', name: 'Preview', volume,
      clips: [{
        id: 'preview-clip', assetId: 'preview-asset', startTick: 0,
        inPoint: 0, outPoint: buffer.duration, volume: 0.5,
      }],
    }],
  }, new Map([['preview-asset', { blob, buffer }]]));
  const originalAudioContext = globalThis.AudioContext;

  class AudioContextDouble {
    static instance: AudioContextDouble | null = null;
    readonly state: AudioContextState = 'running';
    readonly currentTime = 1;
    readonly destination = Object.create(null) as AudioDestinationNode;
    readonly sources: Array<{
      started: number[] | undefined;
      connect(target: unknown): unknown;
      start(...args: number[]): void;
      stop(): void;
      disconnect(): void;
    }> = [];
    readonly gains: Array<{
      gain: { value: number };
      connect(target: unknown): unknown;
      disconnect(): void;
    }> = [];

    constructor() {
      AudioContextDouble.instance = this;
    }

    createBufferSource() {
      const node = {
        started: undefined as number[] | undefined,
        connect(target: unknown) { return target; },
        start(...args: number[]) { node.started = args; },
        stop() {},
        disconnect() {},
      };
      this.sources.push(node);
      return node;
    }

    createGain() {
      const node = {
        gain: { value: 1 },
        connect(target: unknown) { return target; },
        disconnect() {},
      };
      this.gains.push(node);
      return node;
    }

    async close() {}
  }

  try {
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: AudioContextDouble,
    });
    load(2);
    assert.equal(await startAudioPreview({ tick: 0, fps: 48_000 }), true);
    assert.equal(requireValue(AudioContextDouble.instance).sources.length, 1);
    assert.equal(requireValue(requireValue(AudioContextDouble.instance).gains[0]).gain.value, 0.5,
      'loaded volume 2 clamps to one before preview gain');
    load(-1);
    assert.equal(await startAudioPreview({ tick: 0, fps: 48_000 }), true);
    assert.equal(requireValue(AudioContextDouble.instance).sources.length, 1,
      'loaded negative volume clamps to zero and schedules no source');
  } finally {
    await closeAudioPreview();
    resetAudioState();
    if (originalAudioContext === undefined) Reflect.deleteProperty(globalThis, 'AudioContext');
    else Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: originalAudioContext,
    });
  }
});

await test('preview scheduling uses absolute project tick divided by FPS', async () => {
  resetAudioState();
  createProjectAudioTrack(source('preview.wav', 4), 5, {
    inPoint: 0.5,
    outPoint: 2,
  });
  const originalAudioContext = globalThis.AudioContext;

  class AudioContextDouble {
    static instances: AudioContextDouble[] = [];
    readonly state: AudioContextState = 'running';
    readonly currentTime = 4;
    readonly destination = { kind: 'destination' };
    readonly sources: Array<{
      starts: number[][];
      stops: number;
      connected?: unknown;
      connect(target: unknown): unknown;
      start(...args: number[]): void;
      stop(): void;
      disconnect(): void;
    }> = [];

    constructor() {
      AudioContextDouble.instances.push(this);
    }

    createBufferSource() {
      const node = {
        starts: [] as number[][],
        stops: 0,
        connected: undefined as unknown,
        connect(target: unknown) { node.connected = target; return target; },
        start(...args: number[]) { node.starts.push(args); },
        stop() { node.stops++; },
        disconnect() {},
      };
      this.sources.push(node);
      return node;
    }

    createGain() {
      return {
        gain: { value: 1 },
        connect(target: unknown) { return target; },
        disconnect() {},
      };
    }

    async close() {}
  }

  try {
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: AudioContextDouble,
    });
    assert.equal(await startAudioPreview({ tick: 3, fps: 10 }), true);
    const context = requireValue(AudioContextDouble.instances[0]);
    assert.equal(context.sources.length, 1);
    const firstStart = requireValue(requireValue(context.sources[0]).starts[0]);
    const when = requireValue(firstStart[0]);
    const offset = requireValue(firstStart[1]);
    const duration = requireValue(firstStart[2]);
    assert.ok(Math.abs(when - 4.23) < 1e-12);
    assert.equal(offset, 0.5);
    assert.equal(duration, 1.5);

    assert.equal(await startAudioPreview({ tick: 6, fps: 10 }), true);
    const resumedStart = requireValue(requireValue(context.sources[1]).starts[0]);
    const resumedWhen = requireValue(resumedStart[0]);
    const resumedOffset = requireValue(resumedStart[1]);
    const resumedDuration = requireValue(resumedStart[2]);
    assert.ok(Math.abs(resumedWhen - 4.03) < 1e-12);
    assert.ok(Math.abs(resumedOffset - 0.6) < 1e-12);
    assert.ok(Math.abs(resumedDuration - 1.4) < 1e-12);
    assert.equal(requireValue(context.sources[0]).stops, 1);

    assert.equal(await startAudioPreview({
      tick: 5,
      fps: 10,
      loopRange: { startTick: 5, endTick: 7 },
    }), true);
    const loopStart = requireValue(requireValue(context.sources[2]).starts[0]);
    const loopWhen = requireValue(loopStart[0]);
    const loopOffset = requireValue(loopStart[1]);
    const loopDuration = requireValue(loopStart[2]);
    assert.ok(Math.abs(loopWhen - 4.03) < 1e-12);
    assert.equal(loopOffset, 0.5);
    assert.ok(Math.abs(loopDuration - 0.3) < 1e-12);
    assert.equal(requireValue(context.sources[1]).stops, 1,
      'a multi-tick cycle restart stops the preceding source');

    assert.equal(await startAudioPreview({
      tick: 6,
      fps: 10,
      loopRange: { startTick: 6, endTick: 6 },
    }), true);
    const singleStart = requireValue(requireValue(context.sources[3]).starts[0]);
    const singleOffset = requireValue(singleStart[1]);
    const singleDuration = requireValue(singleStart[2]);
    assert.ok(Math.abs(singleOffset - 0.6) < 1e-12);
    assert.ok(Math.abs(singleDuration - 0.1) < 1e-12);
    assert.equal(requireValue(context.sources[2]).stops, 1);

    assert.equal(await startAudioPreview({
      tick: 6,
      fps: 10,
      loopRange: { startTick: 6, endTick: 6 },
    }), true);
    assert.equal(requireValue(context.sources[3]).stops, 1,
      'a same-tick cycle signal can restart an identically positioned source');
    assert.ok(Math.abs(requireValue(requireValue(requireValue(context.sources[4]).starts[0])[2]) - 0.1) < 1e-12);
  } finally {
    await closeAudioPreview();
    resetAudioState();
    if (originalAudioContext === undefined) Reflect.deleteProperty(globalThis, 'AudioContext');
    else Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: originalAudioContext,
    });
  }
});

await test('preview applies track and clip gain and either mute to overlapping clips', async () => {
  resetAudioState();
  const first = requireValue(createProjectAudioTrack(source('first.wav', 2), 0, {
    outPoint: 1,
    volume: 0.4,
  }));
  updateProjectAudioTrack(requireValue(first.track).id, { volume: 0.5 });
  const mutedTrack = requireValue(createProjectAudioTrack(source('muted-track.wav', 2), 0, {
    outPoint: 1,
    volume: 0.9,
  }));
  updateProjectAudioTrack(requireValue(mutedTrack.track).id, { muted: true, volume: 0.8 });
  const mutedClip = requireValue(createProjectAudioTrack(source('muted-clip.wav', 2), 0, {
    outPoint: 1,
    volume: 0.7,
    muted: true,
  }));
  updateProjectAudioTrack(requireValue(mutedClip.track).id, { volume: 0.6 });
  const overlap = requireValue(createProjectAudioTrack(source('overlap.wav', 2), 0, {
    outPoint: 1,
    volume: 0.8,
  }));
  updateProjectAudioTrack(requireValue(overlap.track).id, { volume: 0.75 });
  const originalAudioContext = globalThis.AudioContext;

  class AudioContextDouble {
    static instances: AudioContextDouble[] = [];
    readonly state: AudioContextState = 'running';
    readonly currentTime = 2;
    readonly destination = { kind: 'destination' };
    readonly sources: Array<{
      buffer: AudioBuffer | undefined;
      starts: number[][];
      connected?: unknown;
      connect(target: unknown): unknown;
      start(...args: number[]): void;
      stop(): void;
      disconnect(): void;
    }> = [];
    readonly gains: Array<{
      gain: { value: number };
      connected?: unknown;
      connect(target: unknown): unknown;
      disconnect(): void;
    }> = [];

    constructor() {
      AudioContextDouble.instances.push(this);
    }

    createBufferSource() {
      const node = {
        buffer: undefined as AudioBuffer | undefined,
        starts: [] as number[][],
        connected: undefined as unknown,
        connect(target: unknown) { node.connected = target; return target; },
        start(...args: number[]) { node.starts.push(args); },
        stop() {},
        disconnect() {},
      };
      this.sources.push(node);
      return node;
    }

    createGain() {
      const node = {
        gain: { value: 1 },
        connected: undefined as unknown,
        connect(target: unknown) { node.connected = target; return target; },
        disconnect() {},
      };
      this.gains.push(node);
      return node;
    }

    async close() {}
  }

  try {
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: AudioContextDouble,
    });
    assert.equal(await startAudioPreview({ tick: 0, fps: 10 }), true);
    const context = requireValue(AudioContextDouble.instances[0]);
    assert.equal(context.sources.length, 2);
    assert.equal(requireValue(context.sources[0]).buffer, first.asset.buffer);
    assert.equal(requireValue(context.sources[1]).buffer, overlap.asset.buffer);
    assert.deepEqual(context.sources.map((node) => node.starts[0]), [
      [2.03, 0, 1],
      [2.03, 0, 1],
    ]);
    assert.ok(Math.abs(requireValue(context.gains[0]).gain.value - 0.2) < 1e-12);
    assert.ok(Math.abs(requireValue(context.gains[1]).gain.value - 0.6) < 1e-12);
  } finally {
    await closeAudioPreview();
    resetAudioState();
    if (originalAudioContext === undefined) Reflect.deleteProperty(globalThis, 'AudioContext');
    else Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: originalAudioContext,
    });
  }
});

await test('loop preview plans cap current and future clips at the inclusive endpoint', () => {
  const clip = { startTick: 0, inPoint: 0.25, outPoint: 2 };
  const oneTick = requireValue(planAudioPreviewClip(clip, {
    tick: 3,
    fps: 10,
    loopRange: { startTick: 3, endTick: 3 },
  }));
  assert.equal(oneTick.delay, 0);
  assert.ok(Math.abs(oneTick.offset - 0.55) < 1e-12);
  assert.ok(Math.abs(oneTick.duration - 0.1) < 1e-12);

  const multiTick = requireValue(planAudioPreviewClip(clip, {
    tick: 2,
    fps: 10,
    loopRange: { startTick: 2, endTick: 4 },
  }));
  assert.ok(Math.abs(multiTick.offset - 0.45) < 1e-12);
  assert.ok(Math.abs(multiTick.duration - 0.3) < 1e-12);

  const future = requireValue(planAudioPreviewClip({ startTick: 4, inPoint: 0.5, outPoint: 2 }, {
    tick: 2,
    fps: 10,
    loopRange: { startTick: 2, endTick: 4 },
  }));
  assert.ok(Math.abs(future.delay - 0.2) < 1e-12);
  assert.equal(future.offset, 0.5);
  assert.ok(Math.abs(future.duration - 0.1) < 1e-12);

  const openEnded = requireValue(planAudioPreviewClip(clip, {
    tick: 4,
    fps: 10,
    loopRange: validLoopRange([{
      id: '10000000-0000-4000-8000-000000000001', type: 'loop-start', tick: 4,
    }], 8),
  }));
  assert.ok(Math.abs(openEnded.offset - 0.65) < 1e-12);
  assert.ok(Math.abs(openEnded.duration - 0.4) < 1e-12,
    'start-only loop normalization caps audio at the inclusive sequence end');

  const unbounded = requireValue(planAudioPreviewClip(clip, {
    tick: 2,
    fps: 10,
    loopRange: { startTick: 4, endTick: 2 },
  }));
  assert.ok(Math.abs(unbounded.duration - 1.55) < 1e-12,
    'reversed markers retain full-clip behavior');
  assert.ok(Math.abs(requireValue(planAudioPreviewClip(clip, {
    tick: 2,
    fps: 10,
    loopRange: null,
  })).duration - 1.55) < 1e-12, 'Loop off retains full-clip behavior');
  const partialRange = Object.assign(Object.create(null) as {
    startTick: number;
    endTick: number;
  }, { startTick: 4 });
  assert.ok(Math.abs(requireValue(planAudioPreviewClip(clip, {
    tick: 2,
    fps: 10,
    loopRange: partialRange,
  })).duration - 1.55) < 1e-12, 'an unnormalized partial range is ignored');
});

await test('offline export mixer schedules exact stereo duration and releases nodes', async () => {
  const sourceBuffer = new TestAudioBuffer(2);
  const plan = requireValue(createTimelineAudioPlan({
    assets: [{ id: 'ready', buffer: sourceBuffer }],
    tracks: [{ id: 'track', volume: 0.5 }],
    clips: [{
      id: 'clip', trackId: 'track', assetId: 'ready', startTick: 1,
      inPoint: 0.25, outPoint: 1, volume: 0.4,
    }],
    durationTicks: 6,
    fps: 12,
  }));
  const renderedChannels = [new Float32Array(plan.numberOfFrames), new Float32Array(plan.numberOfFrames)];

  class OfflineContextDouble {
    static instances: OfflineContextDouble[] = [];
    readonly options: OfflineAudioContextOptions;
    readonly destination = { kind: 'destination' };
    readonly sources: Array<{
      buffer: AudioBuffer | undefined;
      starts: number[][];
      stops: number;
      disconnects: number;
      connected?: unknown;
      connect(target: unknown): unknown;
      start(...args: number[]): void;
      stop(): void;
      disconnect(): void;
    }> = [];
    readonly gains: Array<{
      gain: { value: number };
      disconnects: number;
      connected?: unknown;
      connect(target: unknown): unknown;
      disconnect(): void;
    }> = [];

    constructor(options: OfflineAudioContextOptions) {
      this.options = options;
      OfflineContextDouble.instances.push(this);
    }

    createBufferSource() {
      const node = {
        buffer: undefined as AudioBuffer | undefined,
        starts: [] as number[][],
        stops: 0,
        disconnects: 0,
        connected: undefined as unknown,
        connect(target: unknown) { node.connected = target; return target; },
        start(...args: number[]) { node.starts.push(args); },
        stop() { node.stops++; },
        disconnect() { node.disconnects++; },
      };
      this.sources.push(node);
      return node;
    }

    createGain() {
      const node = {
        gain: { value: 1 },
        disconnects: 0,
        connected: undefined as unknown,
        connect(target: unknown) { node.connected = target; return target; },
        disconnect() { node.disconnects++; },
      };
      this.gains.push(node);
      return node;
    }

    async startRendering(): Promise<AudioBuffer> {
      return Object.assign(Object.create(null) as AudioBuffer, {
        duration: this.options.length / this.options.sampleRate,
        length: this.options.length,
        sampleRate: this.options.sampleRate,
        numberOfChannels: this.options.numberOfChannels,
        copyFromChannel(): void {},
        copyToChannel(): void {},
        getChannelData(channel: number) { return requireValue(renderedChannels[channel]); },
      });
    }
  }

  const mixDependencies: Parameters<typeof mixTimelineAudio>[1] = {};
  Object.defineProperty(mixDependencies, 'OfflineAudioContextClass', {
    value: OfflineContextDouble,
  });
  const pcm = requireValue(await mixTimelineAudio(plan, mixDependencies));
  const context = requireValue(OfflineContextDouble.instances[0]);
  assert.deepEqual(context.options, {
    numberOfChannels: 2,
    length: 40_000,
    sampleRate: 48_000,
  });
  const scheduledSource = requireValue(context.sources[0]);
  const scheduledGain = requireValue(context.gains[0]);
  assert.equal(scheduledSource.buffer, sourceBuffer);
  assert.deepEqual(scheduledSource.starts, [[1 / 12, 0.25, 0.75]]);
  assert.equal(scheduledSource.connected, scheduledGain);
  assert.equal(scheduledGain.gain.value, 0.2);
  assert.equal(scheduledGain.connected, context.destination);
  assert.equal(scheduledSource.stops, 1);
  assert.equal(scheduledSource.disconnects, 1);
  assert.equal(scheduledGain.disconnects, 1);
  assert.equal(pcm.numberOfFrames, 40_000);
  assert.equal(pcm.getChannelData(0), renderedChannels[0]);
  assert.equal(pcm.getChannelData(1), renderedChannels[1]);
});

await test('audible planning excludes muted, zero-gain, missing, and out-of-range usages', () => {
  const assets = [
    { id: 'kept', duration: 1 },
    { id: 'muted', duration: 1 },
    { id: 'zero', duration: 1 },
    { id: 'late', duration: 1 },
  ];
  const tracks = [
    { id: 'main', volume: 0.5 },
    { id: 'muted-track', muted: true },
    { id: 'zero-track', volume: 0 },
  ];
  const clips = [
    { trackId: 'main', assetId: 'kept', startTick: 0, inPoint: 0, outPoint: 1 },
    { trackId: 'main', assetId: 'muted', startTick: 0, inPoint: 0, outPoint: 1, muted: true },
    { trackId: 'zero-track', assetId: 'zero', startTick: 0, inPoint: 0, outPoint: 1 },
    { trackId: 'muted-track', assetId: 'muted', startTick: 0, inPoint: 0, outPoint: 1 },
    { trackId: 'main', assetId: 'late', startTick: 4, inPoint: 0, outPoint: 1 },
    { trackId: 'main', assetId: 'missing', startTick: 0, inPoint: 0, outPoint: 1 },
  ];
  assert.deepEqual([...audibleTimelineAudioAssetIds({
    assets,
    tracks,
    clips,
    durationTicks: 4,
  })], ['kept']);
});

await test('PCM fallback mixes mono and stereo overlap with trim, gain, and mute', async () => {
  const plan = requireValue(createTimelineAudioPlan({
    assets: [
      { id: 'mono', buffer: pcmBuffer([[1, 0.5, -0.5, 0]]) },
      { id: 'stereo', buffer: pcmBuffer([[0.25, 0.5, 0.75], [-0.25, -0.5, -0.75]]) },
      { id: 'muted', buffer: pcmBuffer([[1, 1, 1, 1]]) },
    ],
    tracks: [
      { id: 'mono-track', volume: 0.5 },
      { id: 'stereo-track', volume: 0.5 },
    ],
    clips: [
      {
        trackId: 'mono-track', assetId: 'mono', startTick: 0,
        inPoint: 1 / 48_000, outPoint: 4 / 48_000, volume: 0.5,
      },
      {
        trackId: 'stereo-track', assetId: 'stereo', startTick: 1,
        inPoint: 0, outPoint: 3 / 48_000, volume: 1,
      },
      {
        trackId: 'mono-track', assetId: 'muted', startTick: 0,
        inPoint: 0, outPoint: 4 / 48_000, muted: true,
      },
    ],
    durationTicks: 4,
    fps: 48_000,
    exactDuration: true,
  }));
  const mixed = requireValue(await mixTimelineAudio(plan, { OfflineAudioContextClass: null }));
  assert.deepEqual([...mixed.getChannelData(0)], [0.125, 0, 0.25, 0.375]);
  assert.deepEqual([...mixed.getChannelData(1)], [0.125, -0.25, -0.25, -0.375]);
  assert.equal(plan.numberOfFrames, 4);
  assert.equal(plan.durationUs, 83);
  assert.equal(plan.clips.length, 2);
});

await test('PCM fallback resamples 44.1 kHz with a fractional source trim', async () => {
  const sourceBuffer = pcmBuffer([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]], 44_100);
  const plan = requireValue(createTimelineAudioPlan({
    assets: [{ id: 'resample', buffer: sourceBuffer }],
    tracks: [{ id: 'track' }],
    clips: [{
      trackId: 'track', assetId: 'resample', startTick: 0,
      inPoint: 0.5 / 44_100,
      outPoint: 0.5 / 44_100 + 4 / 48_000,
    }],
    durationTicks: 4,
    fps: 48_000,
    exactDuration: true,
  }));
  const mixed = requireValue(await mixTimelineAudio(plan, { OfflineAudioContextClass: null }));
  const expected = [0.5, 1.41875, 2.3375, 3.25625];
  for (let index = 0; index < expected.length; index++) {
    assert.ok(Math.abs(requireValue(mixed.getChannelData(0)[index]) - requireValue(expected[index])) < 1e-6);
    assert.ok(Math.abs(requireValue(mixed.getChannelData(1)[index]) - requireValue(expected[index])) < 1e-6);
  }
});

await test('Animation audio resource estimates include unique sources, encoded copies, mix, WAV, and ZIP', () => {
  const usage = estimateAnimationAudioExportResources({
    assets: [
      { id: 'a', hash: 'a'.repeat(64), generation: 1, duration: 1, size: 100 },
      { id: 'a-copy', hash: 'a'.repeat(64), generation: 1, duration: 1, size: 100 },
      { id: 'b', hash: 'b'.repeat(64), generation: 1, duration: 2, size: 200 },
    ],
    durationTicks: 48_000,
    fps: 48_000,
  });
  assert.deepEqual(usage, {
    sourcePcmBytes: 3 * 48_000 * 8 * 4,
    encodedInputBytes: 600,
    mixPcmBytes: 48_000 * 2 * 4,
    wavBytes: 44 + 48_000 * 2 * 2,
    zipCopyBytes: 44 + 48_000 * 2 * 2,
    peakBytes: 3 * 48_000 * 8 * 4 + 600 +
      48_000 * 2 * 4 + 2 * (44 + 48_000 * 2 * 2),
    numberOfFrames: 48_000,
  });
});

await test('Animation audio resource preflight rejects six-minute 7.1, encoded bytes, and overlaps', () => {
  assert.throws(() => estimateAnimationAudioExportResources({
    assets: [{ id: 'long-7.1', duration: 360, size: 1 }],
    durationTicks: 1,
    fps: 48_000,
  }), /512 MiB safe peak-memory budget/);
  assert.throws(() => estimateAnimationAudioExportResources({
    assets: [{ id: 'large-file', duration: 1, size: 260 * 1024 * 1024 }],
    durationTicks: 1,
    fps: 48_000,
  }), /shorter or smaller source files/);
  assert.throws(() => estimateAnimationAudioExportResources({
    assets: Array.from({ length: 70 }, (_, index) => ({
      id: `overlap-${index}`,
      hash: index.toString(16).padStart(64, '0'),
      generation: 1,
      duration: 20,
    })),
    durationTicks: 48_000,
    fps: 48_000,
  }), /512 MiB safe peak-memory budget/);
});

await test('Animation audio stereo boundary and unsafe arithmetic are checked', () => {
  assert.throws(() => estimateAnimationAudioExportResources({
    assets: [{ id: 'overflow', duration: Number.MAX_VALUE }],
    durationTicks: 1,
    fps: 48_000,
  }), /too long to represent safely/);
  assert.throws(() => estimateAnimationAudioExportResources({
    assets: [{ id: 'encoded-overflow', duration: 1, size: Number.MAX_SAFE_INTEGER }],
    durationTicks: 1,
    fps: 48_000,
  }), /encoded input estimate cannot be represented safely/);
  assert.throws(() => estimateAnimationAudioExportResources({
    assets: [],
    durationTicks: Number.MAX_SAFE_INTEGER,
    fps: Number.MIN_VALUE,
  }), /too long to represent safely/);

  const maximumWavFrames = Math.floor((WAV_EXPORT_MAX_BYTES - 44) / 4);
  const boundary = validateDecodedAnimationAudioExportResources({
    assets: [{
      id: 'boundary', hash: 'c'.repeat(64), generation: 1,
      buffer: { numberOfChannels: 2, length: 11 },
    }],
    numberOfFrames: maximumWavFrames,
  });
  assert.equal(boundary.wavBytes, WAV_EXPORT_MAX_BYTES);
  assert.equal(boundary.peakBytes, ANIMATION_AUDIO_PEAK_MAX_BYTES);
  assert.throws(() => validateDecodedAnimationAudioExportResources({
    assets: [{
      id: 'over-peak', hash: 'd'.repeat(64), generation: 1,
      buffer: { numberOfChannels: 2, length: 12 },
    }],
    numberOfFrames: maximumWavFrames,
  }), /512 MiB safe peak-memory budget/);
  assert.throws(() => estimateAnimationAudioExportResources({
    assets: [],
    durationTicks: maximumWavFrames + 1,
    fps: 48_000,
  }), /128 MiB safe export size limit/);
});

await test('silent mono source produces exact stereo zero samples', async () => {
  const plan = requireValue(createTimelineAudioPlan({
    assets: [{ id: 'silence', buffer: pcmBuffer([[0, 0, 0]]) }],
    tracks: [{ id: 'track' }],
    clips: [{
      trackId: 'track', assetId: 'silence', startTick: 0,
      inPoint: 0, outPoint: 3 / 48_000,
    }],
    durationTicks: 3,
    fps: 48_000,
    exactDuration: true,
  }));
  const mixed = requireValue(await mixTimelineAudio(plan, { OfflineAudioContextClass: null }));
  const wav = await encodePcmWav(mixed);
  assert.deepEqual([...wav.subarray(44)], Array(12).fill(0));
});

await test('WAV encoder writes canonical PCM header, clipping, rounding, and deterministic bytes', async () => {
  const samples = [-2, -1, -0.5, -1 / 32_768, 0, 1 / 32_767, 0.5, 1, 2, NaN];
  const mono = pcmBuffer([samples]);
  const first = await encodePcmWav(mono);
  const repeated = await encodePcmWav(mono);
  const view = wavView(first);
  assert.deepEqual(first, repeated);
  assert.equal(new TextDecoder().decode(first.subarray(0, 4)), 'RIFF');
  assert.equal(view.getUint32(4, true), first.length - 8);
  assert.equal(new TextDecoder().decode(first.subarray(8, 12)), 'WAVE');
  assert.equal(new TextDecoder().decode(first.subarray(12, 16)), 'fmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48_000);
  assert.equal(view.getUint32(28, true), 192_000);
  assert.equal(view.getUint16(32, true), 4);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(new TextDecoder().decode(first.subarray(36, 40)), 'data');
  assert.equal(view.getUint32(40, true), samples.length * 4);
  assert.equal(first.length, 44 + samples.length * 4);
  const expected = [-32_768, -32_768, -16_384, -1, 0, 1, 16_384, 32_767, 32_767, 0];
  for (let frame = 0; frame < samples.length; frame++) {
    assert.equal(view.getInt16(44 + frame * 4, true), requireValue(expected[frame]));
    assert.equal(view.getInt16(46 + frame * 4, true), requireValue(expected[frame]),
      'mono duplicates to stereo');
  }
});

await test('exact-duration WAV planning truncates an audio tail without a second mix', async () => {
  const sourcePcm = pcmBuffer([[0.25, 0.5, 0.75, 1, 1, 1]]);
  const plan = requireValue(createTimelineAudioPlan({
    assets: [{ id: 'tail', buffer: sourcePcm }],
    tracks: [{ id: 'track' }],
    clips: [{
      trackId: 'track', assetId: 'tail', startTick: 0,
      inPoint: 0, outPoint: sourcePcm.duration,
    }],
    durationTicks: 3,
    fps: 48_000,
    exactDuration: true,
  }));
  let mixes = 0;
  let closes = 0;
  const wav = await encodeTimelineWav(plan, {
    OfflineAudioContextClass: null,
    async mixAudio(value, dependencies) {
      mixes++;
      const mixed = await mixTimelineAudio(value, dependencies);
      return { ...mixed, close() { closes++; } };
    },
  });
  assert.equal(mixes, 1);
  assert.equal(closes, 1);
  assert.equal(plan.totalTicks, 3);
  assert.equal(plan.numberOfFrames, 3);
  assert.equal(requireValue(wav).length, 44 + 3 * 4);
});

await test('WAV encoding rejects unsafe allocation and observes cancellation while chunking', async () => {
  const tiny = new Float32Array(1);
  await assert.rejects(encodePcmWav({
    sampleRate: 48_000,
    numberOfChannels: 1,
    numberOfFrames: 100_000_000,
    getChannelData() { return tiny; },
  }), /safe export size limit/);

  const controller = new AbortController();
  const channel = new Float32Array(20_000);
  await assert.rejects(encodePcmWav({
    sampleRate: 48_000,
    numberOfChannels: 1,
    numberOfFrames: channel.length,
    getChannelData() { return channel; },
  }, {
    signal: controller.signal,
    yieldControl() {
      controller.abort();
      return Promise.resolve();
    },
  }), (error: unknown) => error instanceof Error && error.name === 'AbortError');
});

if (failed) {
  console.error(`${failed} audio test(s) failed; ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`ok - ${passed} audio core tests`);
}
