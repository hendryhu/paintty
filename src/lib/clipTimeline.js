import { newUuid } from './uuid.js';
import {
  normalizeTimelineTag,
  normalizeTimelineTags,
  validateTimelineTagRange,
} from './timelineTags.js';
import { planTimelineKeyMotion } from './timelineKeys.js';

const DEFAULT_TIMELINE_FPS = 24;
const MIN_AUDIO_CLIP_SECONDS = 1e-6;

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function nonnegativeTick(value, fallback = 0) {
  return Math.max(0, integer(value, fallback));
}

function positiveTicks(value, fallback = 1) {
  return Math.max(1, integer(value, fallback));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function timelineFps(value) {
  return Math.max(1, finiteNumber(value, DEFAULT_TIMELINE_FPS));
}

function isAudioClip(clip) {
  return clip?.kind === 'audio';
}

function isFrameClip(clip) {
  return !isAudioClip(clip);
}

function normalizedAudioFields(definition = {}) {
  const duration = Math.max(0, finiteNumber(definition.duration));
  const volume = Math.max(0, Math.min(1, finiteNumber(definition.volume, 1)));
  if (duration === 0) {
    return { duration, inPoint: 0, outPoint: 0, volume, muted: Boolean(definition.muted) };
  }
  const minimum = Math.min(MIN_AUDIO_CLIP_SECONDS, duration);
  const inPoint = Math.max(0, Math.min(
    duration - minimum,
    finiteNumber(definition.inPoint),
  ));
  const outPoint = Math.max(
    inPoint + minimum,
    Math.min(duration, definition.outPoint == null
      ? duration
      : finiteNumber(definition.outPoint, duration)),
  );
  return { duration, inPoint, outPoint, volume, muted: Boolean(definition.muted) };
}

function audioDurationTicks(clip, fps) {
  const scaled = Math.max(
    0,
    finiteNumber(clip?.outPoint) - finiteNumber(clip?.inPoint),
  ) * timelineFps(fps);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 32;
  return Math.max(1, Math.ceil(Math.max(0, scaled - tolerance)));
}

function applyAudioTimelineBounds(clip, fps) {
  const fields = normalizedAudioFields(clip);
  Object.assign(clip, fields);
  clip.inTick = 0;
  clip.outTick = audioDurationTicks(fields, fps);
  clip.sourceDuration = clip.outTick;
  clip.frameKeys = [];
  clip.propertyTracks = {};
  return clip;
}

function stripRuntimeMedia(value) {
  for (const field of ['asset', 'audioBuffer', 'blob', 'buffer', 'bytes', 'file']) {
    delete value[field];
  }
  return value;
}

function idValue(value) {
  const id = String(value ?? '').trim();
  return id || null;
}

export function cloneTimelineValue(value, seen = new WeakMap()) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      return new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength);
    }
    return new value.constructor(value);
  }
  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    for (const [key, entry] of value) {
      copy.set(cloneTimelineValue(key, seen), cloneTimelineValue(entry, seen));
    }
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    for (const entry of value) copy.add(cloneTimelineValue(entry, seen));
    return copy;
  }
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const entry of value) copy.push(cloneTimelineValue(entry, seen));
    return copy;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy = Object.create(prototype);
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && [
      'raster', 'rasterURL', 'videoElement', 'videoBlob', 'videoURL', 'runtimeMediaKey',
      'blob', 'buffer', 'audioBuffer', 'decoder', 'objectURL',
    ].includes(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ('value' in descriptor) descriptor.value = cloneTimelineValue(descriptor.value, seen);
    Object.defineProperty(copy, key, descriptor);
  }
  return copy;
}

function runtimeId(kind) {
  return newUuid(kind);
}

function keyEntries(source) {
  if (source instanceof Map) return [...source.entries()].map(([tick, key]) => [tick, key, false]);
  if (Array.isArray(source)) {
    return source.map((key) => [key?.tick, key, true]);
  }
  if (source && typeof source === 'object') {
    return Object.entries(source).map(([tick, key]) => [tick, key, false]);
  }
  return [];
}

function normalizeKeys(source) {
  const byTick = new Map();
  for (const [rawTick, rawKey, record] of keyEntries(source)) {
    const candidateTick = rawKey && typeof rawKey === 'object' && 'tick' in rawKey
      ? rawKey.tick
      : rawTick;
    const tick = integer(candidateTick, -1);
    if (tick < 0) continue;
    const key = (record || (rawKey && typeof rawKey === 'object' && 'tick' in rawKey)) &&
      rawKey && typeof rawKey === 'object' && !Array.isArray(rawKey)
      ? { ...cloneTimelineValue(rawKey), tick }
      : { tick, value: cloneTimelineValue(rawKey) };
    byTick.set(tick, key);
  }
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}

function normalizePropertyTracks(source) {
  const tracks = {};
  if (!source || typeof source !== 'object') return tracks;
  for (const [name, keys] of Object.entries(source)) {
    const entries = !Array.isArray(keys) &&
      keys && typeof keys === 'object' && Array.isArray(keys.keys)
      ? keys.keys
      : keys;
    tracks[name] = normalizeKeys(entries);
  }
  return tracks;
}

function latestKeyTick(frameKeys, propertyTracks) {
  let latest = -1;
  for (const key of frameKeys) latest = Math.max(latest, key.tick);
  for (const keys of Object.values(propertyTracks)) {
    for (const key of keys) latest = Math.max(latest, key.tick);
  }
  return latest;
}

export function createTimelineTrack(definition = {}, makeId = runtimeId) {
  const id = idValue(definition.id) || idValue(makeId('track'));
  if (!id) throw new TypeError('A timeline track requires an id.');
  const kind = String(definition.kind || definition.type || 'visual');
  const track = {
    ...cloneTimelineValue(definition),
    id,
    kind,
    locked: Boolean(definition.locked),
  };
  delete track.clips;
  if (kind === 'audio') stripRuntimeMedia(track);
  return track;
}

export function createTimelineClip(
  definition = {},
  makeId = runtimeId,
  fps = DEFAULT_TIMELINE_FPS,
) {
  const id = idValue(definition.id) || idValue(makeId('clip'));
  const trackId = idValue(definition.trackId);
  if (!id) throw new TypeError('A timeline clip requires an id.');
  if (!trackId) throw new TypeError('A timeline clip requires a trackId.');

  const kind = String(definition.kind || 'clip');
  if (kind === 'audio') {
    const clip = {
      ...cloneTimelineValue(definition),
      id,
      trackId,
      kind,
      startTick: nonnegativeTick(definition.startTick),
    };
    delete clip.startFrame;
    stripRuntimeMedia(clip);
    return applyAudioTimelineBounds(clip, fps);
  }

  const frameKeys = normalizeKeys(definition.frameKeys);
  const propertyTracks = normalizePropertyTracks(definition.propertyTracks);
  const startTick = nonnegativeTick(definition.startTick);
  const requestedIn = nonnegativeTick(definition.inTick);
  const requestedOut = definition.outTick == null
    ? null
    : positiveTicks(definition.outTick);
  const keyedDuration = latestKeyTick(frameKeys, propertyTracks) + 1;
  let sourceDuration = positiveTicks(
    definition.sourceDuration,
    requestedOut ?? Math.max(1, keyedDuration),
  );
  sourceDuration = Math.max(sourceDuration, keyedDuration, requestedOut || 0);
  const inTick = Math.min(sourceDuration - 1, requestedIn);
  const outTick = Math.max(
    inTick + 1,
    Math.min(sourceDuration, requestedOut ?? sourceDuration),
  );

  return {
    ...cloneTimelineValue(definition),
    id,
    trackId,
    kind,
    startTick,
    inTick,
    outTick,
    sourceDuration,
    frameKeys,
    propertyTracks,
  };
}

export function createVisualClip(definition = {}, makeId = runtimeId) {
  return createTimelineClip({ ...definition, kind: 'visual' }, makeId);
}

