<script>
  import Icon from './Icon.svelte';
  import { flushSync, onDestroy, onMount, tick as domTick, untrack } from 'svelte';
  import {
    captureClipTimelineRevisionGuard,
    canonicalClipTimeline,
    clipTimelineMutationRevision,
    clipTimelineSelection,
    durationTicks as canonicalDurationTicks,
    getClipTimelineState,
    isClipTimelineRevisionGuardCurrent,
    playheadTick as canonicalPlayheadTick,
  } from '../lib/clipTimelineState.js';
  import {
    clearClipSelection,
    commitLayersToActiveFrame,
    deleteClipSelection,
    duplicateClips,
    fps,
    moveClips,
    moveTimelineKeys,
    playing,
    razorClip,
    razorClips,
    removeTimelineTag,
    seekTick,
    setTimelineTag,
    setClipSelection,
    togglePlay,
    trimClips,
  } from '../lib/frames.js';
  import {
    audioAssets,
    updateAudioClip,
  } from '../lib/audio.js';
  import {
    beginStroke,
    cancelStroke,
    dims,
    endStroke,
    noteAuthoredMutation,
    selectLayerPart,
  } from '../lib/grid.js';
  import {
    buildClipExposureSegments,
    buildRowPrefixIndex,
    createTickPixelTransform,
    pixelToTick,
    planAnchoredTimelineZoom,
    projectFrameKeyMarkers,
    tickToPixel,
    visibleRowRange,
    visibleTickRange,
  } from '../lib/timelineViewport.js';
  import {
    isEditingTarget,
    isPlaybackShortcut,
    keyboardContextOwns,
    noteKeyboardContext,
    planSelectionDeselect,
    planTimelineKeyMotion,
    releaseKeyboardContext as releaseEditorKeyboardContext,
    setKeyboardContext,
  } from '../lib/timelineKeys.js';
  import { onProjectReplaced } from '../lib/documentLifecycle.js';
  import {
    releaseAudioMediaRequests,
    syncAudioMediaRequests,
  } from '../lib/mediaRuntime.js';
  import { mediaRuntimeStatus } from '../lib/mediaRegistry.js';
  import {
    planClipClick,
    planClipContext,
    planClipDuplicateMove,
    planClipMove,
    planClipPropertyKeyMarkers,
    planClipTrimHandleLayout,
    planClipTrim,
    planFrameKeyClick,
    planGapClick,
    planPropertyKeyClick,
    planRazorClick,
    planRazorDrag,
    planTimelineDelete,
    planTimelineDeleteKey,
    planTimelineKeyContext,
    planTimelineMarquee,
    planTimelineKeyMarkerLayout,
    planTimelinePointerIntent,
    planTrackHeaderClick,
    timelinePropertyLabel as propertyLabel,
    timelineSelectionLayerTarget,
  } from '../lib/clipTimelineUi.js';
  import {
    buildFilmstripSamples,
    buildFrameThumbnailModel,
    frameThumbnail,
    thumbnailFrameValue,
  } from '../lib/timelineThumbnails.js';
  import {
    clampTrackHeaderWidth,
    clampedRulerTickFromPixel,
    buildTimelineTagMarkers,
    maximumTrackHeaderWidth,
    planTimelineTagMove,
    planTimelineTagGesture,
    planTimelineMutationTransition,
    resizeTrackHeaderFromPointer,
    resizeTrackHeaderWithKey,
    rulerTickFromPixel,
    TIMELINE_POINTER_DRAG_THRESHOLD,
    timelineExtentTicks,
    timelineTagMarkerLayout,
    trackHeaderDividerGeometry,
    timelineToolForShortcut,
    timelineWheelZoom,
    timelineZoomForShortcut,
  } from '../lib/timelineUiState.js';
  import { validLoopRange } from '../lib/timelineTags.js';
  import { popupFocus, popupOpen } from '../lib/popupFocus.js';
  import { canvasFont } from '../lib/font.js';
  import { resolveClipTimelineLayers } from '../lib/clipTimelineResolver.js';
  import { readThemeColor } from '../lib/themeColors.js';

  /**
   * @typedef {Object} Props
   * @property {boolean} [expanded]
   * @property {number} [pixelsPerTick]
   * @property {boolean} [showFilmstrip]
   * @property {string} [tool]
   * @property {number} [trackHeaderWidth]
   * @property {(detail: { enabled: boolean }) => void} [onFilmstripToggle]
   * @property {(event: PointerEvent) => void} [onpointerdown]
   */

  /** @type {Props} */
  let {
    expanded = true,
    pixelsPerTick = $bindable(14),
    showFilmstrip = $bindable(false),
    tool = $bindable('select'),
    trackHeaderWidth = $bindable(176),
    onFilmstripToggle = () => {},
    onpointerdown,
  } = $props();

  const RULER_H = 30;
  const COMPACT_ROW_H = 42;
  const FILMSTRIP_ROW_H = 56;
  const MIN_ZOOM = 4;
  const MAX_ZOOM = 48;

  let rootEl = $state();
  let viewportEl = $state();
  let viewportWidth = $state(1);
  let viewportHeight = $state(1);
  let scrollLeft = $state(0);
  let scrollTop = $state(0);
  let collapsedGroups = $state(new Set());
  let trackAnchor = null;
  let clipAnchor = null;
  let frameKeyAnchor = null;
  let propertyKeyAnchor = null;
  let pointerEdit = $state(null);
  let headerResize = $state(null);
  let contextMenu = $state(null);
  let tagEditor = $state(null);
  let tagType = $state('custom');
  let tagValue = $state('');
  let tagTick = $state(0);
  let tagInputEl = $state();
  let tagTypeEl = $state();
  let hoverPreview = $state(null);
  let observedMutationRevision = null;
  let lastExpanded = untrack(() => expanded);
  let lastTool = tool;
  let collapsedViewport = null;
  let viewportGeneration = 0;
  let wheelZoomAnchor = null;

  onMount(() => onProjectReplaced(() => {
    collapsedGroups = new Set();
    closeTagEditor();
    clearTimelineContext(true);
  }));
  onDestroy(() => releaseAudioMediaRequests('clip-timeline'));

  function buildTimelineRows(tracks, collapsed) {
    const ordered = [...(tracks || [])];
    const byId = new Map(ordered.map((track) => [String(track.id), track]));
    const parentIds = new Set(ordered.map((track) => String(track.parentTrackId || '')));
    return ordered.flatMap((track) => {
      let depth = 0;
      let parentId = track.parentTrackId == null ? null : String(track.parentTrackId);
      const seen = new Set();
      let hidden = false;
      while (parentId && byId.has(parentId) && !seen.has(parentId)) {
        seen.add(parentId);
        depth++;
        if (collapsed.has(parentId)) hidden = true;
        parentId = byId.get(parentId)?.parentTrackId == null
          ? null
          : String(byId.get(parentId).parentTrackId);
      }
      return hidden ? [] : [{
        id: String(track.id),
        track,
        kind: track.kind === 'audio'
          ? 'audio'
          : track.kind === 'group' ? 'group' : 'visual',
        depth,
        hasChildren: parentIds.has(String(track.id)),
      }];
    });
  }

  function buildRulerTicks(range, scale) {
    const targetTicks = 62 / scale;
    const power = 10 ** Math.floor(Math.log10(Math.max(1, targetTicks)));
    const major = [1, 2, 5, 10].map((value) => value * power)
      .find((value) => value >= targetTicks) || power * 10;
    const step = scale >= 8 ? 1 : major;
    const start = Math.ceil(range.startTick / step) * step;
    const ticks = [];
    for (let value = start; value <= range.endTick; value += step) {
      ticks.push({ tick: value, major: value % major === 0 });
    }
    return ticks;
  }

  function measureViewport(node) {
    viewportGeneration++;
    wheelZoomAnchor = null;
    const update = () => {
      viewportWidth = Math.max(1, node.clientWidth);
      viewportHeight = Math.max(1, node.clientHeight);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(node);
    update();
    scrollLeft = node.scrollLeft;
    scrollTop = node.scrollTop;
    return { destroy: () => observer?.disconnect() };
  }

  function onScroll(event) {
    const nextScrollLeft = event.currentTarget.scrollLeft;
    if (wheelZoomAnchor &&
      Math.abs(nextScrollLeft - wheelZoomAnchor.expectedScrollLeft) >= 1e-9) {
      wheelZoomAnchor = null;
    }
    scrollLeft = nextScrollLeft;
    scrollTop = event.currentTarget.scrollTop;
  }

  export async function setZoom(value, anchorClientX = null, options = {}) {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(value) || zoom));
    if (next === zoom) return;
    const rect = viewportEl?.getBoundingClientRect();
    const pointerAnchor = Number.isFinite(Number(anchorClientX)) && rect
      ? Number(anchorClientX) - rect.left - headerWidth
      : laneViewportWidth / 2;
    const anchorPixel = Math.max(0, Math.min(laneViewportWidth, pointerAnchor));
    const wheel = options.source === 'wheel';
    const generation = viewportGeneration;
    const targetViewport = viewportEl;
    const devicePixelRatio = Math.max(0.01, Number(window.devicePixelRatio) || 1);
    const geometryKey = wheel
      ? `${generation}:${rect?.left ?? 0}:${rect?.width ?? viewportWidth}:${headerWidth}:${anchorPixel}:${devicePixelRatio}`
      : null;
    const planned = planAnchoredTimelineZoom({
      anchor: wheel ? wheelZoomAnchor : null,
      scrollLeft: targetViewport?.scrollLeft ?? scrollLeft,
      currentPixelsPerTick: zoom,
      nextPixelsPerTick: next,
      anchorPixel,
      devicePixelRatio,
      geometryKey,
    });
    wheelZoomAnchor = wheel ? planned.anchor : null;
    pixelsPerTick = next;
    flushSync();
    if (!viewportEl || viewportEl !== targetViewport || generation !== viewportGeneration) {
      if (wheel) wheelZoomAnchor = null;
      return;
    }
    viewportEl.scrollLeft = planned.scrollLeft;
    scrollLeft = viewportEl.scrollLeft;
    if (wheel && wheelZoomAnchor === planned.anchor) {
      wheelZoomAnchor = { ...planned.anchor, expectedScrollLeft: scrollLeft };
    }
  }

  function handleWheel(event) {
    const planned = timelineWheelZoom(event, zoom, {
      contextOwned: true,
      minimum: MIN_ZOOM,
      maximum: MAX_ZOOM,
      suppressed: isEditingTarget(event.target) || !!contextMenu || !!tagEditor || $popupOpen,
    });
    if (!planned.handled) return;
    event.preventDefault();
    focusTimeline();
    setZoom(planned.zoom, event.clientX, { source: 'wheel' });
  }

  export function focusTimeline() {
    setKeyboardContext('timeline');
    rootEl?.focus({ preventScroll: true });
  }

  export function deselectTimeline() {
    trackAnchor = null;
    clipAnchor = null;
    frameKeyAnchor = null;
    propertyKeyAnchor = null;
    if (hasCanonicalSelection()) clearClipSelection();
  }

  function captureCollapsedViewport() {
    return viewportEl
      ? {
          left: viewportEl.scrollLeft,
          top: viewportEl.scrollTop,
          atRight: viewportEl.scrollWidth - viewportEl.clientWidth - viewportEl.scrollLeft <= 1,
          atBottom: viewportEl.scrollHeight - viewportEl.clientHeight - viewportEl.scrollTop <=
            Math.max(1, rowHeight / 2),
        }
      : { left: scrollLeft, top: scrollTop, atRight: false, atBottom: false };
  }

  export function prepareCollapse() {
    collapsedViewport = captureCollapsedViewport();
  }

  function setTool(next) {
    if (pointerEdit) finishPointer(null, true);
    tool = next;
    hoverPreview = null;
    contextMenu = null;
    closeTagEditor();
    focusTimeline();
  }

  function releaseKeyboardContext() {
    releaseEditorKeyboardContext('timeline', rootEl);
  }

  function clearTimelineContext(clearSelection = false) {
    if (pointerEdit) finishPointer(null, true);
    if (headerResize) finishHeaderResize(null, true);
    contextMenu = null;
    hoverPreview = null;
    closeTagEditor();
    trackAnchor = null;
    clipAnchor = null;
    frameKeyAnchor = null;
    propertyKeyAnchor = null;
    releaseKeyboardContext();
    if (clearSelection && hasCanonicalSelection()) clearClipSelection();
  }

  function handleMutationRevision(revision) {
    const transition = planTimelineMutationTransition(observedMutationRevision, revision, {
      pointerEdit,
      headerResize,
    });
    observedMutationRevision = transition.revision;
    if (!transition.changed) return;
    if (transition.cancelPointer) finishPointer(null, true);
    if (transition.cancelHeaderResize) finishHeaderResize(null, true);
    contextMenu = null;
    hoverPreview = null;
    releaseKeyboardContext();
  }

  function handleExpandedChange(nextExpanded) {
    const next = Boolean(nextExpanded);
    if (lastExpanded && !next) {
      if (!collapsedViewport) collapsedViewport = captureCollapsedViewport();
      clearTimelineContext(true);
    } else if (!lastExpanded && next && collapsedViewport) {
      const saved = collapsedViewport;
      domTick().then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!viewportEl || !expanded || collapsedViewport !== saved) return;
        // Edge anchors follow post-layout extents; interior positions retain exact pixels.
        viewportEl.scrollLeft = saved.atRight
          ? viewportEl.scrollWidth - viewportEl.clientWidth
          : saved.left;
        viewportEl.scrollTop = saved.atBottom
          ? viewportEl.scrollHeight - viewportEl.clientHeight
          : saved.top;
        scrollLeft = viewportEl.scrollLeft;
        scrollTop = viewportEl.scrollTop;
        collapsedViewport = null;
      })));
    }
    lastExpanded = next;
  }

  function handleToolChange(nextTool) {
    if (nextTool === lastTool) return;
    lastTool = nextTool;
    if (pointerEdit) finishPointer(null, true);
    hoverPreview = null;
    contextMenu = null;
    closeTagEditor();
  }

  function toggleFilmstrip() {
    showFilmstrip = !showFilmstrip;
    onFilmstripToggle({ enabled: showFilmstrip });
  }

  function toggleGroupClick(event, trackId) {
    event.stopPropagation();
    toggleGroup(trackId);
  }

  function toggleGroup(trackId) {
    const next = new Set(collapsedGroups);
    const id = String(trackId);
    const collapsing = !next.has(id);
    if (collapsing) next.add(id);
    else next.delete(id);
    collapsedGroups = next;
    if (!collapsing) return;
    releaseKeyboardContext();
    contextMenu = null;
    const hiddenTrackIds = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const track of canonicalState.tracks) {
        const parentId = track.parentTrackId == null ? null : String(track.parentTrackId);
        if (parentId !== id && !hiddenTrackIds.has(parentId)) continue;
        const childId = String(track.id);
        if (!hiddenTrackIds.has(childId)) {
          hiddenTrackIds.add(childId);
          changed = true;
        }
      }
    }
    const selectedClipIds = new Set([
      ...$clipTimelineSelection.clipIds,
      ...$clipTimelineSelection.frameKeys.map((key) => String(key.clipId)),
      ...$clipTimelineSelection.propertyKeys.map((key) => String(key.clipId)),
    ]);
    const hiddenSelection = [...$clipTimelineSelection.trackHeaderIds]
      .some((selectedId) => hiddenTrackIds.has(String(selectedId))) ||
      ($clipTimelineSelection.gap?.trackIds || [])
        .some((selectedId) => hiddenTrackIds.has(String(selectedId))) ||
      canonicalState.clips.some((clip) =>
        hiddenTrackIds.has(String(clip.trackId)) && selectedClipIds.has(String(clip.id)));
    if (hiddenSelection) clearClipSelection();
  }

  function eventTimelinePixel(event) {
    const rect = viewportEl?.getBoundingClientRect();
    if (!rect) return 0;
    return event.clientX - rect.left - headerWidth + scrollLeft;
  }

  function eventTimelineTick(event) {
    return Math.max(0, pixelToTick(eventTimelinePixel(event), tickTransform));
  }

  function roundedEventTick(event) {
    return Math.max(0, Math.min(extentTicks - 1, Math.round(eventTimelineTick(event))));
  }

  function activeEventTick(event) {
    return rulerTickFromPixel(eventTimelinePixel(event), zoom, contentDurationTicks);
  }

  function clampedEventTick(event) {
    return clampedRulerTickFromPixel(eventTimelinePixel(event), zoom, contentDurationTicks);
  }

  function eventTimelineTagRow(event) {
    const rect = viewportEl?.getBoundingClientRect();
    if (!rect) return null;
    if (event.clientY < rect.top + RULER_H || event.clientY >= rect.bottom) return null;
    const rowIndex = Math.floor(
      (event.clientY - rect.top - RULER_H + scrollTop) / rowHeight,
    );
    return rowIndex >= 0 && rowIndex < rows.length ? rows[rowIndex] : null;
  }

  function tagPointerTarget(event, row, globalSurface = false) {
    const rect = viewportEl?.getBoundingClientRect();
    const targetRow = globalSurface
      ? null
      : row === undefined ? eventTimelineTagRow(event) : row;
    const insideLane = globalSurface
      ? Boolean(rect && event.clientY >= rect.top + RULER_H && event.clientY < rect.bottom)
      : row !== undefined || Boolean(rect && event.clientX >= rect.left + headerWidth);
    const tick = clampedEventTick(event);
    return {
      tick,
      rowId: targetRow?.id ?? null,
      ...(globalSurface ? { surface: 'global' } : {}),
      valid: insideLane && tick != null &&
        (globalSurface || (Boolean(targetRow) && targetRow.kind !== 'group')),
    };
  }

  function tagHoverPreview(target) {
    if (target?.tick == null || (target.surface !== 'global' && target.rowId == null)) return null;
    return {
      tool: 'tag',
      rowId: target.rowId,
      ...(target.surface === 'global' ? { surface: 'global' } : {}),
      tick: target.tick,
      valid: target.valid,
      title: target.valid ? `Add or edit tags at tick ${target.tick}` : '',
    };
  }

  function eventTimelineRow(event) {
    const rect = viewportEl?.getBoundingClientRect();
    if (!rect || !rows.length) return 0;
    const row = (event.clientY - rect.top - RULER_H + scrollTop) / rowHeight;
    return Math.max(0, Math.min(rows.length - Number.EPSILON, row));
  }

  function eventTimelinePoint(event) {
    return {
      tick: Math.max(0, eventTimelineTick(event)),
      row: eventTimelineRow(event),
    };
  }

  function hasCanonicalSelection(selection = $clipTimelineSelection) {
    return selection.clipIds.size || selection.frameKeys.length || selection.propertyKeys.length ||
      selection.trackHeaderIds.size || selection.gap || selection.rulerRange;
  }

  function applyTimelineSelection(selection, syncLayer = true) {
    const result = setClipSelection(selection);
    if (!syncLayer) return result;
    const target = timelineSelectionLayerTarget(canonicalState, selection);
    if (target && !selectLayerPart(target.layerId, target.part)) {
      selectLayerPart(target.layerId, 'layer');
    }
    return result;
  }

  function selectTrack(event, trackId) {
    const planned = planTrackHeaderClick(
      canonicalState,
      $clipTimelineSelection,
      trackId,
      event,
      trackAnchor,
    );
    trackAnchor = planned.anchorTrackId;
    applyTimelineSelection(planned.selection);
  }

  function selectClip(event, clip, preserveExisting = false) {
    const planned = planClipClick(
      canonicalState,
      $clipTimelineSelection,
      clip.id,
      {
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        preserveExisting,
      },
      clipAnchor,
    );
    clipAnchor = planned.anchorClipId;
    applyTimelineSelection(planned.selection);
    return planned.selection;
  }

  function selectFrameKey(event, clip, marker, preserveExisting = false) {
    rootEl?.focus({ preventScroll: true });
    const planned = planFrameKeyClick(
      canonicalState,
      $clipTimelineSelection,
      clip.id,
      marker.sourceTick,
      {
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        preserveExisting,
      },
      frameKeyAnchor,
    );
    frameKeyAnchor = planned.anchor;
    applyTimelineSelection(planned.selection);
    seekTick(marker.timelineTick);
    return planned.selection;
  }

  function selectPropertyKey(event, clip, marker, preserveExisting = false) {
    rootEl?.focus({ preventScroll: true });
    const planned = planPropertyKeyClick(
      canonicalState,
      $clipTimelineSelection,
      clip.id,
      marker.propertyName,
      marker.sourceTick,
      {
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        preserveExisting,
      },
      propertyKeyAnchor,
    );
    propertyKeyAnchor = planned.anchor;
    applyTimelineSelection(planned.selection);
    seekTick(marker.timelineTick);
    return planned.selection;
  }

  function keyPointerDown(event, row, clip, marker, kind) {
    event.stopPropagation();
    if (event.button !== 0) return;
    event.preventDefault();
    if ($playing) seekTick(marker.timelineTick);
    else if (tool === 'razor') startRazorPointer(event, row);
    else if (tool === 'tag') startTagPointer(event, row);
    else {
      const selected = kind === 'frame'
        ? frameKeySelected($clipTimelineSelection, clip.id, marker.sourceTick)
        : propertyKeySelected(
          $clipTimelineSelection,
          clip.id,
          marker.propertyName,
          marker.sourceTick,
        );
      const selection = kind === 'frame'
        ? selectFrameKey(event, clip, marker, selected)
        : selectPropertyKey(event, clip, marker, selected);
      if (row.track.locked) return;
      const targetSelected = kind === 'frame'
        ? frameKeySelected(selection, clip.id, marker.sourceTick)
        : propertyKeySelected(selection, clip.id, marker.propertyName, marker.sourceTick);
      if (!targetSelected) return;
      capturePointer(event, {
        type: 'move-key',
        state: getClipTimelineState(),
        selection,
      });
    }
  }

  function runHistoryEdit(edit, guard = null) {
    // Timeline opens only its own stroke; it must never close another editor's gesture.
    if ($playing || (guard && !isClipTimelineRevisionGuardCurrent(guard))) return false;
    if (guard) commitLayersToActiveFrame();
    const commitGuard = guard ? captureClipTimelineRevisionGuard() : null;
    if (beginStroke() !== true) return false;
    try {
      const changed = Boolean(edit(commitGuard));
      if (changed) endStroke(); else cancelStroke();
      return changed;
    } catch (error) {
      cancelStroke();
      throw error;
    }
  }

  function tagTitle(tag) {
    if (tag.type === 'loop-start') return `Loop start at tick ${tag.tick}`;
    if (tag.type === 'loop-end') return `Loop end at tick ${tag.tick}`;
    if (tag.cluster) {
      const shown = tag.customValues.slice(0, 3).map((value) => `“${value}”`).join(', ');
      const remaining = tag.customCount - Math.min(3, tag.customCount);
      return `${tag.customCount} custom tags at tick ${tag.tick}: ${shown}${remaining ? `, and ${remaining} more` : ''}`;
    }
    return `Custom tag “${tag.value}” at tick ${tag.tick}`;
  }

  function closeTagEditor() {
    tagEditor = null;
    tagType = 'custom';
    tagValue = '';
    tagTick = 0;
  }

  async function openTagEditor(event, tick, tag = null) {
    if ($playing || tick == null || tick < 0 || tick >= contentDurationTicks) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const width = 258;
    const height = 280;
    const x = Math.max(4, Math.min(
      Number(event?.clientX) || 4,
      window.innerWidth - width - 4,
    ));
    const y = Math.max(4, Math.min(
      (Number(event?.clientY) || 4) + 8,
      window.innerHeight - height - 4,
    ));
    tagEditor = { tick, x, y, editingId: tag?.id || null };
    tagTick = tag?.tick ?? tick;
    tagType = tag?.type || 'custom';
    tagValue = tag?.type === 'custom' ? tag.value : '';
    await domTick();
    (tagType === 'custom' ? tagInputEl : tagTypeEl)?.focus({ preventScroll: true });
  }

  async function editTag(tag) {
    if (!tagEditor) return;
    tagEditor = { ...tagEditor, editingId: tag.id };
    tagTick = tag.tick;
    tagType = tag.type;
    tagValue = tag.type === 'custom' ? tag.value : '';
    await domTick();
    (tagType === 'custom' ? tagInputEl : tagTypeEl)?.focus({ preventScroll: true });
  }

  function saveTag() {
    if (!tagEditor || $playing) return;
    const definition = {
      ...(tagEditor.editingId ? { id: tagEditor.editingId } : {}),
      tick: Math.max(0, Math.min(contentDurationTicks - 1, Math.round(Number(tagTick)) || 0)),
      type: tagType,
      ...(tagType === 'custom' ? { value: tagValue } : {}),
    };
    const changed = runHistoryEdit(() => Boolean(setTimelineTag(definition)?.changed));
    if (!changed) return;
    closeTagEditor();
  }

  function deleteTag(tagId) {
    if ($playing) return;
    const changed = runHistoryEdit(() => Boolean(removeTimelineTag(tagId)?.changed));
    if (changed && tagEditor?.editingId === tagId) {
      tagEditor = { ...tagEditor, editingId: null };
      tagTick = tagEditor.tick;
      tagType = 'custom';
      tagValue = '';
    }
  }

  function tagEditorKeydown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeTagEditor();
    focusTimeline();
  }

  function markerPointerDown(event, tag) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    focusTimeline();
    if ($playing || (tool !== 'tag' && tool !== 'select')) {
      seekTick(tag.tick);
      capturePointer(event, { type: 'scrub' });
      return;
    }
    if (tool === 'tag' || tag.cluster) {
      openTagEditor(event, tag.tick, tag.cluster ? null : tag);
      return;
    }
    seekTick(tag.tick);
    // Dragging carries this exact authoring UUID; same-tick clustering never changes its identity.
    capturePointer(event, { type: 'move-tag', tag: { ...tag } });
  }

  function markerKeydown(event, tag) {
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if ($playing) {
      seekTick(tag.tick);
      return;
    }
    if (tool === 'tag') openTagEditor(event, tag.tick, tag.cluster ? null : tag);
    else seekTick(tag.tick);
  }

  function executeRazor(tick, hoveredClipId = null, hoveredTrackId = null, guard = null) {
    const canonicalPlan = planRazorClick(canonicalState, {
      tick,
      hoveredClipId,
      hoveredTrackId,
    });
    if (canonicalPlan.kind === 'none') return;
    runHistoryEdit((commitGuard) => {
      const result = razorClip(
        canonicalPlan.clipId,
        canonicalPlan.tick,
        commitGuard ? { guard: commitGuard } : {},
      );
      if (result?.changed && result.right?.id) {
        applyTimelineSelection({ clipIds: [result.right.id] });
      }
      return Boolean(result?.changed);
    }, guard);
    contextMenu = null;
  }

  function commitRazorPath(edit) {
    if (!edit.plan?.cuts?.length) return;
    runHistoryEdit((commitGuard) => {
      const result = razorClips(edit.plan.cuts, { guard: commitGuard });
      if (result?.changed) {
        applyTimelineSelection({
          clipIds: result.splits.map((split) => split.rightId),
        });
      }
      return Boolean(result?.changed);
    }, edit.guard);
    contextMenu = null;
  }

  // Pointer edits hold preview plans only; the guard permits commit at pointer-up
  // only while the canonical timeline still matches pointer-down.
  function capturePointer(event, edit) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const guard = captureClipTimelineRevisionGuard();
    observedMutationRevision = guard.mutationRevision;
    pointerEdit = {
      ...edit,
      pointerId: event.pointerId,
      target: event.currentTarget,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
      plan: null,
      guard,
    };
  }

  function startTagPointer(event, row, globalSurface = false) {
    focusTimeline();
    const target = tagPointerTarget(event, row, globalSurface);
    hoverPreview = tagHoverPreview(target);
    if (!target.valid) return;
    contextMenu = null;
    closeTagEditor();
    capturePointer(event, {
      type: 'tag-place',
      startTarget: target,
      tagSurface: target.surface || 'track',
    });
  }

  function emptyTagLanePointerDown(event) {
    if (event.button !== 0 || $playing || tool !== 'tag') return;
    event.preventDefault();
    startTagPointer(event, null, true);
  }

  function emptyTagLanePointerMove(event) {
    if (pointerEdit || $playing || tool !== 'tag') return;
    hoverPreview = tagHoverPreview(tagPointerTarget(event, null, true));
  }

  function emptyTagLanePointerLeave() {
    if (!pointerEdit && hoverPreview?.surface === 'global') hoverPreview = null;
  }

  function startHeaderResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    headerResize = {
      pointerId: event.pointerId,
      target: event.currentTarget,
      startClientX: event.clientX,
      startWidth: headerWidth,
      guard: captureClipTimelineRevisionGuard(),
    };
  }

  function finishHeaderResize(event, cancelled = false) {
    const resize = headerResize;
    if (!resize || (event?.pointerId != null && event.pointerId !== resize.pointerId)) return false;
    headerResize = null;
    if (resize.target?.hasPointerCapture?.(resize.pointerId)) {
      resize.target.releasePointerCapture(resize.pointerId);
    }
    if (cancelled || !isClipTimelineRevisionGuardCurrent(resize.guard)) {
      trackHeaderWidth = resizeTrackHeaderFromPointer(
        resize.startWidth,
        resize.startClientX,
        resize.startClientX,
        viewportWidth,
        true,
      );
    }
    return true;
  }

  function resizeHeaderWithKey(event) {
    const planned = resizeTrackHeaderWithKey(event, headerWidth, viewportWidth);
    if (!planned.handled) return;
    event.preventDefault();
    event.stopPropagation();
    trackHeaderWidth = planned.width;
  }

  function startTimelineClip(event, row, clip) {
    if (event.button !== 0 || $playing) return;
    event.preventDefault();
    event.stopPropagation();
    rootEl?.focus({ preventScroll: true });
    if (tool === 'tag') {
      startTagPointer(event, row);
      return;
    }
    const tick = activeEventTick(event);
    if (tick == null) return;
    if (tool === 'razor') {
      startRazorPointer(event, row);
      return;
    }
    const alreadySelected = $clipTimelineSelection.clipIds.has(String(clip.id));
    const duplicate = Boolean(event.shiftKey);
    const deferredClick = duplicate
      ? planClipClick(
          canonicalState,
          $clipTimelineSelection,
          clip.id,
          {
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            preserveExisting: true,
          },
          clipAnchor,
        )
      : null;
    const selectedIds = duplicate
      ? alreadySelected ? [...$clipTimelineSelection.clipIds] : [String(clip.id)]
      : [...selectClip(event, clip, alreadySelected).clipIds];
    if (row.track.locked) {
      if (deferredClick) {
        clipAnchor = deferredClick.anchorClipId;
        applyTimelineSelection(deferredClick.selection);
      }
      return;
    }
    capturePointer(event, {
      type: duplicate ? 'duplicate-clip' : 'move-clip',
      state: canonicalState,
      clip,
      selectedIds,
      snapClips,
      playheadTick: $canonicalPlayheadTick,
      clickSelection: deferredClick?.selection || null,
      clickAnchor: deferredClick?.anchorClipId || null,
    });
  }

  function startTimelineTrim(event, row, clip, edge) {
    if (event.button !== 0 || $playing) return;
    event.preventDefault();
    event.stopPropagation();
    rootEl?.focus({ preventScroll: true });
    if (tool === 'tag') {
      startTagPointer(event, row);
      return;
    }
    if (tool === 'razor') {
      startRazorPointer(event, row);
      return;
    }
    if (row.track.locked) return;
    const selection = selectClip(
      event,
      clip,
      $clipTimelineSelection.clipIds.has(String(clip.id)),
    );
    capturePointer(event, {
      type: 'trim-clip',
      state: canonicalState,
      clip,
      edge,
      edgeTick: edge === 'start' ? clip.startTick : clipEnd(clip),
      selectedIds: [...selection.clipIds],
      snapClips,
      playheadTick: $canonicalPlayheadTick,
    });
  }

  function startRulerPointer(event, playheadHandle = false) {
    if (event.button !== 0) return;
    event.preventDefault();
    rootEl?.focus({ preventScroll: true });
    const tick = playheadHandle ? clampedEventTick(event) : activeEventTick(event);
    const intent = planTimelinePointerIntent(tool, tick, {
      playing: $playing,
      surface: 'ruler',
    });
    if (intent.kind !== 'seek') return;
    seekTick(intent.tick);
    capturePointer(event, { type: 'scrub' });
  }

  function startRazorPointer(event, row) {
    const point = eventTimelinePoint(event);
    hoverPreview = null;
    capturePointer(event, {
      type: 'razor-path',
      state: canonicalState,
      points: [point],
      rowTracks: rows.map((candidate) => ({ trackId: candidate.track.id })),
      clickTick: Math.round(point.tick),
      clickTrackId: row.track.id,
    });
  }

  function lanePointerDown(event, row) {
    if (event.button !== 0) return;
    event.preventDefault();
    rootEl?.focus({ preventScroll: true });
    const laneTick = tool === 'select' || tool === 'tag'
      ? clampedEventTick(event)
      : activeEventTick(event);
    const intent = planTimelinePointerIntent(
      tool,
      laneTick,
      { playing: $playing, editable: row.kind !== 'group' },
    );
    if (intent.kind === 'tag') {
      startTagPointer(event, row);
      return;
    }
    if (intent.kind === 'razor') {
      startRazorPointer(event, row);
      return;
    }
    if (intent.kind !== 'seek') return;
    const wasPlaying = $playing;
    if (wasPlaying) {
      seekTick(intent.tick);
      return;
    }
    capturePointer(event, {
      type: 'marquee',
      state: canonicalState,
      selection: $clipTimelineSelection,
      row,
      startPoint: eventTimelinePoint(event),
      startPixel: eventTimelinePixel(event),
      clickTick: intent.tick,
      modifiers: {
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      },
    });
  }

  function blankWorkspacePointerDown(event) {
    if (event.button !== 0 || event.target !== event.currentTarget ||
      tool !== 'select' || $playing) return;
    event.preventDefault();
    capturePointer(event, { type: 'blank-workspace' });
  }

  function lanePointerMove(event, row) {
    if (pointerEdit) return;
    if ($playing) {
      hoverPreview = null;
      return;
    }
    if (tool === 'razor') {
      const tick = roundedEventTick(event);
      const plan = planRazorClick(canonicalState, {
        tick,
        hoveredTrackId: row.track.id,
      });
      hoverPreview = {
        tool,
        rowId: row.id,
        tick,
        valid: plan.kind === 'razor-clip',
        title: plan.kind === 'razor-clip' ? `Split at tick ${tick}` : '',
      };
    } else if (tool === 'tag') {
      hoverPreview = tagHoverPreview(tagPointerTarget(event, row));
    } else {
      hoverPreview = null;
    }
  }

  function lanePointerLeave(row) {
    if (!pointerEdit && hoverPreview?.rowId === row.id) hoverPreview = null;
  }

  function pointerMove(event) {
    if (headerResize && event.pointerId === headerResize.pointerId) {
      if (!isClipTimelineRevisionGuardCurrent(headerResize.guard)) {
        finishHeaderResize(null, true);
        return;
      }
      trackHeaderWidth = resizeTrackHeaderFromPointer(
        headerResize.startWidth,
        headerResize.startClientX,
        event.clientX,
        viewportWidth,
      );
      return;
    }
    const edit = pointerEdit;
    if (!edit || event.pointerId !== edit.pointerId) return;
    if (!isClipTimelineRevisionGuardCurrent(edit.guard)) {
      finishPointer(null, true);
      return;
    }
    if (edit.type === 'scrub') {
      seekTick(clampedEventTick(event));
      return;
    }
    const pointerDistance = Math.hypot(
      event.clientX - edit.startClientX,
      event.clientY - edit.startClientY,
    );
    const moved = edit.moved || pointerDistance >= TIMELINE_POINTER_DRAG_THRESHOLD;
    if (edit.type === 'tag-place') {
      const plan = planTimelineTagGesture(
        edit.startTarget,
        tagPointerTarget(event, undefined, edit.tagSurface === 'global'),
        pointerDistance,
        edit.moved,
      );
      hoverPreview = tagHoverPreview(plan.preview);
      pointerEdit = { ...edit, moved: plan.moved, plan };
      return;
    }
    if (edit.type === 'move-tag') {
      const plan = planTimelineTagMove(
        edit.tag,
        event.clientX - edit.startClientX,
        zoom,
        contentDurationTicks,
        edit.moved,
      );
      pointerEdit = { ...edit, moved: plan.moved, plan };
      return;
    }
    const delta = (event.clientX - edit.startClientX) / zoom;
    let plan = null;
    let points = edit.points;
    if (edit.type === 'marquee' && moved) {
      const point = eventTimelinePoint(event);
      const firstRow = Math.floor(edit.startPoint.row);
      const lastRow = Math.floor(point.row);
      const startRow = Math.min(firstRow, lastRow);
      const endRow = Math.max(firstRow, lastRow);
      plan = {
        ...planTimelineMarquee(edit.state, edit.selection, {
          ...edit.modifiers,
          startTick: edit.startPoint.tick,
          endTick: point.tick,
          trackIds: rows.slice(startRow, endRow + 1).map((row) => row.track.id),
        }),
        geometry: {
          startPixel: edit.startPixel,
          endPixel: eventTimelinePixel(event),
          startRow,
          endRow,
        },
      };
    } else if (edit.type === 'razor-path' && moved) {
      const point = eventTimelinePoint(event);
      const previous = edit.points.at(-1);
      points = previous.tick === point.tick && previous.row === point.row
        ? edit.points
        : [...edit.points, point];
      plan = planRazorDrag(edit.state, points, edit.rowTracks);
    } else if (edit.type === 'duplicate-clip') {
      plan = planClipDuplicateMove(
        edit.state,
        edit.selectedIds,
        edit.clip.id,
        edit.clip.startTick + delta,
        {
          snapClips: edit.snapClips,
          playheadTick: edit.playheadTick,
          pixelsPerTick: zoom,
          altKey: event.altKey,
        },
      );
    } else if (edit.type === 'move-clip') {
      plan = planClipMove(
        edit.state,
        edit.selectedIds,
        edit.clip.id,
        edit.clip.startTick + delta,
        {
          snapClips: edit.snapClips,
          playheadTick: edit.playheadTick,
          pixelsPerTick: zoom,
          altKey: event.altKey,
        },
      );
    } else if (edit.type === 'trim-clip') {
      plan = planClipTrim(
        edit.state,
        edit.selectedIds,
        edit.clip.id,
        edit.edge,
        edit.edgeTick + delta,
        {
          snapClips: edit.snapClips,
          playheadTick: edit.playheadTick,
          pixelsPerTick: zoom,
          altKey: event.altKey,
          fps: $fps,
        },
      );
    } else if (edit.type === 'move-key') {
      plan = planTimelineKeyMotion(edit.state, edit.selection, Math.round(delta));
    }
    pointerEdit = { ...edit, moved, plan, points };
  }

  function finishPointer(event, cancelled = false) {
    if (finishHeaderResize(event, cancelled)) return;
    const edit = pointerEdit;
    if (!edit || (event?.pointerId != null && event.pointerId !== edit.pointerId)) return;
    pointerEdit = null;
    if (edit.target?.hasPointerCapture?.(edit.pointerId)) {
      edit.target.releasePointerCapture(edit.pointerId);
    }
    if (edit.type === 'tag-place') hoverPreview = null;
    if (cancelled || !isClipTimelineRevisionGuardCurrent(edit.guard) || edit.type === 'scrub') return;
    if (edit.type === 'tag-place') {
      const pointerDistance = event ? Math.hypot(
        event.clientX - edit.startClientX,
        event.clientY - edit.startClientY,
      ) : 0;
      const plan = planTimelineTagGesture(
        edit.startTarget,
        event
          ? tagPointerTarget(event, undefined, edit.tagSurface === 'global')
          : edit.plan?.preview,
        pointerDistance,
        edit.moved,
      );
      if (plan.release) openTagEditor(event, plan.release.tick);
      return;
    }
    if (edit.type === 'move-tag') {
      const plan = event
        ? planTimelineTagMove(
          edit.tag,
          event.clientX - edit.startClientX,
          zoom,
          contentDurationTicks,
          edit.moved,
        )
        : edit.plan;
      if (plan?.changed) {
        runHistoryEdit((commitGuard) => Boolean(setTimelineTag({
          id: edit.tag.id,
          tick: plan.tick,
          type: edit.tag.type,
          ...(edit.tag.type === 'custom' ? { value: edit.tag.value } : {}),
        }, { guard: commitGuard })?.changed), edit.guard);
      }
      return;
    }
    if (edit.type === 'blank-workspace') {
      if (!edit.moved) clearTimelineContext(true);
      return;
    }
    if (edit.type === 'marquee') {
      if (edit.moved && edit.plan) {
        applyTimelineSelection(edit.plan.selection);
      } else {
        seekTick(edit.clickTick);
        if (edit.row.kind !== 'group') {
          const planned = planGapClick(
            canonicalState,
            $clipTimelineSelection,
            edit.row.track.id,
            edit.clickTick,
            { maximumTick: extentTicks },
          );
          if (planned.kind === 'gap') applyTimelineSelection(planned.selection, false);
        }
      }
      return;
    }
    if (edit.type === 'razor-path') {
      if (edit.moved) commitRazorPath(edit);
      else executeRazor(edit.clickTick, null, edit.clickTrackId, edit.guard);
      return;
    }
    if (edit.type === 'duplicate-clip' && !edit.moved && edit.clickSelection) {
      clipAnchor = edit.clickAnchor;
      applyTimelineSelection(edit.clickSelection);
      return;
    }
    if (!edit.moved || !edit.plan) return;
    if (edit.type === 'move-key' && edit.plan.valid && edit.plan.changed) {
      runHistoryEdit((commitGuard) => Boolean(moveTimelineKeys(
        edit.selection,
        edit.plan.deltaTicks,
        { guard: commitGuard },
      )?.changed), edit.guard);
    } else if (edit.type === 'duplicate-clip' && edit.plan.valid) {
      runHistoryEdit((commitGuard) => Boolean(
        duplicateClips(edit.plan.operations, { guard: commitGuard })?.changed,
      ), edit.guard);
    } else if (edit.type === 'move-clip' && edit.plan.deltaTicks) {
      runHistoryEdit((commitGuard) => Boolean(
        moveClips(edit.plan.operations, { guard: commitGuard })?.changed,
      ), edit.guard);
    } else if (edit.type === 'trim-clip' && edit.plan.deltaTicks) {
      runHistoryEdit((commitGuard) => Boolean(
        trimClips(edit.plan.operations, { guard: commitGuard })?.changed,
      ), edit.guard);
    }
  }

  function deleteCurrentSelection(planned = planTimelineDelete($clipTimelineSelection)) {
    if (planned && planned.kind !== 'none') {
      const changed = runHistoryEdit(() => Boolean(deleteClipSelection(planned.selection)?.changed));
      contextMenu = null;
      return changed;
    }
    contextMenu = null;
    return false;
  }

  function deleteContextSelection() {
    return deleteCurrentSelection(planTimelineDelete(contextMenu?.deleteSelection));
  }

  function handleKeydown(event) {
    if ((contextMenu || tagEditor) && event.key !== 'Escape') return;
    if (isEditingTarget(event.target)) {
      if (event.key === 'Escape' && tagEditor) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeTagEditor();
        focusTimeline();
      }
      return;
    }
    const contextOwned = keyboardContextOwns('timeline', event);
    if (contextOwned && isPlaybackShortcut(event, false, 'timeline') &&
      (event.code === 'Space' || event.key === ' ')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      togglePlay();
      return;
    }
    const deselect = planSelectionDeselect(event, {
      context: contextOwned ? 'timeline' : null,
    });
    if (deselect.context === 'timeline') {
      event.preventDefault();
      event.stopImmediatePropagation();
      deselectTimeline();
      return;
    }
    const zoomShortcut = timelineZoomForShortcut(event, zoom, {
      contextOwned,
      minimum: MIN_ZOOM,
      maximum: MAX_ZOOM,
    });
    if (zoomShortcut.handled) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setZoom(zoomShortcut.zoom);
      return;
    }
    const shortcutTool = timelineToolForShortcut(event, {
      contextOwned,
      playing: $playing,
    });
    if (shortcutTool) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setTool(shortcutTool);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (pointerEdit) finishPointer(null, true);
      else if (headerResize) finishHeaderResize(null, true);
      else if (tagEditor) closeTagEditor();
      else if (contextMenu) contextMenu = null;
      else {
        if (hasCanonicalSelection()) clearClipSelection();
      }
      return;
    }
    const planned = planTimelineDeleteKey(event, $clipTimelineSelection, {
      editing: false,
      playing: $playing,
      contextOwned: keyboardContextOwns('timeline', event),
    });
    if (!planned.handled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    deleteCurrentSelection(planned);
  }

  function menuPosition(event, height = 190) {
    return {
      x: Math.max(4, Math.min(event.clientX, window.innerWidth - 218)),
      y: Math.max(4, Math.min(event.clientY, window.innerHeight - height)),
    };
  }

  function openVisualMenu(event, row, clip) {
    event.preventDefault();
    event.stopPropagation();
    setKeyboardContext('timeline');
    const planned = planClipContext(canonicalState, $clipTimelineSelection, clip.id);
    if (planned.kind === 'none') return;
    clipAnchor = String(clip.id);
    applyTimelineSelection(planned.selection);
    contextMenu = {
      kind: 'visual',
      clipId: clip.id,
      trackId: row.track.id,
      deleteSelection: planned.deleteSelection,
      deleteCount: planned.deleteCount,
      deleteLabel: planned.deleteLabel,
      deleteDisabled: planned.deleteDisabled,
      locked: planned.locked,
      ...menuPosition(event),
    };
  }

  function openAudioMenu(event, clip) {
    event.preventDefault();
    event.stopPropagation();
    setKeyboardContext('timeline');
    const planned = planClipContext(canonicalState, $clipTimelineSelection, clip.id);
    if (planned.kind === 'none') return;
    clipAnchor = String(clip.id);
    applyTimelineSelection(planned.selection);
    contextMenu = {
      kind: 'audio',
      clipId: clip.id,
      deleteSelection: planned.deleteSelection,
      deleteCount: planned.deleteCount,
      deleteLabel: planned.deleteLabel,
      deleteDisabled: planned.deleteDisabled,
      locked: planned.locked,
      ...menuPosition(event, 220),
    };
  }

  function openKeyMenu(event, clip, marker, kind) {
    event.preventDefault();
    event.stopPropagation();
    setKeyboardContext('timeline');
    const planned = planTimelineKeyContext(canonicalState, $clipTimelineSelection, {
      kind,
      clipId: clip.id,
      sourceTick: marker.sourceTick,
      ...(kind === 'property' ? { propertyName: marker.propertyName } : {}),
    });
    if (planned.kind === 'none') return;
    applyTimelineSelection(planned.selection);
    if (kind === 'frame') {
      frameKeyAnchor = { clipId: String(clip.id), sourceTick: Number(marker.sourceTick) };
    } else {
      propertyKeyAnchor = {
        clipId: String(clip.id),
        propertyName: marker.propertyName,
        sourceTick: Number(marker.sourceTick),
      };
    }
    contextMenu = {
      kind: 'key',
      title: planned.title,
      deleteSelection: planned.deleteSelection,
      deleteCount: planned.deleteCount,
      deleteLabel: planned.deleteLabel,
      deleteDisabled: planned.deleteDisabled,
      locked: planned.locked,
      ...menuPosition(event, 100),
    };
  }

  function openFrameKeyMenu(event, row, clip, marker) {
    openKeyMenu(event, clip, marker, 'frame');
  }

  function openPropertyKeyMenu(event, row, clip, marker) {
    openKeyMenu(event, clip, marker, 'property');
  }

  function openLaneMenu(event, row) {
    if (row.kind === 'group') return;
    event.preventDefault();
    setKeyboardContext('timeline');
    const planned = planGapClick(
      canonicalState,
      $clipTimelineSelection,
      row.track.id,
      clampedEventTick(event),
      { maximumTick: extentTicks },
    );
    if (planned.kind !== 'gap') return;
    applyTimelineSelection(planned.selection, false);
    contextMenu = { kind: 'gap', ...menuPosition(event, 110) };
  }

  function closeContextMenu(event) {
    if (!event.target.closest?.('.clip-timeline-menu')) contextMenu = null;
    if (tagEditor && !event.target.closest?.('.timeline-tag-editor') &&
      !event.target.closest?.('.timeline-tag-marker')) closeTagEditor();
  }

  function stopPointerDownPropagation(event) {
    event.stopPropagation();
    onpointerdown?.(event);
  }

  function submitTagEditor(event) {
    event.preventDefault();
    saveTag();
  }

  function resizePointerMove(event) {
    event.stopPropagation();
    pointerMove(event);
  }

  function resizePointerUp(event) {
    event.stopPropagation();
    finishHeaderResize(event);
  }

  function resizePointerCancel(event) {
    event.stopPropagation();
    finishHeaderResize(event, true);
  }

  function splitMenuVisual() {
    if (menuVisualClip) {
      executeRazor($canonicalPlayheadTick, menuVisualClip.id, menuVisualClip.trackId);
    }
  }

  function splitMenuAudio() {
    if (menuAudioClip) {
      executeRazor($canonicalPlayheadTick, menuAudioClip.id, menuAudioClip.trackId);
    }
  }

  function toggleMenuAudioMute() {
    if (!menuAudioClip) return;
    runHistoryEdit(() => {
      const changed = updateAudioClip(menuAudioClip.trackId, menuAudioClip.id, {
        muted: !menuAudioClip.muted,
      });
      if (changed) noteAuthoredMutation();
      return Boolean(changed);
    });
    contextMenu = null;
  }

  function relinkMenuAudio() {
    if (!menuAudioClip) return;
    window.dispatchEvent(new CustomEvent('relink-media', {
      detail: { assetId: menuAudioClip.assetId },
    }));
    contextMenu = null;
  }

  function selectMenuTrack() {
    if (!menuVisualClip) return;
    const planned = planTrackHeaderClick(
      canonicalState,
      $clipTimelineSelection,
      menuVisualClip.trackId,
    );
    trackAnchor = planned.anchorTrackId;
    applyTimelineSelection(planned.selection);
    contextMenu = null;
  }

  function rippleMenuGap() {
    deleteCurrentSelection();
  }

  function clipEnd(clip) {
    return Number(clip.startTick) + Math.max(1, Number(clip.outTick) - Number(clip.inTick));
  }

  function previewTimelineClip(clip, edit, rate) {
    const plan = edit?.plan;
    if (edit?.type === 'move-clip' && plan?.clipIds.includes(clip.id)) {
      return { ...clip, startTick: Number(clip.startTick) + plan.deltaTicks };
    }
    if (edit?.type === 'trim-clip' && plan?.clipIds.includes(clip.id)) {
      if (clip.kind === 'audio') {
        const seconds = plan.deltaTicks / Math.max(1, Number(rate) || 24);
        return plan.edge === 'start'
          ? {
            ...clip,
            startTick: Number(clip.startTick) + plan.deltaTicks,
            inPoint: Number(clip.inPoint) + seconds,
            outTick: Math.max(1, Number(clip.outTick) - plan.deltaTicks),
            sourceDuration: Math.max(1, Number(clip.outTick) - plan.deltaTicks),
          }
          : {
            ...clip,
            outPoint: Number(clip.outPoint) + seconds,
            outTick: Math.max(1, Number(clip.outTick) + plan.deltaTicks),
            sourceDuration: Math.max(1, Number(clip.outTick) + plan.deltaTicks),
          };
      }
      return plan.edge === 'start'
        ? {
          ...clip,
          startTick: Number(clip.startTick) + plan.deltaTicks,
          inTick: Number(clip.inTick) + plan.deltaTicks,
        }
        : { ...clip, outTick: Number(clip.outTick) + plan.deltaTicks };
    }
    return clip;
  }

  function clipIsVisible(clip, range) {
    return clipEnd(clip) > range.startTick && Number(clip.startTick) < range.endTick;
  }

  function clipsForRow(row, state, edit, rate, range) {
    if (row.kind === 'group') return [];
    const originals = state.clips
      .filter((clip) => String(clip.trackId) === String(row.track.id))
      .map((clip) => previewTimelineClip(clip, edit, rate));
    const ghosts = edit?.type === 'duplicate-clip' && edit.moved && edit.plan
      ? edit.plan.operations.flatMap((operation) => {
          if (String(operation.trackId) !== String(row.track.id)) return [];
          const source = edit.state.clips.find((clip) =>
            String(clip.id) === String(operation.clipId));
          return source ? [{
            ...source,
            id: `${source.id}:duplicate-ghost`,
            trackId: operation.trackId,
            startTick: operation.targetStartTick,
            duplicateGhost: true,
            duplicateValid: edit.plan.valid,
          }] : [];
        })
      : [];
    return [...originals, ...ghosts].filter((clip) => clipIsVisible(clip, range));
  }

  function boundedAudioWaveform(clip, bounds, range, transform, fpsValue) {
    const startTick = Math.max(Number(clip.startTick), range.startTick);
    const endTick = Math.min(clipEnd(clip), range.endTick);
    const rate = Math.max(1, Number(fpsValue) || 24);
    const sourceIn = Number(clip.inPoint);
    const sourceOut = Number(clip.outPoint);
    return {
      left: tickToPixel(startTick, transform) - bounds.left,
      width: Math.max(1, tickToPixel(endTick, transform) - tickToPixel(startTick, transform)),
      inPoint: Math.max(sourceIn, Math.min(
        sourceOut,
        sourceIn + (startTick - clip.startTick) / rate,
      )),
      outPoint: Math.max(sourceIn, Math.min(
        sourceOut,
        sourceIn + (endTick - clip.startTick) / rate,
      )),
    };
  }

  function clipBounds(clip, transform) {
    const left = tickToPixel(Number(clip.startTick), transform);
    return { left, width: Math.max(1, tickToPixel(clipEnd(clip), transform) - left) };
  }

  function resolvedLayerOffset(resolvedLayers, layer) {
    const byId = new Map(resolvedLayers.map((candidate) => [String(candidate.id), candidate]));
    let current = layer;
    let x = 0;
    let y = 0;
    const seen = new Set();
    while (current && !seen.has(String(current.id))) {
      seen.add(String(current.id));
      x += Number(current.offset?.x) || 0;
      y += Number(current.offset?.y) || 0;
      current = current.groupId == null ? null : byId.get(String(current.groupId));
    }
    return { x, y };
  }

  function thumbnailParams(row, clip, sample) {
    const reference = clipKind(row, clip) === 'video';
    const resolvedLayers = reference
      ? []
      : resolveClipTimelineLayers(canonicalState, sample.projectTick);
    const layer = resolvedLayers.find((candidate) =>
      String(candidate.id) === String(row.track.layer?.id));
    const frame = layer?.visible === false ? { cells: {} } : (layer || thumbnailFrameValue(clip, sample));
    return {
      model: buildFrameThumbnailModel(frame, {
        frameWidth: $dims.w,
        frameHeight: $dims.h,
        offset: layer ? resolvedLayerOffset(resolvedLayers, layer) : row.track.layer?.offset,
        reference,
      }),
      backgroundChannel: layer?.type === 'background' || layer?.shape?.channel === 'background' ||
        row.track.layer?.type === 'background' || row.track.layer?.shape?.channel === 'background',
      fontFamily: $canvasFont,
    };
  }

  function groupKeyMarkers(track, range) {
    const markers = new Map();
    for (const [propertyName, keys] of Object.entries(track.propertyTracks || {})) {
      for (const key of keys || []) {
        const tick = Number(key.tick);
        if (tick < range.startTick || tick >= range.endTick) continue;
        if (!markers.has(tick)) markers.set(tick, []);
        markers.get(tick).push(propertyName);
      }
    }
    return [...markers].map(([tick, properties]) => ({ tick, properties }));
  }

  function clipKind(row, clip) {
    const layerType = row.track.layer?.type;
    const kind = clip.kind || row.track.kind || layerType;
    if (kind === 'video' || layerType === 'video') return 'video';
    if (kind === 'effect' || layerType === 'effect') return 'effect';
    return 'visual';
  }

  function clipLabel(row, clip) {
    return clip.name || clip.sourceName || row.track.name || row.track.layer?.name || 'Clip';
  }

  function audioLabel(row, asset) {
    return asset?.sourceName || row.track.name || 'Audio';
  }

  function audioAsset(assets, clip) {
    return assets.find((asset) => asset.id === clip.assetId) || null;
  }

  function audioSourceState(asset, statuses) {
    if (asset?.buffer) return 'ready';
    const state = asset?.id ? statuses.get(asset.id)?.state : null;
    return state === 'missing' || state === 'decode-failed' ? state : 'loading';
  }

  function frameKeySelected(selection, clipId, sourceTick) {
    return selection.frameKeys.some((key) =>
      String(key.clipId) === String(clipId) && Number(key.sourceTick) === Number(sourceTick));
  }

  function propertyKeySelected(selection, clipId, propertyName, sourceTick) {
    return selection.propertyKeys.some((key) =>
      String(key.clipId) === String(clipId) &&
      key.propertyName === propertyName &&
      Number(key.sourceTick) === Number(sourceTick));
  }

  function previewKeyMarker(marker, kind, edit) {
    if (edit?.type !== 'move-key' || !edit.plan?.moves?.length) return marker;
    const move = edit.plan.moves.find((candidate) =>
      candidate.kind === kind &&
      String(candidate.clipId) === String(marker.clipId) &&
      Number(candidate.sourceTick) === Number(marker.sourceTick) &&
      (kind === 'frame' || candidate.propertyName === marker.propertyName));
    if (!move) return marker;
    return {
      ...marker,
      sourceTick: move.destinationSourceTick,
      timelineTick: move.destinationProjectTick,
      moving: edit.plan.deltaTicks !== 0,
      moveValid: edit.plan.valid,
    };
  }

  function waveform(node, params) {
    let current = params;
    const color = readThemeColor('--waveform', node);
    const draw = () => {
      const { buffer, inPoint = 0, outPoint = buffer?.duration || 0 } = current || {};
      const rect = node.getBoundingClientRect();
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.min(4096, Math.round(rect.width * ratio)));
      const height = Math.max(1, Math.min(256, Math.round(rect.height * ratio)));
      if (node.width !== width) node.width = width;
      if (node.height !== height) node.height = height;
      const context = node.getContext('2d');
      context.clearRect(0, 0, width, height);
      if (!buffer?.length || !buffer.numberOfChannels) return;
      const from = Math.max(0, Math.floor(inPoint * buffer.sampleRate));
      const to = Math.min(buffer.length, Math.ceil(outPoint * buffer.sampleRate));
      if (to <= from) return;
      const span = Math.max(1, to - from);
      const channel = buffer.getChannelData(0);
      context.fillStyle = color;
      for (let x = 0; x < width; x++) {
        const start = from + Math.floor(x * span / width);
        const end = Math.max(start + 1, from + Math.floor((x + 1) * span / width));
        const stride = Math.max(1, Math.ceil((end - start) / 96));
        let minimum = 1;
        let maximum = -1;
        for (let sample = start; sample < Math.min(end, to); sample += stride) {
          const value = channel[sample] || 0;
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
        }
        const top = (1 - maximum) * height / 2;
        const bottom = (1 - minimum) * height / 2;
        context.fillRect(x, top, 1, Math.max(1, bottom - top));
      }
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
    observer?.observe(node);
    draw();
    return {
      update(next) {
        current = next;
        draw();
      },
      destroy() {
        observer?.disconnect();
      },
    };
  }

  function gapForRow(selection, row) {
    const gap = selection.gap;
    return gap?.trackIds?.some((id) => String(id) === String(row.track.id)) ? gap : null;
  }
  let zoom = $derived(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(pixelsPerTick) || 14)));
  let canonicalState = $derived($canonicalClipTimeline || { tracks: [], clips: [] });
  let sequenceTags = $derived(canonicalState.tags || []);
  let contentDurationTicks = $derived(Math.max(1, $canonicalDurationTicks));
  let loopRange = $derived(validLoopRange(sequenceTags, contentDurationTicks));
  let headerWidth = $derived(clampTrackHeaderWidth(trackHeaderWidth, viewportWidth));
  let headerDivider = $derived(trackHeaderDividerGeometry(headerWidth));
  let rows = $derived(buildTimelineRows(canonicalState.tracks, collapsedGroups));
  // Filmstrip geometry expands as one unit so rows, virtualization, hit tests, and marquees stay aligned.
  let rowHeight = $derived(showFilmstrip ? FILMSTRIP_ROW_H : COMPACT_ROW_H);
  let rowPrefix = $derived(buildRowPrefixIndex(rows, () => rowHeight));
  let laneViewportWidth = $derived(Math.max(0, viewportWidth - headerWidth));
  let snapClips = $derived(canonicalState.clips);
  let extentTicks = $derived(timelineExtentTicks(contentDurationTicks, laneViewportWidth, zoom));
  let tickTransform = $derived(createTickPixelTransform({ pixelsPerTick: zoom }));
  let laneWidth = $derived(extentTicks * zoom);
  let contentWidth = $derived(headerWidth + laneWidth);
  let surfaceHeight = $derived(Math.max(viewportHeight, RULER_H + rowPrefix.totalHeight));
  let tickRange = $derived(visibleTickRange(tickTransform, laneViewportWidth, {
    viewportLeft: scrollLeft,
    overscanPixels: 96,
    maximumTick: extentTicks,
  }));
  let rowRange = $derived(visibleRowRange(
    rowPrefix,
    Math.max(0, scrollTop),
    Math.max(0, viewportHeight - RULER_H),
    rowHeight * 2,
  ));
  let visibleRows = $derived(rows
    .slice(rowRange.startIndex, rowRange.endIndex)
    .map((row, index) => ({
      ...row,
      rowIndex: rowRange.startIndex + index,
      top: rowPrefix.offsets[rowRange.startIndex + index],
    })));
  let rulerTicks = $derived(buildRulerTicks(tickRange, zoom));
  let previewSequenceTags = $derived(pointerEdit?.type === 'move-tag' && pointerEdit.plan?.tag
    ? sequenceTags.map((tag) => tag.id === pointerEdit.plan.tag.id ? pointerEdit.plan.tag : tag)
    : sequenceTags);
  let visibleTagMarkers = $derived(buildTimelineTagMarkers(previewSequenceTags, tickRange));
  let movingTagId = $derived(pointerEdit?.type === 'move-tag' && pointerEdit.plan?.moved
    ? pointerEdit.tag.id
    : null);
  let displayedSelection = $derived(pointerEdit?.type === 'marquee' && pointerEdit.moved && pointerEdit.plan
    ? pointerEdit.plan.selection
    : $clipTimelineSelection);
  let editorTags = $derived(tagEditor
    ? sequenceTags.filter((tag) => tag.tick === tagEditor.tick)
    : []);
  let menuVisualClip = $derived(contextMenu?.kind === 'visual'
    ? canonicalState.clips.find((clip) => clip.id === contextMenu.clipId) || null
    : null);
  let menuAudioClip = $derived(contextMenu?.kind === 'audio'
    ? canonicalState.clips.find((clip) => clip.id === contextMenu.clipId) || null
    : null);
  let menuAudioAsset = $derived(menuAudioClip
    ? $audioAssets.find((asset) => asset.id === menuAudioClip.assetId) || null
    : null);
  let menuAudioState = $derived(audioSourceState(menuAudioAsset, $mediaRuntimeStatus));
  $effect(() => {
    syncAudioMediaRequests(
      'clip-timeline',
      expanded
        ? canonicalState.clips.filter((clip) => clip.kind === 'audio').map((clip) => clip.assetId)
      : [],
    );
  });
  $effect.pre(() => {
    const revision = $clipTimelineMutationRevision;
    untrack(() => handleMutationRevision(revision));
  });
  $effect.pre(() => {
    const nextExpanded = expanded;
    untrack(() => handleExpandedChange(nextExpanded));
  });
  $effect.pre(() => {
    const nextTool = tool;
    untrack(() => handleToolChange(nextTool));
  });
  $effect.pre(() => {
    if ($playing && tagEditor) closeTagEditor();
  });
