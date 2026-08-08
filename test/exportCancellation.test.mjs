import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'svelte/store';
import { strFromU8, unzipSync } from 'fflate';
import { updateAudioClip, updateAudioTrack } from '../src/lib/audio.js';
import { mixTimelineAudio } from '../src/lib/audioExport.js';
import { ANIMATION_VISUAL_MAX_FRAMES } from '../src/lib/animationExport.js';
import { updateCustomTimelineTag } from '../src/lib/clipTimelineState.js';
import {
  exportAnimation,
  exportANSI,
  exportTXT,
  exportVideo,
  loadJSON,
  saveAsImage,
  serializeJSON,
} from '../src/lib/fileio.js';
import { canUndo } from '../src/lib/grid.js';
import { mediaPackagePath } from '../src/lib/mediaHash.js';
import { replaceMediaAsset } from '../src/lib/mediaRegistry.js';
import {
  activeMediaLeaseHashes,
  putProjectAsset,
} from '../src/lib/projectAssets.js';
import { CURRENT_PROJECT_VERSION } from '../src/lib/projectFormat.js';
import { dirty, fileName } from '../src/lib/stores.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = (prefix) => `${prefix.repeat(8)}-${prefix.repeat(4)}-4${prefix.repeat(3)}-8${prefix.repeat(3)}-${prefix.repeat(12)}`;
const IDs = {
  project: id('a'),
  visualLayer: id('1'),
  visualTrack: id('2'),
  visualClip: id('3'),
  audioTrack: id('4'),
  audioClip: id('5'),
  audioAsset: id('6'),
  customTag: id('7'),
};
const oldAudioBytes = new TextEncoder().encode('captured-audio');
const newAudioBytes = new TextEncoder().encode('replacement-audio');
const oldAudioHash = createHash('sha256').update(oldAudioBytes).digest('hex');
const newAudioHash = createHash('sha256').update(newAudioBytes).digest('hex');
const oldAudioBlob = new Blob([oldAudioBytes], { type: 'audio/wav' });
const newAudioBlob = new Blob([newAudioBytes], { type: 'audio/wav' });

function audioBuffer(value) {
  const samples = new Float32Array(48_000).fill(value);
  return {
    duration: 1,
    length: samples.length,
    numberOfFrames: samples.length,
    numberOfChannels: 1,
    sampleRate: 48_000,
    getChannelData() { return samples; },
  };
}

const capturedAudioBuffer = audioBuffer(0.25);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function abortError(error) {
  return error?.name === 'AbortError';
}

