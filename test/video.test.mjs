import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import {
  MIN_VIDEO_CLIP_SECONDS,
  loadVideoSource,
  normalizeVideoClip,
  requestVideoFrameDecode,
  syncVideoLayerFrames,
  trimVideoClipEndToTick,
  trimVideoClipStartToTick,
  videoClipDurationTicks,
  videoClipEndTick,
  videoDecodeRequests,
  videoFrameRevision,
  videoRasterReadyAt,
  videoRasterStatus,
  videoStateAtTick,
} from '../src/lib/video.js';
import {
  canRelinkVideo,
  videoReferenceState,
  visibleVideoReferenceLayers,
} from '../src/lib/layerActions.js';

const readyIdentity = { clipId: 'video', assetId: 'source', projectTick: 5 };
assert.equal(videoRasterReadyAt({ state: 'ready', ...readyIdentity }, readyIdentity), true);
assert.equal(videoRasterReadyAt(
  { state: 'ready', ...readyIdentity, projectTick: 4 },
  readyIdentity,
), false);
assert.deepEqual([
  videoReferenceState({ id: 'video', type: 'video', videoElement: {}, videoClip: { assetId: 'source' } }),
  videoReferenceState(
    { id: 'video', type: 'video', videoElement: {}, videoClip: { assetId: 'source' } },
    { state: 'error', clipId: 'video', assetId: 'source' },
  ),
  videoReferenceState(
    { id: 'video', type: 'video', videoElement: {}, videoClip: { assetId: 'new-source' } },
    { state: 'error', clipId: 'video', assetId: 'old-source' },
  ),
  videoReferenceState({ id: 'video', type: 'video', videoClip: { assetId: 'source' } }),
], ['ready', 'error', 'ready', 'missing']);
assert.deepEqual(visibleVideoReferenceLayers([
  { id: 'open', type: 'video', videoClip: {}, groupId: 'expanded' },
  { id: 'hidden', type: 'video', videoClip: {}, groupId: 'collapsed' },
  { id: 'collapsed', type: 'group', collapsed: true },
  { id: 'expanded', type: 'group', collapsed: false },
]).map((layer) => layer.id), ['open']);

class FakeVideo {
  constructor({ duration = 4, width = 640, height = 360, readyState = 0 } = {}) {
    this.duration = duration;
    this.videoWidth = width;
    this.videoHeight = height;
    this.readyState = readyState;
    this.currentTimeWrites = [];
    this.listeners = new Map();
    this._currentTime = 0;
    this._decodedTime = 0;
    this.seeking = false;
    this._src = '';
  }

  get currentTime() { return this._currentTime; }
  set currentTime(value) {
    this._currentTime = value;
    this.seeking = true;
    this.currentTimeWrites.push(value);
  }
  get decodedTime() { return this._decodedTime; }

  get src() { return this._src; }
  set src(value) { this._src = value; }

  addEventListener(type, listener, options = {}) {
    const entries = this.listeners.get(type) || [];
    entries.push({ listener, once: Boolean(options.once) });
    this.listeners.set(type, entries);
  }

  removeEventListener(type, listener) {
    const entries = this.listeners.get(type) || [];
    this.listeners.set(type, entries.filter((entry) => entry.listener !== listener));
  }

  dispatch(type) {
    if (type === 'seeked') {
      this.seeking = false;
      this._decodedTime = this._currentTime;
    }
    const entries = [...(this.listeners.get(type) || [])];
    for (const entry of entries) {
      if (entry.once) this.removeEventListener(type, entry.listener);
      entry.listener();
    }
  }
}

class FakeRaster {
  constructor(width = 1, height = 1) {
    this.width = width;
    this.height = height;
    this.draws = [];
    this.context = {
      drawImage: (video, x, y, width, height) => {
        this.draws.push({ time: video.decodedTime ?? video.currentTime, x, y, width, height });
      },
    };
  }

  getContext(type) {
    assert.equal(type, '2d');
    return this.context;
  }
}

let pendingVideo = null;
const createdRasters = [];
const createdUrls = [];
const revokedUrls = [];

globalThis.document = {
  createElement(tag) {
    if (tag === 'video') {
      assert.ok(pendingVideo, 'test must provide the next video element');
      const video = pendingVideo;
      pendingVideo = null;
      return video;
    }
    if (tag === 'canvas') {
      const raster = new FakeRaster(0, 0);
      createdRasters.push(raster);
      return raster;
    }
    throw new Error('unexpected element: ' + tag);
  },
};

