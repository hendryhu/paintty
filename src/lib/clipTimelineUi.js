import {
  cloneClipTimelineSelection,
  createClipTimelineSelection,
  emptyClipTimelineSelection,
} from './clipTimelineState.js';
import { audioClipDurationTicks, normalizeAudioClip } from './audio.js';
import {
  findCommonTrackGap,
  planSelectedClipEdgeResize,
  resolveTimelineTrackScope,
  snapTimelineTick,
} from './timelineViewport.js';

function ids(value) {
  if (value == null) return [];
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (typeof value[Symbol.iterator] !== 'function') return [];
  return [...new Set([...value].map((entry) => String(entry)))];
}

function clipEndTick(clip) {
  return Number(clip?.startTick) + Math.max(1, Number(clip?.outTick) - Number(clip?.inTick));
}

function toggleModifier(modifiers) {
  return Boolean(modifiers?.ctrlKey || modifiers?.metaKey);
}

export function planTimelinePointerIntent(tool, tick, options = {}) {
  if (tick == null) return { kind: 'none' };
  const targetTick = Number(tick);
  if (!Number.isInteger(targetTick) || targetTick < 0) return { kind: 'none' };
  if (options.surface === 'ruler') return { kind: 'seek', tick: targetTick };
  if (options.playing) return { kind: 'seek', tick: targetTick };
  if (options.editable !== false && tool === 'tag') return { kind: 'tag', tick: targetTick };
  if (options.editable !== false && tool === 'razor') return { kind: 'razor', tick: targetTick };
  return tool === 'select' ? { kind: 'seek', tick: targetTick } : { kind: 'none' };
}

function clearDirectTargets(selection) {
  selection.clipIds = new Set();
  selection.frameKeys = [];
  selection.propertyKeys = [];
  selection.gap = null;
  selection.rulerRange = null;
  return selection;
}

function orderedClips(state) {
  const trackOrder = new Map((state?.tracks || []).map((track, index) => [String(track.id), index]));
  return [...(state?.clips || [])].sort((first, second) =>
    (trackOrder.get(String(first.trackId)) ?? Number.MAX_SAFE_INTEGER) -
      (trackOrder.get(String(second.trackId)) ?? Number.MAX_SAFE_INTEGER) ||
    Number(first.startTick) - Number(second.startTick) ||
    String(first.id).localeCompare(String(second.id)));
}

export function planTrackHeaderClick(
  state,
  selection,
  trackId,
  modifiers = {},
  anchorTrackId = null,
) {
  const normalized = createClipTimelineSelection(selection, state);
  const trackIds = (state?.tracks || []).map((track) => String(track.id));
  const target = String(trackId);
  if (!trackIds.includes(target)) return { selection: normalized, anchorTrackId };

  const next = clearDirectTargets(cloneClipTimelineSelection(normalized));
  let selected = new Set(normalized.trackHeaderIds);
  const anchorIndex = trackIds.indexOf(String(anchorTrackId));
  const targetIndex = trackIds.indexOf(target);
  if (modifiers.shiftKey && anchorIndex >= 0) {
    const range = trackIds.slice(
      Math.min(anchorIndex, targetIndex),
      Math.max(anchorIndex, targetIndex) + 1,
    );
    selected = toggleModifier(modifiers) ? new Set([...selected, ...range]) : new Set(range);
  } else if (toggleModifier(modifiers)) {
    if (selected.has(target)) selected.delete(target);
    else selected.add(target);
  } else {
    selected = new Set([target]);
  }
  next.trackHeaderIds = selected;
  return {
    selection: next,
    anchorTrackId: modifiers.shiftKey && anchorIndex >= 0 ? anchorTrackId : target,
  };
}

export function planClipClick(
  state,
  selection,
  clipId,
  modifiers = {},
  anchorClipId = null,
) {
  const normalized = createClipTimelineSelection(selection, state);
  const clips = orderedClips(state);
  const clipIds = clips.map((clip) => String(clip.id));
  const target = String(clipId);
  if (!clipIds.includes(target)) return { selection: normalized, anchorClipId };

  const next = cloneClipTimelineSelection(normalized);
  next.frameKeys = [];
  next.propertyKeys = [];
  next.gap = null;
  next.rulerRange = null;
  let selected = new Set(normalized.clipIds);
  const anchorIndex = clipIds.indexOf(String(anchorClipId));
  const targetIndex = clipIds.indexOf(target);
  if (modifiers.shiftKey && anchorIndex >= 0) {
    const range = clipIds.slice(
      Math.min(anchorIndex, targetIndex),
      Math.max(anchorIndex, targetIndex) + 1,
    );
    selected = toggleModifier(modifiers) ? new Set([...selected, ...range]) : new Set(range);
  } else if (toggleModifier(modifiers)) {
    if (selected.has(target)) selected.delete(target);
    else selected.add(target);
  } else if (!modifiers.preserveExisting || !selected.has(target)) {
    selected = new Set([target]);
  }
  next.clipIds = selected;
  return {
    selection: next,
    anchorClipId: modifiers.shiftKey && anchorIndex >= 0 ? anchorClipId : target,
  };
}

function clipTrack(state, clip) {
  return (state?.tracks || [])
    .find((track) => String(track.id) === String(clip?.trackId)) || null;
}

function clipIsEditable(state, clip) {
  const track = clipTrack(state, clip);
  return Boolean(track && track.kind !== 'group' && !track.locked);
}

