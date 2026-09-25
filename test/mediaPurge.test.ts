import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'svelte/store';
import { loadJSON, serializeJSON } from '../src/lib/fileio.ts';
import { authoredRevision, canRedo, canUndo, undo } from '../src/lib/grid.ts';
import { purgeUnusedMedia } from '../src/lib/mediaCommands.ts';
import { mediaPackagePath } from '../src/lib/mediaHash.ts';
import { currentMediaRegistry } from '../src/lib/mediaRegistry.ts';
import {
  canPurgeUnusedMedia,
  formatByteSize,
  planUnusedMediaPurge,
  unusedMediaAssets,
} from '../src/lib/mediaPurge.ts';
import { playing } from '../src/lib/playbackState.ts';
import type {
  AudioMediaAsset,
  ImageMediaAsset,
  MediaAsset,
  MediaRegistry,
} from '../src/lib/types/media-types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const hashC = 'c'.repeat(64);
const id = (digit: string): string => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

function asset(
  assetId: string,
  hash: string,
  size: number,
  sourceName = `${assetId}.bin`,
): AudioMediaAsset {
  return {
    assetId,
    hash,
    path: mediaPackagePath(hash),
    sourceName,
    mime: 'audio/wav',
    size,
    kind: 'audio',
    duration: 1,
    generation: 1,
  };
}

const usedId = id('1');
const unusedAId = id('2');
const unusedBId = id('3');
const unusedCId = id('4');
const registry: MediaRegistry = {
  generation: 4,
  assets: [
    asset(usedId, hashA, 10, 'used.wav'),
    asset(unusedAId, hashA, 10, 'shared-unused.wav'),
    asset(unusedBId, hashB, 20, 'unused-one.ogg'),
    asset(unusedCId, hashB, 20, 'unused-two.ogg'),
  ],
};
const usage = new Map([[usedId, 1]]);
assert.deepEqual(unusedMediaAssets(registry, usage).map((entry) => entry.assetId), [
  unusedAId,
  unusedBId,
  unusedCId,
]);

const serializedProject = '{"label":"世界"}';
const plan = planUnusedMediaPurge({ registry, usageCounts: usage, serializedProject });
assert.deepEqual(plan.assets.map((entry) => entry.sourceName), [
  'shared-unused.wav',
  'unused-one.ogg',
  'unused-two.ogg',
]);
assert.equal(plan.freedBytes, 20,
  'a used logical asset retains its shared hash while two unused aliases free one other hash');
assert.equal(plan.totalBytes, new TextEncoder().encode(serializedProject).byteLength + 30,
  'project total counts UTF-8 JSON and each unique media hash exactly once');

assert.deepEqual(planUnusedMediaPurge({
  registry: { generation: 0, assets: [] },
  usageCounts: new Map(),
  serializedProject: '{}',
}), {
  assets: [],
  freedBytes: 0,
  totalBytes: 2,
}, 'zero assets has only serialized project bytes');

assert.equal(planUnusedMediaPurge({
  registry: { generation: 1, assets: [asset(unusedAId, hashA, 10)] },
  usageCounts: new Map(),
  serializedProject: '',
}).freedBytes, 10, 'one unused asset frees its bytes');
assert.equal(planUnusedMediaPurge({
  registry: {
    generation: 2,
    assets: [asset(unusedAId, hashC, 40), asset(unusedBId, hashC, 40)],
  },
  usageCounts: new Map(),
  serializedProject: '',
}).freedBytes, 40, 'many unused logical assets sharing bytes free one hash');
assert.equal(planUnusedMediaPurge({
  registry: {
    generation: 2,
    assets: [asset(usedId, hashC, 40), asset(unusedAId, hashC, 40)],
  },
  usageCounts: new Map([[usedId, 1]]),
  serializedProject: '',
}).freedBytes, 0, 'an unused alias cannot free a hash retained by a used asset');

