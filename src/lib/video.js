import { writable } from 'svelte/store';

export const videoFrameRevision = writable(0);
export const videoRasterStatus = writable(new Map());
const videoDecodeRequestCounts = writable(new Map());
export const videoDecodeRequests = { subscribe: videoDecodeRequestCounts.subscribe };

const seekTokens = new Map();
const seekControllers = new Map();
const queuedSeeks = new Map();
const activeSeeks = new Map();
const seekWorkers = new Map();
const readySeeks = new Map();
const SEEK_EPSILON_SECONDS = 0.001;
const SEEK_TIMEOUT_MS = 1000;
const VIDEO_TIME_BOUNDARY_ULPS = 32;
const DEFAULT_VIDEO_FPS = 24;
export const MIN_VIDEO_CLIP_SECONDS = 1e-6;
export const MIN_VIDEO_PLAYBACK_RATE = 0.01;
export const MAX_VIDEO_PLAYBACK_RATE = 100;
const releasedVideoElements = new WeakSet();
const releasedVideoURLsByElement = new WeakMap();
let nextSeekToken = 1;

export function requestVideoFrameDecode(clipId) {
  let released = false;
  videoDecodeRequestCounts.update((counts) => {
    const next = new Map(counts);
    next.set(clipId, (next.get(clipId) || 0) + 1);
    return next;
  });
  return () => {
    if (released) return;
    released = true;
    videoDecodeRequestCounts.update((counts) => {
      const next = new Map(counts);
      const remaining = (next.get(clipId) || 1) - 1;
      if (remaining > 0) next.set(clipId, remaining);
      else next.delete(clipId);
      return next;
    });
  };
}

function publishRasterStatus(clipId, status) {
  if (clipId == null) return;
  videoRasterStatus.update((statuses) => {
    const next = new Map(statuses);
    next.set(clipId, status);
    return next;
  });
}

function projectTick(value) {
  return Math.max(0, Math.round(Number(value)) || 0);
}

function videoFps(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : DEFAULT_VIDEO_FPS;
}

function stableIntegerBoundary(value, round) {
  const nearest = Math.round(value);
  const scale = Math.max(1, Math.abs(value));
  const tolerance = Number.EPSILON * scale * VIDEO_TIME_BOUNDARY_ULPS;
  return Math.abs(value - nearest) <= tolerance ? nearest : round(value);
}

export function normalizeVideoClip(clip = {}) {
  const normalized = { ...(clip || {}) };
  delete normalized.startFrame;
  const durationValue = Number(clip?.duration);
  const duration = Number.isFinite(durationValue) ? Math.max(0, durationValue) : 0;
  const startTick = projectTick(clip?.startTick);
  const rateValue = Number(clip?.playbackRate);
  const playbackRate = Number.isFinite(rateValue) && rateValue > 0
    ? Math.max(MIN_VIDEO_PLAYBACK_RATE, Math.min(MAX_VIDEO_PLAYBACK_RATE, rateValue))
    : 1;
  if (duration === 0) {
    return { ...normalized, startTick, inPoint: 0, outPoint: 0, playbackRate, duration };
  }

  const minClipSeconds = Math.min(MIN_VIDEO_CLIP_SECONDS, duration);
  const inValue = Number(clip?.inPoint);
  const inPoint = Math.max(0, Math.min(
    duration - minClipSeconds,
    Number.isFinite(inValue) ? inValue : 0,
  ));
  const outValue = clip?.outPoint == null ? duration : Number(clip.outPoint);
  const outPoint = Math.max(
    inPoint + minClipSeconds,
    Math.min(duration, Number.isFinite(outValue) ? outValue : duration),
  );
  return { ...normalized, startTick, inPoint, outPoint, playbackRate, duration };
}

// Keep an exact clip-end tick inactive despite floating-point drift.
function isBeforeVideoOutPoint(time, outPoint) {
  const scale = Math.max(1, Math.abs(time), Math.abs(outPoint));
  return time < outPoint - Number.EPSILON * scale * VIDEO_TIME_BOUNDARY_ULPS;
}

export function videoClipDurationTicks(clip, fps = DEFAULT_VIDEO_FPS) {
  const normalized = normalizeVideoClip(clip);
  const playableSeconds = Math.max(0, normalized.outPoint - normalized.inPoint);
  const exactTicks = playableSeconds * videoFps(fps) / normalized.playbackRate;
  return Math.max(0, stableIntegerBoundary(exactTicks, Math.ceil));
}

