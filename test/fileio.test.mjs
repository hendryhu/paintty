import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { strFromU8, unzipSync } from 'fflate';
import { addLayer, layers, toggleGroupCollapsed } from '../src/lib/grid.js';
import {
  activeFrameIndex, frames, moveTimelineKeys, seekTick, setClipSelection, setLayerRaster, trimClip,
} from '../src/lib/frames.js';
import {
  exportAnimation,
  copyAsText,
  loadJSON,
  openFileDialog,
  saveJSON,
  saveJSONAs,
  serializeJSON,
  serializeLivePreview,
  serializeRecoverySnapshot,
  serializeTXT,
} from '../src/lib/fileio.js';
import { decodeProjectArchive, encodeProjectArchive } from '../src/lib/projectArchive.js';
import { putProjectAsset } from '../src/lib/projectAssets.js';
import { captureProjectRevision } from '../src/lib/documentLifecycle.js';
import { dirty, fileName } from '../src/lib/stores.js';
import { getClipTimelineState } from '../src/lib/clipTimelineState.js';
import { projectId } from '../src/lib/projectIdentity.js';
import { renderShapeToCells } from '../src/lib/shapes.js';

const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const id = (prefix) => `${prefix.repeat(8)}-${prefix.repeat(4)}-4${prefix.repeat(3)}-8${prefix.repeat(3)}-${prefix.repeat(12)}`;
const cell = (c, fg = '#ffffff', bg = null) => ({ c, fg, bg });
const shape = {
  kind: 'line', x0: 0, y0: 1, x1: 2, y1: 1,
  channel: 'glyph', style: 'outline', detail: 'cell', char: '#', fg: '#00ff00',
};

const IDs = {
  project: id('a'),
  frontLayer: id('1'), frontTrack: id('2'), frontClip: id('3'),
  imageLayer: id('4'), imageTrack: id('5'), imageClip: id('6'),
  groupLayer: id('7'), groupTrack: id('8'),
  backLayer: id('9'), backTrack: id('b'), backClip: id('c'),
  textLayer: id('d'), textTrack: id('e'), textClip: id('f'),
  shapeLayer: '10101010-1010-4010-8010-101010101010',
  shapeTrack: '20202020-2020-4020-8020-202020202020',
  shapeClip: '30303030-3030-4030-8030-303030303030',
  effectLayer: '40404040-4040-4040-8040-404040404040',
  effectTrack: '50505050-5050-4050-8050-505050505050',
  effectClip: '60606060-6060-4060-8060-606060606060',
  videoLayer: '70707070-7070-4070-8070-707070707070',
  videoTrack: '80808080-8080-4080-8080-808080808080',
  videoClip: '90909090-9090-4090-8090-909090909090',
  audioTrack: '12121212-1212-4212-8212-121212121212',
  audioClip: '13131313-1313-4313-8313-131313131313',
  imageAsset: '14141414-1414-4414-8414-141414141414',
  videoAsset: '15151515-1515-4515-8515-151515151515',
  audioAsset: '16161616-1616-4616-8616-161616161616',
  unusedAsset: '17171717-1717-4717-8717-171717171717',
  loopStartTag: '18181818-1818-4818-8818-181818181818',
  loopEndTag: '19191919-1919-4919-8919-191919191919',
  customTag: '21212121-2121-4121-8121-212121212121',
};

function layer(idValue, name, type, extra = {}) {
  return {
    id: idValue, name, type, visible: true, cells: {}, offset: { x: 0, y: 0 }, ...extra,
  };
}

function visualClip(idValue, trackId, outTick, payload, extra = {}) {
  return {
    id: idValue, trackId, kind: 'visual', startTick: 0,
    inTick: 0, outTick, sourceDuration: outTick,
    frameKeys: [{ tick: 0, value: payload }], propertyTracks: {}, ...extra,
  };
}

function fixtureAudioBuffer() {
  const left = new Float32Array(48_000).fill(0.25);
  const right = new Float32Array(48_000).fill(-0.25);
  return {
    duration: 1,
    length: 48_000,
    numberOfFrames: 48_000,
    numberOfChannels: 2,
    sampleRate: 48_000,
    getChannelData(channel) { return channel === 0 ? left : right; },
  };
}