globalThis.URL = {
  createObjectURL(file) {
    const url = 'blob:test-' + createdUrls.length;
    createdUrls.push({ file, url });
    return url;
  },
  revokeObjectURL(url) {
    revokedUrls.push(url);
  },
};

let passed = 0;
let failed = 0;

async function resetFixtures() {
  syncVideoLayerFrames([], 0, 24);
  await flushAsyncWork();
  pendingVideo = null;
  createdRasters.length = 0;
  createdUrls.length = 0;
  revokedUrls.length = 0;
  videoFrameRevision.set(0);
  videoRasterStatus.set(new Map());
}

async function test(name, run) {
  await resetFixtures();
  try {
    await run();
    passed++;
  } catch (error) {
    failed++;
    console.error('FAIL ' + name, error.stack);
  }
}

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

function videoLayer(video, raster, clip = {}) {
  return {
    id: 'video',
    type: 'video',
    videoElement: video,
    raster,
    videoClip: {
      assetId: 'source',
      startTick: 0,
      inPoint: 0,
      duration: 4,
      ...clip,
    },
  };
}

await test('current-schema timing keeps only a normalized project start tick', () => {
  const normalized = normalizeVideoClip({
    sourceName: 'current.mp4', startTick: '2.6', startFrame: 99, inPoint: 0.5, duration: 4,
  });
  assert.deepEqual(normalized, {
    sourceName: 'current.mp4', startTick: 3, inPoint: 0.5, outPoint: 4,
    playbackRate: 1, duration: 4,
  });
  assert.equal('startFrame' in normalized, false);

  const malformed = normalizeVideoClip({
    startTick: -9, inPoint: 99, outPoint: -4, playbackRate: 0, duration: 2,
  });
  assert.deepEqual({
    startTick: malformed.startTick,
    outPoint: malformed.outPoint,
    playbackRate: malformed.playbackRate,
    duration: malformed.duration,
  }, { startTick: 0, outPoint: 2, playbackRate: 1, duration: 2 });
  assert.ok(Math.abs(malformed.outPoint - malformed.inPoint - MIN_VIDEO_CLIP_SECONDS) < 1e-12);
});

await test('project tick, trim points, fps, and playback rate determine source time', () => {
  const fast = { startTick: 0, inPoint: 1, outPoint: 2, playbackRate: 2, duration: 5 };
  const slow = { ...fast, playbackRate: 0.5 };

  assert.deepEqual([0, 1, 2].map((tick) => videoStateAtTick(fast, tick, 4)), [
    { active: true, time: 1, elapsed: 0 },
    { active: true, time: 1.5, elapsed: 0.25 },
    { active: false, time: 2, elapsed: 0.5 },
  ]);
  assert.equal(videoClipDurationTicks(fast, 4), 2);
  assert.equal(videoClipDurationTicks(slow, 4), 8);
});

await test('exact frame-rate boundaries neither gain nor lose a project tick', () => {
  const clip = { startTick: 1, inPoint: 0, outPoint: 4, playbackRate: 1, duration: 4 };

  assert.equal(videoClipDurationTicks(clip, 24), 96);
  assert.equal(videoClipEndTick(clip, 24), 97);
  assert.equal(videoStateAtTick(clip, 96, 24).active, true);
  assert.equal(videoStateAtTick(clip, 97, 24).active, false);
  assert.equal(videoClipDurationTicks(trimVideoClipEndToTick(clip, 96, 24), 24), 95);
});

await test('left trim stops at the source head and remains reversible across frame rates', () => {
  const sourceHeadClip = {
    startTick: 10, inPoint: 0.2, outPoint: 1, playbackRate: 1, duration: 2,
  };
  assert.deepEqual(trimVideoClipStartToTick(sourceHeadClip, 0, 10), {
    startTick: 8, inPoint: 0, outPoint: 1, playbackRate: 1, duration: 2,
  });

  for (let rate = 1; rate <= 60; rate++) {
    const base = { startTick: 0, inPoint: 0, outPoint: 1, playbackRate: 1, duration: 1 };
    const inward = trimVideoClipStartToTick(base, 1, rate);
    const restored = trimVideoClipStartToTick(inward, 0, rate);
    assert.equal(restored.startTick, 0, `left trim stuck at ${rate} fps`);
    assert.ok(Math.abs(restored.inPoint) < 1e-12, `source time drifted at ${rate} fps`);
  }
});