export function planClipContext(state, selection, clipId) {
  const normalized = createClipTimelineSelection(selection, state);
  const targetId = String(clipId);
  const clip = (state?.clips || []).find((candidate) => String(candidate.id) === targetId);
  if (!clip) {
    return {
      kind: 'none',
      selection: normalized,
      deleteSelection: emptyClipTimelineSelection(),
      deleteCount: 0,
      deleteLabel: 'Delete clip',
      deleteDisabled: true,
      locked: false,
    };
  }

  const targetSelected = normalized.clipIds.has(targetId);
  const next = targetSelected
    ? cloneClipTimelineSelection(normalized)
    : emptyClipTimelineSelection();
  if (!targetSelected) next.clipIds.add(targetId);
  const targetLocked = !clipIsEditable(state, clip);
  const requestedIds = targetSelected ? [...normalized.clipIds] : [targetId];
  const editableIds = targetLocked ? [] : requestedIds.filter((id) => {
    const candidate = (state?.clips || []).find((entry) => String(entry.id) === String(id));
    return candidate && clipIsEditable(state, candidate);
  });
  const deleteSelection = emptyClipTimelineSelection();
  deleteSelection.clipIds = new Set(editableIds.map(String));
  const deleteCount = deleteSelection.clipIds.size;
  return {
    kind: 'clip',
    clipId: targetId,
    selection: next,
    deleteSelection,
    deleteCount,
    deleteLabel: deleteCount > 1 ? `Delete ${deleteCount} clips` : 'Delete clip',
    deleteDisabled: deleteCount === 0,
    locked: targetLocked,
  };
}

function frameKeyIdentity(key) {
  return `${String(key.clipId)}\u0000${Number(key.sourceTick)}`;
}

function propertyKeyIdentity(key) {
  return `${String(key.clipId)}\u0000${String(key.propertyName)}\u0000${Number(key.sourceTick)}`;
}

export function timelinePropertyLabel(name) {
  return String(name || 'Property')
    .replace(
      /([a-z0-9])([A-Z])/g,
      (_, first, second) => `${first} ${second.toLowerCase()}`,
    )
    .replace(/^./, (value) => value.toUpperCase());
}

export function planTimelineKeyContext(state, selection, target = {}) {
  const normalized = createClipTimelineSelection(selection, state);
  const clipId = String(target.clipId ?? '');
  const clip = (state?.clips || []).find((candidate) => String(candidate.id) === clipId);
  const sourceTick = Number(target.sourceTick);
  const propertyName = String(target.propertyName || '').trim();
  const kind = target.kind === 'frame' ? 'frame' : propertyName ? 'property' : null;
  const exists = kind === 'frame'
    ? clip?.frameKeys?.some((key) => Number(key.tick) === sourceTick)
    : kind === 'property'
      ? clip?.propertyTracks?.[propertyName]?.some((key) => Number(key.tick) === sourceTick)
      : false;
  if (!exists) {
    return {
      kind: 'none',
      selection: normalized,
      deleteSelection: emptyClipTimelineSelection(),
      deleteCount: 0,
      deleteLabel: 'Delete key',
      deleteDisabled: true,
      locked: false,
      title: 'Key',
    };
  }

  const key = kind === 'frame'
    ? { clipId, sourceTick }
    : { clipId, sourceTick, propertyName };
  const targetIdentity = kind === 'frame' ? frameKeyIdentity(key) : propertyKeyIdentity(key);
  const selectedKeys = kind === 'frame' ? normalized.frameKeys : normalized.propertyKeys;
  const identity = kind === 'frame' ? frameKeyIdentity : propertyKeyIdentity;
  const targetSelected = selectedKeys.some((entry) => identity(entry) === targetIdentity);
  const selectedFrameKeys = targetSelected ? normalized.frameKeys : (kind === 'frame' ? [key] : []);
  const selectedPropertyKeys = targetSelected
    ? normalized.propertyKeys
    : (kind === 'property' ? [key] : []);
  const next = cloneClipTimelineSelection(normalized);
  next.clipIds = new Set();
  next.frameKeys = selectedFrameKeys.map((entry) => ({
    clipId: String(entry.clipId),
    sourceTick: Number(entry.sourceTick),
  }));
  next.propertyKeys = selectedPropertyKeys.map((entry) => ({
    clipId: String(entry.clipId),
    sourceTick: Number(entry.sourceTick),
    propertyName: String(entry.propertyName),
  }));
  next.gap = null;
  next.rulerRange = null;

  const targetLocked = !clipIsEditable(state, clip);
  const editableFrameKeys = targetLocked ? [] : selectedFrameKeys.filter((entry) => {
    const candidate = (state?.clips || []).find((item) => String(item.id) === String(entry.clipId));
    return candidate && clipIsEditable(state, candidate);
  });
  const editablePropertyKeys = targetLocked ? [] : selectedPropertyKeys.filter((entry) => {
    const candidate = (state?.clips || []).find((item) => String(item.id) === String(entry.clipId));
    return candidate && clipIsEditable(state, candidate);
  });
  const deleteSelection = emptyClipTimelineSelection();
  deleteSelection.frameKeys = editableFrameKeys.map((entry) => ({
    clipId: String(entry.clipId),
    sourceTick: Number(entry.sourceTick),
  }));
  deleteSelection.propertyKeys = editablePropertyKeys.map((entry) => ({
    clipId: String(entry.clipId),
    sourceTick: Number(entry.sourceTick),
    propertyName: String(entry.propertyName),
  }));
  const deleteCount = editableFrameKeys.length + editablePropertyKeys.length;
  const specificTitle = kind === 'frame'
    ? 'Frame key'
    : `${timelinePropertyLabel(propertyName)} key`;
  return {
    kind: 'key',
    keyKind: kind,
    clipId,
    sourceTick,
    propertyName: kind === 'property' ? propertyName : null,
    selection: next,
    deleteSelection,
    deleteCount,
    deleteLabel: deleteCount > 1 ? `Delete ${deleteCount} keys` : 'Delete key',
    deleteDisabled: deleteCount === 0,
    locked: targetLocked,
    title: deleteCount > 1 ? `${deleteCount} keys` : specificTitle,
  };
}

