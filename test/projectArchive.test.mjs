import assert from 'node:assert/strict';
import { Blob } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { unzipSync, zipSync } from 'fflate';
import { decodeProjectArchive, encodeProjectArchive } from '../src/lib/projectArchive.js';

const document = JSON.parse(await readFile(
  new URL('./fixtures/stable-identity-project.json', import.meta.url),
  'utf8',
));
const audioAsset = document.media.assets.find((asset) => asset.kind === 'audio');
const videoAsset = document.media.assets.find((asset) => asset.kind === 'video');
audioAsset.sourceName = '../voice?.ogg';
audioAsset.mime = 'audio/ogg';
audioAsset.hash = '3e6f9aae16382bf563d8991b6da1b92213911f0dd5deea3ecaccf2f35a56794a';
audioAsset.path = `assets/sha256/3e/${audioAsset.hash}`;
audioAsset.size = 4;
videoAsset.hash = '06df4f7e1394f1c57cc6583fba4d8060a5a66f4f4771c14aeff6b9af8a28c9b3';
videoAsset.path = `assets/sha256/06/${videoAsset.hash}`;
videoAsset.size = 3;
const source = new Blob([new Uint8Array([1, 2, 3, 255])], { type: 'audio/ogg' });
const archive = await encodeProjectArchive({
  document,
  mediaBlobs: new Map([
    [audioAsset.hash, source],
    [videoAsset.hash, new Blob([new Uint8Array([9, 8, 7])], { type: 'video/mp4' })],
  ]),
}, 'uint8array');
const decoded = await decodeProjectArchive(archive);
assert.deepEqual(decoded.document, document);
assert.deepEqual(
  new Uint8Array(await decoded.mediaBlobs.get(audioAsset.hash).arrayBuffer()),
  new Uint8Array([1, 2, 3, 255]),
);
assert.equal(decoded.manifest.assets[0].path.includes('..'), false);
assert.equal(decoded.manifest.assets[0].path.startsWith('assets/sha256/'), true);
assert.deepEqual(
  new Uint8Array(await decoded.mediaBlobs.get(videoAsset.hash).arrayBuffer()),
  new Uint8Array([9, 8, 7]),
);
assert.equal(decoded.manifest.assets[1].path.startsWith('assets/sha256/'), true);

await assert.rejects(decodeProjectArchive(new Uint8Array([1, 2, 3])), /invalid|data|zip/i);

const retainedDocument = structuredClone(document);
retainedDocument.media.generation++;
retainedDocument.media.assets.push({
  ...audioAsset,
  assetId: 'abababab-abab-4aba-8aba-abababababab',
  sourceName: 'retained-unused-copy.ogg',
});
const retainedArchive = await encodeProjectArchive({
  document: retainedDocument,
  mediaBlobs: new Map([
    [audioAsset.hash, source],
    [videoAsset.hash, new Blob([new Uint8Array([9, 8, 7])], { type: 'video/mp4' })],
  ]),
}, 'uint8array');
const retainedEntries = unzipSync(retainedArchive);
assert.equal(Object.keys(retainedEntries).filter((path) => path.startsWith('assets/sha256/')).length, 2,
  'three retained metadata entries sharing two hashes produce two byte entries');
const retainedDecoded = await decodeProjectArchive(retainedArchive);
assert.equal(retainedDecoded.manifest.assets.length, 3,
  'the package manifest includes a retained usage-zero logical asset');
assert.equal(retainedDecoded.mediaBlobs.size, 2);

const beforeCorruptAttempt = JSON.stringify(document);
const corruptEntries = unzipSync(archive);
corruptEntries[audioAsset.path] = new Uint8Array(corruptEntries[audioAsset.path]);
corruptEntries[audioAsset.path][0] ^= 0xff;
await assert.rejects(decodeProjectArchive(zipSync(corruptEntries)), /hash mismatch/i);
assert.equal(JSON.stringify(document), beforeCorruptAttempt,
  'corrupt hash rejection does not mutate the open document candidate');

const missingEntries = unzipSync(archive);
delete missingEntries[videoAsset.path];
await assert.rejects(decodeProjectArchive(zipSync(missingEntries)), /missing/i);
console.log('ok - project archive round trip');