function richProject() {
  return {
    format: 'paintty-sprite', version: 13, projectId: IDs.project,
    width: 6, height: 3, fps: 10,
    timeline: {
      tags: [
        { id: IDs.loopEndTag, tick: 21, type: 'loop-end' },
        { id: IDs.customTag, tick: 4, type: 'custom', value: '世界' },
        { id: IDs.loopStartTag, tick: 4, type: 'loop-start' },
      ],
      tracks: [
        {
          id: IDs.frontTrack, kind: 'visual', locked: false,
          layer: layer(IDs.frontLayer, 'Front', 'cell'),
        },
        {
          id: IDs.imageTrack, kind: 'visual', locked: false,
          layer: layer(IDs.imageLayer, 'Reference image', 'image', {
            assetId: IDs.imageAsset,
            transform: { x: 3, y: 1.5, scale: 1, rot: 0 },
          }),
        },
        {
          id: IDs.groupTrack, kind: 'group', locked: false,
          layer: layer(IDs.groupLayer, 'Group', 'group', { collapsed: false }),
          propertyTracks: {
            position: [
              { tick: 0, value: { x: 0, y: 0 } },
              { tick: 2, value: { x: 2, y: 0 } },
            ],
          },
        },
        {
          id: IDs.backTrack, kind: 'visual', locked: false, parentTrackId: IDs.groupTrack,
          layer: layer(IDs.backLayer, 'Back', 'background', { groupId: IDs.groupLayer }),
        },
        {
          id: IDs.textTrack, kind: 'visual', locked: false,
          layer: layer(IDs.textLayer, 'Text', 'text', {
            text: '', box: null, wrap: true, fg: '#ffffff', runs: [],
          }),
        },
        {
          id: IDs.shapeTrack, kind: 'visual', locked: false, shapePathKind: 'line',
          shapePathComponents: [],
          layer: layer(IDs.shapeLayer, 'Shape', 'shape', { shape: null }),
        },
        {
          id: IDs.effectTrack, kind: 'visual', locked: false,
          layer: layer(IDs.effectLayer, 'Effect', 'effect', {
            effect: { kind: 'brightness', intensity: 0 }, clipped: true,
            mask: { defaultStrength: 1, opacity: 1, cells: {}, offset: { x: 0, y: 0 } },
          }),
        },
        {
          id: IDs.videoTrack, kind: 'video', locked: false,
          layer: layer(IDs.videoLayer, 'Reference video', 'video', {
            assetId: IDs.videoAsset,
            transform: { x: 3, y: 1.5, scale: 1, rot: 0 },
          }),
        },
        { id: IDs.audioTrack, kind: 'audio', name: 'Voice', locked: false },
      ],
      clips: [
        {
          ...visualClip(IDs.frontClip, IDs.frontTrack, 3, {
            cells: { '0,0': cell('F', '#ffffff') },
          }),
          frameKeys: [
            { tick: 0, value: { cells: { '0,0': cell('F', '#ffffff') } } },
            { tick: 2, value: { cells: { '1,0': cell('N', '#ffffff') } } },
          ],
          propertyTracks: {
            visibility: [{ tick: 0, value: true }, { tick: 2, value: false }],
          },
        },
        visualClip(IDs.imageClip, IDs.imageTrack, 1, { cells: {} }),
        visualClip(IDs.backClip, IDs.backTrack, 3, {
          cells: { '0,0': cell('', null, '#112233') },
        }),
        visualClip(IDs.textClip, IDs.textTrack, 3, {
          cells: {}, text: 'Hi', box: { x: 0, y: 2, w: 2, h: 1 },
          wrap: false, fg: '#ffffff', runs: [{ start: 1, end: 2, fg: '#ff00ff' }],
        }),
        {
          ...visualClip(IDs.shapeClip, IDs.shapeTrack, 3, {
            cells: renderShapeToCells(shape), shape,
          }),
          propertyTracks: {
            shapePath: [
              { tick: 0, value: { kind: 'line', x0: 0, y0: 1, x1: 2, y1: 1 } },
              { tick: 2, value: { kind: 'line', x0: 2, y0: 1, x1: 4, y1: 1 } },
            ],
          },
        },
        {
          ...visualClip(IDs.effectClip, IDs.effectTrack, 3, {
            cells: {},
            mask: {
              defaultStrength: 1, opacity: 1,
              cells: { '0,0': { mask: 0.5 } }, offset: { x: 0, y: 0 },
            },
          }),
          propertyTracks: {
            effectIntensity: [{ tick: 0, value: 0 }, { tick: 2, value: 1 }],
            maskOpacity: [{ tick: 0, value: 1 }, { tick: 2, value: 0 }],
          },
        },
        {
          id: IDs.videoClip, trackId: IDs.videoTrack, kind: 'video',
          startTick: 4, inTick: 0, outTick: 10, sourceDuration: 10,
          frameKeys: [{ tick: 0, value: { cells: {} } }], propertyTracks: {},
          assetId: IDs.videoAsset, inPoint: 0, outPoint: 1, playbackRate: 1,
        },
        {
          id: IDs.audioClip, trackId: IDs.audioTrack, kind: 'audio',
          startTick: 12, inTick: 0, outTick: 10, sourceDuration: 10,
          frameKeys: [], propertyTracks: {}, assetId: IDs.audioAsset,
          inPoint: 0, outPoint: 1, volume: 0.75, muted: false,
        },
      ],
    },
    media: {
      generation: 4,
      assets: [
        { assetId: IDs.imageAsset, hash: EMPTY_HASH, path: `assets/sha256/e3/${EMPTY_HASH}`,
          sourceName: 'image.png', mime: 'image/png', size: 0, kind: 'image', width: 2, height: 2, generation: 1 },
        { assetId: IDs.videoAsset, hash: EMPTY_HASH, path: `assets/sha256/e3/${EMPTY_HASH}`,
          sourceName: 'video.mp4', mime: 'video/mp4', size: 0, kind: 'video', duration: 1,
          width: 2, height: 2, generation: 1 },
        { assetId: IDs.audioAsset, hash: EMPTY_HASH, path: `assets/sha256/e3/${EMPTY_HASH}`,
          sourceName: 'voice.wav', mime: 'audio/wav', size: 0, kind: 'audio', duration: 1, generation: 1 },
        { assetId: IDs.unusedAsset, hash: EMPTY_HASH, path: `assets/sha256/e3/${EMPTY_HASH}`,
          sourceName: 'unused.png', mime: 'image/png', size: 0, kind: 'image', width: 1, height: 1, generation: 1 },
      ],
    },
  };
}