export function planClipPropertyKeyMarkers(clip, visibleRange = null) {
  const markers = [];
  const startTick = Number(clip?.startTick);
  const inTick = Number(clip?.inTick);
  const outTick = Number(clip?.outTick);
  if (![startTick, inTick, outTick].every(Number.isFinite) || outTick <= inTick) {
    return markers;
  }
  const rangeStart = visibleRange == null ? -Infinity : Number(visibleRange.startTick);
  const rangeEnd = visibleRange == null ? Infinity : Number(visibleRange.endTick);
  if (Number.isNaN(rangeStart) || Number.isNaN(rangeEnd) || rangeEnd <= rangeStart) {
    return markers;
  }

  const propertyTracks = clip?.propertyTracks && typeof clip.propertyTracks === 'object'
    ? clip.propertyTracks
    : {};
  for (const propertyName of Object.keys(propertyTracks).sort()) {
    const keys = Array.isArray(propertyTracks[propertyName]) ? propertyTracks[propertyName] : [];
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      const sourceTick = Number(keys[keyIndex]?.tick);
      if (!Number.isFinite(sourceTick) || sourceTick < inTick || sourceTick >= outTick) continue;
      const timelineTick = startTick + sourceTick - inTick;
      if (timelineTick < rangeStart || timelineTick >= rangeEnd) continue;
      markers.push({
        clipId: String(clip.id),
        propertyName,
        keyIndex,
        sourceTick,
        timelineTick,
      });
    }
  }
  markers.sort((first, second) =>
    first.timelineTick - second.timelineTick ||
    first.propertyName.localeCompare(second.propertyName) ||
    first.sourceTick - second.sourceTick ||
    first.keyIndex - second.keyIndex);
  for (let first = 0; first < markers.length;) {
    let last = first + 1;
    while (last < markers.length && markers[last].timelineTick === markers[first].timelineTick) {
      last++;
    }
    const stackCount = last - first;
    for (let index = first; index < last; index++) {
      markers[index].stackIndex = index - first;
      markers[index].stackCount = stackCount;
    }
    first = last;
  }
  return markers;
}

export function planTimelineKeyMarkerLayout(
  frameMarkers,
  propertyMarkers,
  options = {},
) {
  const pixelsPerTick = Math.max(0.0001, Number(options.pixelsPerTick) || 1);
  const rowHeight = Math.max(1, Number(options.rowHeight) || 42);
  const hitWidth = Math.min(8, pixelsPerTick);
  const stackTop = -5;
  const stackHeight = Math.max(1, rowHeight - 13);
  const entries = [
    ...(Array.isArray(frameMarkers) ? frameMarkers : [])
      .map((marker) => ({ ...marker, kind: 'frame' })),
    ...(Array.isArray(propertyMarkers) ? propertyMarkers : [])
      .map((marker) => ({ ...marker, kind: 'property' })),
  ].filter((marker) => Number.isFinite(Number(marker.timelineTick)));
  entries.sort((first, second) =>
    Number(first.timelineTick) - Number(second.timelineTick) ||
    (first.kind === second.kind ? 0 : first.kind === 'frame' ? -1 : 1) ||
    String(first.propertyName || '').localeCompare(String(second.propertyName || '')) ||
    Number(first.sourceTick) - Number(second.sourceTick));

  // One tick column and a vertical stack keep key hit zones away from adjacent keys and trim handles.
  for (let first = 0; first < entries.length;) {
    let last = first + 1;
    while (last < entries.length &&
      Number(entries[last].timelineTick) === Number(entries[first].timelineTick)) last++;
    const slotHeight = stackHeight / (last - first);
    const hitHeight = Math.min(12, slotHeight);
    const glyphSize = Math.max(2, Math.min(6, Math.floor(Math.min(hitWidth, hitHeight) - 1)));
    for (let index = first; index < last; index++) {
      entries[index] = {
        ...entries[index],
        left: -hitWidth / 2,
        top: stackTop + (index - first) * slotHeight,
        width: hitWidth,
        height: hitHeight,
        glyphSize,
      };
    }
    first = last;
  }
  return entries;
}

export function planClipTrimHandleLayout(clipWidth, preferredHitWidth = 12) {
  const width = Math.max(0, Number(clipWidth) || 0);
  const maximum = Math.max(0, Number(preferredHitWidth) || 0);
  const hitWidth = Math.min(maximum, width / 2);
  return {
    start: { left: 0, right: hitWidth, width: hitWidth },
    end: { left: width - hitWidth, right: width, width: hitWidth },
  };
}

export function planFrameKeyClick(
  state,
  selection,
  clipId,
  sourceTick,
  modifiers = {},
  anchor = null,
) {
  const normalized = createClipTimelineSelection(selection, state);
  const clip = (state?.clips || []).find((candidate) => String(candidate.id) === String(clipId));
  const tick = Number(sourceTick);
  if (!clip?.frameKeys?.some((key) => Number(key.tick) === tick)) {
    return { selection: normalized, anchor };
  }

  const target = { clipId: String(clip.id), sourceTick: tick };
  const next = cloneClipTimelineSelection(normalized);
  next.clipIds = new Set();
  const targetSelected = normalized.frameKeys.some((key) =>
    frameKeyIdentity(key) === frameKeyIdentity(target));
  if (modifiers.preserveExisting && targetSelected &&
    !toggleModifier(modifiers) && !modifiers.shiftKey) {
    next.gap = null;
    next.rulerRange = null;
    return { selection: next, anchor: target };
  }
  if (!toggleModifier(modifiers)) next.propertyKeys = [];
  next.gap = null;
  next.rulerRange = null;
  let selected = [...normalized.frameKeys];
  if (modifiers.shiftKey && String(anchor?.clipId) === target.clipId) {
    const lower = Math.min(Number(anchor.sourceTick), tick);
    const upper = Math.max(Number(anchor.sourceTick), tick);
    const range = clip.frameKeys
      .filter((key) => Number(key.tick) >= lower && Number(key.tick) <= upper)
      .map((key) => ({ clipId: target.clipId, sourceTick: Number(key.tick) }));
    selected = toggleModifier(modifiers)
      ? [...new Map([...selected, ...range].map((key) => [frameKeyIdentity(key), key])).values()]
      : range;
  } else if (toggleModifier(modifiers)) {
    const identity = frameKeyIdentity(target);
    const existing = selected.findIndex((key) => frameKeyIdentity(key) === identity);
    if (existing >= 0) selected.splice(existing, 1);
    else selected.push(target);
  } else {
    selected = [target];
  }
  next.frameKeys = selected;
  return {
    selection: next,
    anchor: modifiers.shiftKey && anchor?.clipId === target.clipId ? anchor : target,
  };
}