function assetMetadata({ hash, sourceName, size }) {
  return {
    assetId: IDs.audioAsset,
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

const oldAsset = assetMetadata({
  hash: oldAudioHash,
  sourceName: 'captured.wav',
  size: oldAudioBlob.size,
});
const newAsset = assetMetadata({
  hash: newAudioHash,
  sourceName: 'replacement.wav',
  size: newAudioBlob.size,
});

function projectFixture() {
  return {
    format: 'paintty-sprite',
    version: CURRENT_PROJECT_VERSION,
    projectId: IDs.project,
    width: 2,
    height: 1,
    fps: 2,
    timeline: {
      tags: [{ id: IDs.customTag, tick: 0, type: 'custom', value: 'captured-tag' }],
      tracks: [{
        id: IDs.visualTrack,
        kind: 'visual',
        locked: false,
        layer: {
          id: IDs.visualLayer,
          name: 'Captured layer',
          type: 'cell',
          visible: true,
          cells: {},
          offset: { x: 0, y: 0 },
        },
      }, {
        id: IDs.audioTrack,
        kind: 'audio',
        name: 'Captured audio',
        locked: false,
        volume: 0.8,
      }],
      clips: [{
        id: IDs.visualClip,
        trackId: IDs.visualTrack,
        kind: 'visual',
        startTick: 0,
        inTick: 0,
        outTick: 2,
        sourceDuration: 2,
        frameKeys: [{
          tick: 0,
          value: { cells: { '0,0': { c: 'A', fg: '#ffffff', bg: null } } },
        }],
        propertyTracks: {},
      }, {
        id: IDs.audioClip,
        trackId: IDs.audioTrack,
        kind: 'audio',
        startTick: 0,
        inTick: 0,
        outTick: 2,
        sourceDuration: 2,
        frameKeys: [],
        propertyTracks: {},
        assetId: IDs.audioAsset,
        inPoint: 0,
        outPoint: 1,
        volume: 0.75,
        muted: false,
      }],
    },
    media: { generation: 1, assets: [oldAsset] },
  };
}

async function loadFixture() {
  await putProjectAsset(oldAudioHash, oldAudioBlob, oldAsset);
  await putProjectAsset(newAudioHash, newAudioBlob, newAsset);
  loadJSON(JSON.stringify(projectFixture()));
  fileName.set('atomic.paintty');
  dirty.set(false);
}

async function exportedAnimation(options = {}) {
  let output = null;
  const saved = await exportAnimation({
    decodeAudio: async () => ({ buffer: capturedAudioBuffer }),
    ...options,
    chooseTarget: async () => ({
      async write(blob) { output = blob; },
    }),
  });
  assert.equal(saved, true);
  assert.ok(output instanceof Blob);
  return output;
}

async function bytesOf(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

await loadFixture();
const activationTarget = deferred();
const activationEvents = [];
const activationExport = exportAnimation({
  includeAudio: true,
  decodeAudio: async () => {
    activationEvents.push('decode');
    return { buffer: capturedAudioBuffer };
  },
  async mixAudio(plan, dependencies) {
    activationEvents.push('mix');
    return mixTimelineAudio(plan, { ...dependencies, OfflineAudioContextClass: null });
  },
  chooseTarget(filename) {
    activationEvents.push(`target:${filename}`);
    return activationTarget.promise;
  },
});
assert.deepEqual(activationEvents, ['target:atomic.zip'],
  'target selection is invoked synchronously before decode or mix');
activationTarget.resolve({
  async write() { activationEvents.push('write'); },
});
assert.equal(await activationExport, true);
assert.deepEqual(activationEvents, ['target:atomic.zip', 'decode', 'mix', 'write']);

const oversizedProject = projectFixture();
oversizedProject.media.assets[0] = { ...oversizedProject.media.assets[0], duration: 360 };
loadJSON(JSON.stringify(oversizedProject));
let oversizedFrameCaptures = 0;
let oversizedTargetSelections = 0;
let oversizedDecodes = 0;
let oversizedAssetReads = 0;
await assert.rejects(exportAnimation({
  includeAudio: true,
  createFrameSource() { oversizedFrameCaptures++; throw new Error('must not capture'); },
  chooseTarget: async () => { oversizedTargetSelections++; return null; },
  getAsset: async () => { oversizedAssetReads++; return null; },
  decodeAudio: async () => { oversizedDecodes++; return { buffer: capturedAudioBuffer }; },
}), /512 MiB safe peak-memory budget/);
assert.deepEqual({ oversizedFrameCaptures, oversizedTargetSelections, oversizedAssetReads, oversizedDecodes }, {
  oversizedFrameCaptures: 0,
  oversizedTargetSelections: 0,
  oversizedAssetReads: 0,
  oversizedDecodes: 0,
}, '7.1 resource preflight fails before frame capture, asset bytes, picker, or source decode');

let longHoldResolves = 0;
let longHoldTargets = 0;
await assert.rejects(exportAnimation({
  createFrameSource: () => ({
    frameCount: ANIMATION_VISUAL_MAX_FRAMES + 1,
    holds: [],
    resolve() { longHoldResolves++; return { layers: [] }; },
  }),
  chooseTarget: async () => { longHoldTargets++; return null; },
}), /reduce long holds/);
assert.deepEqual({ longHoldResolves, longHoldTargets }, { longHoldResolves: 0, longHoldTargets: 0 },
  'long-hold visual preflight fails before frame resolution or target selection');

await loadFixture();
let decodedBudgetMixes = 0;
let decodedBudgetWrites = 0;
await assert.rejects(exportAnimation({
  includeAudio: true,
  decodeAudio: async () => ({
    buffer: {
      duration: 1,
      numberOfChannels: 8,
      length: 20_000_000,
    },
  }),
  mixAudio: async () => { decodedBudgetMixes++; return null; },
  chooseTarget: async () => ({ async write() { decodedBudgetWrites++; } }),
}), /512 MiB safe peak-memory budget/);
assert.deepEqual({ decodedBudgetMixes, decodedBudgetWrites }, { decodedBudgetMixes: 0, decodedBudgetWrites: 0 },
  'actual decoded PCM is re-budgeted before mixing or writing');

const cleanProject = serializeJSON();
const firstJSON = await exportedAnimation();
const repeatedJSON = await exportedAnimation();
assert.equal(await firstJSON.text(), await repeatedJSON.text(),
  'standalone Animation JSON repeats byte-for-byte');
const firstZip = await exportedAnimation({ includeAudio: true });
const repeatedZip = await exportedAnimation({ includeAudio: true });
assert.deepEqual(await bytesOf(firstZip), await bytesOf(repeatedZip),
  'Animation ZIP repeats byte-for-byte');
const baselineZipBytes = await bytesOf(firstZip);
const baselineEntries = unzipSync(baselineZipBytes);
assert.deepEqual(Object.keys(baselineEntries), ['atomic.json', 'audio.wav']);
assert.equal(strFromU8(baselineEntries['audio.wav'].subarray(0, 4)), 'RIFF');
assert.equal(strFromU8(baselineEntries['audio.wav']).includes('captured-audio'), false,
  'the mix contains no original source bytes');
assert.equal(serializeJSON(), cleanProject, 'successful exports do not edit the project');
assert.equal(get(dirty), false, 'successful exports do not dirty the project');
assert.equal(get(canUndo), false, 'successful exports add no history entry');

const atomicMixStarted = deferred();
const atomicMixCompletion = deferred();
let atomicOutput = null;
const atomicExport = exportAnimation({
  includeAudio: true,
  decodeAudio: async () => ({ buffer: capturedAudioBuffer }),
  async mixAudio(plan, dependencies) {
    atomicMixStarted.resolve();
    await atomicMixCompletion.promise;
    return mixTimelineAudio(plan, { ...dependencies, OfflineAudioContextClass: null });
  },
  chooseTarget: async () => ({ async write(blob) { atomicOutput = blob; } }),
});
await atomicMixStarted.promise;
updateCustomTimelineTag(IDs.customTag, { value: 'replacement-tag' });
updateAudioTrack(IDs.audioTrack, { name: 'Replacement audio', volume: 0.2 });
updateAudioClip(IDs.audioTrack, IDs.audioClip, { startTick: 1, volume: 0.1 });
replaceMediaAsset(IDs.audioAsset, {
  hash: newAudioHash,
  sourceName: newAsset.sourceName,
  mime: newAsset.mime,
  size: newAsset.size,
  kind: newAsset.kind,
  duration: newAsset.duration,
});
atomicMixCompletion.resolve();
assert.equal(await atomicExport, true);
const atomicZipBytes = await bytesOf(atomicOutput);
assert.deepEqual(atomicZipBytes, baselineZipBytes,
  'edits and media replacement after export starts cannot change its generation');
const atomicEntries = unzipSync(atomicZipBytes);
const atomicDocument = JSON.parse(strFromU8(atomicEntries['atomic.json']));
assert.deepEqual(atomicDocument.tags, [{ tick: 0, type: 'custom', value: 'captured-tag' }]);
assert.deepEqual(atomicDocument.audio, {
  source: 'audio.wav',
  mime: 'audio/wav',
  sampleRate: 48_000,
  channels: 2,
  durationUs: 1_000_000,
});
assert.equal('audioTracks' in atomicDocument, false);
assert.equal(strFromU8(atomicEntries['atomic.json']).includes('Captured audio'), false);
assert.equal(strFromU8(atomicEntries['atomic.json']).includes('Replacement audio'), false);
assert.equal(strFromU8(atomicEntries['audio.wav']).includes('captured-audio'), false);
assert.equal(strFromU8(atomicEntries['audio.wav']).includes('replacement-audio'), false);
assert.equal(activeMediaLeaseHashes().has(oldAudioHash), false,
  'successful export releases captured media leases');
for (const authorId of Object.values(IDs)) {
  assert.equal(strFromU8(atomicEntries['atomic.json']).includes(authorId), false,
    `Animation JSON omits author identity ${authorId}`);
  assert.equal(Object.keys(atomicEntries).some((entry) => entry.includes(authorId)), false,
    `Animation ZIP paths omit author identity ${authorId}`);
}

await loadFixture();
const cancellationProject = serializeJSON();
const cancellationDirty = get(dirty);
const cancellationCanUndo = get(canUndo);
const cancelledMixStarted = deferred();
const cancelledMixCompletion = deferred();
const mediaController = new AbortController();
let mediaTargetSelections = 0;
let mediaWrites = 0;
const cancelledMediaExport = exportAnimation({
  includeAudio: true,
  signal: mediaController.signal,
  decodeAudio: async () => ({ buffer: capturedAudioBuffer }),
  async mixAudio(plan, dependencies) {
    cancelledMixStarted.resolve();
    await cancelledMixCompletion.promise;
    return mixTimelineAudio(plan, { ...dependencies, OfflineAudioContextClass: null });
  },
  chooseTarget: async () => {
    mediaTargetSelections++;
    return { async write() { mediaWrites++; } };
  },
});
await cancelledMixStarted.promise;
const leasedWhilePending = activeMediaLeaseHashes().has(oldAudioHash);
mediaController.abort();
cancelledMixCompletion.resolve();
await assert.rejects(cancelledMediaExport, abortError);
assert.equal(leasedWhilePending, true, 'captured media is leased while export bytes are pending');
assert.equal(activeMediaLeaseHashes().has(oldAudioHash), false, 'abort releases captured media leases');
assert.equal(mediaTargetSelections, 1,
  'the target is selected under activation before mixed WAV work starts');
assert.equal(mediaWrites, 0, 'abort before mixed WAV completion commits no write');
assert.equal(serializeJSON(), cancellationProject, 'aborted Animation export changes no project data');
assert.equal(get(dirty), cancellationDirty, 'aborted Animation export preserves dirty state');
assert.equal(get(canUndo), cancellationCanUndo, 'aborted Animation export adds no history entry');

const downloadMixStarted = deferred();
const downloadMixCompletion = deferred();
const downloadController = new AbortController();
let downloadTargetSelections = 0;
const cancelledDownload = exportAnimation({
  includeAudio: true,
  download: true,
  signal: downloadController.signal,
  decodeAudio: async () => ({ buffer: capturedAudioBuffer }),
  async mixAudio(plan, dependencies) {
    downloadMixStarted.resolve();
    await downloadMixCompletion.promise;
    return mixTimelineAudio(plan, { ...dependencies, OfflineAudioContextClass: null });
  },
  chooseTarget: async () => { downloadTargetSelections++; return null; },
});
await downloadMixStarted.promise;
assert.equal(downloadTargetSelections, 0, 'download fallback opens no picker');
downloadController.abort();
downloadMixCompletion.resolve();
await assert.rejects(cancelledDownload, abortError);

await loadFixture();
const zipStarted = deferred();
const zipCompletion = deferred();
const zipController = new AbortController();
let zipWrites = 0;
const cancelledZipExport = exportAnimation({
  includeAudio: true,
  signal: zipController.signal,
  decodeAudio: async () => ({ buffer: capturedAudioBuffer }),
  encodeTimelineWav: async () => new Uint8Array(1024 * 1024),
  zipYieldControl() {
    zipStarted.resolve();
    return zipCompletion.promise;
  },
  chooseTarget: async () => ({ async write() { zipWrites++; } }),
});
await zipStarted.promise;
assert.equal(activeMediaLeaseHashes().has(oldAudioHash), true,
  'captured media remains leased during asynchronous ZIP assembly');
zipController.abort();
zipCompletion.resolve();
await assert.rejects(cancelledZipExport, abortError);
assert.equal(zipWrites, 0, 'cancellation during ZIP assembly commits no target write');
assert.equal(activeMediaLeaseHashes().has(oldAudioHash), false,
  'ZIP cancellation releases captured media leases');

await loadFixture();
const decodeStarted = deferred();
const decodeCompletion = deferred();
let decodeCalls = 0;
let decodesInFlight = 0;
let maximumDecodesInFlight = 0;
let sharedDecodeWrites = 0;
const delayedDecode = () => {
  decodeCalls++;
  decodesInFlight++;
  maximumDecodesInFlight = Math.max(maximumDecodesInFlight, decodesInFlight);
  decodeStarted.resolve();
  return decodeCompletion.promise.finally(() => { decodesInFlight--; });
};
const firstDecodeController = new AbortController();
const firstDecodeExport = exportAnimation({
  includeAudio: true,
  signal: firstDecodeController.signal,
  decodeAudio: delayedDecode,
  chooseTarget: async () => ({ async write() { sharedDecodeWrites++; } }),
});
const firstDecodeResult = firstDecodeExport.then(
  () => null,
  (error) => error,
);
await decodeStarted.promise;
firstDecodeController.abort();
assert.equal((await firstDecodeResult)?.name, 'AbortError');

const retryDecodeExport = exportAnimation({
  includeAudio: true,
  decodeAudio: delayedDecode,
  chooseTarget: async () => ({ async write() { sharedDecodeWrites++; } }),
});
await Promise.resolve();
await Promise.resolve();
assert.equal(decodeCalls, 1,
  'retry shares the uncancelable captured hash/generation decode already in flight');
decodeCompletion.resolve({ buffer: capturedAudioBuffer });
assert.equal(await retryDecodeExport, true);
assert.equal(maximumDecodesInFlight, 1);
assert.equal(sharedDecodeWrites, 1, 'the cancelled decode generation writes nothing');

assert.equal(await exportAnimation({
  includeAudio: true,
  decodeAudio: delayedDecode,
  chooseTarget: async () => ({ async write() { sharedDecodeWrites++; } }),
}), true);
assert.equal(decodeCalls, 2, 'settled decode state is released for a later export');
assert.equal(maximumDecodesInFlight, 1);
assert.equal(sharedDecodeWrites, 2);

const targetStarted = deferred();
const targetCompletion = deferred();
const targetController = new AbortController();
let delayedTargetWrites = 0;
const delayedTargetExport = exportAnimation({
  signal: targetController.signal,
  chooseTarget: () => {
    targetStarted.resolve();
    return targetCompletion.promise;
  },
});
await targetStarted.promise;
targetController.abort();
targetCompletion.resolve({ async write() { delayedTargetWrites++; } });
await assert.rejects(delayedTargetExport, abortError);
assert.equal(delayedTargetWrites, 0, 'abort while selecting an Animation target commits no write');

const writeStarted = deferred();
const writeCompletion = deferred();
const writeController = new AbortController();
let writeSignal = null;
let committedWrites = 0;
const delayedWriteExport = exportAnimation({
  signal: writeController.signal,
  chooseTarget: async () => ({
    async write(_blob, options = {}) {
      writeSignal = options.signal;
      writeStarted.resolve();
      await writeCompletion.promise;
      if (writeSignal.aborted) throw writeSignal.reason;
      committedWrites++;
    },
  }),
});
await writeStarted.promise;
writeController.abort();
writeCompletion.resolve();
await assert.rejects(delayedWriteExport, abortError);
assert.equal(writeSignal, writeController.signal, 'Animation target writes receive the run signal');
assert.equal(committedWrites, 0, 'abort while an Animation target write is pending commits no write');

await loadFixture();
const visualYieldStarted = deferred();
const visualYieldCompletion = deferred();
const visualController = new AbortController();
let visualTargetSelections = 0;
let visualResolves = 0;
let visualWrites = 0;
const cancelledVisualResolve = exportAnimation({
  signal: visualController.signal,
  createFrameSource: () => ({
    frameCount: 3,
    holds: [1, 1, 1],
    resolve(index) {
      visualResolves++;
      return {
        hold: 1,
        layers: [{
          id: IDs.visualLayer,
          name: 'Visual',
          type: 'cell',
          visible: true,
          cells: { '0,0': { c: String(index) } },
        }],
      };
    },
  }),
  compositeAnimationFrame: (_frame) => ({ '0,0': { c: 'A' } }),
  visualYieldInterval: 1,
  visualYieldControl() {
    visualYieldStarted.resolve();
    return visualYieldCompletion.promise;
  },
  chooseTarget: async () => {
    visualTargetSelections++;
    return { async write() { visualWrites++; } };
  },
});
await visualYieldStarted.promise;
assert.deepEqual({ visualTargetSelections, visualResolves, visualWrites }, {
  visualTargetSelections: 1,
  visualResolves: 1,
  visualWrites: 0,
});
visualController.abort();
visualYieldCompletion.resolve();
await assert.rejects(cancelledVisualResolve, abortError);
assert.equal(visualResolves, 1, 'cancellation stops visual frame resolution at the next yield');
assert.equal(visualWrites, 0, 'cancellation during visual resolution commits no target write');

const videoPreflightStarted = deferred();
const videoPreflightCompletion = deferred();
const videoActivationEvents = [];
const delayedVideoPreflight = exportVideo(8, false, {
  getAudioState: () => ({ assets: [], tracks: [], clips: [] }),
  createFrameSource: () => ({
    frameCount: 1,
    holds: [1],
    resolve: () => ({ layers: [] }),
  }),
  createCanvas: () => ({ width: 0, height: 0, getContext: () => ({}) }),
  chooseTarget() {
    videoActivationEvents.push('target');
    return Promise.resolve({ async write() { videoActivationEvents.push('write'); } });
  },
  async preflight() {
    videoActivationEvents.push('preflight');
    videoPreflightStarted.resolve();
    await videoPreflightCompletion.promise;
    return {};
  },
  async encodeVideo() {
    videoActivationEvents.push('encode');
    return new Uint8Array([1, 2, 3]);
  },
});
assert.deepEqual(videoActivationEvents, ['target'],
  'MP4 target selection occurs in the calling activation turn before codec preflight');
await videoPreflightStarted.promise;
assert.deepEqual(videoActivationEvents, ['target', 'preflight']);
videoPreflightCompletion.resolve();
assert.equal(await delayedVideoPreflight, true);
assert.deepEqual(videoActivationEvents, ['target', 'preflight', 'encode', 'write']);

const unsupportedVideo = new Error('H.264 unavailable');
unsupportedVideo.code = 'H264_UNSUPPORTED';
let unsupportedVideoWrites = 0;
await assert.rejects(exportVideo(8, false, {
  getAudioState: () => ({ assets: [], tracks: [], clips: [] }),
  createFrameSource: () => ({
    frameCount: 1,
    holds: [1],
    resolve: () => ({ layers: [] }),
  }),
  createCanvas: () => ({ width: 0, height: 0, getContext: () => ({}) }),
  chooseTarget: async () => ({ async write() { unsupportedVideoWrites++; } }),
  preflight: async () => { throw unsupportedVideo; },
}), (error) => error === unsupportedVideo);
assert.equal(unsupportedVideoWrites, 0, 'unsupported MP4 preflight writes nothing');

for (const format of ['png', 'jpg']) {
  const imageStarted = deferred();
  let finishImage;
  let imageTargetSelections = 0;
  let imageWrites = 0;
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return { fillRect() {}, fillText() {} };
    },
    toBlob(callback) {
      finishImage = callback;
      imageStarted.resolve();
    },
  };
  const controller = new AbortController();
  const exporting = saveAsImage(format, 8, {
    signal: controller.signal,
    createCanvas: () => canvas,
    chooseTarget: async () => {
      imageTargetSelections++;
      return { async write() { imageWrites++; } };
    },
  });
  assert.equal(imageTargetSelections, 1,
    `${format} selects its target synchronously before canvas render/toBlob`);
  await imageStarted.promise;
  controller.abort();
  finishImage(new Blob([format], { type: format === 'jpg' ? 'image/jpeg' : 'image/png' }));
  await assert.rejects(exporting, abortError);
  assert.equal(imageTargetSelections, 1, `${format} reuses the already selected target`);
  assert.equal(imageWrites, 0, `${format} abort before toBlob commits no write`);
}

const imageRenderStarted = deferred();
const imageRenderCompletion = deferred();
const imageActivationEvents = [];
let imageRenderFailureWrites = 0;
const failedImageRender = saveAsImage('png', 8, {
  chooseTarget() {
    imageActivationEvents.push('target');
    return Promise.resolve({ async write() { imageRenderFailureWrites++; } });
  },
  async render() {
    imageActivationEvents.push('render');
    imageRenderStarted.resolve();
    await imageRenderCompletion.promise;
    throw new Error('render failed');
  },
});
assert.deepEqual(imageActivationEvents, ['target'],
  'image target selection occurs in the calling activation turn');
await imageRenderStarted.promise;
imageRenderCompletion.resolve();
await assert.rejects(failedImageRender, /render failed/);
assert.deepEqual(imageActivationEvents, ['target', 'render']);
assert.equal(imageRenderFailureWrites, 0, 'image render failure writes nothing');

const imageTargetStarted = deferred();
const imageTargetCompletion = deferred();
const imageTargetController = new AbortController();
let imageTargetWrites = 0;
const delayedImageTarget = saveAsImage('png', 8, {
  signal: imageTargetController.signal,
  render: async () => new Blob(['png'], { type: 'image/png' }),
  chooseTarget: () => {
    imageTargetStarted.resolve();
    return imageTargetCompletion.promise;
  },
});
await imageTargetStarted.promise;
imageTargetController.abort();
imageTargetCompletion.resolve({ async write() { imageTargetWrites++; } });
await assert.rejects(delayedImageTarget, abortError);
assert.equal(imageTargetWrites, 0, 'abort while selecting an image target commits no write');

const originalWindow = globalThis.window;
try {
  for (const [label, exportText] of [['Text', exportTXT], ['ANSI', exportANSI]]) {
    const pickerStarted = deferred();
    const pickerCompletion = deferred();
    let textWrites = 0;
    globalThis.window = {
      showSaveFilePicker() {
        pickerStarted.resolve();
        return pickerCompletion.promise;
      },
    };
    const controller = new AbortController();
    const exporting = exportText({ signal: controller.signal });
    await pickerStarted.promise;
    controller.abort();
    pickerCompletion.resolve({
      name: `${label.toLowerCase()}.txt`,
      async createWritable() {
        return {
          async write() { textWrites++; },
          async close() {},
          async abort() {},
        };
      },
    });
    await assert.rejects(exporting, abortError);
    assert.equal(textWrites, 0, `${label} abort while selecting a target commits no write`);
  }
} finally {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}
assert.equal(serializeJSON(), cancellationProject, 'all aborted exports preserve project data');
assert.equal(get(dirty), cancellationDirty, 'all aborted exports preserve dirty state');
assert.equal(get(canUndo), cancellationCanUndo, 'all aborted exports add no history entry');

const popupSource = fs.readFileSync(
  path.join(root, 'src/components/ExportPopup.svelte'),
  'utf8',
);
assert.match(popupSource, /const controller = new AbortController\(\)/,
  'every popup run owns an AbortController');
assert.doesNotMatch(popupSource, /format === 'video' \? new AbortController/,
  'popup controller creation is not MP4-only');
assert.match(popupSource, /onProjectReplaced\(/,
  'project replacement closes and cancels the export popup');
assert.match(popupSource, /saved && !controller\.signal\.aborted/,
  'an aborted run cannot report success by closing the popup');
assert.doesNotMatch(popupSource, /Package as ZIP|Download (?:ZIP |JSON )?Copy|Download Copy/,
  'Export exposes one primary output action with automatic audio packaging');
assert.match(popupSource, /One mixed WAV included; export will be ZIP\./,
  'audible audio explains the one-WAV ZIP output');
assert.match(popupSource, /> Exclude audio</,
  'audio can be explicitly excluded for plain JSON');
assert.doesNotMatch(popupSource, /Include audio/);
assert.match(popupSource, /format === 'video' \|\| format === 'animation-json'/,
  'long mixed-WAV encoding exposes cancellation');
assert.match(popupSource, /Preparing frames \$\{progress\}%/,
  'Animation visual materialization reports truthful progress');
assert.match(popupSource, />Cancel export</,
  'the cancellation action is explicit while visual/audio work is pending');
for (const call of ['saveAsImage', 'exportTXT', 'exportANSI', 'exportAnimation']) {
  assert.match(popupSource, new RegExp(`${call}\\([^;]*signal`, 's'),
    `${call} receives the popup run signal`);
}

console.log('cancellable atomic export regression tests passed');
