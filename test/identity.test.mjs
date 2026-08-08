import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { get } from 'svelte/store';
import { strFromU8, unzipSync } from 'fflate';
import {
  activeLayerId,
  addGroup,
  addLayer,
  beginStroke,
  endStroke,
  layers,
  redo,
  selectLayer,
  setCell,
  setLayers,
  undo,
} from '../src/lib/grid.js';
import {
  canonicalTimelineStateForSave,
  initTimeline,
  razorClip,
  seekTick,
  trimClip,
} from '../src/lib/frames.js';
import {
  canonicalTimelineDto,
  exportAnimation,
  loadJSON,
  serializeJSON,
} from '../src/lib/fileio.js';
import { getClipTimelineState } from '../src/lib/clipTimelineState.js';
import { decodeProjectArchive, encodeProjectArchive } from '../src/lib/projectArchive.js';
import { putProjectAsset } from '../src/lib/projectAssets.js';
import { captureProjectRevision } from '../src/lib/documentLifecycle.js';
import { projectId } from '../src/lib/projectIdentity.js';
import { fileName } from '../src/lib/stores.js';
import {
  assertUuid,
  isUuid,
  setUuidGenerator,
  uuidFromCrypto,
} from '../src/lib/uuid.js';
import { sequentialUuidGenerator } from './projectFixture.mjs';

const goldenText = await readFile(new URL('./fixtures/stable-identity-project.json', import.meta.url), 'utf8');
const golden = JSON.parse(goldenText);
const danglingUuid = 'ffffffff-ffff-4fff-8fff-fffffffffff1';

function definitionIds(project) {
  return [
    project.projectId,
    ...project.timeline.tracks.map((track) => track.id),
    ...project.timeline.tracks.flatMap((track) => track.layer ? [track.layer.id] : []),
    ...project.timeline.clips.map((clip) => clip.id),
    ...project.timeline.tags.map((tag) => tag.id),
    ...project.media.assets.map((asset) => asset.assetId),
  ];
}

function identitySnapshot(project) {
  return {
    projectId: project.projectId,
    tracks: project.timeline.tracks.map((track) => ({
      id: track.id,
      layerId: track.layer?.id || null,
      parentTrackId: track.parentTrackId || null,
    })),
    clips: project.timeline.clips.map((clip) => ({
      id: clip.id,
      trackId: clip.trackId,
      startTick: clip.startTick,
      inTick: clip.inTick,
      outTick: clip.outTick,
      sourceDuration: clip.sourceDuration,
      assetId: clip.assetId || null,
    })),
    tags: project.timeline.tags.map((tag) => ({ ...tag })),
    assets: project.media.assets.map((asset) => [asset.assetId, asset.hash]),
  };
}

function assertPlainDto(value, path = '$') {
  if (value == null || ['string', 'boolean', 'number'].includes(typeof value)) return;
  assert.equal(typeof value, 'object', `${path} must contain JSON data`);
  assert.equal(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype,
    true, `${path} must not contain runtime resources`);
  Object.entries(value).forEach(([key, child]) => assertPlainDto(child, `${path}.${key}`));
}

const fallback = uuidFromCrypto({
  getRandomValues(bytes) {
    for (let index = 0; index < bytes.length; index++) bytes[index] = index;
    return bytes;
  },
});
assert.equal(isUuid(fallback), true);
assert.equal(fallback[14], '4');
assert.match(fallback[19], /[89ab]/);
assert.throws(() => assertUuid('layer-1'), /RFC 4122 UUID/);

loadJSON(goldenText);
const serializedGolden = JSON.parse(serializeJSON());
assert.deepEqual(serializedGolden, golden, 'the canonical-only golden must round-trip exactly');
assert.deepEqual(Object.keys(serializedGolden.timeline).sort(), ['clips', 'tags', 'tracks']);
assert.equal(definitionIds(serializedGolden).every(isUuid), true);
assert.equal(new Set(definitionIds(serializedGolden).map((id) => id.toLowerCase())).size,
  definitionIds(serializedGolden).length);
const stableIdentity = identitySnapshot(serializedGolden);

loadJSON(serializeJSON());
assert.deepEqual(identitySnapshot(JSON.parse(serializeJSON())), stableIdentity,
  'save and reopen preserve every authoring UUID and exact clip boundary');

