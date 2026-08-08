import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import {
  accountAnimationVisualFrame,
  ANIMATION_VISUAL_MAX_CELL_ENTRIES,
  ANIMATION_VISUAL_MAX_ESTIMATED_BYTES,
  ANIMATION_VISUAL_MAX_FRAMES,
  animationExportBaseName,
  buildAnimationDocument,
  encodeAnimationZip,
  estimateAnimationVisualExportResources,
  planAnimationExport,
  serializeAnimationJSON,
  validateAnimationVisualJsonResources,
} from '../src/lib/animationExport.js';
import { encodePcmWav } from '../src/lib/audioExport.js';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Blob) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

async function bytesOf(value) {
  return value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value;
}

function pcm(channels) {
  const values = channels.map((channel) => Float32Array.from(channel));
  return {
    sampleRate: 48_000,
    numberOfChannels: values.length,
    numberOfFrames: values[0].length,
    getChannelData(channel) { return values[channel]; },
  };
}

function centralDirectoryMethods(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const methods = [];
  for (let offset = 0; offset + 12 <= bytes.length; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) methods.push(view.getUint16(offset + 10, true));
  }
  return methods;
}

assert.equal(animationExportBaseName('Scene.JSON'), 'Scene');
assert.equal(animationExportBaseName('Scene.PAINTTY'), 'Scene');
assert.equal(animationExportBaseName('Scene.ZIP'), 'Scene');
assert.equal(animationExportBaseName('  '), 'untitled');
assert.equal(animationExportBaseName('../../.JSON'), 'untitled');
assert.equal(animationExportBaseName('CON.backup'), 'CON-file.backup');
assert.equal(animationExportBaseName('PRN.safe.name'), 'PRN-file.safe.name');

const jsonOnlyPlan = planAnimationExport({ fileName: 'hero.JSON', includeAudio: true });
assert.deepEqual({
  kind: jsonOnlyPlan.kind,
  filename: jsonOnlyPlan.filename,
  entries: jsonOnlyPlan.entries,
  includeAudio: jsonOnlyPlan.includeAudio,
}, {
  kind: 'json', filename: 'hero.json', entries: ['hero.json'], includeAudio: false,
});
const audioPlan = planAnimationExport({
  fileName: 'hero.PAINTTY',
  includeAudio: true,
  hasAudio: true,
  audioCount: 3,
});
assert.deepEqual({
  kind: audioPlan.kind,
  filename: audioPlan.filename,
  entries: audioPlan.entries,
  audioPath: audioPlan.audioPath,
  audibleAudioCount: audioPlan.audibleAudioCount,
}, {
  kind: 'zip',
  filename: 'hero.zip',
  entries: ['hero.json', 'audio.wav'],
  audioPath: 'audio.wav',
  audibleAudioCount: 3,
});
assert.deepEqual(
  planAnimationExport({ fileName: 'hero.zip', includeAudio: true, hasAudio: true }).entries,
  audioPlan.entries,
  'mixed WAV entry planning is independent of source names',
);

const visualBoundary = estimateAnimationVisualExportResources({
  frameCount: ANIMATION_VISUAL_MAX_FRAMES,
  columns: 256,
  rows: 256,
});
assert.equal(visualBoundary.frameCount, ANIMATION_VISUAL_MAX_FRAMES);
assert.equal(visualBoundary.columns, 256);
assert.equal(visualBoundary.rows, 256);
assert.ok(visualBoundary.estimatedBytes < ANIMATION_VISUAL_MAX_ESTIMATED_BYTES);
assert.throws(() => estimateAnimationVisualExportResources({
  frameCount: ANIMATION_VISUAL_MAX_FRAMES + 1,
  columns: 1,
  rows: 1,
}), /reduce long holds/);
assert.throws(() => estimateAnimationVisualExportResources({
  frameCount: 1,
  columns: 257,
  rows: 256,
}), /256x256 visual export limit/);

let sparseResources = estimateAnimationVisualExportResources({
  frameCount: 100,
  columns: 256,
  rows: 256,
});
sparseResources = accountAnimationVisualFrame(sparseResources, {
  layers: [{ layerId: 0, cells: [{ glyph: 'A', foreground: '#fff', background: null }] }],
  composite: [{ glyph: 'A', foreground: '#fff', background: null }],
});
sparseResources = validateAnimationVisualJsonResources(sparseResources, {
  layers: [{ name: 'Sparse' }],
  tags: [{ value: 'ready' }],
});
assert.equal(sparseResources.cellEntries, 2);
assert.ok(sparseResources.estimatedBytes < ANIMATION_VISUAL_MAX_ESTIMATED_BYTES);

