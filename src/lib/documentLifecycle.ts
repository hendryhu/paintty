import { resetKeyboardContext } from './timelineKeys.js';
import type {
  LatestRequest,
  LatestRequestSettleOptions,
  ProjectCheckpointDetail,
  ProjectLoadedDetail,
  ProjectReplacedDetail,
  ProjectSavedDetail,
  RevisionTracker,
} from './types/project-types.js';

type Listener<T> = (detail: T) => void;
type RequiredListener<T> = (detail: T) => void | Promise<void>;

const savedListeners = new Set<RequiredListener<ProjectSavedDetail>>();
const loadedListeners = new Set<Listener<ProjectLoadedDetail>>();
const checkpointListeners = new Set<RequiredListener<ProjectCheckpointDetail>>();
const replacedListeners = new Set<Listener<ProjectReplacedDetail | undefined>>();

export function createRevisionTracker(initialRevision = 0): RevisionTracker {
  let revision = Number.isSafeInteger(initialRevision) && initialRevision >= 0
    ? initialRevision
    : 0;
  return {
    capture: () => revision,
    advance: () => ++revision,
    isCurrent: (candidate: number) => candidate === revision,
  };
}

export function createLatestRequestTracker<K = string>() {
  let sequence = 0;
  const latest = new Map<K, number>();
  function isCurrent(request: LatestRequest<K> | null | undefined): boolean {
    if (!request) return false;
    return latest.get(request.key) === request.sequence;
  }
  return {
    begin(key: K): LatestRequest<K> {
      const request = { key, sequence: ++sequence };
      latest.set(key, request.sequence);
      return request;
    },
    isCurrent,
    cancel(request: LatestRequest<K> | null | undefined): void {
      if (request && isCurrent(request)) latest.delete(request.key);
    },
    settle<T>(
      request: LatestRequest<K> | null | undefined,
      value: T,
      { valid = true, accept, discard }: LatestRequestSettleOptions<T> = {},
    ): boolean {
      const current = isCurrent(request);
      if (!current || !valid) {
        if (current && request) latest.delete(request.key);
        discard?.(value);
        return false;
      }
      const accepted = accept?.(value) !== false;
      if (!accepted) discard?.(value);
      latest.delete(request!.key);
      return accepted;
    },
  };
}

const projectRevision = createRevisionTracker();

export function captureProjectRevision() {
  return projectRevision.capture();
}

export function advanceProjectRevision() {
  return projectRevision.advance();
}

export function isProjectRevisionCurrent(revision: number): boolean {
  return projectRevision.isCurrent(revision);
}

function subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): () => boolean {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify<T>(listeners: Set<Listener<T>>, detail: T): void {
  for (const listener of listeners) listener(detail);
}

async function notifyRequired<T>(listeners: Set<RequiredListener<T>>, detail: T): Promise<void> {
  for (const listener of listeners) await listener(detail);
}

export function onProjectSaved(listener: RequiredListener<ProjectSavedDetail>): () => boolean {
  return subscribe(savedListeners, listener);
}

export function onProjectLoaded(listener: Listener<ProjectLoadedDetail>): () => boolean {
  return subscribe(loadedListeners, listener);
}

export function onProjectCheckpoint(listener: RequiredListener<ProjectCheckpointDetail>): () => boolean {
  return subscribe(checkpointListeners, listener);
}

export function onProjectReplaced(
  listener: Listener<ProjectReplacedDetail | undefined>,
): () => boolean {
  return subscribe(replacedListeners, listener);
}

export async function notifyProjectSaved(detail: ProjectSavedDetail): Promise<void> {
  await notifyRequired(savedListeners, detail);
}

export function notifyProjectLoaded(detail: ProjectLoadedDetail): void {
  notify(loadedListeners, detail);
}

export function notifyProjectReplaced(detail?: ProjectReplacedDetail): void {
  notify(replacedListeners, detail);
  resetKeyboardContext();
}

export async function notifyProjectCheckpoint(detail: ProjectCheckpointDetail): Promise<void> {
  await notifyRequired(checkpointListeners, detail);
}