export function emptyClipTimelineState() {
  return { tracks: [], clips: [], tags: [] };
}

export function cloneClipTimelineState(state = emptyClipTimelineState()) {
  return {
    ...cloneTimelineValue(state),
    tracks: Array.isArray(state?.tracks)
      ? state.tracks.map((track) => cloneTimelineValue(track))
      : [],
    clips: Array.isArray(state?.clips)
      ? state.clips.map((clip) => cloneTimelineValue(clip))
      : [],
  };
}

export function createClipTimelineState(source = {}) {
  const tracks = [];
  const nestedClips = [];
  for (const definition of Array.isArray(source.tracks) ? source.tracks : []) {
    const track = createTimelineTrack(definition, runtimeId);
    tracks.push(track);
    if (Array.isArray(definition?.clips)) {
      for (const clip of definition.clips) {
        nestedClips.push({ ...clip, trackId: clip.trackId || track.id });
      }
    }
  }
  const clipDefinitions = [
    ...(Array.isArray(source.clips) ? source.clips : []),
    ...nestedClips,
  ];
  const clips = clipDefinitions.map((clip) => (
    (clip.kind || 'visual') === 'visual'
      ? createVisualClip(clip, runtimeId)
      : createTimelineClip(clip, runtimeId, source.fps)
  ));
  return {
    ...cloneTimelineValue(source),
    tracks,
    clips,
    tags: normalizeTimelineTags(source.tags, { allowMissing: true }),
  };
}

export function setClipTimelineFps(state, fps) {
  const next = cloneClipTimelineState(state);
  const rate = timelineFps(fps);
  const tickDuration = 1000 / rate;
  let changed = next.fps !== rate || next.tickDuration !== tickDuration;
  next.fps = rate;
  next.tickDuration = tickDuration;
  next.clips = next.clips.map((clip) => {
    if (!isAudioClip(clip)) return clip;
    const prior = {
      inTick: clip.inTick,
      outTick: clip.outTick,
      sourceDuration: clip.sourceDuration,
    };
    applyAudioTimelineBounds(clip, rate);
    if (clip.inTick !== prior.inTick || clip.outTick !== prior.outTick ||
      clip.sourceDuration !== prior.sourceDuration) changed = true;
    return clip;
  });
  return changed
    ? changedResult(next, { fps: rate, tickDuration })
    : unchangedResult(next, 'unchanged', { fps: rate, tickDuration });
}

export function clipDurationTicks(clip) {
  return Math.max(1, integer(clip?.outTick, 1) - integer(clip?.inTick));
}

export function clipEndTick(clip) {
  return nonnegativeTick(clip?.startTick) + clipDurationTicks(clip);
}

export function clipContainsTick(clip, timelineTick) {
  const tick = integer(timelineTick, -1);
  return tick >= nonnegativeTick(clip?.startTick) && tick < clipEndTick(clip);
}

export function clipSourceTickAt(clip, timelineTick) {
  if (!clipContainsTick(clip, timelineTick)) return null;
  return integer(clip.inTick) + integer(timelineTick) - integer(clip.startTick);
}

function heldKey(keys, sourceTick) {
  const tick = integer(sourceTick, -1);
  let resolved = null;
  for (const key of Array.isArray(keys) ? keys : []) {
    if (key.tick > tick) break;
    resolved = key;
  }
  return resolved;
}

export function resolveHeldKey(keys, sourceTick) {
  const key = heldKey(normalizeKeys(keys), sourceTick);
  return key ? cloneTimelineValue(key) : null;
}

export function resolveHeldFrameKey(clip, timelineTick) {
  const sourceTick = clipSourceTickAt(clip, timelineTick);
  if (sourceTick == null) return null;
  const key = heldKey(clip.frameKeys, sourceTick);
  return key ? cloneTimelineValue(key) : null;
}

export function resolveHeldFrame(clip, timelineTick) {
  const key = resolveHeldFrameKey(clip, timelineTick);
  return key ? cloneTimelineValue(key.value) : null;
}

export function resolveClipPropertyKey(clip, propertyName, timelineTick) {
  const sourceTick = clipSourceTickAt(clip, timelineTick);
  if (sourceTick == null) return null;
  const key = heldKey(clip.propertyTracks?.[propertyName], sourceTick);
  return key ? cloneTimelineValue(key) : null;
}

export function resolveClipProperty(clip, propertyName, timelineTick) {
  const key = resolveClipPropertyKey(clip, propertyName, timelineTick);
  return key ? cloneTimelineValue(key.value) : null;
}

export function findClipAtTick(state, trackId, timelineTick) {
  const found = (state?.clips || []).find((clip) =>
    clip.trackId === trackId && clipContainsTick(clip, timelineTick));
  return found ? cloneTimelineValue(found) : null;
}

function trackById(state, trackId) {
  return state.tracks.find((track) => track.id === trackId) || null;
}

function isStructuralTrack(track) {
  return track?.kind === 'group';
}

function acceptsVisualClips(track) {
  return !!track && !['group', 'audio', 'video', 'media', 'effect'].includes(track.kind);
}

function canExtendHeldSource(clip) {
  return clip?.kind === 'visual' || clip?.kind === 'effect';
}

function clipIndexById(state, clipId) {
  return state.clips.findIndex((clip) => clip.id === clipId);
}

function usedIds(state) {
  return new Set([
    ...state.tracks.map((track) => track.id),
    ...state.clips.map((clip) => clip.id),
    ...(state.tags || []).map((tag) => tag.id),
  ]);
}

function timelineDurationForTags(state) {
  let end = Math.max(1, maxClipEnd(state));
  for (const track of state?.tracks || []) {
    if (track.kind !== 'group') continue;
    for (const keys of Object.values(track.propertyTracks || {})) {
      for (const key of keys || []) end = Math.max(end, nonnegativeTick(key.tick) + 1);
    }
  }
  return end;
}

export function setTimelineTag(state, definition = {}, options = {}) {
  const next = cloneClipTimelineState(state);
  const type = String(definition.type || '');
  const requestedId = idValue(definition.id);
  const editing = requestedId
    ? next.tags.find((tag) => tag.id === requestedId) || null
    : null;
  if (requestedId && !editing) return unchangedResult(next, 'missing-tag');
  const singleton = type === 'custom'
    ? null
    : next.tags.find((tag) => tag.type === type) || null;
  const id = editing?.id || singleton?.id || allocateId(next, 'tag', null, options.makeId);
  const duration = timelineDurationForTags(next);
  const requestedTick = Number(definition.tick);
  if (!Number.isSafeInteger(requestedTick) || requestedTick < 0 || requestedTick >= duration) {
    return unchangedResult(next, 'invalid-tick');
  }
  let tag;
  try {
    tag = normalizeTimelineTag({
      id,
      tick: requestedTick,
      type,
      ...(type === 'custom' ? { value: definition.value } : {}),
    }, 'Timeline tag', { requireTrimmed: false });
  } catch (error) {
    return unchangedResult(next, 'invalid-tag', { error });
  }
  const replacedIds = new Set([id]);
  if (editing) replacedIds.add(editing.id);
  if (type !== 'custom' && singleton) replacedIds.add(singleton.id);
  const retained = next.tags.filter((candidate) => !replacedIds.has(candidate.id));
  const originalIndex = next.tags.findIndex((candidate) => candidate.id === (editing?.id || singleton?.id));
  if (originalIndex < 0) retained.push(tag);
  else retained.splice(Math.min(originalIndex, retained.length), 0, tag);
  if (JSON.stringify(retained) === JSON.stringify(next.tags)) {
    return unchangedResult(next, 'unchanged', { tag: cloneTimelineValue(tag) });
  }
  next.tags = retained;
  return changedResult(next, { tag: cloneTimelineValue(tag) });
}

