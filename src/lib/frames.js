import { derived, get, writable } from 'svelte/store';
import {
  activeLayerId,
  activeLayerPart,
  authoredRevision,
  beginStroke,
  cancelStroke,
  cellSelection,
  checkpointHistory,
  compositeWorld,
  dims,
  endStroke,
  layers,
  noteAuthoredMutation,
  registerAuthoredMutationSettledHandler,
  registerEffectMaskChangeHandler,
  registerHistoryContributor,
  registerLayerHistoryAuthority,
  registerLayerStackEmptyHandler,
  registerShapeRasterizeHandler,
  resizeCanvas,
  selectedLayerIds,
} from './grid.js';
import { cmClone, cmKey, cmParse, cmTranslate } from './cellmap.js';
import { playing } from './playbackState.js';
import {
  LINEAR_TEMPORAL_HANDLE,
  SLOW_TEMPORAL_HANDLE,
  normalizeTemporalEase,
  normalizeTemporalHandle,
  temporalHandleEqual,
  validInterpolation,
  withTemporalEaseSide,
} from './temporalEasing.js';
import {
  enumerateShapePathComponents,
  normalizeShapePathComponentId,
  normalizeShapePathComponentValue,
  normalizeShapePathKey,
  pathValueFromShape,
  shapePathComponentEqual,
  shapePathComponentValue,
  shapePathEqual,
  shapePathVertices,
  shapeWithPathValue,
  translateShapePathKey,
  withShapePathComponentValue,
  SHAPE_PATH_COMPONENT_ANCHOR,
  SHAPE_PATH_COMPONENT_ROTATION,
} from './shapePath.js';
import { renderShapeToCells } from './shapes.js';
import { shapeForAnchorComponentEdit } from './shapePathEditing.js';
import { normalizeTextRuns } from './textLayer.js';
import {
  addEmpty as addCanonicalEmpty,
  addCustomTimelineTag as addCanonicalCustomTag,
  canonicalClipTimeline,
  captureClipTimelineState,
  clearClipTimelineSelection as clearCanonicalClipSelection,
  deleteSelection as deleteCanonicalSelection,
  duplicateClips as duplicateCanonicalClips,
  durationTicks as canonicalDurationTicks,
  getClipTimelineSelection,
  getClipTimelineState,
  initializeClipTimelineState,
  moveClip as moveCanonicalClip,
  moveClips as moveCanonicalClips,
  moveTimelineKeys as moveCanonicalTimelineKeys,
  playheadTick as canonicalPlayheadTick,
  razor as razorCanonicalClips,
  razorPath as razorCanonicalPath,
  removeTimelineTag as removeCanonicalTag,
  restoreClipTimelineState,
  ripple as rippleCanonicalClips,
  seekClipTimelineTick,
  setLoopEndTag as setCanonicalLoopEnd,
  setLoopStartTag as setCanonicalLoopStart,
  setTimelineTag as setCanonicalTimelineTag,
  setClipTimelineFps,
  setClipTimelineSelection as setCanonicalClipSelection,
  transactClipTimeline,
  trimClip as trimCanonicalClip,
  trimClips as trimCanonicalClips,
  updateCustomTimelineTag as updateCanonicalCustomTag,
} from './clipTimelineState.js';
import {
  clipTimelineDurationTicks,
  resolveClipPropertyAtTick,
  resolveClipTimelineLayers,
} from './clipTimelineResolver.js';
import {
  clipContainsTick,
  clipSourceTickAt,
  cloneTimelineValue,
  validateClipTimelineState,
} from './clipTimeline.js';
import { captureProjectRevision } from './documentLifecycle.js';
import { currentMediaRegistry, mediaAssetById } from './mediaRegistry.js';
import { newUuid } from './uuid.js';
import { nextPlaybackTick, playbackStartTick } from './timelineTags.js';

export { playing };
export const DEFAULT_FPS = 24;
export const fps = writable(DEFAULT_FPS);
export const looping = writable(true);
export const onionSkin = writable('off');
export const activeFrameIndex = canonicalPlayheadTick;
export const playheadTick = canonicalPlayheadTick;
export const durationTicks = canonicalDurationTicks;
export const activeFrameTick = derived(canonicalPlayheadTick, () => 0);
export const timelineStructureRevision = writable(0);

let playbackCycleId = 0;
const playbackCyclePublisher = writable(Object.freeze({ id: playbackCycleId, tick: 0 }));
export const playbackCycle = { subscribe: playbackCyclePublisher.subscribe };

const RUNTIME_FIELDS = new Set([
  'raster', 'videoElement', 'videoBlob', 'videoURL', 'runtimeMediaKey',
  'blob', 'buffer', 'audioBuffer', 'decoder', 'objectURL',
]);
const SHAPE_PATH_KINDS = new Set(['line', 'rect', 'circle', 'polygon']);
const SHAPE_ANCHOR_COMPENSATION = 'shapeAnchorCompensation';

let publishingResolvedView = false;
let synchronizedAuthoredRevision = -1;
let timelineStructureToken = 0;
let playbackTimer = null;
let observedFps = get(fps);

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function tickIndex(value, state = getClipTimelineState()) {
  const tick = Number(value);
  const duration = clipTimelineDurationTicks(state);
  return Number.isInteger(tick) && tick >= 0 && tick < duration ? tick : null;
}

function boundedTick(value, state = getClipTimelineState()) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(clipTimelineDurationTicks(state) - 1, Math.round(number)));
}

function cloneDurable(value, seen = new WeakMap()) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    value.forEach((entry) => copy.push(cloneDurable(entry, seen)));
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy = {};
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    if (!RUNTIME_FIELDS.has(key)) copy[key] = cloneDurable(entry, seen);
  }
  return copy;
}

