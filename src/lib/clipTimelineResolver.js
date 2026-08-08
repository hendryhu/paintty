import {
  clipContainsTick,
  clipSourceTickAt,
  cloneTimelineValue,
  maxClipEnd,
} from './clipTimeline.js';
import {
  interpolateShapePath,
  interpolateShapePathComponent,
  normalizeShapePathComponentId,
  normalizeShapePathComponentValue,
  normalizeShapePathKey,
  pathValueFromShape,
  shapePathComponentValue,
  shapeWithPathValue,
  withShapePathComponentValue,
  SHAPE_PATH_COMPONENT_ROTATION,
} from './shapePath.js';
import { constrainShape, renderShapeToCells } from './shapes.js';
import { normalizeTextRuns, renderTextToCells } from './textLayer.js';
import { interpolateTemporalProgress } from './temporalEasing.js';

export const DEFAULT_CLIP_TIMELINE_FPS = 24;
export const CLIP_TIMELINE_PROPERTIES = Object.freeze({
  position: 'position',
  visibility: 'visibility',
  effectIntensity: 'effectIntensity',
  maskOpacity: 'maskOpacity',
  maskPosition: 'maskPosition',
  shapePath: 'shapePath',
});
const SHAPE_ANCHOR_COMPENSATION = 'shapeAnchorCompensation';

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function sameId(first, second) {
  return first != null && second != null && String(first) === String(second);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function cloneCells(cells) {
  return Object.fromEntries(Object.entries(cells || {}).map(([key, cell]) => [
    key,
    cell && typeof cell === 'object' ? { ...cell } : cell,
  ]));
}

function roundedPosition(value) {
  return {
    x: Math.round(Number(value?.x) || 0) || 0,
    y: Math.round(Number(value?.y) || 0) || 0,
  };
}

function keyRecords(source) {
  const entries = source instanceof Map
    ? [...source.entries()]
    : Array.isArray(source)
      ? source.map((key) => [key?.tick, key])
      : source && typeof source === 'object' ? Object.entries(source) : [];
  const byTick = new Map();
  for (const [rawTick, raw] of entries) {
    const tick = integer(raw && typeof raw === 'object' && own(raw, 'tick') ? raw.tick : rawTick, -1);
    if (tick < 0) continue;
    const key = raw && typeof raw === 'object' && own(raw, 'tick')
      ? cloneTimelineValue(raw)
      : { tick, value: cloneTimelineValue(raw) };
    key.tick = tick;
    byTick.set(tick, key);
  }
  return [...byTick.values()].sort((first, second) => first.tick - second.tick);
}

function heldKey(source, tick) {
  let result = null;
  for (const key of keyRecords(source)) {
    if (key.tick > tick) break;
    result = key;
  }
  return result;
}

function keyValue(key) {
  return key && own(key, 'value') ? key.value : null;
}

function neighboringKeys(source, tick) {
  const keys = keyRecords(source);
  if (!keys.length) return { lower: null, upper: null };
  if (tick <= keys[0].tick) return { lower: keys[0], upper: keys[0] };
  if (tick >= keys.at(-1).tick) return { lower: keys.at(-1), upper: keys.at(-1) };
  let lower = keys[0];
  let upper = keys.at(-1);
  for (const key of keys) {
    if (key.tick <= tick) lower = key;
    if (key.tick >= tick) {
      upper = key;
      break;
    }
  }
  return { lower, upper };
}

function interpolatePosition(source, tick, fallback = { x: 0, y: 0 }) {
  const { lower, upper } = neighboringKeys(source, tick);
  if (!lower || !upper) return roundedPosition(fallback);
  const first = keyValue(lower);
  if (lower.tick === upper.tick) return roundedPosition(first);
  const second = keyValue(upper);
  const progress = interpolateTemporalProgress(
    (tick - lower.tick) / (upper.tick - lower.tick),
    first,
    second,
  );
  return roundedPosition({
    x: (Number(first?.x) || 0) + ((Number(second?.x) || 0) - (Number(first?.x) || 0)) * progress,
    y: (Number(first?.y) || 0) + ((Number(second?.y) || 0) - (Number(first?.y) || 0)) * progress,
  });
}

function interpolatePoint(source, tick, fallback = { x: 0, y: 0 }) {
  const point = (value) => ({ x: Number(value?.x) || 0, y: Number(value?.y) || 0 });
  const { lower, upper } = neighboringKeys(source, tick);
  if (!lower || !upper) return point(fallback);
  const first = point(keyValue(lower));
  if (lower.tick === upper.tick) return first;
  const second = point(keyValue(upper));
  const progress = interpolateTemporalProgress(
    (tick - lower.tick) / (upper.tick - lower.tick),
    keyValue(lower),
    keyValue(upper),
  );
  return {
    x: first.x + (second.x - first.x) * progress,
    y: first.y + (second.y - first.y) * progress,
  };
}

function interpolateScalar(source, tick, fallback, min, max) {
  const clamp = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };
  const { lower, upper } = neighboringKeys(source, tick);
  if (!lower || !upper) return clamp(fallback);
  const first = clamp(keyValue(lower));
  if (lower.tick === upper.tick) return first;
  const second = clamp(keyValue(upper));
  const progress = interpolateTemporalProgress(
    (tick - lower.tick) / (upper.tick - lower.tick),
    keyValue(lower),
    keyValue(upper),
  );
  return clamp(first + (second - first) * progress);
}

