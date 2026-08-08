const INTERPOLATIONS = new Set(['linear', 'ease-in', 'ease-out', 'ease-in-out']);
const SIDES = new Set(['in', 'out']);

export const LINEAR_TEMPORAL_HANDLE = Object.freeze({ time: 1 / 3, value: 1 / 3 });
export const SLOW_TEMPORAL_HANDLE = Object.freeze({ time: 1 / 3, value: 0 });

function finiteUnit(value) {
  if (value !== null && !['number', 'string', 'boolean'].includes(typeof value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

export function validInterpolation(value) {
  return INTERPOLATIONS.has(value) ? value : 'linear';
}

export function normalizeTemporalHandle(handle) {
  if (!handle || typeof handle !== 'object' || Array.isArray(handle)) return null;
  const time = finiteUnit(handle.time);
  const value = finiteUnit(handle.value);
  return time == null || value == null ? null : { time, value };
}

export function normalizeTemporalEase(ease) {
  if (!ease || typeof ease !== 'object' || Array.isArray(ease)) return null;
  const incoming = normalizeTemporalHandle(ease.in);
  const outgoing = normalizeTemporalHandle(ease.out);
  if (!incoming && !outgoing) return null;
  return {
    ...(incoming ? { in: incoming } : {}),
    ...(outgoing ? { out: outgoing } : {}),
  };
}

export function clonePositionKey(key) {
  const temporalEase = normalizeTemporalEase(key?.temporalEase);
  const cloned = {
    ...key,
    interpolation: validInterpolation(key?.interpolation),
    ...(temporalEase ? { temporalEase } : {}),
  };
  if (!temporalEase) delete cloned.temporalEase;
  return cloned;
}

export function temporalHandleEqual(a, b) {
  const left = normalizeTemporalHandle(a);
  const right = normalizeTemporalHandle(b);
  if (!left || !right) return left === right;
  return left.time === right.time && left.value === right.value;
}

export function withTemporalEaseSide(key, side, handle) {
  if (!SIDES.has(side)) return clonePositionKey(key);
  const temporalEase = normalizeTemporalEase(key?.temporalEase) || {};
  const normalized = normalizeTemporalHandle(handle);
  if (normalized) temporalEase[side] = normalized;
  else delete temporalEase[side];
  const next = { ...key, interpolation: validInterpolation(key?.interpolation) };
  if (temporalEase.in || temporalEase.out) next.temporalEase = temporalEase;
  else delete next.temporalEase;
  return next;
}

export function interpolateLegacyProgress(t, preset) {
  if (preset === 'ease-in') return t * t;
  if (preset === 'ease-out') return 1 - (1 - t) * (1 - t);
  if (preset === 'ease-in-out') return t < 0.5
    ? 2 * t * t
    : 1 - ((-2 * t + 2) ** 2) / 2;
  return t;
}

function cubicCoordinate(t, first, second) {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first +
    3 * inverse * t * t * second + t * t * t;
}

export function interpolateTemporalProgress(progress, source, destination) {
  const t = Math.max(0, Math.min(1, Number(progress) || 0));
  if (t === 0 || t === 1) return t;
  const outgoing = normalizeTemporalEase(source?.temporalEase)?.out || null;
  const incoming = normalizeTemporalEase(destination?.temporalEase)?.in || null;
  if (!outgoing && !incoming) {
    return interpolateLegacyProgress(t, validInterpolation(source?.interpolation));
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

export function reversedInterpolation(value) {
  if (value === 'ease-in') return 'ease-out';
  if (value === 'ease-out') return 'ease-in';
  return validInterpolation(value);
}

export function reversedTemporalEase(ease) {
  const normalized = normalizeTemporalEase(ease);
  if (!normalized) return null;
  return {
    ...(normalized.out ? { in: { ...normalized.out } } : {}),
    ...(normalized.in ? { out: { ...normalized.in } } : {}),
  };
}

export function reversePositionTrack(source, from, to) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const entries = Object.entries(source || {})
    .map(([frame, key]) => [Number(frame), clonePositionKey(key)])
    .filter(([frame]) => Number.isInteger(frame))
    .sort(([a], [b]) => a - b);
  const output = {};

  for (let index = 0; index < entries.length; index++) {
    const [frame, key] = entries[index];
    if (frame < lo || frame > hi) {
      output[frame] = key;
      continue;
    }
    const mappedFrame = lo + hi - frame;
    const reversedEase = reversedTemporalEase(key.temporalEase);
    const previous = index > 0 && entries[index - 1][0] >= lo
      ? entries[index - 1][1]
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