export function planPropertyKeyClick(
  state,
  selection,
  clipId,
  propertyName,
  sourceTick,
  modifiers = {},
  anchor = null,
) {
  const normalized = createClipTimelineSelection(selection, state);
  const clip = (state?.clips || []).find((candidate) => String(candidate.id) === String(clipId));
  const name = String(propertyName || '').trim();
  const tick = Number(sourceTick);
  const keys = Array.isArray(clip?.propertyTracks?.[name])
    ? clip.propertyTracks[name]
    : [];
  if (!name || !keys.some((key) => Number(key.tick) === tick)) {
    return { selection: normalized, anchor };
  }

  const target = {
    clipId: String(clip.id),
    sourceTick: tick,
    propertyName: name,
  };
  const next = cloneClipTimelineSelection(normalized);
  next.clipIds = new Set();
  const targetSelected = normalized.propertyKeys.some((key) =>
    propertyKeyIdentity(key) === propertyKeyIdentity(target));
  if (modifiers.preserveExisting && targetSelected &&
    !toggleModifier(modifiers) && !modifiers.shiftKey) {
    next.gap = null;
    next.rulerRange = null;
    return { selection: next, anchor: target };
  }
  if (!toggleModifier(modifiers)) next.frameKeys = [];
  next.gap = null;
  next.rulerRange = null;
  let selected = [...normalized.propertyKeys];
  const anchoredTrack = String(anchor?.clipId) === target.clipId &&
    String(anchor?.propertyName) === target.propertyName &&
    Number.isFinite(Number(anchor?.sourceTick));
  if (modifiers.shiftKey && anchoredTrack) {
    const lower = Math.min(Number(anchor.sourceTick), tick);
    const upper = Math.max(Number(anchor.sourceTick), tick);
    const range = keys
      .filter((key) => Number(key.tick) >= lower && Number(key.tick) <= upper)
      .map((key) => ({
        clipId: target.clipId,
        sourceTick: Number(key.tick),
        propertyName: target.propertyName,
      }));
    selected = toggleModifier(modifiers)
      ? [...new Map([...selected, ...range]
        .map((key) => [propertyKeyIdentity(key), key])).values()]
      : range;
  } else if (toggleModifier(modifiers)) {
    const identity = propertyKeyIdentity(target);
    const existing = selected.findIndex((key) => propertyKeyIdentity(key) === identity);
    if (existing >= 0) selected.splice(existing, 1);
    else selected.push(target);
  } else {
    selected = [target];
  }
  next.propertyKeys = selected;
  return {
    selection: next,
    anchor: modifiers.shiftKey && anchoredTrack ? anchor : target,
  };
}

export function planGapClick(state, selection, hoveredTrackId, timelineTick, options = {}) {
  const normalized = createClipTimelineSelection(selection, state);
  const editableTracks = (state?.tracks || [])
    .filter((track) => track.kind !== 'group' && !track.locked);
  const editableIds = editableTracks.map((track) => String(track.id));
  const selectedIds = [...normalized.trackHeaderIds]
    .map(String)
    .filter((id) => editableIds.includes(id));
  const scope = resolveTimelineTrackScope({
    allTrackIds: editableIds,
    selectedTrackIds: selectedIds,
    hoveredTrackId,
  });
  if (!scope.trackIds.length) {
    return { kind: 'none', selection: normalized, gap: null, scope };
  }
  const tick = Math.max(0, Math.round(Number(timelineTick) || 0));
  const lastClipEnd = (state?.clips || []).reduce(
    (end, clip) => Math.max(end, clipEndTick(clip)),
    0,
  );
  const maximumTick = Number.isFinite(Number(options.maximumTick))
    ? Math.max(tick + 1, Math.round(Number(options.maximumTick)))
    : Math.max(tick + 1, lastClipEnd + 1);
  const gap = findCommonTrackGap(state?.clips || [], scope.trackIds, tick, { maximumTick });
  if (!gap) return { kind: 'none', selection: normalized, gap: null, scope };

  const next = clearDirectTargets(cloneClipTimelineSelection(normalized));
  next.gap = gap;
  next.trackHeaderIds = new Set(scope.trackIds);
  return { kind: 'gap', selection: next, gap, scope };
}

function projectTickForSource(clip, sourceTick) {
  return Number(clip.startTick) + Number(sourceTick) - Number(clip.inTick);
}

function tickIntersectsRange(tick, startTick, endTick) {
  return tick >= startTick && tick <= endTick;
}

function clipIntersectsRange(clip, startTick, endTick) {
  if (startTick === endTick) {
    return startTick >= Number(clip.startTick) && startTick < clipEndTick(clip);
  }
  return clipEndTick(clip) > startTick && Number(clip.startTick) < endTick;
}

function mergeMarqueeArray(current, hits, identity, mode) {
  if (mode === 'replace') return hits;
  const next = new Map(current.map((entry) => [identity(entry), entry]));
  for (const hit of hits) {
    const key = identity(hit);
    if (mode === 'toggle' && next.has(key)) next.delete(key);
    else next.set(key, hit);
  }
  return [...next.values()];
}