await test('sub-millisecond sources normalize within their real duration', () => {
  const clip = normalizeVideoClip({ inPoint: 1, outPoint: 2, duration: 0.0005 });
  assert.ok(clip.inPoint >= 0 && clip.inPoint < clip.outPoint);
  assert.equal(clip.outPoint, clip.duration);
});

await test('a slow reference can be trimmed to one project tick', () => {
  const clip = { startTick: 0, inPoint: 0, outPoint: 1, playbackRate: 0.01, duration: 1 };
  assert.equal(videoClipDurationTicks(trimVideoClipEndToTick(clip, 1, 24), 24), 1);
});

await test('tick edge trims preserve source continuity without visual frame data', () => {
  const clip = {
    startTick: 10, inPoint: 0.5, outPoint: 1.7, playbackRate: 2, duration: 4,
  };

  assert.deepEqual(trimVideoClipStartToTick(clip, 12, 10), {
    startTick: 12, inPoint: 0.9, outPoint: 1.7, playbackRate: 2, duration: 4,
  });
  assert.deepEqual(trimVideoClipStartToTick(clip, 9, 10), {
    startTick: 9, inPoint: 0.3, outPoint: 1.7, playbackRate: 2, duration: 4,
  });
  assert.deepEqual(trimVideoClipEndToTick(clip, 15, 10), {
    startTick: 10, inPoint: 0.5, outPoint: 1.5, playbackRate: 2, duration: 4,
  });
  assert.deepEqual(clip, {
    startTick: 10, inPoint: 0.5, outPoint: 1.7, playbackRate: 2, duration: 4,
  });
});

await test('touching a displayed trim edge preserves a fractional source out point', () => {
  const clip = {
    startTick: 10, inPoint: 0.5, outPoint: 1.7, playbackRate: 2, duration: 4,
  };

  assert.deepEqual(trimVideoClipEndToTick(clip, videoClipEndTick(clip, 10), 10), clip);
});

await test('tick mapping is independent of visual frame structure and holds', () => {
  const clip = { startTick: 1, inPoint: 0.5, duration: 1.05 };

  assert.deepEqual(videoStateAtTick(clip, 0, 10), {
    active: false,
    time: 0.5,
    elapsed: 0,
  });
  assert.deepEqual(videoStateAtTick(clip, 6, 10), {
    active: true,
    time: 1,
    elapsed: 0.5,
  });
  assert.equal(videoClipDurationTicks(clip, 10), 6);
});

await test('each output tick advances source time at the project fps', () => {
  const clip = { startTick: 0, inPoint: 0.25, duration: 0.7 };
  const states = [0, 1, 2, 3, 4].map((tick) => videoStateAtTick(clip, tick, 10));

  assert.deepEqual(states.map((state) => ({
    active: state.active,
    time: Math.round(state.time * 100) / 100,
  })), [
    { active: true, time: 0.25 },
    { active: true, time: 0.35 },
    { active: true, time: 0.45 },
    { active: true, time: 0.55 },
    { active: true, time: 0.65 },
  ]);
  assert.equal(videoStateAtTick({ ...clip, duration: 0.45 }, 2, 10).active, false);
  assert.ok(Math.abs(videoStateAtTick({ startTick: 0, duration: 1 }, 2, 24).time - 2 / 24) < 1e-12);
});

await test('a clip hides exactly at its out point', () => {
  const clip = { startTick: 0, inPoint: 0.25, duration: 0.5 };

  assert.deepEqual(videoStateAtTick(clip, 2, 8), {
    active: false,
    time: 0.5,
    elapsed: 0.25,
  });
});

await test('a late clip extends sequence timing beyond visual content', () => {
  const clip = { startTick: 99, inPoint: 0.5, duration: 1.05 };

  assert.equal(videoClipDurationTicks(clip, 10), 6);
  assert.equal(videoClipEndTick(clip, 10), 105);
});

