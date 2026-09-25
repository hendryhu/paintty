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
import type {
  ClipTimelineSelection,
  ClipTimelineState,
  ClipTimelineStateDefinition,
  TimelineClip,
  TimelineFrameSelectionKey,
  TimelineGapSelection,
  TimelineIdFactory,
  TimelineIdSource,
  TimelinePropertySelectionKey,
  TimelineTag,
  TimelineTickRange,
  TimelineTrack,
  TimelineTrackDefinition,
  TimelineClipDefinition,
} from './types/timeline-models.js';

const HISTORY_SNAPSHOT_KIND = 'clip-timeline-history';

interface SelectionInput {
  clipIds?: TimelineIdSource;
  clips?: TimelineIdSource;
  selectedClipIds?: TimelineIdSource;
  frameKeys?: unknown;
  selectedFrameKeys?: unknown;
  propertyKeys?: unknown;
  selectedPropertyKeys?: unknown;
  trackHeaderIds?: TimelineIdSource;
  trackIds?: TimelineIdSource;
  trackHeaders?: TimelineIdSource;
  selectedTrackIds?: TimelineIdSource;
  gap?: unknown;
  rulerRange?: unknown;
  ruler?: unknown;
  range?: unknown;
}

interface CanonicalControllerOptions {
  makeId?: TimelineIdFactory;
  idGenerator?: TimelineIdFactory;
  captureProjectRevision?: () => unknown;
  isProjectRevisionCurrent?: (revision: unknown) => boolean;
  projectRevision?: unknown;
  initialState?: ClipTimelineStateDefinition;
  initialSelection?: SelectionInput | ClipTimelineSelection;
  playheadTick?: unknown;
  mutationRevision?: unknown;
}

interface TransactionOptions {
  guard?: { projectRevision?: unknown; mutationRevision?: unknown };
  projectRevision?: unknown;
  expectedMutationRevision?: unknown;
  operation?: string;
  playheadTick?: unknown;
  selection?: SelectionInput | ClipTimelineSelection;
  clipIds?: TimelineIdSource;
  clipId?: string;
  trackIds?: TimelineIdSource;
  range?: TimelineTickRange;
  allUnlocked?: boolean;
  [field: string]: unknown;
}

interface CoreOperationResult {
  state: ClipTimelineState;
  changed: boolean;
  reason?: string;
  [field: string]: unknown;
}

interface ControllerTransactionContext {
  makeId: TimelineIdFactory;
  playheadTick: number;
  durationTicks: number;
  selection: ClipTimelineSelection;
  projectRevision: unknown;
  mutationRevision: number;
}

interface CommitOptions extends TransactionOptions {
  clearSelection?: boolean;
  clearRanges?: boolean;
}

interface ControllerResult extends Record<string, unknown> {
  changed: boolean;
  reason?: string;
  operation: string;
  state: ClipTimelineState;
  selection: ClipTimelineSelection;
  playheadTick: number;
  durationTicks: number;
  previousMutationRevision: number;
  mutationRevision: number;
  revision: number;
  projectRevision: unknown;
}

interface ClipMoveOperation {
  clipId?: unknown;
  targetStartTick?: unknown;
  trackId?: unknown;
}

interface ClipTrimOperation {
  clipId?: unknown;
  edge?: unknown;
  targetTick?: unknown;
}

interface RazorCut {
  clipId?: unknown;
  tick?: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isClipTimelineState(value: unknown): value is ClipTimelineState {
  if (!record(value) || !Array.isArray(value['tracks']) || !Array.isArray(value['clips'])) {
    return false;
  }
  return value['tracks'].every((track) => record(track) && typeof track['id'] === 'string' &&
    typeof track['kind'] === 'string') &&
    value['clips'].every((clip) => record(clip) && typeof clip['id'] === 'string' &&
      typeof clip['trackId'] === 'string' && typeof clip['kind'] === 'string');
}

function isCoreOperationResult(value: unknown): value is CoreOperationResult {
  return record(value) && typeof value['changed'] === 'boolean' &&
    isClipTimelineState(value['state']);
}

function integer(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function idValue(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return id || null;
}

function iterableIds(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (typeof value !== 'object' && typeof value !== 'function') return [];
  if (!isIterable(value)) return [];
  return [...new Set([...value].map((entry) => String(entry)))];
}

function isIterable(value: object): value is object & Iterable<unknown> {
  return typeof Reflect.get(value, Symbol.iterator) === 'function';
}

function sameId(first: unknown, second: unknown): boolean {
  return first != null && second != null && String(first) === String(second);
}

function timelineShapeErrors(state: unknown): string[] {
  const errors: string[] = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return ['Timeline state must be an object.'];
  }
  if (!('tracks' in state) || !Array.isArray(state.tracks)) {
    errors.push('Timeline tracks must be an array.');
  }
  if (!('clips' in state) || !Array.isArray(state.clips)) {
    errors.push('Timeline clips must be an array.');
  }
  return errors;
}

export class ClipTimelineStateValidationError extends Error {
  operation: string;
  errors: string[];