export function videoClipEndTick(clip, fps = DEFAULT_VIDEO_FPS) {
  const normalized = normalizeVideoClip(clip);
  return normalized.startTick + videoClipDurationTicks(normalized, fps);
}

export function videoRasterReadyAt(status, identity) {
  return status?.state === 'ready' &&
    status.clipId === identity?.clipId &&
    status.assetId === (identity?.assetId ?? null) &&
    status.projectTick === projectTick(identity?.projectTick);
}

export function videoStateAtTick(clip, tickValue, fps = DEFAULT_VIDEO_FPS) {
  const normalized = normalizeVideoClip(clip);
  const { startTick, inPoint, outPoint, playbackRate } = normalized;
  const tick = projectTick(tickValue);
  if (tick < startTick || outPoint <= inPoint) {
    return { active: false, time: inPoint, elapsed: 0 };
  }
  const elapsed = (tick - startTick) / videoFps(fps);
  const time = inPoint + elapsed * playbackRate;
  return { active: isBeforeVideoOutPoint(time, outPoint), time: Math.min(time, outPoint), elapsed };
}

export function trimVideoClipStartToTick(clip, targetTick, fps = DEFAULT_VIDEO_FPS) {
  const normalized = normalizeVideoClip(clip);
  const rate = videoFps(fps);
  const availablePrefixTicks = Math.max(0, stableIntegerBoundary(
    normalized.inPoint * rate / normalized.playbackRate,
    Math.floor,
  ));
  const earliestStart = Math.max(0, normalized.startTick - availablePrefixTicks);
  const latestStart = normalized.startTick + Math.max(
    0,
    videoClipDurationTicks(normalized, rate) - 1,
  );
  const startTick = Math.max(earliestStart, Math.min(latestStart, projectTick(targetTick)));
  if (startTick === normalized.startTick) return normalized;
  const sourceDelta = (startTick - normalized.startTick) / rate * normalized.playbackRate;
  return normalizeVideoClip({
    ...normalized,
    startTick,
    inPoint: normalized.inPoint + sourceDelta,
  });
}

export function trimVideoClipEndToTick(clip, targetTick, fps = DEFAULT_VIDEO_FPS) {
  const normalized = normalizeVideoClip(clip);
  if (normalized.outPoint <= normalized.inPoint) return normalized;
  const rate = videoFps(fps);
  const currentEndTick = videoClipEndTick(normalized, rate);
  const sourceEndTick = normalized.startTick + Math.max(1, stableIntegerBoundary(
    (normalized.duration - normalized.inPoint) * rate / normalized.playbackRate,
    Math.ceil,
  ));
  const endTick = Math.max(
    normalized.startTick + 1,
    Math.min(sourceEndTick, projectTick(targetTick)),
  );
  if (endTick === currentEndTick) return normalized;
  const sourceSpan = (endTick - normalized.startTick) / rate * normalized.playbackRate;
  return normalizeVideoClip({
    ...normalized,
    outPoint: normalized.inPoint + sourceSpan,
  });
}

export function releaseVideoSource(source) {
  const element = source?.element || source?.videoElement;
  const url = source?.url || source?.videoURL;
  const objectElement = element !== null &&
    (typeof element === 'object' || typeof element === 'function');
  const firstElementRelease = objectElement && !releasedVideoElements.has(element);
  if (firstElementRelease) {
    releasedVideoElements.add(element);
    try { element.pause?.(); } catch {}
    try {
      element.removeAttribute?.('src');
      element.load?.();
    } catch {}
  }
  let firstURLRelease = !!url;
  if (url && objectElement) {
    const releasedURLs = releasedVideoURLsByElement.get(element) || new Set();
    firstURLRelease = !releasedURLs.has(url);
    releasedURLs.add(url);
    releasedVideoURLsByElement.set(element, releasedURLs);
  }
  // History clones share the media element, which gives cleanup a weak, idempotent identity.
  if (firstURLRelease) {
    if (typeof globalThis.URL?.revokeObjectURL === 'function') {
      try { globalThis.URL.revokeObjectURL(url); } catch {}
    }
  }
}

