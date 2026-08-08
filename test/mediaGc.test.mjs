import assert from 'node:assert/strict';
import {
  mediaHashesFromProject,
  planMediaCacheSweep,
  runMediaCacheGc,
} from '../src/lib/mediaGc.js';
import { loadMediaRegistry } from '../src/lib/mediaRegistry.js';
import { withMediaLease } from '../src/lib/projectAssets.js';

const hash = (digit) => digit.repeat(64);
const uuid = (tail) => `10000000-0000-4000-8000-${String(tail).padStart(12, '0')}`;
const audioAsset = (tail, digit) => ({
  assetId: uuid(tail),
  hash: hash(digit),
  path: `assets/sha256/${digit}${digit}/${hash(digit)}`,
  sourceName: `${digit}.wav`,
  mime: 'audio/wav',
  size: 1,
  kind: 'audio',
  duration: 1,
  generation: 1,
});

const now = 10_000;
const gracePeriodMs = 100;
assert.deepEqual(planMediaCacheSweep([
  { hash: hash('1'), createdAt: now - 99, lastAccessedAt: 0 },
  { hash: hash('2'), createdAt: now - 100, lastAccessedAt: 0 },
  { hash: hash('3'), createdAt: now - 101, lastAccessedAt: 0 },
], new Set(), { now, gracePeriodMs }), [hash('2'), hash('3')],
'the grace boundary is retained before expiry and swept at expiry');

const activeHash = hash('a');
const historyHash = hash('b');
const storedHash = hash('c');
const inFlightHash = hash('d');
const resourceHash = hash('e');
const expiredHash = hash('f');
const recentHash = hash('1');
loadMediaRegistry({ generation: 1, assets: [audioAsset(1, 'a')] });

const storedProjects = [
  JSON.stringify({ media: { assets: [{ hash: storedHash }] } }),
  new Blob([JSON.stringify({ media: { assets: [{ hash: recentHash }] } })]),
];
assert.deepEqual([...mediaHashesFromProject(storedProjects[0])], [storedHash]);

const records = [
  activeHash,
  historyHash,
  storedHash,
  inFlightHash,
  resourceHash,
  expiredHash,
  recentHash,
].map((value) => ({ hash: value, createdAt: 0, lastAccessedAt: 0 }));
let removed = [];
const result = await withMediaLease(inFlightHash, () => runMediaCacheGc({
  now,
  gracePeriodMs,
  historyHashes: [historyHash],
  resourceHashes: [resourceHash],
  storedProjects,
  list: async () => records,
  remove: async (hashes) => { removed = [...hashes]; },
}));
assert.deepEqual(removed, [expiredHash]);
assert.deepEqual(result.deleted, [expiredHash]);
for (const marked of [activeHash, historyHash, storedHash, inFlightHash, resourceHash, recentHash]) {
  assert.equal(result.marked.has(marked), true, `GC marks ${marked}`);
}

removed = [];
await runMediaCacheGc({
  markedHashes: [],
  storedProjects: [],
  now,
  gracePeriodMs,
  list: async () => [{ hash: inFlightHash, createdAt: 0, lastAccessedAt: 0 }],
  remove: async (hashes) => { removed = [...hashes]; },
});
assert.deepEqual(removed, [inFlightHash], 'an expired lease-free unmarked record is swept');

console.log('media GC tests passed');