const source = richProject();
loadJSON(JSON.stringify(source));
assert.deepEqual(JSON.parse(serializeJSON()), source,
  'all canonical layer payloads, sparse properties, clips, and retained media round-trip exactly');
assert.deepEqual(Object.keys(JSON.parse(serializeJSON()).timeline).sort(), ['clips', 'tags', 'tracks']);
for (const [input, expected] of [[2, 1], [-2, 0]]) {
  const volumeProject = structuredClone(source);
  const track = volumeProject.timeline.tracks.find((entry) => entry.kind === 'audio');
  track.volume = input;
  track.muted = true;
  loadJSON(JSON.stringify(volumeProject));
  const loadedTrack = JSON.parse(serializeJSON()).timeline.tracks
    .find((entry) => entry.kind === 'audio');
  assert.equal(loadedTrack.volume, expected, `loaded track volume ${input} clamps to ${expected}`);
  assert.equal(loadedTrack.muted, true, 'loaded track mute survives volume normalization');
}
loadJSON(JSON.stringify(source));
assert.equal(get(frames).length, 22, 'audio extends the shared transport beyond visual/video clips');
assert.deepEqual(get(layers).map((layer) => layer.type),
  ['cell', 'image', 'group', 'background', 'text', 'shape', 'effect', 'video']);