export function loadVideoSource(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    const clearLoadHandlers = () => {
      video.onloadedmetadata = null;
      video.ondurationchange = null;
      video.onerror = null;
    };
    const finish = () => {
      if (!Number.isFinite(video.duration)) return;
      clearLoadHandlers();
      const raster = document.createElement('canvas');
      raster.width = video.videoWidth;
      raster.height = video.videoHeight;
      resolve({
        element: video,
        raster,
        url,
        blob: file,
        mime: file.type || 'video/mp4',
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };
    video.onloadedmetadata = finish;
    video.ondurationchange = finish;
    video.onerror = () => {
      clearLoadHandlers();
      URL.revokeObjectURL(url);
      reject(new Error('The selected video could not be decoded.'));
    };
    video.src = url;
  });
}

function seekAbortError() {
  const error = new Error('Video seek canceled');
  error.name = 'AbortError';
  return error;
}

async function seek(video, time, signal) {
  const ready = () => !video.seeking && video.readyState >= 2 &&
    Math.abs(video.currentTime - time) < SEEK_EPSILON_SECONDS;
  if (signal?.aborted) throw seekAbortError();
  if (ready()) return;
  await new Promise((resolve, reject) => {
    const done = () => {
      if (!ready()) return;
      cleanup();
      resolve();
    };
    const loaded = () => { if (ready()) done(); };
    const failed = () => { cleanup(); reject(new Error('Could not read this video frame.')); };
    const aborted = () => { cleanup(); reject(seekAbortError()); };
    const cleanup = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('error', failed);
      signal?.removeEventListener('abort', aborted);
    };
    video.addEventListener('seeked', done);
    video.addEventListener('loadeddata', loaded);
    video.addEventListener('error', failed, { once: true });
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) {
      aborted();
      return;
    }
    video.currentTime = time;
  });
}

function sameSeek(request, layer, identity, time) {
  return request?.layer.videoElement === layer.videoElement &&
    request.layer.raster === layer.raster &&
    request.identity.clipId === identity.clipId &&
    request.identity.assetId === identity.assetId &&
    request.identity.projectTick === identity.projectTick &&
    Math.abs(request.state.time - time) < SEEK_EPSILON_SECONDS;
}

function sameSource(request, layer) {
  return request?.layer.videoElement === layer?.videoElement &&
    request.layer.raster === layer?.raster &&
    request.identity.assetId === (layer?.videoClip?.assetId ?? null);
}

function drawDecodedFrame(request) {
  const { layer } = request;
  const { videoElement: video, raster } = layer;
  if (raster.width !== video.videoWidth || raster.height !== video.videoHeight) {
    raster.width = video.videoWidth;
    raster.height = video.videoHeight;
  }
  raster.getContext('2d').drawImage(video, 0, 0, raster.width, raster.height);
  videoFrameRevision.update((n) => n + 1);
}

// One worker per clip coalesces queued seeks; tokens prevent overtaken decodes from
// publishing except for same-source playback intermediates.
async function drainVideoSeeks(clipId) {
  try {
    while (queuedSeeks.has(clipId)) {
      const request = queuedSeeks.get(clipId);
      queuedSeeks.delete(clipId);
      activeSeeks.set(clipId, request);
      const controller = new AbortController();
      seekControllers.set(clipId, controller);
      let timedOut = false;
      const watchdog = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, SEEK_TIMEOUT_MS);
      let decoded = false;
      try {
        await seek(request.layer.videoElement, request.state.time, controller.signal);
        decoded = true;
      } catch (error) {
        if ((timedOut || error?.name !== 'AbortError') &&
          seekTokens.get(clipId) === request.identity.token) {
          publishRasterStatus(clipId, { ...request.identity, state: 'error' });
        }
      } finally {
        clearTimeout(watchdog);
        if (seekControllers.get(clipId) === controller) seekControllers.delete(clipId);
        if (activeSeeks.get(clipId) === request) activeSeeks.delete(clipId);
      }
      if (!decoded) continue;
      const newest = seekTokens.get(clipId) === request.identity.token;
      const queued = queuedSeeks.get(clipId);
      // During playback, publish an overtaken decode when the queued request uses the same source.
      const publishIntermediate = !newest && request.allowIntermediate &&
        sameSource(request, queued?.layer);
      if (!newest && !publishIntermediate) continue;

      drawDecodedFrame(request);
      if (!newest) continue;
      readySeeks.set(clipId, request);
      publishRasterStatus(clipId, { ...request.identity, state: 'ready' });
    }
  } finally {
    seekWorkers.delete(clipId);
    if (queuedSeeks.has(clipId)) startVideoSeekWorker(clipId);
  }
}

