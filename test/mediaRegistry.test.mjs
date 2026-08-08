import assert from 'node:assert/strict';
import { Blob } from 'node:buffer';
import { unzipSync } from 'fflate';
import { get } from 'svelte/store';
import {
  audioClips,
  createAudioTrack,
  resetAudioState,
  updateAudioClip,
} from '../src/lib/audio.js';
import {
  currentAnimationExportPlan,
  exportAnimation,
  loadJSON,
  serializeJSON,
} from '../src/lib/fileio.js';
import {
  createImageLayer,
  createVideoLayer,
  collectHistoryReachability,
  layers,
  redo,
  removeLayer,
  setLayers,
  undo,
  updateVideoClip,
} from '../src/lib/grid.js';
import {
  importMediaFile,
  purgeUnusedMedia,
  replaceMediaFile,
} from '../src/lib/mediaCommands.js';
import { mediaPackagePath, sha256Hex } from '../src/lib/mediaHash.js';
import {
  currentMediaRegistry,
  loadMediaRegistry,
  mediaAssetById,
  registerMediaAsset,
} from '../src/lib/mediaRegistry.js';
import { notifications } from '../src/lib/notifications.js';
import {
  listProjectAssets,
  putProjectAsset,
} from '../src/lib/projectAssets.js';
import { setUuidGenerator } from '../src/lib/uuid.js';

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function namedBlob(contents, type, name) {
  const blob = new Blob([contents], { type });
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

function decodedAudioBuffer(duration, value = 0.125) {
  const samples = new Float32Array(Math.round(duration * 48_000)).fill(value);
  return {
    duration,
    length: samples.length,
    numberOfFrames: samples.length,
    numberOfChannels: 1,
    sampleRate: 48_000,
    getChannelData() { return samples; },
  };
}

let nextUuid = 1;
const restoreUuidGenerator = setUuidGenerator(() => (
  `20000000-0000-4000-8000-${(nextUuid++).toString(16).padStart(12, '0')}`
));

try {
  resetAudioState();
  loadMediaRegistry({ generation: 0, assets: [] });
  setLayers([]);

  const abc = namedBlob('abc', 'application/octet-stream', 'abc.bin');
  const abcHash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.equal(await sha256Hex(abc), abcHash, 'SHA-256 matches the independent abc vector');
  assert.equal(mediaPackagePath(abcHash), `assets/sha256/ba/${abcHash}`);
  await putProjectAsset(abcHash, abc, { size: 3, mime: abc.type });
  await putProjectAsset(abcHash, namedBlob('abc', abc.type, 'duplicate.bin'), {
    size: 3,
    mime: abc.type,
  });
  assert.equal((await listProjectAssets()).filter((record) => record.hash === abcHash).length, 1,
    'equal compressed bytes occupy one content-addressed cache record');

  let closed = false;
  const indexedRecord = { hash: abcHash, blob: abc, size: 3, mime: abc.type };
  const indexedDb = {
    transaction(storeName, mode) {
      assert.equal(storeName, 'media-test');
      assert.equal(mode, 'readonly');
      const transaction = {
        objectStore() {
          return {
            getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = [indexedRecord];
                request.onsuccess();
                queueMicrotask(() => transaction.oncomplete());
              });
              return request;
            },
          };
        },
      };
      return transaction;
    },
    close() { closed = true; },
  };
  assert.deepEqual(await listProjectAssets({
    openDatabase: async () => indexedDb,
    storeName: 'media-test',
  }), [indexedRecord], 'IndexedDB cache listing reads through its transaction store');
  assert.equal(closed, true);

  const registeredImage = registerMediaAsset({
    hash: abcHash,
    sourceName: 'source.png',
    mime: 'image/png',
    size: 3,
    kind: 'image',
    width: 10,
    height: 20,
  });
  const duplicateImage = registerMediaAsset({
    hash: abcHash,
    sourceName: 'same-bytes.png',
    mime: 'image/png',
    size: 3,
    kind: 'image',
    width: 10,
    height: 20,
  });
  assert.equal(duplicateImage.reused, true);
  assert.equal(duplicateImage.asset.assetId, registeredImage.asset.assetId,
    'same project bytes reuse one logical asset by default');
  assert.equal(currentMediaRegistry().assets.length, 1);

  const imageId = createImageLayer(
    registeredImage.asset.sourceName,
    { width: 10, height: 20 },
    registeredImage.asset.assetId,
  );
  await flush();
  removeLayer(imageId);
  await flush();
  assert.equal(mediaAssetById(registeredImage.asset.assetId)?.assetId,
    registeredImage.asset.assetId,
    'deleting the final placement retains its project asset');
  assert.equal(purgeUnusedMedia(), 1);
  assert.equal(mediaAssetById(registeredImage.asset.assetId), null);
  undo();
  assert.equal(mediaAssetById(registeredImage.asset.assetId)?.assetId,
    registeredImage.asset.assetId,
    'Undo restores purged registry metadata');
  undo();
  assert.equal(get(layers).some((layer) => layer.id === imageId), true,
    'the preceding Undo can still restore the retained final placement');

  layers.update((stack) => stack.map((layer) => layer.id === imageId ? {
    ...layer,
    transform: { x: 12, y: 9, scale: 2, rot: 15 },
  } : layer));
  const oldImageAsset = mediaAssetById(registeredImage.asset.assetId);
  const replacementImage = namedBlob('replacement-image', 'image/webp', 'replacement.webp');
  let closedImageRasters = 0;
  const imageReplacement = await replaceMediaFile(oldImageAsset.assetId, replacementImage, {
    decodeFile: async () => ({
      runtime: {
        raster: { width: 20, height: 10, close() { closedImageRasters++; } },
        blob: replacementImage,
      },
      metadata: { width: 20, height: 10 },
    }),
  });
  await flush();
  const replacedImageAsset = mediaAssetById(oldImageAsset.assetId);
  const replacedImageLayer = get(layers).find((layer) => layer.id === imageId);
  assert.equal(imageReplacement.asset.assetId, oldImageAsset.assetId);
  assert.equal(replacedImageAsset.assetId, oldImageAsset.assetId);
  assert.notEqual(replacedImageAsset.hash, oldImageAsset.hash);
  assert.deepEqual([
    replacedImageAsset.width * replacedImageLayer.transform.scaleX,
    replacedImageAsset.height * replacedImageLayer.transform.scaleY,
  ], [20, 40], 'different source dimensions preserve visible image size');
  assert.equal(replacedImageLayer.raster, undefined,
    'the command releases its temporary image raster to lazy runtime ownership');
  assert.equal(closedImageRasters, 1);
  assert.equal(collectHistoryReachability().has(oldImageAsset.hash), true,
    'Undo reachability marks the replaced byte generation for GC');
  undo();
  assert.equal(mediaAssetById(oldImageAsset.assetId).hash, oldImageAsset.hash);
  assert.deepEqual(get(layers).find((layer) => layer.id === imageId).transform,
    { x: 12, y: 9, scale: 2, rot: 15 });
  redo();
  await flush();
  assert.equal(collectHistoryReachability().has(oldImageAsset.hash), true);

  const imageProject = serializeJSON();
  assert.equal(imageProject.includes('data:image'), false);
  const parsedImageProject = JSON.parse(imageProject);
  assert.equal(parsedImageProject.version, 13);
  assert.equal('audio' in parsedImageProject, false);
  assert.equal('video' in parsedImageProject, false);
  loadJSON(imageProject);
  assert.equal(mediaAssetById(oldImageAsset.assetId)?.assetId, oldImageAsset.assetId,
    'replacement keeps the same asset UUID after reopen');

  const audioFile = namedBlob('five-second-audio', 'audio/wav', 'used.wav');
  const beforeAudioAssets = currentMediaRegistry().assets.length;
  const importedAudio = await importMediaFile(audioFile, 'audio', {
    decodeFile: async () => ({
      runtime: {
        blob: audioFile,
        buffer: decodedAudioBuffer(5),
        duration: 5,
        sourceName: audioFile.name,
        mime: audioFile.type,
        size: audioFile.size,
      },
      metadata: { duration: 5 },
    }),
  });
  await flush();
  assert.equal(get(audioClips).length, 1);
  assert.equal(importedAudio.asset.assetId, get(audioClips)[0].assetId);
  undo();
  assert.equal(get(audioClips).length, 0);
  assert.equal(currentMediaRegistry().assets.length, beforeAudioAssets,
    'one Undo removes the complete import and registry addition');
  redo();
  await flush();
  assert.equal(get(audioClips).length, 1);

  let audioClip = get(audioClips)[0];
  updateAudioClip(audioClip.trackId, audioClip.id, {
    inPoint: 1,
    outPoint: 4,
    volume: 0.4,
    muted: true,
  });
  audioClip = get(audioClips)[0];
  const usedAudioAsset = mediaAssetById(audioClip.assetId);
  const reusedAudio = createAudioTrack({
    blob: audioFile,
    buffer: decodedAudioBuffer(5),
    duration: 5,
    sourceName: audioFile.name,
    mime: audioFile.type,
    size: audioFile.size,
  }, 6, {
    assetId: usedAudioAsset.assetId,
    sourceName: usedAudioAsset.sourceName,
    inPoint: 0.5,
    outPoint: 5,
    volume: 0.7,
    retainRuntime: false,
  });
  const unusedAudioFile = namedBlob('unused-audio', 'audio/ogg', 'unused.ogg');
  const unusedAudioHash = await sha256Hex(unusedAudioFile);
  const unusedAudioAsset = registerMediaAsset({
    hash: unusedAudioHash,
    sourceName: unusedAudioFile.name,
    mime: unusedAudioFile.type,
    size: unusedAudioFile.size,
    kind: 'audio',
    duration: 3,
  }).asset;
  await putProjectAsset(unusedAudioHash, unusedAudioFile, unusedAudioAsset);

  const animationPlan = currentAnimationExportPlan({ includeAudio: true });
  assert.equal(animationPlan.kind, 'zip');
  assert.deepEqual(animationPlan.entries.slice(1), ['audio.wav'],
    'Animation planning emits one mixed WAV and excludes retained unreferenced media');
  assert.equal(animationPlan.audibleAudioCount, 1);
  let animationPackage = null;
  assert.equal(await exportAnimation({
    includeAudio: true,
    decodeAudio: async () => ({ buffer: decodedAudioBuffer(5) }),
    chooseTarget: async () => ({ async write(blob) { animationPackage = blob; } }),
  }), true);
  const animationEntries = unzipSync(new Uint8Array(await animationPackage.arrayBuffer()));
  assert.deepEqual(Object.keys(animationEntries).slice(1), ['audio.wav'],
    'Animation ZIP contains one mix rather than original source files');
  assert.equal(Object.keys(animationEntries).some((path) => path.includes('used.wav')), false);
  assert.equal(Object.keys(animationEntries).some((path) => path.includes('unused.ogg')), false);

  updateAudioClip(reusedAudio.track.id, reusedAudio.clip.id, { muted: true });
  assert.equal(currentAnimationExportPlan({ includeAudio: true }).kind, 'json',
    'muted-only Animation audio remains plain JSON');
  let mutedOnlyOutput = null;
  assert.equal(await exportAnimation({
    includeAudio: true,
    chooseTarget: async () => ({ async write(blob) { mutedOnlyOutput = blob; } }),
  }), true);
  assert.equal(mutedOnlyOutput.type, 'application/json');
  assert.equal('audio' in JSON.parse(await mutedOnlyOutput.text()), false);
  updateAudioClip(reusedAudio.track.id, reusedAudio.clip.id, { muted: false });

  notifications.set([]);
  const shortAudio = namedBlob('short-audio', 'audio/wav', 'short.wav');
  const audioReplacement = await replaceMediaFile(usedAudioAsset.assetId, shortAudio, {
    decodeFile: async () => ({
      runtime: {
        blob: shortAudio,
        buffer: { duration: 2 },
        duration: 2,
        sourceName: shortAudio.name,
        mime: shortAudio.type,
        size: shortAudio.size,
      },
      metadata: { duration: 2 },
    }),
  });
  audioClip = get(audioClips)[0];
  assert.equal(audioReplacement.asset.assetId, usedAudioAsset.assetId);
  assert.equal(audioReplacement.clamped, 2);
  assert.deepEqual(get(audioClips).map((clip) => ({
    inPoint: clip.inPoint,
    outPoint: clip.outPoint,
    volume: clip.volume,
    muted: clip.muted,
  })), [
    { inPoint: 1, outPoint: 2, volume: 0.4, muted: true },
    { inPoint: 0.5, outPoint: 2, volume: 0.7, muted: false },
  ]);
  assert.match(get(notifications).at(-1).message, /clamped 2 affected usages/);
  undo();
  assert.equal(mediaAssetById(usedAudioAsset.assetId).duration, 5);
  assert.deepEqual(get(audioClips).map((clip) => [clip.inPoint, clip.outPoint]), [
    [1, 4], [0.5, 5],
  ]);
  assert.equal(reusedAudio.asset.id, usedAudioAsset.assetId);

  const videoBytes = namedBlob('long-video', 'video/mp4', 'long.mp4');
  const videoHash = await sha256Hex(videoBytes);
  const videoAsset = registerMediaAsset({
    hash: videoHash,
    sourceName: videoBytes.name,
    mime: videoBytes.type,
    size: videoBytes.size,
    kind: 'video',
    duration: 10,
    width: 640,
    height: 360,
  }).asset;
  await putProjectAsset(videoHash, videoBytes, videoAsset);
  const videoId = createVideoLayer(videoAsset.sourceName, {
    assetId: videoAsset.assetId,
    duration: 10,
    width: 640,
    height: 360,
  });
  updateVideoClip(videoId, {
    inPoint: 8,
    outPoint: 10,
    playbackRate: 0.5,
  }, false);
  layers.update((stack) => stack.map((layer) => layer.id === videoId ? {
    ...layer,
    transform: { x: 12, y: 9, scale: 0.5, rot: 5 },
  } : layer));
  const secondVideoId = createVideoLayer(videoAsset.sourceName, {
    assetId: videoAsset.assetId,
    duration: 10,
    width: 640,
    height: 360,
  }, 4);
  updateVideoClip(secondVideoId, {
    inPoint: 0.5,
    outPoint: 5,
    playbackRate: 2,
  }, false);
  await flush();

  const shortVideo = namedBlob('short-video', 'video/webm', 'short.webm');
  const videoActivity = { paused: 0, cleared: 0, loaded: 0 };
  const videoReplacement = await replaceMediaFile(videoAsset.assetId, shortVideo, {
    decodeFile: async () => ({
      runtime: {
        element: {
          pause() { videoActivity.paused++; },
          removeAttribute() { videoActivity.cleared++; },
          load() { videoActivity.loaded++; },
        },
        raster: { width: 1280, height: 180 },
        blob: shortVideo,
        duration: 2,
        width: 1280,
        height: 180,
      },
      metadata: { duration: 2, width: 1280, height: 180 },
    }),
  });
  await flush();
  const replacedVideoAsset = mediaAssetById(videoAsset.assetId);
  let videoLayer = get(layers).find((layer) => layer.id === videoId);
  assert.equal(videoReplacement.asset.assetId, videoAsset.assetId);
  assert.equal(videoReplacement.clamped, 2);
  assert.deepEqual({
    inPoint: videoLayer.videoClip.inPoint,
    outPoint: videoLayer.videoClip.outPoint,
    playbackRate: videoLayer.videoClip.playbackRate,
  }, { inPoint: 1.999999, outPoint: 2, playbackRate: 0.5 });
  assert.deepEqual([
    replacedVideoAsset.width * videoLayer.transform.scaleX,
    replacedVideoAsset.height * videoLayer.transform.scaleY,
  ], [320, 180], 'different video dimensions preserve visible placement size');
  assert.deepEqual(videoActivity, { paused: 1, cleared: 1, loaded: 1 },
    'the temporary decoded replacement is disposed exactly once');
  assert.equal(videoLayer.videoElement, undefined);
  const secondVideoLayer = get(layers).find((layer) => layer.id === secondVideoId);
  assert.deepEqual([
    secondVideoLayer.videoClip.inPoint,
    secondVideoLayer.videoClip.outPoint,
    secondVideoLayer.videoClip.playbackRate,
    secondVideoLayer.videoClip.startTick,
  ], [0.5, 2, 2, 4]);
  assert.match(get(notifications).at(-1).message, /clamped 2 affected usages/);
  undo();
  videoLayer = get(layers).find((layer) => layer.id === videoId);
  assert.equal(mediaAssetById(videoAsset.assetId).hash, videoHash);
  assert.deepEqual([
    videoLayer.videoClip.inPoint,
    videoLayer.videoClip.outPoint,
    videoLayer.videoClip.playbackRate,
  ], [8, 10, 0.5]);
  assert.deepEqual([
    get(layers).find((layer) => layer.id === secondVideoId).videoClip.inPoint,
    get(layers).find((layer) => layer.id === secondVideoId).videoClip.outPoint,
  ], [0.5, 5]);

  const failedPrepareActivity = { paused: 0, cleared: 0, loaded: 0 };
  const registrySizeBeforeFailedPrepare = currentMediaRegistry().assets.length;
  await assert.rejects(importMediaFile(
    namedBlob('unhashable-video', 'video/mp4', 'unhashable.mp4'),
    'video',
    {
      hashFile: async () => { throw new Error('hash failed'); },
      decodeFile: async (file) => ({
        runtime: {
          element: {
            pause() { failedPrepareActivity.paused++; },
            removeAttribute() { failedPrepareActivity.cleared++; },
            load() { failedPrepareActivity.loaded++; },
          },
          raster: { width: 1, height: 1 },
          blob: file,
          duration: 1,
          width: 1,
          height: 1,
        },
        metadata: { duration: 1, width: 1, height: 1 },
      }),
    },
  ), /hash failed/);
  assert.deepEqual(failedPrepareActivity, { paused: 1, cleared: 1, loaded: 1 },
    'a hash failure disposes a concurrently prepared video runtime');
  assert.equal(currentMediaRegistry().assets.length, registrySizeBeforeFailedPrepare);

  const project = JSON.parse(serializeJSON());
  const forbidden = new Set([
    'raster', 'rasterURL', 'videoElement', 'videoBlob', 'videoURL', 'runtimeMediaKey',
    'blob', 'buffer', 'audioBuffer', 'objectURL', 'decoder', 'bytes', 'file',
  ]);
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false, `authoring JSON omits runtime field ${key}`);
      visit(child);
    }
  };
  visit(project);
  assert.equal(JSON.stringify(project).includes('data:image'), false);
  assert.equal(project.media.assets.some((asset) => asset.assetId === unusedAudioAsset.assetId), true,
    'the authoring project retains an unused asset until explicit Purge');
} finally {
  restoreUuidGenerator();
}

console.log('media registry integration tests passed');