const heroLayerId = golden.timeline.tracks.find((track) => track.layer?.name === 'Hero').layer.id;
seekTick(2);
selectLayer(heroLayerId);
beginStroke();
setCell(2, 0, { c: 'X', fg: '#ffffff', bg: null });
assert.equal(endStroke(), true);
await Promise.resolve();
const edited = serializeJSON();
assert.equal(JSON.parse(edited).timeline.clips.some((clip) =>
  clip.frameKeys.some((key) => key.value.cells?.['2,0']?.c === 'X')), true);
undo();
assert.deepEqual(JSON.parse(serializeJSON()), golden);
redo();
assert.equal(serializeJSON(), edited);
assert.deepEqual(identitySnapshot(JSON.parse(edited)), stableIdentity,
  'Canvas edits add sparse keys without rebuilding clip topology or IDs');

loadJSON(goldenText);
const firstHeroClip = getClipTimelineState().clips.find((clip) =>
  getClipTimelineState().tracks.find((track) => track.id === clip.trackId)?.layer?.id === heroLayerId);
beginStroke();
assert.equal(trimClip(firstHeroClip.id, 'end', 2).changed, true);
const firstSplit = razorClip(firstHeroClip.id, 1);
assert.equal(firstSplit.changed, true);
assert.equal(endStroke(), true);
const discardedRightId = firstSplit.right.id;
undo();
redo();
assert.equal(getClipTimelineState().clips.some((clip) => clip.id === discardedRightId), true);
undo();
beginStroke();
assert.equal(trimClip(firstHeroClip.id, 'end', 2).changed, true);
const branched = razorClip(firstHeroClip.id, 1);
assert.equal(endStroke(), true);
assert.equal(branched.left.id, firstHeroClip.id);
assert.notEqual(branched.right.id, discardedRightId,
  'a new Undo branch allocates a fresh right-side clip UUID');

const restoreUuidGenerator = setUuidGenerator(sequentialUuidGenerator(1000));
try {
  setLayers([]);
  initTimeline([]);
  addLayer('cell');
  const abandonedLayer = get(layers)[0];
  undo();
  addLayer('cell');
  assert.equal(get(layers)[0].name, abandonedLayer.name);
  assert.notEqual(get(layers)[0].id, abandonedLayer.id);
  undo();
  addGroup();
  const abandonedGroup = get(layers)[0];
  undo();
  addGroup();
  assert.equal(get(layers)[0].name, abandonedGroup.name);
  assert.notEqual(get(layers)[0].id, abandonedGroup.id);
} finally {
  restoreUuidGenerator();
}

loadJSON(goldenText);
const baseline = serializeJSON();
const baselineProject = JSON.parse(baseline);
const baselineRevision = captureProjectRevision();
const baselineProjectId = get(projectId);
function rejectAtomically(label, mutate, pattern) {
  const invalid = structuredClone(baselineProject);
  mutate(invalid);
  assert.throws(() => loadJSON(JSON.stringify(invalid)), pattern, label);
  assert.equal(serializeJSON(), baseline, `${label} must preserve project bytes`);
  assert.equal(captureProjectRevision(), baselineRevision, `${label} must preserve revision`);
  assert.equal(get(projectId), baselineProjectId, `${label} must preserve project UUID`);
}

rejectAtomically('obsolete global frame shape', (project) => {
  project.timeline.frameCount = 14;
  project.timeline.holds = Array(14).fill(1);
  project.timeline.layers = [];
}, /unsupported field frameCount/);
rejectAtomically('mixed canonical and old mirror', (project) => {
  project.timeline.layers = [];
}, /unsupported field layers/);
rejectAtomically('missing canonical tracks', (project) => {
  delete project.timeline.tracks;
}, /Canonical timeline tracks/);
rejectAtomically('duplicate definition UUID', (project) => {
  project.timeline.tracks[1].id = project.timeline.tracks[0].id;
}, /Duplicate (?:UUID|timeline id)/);
rejectAtomically('dangling parent track', (project) => {
  project.timeline.tracks[1].parentTrackId = danglingUuid;
}, /parent track/);
rejectAtomically('dangling clip owner', (project) => {
  project.timeline.clips[0].trackId = danglingUuid;
}, /has no track|owner track/);
rejectAtomically('wrong-kind media reference', (project) => {
  const video = project.timeline.clips.find((clip) => clip.kind === 'video');
  video.assetId = project.media.assets.find((asset) => asset.kind === 'audio').assetId;
}, /wrong-kind asset reference/);
rejectAtomically('stale video tick bounds', (project) => {
  project.timeline.clips.find((clip) => clip.kind === 'video').outTick--;
}, /stale canonical tick bounds/);
rejectAtomically('malformed media hash', (project) => {
  project.media.assets[0].hash = 'not-a-sha';
}, /hash must be 64 lowercase hexadecimal/);
rejectAtomically('runtime field in track layer', (project) => {
  project.timeline.tracks[0].layer.raster = 'data:image/png;base64,forbidden';
}, /unsupported field raster/);