await test('metadata load publishes the decoded video and correctly sized raster', async () => {
  const file = { name: 'reference.mp4' };
  const video = new FakeVideo({ duration: 7.25, width: 1920, height: 1080 });
  pendingVideo = video;

  const loading = loadVideoSource(file);
  assert.equal(video.preload, 'auto');
  assert.equal(video.muted, true);
  assert.equal(video.playsInline, true);
  assert.equal(video.src, 'blob:test-0');

  video.onloadedmetadata();
  const source = await loading;

  assert.equal(source.element, video);
  assert.equal(source.raster, createdRasters[0]);
  assert.deepEqual(
    {
      url: source.url,
      duration: source.duration,
      width: source.width,
      height: source.height,
      rasterWidth: source.raster.width,
      rasterHeight: source.raster.height,
    },
    {
      url: 'blob:test-0',
      duration: 7.25,
      width: 1920,
      height: 1080,
      rasterWidth: 1920,
      rasterHeight: 1080,
    },
  );
  assert.deepEqual(createdUrls[0], { file, url: 'blob:test-0' });
  assert.deepEqual(revokedUrls, []);
});

await test('metadata with an initially unknown duration waits for the finite duration', async () => {
  const video = new FakeVideo({ duration: Infinity, width: 1280, height: 720 });
  pendingVideo = video;
  let resolved = false;
  const loading = loadVideoSource({ name: 'browser-recording.webm' }).then((source) => {
    resolved = true;
    return source;
  });

  video.onloadedmetadata();
  await flushAsyncWork();
  assert.equal(resolved, false);

  video.duration = 3.5;
  video.ondurationchange();
  const source = await loading;
  assert.equal(source.duration, 3.5);
});

await test('decode failure rejects and releases its object URL', async () => {
  const video = new FakeVideo();
  pendingVideo = video;

  const loading = loadVideoSource({ name: 'broken.mov' });
  video.onerror();

  await assert.rejects(loading, /could not be decoded/i);
  assert.deepEqual(revokedUrls, ['blob:test-0']);
});

await test('frame sync waits for seek before publishing a resized raster', async () => {
  const video = new FakeVideo({ width: 800, height: 450 });
  const raster = new FakeRaster(2, 2);

  syncVideoLayerFrames(
    [videoLayer(video, raster, { inPoint: 0.25 })],
    1,
    8,
  );

  assert.deepEqual(video.currentTimeWrites, [0.375]);
  assert.deepEqual(raster.draws, []);
  assert.equal(get(videoFrameRevision), 0);
  const pending = get(videoRasterStatus).get('video');
  assert.equal(pending.state, 'pending');

  video.readyState = 2;
  video.dispatch('seeked');
  await flushAsyncWork();

  assert.deepEqual(raster.draws, [
    { time: 0.375, x: 0, y: 0, width: 800, height: 450 },
  ]);
  assert.equal(raster.width, 800);
  assert.equal(raster.height, 450);
  assert.equal(get(videoFrameRevision), 1);
  assert.deepEqual(get(videoRasterStatus).get('video'), {
    ...pending,
    state: 'ready',
  });
});

await test('frame sync seeks every output tick inside one held frame', async () => {
  const video = new FakeVideo({ width: 320, height: 180, readyState: 2 });
  const raster = new FakeRaster();
  const layer = videoLayer(video, raster, { inPoint: 0.2 });

  syncVideoLayerFrames([layer], 0, 10);
  video.dispatch('seeked');
  await flushAsyncWork();
  const firstToken = get(videoRasterStatus).get('video').token;
  syncVideoLayerFrames([layer], 1, 10);
  video.dispatch('seeked');
  await flushAsyncWork();

  assert.deepEqual(video.currentTimeWrites, [0.2, 0.30000000000000004]);
  assert.deepEqual(raster.draws.map((draw) => Math.round(draw.time * 10) / 10), [0.2, 0.3]);
  assert.deepEqual(get(videoRasterStatus).get('video'), {
    clipId: 'video',
    assetId: 'source',
    projectTick: 1,
    token: firstToken + 1,
    state: 'ready',
  });
});

