import assert from 'node:assert/strict';
import { Blob } from 'node:buffer';
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
} from '../src/lib/audio.js';
import {
  deterministicUuid,
  deterministicUuidGenerator as createStableAudioIdGenerator,
} from './projectFixture.mjs';
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
} from '../src/lib/audioExport.js';
import {
  closeAudioPreview,
  planAudioPreviewClip,
  startAudioPreview,
} from '../src/lib/audioPlayback.js';
import {
  fps as projectFps,
  initTimeline,
  moveClip,
  razorClip,
  trimClip,
} from '../src/lib/frames.js';
import {
  authoredRevision,
  beginStroke,
  endStroke,
  noteAuthoredMutation,
  redo,
  undo,
} from '../src/lib/grid.js';
import {
  createCanonicalClipTimelineController,
  getClipTimelineState,
} from '../src/lib/clipTimelineState.js';
import { validLoopRange } from '../src/lib/timelineTags.js';

let passed = 0;
let failed = 0;

async function test(name, run) {
  try {
    await run();
    passed++;
  } catch (error) {
    failed++;
    console.error('FAIL ' + name, error.stack);
  }
}

function source(name = 'voice.ogg', duration = 4) {
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/ogg' });
  Object.defineProperty(blob, 'name', { value: name });
  return { blob, buffer: { duration }, duration };
}

function pcmBuffer(channels, sampleRate = 48_000) {
  const data = channels.map((channel) => Float32Array.from(channel));
  const length = data[0]?.length ?? 0;
  assert.equal(data.every((channel) => channel.length === length), true);
  return {
    duration: length / sampleRate,
    length,
    numberOfFrames: length,
    numberOfChannels: data.length,
    sampleRate,
    getChannelData(channel) { return data[channel]; },
  };
}

