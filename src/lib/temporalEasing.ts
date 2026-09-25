import type {
  TimelineInterpolation,
  TimelineKeyValue,
  TimelineTemporalEase,
  TimelineTemporalHandle,
  TimelineTemporalSide,
} from './types/timeline-models.js';

const INTERPOLATIONS: ReadonlySet<TimelineInterpolation> = new Set([
  'linear', 'ease-in', 'ease-out', 'ease-in-out',
]);
const SIDES: ReadonlySet<TimelineTemporalSide> = new Set(['in', 'out']);

export const LINEAR_TEMPORAL_HANDLE = Object.freeze({ time: 1 / 3, value: 1 / 3 });
export const SLOW_TEMPORAL_HANDLE = Object.freeze({ time: 1 / 3, value: 0 });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteUnit(value: unknown): number | null {
  if (value !== null && !['number', 'string', 'boolean'].includes(typeof value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

function isTimelineInterpolation(value: unknown): value is TimelineInterpolation {
  return value === 'linear' || value === 'ease-in' ||
    value === 'ease-out' || value === 'ease-in-out';
}

export function validInterpolation(value: unknown): TimelineInterpolation {
  return isTimelineInterpolation(value) && INTERPOLATIONS.has(value) ? value : 'linear';
}

export function normalizeTemporalHandle(handle: unknown): TimelineTemporalHandle | null {
  if (!record(handle)) return null;
  const time = finiteUnit(handle['time']);
  const value = finiteUnit(handle['value']);
  return time == null || value == null ? null : { time, value };
}

export function normalizeTemporalEase(ease: unknown): TimelineTemporalEase | null {
  if (!record(ease)) return null;
  const incoming = normalizeTemporalHandle(ease['in']);
  const outgoing = normalizeTemporalHandle(ease['out']);
  if (!incoming && !outgoing) return null;
  return {
    ...(incoming ? { in: incoming } : {}),
    ...(outgoing ? { out: outgoing } : {}),
  };
}

export function clonePositionKey(key: unknown): TimelineKeyValue {
  const source = record(key) ? key : {};
  const temporalEase = normalizeTemporalEase(source['temporalEase']);
  const cloned = {
    ...source,
    interpolation: validInterpolation(source['interpolation']),
    ...(temporalEase ? { temporalEase } : {}),
  };
  if (!temporalEase) delete cloned.temporalEase;
  return cloned;
}

export function temporalHandleEqual(a: unknown, b: unknown): boolean {
  const left = normalizeTemporalHandle(a);
  const right = normalizeTemporalHandle(b);
  if (!left || !right) return left === right;
  return left.time === right.time && left.value === right.value;
}

export function withTemporalEaseSide(
  key: unknown,
  side: unknown,
  handle: unknown,
): TimelineKeyValue {
  if (side !== 'in' && side !== 'out') {
    return clonePositionKey(key);
  }
  const source = record(key) ? key : {};
  const temporalEase = normalizeTemporalEase(source['temporalEase']) || {};
  const normalized = normalizeTemporalHandle(handle);
  if (side === 'in') {
    if (normalized) temporalEase.in = normalized;
    else delete temporalEase.in;
  } else if (normalized) temporalEase.out = normalized;
  else delete temporalEase.out;
  const next: TimelineKeyValue = {
    ...source,
    interpolation: validInterpolation(source['interpolation']),
  };
  if (temporalEase.in || temporalEase.out) next.temporalEase = temporalEase;
  else delete next.temporalEase;
  return next;
}

export function interpolateLegacyProgress(t: number, preset: unknown): number {
  if (preset === 'ease-in') return t * t;
  if (preset === 'ease-out') return 1 - (1 - t) * (1 - t);
  if (preset === 'ease-in-out') return t < 0.5
    ? 2 * t * t
    : 1 - ((-2 * t + 2) ** 2) / 2;
  return t;
}

function cubicCoordinate(t: number, first: number, second: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first +
    3 * inverse * t * t * second + t * t * t;
}

export function interpolateTemporalProgress(
  progress: unknown,
  source: unknown,
  destination: unknown,
): number {
  const t = Math.max(0, Math.min(1, Number(progress) || 0));
  if (t === 0 || t === 1) return t;
  const sourceRecord = record(source) ? source : {};
  const destinationRecord = record(destination) ? destination : {};
  const outgoing = normalizeTemporalEase(sourceRecord['temporalEase'])?.out || null;
  const incoming = normalizeTemporalEase(destinationRecord['temporalEase'])?.in || null;
  if (!outgoing && !incoming) {
    return interpolateLegacyProgress(t, validInterpolation(sourceRecord['interpolation']));
  }

  const first = outgoing || LINEAR_TEMPORAL_HANDLE;
  const incomingOffset = incoming || LINEAR_TEMPORAL_HANDLE;
  const second = {
    time: 1 - incomingOffset.time,
    value: 1 - incomingOffset.value,
  };
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 24; iteration++) {
    const candidate = (low + high) / 2;
    if (cubicCoordinate(candidate, first.time, second.time) < t) low = candidate;
    else high = candidate;
  }
  return cubicCoordinate((low + high) / 2, first.value, second.value);
}

export function reversedInterpolation(value: unknown): TimelineInterpolation {
  if (value === 'ease-in') return 'ease-out';
  if (value === 'ease-out') return 'ease-in';
  return validInterpolation(value);
}

export function reversedTemporalEase(ease: unknown): TimelineTemporalEase | null {
  const normalized = normalizeTemporalEase(ease);
  if (!normalized) return null;
  return {
    ...(normalized.out ? { in: { ...normalized.out } } : {}),
    ...(normalized.in ? { out: { ...normalized.in } } : {}),
  };
}

export function reversePositionTrack(
  source: unknown,
  from: number,
  to: number,
): Record<number, TimelineKeyValue> {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const entries = Object.entries(record(source) ? source : {})
    .map(([frame, key]) => [Number(frame), clonePositionKey(key)])
    .filter((entry): entry is [number, TimelineKeyValue] => Number.isInteger(entry[0]))
    .sort((left, right) => left[0] - right[0]);
  const output: Record<number, TimelineKeyValue> = {};

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const [frame, key] = entry;
    if (frame < lo || frame > hi) {
      output[frame] = key;
      continue;
    }
    const mappedFrame = lo + hi - frame;
    const reversedEase = reversedTemporalEase(key.temporalEase);
    const priorEntry = entries[index - 1];
    const previous = index > 0 && priorEntry && priorEntry[0] >= lo
      ? priorEntry[1]
      : null;
    const reversed = {
      ...key,
      interpolation: previous
        ? reversedInterpolation(previous.interpolation)
        : 'linear',
    };
    if (reversedEase) reversed.temporalEase = reversedEase;
    else delete reversed.temporalEase;
    output[mappedFrame] = reversed;
  }
  return output;
}
