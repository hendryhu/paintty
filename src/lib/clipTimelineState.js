import { derived, writable } from 'svelte/store';
import {
  addEmptyTime as addEmptyTimeValue,
  addTimelineClip,
  addTimelineTrack,
  clipSourceTickAt,
  cloneTimelineValue,
  createClipTimelineState as createCoreClipTimelineState,
  deleteTimelineSelection as deleteTimelineSelectionValue,
  duplicateTimelineClips as duplicateTimelineClipsValue,
  editClipProperty as editClipPropertyValue,
  editVisualFrame as editVisualFrameValue,
  emptyClipTimelineState,
  moveTimelineClip,
  moveTimelineKeys as moveTimelineKeysValue,
  razorSplitAtTick,
  razorSplitClip,
  removeTimelineClip,
  removeTimelineTag as removeTimelineTagValue,
  removeTimelineTrack,
  resizeSelectedClipEdges as resizeSelectedClipEdgesValue,
  rippleDeleteGap as rippleDeleteGapValue,
  setClipTimelineFps as setClipTimelineFpsValue,
  setTimelineTag as setTimelineTagValue,
  shiftTimelineClipKeys,
  trimTimelineClip,
  updateTimelineClip,
  updateTimelineTrack,
  validateClipTimelineState,
} from './clipTimeline.js';
import {
  clipTimelineDurationTicks,
  clipTimelineTickDuration,
  findClipAtProjectTick,
  lookupClipAtProjectTick,
  resolveClipTimelineAtTick,
  resolveClipTimelineLayers,
} from './clipTimelineResolver.js';
import {
  captureProjectRevision as captureGlobalProjectRevision,
  isProjectRevisionCurrent as isGlobalProjectRevisionCurrent,
} from './documentLifecycle.js';
import { newUuid } from './uuid.js';
import { clampTimelineTags } from './timelineTags.js';

const HISTORY_SNAPSHOT_KIND = 'clip-timeline-history';

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function idValue(value) {
  const id = String(value ?? '').trim();
  return id || null;
}

function iterableIds(value) {
  if (value == null) return [];
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (typeof value[Symbol.iterator] !== 'function') return [];
  return [...new Set([...value].map((entry) => String(entry)))];
}

function sameId(first, second) {
  return first != null && second != null && String(first) === String(second);
}

function timelineShapeErrors(state) {
  const errors = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return ['Timeline state must be an object.'];
  }
  if (!Array.isArray(state.tracks)) errors.push('Timeline tracks must be an array.');
  if (!Array.isArray(state.clips)) errors.push('Timeline clips must be an array.');
  return errors;
}

export class ClipTimelineStateValidationError extends Error {
  constructor(errors, operation = 'timeline state') {
    const list = Array.isArray(errors) ? errors.map(String) : [String(errors)];
    super(`Invalid ${operation}: ${list.join(' ')}`);
    this.name = 'ClipTimelineStateValidationError';
    this.operation = operation;
    this.errors = list;
  }
}

function sourceWithInjectedIds(source, makeId) {
  if (typeof makeId !== 'function') return source;
  const next = cloneTimelineValue(source || emptyClipTimelineState());
  const tracks = Array.isArray(next.tracks) ? next.tracks : [];
  const clips = [
    ...(Array.isArray(next.clips) ? next.clips : []),
    ...tracks.flatMap((track) => Array.isArray(track?.clips) ? track.clips : []),
  ];
  const reserved = new Set([
    ...tracks.map((track) => idValue(track?.id)).filter(Boolean),
    ...clips.map((clip) => idValue(clip?.id)).filter(Boolean),
    ...(Array.isArray(next.tags) ? next.tags : []).map((tag) => idValue(tag?.id)).filter(Boolean),
  ]);
  function allocate(kind) {
    const generated = new Set();
    while (generated.size < 1000) {
      const candidate = idValue(makeId(kind));
      if (!candidate) continue;
      if (!reserved.has(candidate)) {
        reserved.add(candidate);
        return candidate;
      }
      if (generated.has(candidate)) break;
      generated.add(candidate);
    }
    let suffix = 1;
    while (reserved.has(`${kind}-${suffix}`)) suffix++;
    const candidate = `${kind}-${suffix}`;
    reserved.add(candidate);
    return candidate;
  }
  for (const track of tracks) {
    if (!idValue(track.id)) track.id = allocate('track');
    for (const clip of Array.isArray(track.clips) ? track.clips : []) {
      if (!idValue(clip.id)) clip.id = allocate('clip');
      if (!idValue(clip.trackId)) clip.trackId = track.id;
    }
  }
  for (const clip of Array.isArray(next.clips) ? next.clips : []) {
    if (!idValue(clip.id)) clip.id = allocate('clip');
  }
  return next;
}

export function createCanonicalClipTimelineState(
  source = emptyClipTimelineState(),
  options = {},
) {
  const makeId = typeof options === 'function' ? options : options?.makeId;
  const state = createCoreClipTimelineState(sourceWithInjectedIds(source, makeId));
  // Duration is always derived. Retaining an adapter's cached value would create
  // a second authority as soon as a canonical edit changes the max end.
  delete state.durationTicks;
  state.tags = clampTimelineTags(state.tags, Math.max(1, clipTimelineDurationTicks(state)));
  return state;
}

export function validateCanonicalClipTimelineState(state) {
  const shapeErrors = timelineShapeErrors(state);
  if (shapeErrors.length) return shapeErrors;
  return validateClipTimelineState(state);
}

export function assertCanonicalClipTimelineState(state, operation = 'timeline state') {
  const errors = validateCanonicalClipTimelineState(state);
  if (errors.length) throw new ClipTimelineStateValidationError(errors, operation);
  return state;
}

function canonicalState(source, operation, makeId = null) {
  const shapeErrors = timelineShapeErrors(source);
  if (shapeErrors.length) throw new ClipTimelineStateValidationError(shapeErrors, operation);
  const state = createCanonicalClipTimelineState(source, { makeId });
  return assertCanonicalClipTimelineState(state, operation);
}

