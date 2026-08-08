import { get, writable } from 'svelte/store';
import {
  beginStroke,
  cancelStroke,
  activeLayerId,
  endStroke,
  getLayer,
  layers,
  setShapeLayerProperties,
  updateTextLayer,
} from './grid.js';
import { renderShapeToCells } from './shapes.js';
import { activeTool, paintColor, recentColors } from './stores.js';
import {
  textColorPatchForSelection,
  textColorStateForSelection,
  textSelection,
  textSelectionForLayer,
} from './textEditing.js';
import { renderTextToCells } from './textLayer.js';
import {
  captureProjectRevision,
  isProjectRevisionCurrent,
  onProjectReplaced,
} from './documentLifecycle.js';

const HEX = /^#[0-9a-f]{6}$/i;
const IDLE = Object.freeze({
  active: false,
  phase: 'idle',
  target: null,
  color: null,
  mixed: false,
  editing: false,
  x: 0,
  y: 0,
  cycle: 0,
});

const state = writable(IDLE);
let current = null;
let nextCycle = 1;

function normalizedHex(value) {
  return HEX.test(value || '') ? value.toLowerCase() : null;
}

function frozenSelection(layerId, supplied) {
  const selection = supplied ?? textSelectionForLayer(get(textSelection), layerId);
  if (!selection || selection.layerId !== layerId) return null;
  const start = Math.max(0, Math.round(Number(selection.start)) || 0);
  const end = Math.max(start, Math.round(Number(selection.end)) || 0);
  return Object.freeze({ layerId, start, end });
}

function normalizeTarget(target) {
  if (target?.kind === 'toolbar') return Object.freeze({ kind: 'toolbar' });
  if (target?.kind !== 'shape' && target?.kind !== 'text') return null;
  const layer = getLayer(target.layerId);
  if (!layer || layer.type !== target.kind || get(activeLayerId) !== layer.id) return null;
  if (target.kind === 'shape') {
    return Object.freeze({ kind: 'shape', layerId: layer.id });
  }
  return Object.freeze({
    kind: 'text',
    layerId: layer.id,
    selection: frozenSelection(layer.id, target.selection),
  });
}

function normalizedAnchor(target, anchor) {
  const source = anchor || target?.anchor || target || {};
  return Object.freeze({
    x: Number.isFinite(Number(source.x)) ? Number(source.x) : 0,
    y: Number.isFinite(Number(source.y)) ? Number(source.y) : 0,
  });
}

function targetLayer(target = current?.target) {
  if (!target || target.kind === 'toolbar') return null;
  const layer = getLayer(target.layerId);
  return layer?.type === target.kind ? layer : null;
}

function colorState(target = current?.target) {
  if (!target) return { color: null, mixed: false };
  if (target.kind === 'toolbar') {
    return { color: normalizedHex(get(paintColor)), mixed: false };
  }
  const layer = targetLayer(target);
  if (!layer) return { color: null, mixed: false };
  if (target.kind === 'shape') {
    return { color: normalizedHex(layer.shape?.fg) || '#ffffff', mixed: false };
  }
  return textColorStateForSelection(layer, target.selection);
}

function publicTarget(target) {
  if (!target) return null;
  if (target.kind !== 'text') return target;
  return Object.freeze({ ...target, selection: target.selection });
}

function publish() {
  if (!current) {
    state.set(IDLE);
    return;
  }
  const value = colorState();
  state.set(Object.freeze({
    active: true,
    phase: current.phase,
    target: publicTarget(current.target),
    color: value.color,
    mixed: value.mixed,
    editing: current.gesture !== null,
    x: current.anchor.x,
    y: current.anchor.y,
    cycle: current.cycle,
  }));
}

function rememberColor(color) {
  if (!color) return;
  recentColors.update((colors) => [
    color,
    ...colors.filter((candidate) => candidate.toLowerCase() !== color),
  ].slice(0, 16));
}

function targetSnapshot(target) {
  if (target.kind === 'toolbar') return get(paintColor);
  const layer = targetLayer(target);
  if (target.kind === 'shape') return layer?.shape?.fg ?? null;
  return layer ? {
    fg: layer.fg,
    runs: (layer.runs || []).map((run) => ({ ...run })),
  } : null;
}

function sameRuns(left, right) {
  return left.length === right.length && left.every((run, index) => {
    const other = right[index];
    return run.start === other.start && run.end === other.end && run.fg === other.fg;
  });
}

function targetMatchesSnapshot(target, snapshot) {
  if (target.kind === 'toolbar') return get(paintColor) === snapshot;
  const layer = targetLayer(target);
  if (!layer) return false;
  if (target.kind === 'shape') return layer.shape?.fg === snapshot;
  return layer.fg === snapshot.fg && sameRuns(layer.runs || [], snapshot.runs);
}

function beginGesture() {
  if (current.gesture) return;
  current.gesture = { snapshot: targetSnapshot(current.target) };
  if (current.target.kind !== 'toolbar') beginStroke();
}

