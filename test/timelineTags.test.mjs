import assert from 'node:assert/strict';
import {
  clampTimelineTags,
  nextPlaybackTick,
  normalizeTimelineTags,
  playbackStartTick,
  runtimeTimelineTags,
  validLoopRange,
} from '../src/lib/timelineTags.js';

const ids = {
  start: '10000000-0000-4000-8000-000000000001',
  end: '20000000-0000-4000-8000-000000000002',
  customA: '30000000-0000-4000-8000-000000000003',
  customB: '40000000-0000-4000-8000-000000000004',
};

const tags = normalizeTimelineTags([
  { id: ids.end, tick: 4, type: 'loop-end' },
  { id: ids.customB, tick: 2, type: 'custom', value: '世界' },
  { id: ids.start, tick: 1, type: 'loop-start' },
  { id: ids.customA, tick: 2, type: 'custom', value: 'alpha' },
]);
assert.deepEqual(validLoopRange(tags, 5), { startTick: 1, endTick: 4 });
assert.equal(playbackStartTick(0, tags, 5, true), 1);
assert.equal(playbackStartTick(3, tags, 5, true), 3);
assert.deepEqual(nextPlaybackTick(4, tags, 5, true), {
  tick: 1, stopped: false, wrapped: true,
});
assert.deepEqual(nextPlaybackTick(0, tags, 5, true), {
  tick: 1, stopped: false, wrapped: true,
});
assert.deepEqual(nextPlaybackTick(4, tags, 5, false), {
  tick: 4, stopped: true, wrapped: false,
});

assert.deepEqual(runtimeTimelineTags(tags, 5), [
  { tick: 1, type: 'loop-start' },
  { tick: 2, type: 'custom', value: 'alpha' },
  { tick: 2, type: 'custom', value: '世界' },
  { tick: 4, type: 'loop-end' },
]);
assert.equal(JSON.stringify(runtimeTimelineTags(tags, 5)).includes(ids.start), false);

assert.deepEqual(clampTimelineTags(tags, 2).map((tag) => tag.tick), [1, 1, 1, 1]);
assert.deepEqual(validLoopRange([
  { id: ids.start, tick: 3, type: 'loop-start' },
  { id: ids.end, tick: 2, type: 'loop-end' },
], 5), null);
assert.deepEqual(validLoopRange([{ id: ids.start, tick: 2, type: 'loop-start' }], 5), {
  startTick: 2,
  endTick: 4,
});
assert.equal(playbackStartTick(0, [{ id: ids.start, tick: 2, type: 'loop-start' }], 5, true), 2);
assert.deepEqual(nextPlaybackTick(4, [{ id: ids.start, tick: 2, type: 'loop-start' }], 5, true), {
  tick: 2, stopped: false, wrapped: true,
});
assert.equal(validLoopRange([{ id: ids.end, tick: 3, type: 'loop-end' }], 5), null);
assert.deepEqual(validLoopRange([{ id: ids.start, tick: 0, type: 'loop-start' }], 1), {
  startTick: 0,
  endTick: 0,
});
assert.deepEqual(validLoopRange([
  { id: ids.start, tick: 0, type: 'loop-start' },
  { id: ids.end, tick: 0, type: 'loop-end' },
], 1), { startTick: 0, endTick: 0 });

for (const malformed of [
  [{ id: 'not-a-uuid', tick: 0, type: 'custom', value: 'event' }],
  [{ id: ids.customA, tick: -1, type: 'custom', value: 'event' }],
  [{ id: ids.customA, tick: 0.5, type: 'custom', value: 'event' }],
  [{ id: ids.customA, tick: 0, type: 'unknown' }],
  [{ id: ids.customA, tick: 0, type: 'custom', value: '' }],
  [{ id: ids.customA, tick: 0, type: 'custom', value: ' event ' }],
  [{ id: ids.start, tick: 0, type: 'loop-start', value: 'forbidden' }],
  [{ id: ids.customA, tick: 0, type: 'custom', value: 'event', extra: true }],
  [
    { id: ids.start, tick: 0, type: 'loop-start' },
    { id: ids.end, tick: 1, type: 'loop-start' },
  ],
  [
    { id: ids.customA, tick: 0, type: 'custom', value: 'a' },
    { id: ids.customA.toUpperCase(), tick: 0, type: 'custom', value: 'b' },
  ],
]) assert.throws(() => normalizeTimelineTags(malformed));

assert.throws(() => runtimeTimelineTags(tags, 4), /inside the exported sequence/);
console.log('timeline tag validation, ordering, and loop tests passed');