export function findClipTimelineTrack(state, trackOrLayerId) {
  const found = (state?.tracks || []).find((track) =>
    sameId(track.id, trackOrLayerId) ||
    sameId(track.layer?.id, trackOrLayerId));
  return found ? cloneTimelineValue(found) : null;
}

export function findClipTimelineLayer(state, trackOrLayerId) {
  const track = findClipTimelineTrack(state, trackOrLayerId);
  const layer = track?.layer;
  return layer ? cloneTimelineValue(layer) : null;
}

export function findActiveTimelineClip(state, trackOrLayerId, projectTick) {
  return findClipAtProjectTick(state, trackOrLayerId, projectTick);
}

export function lookupActiveTimelineClip(state, trackOrLayerId, projectTick) {
  return lookupClipAtProjectTick(state, trackOrLayerId, projectTick);
}

export function resolveCanonicalTimelineLayers(state, projectTick, options = {}) {
  return resolveClipTimelineLayers(state, projectTick, options);
}

export function resolveCanonicalTimelineAtTick(state, projectTick, options = {}) {
  return resolveClipTimelineAtTick(state, projectTick, options);
}

export function emptyClipTimelineSelection() {
  return {
    clipIds: new Set(),
    frameKeys: [],
    propertyKeys: [],
    trackHeaderIds: new Set(),
    gap: null,
    rulerRange: null,
  };
}

export function cloneClipTimelineSelection(selection = emptyClipTimelineSelection()) {
  return {
    clipIds: new Set(iterableIds(selection.clipIds)),
    frameKeys: cloneTimelineValue(Array.isArray(selection.frameKeys) ? selection.frameKeys : []),
    propertyKeys: cloneTimelineValue(
      Array.isArray(selection.propertyKeys) ? selection.propertyKeys : [],
    ),
    trackHeaderIds: new Set(iterableIds(selection.trackHeaderIds)),
    gap: selection.gap ? cloneTimelineValue(selection.gap) : null,
    rulerRange: selection.rulerRange ? cloneTimelineValue(selection.rulerRange) : null,
  };
}

function normalizedSelectionKey(entry, state, property = false) {
  const clipId = idValue(entry?.clipId);
  const clip = (state?.clips || []).find((candidate) => candidate.id === clipId);
  let sourceTick;
  if (entry?.sourceTick != null) sourceTick = integer(entry.sourceTick, -1);
  else if (entry?.timelineTick != null && clip) {
    sourceTick = clipSourceTickAt(clip, entry.timelineTick);
  } else sourceTick = integer(entry?.tick, -1);
  const normalized = { clipId, sourceTick: sourceTick ?? -1 };
  if (property) {
    normalized.propertyName = String(
      entry?.propertyName || entry?.track || entry?.name || '',
    ).trim();
  }
  return normalized;
}

function normalizedRange(value, includeTracks = false) {
  if (!value || typeof value !== 'object') return null;
  const range = {
    startTick: integer(value.startTick, -1),
    endTick: integer(value.endTick, -1),
  };
  if (includeTracks) range.trackIds = iterableIds(value.trackIds);
  return range;
}

function selectionInput(selection) {
  const source = selection && typeof selection === 'object' ? selection : {};
  return {
    clipIds: source.clipIds ?? source.clips ?? source.selectedClipIds,
    frameKeys: source.frameKeys ?? source.selectedFrameKeys,
    propertyKeys: source.propertyKeys ?? source.selectedPropertyKeys,
    trackHeaderIds: source.trackHeaderIds ?? source.trackIds ??
      source.trackHeaders ?? source.selectedTrackIds,
    gap: source.gap,
    rulerRange: source.rulerRange ?? source.ruler ?? source.range,
  };
}

export function createClipTimelineSelection(selection = {}, state = emptyClipTimelineState()) {
  const source = selectionInput(selection);
  const frameKeys = [];
  const seenFrames = new Set();
  for (const entry of Array.isArray(source.frameKeys) ? source.frameKeys : []) {
    const key = normalizedSelectionKey(entry, state, false);
    const identity = `${key.clipId}\u0000${key.sourceTick}`;
    if (!seenFrames.has(identity)) frameKeys.push(key);
    seenFrames.add(identity);
  }
  const propertyKeys = [];
  const seenProperties = new Set();
  for (const entry of Array.isArray(source.propertyKeys) ? source.propertyKeys : []) {
    const key = normalizedSelectionKey(entry, state, true);
    const identity = `${key.clipId}\u0000${key.propertyName}\u0000${key.sourceTick}`;
    if (!seenProperties.has(identity)) propertyKeys.push(key);
    seenProperties.add(identity);
  }
  const result = {
    clipIds: new Set(iterableIds(source.clipIds)),
    frameKeys,
    propertyKeys,
    trackHeaderIds: new Set(iterableIds(source.trackHeaderIds)),
    gap: normalizedRange(source.gap, true),
    rulerRange: normalizedRange(source.rulerRange, false),
  };
  if (result.gap && !result.gap.trackIds.length) {
    result.gap.trackIds = [...result.trackHeaderIds];
  }
  return result;
}