const runtimeState = canonicalTimelineStateForSave();
runtimeState.tracks[0].projection = { forbidden: true };
runtimeState.tracks[0].stackIndex = 99;
runtimeState.tracks[0].layer.canvas = { getContext() {} };
runtimeState.clips[0].blob = new Blob(['forbidden']);
runtimeState.clips[0].decoder = () => {};
const dto = canonicalTimelineDto(runtimeState);
const dtoText = JSON.stringify(dto);
for (const forbidden of [
  'projection', 'stackIndex', 'blob', 'audioBuffer', 'canvas', 'decoder',
  'videoElement', 'videoURL', 'objectURL', 'sourceLayerId', 'layerType', 'frameValueKind',
]) assert.equal(dtoText.includes(`"${forbidden}"`), false, `DTO omits ${forbidden}`);
assertPlainDto(dto);

const audioRegistry = baselineProject.media.assets.find((asset) => asset.kind === 'audio');
const videoRegistry = baselineProject.media.assets.find((asset) => asset.kind === 'video');
const voiceSamples = new Float32Array(48_000).fill(0.125);
const decodeVoice = async () => ({
  buffer: {
    duration: 1,
    length: voiceSamples.length,
    numberOfFrames: voiceSamples.length,
    numberOfChannels: 1,
    sampleRate: 48_000,
    getChannelData() { return voiceSamples; },
  },
});
const archive = await encodeProjectArchive({
  document: baselineProject,
  mediaBlobs: new Map([
    [audioRegistry.hash, new Blob(['voice'], { type: 'audio/wav' })],
    [videoRegistry.hash, new Blob(['reference'], { type: 'video/mp4' })],
  ]),
}, 'uint8array');
const decoded = await decodeProjectArchive(archive);
assert.deepEqual(decoded.document, baselineProject);
assert.equal(await decoded.mediaBlobs.get(audioRegistry.hash).text(), 'voice');
assert.equal(await decoded.mediaBlobs.get(videoRegistry.hash).text(), 'reference');
await putProjectAsset(audioRegistry.hash, new Blob(['voice'], { type: 'audio/wav' }), audioRegistry);

loadJSON(baseline);
fileName.set('identity-runtime.paintty');
let runtimeJsonBlob;
await exportAnimation({
  chooseTarget: async () => ({ async write(blob) { runtimeJsonBlob = blob; } }),
});
const runtimeJson = await runtimeJsonBlob.text();
for (const id of definitionIds(baselineProject)) {
  assert.equal(runtimeJson.includes(id), false, `runtime JSON omits author ID ${id}`);
}
let runtimeZipBlob;
await exportAnimation({
  includeAudio: true,
  decodeAudio: decodeVoice,
  chooseTarget: async () => ({ async write(blob) { runtimeZipBlob = blob; } }),
});
const runtimeEntries = unzipSync(new Uint8Array(await runtimeZipBlob.arrayBuffer()));
const packagedRuntimeJson = strFromU8(runtimeEntries['identity-runtime.json']);
assert.deepEqual(Object.keys(runtimeEntries), ['identity-runtime.json', 'audio.wav']);
assert.deepEqual(JSON.parse(packagedRuntimeJson).audio, {
  source: 'audio.wav',
  mime: 'audio/wav',
  sampleRate: 48_000,
  channels: 2,
  durationUs: 1_400_000,
});
assert.equal(packagedRuntimeJson.includes(audioRegistry.sourceName), false);
for (const id of definitionIds(baselineProject)) {
  assert.equal(packagedRuntimeJson.includes(id), false, `packaged runtime JSON omits author ID ${id}`);
}
for (const path of Object.keys(runtimeEntries)) {
  for (const id of definitionIds(baselineProject)) assert.equal(path.includes(id), false);
}

console.log('stable canonical authoring identity contract passed');