export function planTimelineMarquee(state, selection, options = {}) {
  const normalized = createClipTimelineSelection(selection, state);
  const firstTick = Number(options.startTick);
  const lastTick = Number(options.endTick);
  if (!Number.isFinite(firstTick) || !Number.isFinite(lastTick)) {
    return {
      kind: 'none',
      selection: normalized,
      hitCount: 0,
      trackIds: [],
      startTick: 0,
      endTick: 0,
    };
  }
  const startTick = Math.max(0, Math.min(firstTick, lastTick));
  const endTick = Math.max(0, Math.max(firstTick, lastTick));
  const tracks = new Map((state?.tracks || []).map((track) => [String(track.id), track]));
  const requestedTrackIds = ids(options.trackIds);
  const trackIds = requestedTrackIds.filter((trackId) => {
    const track = tracks.get(trackId);
    return track && track.kind !== 'group' && !track.locked;
  });
  const trackSet = new Set(trackIds);
  const hitClips = [];
  const hitFrameKeys = [];
  const hitPropertyKeys = [];
  for (const clip of orderedClips(state)) {
    if (!trackSet.has(String(clip.trackId)) || !clipIntersectsRange(clip, startTick, endTick)) {
      continue;
    }
    hitClips.push(String(clip.id));
    for (const key of clip.frameKeys || []) {
      const sourceTick = Number(key.tick);
      if (sourceTick < Number(clip.inTick) || sourceTick >= Number(clip.outTick)) continue;
      const projectTick = projectTickForSource(clip, sourceTick);
      if (tickIntersectsRange(projectTick, startTick, endTick)) {
        hitFrameKeys.push({ clipId: String(clip.id), sourceTick });
      }
    }
    for (const propertyName of Object.keys(clip.propertyTracks || {}).sort()) {
      for (const key of clip.propertyTracks[propertyName] || []) {
        const sourceTick = Number(key.tick);
        if (sourceTick < Number(clip.inTick) || sourceTick >= Number(clip.outTick)) continue;
        const projectTick = projectTickForSource(clip, sourceTick);
        if (tickIntersectsRange(projectTick, startTick, endTick)) {
          hitPropertyKeys.push({ clipId: String(clip.id), propertyName, sourceTick });
        }
      }
    }
  }

  const mode = toggleModifier(options)
    ? 'toggle'
    : options.shiftKey ? 'add' : 'replace';
  const next = mode === 'replace'
    ? emptyClipTimelineSelection()
    : cloneClipTimelineSelection(normalized);
  const clipIds = mode === 'replace' ? new Set() : new Set(next.clipIds);
  for (const clipId of hitClips) {
    if (mode === 'toggle' && clipIds.has(clipId)) clipIds.delete(clipId);
    else clipIds.add(clipId);
  }
  next.clipIds = clipIds;
  next.frameKeys = mergeMarqueeArray(
    next.frameKeys,
    hitFrameKeys,
    frameKeyIdentity,
    mode,
  );
  next.propertyKeys = mergeMarqueeArray(
    next.propertyKeys,
    hitPropertyKeys,
    propertyKeyIdentity,
    mode,
  );
  next.gap = null;
  next.rulerRange = null;
  const result = createClipTimelineSelection(next, state);
  return {
    kind: 'marquee',
    selection: result,
    hitCount: hitClips.length + hitFrameKeys.length + hitPropertyKeys.length,
    hitClipIds: hitClips,
    hitFrameKeys,
    hitPropertyKeys,
    mode,
    trackIds,
    startTick,
    endTick,
  };
}

export function timelineSelectionLayerTarget(state, selection) {
  const normalized = createClipTimelineSelection(selection, state);
  const clips = new Map((state?.clips || []).map((clip) => [String(clip.id), clip]));
  const tracks = new Map((state?.tracks || []).map((track) => [String(track.id), track]));
  const directClipIds = new Set([
    ...normalized.clipIds,
    ...normalized.frameKeys.map((key) => String(key.clipId)),
    ...normalized.propertyKeys.map((key) => String(key.clipId)),
  ]);
  const trackIds = directClipIds.size
    ? new Set([...directClipIds].map((clipId) => String(clips.get(clipId)?.trackId || '')))
    : normalized.gap || normalized.rulerRange
      ? new Set()
      : new Set([...normalized.trackHeaderIds].map(String));
  trackIds.delete('');
  if (trackIds.size !== 1) return null;
  const track = tracks.get([...trackIds][0]);
  const layerId = track?.layer?.id || track?.sourceLayerId;
  if (!layerId) return null;
  const propertyOnly = !normalized.clipIds.size && !normalized.frameKeys.length &&
    normalized.propertyKeys.length > 0;
  const maskOnly = propertyOnly && normalized.propertyKeys.every((key) =>
    key.propertyName === 'maskOpacity' || key.propertyName === 'maskPosition');
  return { layerId: String(layerId), part: maskOnly ? 'mask' : 'layer' };
}

export function planRazorClick(state, options = {}) {
  if (options.tick == null || !Number.isFinite(Number(options.tick))) {
    return { kind: 'none', tick: null, clipIds: [], options: {}, reason: 'outside' };
  }
  const tick = Math.round(Number(options.tick));
  if (tick < 0) {
    return { kind: 'none', tick, clipIds: [], options: {}, reason: 'outside' };
  }
  const tracks = new Map((state?.tracks || []).map((track) => [String(track.id), track]));
  const hoveredId = options.hoveredClipId == null ? null : String(options.hoveredClipId);
  const hoveredTrackId = options.hoveredTrackId == null ? null : String(options.hoveredTrackId);
  const hoveredClip = hoveredId == null
    ? null
    : (state?.clips || []).find((candidate) => String(candidate.id) === hoveredId) || null;
  const trackId = hoveredTrackId || (hoveredClip ? String(hoveredClip.trackId) : null);
  const track = trackId == null ? null : tracks.get(trackId);
  if (!track) return { kind: 'none', tick, clipIds: [], options: {}, reason: 'gap', trackId };
  if (track.kind === 'group') {
    return { kind: 'none', tick, clipIds: [], options: {}, reason: 'structural', trackId };
  }
  if (track.locked) {
    return { kind: 'none', tick, clipIds: [], options: {}, reason: 'locked', trackId };
  }
  const rowClips = (state?.clips || []).filter((clip) => String(clip.trackId) === trackId);
  const clip = (hoveredClip && String(hoveredClip.trackId) === trackId &&
    tick > Number(hoveredClip.startTick) && tick < clipEndTick(hoveredClip))
    ? hoveredClip
    : rowClips.find((candidate) =>
      tick > Number(candidate.startTick) && tick < clipEndTick(candidate));
  if (!clip) {
    const edge = rowClips.some((candidate) =>
      tick === Number(candidate.startTick) || tick === clipEndTick(candidate));
    return {
      kind: 'none',
      tick,
      clipIds: [],
      options: {},
      reason: edge ? 'edge' : 'gap',
      trackId,
    };
  }
  return {
    kind: 'razor-clip',
    tick,
    clipId: clip.id,
    clipIds: [clip.id],
    trackId: String(clip.trackId),
    options: {},
  };
}

