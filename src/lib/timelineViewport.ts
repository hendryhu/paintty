import type {
  ClipTimelineState,
  TimelineClip,
  TimelineClipGeometry,
  TimelineEdge,
  TimelineEdgeInput,
  TimelineIdSource,
  TimelineSnapTarget,
  TimelineTickRange,
} from './types/timeline-models.js';
import type { TickPixelTransform, TimelineExposureSegment } from './types/timeline-ui.js';

export const DEFAULT_MAX_TIMELINE_SCROLL_PIXELS = 8_000_000;

interface TickPixelTransformInput {
  pixelsPerTick?: unknown;
  panTick?: unknown;
  originPixel?: unknown;
}

interface AnchoredZoomAnchor {
  geometryKey: unknown;
  anchorPixel: number;
  anchorTick: number;
  originAnchorPixel: number;
  originPixelsPerTick: number;
  originScrollLeft: number;
  currentPixelsPerTick?: number;
  expectedScrollLeft?: number;
}

interface AnchoredZoomOptions {
  scrollLeft?: unknown;
  currentPixelsPerTick?: unknown;
  nextPixelsPerTick?: unknown;
  anchorPixel?: unknown;
  devicePixelRatio?: unknown;
  maximumScrollLeft?: unknown;
  geometryKey?: unknown;
  anchor?: AnchoredZoomAnchor | null;
}

interface VisibleTickOptions {
  viewportLeft?: unknown;
  overscanPixels?: unknown;
  minimumTick?: unknown;
  maximumTick?: unknown;
}

interface TimelineRowPrefixIndex {
  offsets: number[];
  rowCount: number;
  totalHeight: number;
}

interface TimelineRangeOptions {
  minimumTick?: unknown;
  maximumTick?: unknown;
}

interface TimelineTrackScopeOptions {
  allTrackIds?: TimelineIdSource;
  selectedTrackIds?: TimelineIdSource;
  hoveredTrackId?: unknown;
  rulerAll?: boolean;
}

interface SnapTimelineOptions {
  altKey?: boolean;
  pixelsPerTick?: unknown;
  transform?: Partial<TickPixelTransform>;
  thresholdPixels?: unknown;
  trackIds?: TimelineIdSource;
  excludeClipIds?: TimelineIdSource;
  playheadTick?: unknown;
  clips?: TimelineClipGeometry[];
}

interface TimelineSnapResult {
  requestedTick: number;
  tick: number;
  snapped: boolean;
  distanceTicks: number;
  distancePixels: number;
  target: TimelineSnapTarget | null;
}

interface ScrollWindowOptions {
  totalTicks?: unknown;
  pixelsPerTick?: unknown;
  viewportWidth?: unknown;
  maxScrollPixels?: unknown;
  rebaseMarginPixels?: unknown;
  logicalStartTick?: unknown;
}

interface ScrollWindowMetrics {
  totalTicks: number;
  pixelsPerTick: number;
  viewportWidth: number;
  maxScrollPixels: number;
  rebaseMarginPixels: number;
  scrollWidth: number;
  maxScrollLeft: number;
  visibleTicks: number;
  maxLogicalStartTick: number;
  windowTicks: number;
  maxLogicalOriginTick: number;
}

interface LogicalScrollWindow {
  totalTicks: number;
  pixelsPerTick: number;
  viewportWidth: number;
  maxScrollPixels: number;
  rebaseMarginPixels: number;
  scrollWidth: number;
  maxScrollLeft: number;
  logicalOriginTick: number;
  logicalWindowEndTick: number;
  logicalStartTick: number;
  logicalEndTick: number;
  scrollLeft: number;
  rebased: boolean;
  scrollAdjustmentPixels: number;
}