seekTick(1);
const shapeLayer = get(layers).find((layer) => layer.type === 'shape');
assert.deepEqual({ x0: shapeLayer.shape.x0, x1: shapeLayer.shape.x1 }, { x0: 1, x1: 3 });
assert.equal(shapeLayer.cells['1,1'].c, '#');
const effectLayer = get(layers).find((layer) => layer.type === 'effect');
assert.equal(effectLayer.effect.intensity, 0.5);
assert.equal(effectLayer.mask.opacity, 0.5);
assert.deepEqual(get(layers).find((layer) => layer.type === 'group').offset, { x: 1, y: 0 });
assert.equal(get(layers).find((layer) => layer.type === 'text').cells['1,2'].fg, '#ff00ff');
const preview = JSON.parse(serializeLivePreview());
assert.equal(preview.format, 'paintty-preview');
assert.equal(preview.version, 1);
assert.equal(preview.ticks.length, 22);
assert.deepEqual(Object.keys(preview).sort(), ['format', 'fps', 'height', 'tags', 'ticks', 'version', 'width']);
assert.deepEqual(preview.tags, [
  { tick: 4, type: 'loop-start' },
  { tick: 4, type: 'custom', value: '世界' },
  { tick: 21, type: 'loop-end' },
]);
assert.deepEqual(Object.keys(preview.ticks[1].layers.find((layer) => layer.type === 'shape').cells),
  ['1,1', '2,1', '3,1'], 'resolved live preview rasterizes interpolated shape paths');

seekTick(4);
const videoLayer = get(layers).find((layer) => layer.type === 'video');
assert.deepEqual({
  assetId: videoLayer.videoClip.assetId,
  startTick: videoLayer.videoClip.startTick,
  inPoint: videoLayer.videoClip.inPoint,
  outPoint: videoLayer.videoClip.outPoint,
  playbackRate: videoLayer.videoClip.playbackRate,
}, {
  assetId: IDs.videoAsset, startTick: 4, inPoint: 0, outPoint: 1, playbackRate: 1,
});
assert.equal(trimClip(IDs.videoClip, 'start', 6).changed, true);
const trimmedVideoProject = JSON.parse(serializeJSON());
const trimmedVideo = trimmedVideoProject.timeline.clips.find((clip) => clip.id === IDs.videoClip);
assert.deepEqual({
  startTick: trimmedVideo.startTick,
  inTick: trimmedVideo.inTick,
  outTick: trimmedVideo.outTick,
  sourceDuration: trimmedVideo.sourceDuration,
  inPoint: trimmedVideo.inPoint,
  outPoint: trimmedVideo.outPoint,
}, {
  startTick: 6, inTick: 0, outTick: 8, sourceDuration: 8, inPoint: 0.2, outPoint: 1,
});
loadJSON(JSON.stringify(trimmedVideoProject));
assert.deepEqual(JSON.parse(serializeJSON()), trimmedVideoProject,
  'trimmed video source seconds and canonical ticks reopen exactly');
loadJSON(JSON.stringify(source));
seekTick(4);

const recoveryKeySelection = {
  frameKeys: [{ clipId: IDs.frontClip, sourceTick: 2 }],
  propertyKeys: [
    { clipId: IDs.frontClip, propertyName: 'visibility', sourceTick: 2 },
    { clipId: IDs.shapeClip, propertyName: 'shapePath', sourceTick: 2 },
  ],
};
setClipSelection(recoveryKeySelection);
assert.equal(moveTimelineKeys(recoveryKeySelection, -1).changed, true);
const movedKeyRecovery = serializeRecoverySnapshot();
loadJSON(movedKeyRecovery.contents);
const recoveredKeyState = getClipTimelineState();
assert.deepEqual(recoveredKeyState.clips.find((clip) => clip.id === IDs.frontClip)
  .frameKeys.map((key) => key.tick), [0, 1]);
assert.deepEqual(recoveredKeyState.clips.find((clip) => clip.id === IDs.frontClip)
  .propertyTracks.visibility.map((key) => key.tick), [0, 1]);