function razorRowsForSegment(first, second) {
  const start = Math.floor(first.row);
  const end = Math.floor(second.row);
  const step = end < start ? -1 : 1;
  const rows = [];
  for (let row = start; ; row += step) {
    rows.push(row);
    if (row === end) break;
  }
  return rows;
}

function segmentTicksInRow(first, second, row) {
  const dx = second.tick - first.tick;
  const dy = second.row - first.row;
  let from = 0;
  let to = 1;
  if (dy === 0) {
    if (Math.floor(first.row) !== row) return [];
  } else {
    const firstBoundary = (row - first.row) / dy;
    const secondBoundary = (row + 1 - first.row) / dy;
    from = Math.max(0, Math.min(firstBoundary, secondBoundary));
    to = Math.min(1, Math.max(firstBoundary, secondBoundary));
    if (to < from) return [];
  }
  const startTick = Math.round(first.tick + dx * from);
  const endTick = Math.round(first.tick + dx * to);
  const direction = endTick < startTick ? -1 : 1;
  const ticks = [];
  for (let tick = startTick; ; tick += direction) {
    ticks.push(tick);
    if (tick === endTick) break;
  }
  return ticks;
}

export function planRazorDrag(state, points, rowTracks = []) {
  const path = (Array.isArray(points) ? points : [])
    .map((point) => ({ tick: Number(point?.tick), row: Number(point?.row) }))
    .filter((point) => Number.isFinite(point.tick) && Number.isFinite(point.row));
  if (!path.length) return { kind: 'none', cuts: [], current: null };
  const rows = rowTracks.map((row) => String(row?.trackId ?? row?.id ?? row));
  const cuts = [];
  const seen = new Set();
  const segments = path.length === 1 ? [[path[0], path[0]]] : path.slice(1)
    .map((point, index) => [path[index], point]);
  for (const [first, second] of segments) {
    for (const row of razorRowsForSegment(first, second)) {
      const trackId = rows[row];
      if (trackId == null) continue;
      for (const tick of segmentTicksInRow(first, second, row)) {
        const planned = planRazorClick(state, { tick, hoveredTrackId: trackId });
        if (planned.kind !== 'razor-clip') continue;
        const identity = `${String(planned.clipId)}\u0000${planned.tick}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        cuts.push({
          clipId: String(planned.clipId),
          trackId: String(planned.trackId),
          tick: planned.tick,
          row,
        });
      }
    }
  }
  const last = path.at(-1);
  const currentRow = Math.floor(last.row);
  const currentTrackId = rows[currentRow];
  const current = currentTrackId == null
    ? { kind: 'none', tick: Math.round(last.tick), reason: 'outside', trackId: null }
    : planRazorClick(state, { tick: Math.round(last.tick), hoveredTrackId: currentTrackId });
  return { kind: cuts.length ? 'razor-path' : 'none', cuts, current };
}

export function planTimelineDelete(selection) {
  const source = cloneClipTimelineSelection(selection || emptyClipTimelineSelection());
  const next = emptyClipTimelineSelection();
  if (source.frameKeys.length || source.propertyKeys.length) {
    next.frameKeys = source.frameKeys;
    next.propertyKeys = source.propertyKeys;
    return { kind: 'keys', selection: next };
  }
  if (source.clipIds.size) {
    next.clipIds = new Set(source.clipIds);
    return { kind: 'clips', selection: next };
  }
  if (source.gap) {
    next.gap = source.gap;
    next.trackHeaderIds = new Set(source.gap.trackIds || source.trackHeaderIds);
    return { kind: 'gap', selection: next };
  }
  return { kind: 'none', selection: next };
}

export function planTimelineDeleteKey(event, selection, options = {}) {
  const key = event?.key;
  const tagName = String(event?.target?.tagName || '').toUpperCase();
  const editing = options.editing ?? (
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName) || event?.target?.isContentEditable
  );
  if ((key !== 'Delete' && key !== 'Backspace') || event?.defaultPrevented ||
    editing || options.contextOwned === false) {
    return { handled: false, kind: 'none', selection: emptyClipTimelineSelection() };
  }
  if (options.playing) {
    return { handled: true, kind: 'none', selection: emptyClipTimelineSelection() };
  }
  return { handled: true, ...planTimelineDelete(selection) };
}

// One delta moves the selection: intersecting stationary-neighbor bounds preserves
// relative spacing, and operation order avoids transient overlap rejection.
export function planClipMove(
  state,
  selectedClipIds,
  draggedClipId,
  requestedStartTick,
  options = {},
) {
  const clips = state?.clips || [];
  const tracks = new Map((state?.tracks || []).map((track) => [String(track.id), track]));
  const dragged = clips.find((clip) => String(clip.id) === String(draggedClipId));
  if (!dragged || tracks.get(String(dragged.trackId))?.locked) return null;

  const requestedIds = new Set(ids(selectedClipIds));
  const activeIds = requestedIds.has(String(dragged.id))
    ? requestedIds
    : new Set([String(dragged.id)]);
  const moving = clips.filter((clip) => activeIds.has(String(clip.id)) &&
    !tracks.get(String(clip.trackId))?.locked);
  if (!moving.length) return null;
  const movingIds = new Set(moving.map((clip) => String(clip.id)));
  const snapped = snapTimelineTick(Number(requestedStartTick), {
    clips: options.snapClips || clips,
    playheadTick: options.playheadTick,
    pixelsPerTick: options.pixelsPerTick || 1,
    thresholdPixels: options.thresholdPixels,
    altKey: options.altKey,
    excludeClipIds: [...movingIds],
  });
  const requestedDeltaTicks = Math.round(snapped.tick - Number(dragged.startTick));
  let minimumDeltaTicks = -Infinity;
  let maximumDeltaTicks = Infinity;
  for (const clip of moving) {
    minimumDeltaTicks = Math.max(minimumDeltaTicks, -Number(clip.startTick));
    if (clip.kind === 'audio') continue;
    const endTick = clipEndTick(clip);
    for (const other of clips) {
      if (movingIds.has(String(other.id)) || other.trackId !== clip.trackId) continue;
      const otherEnd = clipEndTick(other);
      if (otherEnd <= Number(clip.startTick)) {
        minimumDeltaTicks = Math.max(
          minimumDeltaTicks,
          otherEnd - Number(clip.startTick),
        );
      }
      if (Number(other.startTick) >= endTick) {
        maximumDeltaTicks = Math.min(
          maximumDeltaTicks,
          Number(other.startTick) - endTick,
        );
      }
    }
  }
  const deltaTicks = Math.max(
    minimumDeltaTicks,
    Math.min(maximumDeltaTicks, requestedDeltaTicks),
  );
  const operations = moving.map((clip) => ({
    clipId: clip.id,
    targetStartTick: Number(clip.startTick) + deltaTicks,
  })).sort((first, second) => deltaTicks > 0
    ? second.targetStartTick - first.targetStartTick
    : first.targetStartTick - second.targetStartTick);
  return {
    clipIds: operations.map((operation) => operation.clipId),
    requestedDeltaTicks,
    minimumDeltaTicks,
    maximumDeltaTicks,
    deltaTicks,
    snapped,
    operations,
  };
}

function plannedClipsOverlap(first, second) {
  if (first?.kind === 'audio' && second?.kind === 'audio') return false;
  return String(first?.trackId) === String(second?.trackId) &&
    Number(first.startTick) < clipEndTick(second) &&
    clipEndTick(first) > Number(second.startTick);
}

export function planClipDuplicateMove(
  state,
  selectedClipIds,
  draggedClipId,
  requestedStartTick,
  options = {},
) {
  const clips = state?.clips || [];
  const tracks = new Map((state?.tracks || []).map((track) => [String(track.id), track]));
  const dragged = clips.find((clip) => String(clip.id) === String(draggedClipId));
  if (!dragged) return null;

  const requestedIds = new Set(ids(selectedClipIds));
  const activeIds = requestedIds.has(String(dragged.id))
    ? requestedIds
    : new Set([String(dragged.id)]);
  const moving = clips.filter((clip) => activeIds.has(String(clip.id)));
  if (moving.length !== activeIds.size) {
    return {
      valid: false,
      changed: false,
      reason: 'missing-clip',
      clipIds: [...activeIds],
      operations: [],
    };
  }

  const snapped = snapTimelineTick(Number(requestedStartTick), {
    clips: options.snapClips || clips,
    playheadTick: options.playheadTick,
    pixelsPerTick: options.pixelsPerTick || 1,
    thresholdPixels: options.thresholdPixels,
    altKey: options.altKey,
  });
  const requestedDeltaTicks = Math.round(snapped.tick - Number(dragged.startTick));
  const operations = moving.map((clip) => ({
    clipId: clip.id,
    trackId: clip.trackId,
    targetStartTick: Number(clip.startTick) + requestedDeltaTicks,
  }));
  const candidates = moving.map((clip, index) => ({
    ...clip,
    trackId: operations[index].trackId,
    startTick: operations[index].targetStartTick,
  }));

  let reason = null;
  for (const candidate of candidates) {
    const track = tracks.get(String(candidate.trackId));
    if (!track) reason ||= 'missing-track';
    else if (track.locked) reason ||= 'locked-track';
    else if (track.kind === 'group' ||
      ((candidate.kind === 'audio') !== (track.kind === 'audio'))) {
      reason ||= 'incompatible-track';
    }
    if (!Number.isSafeInteger(candidate.startTick) || candidate.startTick < 0) {
      reason ||= 'negative-start';
    }
  }
  if (!reason) {
    for (const candidate of candidates) {
      if (candidate.kind === 'audio') continue;
      if (clips.some((clip) => plannedClipsOverlap(candidate, clip))) {
        reason = 'overlap';
        break;
      }
    }
  }
  if (!reason) {
    for (let first = 0; first < candidates.length; first++) {
      for (let second = first + 1; second < candidates.length; second++) {
        if (plannedClipsOverlap(candidates[first], candidates[second])) {
          reason = 'overlap';
          break;
        }
      }
      if (reason) break;
    }
  }

  return {
    valid: !reason,
    changed: !reason,
    reason,
    clipIds: moving.map((clip) => clip.id),
    requestedDeltaTicks,
    deltaTicks: requestedDeltaTicks,
    snapped,
    operations,
  };
}

function clipCanExtendHeldSource(clip) {
  return clip?.kind === 'visual' || clip?.kind === 'effect';
}

// Only selected clips sharing the dragged edge participate; source limits and
// neighboring clips intersect into one shared clamp.
export function planClipTrim(
  state,
  selectedClipIds,
  draggedClipId,
  edge,
  requestedEdgeTick,
  options = {},
) {
  const clip = (state?.clips || []).find((candidate) =>
    String(candidate.id) === String(draggedClipId));
  if (!clip) return null;
  const side = edge === 'start' || edge === 'in' ? 'start'
    : edge === 'end' || edge === 'out' ? 'end' : null;
  if (!side) return null;
  const selected = new Set(ids(selectedClipIds));
  if (!selected.has(String(clip.id))) {
    selected.clear();
    selected.add(String(clip.id));
  }
  const edgeTick = side === 'start' ? Number(clip.startTick) : clipEndTick(clip);
  const snapped = snapTimelineTick(Number(requestedEdgeTick), {
    clips: options.snapClips || state?.clips || [],
    playheadTick: options.playheadTick,
    pixelsPerTick: options.pixelsPerTick || 1,
    thresholdPixels: options.thresholdPixels,
    altKey: options.altKey,
    excludeClipIds: [...selected],
  });
  const requestedDeltaTicks = Math.round(snapped.tick - edgeTick);
  const base = planSelectedClipEdgeResize(
    state,
    selected,
    side,
    edgeTick,
    requestedDeltaTicks,
  );
  if (!base) return null;

  let minimumDeltaTicks = base.minimumDeltaTicks;
  let maximumDeltaTicks = base.maximumDeltaTicks;
  const eligible = (state?.clips || []).filter((candidate) =>
    base.clipIds.some((id) => String(id) === String(candidate.id)));
  const rate = Math.max(1, Number(options.fps ?? state?.fps) || 24);
  for (const candidate of eligible) {
    if (side === 'start') {
      const earliestFrameTick = Math.min(...(candidate.frameKeys || [])
        .map((key) => Number(key.tick))
        .filter(Number.isFinite));
      minimumDeltaTicks = Math.max(
        minimumDeltaTicks,
        candidate.kind === 'audio'
          ? -Math.floor(Number(candidate.inPoint) * rate)
          : Math.max(
            -Number(candidate.inTick),
            Number.isFinite(earliestFrameTick)
              ? earliestFrameTick - Number(candidate.inTick)
              : -Number(candidate.inTick),
          ),
      );
    } else if (candidate.kind === 'audio') {
      maximumDeltaTicks = Math.min(
        maximumDeltaTicks,
        Math.ceil(Math.max(0, Number(candidate.duration) - Number(candidate.inPoint)) * rate) -
          (Number(candidate.outTick) - Number(candidate.inTick)),
      );
    } else if (!clipCanExtendHeldSource(candidate)) {
      maximumDeltaTicks = Math.min(
        maximumDeltaTicks,
        Number(candidate.sourceDuration) - Number(candidate.outTick),
      );
    }
  }
  const deltaTicks = Math.max(
    minimumDeltaTicks,
    Math.min(maximumDeltaTicks, requestedDeltaTicks),
  );
  return {
    ...base,
    requestedDeltaTicks,
    minimumDeltaTicks,
    maximumDeltaTicks,
    deltaTicks,
    targetEdgeTick: edgeTick + deltaTicks,
    snapped,
    operations: eligible.map((candidate) => ({
      clipId: candidate.id,
      edge: side,
      targetTick: (side === 'start' ? Number(candidate.startTick) : clipEndTick(candidate)) +
        deltaTicks,
    })),
  };
}

export function adaptAudioClipForTimeline(clip, fps) {
  return {
    id: `audio:${String(clip?.id)}`,
    audioClipId: clip?.id,
    trackId: `audio:${String(clip?.trackId)}`,
    startTick: Number(clip?.startTick) || 0,
    inTick: 0,
    outTick: Math.max(1, audioClipDurationTicks(clip, fps)),
    sourceDuration: Math.max(1, audioClipDurationTicks(clip, fps)),
    frameKeys: [],
    kind: 'audio',
  };
}

export function planAudioClipMove(
  clips,
  selectedClipIds,
  draggedClipId,
  requestedStartTick,
  options = {},
) {
  const dragged = (clips || []).find((clip) => String(clip.id) === String(draggedClipId));
  if (!dragged) return null;
  const selected = new Set(ids(selectedClipIds));
  const moving = selected.has(String(dragged.id))
    ? (clips || []).filter((clip) => selected.has(String(clip.id)))
    : [dragged];
  const excluded = moving.map((clip) => `audio:${String(clip.id)}`);
  const snapped = snapTimelineTick(Number(requestedStartTick), {
    clips: options.snapClips || (clips || []).map((clip) => adaptAudioClipForTimeline(clip, options.fps)),
    playheadTick: options.playheadTick,
    pixelsPerTick: options.pixelsPerTick || 1,
    thresholdPixels: options.thresholdPixels,
    altKey: options.altKey,
    excludeClipIds: excluded,
  });
  const requestedDeltaTicks = Math.round(snapped.tick - Number(dragged.startTick));
  const minimumDeltaTicks = -Math.min(...moving.map((clip) => Number(clip.startTick) || 0));
  const deltaTicks = Math.max(minimumDeltaTicks, requestedDeltaTicks);
  return {
    clipIds: moving.map((clip) => clip.id),
    requestedDeltaTicks,
    minimumDeltaTicks,
    deltaTicks,
    snapped,
    operations: moving.map((clip) => ({
      trackId: clip.trackId,
      clipId: clip.id,
      patch: { startTick: Number(clip.startTick) + deltaTicks },
    })),
  };
}

export function planAudioClipTrim(clip, edge, targetTick, fps) {
  const original = normalizeAudioClip(clip);
  const rate = Math.max(1, Number(fps) || 24);
  const side = edge === 'start' || edge === 'in' ? 'start'
    : edge === 'end' || edge === 'out' ? 'end' : null;
  if (!side) return null;
  const currentEndTick = original.startTick + audioClipDurationTicks(original, rate);
  const requestedTick = Math.round(Number(targetTick));
  let appliedTick;
  let patch;
  if (side === 'start') {
    const sourceStartTick = original.startTick - Math.floor(original.inPoint * rate);
    appliedTick = Math.max(
      0,
      sourceStartTick,
      Math.min(currentEndTick - 1, requestedTick),
    );
    patch = {
      startTick: appliedTick,
      inPoint: Math.min(
        original.outPoint,
        original.inPoint + (appliedTick - original.startTick) / rate,
      ),
    };
  } else {
    const sourceEndTick = original.startTick + Math.ceil(
      Math.max(0, original.duration - original.inPoint) * rate,
    );
    appliedTick = Math.max(original.startTick + 1, Math.min(sourceEndTick, requestedTick));
    patch = {
      outPoint: Math.min(
        original.duration,
        original.outPoint + (appliedTick - currentEndTick) / rate,
      ),
    };
  }
  return {
    edge: side,
    requestedTick,
    targetTick: appliedTick,
    patch,
    clip: normalizeAudioClip({ ...original, ...patch }),
  };
}
