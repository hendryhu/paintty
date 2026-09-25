import { isUuid } from './uuid.js';
import type {
  RuntimeTimelineTag,
  TimelineTag,
  TimelineTagType,
  TimelineTickRange,
} from './types/timeline-models.js';

export const TIMELINE_TAG_TYPES = Object.freeze(['loop-start', 'loop-end', 'custom']);
export const TIMELINE_TAG_TYPE_ORDER = Object.freeze({
  'loop-start': 0,
  custom: 1,
  'loop-end': 2,
});

const TAG_FIELDS: ReadonlySet<string> = new Set(['id', 'tick', 'type', 'value']);
const RUNTIME_TAG_FIELDS: ReadonlySet<string> = new Set(['tick', 'type', 'value']);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new TypeError(`${label} contains unsupported field ${field}.`);
  }
}

function tagTick(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} tick must be a nonnegative integer.`);
  }
  return value;
}

function tagType(value: unknown, label: string): TimelineTagType {
  if (value === 'loop-start' || value === 'loop-end' || value === 'custom') return value;
  throw new TypeError(`${label} type is invalid.`);
}

function tagValue(
  value: unknown,
  type: TimelineTagType,
  label: string,
  { requireTrimmed = true }: { requireTrimmed?: boolean } = {},
): string | undefined {
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

export function normalizeTimelineTag(
  value: unknown,
  label = 'Timeline tag',
  options: { requireTrimmed?: boolean } = {},
): TimelineTag {
  if (!record(value)) throw new TypeError(`${label} must be an object.`);
  assertFields(value, TAG_FIELDS, label);
  if (!isUuid(value['id'])) throw new TypeError(`${label} ID must be an RFC 4122 UUID.`);
  const type = tagType(value['type'], label);
  const id = value['id'];
  if (typeof id !== 'string') throw new TypeError(`${label} ID must be an RFC 4122 UUID.`);
  const tick = tagTick(value['tick'], label);
  const customValue = tagValue(value['value'], type, label, options);
  if (type !== 'custom') return { id, tick, type };
  if (customValue === undefined) throw new TypeError(`${label} custom value must be text.`);
  return { id, tick, type, value: customValue };
}

export function normalizeRuntimeTimelineTag(
  value: unknown,
  label = 'Runtime tag',
): RuntimeTimelineTag {
  if (!record(value)) throw new TypeError(`${label} must be an object.`);
  assertFields(value, RUNTIME_TAG_FIELDS, label);
  const type = tagType(value['type'], label);
  const tick = tagTick(value['tick'], label);
  const customValue = tagValue(value['value'], type, label);
  if (type !== 'custom') return { tick, type };
  if (customValue === undefined) throw new TypeError(`${label} custom value must be text.`);
  return { tick, type, value: customValue };
}

export function normalizeTimelineTags(
  source: unknown,
  options: { allowMissing?: boolean; requireTrimmed?: boolean } = {},
): TimelineTag[] {
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

export function validateTimelineTagRange(tags: TimelineTag[], durationTicks: unknown): TimelineTag[] {
  const duration = Math.max(1, Math.round(Number(durationTicks)) || 1);
  for (const tag of tags || []) {
    if (tag.tick >= duration) {
      throw new RangeError(`Timeline tag ${tag.id} tick must be inside the sequence.`);
    }
  }
  return tags;
}

export function clampTimelineTags(tags: TimelineTag[], durationTicks: unknown): TimelineTag[] {
  const lastTick = Math.max(0, (Math.round(Number(durationTicks)) || 1) - 1);
  return (tags || []).map((tag) => ({ ...tag, tick: Math.min(tag.tick, lastTick) }));
}

export function compareRuntimeTimelineTags(first: RuntimeTimelineTag, second: RuntimeTimelineTag): number {
  const firstValue = first.type === 'custom' ? first.value : '';
  const secondValue = second.type === 'custom' ? second.value : '';
  return first.tick - second.tick ||
    TIMELINE_TAG_TYPE_ORDER[first.type] - TIMELINE_TAG_TYPE_ORDER[second.type] ||
    (firstValue < secondValue ? -1 : firstValue > secondValue ? 1 : 0);
}

export function runtimeTimelineTags(tags: unknown, durationTicks: unknown = Infinity): RuntimeTimelineTag[] {
  const maximum = Number.isFinite(Number(durationTicks))
    ? Math.max(1, Math.round(Number(durationTicks)) || 1)
    : Infinity;
  return normalizeTimelineTags(tags, { allowMissing: true }).map((tag): RuntimeTimelineTag => {
    if (tag.tick >= maximum) {
      throw new RangeError(`Timeline tag ${tag.id} tick must be inside the exported sequence.`);
    }
    return tag.type === 'custom'
      ? { tick: tag.tick, type: tag.type, value: tag.value }
      : { tick: tag.tick, type: tag.type };
  }).sort(compareRuntimeTimelineTags);
}

export function validLoopRange(tags: TimelineTag[], durationTicks: unknown): TimelineTickRange | null {
  const duration = Math.max(1, Math.round(Number(durationTicks)) || 1);
  const start = (tags || []).find((tag) => tag.type === 'loop-start');
  const end = (tags || []).find((tag) => tag.type === 'loop-end');
  if (!start || start.tick >= duration) return null;
  // A missing end is normalized to the inclusive sequence end; end-only and reversed pairs stay invalid.
  if (!end) return { startTick: start.tick, endTick: duration - 1 };
  if (start.tick > end.tick || end.tick >= duration) return null;
  return { startTick: start.tick, endTick: end.tick };
}

export function playbackTickRange(
  tags: TimelineTag[],
  durationTicks: unknown,
  looping: unknown,
): TimelineTickRange {
  const duration = Math.max(1, Math.round(Number(durationTicks)) || 1);
  if (looping) {
    const range = validLoopRange(tags, duration);
    if (range) return range;
  }
  return { startTick: 0, endTick: duration - 1 };
}

export function playbackStartTick(
  currentTick: unknown,
  tags: TimelineTag[],
  durationTicks: unknown,
  looping: unknown,
): number {
  const range = playbackTickRange(tags, durationTicks, looping);
  const current = Math.max(0, Math.min(
    Math.max(0, (Math.round(Number(durationTicks)) || 1) - 1),
    Math.round(Number(currentTick)) || 0,
  ));
  return current < range.startTick || current > range.endTick ? range.startTick : current;
}

export function nextPlaybackTick(
  currentTick: unknown,
  tags: TimelineTag[],
  durationTicks: unknown,
  looping: unknown,
): { tick: number; stopped: boolean; wrapped: boolean } {
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