const denseCells = new Array(256 * 256).fill({ glyph: 'X', foreground: null, background: null });
let denseResources = estimateAnimationVisualExportResources({
  frameCount: 4,
  columns: 256,
  rows: 256,
});
const denseRuntimeFrame = {
  layers: [{ layerId: 0, cells: denseCells }],
  composite: denseCells,
};
denseResources = accountAnimationVisualFrame(denseResources, denseRuntimeFrame);
denseResources = accountAnimationVisualFrame(denseResources, denseRuntimeFrame);
denseResources = accountAnimationVisualFrame(denseResources, denseRuntimeFrame);
assert.throws(
  () => accountAnimationVisualFrame(denseResources, denseRuntimeFrame),
  new RegExp(`${ANIMATION_VISUAL_MAX_CELL_ENTRIES.toLocaleString('en-US')} resolved-cell limit`),
  'dense 256x256 frames held across the sequence are bounded',
);
const byteBoundarySeed = {
  ...estimateAnimationVisualExportResources({ frameCount: 1, columns: 1, rows: 1 }),
  baseBytes: ANIMATION_VISUAL_MAX_ESTIMATED_BYTES - 192,
};
const byteBoundary = accountAnimationVisualFrame(byteBoundarySeed, {
  layers: [],
  composite: [{}],
});
assert.equal(byteBoundary.estimatedBytes, ANIMATION_VISUAL_MAX_ESTIMATED_BYTES);
assert.throws(() => accountAnimationVisualFrame(byteBoundary, {
  layers: [],
  composite: [{}],
}), /128 MiB safe object\/JSON estimate/);

