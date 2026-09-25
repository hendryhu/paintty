import assert from 'node:assert/strict';
import {
  mediaHashesFromProject,
  planMediaCacheSweep,
  runMediaCacheGc,
} from '../src/lib/mediaGc.ts';
import { loadMediaRegistry } from '../src/lib/mediaRegistry.ts';
import { withMediaLease } from '../src/lib/projectAssets.ts';
import {
  projectAssetRecord,
  type MediaAsset,
} from './types/timeline-media-test-types.ts';

const hash = (digit: string): string => digit.repeat(64);
const uuid = (tail: string | number): string => `10000000-0000-4000-8000-${String(tail).padStart(12, '0')}`;
const audioAsset = (tail: string | number, digit: string): MediaAsset => ({
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
  projectAssetRecord(hash('1'), now - 99, 0),
  projectAssetRecord(hash('2'), now - 100, 0),
  projectAssetRecord(hash('3'), now - 101, 0),
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
].map((value) => projectAssetRecord(value, 0, 0));
let removed: string[] = [];
const result = await withMediaLease(inFlightHash, () => runMediaCacheGc({
  now,
  gracePeriodMs,
  historyHashes: [historyHash],
  resourceHashes: [resourceHash],
  storedProjects,
  list: async () => records,
  remove: async (hashes) => {
    removed = [...hashes].map(String);
    return removed.length;
  },
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
  list: async () => [projectAssetRecord(inFlightHash, 0, 0)],
  remove: async (hashes) => {
    removed = [...hashes].map(String);
    return removed.length;
  },
});
assert.deepEqual(removed, [inFlightHash], 'an expired lease-free unmarked record is swept');

console.log('media GC tests passed');