await test('a superseded seek cannot replace the preview with its stale frame', async () => {
  const video = new FakeVideo({ width: 320, height: 180 });
  const raster = new FakeRaster();

  syncVideoLayerFrames([videoLayer(video, raster)], 0, 10);
  const firstPending = get(videoRasterStatus).get('video');
  assert.equal(firstPending.projectTick, 0);
  assert.equal(firstPending.state, 'pending');
  syncVideoLayerFrames([videoLayer(video, raster)], 1, 10);
  const secondPending = get(videoRasterStatus).get('video');
  assert.equal(secondPending.projectTick, 1);
  assert.equal(secondPending.state, 'pending');
  assert.equal(secondPending.token, firstPending.token + 1);

  assert.deepEqual(video.currentTimeWrites, [0]);
  video.readyState = 2;
  video.dispatch('seeked');
  await flushAsyncWork();

  assert.deepEqual(raster.draws, []);
  assert.deepEqual(video.currentTimeWrites, [0, 0.1]);
  assert.deepEqual(get(videoRasterStatus).get('video'), secondPending);

  video.dispatch('seeked');
  await flushAsyncWork();
  assert.deepEqual(raster.draws, [
    { time: 0.1, x: 0, y: 0, width: 320, height: 180 },
  ]);
  assert.equal(get(videoFrameRevision), 1);
  assert.deepEqual(get(videoRasterStatus).get('video'), {
    ...secondPending,
    state: 'ready',
  });
});

await test('rapid held-frame requests coalesce to the newest tick', async () => {
  const video = new FakeVideo({ width: 320, height: 180, readyState: 2 });
  const raster = new FakeRaster();
  const layer = videoLayer(video, raster, { inPoint: 0.2 });

  syncVideoLayerFrames([layer], 0, 10);
  syncVideoLayerFrames([layer], 1, 10);
  syncVideoLayerFrames([layer], 2, 10);
  const latestPending = get(videoRasterStatus).get('video');
  assert.equal(latestPending.projectTick, 2);
  assert.deepEqual(video.currentTimeWrites, [0.2]);

  video.dispatch('seeked');
  await flushAsyncWork();
  assert.deepEqual(raster.draws, []);
  assert.deepEqual(video.currentTimeWrites, [0.2, 0.4]);
  assert.deepEqual(get(videoRasterStatus).get('video'), latestPending);

  video.dispatch('seeked');
  await flushAsyncWork();
  assert.deepEqual(raster.draws.map((draw) => draw.time), [0.4]);
  assert.equal(videoRasterReadyAt(get(videoRasterStatus).get('video'), {
    clipId: 'video', assetId: 'source', projectTick: 2,
  }), true);
  assert.equal(video.listeners.get('seeked').length, 0);
});

await test('continuous playback publishes decodable intermediate frames instead of freezing', async () => {
  const video = new FakeVideo({ width: 320, height: 180, readyState: 2 });
  const raster = new FakeRaster();
  const layer = videoLayer(video, raster);

  syncVideoLayerFrames([layer], 0, 24, { allowIntermediate: true });
  syncVideoLayerFrames([layer], 1, 24, { allowIntermediate: true });
  video.dispatch('seeked');
  await flushAsyncWork();

  assert.deepEqual(raster.draws.map((draw) => draw.time), [0]);
  assert.equal(get(videoRasterStatus).get('video').projectTick, 1);
  assert.equal(get(videoRasterStatus).get('video').state, 'pending');
});

await test('adjacent 24 fps frames are not mistaken for the same decoded time', async () => {
  const video = new FakeVideo({ width: 320, height: 180, readyState: 2 });
  const raster = new FakeRaster();

  syncVideoLayerFrames([videoLayer(video, raster)], 1, 24);
  assert.equal(video.currentTimeWrites.length, 1);
  assert.ok(Math.abs(video.currentTimeWrites[0] - 1 / 24) < 1e-9);
  assert.equal(get(videoRasterStatus).get('video').state, 'pending');

  video.dispatch('seeked');
  await flushAsyncWork();
  assert.equal(raster.draws.length, 1);
  assert.ok(Math.abs(raster.draws[0].time - 1 / 24) < 1e-9);
});

await test('restarting the same pending seek cannot publish the previous decoded frame', async () => {
  const video = new FakeVideo({ width: 320, height: 180, readyState: 2 });
  const raster = new FakeRaster();
  const layer = videoLayer(video, raster);

  syncVideoLayerFrames([layer], 1, 24);
  syncVideoLayerFrames([layer], 1, 24);
  await flushAsyncWork();
  assert.deepEqual(raster.draws, []);
  assert.equal(get(videoRasterStatus).get('video').state, 'pending');

  video.dispatch('seeked');
  await flushAsyncWork();
  assert.equal(raster.draws.length, 1);
  assert.ok(Math.abs(raster.draws[0].time - 1 / 24) < 1e-9);
});

