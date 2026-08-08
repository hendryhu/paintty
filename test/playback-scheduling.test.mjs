import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { layers } from '../src/lib/grid.js';
import * as F from '../src/lib/frames.js';
import { loadAudioState, resetAudioState } from '../src/lib/audio.js';
import { transactClipTimeline } from '../src/lib/clipTimelineState.js';
import { videoFramePlan } from '../src/lib/fileio.js';

const SOURCE_TICKS = 720;
const PLAYBACK_FPS = 24;
const glyphs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function cellsAt(tick) {
  return {
    '0,0': { c: glyphs[Math.floor(tick / glyphs.length)], fg: '#ffffff', bg: null },
    '1,0': { c: glyphs[tick % glyphs.length], fg: '#ffffff', bg: null },
  };
}

const LOOP_START_ID = '10000000-0000-4000-8000-000000000101';
const LOOP_END_ID = '10000000-0000-4000-8000-000000000102';

function loadSequence(ticks = SOURCE_TICKS, tags = []) {
  F.fps.set(PLAYBACK_FPS);
  F.loadCanonicalTimeline({
    fps: PLAYBACK_FPS,
    tracks: [{
      id: 'playback-track', kind: 'visual', locked: false,
      layer: {
        id: 'playback-layer', name: 'Animated layer', type: 'cell', visible: true,
        blink: true, cells: {}, offset: { x: 0, y: 0 },
      },
    }],
    clips: [{
      id: 'playback-clip', trackId: 'playback-track', kind: 'visual',
      startTick: 0, inTick: 0, outTick: ticks, sourceDuration: ticks,
      frameKeys: Array.from({ length: ticks }, (_, tick) => ({
        tick,
        value: { cells: cellsAt(tick) },
      })),
      propertyTracks: {
        position: [
          { tick: 0, value: { x: 0, y: 0, interpolation: 'linear' } },
          { tick: ticks - 1, value: { x: ticks - 1, y: 0, interpolation: 'linear' } },
        ],
      },
    }],
    tags,
  });
  F.seekTick(0);
}