function wavView(bytes) {
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
  const first = audio.createAudioTrack(firstSource, 7);
  const second = audio.createAudioTrack(source('music.wav', 8), 0);

  assert.deepEqual([
    first.asset.id,
    first.track.id,
    first.clip.id,
    second.asset.id,
    second.track.id,
    second.clip.id,
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
  assert.equal(first.clip.startTick, 7);
  assert.equal(first.clip.outPoint, 3.5);
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
  const audio = createAudioController({ canonicalController: canonical });
  const created = audio.createAudioTrack(source('shared.wav', 1), 2);

  assert.equal(audio.canonicalController, canonical);
  assert.deepEqual(canonical.getState().tracks.map((track) => track.kind), ['visual', 'audio']);
  assert.equal(canonical.getState().clips.find((clip) => clip.id === created.clip.id).assetId,
    created.asset.id);
  assert.deepEqual(get(audio.audioTracks).map((track) => track.id), [created.track.id]);
});

await test('split uses exact project-tick boundaries and preserves continuous source time', () => {
  const audio = createAudioController();
  const created = audio.createAudioTrack(source('held.wav', 5), 0, {
    inPoint: 0.5,
    outPoint: 4,
    volume: 0.35,
    muted: true,
  });
  const split = audio.splitAudioClipAtTick(
    created.track.id,
    created.clip.id,
    3,
    4,
  );

  assert.ok(split);
  assert.equal(split.left.outPoint, 1.25);
  assert.equal(split.right.inPoint, split.left.outPoint);
  assert.equal(split.right.startTick, 3);
  assert.equal(split.left.assetId, split.right.assetId);
  assert.equal(split.left.volume, 0.35);
  assert.equal(split.right.volume, 0.35);
  assert.equal(split.left.muted, true);
  assert.equal(split.right.muted, true);
  assert.equal(get(audio.audioClips).length, 2);
  assert.equal(audio.splitAudioClipAtTick(
    created.track.id,
    split.right.id,
    3,
    4,
  ), null);
});

await test('clip gain and mute updates remain normalized', () => {
  const audio = createAudioController();
  const { track, clip } = audio.createAudioTrack(source(), 0);
  const quiet = audio.updateAudioClip(track.id, clip.id, { volume: 0.2, muted: true });
  const clamped = audio.updateAudioClip(track.id, clip.id, { volume: 2, muted: false });

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
  const plan = createTimelineAudioPlan({
    assets: get(audio.audioAssets),
    tracks: loadedTracks,
    clips: get(audio.audioClips),
    durationTicks: 4,
    fps: 48_000,
    exactDuration: true,
  });
  assert.equal(plan.clips.length, 1);
  assert.equal(plan.clips[0].assetId, 'high-asset');
  assert.equal(plan.clips[0].gain, 1);
});

await test('canonical visual clip edits never remap project-tick audio', () => {
  resetAudioState();
  projectFps.set(12);
  initTimeline([{
    id: 'visual', name: 'Visual', type: 'cell', visible: true, cells: {},
  }]);
  const created = createProjectAudioTrack(source('fixed.wav', 5), 7, {
    inPoint: 0.25,
  });
  const visual = getClipTimelineState().clips.find((clip) => clip.kind === 'visual');
  const extended = trimClip(visual.id, 'end', 4);
  const split = razorClip(visual.id, 2);
  const moved = moveClip(split.right.id, 5);

  assert.deepEqual([extended.changed, split.changed, moved.changed], [true, true, true]);
  assert.equal(get(projectAudioClips)[0].startTick, 7);
  assert.equal(get(projectAudioClips)[0].inPoint, 0.25);
  assert.equal(get(projectAudioClips)[0].id, created.clip.id);
  resetAudioState();
});

await test('serialization separates Blob bytes and omits all runtime fields', () => {
  const audio = createAudioController();
  const imported = source('serialize.ogg', 6);
  const created = audio.createAudioTrack(imported, 3, { volume: 0.75 });
  const serialized = audio.serializeAudioState();

  assert.deepEqual(serialized.assetIds, [created.asset.id]);
  assert.deepEqual([...serialized.blobs.keys()], [created.asset.id]);
  assert.equal(serialized.blobs.get(created.asset.id), imported.blob);
  assert.equal('blob' in serialized.metadata.assets[0], false);
  assert.equal('buffer' in serialized.metadata.assets[0], false);
  assert.equal(JSON.stringify(serialized.metadata).includes('buffer'), false);
  assert.equal(serialized.metadata.tracks[0].clips[0].assetId, created.asset.id);
  assert.equal(serialized.metadata.tracks[0].clips[0].startTick, 3);
  assert.equal('startFrame' in serialized.metadata.tracks[0].clips[0], false);

  const loaded = createAudioController();
  loaded.loadAudioState(serialized.metadata, serialized.blobs);
  assert.equal(get(loaded.audioAssets)[0].blob, imported.blob);
  assert.equal(get(loaded.audioAssets)[0].buffer, null);
  assert.deepEqual(loaded.audioStateForSave(), serialized.metadata);

  const decoded = createAudioController();
  decoded.loadAudioState(serialized.metadata, new Map([[
    created.asset.id,
    { blob: imported.blob, buffer: imported.buffer },
  ]]));
  assert.equal(get(decoded.audioAssets)[0].buffer, imported.buffer);

});

await test('history capture and restore share immutable media but isolate edit metadata', () => {
  const audio = createAudioController();
  const { asset, track, clip } = audio.createAudioTrack(source(), 2);
  const captured = audio.captureAudioState();
  audio.updateAudioClip(track.id, clip.id, { startTick: 9, volume: 0.1 });
  audio.restoreAudioState(captured);

  const restored = audio.captureAudioState();
  assert.equal(restored.assets[0], asset);
  assert.equal(restored.clips[0].startTick, 2);
  assert.equal(restored.clips[0].volume, 1);
  assert.notEqual(restored.clips[0], captured.clips[0]);
});

await test('default audio placement Undo and Redo retain runtime media outside canonical history', () => {
  resetAudioState();
  projectFps.set(10);
  initTimeline([]);
  const revisionBeforeImport = get(authoredRevision);
  beginStroke();
  const created = createProjectAudioTrack(source('history.wav', 2), 3, {
    inPoint: 0.25,
    outPoint: 1.25,
  });
  const createdClipId = created.clip.id;
  const createdBuffer = created.asset.buffer;
  noteAuthoredMutation();
  assert.equal(endStroke(), true);
  assert.equal(get(authoredRevision), revisionBeforeImport + 1);
  assert.equal(get(projectAudioClips)[0].startTick, 3);
  assert.equal(JSON.stringify(getClipTimelineState()).includes('buffer'), false);

  undo();
  assert.equal(get(projectAudioClips).length, 0);
  redo();
  assert.equal(get(projectAudioClips)[0].id, createdClipId);
  assert.equal(get(projectAudioAssets)[0].buffer, createdBuffer);

  const revisionBeforeMove = get(authoredRevision);
  beginStroke();
  const moved = get(projectAudioClips)[0];
  const updated = updateProjectAudioClip(
    moved.trackId,
    moved.id,
    { startTick: 7 },
  );
  assert.equal(updated.startTick, 7);
  noteAuthoredMutation();
  assert.equal(endStroke(), true);
  assert.equal(get(authoredRevision), revisionBeforeMove + 1);
  undo();
  assert.equal(get(projectAudioClips)[0].startTick, 3);
  redo();
  assert.equal(get(projectAudioClips)[0].startTick, 7);

  beginStroke();
  const current = get(projectAudioClips)[0];
  assert.ok(removeAudioClip(current.trackId, current.id));
  noteAuthoredMutation();
  assert.equal(endStroke(), true);
  assert.equal(get(projectAudioClips).length, 0);
  undo();
  assert.equal(get(projectAudioClips)[0].id, createdClipId);
  assert.equal(get(projectAudioAssets)[0].buffer, createdBuffer);
  redo();
  assert.equal(get(projectAudioClips).length, 0);
  resetAudioState();
});

await test('export audio planning uses absolute ticks and lets clips extend duration', () => {
  const readyBuffer = { duration: 2 };
  const plan = createTimelineAudioPlan({
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
  });

  assert.equal(plan.sampleRate, 48_000);
  assert.equal(plan.numberOfChannels, 2);
  assert.equal(plan.numberOfFrames, 40_000);
  assert.equal(plan.duration, 5 / 6);
  assert.equal(plan.totalTicks, 10);
  assert.equal(plan.clips.length, 1);
  assert.deepEqual({
    id: plan.clips[0].id,
    buffer: plan.clips[0].buffer,
    gain: plan.clips[0].gain,
    inPoint: plan.clips[0].inPoint,
    outPoint: plan.clips[0].outPoint,
    startTick: plan.clips[0].startTick,
    startSample: plan.clips[0].startSample,
    startTime: plan.clips[0].startTime,
    duration: plan.clips[0].duration,
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
  const load = (volume) => loadProjectAudioState({
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
    static instance = null;

    constructor() {
      this.state = 'running';
      this.currentTime = 1;
      this.destination = {};
      this.sources = [];
      this.gains = [];
      this.constructor.instance = this;
    }

    createBufferSource() {
      const node = {
        connect(target) { return target; },
        start(...args) { node.started = args; },
        stop() {},
        disconnect() {},
      };
      this.sources.push(node);
      return node;
    }

    createGain() {
      const node = {
        gain: { value: 1 },
        connect(target) { return target; },
        disconnect() {},
      };
      this.gains.push(node);
      return node;
    }

    async close() {}
  }

  try {
    globalThis.AudioContext = AudioContextDouble;
    load(2);
    assert.equal(await startAudioPreview({ tick: 0, fps: 48_000 }), true);
    assert.equal(AudioContextDouble.instance.sources.length, 1);
    assert.equal(AudioContextDouble.instance.gains[0].gain.value, 0.5,
      'loaded volume 2 clamps to one before preview gain');
    load(-1);
    assert.equal(await startAudioPreview({ tick: 0, fps: 48_000 }), true);
    assert.equal(AudioContextDouble.instance.sources.length, 1,
      'loaded negative volume clamps to zero and schedules no source');
  } finally {
    await closeAudioPreview();
    resetAudioState();
    if (originalAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = originalAudioContext;
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
    static instances = [];

    constructor() {
      this.state = 'running';
      this.currentTime = 4;
      this.destination = { kind: 'destination' };
      this.sources = [];
      this.constructor.instances.push(this);
    }

    createBufferSource() {
      const node = {
        starts: [],
        stops: 0,
        connect(target) { node.connected = target; return target; },
        start(...args) { node.starts.push(args); },
        stop() { node.stops++; },
        disconnect() {},
      };
      this.sources.push(node);
      return node;
    }

    createGain() {
      return {
        gain: { value: 1 },
        connect(target) { return target; },
        disconnect() {},
      };
    }

    async close() {}
  }

  try {
    globalThis.AudioContext = AudioContextDouble;
    assert.equal(await startAudioPreview({ tick: 3, fps: 10 }), true);
    const context = AudioContextDouble.instances[0];
    assert.equal(context.sources.length, 1);
    const [when, offset, duration] = context.sources[0].starts[0];
    assert.ok(Math.abs(when - 4.23) < 1e-12);
    assert.equal(offset, 0.5);
    assert.equal(duration, 1.5);

    assert.equal(await startAudioPreview({ tick: 6, fps: 10 }), true);
    const [resumedWhen, resumedOffset, resumedDuration] = context.sources[1].starts[0];
    assert.ok(Math.abs(resumedWhen - 4.03) < 1e-12);
    assert.ok(Math.abs(resumedOffset - 0.6) < 1e-12);
    assert.ok(Math.abs(resumedDuration - 1.4) < 1e-12);
    assert.equal(context.sources[0].stops, 1);

    assert.equal(await startAudioPreview({
      tick: 5,
      fps: 10,
      loopRange: { startTick: 5, endTick: 7 },
    }), true);
    const [loopWhen, loopOffset, loopDuration] = context.sources[2].starts[0];
    assert.ok(Math.abs(loopWhen - 4.03) < 1e-12);
    assert.equal(loopOffset, 0.5);
    assert.ok(Math.abs(loopDuration - 0.3) < 1e-12);
    assert.equal(context.sources[1].stops, 1,
      'a multi-tick cycle restart stops the preceding source');

    assert.equal(await startAudioPreview({
      tick: 6,
      fps: 10,
      loopRange: { startTick: 6, endTick: 6 },
    }), true);
    const [, singleOffset, singleDuration] = context.sources[3].starts[0];
    assert.ok(Math.abs(singleOffset - 0.6) < 1e-12);
    assert.ok(Math.abs(singleDuration - 0.1) < 1e-12);
    assert.equal(context.sources[2].stops, 1);

    assert.equal(await startAudioPreview({
      tick: 6,
      fps: 10,
      loopRange: { startTick: 6, endTick: 6 },
    }), true);
    assert.equal(context.sources[3].stops, 1,
      'a same-tick cycle signal can restart an identically positioned source');
    assert.ok(Math.abs(context.sources[4].starts[0][2] - 0.1) < 1e-12);
  } finally {
    await closeAudioPreview();
    resetAudioState();
    if (originalAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = originalAudioContext;
  }
});

await test('preview applies track and clip gain and either mute to overlapping clips', async () => {
  resetAudioState();
  const first = createProjectAudioTrack(source('first.wav', 2), 0, {
    outPoint: 1,
    volume: 0.4,
  });
  updateProjectAudioTrack(first.track.id, { volume: 0.5 });
  const mutedTrack = createProjectAudioTrack(source('muted-track.wav', 2), 0, {
    outPoint: 1,
    volume: 0.9,
  });
  updateProjectAudioTrack(mutedTrack.track.id, { muted: true, volume: 0.8 });
  const mutedClip = createProjectAudioTrack(source('muted-clip.wav', 2), 0, {
    outPoint: 1,
    volume: 0.7,
    muted: true,
  });
  updateProjectAudioTrack(mutedClip.track.id, { volume: 0.6 });
  const overlap = createProjectAudioTrack(source('overlap.wav', 2), 0, {
    outPoint: 1,
    volume: 0.8,
  });
  updateProjectAudioTrack(overlap.track.id, { volume: 0.75 });
  const originalAudioContext = globalThis.AudioContext;

  class AudioContextDouble {
    static instances = [];

    constructor() {
      this.state = 'running';
      this.currentTime = 2;
      this.destination = { kind: 'destination' };
      this.sources = [];
      this.gains = [];
      this.constructor.instances.push(this);
    }

    createBufferSource() {
      const node = {
        starts: [],
        connect(target) { node.connected = target; return target; },
        start(...args) { node.starts.push(args); },
        stop() {},
        disconnect() {},
      };
      this.sources.push(node);
      return node;
    }

    createGain() {
      const node = {
        gain: { value: 1 },
        connect(target) { node.connected = target; return target; },
        disconnect() {},
      };
      this.gains.push(node);
      return node;
    }

    async close() {}
  }

  try {
    globalThis.AudioContext = AudioContextDouble;
    assert.equal(await startAudioPreview({ tick: 0, fps: 10 }), true);
    const context = AudioContextDouble.instances[0];
    assert.equal(context.sources.length, 2);
    assert.equal(context.sources[0].buffer, first.asset.buffer);
    assert.equal(context.sources[1].buffer, overlap.asset.buffer);
    assert.deepEqual(context.sources.map((node) => node.starts[0]), [
      [2.03, 0, 1],
      [2.03, 0, 1],
    ]);
    assert.ok(Math.abs(context.gains[0].gain.value - 0.2) < 1e-12);
    assert.ok(Math.abs(context.gains[1].gain.value - 0.6) < 1e-12);
  } finally {
    await closeAudioPreview();
    resetAudioState();
    if (originalAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = originalAudioContext;
  }
});

await test('loop preview plans cap current and future clips at the inclusive endpoint', () => {
  const clip = { startTick: 0, inPoint: 0.25, outPoint: 2 };
  const oneTick = planAudioPreviewClip(clip, {
    tick: 3,
    fps: 10,
    loopRange: { startTick: 3, endTick: 3 },
  });
  assert.equal(oneTick.delay, 0);
  assert.ok(Math.abs(oneTick.offset - 0.55) < 1e-12);
  assert.ok(Math.abs(oneTick.duration - 0.1) < 1e-12);

  const multiTick = planAudioPreviewClip(clip, {
    tick: 2,
    fps: 10,
    loopRange: { startTick: 2, endTick: 4 },
  });
  assert.ok(Math.abs(multiTick.offset - 0.45) < 1e-12);
  assert.ok(Math.abs(multiTick.duration - 0.3) < 1e-12);

  const future = planAudioPreviewClip({ startTick: 4, inPoint: 0.5, outPoint: 2 }, {
    tick: 2,
    fps: 10,
    loopRange: { startTick: 2, endTick: 4 },
  });
  assert.ok(Math.abs(future.delay - 0.2) < 1e-12);
  assert.equal(future.offset, 0.5);
  assert.ok(Math.abs(future.duration - 0.1) < 1e-12);

  const openEnded = planAudioPreviewClip(clip, {
    tick: 4,
    fps: 10,
    loopRange: validLoopRange([{ type: 'loop-start', tick: 4 }], 8),
  });
  assert.ok(Math.abs(openEnded.offset - 0.65) < 1e-12);
  assert.ok(Math.abs(openEnded.duration - 0.4) < 1e-12,
    'start-only loop normalization caps audio at the inclusive sequence end');

  const unbounded = planAudioPreviewClip(clip, {
    tick: 2,
    fps: 10,
    loopRange: { startTick: 4, endTick: 2 },
  });
  assert.ok(Math.abs(unbounded.duration - 1.55) < 1e-12,
    'reversed markers retain full-clip behavior');
  assert.ok(Math.abs(planAudioPreviewClip(clip, {
    tick: 2,
    fps: 10,
    loopRange: null,
  }).duration - 1.55) < 1e-12, 'Loop off retains full-clip behavior');
  assert.ok(Math.abs(planAudioPreviewClip(clip, {
    tick: 2,
    fps: 10,
    loopRange: { startTick: 4 },
  }).duration - 1.55) < 1e-12, 'an unnormalized partial range is ignored');
});

await test('offline export mixer schedules exact stereo duration and releases nodes', async () => {
  const sourceBuffer = { duration: 2 };
  const plan = createTimelineAudioPlan({
    assets: [{ id: 'ready', buffer: sourceBuffer }],
    tracks: [{ id: 'track', volume: 0.5 }],
    clips: [{
      id: 'clip', trackId: 'track', assetId: 'ready', startTick: 1,
      inPoint: 0.25, outPoint: 1, volume: 0.4,
    }],
    durationTicks: 6,
    fps: 12,
  });
  const renderedChannels = [new Float32Array(plan.numberOfFrames), new Float32Array(plan.numberOfFrames)];

  class OfflineContextDouble {
    static instances = [];

    constructor(options) {
      this.options = options;
      this.destination = { kind: 'destination' };
      this.sources = [];
      this.gains = [];
      this.constructor.instances.push(this);
    }

    createBufferSource() {
      const node = {
        starts: [],
        stops: 0,
        disconnects: 0,
        connect(target) { node.connected = target; return target; },
        start(...args) { node.starts.push(args); },
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
        connect(target) { node.connected = target; return target; },
        disconnect() { node.disconnects++; },
      };
      this.gains.push(node);
      return node;
    }

    async startRendering() {
      return {
        length: this.options.length,
        sampleRate: this.options.sampleRate,
        numberOfChannels: this.options.numberOfChannels,
        getChannelData(channel) { return renderedChannels[channel]; },
      };
    }
  }

  const pcm = await mixTimelineAudio(plan, { OfflineAudioContextClass: OfflineContextDouble });
  const context = OfflineContextDouble.instances[0];
  assert.deepEqual(context.options, {
    numberOfChannels: 2,
    length: 40_000,
    sampleRate: 48_000,
  });
  assert.equal(context.sources[0].buffer, sourceBuffer);
  assert.deepEqual(context.sources[0].starts, [[1 / 12, 0.25, 0.75]]);
  assert.equal(context.sources[0].connected, context.gains[0]);
  assert.equal(context.gains[0].gain.value, 0.2);
  assert.equal(context.gains[0].connected, context.destination);
  assert.equal(context.sources[0].stops, 1);
  assert.equal(context.sources[0].disconnects, 1);
  assert.equal(context.gains[0].disconnects, 1);
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
  const plan = createTimelineAudioPlan({
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
  });
  const mixed = await mixTimelineAudio(plan, { OfflineAudioContextClass: null });
  assert.deepEqual([...mixed.getChannelData(0)], [0.125, 0, 0.25, 0.375]);
  assert.deepEqual([...mixed.getChannelData(1)], [0.125, -0.25, -0.25, -0.375]);
  assert.equal(plan.numberOfFrames, 4);
  assert.equal(plan.durationUs, 83);
  assert.equal(plan.clips.length, 2);
});

await test('PCM fallback resamples 44.1 kHz with a fractional source trim', async () => {
  const sourceBuffer = pcmBuffer([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]], 44_100);
  const plan = createTimelineAudioPlan({
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
  });
  const mixed = await mixTimelineAudio(plan, { OfflineAudioContextClass: null });
  const expected = [0.5, 1.41875, 2.3375, 3.25625];
  for (let index = 0; index < expected.length; index++) {
    assert.ok(Math.abs(mixed.getChannelData(0)[index] - expected[index]) < 1e-6);
    assert.ok(Math.abs(mixed.getChannelData(1)[index] - expected[index]) < 1e-6);
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
  const plan = createTimelineAudioPlan({
    assets: [{ id: 'silence', buffer: pcmBuffer([[0, 0, 0]]) }],
    tracks: [{ id: 'track' }],
    clips: [{
      trackId: 'track', assetId: 'silence', startTick: 0,
      inPoint: 0, outPoint: 3 / 48_000,
    }],
    durationTicks: 3,
    fps: 48_000,
    exactDuration: true,
  });
  const mixed = await mixTimelineAudio(plan, { OfflineAudioContextClass: null });
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
    assert.equal(view.getInt16(44 + frame * 4, true), expected[frame]);
    assert.equal(view.getInt16(46 + frame * 4, true), expected[frame], 'mono duplicates to stereo');
  }
});

await test('exact-duration WAV planning truncates an audio tail without a second mix', async () => {
  const sourcePcm = pcmBuffer([[0.25, 0.5, 0.75, 1, 1, 1]]);
  const plan = createTimelineAudioPlan({
    assets: [{ id: 'tail', buffer: sourcePcm }],
    tracks: [{ id: 'track' }],
    clips: [{
      trackId: 'track', assetId: 'tail', startTick: 0,
      inPoint: 0, outPoint: sourcePcm.duration,
    }],
    durationTicks: 3,
    fps: 48_000,
    exactDuration: true,
  });
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
  assert.equal(wav.length, 44 + 3 * 4);
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
  }), (error) => error?.name === 'AbortError');
});

if (failed) {
  console.error(`${failed} audio test(s) failed; ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`ok - ${passed} audio core tests`);
}