function restoreSamplingTool() {
  if (!current || current.phase !== 'sampling') return;
  const tool = current.samplingTool;
  current.phase = 'picker';
  current.samplingTool = null;
  activeTool.set(tool);
}

function finishGesture(cancel = false) {
  if (!current?.gesture) return false;
  const session = current;
  const { target, gesture } = session;
  if (target.kind === 'toolbar') {
    if (cancel) paintColor.set(gesture.snapshot);
  } else if (cancel || targetMatchesSnapshot(target, gesture.snapshot)) {
    cancelStroke();
  } else {
    endStroke();
  }
  session.gesture = null;
  if (current === session) publish();
  return true;
}

function abandonMissingTarget() {
  if (!current) return;
  // Preserve deletion; its undo entry also discards the uncommitted preview.
  if (current.gesture) endStroke();
  restoreSamplingTool();
  current = null;
  state.set(IDLE);
}

function abandonReplacedProject() {
  if (!current) return;
  restoreSamplingTool();
  current = null;
  state.set(IDLE);
}

function validate() {
  if (!current) return false;
  if (!isProjectRevisionCurrent(current.revision)) {
    abandonReplacedProject();
    return false;
  }
  if (current.target.kind === 'toolbar') return true;
  if (!targetLayer()) {
    abandonMissingTarget();
    return false;
  }
  if (get(activeLayerId) === current.target.layerId) return true;
  abort();
  return false;
}

function applyColor(color) {
  const target = current.target;
  if (target.kind === 'toolbar') {
    if (get(paintColor).toLowerCase() === color) return false;
    beginGesture();
    paintColor.set(color);
    return true;
  }
  const layer = targetLayer(target);
  if (target.kind === 'shape') {
    if ((layer.shape?.fg || '#ffffff').toLowerCase() === color) return false;
    beginGesture();
    setShapeLayerProperties(target.layerId, { fg: color }, renderShapeToCells);
    return true;
  }
  const patch = textColorPatchForSelection(layer, target.selection, color);
  if (!patch) return false;
  beginGesture();
  updateTextLayer(target.layerId, patch, renderTextToCells);
  return true;
}

function open(target, anchor = null) {
  const nextTarget = normalizeTarget(target);
  if (!nextTarget) return false;
  close();
  current = {
    target: nextTarget,
    anchor: normalizedAnchor(target, anchor),
    cycle: nextCycle++,
    revision: captureProjectRevision(),
    phase: 'picker',
    gesture: null,
    samplingTool: null,
  };
  publish();
  return true;
}

function preview(value) {
  const color = normalizedHex(value);
  if (!color || !validate()) return false;
  const changed = applyColor(color);
  publish();
  return changed;
}

function commit(value) {
  const color = normalizedHex(value);
  if (value != null && !color) return false;
  if (!validate()) return false;
  if (color) preview(color);
  const committed = current.gesture !== null;
  const remembered = color || colorState().color;
  finishGesture(false);
  rememberColor(normalizedHex(remembered));
  restoreSamplingTool();
  publish();
  return committed;
}

function cancel() {
  if (!current) return false;
  const cancelled = finishGesture(true);
  restoreSamplingTool();
  publish();
  return cancelled;
}

function startSampling() {
  if (!validate()) return false;
  finishGesture(false);
  if (current.phase !== 'sampling') {
    current.samplingTool = get(activeTool);
    current.sampled = false;
    current.phase = 'sampling';
    activeTool.set('eyedropper');
  }
  publish();
  return true;
}

function sample(value) {
  const color = normalizedHex(value);
  if (!color || !current || current.phase !== 'sampling' || !validate()) return false;
  current.sampled = true;
  return preview(color);
}

function finishSampling() {
  if (!current || current.phase !== 'sampling') return false;
  if (!current.sampled) return false;
  return commit();
}

function abort() {
  if (!current) return false;
  finishGesture(true);
  restoreSamplingTool();
  current = null;
  state.set(IDLE);
  return true;
}

function close() {
  if (!current) return false;
  if (validate()) finishGesture(false);
  if (!current) return true;
  restoreSamplingTool();
  current = null;
  state.set(IDLE);
  return true;
}

layers.subscribe(() => {
  if (!current || current.target.kind === 'toolbar') return;
  if (!isProjectRevisionCurrent(current.revision)) abandonReplacedProject();
  else if (!targetLayer()) abandonMissingTarget();
  else publish();
});

onProjectReplaced(abandonReplacedProject);

activeTool.subscribe((tool) => {
  if (!current || current.phase !== 'sampling' || tool === 'eyedropper') return;
  const session = current;
  finishGesture(true);
  if (current === session) {
    current = null;
    state.set(IDLE);
  }
});

export const colorEditSession = Object.freeze({
  subscribe: state.subscribe,
  open,
  preview,
  commit,
  cancel,
  startSampling,
  sample,
  finishSampling,
  close,
  abort,
  validate,
});
