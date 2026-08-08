import assert from 'node:assert/strict';
import {
  createMediaResourceManager,
  StaleMediaResourceError,
} from '../src/lib/mediaResources.js';

const uuid = (tail) => `00000000-0000-4000-8000-${String(tail).padStart(12, '0')}`;
const hash = (digit) => digit.repeat(64);
const asset = (tail, digit, kind = 'image') => ({
  assetId: uuid(tail),
  hash: hash(digit),
  kind,
});

{
  let decodeCount = 0;
  let complete;
  const manager = createMediaResourceManager({
    decode() {
      decodeCount++;
      return new Promise((resolve) => { complete = resolve; });
    },
  });
  const source = asset(1, '1');
  assert.equal(decodeCount, 0, 'constructing the manager performs no eager decode');
  const firstPending = manager.acquire(source);
  const secondPending = manager.acquire(source);
  await Promise.resolve();
  assert.equal(decodeCount, 1, 'concurrent acquisition coalesces one decode');
  const decoded = { id: 'coalesced' };
  complete(decoded);
  const [first, second] = await Promise.all([firstPending, secondPending]);
  assert.equal(first.value, decoded);
  assert.equal(second.value, decoded);
  assert.equal(manager.inspect()[0].refs, 2);
  first.release();
  first.release();
  assert.equal(manager.inspect()[0].refs, 1, 'release tokens are idempotent');
  second.release();
  assert.equal(manager.inspect()[0].refs, 0);
  manager.clear();
}

{
  let current = true;
  let complete;
  const disposed = [];
  const source = asset(2, '2');
  const manager = createMediaResourceManager({
    decode() {
      return new Promise((resolve) => { complete = resolve; });
    },
    dispose(value) { disposed.push(value.id); },
    isCurrent() { return current; },
  });
  const pending = manager.acquire(source);
  await Promise.resolve();
  current = false;
  manager.invalidateAsset(source.assetId);
  complete({ id: 'stale' });
  await assert.rejects(pending, StaleMediaResourceError);
  assert.deepEqual(disposed, ['stale'], 'a stale completion is disposed exactly once');
  manager.clear();
  assert.deepEqual(disposed, ['stale']);
}

{
  let clock = 0;
  const disposed = [];
  const manager = createMediaResourceManager({
    decode(source) { return { id: source.assetId }; },
    dispose(value) { disposed.push(value.id); },
    now() { return ++clock; },
    capacities: { image: 1 },
  });
  const firstAsset = asset(3, '3');
  const secondAsset = asset(4, '4');
  const first = await manager.acquire(firstAsset);
  first.release();
  const second = await manager.acquire(secondAsset);
  second.release();
  assert.deepEqual(disposed, [firstAsset.assetId], 'LRU evicts the oldest idle resource');
  manager.invalidateAsset(secondAsset.assetId);
  assert.deepEqual(disposed, [firstAsset.assetId, secondAsset.assetId]);
  manager.clear();
  assert.deepEqual(disposed, [firstAsset.assetId, secondAsset.assetId],
    'eviction and clear never dispose one value twice');
}

{
  const disposed = [];
  const source = asset(5, '5', 'video');
  const manager = createMediaResourceManager({
    decode() { return { id: 'active-video' }; },
    dispose(value) { disposed.push(value.id); },
  });
  const lease = await manager.acquire(source);
  manager.invalidateAsset(source.assetId);
  assert.deepEqual(disposed, [], 'invalidation does not dispose an actively leased value');
  assert.equal(manager.activeHashes().has(source.hash), true,
    'an invalidated active lease remains reachable to persistent-byte GC');
  lease.release();
  assert.deepEqual(disposed, ['active-video'],
    'an invalidated value is disposed on its final release');
  assert.equal(manager.activeHashes().has(source.hash), false);
  lease.release();
  manager.clear();
  assert.deepEqual(disposed, ['active-video']);
}

{
  let complete;
  const disposed = [];
  const source = asset(6, '6');
  const manager = createMediaResourceManager({
    decode() { return new Promise((resolve) => { complete = resolve; }); },
    dispose(value) { disposed.push(value.id); },
  });
  const pending = manager.acquire(source);
  await Promise.resolve();
  manager.clear();
  complete({ id: 'cleared-pending' });
  await assert.rejects(pending, StaleMediaResourceError);
  assert.deepEqual(disposed, ['cleared-pending'],
    'clearing during decode rejects and disposes late completion exactly once');
}

console.log('media resource manager tests passed');
