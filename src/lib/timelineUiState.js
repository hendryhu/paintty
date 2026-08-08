export const TIMELINE_TOOLS = Object.freeze(['select', 'razor', 'tag']);
export const DEFAULT_TRACK_HEADER_WIDTH = 176;
export const MIN_TRACK_HEADER_WIDTH = 120;
export const MAX_TRACK_HEADER_WIDTH = 360;
export const TRACK_HEADER_WIDTH_STEP = 8;
export const TRACK_HEADER_WIDTH_STORAGE_KEY = 'paintty.timeline.track-header-width';
export const MIN_TIMELINE_LANE_WIDTH = 72;
export const TIMELINE_TAG_MARKER_WIDTH = 12;
export const TIMELINE_TAG_MARKER_HEIGHT = 6;
export const TIMELINE_POINTER_DRAG_THRESHOLD = 3;
export const TRACK_HEADER_RESIZE_HIT_WIDTH = 7;
export const TRACK_HEADER_RESIZE_INSET = 12;
export const TRACK_HEADER_RESIZE_GRIP_WIDTH = 3;

const TAG_MARKER_TYPE_ORDER = Object.freeze({
  'loop-start': 0,
  custom: 1,
  'loop-end': 2,
});

function browserStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function trackHeaderDividerGeometry(headerWidth) {
  const width = Math.max(0, Number(headerWidth) || 0);
  const hitWidth = Math.min(width, TRACK_HEADER_RESIZE_HIT_WIDTH);
  const hitLeft = Math.max(0, width - TRACK_HEADER_RESIZE_INSET);
  const gripWidth = Math.min(hitWidth, TRACK_HEADER_RESIZE_GRIP_WIDTH);
  const gripLeft = hitLeft + Math.min(2, Math.max(0, hitWidth - gripWidth));
  return {
    hitLeft,
    hitRight: hitLeft + hitWidth,
    hitWidth,
    gripLeft,
    gripRight: gripLeft + gripWidth,
    gripWidth,
  };
}

export function timelineToolForShortcut(event, options = {}) {
  if (options.typing || options.playing || !options.contextOwned || event?.defaultPrevented ||
    event?.ctrlKey || event?.altKey || event?.metaKey) return null;
  const key = String(event?.key || '').toLowerCase();
  return key === 'v' ? 'select' : key === 'c' ? 'razor' : key === 't' ? 'tag' : null;
}

export function timelineZoomForShortcut(event, currentZoom, options = {}) {
  if (options.typing || !options.contextOwned || event?.defaultPrevented ||
    event?.ctrlKey || event?.altKey || event?.metaKey) return { handled: false, zoom: currentZoom };
  const direction = event?.key === '+' || event?.key === '=' ? 1 : event?.key === '-' ? -1 : 0;
  if (!direction) return { handled: false, zoom: currentZoom };
  const minimum = Number.isFinite(Number(options.minimum)) ? Number(options.minimum) : 4;
  const maximum = Number.isFinite(Number(options.maximum)) ? Number(options.maximum) : 48;
  const step = Math.max(1, Number(options.step) || 2);
  const current = Number.isFinite(Number(currentZoom)) ? Number(currentZoom) : minimum;
  return {
    handled: true,
    zoom: Math.max(minimum, Math.min(maximum, current + direction * step)),
  };
}

export function timelineWheelZoom(event, currentZoom, options = {}) {
  const modified = Boolean(event?.ctrlKey || event?.metaKey);
  if (!modified || event?.defaultPrevented || options.suppressed ||
    options.contextOwned === false || event?.altKey || !Number(event?.deltaY)) {
    return { handled: false, zoom: currentZoom };
  }
  const minimum = Number.isFinite(Number(options.minimum)) ? Number(options.minimum) : 4;
  const maximum = Number.isFinite(Number(options.maximum)) ? Number(options.maximum) : 48;
  const step = Math.max(1, Number(options.step) || 2);
  const current = Number.isFinite(Number(currentZoom)) ? Number(currentZoom) : minimum;
  const direction = Number(event.deltaY) < 0 ? 1 : -1;
  return {
    handled: true,
    zoom: Math.max(minimum, Math.min(maximum, current + direction * step)),
  };
}