</script>

<svelte:window
  onpointerdowncapture={noteKeyboardContext}
  onpointerdown={closeContextMenu}
  onpointermove={pointerMove}
  onpointerup={finishPointer}
  onpointercancel={(event) => finishPointer(event, true)}
  onblur={(event) => finishPointer(event, true)}
/>

{#if expanded}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="clip-timeline" class:playback-locked={$playing}
    class:select-tool={tool === 'select'} class:razor-tool={tool === 'razor'}
    class:tag-tool={tool === 'tag'} class:filmstrip-mode={showFilmstrip} bind:this={rootEl}
    tabindex="0" role="application" aria-label="Clip timeline" data-keyboard-context="timeline"
    onkeydown={handleKeydown}>
    <div class="timeline-workspace">
      <div class="timeline-viewport" bind:this={viewportEl} use:measureViewport onscroll={onScroll}
        onwheel={handleWheel}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="timeline-surface" style={`width:${contentWidth}px;height:${surfaceHeight}px;--tick-width:${zoom}px`}
          onpointerdown={blankWorkspacePointerDown}>
          <div class="tick-ruler" style={`width:${contentWidth}px;height:${RULER_H}px`}>
            <div class="ruler-corner" style={`width:${headerWidth}px`}>Tracks</div>
            <div class="ruler-lane" style={`left:${headerWidth}px;width:${laneWidth}px`}>
              {#if loopRange}
                <span class="loop-range-band"
                  style={`left:${tickToPixel(loopRange.startTick, tickTransform)}px;width:${Math.max(1, (loopRange.endTick - loopRange.startTick + 1) * zoom)}px`}
                  title={`Loop range: ticks ${loopRange.startTick} through ${loopRange.endTick}, inclusive`}></span>
              {/if}
              {#each rulerTicks as rulerTick (rulerTick.tick)}
                <span class="ruler-tick" class:major={rulerTick.major}
                  style={`left:${tickToPixel(rulerTick.tick, tickTransform)}px`}>
                  {#if rulerTick.major}<span>{rulerTick.tick}</span>{/if}
                </span>
              {/each}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div class="ruler-active-range"
                style={`width:${contentDurationTicks * zoom}px`}
                title={`Sequence ticks 0 through ${contentDurationTicks - 1}`}
                onpointerdown={startRulerPointer}></div>
              {#each visibleTagMarkers as tag (tag.id)}
                {@const markerLayout = timelineTagMarkerLayout(tickToPixel(tag.tick, tickTransform), tag.stackIndex, zoom)}
                <button class="timeline-tag-marker {tag.type}" class:cluster={tag.cluster}
                  class:moving={movingTagId != null &&
                    (tag.id === movingTagId || tag.customIds?.includes(movingTagId))}
                  aria-label={tagTitle(tag)} title={tagTitle(tag)}
                  style={`left:${markerLayout.left}px;top:${markerLayout.top}px;width:${markerLayout.width}px;height:${markerLayout.height}px;z-index:9`}
                  onpointerdown={(event) => markerPointerDown(event, tag)}
                  onkeydown={(event) => markerKeydown(event, tag)}
                  oncontextmenu={(event) => openTagEditor(event, tag.tick, tag.cluster ? null : tag)}></button>
              {/each}
              <span class="cti-ruler-line" aria-hidden="true"
                style={`left:${tickToPixel($canonicalPlayheadTick, tickTransform) - 1}px;z-index:11`}></span>
              <button class="cti-head" aria-label={`Playhead at tick ${$canonicalPlayheadTick}`}
                title={`Tick ${$canonicalPlayheadTick}`}
                style={`left:${tickToPixel($canonicalPlayheadTick, tickTransform) - 6}px;height:8px;z-index:12`}
                onpointerdown={(event) => startRulerPointer(event, true)}></button>
            </div>
          </div>

          <div class="playhead-line"
            style={`left:${headerWidth + tickToPixel($canonicalPlayheadTick, tickTransform)}px;top:${RULER_H}px;height:${Math.max(0, surfaceHeight - RULER_H)}px;z-index:21`}></div>

          {#if pointerEdit?.type === 'marquee' && pointerEdit.moved && pointerEdit.plan?.geometry}
            {@const marquee = pointerEdit.plan.geometry}
            <div class="timeline-marquee"
              style={`left:${headerWidth + Math.min(marquee.startPixel, marquee.endPixel)}px;top:${RULER_H + rowPrefix.offsets[marquee.startRow]}px;width:${Math.max(1, Math.abs(marquee.endPixel - marquee.startPixel))}px;height:${rowPrefix.offsets[marquee.endRow + 1] - rowPrefix.offsets[marquee.startRow]}px`}></div>
          {/if}

          {#if !rows.length}
            {#if tool === 'tag' && !$playing}
              <button type="button" class="empty-tag-lane"
                style={`top:${RULER_H}px;left:${headerWidth}px;width:${laneWidth}px;height:${Math.max(rowHeight, surfaceHeight - RULER_H)}px`}
                aria-label={`Sequence tag lane, ticks 0 through ${contentDurationTicks - 1}`}
                title="Add a sequence tag"
                onpointerdown={emptyTagLanePointerDown}
                onpointermove={emptyTagLanePointerMove}
                onpointerleave={emptyTagLanePointerLeave}>
                <span>Add sequence tag</span>
                {#if hoverPreview?.surface === 'global'}
                  <span class="timeline-tool-preview tag" class:valid={hoverPreview.valid}
                    class:invalid={!hoverPreview.valid} title={hoverPreview.title || null}
                    style={`left:${tickToPixel(hoverPreview.tick, tickTransform) - 1}px`}></span>
                {/if}
              </button>
            {:else}
              <div class="empty-timeline" style={`top:${RULER_H}px;left:${headerWidth}px;width:${laneViewportWidth}px`}>
                No timeline tracks
              </div>
            {/if}
          {/if}

          {#each visibleRows as row (row.id)}
            <div class="timeline-row" class:group-row={row.kind === 'group'} class:audio-row={row.kind === 'audio'}
              style={`top:${RULER_H + row.top}px;width:${contentWidth}px;height:${rowHeight}px`}>
              <div class="track-header"
                class:selected={displayedSelection.trackHeaderIds.has(String(row.track.id))}
                style={`width:${headerWidth}px;--track-depth:${row.depth}`}>
                {#if row.kind === 'group' || row.hasChildren}
                  <button class="group-toggle" aria-label={`${collapsedGroups.has(String(row.track.id)) ? 'Expand' : 'Collapse'} ${row.track.name || 'group'}`}
                    onclick={(event) => toggleGroupClick(event, row.track.id)}>
                    <Icon icon={collapsedGroups.has(String(row.track.id))
                      ? 'material-symbols:chevron-right' : 'material-symbols:expand-more'} />
                  </button>
                {:else}
                  <span class="group-toggle-spacer"></span>
                {/if}
                <button class="track-select" title={row.track.name || row.track.layer?.name || row.kind}
                  onclick={(event) => selectTrack(event, row.track.id)}>
                  <Icon icon={row.kind === 'audio' ? 'material-symbols:volume-up-outline'
                    : row.kind === 'group' ? 'material-symbols:folder-outline'
                    : row.track.layer?.type === 'video' ? 'material-symbols:movie-outline'
                    : row.track.layer?.type === 'effect' ? 'material-symbols:auto-fix-high-outline'
                    : 'material-symbols:layers-outline'} />
                  <span>{row.track.name || row.track.layer?.name || (row.kind === 'audio' ? 'Audio' : 'Track')}</span>
                  {#if row.track.locked}<Icon class="lock" icon="material-symbols:lock-outline" />{/if}
                </button>
              </div>

              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div class="track-lane" class:gap-selected={!!gapForRow(displayedSelection, row)}
                style={`left:${headerWidth}px;width:${laneWidth}px`}
                onpointerdown={(event) => lanePointerDown(event, row)}
                onpointermove={(event) => lanePointerMove(event, row)}
                onpointerleave={() => lanePointerLeave(row)}
                oncontextmenu={(event) => openLaneMenu(event, row)}>
                {#if gapForRow(displayedSelection, row)}
                  {@const gap = gapForRow(displayedSelection, row)}
                  <div class="gap-range" style={`left:${tickToPixel(gap.startTick, tickTransform)}px;width:${Math.max(1, tickToPixel(gap.endTick, tickTransform) - tickToPixel(gap.startTick, tickTransform))}px`}
                    title={`Selected gap: ${gap.endTick - gap.startTick} ticks`}></div>
                {/if}

                {#if hoverPreview?.rowId === row.id}
                  <span class="timeline-tool-preview" class:razor={hoverPreview.tool === 'razor'}
                    class:tag={hoverPreview.tool === 'tag'} class:valid={hoverPreview.valid}
                    class:invalid={!hoverPreview.valid} title={hoverPreview.title || null}
                    style={`left:${tickToPixel(hoverPreview.tick, tickTransform) - 1}px`}></span>
                {/if}
                {#if pointerEdit?.type === 'razor-path' && pointerEdit.moved}
                  {#each pointerEdit.plan?.cuts?.filter((cut) => cut.trackId === String(row.track.id)) || [] as cut (`${cut.clipId}:${cut.tick}`)}
                    <span class="timeline-tool-preview razor valid committed-preview"
                      title={`Split at tick ${cut.tick}`}
                      style={`left:${tickToPixel(cut.tick, tickTransform) - 1}px`}></span>
                  {/each}
                  {#if pointerEdit.plan?.current?.kind === 'none' && pointerEdit.plan.current.trackId === String(row.track.id)}
                    <span class="timeline-tool-preview razor invalid"
                      style={`left:${tickToPixel(pointerEdit.plan.current.tick, tickTransform) - 1}px`}></span>
                  {/if}
                {/if}

                {#if row.kind === 'group'}
                  {#each groupKeyMarkers(row.track, tickRange) as marker (marker.tick)}
                    <span class="group-key" style={`left:${tickToPixel(marker.tick, tickTransform) - 5}px`}
                      title={`${marker.properties.join(', ')} key at tick ${marker.tick}`}></span>
                  {/each}
                {:else if row.kind === 'visual'}
                  {#each clipsForRow(row, canonicalState, pointerEdit, $fps, tickRange) as clip (clip.id)}
                    {@const bounds = clipBounds(clip, tickTransform)}
                    {@const trimHandles = planClipTrimHandleLayout(bounds.width)}
                    {@const segments = showFilmstrip ? [] : buildClipExposureSegments(clip, tickRange)}
                    {@const filmstripSamples = showFilmstrip ? buildFilmstripSamples(clip, tickRange, zoom) : []}
                    {@const markers = projectFrameKeyMarkers(clip, tickTransform, tickRange)}
                    {@const propertyMarkers = planClipPropertyKeyMarkers(clip, tickRange)}
                    {@const keyMarkers = planTimelineKeyMarkerLayout(markers, propertyMarkers, {
                      pixelsPerTick: zoom,
                      rowHeight,
                    })}
                    <div class="timeline-clip" class:selected={displayedSelection.clipIds.has(String(clip.id))}
                      class:duplicate-ghost={clip.duplicateGhost}
                      class:invalid-duplicate={clip.duplicateGhost && !clip.duplicateValid}
                      class:effect={clipKind(row, clip) === 'effect'} class:video={clipKind(row, clip) === 'video'}
                      class:locked={row.track.locked} class:filmstrip={showFilmstrip}
                      role="button" tabindex="-1" aria-hidden={clip.duplicateGhost ? 'true' : undefined}
                      aria-label={`${clipKind(row, clip)} clip ${clipLabel(row, clip)}`}
                      style={`left:${bounds.left}px;width:${bounds.width}px`}
                      onpointerdown={(event) => startTimelineClip(event, row, clip)}
                      onlostpointercapture={(event) => finishPointer(event, true)}
                      oncontextmenu={(event) => openVisualMenu(event, row, clip)}>
                      {#if showFilmstrip}
                        {#each filmstripSamples as sample (sample.index)}
                          {@const thumbnail = thumbnailParams(row, clip, sample)}
                          <span class="filmstrip-frame"
                            style={`left:${tickToPixel(sample.startTick, tickTransform) - bounds.left}px;width:${Math.max(1, tickToPixel(sample.endTick, tickTransform) - tickToPixel(sample.startTick, tickTransform))}px`}
                            title="Filmstrip frame">
                            <canvas class="frame-thumbnail" aria-hidden="true"
                              use:frameThumbnail={thumbnail}></canvas>
                          </span>
                        {/each}
                      {:else}
                      {#each segments as segment (`${segment.sourceTick}:${segment.startTick}`)}
                        <span class="exposure-segment" class:held={segment.heldFromBeforeClip || segment.sourceTick !== clip.inTick}
                          style={`left:${tickToPixel(segment.startTick, tickTransform) - bounds.left}px;width:${Math.max(1, tickToPixel(segment.endTick, tickTransform) - tickToPixel(segment.startTick, tickTransform))}px`}
                          title={`Source tick ${segment.sourceTick}, held for ${segment.durationTicks}`}>
                        </span>
                      {/each}
                      {/if}
                      <span class="clip-label">{clipLabel(row, clip)}</span>
                      {#each keyMarkers as marker (`${marker.kind}:${marker.clipId}:${marker.propertyName || ''}:${marker.sourceTick}`)}
                        {@const shownMarker = previewKeyMarker(marker, marker.kind, pointerEdit)}
                        {#if marker.kind === 'frame'}
                          <button class="frame-key" class:selected={frameKeySelected(displayedSelection, clip.id, marker.sourceTick)}
                            class:moving={shownMarker.moving} class:invalid-move={shownMarker.moving && !shownMarker.moveValid}
                            aria-label={`Frame key at tick ${shownMarker.timelineTick}`}
                            title={`Frame key: source ${shownMarker.sourceTick}, project ${shownMarker.timelineTick}`}
                            style={`left:${tickToPixel(shownMarker.timelineTick, tickTransform) - bounds.left + marker.left}px;top:${marker.top}px;width:${marker.width}px;height:${marker.height}px;--key-glyph-size:${marker.glyphSize}px`}
                            onpointerdown={(event) => keyPointerDown(event, row, clip, marker, 'frame')}
                            oncontextmenu={(event) => openFrameKeyMenu(event, row, clip, marker)}><span></span></button>
                        {:else}
                          <button class="property-key"
                            class:selected={propertyKeySelected(displayedSelection, clip.id, marker.propertyName, marker.sourceTick)}
                            class:moving={shownMarker.moving} class:invalid-move={shownMarker.moving && !shownMarker.moveValid}
                            aria-label={`${propertyLabel(marker.propertyName)} key at tick ${shownMarker.timelineTick}`}
                            title={`${propertyLabel(marker.propertyName)} key: source ${shownMarker.sourceTick}, project ${shownMarker.timelineTick}`}
                            style={`left:${tickToPixel(shownMarker.timelineTick, tickTransform) - bounds.left + marker.left}px;top:${marker.top}px;width:${marker.width}px;height:${marker.height}px;--key-glyph-size:${marker.glyphSize}px`}
                            onpointerdown={(event) => keyPointerDown(event, row, clip, marker, 'property')}
                            oncontextmenu={(event) => openPropertyKeyMenu(event, row, clip, marker)}><span></span></button>
                        {/if}
                      {/each}
                      <button class="trim-handle start" disabled={$playing || (tool === 'select' && row.track.locked)}
                        aria-label={`Trim start of ${clipLabel(row, clip)}`}
                        title={tool === 'select' ? `Trim start of ${clipLabel(row, clip)}` : null}
                        style={`left:${trimHandles.start.left}px;width:${trimHandles.start.width}px`}
                        onpointerdown={(event) => startTimelineTrim(event, row, clip, 'start')}></button>
                      <button class="trim-handle end" disabled={$playing || (tool === 'select' && row.track.locked)}
                        aria-label={`Trim end of ${clipLabel(row, clip)}`}
                        title={tool === 'select' ? `Trim end of ${clipLabel(row, clip)}` : null}
                        style={`left:${trimHandles.end.left}px;width:${trimHandles.end.width}px`}
                        onpointerdown={(event) => startTimelineTrim(event, row, clip, 'end')}></button>
                    </div>
                  {/each}
                {:else}
                  {#each clipsForRow(row, canonicalState, pointerEdit, $fps, tickRange) as clip (clip.id)}
                    {@const bounds = clipBounds(clip, tickTransform)}
                    {@const trimHandles = planClipTrimHandleLayout(bounds.width)}
                    {@const asset = audioAsset($audioAssets, clip)}
                    {@const sourceState = audioSourceState(asset, $mediaRuntimeStatus)}
                    {@const waveformBounds = boundedAudioWaveform(clip, bounds, tickRange, tickTransform, $fps)}
                    <div class="timeline-clip audio" class:selected={displayedSelection.clipIds.has(String(clip.id))}
                      class:duplicate-ghost={clip.duplicateGhost}
                      class:invalid-duplicate={clip.duplicateGhost && !clip.duplicateValid}
                      class:muted={clip.muted} class:missing={sourceState === 'missing' || sourceState === 'decode-failed'} class:locked={row.track.locked}
                      role="button" tabindex="-1" aria-hidden={clip.duplicateGhost ? 'true' : undefined}
                      aria-label={`Audio clip ${audioLabel(row, asset)}`}
                      title={sourceState === 'ready'
                        ? `${audioLabel(row, asset)} waveform`
                        : sourceState === 'loading' ? 'Loading audio source' : 'Missing audio source'}
                      style={`left:${bounds.left}px;width:${bounds.width}px`}
                      onpointerdown={(event) => startTimelineClip(event, row, clip)}
                      onlostpointercapture={(event) => finishPointer(event, true)}
                      oncontextmenu={(event) => openAudioMenu(event, clip)}>
                      {#if asset?.buffer}
                        <canvas class="audio-waveform"
                          style={`left:${waveformBounds.left}px;width:${waveformBounds.width}px`}
                          use:waveform={{
                            buffer: asset.buffer,
                            inPoint: waveformBounds.inPoint,
                            outPoint: waveformBounds.outPoint,
                          }}></canvas>
                      {/if}
                      <span class="clip-label">{asset?.sourceName || 'Missing audio'}</span>
                      <button class="trim-handle start" disabled={$playing || (tool === 'select' && row.track.locked)}
                        aria-label={`Trim start of ${audioLabel(row, asset)}`}
                        title={tool === 'select' ? `Trim start of ${audioLabel(row, asset)}` : null}
                        style={`left:${trimHandles.start.left}px;width:${trimHandles.start.width}px`}
                        onpointerdown={(event) => startTimelineTrim(event, row, clip, 'start')}></button>
                      <button class="trim-handle end" disabled={$playing || (tool === 'select' && row.track.locked)}
                        aria-label={`Trim end of ${audioLabel(row, asset)}`}
                        title={tool === 'select' ? `Trim end of ${audioLabel(row, asset)}` : null}
                        style={`left:${trimHandles.end.left}px;width:${trimHandles.end.width}px`}
                        onpointerdown={(event) => startTimelineTrim(event, row, clip, 'end')}></button>
                    </div>
                  {/each}
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
      <div class="track-boundary-resizer" role="separator" tabindex="0"
        aria-label="Resize track headers" aria-orientation="vertical"
        aria-valuemin="120" aria-valuemax={maximumTrackHeaderWidth(viewportWidth)}
        aria-valuenow={headerWidth} aria-valuetext={`${headerWidth} pixels`}
        style={`left:${headerDivider.hitLeft}px;width:${headerDivider.hitWidth}px;--track-grip-left:${headerDivider.gripLeft - headerDivider.hitLeft}px;--track-grip-width:${headerDivider.gripWidth}px`}
        onpointerdown={startHeaderResize}
        onpointermove={resizePointerMove}
        onpointerup={resizePointerUp}
        onpointercancel={resizePointerCancel}
        onlostpointercapture={(event) => headerResize && finishHeaderResize(event, true)}
        onkeydown={resizeHeaderWithKey}></div>
    </div>

    {#if contextMenu}
      <div class="clip-timeline-menu" style={`left:${contextMenu.x}px;top:${contextMenu.y}px`}
        role="menu" tabindex="-1" use:popupFocus={{ initialFocus: 'button:not([disabled])' }}
        data-keyboard-context="timeline" onpointerdown={stopPointerDownPropagation}>
        {#if contextMenu.kind === 'visual' && menuVisualClip}
          <strong>{menuVisualClip.name || 'Clip'}</strong>
          <button onclick={splitMenuVisual} disabled={$playing || contextMenu.locked}>
            <Icon icon="material-symbols:content-cut" /> Razor at playhead
          </button>
          <button onclick={selectMenuTrack}><Icon icon="material-symbols:select-all" /> Select track</button>
          <button onclick={toggleFilmstrip}>
            <Icon icon="mdi:filmstrip-box-multiple" /> {showFilmstrip ? 'Hide' : 'Show'} frame thumbnails
          </button>
          <button class="danger" onclick={deleteContextSelection}
            disabled={$playing || contextMenu.deleteDisabled}>
            <Icon icon="material-symbols:delete-outline" /> {contextMenu.deleteLabel}
          </button>
        {:else if contextMenu.kind === 'audio' && menuAudioClip}
          <strong>{menuAudioAsset?.sourceName || 'Audio clip'}</strong>
          <button onclick={splitMenuAudio} disabled={$playing || contextMenu.locked}>
            <Icon icon="material-symbols:content-cut" /> Razor at playhead
          </button>
          <button onclick={toggleMenuAudioMute} disabled={$playing || contextMenu.locked}>
            <Icon icon={menuAudioClip.muted ? 'material-symbols:volume-up-outline' : 'material-symbols:volume-off-outline'} />
            {menuAudioClip.muted ? 'Unmute' : 'Mute'}
          </button>
          {#if menuAudioState === 'missing' || menuAudioState === 'decode-failed'}
            <button onclick={relinkMenuAudio} disabled={$playing || contextMenu.locked}>
              <Icon icon="material-symbols:link" /> Relink…
            </button>
          {/if}
          <button class="danger" onclick={deleteContextSelection}
            disabled={$playing || contextMenu.deleteDisabled}>
            <Icon icon="material-symbols:delete-outline" /> {contextMenu.deleteLabel}
          </button>
        {:else if contextMenu.kind === 'key'}
          <strong>{contextMenu.title}</strong>
          <button class="danger" onclick={deleteContextSelection}
            disabled={$playing || contextMenu.deleteDisabled}>
            <Icon icon="material-symbols:delete-outline" /> {contextMenu.deleteLabel}
          </button>
        {:else if contextMenu.kind === 'gap'}
          <strong>Selected track gap</strong>
          <button onclick={rippleMenuGap} disabled={$playing}>
            <Icon icon="material-symbols:collapse-content" /> Ripple delete gap
          </button>
        {/if}
      </div>
    {/if}

    {#if tagEditor}
      <form class="timeline-tag-editor" style={`left:${tagEditor.x}px;top:${tagEditor.y}px`}
        role="dialog" aria-label={`Edit tags at tick ${tagEditor.tick}`} tabindex="-1"
        use:popupFocus={{ initialFocus: () => tagType === 'custom' ? tagInputEl : tagTypeEl }}
        onsubmit={submitTagEditor} onpointerdown={stopPointerDownPropagation}
        onkeydown={tagEditorKeydown}>
        <header>
          <strong>Tag</strong>
          <button type="button" class="tag-close" aria-label="Close tag editor"
            onclick={closeTagEditor}>&times;</button>
        </header>
        <label class="tag-tick">
          <span>Tick</span>
          <input type="number" min="0" max={contentDurationTicks - 1} step="1"
            bind:value={tagTick} aria-label="Tag tick" />
        </label>
        <label class="tag-kind">
          <span>Type</span>
          <select bind:this={tagTypeEl} bind:value={tagType} aria-label="Tag type">
            <option value="loop-start">Loop start</option>
            <option value="loop-end">Loop end</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {#if tagType === 'custom'}
          <label class="tag-value">
            <span>Value</span>
            <input bind:this={tagInputEl} bind:value={tagValue} maxlength="160"
              aria-label="Custom tag value" placeholder="Programmer event" />
          </label>
        {/if}
        <button class="tag-save" type="submit"
          disabled={tagType === 'custom' && !tagValue.trim()}>
          {tagEditor.editingId ? 'Update' : 'Set'}
        </button>
        {#if editorTags.length}
          <div class="tag-list" aria-label={`Tags at tick ${tagEditor.tick}`}>
            {#each editorTags as tag (tag.id)}
              <div class="tag-list-row">
                <button type="button" class="tag-edit" title={tagTitle(tag)}
                  onclick={() => editTag(tag)}>
                  <span class="tag-dot {tag.type}"></span>
                  <span>{tag.type === 'custom' ? tag.value : tag.type === 'loop-start' ? 'Loop start' : 'Loop end'}</span>
                </button>
                <button type="button" class="tag-delete danger" aria-label={`Delete ${tagTitle(tag)}`}
                  title={`Delete ${tagTitle(tag)}`} onclick={() => deleteTag(tag.id)}>
                  <Icon icon="material-symbols:delete-outline" />
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </form>
    {/if}
  </div>
{/if}

<style>
  .clip-timeline {
    display: flex;
    min-width: 0;
    min-height: 0;
    height: 100%;
    flex-direction: column;
    overflow: hidden;
    background: var(--panel-lo);
    color: var(--text);
    font-size: 11px;
  }
  .clip-timeline:focus { outline: none; }
  .timeline-workspace { position: relative; display: flex; min-height: 0; flex: 1; }
  .timeline-viewport {
    position: relative;
    min-width: 0;
    min-height: 0;
    flex: 1;
    overflow: auto;
    background: var(--workspace);
    scrollbar-gutter: stable;
  }
  .timeline-surface { position: relative; min-width: 100%; }
  .tick-ruler {
    position: sticky;
    top: 0;
    z-index: 40;
    border-bottom: 1px solid var(--border);
    background: var(--panel-lo);
  }
  .ruler-corner {
    position: sticky;
    left: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    height: 100%;
    padding: 0 10px;
    border-right: 1px solid var(--border);
    background: var(--panel-hi);
    color: var(--text-dim);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .ruler-lane { position: absolute; top: 0; height: 100%; cursor: default; }
  .ruler-active-range {
    position: absolute;
    z-index: 1;
    inset: 0 auto 0 0;
    cursor: ew-resize;
  }
  .loop-range-band {
    position: absolute;
    z-index: 1;
    top: 11px;
    bottom: 1px;
    border-inline: 1px solid var(--accent-dim);
    background: var(--accent-wash);
    pointer-events: none;
  }
  .ruler-tick {
    position: absolute;
    z-index: 2;
    bottom: 0;
    width: 1px;
    height: 7px;
    background: var(--border);
    pointer-events: none;
  }
  .ruler-tick.major { height: 13px; background: var(--text-faint); }
  .ruler-tick span {
    position: absolute;
    bottom: 12px;
    left: 4px;
    color: var(--text-dim);
    font: 9px var(--font-mono);
  }
  .cti-head {
    position: absolute;
    z-index: 12;
    top: 0;
    width: 12px;
    height: 8px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: ew-resize;
  }
  .cti-head::before {
    content: '';
    position: absolute;
    left: 0;
    top: 1px;
    width: 12px;
    height: 10px;
    border-radius: 2px 2px 6px 6px;
    background: var(--accent);
    clip-path: polygon(0 0, 100% 0, 50% 100%);
    pointer-events: none;
  }
  .cti-ruler-line {
    position: absolute;
    top: 8px;
    width: 3px;
    height: 22px;
    background: transparent;
    pointer-events: none;
  }
  .cti-ruler-line::before {
    content: '';
    position: absolute;
    left: 1px;
    top: 0;
    width: 1px;
    height: 22px;
    background: var(--accent);
    pointer-events: none;
  }
  .timeline-tag-marker {
    position: absolute;
    z-index: 9;
    padding: 0;
    border: 0;
    border-radius: 2px 2px 5px 2px;
    background: var(--accent);
    box-shadow: 0 1px 2px var(--workspace);
    touch-action: none;
  }
  .timeline-tag-marker::after {
    content: '';
    position: absolute;
    left: 50%;
    bottom: -2px;
    transform: translateX(-50%);
    border-top: 3px solid var(--accent);
    border-right: 3px solid transparent;
  }
  .timeline-tag-marker.loop-start { background: var(--play); }
  .timeline-tag-marker.loop-start::after { border-top-color: var(--play); }
  .timeline-tag-marker.loop-end { background: var(--stop); }
  .timeline-tag-marker.loop-end::after { border-top-color: var(--stop); }
  .timeline-tag-marker.cluster::before {
    content: '+';
    display: block;
    color: var(--on-accent);
    font: 700 7px/7px var(--font-ui);
    text-align: center;
  }
  .timeline-tag-marker:hover { filter: brightness(1.18); }
  .timeline-tag-marker.moving { outline: 1px solid var(--on-accent); filter: brightness(1.22); }
  .playhead-line {
    position: absolute;
    z-index: 21;
    width: 1px;
    pointer-events: none;
    background: var(--accent);
    box-shadow: 0 0 0 1px var(--playhead-outline);
  }
  .timeline-marquee {
    position: absolute;
    z-index: 20;
    border: 1px solid var(--accent);
    background: var(--accent-wash);
    box-shadow: inset 0 0 0 1px var(--selection-inset-outline);
    pointer-events: none;
  }
  .track-boundary-resizer {
    position: absolute;
    z-index: 60;
    top: 0;
    bottom: 0;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: ew-resize;
    touch-action: none;
  }
  .track-boundary-resizer::after {
    content: '';
    position: absolute;
    top: 6px;
    bottom: 6px;
    left: var(--track-grip-left);
    width: var(--track-grip-width);
    border-radius: 2px;
    background: var(--border);
  }
  .track-boundary-resizer:hover::after,
  .track-boundary-resizer:focus-visible::after { background: var(--accent); }
  .timeline-row { position: absolute; left: 0; border-bottom: 1px solid var(--border-subtle); }
  .track-header {
    position: sticky;
    left: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    height: 100%;
    padding-left: calc(var(--track-depth) * 12px + 3px);
    border-right: 1px solid var(--border);
    background: var(--panel-hi);
    color: var(--text-dim);
  }
  .group-row .track-header { background: var(--group-row); }
  .track-header.selected { color: var(--text); box-shadow: inset 3px 0 var(--accent); }
  .group-toggle, .group-toggle-spacer { width: 26px; height: 28px; flex: 0 0 26px; }
  .group-toggle {
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-dim);
  }
  .group-toggle:hover { color: var(--accent); background: var(--hover, var(--accent-wash)); }
  .track-select {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    height: 100%;
    flex: 1;
    padding: 0 8px 0 3px;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
  }
  .track-select span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .track-select :global(.lock) { margin-left: auto; flex: 0 0 auto; }
  .track-lane {
    position: absolute;
    top: 0;
    height: 100%;
    background-color: var(--panel);
    background-image: repeating-linear-gradient(90deg, transparent 0 calc(var(--tick-width) - 1px),
      var(--border-subtle) calc(var(--tick-width) - 1px) var(--tick-width));
    touch-action: none;
  }
  .group-row .track-lane { background-color: var(--group-row); }
  .audio-row .track-lane { background-color: var(--audio-track-surface); }
  .gap-range {
    position: absolute;
    z-index: 1;
    top: 3px;
    bottom: 3px;
    border: 1px dashed var(--accent);
    background: var(--accent-wash);
    pointer-events: none;
  }
  .timeline-tool-preview {
    position: absolute;
    z-index: 24;
    top: 2px;
    bottom: 2px;
    width: 2px;
    pointer-events: none;
  }
  .timeline-tool-preview.razor.valid {
    background: var(--danger);
    box-shadow: 0 0 0 1px var(--razor-outline);
  }
  .timeline-tool-preview.razor.invalid {
    width: 1px;
    border-left: 1px dashed var(--text-faint);
    opacity: 0.85;
  }
  .timeline-tool-preview.tag.valid {
    width: 1px;
    background: var(--accent);
  }
  .timeline-tool-preview.tag.valid::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    width: 6px;
    height: 6px;
    border-radius: 1px 3px 3px 1px;
    background: var(--accent);
  }
  .timeline-tool-preview.tag.invalid {
    width: 1px;
    border-left: 1px dashed var(--text-faint);
    opacity: 0.65;
  }
  .timeline-tool-preview.committed-preview { width: 2px; }
  .group-key {
    position: absolute;
    top: 16px;
    width: 10px;
    height: 10px;
    transform: rotate(45deg);
    border: 1px solid var(--accent);
    background: var(--group-row);
  }
  .timeline-clip {
    position: absolute;
    z-index: 4;
    top: 5px;
    bottom: 5px;
    min-width: 1px;
    border: 1px solid var(--visual-clip-border);
    border-radius: 3px;
    background: var(--visual-clip-surface);
    color: var(--visual-clip-text);
    cursor: grab;
    isolation: isolate;
    touch-action: none;
  }
  .timeline-clip.effect { border-color: var(--effect-clip-border); background: var(--effect-clip-surface); color: var(--effect-clip-text); }
  .timeline-clip.video { border-color: var(--video-clip-border); background: var(--video-clip-surface); color: var(--video-clip-text); }
  .timeline-clip.filmstrip {
    border: 0; border-radius: 0; background: transparent; box-shadow: none;
  }
  .timeline-clip.audio { border-color: var(--audio-clip-border); background: var(--audio-clip-surface); color: var(--audio-clip-text); }
  .timeline-clip.audio.missing {
    border-color: var(--missing-clip-border);
    background: repeating-linear-gradient(135deg, var(--missing-clip-surface-a) 0 6px, var(--missing-clip-surface-b) 6px 12px);
    color: var(--missing-clip-text);
  }
  .timeline-clip.selected {
    z-index: 8;
    border-color: var(--accent);
    outline: 1px solid var(--accent);
    box-shadow: 0 0 0 1px var(--selection-outer-outline);
  }
  .timeline-clip.duplicate-ghost {
    z-index: 18;
    opacity: 0.72;
    pointer-events: none;
    border-style: dashed;
    outline: 1px dashed var(--accent);
    box-shadow: 0 0 0 1px var(--selection-outer-outline);
  }
  .timeline-clip.duplicate-ghost.invalid-duplicate {
    border-color: var(--danger);
    outline-color: var(--danger);
    filter: saturate(0.5);
  }
  .timeline-clip.duplicate-ghost .frame-key,
  .timeline-clip.duplicate-ghost .property-key,
  .timeline-clip.duplicate-ghost .trim-handle { display: none; }
  .timeline-clip.filmstrip.selected { box-shadow: none; }
  .timeline-clip.locked { cursor: default; opacity: 0.72; }
  .timeline-clip.muted { opacity: 0.52; }
  .clip-label {
    position: absolute;
    z-index: 4;
    left: 14px;
    right: 14px;
    top: 7px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
    pointer-events: none;
    text-shadow: 0 1px 2px var(--visual-clip-label-shadow);
  }
  .exposure-segment {
    position: absolute;
    z-index: 1;
    top: 1px;
    bottom: 1px;
    overflow: hidden;
    border-right: 1px solid var(--exposure-border);
    background: var(--exposure-wash);
    pointer-events: none;
  }
  .exposure-segment.held { background: var(--exposure-held-wash); }
  .filmstrip-frame {
    position: absolute; z-index: 1; top: 0; bottom: 0; overflow: hidden;
    background: transparent; pointer-events: none;
  }
  .frame-thumbnail { display: block; width: 100%; height: 100%; }
  .filmstrip .clip-label { display: none; }
  .frame-key {
    position: absolute;
    z-index: 14;
    padding: 0;
    border: 0;
    background: transparent;
    touch-action: none;
  }
  .frame-key span {
    position: absolute;
    left: 50%;
    top: 50%;
    width: var(--key-glyph-size);
    height: var(--key-glyph-size);
    transform: translate(-50%, -50%) rotate(45deg);
    border: 1px solid var(--frame-key-outline);
    background: var(--key-surface);
    pointer-events: none;
  }
  .frame-key.selected span { border-color: var(--accent); background: var(--accent); }
  .frame-key.moving span,
  .property-key.moving span { box-shadow: 0 0 0 2px var(--accent-wash); }
  .frame-key.invalid-move span,
  .property-key.invalid-move span { border-color: var(--danger); background: var(--panel-hi); }
  .property-key {
    position: absolute;
    z-index: 15;
    padding: 0;
    border: 0;
    background: transparent;
    touch-action: none;
  }
  .property-key span {
    position: absolute;
    left: 50%;
    top: 50%;
    width: var(--key-glyph-size);
    height: var(--key-glyph-size);
    transform: translate(-50%, -50%) rotate(45deg);
    border: 1px solid var(--property-key-outline);
    background: var(--key-surface);
    pointer-events: none;
  }
  .property-key.selected span { border-color: var(--accent); background: var(--accent); }
  .trim-handle {
    position: absolute;
    z-index: 16;
    bottom: 0;
    height: 8px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: ew-resize;
  }
  .trim-handle::after {
    content: '';
    position: absolute;
    bottom: 2px;
    width: 2px;
    height: 24px;
    border-radius: 2px;
    background: var(--timeline-trim);
    pointer-events: none;
  }
  .timeline-clip.filmstrip .trim-handle::after { height: 38px; }
  .trim-handle.start::after { left: 0; }
  .trim-handle.end::after { right: 0; }
  .timeline-clip:hover .trim-handle:not(:disabled)::after,
  .trim-handle:hover:not(:disabled)::after { background: var(--accent); }
  .audio-waveform {
    position: absolute;
    z-index: 1;
    top: 3px;
    bottom: 3px;
    height: calc(100% - 6px);
    pointer-events: none;
  }
  .empty-timeline {
    position: absolute;
    display: grid;
    place-items: center;
    height: 86px;
    color: var(--text-faint);
  }
  .empty-tag-lane {
    position: absolute;
    display: grid;
    place-items: center;
    overflow: hidden;
    padding: 0;
    border: 0;
    background-color: var(--panel);
    background-image: repeating-linear-gradient(90deg, transparent 0 calc(var(--tick-width) - 1px),
      var(--border-subtle) calc(var(--tick-width) - 1px) var(--tick-width));
    color: var(--text-dim);
    cursor: copy;
    touch-action: none;
  }
  .empty-tag-lane:hover { box-shadow: inset 0 0 0 1px var(--accent-dim); }
  .empty-tag-lane > span:first-child { pointer-events: none; }
  .clip-timeline-menu {
    position: fixed;
    z-index: 140;
    width: 214px;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--panel-hi);
    box-shadow: 0 10px 28px var(--shadow-menu);
  }
  .clip-timeline-menu strong {
    display: block;
    overflow: hidden;
    padding: 6px 8px 8px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .clip-timeline-menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 28px;
    padding: 4px 8px;
    border: 0;
    border-radius: 2px;
    background: transparent;
    color: var(--text);
    text-align: left;
  }
  .clip-timeline-menu button:hover:not(:disabled) { background: var(--accent-wash); }
  .clip-timeline-menu button.danger { color: var(--danger); }
  .timeline-tag-editor {
    position: fixed;
    z-index: 145;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    width: 258px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--panel-hi);
    box-shadow: 0 10px 28px var(--workspace);
  }
  .timeline-tag-editor header {
    display: flex;
    grid-column: 1 / -1;
    align-items: center;
    justify-content: space-between;
    min-width: 0;
  }
  .timeline-tag-editor header strong { padding: 2px 3px; }
  .tag-close {
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-dim);
    font-size: 17px;
  }
  .tag-close:hover { color: var(--text); }
  .tag-tick, .tag-kind, .tag-value {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: 42px minmax(0, 1fr);
    align-items: center;
    gap: 7px;
    color: var(--text-dim);
    font-size: 10px;
  }
  .tag-tick input, .tag-kind select, .tag-value input { width: 100%; height: 28px; min-width: 0; }
  .tag-tick input, .tag-value input { user-select: text; }
  .tag-save {
    grid-column: 2;
    min-width: 58px;
    height: 28px;
    padding: 0 9px;
    border: 1px solid var(--accent-dim);
    border-radius: var(--radius-sm);
    background: var(--accent-dim);
    color: var(--on-accent);
  }
  .tag-save:hover:not(:disabled) { background: var(--accent); }
  .tag-save:disabled { opacity: 0.4; }
  .tag-list {
    display: grid;
    grid-column: 1 / -1;
    gap: 2px;
    max-height: 112px;
    overflow-y: auto;
    padding-top: 6px;
    border-top: 1px solid var(--border);
  }
  .tag-list-row { display: flex; min-width: 0; }
  .tag-edit, .tag-delete {
    min-height: 27px;
    padding: 3px 6px;
    border: 0;
    border-radius: 2px;
    background: transparent;
    color: var(--text);
  }
  .tag-edit {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    flex: 1;
    text-align: left;
  }
  .tag-edit span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tag-edit:hover, .tag-delete:hover { background: var(--accent-wash); }
  .tag-delete { display: grid; width: 28px; place-items: center; color: var(--danger); }
  .tag-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 2px; background: var(--accent); }
  .tag-dot.loop-start { background: var(--play); }
  .tag-dot.loop-end { background: var(--stop); }
  .select-tool .track-lane { cursor: crosshair; }
  .select-tool .track-lane:hover { box-shadow: inset 0 0 0 1px var(--accent-dim); }
  .select-tool .timeline-clip { cursor: grab; }
  .select-tool .timeline-tag-marker { cursor: grab; }
  .select-tool .timeline-tag-marker.cluster { cursor: pointer; }
  .select-tool .trim-handle { cursor: ew-resize; }
  .razor-tool .track-lane,
  .razor-tool .timeline-clip,
  .razor-tool .frame-key,
  .razor-tool .property-key,
  .razor-tool .trim-handle { cursor: crosshair; }
  .tag-tool .track-lane,
  .tag-tool .timeline-clip,
  .tag-tool .frame-key,
  .tag-tool .property-key,
  .tag-tool .trim-handle { cursor: copy; }
  .playback-locked .track-lane { cursor: ew-resize; }
  .playback-locked .timeline-clip { cursor: default; }
  .playback-locked .frame-key,
  .playback-locked .property-key,
  .playback-locked .trim-handle { cursor: default; }
</style>