function liveSignature() {
  const cells = get(layers)[0]?.cells || {};
  return `${cells['0,0']?.c || ''}${cells['1,0']?.c || ''}`;
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realPerformanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
let virtualNow = 0;
let simulatedPaintCost = 0;
let nextTimerId = 1;
const pending = [];
const delays = [];
Object.defineProperty(globalThis, 'performance', {
  configurable: true,
  value: { now: () => virtualNow },
});
globalThis.setTimeout = (fn, delay = 0) => {
  const task = { id: nextTimerId++, fn, delay, cancelled: false };
  pending.push(task);
  delays.push(delay);
  return task.id;
};
globalThis.clearTimeout = (id) => {
  const task = pending.find((candidate) => candidate.id === id);
  if (task) task.cancelled = true;
};
function runNextTimer(lateness = 0) {
  let task;
  while ((task = pending.shift())) {
    if (task.cancelled) continue;
    virtualNow += task.delay + lateness;
    task.fn();
    return;
  }
  throw new Error('Playback did not schedule another tick.');
}
function resetClock() {
  virtualNow = 0;
  pending.length = 0;
  delays.length = 0;
  simulatedPaintCost = 0;
}

let framePublications = 0;
let layerPublications = 0;
const unsubscribeFrames = F.frames.subscribe(() => framePublications++);
const unsubscribeLayers = layers.subscribe(() => {
  layerPublications++;
  if (simulatedPaintCost && get(F.playing)) virtualNow += simulatedPaintCost;
});

try {
  loadSequence();
  F.looping.set(false);
  assert.equal(get(F.frames).length, SOURCE_TICKS);
  assert.deepEqual(get(F.frames)[360].layers[0].offset, { x: 360, y: 0 });

  const frameBaseline = framePublications;
  const layerBaseline = layerPublications;
  const projection = get(F.frames);
  const signatures = [liveSignature()];
  F.play();
  while (get(F.playing)) {
    runNextTimer();
    const signature = liveSignature();
    if (signature !== signatures.at(-1)) signatures.push(signature);
  }
  assert.equal(get(F.activeFrameIndex), 719);
  assert.equal(get(F.playheadTick), 719);
  assert.equal(get(F.activeFrameTick), 0);
  assert.equal(get(F.frames) === projection, false,
    'the resolved facade republishes once when playback settles, not on every tick');
  assert.equal(framePublications - frameBaseline, 1);
  assert.equal(layerPublications - layerBaseline, SOURCE_TICKS - 1);
  assert.deepEqual(signatures, Array.from({ length: SOURCE_TICKS }, (_, tick) =>
    `${glyphs[Math.floor(tick / glyphs.length)]}${glyphs[tick % glyphs.length]}`));
  assert.deepEqual(get(layers)[0].offset, { x: 719, y: 0 });
  assert.equal(get(layers)[0].blink, true);
  assert.equal(Math.round(virtualNow), 30_000);
  assert.equal(delays.every((delay) => Math.abs(delay - 1000 / PLAYBACK_FPS) < 0.001), true);

  loadSequence();
  F.looping.set(false);
  resetClock();
  simulatedPaintCost = 55;
  let timerCalls = 0;
  F.play();
  while (get(F.playing) && timerCalls <= SOURCE_TICKS) {
    runNextTimer();
    timerCalls++;
  }
  simulatedPaintCost = 0;
  assert.equal(get(F.activeFrameIndex), 719);
  assert.equal(timerCalls < SOURCE_TICKS, true,
    'overdue ticks are skipped rather than accumulating one timer per render');
  assert.equal(Math.abs(virtualNow - 30_000) <= 56, true);

  loadSequence(8);
  resetClock();
  F.looping.set(false);
  F.play();
  runNextTimer((1000 / PLAYBACK_FPS) * 3.5);
  assert.equal(get(F.playheadTick), 4,
    'a late callback publishes its deadline-derived catch-up tick immediately');
  assert.equal(liveSignature(), '04');
  assert.equal(get(F.playing), true);
  F.stop({ preserveTick: true });

  loadSequence(6);
  resetClock();
  F.looping.set(false);
  let stoppedView = null;
  let playbackStarted = false;
  const unsubscribeDelayedStop = F.playing.subscribe((active) => {
    if (active) playbackStarted = true;
    else if (playbackStarted) {
      stoppedView = { tick: get(F.playheadTick), signature: liveSignature() };
    }
  });
  F.play();
  runNextTimer((1000 / PLAYBACK_FPS) * 20);
  unsubscribeDelayedStop();
  assert.deepEqual(stoppedView, { tick: 5, signature: '05' },
    'a callback delayed beyond the sequence publishes the final canvas before stopping');
  assert.equal(get(F.playing), false);

  loadSequence(8);
  resetClock();
  F.looping.set(false);
  F.play();
  for (let tick = 0; tick < 3; tick++) runNextTimer();
  assert.equal(liveSignature(), '03');
  transactClipTimeline('shrink-during-playback', (state) => {
    const clip = state.clips[0];
    clip.outTick = 2;
    clip.sourceDuration = 2;
    clip.frameKeys = clip.frameKeys.filter((key) => key.tick < 2);
    clip.propertyTracks.position = clip.propertyTracks.position.filter((key) => key.tick < 2);
    return { state, changed: true };
  });
  assert.equal(get(F.playheadTick), 1, 'duration shrink clamps canonical transport state');
  assert.equal(liveSignature(), '03', 'the scheduler still owns the pending canvas publication');
  runNextTimer();
  assert.equal(get(F.playing), false);
  assert.equal(get(F.playheadTick), 1);
  assert.equal(liveSignature(), '01', 'duration shrink publishes its exact final tick before stop');

  loadSequence(4);
  resetClock();
  F.looping.set(false);
  F.play();
  runNextTimer();
  transactClipTimeline('extend-during-playback', (state) => {
    const clip = state.clips[0];
    clip.outTick = 6;
    clip.sourceDuration = 6;
    clip.frameKeys.push(
      { tick: 4, value: { cells: cellsAt(4) } },
      { tick: 5, value: { cells: cellsAt(5) } },
    );
    clip.propertyTracks.position.push({
      tick: 5,
      value: { x: 5, y: 0, interpolation: 'linear' },
    });
    return { state, changed: true };
  });
  while (get(F.playing)) runNextTimer();
  assert.equal(get(F.playheadTick), 5, 'duration extension is observed on the next deadline');
  assert.equal(liveSignature(), '05');

  loadSequence(4);
  resetClock();
  F.looping.set(true);
  const loopTicks = [];
  const unsubscribeLoop = F.playheadTick.subscribe((tick) => {
    if (get(F.playing)) loopTicks.push(tick);
  });
  F.play();
  for (let tick = 0; tick < 5; tick++) runNextTimer();
  F.stop({ preserveTick: true });
  unsubscribeLoop();
  assert.deepEqual(loopTicks, [1, 2, 3, 0, 1]);

  loadSequence(8, [
    { id: LOOP_END_ID, tick: 4, type: 'loop-end' },
    { id: LOOP_START_ID, tick: 2, type: 'loop-start' },
  ]);
  resetClock();
  F.looping.set(true);
  F.seekTick(0);
  F.play();
  assert.equal(get(F.playheadTick), 2, 'playback outside a valid loop starts at loop start');
  let rangeCycleId = get(F.playbackCycle).id;
  const rangeCycles = [];
  const unsubscribeRangeCycles = F.playbackCycle.subscribe((cycle) => {
    if (cycle.id === rangeCycleId) return;
    rangeCycleId = cycle.id;
    rangeCycles.push(cycle.tick);
  });
  const rangedTicks = [];
  const unsubscribeRange = F.playheadTick.subscribe((tick) => {
    if (get(F.playing)) rangedTicks.push(tick);
  });
  for (let tick = 0; tick < 4; tick++) runNextTimer();
  F.stop({ preserveTick: true });
  unsubscribeRange();
  unsubscribeRangeCycles();
  assert.deepEqual(rangedTicks, [2, 3, 4, 2, 3], 'inclusive loop end wraps to loop start');
  assert.deepEqual(rangeCycles, [2], 'a multi-tick loop publishes one cycle event at wrap');

  loadSequence(8, [
    { id: LOOP_START_ID, tick: 5, type: 'loop-start' },
    { id: LOOP_END_ID, tick: 2, type: 'loop-end' },
  ]);
  resetClock();
  F.looping.set(true);
  F.seekTick(7);
  F.play();
  runNextTimer();
  assert.equal(get(F.playheadTick), 0, 'a reversed loop pair falls back to the full sequence');
  F.stop({ preserveTick: true });

  loadSequence(8, [{ id: LOOP_START_ID, tick: 2, type: 'loop-start' }]);
  resetClock();
  F.looping.set(true);
  F.seekTick(7);
  F.play();
  runNextTimer();
  assert.equal(get(F.playheadTick), 2, 'a loop start without an end wraps after the inclusive sequence end');
  F.stop({ preserveTick: true });

  loadSequence(8, [{ id: LOOP_END_ID, tick: 5, type: 'loop-end' }]);
  resetClock();
  F.looping.set(true);
  F.seekTick(7);
  F.play();
  runNextTimer();
  assert.equal(get(F.playheadTick), 0, 'a loop end without a start retains full-sequence looping');
  F.stop({ preserveTick: true });

  loadSequence(8, [
    { id: LOOP_START_ID, tick: 2, type: 'loop-start' },
    { id: LOOP_END_ID, tick: 4, type: 'loop-end' },
  ]);
  resetClock();
  F.looping.set(false);
  F.seekTick(0);
  F.play();
  while (get(F.playing)) runNextTimer();
  assert.equal(get(F.playheadTick), 7, 'Loop off ignores markers and stops at sequence end');

  loadSequence(8, [
    { id: LOOP_START_ID, tick: 3, type: 'loop-start' },
    { id: LOOP_END_ID, tick: 3, type: 'loop-end' },
  ]);
  resetClock();
  F.looping.set(true);
  F.seekTick(0);
  assert.equal(F.play(), true);
  assert.equal(get(F.playheadTick), 3);
  let singleTickCycleId = get(F.playbackCycle).id;
  const singleTickCycles = [];
  const unsubscribeSingleTickCycles = F.playbackCycle.subscribe((cycle) => {
    if (cycle.id === singleTickCycleId) return;
    singleTickCycleId = cycle.id;
    singleTickCycles.push(cycle.tick);
  });
  runNextTimer();
  assert.equal(get(F.playheadTick), 3, 'start=end forms a one-tick loop');
  runNextTimer();
  assert.deepEqual(singleTickCycles, [3, 3], 'same-tick wraps publish every playback cycle');
  unsubscribeSingleTickCycles();
  F.stop({ preserveTick: true });

  loadSequence(1, [
    { id: LOOP_START_ID, tick: 0, type: 'loop-start' },
    { id: LOOP_END_ID, tick: 0, type: 'loop-end' },
  ]);
  resetClock();
  F.looping.set(true);
  assert.equal(F.play(), true, 'a one-tick sequence can run until explicitly stopped');
  runNextTimer();
  assert.equal(get(F.playheadTick), 0);
  F.stop({ preserveTick: true });

  loadSequence(4);
  resetClock();
  F.looping.set(true);
  F.seekTick(2);
  F.play();
  runNextTimer();
  F.gotoFrame(1);
  assert.equal(get(F.playing), false);
  assert.equal(get(F.playheadTick), 1);

  layers.set([]);
  F.initTimeline([]);
  resetAudioState();
  loadAudioState({
    assets: [{ id: 'loop-audio', sourceName: 'Loop', duration: 4 / PLAYBACK_FPS }],
    tracks: [{
      id: 'loop-audio-track', name: 'Loop', clips: [{
        id: 'loop-audio-clip', assetId: 'loop-audio', startTick: 0,
        inPoint: 0, outPoint: 4 / PLAYBACK_FPS, duration: 4 / PLAYBACK_FPS,
        volume: 1, muted: false,
      }],
    }],
  });
  await Promise.resolve();
  resetClock();
  F.looping.set(true);
  const audioTicks = [];
  const unsubscribeAudio = F.playheadTick.subscribe((tick) => {
    if (get(F.playing)) audioTicks.push(tick);
  });
  F.play();
  for (let tick = 0; tick < 4; tick++) runNextTimer();
  F.stop({ preserveTick: true });
  unsubscribeAudio();
  assert.equal(get(F.durationTicks), 4);
  assert.deepEqual(audioTicks, [1, 2, 3, 0]);
  resetAudioState();
} finally {
  F.stop({ preserveTick: true });
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  if (realPerformanceDescriptor) {
    Object.defineProperty(globalThis, 'performance', realPerformanceDescriptor);
  } else {
    delete globalThis.performance;
  }
  unsubscribeFrames();
  unsubscribeLayers();
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

for (let seed = 1; seed <= 64; seed++) {
  const random = seededRandom(seed);
  const definitions = Array.from({ length: 5 + Math.floor(random() * 50) }, () => ({
    hold: 1 + Math.floor(random() * 5),
  }));
  const rate = 1 + Math.floor(random() * 60);
  const expected = definitions.flatMap((frame, sourceIndex) =>
    Array.from({ length: frame.hold }, (_, tick) => ({ sourceIndex, tick })));
  const plan = videoFramePlan(definitions, rate);
  assert.equal(plan.length, expected.length);
  plan.forEach((sample, index) => {
    assert.deepEqual({ sourceIndex: sample.sourceIndex, tick: sample.tick }, expected[index]);
    assert.ok(Math.abs(sample.timestamp - index / rate) < 1e-12);
    assert.ok(Math.abs(sample.duration - 1 / rate) < 1e-12);
  });
}

console.log('canonical playback scheduling tests passed');