assert.deepEqual(recoveredKeyState.clips.find((clip) => clip.id === IDs.shapeClip)
  .propertyTracks.shapePath.map((key) => key.tick), [0, 1],
  'recovery contents preserve mixed moved key source ticks across clips');
loadJSON(JSON.stringify(source));
seekTick(4);

const runtimeRaster = { width: 2, height: 2, getContext() {} };
setLayerRaster(IDs.imageLayer, runtimeRaster);
assert.equal(get(layers).find((layer) => layer.id === IDs.imageLayer).raster, runtimeRaster);
const runtimeFree = serializeJSON();
for (const forbidden of ['raster', 'videoElement', 'videoURL', 'audioBuffer', 'decoder']) {
  assert.equal(runtimeFree.includes(`"${forbidden}"`), false);
}

seekTick(0);
assert.match(serializeTXT(), /^F/);
assert.equal(get(activeFrameIndex), 0);
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let copiedText = null;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { async writeText(value) { copiedText = value; } } },
});
assert.equal(await copyAsText(), true);
assert.equal(copiedText, serializeTXT(), 'Copy as Text writes raw serializeTXT bytes');
if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
else delete globalThis.navigator;

const recovery = serializeRecoverySnapshot();
assert.deepEqual(Object.keys(JSON.parse(recovery.contents).timeline).sort(), ['clips', 'tags', 'tracks']);
assert.deepEqual(JSON.parse(recovery.contents).timeline.tags, source.timeline.tags,
  'recovery preserves exact author tag IDs, order, and values');
toggleGroupCollapsed(IDs.groupLayer);
const collapsedRecovery = serializeRecoverySnapshot();
assert.notEqual(collapsedRecovery.contents, recovery.contents,
  'recovery contents retain panel collapse context');
assert.equal(collapsedRecovery.contentKey, recovery.contentKey,
  'panel-only collapse does not create a second authored content revision');
toggleGroupCollapsed(IDs.groupLayer);

const baseline = serializeJSON();
const baselineRevision = captureProjectRevision();
const baselineProjectId = get(projectId);
for (const [label, mutate, pattern] of [
  ['missing tags', (project) => { delete project.timeline.tags; }, /Timeline tags must be an array/],
  ['old-only shape', (project) => {
    project.timeline = { frameCount: 1, holds: [1], layers: [] };
  }, /unsupported field frameCount/],
  ['mixed shape', (project) => { project.timeline.layers = []; }, /unsupported field layers/],
  ['duplicate key tick', (project) => {
    project.timeline.clips[0].frameKeys.push(structuredClone(project.timeline.clips[0].frameKeys[0]));
  }, /strictly increasing/],
  ['invalid clip bound', (project) => { project.timeline.clips[0].outTick = 0; }, /outTick/],
  ['unknown payload field', (project) => {
    project.timeline.clips[0].frameKeys[0].value.offset = { x: 1, y: 2 };
  }, /unsupported field offset/],
  ['duplicate visual track name alias', (project) => {
    project.timeline.tracks.find((track) => track.layer).name = 'Duplicate';
  }, /duplicates its layer name/],
  ['unknown property authority', (project) => {
    project.timeline.clips[0].propertyTracks.legacyPosition = [];
  }, /unsupported property legacyPosition/],
  ['invalid property value', (project) => {
    project.timeline.clips[0].propertyTracks.position = [
      { tick: 0, value: { x: '1', y: 0 } },
    ];
  }, /integer x\/y/],
  ['unsupported tag field', (project) => {
    project.timeline.tags[0].extra = true;
  }, /unsupported field extra/],
  ['duplicate tag ID', (project) => {
    project.timeline.tags[1].id = project.timeline.tags[0].id;
  }, /Duplicate timeline tag ID/],
  ['duplicate loop singleton', (project) => {
    project.timeline.tags[1] = {
      id: project.timeline.tags[1].id,
      tick: 4,
      type: 'loop-end',
    };
  }, /only one loop-end/],
  ['untrimmed custom tag', (project) => {
    project.timeline.tags[1].value = ' event ';
  }, /must be trimmed/],
  ['out-of-range tag', (project) => {
    project.timeline.tags[0].tick = 22;
  }, /inside the sequence/],
]) {
  const invalid = JSON.parse(baseline);
  mutate(invalid);
  assert.throws(() => loadJSON(JSON.stringify(invalid)), pattern, label);
  assert.equal(serializeJSON(), baseline, `${label} must leave the project unchanged`);
  assert.equal(captureProjectRevision(), baselineRevision);
  assert.equal(get(projectId), baselineProjectId);
}