export function timelineTransportStatus(playheadTick, durationTicks) {
  const duration = Math.max(1, Math.round(Number(durationTicks)) || 1);
  const finalTick = duration - 1;
  const requestedTick = Math.round(Number(playheadTick));
  const currentTick = Number.isFinite(requestedTick)
    ? Math.max(0, Math.min(finalTick, requestedTick))
    : 0;
  return {
    currentTick,
    finalTick,
    label: `Tick ${currentTick} / ${finalTick}`,
  };
}

function normalizeTimelineTagTarget(target) {
  const number = Number(target?.tick);
  const tick = Number.isInteger(number) && number >= 0 ? number : null;
  const rowId = target?.rowId == null ? null : String(target.rowId);
  const globalSurface = target?.surface === 'global';
  return {
    tick,
    rowId,
    ...(globalSurface ? { surface: 'global' } : {}),
    valid: target?.valid === true && tick != null && (globalSurface || rowId != null),
  };
}

export function planTimelineTagGesture(
  startTarget,
  currentTarget,
  pointerDistance = 0,
  wasDragged = false,
) {
  const distance = Number(pointerDistance);
  const moved = Boolean(wasDragged) ||
    (Number.isFinite(distance) && distance >= TIMELINE_POINTER_DRAG_THRESHOLD);
  const preview = normalizeTimelineTagTarget(moved ? currentTarget : startTarget);
  return {
    moved,
    preview,
    release: preview.valid
      ? preview.surface === 'global'
        ? { tick: preview.tick, surface: 'global' }
        : { tick: preview.tick, rowId: preview.rowId }
      : null,
  };
}

// Cross the pixel drag threshold before quantizing to ticks, then clamp the tick to
// the inclusive authored sequence without changing tag identity.
export function planTimelineTagMove(tag, deltaPixels, pixelsPerTick, durationTicks, wasDragged = false) {
  const duration = Math.max(1, Math.round(Number(durationTicks)) || 1);
  const origin = Math.max(0, Math.min(duration - 1, Math.round(Number(tag?.tick)) || 0));
  const pixels = Number(deltaPixels) || 0;
  const moved = Boolean(wasDragged) || Math.abs(pixels) >= TIMELINE_POINTER_DRAG_THRESHOLD;
  const scale = Math.max(0.0001, Number(pixelsPerTick) || 1);
  const tick = Math.max(0, Math.min(duration - 1, origin + Math.round(pixels / scale)));
  return {
    moved,
    changed: moved && tick !== origin,
    tick,
    tag: tag ? { ...tag, tick } : null,
  };
}

export function planTimelineMutationTransition(previousRevision, revision, gestures = {}) {
  const initialized = previousRevision == null;
  const changed = !initialized && revision !== previousRevision;
  return {
    revision,
    changed,
    cancelPointer: changed && Boolean(gestures.pointerEdit),
    cancelHeaderResize: changed && Boolean(gestures.headerResize),
  };
}

export function normalizeTimelineTool(value) {
  return TIMELINE_TOOLS.includes(value) ? value : 'select';
}

export function maximumTrackHeaderWidth(viewportWidth = Infinity) {
  if (!Number.isFinite(Number(viewportWidth))) return MAX_TRACK_HEADER_WIDTH;
  return Math.max(
    MIN_TRACK_HEADER_WIDTH,
    Math.min(MAX_TRACK_HEADER_WIDTH, Math.floor(Number(viewportWidth)) - MIN_TIMELINE_LANE_WIDTH),
  );
}

export function clampTrackHeaderWidth(value, viewportWidth = Infinity) {
  const number = Number(value);
  const fallback = value != null && value !== '' && Number.isFinite(number)
    ? Math.round(number)
    : DEFAULT_TRACK_HEADER_WIDTH;
  return Math.max(
    MIN_TRACK_HEADER_WIDTH,
    Math.min(maximumTrackHeaderWidth(viewportWidth), fallback),
  );
}

export function loadTrackHeaderWidth(storage = browserStorage()) {
  try {
    return clampTrackHeaderWidth(storage?.getItem?.(TRACK_HEADER_WIDTH_STORAGE_KEY));
  } catch {
    return DEFAULT_TRACK_HEADER_WIDTH;
  }
}

export function persistTrackHeaderWidth(value, storage = browserStorage()) {
  const width = clampTrackHeaderWidth(value);
  try {
    storage?.setItem?.(TRACK_HEADER_WIDTH_STORAGE_KEY, String(width));
  } catch {}
  return width;
}