export function validateClipTimelineSelection(selection, state) {
  const normalized = createClipTimelineSelection(selection, state);
  const errors = [];
  const tracks = new Set((state?.tracks || []).map((track) => track.id));
  const clips = new Map((state?.clips || []).map((clip) => [clip.id, clip]));
  for (const id of normalized.clipIds) {
    if (!clips.has(id)) errors.push(`Selected clip ${id} does not exist.`);
  }
  for (const id of normalized.trackHeaderIds) {
    if (!tracks.has(id)) errors.push(`Selected track ${id} does not exist.`);
  }
  for (const key of normalized.frameKeys) {
    const clip = clips.get(key.clipId);
    if (!clip) errors.push(`Selected frame key clip ${key.clipId} does not exist.`);
    else if (!Number.isInteger(key.sourceTick) || key.sourceTick < 0 ||
      !clip.frameKeys.some((candidate) => candidate.tick === key.sourceTick)) {
      errors.push(`Selected frame key ${key.clipId}@${key.sourceTick} does not exist.`);
    }
  }
  for (const key of normalized.propertyKeys) {
    const clip = clips.get(key.clipId);
    if (!clip) errors.push(`Selected property key clip ${key.clipId} does not exist.`);
    else if (!key.propertyName || !Number.isInteger(key.sourceTick) || key.sourceTick < 0 ||
      !(clip.propertyTracks?.[key.propertyName] || [])
        .some((candidate) => candidate.tick === key.sourceTick)) {
      errors.push(
        `Selected property key ${key.clipId}:${key.propertyName}@${key.sourceTick} does not exist.`,
      );
    }
  }
  if (normalized.gap) {
    if (normalized.gap.startTick < 0 || normalized.gap.endTick <= normalized.gap.startTick) {
      errors.push('Selected gap must be a finite, non-empty tick range.');
    }
    if (!normalized.gap.trackIds.length) errors.push('Selected gap requires at least one track.');
    for (const id of normalized.gap.trackIds) {
      if (!tracks.has(id)) errors.push(`Selected gap track ${id} does not exist.`);
    }
  }
  if (normalized.rulerRange && (
    normalized.rulerRange.startTick < 0 ||
    normalized.rulerRange.endTick <= normalized.rulerRange.startTick
  )) errors.push('Selected ruler range must be a finite, non-empty tick range.');
  return errors;
}

export function assertClipTimelineSelection(selection, state) {
  const normalized = createClipTimelineSelection(selection, state);
  const errors = validateClipTimelineSelection(normalized, state);
  if (errors.length) throw new ClipTimelineStateValidationError(errors, 'timeline selection');
  return normalized;
}

function prunedSelection(selection, state) {
  const normalized = createClipTimelineSelection(selection, state);
  const tracks = new Set(state.tracks.map((track) => track.id));
  const clips = new Map(state.clips.map((clip) => [clip.id, clip]));
  normalized.clipIds = new Set([...normalized.clipIds].filter((id) => clips.has(id)));
  normalized.trackHeaderIds = new Set(
    [...normalized.trackHeaderIds].filter((id) => tracks.has(id)),
  );
  normalized.frameKeys = normalized.frameKeys.filter((key) =>
    clips.get(key.clipId)?.frameKeys.some((candidate) => candidate.tick === key.sourceTick));
  normalized.propertyKeys = normalized.propertyKeys.filter((key) =>
    clips.get(key.clipId)?.propertyTracks?.[key.propertyName]
      ?.some((candidate) => candidate.tick === key.sourceTick));
  if (normalized.gap) {
    normalized.gap.trackIds = normalized.gap.trackIds.filter((id) => tracks.has(id));
    if (!normalized.gap.trackIds.length) normalized.gap = null;
  }
  const duration = clipTimelineDurationTicks(state);
  if (normalized.rulerRange) {
    normalized.rulerRange.startTick = Math.min(
      duration,
      Math.max(0, normalized.rulerRange.startTick),
    );
    normalized.rulerRange.endTick = Math.min(
      duration,
      Math.max(0, normalized.rulerRange.endTick),
    );
    if (normalized.rulerRange.endTick <= normalized.rulerRange.startTick) {
      normalized.rulerRange = null;
    }
  }
  return normalized;
}

export function clipTimelineSelectionTrackScope(state, selection) {
  const normalized = createClipTimelineSelection(selection, state);
  const editableTrackIds = new Set((state?.tracks || [])
    .filter((track) => track.kind !== 'group' && !track.locked)
    .map((track) => track.id));
  const editable = (trackIds) => trackIds.filter((id) => editableTrackIds.has(id));
  if (normalized.gap?.trackIds.length) {
    return { kind: 'gap', trackIds: editable(normalized.gap.trackIds) };
  }
  if (normalized.trackHeaderIds.size) {
    return { kind: 'track-headers', trackIds: editable([...normalized.trackHeaderIds]) };
  }
  if (normalized.rulerRange) {
    return {
      kind: 'ruler-range',
      trackIds: (state?.tracks || [])
        .filter((track) => editableTrackIds.has(track.id))
        .map((track) => track.id),
    };
  }
  return { kind: 'none', trackIds: [] };
}

function selectionForCore(selection) {
  const normalized = cloneClipTimelineSelection(selection);
  return {
    clipIds: [...normalized.clipIds],
    frameKeys: normalized.frameKeys,
    propertyKeys: normalized.propertyKeys,
    trackIds: [...normalized.trackHeaderIds],
    gap: normalized.gap,
  };
}

function selectedClipId(selection) {
  return selection.clipIds.size === 1 ? [...selection.clipIds][0] : null;
}

function transactionResultDetails(result) {
  if (!result || typeof result !== 'object') return {};
  const details = { ...result };
  delete details.state;
  return cloneTimelineValue(details);
}

