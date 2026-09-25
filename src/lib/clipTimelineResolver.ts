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
import { hexToOklch, oklchToHex } from './color.js';
import type {
  ClipTimelineState,
  TimelineCellMap,
  TimelineClip,
  TimelineClipTiming,
  TimelineLayer,
  TimelinePoint,
  TimelinePropertyTracks,
  TimelineStoredKey,
  TimelineTrack,
} from './types/timeline-models.js';

export const DEFAULT_CLIP_TIMELINE_FPS = 24;
export const CLIP_TIMELINE_PROPERTIES = Object.freeze({
  position: 'position',
  visibility: 'visibility',
  effectIntensity: 'effectIntensity',
  effectColor: 'effectColor',
  contentMask: 'contentMask',
  maskOpacity: 'maskOpacity',
  maskPosition: 'maskPosition',
  shapeMix: 'shapeMix',
  shapePath: 'shapePath',
});
const SHAPE_ANCHOR_COMPENSATION = 'shapeAnchorCompensation';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function sameId(first: unknown, second: unknown): boolean {
  return first != null && second != null && String(first) === String(second);
}

function own(object: unknown, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function cloneCells(cells: TimelineCellMap | null | undefined): TimelineCellMap {
  return Object.fromEntries(Object.entries(cells || {}).map(([key, cell]) => [
    key,
    cell && typeof cell === 'object' ? { ...cell } : cell,
  ]));
}

function numericPosition(value: unknown): TimelinePoint {
  const source = record(value) ? value : {};
  return {
    x: Number(source['x']) || 0,
    y: Number(source['y']) || 0,
  };
}

function roundedPosition(value: unknown): TimelinePoint {
  const point = numericPosition(value);
  return { x: Math.round(point.x) || 0, y: Math.round(point.y) || 0 };
}

function keyRecords(source: unknown): TimelineStoredKey[] {
  const entries = source instanceof Map
    ? [...source.entries()]
    : Array.isArray(source)
      ? source.map((key) => [record(key) ? key['tick'] : undefined, key])
      : source && typeof source === 'object' ? Object.entries(source) : [];
  const byTick = new Map<number, TimelineStoredKey>();
  for (const [rawTick, raw] of entries) {
    const tick = integer(record(raw) && own(raw, 'tick') ? raw['tick'] : rawTick, -1);
    if (tick < 0) continue;
    const key: TimelineStoredKey = record(raw) && own(raw, 'tick')
      ? { ...cloneTimelineValue(raw), tick }
      : { tick, value: cloneTimelineValue(raw) };
    key.tick = tick;
    byTick.set(tick, key);
  }
  return [...byTick.values()].sort((first, second) => first.tick - second.tick);
}

function heldKey(source: unknown, tick: number): TimelineStoredKey | null {
  let result: TimelineStoredKey | null = null;
  for (const key of keyRecords(source)) {
    if (key.tick > tick) break;
    result = key;
  }
  return result;
}

function keyValue(key: TimelineStoredKey | null | undefined): unknown {
  return key && own(key, 'value') ? key.value : null;
}

function neighboringKeys(source: unknown, tick: number) {
  const keys = keyRecords(source);
  if (!keys.length) return { lower: null, upper: null };
  const first = keys[0];
  const last = keys.at(-1);
  if (!first || !last) return { lower: null, upper: null };
  if (tick <= first.tick) return { lower: first, upper: first };
  if (tick >= last.tick) return { lower: last, upper: last };
  let lower = first;
  let upper = last;
  for (const key of keys) {
    if (key.tick <= tick) lower = key;
    if (key.tick >= tick) {
      upper = key;
      break;
    }
  }
  return { lower, upper };
}

function interpolatePosition(source: unknown, tick: number, fallback: unknown = { x: 0, y: 0 }) {
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
  const firstPoint = roundedPosition(first);
  const secondPoint = roundedPosition(second);
  return roundedPosition({
    x: firstPoint.x + (secondPoint.x - firstPoint.x) * progress,
    y: firstPoint.y + (secondPoint.y - firstPoint.y) * progress,
  });
}

function interpolatePoint(source: unknown, tick: number, fallback: unknown = { x: 0, y: 0 }) {
  const point = (value: unknown) => {
    const sourcePoint = record(value) ? value : {};
    return { x: Number(sourcePoint['x']) || 0, y: Number(sourcePoint['y']) || 0 };
  };
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

function interpolateScalar(
  source: unknown,
  tick: number,
  fallback: number,
  min: number,
  max: number,
): number {
  const clamp = (value: unknown) => {
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

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function normalizeHexColor(value: unknown, fallback = '#ffffff'): string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value) ? value.toLowerCase() : fallback;
}

function interpolateHueShortest(first: number, second: number, progress: number): number {
  let delta = second - first;
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  let result = first + delta * progress;
  if (result < 0) result += 360;
  if (result >= 360) result -= 360;
  return result;
}

function interpolateColor(source: unknown, tick: number, fallback: unknown = '#ffffff'): string {
  const fallbackColor = normalizeHexColor(fallback);
  const { lower, upper } = neighboringKeys(source, tick);
  if (!lower || !upper) return fallbackColor;
  const first = normalizeHexColor(keyValue(lower), fallbackColor);
  if (lower.tick === upper.tick) return first;
  const second = normalizeHexColor(keyValue(upper), fallbackColor);
  const progress = interpolateTemporalProgress(
    (tick - lower.tick) / (upper.tick - lower.tick),
    keyValue(lower),
    keyValue(upper),
  );
  const a = hexToOklch(first);
  const b = hexToOklch(second);
  // When one endpoint is effectively achromatic, borrow hue from the chromatic
  // endpoint rather than spinning through an arbitrary hue.
  const chromaThreshold = 1e-4;
  let hueA = a.H;
  let hueB = b.H;
  if (a.C < chromaThreshold && b.C >= chromaThreshold) hueA = b.H;
  else if (b.C < chromaThreshold && a.C >= chromaThreshold) hueB = a.H;
  const L = a.L + (b.L - a.L) * progress;
  const C = a.C + (b.C - a.C) * progress;
  const H = interpolateHueShortest(hueA, hueB, progress);
  return oklchToHex(L, Math.max(0, C), H);
}

function shapePathEntryIsEnvelope(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && (own(value, 'path') || own(value, 'components'));
}

function shapePathEntryPath(value: unknown): unknown {
  return shapePathEntryIsEnvelope(value) ? value['path'] : value;
}

function shapePathEntryComponents(value: unknown): Record<string, unknown> {
  const components = shapePathEntryIsEnvelope(value) ? value['components'] : null;
  return record(components)
    ? components
    : {};
}

function componentMotionValue(componentId: string, value: unknown) {
  const source = record(value) ? value : {};
  return normalizeShapePathComponentValue(
    componentId,
    componentId === SHAPE_PATH_COMPONENT_ROTATION ? source['value'] : value,
  );
}

function interpolateShapeKeys(source: unknown, tick: number, fallback: unknown = null) {
  const pathKeys = keyRecords(source).flatMap((key) => {
    const path = shapePathEntryPath(keyValue(key));
    return path ? [{ ...key, value: path }] : [];
  });
  const { lower, upper } = neighboringKeys(pathKeys, tick);
  const first = lower ? normalizeShapePathKey(keyValue(lower)) : null;
  const second = upper ? normalizeShapePathKey(keyValue(upper)) : null;
  let path = first || second || normalizeShapePathKey(fallback);
  if (first && second && lower && upper && lower.tick !== upper.tick) {
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
    if (path.kind === 'line' && normalizedId.startsWith('vertex:') &&
      value !== null && typeof value === 'object' && 'x' in value && 'y' in value &&
      typeof value.x === 'number' && typeof value.y === 'number') {
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

function trackForIdentifier(state: ClipTimelineState, identifier: unknown): TimelineTrack | null {
  return (state?.tracks || []).find((track) =>
    sameId(track.id, identifier) || sameId(track.layer?.id, identifier)) || null;
}

function rawClipAtTick(
  state: ClipTimelineState,
  trackId: string,
  projectTick: unknown,
): TimelineClip | null {
  const tick = integer(projectTick, -1);
  return tick < 0 ? null : (state?.clips || []).find((clip) =>
    sameId(clip.trackId, trackId) && clipContainsTick(clip, tick)) || null;
}

export function findClipAtProjectTick(
  state: ClipTimelineState,
  trackOrLayerId: unknown,
  projectTick: unknown,
): TimelineClip | null {
  const track = trackForIdentifier(state, trackOrLayerId);
  const clip = track ? rawClipAtTick(state, track.id, projectTick) : null;
  return clip ? cloneTimelineValue(clip) : null;
}

export function projectTickToClipLocal(clip: TimelineClip, projectTick: unknown) {
  const tick = integer(projectTick, -1);
  const sourceTick = clipSourceTickAt(clip, tick);
  return sourceTick == null ? null : {
    projectTick: tick,
    clipLocalTick: tick - Math.max(0, integer(clip.startTick)),
    sourceTick,
  };
}

export function lookupClipAtProjectTick(
  state: ClipTimelineState,
  trackOrLayerId: unknown,
  projectTick: unknown,
) {
  const track = trackForIdentifier(state, trackOrLayerId);
  const clip = track ? rawClipAtTick(state, track.id, projectTick) : null;
  return !track || !clip ? null : {
    track: cloneTimelineValue(track),
    clip: cloneTimelineValue(clip),
    ...projectTickToClipLocal(clip, projectTick),
  };
}

export function tickDurationFromFps(fps: unknown = DEFAULT_CLIP_TIMELINE_FPS): number {
  const number = Number(fps);
  return 1000 / (Number.isFinite(number) && number > 0 ? number : DEFAULT_CLIP_TIMELINE_FPS);
}

export function clipTimelineTickDuration(state: ClipTimelineState): number {
  const stored = Number(state?.tickDuration);
  return Number.isFinite(stored) && stored > 0 ? stored : tickDurationFromFps(state?.fps);
}

export function clipTimelineDurationTicks(state: ClipTimelineState): number {
  let groupEnd = 0;
  for (const track of state?.tracks || []) {
    if (track.kind !== 'group' && track.layer?.type !== 'group') continue;
    for (const keys of Object.values(track.propertyTracks || {})) {
      for (const key of keyRecords(keys)) groupEnd = Math.max(groupEnd, key.tick + 1);
    }
  }
  return Math.max(1, maxClipEnd(state), groupEnd);
}

export function visualClipTimelineDurationTicks(state: ClipTimelineState): number {
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

export function resolveClipPropertyAtTick(
  clip: TimelineClipTiming & { propertyTracks?: TimelinePropertyTracks },
  propertyName: string,
  projectTick: unknown,
  fallback: unknown = null,
): unknown {
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
  if (propertyName === CLIP_TIMELINE_PROPERTIES.effectColor) {
    return interpolateColor(keys, tick, fallback);
  }
  if (propertyName === CLIP_TIMELINE_PROPERTIES.maskOpacity) {
    return interpolateScalar(keys, tick, fallback == null ? 1 : Number(fallback), 0, 1);
  }
  if (propertyName === CLIP_TIMELINE_PROPERTIES.shapeMix) {
    return interpolateScalar(keys, tick, fallback == null ? 1 : Number(fallback), 0, 1);
  }
  if (propertyName === CLIP_TIMELINE_PROPERTIES.shapePath) {
    return interpolateShapeKeys(keys, tick, fallback);
  }
  const key = heldKey(keys, tick);
  return cloneTimelineValue(key ? keyValue(key) : fallback);
}

function textMeta(layer: Extract<TimelineLayer, { type: 'text' }>) {
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

function payloadLayer(track: TimelineTrack, payload: unknown): TimelineLayer | null {
  const layer = cloneTimelineValue(track.layer);
  if (!layer) return null;
  if (record(payload)) Object.assign(layer, cloneTimelineValue(payload));
  layer.cells = cloneCells(layer.cells);
  return layer;
}

function withShapeCompensation(path: ReturnType<typeof normalizeShapePathKey>, offset: unknown) {
  const point = numericPosition(offset);
  if (!path || (!point.x && !point.y)) return path;
  const components = path.kind === 'polygon'
    ? path.vertices.map((vertex) => ({ x: vertex.x + point.x, y: vertex.y + point.y }))
    : null;
  if (path.kind === 'line') {
    return normalizeShapePathKey({
      ...path,
      x0: path.x0 + point.x,
      y0: path.y0 + point.y,
      x1: path.x1 + point.x,
      y1: path.y1 + point.y,
    }, path.kind);
  }
  if (path.kind === 'polygon') {
    return normalizeShapePathKey({ ...path, vertices: components || path.vertices }, path.kind);
  }
  return normalizeShapePathKey({
    ...path,
    cx: path.cx + point.x,
    cy: path.cy + point.y,
  }, path.kind);
}

function applyProperties(layer: TimelineLayer, clip: TimelineClip, projectTick: number): TimelineLayer {
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
  ) !== false;
  if (layer.type === 'text') {
    Object.assign(layer, textMeta(layer));
    const value = textMeta(layer);
    layer.cells = renderTextToCells(value.text, value.box, value.fg, value.wrap, value.runs);
  }
  if (layer.type === 'shape') {
    let path = normalizeShapePathKey(resolveClipPropertyAtTick(
      clip,
      CLIP_TIMELINE_PROPERTIES.shapePath,
      projectTick,
      pathValueFromShape(layer.shape),
    ));
    path = withShapeCompensation(path, resolveClipPropertyAtTick(
      clip,
      'shapeAnchorCompensation',
      projectTick,
      { x: 0, y: 0 },
    ));
    if (layer.shape && path) {
      const shape = constrainShape(shapeWithPathValue(layer.shape, path));
      if (shape.channel === 'color-clip') {
        shape.mix = Number(resolveClipPropertyAtTick(
          clip,
          CLIP_TIMELINE_PROPERTIES.shapeMix,
          projectTick,
          shape.mix ?? 1,
        ));
      }
      layer.shape = shape;
      layer.cells = shape ? renderShapeToCells(shape) : {};
    } else if (!layer.shape) layer.cells = {};
  }
  if (layer.type === 'effect' && layer.effect) {
    const intensity = Number(resolveClipPropertyAtTick(
      clip,
      CLIP_TIMELINE_PROPERTIES.effectIntensity,
      projectTick,
      layer.effect.intensity,
    ));
    if (layer.effect.kind === 'solid-color') {
      const color = String(resolveClipPropertyAtTick(
        clip,
        CLIP_TIMELINE_PROPERTIES.effectColor,
        projectTick,
        layer.effect.color,
      ));
      layer.effect = { kind: 'solid-color', color, intensity };
    } else {
      layer.effect = { ...layer.effect, intensity };
    }
  }
  if (layer.type === 'effect' && layer.mask) {
    const hasOpacity = own(layer.mask, 'opacity') ||
      keyRecords(clip.propertyTracks?.['maskOpacity']).length > 0;
    layer.mask = {
      ...layer.mask,
      cells: cloneCells(layer.mask.cells),
      offset: roundedPosition(resolveClipPropertyAtTick(
        clip,
        CLIP_TIMELINE_PROPERTIES.maskPosition,
        projectTick,
        layer.mask.offset,
      )),
    };
    if (hasOpacity) {
      layer.mask.opacity = Number(resolveClipPropertyAtTick(
        clip,
        CLIP_TIMELINE_PROPERTIES.maskOpacity,
        projectTick,
        layer.mask.opacity,
      ));
    }
  }
  if (layer.contentMask) {
    const value = resolveClipPropertyAtTick(
      clip,
      CLIP_TIMELINE_PROPERTIES.contentMask,
      projectTick,
      layer.contentMask,
    );
    if (record(value)) {
      layer.contentMask = {
        ...layer.contentMask,
        ...value,
        cells: cloneCells(value['cells'] as TimelineCellMap),
        offset: roundedPosition(value['offset']),
      };
    }
  }
  return layer;
}

function blankLayer(track: TimelineTrack): TimelineLayer | null {
  const layer = cloneTimelineValue(track.layer);
  if (!layer) return null;
  layer.cells = {};
  layer.offset = roundedPosition(layer.offset);
  if (layer.type === 'text') {
    layer.text = '';
    layer.runs = [];
  }
  if (layer.type === 'shape') Reflect.set(layer, 'shape', null);
  return layer;
}

function groupLayer(
  state: ClipTimelineState,
  track: TimelineTrack,
  projectTick: number,
): TimelineLayer | null {
  const layer = cloneTimelineValue(track.layer);
  if (!layer) return null;
  const duration = clipTimelineDurationTicks(state);
  return applyProperties(layer, {
    id: `group:${track.id}`,
    trackId: track.id,
    kind: 'clip',
    startTick: 0,
    inTick: 0,
    outTick: duration,
    sourceDuration: duration,
    frameKeys: [],
    propertyTracks: track.propertyTracks || {},
  }, projectTick);
}

function videoLayer(
  track: TimelineTrack,
  clip: TimelineClip,
  layer: TimelineLayer | null,
): TimelineLayer | null {
  if (!layer) return null;
  const layerRecord: Record<string, unknown> = record(layer) ? layer : {};
  const trackLayer: Record<string, unknown> = record(track.layer) ? track.layer : {};
  const priorVideoClip: Record<string, unknown> = record(layerRecord['videoClip'])
    ? layerRecord['videoClip']
    : {};
  const trackVideoClip: Record<string, unknown> = record(trackLayer['videoClip'])
    ? trackLayer['videoClip']
    : {};
  const trackAssetId = trackVideoClip['assetId'] ?? trackLayer['assetId'];
  const assetId = typeof clip.assetId === 'string' ? clip.assetId : trackAssetId;
  const result = cloneTimelineValue(layer);
  if (assetId != null) Reflect.set(result, 'assetId', assetId);
  Reflect.set(result, 'videoClip', {
    ...priorVideoClip,
    ...(assetId != null ? { assetId } : {}),
    ...(typeof clip.sourceName === 'string' ? { sourceName: clip.sourceName } : {}),
    startTick: clip.startTick,
    inPoint: clip.inPoint,
    outPoint: clip.outPoint,
    playbackRate: clip.playbackRate,
    duration: clip.duration ?? trackLayer['sourceDuration'],
    width: clip.width ?? trackLayer['sourceWidth'],
    height: clip.height ?? trackLayer['sourceHeight'],
  });
  return result;
}

function resolveTrack(
  state: ClipTimelineState,
  track: TimelineTrack,
  projectTick: number,
): TimelineLayer | null {
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
  const payload = sourceTick == null ? null : keyValue(heldKey(clip.frameKeys, sourceTick));
  const payloadValue = payloadLayer(track, payload);
  if (!payloadValue) return null;
  let layer = applyProperties(payloadValue, clip, projectTick);
  if (track.layer?.type === 'video' || clip.kind === 'video') {
    const video = videoLayer(track, clip, layer);
    if (video) layer = video;
  }
  return layer;
}

export function resolveClipTimelineLayers(
  state: ClipTimelineState,
  projectTick: unknown,
): TimelineLayer[] {
  const tick = integer(projectTick, -1);
  if (tick < 0 || tick >= clipTimelineDurationTicks(state)) return [];
  return (state?.tracks || []).flatMap((track) => {
    const layer = resolveTrack(state, track, tick);
    return layer ? [layer] : [];
  });
}

export function resolveClipTimelineAtTick(state: ClipTimelineState, projectTick: unknown) {
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

export function createClipTimelineResolver(state: ClipTimelineState) {
  const snapshot = cloneTimelineValue(state || { tracks: [], clips: [] });
  return {
    durationTicks: clipTimelineDurationTicks(snapshot),
    tickDuration: clipTimelineTickDuration(snapshot),
    resolve: (tick: unknown) => resolveClipTimelineAtTick(snapshot, tick),
    resolveLayers: (tick: unknown) => resolveClipTimelineLayers(snapshot, tick),
    findClip: (trackOrLayerId: unknown, tick: unknown) =>
      findClipAtProjectTick(snapshot, trackOrLayerId, tick),
    lookupClip: (trackOrLayerId: unknown, tick: unknown) =>
      lookupClipAtProjectTick(snapshot, trackOrLayerId, tick),
    mapProjectTick(clip: TimelineClip | string, tick: unknown) {
      const target = typeof clip === 'string'
        ? snapshot.clips.find((candidate) => candidate.id === clip)
        : clip;
      return target ? projectTickToClipLocal(target, tick) : null;
    },
  };
}