export function removeTimelineTag(state, tagId) {
  const next = cloneClipTimelineState(state);
  const index = next.tags.findIndex((tag) => tag.id === tagId);
  if (index < 0) return unchangedResult(next, 'missing-tag');
  const [tag] = next.tags.splice(index, 1);
  return changedResult(next, { tag: cloneTimelineValue(tag) });
}

function allocateId(state, kind, preferred, makeId = runtimeId, reserved = usedIds(state)) {
  const requested = idValue(preferred);
  if (requested) {
    if (reserved.has(requested)) throw new Error(`Duplicate timeline id: ${requested}`);
    reserved.add(requested);
    return requested;
  }
  const generated = new Set();
  while (generated.size < 1000) {
    const candidate = idValue(makeId(kind));
    if (!candidate) continue;
    if (!reserved.has(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
    if (generated.has(candidate)) break;
    generated.add(candidate);
  }
  throw new Error(`Could not allocate a unique ${kind} UUID.`);
}

function clipsOverlap(first, second) {
  if (isAudioClip(first) && isAudioClip(second)) return false;
  return first.trackId === second.trackId &&
    first.startTick < clipEndTick(second) &&
    clipEndTick(first) > second.startTick;
}

function overlappingClip(state, candidate, ignoredId = null) {
  return state.clips.find((clip) =>
    clip.id !== ignoredId && clipsOverlap(clip, candidate)) || null;
}

function changedResult(state, details = {}) {
  return { state, changed: true, ...details };
}

function unchangedResult(state, reason = 'unchanged', details = {}) {
  return { state, changed: false, reason, ...details };
}

export function addTimelineTrack(state, definition = {}, options = {}) {
  const next = cloneClipTimelineState(state);
  const id = allocateId(next, 'track', definition.id, options.makeId);
  const track = createTimelineTrack({ ...definition, id }, options.makeId || runtimeId);
  next.tracks.push(track);
  return changedResult(next, { track: cloneTimelineValue(track) });
}

export function updateTimelineTrack(state, trackId, patch = {}) {
  const next = cloneClipTimelineState(state);
  const index = next.tracks.findIndex((track) => track.id === trackId);
  if (index < 0) return unchangedResult(next, 'missing-track');
  const current = next.tracks[index];
  const updated = createTimelineTrack({
    ...current,
    ...cloneTimelineValue(patch),
    id: current.id,
  });
  next.tracks[index] = updated;
  return changedResult(next, { track: cloneTimelineValue(updated) });
}

export function removeTimelineTrack(state, trackId) {
  const next = cloneClipTimelineState(state);
  const index = next.tracks.findIndex((track) => track.id === trackId);
  if (index < 0) return unchangedResult(next, 'missing-track');
  const [track] = next.tracks.splice(index, 1);
  const clips = next.clips.filter((clip) => clip.trackId === trackId);
  next.clips = next.clips.filter((clip) => clip.trackId !== trackId);
  return changedResult(next, {
    track: cloneTimelineValue(track),
    clips: cloneTimelineValue(clips),
  });
}

export function addTimelineClip(state, definition = {}, options = {}) {
  const next = cloneClipTimelineState(state);
  const track = trackById(next, definition.trackId);
  if (!track) return unchangedResult(next, 'missing-track');
  if (isStructuralTrack(track)) return unchangedResult(next, 'structural-track');
  const clipKind = String(definition.kind || 'visual');
  if ((track.kind === 'audio') !== (clipKind === 'audio')) {
    return unchangedResult(next, 'incompatible-track');
  }
  const requestedId = idValue(definition.id);
  if (requestedId && usedIds(next).has(requestedId)) {
    throw new Error(`Duplicate timeline id: ${requestedId}`);
  }
  const provisionalId = requestedId || '__pending-clip__';
  const clip = clipKind === 'visual'
    ? createVisualClip({ ...definition, id: provisionalId }, options.makeId || runtimeId)
    : createTimelineClip(
      { ...definition, id: provisionalId },
      options.makeId || runtimeId,
      next.fps,
    );
  if (overlappingClip(next, clip)) return unchangedResult(next, 'overlap');
  clip.id = allocateId(next, 'clip', requestedId, options.makeId);
  next.clips.push(clip);
  return changedResult(next, { clip: cloneTimelineValue(clip) });
}

export function removeTimelineClip(state, clipId) {
  const next = cloneClipTimelineState(state);
  const index = clipIndexById(next, clipId);
  if (index < 0) return unchangedResult(next, 'missing-clip');
  const [clip] = next.clips.splice(index, 1);
  return changedResult(next, { clip: cloneTimelineValue(clip) });
}

export function updateTimelineClip(state, clipId, patch = {}) {
  const next = cloneClipTimelineState(state);
  const index = clipIndexById(next, clipId);
  if (index < 0) return unchangedResult(next, 'missing-clip');
  const current = next.clips[index];
  if (trackById(next, current.trackId)?.locked) return unchangedResult(next, 'locked-track');
  const updated = createTimelineClip({
    ...current,
    ...cloneTimelineValue(patch),
    id: current.id,
    trackId: current.trackId,
    kind: current.kind,
  }, runtimeId, next.fps);
  if (overlappingClip(next, updated, current.id)) {
    return unchangedResult(next, 'overlap', { clip: cloneTimelineValue(current) });
  }
  if (JSON.stringify(updated) === JSON.stringify(current)) {
    return unchangedResult(next, 'unchanged', { clip: cloneTimelineValue(current) });
  }
  next.clips[index] = updated;
  return changedResult(next, { clip: cloneTimelineValue(updated) });
}

function applyValueEdit(value, edit, context) {
  const draft = cloneTimelineValue(value);
  if (typeof edit !== 'function') {
    return edit === undefined ? draft : cloneTimelineValue(edit);
  }
  const result = edit(draft, context);
  return cloneTimelineValue(result === undefined ? draft : result);
}

function upsertKey(keys, key) {
  const next = normalizeKeys(keys);
  const index = next.findIndex((candidate) => candidate.tick === key.tick);
  if (index >= 0) next[index] = cloneTimelineValue(key);
  else next.push(cloneTimelineValue(key));
  next.sort((a, b) => a.tick - b.tick);
  return next;
}

export function editVisualFrame(state, trackId, timelineTick, edit, options = {}) {
  const next = cloneClipTimelineState(state);
  const track = trackById(next, trackId);
  if (!track) return unchangedResult(next, 'missing-track');
  if (track.locked) return unchangedResult(next, 'locked-track');
  if (!acceptsVisualClips(track)) return unchangedResult(next, 'not-visual-track');
  const tick = nonnegativeTick(timelineTick);
  let index = next.clips.findIndex((clip) =>
    clip.trackId === trackId && clipContainsTick(clip, tick));
  let createdClip = false;
  if (index < 0) {
    const id = allocateId(next, 'clip', options.clipId, options.makeId);
    const initialValue = cloneTimelineValue(options.initialValue ?? null);
    const clip = createVisualClip({
      id,
      trackId,
      startTick: tick,
      inTick: 0,
      outTick: 1,
      sourceDuration: 1,
      frameKeys: [{ tick: 0, value: initialValue }],
    });
    if (overlappingClip(next, clip)) return unchangedResult(next, 'overlap');
    next.clips.push(clip);
    index = next.clips.length - 1;
    createdClip = true;
  }

  const clip = next.clips[index];
  if (clip.kind !== 'visual') return unchangedResult(next, 'not-visual');
  const sourceTick = clipSourceTickAt(clip, tick);
  const exact = clip.frameKeys.find((key) => key.tick === sourceTick);
  const resolved = exact || heldKey(clip.frameKeys, sourceTick);
  const seed = resolved
    ? cloneTimelineValue(resolved)
    : { tick: sourceTick, value: cloneTimelineValue(options.initialValue ?? null) };
  const key = {
    ...seed,
    tick: sourceTick,
    value: applyValueEdit(seed.value, edit, {
      clipId: clip.id,
      trackId,
      timelineTick: tick,
      sourceTick,
    }),
  };
  clip.frameKeys = upsertKey(clip.frameKeys, key);
  return changedResult(next, {
    clip: cloneTimelineValue(clip),
    key: cloneTimelineValue(key),
    createdClip,
    createdKey: createdClip || !exact,
  });
}

export function editClipProperty(
  state,
  clipId,
  propertyName,
  timelineTick,
  edit,
  options = {},
) {
  const next = cloneClipTimelineState(state);
  const index = clipIndexById(next, clipId);
  if (index < 0) return unchangedResult(next, 'missing-clip');
  const clip = next.clips[index];
  if (trackById(next, clip.trackId)?.locked) return unchangedResult(next, 'locked-track');
  const sourceTick = clipSourceTickAt(clip, timelineTick);
  if (sourceTick == null) return unchangedResult(next, 'outside-clip');
  const name = String(propertyName || '').trim();
  if (!name) return unchangedResult(next, 'missing-property');
  const keys = normalizeKeys(clip.propertyTracks?.[name]);
  const exact = keys.find((key) => key.tick === sourceTick);
  const resolved = exact || heldKey(keys, sourceTick);
  const seed = resolved
    ? cloneTimelineValue(resolved)
    : { tick: sourceTick, value: cloneTimelineValue(options.initialValue ?? null) };
  const key = {
    ...seed,
    tick: sourceTick,
    value: applyValueEdit(seed.value, edit, {
      clipId,
      propertyName: name,
      timelineTick: integer(timelineTick),
      sourceTick,
    }),
  };
  clip.propertyTracks = {
    ...clip.propertyTracks,
    [name]: upsertKey(keys, key),
  };
  return changedResult(next, {
    clip: cloneTimelineValue(clip),
    key: cloneTimelineValue(key),
    createdKey: !exact,
  });
}

function priorClipEnd(state, clip) {
  let boundary = 0;
  for (const other of state.clips) {
    if (other.id === clip.id || other.trackId !== clip.trackId) continue;
    if (clipEndTick(other) <= clip.startTick) boundary = Math.max(boundary, clipEndTick(other));
  }
  return boundary;
}

function nextClipStart(state, clip) {
  let boundary = Infinity;
  const end = clipEndTick(clip);
  for (const other of state.clips) {
    if (other.id === clip.id || other.trackId !== clip.trackId) continue;
    if (other.startTick >= end) boundary = Math.min(boundary, other.startTick);
  }
  return boundary;
}

export function trimTimelineClip(state, clipId, edge, targetTick) {
  const next = cloneClipTimelineState(state);
  const index = clipIndexById(next, clipId);
  if (index < 0) return unchangedResult(next, 'missing-clip');
  const clip = next.clips[index];
  if (trackById(next, clip.trackId)?.locked) return unchangedResult(next, 'locked-track');
  const side = edge === 'in' || edge === 'start' ? 'start'
    : edge === 'out' || edge === 'end' ? 'end' : null;
  if (!side) return unchangedResult(next, 'invalid-edge');
  const oldStart = clip.startTick;
  const oldEnd = clipEndTick(clip);
  const rate = timelineFps(next.fps);
  let appliedTick;
  if (side === 'start') {
    const earliestSource = isAudioClip(clip)
      ? oldStart - Math.floor(clip.inPoint * rate)
      : oldStart - clip.inTick;
    const earliest = Math.max(
      0,
      earliestSource,
      isAudioClip(clip) ? 0 : priorClipEnd(next, clip),
    );
    appliedTick = Math.max(earliest, Math.min(oldEnd - 1, integer(targetTick, oldStart)));
    if (isAudioClip(clip)) {
      clip.inPoint += (appliedTick - oldStart) / rate;
    } else {
      clip.inTick += appliedTick - oldStart;
    }
    clip.startTick = appliedTick;
  } else {
    const latestSource = isAudioClip(clip)
      ? oldStart + audioDurationTicks({ inPoint: clip.inPoint, outPoint: clip.duration }, rate)
      : oldStart + clip.sourceDuration - clip.inTick;
    const latest = Math.min(
      canExtendHeldSource(clip) ? Infinity : latestSource,
      isAudioClip(clip) ? Infinity : nextClipStart(next, clip),
    );
    appliedTick = Math.max(oldStart + 1, Math.min(latest, integer(targetTick, oldEnd)));
    if (isAudioClip(clip)) {
      clip.outPoint += (appliedTick - oldEnd) / rate;
    } else {
      clip.outTick += appliedTick - oldEnd;
      if (canExtendHeldSource(clip) && clip.outTick > clip.sourceDuration) {
        clip.sourceDuration = clip.outTick;
      }
    }
  }
  if (appliedTick === (side === 'start' ? oldStart : oldEnd)) {
    return unchangedResult(next, 'unchanged', { clip: cloneTimelineValue(clip) });
  }
  if (isAudioClip(clip)) applyAudioTimelineBounds(clip, rate);
  return changedResult(next, {
    clip: cloneTimelineValue(clip),
    edge: side,
    edgeTick: appliedTick,
  });
}

export function moveTimelineClip(state, clipId, targetStartTick, options = {}) {
  const next = cloneClipTimelineState(state);
  const index = clipIndexById(next, clipId);
  if (index < 0) return unchangedResult(next, 'missing-clip');
  const clip = next.clips[index];
  const targetTrackId = idValue(options.trackId) || clip.trackId;
  const sourceTrack = trackById(next, clip.trackId);
  const targetTrack = trackById(next, targetTrackId);
  if (!targetTrack) return unchangedResult(next, 'missing-track');
  if (sourceTrack?.locked || targetTrack.locked) return unchangedResult(next, 'locked-track');
  if (isStructuralTrack(targetTrack)) return unchangedResult(next, 'structural-track');
  if ((clip.kind === 'audio') !== (targetTrack.kind === 'audio')) {
    return unchangedResult(next, 'incompatible-track');
  }
  const startTick = nonnegativeTick(targetStartTick);
  const candidate = { ...clip, trackId: targetTrackId, startTick };
  if (overlappingClip(next, candidate, clip.id)) {
    return unchangedResult(next, 'overlap', { clip: cloneTimelineValue(clip) });
  }
  if (clip.startTick === startTick && clip.trackId === targetTrackId) {
    return unchangedResult(next, 'unchanged', { clip: cloneTimelineValue(clip) });
  }
  clip.startTick = startTick;
  clip.trackId = targetTrackId;
  return changedResult(next, { clip: cloneTimelineValue(clip) });
}

export function duplicateTimelineClips(state, operations, options = {}) {
  const next = cloneClipTimelineState(state);
  const edits = Array.isArray(operations) ? operations : [];
  if (!edits.length) {
    return unchangedResult(next, 'missing-operations', { duplicatedClipIds: [] });
  }

  const sourceIds = new Set();
  const candidates = [];
  for (const edit of edits) {
    const sourceId = idValue(edit?.clipId);
    const source = next.clips.find((clip) => clip.id === sourceId);
    if (!source) {
      return unchangedResult(next, 'missing-clip', { duplicatedClipIds: [] });
    }
    if (sourceIds.has(source.id)) {
      return unchangedResult(next, 'duplicate-source', { duplicatedClipIds: [] });
    }
    sourceIds.add(source.id);

    const sourceTrack = trackById(next, source.trackId);
    const targetTrackId = idValue(edit?.trackId) || source.trackId;
    const targetTrack = trackById(next, targetTrackId);
    if (!sourceTrack || !targetTrack) {
      return unchangedResult(next, 'missing-track', { duplicatedClipIds: [] });
    }
    if (sourceTrack.locked || targetTrack.locked) {
      return unchangedResult(next, 'locked-track', { duplicatedClipIds: [] });
    }
    if (isStructuralTrack(targetTrack)) {
      return unchangedResult(next, 'structural-track', { duplicatedClipIds: [] });
    }
    if ((source.kind === 'audio') !== (targetTrack.kind === 'audio')) {
      return unchangedResult(next, 'incompatible-track', { duplicatedClipIds: [] });
    }

    const targetStartTick = Number(edit?.targetStartTick);
    if (!Number.isSafeInteger(targetStartTick) || targetStartTick < 0) {
      return unchangedResult(next, 'invalid-start', { duplicatedClipIds: [] });
    }
    candidates.push({
      sourceId: source.id,
      clip: {
        ...cloneTimelineValue(source),
        trackId: targetTrackId,
        startTick: targetStartTick,
      },
    });
  }

  for (const candidate of candidates) {
    if (candidate.clip.kind === 'audio') continue;
    const collision = next.clips.find((clip) => clipsOverlap(candidate.clip, clip));
    if (collision) {
      return unchangedResult(next, 'overlap', {
        duplicatedClipIds: [],
        sourceClipId: candidate.sourceId,
        overlappingClipId: collision.id,
      });
    }
  }
  for (let first = 0; first < candidates.length; first++) {
    for (let second = first + 1; second < candidates.length; second++) {
      if (clipsOverlap(candidates[first].clip, candidates[second].clip)) {
        return unchangedResult(next, 'overlap', {
          duplicatedClipIds: [],
          sourceClipId: candidates[first].sourceId,
          overlappingSourceClipId: candidates[second].sourceId,
        });
      }
    }
  }

  const reserved = usedIds(next);
  const duplicatedClips = candidates.map(({ clip }) => ({
    ...clip,
    id: allocateId(next, 'clip', null, options.makeId, reserved),
  }));
  next.clips.push(...duplicatedClips);
  const errors = validateClipTimelineState(next);
  if (errors.length) {
    return unchangedResult(cloneClipTimelineState(state), 'invalid-result', {
      duplicatedClipIds: [],
      errors,
    });
  }
  return changedResult(next, {
    duplicatedClipIds: duplicatedClips.map((clip) => clip.id),
    duplicatedClips: cloneTimelineValue(duplicatedClips),
  });
}

function materializeBoundary(keys, sourceTick) {
  const normalized = normalizeKeys(keys);
  if (normalized.some((key) => key.tick === sourceTick)) return normalized;
  const resolved = heldKey(normalized, sourceTick);
  return resolved
    ? upsertKey(normalized, { ...cloneTimelineValue(resolved), tick: sourceTick })
    : normalized;
}

function splitClipObject(clip, timelineTick, rightId, fps = DEFAULT_TIMELINE_FPS) {
  if (!clipContainsTick(clip, timelineTick) || timelineTick === clip.startTick) return null;
  const sourceTick = clipSourceTickAt(clip, timelineTick);
  const left = cloneTimelineValue(clip);
  const right = cloneTimelineValue(clip);
  left.outTick = sourceTick;
  right.id = rightId;
  right.startTick = integer(timelineTick);
  right.inTick = sourceTick;
  right.frameKeys = materializeBoundary(right.frameKeys, sourceTick);
  right.propertyTracks = Object.fromEntries(Object.entries(right.propertyTracks || {}).map(
    ([name, keys]) => [name, materializeBoundary(keys, sourceTick)],
  ));
  if (isAudioClip(clip)) {
    const splitPoint = finiteNumber(clip.inPoint) +
      (integer(timelineTick) - nonnegativeTick(clip.startTick)) / timelineFps(fps);
    left.outPoint = splitPoint;
    right.inPoint = splitPoint;
    applyAudioTimelineBounds(left, fps);
    applyAudioTimelineBounds(right, fps);
  }
  return { left, right, sourceTick };
}

export function razorSplitClip(state, clipId, timelineTick, options = {}) {
  const next = cloneClipTimelineState(state);
  const index = clipIndexById(next, clipId);
  if (index < 0) return unchangedResult(next, 'missing-clip');
  const clip = next.clips[index];
  if (trackById(next, clip.trackId)?.locked) return unchangedResult(next, 'locked-track');
  const tick = integer(timelineTick, -1);
  if (tick <= clip.startTick || tick >= clipEndTick(clip)) {
    return unchangedResult(next, 'outside-clip');
  }
  const rightId = allocateId(next, 'clip', options.rightClipId, options.makeId);
  const split = splitClipObject(clip, tick, rightId, options.fps ?? next.fps);
  next.clips.splice(index, 1, split.left, split.right);
  return changedResult(next, {
    left: cloneTimelineValue(split.left),
    right: cloneTimelineValue(split.right),
    sourceTick: split.sourceTick,
  });
}

export function razorSplitAtTick(state, timelineTick, options = {}) {
  const next = cloneClipTimelineState(state);
  const tick = integer(timelineTick, -1);
  const selectedTracks = options.trackIds == null
    ? null
    : new Set(iterableIds(options.trackIds));
  const targets = next.clips.filter((clip) => {
    if (options.clipId && clip.id !== options.clipId) return false;
    if (selectedTracks && !selectedTracks.has(clip.trackId)) return false;
    if (trackById(next, clip.trackId)?.locked) return false;
    return tick > clip.startTick && tick < clipEndTick(clip);
  });
  if (!options.allUnlocked && !options.clipId && targets.length > 1) targets.splice(1);
  if (!targets.length) return unchangedResult(next, 'no-crossing-clips', { splits: [] });

  const reserved = usedIds(next);
  const targetIds = new Set(targets.map((clip) => clip.id));
  const splits = [];
  const clips = [];
  for (const clip of next.clips) {
    if (!targetIds.has(clip.id)) {
      clips.push(clip);
      continue;
    }
    const rightId = allocateId(next, 'clip', null, options.makeId, reserved);
    const split = splitClipObject(clip, tick, rightId, options.fps ?? next.fps);
    clips.push(split.left, split.right);
    splits.push({
      originalId: clip.id,
      leftId: split.left.id,
      rightId: split.right.id,
      sourceTick: split.sourceTick,
    });
  }
  next.clips = clips;
  return changedResult(next, { splits });
}

function iterableIds(value) {
  if (value == null) return [];
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (typeof value[Symbol.iterator] !== 'function') return [];
  return [...new Set([...value].map((entry) => String(entry)))];
}

function keySelections(selection) {
  const keys = [];
  for (const key of selection?.keys || []) keys.push(key);
  for (const key of selection?.frameKeys || []) keys.push({ ...key, kind: 'frame' });
  for (const key of selection?.propertyKeys || []) keys.push({ ...key, kind: 'property' });
  return keys;
}

export function deleteTimelineSelection(state, selection = {}, options = {}) {
  const clipIds = new Set(iterableIds(selection.clipIds));
  const keys = keySelections(selection);
  if (!clipIds.size && !keys.length && selection.gap) {
    const gap = selection.gap;
    return rippleDeleteGap(
      state,
      gap.trackIds ?? selection.trackIds,
      gap.startTick,
      gap.endTick,
      options,
    );
  }

  const next = cloneClipTimelineState(state);
  let removedClips = 0;
  let removedKeys = 0;
  const changedFrameClipIds = new Set();
  const removedAudioTrackIds = new Set();
  if (clipIds.size) {
    const before = next.clips.length;
    next.clips = next.clips.filter((clip) => {
      if (!clipIds.has(clip.id) || trackById(next, clip.trackId)?.locked) return true;
      if (isAudioClip(clip)) removedAudioTrackIds.add(clip.trackId);
      return false;
    });
    removedClips = before - next.clips.length;
  }
  for (const selectionKey of keys) {
    if (clipIds.has(selectionKey.clipId)) continue;
    const clip = next.clips.find((candidate) => candidate.id === selectionKey.clipId);
    if (!clip) continue;
    if (trackById(next, clip.trackId)?.locked) continue;
    const sourceTick = selectionKey.sourceTick != null
      ? integer(selectionKey.sourceTick, -1)
      : selectionKey.timelineTick != null
        ? clipSourceTickAt(clip, selectionKey.timelineTick)
        : integer(selectionKey.tick, -1);
    if (sourceTick == null || sourceTick < 0) continue;
    const kind = selectionKey.kind || selectionKey.type || 'frame';
    if (kind === 'frame') {
      const before = clip.frameKeys.length;
      clip.frameKeys = clip.frameKeys.filter((key) => key.tick !== sourceTick);
      const removed = before - clip.frameKeys.length;
      removedKeys += removed;
      if (removed && isFrameClip(clip)) changedFrameClipIds.add(clip.id);
      continue;
    }
    const name = selectionKey.propertyName || selectionKey.track || selectionKey.name;
    if (!name || !clip.propertyTracks?.[name]) continue;
    const before = clip.propertyTracks[name].length;
    clip.propertyTracks[name] = clip.propertyTracks[name]
      .filter((key) => key.tick !== sourceTick);
    removedKeys += before - clip.propertyTracks[name].length;
  }
  for (const clipId of changedFrameClipIds) {
    const clip = next.clips.find((candidate) => candidate.id === clipId);
    if (!clip || heldKey(clip.frameKeys, clip.inTick)) continue;
    const nextFrame = clip.frameKeys.find((key) =>
      key.tick > clip.inTick && key.tick < clip.outTick);
    if (!nextFrame) {
      next.clips.splice(clipIndexById(next, clip.id), 1);
      removedClips++;
      continue;
    }
    const blankTicks = nextFrame.tick - clip.inTick;
    clip.startTick += blankTicks;
    clip.inTick = nextFrame.tick;
  }
  if (!removedClips && !removedKeys) return unchangedResult(next, 'nothing-selected');
  const removedTrackIds = next.tracks
    .filter((track) => track.kind === 'audio' && removedAudioTrackIds.has(track.id) &&
      !next.clips.some((clip) => clip.trackId === track.id))
    .map((track) => track.id);
  if (removedTrackIds.length) {
    const removed = new Set(removedTrackIds);
    next.tracks = next.tracks.filter((track) => !removed.has(track.id));
  }
  return changedResult(next, { removedClips, removedKeys, removedTrackIds });
}

export function moveTimelineKeys(state, selection = {}, deltaTicks = 0) {
  const next = cloneClipTimelineState(state);
  const plan = planTimelineKeyMotion(next, selection, deltaTicks);
  if (!plan.valid || !plan.changed) {
    return unchangedResult(next, plan.reason || 'unchanged', {
      deltaTicks: plan.deltaTicks || 0,
      moves: plan.moves || [],
    });
  }

  const frameMoves = new Map();
  const propertyMoves = new Map();
  for (const move of plan.moves) {
    if (move.kind === 'frame') {
      const byTick = frameMoves.get(move.clipId) || new Map();
      byTick.set(move.sourceTick, move.destinationSourceTick);
      frameMoves.set(move.clipId, byTick);
      continue;
    }
    const identity = `${move.clipId}\u0000${move.propertyName}`;
    const byTick = propertyMoves.get(identity) || new Map();
    byTick.set(move.sourceTick, move.destinationSourceTick);
    propertyMoves.set(identity, byTick);
  }
  for (const clip of next.clips) {
    const frames = frameMoves.get(String(clip.id));
    if (frames) {
      clip.frameKeys = clip.frameKeys.map((key) => ({
        ...key,
        tick: frames.get(Number(key.tick)) ?? Number(key.tick),
      })).sort((first, second) => first.tick - second.tick);
      if (!clip.frameKeys.some((key) => key.tick <= clip.inTick)) {
        const firstFrame = clip.frameKeys.find((key) => key.tick < clip.outTick);
        if (firstFrame) {
          clip.startTick += firstFrame.tick - clip.inTick;
          clip.inTick = firstFrame.tick;
        }
      }
    }
    for (const [propertyName, keys] of Object.entries(clip.propertyTracks || {})) {
      const moved = propertyMoves.get(`${String(clip.id)}\u0000${propertyName}`);
      if (!moved) continue;
      clip.propertyTracks[propertyName] = keys.map((key) => ({
        ...key,
        tick: moved.get(Number(key.tick)) ?? Number(key.tick),
      })).sort((first, second) => first.tick - second.tick);
    }
  }
  return changedResult(next, {
    deltaTicks: plan.deltaTicks,
    moves: plan.moves,
    selection: plan.selection,
  });
}

export function maxClipEnd(state, trackIds = null) {
  const selected = trackIds == null ? null : new Set(iterableIds(trackIds));
  let end = 0;
  for (const clip of state?.clips || []) {
    if (!selected || selected.has(clip.trackId)) end = Math.max(end, clipEndTick(clip));
  }
  return end;
}

export function playbackDurationTicks(state) {
  return Math.max(1, maxClipEnd(state));
}

export function findContiguousGap(state, trackIds, timelineTick, options = {}) {
  const ids = new Set(iterableIds(trackIds));
  if (!ids.size) return null;
  const tick = nonnegativeTick(timelineTick);
  const clips = (state?.clips || []).filter((clip) => ids.has(clip.trackId));
  if (clips.some((clip) => clipContainsTick(clip, tick))) return null;
  let startTick = 0;
  let endTick = Infinity;
  for (const clip of clips) {
    const end = clipEndTick(clip);
    if (end <= tick) startTick = Math.max(startTick, end);
    if (clip.startTick > tick) endTick = Math.min(endTick, clip.startTick);
  }
  if (Number.isFinite(Number(options.endTick))) {
    endTick = Math.min(endTick, Math.max(tick + 1, integer(options.endTick)));
  }
  return {
    trackIds: [...ids],
    startTick,
    endTick,
    durationTicks: endTick - startTick,
  };
}

export function rippleDeleteGap(
  state,
  trackIds,
  startTick,
  endTick,
  _options = {},
) {
  const next = cloneClipTimelineState(state);
  const ids = new Set(iterableIds(trackIds));
  if (!ids.size) return unchangedResult(next, 'missing-tracks', { shiftedClipIds: [] });
  const requestedTracks = [...ids].map((id) => trackById(next, id)).filter(Boolean);
  if (!requestedTracks.length) {
    return unchangedResult(next, 'missing-tracks', { shiftedClipIds: [] });
  }
  const tracks = requestedTracks.filter((track) => !track.locked && !isStructuralTrack(track));
  if (!tracks.length) {
    return unchangedResult(next, 'locked-track', { shiftedClipIds: [] });
  }
  const editableIds = new Set(tracks.map((track) => track.id));
  const from = nonnegativeTick(startTick);
  const to = integer(endTick, from);
  if (!Number.isFinite(to) || to <= from) {
    return unchangedResult(next, 'invalid-gap', { shiftedClipIds: [] });
  }
  const occupied = next.clips.some((clip) => editableIds.has(clip.trackId) &&
    clip.startTick < to && clipEndTick(clip) > from);
  if (occupied) return unchangedResult(next, 'occupied', { shiftedClipIds: [] });
  const delta = to - from;
  const shiftedClipIds = [];
  for (const clip of next.clips) {
    if (!editableIds.has(clip.trackId) || clip.startTick < to) continue;
    clip.startTick -= delta;
    shiftedClipIds.push(clip.id);
  }
  if (!shiftedClipIds.length) {
    return unchangedResult(next, 'no-later-clips', { shiftedClipIds: [] });
  }
  return changedResult(next, { shiftedClipIds, deltaTicks: -delta });
}

export function addEmptyTime(state, timelineTick, durationTicks, options = {}) {
  const next = cloneClipTimelineState(state);
  const tick = nonnegativeTick(timelineTick);
  const duration = positiveTicks(durationTicks);
  const reserved = usedIds(next);
  const clips = [];
  const movedClipIds = [];
  const splitClipIds = [];
  for (const clip of next.clips) {
    const end = clipEndTick(clip);
    if (clip.startTick >= tick) {
      clip.startTick += duration;
      movedClipIds.push(clip.id);
      clips.push(clip);
      continue;
    }
    if (end <= tick) {
      clips.push(clip);
      continue;
    }
    const rightId = allocateId(next, 'clip', null, options.makeId, reserved);
    const split = splitClipObject(clip, tick, rightId, next.fps);
    split.right.startTick += duration;
    clips.push(split.left, split.right);
    movedClipIds.push(split.right.id);
    splitClipIds.push(split.right.id);
  }
  next.clips = clips;
  if (!movedClipIds.length) {
    return unchangedResult(next, 'no-content-at-or-after-tick', {
      movedClipIds,
      splitClipIds,
    });
  }
  return changedResult(next, {
    startTick: tick,
    durationTicks: duration,
    movedClipIds,
    splitClipIds,
  });
}

function shiftedKeys(keys, fromSourceTick, delta) {
  const shifted = normalizeKeys(keys).map((key) => ({
    ...cloneTimelineValue(key),
    tick: key.tick >= fromSourceTick ? key.tick + delta : key.tick,
  }));
  if (shifted.some((key) => key.tick < 0)) {
    throw new RangeError('A clip-local key cannot move before source tick zero.');
  }
  shifted.sort((a, b) => a.tick - b.tick);
  for (let index = 1; index < shifted.length; index++) {
    if (shifted[index - 1].tick === shifted[index].tick) {
      throw new RangeError('A clip-local key shift cannot collide with another key.');
    }
  }
  return shifted;
}

export function shiftClipLocalKeys(clip, deltaTicks, fromSourceTick = 0) {
  const next = cloneTimelineValue(clip);
  const delta = integer(deltaTicks);
  const from = nonnegativeTick(fromSourceTick);
  if (!delta) return next;
  next.frameKeys = shiftedKeys(next.frameKeys, from, delta);
  next.propertyTracks = Object.fromEntries(Object.entries(next.propertyTracks || {}).map(
    ([name, keys]) => [name, shiftedKeys(keys, from, delta)],
  ));
  const latest = latestKeyTick(next.frameKeys, next.propertyTracks);
  next.sourceDuration = Math.max(next.sourceDuration, latest + 1);
  return next;
}

export function shiftTimelineClipKeys(
  state,
  clipId,
  deltaTicks,
  fromSourceTick = 0,
) {
  const next = cloneClipTimelineState(state);
  const index = clipIndexById(next, clipId);
  if (index < 0) return unchangedResult(next, 'missing-clip');
  if (trackById(next, next.clips[index].trackId)?.locked) {
    return unchangedResult(next, 'locked-track');
  }
  const delta = integer(deltaTicks);
  if (!delta) return unchangedResult(next, 'unchanged');
  next.clips[index] = shiftClipLocalKeys(next.clips[index], delta, fromSourceTick);
  return changedResult(next, { clip: cloneTimelineValue(next.clips[index]), deltaTicks: delta });
}

function earliestKey(keys) {
  const normalized = normalizeKeys(keys);
  return normalized.length ? normalized[0] : null;
}

function prependClipSource(clip, ticks) {
  if (ticks <= 0) return cloneTimelineValue(clip);
  const original = cloneTimelineValue(clip);
  const next = shiftClipLocalKeys(original, ticks, 0);
  next.inTick += ticks;
  next.outTick += ticks;
  next.sourceDuration = original.sourceDuration + ticks;
  const frame = heldKey(original.frameKeys, 0) || earliestKey(original.frameKeys);
  if (frame) next.frameKeys = upsertKey(next.frameKeys, { ...cloneTimelineValue(frame), tick: 0 });
  for (const [name, originalKeys] of Object.entries(original.propertyTracks || {})) {
    const key = heldKey(originalKeys, 0) || earliestKey(originalKeys);
    if (key) {
      next.propertyTracks[name] = upsertKey(
        next.propertyTracks[name],
        { ...cloneTimelineValue(key), tick: 0 },
      );
    }
  }
  return next;
}

function resizeClipEdge(clip, edge, delta, fps = DEFAULT_TIMELINE_FPS) {
  let next = cloneTimelineValue(clip);
  if (isAudioClip(next)) {
    const rate = timelineFps(fps);
    if (edge === 'start') {
      next.startTick += delta;
      next.inPoint += delta / rate;
    } else {
      next.outPoint += delta / rate;
    }
    return applyAudioTimelineBounds(next, rate);
  }
  if (edge === 'start') {
    if (next.inTick + delta < 0) next = prependClipSource(next, -(next.inTick + delta));
    next.startTick += delta;
    next.inTick += delta;
  } else {
    const outTick = next.outTick + delta;
    if (outTick > next.sourceDuration && canExtendHeldSource(next)) {
      next.sourceDuration = outTick;
    }
    next.outTick = outTick;
  }
  return next;
}

export function resizeSelectedClipEdges(
  state,
  clipIds,
  edge,
  edgeTick,
  deltaTicks,
) {
  const next = cloneClipTimelineState(state);
  const ids = new Set(iterableIds(clipIds));
  const side = edge === 'in' || edge === 'start' ? 'start'
    : edge === 'out' || edge === 'end' ? 'end' : null;
  if (!ids.size || !side) {
    return unchangedResult(next, 'invalid-selection', { resizedClipIds: [] });
  }
  const firstSelected = next.clips.find((clip) => ids.has(clip.id));
  if (!firstSelected) return unchangedResult(next, 'missing-clips', { resizedClipIds: [] });
  const sharedEdge = edgeTick == null
    ? (side === 'start' ? firstSelected.startTick : clipEndTick(firstSelected))
    : nonnegativeTick(edgeTick);
  const eligible = next.clips.filter((clip) => ids.has(clip.id) &&
    !trackById(next, clip.trackId)?.locked &&
    (side === 'start' ? clip.startTick : clipEndTick(clip)) === sharedEdge);
  if (!eligible.length) return unchangedResult(next, 'no-shared-edge', { resizedClipIds: [] });

  let minimumDelta = -Infinity;
  let maximumDelta = Infinity;
  for (const clip of eligible) {
    if (side === 'start') {
      minimumDelta = Math.max(
        minimumDelta,
        -clip.startTick,
        (isAudioClip(clip) ? 0 : priorClipEnd(next, clip)) - clip.startTick,
      );
      if (isAudioClip(clip)) {
        minimumDelta = Math.max(minimumDelta, -Math.floor(
          finiteNumber(clip.inPoint) * timelineFps(next.fps),
        ));
      }
      maximumDelta = Math.min(maximumDelta, clipEndTick(clip) - clip.startTick - 1);
    } else {
      minimumDelta = Math.max(minimumDelta, clip.startTick + 1 - clipEndTick(clip));
      if (!isAudioClip(clip)) {
        maximumDelta = Math.min(maximumDelta, nextClipStart(next, clip) - clipEndTick(clip));
      }
      if (isAudioClip(clip)) {
        maximumDelta = Math.min(
          maximumDelta,
          audioDurationTicks({ inPoint: clip.inPoint, outPoint: clip.duration }, next.fps) -
            clipDurationTicks(clip),
        );
      } else if (!canExtendHeldSource(clip)) {
        maximumDelta = Math.min(maximumDelta, clip.sourceDuration - clip.outTick);
      }
    }
  }
  const requested = integer(deltaTicks);
  const applied = Math.max(minimumDelta, Math.min(maximumDelta, requested));
  if (!Number.isFinite(applied) || !applied) {
    return unchangedResult(next, 'unchanged', {
      requestedDeltaTicks: requested,
      deltaTicks: 0,
      resizedClipIds: [],
    });
  }
  const eligibleIds = new Set(eligible.map((clip) => clip.id));
  const resizedClipIds = [];
  next.clips = next.clips.map((clip) => {
    if (!eligibleIds.has(clip.id)) return clip;
    resizedClipIds.push(clip.id);
    return resizeClipEdge(clip, side, applied, next.fps);
  });
  return changedResult(next, {
    edge: side,
    sharedEdgeTick: sharedEdge,
    requestedDeltaTicks: requested,
    deltaTicks: applied,
    resizedClipIds,
  });
}

export function validateClipTimelineState(state) {
  const errors = [];
  const trackIds = new Set();
  const allIds = new Set();
  for (const track of state?.tracks || []) {
    if (!idValue(track?.id)) errors.push('Track id is missing.');
    else if (allIds.has(track.id)) errors.push(`Duplicate timeline id: ${track.id}`);
    else {
      allIds.add(track.id);
      trackIds.add(track.id);
    }
  }
  for (const clip of state?.clips || []) {
    if (!idValue(clip?.id)) errors.push('Clip id is missing.');
    else if (allIds.has(clip.id)) errors.push(`Duplicate timeline id: ${clip.id}`);
    else allIds.add(clip.id);
    if (!trackIds.has(clip?.trackId)) errors.push(`Clip ${clip?.id} has no track.`);
    const ownerTrack = (state?.tracks || []).find((track) => track.id === clip?.trackId);
    if (isStructuralTrack(ownerTrack)) {
      errors.push(`Structural track ${clip.trackId} cannot contain clips.`);
    }
    if (ownerTrack && ((ownerTrack.kind === 'audio') !== (clip?.kind === 'audio'))) {
      errors.push(`Clip ${clip?.id} has an incompatible track kind.`);
    }
    if (!Number.isInteger(clip?.startTick) || clip.startTick < 0) {
      errors.push(`Clip ${clip?.id} has an invalid startTick.`);
    }
    if (!Number.isInteger(clip?.inTick) || !Number.isInteger(clip?.outTick) ||
      !Number.isInteger(clip?.sourceDuration) || clip.inTick < 0 ||
      clip.outTick <= clip.inTick || clip.outTick > clip.sourceDuration) {
      errors.push(`Clip ${clip?.id} has invalid source bounds.`);
    }
    if ((clip?.kind || 'visual') === 'visual' &&
      !heldKey(normalizeKeys(clip?.frameKeys), clip?.inTick)) {
      errors.push(`Visual clip ${clip?.id} has no resolvable frame at inTick.`);
    }
    if (clip?.kind === 'audio') {
      const fields = normalizedAudioFields(clip);
      if (!idValue(clip.assetId)) errors.push(`Audio clip ${clip?.id} has no asset.`);
      if (![clip.duration, clip.inPoint, clip.outPoint, clip.volume]
        .every((value) => Number.isFinite(Number(value)))) {
        errors.push(`Audio clip ${clip?.id} has invalid source metadata.`);
      }
      if (clip.duration !== fields.duration || clip.inPoint !== fields.inPoint ||
        clip.outPoint !== fields.outPoint || clip.volume !== fields.volume ||
        clip.muted !== fields.muted) {
        errors.push(`Audio clip ${clip?.id} has unnormalized source metadata.`);
      }
      if (clip.inTick !== 0 || clip.outTick !== audioDurationTicks(clip, state?.fps) ||
        clip.sourceDuration !== clip.outTick) {
        errors.push(`Audio clip ${clip?.id} has stale timeline bounds.`);
      }
      if (['asset', 'audioBuffer', 'blob', 'buffer', 'bytes', 'file']
        .some((field) => clip[field] != null)) {
        errors.push(`Audio clip ${clip?.id} contains runtime media.`);
      }
    }
  }
  try {
    const tags = normalizeTimelineTags(state?.tags);
    for (const tag of tags) {
      if (allIds.has(tag.id)) errors.push(`Duplicate timeline id: ${tag.id}`);
      else allIds.add(tag.id);
    }
    validateTimelineTagRange(tags, timelineDurationForTags(state));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const clips = state?.clips || [];
  for (let first = 0; first < clips.length; first++) {
    for (let second = first + 1; second < clips.length; second++) {
      if (clipsOverlap(clips[first], clips[second])) {
        errors.push(`Clips ${clips[first].id} and ${clips[second].id} overlap.`);
      }
    }
  }
  return errors;
}

export function createClipTimelineController(options = {}) {
  const makeId = options.makeId || options.idGenerator || runtimeId;
  let state = createClipTimelineState(options.initialState || emptyClipTimelineState());

  function commit(result) {
    state = cloneClipTimelineState(result.state);
    return { ...cloneTimelineValue(result), state: cloneClipTimelineState(state) };
  }

  return {
    getState: () => cloneClipTimelineState(state),
    captureState: () => cloneClipTimelineState(state),
    restoreState(snapshot) {
      state = createClipTimelineState(snapshot || emptyClipTimelineState());
      return cloneClipTimelineState(state);
    },
    resetState() {
      state = emptyClipTimelineState();
      return cloneClipTimelineState(state);
    },
    addTrack: (definition = {}) =>
      commit(addTimelineTrack(state, definition, { makeId })),
    updateTrack: (trackId, patch = {}) =>
      commit(updateTimelineTrack(state, trackId, patch)),
    removeTrack: (trackId) => commit(removeTimelineTrack(state, trackId)),
    addClip: (definition = {}) =>
      commit(addTimelineClip(state, definition, { makeId })),
    updateClip: (clipId, patch = {}) => commit(updateTimelineClip(state, clipId, patch)),
    addVisualClip(trackId, definition = {}) {
      return commit(addTimelineClip(
        state,
        { ...definition, trackId, kind: 'visual' },
        { makeId },
      ));
    },
    removeClip: (clipId) => commit(removeTimelineClip(state, clipId)),
    setTag: (definition = {}) => commit(setTimelineTag(state, definition, { makeId })),
    removeTag: (tagId) => commit(removeTimelineTag(state, tagId)),
    editVisualFrame: (trackId, tick, edit, editOptions = {}) =>
      commit(editVisualFrame(state, trackId, tick, edit, { ...editOptions, makeId })),
    editClipProperty: (clipId, name, tick, edit, editOptions = {}) =>
      commit(editClipProperty(state, clipId, name, tick, edit, editOptions)),
    trimClip: (clipId, edge, tick) => commit(trimTimelineClip(state, clipId, edge, tick)),
    moveClip: (clipId, tick, moveOptions = {}) =>
      commit(moveTimelineClip(state, clipId, tick, moveOptions)),
    duplicateClips: (operations, duplicateOptions = {}) =>
      commit(duplicateTimelineClips(state, operations, { ...duplicateOptions, makeId })),
    razorSplitClip: (clipId, tick, splitOptions = {}) =>
      commit(razorSplitClip(state, clipId, tick, { ...splitOptions, makeId })),
    razorSplitAtTick: (tick, splitOptions = {}) =>
      commit(razorSplitAtTick(state, tick, { ...splitOptions, makeId })),
    deleteSelection: (selection, deleteOptions = {}) =>
      commit(deleteTimelineSelection(state, selection, deleteOptions)),
    rippleDeleteGap: (trackIds, start, end, rippleOptions = {}) =>
      commit(rippleDeleteGap(state, trackIds, start, end, rippleOptions)),
    addEmptyTime: (tick, duration) =>
      commit(addEmptyTime(state, tick, duration, { makeId })),
    shiftClipKeys: (clipId, delta, from = 0) =>
      commit(shiftTimelineClipKeys(state, clipId, delta, from)),
    resizeSelectedClipEdges: (clipIds, edge, edgeTick, delta) =>
      commit(resizeSelectedClipEdges(state, clipIds, edge, edgeTick, delta)),
    setFps: (fps) => commit(setClipTimelineFps(state, fps)),
  };
}