export function createCanonicalClipTimelineController(options = {}) {
  const makeId = options.makeId || options.idGenerator || ((kind) => newUuid(kind));
  const captureProjectRevision = options.captureProjectRevision || captureGlobalProjectRevision;
  const isProjectRevisionCurrent = options.isProjectRevisionCurrent ||
    isGlobalProjectRevisionCurrent;
  let projectRevision = options.projectRevision ?? captureProjectRevision();
  let currentState = canonicalState(
    options.initialState || emptyClipTimelineState(),
    'initial clip timeline',
    makeId,
  );
  const effectiveDurationTicks = () => Math.max(1, clipTimelineDurationTicks(currentState));
  let currentSelection = options.initialSelection
    ? assertClipTimelineSelection(options.initialSelection, currentState)
    : emptyClipTimelineSelection();
  let currentPlayhead = Math.max(
    0,
    Math.min(
      effectiveDurationTicks() - 1,
      integer(options.playheadTick),
    ),
  );
  let currentMutationRevision = Math.max(0, integer(options.mutationRevision));

  const statePublisher = writable(cloneTimelineValue(currentState));
  const playheadPublisher = writable(currentPlayhead);
  const durationPublisher = writable(effectiveDurationTicks());
  const selectionPublisher = writable(cloneClipTimelineSelection(currentSelection));
  const mutationRevisionPublisher = writable(currentMutationRevision);

  function publicView() {
    const state = cloneTimelineValue(currentState);
    return {
      ...state,
      state,
      timeline: state,
      playheadTick: currentPlayhead,
      durationTicks: effectiveDurationTicks(),
      selection: cloneClipTimelineSelection(currentSelection),
      mutationRevision: currentMutationRevision,
      revision: currentMutationRevision,
      projectRevision,
    };
  }

  const viewPublisher = writable(publicView());

  function publishState() {
    statePublisher.set(cloneTimelineValue(currentState));
    playheadPublisher.set(currentPlayhead);
    durationPublisher.set(effectiveDurationTicks());
    selectionPublisher.set(cloneClipTimelineSelection(currentSelection));
    mutationRevisionPublisher.set(currentMutationRevision);
    viewPublisher.set(publicView());
  }

  function publishContext() {
    playheadPublisher.set(currentPlayhead);
    selectionPublisher.set(cloneClipTimelineSelection(currentSelection));
    viewPublisher.set(publicView());
  }

  function decoratedResult(result, operation, previousRevision = currentMutationRevision) {
    return {
      ...transactionResultDetails(result),
      operation,
      state: cloneTimelineValue(currentState),
      selection: cloneClipTimelineSelection(currentSelection),
      playheadTick: currentPlayhead,
      durationTicks: effectiveDurationTicks(),
      previousMutationRevision: previousRevision,
      mutationRevision: currentMutationRevision,
      revision: currentMutationRevision,
      projectRevision,
    };
  }

  function staleResult(operation, reason) {
    return decoratedResult({ changed: false, reason }, operation);
  }

  function revisionFailure(transactionOptions = {}) {
    let current = false;
    try {
      current = isProjectRevisionCurrent(projectRevision);
    } catch {
      current = false;
    }
    if (!current) return 'stale-project';
    const guard = transactionOptions?.guard;
    const expectedProject = transactionOptions?.projectRevision ?? guard?.projectRevision;
    if (expectedProject != null && expectedProject !== projectRevision) return 'stale-project';
    const expectedMutation = transactionOptions?.expectedMutationRevision ??
      guard?.mutationRevision;
    if (expectedMutation != null && expectedMutation !== currentMutationRevision) {
      return 'stale-mutation';
    }
    return null;
  }

  function commitResult(result, operation, commitOptions = {}) {
    if (!result?.changed) {
      let contextChanged = false;
      if (commitOptions.clearSelection && (
        currentSelection.clipIds.size || currentSelection.frameKeys.length ||
        currentSelection.propertyKeys.length || currentSelection.trackHeaderIds.size ||
        currentSelection.gap || currentSelection.rulerRange
      )) {
        currentSelection = emptyClipTimelineSelection();
        contextChanged = true;
      }
      if (commitOptions.clearRanges && (
        currentSelection.gap || currentSelection.rulerRange
      )) {
        currentSelection.gap = null;
        currentSelection.rulerRange = null;
        contextChanged = true;
      }
      if (contextChanged) publishContext();
      return decoratedResult(result, operation);
    }
    const next = canonicalState(result.state, `${operation} result`, makeId);
    const previousRevision = currentMutationRevision;
    currentState = next;
    currentPlayhead = Math.max(
      0,
      Math.min(
        effectiveDurationTicks() - 1,
        commitOptions.playheadTick == null
          ? currentPlayhead
          : integer(commitOptions.playheadTick),
      ),
    );
    currentSelection = commitOptions.selection == null
      ? prunedSelection(currentSelection, currentState)
      : assertClipTimelineSelection(commitOptions.selection, currentState);
    if (commitOptions.clearSelection) currentSelection = emptyClipTimelineSelection();
    if (commitOptions.clearRanges) {
      currentSelection.gap = null;
      currentSelection.rulerRange = null;
    }
    if (commitOptions.projectRevision != null) {
      projectRevision = commitOptions.projectRevision;
    }
    currentMutationRevision++;
    publishState();
    return decoratedResult(result, operation, previousRevision);
  }

  function transact(operation, mutator, transactionOptions = {}, commitOptions = {}) {
    if (typeof operation === 'function') {
      commitOptions = transactionOptions || {};
      transactionOptions = mutator || {};
      mutator = operation;
      operation = 'transaction';
    }
    if (typeof mutator !== 'function') throw new TypeError('Timeline transaction requires a mutator.');
    const failure = revisionFailure(transactionOptions);
    if (failure) return staleResult(operation, failure);
    const draft = cloneTimelineValue(currentState);
    const output = mutator(draft, {
      makeId,
      playheadTick: currentPlayhead,
      durationTicks: effectiveDurationTicks(),
      selection: cloneClipTimelineSelection(currentSelection),
      projectRevision,
      mutationRevision: currentMutationRevision,
    });
    if (output && typeof output.then === 'function') {
      throw new TypeError('Timeline transactions must be synchronous.');
    }
    let result;
    if (output === false) result = { state: currentState, changed: false, reason: 'unchanged' };
    else if (output && typeof output === 'object' && 'state' in output && 'changed' in output) {
      result = output;
    } else if (output && typeof output === 'object' &&
      Array.isArray(output.tracks) && Array.isArray(output.clips)) {
      result = { state: output, changed: true };
    } else if (output === undefined) result = { state: draft, changed: true };
    else throw new TypeError('Timeline transaction must return state or an operation result.');
    return commitResult(result, operation, commitOptions);
  }

  function noChange(operation, reason, details = {}) {
    return decoratedResult({ changed: false, reason, ...details }, operation);
  }

  function replaceState(value, replaceOptions = {}) {
    return transact(
      replaceOptions.operation || 'replace-state',
      () => ({ state: value, changed: true }),
      replaceOptions,
      replaceOptions,
    );
  }

  const timeline = {
    subscribe: statePublisher.subscribe,
    set(value) {
      return replaceState(value);
    },
    update(updater) {
      if (typeof updater !== 'function') throw new TypeError('Timeline updater must be a function.');
      const value = updater(cloneTimelineValue(currentState));
      if (value === undefined) throw new TypeError('Timeline updater must return state.');
      return replaceState(value);
    },
  };

  const playheadTick = {
    subscribe: playheadPublisher.subscribe,
    set(value) {
      if (revisionFailure()) return false;
      const number = Number(value);
      if (!Number.isFinite(number)) return false;
      const next = Math.max(
        0,
        Math.min(effectiveDurationTicks() - 1, Math.round(number)),
      );
      const changed = next !== currentPlayhead;
      currentPlayhead = next;
      if (changed) publishContext();
      return changed;
    },
    update(updater) {
      if (typeof updater !== 'function') throw new TypeError('Playhead updater must be a function.');
      return playheadTick.set(updater(currentPlayhead));
    },
  };

  const selection = {
    subscribe: selectionPublisher.subscribe,
    set(value) {
      if (revisionFailure()) return false;
      currentSelection = assertClipTimelineSelection(value, currentState);
      publishContext();
      return cloneClipTimelineSelection(currentSelection);
    },
    update(updater) {
      if (typeof updater !== 'function') throw new TypeError('Selection updater must be a function.');
      return selection.set(updater(cloneClipTimelineSelection(currentSelection)));
    },
  };

  const durationTicks = { subscribe: durationPublisher.subscribe };
  const mutationRevision = { subscribe: mutationRevisionPublisher.subscribe };

  function seekTick(value) {
    return playheadTick.set(value);
  }

  function clearSelection() {
    return selection.set(emptyClipTimelineSelection());
  }

  function getState() {
    return cloneTimelineValue(currentState);
  }

  function getSelection() {
    return cloneClipTimelineSelection(currentSelection);
  }

  function captureRevisionGuard() {
    return Object.freeze({ projectRevision, mutationRevision: currentMutationRevision });
  }

  function isRevisionGuardCurrent(guard, { mutation = true } = {}) {
    if (!guard || guard.projectRevision !== projectRevision) return false;
    if (!isProjectRevisionCurrent(guard.projectRevision)) return false;
    return !mutation || guard.mutationRevision === currentMutationRevision;
  }

  function captureState() {
    const state = cloneTimelineValue(currentState);
    return {
      kind: HISTORY_SNAPSHOT_KIND,
      state,
      timeline: state,
      playheadTick: currentPlayhead,
      selection: cloneClipTimelineSelection(currentSelection),
      projectRevision,
      mutationRevision: currentMutationRevision,
    };
  }

  function restoreState(snapshot, restoreOptions = {}) {
    const source = Array.isArray(snapshot?.state?.tracks)
      ? snapshot.state
      : Array.isArray(snapshot?.timeline?.tracks)
        ? snapshot.timeline
        : snapshot;
    const expectedProject = restoreOptions.projectRevision ?? snapshot?.projectRevision ??
      projectRevision;
    if (expectedProject !== projectRevision || !isProjectRevisionCurrent(projectRevision)) {
      return staleResult('restore', 'stale-project');
    }
    return transact(
      'restore',
      () => ({ state: source, changed: true }),
      restoreOptions,
      {
        playheadTick: restoreOptions.playheadTick ?? snapshot?.playheadTick ?? currentPlayhead,
        selection: restoreOptions.selection ?? snapshot?.selection ?? emptyClipTimelineSelection(),
      },
    );
  }

  function resetState(resetOptions = {}) {
    const candidateProject = resetOptions.projectRevision ?? projectRevision;
    if (candidateProject !== projectRevision) {
      if (!isProjectRevisionCurrent(candidateProject)) return staleResult('reset', 'stale-project');
      projectRevision = candidateProject;
    }
    return transact(
      'reset',
      () => ({ state: emptyClipTimelineState(), changed: true }),
      resetOptions,
      { playheadTick: 0, selection: emptyClipTimelineSelection() },
    );
  }

  function initializeState(value, initializeOptions = {}) {
    const candidateProject = initializeOptions.projectRevision ?? captureProjectRevision();
    if (!isProjectRevisionCurrent(candidateProject)) {
      return staleResult('initialize', 'stale-project');
    }
    const next = canonicalState(value, 'initialized clip timeline', makeId);
    const previousRevision = currentMutationRevision;
    currentState = next;
    projectRevision = candidateProject;
    currentPlayhead = Math.max(
      0,
      Math.min(
        effectiveDurationTicks() - 1,
        integer(initializeOptions.playheadTick),
      ),
    );
    currentSelection = initializeOptions.selection
      ? assertClipTimelineSelection(initializeOptions.selection, next)
      : emptyClipTimelineSelection();
    currentMutationRevision++;
    publishState();
    return decoratedResult({ changed: true }, 'initialize', previousRevision);
  }

  function addTrack(definition = {}, operationOptions = {}) {
    return transact(
      'add-track',
      (state) => addTimelineTrack(state, definition, { makeId }),
      operationOptions,
    );
  }

  function updateTrack(trackId, patch = {}, operationOptions = {}) {
    return transact(
      'update-track',
      (state) => updateTimelineTrack(state, trackId, patch),
      operationOptions,
    );
  }

  function removeTrack(trackId, operationOptions = {}) {
    return transact(
      'remove-track',
      (state) => removeTimelineTrack(state, trackId),
      operationOptions,
    );
  }

  function addClip(definition = {}, operationOptions = {}) {
    return transact(
      'add-clip',
      (state) => addTimelineClip(state, definition, { makeId }),
      operationOptions,
    );
  }

  function addVisualClip(trackId, definition = {}, operationOptions = {}) {
    return addClip({ ...definition, trackId, kind: 'visual' }, operationOptions);
  }

  function removeClip(clipId, operationOptions = {}) {
    return transact(
      'remove-clip',
      (state) => removeTimelineClip(state, clipId),
      operationOptions,
    );
  }

  function updateClip(clipId, patch = {}, operationOptions = {}) {
    return transact(
      'update-clip',
      (state) => updateTimelineClip(state, clipId, patch),
      operationOptions,
    );
  }

  function setTag(definition = {}, operationOptions = {}) {
    return transact(
      'set-tag',
      (state) => setTimelineTagValue(state, definition, { ...operationOptions, makeId }),
      operationOptions,
    );
  }

  function setLoopStart(tick, operationOptions = {}) {
    return setTag({ tick, type: 'loop-start' }, operationOptions);
  }

  function setLoopEnd(tick, operationOptions = {}) {
    return setTag({ tick, type: 'loop-end' }, operationOptions);
  }

  function addCustomTag(tick, value, operationOptions = {}) {
    return setTag({ tick, type: 'custom', value }, operationOptions);
  }

  function updateCustomTag(tagId, patch = {}, operationOptions = {}) {
    const current = currentState.tags.find((tag) => tag.id === tagId && tag.type === 'custom');
    if (!current) return noChange('set-tag', 'missing-tag');
    return setTag({ ...current, ...patch, id: current.id, type: 'custom' }, operationOptions);
  }

  function removeTag(tagId, operationOptions = {}) {
    return transact(
      'remove-tag',
      (state) => removeTimelineTagValue(state, tagId),
      operationOptions,
    );
  }

  function setFps(value, operationOptions = {}) {
    return transact(
      'set-fps',
      (state) => setClipTimelineFpsValue(state, value),
      operationOptions,
    );
  }

  function editVisualFrame(trackId, tick, edit, editOptions = {}) {
    return transact(
      'edit-visual-frame',
      (state) => editVisualFrameValue(state, trackId, tick, edit, {
        ...editOptions,
        makeId,
      }),
      editOptions,
    );
  }

  function editProperty(clipId, propertyName, tick, edit, editOptions = {}) {
    return transact(
      'edit-property',
      (state) => editClipPropertyValue(
        state,
        clipId,
        propertyName,
        tick,
        edit,
        editOptions,
      ),
      editOptions,
    );
  }

  function move(clipId, targetStartTick, moveOptions = {}) {
    const target = clipId || selectedClipId(currentSelection);
    if (!target) return noChange('move', 'missing-clip-selection');
    return transact(
      'move',
      (state) => moveTimelineClip(state, target, targetStartTick, moveOptions),
      moveOptions,
    );
  }

  function moveMany(operations, moveOptions = {}) {
    const edits = Array.isArray(operations) ? operations : [];
    if (!edits.length) return noChange('move-many', 'missing-operations');
    return transact('move-many', (state) => {
      let next = state;
      const movedClipIds = [];
      for (const edit of edits) {
        const result = moveTimelineClip(
          next,
          edit?.clipId,
          edit?.targetStartTick,
          edit?.trackId == null ? moveOptions : { ...moveOptions, trackId: edit.trackId },
        );
        if (!result.changed) continue;
        next = result.state;
        movedClipIds.push(edit.clipId);
      }
      return movedClipIds.length
        ? { state: next, changed: true, movedClipIds }
        : { state: next, changed: false, reason: 'unchanged', movedClipIds };
    }, moveOptions);
  }

  function duplicateClips(operations, duplicateOptions = {}) {
    const commitOptions = {};
    return transact('duplicate-clips', (state) => {
      const result = duplicateTimelineClipsValue(state, operations, {
        ...duplicateOptions,
        makeId,
      });
      if (result.changed) {
        commitOptions.selection = {
          ...emptyClipTimelineSelection(),
          clipIds: new Set(result.duplicatedClipIds),
        };
      }
      return result;
    }, duplicateOptions, commitOptions);
  }

  function moveKeys(selectionValue = currentSelection, deltaTicks = 0, moveOptions = {}) {
    const target = assertClipTimelineSelection(selectionValue, currentState);
    const commitOptions = {};
    return transact('move-keys', (state) => {
      const result = moveTimelineKeysValue(state, target, deltaTicks);
      if (result.changed) commitOptions.selection = result.selection;
      return result;
    }, moveOptions, commitOptions);
  }

  function trim(clipId, edge, targetTick, trimOptions = {}) {
    const target = clipId || selectedClipId(currentSelection);
    if (!target) return noChange('trim', 'missing-clip-selection');
    return transact(
      'trim',
      (state) => trimTimelineClip(state, target, edge, targetTick),
      trimOptions,
    );
  }

  function trimMany(operations, trimOptions = {}) {
    const edits = Array.isArray(operations) ? operations : [];
    if (!edits.length) return noChange('trim-many', 'missing-operations');
    return transact('trim-many', (state) => {
      let next = state;
      const trimmedClipIds = [];
      for (const edit of edits) {
        const result = trimTimelineClip(next, edit?.clipId, edit?.edge, edit?.targetTick);
        if (!result.changed) continue;
        next = result.state;
        trimmedClipIds.push(edit.clipId);
      }
      return trimmedClipIds.length
        ? { state: next, changed: true, trimmedClipIds }
        : { state: next, changed: false, reason: 'unchanged', trimmedClipIds };
    }, trimOptions);
  }

  function razorClip(clipId, tick, razorOptions = {}) {
    return transact(
      'razor',
      (state) => razorSplitClip(state, clipId, tick, { ...razorOptions, makeId }),
      razorOptions,
    );
  }

  function razorAtTick(tick, razorOptions = {}) {
    return transact(
      'razor',
      (state) => razorSplitAtTick(state, tick, { ...razorOptions, makeId }),
      razorOptions,
    );
  }

  function razorPath(cuts, razorOptions = {}) {
    const requested = Array.isArray(cuts) ? cuts : [];
    const grouped = new Map();
    for (const cut of requested) {
      const clipId = idValue(cut?.clipId);
      const tick = integer(cut?.tick, -1);
      if (!clipId || tick < 0) continue;
      const ticks = grouped.get(clipId) || new Set();
      ticks.add(tick);
      grouped.set(clipId, ticks);
    }
    if (!grouped.size) return noChange('razor-path', 'missing-cuts', { splits: [] });
    return transact('razor-path', (state) => {
      let next = state;
      const splits = [];
      for (const [clipId, ticks] of grouped) {
        // Split highest ticks first so lower cuts keep addressing the original clip ID.
        for (const tick of [...ticks].sort((first, second) => second - first)) {
          const result = razorSplitClip(next, clipId, tick, {
            ...razorOptions,
            rightClipId: null,
            makeId,
          });
          if (!result.changed) continue;
          next = result.state;
          splits.push({
            originalId: clipId,
            leftId: result.left.id,
            rightId: result.right.id,
            sourceTick: result.sourceTick,
            tick,
          });
        }
      }
      return splits.length
        ? { state: next, changed: true, splits }
        : { state: next, changed: false, reason: 'no-crossing-clips', splits };
    }, razorOptions);
  }

  function razor(first = currentPlayhead, second = {}, third = {}) {
    if ((typeof first === 'string' || typeof first === 'number') &&
      Number.isFinite(Number(second)) && typeof second !== 'object') {
      return razorClip(String(first), Number(second), third);
    }
    const tick = Number.isFinite(Number(first)) ? Number(first) : currentPlayhead;
    const razorOptions = second && typeof second === 'object' ? second : {};
    const ids = iterableIds(razorOptions.clipIds || currentSelection.clipIds);
    if (razorOptions.clipId) return razorClip(razorOptions.clipId, tick, razorOptions);
    if (ids.length === 1) return razorClip(ids[0], tick, razorOptions);
    if (ids.length > 1) {
      return transact('razor', (state) => {
        let next = state;
        let changed = false;
        const splits = [];
        for (const id of ids) {
          const result = razorSplitClip(next, id, tick, { ...razorOptions, makeId });
          if (!result.changed) continue;
          next = result.state;
          changed = true;
          splits.push({
            originalId: id,
            leftId: result.left.id,
            rightId: result.right.id,
            sourceTick: result.sourceTick,
          });
        }
        return changed
          ? { state: next, changed: true, splits }
          : { state: next, changed: false, reason: 'no-crossing-clips', splits };
      }, razorOptions);
    }
    if (razorOptions.trackIds != null) return razorAtTick(tick, razorOptions);
    const scope = clipTimelineSelectionTrackScope(currentState, currentSelection);
    return razorAtTick(tick, {
      ...razorOptions,
      ...(scope.trackIds.length ? { trackIds: scope.trackIds, allUnlocked: true } : {}),
    });
  }

  function deleteSelection(selectionValue = currentSelection, deleteOptions = {}) {
    const target = assertClipTimelineSelection(selectionValue, currentState);
    return transact(
      'delete',
      (state) => deleteTimelineSelectionValue(state, selectionForCore(target), deleteOptions),
      deleteOptions,
      { clearSelection: true },
    );
  }

  function rippleDeleteGap(trackIds, startTick, endTick, rippleOptions = {}) {
    return transact(
      'ripple',
      (state) => rippleDeleteGapValue(
        state,
        trackIds,
        startTick,
        endTick,
        rippleOptions,
      ),
      rippleOptions,
      { clearRanges: true },
    );
  }

  function ripple(first = {}, startTick, endTick, trailingOptions = {}) {
    if (typeof first === 'string' || Array.isArray(first) || first instanceof Set) {
      return rippleDeleteGap(first, startTick, endTick, trailingOptions);
    }
    const rippleOptions = first && typeof first === 'object' ? first : {};
    const range = rippleOptions.range || currentSelection.gap || currentSelection.rulerRange;
    if (!range) return noChange('ripple', 'missing-ripple-range', { shiftedClipIds: [] });
    const scope = rippleOptions.trackIds
      ? { trackIds: iterableIds(rippleOptions.trackIds) }
      : clipTimelineSelectionTrackScope(currentState, currentSelection);
    if (!scope.trackIds.length) {
      return noChange('ripple', 'missing-tracks', { shiftedClipIds: [] });
    }
    return rippleDeleteGap(
      scope.trackIds,
      range.startTick,
      range.endTick,
      rippleOptions,
    );
  }

  function addEmpty(tick, ticks, addOptions = {}) {
    return transact(
      'add-empty',
      (state) => addEmptyTimeValue(state, tick, ticks, { ...addOptions, makeId }),
      addOptions,
      { clearRanges: true },
    );
  }

  function shiftClipKeys(clipId, delta, from = 0, shiftOptions = {}) {
    return transact(
      'shift-clip-keys',
      (state) => shiftTimelineClipKeys(state, clipId, delta, from),
      shiftOptions,
    );
  }

  function resizeSelectedClipEdges(clipIds, edge, edgeTick, delta, resizeOptions = {}) {
    const ids = clipIds == null ? currentSelection.clipIds : clipIds;
    return transact(
      'resize-selected-clip-edges',
      (state) => resizeSelectedClipEdgesValue(state, ids, edge, edgeTick, delta),
      resizeOptions,
    );
  }

  function findTrack(identifier) {
    return findClipTimelineTrack(currentState, identifier);
  }

  function findLayer(identifier) {
    return findClipTimelineLayer(currentState, identifier);
  }

  function findActiveClip(identifier, tick = currentPlayhead) {
    return findActiveTimelineClip(currentState, identifier, tick);
  }

  function lookupActiveClip(identifier, tick = currentPlayhead) {
    return lookupActiveTimelineClip(currentState, identifier, tick);
  }

  function resolveLayersAtTick(tick = currentPlayhead, resolverOptions = {}) {
    const projectTick = integer(tick, -1);
    if (projectTick < 0 || projectTick >= effectiveDurationTicks() ||
      projectTick >= clipTimelineDurationTicks(currentState)) return [];
    return resolveCanonicalTimelineLayers(currentState, projectTick, resolverOptions);
  }

  function resolveAtTick(tick = currentPlayhead, resolverOptions = {}) {
    const projectTick = integer(tick, -1);
    if (projectTick < 0 || projectTick >= effectiveDurationTicks()) {
      throw new RangeError('Project tick is outside the clip timeline.');
    }
    if (projectTick < clipTimelineDurationTicks(currentState)) {
      return resolveCanonicalTimelineAtTick(currentState, projectTick, resolverOptions);
    }
    const tickDuration = clipTimelineTickDuration(currentState);
    return {
      id: projectTick,
      index: projectTick,
      tick: projectTick,
      duration: tickDuration,
      tickDuration,
      hold: 1,
      layers: [],
    };
  }

  return {
    subscribe: viewPublisher.subscribe,
    subscribeState: statePublisher.subscribe,
    timeline,
    state: timeline,
    playheadTick,
    durationTicks,
    selection,
    mutationRevision,
    getState,
    getSelection,
    getPlayheadTick: () => currentPlayhead,
    getDurationTicks: effectiveDurationTicks,
    getMutationRevision: () => currentMutationRevision,
    getProjectRevision: () => projectRevision,
    seekTick,
    setSelection: selection.set,
    clearSelection,
    captureRevisionGuard,
    isRevisionGuardCurrent,
    capture: captureState,
    captureState,
    restore: restoreState,
    restoreState,
    reset: resetState,
    resetState,
    initialize: initializeState,
    initializeState,
    transact,
    addTrack,
    updateTrack,
    removeTrack,
    addClip,
    addVisualClip,
    removeClip,
    updateClip,
    setTag,
    setLoopStart,
    setLoopEnd,
    addCustomTag,
    updateCustomTag,
    removeTag,
    setFps,
    editVisualFrame,
    editProperty,
    editClipProperty: editProperty,
    move,
    moveClip: move,
    moveMany,
    moveClips: moveMany,
    duplicate: duplicateClips,
    duplicateClips,
    moveKeys,
    moveTimelineKeys: moveKeys,
    trim,
    trimClip: trim,
    trimMany,
    trimClips: trimMany,
    razor,
    razorClip,
    razorAtTick,
    razorPath,
    delete: deleteSelection,
    deleteSelection,
    ripple,
    rippleDeleteGap,
    addEmpty,
    addEmptyTime: addEmpty,
    shiftClipKeys,
    resizeSelectedClipEdges,
    findTrack,
    findLayer,
    findActiveClip,
    lookupActiveClip,
    resolveLayersAtTick,
    resolveAtTick,
  };
}