  constructor(errors: unknown, operation = 'timeline state') {
    const list = Array.isArray(errors) ? errors.map(String) : [String(errors)];
    super(`Invalid ${operation}: ${list.join(' ')}`);
    this.name = 'ClipTimelineStateValidationError';
    this.operation = operation;
    this.errors = list;
  }
}

function sourceWithInjectedIds(
  source: ClipTimelineStateDefinition,
  makeId: TimelineIdFactory | null | undefined,
): ClipTimelineStateDefinition {
  if (typeof makeId !== 'function') return source;
  const idFactory = makeId;
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
  function allocate(kind: string): string {
    const generated = new Set();
    while (generated.size < 1000) {
      const candidate = idValue(idFactory(kind));
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
  source: ClipTimelineStateDefinition = emptyClipTimelineState(),
  options: { makeId?: TimelineIdFactory } | TimelineIdFactory = {},
): ClipTimelineState {
  const makeId = typeof options === 'function' ? options : options?.makeId;
  const state = createCoreClipTimelineState(sourceWithInjectedIds(source, makeId));
  // Duration is always derived. Retaining an adapter's cached value would create
  // a second authority as soon as a canonical edit changes the max end.
  delete state['durationTicks'];
  state.tags = clampTimelineTags(state.tags, Math.max(1, clipTimelineDurationTicks(state)));
  return state;
}

export function validateCanonicalClipTimelineState(state: ClipTimelineState): string[] {
  const shapeErrors = timelineShapeErrors(state);
  if (shapeErrors.length) return shapeErrors;
  return validateClipTimelineState(state);
}

export function assertCanonicalClipTimelineState(
  state: ClipTimelineState,
  operation = 'timeline state',
): ClipTimelineState {
  const errors = validateCanonicalClipTimelineState(state);
  if (errors.length) throw new ClipTimelineStateValidationError(errors, operation);
  return state;
}

function canonicalState(
  source: ClipTimelineStateDefinition,
  operation: string,
  makeId: TimelineIdFactory | null = null,
): ClipTimelineState {
  const shapeErrors = timelineShapeErrors(source);
  if (shapeErrors.length) throw new ClipTimelineStateValidationError(shapeErrors, operation);
  const state = createCanonicalClipTimelineState(source, makeId ? { makeId } : {});
  return assertCanonicalClipTimelineState(state, operation);
}

export function findClipTimelineTrack(
  state: ClipTimelineState,
  trackOrLayerId: unknown,
): TimelineTrack | null {
  const found = (state?.tracks || []).find((track) =>
    sameId(track.id, trackOrLayerId) ||
    sameId(track.layer?.id, trackOrLayerId));
  return found ? cloneTimelineValue(found) : null;
}

export function findClipTimelineLayer(state: ClipTimelineState, trackOrLayerId: unknown) {
  const track = findClipTimelineTrack(state, trackOrLayerId);
  const layer = track?.layer;
  return layer ? cloneTimelineValue(layer) : null;
}

export function findActiveTimelineClip(
  state: ClipTimelineState,
  trackOrLayerId: unknown,
  projectTick: unknown,
) {
  return findClipAtProjectTick(state, trackOrLayerId, projectTick);
}

export function lookupActiveTimelineClip(
  state: ClipTimelineState,
  trackOrLayerId: unknown,
  projectTick: unknown,
) {
  return lookupClipAtProjectTick(state, trackOrLayerId, projectTick);
}

export function resolveCanonicalTimelineLayers(
  state: ClipTimelineState,
  projectTick: unknown,
  _options: object = {},
) {
  return resolveClipTimelineLayers(state, projectTick);
}

export function resolveCanonicalTimelineAtTick(
  state: ClipTimelineState,
  projectTick: unknown,
  _options: object = {},
) {
  return resolveClipTimelineAtTick(state, projectTick);
}

export function emptyClipTimelineSelection(): ClipTimelineSelection {
  return {
    clipIds: new Set(),
    frameKeys: [],
    propertyKeys: [],
    trackHeaderIds: new Set(),
    gap: null,
    rulerRange: null,
  };
}

export function cloneClipTimelineSelection(
  selection: ClipTimelineSelection = emptyClipTimelineSelection(),
): ClipTimelineSelection {
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

function normalizedSelectionKey(
  entry: unknown,
  state: ClipTimelineState,
  property: false,
): TimelineFrameSelectionKey;
function normalizedSelectionKey(
  entry: unknown,
  state: ClipTimelineState,
  property: true,
): TimelinePropertySelectionKey;
function normalizedSelectionKey(
  entry: unknown,
  state: ClipTimelineState,
  property: boolean,
): TimelineFrameSelectionKey | TimelinePropertySelectionKey {
  const source = record(entry) ? entry : {};
  const clipId = idValue(source['clipId']) || '';
  const clip = (state?.clips || []).find((candidate) => candidate.id === clipId);
  let sourceTick;
  if (source['sourceTick'] != null) sourceTick = integer(source['sourceTick'], -1);
  else if (source['timelineTick'] != null && clip) {
    sourceTick = clipSourceTickAt(clip, source['timelineTick']);
  } else sourceTick = integer(source['tick'], -1);
  const normalized = { clipId, sourceTick: sourceTick ?? -1 };
  if (property) {
    return {
      ...normalized,
      propertyName: String(
        source['propertyName'] || source['track'] || source['name'] || '',
      ).trim(),
    };
  }
  return normalized;
}

function normalizedRange(value: unknown, includeTracks: false): TimelineTickRange | null;
function normalizedRange(value: unknown, includeTracks: true): TimelineGapSelection | null;
function normalizedRange(
  value: unknown,
  includeTracks: boolean,
): TimelineTickRange | TimelineGapSelection | null {
  if (!record(value)) return null;
  const range = {
    startTick: integer(value['startTick'], -1),
    endTick: integer(value['endTick'], -1),
  };
  return includeTracks ? { ...range, trackIds: iterableIds(value['trackIds']) } : range;
}

function selectionInput(selection: unknown) {
  const source = record(selection) ? selection : {};
  return {
    clipIds: source['clipIds'] ?? source['clips'] ?? source['selectedClipIds'],
    frameKeys: source['frameKeys'] ?? source['selectedFrameKeys'],
    propertyKeys: source['propertyKeys'] ?? source['selectedPropertyKeys'],
    trackHeaderIds: source['trackHeaderIds'] ?? source['trackIds'] ??
      source['trackHeaders'] ?? source['selectedTrackIds'],
    gap: source['gap'],
    rulerRange: source['rulerRange'] ?? source['ruler'] ?? source['range'],
  };
}

export function createClipTimelineSelection(
  selection: unknown = {},
  state: ClipTimelineState = emptyClipTimelineState(),
): ClipTimelineSelection {
  const source = selectionInput(selection);
  const frameKeys: TimelineFrameSelectionKey[] = [];
  const seenFrames = new Set<string>();
  for (const entry of Array.isArray(source.frameKeys) ? source.frameKeys : []) {
    const key = normalizedSelectionKey(entry, state, false);
    const identity = `${key.clipId}\u0000${key.sourceTick}`;
    if (!seenFrames.has(identity)) frameKeys.push(key);
    seenFrames.add(identity);
  }
  const propertyKeys: TimelinePropertySelectionKey[] = [];
  const seenProperties = new Set<string>();
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

export function validateClipTimelineSelection(
  selection: unknown,
  state: ClipTimelineState,
): string[] {
  const normalized = createClipTimelineSelection(selection, state);
  const errors: string[] = [];
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

export function assertClipTimelineSelection(
  selection: unknown,
  state: ClipTimelineState,
): ClipTimelineSelection {
  const normalized = createClipTimelineSelection(selection, state);
  const errors = validateClipTimelineSelection(normalized, state);
  if (errors.length) throw new ClipTimelineStateValidationError(errors, 'timeline selection');
  return normalized;
}

function prunedSelection(selection: ClipTimelineSelection, state: ClipTimelineState) {
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

export function clipTimelineSelectionTrackScope(
  state: ClipTimelineState,
  selection: unknown,
) {
  const normalized = createClipTimelineSelection(selection, state);
  const editableTrackIds = new Set((state?.tracks || [])
    .filter((track) => track.kind !== 'group' && !track.locked)
    .map((track) => track.id));
  const editable = (trackIds: string[]) => trackIds.filter((id) => editableTrackIds.has(id));
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

function selectionForCore(selection: ClipTimelineSelection) {
  const normalized = cloneClipTimelineSelection(selection);
  return {
    clipIds: [...normalized.clipIds],
    frameKeys: normalized.frameKeys,
    propertyKeys: normalized.propertyKeys,
    trackIds: [...normalized.trackHeaderIds],
    gap: normalized.gap,
  };
}

function selectedClipId(selection: ClipTimelineSelection): string | null {
  return selection.clipIds.size === 1 ? [...selection.clipIds][0] ?? null : null;
}

function transactionResultDetails(result: unknown): Record<string, unknown> {
  if (!record(result)) return {};
  const details = { ...result };
  delete details['state'];
  return cloneTimelineValue(details);
}

export function createCanonicalClipTimelineController(options: CanonicalControllerOptions = {}) {
  const makeId = options.makeId || options.idGenerator || ((kind) => newUuid(kind));
  const captureProjectRevision = options.captureProjectRevision || captureGlobalProjectRevision;
  const isProjectRevisionCurrent: (revision: unknown) => boolean =
    options.isProjectRevisionCurrent || ((revision) =>
      typeof revision === 'number' && isGlobalProjectRevisionCurrent(revision));
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

  function decoratedResult(
    result: Record<string, unknown>,
    operation: string,
    previousRevision = currentMutationRevision,
  ): ControllerResult {
    const reason = typeof result['reason'] === 'string' ? result['reason'] : null;
    return {
      ...transactionResultDetails(result),
      changed: result['changed'] === true,
      ...(reason === null ? {} : { reason }),
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

  function staleResult(operation: string, reason: string) {
    return decoratedResult({ changed: false, reason }, operation);
  }

  function revisionFailure(transactionOptions: TransactionOptions = {}): string | null {
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

  function commitResult(
    result: CoreOperationResult,
    operation: string,
    commitOptions: CommitOptions = {},
  ) {
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

  function transact(
    operation: string,
    mutator: (
      state: ClipTimelineState,
      context: ControllerTransactionContext,
    ) => CoreOperationResult | ClipTimelineState | false | undefined,
    transactionOptions?: TransactionOptions,
    commitOptions?: CommitOptions,
  ): ReturnType<typeof decoratedResult>;
  function transact(
    mutator: (
      state: ClipTimelineState,
      context: ControllerTransactionContext,
    ) => CoreOperationResult | ClipTimelineState | false | undefined,
    transactionOptions?: TransactionOptions,
    commitOptions?: CommitOptions,
  ): ReturnType<typeof decoratedResult>;
  function transact(
    operation: string | ((
      state: ClipTimelineState,
      context: ControllerTransactionContext,
    ) => CoreOperationResult | ClipTimelineState | false | undefined),
    mutator: ((
      state: ClipTimelineState,
      context: ControllerTransactionContext,
    ) => CoreOperationResult | ClipTimelineState | false | undefined) | TransactionOptions = {},
    transactionOptions: TransactionOptions = {},
    commitOptions: CommitOptions = {},
  ) {
    if (typeof operation === 'function') {
      const operationMutator = operation;
      commitOptions = transactionOptions;
      transactionOptions = record(mutator) ? mutator : {};
      mutator = operationMutator;
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
    if (record(output) && typeof output['then'] === 'function') {
      throw new TypeError('Timeline transactions must be synchronous.');
    }
    let result: CoreOperationResult;
    if (output === false) result = { state: currentState, changed: false, reason: 'unchanged' };
    else if (isCoreOperationResult(output)) {
      result = output;
    } else if (isClipTimelineState(output)) {
      result = { state: output, changed: true };
    } else if (output === undefined) result = { state: draft, changed: true };
    else throw new TypeError('Timeline transaction must return state or an operation result.');
    return commitResult(result, operation, commitOptions);
  }

  function noChange(operation: string, reason: string, details: Record<string, unknown> = {}) {
    return decoratedResult({ changed: false, reason, ...details }, operation);
  }

  function replaceState(value: ClipTimelineStateDefinition, replaceOptions: TransactionOptions = {}) {
    const operation = replaceOptions.operation || 'replace-state';
    return transact(
      operation,
      () => ({ state: canonicalState(value, `${operation} result`, makeId), changed: true }),
      replaceOptions,
      replaceOptions,
    );
  }

  const timeline = {
    subscribe: statePublisher.subscribe,
    set(value: ClipTimelineStateDefinition) {
      return replaceState(value);
    },
    update(updater: (state: ClipTimelineState) => ClipTimelineStateDefinition) {
      if (typeof updater !== 'function') throw new TypeError('Timeline updater must be a function.');
      const value = updater(cloneTimelineValue(currentState));
      if (value === undefined) throw new TypeError('Timeline updater must return state.');
      return replaceState(value);
    },
  };

  const playheadTick = {
    subscribe: playheadPublisher.subscribe,
    set(value: unknown) {
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
    update(updater: (tick: number) => unknown) {
      if (typeof updater !== 'function') throw new TypeError('Playhead updater must be a function.');
      return playheadTick.set(updater(currentPlayhead));
    },
  };

  const selection = {
    subscribe: selectionPublisher.subscribe,
    set(value: unknown) {
      if (revisionFailure()) return false;
      currentSelection = assertClipTimelineSelection(value, currentState);
      publishContext();
      return cloneClipTimelineSelection(currentSelection);
    },
    update(updater: (selection: ClipTimelineSelection) => unknown) {
      if (typeof updater !== 'function') throw new TypeError('Selection updater must be a function.');
      return selection.set(updater(cloneClipTimelineSelection(currentSelection)));
    },
  };

  const durationTicks = { subscribe: durationPublisher.subscribe };
  const mutationRevision = { subscribe: mutationRevisionPublisher.subscribe };

  function seekTick(value: unknown) {
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

  function isRevisionGuardCurrent(
    guard: { projectRevision?: unknown; mutationRevision?: unknown } | null | undefined,
    { mutation = true }: { mutation?: boolean } = {},
  ) {
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

  function restoreState(snapshot: unknown, restoreOptions: TransactionOptions = {}) {
    const snapshotRecord = record(snapshot) ? snapshot : {};
    const snapshotState = record(snapshotRecord['state']) ? snapshotRecord['state'] : null;
    const snapshotTimeline = record(snapshotRecord['timeline']) ? snapshotRecord['timeline'] : null;
    const source = Array.isArray(snapshotState?.['tracks'])
      ? snapshotState
      : Array.isArray(snapshotTimeline?.['tracks'])
        ? snapshotTimeline
        : snapshot;
    const expectedProject = restoreOptions.projectRevision ?? snapshotRecord['projectRevision'] ??
      projectRevision;
    if (expectedProject !== projectRevision || !isProjectRevisionCurrent(projectRevision)) {
      return staleResult('restore', 'stale-project');
    }
    if (!isClipTimelineState(source)) {
      throw new ClipTimelineStateValidationError(timelineShapeErrors(source), 'restored clip timeline');
    }
    const restored = createCanonicalClipTimelineState(source, { makeId });
    return transact(
      'restore',
      () => ({ state: restored, changed: true }),
      restoreOptions,
      {
        playheadTick: restoreOptions.playheadTick ?? snapshotRecord['playheadTick'] ?? currentPlayhead,
        selection: restoreOptions.selection ?? snapshotRecord['selection'] ?? emptyClipTimelineSelection(),
      },
    );
  }

  function resetState(resetOptions: TransactionOptions = {}) {
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

  function initializeState(
    value: ClipTimelineStateDefinition,
    initializeOptions: TransactionOptions = {},
  ) {
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

  function addTrack(
    definition: TimelineTrackDefinition = {},
    operationOptions: TransactionOptions = {},
  ) {
    return transact(
      'add-track',
      (state) => addTimelineTrack(state, definition, { makeId }),
      operationOptions,
    );
  }

  function updateTrack(
    trackId: string,
    patch: TimelineTrackDefinition = {},
    operationOptions: TransactionOptions = {},
  ) {
    return transact(
      'update-track',
      (state) => updateTimelineTrack(state, trackId, patch),
      operationOptions,
    );
  }

  function removeTrack(trackId: string, operationOptions: TransactionOptions = {}) {
    return transact(
      'remove-track',
      (state) => removeTimelineTrack(state, trackId),
      operationOptions,
    );
  }

  function addClip(
    definition: TimelineClipDefinition = {},
    operationOptions: TransactionOptions = {},
  ) {
    return transact(
      'add-clip',
      (state) => addTimelineClip(state, definition, { makeId }),
      operationOptions,
    );
  }

  function addVisualClip(
    trackId: string,
    definition: TimelineClipDefinition = {},
    operationOptions: TransactionOptions = {},
  ) {
    return addClip({ ...definition, trackId, kind: 'visual' }, operationOptions);
  }

  function removeClip(clipId: string, operationOptions: TransactionOptions = {}) {
    return transact(
      'remove-clip',
      (state) => removeTimelineClip(state, clipId),
      operationOptions,
    );
  }

  function updateClip(
    clipId: string,
    patch: TimelineClipDefinition = {},
    operationOptions: TransactionOptions = {},
  ) {
    return transact(
      'update-clip',
      (state) => updateTimelineClip(state, clipId, patch),
      operationOptions,
    );
  }

  function setTag(
    definition: { id?: unknown; tick?: unknown; type?: unknown; value?: unknown } = {},
    operationOptions: TransactionOptions = {},
  ) {
    return transact(
      'set-tag',
      (state) => setTimelineTagValue(state, definition, { ...operationOptions, makeId }),
      operationOptions,
    );
  }

  function setLoopStart(tick: unknown, operationOptions: TransactionOptions = {}) {
    return setTag({ tick, type: 'loop-start' }, operationOptions);
  }

  function setLoopEnd(tick: unknown, operationOptions: TransactionOptions = {}) {
    return setTag({ tick, type: 'loop-end' }, operationOptions);
  }

  function addCustomTag(tick: unknown, value: unknown, operationOptions: TransactionOptions = {}) {
    return setTag({ tick, type: 'custom', value }, operationOptions);
  }

  function updateCustomTag(
    tagId: string,
    patch: { tick?: unknown; value?: unknown } = {},
    operationOptions: TransactionOptions = {},
  ) {
    const current = currentState.tags.find((tag) => tag.id === tagId && tag.type === 'custom');
    if (!current) return noChange('set-tag', 'missing-tag');
    return setTag({ ...current, ...patch, id: current.id, type: 'custom' }, operationOptions);
  }

  function removeTag(tagId: string, operationOptions: TransactionOptions = {}) {
    return transact(
      'remove-tag',
      (state) => removeTimelineTagValue(state, tagId),
      operationOptions,
    );
  }

  function setFps(value: unknown, operationOptions: TransactionOptions = {}) {
    return transact(
      'set-fps',
      (state) => setClipTimelineFpsValue(state, value),
      operationOptions,
    );
  }

  function editVisualFrame(
    trackId: string,
    tick: unknown,
    edit: unknown,
    editOptions: TransactionOptions = {},
  ) {
    return transact(
      'edit-visual-frame',
      (state) => editVisualFrameValue(state, trackId, tick, edit, {
        ...editOptions,
        makeId,
      }),
      editOptions,
    );
  }

  function editProperty(
    clipId: string,
    propertyName: unknown,
    tick: unknown,
    edit: unknown,
    editOptions: TransactionOptions = {},
  ) {
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

  function move(
    clipId: string | null | undefined,
    targetStartTick: unknown,
    moveOptions: TransactionOptions = {},
  ) {
    const target = clipId || selectedClipId(currentSelection);
    if (!target) return noChange('move', 'missing-clip-selection');
    return transact(
      'move',
      (state) => moveTimelineClip(state, target, targetStartTick, moveOptions),
      moveOptions,
    );
  }

  function moveMany(operations: ClipMoveOperation[] | unknown, moveOptions: TransactionOptions = {}) {
    const edits: ClipMoveOperation[] = Array.isArray(operations)
      ? operations.filter(record)
      : [];
    if (!edits.length) return noChange('move-many', 'missing-operations');
    return transact('move-many', (state) => {
      let next = state;
      const movedClipIds: string[] = [];
      for (const edit of edits) {
        const clipId = idValue(edit.clipId);
        if (!clipId) continue;
        const result = moveTimelineClip(
          next,
          clipId,
          edit?.targetStartTick,
          edit?.trackId == null ? moveOptions : { ...moveOptions, trackId: edit.trackId },
        );
        if (!result.changed) continue;
        next = result.state;
        movedClipIds.push(clipId);
      }
      return movedClipIds.length
        ? { state: next, changed: true, movedClipIds }
        : { state: next, changed: false, reason: 'unchanged', movedClipIds };
    }, moveOptions);
  }

  function duplicateClips(
    operations: ClipMoveOperation[] | unknown,
    duplicateOptions: TransactionOptions = {},
  ) {
    const commitOptions: CommitOptions = {};
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

  function moveKeys(
    selectionValue: unknown = currentSelection,
    deltaTicks: unknown = 0,
    moveOptions: TransactionOptions = {},
  ) {
    const target = assertClipTimelineSelection(selectionValue, currentState);
    const commitOptions: CommitOptions = {};
    return transact('move-keys', (state) => {
      const result = moveTimelineKeysValue(state, target, deltaTicks);
      if (result.changed) commitOptions.selection = result.selection;
      return result;
    }, moveOptions, commitOptions);
  }

  function trim(
    clipId: string | null | undefined,
    edge: unknown,
    targetTick: unknown,
    trimOptions: TransactionOptions = {},
  ) {
    const target = clipId || selectedClipId(currentSelection);
    if (!target) return noChange('trim', 'missing-clip-selection');
    return transact(
      'trim',
      (state) => trimTimelineClip(state, target, edge, targetTick),
      trimOptions,
    );
  }

  function trimMany(operations: ClipTrimOperation[] | unknown, trimOptions: TransactionOptions = {}) {
    const edits: ClipTrimOperation[] = Array.isArray(operations)
      ? operations.filter(record)
      : [];
    if (!edits.length) return noChange('trim-many', 'missing-operations');
    return transact('trim-many', (state) => {
      let next = state;
      const trimmedClipIds: string[] = [];
      for (const edit of edits) {
        const clipId = idValue(edit.clipId);
        if (!clipId) continue;
        const result = trimTimelineClip(next, clipId, edit.edge, edit.targetTick);
        if (!result.changed) continue;
        next = result.state;
        trimmedClipIds.push(clipId);
      }
      return trimmedClipIds.length
        ? { state: next, changed: true, trimmedClipIds }
        : { state: next, changed: false, reason: 'unchanged', trimmedClipIds };
    }, trimOptions);
  }

  function razorClip(clipId: string, tick: unknown, razorOptions: TransactionOptions = {}) {
    return transact(
      'razor',
      (state) => razorSplitClip(state, clipId, tick, { ...razorOptions, makeId }),
      razorOptions,
    );
  }

  function razorAtTick(tick: unknown, razorOptions: TransactionOptions = {}) {
    return transact(
      'razor',
      (state) => razorSplitAtTick(state, tick, { ...razorOptions, makeId }),
      razorOptions,
    );
  }

  function razorPath(cuts: RazorCut[] | unknown, razorOptions: TransactionOptions = {}) {
    const requested: RazorCut[] = Array.isArray(cuts) ? cuts.filter(record) : [];
    const grouped = new Map<string, Set<number>>();
    for (const cut of requested) {
      const clipId = idValue(cut?.clipId);
      const tick = integer(cut?.tick, -1);
      if (!clipId || tick < 0) continue;
      const ticks = grouped.get(clipId) || new Set<number>();
      ticks.add(tick);
      grouped.set(clipId, ticks);
    }
    if (!grouped.size) return noChange('razor-path', 'missing-cuts', { splits: [] });
    return transact('razor-path', (state) => {
      let next = state;
      const splits: Array<{
        originalId: string;
        leftId: string;
        rightId: string;
        sourceTick: number;
        tick: number;
      }> = [];
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

  function razor(
    first: unknown = currentPlayhead,
    second: unknown = {},
    third: TransactionOptions = {},
  ) {
    if ((typeof first === 'string' || typeof first === 'number') &&
      Number.isFinite(Number(second)) && typeof second !== 'object') {
      return razorClip(String(first), Number(second), third);
    }
    const tick = Number.isFinite(Number(first)) ? Number(first) : currentPlayhead;
    const razorOptions: TransactionOptions = record(second) ? second : {};
    const ids = iterableIds(razorOptions.clipIds || currentSelection.clipIds);
    if (razorOptions.clipId) return razorClip(razorOptions.clipId, tick, razorOptions);
    const firstId = ids[0];
    if (ids.length === 1 && firstId) return razorClip(firstId, tick, razorOptions);
    if (ids.length > 1) {
      return transact('razor', (state) => {
        let next = state;
        let changed = false;
        const splits: Array<{
          originalId: string;
          leftId: string;
          rightId: string;
          sourceTick: number;
        }> = [];
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

  function deleteSelection(
    selectionValue: unknown = currentSelection,
    deleteOptions: TransactionOptions = {},
  ) {
    const target = assertClipTimelineSelection(selectionValue, currentState);
    return transact(
      'delete',
      (state) => deleteTimelineSelectionValue(state, selectionForCore(target), deleteOptions),
      deleteOptions,
      { clearSelection: true },
    );
  }

  function rippleDeleteGap(
    trackIds: TimelineIdSource,
    startTick: unknown,
    endTick: unknown,
    rippleOptions: TransactionOptions = {},
  ) {
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

  function ripple(
    first: unknown = {},
    startTick?: unknown,
    endTick?: unknown,
    trailingOptions: TransactionOptions = {},
  ) {
    if (typeof first === 'string' || Array.isArray(first) || first instanceof Set) {
      return rippleDeleteGap(first, startTick, endTick, trailingOptions);
    }
    const rippleOptions: TransactionOptions = record(first) ? first : {};
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

  function addEmpty(tick: unknown, ticks: unknown, addOptions: TransactionOptions = {}) {
    return transact(
      'add-empty',
      (state) => addEmptyTimeValue(state, tick, ticks, { ...addOptions, makeId }),
      addOptions,
      { clearRanges: true },
    );
  }

  function shiftClipKeys(
    clipId: string,
    delta: unknown,
    from: unknown = 0,
    shiftOptions: TransactionOptions = {},
  ) {
    return transact(
      'shift-clip-keys',
      (state) => shiftTimelineClipKeys(state, clipId, delta, from),
      shiftOptions,
    );
  }

  function resizeSelectedClipEdges(
    clipIds: TimelineIdSource,
    edge: unknown,
    edgeTick: unknown,
    delta: unknown,
    resizeOptions: TransactionOptions = {},
  ) {
    const ids = clipIds == null ? currentSelection.clipIds : clipIds;
    return transact(
      'resize-selected-clip-edges',
      (state) => resizeSelectedClipEdgesValue(state, ids, edge, edgeTick, delta),
      resizeOptions,
    );
  }

  function findTrack(identifier: unknown) {
    return findClipTimelineTrack(currentState, identifier);
  }

  function findLayer(identifier: unknown) {
    return findClipTimelineLayer(currentState, identifier);
  }

  function findActiveClip(identifier: unknown, tick: unknown = currentPlayhead) {
    return findActiveTimelineClip(currentState, identifier, tick);
  }

  function lookupActiveClip(identifier: unknown, tick: unknown = currentPlayhead) {
    return lookupActiveTimelineClip(currentState, identifier, tick);
  }

  function resolveLayersAtTick(tick: unknown = currentPlayhead, resolverOptions: object = {}) {
    const projectTick = integer(tick, -1);
    if (projectTick < 0 || projectTick >= effectiveDurationTicks() ||
      projectTick >= clipTimelineDurationTicks(currentState)) return [];
    return resolveCanonicalTimelineLayers(currentState, projectTick, resolverOptions);
  }

  function resolveAtTick(tick: unknown = currentPlayhead, resolverOptions: object = {}) {
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

export const subscribeClipTimeline = defaultController.subscribe;
export const getClipTimelineState = () => defaultController.getState();
export const getClipTimelineSelection = () => defaultController.getSelection();
export const seekClipTimelineTick = defaultController.seekTick;
export const setClipTimelineSelection = defaultController.setSelection;
export const clearClipTimelineSelection = defaultController.clearSelection;
export const captureClipTimelineState = defaultController.captureState;
export const captureClipTimelineRevisionGuard = defaultController.captureRevisionGuard;
export const isClipTimelineRevisionGuardCurrent = defaultController.isRevisionGuardCurrent;
export const restoreClipTimelineState = defaultController.restoreState;
export const resetClipTimelineState = defaultController.resetState;
export const initializeClipTimelineState = defaultController.initializeState;
export const transactClipTimeline = defaultController.transact;
export const editVisualFrame = defaultController.editVisualFrame;
export const editProperty = defaultController.editProperty;
export const updateClip = defaultController.updateClip;
export const setTimelineTag = defaultController.setTag;
export const setLoopStartTag = defaultController.setLoopStart;
export const setLoopEndTag = defaultController.setLoopEnd;
export const addCustomTimelineTag = defaultController.addCustomTag;
export const updateCustomTimelineTag = defaultController.updateCustomTag;
export const removeTimelineTag = defaultController.removeTag;
export const setClipTimelineFps = defaultController.setFps;
export const moveClip = defaultController.moveClip;
export const moveClips = defaultController.moveMany;
export const duplicateClips = defaultController.duplicateClips;
export const moveTimelineKeys = defaultController.moveKeys;
export const trimClip = defaultController.trimClip;
export const trimClips = defaultController.trimMany;
export const razor = defaultController.razor;
export const razorPath = defaultController.razorPath;
export const deleteSelection = defaultController.deleteSelection;
export const ripple = defaultController.ripple;
export const addEmpty = defaultController.addEmpty;
