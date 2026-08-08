import {
  LINEAR_TEMPORAL_HANDLE,
  SLOW_TEMPORAL_HANDLE,
  interpolateTemporalProgress,
  normalizeTemporalEase,
  normalizeTemporalHandle,
  validInterpolation,
} from './temporalEasing.js';

function clampUnit(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function point(x, value, height, inset) {
  return { x, y: inset + (1 - value) * (height - inset * 2) };
}

function format(value) {
  return Number(value.toFixed(3));
}

function pathFromPoints(points) {
  return points.map((entry, index) =>
    `${index ? 'L' : 'M'}${format(entry.x)} ${format(entry.y)}`).join(' ');
}

function legacyHandle(interpolation, side) {
  const preset = validInterpolation(interpolation);
  if (preset === 'ease-in') {
    return side === 'out' ? SLOW_TEMPORAL_HANDLE : { time: 1 / 3, value: 2 / 3 };
  }
  if (preset === 'ease-out') {
    return side === 'out' ? { time: 1 / 3, value: 2 / 3 } : SLOW_TEMPORAL_HANDLE;
  }
  if (preset === 'ease-in-out') return SLOW_TEMPORAL_HANDLE;
  return LINEAR_TEMPORAL_HANDLE;
}

function optionsWithDefaults(options = {}) {
  const frameWidth = Math.max(1, Number(options.frameWidth) || 22);
  const height = Math.max(8, Number(options.height) || 48);
  const requestedInset = Number(options.inset);
  const inset = Math.max(0, Math.min(height / 2 - 1,
    Number.isFinite(requestedInset) ? requestedInset : 5));
  const samples = Math.max(4, Math.round(Number(options.samples) || 24));
  return { frameWidth, height, inset, samples };
}

export function orderedTemporalKeys(keys) {
  return (Array.isArray(keys) ? keys : [])
    .filter((key) => Number.isInteger(key?.frame))
    .slice()
    .sort((left, right) => left.frame - right.frame);
}

export function temporalCurveSegments(keys, options = {}) {
  const ordered = orderedTemporalKeys(keys);
  const { frameWidth, height, inset, samples } = optionsWithDefaults(options);
  const segments = [];

  for (let index = 0; index < ordered.length - 1; index++) {
    const source = ordered[index];
    const destination = ordered[index + 1];
    if (destination.frame <= source.frame) continue;
    const startX = source.frame * frameWidth + frameWidth / 2;
    const endX = destination.frame * frameWidth + frameWidth / 2;
    const span = endX - startX;
    const sourceEase = normalizeTemporalEase(source.temporalEase);
    const destinationEase = normalizeTemporalEase(destination.temporalEase);
    const outgoing = sourceEase?.out || null;
    const incoming = destinationEase?.in || null;
    let path;

    if (outgoing || incoming) {
      const first = outgoing || LINEAR_TEMPORAL_HANDLE;
      const last = incoming || LINEAR_TEMPORAL_HANDLE;
      const p0 = point(startX, 0, height, inset);
      const p1 = point(startX + span * first.time, first.value, height, inset);
      const p2 = point(endX - span * last.time, 1 - last.value, height, inset);
      const p3 = point(endX, 1, height, inset);
      path = `M${format(p0.x)} ${format(p0.y)} C${format(p1.x)} ${format(p1.y)} ${format(p2.x)} ${format(p2.y)} ${format(p3.x)} ${format(p3.y)}`;
    } else {
      const points = [];
      for (let sample = 0; sample <= samples; sample++) {
        const progress = sample / samples;
        points.push(point(
          startX + span * progress,
          interpolateTemporalProgress(progress, source, destination),
          height,
          inset,
        ));
      }
      path = pathFromPoints(points);
    }

    segments.push({
      sourceFrame: source.frame,
      destinationFrame: destination.frame,
      path,
      custom: !!(outgoing || incoming),
    });
  }
  return segments;
}

function handleGeometry(ordered, keyIndex, side, options) {
  const index = Number(keyIndex);
  if (!Number.isInteger(index) || !ordered[index] || (side !== 'in' && side !== 'out')) return null;
  const adjacentIndex = side === 'in' ? index - 1 : index + 1;
  const adjacent = ordered[adjacentIndex];
  if (!adjacent) return null;

  const key = ordered[index];
  const source = side === 'out' ? key : adjacent;
  const destination = side === 'in' ? key : adjacent;
  const { frameWidth, height, inset } = optionsWithDefaults(options);
  const span = (destination.frame - source.frame) * frameWidth;
  if (span <= 0) return null;
  const explicit = normalizeTemporalEase(key.temporalEase)?.[side] || null;
  const segmentCustom = !!(
    normalizeTemporalEase(source.temporalEase)?.out ||
    normalizeTemporalEase(destination.temporalEase)?.in
  );
  const handle = explicit || (segmentCustom
    ? LINEAR_TEMPORAL_HANDLE
    : legacyHandle(source.interpolation, side));
  const origin = side === 'out'
    ? point(source.frame * frameWidth + frameWidth / 2, 0, height, inset)
    : point(destination.frame * frameWidth + frameWidth / 2, 1, height, inset);
  const control = side === 'out'
    ? point(origin.x + span * handle.time, handle.value, height, inset)
    : point(origin.x - span * handle.time, 1 - handle.value, height, inset);

  return {
    frame: key.frame,
    side,
    adjacentFrame: adjacent.frame,
    origin,
    control,
    handle: { ...handle },
    explicit: !!explicit,
  };
}

export function temporalHandleGeometry(keys, keyIndex, side, options = {}) {
  return handleGeometry(orderedTemporalKeys(keys), keyIndex, side, options);
}

export function selectedTemporalHandles(keys, selectedFrames, options = {}) {
  const ordered = orderedTemporalKeys(keys);
  const selected = selectedFrames instanceof Set ? selectedFrames : new Set(selectedFrames || []);
  const handles = [];
  ordered.forEach((key, index) => {
    if (!selected.has(key.frame)) return;
    const incoming = handleGeometry(ordered, index, 'in', options);
    const outgoing = handleGeometry(ordered, index, 'out', options);
    if (incoming) handles.push(incoming);
    if (outgoing) handles.push(outgoing);
  });
  return handles;
}

export function temporalHandleFromPoint(side, frame, adjacentFrame, x, y, options = {}) {
  if ((side !== 'in' && side !== 'out') || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    return null;
  }
  const { frameWidth, height, inset } = optionsWithDefaults(options);
  const frameValue = Number(frame);
  const adjacentValue = Number(adjacentFrame);
  const span = Math.abs(frameValue - adjacentValue) * frameWidth;
  if (!Number.isInteger(frameValue) || !Number.isInteger(adjacentValue) || span <= 0) return null;
  const originX = frameValue * frameWidth + frameWidth / 2;
  const drawableHeight = height - inset * 2;
  const time = side === 'out'
    ? (Number(x) - originX) / span
    : (originX - Number(x)) / span;
  const value = side === 'out'
    ? (height - inset - Number(y)) / drawableHeight
    : (Number(y) - inset) / drawableHeight;
  return normalizeTemporalHandle({ time: clampUnit(time), value: clampUnit(value) });
}
