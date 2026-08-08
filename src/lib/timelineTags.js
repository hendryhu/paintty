import { isUuid } from './uuid.js';

export const TIMELINE_TAG_TYPES = Object.freeze(['loop-start', 'loop-end', 'custom']);
export const TIMELINE_TAG_TYPE_ORDER = Object.freeze({
  'loop-start': 0,
  custom: 1,
  'loop-end': 2,
});

const TAG_FIELDS = new Set(['id', 'tick', 'type', 'value']);
const RUNTIME_TAG_FIELDS = new Set(['tick', 'type', 'value']);

function record(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new TypeError(`${label} contains unsupported field ${field}.`);
  }
}

function tagTick(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} tick must be a nonnegative integer.`);
  }
  return value;
}

function tagType(value, label) {
  if (!TIMELINE_TAG_TYPES.includes(value)) {
    throw new TypeError(`${label} type is invalid.`);
  }
  return value;
}

function tagValue(value, type, label, { requireTrimmed = true } = {}) {
  if (type !== 'custom') {
    if (value !== undefined) throw new TypeError(`${label} loop marker must omit value.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new TypeError(`${label} custom value must be text.`);
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${label} custom value must not be empty.`);
  if (requireTrimmed && value !== trimmed) {
    throw new TypeError(`${label} custom value must be trimmed.`);
  }
  return trimmed;
}

export function normalizeTimelineTag(value, label = 'Timeline tag', options = {}) {
  if (!record(value)) throw new TypeError(`${label} must be an object.`);
  assertFields(value, TAG_FIELDS, label);
  if (!isUuid(value.id)) throw new TypeError(`${label} ID must be an RFC 4122 UUID.`);
  const type = tagType(value.type, label);
  const normalized = {
    id: value.id,
    tick: tagTick(value.tick, label),
    type,
  };
  const customValue = tagValue(value.value, type, label, options);
  if (customValue !== undefined) normalized.value = customValue;
  return normalized;
}

export function normalizeRuntimeTimelineTag(value, label = 'Runtime tag') {
  if (!record(value)) throw new TypeError(`${label} must be an object.`);
  assertFields(value, RUNTIME_TAG_FIELDS, label);
  const type = tagType(value.type, label);
  const normalized = { tick: tagTick(value.tick, label), type };
  const customValue = tagValue(value.value, type, label);
  if (customValue !== undefined) normalized.value = customValue;
  return normalized;
}

export function normalizeTimelineTags(source, options = {}) {
  if (source == null && options.allowMissing) return [];
  if (!Array.isArray(source)) throw new TypeError('Timeline tags must be an array.');
  const ids = new Set();
  const singletonTypes = new Set();
  return source.map((value, index) => {
    const tag = normalizeTimelineTag(value, `Timeline tag ${index + 1}`, options);
    const id = tag.id.toLowerCase();
    if (ids.has(id)) throw new TypeError(`Duplicate timeline tag ID ${tag.id}.`);
    ids.add(id);
    if (tag.type !== 'custom') {
      if (singletonTypes.has(tag.type)) {
        throw new TypeError(`Timeline may contain only one ${tag.type} marker.`);
      }
      singletonTypes.add(tag.type);
    }
    return tag;
  });
}

export function validateTimelineTagRange(tags, durationTicks) {
  const duration = Math.max(1, Math.round(Number(durationTicks)) || 1);
  for (const tag of tags || []) {
    if (tag.tick >= duration) {
      throw new RangeError(`Timeline tag ${tag.id} tick must be inside the sequence.`);
    }
  }
  return tags;
}

export function clampTimelineTags(tags, durationTicks) {
  const lastTick = Math.max(0, (Math.round(Number(durationTicks)) || 1) - 1);
  return (tags || []).map((tag) => ({ ...tag, tick: Math.min(tag.tick, lastTick) }));
}

export function compareRuntimeTimelineTags(first, second) {
  const firstValue = String(first.value ?? '');
  const secondValue = String(second.value ?? '');
  return first.tick - second.tick ||
    TIMELINE_TAG_TYPE_ORDER[first.type] - TIMELINE_TAG_TYPE_ORDER[second.type] ||
    (firstValue < secondValue ? -1 : firstValue > secondValue ? 1 : 0);
}

export function runtimeTimelineTags(tags, durationTicks = Infinity) {
  const maximum = Number.isFinite(durationTicks)
    ? Math.max(1, Math.round(Number(durationTicks)) || 1)
    : Infinity;
  return normalizeTimelineTags(tags, { allowMissing: true }).map((tag) => {
    if (tag.tick >= maximum) {
      throw new RangeError(`Timeline tag ${tag.id} tick must be inside the exported sequence.`);
    }
    return {
      tick: tag.tick,
      type: tag.type,
      ...(tag.type === 'custom' ? { value: tag.value } : {}),
    };
  }).sort(compareRuntimeTimelineTags);
}

export function validLoopRange(tags, durationTicks) {
  const duration = Math.max(1, Math.round(Number(durationTicks)) || 1);
  const start = (tags || []).find((tag) => tag.type === 'loop-start');
  const end = (tags || []).find((tag) => tag.type === 'loop-end');
  if (!start || start.tick >= duration) return null;
  // A missing end is normalized to the inclusive sequence end; end-only and reversed pairs stay invalid.
  if (!end) return { startTick: start.tick, endTick: duration - 1 };
  if (start.tick > end.tick || end.tick >= duration) return null;
  return { startTick: start.tick, endTick: end.tick };
}

export function playbackTickRange(tags, durationTicks, looping) {
  const duration = Math.max(1, Math.round(Number(durationTicks)) || 1);
  if (looping) {
    const range = validLoopRange(tags, duration);
    if (range) return range;
  }
  return { startTick: 0, endTick: duration - 1 };
}

export function playbackStartTick(currentTick, tags, durationTicks, looping) {
  const range = playbackTickRange(tags, durationTicks, looping);
  const current = Math.max(0, Math.min(
    Math.max(0, (Math.round(Number(durationTicks)) || 1) - 1),
    Math.round(Number(currentTick)) || 0,
  ));
  return current < range.startTick || current > range.endTick ? range.startTick : current;
}

export function nextPlaybackTick(currentTick, tags, durationTicks, looping) {
  const current = Math.round(Number(currentTick)) || 0;
  const taggedRange = looping ? validLoopRange(tags, durationTicks) : null;
  if (taggedRange) {
    if (current < taggedRange.startTick || current >= taggedRange.endTick) {
      return { tick: taggedRange.startTick, stopped: false, wrapped: true };
    }
    return { tick: current + 1, stopped: false, wrapped: false };
  }
  const range = playbackTickRange(tags, durationTicks, looping);
  const next = current + 1;
  if (next <= range.endTick) return { tick: next, stopped: false, wrapped: false };
  if (looping) return { tick: range.startTick, stopped: false, wrapped: true };
  return { tick: range.endTick, stopped: true, wrapped: false };
}