const emptyBlob = new Blob([]);
const archive = await encodeProjectArchive({
  document: source,
  mediaBlobs: new Map([[EMPTY_HASH, emptyBlob]]),
}, 'uint8array');
const decoded = await decodeProjectArchive(archive);
assert.deepEqual(decoded.document, source);
assert.equal(decoded.mediaBlobs.size, 1, 'equal retained bytes are packaged once by hash');
assert.equal(decoded.manifest.assets.length, 4, 'the complete logical registry remains in project.json');

await putProjectAsset(EMPTY_HASH, emptyBlob, source.media.assets[0]);
loadJSON(JSON.stringify(source));
fileName.set('rich.paintty');
let packageBlob;
assert.equal(await saveJSONAs({
  checkpoint: async () => {},
  notifySaved: async () => {},
  chooseTarget: async () => ({
    name: 'rich.paintty',
    async write(blob) { packageBlob = blob; },
  }),
}), true);
const savedPackage = await decodeProjectArchive(new Uint8Array(await packageBlob.arrayBuffer()));
assert.deepEqual(savedPackage.document, source);
assert.equal(get(dirty), false);

let runtimeBlob;
await exportAnimation({
  chooseTarget: async () => ({ async write(blob) { runtimeBlob = blob; } }),
});
const runtime = JSON.parse(await runtimeBlob.text());
assert.equal(runtime.format, 'paintty-animation');
assert.deepEqual(runtime.layers.map((entry) => entry.id),
  runtime.layers.map((_, index) => index), 'runtime layer indexes are dense and export-local');
assert.equal(runtime.layers.some((entry) => entry.name === 'Reference image'), false);
assert.equal(runtime.layers.some((entry) => entry.name === 'Reference video'), false);
assert.equal(JSON.stringify(runtime).includes(IDs.project), false);
assert.equal(JSON.stringify(runtime).includes(IDs.frontLayer), false);
assert.equal(JSON.stringify(runtime).includes(IDs.customTag), false);
assert.deepEqual(runtime.tags, preview.tags);

let audioRuntimeZip;
await exportAnimation({
  includeAudio: true,
  decodeAudio: async () => ({ buffer: fixtureAudioBuffer() }),
  chooseTarget: async () => ({ async write(blob) { audioRuntimeZip = blob; } }),
});
const entries = unzipSync(new Uint8Array(await audioRuntimeZip.arrayBuffer()));
const embedded = JSON.parse(strFromU8(entries['rich.json']));
assert.deepEqual(Object.keys(entries), ['rich.json', 'audio.wav']);
assert.deepEqual(embedded.audio, {
  source: 'audio.wav',
  mime: 'audio/wav',
  sampleRate: 48_000,
  channels: 2,
  durationUs: 2_200_000,
});
assert.equal('audioAssets' in embedded, false);
assert.equal('audioTracks' in embedded, false);
assert.equal(strFromU8(entries['rich.json']).includes('voice.wav'), false);
assert.equal(Object.keys(entries).some((path) => path.includes(IDs.audioAsset)), false);
assert.equal(strFromU8(entries['audio.wav'].subarray(0, 4)), 'RIFF');
assert.equal(entries['audio.wav'].length, 44 + 105_600 * 4,
  'mixed WAV spans the exact shared 22-tick sequence');
assert.deepEqual(embedded.tags, runtime.tags);