function shapePathEntryIsEnvelope(value) {
  return !!value && typeof value === 'object' && (own(value, 'path') || own(value, 'components'));
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

function componentMotionValue(componentId, value) {
  return normalizeShapePathComponentValue(
    componentId,
    componentId === SHAPE_PATH_COMPONENT_ROTATION ? value?.value : value,
  );
}

function interpolateShapeKeys(source, tick, fallback = null) {
  const pathKeys = keyRecords(source).flatMap((key) => {
    const path = shapePathEntryPath(keyValue(key));
    return path ? [{ ...key, value: path }] : [];
  });
  const { lower, upper } = neighboringKeys(pathKeys, tick);
  const first = lower ? normalizeShapePathKey(keyValue(lower)) : null;
  const second = upper ? normalizeShapePathKey(keyValue(upper)) : null;
  let path = first || second || normalizeShapePathKey(fallback);
  if (first && second && lower.tick !== upper.tick) {
    path = interpolateShapePath(
      first,
      second,
      interpolateTemporalProgress(
        (tick - lower.tick) / (upper.tick - lower.tick),
        keyValue(lower),
        keyValue(upper),
      ),
    ) || first;
  }
  if (!path) return null;
  const componentIds = new Set(keyRecords(source).flatMap((key) =>
    Object.keys(shapePathEntryComponents(keyValue(key)))));
  for (const componentId of componentIds) {
    const normalizedId = normalizeShapePathComponentId(componentId, path);
    if (!normalizedId) continue;
    const componentKeys = keyRecords(source).flatMap((key) => {
      const value = shapePathEntryComponents(keyValue(key))[normalizedId];
      return value == null ? [] : [{ ...key, value }];
    });
    const neighbors = neighboringKeys(componentKeys, tick);
    if (!neighbors.lower || !neighbors.upper) continue;
    const firstValue = componentMotionValue(normalizedId, keyValue(neighbors.lower));
    const secondValue = componentMotionValue(normalizedId, keyValue(neighbors.upper));
    if (firstValue == null || secondValue == null) continue;
    const value = neighbors.lower.tick === neighbors.upper.tick
      ? firstValue
      : interpolateShapePathComponent(
        normalizedId,
        firstValue,
        secondValue,
        interpolateTemporalProgress(
          (tick - neighbors.lower.tick) / (neighbors.upper.tick - neighbors.lower.tick),
          keyValue(neighbors.lower),
          keyValue(neighbors.upper),
        ),
      );
    if (path.kind === 'line' && normalizedId.startsWith('vertex:')) {
      const index = Number(normalizedId.slice('vertex:'.length));
      path = {
        ...path,
        ...(index === 0
          ? { x0: value.x, y0: value.y }
          : { x1: value.x, y1: value.y }),
      };
      delete path.vertices;
    } else {
      path = withShapePathComponentValue(path, normalizedId, value) || path;
    }
  }
  return path;
}

function trackForIdentifier(state, identifier) {
  return (state?.tracks || []).find((track) =>
    sameId(track.id, identifier) || sameId(track.layer?.id, identifier)) || null;
}

function rawClipAtTick(state, trackId, projectTick) {
  const tick = integer(projectTick, -1);
  return tick < 0 ? null : (state?.clips || []).find((clip) =>
    sameId(clip.trackId, trackId) && clipContainsTick(clip, tick)) || null;
}

export function findClipAtProjectTick(state, trackOrLayerId, projectTick) {
  const track = trackForIdentifier(state, trackOrLayerId);
  const clip = track ? rawClipAtTick(state, track.id, projectTick) : null;
  return clip ? cloneTimelineValue(clip) : null;
}

export function projectTickToClipLocal(clip, projectTick) {
  const tick = integer(projectTick, -1);
  const sourceTick = clipSourceTickAt(clip, tick);
  return sourceTick == null ? null : {
    projectTick: tick,
    clipLocalTick: tick - Math.max(0, integer(clip.startTick)),
    sourceTick,
  };
}

export function lookupClipAtProjectTick(state, trackOrLayerId, projectTick) {
  const track = trackForIdentifier(state, trackOrLayerId);
  const clip = track ? rawClipAtTick(state, track.id, projectTick) : null;
  return !track || !clip ? null : {
    track: cloneTimelineValue(track),
    clip: cloneTimelineValue(clip),
    ...projectTickToClipLocal(clip, projectTick),
  };
}

export function tickDurationFromFps(fps = DEFAULT_CLIP_TIMELINE_FPS) {
  const number = Number(fps);
  return 1000 / (Number.isFinite(number) && number > 0 ? number : DEFAULT_CLIP_TIMELINE_FPS);
}

export function clipTimelineTickDuration(state) {
  const stored = Number(state?.tickDuration);
  return Number.isFinite(stored) && stored > 0 ? stored : tickDurationFromFps(state?.fps);
}

export function clipTimelineDurationTicks(state) {
  let groupEnd = 0;
  for (const track of state?.tracks || []) {
    if (track.kind !== 'group' && track.layer?.type !== 'group') continue;
    for (const keys of Object.values(track.propertyTracks || {})) {
      for (const key of keyRecords(keys)) groupEnd = Math.max(groupEnd, key.tick + 1);
    }
  }
  return Math.max(1, maxClipEnd(state), groupEnd);
}

export function visualClipTimelineDurationTicks(state) {
  const visualTrackIds = new Set((state?.tracks || [])
    .filter((track) => track.kind !== 'audio')
    .map((track) => track.id));
  let groupEnd = 0;
  for (const track of state?.tracks || []) {
    if (track.kind === 'audio' || (track.kind !== 'group' && track.layer?.type !== 'group')) continue;
    for (const keys of Object.values(track.propertyTracks || {})) {
      for (const key of keyRecords(keys)) groupEnd = Math.max(groupEnd, key.tick + 1);
    }
  }
  return Math.max(1, maxClipEnd(state, visualTrackIds), groupEnd);
}

export function resolveClipPropertyAtTick(clip, propertyName, projectTick, fallback = null) {
  const tick = clipSourceTickAt(clip, projectTick);
  if (tick == null) return cloneTimelineValue(fallback);
  const keys = clip?.propertyTracks?.[propertyName];
  if (propertyName === CLIP_TIMELINE_PROPERTIES.position ||
    propertyName === CLIP_TIMELINE_PROPERTIES.maskPosition) {
    return interpolatePosition(keys, tick, fallback);
  }
  if (propertyName === SHAPE_ANCHOR_COMPENSATION || propertyName === 'shapeAnchorCompensation') {
    return interpolatePoint(keys, tick, fallback);
  }
  if (propertyName === CLIP_TIMELINE_PROPERTIES.visibility) {
    const key = heldKey(keys, tick);
    return key ? keyValue(key) !== false : fallback !== false;
  }
  if (propertyName === CLIP_TIMELINE_PROPERTIES.effectIntensity) {
    return interpolateScalar(keys, tick, Number(fallback) || 0, -1, 1);
  }
  if (propertyName === CLIP_TIMELINE_PROPERTIES.maskOpacity) {
    return interpolateScalar(keys, tick, fallback == null ? 1 : Number(fallback), 0, 1);
  }
  if (propertyName === CLIP_TIMELINE_PROPERTIES.shapePath) {
    return interpolateShapeKeys(keys, tick, fallback);
  }
  const key = heldKey(keys, tick);
  return cloneTimelineValue(key ? keyValue(key) : fallback);
}

function textMeta(layer) {
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

function payloadLayer(track, payload) {
  const layer = { ...cloneTimelineValue(track.layer), ...cloneTimelineValue(payload || {}) };
  layer.cells = cloneCells(layer.cells);
  return layer;
}

function withShapeCompensation(path, offset) {
  if (!path || !offset || (!offset.x && !offset.y)) return path;
  const components = path.kind === 'polygon'
    ? path.vertices.map((point) => ({ x: point.x + offset.x, y: point.y + offset.y }))
    : null;
  if (path.kind === 'line') {
    return normalizeShapePathKey({
      ...path,
      x0: path.x0 + offset.x,
      y0: path.y0 + offset.y,
      x1: path.x1 + offset.x,
      y1: path.y1 + offset.y,
    }, path.kind);
  }
  return normalizeShapePathKey({
    ...path,
    ...(components ? { vertices: components } : {}),
    ...(!components ? { cx: path.cx + offset.x, cy: path.cy + offset.y } : {}),
  }, path.kind);
}

function applyProperties(layer, clip, projectTick) {
  layer.offset = roundedPosition(resolveClipPropertyAtTick(
    clip,
    CLIP_TIMELINE_PROPERTIES.position,
    projectTick,
    layer.offset,
  ));
  layer.visible = resolveClipPropertyAtTick(
    clip,
    CLIP_TIMELINE_PROPERTIES.visibility,
    projectTick,
    layer.visible,
  );
  if (layer.type === 'text') {
    Object.assign(layer, textMeta(layer));
    const value = textMeta(layer);
    layer.cells = renderTextToCells(value.text, value.box, value.fg, value.wrap, value.runs);
  }
  if (layer.type === 'shape') {
    let path = resolveClipPropertyAtTick(
      clip,
      CLIP_TIMELINE_PROPERTIES.shapePath,
      projectTick,
      pathValueFromShape(layer.shape),
    );
    path = withShapeCompensation(path, resolveClipPropertyAtTick(
      clip,
      'shapeAnchorCompensation',
      projectTick,
      { x: 0, y: 0 },
    ));
    if (layer.shape && path) {
      layer.shape = constrainShape(shapeWithPathValue(layer.shape, path));
      layer.cells = renderShapeToCells(layer.shape);
    } else if (!layer.shape) layer.cells = {};
  }
  if (layer.effect) {
    layer.effect = {
      ...layer.effect,
      intensity: resolveClipPropertyAtTick(
        clip,
        CLIP_TIMELINE_PROPERTIES.effectIntensity,
        projectTick,
        layer.effect.intensity,
      ),
    };
  }
  if (layer.mask) {
    const hasOpacity = own(layer.mask, 'opacity') ||
      keyRecords(clip.propertyTracks?.maskOpacity).length > 0;
    layer.mask = {
      ...layer.mask,
      cells: cloneCells(layer.mask.cells),
      offset: resolveClipPropertyAtTick(
        clip,
        CLIP_TIMELINE_PROPERTIES.maskPosition,
        projectTick,
        layer.mask.offset,
      ),
    };
    if (hasOpacity) {
      layer.mask.opacity = resolveClipPropertyAtTick(
        clip,
        CLIP_TIMELINE_PROPERTIES.maskOpacity,
        projectTick,
        layer.mask.opacity,
      );
    }
  }
  return layer;
}

function blankLayer(track) {
  const layer = cloneTimelineValue(track.layer);
  if (!layer) return null;
  layer.cells = {};
  layer.offset = roundedPosition(layer.offset);
  if (layer.type === 'text') {
    layer.text = '';
    layer.runs = [];
  }
  if (layer.type === 'shape') layer.shape = null;
  return layer;
}

function groupLayer(state, track, projectTick) {
  const layer = cloneTimelineValue(track.layer);
  if (!layer) return null;
  const duration = clipTimelineDurationTicks(state);
  return applyProperties(layer, {
    startTick: 0,
    inTick: 0,
    outTick: duration,
    sourceDuration: duration,
    propertyTracks: track.propertyTracks || {},
  }, projectTick);
}

function videoLayer(track, clip, layer) {
  const assetId = clip.assetId ?? track.layer?.assetId;
  return {
    ...layer,
    ...(assetId != null ? { assetId } : {}),
    videoClip: {
      ...(assetId != null ? { assetId } : {}),
      ...(clip.sourceName != null ? { sourceName: clip.sourceName } : {}),
      startTick: clip.startTick,
      inPoint: clip.inPoint,
      outPoint: clip.outPoint,
      playbackRate: clip.playbackRate,
      duration: clip.duration ?? track.layer?.sourceDuration,
      width: clip.width ?? track.layer?.sourceWidth,
      height: clip.height ?? track.layer?.sourceHeight,
    },
  };
}

function resolveTrack(state, track, projectTick) {
  if (track.kind === 'audio') return null;
  if (track.kind === 'group' || track.layer?.type === 'group') {
    return groupLayer(state, track, projectTick);
  }
  const clip = rawClipAtTick(state, track.id, projectTick);
  if (!clip) {
    const blank = blankLayer(track);
    const referenceClip = track.layer?.type === 'video'
      ? (state.clips || []).find((candidate) =>
        candidate.trackId === track.id && candidate.kind === 'video')
      : null;
    return referenceClip ? videoLayer(track, referenceClip, blank) : blank;
  }
  const sourceTick = clipSourceTickAt(clip, projectTick);
  const payload = keyValue(heldKey(clip.frameKeys, sourceTick));
  let layer = applyProperties(payloadLayer(track, payload), clip, projectTick);
  if (track.layer?.type === 'video' || clip.kind === 'video') layer = videoLayer(track, clip, layer);
  return layer;
}

export function resolveClipTimelineLayers(state, projectTick) {
  const tick = integer(projectTick, -1);
  if (tick < 0 || tick >= clipTimelineDurationTicks(state)) return [];
  return (state?.tracks || []).flatMap((track) => {
    const layer = resolveTrack(state, track, tick);
    return layer ? [layer] : [];
  });
}

export function resolveClipTimelineAtTick(state, projectTick) {
  const tick = integer(projectTick, -1);
  if (tick < 0 || tick >= clipTimelineDurationTicks(state)) {
    throw new RangeError('Project tick is outside the clip timeline.');
  }
  const tickDuration = clipTimelineTickDuration(state);
  return {
    id: tick,
    index: tick,
    tick,
    duration: tickDuration,
    tickDuration,
    hold: 1,
    layers: resolveClipTimelineLayers(state, tick),
  };
}

export function createClipTimelineResolver(state) {
  const snapshot = cloneTimelineValue(state || { tracks: [], clips: [] });
  return {
    durationTicks: clipTimelineDurationTicks(snapshot),
    tickDuration: clipTimelineTickDuration(snapshot),
    resolve: (tick) => resolveClipTimelineAtTick(snapshot, tick),
    resolveLayers: (tick) => resolveClipTimelineLayers(snapshot, tick),
    findClip: (trackOrLayerId, tick) => findClipAtProjectTick(snapshot, trackOrLayerId, tick),
    lookupClip: (trackOrLayerId, tick) => lookupClipAtProjectTick(snapshot, trackOrLayerId, tick),
    mapProjectTick(clip, tick) {
      const target = typeof clip === 'string'
        ? snapshot.clips.find((candidate) => candidate.id === clip)
        : clip;
      return target ? projectTickToClipLocal(target, tick) : null;
    },
  };
}