await test('an inactive frame invalidates an older pending seek', async () => {
  const video = new FakeVideo({ width: 320, height: 180 });
  const raster = new FakeRaster();
  const layer = videoLayer(video, raster, { duration: 0.05 });

  syncVideoLayerFrames([layer], 0, 10);
  const pending = get(videoRasterStatus).get('video');
  syncVideoLayerFrames([layer], 1, 10);
  const inactive = get(videoRasterStatus).get('video');
  assert.equal(inactive.state, 'inactive');
  assert.equal(inactive.token, pending.token + 1);

  video.dispatch('seeked');
  await flushAsyncWork();

  assert.deepEqual(raster.draws, []);
  assert.equal(get(videoFrameRevision), 0);
  assert.deepEqual(get(videoRasterStatus).get('video'), inactive);
});

await test('an out-point change invalidates a ready raster at the same tick', async () => {
  const video = new FakeVideo({ width: 320, height: 180, readyState: 2 });
  const raster = new FakeRaster();
  const layer = videoLayer(video, raster);

  syncVideoLayerFrames([layer], 0, 10);
  video.dispatch('seeked');
  await flushAsyncWork();
  assert.equal(videoRasterReadyAt(get(videoRasterStatus).get('video'), {
    clipId: 'video', assetId: 'source', projectTick: 0,
  }), true);

  syncVideoLayerFrames([{ ...layer, videoClip: { ...layer.videoClip, duration: 0 } }], 0, 10);
  assert.equal(get(videoRasterStatus).get('video').state, 'inactive');
});

await test('an aborted inactive transition can immediately queue the active frame again', async () => {
  const video = new FakeVideo({ width: 320, height: 180 });
  const raster = new FakeRaster();
  const active = videoLayer(video, raster);

  syncVideoLayerFrames([active], 0, 10);
  syncVideoLayerFrames([{ ...active, videoClip: { ...active.videoClip, duration: 0 } }], 0, 10);
  assert.equal(get(videoRasterStatus).get('video').state, 'inactive');
  syncVideoLayerFrames([active], 0, 10);
  assert.equal(get(videoRasterStatus).get('video').state, 'pending');
  await flushAsyncWork();

  assert.deepEqual(video.currentTimeWrites, [0, 0]);
  video.readyState = 2;
  video.dispatch('seeked');
  await flushAsyncWork();
  assert.equal(videoRasterReadyAt(get(videoRasterStatus).get('video'), {
    clipId: 'video', assetId: 'source', projectTick: 0,
  }), true);
});