export function resizeTrackHeaderWithKey(event, currentWidth, viewportWidth = Infinity) {
  let next = null;
  if (event?.key === 'ArrowLeft') next = Number(currentWidth) - TRACK_HEADER_WIDTH_STEP;
  else if (event?.key === 'ArrowRight') next = Number(currentWidth) + TRACK_HEADER_WIDTH_STEP;
  else if (event?.key === 'Home') next = MIN_TRACK_HEADER_WIDTH;
  else if (event?.key === 'End') next = maximumTrackHeaderWidth(viewportWidth);
  if (next == null) return { handled: false, width: clampTrackHeaderWidth(currentWidth, viewportWidth) };
  return { handled: true, width: clampTrackHeaderWidth(next, viewportWidth) };
}

export function resizeTrackHeaderFromPointer(
  startWidth,
  startClientX,
  clientX,
  viewportWidth = Infinity,
  cancelled = false,
) {
  return clampTrackHeaderWidth(
    cancelled ? startWidth : Number(startWidth) + Number(clientX) - Number(startClientX),
    viewportWidth,
  );
}

export function rulerTickFromPixel(pixel, pixelsPerTick, durationTicks) {
  if (pixel == null) return null;
  const scale = Math.max(0.0001, Number(pixelsPerTick) || 1);
  const duration = Math.max(1, Math.round(Number(durationTicks)) || 1);
  const raw = Number(pixel) / scale;
  if (!Number.isFinite(raw) || raw < 0 || raw >= duration) return null;
  return Math.max(0, Math.min(duration - 1, Math.floor(raw)));
}

export function clampedRulerTickFromPixel(pixel, pixelsPerTick, durationTicks) {
  if (pixel == null) return null;
  const scale = Math.max(0.0001, Number(pixelsPerTick) || 1);
  const duration = Math.max(1, Math.round(Number(durationTicks)) || 1);
  const raw = Number(pixel) / scale;
  if (!Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(duration - 1, Math.floor(raw)));
}

export function timelineTagMarkerLayout(tickPixel, stackIndex = 0, pixelsPerTick = 14) {
  const index = Math.max(0, Math.trunc(Number(stackIndex)) || 0);
  const width = Math.min(
    TIMELINE_TAG_MARKER_WIDTH,
    Math.max(4, Number(pixelsPerTick) - 2 || 4),
  );
  return {
    left: Number(tickPixel) - width / 2,
    top: 8 + index * 7,
    width,
    height: TIMELINE_TAG_MARKER_HEIGHT,
  };
}

export function timelineExtentTicks(contentDurationTicks, laneViewportWidth, pixelsPerTick) {
  const duration = Math.max(1, Math.round(Number(contentDurationTicks)) || 1);
  const viewport = Math.max(0, Number(laneViewportWidth) || 0);
  const scale = Math.max(0.0001, Number(pixelsPerTick) || 1);
  return Math.max(
    duration + Math.max(1, Math.ceil(viewport / scale / 2)),
    Math.ceil(viewport / scale),
    1,
  );
}

export function buildTimelineTagMarkers(tags, range) {
  const grouped = new Map();
  for (const tag of tags || []) {
    if (tag.tick < range.startTick || tag.tick >= range.endTick) continue;
    const entries = grouped.get(tag.tick) || [];
    entries.push(tag);
    grouped.set(tag.tick, entries);
  }
  const markers = [];
  for (const tick of [...grouped.keys()].sort((first, second) => first - second)) {
    const entries = grouped.get(tick);
    const custom = entries
      .filter((tag) => tag.type === 'custom')
      .sort((first, second) => first.value.localeCompare(second.value) || first.id.localeCompare(second.id));
    const tickMarkers = entries.filter((tag) => tag.type !== 'custom');
    if (custom.length === 1) tickMarkers.push(custom[0]);
    else if (custom.length > 1) {
      tickMarkers.push({
        id: `custom-cluster:${tick}`,
        tick,
        type: 'custom',
        value: custom[0].value,
        cluster: true,
        customCount: custom.length,
        customIds: custom.map((tag) => tag.id),
        customValues: custom.map((tag) => tag.value),
      });
    }
    tickMarkers.sort((first, second) =>
      TAG_MARKER_TYPE_ORDER[first.type] - TAG_MARKER_TYPE_ORDER[second.type] ||
      first.id.localeCompare(second.id));
    markers.push(...tickMarkers.map((marker, stackIndex) => ({ ...marker, stackIndex })));
  }
  return markers;
}