function sameValue(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function roundedPosition(value) {
  return {
    x: Math.round(Number(value?.x) || 0) || 0,
    y: Math.round(Number(value?.y) || 0) || 0,
  };
}

function textPayload(layer) {
  const text = typeof layer?.text === 'string' ? layer.text : '';
  const fg = layer?.fg || '#ffffff';
  return {
    text,
    box: layer?.box ? { ...layer.box } : null,
    wrap: layer?.wrap !== false,
    fg,
    runs: normalizeTextRuns(layer?.runs, text, fg),
  };
}

function shapePayload(layer) {
  if (!layer?.shape) return null;
  return cloneDurable(layer.shape);
}

function maskValue(mask, includeCells = true) {
  if (!mask) return null;
  return {
    ...cloneDurable(mask),
    ...(includeCells ? { cells: cmClone(mask.cells || {}) } : { cells: {} }),
    offset: roundedPosition(mask.offset),
  };
}

function framePayload(layer) {
  const payload = { cells: cmClone(layer?.cells || {}) };
  if (layer?.type === 'text') Object.assign(payload, textPayload(layer));
  if (layer?.type === 'shape') payload.shape = shapePayload(layer);
  if (layer?.type === 'effect') payload.mask = maskValue(layer.mask);
  return payload;
}

function layerBase(layer) {
  const base = cloneDurable(layer || {});
  base.cells = {};
  base.offset = roundedPosition(layer?.offset);
  base.visible = layer?.visible !== false;
  if (base.type === 'text') {
    base.text = '';
    base.box = null;
    base.wrap = true;
    base.fg = '#ffffff';
    base.runs = [];
  }
  if (base.type === 'shape') base.shape = null;
  if (base.type === 'effect' && base.mask) base.mask = maskValue(base.mask, false);
  if (base.type === 'video') {
    const source = layer?.videoClip || {};
    base.assetId = source.assetId ?? base.assetId;
    delete base.videoClip;
  }
  for (const field of RUNTIME_FIELDS) delete base[field];
  return base;
}

function visualTracks(state = getClipTimelineState()) {
  return (state.tracks || []).filter((track) => track.kind !== 'audio');
}

function trackLayerId(track) {
  return track?.layer?.id ?? null;
}

function trackForLayer(state, layerId) {
  return (state?.tracks || []).find((track) =>
    track.kind !== 'audio' && String(trackLayerId(track)) === String(layerId)) || null;
}

function clipsForTrack(state, trackId) {
  return (state?.clips || []).filter((clip) => clip.trackId === trackId && clip.kind !== 'audio');
}

function clipAtTick(state, trackId, tick) {
  return (state?.clips || []).find((clip) =>
    clip.trackId === trackId && clip.kind !== 'audio' && clipContainsTick(clip, tick)) || null;
}

function sourceTickAt(clip, tick) {
  return clipSourceTickAt(clip, tick);
}

function projectTickAt(clip, sourceTick) {
  return clip.startTick + sourceTick - clip.inTick;
}

function generatedId(state, makeId, kind) {
  const used = new Set([
    ...state.tracks.map((track) => track.id),
    ...state.clips.map((clip) => clip.id),
  ]);
  let id;
  do id = String(makeId?.(kind) || newUuid(kind)); while (!id || used.has(id));
  return id;
}

function trackKind(layer) {
  if (layer?.type === 'group') return 'group';
  if (layer?.type === 'video') return 'video';
  return 'visual';
}

function clipKind(layer) {
  return layer?.type === 'video' ? 'video' : 'visual';
}

function clipDuration(clip) {
  return Math.max(1, integer(clip?.outTick, 1) - integer(clip?.inTick));
}

function sourceDurationTicks(seconds, playbackRate, rate) {
  return Math.max(1, Math.ceil((seconds / playbackRate) * rate - Number.EPSILON * 32));
}

function videoClipDefinition(layer, trackId, id, rate = get(fps)) {
  const source = layer?.videoClip || {};
  const playbackRate = Math.max(0.01, Number(source.playbackRate) || 1);
  const inPoint = Math.max(0, Number(source.inPoint) || 0);
  const outPoint = Math.max(inPoint, Number(source.outPoint) || Number(source.duration) || inPoint);
  const sourceDuration = sourceDurationTicks(outPoint - inPoint, playbackRate, rate);
  return {
    id,
    trackId,
    kind: 'video',
    startTick: Math.max(0, integer(source.startTick)),
    inTick: 0,
    outTick: sourceDuration,
    sourceDuration,
    assetId: source.assetId,
    sourceName: source.sourceName,
    inPoint,
    outPoint,
    playbackRate,
    duration: Math.max(0, Number(source.duration) || outPoint),
    width: Math.max(0, Number(source.width) || 0),
    height: Math.max(0, Number(source.height) || 0),
    frameKeys: [{ tick: 0, value: framePayload(layer) }],
    propertyTracks: {},
  };
}

function normalizeVideoSourceBounds(
  operation = 'normalize-video-source-bounds',
  retime = false,
  previousRate = null,
) {
  return transactClipTimeline(operation, (state) => {
    const rate = Math.max(1, Number(state.fps) || get(fps) || DEFAULT_FPS);
    let changed = false;
    for (const clip of state.clips) {
      if (clip.kind !== 'video') continue;
      const track = state.tracks.find((candidate) => candidate.id === clip.trackId);
      const resolved = resolveClipTimelineLayers(state, clip.startTick)
        .find((layer) => layer.id === track?.layer?.id);
      const playbackRate = Math.max(0.01, Number(clip.playbackRate) || 1);
      const baseInPoint = Math.max(0, Number(clip.inPoint) || 0);
      const baseOutPoint = Math.max(baseInPoint, Number(clip.outPoint) || baseInPoint);
      const sourceIn = clip.inTick;
      const sourceOut = clip.outTick;
      const inPoint = retime
        ? baseInPoint
        : baseInPoint + (sourceIn * playbackRate) / rate;
      const outPoint = retime
        ? baseOutPoint
        : Math.min(baseOutPoint, baseInPoint + (sourceOut * playbackRate) / rate);
      const duration = retime
        ? sourceDurationTicks(outPoint - inPoint, playbackRate, rate)
        : Math.max(1, sourceOut - sourceIn);
      if (sourceIn === 0 && sourceOut === duration &&
        clip.sourceDuration === duration && clip.inPoint === inPoint && clip.outPoint === outPoint) {
        continue;
      }
      const propertyBoundaries = Object.fromEntries(Object.keys(clip.propertyTracks || {}).map(
        (name) => {
          let fallback = null;
          if (name === 'position') fallback = resolved?.offset;
          else if (name === 'visibility') fallback = resolved?.visible;
          else if (name === 'effectIntensity') fallback = resolved?.effect?.intensity;
          else if (name === 'maskOpacity') fallback = resolved?.mask?.opacity;
          else if (name === 'maskPosition') fallback = resolved?.mask?.offset;
          else if (name === 'shapePath') fallback = pathValueFromShape(resolved?.shape);
          return [name, resolveClipPropertyAtTick(clip, name, clip.startTick, fallback)];
        },
      ));
      const remapKeys = (keys) => {
        const remapped = new Map();
        for (const key of keys) {
          if (key.tick < sourceIn || key.tick >= sourceOut) continue;
          const tick = retime
            ? Math.max(0, Math.min(
              duration - 1,
              Math.round((key.tick - sourceIn) * rate / Math.max(1, previousRate || rate)),
            ))
            : key.tick - sourceIn;
          remapped.set(tick, { ...key, tick });
        }
        return [...remapped.values()].sort((first, second) => first.tick - second.tick);
      };
      clip.inPoint = inPoint;
      clip.outPoint = outPoint;
      clip.inTick = 0;
      clip.outTick = duration;
      clip.sourceDuration = duration;
      let heldFrame = null;
      for (const key of clip.frameKeys) {
        if (key.tick > sourceIn) break;
        heldFrame = key;
      }
      clip.frameKeys = remapKeys(clip.frameKeys);
      if (heldFrame && !clip.frameKeys.some((key) => key.tick === 0)) {
        clip.frameKeys.unshift({ tick: 0, value: cloneDurable(heldFrame.value) });
      }
      clip.propertyTracks = Object.fromEntries(Object.entries(clip.propertyTracks || {}).map(
        ([name, keys]) => {
          const shifted = remapKeys(keys);
          if (!shifted.some((key) => key.tick === 0)) {
            const value = propertyBoundaries[name];
            shifted.unshift({
              tick: 0,
              value: name === 'shapePath' ? { path: value } : cloneDurable(value),
            });
          }
          return [name, shifted];
        },
      ));
      changed = true;
    }
    return changed ? { state, changed: true } : false;
  });
}

function visualClipDefinition(layer, trackId, id, startTick = 0) {
  if (layer?.type === 'video') return videoClipDefinition(layer, trackId, id);
  return {
    id,
    trackId,
    kind: 'visual',
    startTick: Math.max(0, integer(startTick)),
    inTick: 0,
    outTick: 1,
    sourceDuration: 1,
    frameKeys: [{ tick: 0, value: framePayload(layer) }],
    propertyTracks: {},
  };
}

function initialVisualTimeline(initialLayers, retainedAudio = { tracks: [], clips: [] }) {
  const trackIds = new Map();
  const tracks = initialLayers.map((layer) => {
    const id = newUuid('track');
    trackIds.set(layer.id, id);
    return {
      id,
      kind: trackKind(layer),
      name: layer.name,
      locked: false,
      layer: layerBase(layer),
      ...(layer.type === 'shape' ? { shapePathKind: null, shapePathComponents: [] } : {}),
      ...(layer.type === 'group' ? { propertyTracks: {} } : {}),
    };
  });
  tracks.forEach((track) => {
    const groupId = track.layer?.groupId;
    if (groupId != null && trackIds.has(groupId)) track.parentTrackId = trackIds.get(groupId);
  });
  const clips = tracks.flatMap((track, index) => track.kind === 'group' ? [] : [
    visualClipDefinition(initialLayers[index], track.id, newUuid('clip'), 0),
  ]);
  return {
    fps: get(fps),
    tickDuration: 1000 / get(fps),
    tracks: [...tracks, ...retainedAudio.tracks],
    clips: [...clips, ...retainedAudio.clips],
    tags: [],
  };
}

function propertyOwners(state, track, name) {
  if (!track) return [];
  if (track.kind === 'group' || track.layer?.type === 'group') return [track];
  return clipsForTrack(state, track.id).filter((clip) => clip.propertyTracks?.[name]);
}

function propertyEnabled(state, track, name) {
  return propertyOwners(state, track, name).some((owner) =>
    (owner.propertyTracks?.[name] || []).length > 0);
}

function upsertKey(keys, tick, value) {
  const next = [...(keys || [])];
  const index = next.findIndex((key) => key.tick === tick);
  const previous = index >= 0 ? next[index] : null;
  const key = {
    ...(previous || {}),
    tick,
    value: cloneDurable(value),
  };
  if (previous && sameValue(previous, key)) return { keys: next, changed: false };
  if (index >= 0) next[index] = key;
  else next.push(key);
  next.sort((first, second) => first.tick - second.tick);
  return { keys: next, changed: true };
}

function resolvedLayer(state, layerId, tick) {
  return resolveClipTimelineLayers(state, tick)
    .find((layer) => String(layer.id) === String(layerId)) || null;
}

function retainedRuntime(layer, live) {
  if (!live || live.type !== layer.type) return layer;
  const runtime = {};
  for (const field of ['raster', 'videoElement', 'videoBlob', 'videoURL', 'runtimeMediaKey']) {
    if (live[field] != null) runtime[field] = live[field];
  }
  return Object.keys(runtime).length ? { ...layer, ...runtime } : layer;
}

function resolveView(state, tick, liveById = null) {
  const live = liveById || new Map(get(layers).map((layer) => [layer.id, layer]));
  return resolveClipTimelineLayers(state, tick)
    .map((layer) => retainedRuntime(layer, live.get(layer.id)));
}

function publishResolvedTick(tick = get(canonicalPlayheadTick), liveById = null) {
  const state = getClipTimelineState();
  const target = boundedTick(tick, state) ?? 0;
  const view = resolveView(state, target, liveById);
  publishingResolvedView = true;
  try {
    layers.set(view);
  } finally {
    publishingResolvedView = false;
  }
  if (!view.some((layer) => layer.id === get(activeLayerId))) {
    activeLayerId.set(view[0]?.id ?? null);
  }
  return view;
}

function structureSignature(state) {
  return JSON.stringify({
    tracks: state.tracks.map((track) => [track.id, track.parentTrackId || null, trackLayerId(track)]),
    clips: state.clips.map((clip) => [clip.id, clip.trackId, clip.startTick, clip.inTick, clip.outTick]),
  });
}

function preserveAnimatedBase(state, track, live, base) {
  const previous = track.layer || {};
  if (propertyEnabled(state, track, 'position')) base.offset = roundedPosition(previous.offset);
  if (propertyEnabled(state, track, 'visibility')) base.visible = previous.visible !== false;
  if (base.effect && previous.effect && propertyEnabled(state, track, 'effectIntensity')) {
    base.effect.intensity = previous.effect.intensity;
  }
  if (base.mask && previous.mask) {
    if (propertyEnabled(state, track, 'maskPosition')) {
      base.mask.offset = roundedPosition(previous.mask.offset);
    }
    if (propertyEnabled(state, track, 'maskOpacity')) {
      if ('opacity' in previous.mask) base.mask.opacity = previous.mask.opacity;
      else delete base.mask.opacity;
    }
  }
  return base;
}

function positionRecordsForTrack(state, track) {
  if (!track) return [];
  if (track.kind === 'group' || track.layer?.type === 'group') {
    return (track.propertyTracks?.position || []).map((key) => ({
      projectTick: key.tick,
      value: key.value,
    }));
  }
  return clipsForTrack(state, track.id).flatMap((clip) =>
    (clip.propertyTracks?.position || []).map((key) => ({
      projectTick: projectTickAt(clip, key.tick),
      value: key.value,
    })).filter((record) => clipContainsTick(clip, record.projectTick)));
}

function groupOffsetAt(state, trackId, tick) {
  if (!trackId) return { x: 0, y: 0 };
  const track = state.tracks.find((candidate) => candidate.id === trackId);
  if (!track) return { x: 0, y: 0 };
  const fallback = roundedPosition(track.layer?.offset);
  const duration = Math.max(1, clipTimelineDurationTicks(state), tick + 1);
  return roundedPosition(resolveClipPropertyAtTick({
    startTick: 0,
    inTick: 0,
    outTick: duration,
    sourceDuration: duration,
    propertyTracks: { position: track.propertyTracks?.position || [] },
  }, 'position', tick, fallback));
}

function resolvedPositionFromKeys(keys, offset) {
  const duration = Math.max(1, keys.at(-1)?.tick + 1 || 1, offset + 1);
  return roundedPosition(resolveClipPropertyAtTick({
    startTick: 0,
    inTick: 0,
    outTick: duration,
    sourceDuration: duration,
    propertyTracks: { position: keys },
  }, 'position', offset, { x: 0, y: 0 }));
}

function positionKeysMatchSamples(keys, samples) {
  return samples.every((sample, offset) => {
    const resolved = resolvedPositionFromKeys(keys, offset);
    return resolved.x === sample.x && resolved.y === sample.y;
  });
}

function sparsePositionKeys(samples) {
  if (!samples.length) return [];
  if (samples.length === 1) return [{ tick: 0, value: { ...samples[0] } }];
  const retained = new Set([0, samples.length - 1]);
  const segments = [[0, samples.length - 1]];
  while (segments.length) {
    const [start, end] = segments.pop();
    if (end <= start + 1) continue;
    const segment = [
      { tick: start, value: { ...samples[start] } },
      { tick: end, value: { ...samples[end] } },
    ];
    let split = -1;
    let largestError = 0;
    for (let offset = start + 1; offset < end; offset++) {
      const resolved = resolvedPositionFromKeys(segment, offset);
      const expected = samples[offset];
      const error = Math.abs(resolved.x - expected.x) + Math.abs(resolved.y - expected.y);
      if (error > largestError) {
        largestError = error;
        split = offset;
      }
    }
    if (split < 0) continue;
    retained.add(split);
    segments.push([start, split], [split, end]);
  }
  return [...retained].sort((first, second) => first - second)
    .map((tick) => ({ tick, value: { ...samples[tick] } }));
}

function positionKeysForSamples(samples, clip, sourceRecords) {
  const last = Math.max(0, samples.length - 1);
  const offsets = new Set([0, last]);
  for (const record of sourceRecords) {
    const offset = record.projectTick - clip.startTick;
    if (offset >= 0 && offset <= last) offsets.add(offset);
  }
  const candidate = [...offsets].sort((first, second) => first - second).map((offset) => {
    const projectTick = clip.startTick + offset;
    const source = sourceRecords.find((record) => record.projectTick === projectTick)?.value || {};
    return { tick: offset, value: { ...source, ...samples[offset] } };
  });
  const local = positionKeysMatchSamples(candidate, samples)
    ? candidate
    : sparsePositionKeys(samples);
  return local.map((key) => ({ ...key, tick: clip.inTick + key.tick }));
}

function preserveReparentedPosition(state, before, track, previousParentId, nextParentId) {
  const previousTrack = trackForLayer(before, track.layer?.id);
  if (!previousTrack || previousParentId === nextParentId) return false;
  const duration = Math.max(1, clipTimelineDurationTicks(before), clipTimelineDurationTicks(state));
  const deltas = Array.from({ length: duration }, (_, tick) => {
    const previous = groupOffsetAt(before, previousParentId, tick);
    const next = groupOffsetAt(state, nextParentId, tick);
    return { x: previous.x - next.x, y: previous.y - next.y };
  });
  const constant = deltas.every((delta) =>
    delta.x === deltas[0].x && delta.y === deltas[0].y);
  if (constant) {
    const delta = deltas[0] || { x: 0, y: 0 };
    track.layer.offset = {
      x: roundedPosition(previousTrack.layer?.offset).x + delta.x,
      y: roundedPosition(previousTrack.layer?.offset).y + delta.y,
    };
    if (track.propertyTracks?.position) {
      track.propertyTracks.position = track.propertyTracks.position.map((key) => ({
        ...key,
        value: {
          ...key.value,
          x: (Number(key.value?.x) || 0) + delta.x,
          y: (Number(key.value?.y) || 0) + delta.y,
        },
      }));
    }
    for (const clip of clipsForTrack(state, track.id)) {
      if (!clip.propertyTracks?.position) continue;
      clip.propertyTracks.position = clip.propertyTracks.position.map((key) => ({
        ...key,
        value: {
          ...key.value,
          x: (Number(key.value?.x) || 0) + delta.x,
          y: (Number(key.value?.y) || 0) + delta.y,
        },
      }));
    }
    return true;
  }

  const sourceRecords = [
    ...positionRecordsForTrack(before, previousTrack),
    ...positionRecordsForTrack(before, before.tracks.find((candidate) =>
      candidate.id === previousParentId)),
    ...positionRecordsForTrack(state, state.tracks.find((candidate) =>
      candidate.id === nextParentId)),
  ];
  for (const clip of clipsForTrack(state, track.id)) {
    const samples = Array.from({ length: clipDuration(clip) }, (_, offset) => {
      const tick = clip.startTick + offset;
      const local = resolvedLayer(before, track.layer.id, tick)?.offset || previousTrack.layer?.offset;
      const delta = deltas[tick] || deltas.at(-1) || { x: 0, y: 0 };
      return {
        x: roundedPosition(local).x + delta.x,
        y: roundedPosition(local).y + delta.y,
      };
    });
    clip.propertyTracks = {
      ...(clip.propertyTracks || {}),
      position: positionKeysForSamples(samples, clip, sourceRecords),
    };
  }
  return true;
}

function ensureClipForTick(state, track, layer, tick, makeId) {
  let clip = clipAtTick(state, track.id, tick);
  if (clip || track.kind === 'group' || layer?.type === 'group') return clip;
  if (track.kind === 'video' || layer?.type === 'video') return null;
  clip = visualClipDefinition(layer, track.id, generatedId(state, makeId, 'clip'), tick);
  state.clips.push(clip);
  return clip;
}

function upsertProperty(owner, name, tick, value) {
  owner.propertyTracks = { ...(owner.propertyTracks || {}) };
  const result = upsertKey(owner.propertyTracks[name], tick, value);
  if (result.changed) owner.propertyTracks[name] = result.keys;
  return result.changed;
}

function livePropertyValue(layer, name) {
  if (name === 'position') return roundedPosition(layer?.offset);
  if (name === 'visibility') return layer?.visible !== false;
  if (name === 'effectIntensity') return Math.max(-1, Math.min(1, Number(layer?.effect?.intensity) || 0));
  if (name === 'maskOpacity') return Math.max(0, Math.min(1, Number(layer?.mask?.opacity ?? 1)));
  if (name === 'maskPosition') return roundedPosition(layer?.mask?.offset);
  if (name === 'shapePath') return pathValueFromShape(layer?.shape);
  return null;
}

// `layers` is the editable projection; settling diffs its live values back into the
// canonical timeline without replacing animated bases with resolved values.
function reconcileLiveLayers(activeTick = get(canonicalPlayheadTick), options = {}) {
  if (publishingResolvedView) return false;
  const liveLayers = get(layers).map((layer) => cloneDurable(layer));
  const tick = Math.max(0, integer(activeTick));
  let structureChanged = false;
  const before = getClipTimelineState();
  const result = transactClipTimeline('settle-canvas', (state, context) => {
    const liveIds = new Set(liveLayers.map((layer) => String(layer.id)));
    const retainedTracks = state.tracks.filter((track) =>
      track.kind === 'audio' || liveIds.has(String(trackLayerId(track))));
    const retainedIds = new Set(retainedTracks.map((track) => track.id));
    if (retainedTracks.length !== state.tracks.length) {
      state.tracks = retainedTracks;
      state.clips = state.clips.filter((clip) => retainedIds.has(clip.trackId));
      structureChanged = true;
    }

    const tracksByLayer = new Map(visualTracks(state).map((track) => [String(trackLayerId(track)), track]));
    for (const layer of liveLayers) {
      if (tracksByLayer.has(String(layer.id))) continue;
      const track = {
        id: generatedId(state, context.makeId, 'track'),
        kind: trackKind(layer),
        name: layer.name,
        locked: false,
        layer: layerBase(layer),
        ...(layer.type === 'shape' ? { shapePathKind: null, shapePathComponents: [] } : {}),
        ...(layer.type === 'group' ? { propertyTracks: {} } : {}),
      };
      state.tracks.push(track);
      tracksByLayer.set(String(layer.id), track);
      if (layer.type !== 'group') {
        state.clips.push(visualClipDefinition(
          layer,
          track.id,
          generatedId(state, context.makeId, 'clip'),
          tick,
        ));
      }
      structureChanged = true;
    }

    const trackIdByLayer = new Map([...tracksByLayer].map(([layerId, track]) => [layerId, track.id]));
    const resolvedById = new Map(resolveClipTimelineLayers(before, Math.min(
      clipTimelineDurationTicks(before) - 1,
      tick,
    )).map((layer) => [String(layer.id), layer]));

    const orderedVisual = [];
    const orderedTrackIds = new Set();
    for (const [stackIndex, layer] of liveLayers.entries()) {
      const track = tracksByLayer.get(String(layer.id));
      if (!track || orderedTrackIds.has(track.id)) continue;
      orderedTrackIds.add(track.id);
      const previousParent = track.parentTrackId || null;
      const parentTrackId = layer.groupId == null
        ? null
        : trackIdByLayer.get(String(layer.groupId)) || null;
      const base = preserveAnimatedBase(state, track, layer, layerBase(layer));
      track.kind = trackKind(layer);
      track.name = layer.name;
      track.stackIndex = stackIndex;
      track.layer = base;
      if (parentTrackId) track.parentTrackId = parentTrackId;
      else delete track.parentTrackId;
      const reparented = preserveReparentedPosition(
        state,
        before,
        track,
        previousParent,
        parentTrackId,
      );
      if (previousParent !== parentTrackId) structureChanged = true;
      orderedVisual.push(track);

      const resolved = resolvedById.get(String(layer.id));
      const propertyNames = ['position', 'visibility', 'effectIntensity', 'maskOpacity', 'maskPosition'];
      for (const name of propertyNames) {
        if (name === 'position' && reparented) continue;
        if (!propertyEnabled(state, track, name)) continue;
        const value = livePropertyValue(layer, name);
        const previous = livePropertyValue(resolved, name);
        if (sameValue(value, previous)) continue;
        if (track.kind === 'group') {
          upsertProperty(track, name, tick, value);
        } else {
          const clip = ensureClipForTick(state, track, layer, tick, context.makeId);
          if (clip) upsertProperty(clip, name, sourceTickAt(clip, tick), value);
        }
      }

      if (layer.type === 'group') continue;
      let clip = clipAtTick(state, track.id, tick);
      if (layer.type === 'video') {
        clip ||= clipsForTrack(state, track.id).find((candidate) => candidate.kind === 'video') || null;
        const exact = videoClipDefinition(
          layer,
          track.id,
          clip?.id || generatedId(state, context.makeId, 'clip'),
        );
        if (clip) {
          exact.frameKeys = clip.frameKeys;
          exact.propertyTracks = clip.propertyTracks;
          Object.assign(clip, exact);
        }
        else state.clips.push(exact);
        clip = exact;
        structureChanged = true;
      }
      const payload = framePayload(layer);
      const previousPayload = framePayload(resolved || {});
      if (!clip && !sameValue(payload, previousPayload)) {
        clip = ensureClipForTick(state, track, layer, tick, context.makeId);
        structureChanged = true;
      }
      if (clip && !sameValue(payload, previousPayload)) {
        const sourceTick = sourceTickAt(clip, tick);
        const updated = upsertKey(clip.frameKeys, sourceTick, payload);
        if (updated.changed) clip.frameKeys = updated.keys;
      }
    }
    state.tracks = [
      ...orderedVisual,
      ...state.tracks.filter((track) => track.kind === 'audio'),
    ];
    state.fps = get(fps);
    state.tickDuration = 1000 / get(fps);
    return sameValue(state, before) ? false : { state, changed: true };
  });
  if (!result.changed) return false;
  if (structureChanged) {
    timelineStructureToken++;
    timelineStructureRevision.update((value) => value + 1);
  }
  if (options.publish !== false) publishResolvedTick(result.playheadTick);
  return true;
}

export function commitLayersToActiveFrame(options = {}) {
  return reconcileLiveLayers(get(canonicalPlayheadTick), options);
}

const CLIP_CLIPBOARD_FORMAT = 'paintty-clips';
const CLIP_CLIPBOARD_VERSION = 1;

function selectedClipTracks(state, requestedLayerIds) {
  const requested = new Set([...requestedLayerIds].map(String));
  const visual = visualTracks(state);
  const selectedGroups = new Set(visual
    .filter((track) => track.kind === 'group' && requested.has(String(trackLayerId(track))))
    .map((track) => String(track.id)));
  return visual.filter((track) => {
    if (track.kind === 'group') return false;
    if (requested.has(String(trackLayerId(track)))) return true;
    let parentId = track.parentTrackId == null ? null : String(track.parentTrackId);
    const seen = new Set();
    while (parentId && !seen.has(parentId)) {
      if (selectedGroups.has(parentId)) return true;
      seen.add(parentId);
      const parent = visual.find((candidate) => String(candidate.id) === parentId);
      parentId = parent?.parentTrackId == null ? null : String(parent.parentTrackId);
    }
    return false;
  });
}

function capturedClipPayload(state, selectedClips) {
  if (!selectedClips.length) return null;
  const trackIds = new Set(selectedClips.map((clip) => String(clip.trackId)));
  const tracks = state.tracks.filter((track) => trackIds.has(String(track.id)));
  if (tracks.length !== trackIds.size) return null;
  const media = clipboardMediaIdentities(tracks, selectedClips);
  if (!media) return null;
  const sourceStartTick = Math.min(...selectedClips.map((clip) => Number(clip.startTick)));
  return {
    format: CLIP_CLIPBOARD_FORMAT,
    version: CLIP_CLIPBOARD_VERSION,
    projectRevision: captureProjectRevision(),
    fps: state.fps,
    sourceStartTick,
    tracks: tracks.map((track) => cloneDurable(track)),
    clips: selectedClips.map((clip) => cloneDurable(clip)),
    media,
  };
}

function clipboardMediaReferences(tracks, clips) {
  const references = new Map();
  const add = (assetId, kind) => {
    const id = String(assetId || '');
    if (!id) return false;
    const previous = references.get(id);
    if (previous && previous !== kind) return false;
    references.set(id, kind);
    return true;
  };
  for (const track of tracks) {
    const type = track.layer?.type;
    if ((type === 'image' || type === 'video') && !add(track.layer?.assetId, type)) return null;
  }
  for (const clip of clips) {
    if ((clip.kind === 'audio' || clip.kind === 'video') && !add(clip.assetId, clip.kind)) {
      return null;
    }
  }
  return references;
}

function clipboardMediaIdentities(tracks, clips, registry = currentMediaRegistry()) {
  const references = clipboardMediaReferences(tracks, clips);
  if (!references) return null;
  const identities = [];
  for (const [assetId, kind] of references) {
    const asset = mediaAssetById(assetId, registry);
    if (!asset || asset.kind !== kind) return null;
    identities.push({
      assetId: asset.assetId,
      hash: asset.hash,
      generation: asset.generation,
      kind: asset.kind,
    });
  }
  return identities;
}

export function captureLayerClipClipboard(
  layerIds = get(selectedLayerIds),
  playhead = get(canonicalPlayheadTick),
) {
  if (get(playing)) return null;
  commitLayersToActiveFrame();
  const state = getClipTimelineState();
  const clips = selectedClipTracks(state, layerIds || [])
    .map((track) => clipAtTick(state, track.id, playhead))
    .filter(Boolean);
  return capturedClipPayload(state, clips);
}

export function captureTimelineClipClipboard(
  clipIds = getClipTimelineSelection().clipIds,
) {
  if (get(playing)) return null;
  commitLayersToActiveFrame();
  const state = getClipTimelineState();
  const selected = new Set([...(clipIds || [])].map(String));
  return capturedClipPayload(
    state,
    state.clips.filter((clip) => selected.has(String(clip.id))),
  );
}

function clipClipboardFailure(reason, details = {}) {
  return {
    changed: false,
    reason,
    clipIds: [],
    trackIds: [],
    layerIds: [],
    ...details,
  };
}

function validateClipClipboard(payload) {
  if (payload?.format !== CLIP_CLIPBOARD_FORMAT ||
    payload.version !== CLIP_CLIPBOARD_VERSION) return clipClipboardFailure('invalid-clipboard');
  if (payload.projectRevision !== captureProjectRevision()) {
    return clipClipboardFailure('stale-project');
  }
  if (!Array.isArray(payload.tracks) || !payload.tracks.length ||
    !Array.isArray(payload.clips) || !payload.clips.length) {
    return clipClipboardFailure('empty-clipboard');
  }
  if (Number(payload.fps) !== Number(getClipTimelineState().fps)) {
    return clipClipboardFailure('stale-fps');
  }
  const tracks = payload.tracks.map((track) => cloneDurable(track));
  const clips = payload.clips.map((clip) => cloneDurable(clip));
  const trackIds = new Set(tracks.map((track) => String(track?.id || '')));
  const clipIds = new Set(clips.map((clip) => String(clip?.id || '')));
  if (trackIds.has('') || trackIds.size !== tracks.length ||
    clipIds.has('') || clipIds.size !== clips.length) {
    return clipClipboardFailure('invalid-clipboard');
  }
  const referencedTrackIds = new Set(clips.map((clip) => String(clip.trackId || '')));
  if (referencedTrackIds.has('') || referencedTrackIds.size !== tracks.length ||
    [...trackIds].some((id) => !referencedTrackIds.has(id))) {
    return clipClipboardFailure('invalid-clipboard');
  }
  if (tracks.some((track) => track.kind === 'group' ||
    (track.kind !== 'audio' && trackLayerId(track) == null))) {
    return clipClipboardFailure('invalid-clipboard');
  }
  const sourceStartTick = Math.min(...clips.map((clip) => Number(clip.startTick)));
  if (!Number.isSafeInteger(sourceStartTick) || payload.sourceStartTick !== sourceStartTick) {
    return clipClipboardFailure('invalid-clipboard');
  }
  const errors = validateClipTimelineState({
    fps: payload.fps,
    tracks,
    clips,
    tags: [],
  });
  if (errors.length) return clipClipboardFailure('invalid-clipboard', { errors });
  const references = clipboardMediaReferences(tracks, clips);
  if (!references || !Array.isArray(payload.media) || payload.media.length !== references.size) {
    return clipClipboardFailure('invalid-clipboard');
  }
  const identities = new Map();
  for (const identity of payload.media) {
    const assetId = String(identity?.assetId || '');
    const hash = String(identity?.hash || '');
    const kind = String(identity?.kind || '');
    const generation = Number(identity?.generation);
    if (!assetId || identities.has(assetId) || references.get(assetId) !== kind ||
      !/^[a-f0-9]{64}$/i.test(hash) || !Number.isSafeInteger(generation) || generation < 1) {
      return clipClipboardFailure('invalid-clipboard');
    }
    identities.set(assetId, { assetId, hash, generation, kind });
  }
  const registry = currentMediaRegistry();
  for (const [assetId, kind] of references) {
    const expected = identities.get(assetId);
    if (!expected) return clipClipboardFailure('invalid-clipboard');
    const current = mediaAssetById(assetId, registry);
    if (!current || current.kind !== kind || current.hash !== expected.hash ||
      current.generation !== expected.generation) {
      return clipClipboardFailure('stale-media');
    }
  }
  return { valid: true, tracks, clips, sourceStartTick };
}

function allocateClipboardId(state, makeId, kind, reserved) {
  const generated = new Set();
  while (generated.size < 1000) {
    const candidate = String(makeId?.(kind) || newUuid(kind));
    if (candidate && !reserved.has(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
    if (generated.has(candidate)) break;
    generated.add(candidate);
  }
  throw new Error(`Could not allocate a unique ${kind} UUID.`);
}

function interleaveCopiedTracks(existing, copiesBySource) {
  const placed = new Set();
  const ordered = [];
  for (const track of existing) {
    const sourceId = String(track.id);
    const copy = copiesBySource.get(sourceId);
    if (copy) {
      ordered.push(copy);
      placed.add(sourceId);
    }
    ordered.push(track);
  }
  for (const [sourceId, copy] of copiesBySource) {
    if (!placed.has(sourceId)) ordered.push(copy);
  }
  return ordered;
}

function uniqueCopyName(value, used, fallback) {
  const source = String(value || fallback).trim() || fallback;
  const priorCopy = /^(.*\S) copy(?: \d+)?$/i.exec(source);
  const base = priorCopy?.[1] || source;
  let suffix = 1;
  let candidate = `${base} copy`;
  while (used.has(candidate.toLocaleLowerCase())) {
    suffix++;
    candidate = `${base} copy ${suffix}`;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

export function pasteClipClipboard(payload) {
  if (get(playing)) return clipClipboardFailure('playing');
  const validated = validateClipClipboard(payload);
  if (!validated.valid) return validated;
  commitLayersToActiveFrame();
  if (beginStroke() !== true) return clipClipboardFailure('history-busy');
  try {
    const pasteTick = get(canonicalPlayheadTick);
    const result = transactClipTimeline('paste-clips', (state, context) => {
      const reserved = new Set([
        ...state.tracks.map((track) => String(track.id)),
        ...state.clips.map((clip) => String(clip.id)),
        ...(state.tags || []).map((tag) => String(tag.id)),
        ...state.tracks.map((track) => String(trackLayerId(track) || '')).filter(Boolean),
        ...validated.tracks.map((track) => String(track.id)),
        ...validated.clips.map((clip) => String(clip.id)),
        ...validated.tracks
          .map((track) => String(trackLayerId(track) || ''))
          .filter(Boolean),
      ]);
      const currentTracks = new Map(state.tracks.map((track) => [String(track.id), track]));
      const currentGroupsByLayer = new Map(state.tracks
        .filter((track) => track.kind === 'group' && trackLayerId(track) != null)
        .map((track) => [String(trackLayerId(track)), track]));
      const usedNames = new Set(state.tracks.flatMap((track) => [track.name, track.layer?.name])
        .map((name) => String(name || '').trim().toLocaleLowerCase())
        .filter(Boolean));
      const newTrackIds = new Map();
      const newLayerIds = new Map();
      for (const source of validated.tracks) {
        newTrackIds.set(
          String(source.id),
          allocateClipboardId(state, context.makeId, 'track', reserved),
        );
        if (source.kind !== 'audio') {
          newLayerIds.set(
            String(trackLayerId(source)),
            allocateClipboardId(state, context.makeId, 'layer', reserved),
          );
        }
      }

      const copiesBySource = new Map();
      const pastedLayerIds = [];
      for (const source of validated.tracks) {
        const sourceId = String(source.id);
        const copy = cloneDurable(source);
        copy.id = newTrackIds.get(sourceId);
        delete copy.clips;
        if (source.kind !== 'audio') {
          const sourceLayerId = String(trackLayerId(source));
          const layerId = newLayerIds.get(sourceLayerId);
          copy.layer = cloneDurable(source.layer);
          copy.layer.id = layerId;
          copy.layer.name = uniqueCopyName(
            source.layer?.name || source.name,
            usedNames,
            'Layer',
          );
          copy.name = copy.layer.name;
          if ('sourceLayerId' in copy) copy.sourceLayerId = layerId;
          pastedLayerIds.push(layerId);

          const currentSource = currentTracks.get(sourceId);
          let parent = currentSource?.parentTrackId == null
            ? null
            : currentTracks.get(String(currentSource.parentTrackId));
          if (currentSource && parent?.kind !== 'group') {
            const groupId = currentSource.layer?.groupId == null
              ? null
              : String(currentSource.layer.groupId);
            parent = groupId ? currentGroupsByLayer.get(groupId) : null;
          }
          if (currentSource && parent?.kind === 'group' && trackLayerId(parent) != null) {
            copy.parentTrackId = parent.id;
            copy.layer.groupId = trackLayerId(parent);
          } else {
            delete copy.parentTrackId;
            delete copy.layer.groupId;
          }
        } else {
          copy.name = uniqueCopyName(source.name, usedNames, 'Audio');
        }
        copiesBySource.set(sourceId, copy);
      }

      const pastedClips = validated.clips.map((source) => ({
        ...cloneDurable(source),
        id: allocateClipboardId(state, context.makeId, 'clip', reserved),
        trackId: newTrackIds.get(String(source.trackId)),
        startTick: pasteTick + Number(source.startTick) - validated.sourceStartTick,
      }));
      const visualSources = validated.tracks.filter((track) => track.kind !== 'audio');
      const audioSources = validated.tracks.filter((track) => track.kind === 'audio');
      const visualCopies = new Map(visualSources.map((track) => [
        String(track.id),
        copiesBySource.get(String(track.id)),
      ]));
      const audioCopies = new Map(audioSources.map((track) => [
        String(track.id),
        copiesBySource.get(String(track.id)),
      ]));
      state.tracks = [
        ...interleaveCopiedTracks(
          state.tracks.filter((track) => track.kind !== 'audio'),
          visualCopies,
        ),
        ...interleaveCopiedTracks(
          state.tracks.filter((track) => track.kind === 'audio'),
          audioCopies,
        ),
      ];
      state.tracks.forEach((track, index) => { track.stackIndex = index; });
      state.clips.push(...pastedClips);
      return {
        state,
        changed: true,
        clipIds: pastedClips.map((clip) => clip.id),
        trackIds: [...copiesBySource.values()].map((track) => track.id),
        layerIds: pastedLayerIds,
      };
    });
    if (!result.changed) {
      endStroke();
      return clipClipboardFailure(result.reason || 'invalid-result', {
        ...(result.errors ? { errors: result.errors } : {}),
      });
    }
    noteAuthoredMutation();
    publishResolvedTick(result.playheadTick);
    setCanonicalClipSelection({ clipIds: result.clipIds });
    if (result.layerIds.length) {
      selectedLayerIds.set(new Set(result.layerIds));
      activeLayerId.set(result.layerIds[0]);
      activeLayerPart.set('layer');
      cellSelection.set(new Set());
    }
    endStroke();
    return result;
  } catch (error) {
    cancelStroke();
    throw error;
  }
}

export function initTimeline(initialLayers) {
  stop();
  const current = getClipTimelineState();
  const audioTracks = current.tracks.filter((track) => track.kind === 'audio')
    .map((track) => cloneDurable(track));
  const audioTrackIds = new Set(audioTracks.map((track) => track.id));
  const audioClips = current.clips.filter((clip) =>
    clip.kind === 'audio' && audioTrackIds.has(clip.trackId))
    .map((clip) => cloneDurable(clip));
  const state = initialVisualTimeline(initialLayers, { tracks: audioTracks, clips: audioClips });
  const result = initializeClipTimelineState(state, {
    playheadTick: 0,
    projectRevision: captureProjectRevision(),
  });
  if (result?.changed === false) throw new Error('Could not initialize the canonical timeline.');
  timelineStructureToken++;
  timelineStructureRevision.update((value) => value + 1);
  synchronizedAuthoredRevision = get(authoredRevision);
  publishResolvedTick(0);
}

export function loadCanonicalTimeline(state) {
  stop();
  const result = initializeClipTimelineState({
    ...cloneDurable(state),
    fps: get(fps),
    tickDuration: 1000 / get(fps),
  }, {
    playheadTick: 0,
    projectRevision: captureProjectRevision(),
  });
  if (result?.changed === false) throw new Error('Could not initialize the canonical timeline.');
  timelineStructureToken++;
  timelineStructureRevision.update((value) => value + 1);
  synchronizedAuthoredRevision = get(authoredRevision);
  publishResolvedTick(0);
}

export function canonicalTimelineStateForSave() {
  commitLayersToActiveFrame();
  return getClipTimelineState();
}

export function frameStartTick(index) {
  return tickIndex(index) == null ? null : Number(index);
}

export function frameAtProjectTick(tick) {
  const index = tickIndex(tick);
  return index == null ? null : {
    frameIndex: index,
    localTick: 0,
    start: index,
    end: index + 1,
  };
}

export function frameReadModel(count, active, _holds, rate, layersAt) {
  const safeRate = Math.max(1, Number(rate) || DEFAULT_FPS);
  return Array.from({ length: Math.max(0, integer(count)) }, (_, index) => {
    let cachedLayers;
    return {
      id: index,
      index,
      duration: 1000 / safeRate,
      tickDuration: 1000 / safeRate,
      hold: 1,
      get layers() {
        if (!cachedLayers) cachedLayers = layersAt(index, index === active);
        return cachedLayers;
      },
    };
  });
}

export const frames = derived(
  [canonicalClipTimeline, canonicalPlayheadTick, fps, playing],
  ([$state, $active, $rate, $playing], set) => {
    if ($playing) return;
    const count = clipTimelineDurationTicks($state);
    set(frameReadModel(count, $active, null, $rate, (tick, active) => (
      active
        ? get(layers).map((layer) => ({ ...layer }))
        : resolveClipTimelineLayers($state, tick)
    )));
  },
  [],
);

export function compositeFrameCells(frame, w, h, layerIdx = null, x0 = 0, y0 = 0, options = {}) {
  const viewport = { x: x0, y: y0, w, h };
  const all = frame?.layers || [];
  if (layerIdx == null) return compositeWorld(all, viewport, null, options);
  const target = all[layerIdx];
  if (!target) return compositeWorld([], viewport, null, options);
  if (target.type === 'group') {
    return compositeWorld(all.filter((layer) =>
      layer.id === target.id || layer.groupId === target.id), viewport, null, options);
  }
  const group = target.groupId
    ? all.find((layer) => layer.id === target.groupId && layer.type === 'group')
    : null;
  return compositeWorld(group ? [target, group] : [target], viewport, null, options);
}

export function gotoFrame(value) {
  return seekTick(value);
}

export function seekTick(value) {
  const tick = boundedTick(value);
  if (tick == null) return false;
  if (get(playing)) stop({ preserveTick: true });
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('commit-move'));
  commitLayersToActiveFrame();
  const changed = seekClipTimelineTick(tick);
  publishResolvedTick(tick);
  return changed || tick === get(canonicalPlayheadTick);
}

export function setFps(value) {
  if (get(playing)) return false;
  const number = Number(value);
  if (!Number.isFinite(number)) return false;
  const next = Math.max(1, Math.min(60, Math.round(number)));
  if (next === get(fps)) return false;
  checkpointHistory();
  fps.set(next);
  return true;
}

function runCanonicalClipOperation(operation) {
  commitLayersToActiveFrame();
  const result = operation();
  if (!result?.changed) return result;
  normalizeVideoSourceBounds();
  noteAuthoredMutation();
  publishResolvedTick(result.playheadTick);
  return { ...result, state: getClipTimelineState() };
}

export function moveClip(clipId, targetStartTick, options = {}) {
  return runCanonicalClipOperation(() => moveCanonicalClip(clipId, targetStartTick, options));
}

export function moveClips(operations, options = {}) {
  return runCanonicalClipOperation(() => moveCanonicalClips(operations, options));
}

export function duplicateClips(operations, options = {}) {
  return runCanonicalClipOperation(() => duplicateCanonicalClips(operations, options));
}

export function moveTimelineKeys(selection, deltaTicks, options = {}) {
  return runCanonicalClipOperation(() =>
    moveCanonicalTimelineKeys(selection, deltaTicks, options));
}

export function trimClip(clipId, edge, targetTick, options = {}) {
  return runCanonicalClipOperation(() => trimCanonicalClip(clipId, edge, targetTick, options));
}

export function trimClips(operations, options = {}) {
  return runCanonicalClipOperation(() => trimCanonicalClips(operations, options));
}

export function setTimelineTag(definition, options = {}) {
  return runCanonicalClipOperation(() => setCanonicalTimelineTag(definition, options));
}

export function setLoopStartTag(tick, options = {}) {
  return runCanonicalClipOperation(() => setCanonicalLoopStart(tick, options));
}

export function setLoopEndTag(tick, options = {}) {
  return runCanonicalClipOperation(() => setCanonicalLoopEnd(tick, options));
}

export function addCustomTimelineTag(tick, value, options = {}) {
  return runCanonicalClipOperation(() => addCanonicalCustomTag(tick, value, options));
}

export function updateCustomTimelineTag(tagId, patch, options = {}) {
  return runCanonicalClipOperation(() => updateCanonicalCustomTag(tagId, patch, options));
}

export function removeTimelineTag(tagId, options = {}) {
  return runCanonicalClipOperation(() => removeCanonicalTag(tagId, options));
}

function razorBoundaryValues(tick) {
  const projectTick = integer(tick, -1);
  if (projectTick < 0) return new Map();
  const state = getClipTimelineState();
  const tracks = new Map(state.tracks.map((track) => [track.id, track]));
  const resolved = new Map(resolveClipTimelineLayers(state, projectTick)
    .map((layer) => [layer.id, layer]));
  return new Map(state.clips.flatMap((clip) => {
    const track = tracks.get(clip.trackId);
    if (clip.kind === 'audio' || track?.locked ||
      projectTick <= clip.startTick || !clipContainsTick(clip, projectTick)) return [];
    const layer = resolved.get(track?.layer?.id);
    const values = {};
    for (const name of [
      'position', 'visibility', 'effectIntensity', 'maskOpacity', 'maskPosition', 'shapePath',
    ]) {
      if (!(clip.propertyTracks?.[name] || []).length) continue;
      let fallback;
      if (name === 'position') fallback = layer?.offset;
      else if (name === 'visibility') fallback = layer?.visible;
      else if (name === 'effectIntensity') fallback = layer?.effect?.intensity;
      else if (name === 'maskOpacity') fallback = layer?.mask?.opacity;
      else if (name === 'maskPosition') fallback = layer?.mask?.offset;
      else fallback = pathValueFromShape(layer?.shape);
      values[name] = resolveClipPropertyAtTick(clip, name, projectTick, fallback);
    }
    return [[clip.id, values]];
  }));
}

export function razorClip(...args) {
  const tick = Number.isFinite(Number(args[1])) ? Number(args[1]) : Number(args[0]);
  commitLayersToActiveFrame();
  const boundaryValues = razorBoundaryValues(tick);
  const result = razorCanonicalClips(...args);
  if (!result?.changed) return result;
  const splits = result.splits || (result.right ? [{
    originalId: result.left?.id,
    rightId: result.right.id,
    sourceTick: result.sourceTick,
  }] : []);
  if (splits.length) {
    transactClipTimeline('materialize-razor-right-boundaries', (state) => {
      let changed = false;
      for (const split of splits) {
        const clip = state.clips.find((candidate) => candidate.id === split.rightId);
        const values = boundaryValues.get(split.originalId);
        if (!clip || !values) continue;
        for (const [name, value] of Object.entries(values)) {
          changed = upsertProperty(
            clip,
            name,
            split.sourceTick,
            name === 'shapePath' ? { path: value } : value,
          ) || changed;
        }
      }
      return changed ? { state, changed: true } : false;
    });
  }
  normalizeVideoSourceBounds();
  noteAuthoredMutation();
  publishResolvedTick(result.playheadTick);
  return { ...result, state: getClipTimelineState() };
}

export function razorClips(cuts, options = {}) {
  const requested = Array.isArray(cuts) ? cuts : [];
  commitLayersToActiveFrame();
  const boundaryValues = new Map();
  for (const cut of requested) {
    const tick = integer(cut?.tick, -1);
    const clipId = String(cut?.clipId ?? '');
    if (!clipId || tick < 0) continue;
    const values = razorBoundaryValues(tick).get(clipId);
    if (values) boundaryValues.set(`${clipId}\u0000${tick}`, values);
  }
  const result = razorCanonicalPath(requested, options);
  if (!result?.changed) return result;
  if (result.splits?.length) {
    transactClipTimeline('materialize-razor-path-boundaries', (state) => {
      let changed = false;
      for (const split of result.splits) {
        const clip = state.clips.find((candidate) => candidate.id === split.rightId);
        const values = boundaryValues.get(`${split.originalId}\u0000${split.tick}`);
        if (!clip || !values) continue;
        for (const [name, value] of Object.entries(values)) {
          changed = upsertProperty(
            clip,
            name,
            split.sourceTick,
            name === 'shapePath' ? { path: value } : value,
          ) || changed;
        }
      }
      return changed ? { state, changed: true } : false;
    });
  }
  normalizeVideoSourceBounds();
  noteAuthoredMutation();
  publishResolvedTick(result.playheadTick);
  return { ...result, state: getClipTimelineState() };
}

export function deleteClipSelection(selection = getClipTimelineSelection(), options = {}) {
  return runCanonicalClipOperation(() => deleteCanonicalSelection(selection, options));
}

export function rippleClips(...args) {
  return runCanonicalClipOperation(() => rippleCanonicalClips(...args));
}

export function addEmptyClipTime(tick, ticks, options = {}) {
  return runCanonicalClipOperation(() => addCanonicalEmpty(tick, ticks, options));
}

export function setClipSelection(selection) {
  return setCanonicalClipSelection(selection);
}

export function clearClipSelection() {
  return clearCanonicalClipSelection();
}

export const razor = razorClip;
export const deleteSelection = deleteClipSelection;
export const ripple = rippleClips;
export const addEmpty = addEmptyClipTime;

export function appendProjectTick(blankActive = false) {
  if (get(playing)) return false;
  const state = getClipTimelineState();
  const at = get(canonicalPlayheadTick) + 1;
  const activeId = get(activeLayerId);
  checkpointHistory();
  const result = transactClipTimeline('insert-project-tick', (draft) => {
    let changed = false;
    for (const track of draft.tracks) {
      if (track.kind !== 'group' || !track.propertyTracks) continue;
      track.propertyTracks = Object.fromEntries(Object.entries(track.propertyTracks).map(
        ([name, keys]) => [name, keys.map((key) => ({
          ...key,
          tick: key.tick >= at ? key.tick + 1 : key.tick,
        }))],
      ));
    }
    for (const clip of draft.clips) {
      if (clip.kind === 'audio') continue;
      const end = clip.startTick + clipDuration(clip);
      if (clip.startTick >= at) {
        clip.startTick++;
        changed = true;
        continue;
      }
      if (end < at) continue;
      const sourceTick = clip.inTick + at - clip.startTick;
      clip.frameKeys = clip.frameKeys.map((key) => ({
        ...key,
        tick: key.tick >= sourceTick ? key.tick + 1 : key.tick,
      }));
      clip.propertyTracks = Object.fromEntries(Object.entries(clip.propertyTracks || {}).map(
        ([name, keys]) => [name, keys.map((key) => ({
          ...key,
          tick: key.tick >= sourceTick ? key.tick + 1 : key.tick,
        }))],
      ));
      clip.outTick++;
      clip.sourceDuration++;
      changed = true;
      if (blankActive) {
        const track = draft.tracks.find((candidate) => candidate.id === clip.trackId);
        if (track?.layer?.id === activeId && ['cell', 'background', 'text', 'shape'].includes(
          track.layer.type,
        )) {
          const blank = { cells: {} };
          if (track.layer.type === 'text') Object.assign(blank, {
            text: '', box: null, wrap: true, fg: '#ffffff', runs: [],
          });
          if (track.layer.type === 'shape') blank.shape = null;
          clip.frameKeys.push({ tick: sourceTick, value: blank });
          clip.frameKeys.sort((first, second) => first.tick - second.tick);
        }
      }
    }
    return changed ? { state: draft, changed: true } : false;
  });
  if (!result.changed) return false;
  seekClipTimelineTick(at);
  publishResolvedTick(at);
  return true;
}

// Temporary call-site alias only. It has no persisted compatibility contract and
// delegates to canonical clip/tick state; no global frame collection exists.
export const addFrame = appendProjectTick;

function propertyContext(state, layerId, projectTick, makeId = null, create = false) {
  const track = trackForLayer(state, layerId);
  if (!track) return null;
  if (track.kind === 'group' || track.layer?.type === 'group') {
    return { track, owner: track, sourceTick: projectTick, clip: null };
  }
  let clip = clipAtTick(state, track.id, projectTick);
  if (!clip && create) {
    const live = get(layers).find((layer) => layer.id === layerId) || track.layer;
    clip = ensureClipForTick(state, track, live, projectTick, makeId);
  }
  return clip
    ? { track, owner: clip, sourceTick: sourceTickAt(clip, projectTick), clip }
    : { track, owner: null, sourceTick: null, clip: null };
}

function propertyRecords(state, layerId, name) {
  const track = trackForLayer(state, layerId);
  if (!track) return [];
  if (track.kind === 'group' || track.layer?.type === 'group') {
    return (track.propertyTracks?.[name] || []).map((key) => ({
      owner: track,
      clip: null,
      sourceTick: key.tick,
      projectTick: key.tick,
      key,
    }));
  }
  return clipsForTrack(state, track.id).flatMap((clip) =>
    (clip.propertyTracks?.[name] || []).map((key) => ({
      owner: clip,
      clip,
      sourceTick: key.tick,
      projectTick: projectTickAt(clip, key.tick),
      key,
    })).filter((record) => clipContainsTick(clip, record.projectTick)));
}

function propertyAt(layerId, name, tick, fallback) {
  const state = getClipTimelineState();
  const context = propertyContext(state, layerId, tick);
  if (!context?.track) return cloneDurable(fallback);
  if (!context.clip) {
    const keys = context.track.propertyTracks?.[name];
    return resolveClipPropertyAtTick({
      startTick: 0,
      inTick: 0,
      outTick: clipTimelineDurationTicks(state),
      sourceDuration: clipTimelineDurationTicks(state),
      propertyTracks: { [name]: keys || [] },
    }, name, tick, fallback);
  }
  return resolveClipPropertyAtTick(context.clip, name, tick, fallback);
}

function updateBaseProperty(layer, name, value) {
  if (name === 'position') layer.offset = roundedPosition(value);
  else if (name === 'visibility') layer.visible = value !== false;
  else if (name === 'effectIntensity' && layer.effect) {
    layer.effect = { ...layer.effect, intensity: Number(value) };
  } else if (name === 'maskOpacity' && layer.mask) {
    layer.mask = { ...layer.mask, opacity: Number(value) };
  } else if (name === 'maskPosition' && layer.mask) {
    layer.mask = { ...layer.mask, offset: roundedPosition(value) };
  }
}

function setPropertyKey(layerId, projectTick, name, value) {
  const tick = tickIndex(projectTick);
  if (tick == null || get(playing)) return false;
  const state = getClipTimelineState();
  const current = propertyContext(state, layerId, tick);
  const existing = current?.owner?.propertyTracks?.[name]
    ?.find((key) => key.tick === current.sourceTick);
  if (existing && sameValue(existing.value, value)) return false;
  checkpointHistory();
  const result = transactClipTimeline(`set-${name}-key`, (draft, context) => {
    const target = propertyContext(draft, layerId, tick, context.makeId, true);
    if (!target?.owner) return false;
    const changed = upsertProperty(target.owner, name, target.sourceTick, value);
    return changed ? { state: draft, changed: true } : false;
  });
  if (result.changed) publishResolvedTick();
  return !!result.changed;
}

function setStaticProperty(layerId, name, value) {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  if (!track || sameValue(livePropertyValue(track.layer, name), value)) return false;
  checkpointHistory();
  const result = transactClipTimeline(`set-static-${name}`, (draft) => {
    const target = trackForLayer(draft, layerId);
    if (!target) return false;
    target.layer = { ...target.layer };
    updateBaseProperty(target.layer, name, value);
    return { state: draft, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return !!result.changed;
}

function setPropertyTrackEnabled(layerId, name, enabled, fallback) {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  if (!track) return false;
  const current = propertyEnabled(state, track, name);
  const next = !!enabled;
  if (current === next) return false;
  const tick = get(canonicalPlayheadTick);
  const value = propertyAt(layerId, name, tick, fallback(track.layer));
  checkpointHistory();
  const result = transactClipTimeline(`${next ? 'enable' : 'disable'}-${name}`, (draft, context) => {
    const targetTrack = trackForLayer(draft, layerId);
    if (!targetTrack) return false;
    if (next) {
      const target = propertyContext(draft, layerId, tick, context.makeId, true);
      if (!target?.owner) return false;
      upsertProperty(target.owner, name, target.sourceTick, value);
    } else {
      targetTrack.layer = { ...targetTrack.layer };
      updateBaseProperty(targetTrack.layer, name, value);
      if (targetTrack.propertyTracks?.[name]) {
        targetTrack.propertyTracks = { ...targetTrack.propertyTracks };
        delete targetTrack.propertyTracks[name];
      }
      for (const clip of clipsForTrack(draft, targetTrack.id)) {
        if (!clip.propertyTracks?.[name]) continue;
        clip.propertyTracks = { ...clip.propertyTracks };
        delete clip.propertyTracks[name];
      }
    }
    return { state: draft, changed: true };
  });
  if (result.changed) publishResolvedTick(tick);
  return !!result.changed;
}

function deletePropertyKeys(layerId, name, ticks) {
  const requested = new Set([...(ticks || [])].map(Number));
  const selected = propertyRecords(getClipTimelineState(), layerId, name)
    .filter((record) => requested.has(record.projectTick));
  if (!selected.length) return [];
  checkpointHistory();
  const identities = new Set(selected.map((record) =>
    `${record.owner.id}\u0000${record.sourceTick}`));
  const result = transactClipTimeline(`delete-${name}-keys`, (state) => {
    for (const track of state.tracks) {
      if (identities.size && track.propertyTracks?.[name]) {
        track.propertyTracks[name] = track.propertyTracks[name].filter((key) =>
          !identities.has(`${track.id}\u0000${key.tick}`));
      }
    }
    for (const clip of state.clips) {
      if (!clip.propertyTracks?.[name]) continue;
      clip.propertyTracks[name] = clip.propertyTracks[name].filter((key) =>
        !identities.has(`${clip.id}\u0000${key.tick}`));
    }
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return selected.map((record) => record.projectTick);
}

function movePropertyKeys(layerId, name, ticks, delta) {
  const state = getClipTimelineState();
  const requested = new Set([...(ticks || [])].map(Number));
  const selected = propertyRecords(state, layerId, name)
    .filter((record) => requested.has(record.projectTick));
  const shift = integer(delta);
  if (!selected.length || !shift) return [];
  if (selected.some((record) => {
    const destination = record.projectTick + shift;
    return destination < 0 || (record.clip && !clipContainsTick(record.clip, destination));
  })) return [];
  checkpointHistory();
  const edits = new Map(selected.map((record) => [
    `${record.owner.id}\u0000${record.sourceTick}`,
    record.sourceTick + shift,
  ]));
  const result = transactClipTimeline(`move-${name}-keys`, (draft) => {
    for (const owner of [...draft.tracks, ...draft.clips]) {
      const keys = owner.propertyTracks?.[name];
      if (!keys) continue;
      const next = keys.map((key) => ({
        ...key,
        tick: edits.get(`${owner.id}\u0000${key.tick}`) ?? key.tick,
      })).sort((a, b) => a.tick - b.tick);
      if (new Set(next.map((key) => key.tick)).size !== next.length) return false;
      owner.propertyTracks[name] = next;
    }
    return { state: draft, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return result.changed
    ? selected.map((record) => record.projectTick + shift).sort((a, b) => a - b)
    : [];
}

function copyPropertyKeys(layerId, name, ticks, type, mapValue = (value) => cloneDurable(value)) {
  const requested = new Set([...(ticks || [])].map(Number));
  const selected = propertyRecords(getClipTimelineState(), layerId, name)
    .filter((record) => requested.has(record.projectTick))
    .sort((a, b) => a.projectTick - b.projectTick);
  const origin = selected[0]?.projectTick || 0;
  return {
    type,
    origin,
    keys: selected.map((record) => ({
      frame: record.projectTick - origin,
      value: mapValue(record.key.value),
    })),
  };
}

function pastePropertyKeys(layerId, name, destination, payload, type, normalize = cloneDurable) {
  const start = integer(destination, -1);
  if (payload?.type !== type || !Array.isArray(payload.keys) || start < 0) return [];
  const keys = payload.keys.flatMap((entry) => {
    const tick = start + integer(entry.frame);
    const value = normalize(entry.value ?? entry);
    return tickIndex(tick) == null || value == null ? [] : [{ tick, value }];
  });
  if (!keys.length) return [];
  checkpointHistory();
  const result = transactClipTimeline(`paste-${name}-keys`, (state, context) => {
    let changed = false;
    for (const key of keys) {
      const target = propertyContext(state, layerId, key.tick, context.makeId, true);
      if (target?.owner) changed = upsertProperty(
        target.owner,
        name,
        target.sourceTick,
        key.value,
      ) || changed;
    }
    return changed ? { state, changed: true } : false;
  });
  if (result.changed) publishResolvedTick();
  return result.changed ? [...new Set(keys.map((key) => key.tick))].sort((a, b) => a - b) : [];
}

function temporalPresetEdits(preset) {
  if (preset === 'linear') return { in: LINEAR_TEMPORAL_HANDLE, out: LINEAR_TEMPORAL_HANDLE };
  if (preset === 'ease-in') return { in: SLOW_TEMPORAL_HANDLE };
  if (preset === 'ease-out') return { out: SLOW_TEMPORAL_HANDLE };
  if (preset === 'ease-in-out') return { in: SLOW_TEMPORAL_HANDLE, out: SLOW_TEMPORAL_HANDLE };
  return null;
}

function editPropertyKeyMetadata(layerId, name, ticks, edit) {
  const requested = new Set([...(ticks || [])].map(Number));
  const selected = propertyRecords(getClipTimelineState(), layerId, name)
    .filter((record) => requested.has(record.projectTick));
  if (!selected.length) return [];
  const changes = new Map();
  for (const record of selected) {
    const next = edit(cloneDurable(record.key.value), record, selected);
    if (next && !sameValue(next, record.key.value)) {
      changes.set(`${record.owner.id}\u0000${record.sourceTick}`, next);
    }
  }
  if (!changes.size) return [];
  checkpointHistory();
  const result = transactClipTimeline(`edit-${name}-key-metadata`, (state) => {
    for (const owner of [...state.tracks, ...state.clips]) {
      if (!owner.propertyTracks?.[name]) continue;
      owner.propertyTracks[name] = owner.propertyTracks[name].map((key) => {
        const value = changes.get(`${owner.id}\u0000${key.tick}`);
        return value ? { ...key, value } : key;
      });
    }
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return selected.map((record) => record.projectTick);
}

export function setLayerOffsetById(frameValue, layerId, offset) {
  const value = roundedPosition(offset);
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  if (!track) return false;
  return propertyEnabled(state, track, 'position')
    ? setPropertyKey(layerId, Number(frameValue), 'position', value)
    : setStaticProperty(layerId, 'position', value);
}

export function hasPosKey(layerId, frameValue) {
  const tick = Number(frameValue);
  return propertyRecords(getClipTimelineState(), layerId, 'position')
    .some((record) => record.projectTick === tick);
}

export function setPosKey(layerId, frameValue, keyed) {
  const tick = tickIndex(frameValue);
  if (tick == null) return false;
  const owns = hasPosKey(layerId, tick);
  if (owns === !!keyed) return false;
  if (!keyed) return deletePropertyKeys(layerId, 'position', [tick]).length > 0;
  const layer = resolvedLayer(getClipTimelineState(), layerId, tick);
  return setPropertyKey(layerId, tick, 'position', roundedPosition(layer?.offset));
}

export function togglePosKey(layerId, frameValue) {
  return setPosKey(layerId, frameValue, !hasPosKey(layerId, frameValue));
}

export function anyPosKeys(layerId) {
  return propertyRecords(getClipTimelineState(), layerId, 'position').length > 0;
}

export function clearPosKeys(layerId) {
  return setPropertyTrackEnabled(layerId, 'position', false, (layer) => layer.offset || { x: 0, y: 0 });
}

export function positionKeys(layerId) {
  return propertyRecords(getClipTimelineState(), layerId, 'position')
    .map((record) => ({
      frame: record.projectTick,
      ...roundedPosition(record.key.value),
      interpolation: validInterpolation(record.key.value?.interpolation),
      ...(normalizeTemporalEase(record.key.value?.temporalEase)
        ? { temporalEase: normalizeTemporalEase(record.key.value.temporalEase) }
        : {}),
    })).sort((a, b) => a.frame - b.frame);
}

export function deletePosKeys(layerId, ticks) {
  return deletePropertyKeys(layerId, 'position', ticks);
}

export function movePosKeys(layerId, ticks, delta) {
  return movePropertyKeys(layerId, 'position', ticks, delta);
}

export function copyPosKeys(layerId, ticks) {
  const payload = copyPropertyKeys(layerId, 'position', ticks, 'position');
  payload.keys = payload.keys.map(({ frame, value }) => ({ frame, ...cloneDurable(value) }));
  return payload;
}

export function pastePosKeys(layerId, destinationFrame, payload) {
  const normalized = payload?.type === 'position'
    ? {
      ...payload,
      keys: (payload.keys || []).map((key) => ({
        frame: key.frame,
        value: {
          x: integer(key.x),
          y: integer(key.y),
          interpolation: validInterpolation(key.interpolation),
          ...(normalizeTemporalEase(key.temporalEase)
            ? { temporalEase: normalizeTemporalEase(key.temporalEase) }
            : {}),
        },
      })),
    }
    : payload;
  return pastePropertyKeys(layerId, 'position', destinationFrame, normalized, 'position');
}

export function setPosKeyInterpolation(layerId, ticks, interpolation) {
  const preset = validInterpolation(interpolation);
  return editPropertyKeyMetadata(layerId, 'position', ticks, (value) => ({
    ...value,
    interpolation: preset,
  }));
}

function setPropertyTemporalEase(layerId, name, ticks, edits) {
  if (!edits) return [];
  const ordered = propertyRecords(getClipTimelineState(), layerId, name)
    .sort((a, b) => a.projectTick - b.projectTick);
  const indexByIdentity = new Map(ordered.map((record, index) => [
    `${record.owner.id}\u0000${record.sourceTick}`,
    index,
  ]));
  return editPropertyKeyMetadata(layerId, name, ticks, (value, record) => {
    const index = indexByIdentity.get(`${record.owner.id}\u0000${record.sourceTick}`);
    let key = value;
    for (const [side, handle] of Object.entries(edits)) {
      if ((side === 'in' && index === 0) || (side === 'out' && index === ordered.length - 1)) continue;
      key = withTemporalEaseSide(key, side, handle);
    }
    return key;
  });
}

export function setPosKeyTemporalEase(layerId, ticks, side, handle) {
  if ((side !== 'in' && side !== 'out') ||
    (handle != null && !normalizeTemporalHandle(handle))) return [];
  return setPropertyTemporalEase(layerId, 'position', ticks, { [side]: handle });
}

export function setPosKeyTemporalPreset(layerId, ticks, preset) {
  return setPropertyTemporalEase(layerId, 'position', ticks, temporalPresetEdits(preset));
}

export function isVisibilityTrackEnabled(layerId) {
  const state = getClipTimelineState();
  return propertyEnabled(state, trackForLayer(state, layerId), 'visibility');
}

export function visibilityAt(layerId, frameIdx) {
  const tick = tickIndex(frameIdx);
  if (tick == null) return false;
  return propertyAt(layerId, 'visibility', tick,
    trackForLayer(getClipTimelineState(), layerId)?.layer?.visible !== false) !== false;
}

export function visibilityKeys(layerId) {
  return propertyRecords(getClipTimelineState(), layerId, 'visibility')
    .map((record) => ({ frame: record.projectTick, visible: record.key.value !== false }))
    .sort((a, b) => a.frame - b.frame);
}

export function hasVisibilityKey(layerId, frameIdx) {
  const tick = Number(frameIdx);
  return propertyRecords(getClipTimelineState(), layerId, 'visibility')
    .some((record) => record.projectTick === tick);
}

export function setVisibilityTrackEnabled(layerId, enabled) {
  return setPropertyTrackEnabled(layerId, 'visibility', enabled, (layer) => layer.visible !== false);
}

export function setVisibilityKey(layerId, frameIdx, visible) {
  return setPropertyKey(layerId, Number(frameIdx), 'visibility', !!visible);
}

export function toggleVisibilityKey(layerId, frameIdx) {
  const tick = tickIndex(frameIdx);
  if (tick == null) return false;
  return hasVisibilityKey(layerId, tick)
    ? deletePropertyKeys(layerId, 'visibility', [tick]).length > 0
    : setPropertyKey(layerId, tick, 'visibility', visibilityAt(layerId, tick));
}

export function deleteVisibilityKeys(layerId, ticks) {
  return deletePropertyKeys(layerId, 'visibility', ticks);
}

export function moveVisibilityKeys(layerId, ticks, delta) {
  return movePropertyKeys(layerId, 'visibility', ticks, delta);
}

export function copyVisibilityKeys(layerId, ticks) {
  const payload = copyPropertyKeys(layerId, 'visibility', ticks, 'visibility');
  payload.keys = payload.keys.map(({ frame, value }) => ({ frame, visible: value !== false }));
  return payload;
}

export function pasteVisibilityKeys(layerId, destinationFrame, payload) {
  const normalized = payload?.type === 'visibility'
    ? {
      ...payload,
      keys: (payload.keys || []).map((key) => ({
        frame: key.frame,
        value: key.visible !== false,
      })),
    }
    : payload;
  return pastePropertyKeys(layerId, 'visibility', destinationFrame, normalized, 'visibility');
}

const SCALAR_PROPERTIES = {
  effectIntensity: {
    min: -1,
    max: 1,
    fallback: 0,
    supports: (layer) => layer?.type === 'effect' && !!layer.effect,
    base: (layer) => layer?.effect?.intensity ?? 0,
    payloadType: 'effect-intensity',
  },
  maskOpacity: {
    min: 0,
    max: 1,
    fallback: 1,
    supports: (layer) => layer?.type === 'effect' && !!layer.mask,
    base: (layer) => layer?.mask?.opacity ?? 1,
    payloadType: 'mask-opacity',
  },
};

function clampScalar(value, config) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(config.min, Math.min(config.max, number))
    : config.fallback;
}

function scalarAt(layerId, frameIdx, name) {
  const config = SCALAR_PROPERTIES[name];
  const tick = tickIndex(frameIdx);
  const track = trackForLayer(getClipTimelineState(), layerId);
  if (!config || tick == null || !config.supports(track?.layer)) return config?.fallback ?? 0;
  return clampScalar(propertyAt(layerId, name, tick, config.base(track.layer)), config);
}

function scalarTrackEnabled(layerId, name) {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  return !!SCALAR_PROPERTIES[name]?.supports(track?.layer) && propertyEnabled(state, track, name);
}

function hasScalarKey(layerId, frameIdx, name) {
  const tick = Number(frameIdx);
  return propertyRecords(getClipTimelineState(), layerId, name)
    .some((record) => record.projectTick === tick);
}

function setScalarTrackEnabled(layerId, enabled, name) {
  const config = SCALAR_PROPERTIES[name];
  const track = trackForLayer(getClipTimelineState(), layerId);
  if (!config?.supports(track?.layer)) return false;
  return setPropertyTrackEnabled(layerId, name, enabled, config.base);
}

function setScalarKey(layerId, frameIdx, value, name) {
  const config = SCALAR_PROPERTIES[name];
  const track = trackForLayer(getClipTimelineState(), layerId);
  if (!config?.supports(track?.layer)) return false;
  return setPropertyKey(layerId, Number(frameIdx), name, clampScalar(value, config));
}

function toggleScalarKey(layerId, frameIdx, name) {
  const tick = tickIndex(frameIdx);
  if (tick == null) return false;
  return hasScalarKey(layerId, tick, name)
    ? deletePropertyKeys(layerId, name, [tick]).length > 0
    : setScalarKey(layerId, tick, scalarAt(layerId, tick, name), name);
}

function scalarKeys(layerId, name) {
  const config = SCALAR_PROPERTIES[name];
  return propertyRecords(getClipTimelineState(), layerId, name)
    .map((record) => ({ frame: record.projectTick, value: clampScalar(record.key.value, config) }))
    .sort((a, b) => a.frame - b.frame);
}

function copyScalarKeys(layerId, ticks, name) {
  const config = SCALAR_PROPERTIES[name];
  const payload = copyPropertyKeys(layerId, name, ticks, config.payloadType,
    (value) => clampScalar(value, config));
  payload.keys = payload.keys.map(({ frame, value }) => ({ frame, value }));
  return payload;
}

function pasteScalarKeys(layerId, destination, payload, name) {
  const config = SCALAR_PROPERTIES[name];
  return pastePropertyKeys(
    layerId,
    name,
    destination,
    payload,
    config.payloadType,
    (value) => clampScalar(value, config),
  );
}

export const effectIntensityAt = (layerId, frame) => scalarAt(layerId, frame, 'effectIntensity');
export const isEffectIntensityTrackEnabled = (layerId) => scalarTrackEnabled(layerId, 'effectIntensity');
export const hasEffectIntensityKey = (layerId, frame) => hasScalarKey(layerId, frame, 'effectIntensity');
export const setEffectIntensityTrackEnabled = (layerId, enabled) =>
  setScalarTrackEnabled(layerId, enabled, 'effectIntensity');
export const setEffectIntensityKey = (layerId, frame, value) =>
  setScalarKey(layerId, frame, value, 'effectIntensity');
export const toggleEffectIntensityKey = (layerId, frame) =>
  toggleScalarKey(layerId, frame, 'effectIntensity');
export const effectIntensityKeys = (layerId) => scalarKeys(layerId, 'effectIntensity');
export const deleteEffectIntensityKeys = (layerId, ticks) =>
  deletePropertyKeys(layerId, 'effectIntensity', ticks);
export const moveEffectIntensityKeys = (layerId, ticks, delta) =>
  movePropertyKeys(layerId, 'effectIntensity', ticks, delta);
export const copyEffectIntensityKeys = (layerId, ticks) =>
  copyScalarKeys(layerId, ticks, 'effectIntensity');
export const pasteEffectIntensityKeys = (layerId, destination, payload) =>
  pasteScalarKeys(layerId, destination, payload, 'effectIntensity');

export const maskOpacityAt = (layerId, frame) => scalarAt(layerId, frame, 'maskOpacity');
export const isMaskOpacityTrackEnabled = (layerId) => scalarTrackEnabled(layerId, 'maskOpacity');
export const hasMaskOpacityKey = (layerId, frame) => hasScalarKey(layerId, frame, 'maskOpacity');
export const setMaskOpacityTrackEnabled = (layerId, enabled) =>
  setScalarTrackEnabled(layerId, enabled, 'maskOpacity');
export const setMaskOpacityKey = (layerId, frame, value) =>
  setScalarKey(layerId, frame, value, 'maskOpacity');
export const toggleMaskOpacityKey = (layerId, frame) =>
  toggleScalarKey(layerId, frame, 'maskOpacity');
export const maskOpacityKeys = (layerId) => scalarKeys(layerId, 'maskOpacity');
export const deleteMaskOpacityKeys = (layerId, ticks) =>
  deletePropertyKeys(layerId, 'maskOpacity', ticks);
export const moveMaskOpacityKeys = (layerId, ticks, delta) =>
  movePropertyKeys(layerId, 'maskOpacity', ticks, delta);
export const copyMaskOpacityKeys = (layerId, ticks) =>
  copyScalarKeys(layerId, ticks, 'maskOpacity');
export const pasteMaskOpacityKeys = (layerId, destination, payload) =>
  pasteScalarKeys(layerId, destination, payload, 'maskOpacity');

function supportsMaskPosition(layer) {
  return layer?.type === 'effect' && !!layer.mask;
}

export function maskPositionAt(layerId, frameValue) {
  const tick = tickIndex(frameValue);
  const track = trackForLayer(getClipTimelineState(), layerId);
  if (tick == null || !supportsMaskPosition(track?.layer)) return { x: 0, y: 0 };
  return roundedPosition(propertyAt(layerId, 'maskPosition', tick, track.layer.mask.offset));
}

export function isMaskPositionTrackEnabled(layerId) {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  return supportsMaskPosition(track?.layer) && propertyEnabled(state, track, 'maskPosition');
}

export function setMaskPositionTrackEnabled(layerId, enabled) {
  const track = trackForLayer(getClipTimelineState(), layerId);
  if (!supportsMaskPosition(track?.layer)) return false;
  return setPropertyTrackEnabled(layerId, 'maskPosition', enabled,
    (layer) => layer.mask?.offset || { x: 0, y: 0 });
}

export function setMaskPositionById(frameValue, layerId, offset) {
  if (!isMaskPositionTrackEnabled(layerId)) return false;
  return setPropertyKey(layerId, Number(frameValue), 'maskPosition', roundedPosition(offset));
}

export function hasMaskPositionKey(layerId, frameValue) {
  const tick = Number(frameValue);
  return propertyRecords(getClipTimelineState(), layerId, 'maskPosition')
    .some((record) => record.projectTick === tick);
}

export function toggleMaskPositionKey(layerId, frameValue) {
  const tick = tickIndex(frameValue);
  if (tick == null) return false;
  return hasMaskPositionKey(layerId, tick)
    ? deletePropertyKeys(layerId, 'maskPosition', [tick]).length > 0
    : setPropertyKey(layerId, tick, 'maskPosition', maskPositionAt(layerId, tick));
}

export function clearMaskPositionKeys(layerId) {
  return setMaskPositionTrackEnabled(layerId, false);
}

export function maskPositionKeys(layerId) {
  return propertyRecords(getClipTimelineState(), layerId, 'maskPosition')
    .map((record) => ({
      frame: record.projectTick,
      ...roundedPosition(record.key.value),
      interpolation: validInterpolation(record.key.value?.interpolation),
      ...(normalizeTemporalEase(record.key.value?.temporalEase)
        ? { temporalEase: normalizeTemporalEase(record.key.value.temporalEase) }
        : {}),
    })).sort((a, b) => a.frame - b.frame);
}

export const deleteMaskPositionKeys = (layerId, ticks) =>
  deletePropertyKeys(layerId, 'maskPosition', ticks);
export const moveMaskPositionKeys = (layerId, ticks, delta) =>
  movePropertyKeys(layerId, 'maskPosition', ticks, delta);

export function copyMaskPositionKeys(layerId, ticks) {
  const payload = copyPropertyKeys(layerId, 'maskPosition', ticks, 'mask-position');
  payload.keys = payload.keys.map(({ frame, value }) => ({ frame, ...cloneDurable(value) }));
  return payload;
}

export function pasteMaskPositionKeys(layerId, destination, payload) {
  const normalized = payload?.type === 'mask-position'
    ? {
      ...payload,
      keys: (payload.keys || []).map((key) => ({
        frame: key.frame,
        value: {
          x: integer(key.x),
          y: integer(key.y),
          interpolation: validInterpolation(key.interpolation),
          ...(normalizeTemporalEase(key.temporalEase)
            ? { temporalEase: normalizeTemporalEase(key.temporalEase) }
            : {}),
        },
      })),
    }
    : payload;
  return pastePropertyKeys(layerId, 'maskPosition', destination, normalized, 'mask-position');
}

export function setMaskPositionKeyInterpolation(layerId, ticks, interpolation) {
  const preset = validInterpolation(interpolation);
  return editPropertyKeyMetadata(layerId, 'maskPosition', ticks, (value) => ({
    ...value,
    interpolation: preset,
  }));
}

export function setMaskPositionKeyTemporalEase(layerId, ticks, side, handle) {
  if ((side !== 'in' && side !== 'out') ||
    (handle != null && !normalizeTemporalHandle(handle))) return [];
  return setPropertyTemporalEase(layerId, 'maskPosition', ticks, { [side]: handle });
}

export function setMaskPositionKeyTemporalPreset(layerId, ticks, preset) {
  return setPropertyTemporalEase(layerId, 'maskPosition', ticks, temporalPresetEdits(preset));
}

function shapePathEntryIsEnvelope(value) {
  return !!value && typeof value === 'object' &&
    (Object.prototype.hasOwnProperty.call(value, 'path') ||
      Object.prototype.hasOwnProperty.call(value, 'components'));
}

function shapePathEntryPath(value) {
  return shapePathEntryIsEnvelope(value) ? value.path : value;
}

function shapePathEntryComponents(value) {
  return shapePathEntryIsEnvelope(value) && value.components &&
    typeof value.components === 'object' && !Array.isArray(value.components)
    ? value.components
    : {};
}

function shapePathEntry(path, components = {}) {
  const componentEntries = Object.entries(components).filter(([, value]) => value != null);
  if (!componentEntries.length) return path || null;
  return {
    ...(path ? { path } : {}),
    components: Object.fromEntries(componentEntries),
  };
}

function shapePathMotionKey(value, expectedKind = null) {
  const path = normalizeShapePathKey(value, expectedKind || undefined);
  if (!path) return null;
  const temporalEase = normalizeTemporalEase(value?.temporalEase);
  return {
    ...path,
    interpolation: validInterpolation(value?.interpolation),
    ...(temporalEase ? { temporalEase } : {}),
  };
}

function componentMotionKey(componentId, value) {
  const raw = componentId === SHAPE_PATH_COMPONENT_ROTATION
    ? (typeof value === 'number' ? value : value?.value)
    : value;
  const normalized = normalizeShapePathComponentValue(componentId, raw);
  if (normalized == null) return null;
  const temporalEase = normalizeTemporalEase(value?.temporalEase);
  return {
    ...(componentId === SHAPE_PATH_COMPONENT_ROTATION
      ? { value: normalized }
      : normalized),
    interpolation: validInterpolation(value?.interpolation),
    ...(temporalEase ? { temporalEase } : {}),
  };
}

function componentMotionValue(componentId, value) {
  return normalizeShapePathComponentValue(
    componentId,
    componentId === SHAPE_PATH_COMPONENT_ROTATION ? value?.value : value,
  );
}

function withAnchorCompensation(path, offset) {
  if (!path || !offset || (!offset.x && !offset.y)) return path;
  if (path.kind === 'polygon') {
    return normalizeShapePathKey({
      ...path,
      vertices: path.vertices.map((point) => ({
        x: point.x + offset.x,
        y: point.y + offset.y,
      })),
    }, path.kind);
  }
  if (path.kind === 'line') {
    return normalizeShapePathKey({
      ...path,
      x0: path.x0 + offset.x,
      y0: path.y0 + offset.y,
      x1: path.x1 + offset.x,
      y1: path.y1 + offset.y,
      ...(path.vertices ? {
        vertices: path.vertices.map((point) => ({
          x: point.x + offset.x,
          y: point.y + offset.y,
        })),
      } : {}),
    }, path.kind);
  }
  return normalizeShapePathKey({
    ...path,
    cx: path.cx + offset.x,
    cy: path.cy + offset.y,
    ...(path.vertices ? {
      vertices: path.vertices.map((point) => ({
        x: point.x + offset.x,
        y: point.y + offset.y,
      })),
    } : {}),
  }, path.kind);
}

function pathForStateAt(state, layerId, tick) {
  const track = trackForLayer(state, layerId);
  const clip = track && clipAtTick(state, track.id, tick);
  if (!clip) return pathValueFromShape(resolvedLayer(state, layerId, tick)?.shape);
  const sourceTick = sourceTickAt(clip, tick);
  let frameKey = null;
  for (const key of clip.frameKeys || []) {
    if (key.tick > sourceTick) break;
    frameKey = key;
  }
  const fallback = pathValueFromShape(frameKey?.value?.shape || track.layer?.shape);
  let path = resolveClipPropertyAtTick(clip, 'shapePath', tick, fallback);
  const compensation = resolveClipPropertyAtTick(
    clip,
    SHAPE_ANCHOR_COMPENSATION,
    tick,
    { x: 0, y: 0 },
  );
  if (path && (compensation?.x || compensation?.y)) {
    path = withAnchorCompensation(path, compensation);
  }
  return path;
}

function pathForLayerAt(layerId, tick) {
  return pathForStateAt(getClipTimelineState(), layerId, tick);
}

function shapeKindsForTrack(state, track) {
  const kinds = new Set();
  for (const clip of clipsForTrack(state, track.id)) {
    for (const key of clip.frameKeys || []) {
      const kind = pathValueFromShape(key.value?.shape)?.kind;
      if (kind) kinds.add(kind);
    }
    for (const key of clip.propertyTracks?.shapePath || []) {
      const kind = normalizeShapePathKey(shapePathEntryPath(key.value))?.kind;
      if (kind) kinds.add(kind);
    }
  }
  return kinds;
}

function polygonCountsForTrack(state, track) {
  const counts = new Set();
  for (const clip of clipsForTrack(state, track.id)) {
    for (const key of clip.frameKeys || []) {
      const path = pathValueFromShape(key.value?.shape);
      if (path?.kind === 'polygon') counts.add(path.vertices.length);
    }
    for (const key of clip.propertyTracks?.shapePath || []) {
      const path = normalizeShapePathKey(shapePathEntryPath(key.value));
      if (path?.kind === 'polygon') counts.add(path.vertices.length);
    }
  }
  return counts;
}

export function canAnimateShapePath(layerId) {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  if (track?.layer?.type !== 'shape') return false;
  const path = pathForLayerAt(layerId, get(canonicalPlayheadTick));
  if (!path || !SHAPE_PATH_KINDS.has(path.kind)) return false;
  const kinds = shapeKindsForTrack(state, track);
  return kinds.size <= 1 && (path.kind !== 'polygon' || polygonCountsForTrack(state, track).size <= 1);
}

export function shapePathAt(layerId, frameValue) {
  const tick = tickIndex(frameValue);
  const path = tick == null ? null : pathForLayerAt(layerId, tick);
  return path ? cloneDurable(path) : null;
}

export function shapePathComponentAt(layerId, componentId, frameValue) {
  const path = shapePathAt(layerId, frameValue);
  const component = normalizeShapePathComponentId(componentId, path);
  return component ? shapePathComponentValue(path, component) : null;
}

function shapePathRecords(state, layerId) {
  return propertyRecords(state, layerId, 'shapePath');
}

function shapePathComponentRecords(state, layerId, componentId) {
  return shapePathRecords(state, layerId).flatMap((record) => {
    const key = shapePathEntryComponents(record.key.value)[componentId];
    return key == null ? [] : [{ ...record, componentKey: key }];
  });
}

export function isShapePathTrackEnabled(layerId) {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  return canAnimateShapePath(layerId) && (
    shapePathRecords(state, layerId).length > 0 ||
    (track?.shapePathComponents || []).length > 0
  );
}

export function isShapePathWholeTrackEnabled(layerId) {
  return shapePathRecords(getClipTimelineState(), layerId)
    .some((record) => !!shapePathEntryPath(record.key.value));
}

export function hasShapePathWholeKey(layerId, frameValue) {
  const tick = Number(frameValue);
  return shapePathRecords(getClipTimelineState(), layerId).some((record) =>
    record.projectTick === tick && !!shapePathEntryPath(record.key.value));
}

export function hasShapePathKey(layerId, frameValue) {
  return hasShapePathWholeKey(layerId, frameValue);
}

function mutateShapeEntry(layerId, tick, operation, callback, create = true, finalize = null) {
  const projectTick = tickIndex(tick);
  if (projectTick == null || !canAnimateShapePath(layerId)) return false;
  checkpointHistory();
  const result = transactClipTimeline(operation, (state, context) => {
    const target = propertyContext(state, layerId, projectTick, context.makeId, create);
    if (!target?.owner) return false;
    const keys = [...(target.owner.propertyTracks?.shapePath || [])];
    const index = keys.findIndex((key) => key.tick === target.sourceTick);
    const prior = index >= 0 ? cloneDurable(keys[index].value) : null;
    const next = callback(prior, state, target);
    if (sameValue(prior, next)) return false;
    target.owner.propertyTracks = { ...(target.owner.propertyTracks || {}) };
    if (next == null) {
      if (index < 0) return false;
      keys.splice(index, 1);
    } else if (index >= 0) keys[index] = { ...keys[index], value: next };
    else keys.push({ tick: target.sourceTick, value: next });
    keys.sort((a, b) => a.tick - b.tick);
    if (keys.length) target.owner.propertyTracks.shapePath = keys;
    else delete target.owner.propertyTracks.shapePath;
    finalize?.(state, target);
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return !!result.changed;
}

function setFrameShape(layerId, tick, path) {
  const projectTick = tickIndex(tick);
  if (projectTick == null) return false;
  checkpointHistory();
  const result = transactClipTimeline('set-static-shape-path', (state, context) => {
    const track = trackForLayer(state, layerId);
    if (!track) return false;
    const live = get(layers).find((layer) => layer.id === layerId) ||
      resolvedLayer(state, layerId, projectTick) || track.layer;
    const clip = ensureClipForTick(state, track, live, projectTick, context.makeId);
    if (!clip) return false;
    const sourceTick = sourceTickAt(clip, projectTick);
    let payload = cloneDurable((clip.frameKeys || []).filter((key) => key.tick <= sourceTick).at(-1)?.value)
      || framePayload(live);
    const shape = payload.shape || live.shape;
    payload = {
      ...payload,
      shape: shape ? shapeWithPathValue(shape, path) : null,
    };
    payload.cells = payload.shape ? renderShapeToCells(payload.shape) : {};
    const updated = upsertKey(clip.frameKeys, sourceTick, payload);
    if (!updated.changed) return false;
    clip.frameKeys = updated.keys;
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return !!result.changed;
}

export function setShapePathById(frameValue, layerId, value) {
  const tick = tickIndex(frameValue);
  const current = tick == null ? null : shapePathAt(layerId, tick);
  const normalized = normalizeShapePathKey(value, current?.kind);
  if (!normalized || shapePathEqual(current, normalized)) return false;
  if (!isShapePathTrackEnabled(layerId)) return setFrameShape(layerId, tick, normalized);
  return mutateShapeEntry(layerId, tick, 'set-shape-path-key', (entry) => {
    const prior = shapePathEntryPath(entry);
    const key = shapePathMotionKey({ ...(prior || {}), ...normalized }, normalized.kind);
    return shapePathEntry(key, shapePathEntryComponents(entry));
  });
}

export function setShapePathWholeTrackEnabled(layerId, enabled) {
  const next = !!enabled;
  if (!canAnimateShapePath(layerId) || isShapePathWholeTrackEnabled(layerId) === next) return false;
  const tick = get(canonicalPlayheadTick);
  const path = shapePathAt(layerId, tick);
  if (!path) return false;
  if (next) {
    const changed = mutateShapeEntry(layerId, tick, 'enable-shape-path', (entry) =>
      shapePathEntry(shapePathMotionKey(path, path.kind), shapePathEntryComponents(entry)));
    if (changed) {
      transactClipTimeline('record-shape-path-kind', (state) => {
        const track = trackForLayer(state, layerId);
        if (!track) return false;
        track.shapePathKind = path.kind;
        return { state, changed: true };
      });
    }
    return changed;
  }

  checkpointHistory();
  const result = transactClipTimeline('disable-shape-path', (state) => {
    const track = trackForLayer(state, layerId);
    if (!track) return false;
    for (const clip of clipsForTrack(state, track.id)) {
      clip.frameKeys = clip.frameKeys.map((key) => {
        const shape = key.value?.shape;
        if (!shape) return key;
        return {
          ...key,
          value: {
            ...key.value,
            shape: shapeWithPathValue(shape, path),
            cells: renderShapeToCells(shapeWithPathValue(shape, path)),
          },
        };
      });
      const keys = clip.propertyTracks?.shapePath;
      if (!keys) continue;
      clip.propertyTracks = { ...clip.propertyTracks };
      clip.propertyTracks.shapePath = keys.flatMap((key) => {
        const value = shapePathEntry(null, shapePathEntryComponents(key.value));
        return value ? [{ ...key, value }] : [];
      });
      if (!clip.propertyTracks.shapePath.length) delete clip.propertyTracks.shapePath;
    }
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick(tick);
  return !!result.changed;
}

export function setShapePathTrackEnabled(layerId, enabled) {
  const next = !!enabled;
  if (isShapePathTrackEnabled(layerId) === next) return false;
  if (next) return setShapePathWholeTrackEnabled(layerId, true);
  const tick = get(canonicalPlayheadTick);
  const path = shapePathAt(layerId, tick);
  if (!path) return false;
  checkpointHistory();
  const result = transactClipTimeline('disable-all-shape-animation', (state) => {
    const track = trackForLayer(state, layerId);
    if (!track) return false;
    for (const clip of clipsForTrack(state, track.id)) {
      clip.frameKeys = clip.frameKeys.map((key) => {
        const shape = key.value?.shape;
        if (!shape) return key;
        const baked = shapeWithPathValue(shape, path);
        return { ...key, value: { ...key.value, shape: baked, cells: renderShapeToCells(baked) } };
      });
      if (clip.propertyTracks?.shapePath) {
        clip.propertyTracks = { ...clip.propertyTracks };
        delete clip.propertyTracks.shapePath;
      }
    }
    track.shapePathComponents = [];
    delete track.shapePathKind;
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick(tick);
  return !!result.changed;
}

export function toggleShapePathWholeKey(layerId, frameValue) {
  const tick = tickIndex(frameValue);
  if (tick == null) return false;
  if (hasShapePathWholeKey(layerId, tick)) {
    return mutateShapeEntry(layerId, tick, 'delete-shape-path-key', (entry) =>
      shapePathEntry(null, shapePathEntryComponents(entry)), false);
  }
  const path = shapePathAt(layerId, tick);
  return path ? mutateShapeEntry(layerId, tick, 'add-shape-path-key', (entry) =>
    shapePathEntry(shapePathMotionKey(path, path.kind), shapePathEntryComponents(entry)), true,
  (state) => {
    const track = trackForLayer(state, layerId);
    if (track) track.shapePathKind = path.kind;
  }) : false;
}

export const toggleShapePathKey = toggleShapePathWholeKey;

export function shapePathWholeKeys(layerId) {
  return shapePathRecords(getClipTimelineState(), layerId).flatMap((record) => {
    const path = shapePathMotionKey(shapePathEntryPath(record.key.value));
    return path ? [{ frame: record.projectTick, ...path }] : [];
  }).sort((a, b) => a.frame - b.frame);
}

export const shapePathKeys = shapePathWholeKeys;

export function deleteShapePathWholeKeys(layerId, ticks) {
  const requested = new Set([...(ticks || [])].map(Number));
  const selected = shapePathRecords(getClipTimelineState(), layerId)
    .filter((record) => requested.has(record.projectTick) && shapePathEntryPath(record.key.value));
  if (!selected.length) return [];
  const changed = selected.map((record) => mutateShapeEntry(
    layerId,
    record.projectTick,
    'delete-shape-path-key',
    (entry) => shapePathEntry(null, shapePathEntryComponents(entry)),
    false,
  ));
  return changed.some(Boolean) ? selected.map((record) => record.projectTick) : [];
}

export const deleteShapePathKeys = deleteShapePathWholeKeys;

function moveShapeSubset(layerId, ticks, delta, componentId = null) {
  const state = getClipTimelineState();
  const requested = new Set([...(ticks || [])].map(Number));
  const records = componentId
    ? shapePathComponentRecords(state, layerId, componentId)
    : shapePathRecords(state, layerId).filter((record) => shapePathEntryPath(record.key.value));
  const selected = records.filter((record) => requested.has(record.projectTick));
  const shift = integer(delta);
  if (!selected.length || !shift || selected.some((record) =>
    record.projectTick + shift < 0 ||
    (record.clip && !clipContainsTick(record.clip, record.projectTick + shift)))) return [];
  checkpointHistory();
  const identities = new Map(selected.map((record) => [
    `${record.owner.id}\u0000${record.sourceTick}`,
    record.sourceTick + shift,
  ]));
  const result = transactClipTimeline('move-shape-keys', (draft) => {
    for (const owner of [...draft.tracks, ...draft.clips]) {
      const keys = owner.propertyTracks?.shapePath;
      if (!keys) continue;
      if (!componentId) {
        const moved = keys.map((key) => ({
          ...key,
          tick: identities.get(`${owner.id}\u0000${key.tick}`) ?? key.tick,
        })).sort((a, b) => a.tick - b.tick);
        if (new Set(moved.map((key) => key.tick)).size !== moved.length) return false;
        owner.propertyTracks.shapePath = moved;
        continue;
      }
      const extracted = [];
      owner.propertyTracks.shapePath = keys.flatMap((key) => {
        const destination = identities.get(`${owner.id}\u0000${key.tick}`);
        const components = { ...shapePathEntryComponents(key.value) };
        if (destination == null || components[componentId] == null) return [key];
        extracted.push({ tick: destination, value: components[componentId] });
        delete components[componentId];
        const value = shapePathEntry(shapePathEntryPath(key.value), components);
        return value ? [{ ...key, value }] : [];
      });
      for (const moved of extracted) {
        const index = owner.propertyTracks.shapePath.findIndex((key) => key.tick === moved.tick);
        const prior = index >= 0 ? owner.propertyTracks.shapePath[index] : { tick: moved.tick, value: null };
        const value = shapePathEntry(shapePathEntryPath(prior.value), {
          ...shapePathEntryComponents(prior.value),
          [componentId]: moved.value,
        });
        if (index >= 0) owner.propertyTracks.shapePath[index] = { ...prior, value };
        else owner.propertyTracks.shapePath.push({ tick: moved.tick, value });
      }
      owner.propertyTracks.shapePath.sort((a, b) => a.tick - b.tick);
    }
    return { state: draft, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return result.changed
    ? selected.map((record) => record.projectTick + shift).sort((a, b) => a - b)
    : [];
}

export const moveShapePathWholeKeys = (layerId, ticks, delta) =>
  moveShapeSubset(layerId, ticks, delta);
export const moveShapePathKeys = moveShapePathWholeKeys;

function shapePathPayload(layerId, ticks, componentId = null) {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  const requested = new Set([...(ticks || [])].map(Number));
  const records = (componentId
    ? shapePathComponentRecords(state, layerId, componentId)
    : shapePathRecords(state, layerId).filter((record) => shapePathEntryPath(record.key.value)))
    .filter((record) => requested.has(record.projectTick))
    .sort((a, b) => a.projectTick - b.projectTick);
  const origin = records[0]?.projectTick || 0;
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  return {
    type: componentId ? 'shape-path-component' : 'shape-path',
    ...(componentId ? { componentId } : {}),
    shapeKind: path?.kind || track?.shapePathKind || null,
    ...(path?.kind === 'polygon' ? { vertexCount: path.vertices.length } : {}),
    origin,
    keys: records.map((record) => ({
      frame: record.projectTick - origin,
      ...(componentId
        ? cloneDurable(record.componentKey)
        : cloneDurable(shapePathEntryPath(record.key.value))),
    })),
  };
}

export const copyShapePathWholeKeys = (layerId, ticks) => shapePathPayload(layerId, ticks);
export const copyShapePathKeys = copyShapePathWholeKeys;

function pasteShapeKeys(layerId, componentId, destination, payload) {
  const start = integer(destination, -1);
  const path = shapePathAt(layerId, Math.max(0, start));
  const expectedType = componentId ? 'shape-path-component' : 'shape-path';
  if (!path || start < 0 || payload?.type !== expectedType || payload.shapeKind !== path.kind ||
    (path?.kind === 'polygon' && payload.vertexCount !== path.vertices.length) ||
    !Array.isArray(payload.keys)) return [];
  const changed = [];
  for (const key of payload.keys) {
    const tick = start + integer(key.frame);
    if (tickIndex(tick) == null) continue;
    const success = componentId
      ? mutateShapeEntry(layerId, tick, 'paste-shape-component-key', (entry) => {
        const components = { ...shapePathEntryComponents(entry) };
        const motion = componentMotionKey(componentId, key);
        if (!motion) return entry;
        components[componentId] = motion;
        return shapePathEntry(shapePathEntryPath(entry), components);
      })
      : mutateShapeEntry(layerId, tick, 'paste-shape-path-key', (entry) => {
        const motion = shapePathMotionKey(key, path.kind);
        return motion ? shapePathEntry(motion, shapePathEntryComponents(entry)) : entry;
      });
    if (success) changed.push(tick);
  }
  return [...new Set(changed)].sort((a, b) => a - b);
}

export const pasteShapePathWholeKeys = (layerId, destination, payload) =>
  pasteShapeKeys(layerId, null, destination, payload);
export const pasteShapePathKeys = pasteShapePathWholeKeys;

function editShapePathMetadata(layerId, ticks, componentId, edit) {
  const requested = new Set([...(ticks || [])].map(Number));
  const records = (componentId
    ? shapePathComponentRecords(getClipTimelineState(), layerId, componentId)
    : shapePathRecords(getClipTimelineState(), layerId).filter((record) =>
      shapePathEntryPath(record.key.value)))
    .filter((record) => requested.has(record.projectTick));
  const changed = [];
  for (const record of records) {
    if (mutateShapeEntry(layerId, record.projectTick, 'edit-shape-key-metadata', (entry) => {
      if (componentId) {
        const components = { ...shapePathEntryComponents(entry) };
        components[componentId] = edit(components[componentId]);
        return shapePathEntry(shapePathEntryPath(entry), components);
      }
      return shapePathEntry(edit(shapePathEntryPath(entry)), shapePathEntryComponents(entry));
    }, false)) changed.push(record.projectTick);
  }
  return changed;
}

export function setShapePathWholeKeyInterpolation(layerId, ticks, interpolation) {
  const preset = validInterpolation(interpolation);
  return editShapePathMetadata(layerId, ticks, null, (key) => ({ ...key, interpolation: preset }));
}

export const setShapePathKeyInterpolation = setShapePathWholeKeyInterpolation;

function setShapeTemporalEase(layerId, ticks, componentId, edits) {
  if (!edits) return [];
  return editShapePathMetadata(layerId, ticks, componentId, (value) => {
    let next = value;
    for (const [side, handle] of Object.entries(edits)) next = withTemporalEaseSide(next, side, handle);
    return next;
  });
}

export function setShapePathWholeKeyTemporalEase(layerId, ticks, side, handle) {
  if ((side !== 'in' && side !== 'out') ||
    (handle != null && !normalizeTemporalHandle(handle))) return [];
  return setShapeTemporalEase(layerId, ticks, null, { [side]: handle });
}

export const setShapePathKeyTemporalEase = setShapePathWholeKeyTemporalEase;

export function setShapePathWholeKeyTemporalPreset(layerId, ticks, preset) {
  return setShapeTemporalEase(layerId, ticks, null, temporalPresetEdits(preset));
}

export const setShapePathKeyTemporalPreset = setShapePathWholeKeyTemporalPreset;

export function isShapePathComponentEnabled(layerId, componentId) {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  return !!component && (track?.shapePathComponents || []).includes(component);
}

export function hasShapePathComponentKey(layerId, componentId, frameValue) {
  const path = shapePathAt(layerId, frameValue);
  const component = normalizeShapePathComponentId(componentId, path);
  const tick = Number(frameValue);
  return !!component && shapePathComponentRecords(getClipTimelineState(), layerId, component)
    .some((record) => record.projectTick === tick);
}

export function shapePathComponentKeys(layerId, componentId) {
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  if (!component) return [];
  return shapePathComponentRecords(getClipTimelineState(), layerId, component)
    .map((record) => ({
      frame: record.projectTick,
      value: componentMotionValue(component, record.componentKey),
      interpolation: validInterpolation(record.componentKey?.interpolation),
      ...(normalizeTemporalEase(record.componentKey?.temporalEase)
        ? { temporalEase: normalizeTemporalEase(record.componentKey.temporalEase) }
        : {}),
    })).sort((a, b) => a.frame - b.frame);
}

export function shapePathAnimationComponents(layerId, frameValue = get(canonicalPlayheadTick)) {
  const path = shapePathAt(layerId, frameValue);
  if (!path) return [];
  return enumerateShapePathComponents(path).map((component) => ({
    ...component,
    value: shapePathComponentValue(path, component.id),
    enabled: isShapePathComponentEnabled(layerId, component.id),
    keyed: hasShapePathComponentKey(layerId, component.id, frameValue),
  }));
}

function bakeComponentIntoPayloads(state, track, componentId, value) {
  for (const clip of clipsForTrack(state, track.id)) {
    clip.frameKeys = clip.frameKeys.map((key) => {
      const shape = key.value?.shape;
      const path = pathValueFromShape(shape);
      const bakedPath = path && withShapePathComponentValue(path, componentId, value);
      if (!shape || !bakedPath) return key;
      const baked = shapeWithPathValue(shape, bakedPath);
      return { ...key, value: { ...key.value, shape: baked, cells: renderShapeToCells(baked) } };
    });
    const keys = clip.propertyTracks?.shapePath;
    if (!keys) continue;
    clip.propertyTracks.shapePath = keys.flatMap((key) => {
      const path = shapePathEntryPath(key.value);
      const bakedPath = path && withShapePathComponentValue(path, componentId, value);
      const components = { ...shapePathEntryComponents(key.value) };
      delete components[componentId];
      const entry = shapePathEntry(bakedPath || path, components);
      return entry ? [{ ...key, value: entry }] : [];
    });
  }
}

export function setShapePathComponentTrackEnabled(layerId, componentId, enabled) {
  const tick = get(canonicalPlayheadTick);
  const path = shapePathAt(layerId, tick);
  const component = normalizeShapePathComponentId(componentId, path);
  if (!component) return false;
  const current = isShapePathComponentEnabled(layerId, component);
  const next = !!enabled;
  if (current === next) return false;
  const value = shapePathComponentValue(path, component);
  const baseline = getClipTimelineState();
  const shouldMaterialize = shapePathRecords(baseline, layerId).length > 0;
  const baselineTrack = trackForLayer(baseline, layerId);
  const hasCompensation = clipsForTrack(baseline, baselineTrack?.id)
    .some((clip) => clip.propertyTracks?.[SHAPE_ANCHOR_COMPENSATION]?.length);
  checkpointHistory();
  const result = transactClipTimeline(`${next ? 'enable' : 'disable'}-shape-component`, (state, context) => {
    const track = trackForLayer(state, layerId);
    if (!track) return false;
    track.shapePathKind = path.kind;
    if (next) {
      track.shapePathComponents = [...new Set([...(track.shapePathComponents || []), component])];
      if (shouldMaterialize) {
        if (hasCompensation && component.startsWith('vertex:')) {
          materializeCompensatedVertices(state, baseline, layerId);
        } else {
          materializeShapeComponent(state, baseline, layerId, component);
        }
      }
      const target = propertyContext(state, layerId, tick, context.makeId, true);
      if (!target?.owner) return false;
      const keys = [...(target.owner.propertyTracks?.shapePath || [])];
      const index = keys.findIndex((key) => key.tick === target.sourceTick);
      const prior = index >= 0 ? keys[index].value : null;
      const entry = shapePathEntry(shapePathEntryPath(prior), {
        ...shapePathEntryComponents(prior),
        [component]: componentMotionKey(component, value),
      });
      if (index >= 0) keys[index] = { ...keys[index], value: entry };
      else keys.push({ tick: target.sourceTick, value: entry });
      keys.sort((a, b) => a.tick - b.tick);
      target.owner.propertyTracks = {
        ...(target.owner.propertyTracks || {}),
        shapePath: keys,
      };
    } else {
      bakeComponentIntoPayloads(state, track, component, value);
      track.shapePathComponents = (track.shapePathComponents || [])
        .filter((candidate) => candidate !== component);
      if (!track.shapePathComponents.length && !shapePathRecords(state, layerId)
        .some((record) => shapePathEntryPath(record.key.value))) delete track.shapePathKind;
    }
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick(tick);
  return !!result.changed;
}

export function toggleShapePathComponentKey(layerId, componentId, frameValue) {
  const tick = tickIndex(frameValue);
  const path = tick == null ? null : shapePathAt(layerId, tick);
  const component = normalizeShapePathComponentId(componentId, path);
  if (!component || !isShapePathComponentEnabled(layerId, component)) return false;
  const owns = hasShapePathComponentKey(layerId, component, tick);
  return mutateShapeEntry(layerId, tick, 'toggle-shape-component-key', (entry) => {
    const components = { ...shapePathEntryComponents(entry) };
    if (owns) delete components[component];
    else components[component] = componentMotionKey(
      component,
      shapePathComponentValue(path, component),
    );
    return shapePathEntry(shapePathEntryPath(entry), components);
  }, !owns) ? !owns : false;
}

function sparsePointSamples(samples) {
  if (!samples.length) return [];
  if (samples.length === 1) return [{ tick: 0, value: samples[0] }];
  const retained = new Set([0, samples.length - 1]);
  const segments = [[0, samples.length - 1]];
  while (segments.length) {
    const [start, end] = segments.pop();
    if (end <= start + 1) continue;
    const first = samples[start];
    const last = samples[end];
    let split = -1;
    let error = 1e-9;
    for (let tick = start + 1; tick < end; tick++) {
      const progress = (tick - start) / (end - start);
      const expected = {
        x: first.x + (last.x - first.x) * progress,
        y: first.y + (last.y - first.y) * progress,
      };
      const difference = Math.abs(samples[tick].x - expected.x) +
        Math.abs(samples[tick].y - expected.y);
      if (difference > error) {
        error = difference;
        split = tick;
      }
    }
    if (split < 0) continue;
    retained.add(split);
    segments.push([start, split], [split, end]);
  }
  return [...retained].sort((a, b) => a - b).map((tick) => ({
    tick,
    value: { ...samples[tick], interpolation: 'linear' },
  }));
}

function sparseScalarSamples(samples) {
  return sparsePointSamples(samples.map((value) => ({ x: Number(value) || 0, y: 0 })))
    .map((key) => ({ tick: key.tick, value: key.value.x }));
}

function materializeShapeComponent(state, baselineState, layerId, componentId) {
  const track = trackForLayer(state, layerId);
  if (!track) return;
  for (const clip of clipsForTrack(state, track.id)) {
    const values = Array.from({ length: clipDuration(clip) }, (_, offset) => {
      const path = pathForStateAt(baselineState, layerId, clip.startTick + offset);
      return shapePathComponentValue(path, componentId);
    });
    const sampled = componentId === SHAPE_PATH_COMPONENT_ROTATION
      ? sparseScalarSamples(values)
      : sparsePointSamples(values);
    clip.propertyTracks = { ...(clip.propertyTracks || {}) };
    const keys = [...(clip.propertyTracks.shapePath || [])];
    for (const sample of sampled) {
      const sourceTick = clip.inTick + sample.tick;
      const index = keys.findIndex((key) => key.tick === sourceTick);
      const prior = index >= 0 ? keys[index] : { tick: sourceTick, value: null };
      const value = shapePathEntry(shapePathEntryPath(prior.value), {
        ...shapePathEntryComponents(prior.value),
        [componentId]: componentMotionKey(componentId, sample.value),
      });
      if (index >= 0) keys[index] = { ...prior, value };
      else keys.push({ tick: sourceTick, value });
    }
    keys.sort((first, second) => first.tick - second.tick);
    clip.propertyTracks.shapePath = keys;
  }
}

function materializeCompensatedVertices(state, baselineState, layerId) {
  const path = pathForStateAt(baselineState, layerId, 0) ||
    pathForStateAt(baselineState, layerId, get(canonicalPlayheadTick));
  for (const component of enumerateShapePathComponents(path || {})) {
    if (component.type === 'vertex') {
      materializeShapeComponent(state, baselineState, layerId, component.id);
    }
  }
  const track = trackForLayer(state, layerId);
  if (!track) return;
  for (const clip of clipsForTrack(state, track.id)) {
    if (!clip.propertyTracks?.[SHAPE_ANCHOR_COMPENSATION]) continue;
    clip.propertyTracks = { ...clip.propertyTracks };
    delete clip.propertyTracks[SHAPE_ANCHOR_COMPENSATION];
  }
}

// Moving an animated pivot must not move rendered vertices, so a sparse hidden track
// records the geometry delta needed to preserve the baseline image.
function applyAnchorCompensation(state, baselineState, layerId) {
  const track = trackForLayer(state, layerId);
  if (!track) return;
  for (const clip of clipsForTrack(state, track.id)) {
    const samples = [];
    for (let offset = 0; offset < clipDuration(clip); offset++) {
      const tick = clip.startTick + offset;
      const baselinePath = pathForStateAt(baselineState, layerId, tick);
      const previewPath = pathForStateAt(state, layerId, tick);
      const anchor = shapePathComponentValue(previewPath, SHAPE_PATH_COMPONENT_ANCHOR);
      const baselineTrack = trackForLayer(baselineState, layerId);
      const baselineClip = baselineTrack && clipAtTick(baselineState, baselineTrack.id, tick);
      const baselineSourceTick = baselineClip && sourceTickAt(baselineClip, tick);
      let baselineFrameKey = null;
      for (const key of baselineClip?.frameKeys || []) {
        if (key.tick > baselineSourceTick) break;
        baselineFrameKey = key;
      }
      const appearance = baselineFrameKey?.value?.shape || baselineTrack?.layer?.shape;
      const compensated = appearance && baselinePath && previewPath && anchor
        ? pathValueFromShape(shapeForAnchorComponentEdit(appearance, baselinePath, anchor))
        : null;
      const previewVertex = shapePathVertices(previewPath || {})[0];
      const compensatedVertex = shapePathVertices(compensated || {})[0];
      const existing = baselineClip
        ? resolveClipPropertyAtTick(
          baselineClip,
          SHAPE_ANCHOR_COMPENSATION,
          tick,
          { x: 0, y: 0 },
        )
        : { x: 0, y: 0 };
      samples.push(previewVertex && compensatedVertex
        ? {
          x: existing.x + compensatedVertex.x - previewVertex.x,
          y: existing.y + compensatedVertex.y - previewVertex.y,
        }
        : { x: 0, y: 0 });
    }
    const localKeys = sparsePointSamples(samples).map((key) => ({
      ...key,
      tick: clip.inTick + key.tick,
    }));
    clip.propertyTracks = { ...(clip.propertyTracks || {}) };
    if (localKeys.some((key) => key.value.x || key.value.y)) {
      clip.propertyTracks[SHAPE_ANCHOR_COMPENSATION] = localKeys;
    } else {
      delete clip.propertyTracks[SHAPE_ANCHOR_COMPENSATION];
    }
  }
}

export function setShapePathComponentValues(frameValue, layerId, entries) {
  const tick = tickIndex(frameValue);
  const path = tick == null ? null : shapePathAt(layerId, tick);
  if (!path) return [];
  const requested = Array.isArray(entries)
    ? entries
    : Object.entries(entries || {}).map(([componentId, value]) => ({ componentId, value }));
  const changes = [];
  let visiblePath = path;
  for (const entry of requested) {
    const componentId = Array.isArray(entry) ? entry[0] : entry?.componentId ?? entry?.id;
    const raw = Array.isArray(entry) ? entry[1] : entry?.value;
    const component = normalizeShapePathComponentId(componentId, path);
    const value = component ? normalizeShapePathComponentValue(component, raw) : null;
    if (!component || value == null || shapePathComponentEqual(
      component,
      shapePathComponentValue(path, component),
      value,
    )) continue;
    visiblePath = withShapePathComponentValue(visiblePath, component, value) || visiblePath;
    changes.push([component, value]);
  }
  if (!changes.length) return [];
  const stateBeforeEdit = getClipTimelineState();
  const trackBeforeEdit = trackForLayer(stateBeforeEdit, layerId);
  const hasCompensation = clipsForTrack(stateBeforeEdit, trackBeforeEdit?.id)
    .some((clip) => clip.propertyTracks?.[SHAPE_ANCHOR_COMPENSATION]?.length);
  const animatedComponents = new Set(changes.flatMap(([component]) => (
    isShapePathComponentEnabled(layerId, component) ||
    (hasCompensation && component.startsWith('vertex:'))
      ? [component]
      : []
  )));
  const animatedAnchor = animatedComponents.has(SHAPE_PATH_COMPONENT_ANCHOR);
  const newlyAnimatedComponents = [...animatedComponents].filter((component) =>
    !isShapePathComponentEnabled(layerId, component));
  const whole = isShapePathWholeTrackEnabled(layerId);
  let changed = false;
  if (animatedComponents.size || whole) {
    const baseline = stateBeforeEdit;
    changed = mutateShapeEntry(layerId, tick, 'set-shape-components', (entry) => {
      let keyPath = shapePathEntryPath(entry);
      const components = { ...shapePathEntryComponents(entry) };
      for (const [component, value] of changes) {
        if (animatedComponents.has(component)) {
          components[component] = componentMotionKey(component, {
            ...(components[component] || {}),
            ...(component === SHAPE_PATH_COMPONENT_ROTATION ? { value } : value),
          });
        } else if (whole) {
          keyPath = withShapePathComponentValue(
            keyPath || path,
            component,
            value,
          );
        }
      }
      return shapePathEntry(keyPath ? shapePathMotionKey(keyPath, path.kind) : null, components);
    }, true, (state, target) => {
      const track = trackForLayer(state, layerId);
      if (track) {
        track.shapePathComponents = [...new Set([
          ...(track.shapePathComponents || []),
          ...animatedComponents,
        ])];
      }
      const materializeVertices = hasCompensation && newlyAnimatedComponents
        .some((component) => component.startsWith('vertex:'));
      if (materializeVertices) materializeCompensatedVertices(state, baseline, layerId);
      for (const component of newlyAnimatedComponents) {
        if (!materializeVertices || !component.startsWith('vertex:')) {
          materializeShapeComponent(state, baseline, layerId, component);
        }
      }
      if (newlyAnimatedComponents.length && target?.owner) {
        const keys = target.owner.propertyTracks?.shapePath || [];
        const index = keys.findIndex((key) => key.tick === target.sourceTick);
        if (index >= 0) {
          const entry = keys[index].value;
          const components = { ...shapePathEntryComponents(entry) };
          for (const [component, value] of changes) {
            if (!animatedComponents.has(component)) continue;
            components[component] = componentMotionKey(component, {
              ...(components[component] || {}),
              ...(component === SHAPE_PATH_COMPONENT_ROTATION ? { value } : value),
            });
          }
          keys[index] = {
            ...keys[index],
            value: shapePathEntry(shapePathEntryPath(entry), components),
          };
        }
      }
      if (animatedAnchor) applyAnchorCompensation(state, baseline, layerId);
    });
  } else {
    changed = setFrameShape(layerId, tick, visiblePath);
  }
  return changed ? changes.map(([component]) => component) : [];
}

export function setShapePathComponentValue(frameValue, layerId, componentId, value) {
  return setShapePathComponentValues(frameValue, layerId, [{ componentId, value }]).length > 0;
}

export function deleteShapePathComponentKeys(layerId, componentId, ticks) {
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  if (!component) return [];
  const requested = new Set([...(ticks || [])].map(Number));
  const records = shapePathComponentRecords(getClipTimelineState(), layerId, component)
    .filter((record) => requested.has(record.projectTick));
  const changed = records.filter((record) => mutateShapeEntry(
    layerId,
    record.projectTick,
    'delete-shape-component-key',
    (entry) => {
      const components = { ...shapePathEntryComponents(entry) };
      delete components[component];
      return shapePathEntry(shapePathEntryPath(entry), components);
    },
    false,
  ));
  return changed.map((record) => record.projectTick);
}

export function moveShapePathComponentKeys(layerId, componentId, ticks, delta) {
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  return component ? moveShapeSubset(layerId, ticks, delta, component) : [];
}

export function copyShapePathComponentKeys(layerId, componentId, ticks) {
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  return shapePathPayload(layerId, ticks, component || String(componentId));
}

export function pasteShapePathComponentKeys(layerId, componentId, destination, payload) {
  const path = shapePathAt(layerId, destination);
  const component = normalizeShapePathComponentId(componentId, path);
  if (!component || payload?.componentId !== component) return [];
  return pasteShapeKeys(layerId, component, destination, payload);
}

export function setShapePathComponentKeyInterpolation(layerId, componentId, ticks, interpolation) {
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  const preset = validInterpolation(interpolation);
  return component
    ? editShapePathMetadata(layerId, ticks, component, (key) => ({ ...key, interpolation: preset }))
    : [];
}

export function setShapePathComponentKeyTemporalEase(
  layerId,
  componentId,
  ticks,
  side,
  handle,
) {
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  if (!component || (side !== 'in' && side !== 'out') ||
    (handle != null && !normalizeTemporalHandle(handle))) return [];
  return setShapeTemporalEase(layerId, ticks, component, { [side]: handle });
}

export function setShapePathComponentKeyTemporalPreset(layerId, componentId, ticks, preset) {
  const path = shapePathAt(layerId, get(canonicalPlayheadTick));
  const component = normalizeShapePathComponentId(componentId, path);
  return component
    ? setShapeTemporalEase(layerId, ticks, component, temporalPresetEdits(preset))
    : [];
}

export function clearShapePathKeys(layerId) {
  return setShapePathTrackEnabled(layerId, false);
}

function translatePayload(payload, dx, dy) {
  const next = { ...cloneDurable(payload), cells: cmTranslate(payload?.cells || {}, dx, dy) };
  if (next.box) next.box = { ...next.box, x: next.box.x + dx, y: next.box.y + dy };
  if (next.shape) {
    const path = translateShapePathKey(pathValueFromShape(next.shape), dx, dy);
    if (path) next.shape = shapeWithPathValue(next.shape, path);
    next.cells = next.shape ? renderShapeToCells(next.shape) : {};
  }
  if (next.mask) next.mask = { ...next.mask, cells: cmTranslate(next.mask.cells || {}, dx, dy) };
  return next;
}

function translateBase(base, dx, dy) {
  const next = cloneDurable(base);
  if (next.box) next.box = { ...next.box, x: next.box.x + dx, y: next.box.y + dy };
  if (next.shape) {
    const path = translateShapePathKey(pathValueFromShape(next.shape), dx, dy);
    if (path) next.shape = shapeWithPathValue(next.shape, path);
  }
  if (next.mask) next.mask = { ...next.mask, cells: cmTranslate(next.mask.cells || {}, dx, dy) };
  if (next.type === 'image' || next.type === 'video') {
    const size = get(dims);
    const transform = next.transform || { x: size.w / 2, y: size.h / 2, scale: 1, rot: 0 };
    next.transform = { ...transform, x: transform.x + dx, y: transform.y + dy };
  }
  return next;
}

function translateTrackContent(state, track, dx, dy) {
  track.layer = translateBase(track.layer, dx, dy);
  for (const clip of clipsForTrack(state, track.id)) {
    clip.frameKeys = clip.frameKeys.map((key) => ({
      ...key,
      value: translatePayload(key.value, dx, dy),
    }));
    const keys = clip.propertyTracks?.shapePath;
    if (!keys) continue;
    clip.propertyTracks.shapePath = keys.map((key) => {
      const path = shapePathEntryPath(key.value);
      const translated = path && translateShapePathKey(path, dx, dy);
      const components = Object.fromEntries(Object.entries(shapePathEntryComponents(key.value)).map(
        ([componentId, value]) => {
          if (componentId === SHAPE_PATH_COMPONENT_ROTATION) return [componentId, value];
          return [componentId, { ...value, x: Number(value.x) + dx, y: Number(value.y) + dy }];
        },
      ));
      return {
        ...key,
        value: shapePathEntry(translated ? { ...path, ...translated } : path, components),
      };
    });
  }
}

export function translateShapeLayerBaseById(layerId, dxValue, dyValue) {
  const dx = integer(dxValue);
  const dy = integer(dyValue);
  const track = trackForLayer(getClipTimelineState(), layerId);
  if (get(playing) || track?.layer?.type !== 'shape' || (!dx && !dy)) return false;
  checkpointHistory();
  const result = transactClipTimeline('translate-shape-base', (state) => {
    const target = trackForLayer(state, layerId);
    if (!target) return false;
    translateTrackContent(state, target, dx, dy);
    return { state, changed: true };
  });
  if (result.changed) publishResolvedTick();
  return !!result.changed;
}

export function cropTimeline(rect) {
  if (get(playing)) return false;
  const x = integer(rect?.x);
  const y = integer(rect?.y);
  const w = Math.max(1, Math.min(256, integer(rect?.w, 1)));
  const h = Math.max(1, Math.min(256, integer(rect?.h, 1)));
  checkpointHistory();
  if (x || y) {
    transactClipTimeline('crop-translate', (state) => {
      for (const track of visualTracks(state)) {
        if (track.kind !== 'group' && track.layer?.type !== 'group') {
          translateTrackContent(state, track, -x, -y);
        }
      }
      return { state, changed: true };
    });
    cellSelection.update((selected) => new Set([...selected].map((key) => {
      const point = cmParse(key);
      return cmKey(point.x - x, point.y - y);
    })));
  }
  resizeCanvas(w, h, false);
  publishResolvedTick();
  return true;
}

export function materializeShapePathsForRasterize(layerIds) {
  const ids = new Set(layerIds != null && typeof layerIds[Symbol.iterator] === 'function'
    ? [...layerIds]
    : [layerIds]);
  if (!ids.size) return false;
  const snapshot = getClipTimelineState();
  const result = transactClipTimeline('materialize-shape-paths', (state) => {
    let changed = false;
    for (const id of ids) {
      const track = trackForLayer(state, id);
      if (track?.layer?.type !== 'shape') continue;
      for (const clip of clipsForTrack(state, track.id)) {
        const keys = [];
        for (let offset = 0; offset < clipDuration(clip); offset++) {
          const projectTick = clip.startTick + offset;
          const sourceTick = clip.inTick + offset;
          const layer = resolvedLayer(snapshot, id, projectTick);
          if (!layer?.shape) continue;
          let held = null;
          for (const key of clip.frameKeys) {
            if (key.tick > sourceTick) break;
            held = key;
          }
          keys.push({
            tick: sourceTick,
            value: {
              ...(held?.value || {}),
              shape: cloneDurable(layer.shape),
              cells: renderShapeToCells(layer.shape),
            },
          });
        }
        if (keys.length) {
          clip.frameKeys = keys;
          changed = true;
        }
        if (clip.propertyTracks?.shapePath) {
          clip.propertyTracks = { ...clip.propertyTracks };
          delete clip.propertyTracks.shapePath;
        }
      }
      track.shapePathComponents = [];
      delete track.shapePathKind;
    }
    return changed ? { state, changed: true } : false;
  });
  if (result.changed) publishResolvedTick();
  return !!result.changed;
}

export function setLayerRaster(id, raster) {
  let found = false;
  layers.update((stack) => stack.map((layer) => {
    if (layer.id !== id) return layer;
    found = true;
    return { ...layer, raster };
  }));
  return found;
}

export function setAssetRuntime(assetId, runtime = null) {
  let found = false;
  layers.update((stack) => stack.map((layer) => {
    const layerAssetId = layer.type === 'image'
      ? layer.assetId
      : layer.type === 'video' ? layer.videoClip?.assetId : null;
    if (layerAssetId !== assetId) return layer;
    found = true;
    const { raster, videoElement, videoBlob, videoURL, runtimeMediaKey, ...durable } = layer;
    if (!runtime) return durable;
    if (layer.type === 'image') {
      return { ...durable, raster: runtime.raster || runtime, runtimeMediaKey: runtime.key };
    }
    return {
      ...durable,
      raster: runtime.raster,
      videoElement: runtime.element,
      videoBlob: runtime.blob,
      videoURL: runtime.url,
      runtimeMediaKey: runtime.key,
    };
  }));
  return found;
}

export function shapePathCelsForSave() {
  return null;
}

export function dopeRows() {
  const state = getClipTimelineState();
  return visualTracks(state).map((track) => {
    const id = trackLayerId(track);
    const clips = clipsForTrack(state, track.id);
    const celFrames = clips.flatMap((clip) => clip.frameKeys.map((key) => projectTickAt(clip, key.tick)))
      .filter((tick) => clipAtTick(state, track.id, tick))
      .sort((a, b) => a - b);
    const heldFrames = [];
    for (const clip of clips) {
      for (let tick = clip.startTick; tick < clip.startTick + clipDuration(clip); tick++) {
        if (!celFrames.includes(tick)) heldFrames.push(tick);
      }
    }
    return {
      id,
      name: track.layer?.name || track.name,
      type: track.layer?.type,
      groupId: track.layer?.groupId || null,
      visible: track.layer?.visible !== false,
      celFrames,
      heldFrames,
      keyFrames: positionKeys(id).map((key) => key.frame),
      visibilityKeyFrames: visibilityKeys(id).map((key) => key.frame),
      visibilityTrackEnabled: isVisibilityTrackEnabled(id),
      effectIntensityKeyFrames: effectIntensityKeys(id).map((key) => key.frame),
      effectIntensityTrackEnabled: isEffectIntensityTrackEnabled(id),
      maskOpacityKeyFrames: maskOpacityKeys(id).map((key) => key.frame),
      maskOpacityTrackEnabled: isMaskOpacityTrackEnabled(id),
      maskPositionKeyFrames: maskPositionKeys(id).map((key) => key.frame),
      maskPositionTrackEnabled: isMaskPositionTrackEnabled(id),
      shapePathKeyFrames: shapePathWholeKeys(id).map((key) => key.frame),
      shapePathTrackEnabled: isShapePathWholeTrackEnabled(id),
      shapePathWholeTrackEnabled: isShapePathWholeTrackEnabled(id),
      shapePathComponentTracks: shapePathAnimationComponents(id).filter((component) => component.enabled)
        .map((component) => ({
          id: component.id,
          label: component.label,
          keyFrames: shapePathComponentKeys(id, component.id).map((key) => key.frame),
        })),
    };
  });
}

export function isSimpleTimeline() {
  const state = getClipTimelineState();
  const tracks = visualTracks(state);
  return tracks.filter((track) => track.kind !== 'group').length <= 1 &&
    !tracks.some((track) => track.kind === 'group') &&
    tracks.every((track) => !Object.keys(track.propertyTracks || {}).length &&
      clipsForTrack(state, track.id).every((clip) => !Object.keys(clip.propertyTracks || {}).length));
}

export function createTimelineTickSource() {
  commitLayersToActiveFrame();
  const state = cloneDurable(getClipTimelineState());
  const rate = Math.max(1, Number(get(fps)) || DEFAULT_FPS);
  const total = clipTimelineDurationTicks(state);
  const tickDuration = 1000 / rate;
  return Object.freeze({
    fps: rate,
    durationTicks: total,
    tickDuration,
    layerStack: Object.freeze(resolveClipTimelineLayers(state, 0)),
    frameAtProjectTick(tick) {
      const projectTick = Number(tick);
      return Number.isInteger(projectTick) && projectTick >= 0 && projectTick < total
        ? { frameIndex: projectTick, localTick: 0, start: projectTick, end: projectTick + 1 }
        : null;
    },
    resolve(tick) {
      const projectTick = Number(tick);
      if (!Number.isInteger(projectTick) || projectTick < 0 || projectTick >= total) {
        throw new RangeError('Project tick is outside the timeline.');
      }
      return {
        id: projectTick,
        index: projectTick,
        tick: projectTick,
        duration: tickDuration,
        tickDuration,
        hold: 1,
        frameIndex: projectTick,
        localTick: 0,
        start: projectTick,
        end: projectTick + 1,
        layers: resolveClipTimelineLayers(state, projectTick),
      };
    },
  });
}

export function createTimelineFrameSource() {
  const source = createTimelineTickSource();
  return {
    frameCount: source.durationTicks,
    holds: Array(source.durationTicks).fill(1),
    resolve(index) {
      const frame = source.resolve(index);
      return {
        id: index,
        index,
        duration: source.tickDuration,
        hold: 1,
        layers: frame.layers,
      };
    },
  };
}

function playbackNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function play() {
  const loopEnabled = get(looping);
  if (get(playing)) return false;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('commit-move'));
  commitLayersToActiveFrame();
  const total = get(canonicalDurationTicks);
  if (total <= 1 && !loopEnabled) return false;
  const state = getClipTimelineState();
  let current = playbackStartTick(get(canonicalPlayheadTick), state.tags, total, loopEnabled);
  if (current !== get(canonicalPlayheadTick)) {
    seekClipTimelineTick(current);
    publishResolvedTick(current);
  }
  let publishedCurrent = current;
  playing.set(true);
  let nextDeadline = playbackNow() + 1000 / (get(fps) || DEFAULT_FPS);
  const advance = (duration) => {
    const next = nextPlaybackTick(current, getClipTimelineState().tags, duration, get(looping));
    current = next.tick;
    return next;
  };
  const step = () => {
    const duration = get(canonicalDurationTicks);
    let next = advance(duration);
    let wraps = next.wrapped ? 1 : 0;
    nextDeadline += 1000 / (get(fps) || DEFAULT_FPS);
    while (!next.stopped && nextDeadline <= playbackNow()) {
      next = advance(duration);
      if (next.wrapped) wraps++;
      nextDeadline += 1000 / (get(fps) || DEFAULT_FPS);
    }
    if (!next.stopped || wraps || current !== publishedCurrent) {
      seekClipTimelineTick(current);
      publishResolvedTick(current);
      publishedCurrent = current;
    }
    for (let cycle = 0; cycle < wraps; cycle++) {
      playbackCyclePublisher.set(Object.freeze({ id: ++playbackCycleId, tick: current }));
    }
    if (next.stopped) {
      stop({ preserveTick: true });
      return;
    }
    playbackTimer = setTimeout(step, Math.max(0, nextDeadline - playbackNow()));
  };
  playbackTimer = setTimeout(step, Math.max(0, nextDeadline - playbackNow()));
  return true;
}

export function stop({ preserveTick = false } = {}) {
  const wasPlaying = get(playing);
  if (playbackTimer) clearTimeout(playbackTimer);
  playbackTimer = null;
  if (!preserveTick && wasPlaying) {
    seekClipTimelineTick(0);
    publishResolvedTick(0);
  }
  if (wasPlaying) playing.set(false);
}

export function togglePlay() {
  return get(playing) ? stop({ preserveTick: true }) : play();
}

// History captures canonical state only after the editable projection has settled,
// keeping one undo entry authoritative for both views.
function captureTimeline() {
  const revision = get(authoredRevision);
  if (synchronizedAuthoredRevision !== revision) {
    commitLayersToActiveFrame({ publish: false });
    synchronizedAuthoredRevision = revision;
  }
  return {
    canonical: captureClipTimelineState(),
    fps: get(fps),
    structureToken: timelineStructureToken,
  };
}

function restoreTimeline(snapshot) {
  stop();
  const structureChanged = snapshot.structureToken !== timelineStructureToken;
  fps.set(snapshot.fps);
  const restored = restoreClipTimelineState(snapshot.canonical, {
    playheadTick: get(canonicalPlayheadTick),
  });
  timelineStructureToken = snapshot.structureToken;
  if (structureChanged) timelineStructureRevision.update((value) => value + 1);
  if (restored.changed) publishResolvedTick(restored.playheadTick);
  synchronizedAuthoredRevision = get(authoredRevision);
}

function restoreTimelineView(liveById) {
  return publishResolvedTick(get(canonicalPlayheadTick), liveById);
}

function settleAuthoredTimelineMutation() {
  const revision = get(authoredRevision);
  if (synchronizedAuthoredRevision !== revision) {
    commitLayersToActiveFrame();
    synchronizedAuthoredRevision = revision;
  }
}

function resetTimelineForEmptyLayerStack() {
  reconcileLiveLayers(get(canonicalPlayheadTick));
}

function resetEffectMaskTracks(layerId) {
  const state = getClipTimelineState();
  const track = trackForLayer(state, layerId);
  if (!track) return;
  transactClipTimeline('reset-effect-mask-tracks', (draft) => {
    const target = trackForLayer(draft, layerId);
    if (!target) return false;
    for (const clip of clipsForTrack(draft, target.id)) {
      if (!clip.propertyTracks) continue;
      clip.propertyTracks = { ...clip.propertyTracks };
      delete clip.propertyTracks.maskOpacity;
      delete clip.propertyTracks.maskPosition;
    }
    return { state: draft, changed: true };
  });
}

registerHistoryContributor(captureTimeline, restoreTimeline);
registerLayerHistoryAuthority({
  initializeView: initTimeline,
  restoreView: restoreTimelineView,
});
registerLayerStackEmptyHandler(resetTimelineForEmptyLayerStack);
registerEffectMaskChangeHandler(resetEffectMaskTracks);
registerShapeRasterizeHandler(materializeShapePathsForRasterize);
registerAuthoredMutationSettledHandler(settleAuthoredTimelineMutation);

initTimeline(get(layers));

fps.subscribe((rate) => {
  if (Object.is(rate, observedFps)) return;
  const previousRate = observedFps;
  observedFps = rate;
  const result = setClipTimelineFps(rate);
  if (result.changed) {
    normalizeVideoSourceBounds('retime-video-source-bounds', true, previousRate);
    publishResolvedTick(result.playheadTick);
  }
});

let lastStructureSignature = structureSignature(getClipTimelineState());
canonicalClipTimeline.subscribe((state) => {
  const signature = structureSignature(state);
  if (signature !== lastStructureSignature) {
    lastStructureSignature = signature;
    timelineStructureToken++;
    timelineStructureRevision.update((value) => value + 1);
  }
});