assert.deepEqual([
  formatByteSize(0),
  formatByteSize(1023),
  formatByteSize(1024),
  formatByteSize(1536),
  formatByteSize(1024 ** 2),
  formatByteSize(1024 ** 3),
], ['0 B', '1023 B', '1.0 KB', '1.5 KB', '1.0 MB', '1.0 GB']);

assert.equal(canPurgeUnusedMedia({ unusedCount: 1 }), true);
assert.equal(canPurgeUnusedMedia({ unusedCount: 0 }), false);
assert.equal(canPurgeUnusedMedia({ unusedCount: 1, playing: true }), false);
assert.equal(canPurgeUnusedMedia({ unusedCount: 1, popupBusy: true }), false);

function persistedAsset(
  assetId: string,
  hash: string,
  size: number,
  sourceName: string,
  kind: 'image' | 'audio',
): MediaAsset {
  const common = {
    assetId,
    hash,
    path: mediaPackagePath(hash),
    sourceName,
    size,
    generation: 1,
  };
  return kind === 'image'
    ? { ...common, kind: 'image', mime: 'image/png', width: 2, height: 3 }
    : { ...common, kind: 'audio', mime: 'audio/wav', duration: 1 };
}

const project = JSON.parse(serializeJSON()) as { media?: MediaRegistry; [field: string]: unknown };
project.media = {
  generation: 2,
  assets: [
    persistedAsset(unusedAId, hashA, 10, 'unused.png', 'image'),
    persistedAsset(unusedBId, hashB, 20, 'unused.wav', 'audio'),
  ],
};
loadJSON(JSON.stringify(project));
const beforePurge = serializeJSON();
const beforeRevision = get(authoredRevision);
assert.equal(get(canUndo), false);

playing.set(true);
assert.equal(purgeUnusedMedia(), 0, 'playback blocks the mutation even if the command is invoked directly');
assert.equal(serializeJSON(), beforePurge);
assert.equal(get(canUndo), false);

playing.set(false);
assert.equal(purgeUnusedMedia(), 2);
assert.equal(currentMediaRegistry().assets.length, 0);
assert.equal(get(authoredRevision), beforeRevision + 1,
  'purge emits the authored revision used by dirty/recovery tracking');
assert.equal(get(canUndo), true);
undo();
assert.equal(serializeJSON(), beforePurge, 'one Undo restores exact registry metadata');
assert.equal(get(canRedo), true);

const popupSource = fs.readFileSync(
  path.join(root, 'src/components/PurgeUnusedMediaPopup.svelte'),
  'utf8',
);
const menuSource = fs.readFileSync(path.join(root, 'src/components/MenuBar.svelte'), 'utf8');
const assetsSource = fs.readFileSync(path.join(root, 'src/components/ProjectAssets.svelte'), 'utf8');
assert.match(popupSource, /Purge unused media\?/);
assert.match(popupSource, /serializeJSON\(\)/,
  'the planner measures the actual current serialized project');
assert.doesNotMatch(popupSource, /serializeJSON\(\$projectMediaRegistry\)/);
assert.match(popupSource, /\{asset\.sourceName\}/);
assert.match(popupSource, /\{asset\.kind\}/);
assert.match(popupSource, /formatByteSize\(asset\.size\)/);
assert.match(popupSource, /will be freed from the project\./);
assert.match(popupSource, />Cancel</);
assert.match(popupSource, />Purge</);
assert.match(popupSource, /function close\(\) \{ onClose\(\); \}/,
  'Cancel closes without invoking the purge command');
assert.match(popupSource, /const count = purgeUnusedMedia\(\)/,
  'confirmation uses the existing one-step command');
assert.match(menuSource, /Purge unused media…/);
assert.match(menuSource, /popupBusy: popupBusyAtOpen/);
assert.doesNotMatch(menuSource, /popupBusy:\s*\$popupOpen/,
  'the File menu does not disable itself after its own popup focus mounts');
assert.doesNotMatch(assetsSource, /Retained assets stay packaged even when unused\.|Purge unused/);

console.log('unused media purge planning and history tests passed');