await test('a seek watchdog releases the newest queued tick', async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let nextTimer = 1;
  globalThis.setTimeout = (callback) => {
    const id = nextTimer++;
    timers.set(id, callback);
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  try {
    const video = new FakeVideo({ width: 320, height: 180 });
    const raster = new FakeRaster();
    const layer = videoLayer(video, raster);

    syncVideoLayerFrames([layer], 0, 10);
    syncVideoLayerFrames([layer], 1, 10);
    assert.deepEqual(video.currentTimeWrites, [0]);
    const [watchdogId, watchdog] = timers.entries().next().value;
    timers.delete(watchdogId);
    watchdog();
    await flushAsyncWork();

    assert.deepEqual(video.currentTimeWrites, [0, 0.1]);
    assert.equal(get(videoRasterStatus).get('video').projectTick, 1);
    video.readyState = 2;
    video.dispatch('seeked');
    await flushAsyncWork();
    assert.equal(videoRasterReadyAt(get(videoRasterStatus).get('video'), {
      clipId: 'video', assetId: 'source', projectTick: 1,
    }), true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

await test('removing a video invalidates its pending seek and status', async () => {
  const video = new FakeVideo({ width: 320, height: 180 });
  const raster = new FakeRaster();

  syncVideoLayerFrames([videoLayer(video, raster)], 0, 10);
  assert.equal(get(videoRasterStatus).get('video').state, 'pending');
  syncVideoLayerFrames([], 0, 10);
  assert.equal(get(videoRasterStatus).has('video'), false);

  video.dispatch('seeked');
  await flushAsyncWork();

  assert.deepEqual(raster.draws, []);
  assert.equal(get(videoFrameRevision), 0);
  assert.equal(get(videoRasterStatus).has('video'), false);
});

await test('hidden video references and references in hidden groups do not decode', async () => {
  const directVideo = new FakeVideo();
  const groupedVideo = new FakeVideo();
  const hidden = {
    ...videoLayer(directVideo, new FakeRaster()),
    id: 'hidden-video',
    visible: false,
  };
  const group = { id: 'hidden-group', type: 'group', visible: false };
  const grouped = {
    ...videoLayer(groupedVideo, new FakeRaster()),
    id: 'grouped-video',
    groupId: group.id,
    visible: true,
  };

  syncVideoLayerFrames([hidden, group, grouped], 0, 10);
  await flushAsyncWork();

  assert.deepEqual(directVideo.currentTimeWrites, []);
  assert.deepEqual(groupedVideo.currentTimeWrites, []);
  assert.equal(get(videoRasterStatus).size, 0);
});

await test('a hidden video decodes only while conversion explicitly requests its frame', async () => {
  const video = new FakeVideo();
  const hidden = {
    ...videoLayer(video, new FakeRaster()),
    id: 'hidden-video',
    visible: false,
  };
  const release = requestVideoFrameDecode(hidden.id);

  try {
    const requestedClipIds = new Set(get(videoDecodeRequests).keys());
    syncVideoLayerFrames([hidden], 0, 10, { requestedClipIds });

    assert.deepEqual(video.currentTimeWrites, [0]);
    assert.equal(get(videoRasterStatus).get(hidden.id).state, 'pending');
  } finally {
    release();
  }

  syncVideoLayerFrames([hidden], 0, 10, {
    requestedClipIds: new Set(get(videoDecodeRequests).keys()),
  });
  assert.equal(get(videoRasterStatus).has(hidden.id), false);
});

await test('a failed decoded frame stays recoverable while hidden and clears when removed', async () => {
  const video = new FakeVideo({ width: 320, height: 180 });
  const raster = new FakeRaster();
  const layer = videoLayer(video, raster);

  syncVideoLayerFrames([layer], 0, 10);
  video.dispatch('error');
  await flushAsyncWork();
  const status = get(videoRasterStatus).get('video');

  assert.equal(status.state, 'error');
  assert.equal(canRelinkVideo(layer, status), true);

  const hidden = { ...layer, visible: false };
  syncVideoLayerFrames([hidden], 0, 10);
  const hiddenStatus = get(videoRasterStatus).get('video');
  assert.equal(hiddenStatus.state, 'error');
  assert.equal(canRelinkVideo(hidden, hiddenStatus), true);

  syncVideoLayerFrames([], 0, 10);
  assert.equal(get(videoRasterStatus).has('video'), false);
});

await test('removing and immediately reusing a layer id rejects the old completion', async () => {
  const oldVideo = new FakeVideo({ width: 320, height: 180 });
  const oldRaster = new FakeRaster();
  const newVideo = new FakeVideo({ width: 640, height: 360 });
  const newRaster = new FakeRaster();

  syncVideoLayerFrames([videoLayer(oldVideo, oldRaster)], 0, 10);
  const oldToken = get(videoRasterStatus).get('video').token;
  syncVideoLayerFrames([], 0, 10);
  syncVideoLayerFrames([videoLayer(newVideo, newRaster)], 0, 10);
  await flushAsyncWork();
  const newToken = get(videoRasterStatus).get('video').token;
  assert.notEqual(newToken, oldToken);

  oldVideo.readyState = 2;
  oldVideo.dispatch('seeked');
  newVideo.readyState = 2;
  newVideo.dispatch('seeked');
  await flushAsyncWork();
  assert.deepEqual(oldRaster.draws, []);
  assert.equal(newRaster.draws.length, 1);
  assert.equal(get(videoRasterStatus).get('video').token, newToken);
});

await test('missing video, missing raster, and inactive clips publish nothing', async () => {
  const unusedVideo = new FakeVideo();
  const inactiveVideo = new FakeVideo();
  const untouchedRaster = new FakeRaster();

  syncVideoLayerFrames([
    videoLayer(null, untouchedRaster),
    videoLayer(unusedVideo, null),
    videoLayer(inactiveVideo, untouchedRaster, { startTick: 3 }),
    { type: 'glyph', videoElement: unusedVideo, raster: untouchedRaster },
  ], 0, 10);

  await flushAsyncWork();

  assert.deepEqual(unusedVideo.currentTimeWrites, []);
  assert.deepEqual(inactiveVideo.currentTimeWrites, []);
  assert.deepEqual(untouchedRaster.draws, []);
  assert.equal(get(videoFrameRevision), 0);
});

console.log();
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