loadJSON(serializeJSON());
dirty.set(true);
fileName.set('recovery-failure.paintty');
let durableWrite = null;
let recoveryReports = 0;
assert.equal(await saveJSON({
  checkpoint: async () => { throw new Error('recovery unavailable'); },
  reportRecoveryError(error) {
    assert.match(error.message, /recovery unavailable/);
    recoveryReports++;
  },
  notifySaved: async () => {},
  chooseTarget: async () => ({
    name: 'recovery-failure.paintty',
    durable: true,
    async write(blob) { durableWrite = blob; },
  }),
}), true);
assert.ok(durableWrite instanceof Blob, 'disk save proceeds after checkpoint failure');
assert.equal(recoveryReports, 1);
assert.equal(get(dirty), false, 'a durable write determines the clean state');

dirty.set(true);
fileName.set('download-only.paintty');
let unverifiedReports = 0;
let unverifiedSavedNotifications = 0;
assert.equal(await saveJSONAs({
  checkpoint: async () => {},
  reportUnverifiedSave() { unverifiedReports++; },
  notifySaved: async () => { unverifiedSavedNotifications++; },
  chooseTarget: async () => ({
    name: 'download-only.paintty',
    durable: false,
    async write() {},
  }),
}), true);
assert.equal(unverifiedReports, 1);
assert.equal(unverifiedSavedNotifications, 0);
assert.equal(get(fileName), 'download-only.paintty');
assert.equal(get(dirty), true, 'an unverified browser download cannot clean the project');

fileName.set('source.JSON');
dirty.set(true);
let saveAsSuggestion = null;
let saveAsMime = null;
let saveAsBlob = null;
assert.equal(await saveJSONAs({
  checkpoint: async () => {},
  notifySaved: async () => {},
  chooseTarget: async (filename, type) => {
    saveAsSuggestion = filename;
    saveAsMime = type;
    return {
      name: filename,
      durable: true,
      async write(blob) { saveAsBlob = blob; },
    };
  },
}), true);
assert.equal(saveAsSuggestion, 'source.paintty');
assert.equal(saveAsMime, 'application/zip');
assert.deepEqual(
  (await decodeProjectArchive(new Uint8Array(await saveAsBlob.arrayBuffer()))).document,
  JSON.parse(serializeJSON()),
  'Save As packages editable current-schema state even when the source name ends in JSON',
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function staleArchiveOpen(mutateWhileCaching) {
  const input = { files: [], click() {} };
  const cacheStarted = deferred();
  const cacheFinish = deferred();
  let restored = 0;
  let cachedRecords = null;
  openFileDialog({
    createInput: () => input,
    decodeArchive: async () => ({
      document: JSON.parse(serializeJSON()),
      mediaBlobs: new Map([
        ['a'.repeat(64), new Blob(['a'])],
        ['b'.repeat(64), new Blob(['b'])],
      ]),
    }),
    storeAssets: async (records) => {
      cachedRecords = records;
      cacheStarted.resolve();
      await cacheFinish.promise;
    },
    loadProject: () => { restored++; },
    showError(error) { throw new Error(error); },
  });
  input.files = [{ name: 'large.paintty', async arrayBuffer() { return new ArrayBuffer(0); } }];
  const opening = input.onchange();
  await cacheStarted.promise;
  mutateWhileCaching();
  cacheFinish.resolve();
  await opening;
  assert.equal(cachedRecords.length, 2, 'archive media cache writes are one complete batch');
  assert.equal(restored, 0, 'stale archive restore is rejected after its cache write');
}

await staleArchiveOpen(() => addLayer('cell'));
const replacementContents = serializeJSON();
await staleArchiveOpen(() => loadJSON(replacementContents));

assert.deepEqual(getClipTimelineState().clips.find((clip) => clip.kind === 'video') && {
  startTick: getClipTimelineState().clips.find((clip) => clip.kind === 'video').startTick,
  inPoint: getClipTimelineState().clips.find((clip) => clip.kind === 'video').inPoint,
  outPoint: getClipTimelineState().clips.find((clip) => clip.kind === 'video').outPoint,
}, { startTick: 4, inPoint: 0, outPoint: 1 });

console.log('canonical file, package, recovery, and runtime export tests passed');