function startVideoSeekWorker(clipId) {
  if (seekWorkers.has(clipId)) return;
  seekWorkers.set(clipId, drainVideoSeeks(clipId));
}

function invalidateVideoSeek(clipId, identity, state) {
  queuedSeeks.delete(clipId);
  readySeeks.delete(clipId);
  activeSeeks.delete(clipId);
  seekControllers.get(clipId)?.abort();
  publishRasterStatus(clipId, { ...identity, state });
}

function queueVideoLayerFrame(layer, tickValue, fps, options) {
  const tick = projectTick(tickValue);
  const clipId = layer.id;
  const assetId = layer.videoClip?.assetId ?? null;
  const state = videoStateAtTick(layer.videoClip, tick, fps);
  const video = layer.videoElement;
  const raster = layer.raster;
  const identityFor = (token) => ({ clipId, assetId, projectTick: tick, token });
  if (!video || !raster || !state.active) {
    const token = nextSeekToken++;
    seekTokens.set(clipId, token);
    invalidateVideoSeek(clipId, identityFor(token), !video || !raster ? 'missing' : 'inactive');
    return;
  }

  const active = activeSeeks.get(clipId);
  const queued = queuedSeeks.get(clipId);
  const ready = readySeeks.get(clipId);
  const seekIdentity = identityFor(0);
  if (!queued && sameSeek(active, layer, seekIdentity, state.time)) return;
  if (sameSeek(queued, layer, seekIdentity, state.time)) return;
  if (sameSeek(ready, layer, seekIdentity, state.time)) return;

  const token = nextSeekToken++;
  seekTokens.set(clipId, token);
  const identity = identityFor(token);
  readySeeks.delete(clipId);
  const request = { layer, state, identity, allowIntermediate: !!options.allowIntermediate };
  queuedSeeks.set(clipId, request);
  publishRasterStatus(clipId, { ...identity, state: 'pending' });
  if (active && (active.layer.videoElement !== video || active.layer.raster !== raster)) {
    activeSeeks.delete(clipId);
    seekControllers.get(clipId)?.abort();
  }
  startVideoSeekWorker(clipId);
}

export function syncVideoLayerFrames(layerList, projectTick, fps = DEFAULT_VIDEO_FPS, options = {}) {
  const allVideos = layerList.filter((layer) => layer.type === 'video');
  const allVideoIds = new Set(allVideos.map((layer) => layer.id));
  const assetByClipId = new Map(allVideos.map((layer) => [
    layer.id,
    layer.videoClip?.assetId ?? null,
  ]));
  const groups = new Map(layerList
    .filter((layer) => layer.type === 'group')
    .map((group) => [group.id, group]));
  const requestedClipIds = options.requestedClipIds || new Set();
  const videos = layerList.filter((layer) => {
    if (layer.type !== 'video') return false;
    if (requestedClipIds.has(layer.id)) return true;
    if (layer.visible === false || (layer.opacity ?? 1) <= 0) return false;
    const group = layer.groupId == null ? null : groups.get(layer.groupId);
    return !group || group.visible !== false;
  });
  const videoIds = new Set(videos.map((layer) => layer.id));
  for (const layerId of seekTokens.keys()) {
    if (videoIds.has(layerId)) continue;
    seekTokens.delete(layerId);
    queuedSeeks.delete(layerId);
    readySeeks.delete(layerId);
    activeSeeks.delete(layerId);
    seekControllers.get(layerId)?.abort();
    seekControllers.delete(layerId);
  }
  videoRasterStatus.update((statuses) => {
    const retained = [...statuses].filter(([id, status]) =>
      videoIds.has(id) || (allVideoIds.has(id) && status.state === 'error' &&
        status.assetId === assetByClipId.get(id)));
    if (retained.length === statuses.size) return statuses;
    return new Map(retained);
  });
  for (const layer of videos) {
    queueVideoLayerFrame(layer, projectTick, fps, options);
  }
}