function finiteNumber(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${name} must be finite.`);
  return number;
}

function positiveNumber(value: unknown, name: string): number {
  const number = finiteNumber(value, name);
  if (number <= 0) throw new RangeError(`${name} must be greater than zero.`);
  return number;
}

function nonnegativeNumber(value: unknown, name: string): number {
  const number = finiteNumber(value, name);
  if (number < 0) throw new RangeError(`${name} must not be negative.`);
  return number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function iterableIds(value: TimelineIdSource): string[] {
  if (value == null) return [];
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (typeof Reflect.get(value, Symbol.iterator) !== 'function') return [];
  return [...new Set([...value].map((entry) => String(entry)))];
}

function clipStartTick(clip: TimelineClipGeometry): number {
  return Number(clip?.startTick);
}

function clipEndTick(clip: TimelineClipGeometry): number {
  const startTick = clipStartTick(clip);
  const durationTicks = Math.max(1, Number(clip?.outTick) - Number(clip?.inTick));
  return startTick + durationTicks;
}

function intervalFor(value: Partial<TimelineTickRange> | null | undefined): TimelineTickRange | null {
  const startTick = Number(value?.startTick);
  const endTick = Number(value?.endTick);
  if (!Number.isFinite(startTick) || Number.isNaN(endTick)) return null;
  return { startTick, endTick };
}

/**
 * Defines viewport coordinates around a logical tick at an arbitrary pixel origin.
 * `panTick` may be fractional so pointer panning remains smooth between integer ticks.
 */
export function createTickPixelTransform({
  pixelsPerTick,
  panTick = 0,
  originPixel = 0,
}: TickPixelTransformInput = {}): TickPixelTransform {
  return {
    pixelsPerTick: positiveNumber(pixelsPerTick, 'pixelsPerTick'),
    panTick: finiteNumber(panTick, 'panTick'),
    originPixel: finiteNumber(originPixel, 'originPixel'),
  };
}

export function tickToPixel(tick: unknown, transform: Partial<TickPixelTransform>): number {
  const logicalTick = finiteNumber(tick, 'tick');
  const pixelsPerTick = positiveNumber(transform?.pixelsPerTick, 'pixelsPerTick');
  const panTick = finiteNumber(transform?.panTick ?? 0, 'panTick');
  const originPixel = finiteNumber(transform?.originPixel ?? 0, 'originPixel');
  return originPixel + (logicalTick - panTick) * pixelsPerTick;
}

export function pixelToTick(pixel: unknown, transform: Partial<TickPixelTransform>): number {
  const viewportPixel = finiteNumber(pixel, 'pixel');
  const pixelsPerTick = positiveNumber(transform?.pixelsPerTick, 'pixelsPerTick');
  const panTick = finiteNumber(transform?.panTick ?? 0, 'panTick');
  const originPixel = finiteNumber(transform?.originPixel ?? 0, 'originPixel');
  return panTick + (viewportPixel - originPixel) / pixelsPerTick;
}

export function zoomTickPixelTransform(
  transform: Partial<TickPixelTransform>,
  pixelsPerTick: unknown,
  anchorPixel: unknown = 0,
): TickPixelTransform {
  const anchor = finiteNumber(anchorPixel, 'anchorPixel');
  const anchorTick = pixelToTick(anchor, transform);
  const nextPixelsPerTick = positiveNumber(pixelsPerTick, 'pixelsPerTick');
  const originPixel = finiteNumber(transform?.originPixel ?? 0, 'originPixel');
  return createTickPixelTransform({
    pixelsPerTick: nextPixelsPerTick,
    panTick: anchorTick - (anchor - originPixel) / nextPixelsPerTick,
    originPixel,
  });
}

export function planAnchoredTimelineZoom(options: AnchoredZoomOptions = {}) {
  const scrollLeft = nonnegativeNumber(options.scrollLeft ?? 0, 'scrollLeft');
  const currentPixelsPerTick = positiveNumber(
    options.currentPixelsPerTick,
    'currentPixelsPerTick',
  );
  const nextPixelsPerTick = positiveNumber(options.nextPixelsPerTick, 'nextPixelsPerTick');
  const anchorPixel = finiteNumber(options.anchorPixel ?? 0, 'anchorPixel');
  const devicePixelRatio = positiveNumber(options.devicePixelRatio ?? 1, 'devicePixelRatio');
  const maximumScrollLeft = options.maximumScrollLeft == null
    ? Infinity
    : nonnegativeNumber(options.maximumScrollLeft, 'maximumScrollLeft');
  const geometryKey = options.geometryKey ?? null;
  const prior = options.anchor;
  const reusable = prior &&
    Object.is(prior.geometryKey, geometryKey) &&
    Math.abs(Number(prior.anchorPixel) - anchorPixel) < 1e-9 &&
    Math.abs(Number(prior.currentPixelsPerTick) - currentPixelsPerTick) < 1e-9 &&
    Math.abs(Number(prior.expectedScrollLeft) - scrollLeft) < 1e-9;
  const origin = reusable ? prior : {
    geometryKey,
    anchorPixel,
    anchorTick: (scrollLeft + anchorPixel) / currentPixelsPerTick,
    originAnchorPixel: anchorPixel,
    originPixelsPerTick: currentPixelsPerTick,
    originScrollLeft: scrollLeft,
  };
  // Returning to the origin bypasses accumulated floating-point and device-pixel rounding.
  const returnsToOrigin = nextPixelsPerTick === origin.originPixelsPerTick &&
    anchorPixel === origin.originAnchorPixel;
  const exactScrollLeft = returnsToOrigin
    ? origin.originScrollLeft
    : origin.anchorTick * nextPixelsPerTick - anchorPixel;
  const bounded = clamp(exactScrollLeft, 0, maximumScrollLeft);
  const quantized = Math.round(bounded * devicePixelRatio) / devicePixelRatio;
  const nextScrollLeft = returnsToOrigin
    ? bounded
    : clamp(quantized, 0, maximumScrollLeft);
  return {
    scrollLeft: nextScrollLeft,
    anchor: {
      ...origin,
      anchorPixel,
      currentPixelsPerTick: nextPixelsPerTick,
      expectedScrollLeft: nextScrollLeft,
    },
  };
}

export function visibleTickRange(
  transform: Partial<TickPixelTransform>,
  viewportWidth: unknown,
  options: VisibleTickOptions = {},
) {
  const width = nonnegativeNumber(viewportWidth, 'viewportWidth');
  const viewportLeft = finiteNumber(options.viewportLeft ?? 0, 'viewportLeft');
  const overscanPixels = nonnegativeNumber(options.overscanPixels ?? 0, 'overscanPixels');
  const minimumTick = finiteNumber(options.minimumTick ?? 0, 'minimumTick');
  const maximumTick = options.maximumTick == null
    ? Infinity
    : Number(options.maximumTick);
  if (Number.isNaN(maximumTick) || maximumTick < minimumTick) {
    throw new RangeError('maximumTick must be at least minimumTick.');
  }

  const startTick = Math.min(maximumTick, Math.max(
    minimumTick,
    Math.floor(pixelToTick(viewportLeft - overscanPixels, transform)),
  ));
  if (!width && !overscanPixels) {
    return { startTick, endTick: startTick, durationTicks: 0 };
  }
  const endTick = Math.max(startTick, Math.min(
    maximumTick,
    Math.ceil(pixelToTick(viewportLeft + width + overscanPixels, transform)),
  ));
  return { startTick, endTick, durationTicks: endTick - startTick };
}

export function buildRowPrefixIndex<T extends number | { height?: unknown }>(
  rows: T[] | null | undefined,
  heightForRow: ((row: T, index: number) => unknown) | null = null,
): TimelineRowPrefixIndex {
  const entries = Array.isArray(rows) ? rows : [];
  const offsets = new Array<number>(entries.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const rawHeight = heightForRow
      ? heightForRow(entry, index)
      : typeof entry === 'number'
        ? entry
        : entry.height;
    const height = nonnegativeNumber(rawHeight, `row height at index ${index}`);
    offsets[index + 1] = (offsets[index] ?? 0) + height;
  }
  return {
    offsets,
    rowCount: entries.length,
    totalHeight: offsets[offsets.length - 1] ?? 0,
  };
}

function firstRowEndingAfter(offsets: number[], value: number): number {
  let lower = 0;
  let upper = offsets.length - 1;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if ((offsets[middle + 1] ?? Infinity) <= value) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function firstRowStartingAtOrAfter(offsets: number[], value: number): number {
  let lower = 0;
  let upper = offsets.length - 1;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if ((offsets[middle] ?? Infinity) < value) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

// Prefix intervals are half-open: include a partially visible top row and exclude the
// first row whose start lies at or beyond the bottom edge.
export function visibleRowRange(
  prefixIndex: TimelineRowPrefixIndex,
  scrollTop: unknown,
  viewportHeight: unknown,
  overscanPixels: unknown = 0,
) {
  const offsets = prefixIndex?.offsets;
  if (!Array.isArray(offsets) || offsets.length !== Number(prefixIndex?.rowCount) + 1) {
    throw new TypeError('prefixIndex must come from buildRowPrefixIndex().');
  }
  const top = clamp(
    finiteNumber(scrollTop, 'scrollTop') - nonnegativeNumber(overscanPixels, 'overscanPixels'),
    0,
    prefixIndex.totalHeight,
  );
  const bottom = clamp(
    finiteNumber(scrollTop, 'scrollTop') +
      nonnegativeNumber(viewportHeight, 'viewportHeight') +
      nonnegativeNumber(overscanPixels, 'overscanPixels'),
    0,
    prefixIndex.totalHeight,
  );
  if (!prefixIndex.rowCount || bottom <= top) {
    const index = firstRowEndingAfter(offsets, top);
    return {
      startIndex: index,
      endIndex: index,
      startOffset: offsets[index] ?? 0,
      endOffset: offsets[index] ?? 0,
    };
  }
  const startIndex = firstRowEndingAfter(offsets, top);
  const endIndex = Math.max(
    startIndex,
    firstRowStartingAtOrAfter(offsets, bottom),
  );
  return {
    startIndex,
    endIndex,
    startOffset: offsets[startIndex] ?? 0,
    endOffset: offsets[endIndex] ?? 0,
  };
}

export function intersectTickIntervals(
  first: Partial<TimelineTickRange>,
  second: Partial<TimelineTickRange>,
) {
  const firstInterval = intervalFor(first);
  const secondInterval = intervalFor(second);
  if (!firstInterval || !secondInterval) return null;
  const startTick = Math.max(firstInterval.startTick, secondInterval.startTick);
  const endTick = Math.min(firstInterval.endTick, secondInterval.endTick);
  return endTick > startTick
    ? { startTick, endTick, durationTicks: endTick - startTick }
    : null;
}

export function intersectClipRange(clip: TimelineClip, range: Partial<TimelineTickRange>) {
  const startTick = clipStartTick(clip);
  const endTick = clipEndTick(clip);
  if (!Number.isFinite(startTick) || !Number.isFinite(endTick)) return null;
  return intersectTickIntervals({ startTick, endTick }, range);
}

export function projectFrameKeyMarkers(
  clip: TimelineClip,
  transform: Partial<TickPixelTransform>,
  visibleRange: Partial<TimelineTickRange> | null = null,
) {
  const markers: Array<{
    clipId: string;
    keyIndex: number;
    sourceTick: number;
    timelineTick: number;
    pixel: number;
  }> = [];
  const startTick = clipStartTick(clip);
  const inTick = Number(clip?.inTick);
  const outTick = Number(clip?.outTick);
  if (![startTick, inTick, outTick].every(Number.isFinite) || outTick <= inTick) return markers;
  const range = visibleRange == null
    ? { startTick: -Infinity, endTick: Infinity }
    : intervalFor(visibleRange);
  if (!range || range.endTick <= range.startTick) return markers;

  const keys = Array.isArray(clip?.frameKeys) ? clip.frameKeys : [];
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
    const sourceTick = Number(keys[keyIndex]?.tick);
    if (!Number.isFinite(sourceTick) || sourceTick < inTick || sourceTick >= outTick) continue;
    const timelineTick = startTick + sourceTick - inTick;
    if (timelineTick < range.startTick || timelineTick >= range.endTick) continue;
    markers.push({
      clipId: clip.id,
      keyIndex,
      sourceTick,
      timelineTick,
      pixel: tickToPixel(timelineTick, transform),
    });
  }
  return markers;
}

export function buildClipExposureSegments(
  clip: TimelineClip,
  visibleRange: Partial<TimelineTickRange> | null = null,
): TimelineExposureSegment[] {
  const segments: TimelineExposureSegment[] = [];
  const clipStart = clipStartTick(clip);
  const inTick = Number(clip?.inTick);
  const outTick = Number(clip?.outTick);
  const keys = Array.isArray(clip?.frameKeys) ? clip.frameKeys : [];
  if (![clipStart, inTick, outTick].every(Number.isFinite) || outTick <= inTick || !keys.length) {
    return segments;
  }
  const clipRange = { startTick: clipStart, endTick: clipStart + outTick - inTick };
  const renderRange = visibleRange == null
    ? clipRange
    : intersectTickIntervals(clipRange, visibleRange);
  if (!renderRange) return segments;

  let firstIndex = 0;
  for (let index = 0; index < keys.length; index++) {
    const sourceTick = Number(keys[index]?.tick);
    if (!Number.isFinite(sourceTick)) continue;
    if (sourceTick <= inTick) firstIndex = index;
    else break;
  }
  if (Number(keys[firstIndex]?.tick) > inTick) {
    while (firstIndex < keys.length && Number(keys[firstIndex]?.tick) < inTick) firstIndex++;
  }

  for (let keyIndex = firstIndex; keyIndex < keys.length; keyIndex++) {
    const sourceTick = Number(keys[keyIndex]?.tick);
    if (!Number.isFinite(sourceTick)) continue;
    if (sourceTick >= outTick) break;
    const nextSourceTick = keyIndex + 1 < keys.length
      ? Number(keys[keyIndex + 1]?.tick)
      : outTick;
    const sourceStartTick = Math.max(inTick, sourceTick);
    const sourceEndTick = Math.min(
      outTick,
      Number.isFinite(nextSourceTick) ? nextSourceTick : outTick,
    );
    if (sourceEndTick <= sourceStartTick) continue;
    const fullStartTick = clipStart + sourceStartTick - inTick;
    const fullEndTick = clipStart + sourceEndTick - inTick;
    const visible = intersectTickIntervals(
      { startTick: fullStartTick, endTick: fullEndTick },
      renderRange,
    );
    if (!visible) continue;
    segments.push({
      clipId: clip.id,
      keyIndex,
      sourceTick,
      startTick: visible.startTick,
      endTick: visible.endTick,
      durationTicks: visible.durationTicks,
      heldFromBeforeClip: sourceTick < inTick,
      continuesBefore: visible.startTick > fullStartTick,
      continuesAfter: visible.endTick < fullEndTick,
    });
  }
  return segments;
}

export function findCommonTrackGap(
  clips: TimelineClip[],
  trackIds: TimelineIdSource,
  timelineTick: unknown,
  options: TimelineRangeOptions = {},
) {
  const ids = iterableIds(trackIds);
  if (!ids.length) return null;
  const selected = new Set(ids);
  const tick = finiteNumber(timelineTick, 'timelineTick');
  const minimumTick = finiteNumber(options.minimumTick ?? 0, 'minimumTick');
  const maximumTick = options.maximumTick == null ? Infinity : Number(options.maximumTick);
  if (Number.isNaN(maximumTick) || maximumTick < minimumTick) {
    throw new RangeError('maximumTick must be at least minimumTick.');
  }
  if (tick < minimumTick || tick >= maximumTick) return null;

  let startTick = minimumTick;
  let endTick = maximumTick;
  for (const clip of Array.isArray(clips) ? clips : []) {
    if (!selected.has(String(clip?.trackId))) continue;
    const start = clipStartTick(clip);
    const end = clipEndTick(clip);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start <= tick && tick < end) return null;
    if (end <= tick) startTick = Math.max(startTick, end);
    if (start > tick) endTick = Math.min(endTick, start);
  }
  if (endTick <= startTick) return null;
  return {
    trackIds: ids,
    startTick,
    endTick,
    durationTicks: endTick - startTick,
  };
}

export function resolveTimelineTrackScope({
  allTrackIds = [],
  selectedTrackIds = [],
  hoveredTrackId = null,
  rulerAll = false,
}: TimelineTrackScopeOptions = {}) {
  const all = iterableIds(allTrackIds);
  const known = new Set(all);
  const selectedSet = new Set(iterableIds(selectedTrackIds));
  const selected = all.length
    ? all.filter((id) => selectedSet.has(id))
    : [...selectedSet];
  if (rulerAll) return { kind: 'ruler-all', trackIds: all };
  if (selected.length) return { kind: 'selected', trackIds: selected };
  if (hoveredTrackId != null) {
    const hovered = String(hoveredTrackId);
    if (!all.length || known.has(hovered)) {
      return { kind: 'hovered', trackIds: [hovered] };
    }
  }
  return { kind: 'none', trackIds: [] };
}

export function snapTimelineTick(
  timelineTick: unknown,
  options: SnapTimelineOptions = {},
): TimelineSnapResult {
  const requestedTick = finiteNumber(timelineTick, 'timelineTick');
  if (options.altKey) {
    return {
      requestedTick,
      tick: requestedTick,
      snapped: false,
      distanceTicks: 0,
      distancePixels: 0,
      target: null,
    };
  }
  const pixelsPerTick = positiveNumber(
    options.pixelsPerTick ?? options.transform?.pixelsPerTick ?? 1,
    'pixelsPerTick',
  );
  const thresholdPixels = nonnegativeNumber(options.thresholdPixels ?? 6, 'thresholdPixels');
  const selectedTracks = options.trackIds == null ? null : new Set(iterableIds(options.trackIds));
  const excludedClips = new Set(iterableIds(options.excludeClipIds));
  interface SnapCandidate {
    tick: number;
    priority: number;
    target: TimelineSnapTarget;
    distanceTicks: number;
    distancePixels: number;
    identity: string;
  }
  const best: { value: SnapCandidate | null } = { value: null };

  function consider(tick: number, priority: number, target: TimelineSnapTarget): void {
    if (!Number.isFinite(tick)) return;
    const distanceTicks = Math.abs(tick - requestedTick);
    const distancePixels = distanceTicks * pixelsPerTick;
    if (distancePixels > thresholdPixels) return;
    const identity = target.kind === 'playhead'
      ? '\u0000'
      : `${target.clipId}\u0000${target.kind === 'frame-key' ? target.sourceTick : ''}`;
    const current = best.value;
    if (current && (
      distancePixels > current.distancePixels ||
      (distancePixels === current.distancePixels && priority > current.priority) ||
      (distancePixels === current.distancePixels && priority === current.priority && tick > current.tick) ||
      (distancePixels === current.distancePixels && priority === current.priority &&
        tick === current.tick && identity >= current.identity)
    )) return;
    best.value = { tick, priority, target, distanceTicks, distancePixels, identity };
  }

  if (Number.isFinite(Number(options.playheadTick))) {
    const tick = Number(options.playheadTick);
    consider(tick, 0, { kind: 'playhead', tick });
  }
  for (const clip of Array.isArray(options.clips) ? options.clips : []) {
    const clipId = String(clip?.id ?? '');
    const trackId = String(clip?.trackId ?? '');
    if (excludedClips.has(clipId) || (selectedTracks && !selectedTracks.has(trackId))) continue;
    const startTick = clipStartTick(clip);
    const endTick = clipEndTick(clip);
    consider(startTick, 1, { kind: 'clip-start', tick: startTick, clipId, trackId });
    consider(endTick, 2, { kind: 'clip-end', tick: endTick, clipId, trackId });
    const inTick = Number(clip?.inTick);
    const outTick = Number(clip?.outTick);
    for (const key of Array.isArray(clip?.frameKeys) ? clip.frameKeys : []) {
      const sourceTick = Number(key?.tick);
      if (!Number.isFinite(sourceTick) || sourceTick < inTick || sourceTick >= outTick) continue;
      const tick = startTick + sourceTick - inTick;
      consider(tick, 3, {
        kind: 'frame-key',
        tick,
        clipId,
        trackId,
        sourceTick,
      });
    }
  }
  const resolved = best.value;
  if (!resolved) {
    return {
      requestedTick,
      tick: requestedTick,
      snapped: false,
      distanceTicks: 0,
      distancePixels: 0,
      target: null,
    };
  }
  return {
    requestedTick,
    tick: resolved.tick,
    snapped: true,
    distanceTicks: resolved.distanceTicks,
    distancePixels: resolved.distancePixels,
    target: resolved.target,
  };
}

function resizeSide(edge: unknown): TimelineEdge | null {
  if (edge === 'start' || edge === 'in') return 'start';
  if (edge === 'end' || edge === 'out') return 'end';
  return null;
}

// Shared-edge resize intersects every eligible clip's collision bounds so one clamp
// preserves alignment across the selection.
export function planSelectedClipEdgeResize(
  state: ClipTimelineState | TimelineClip[],
  selectedClipIds: TimelineIdSource,
  edge: TimelineEdgeInput | unknown,
  edgeTick: unknown,
  deltaTicks: unknown,
) {
  const clips = Array.isArray(state) ? state : Array.isArray(state?.clips) ? state.clips : [];
  const tracks = Array.isArray(state) ? [] : state.tracks;
  const ids = new Set(iterableIds(selectedClipIds));
  const side = resizeSide(edge);
  if (!ids.size || !side) return null;
  const firstSelected = clips.find((clip) => ids.has(String(clip?.id)));
  if (!firstSelected) return null;
  const sharedEdgeTick = edgeTick == null
    ? side === 'start' ? clipStartTick(firstSelected) : clipEndTick(firstSelected)
    : finiteNumber(edgeTick, 'edgeTick');
  const lockedTracks = new Set(tracks.filter((track) => track?.locked).map((track) => String(track.id)));
  const eligible = clips.filter((clip) =>
    ids.has(String(clip?.id)) &&
    !lockedTracks.has(String(clip?.trackId)) &&
    (side === 'start' ? clipStartTick(clip) : clipEndTick(clip)) === sharedEdgeTick);
  if (!eligible.length) return null;

  let minimumDeltaTicks = -Infinity;
  let maximumDeltaTicks = Infinity;
  for (const clip of eligible) {
    const startTick = clipStartTick(clip);
    const endTick = clipEndTick(clip);
    if (side === 'start') {
      let priorEndTick = 0;
      if (clip?.kind !== 'audio') {
        for (const other of clips) {
          if (other === clip || other?.trackId !== clip?.trackId) continue;
          const otherEnd = clipEndTick(other);
          if (otherEnd <= startTick) priorEndTick = Math.max(priorEndTick, otherEnd);
        }
      }
      minimumDeltaTicks = Math.max(minimumDeltaTicks, -startTick, priorEndTick - startTick);
      maximumDeltaTicks = Math.min(maximumDeltaTicks, endTick - startTick - 1);
    } else {
      let nextStartTick = Infinity;
      if (clip?.kind !== 'audio') {
        for (const other of clips) {
          if (other === clip || other?.trackId !== clip?.trackId) continue;
          const otherStart = clipStartTick(other);
          if (otherStart >= endTick) nextStartTick = Math.min(nextStartTick, otherStart);
        }
      }
      minimumDeltaTicks = Math.max(minimumDeltaTicks, startTick + 1 - endTick);
      maximumDeltaTicks = Math.min(maximumDeltaTicks, nextStartTick - endTick);
    }
  }
  const requestedDeltaTicks = Math.round(finiteNumber(deltaTicks, 'deltaTicks'));
  const appliedDeltaTicks = clamp(requestedDeltaTicks, minimumDeltaTicks, maximumDeltaTicks);
  return {
    edge: side,
    sharedEdgeTick,
    requestedDeltaTicks,
    minimumDeltaTicks,
    maximumDeltaTicks,
    deltaTicks: appliedDeltaTicks,
    targetEdgeTick: sharedEdgeTick + appliedDeltaTicks,
    clipIds: eligible.map((clip) => clip.id),
  };
}

function scrollWindowMetrics(options: ScrollWindowOptions): ScrollWindowMetrics {
  const totalTicks = nonnegativeNumber(options.totalTicks, 'totalTicks');
  const pixelsPerTick = positiveNumber(options.pixelsPerTick, 'pixelsPerTick');
  const viewportWidth = nonnegativeNumber(options.viewportWidth, 'viewportWidth');
  const maxScrollPixels = positiveNumber(
    options.maxScrollPixels ?? DEFAULT_MAX_TIMELINE_SCROLL_PIXELS,
    'maxScrollPixels',
  );
  if (viewportWidth > maxScrollPixels) {
    throw new RangeError('maxScrollPixels must be at least viewportWidth.');
  }
  const scrollWidth = Math.max(viewportWidth, Math.min(totalTicks * pixelsPerTick, maxScrollPixels));
  const maxScrollLeft = Math.max(0, scrollWidth - viewportWidth);
  const visibleTicks = viewportWidth / pixelsPerTick;
  const maxLogicalStartTick = Math.max(0, totalTicks - visibleTicks);
  const windowTicks = scrollWidth / pixelsPerTick;
  const maxLogicalOriginTick = Math.max(0, totalTicks - windowTicks);
  const defaultMargin = Math.min(maxScrollLeft / 2, maxScrollPixels * 0.2);
  const rebaseMarginPixels = clamp(
    nonnegativeNumber(options.rebaseMarginPixels ?? defaultMargin, 'rebaseMarginPixels'),
    0,
    maxScrollLeft / 2,
  );
  return {
    totalTicks,
    pixelsPerTick,
    viewportWidth,
    maxScrollPixels,
    rebaseMarginPixels,
    scrollWidth,
    maxScrollLeft,
    visibleTicks,
    maxLogicalStartTick,
    windowTicks,
    maxLogicalOriginTick,
  };
}

function positionScrollWindow(
  metrics: ScrollWindowMetrics,
  logicalStartTick: unknown,
): LogicalScrollWindow {
  const logicalStart = clamp(
    finiteNumber(logicalStartTick, 'logicalStartTick'),
    0,
    metrics.maxLogicalStartTick,
  );
  const centeredScrollLeft = metrics.maxScrollLeft / 2;
  const logicalOriginTick = clamp(
    logicalStart - centeredScrollLeft / metrics.pixelsPerTick,
    0,
    metrics.maxLogicalOriginTick,
  );
  const scrollLeft = clamp(
    (logicalStart - logicalOriginTick) * metrics.pixelsPerTick,
    0,
    metrics.maxScrollLeft,
  );
  return {
    totalTicks: metrics.totalTicks,
    pixelsPerTick: metrics.pixelsPerTick,
    viewportWidth: metrics.viewportWidth,
    maxScrollPixels: metrics.maxScrollPixels,
    rebaseMarginPixels: metrics.rebaseMarginPixels,
    scrollWidth: metrics.scrollWidth,
    maxScrollLeft: metrics.maxScrollLeft,
    logicalOriginTick,
    logicalWindowEndTick: Math.min(
      metrics.totalTicks,
      logicalOriginTick + metrics.windowTicks,
    ),
    logicalStartTick: logicalStart,
    logicalEndTick: Math.min(metrics.totalTicks, logicalStart + metrics.visibleTicks),
    scrollLeft,
    rebased: false,
    scrollAdjustmentPixels: 0,
  };
}

export function createLogicalScrollWindow(options: ScrollWindowOptions = {}): LogicalScrollWindow {
  const metrics = scrollWindowMetrics(options);
  return positionScrollWindow(metrics, options.logicalStartTick ?? 0);
}

/**
 * Recenters a capped physical scroll window near either edge without changing
 * the logical tick at the viewport's left edge.
 */
export function rebaseLogicalScrollWindow(
  window: LogicalScrollWindow,
  scrollLeft: unknown,
): LogicalScrollWindow {
  const metrics = scrollWindowMetrics(window || {});
  const physicalScrollLeft = clamp(
    finiteNumber(scrollLeft, 'scrollLeft'),
    0,
    metrics.maxScrollLeft,
  );
  const originTick = clamp(
    finiteNumber(window?.logicalOriginTick ?? 0, 'logicalOriginTick'),
    0,
    metrics.maxLogicalOriginTick,
  );
  const logicalStartTick = clamp(
    originTick + physicalScrollLeft / metrics.pixelsPerTick,
    0,
    metrics.maxLogicalStartTick,
  );
  const canRebaseLeft = originTick > 0;
  const canRebaseRight = originTick < metrics.maxLogicalOriginTick;
  const nearLeft = physicalScrollLeft <= metrics.rebaseMarginPixels;
  const nearRight = physicalScrollLeft >= metrics.maxScrollLeft - metrics.rebaseMarginPixels;
  if ((nearLeft && canRebaseLeft) || (nearRight && canRebaseRight)) {
    const rebased = positionScrollWindow(metrics, logicalStartTick);
    return {
      ...rebased,
      rebased: true,
      scrollAdjustmentPixels: rebased.scrollLeft - physicalScrollLeft,
    };
  }
  return {
    ...positionScrollWindow(metrics, logicalStartTick),
    logicalOriginTick: originTick,
    logicalWindowEndTick: Math.min(metrics.totalTicks, originTick + metrics.windowTicks),
    scrollLeft: physicalScrollLeft,
  };
}