export const createClipTimelineStateController = createCanonicalClipTimelineController;
export const createClipTimelineStore = createCanonicalClipTimelineController;

export const canonicalClipTimelineController = createCanonicalClipTimelineController();
const defaultController = canonicalClipTimelineController;

export const canonicalClipTimeline = defaultController.timeline;
export const clipTimelineState = canonicalClipTimeline;
export const clipTimelineSelection = defaultController.selection;
export const playheadTick = defaultController.playheadTick;
export const durationTicks = defaultController.durationTicks;
export const clipTimelineMutationRevision = defaultController.mutationRevision;
export const timelineMutationRevision = clipTimelineMutationRevision;
export const timelineTags = derived(canonicalClipTimeline, (state) =>
  (state.tags || []).map((tag) => ({ ...tag })));

export const subscribeClipTimeline = (...args) => defaultController.subscribe(...args);
export const getClipTimelineState = () => defaultController.getState();
export const getClipTimelineSelection = () => defaultController.getSelection();
export const seekClipTimelineTick = (...args) => defaultController.seekTick(...args);
export const setClipTimelineSelection = (...args) => defaultController.setSelection(...args);
export const clearClipTimelineSelection = (...args) => defaultController.clearSelection(...args);
export const captureClipTimelineState = (...args) => defaultController.captureState(...args);
export const captureClipTimelineRevisionGuard = (...args) =>
  defaultController.captureRevisionGuard(...args);