const frozenSnapshot = deepFreeze({
  dimensions: { w: 4, h: 2 },
  fps: 10,
  layerMetadata: [
    { id: 'ink', name: 'Ink', type: 'cell' },
    { id: 'reference-image', name: 'Tracing', type: 'image' },
    { id: 'reference-video', name: 'Footage', type: 'video' },
  ],
  frames: [{
    hold: 2,
    layers: [
      {
        id: 'ink',
        cells: [[
          { c: '界', fg: '#ffffff', bg: '#101010', blink: true },
          { c: '', fg: '#ffffff', bg: '#101010', cont: true },
          null,
          { bg: '#224466' },
        ]],
      },
      { id: 'reference-image', type: 'image', cells: [[{ c: 'X' }]] },
      { id: 'reference-video', type: 'video', cells: [[{ c: 'Y' }]] },
    ],
  }],
  compositeCells: [[[
    { c: '界', fg: '#ffffff', bg: '#101010', blink: true },
    { c: '', fg: '#ffffff', bg: '#101010', cont: true },
    null,
    { bg: '#224466' },
  ]]],
});
const visualDocument = buildAnimationDocument(frozenSnapshot);
assert.deepEqual(visualDocument.layers, [{ id: 0, name: 'Ink', order: 0 }]);
assert.deepEqual(visualDocument.frames[0].layers, [{
  layerId: 0,
  cells: [{
    x: 0,
    y: 0,
    glyph: '界',
    foreground: '#ffffff',
    background: '#101010',
    width: 2,
    blink: true,
  }, {
    x: 3,
    y: 0,
    glyph: null,
    foreground: null,
    background: '#224466',
    width: 1,
  }],
}]);
assert.deepEqual(visualDocument.frames[0].composite, visualDocument.frames[0].layers[0].cells);
assert.equal('audio' in visualDocument, false);
assert.equal('audioAssets' in visualDocument, false);
assert.equal('audioTracks' in visualDocument, false);
const prettyJSON = serializeAnimationJSON(visualDocument);
assert.match(prettyJSON, /^\{\n  "format": "paintty-animation",/);
assert.equal(prettyJSON.endsWith('\n'), true);
assert.deepEqual(JSON.parse(prettyJSON), visualDocument);

const mixedWav = await encodePcmWav(pcm([[0, 0.25], [0, -0.25]]));
const mixedDocument = buildAnimationDocument({
  ...frozenSnapshot,
  exportPlan: audioPlan,
  audio: { durationUs: 42 },
  audioAssets: [{ id: 'author-asset', sourceName: 'private-source-name.ogg' }],
  audioTracks: [{ id: 'author-track', name: 'Private track', clips: [{ id: 'author-clip' }] }],
});
assert.deepEqual(mixedDocument.audio, {
  source: 'audio.wav',
  mime: 'audio/wav',
  sampleRate: 48_000,
  channels: 2,
  durationUs: 42,
});
assert.equal('audioAssets' in mixedDocument, false);
assert.equal('audioTracks' in mixedDocument, false);
const mixedJSON = serializeAnimationJSON(mixedDocument);
for (const forbidden of [
  'author-asset', 'author-track', 'author-clip', 'private-source-name.ogg', 'Private track',
]) assert.equal(mixedJSON.includes(forbidden), false);

const archiveBlob = await encodeAnimationZip({
  plan: audioPlan,
  json: mixedJSON,
  audioBytes: mixedWav,
  output: 'blob',
});
assert.equal(archiveBlob instanceof Blob, true);
assert.equal(archiveBlob.type, 'application/zip');
const archiveEntries = unzipSync(await bytesOf(archiveBlob));
assert.deepEqual(Object.keys(archiveEntries), ['hero.json', 'audio.wav']);
assert.deepEqual(archiveEntries['audio.wav'], mixedWav);
assert.deepEqual(JSON.parse(strFromU8(archiveEntries['hero.json'])), mixedDocument);

const authorIdsA = {
  front: '10000000-0000-4000-8000-000000000001',
  back: '20000000-0000-4000-8000-000000000002',
  loop: '30000000-0000-4000-8000-000000000003',
  event: '40000000-0000-4000-8000-000000000004',
};
const authorIdsB = {
  front: 'a0000000-0000-4000-8000-000000000001',
  back: 'b0000000-0000-4000-8000-000000000002',
  loop: 'c0000000-0000-4000-8000-000000000003',
  event: 'd0000000-0000-4000-8000-000000000004',
};
const uuidLookingLabel = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function runtimeGolden(ids) {
  const front = { id: ids.front, name: uuidLookingLabel, type: 'cell' };
  const back = { id: ids.back, name: 'Backdrop', type: 'cell' };
  const plan = planAnimationExport({
    fileName: 'runtime-golden.paintty', includeAudio: true, hasAudio: true,
  });
  const document = buildAnimationDocument({
    dimensions: { w: 2, h: 1 },
    fps: 12,
    tags: [
      { id: ids.event, tick: 0, type: 'custom', value: 'spawn:世界' },
      { id: ids.loop, tick: 0, type: 'loop-start' },
    ],
    layerMetadata: [front, back],
    frames: [{
      hold: 2,
      layers: [
        { ...front, cells: { '1,0': { c: 'F' }, '0,0': { c: 'B', fg: '#ffffff' } } },
        { ...back, cells: { '0,0': { c: 'A', fg: '#777777' } } },
      ],
    }],
    compositeCells: [[{ c: 'B', fg: '#ffffff' }, { c: 'F' }]],
    exportPlan: plan,
    audio: { durationUs: 166_667 },
  });
  return { plan, document, json: serializeAnimationJSON(document) };
}

const firstGolden = runtimeGolden(authorIdsA);
const secondGolden = runtimeGolden(authorIdsB);
assert.equal(firstGolden.json, secondGolden.json,
  'author identity allocation does not affect mixed-audio runtime JSON');
assert.deepEqual(firstGolden.document.tags, [
  { tick: 0, type: 'loop-start' },
  { tick: 0, type: 'custom', value: 'spawn:世界' },
]);
assert.equal(firstGolden.json.includes(uuidLookingLabel), true,
  'UUID-looking user labels remain valid runtime content');
for (const identity of [...Object.values(authorIdsA), ...Object.values(authorIdsB)]) {
  assert.equal(firstGolden.json.includes(identity), false, `runtime JSON omits ${identity}`);
}

const firstZip = await encodeAnimationZip({
  plan: firstGolden.plan,
  json: firstGolden.json,
  audioBytes: mixedWav,
});
const repeatedZip = await encodeAnimationZip({
  plan: firstGolden.plan,
  json: firstGolden.json,
  audioBytes: mixedWav,
});
const reidentifiedZip = await encodeAnimationZip({
  plan: secondGolden.plan,
  json: secondGolden.json,
  audioBytes: mixedWav,
});
assert.deepEqual(firstZip, repeatedZip, 'repeated ZIP bytes are deterministic');
assert.deepEqual(firstZip, reidentifiedZip,
  'author identity allocation does not affect ZIP bytes');
const goldenEntries = unzipSync(firstZip);
assert.deepEqual(Object.keys(goldenEntries), ['runtime-golden.json', 'audio.wav']);
assert.equal(strFromU8(goldenEntries['runtime-golden.json']), firstGolden.json);
assert.deepEqual(goldenEntries['audio.wav'], mixedWav);
assert.deepEqual(centralDirectoryMethods(firstZip), [8, 0],
  'JSON is deflated and the mixed WAV is stored');

const zipController = new AbortController();
let zipYields = 0;
await assert.rejects(encodeAnimationZip({
  plan: audioPlan,
  json: mixedJSON,
  audioBytes: new Uint8Array(1024 * 1024),
  signal: zipController.signal,
  yieldControl() {
    zipYields++;
    zipController.abort();
    return Promise.resolve();
  },
}), (error) => error?.name === 'AbortError');
assert.equal(zipYields, 1, 'cancellation interrupts chunked asynchronous ZIP assembly');

const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(encodeAnimationZip({
  plan: audioPlan,
  json: mixedJSON,
  audioBytes: mixedWav,
  signal: cancelled.signal,
}), (error) => error?.name === 'AbortError');

console.log('animation export focused tests passed');
