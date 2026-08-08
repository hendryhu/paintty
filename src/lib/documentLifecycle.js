import { resetKeyboardContext } from './timelineKeys.js';

const savedListeners = new Set();
const loadedListeners = new Set();
const checkpointListeners = new Set();
const replacedListeners = new Set();

export function createRevisionTracker(initialRevision = 0) {
  let revision = Number.isSafeInteger(initialRevision) && initialRevision >= 0
    ? initialRevision
    : 0;
  return {
    capture: () => revision,
    advance: () => ++revision,
    isCurrent: (candidate) => candidate === revision,
  };
}

export function createLatestRequestTracker() {
  let sequence = 0;
  const latest = new Map();
  function isCurrent(request) {
    return !!request && latest.get(request.key) === request.sequence;
  }
  return {
    begin(key) {
      const request = { key, sequence: ++sequence };
      latest.set(key, request.sequence);
      return request;
    },
    isCurrent,
    cancel(request) {
      if (isCurrent(request)) latest.delete(request.key);
    },
    settle(request, value, { valid = true, accept, discard } = {}) {
      const current = isCurrent(request);
      if (!current || !valid) {
        if (current) latest.delete(request.key);
        discard?.(value);
        return false;
      }
      const accepted = accept?.(value) !== false;
      if (!accepted) discard?.(value);
      latest.delete(request.key);
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

export function isProjectRevisionCurrent(revision) {
  return projectRevision.isCurrent(revision);
}

function subscribe(listeners, listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(listeners, detail) {
  for (const listener of listeners) listener(detail);
}

async function notifyRequired(listeners, detail) {
  for (const listener of listeners) await listener(detail);
}

export function onProjectSaved(listener) {
  return subscribe(savedListeners, listener);
}

export function onProjectLoaded(listener) {
  return subscribe(loadedListeners, listener);
}

export function onProjectCheckpoint(listener) {
  return subscribe(checkpointListeners, listener);
}

export function onProjectReplaced(listener) {
  return subscribe(replacedListeners, listener);
}

export async function notifyProjectSaved(detail) {
  await notifyRequired(savedListeners, detail);
}

export function notifyProjectLoaded(detail) {
  notify(loadedListeners, detail);
}

export function notifyProjectReplaced(detail) {
  notify(replacedListeners, detail);
  resetKeyboardContext();
}

export async function notifyProjectCheckpoint(detail) {
  await notifyRequired(checkpointListeners, detail);
}