export const isClipTimelineRevisionGuardCurrent = (...args) =>
  defaultController.isRevisionGuardCurrent(...args);
export const restoreClipTimelineState = (...args) => defaultController.restoreState(...args);
export const resetClipTimelineState = (...args) => defaultController.resetState(...args);
export const initializeClipTimelineState = (...args) => defaultController.initializeState(...args);
export const transactClipTimeline = (...args) => defaultController.transact(...args);
export const editVisualFrame = (...args) => defaultController.editVisualFrame(...args);
export const editProperty = (...args) => defaultController.editProperty(...args);
export const updateClip = (...args) => defaultController.updateClip(...args);
export const setTimelineTag = (...args) => defaultController.setTag(...args);
export const setLoopStartTag = (...args) => defaultController.setLoopStart(...args);
export const setLoopEndTag = (...args) => defaultController.setLoopEnd(...args);
export const addCustomTimelineTag = (...args) => defaultController.addCustomTag(...args);
export const updateCustomTimelineTag = (...args) => defaultController.updateCustomTag(...args);
export const removeTimelineTag = (...args) => defaultController.removeTag(...args);
export const setClipTimelineFps = (...args) => defaultController.setFps(...args);
export const moveClip = (...args) => defaultController.moveClip(...args);
export const moveClips = (...args) => defaultController.moveMany(...args);
export const duplicateClips = (...args) => defaultController.duplicateClips(...args);
export const moveTimelineKeys = (...args) => defaultController.moveKeys(...args);
export const trimClip = (...args) => defaultController.trimClip(...args);
export const trimClips = (...args) => defaultController.trimMany(...args);
export const razor = (...args) => defaultController.razor(...args);
export const razorPath = (...args) => defaultController.razorPath(...args);
export const deleteSelection = (...args) => defaultController.deleteSelection(...args);
export const ripple = (...args) => defaultController.ripple(...args);
export const addEmpty = (...args) => defaultController.addEmpty(...args);
