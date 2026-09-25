import { get, writable } from 'svelte/store';
import {
  beginStroke,
  cancelStroke,
  activeLayerId,
  endStroke,
  getLayer,
  layers,
  setEffectProperties,
  setShapeLayerProperties,
  updateTextLayer,
} from './grid.js';
import { renderShapeToCells } from './shapes.js';
import { activeTool, paintColor, recentColors } from './stores.js';
import {
  activeFrameIndex,
  effectColorAt,
  isEffectColorTrackEnabled,
  setEffectColorKey,
} from './frames.js';
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
import type {
  EditorEffectLayer,
  EditorPoint,
  EditorShapeLayer,
  EditorTextLayer,
  EditorTextRun,
  EditorTool,
} from './types/editor-domain.js';
import type { EditorTextSelection } from './textEditing.js';

type ColorTarget =
  | { kind: 'toolbar' }
  | { kind: 'shape'; layerId: string }
  | { kind: 'text'; layerId: string; selection: EditorTextSelection | null }
  | { kind: 'effect'; layerId: string };

type ColorOpenTarget = (
  | { kind: 'toolbar' }
  | { kind: 'shape'; layerId: string }
  | { kind: 'text'; layerId: string; selection?: EditorTextSelection | null | undefined }
  | { kind: 'effect'; layerId: string }
) & Partial<EditorPoint> & { anchor?: Partial<EditorPoint> | undefined };

interface TextColorSnapshot {
  fg: string;
  runs: EditorTextRun[];
}

interface ColorSession {
  target: ColorTarget;
  anchor: Readonly<EditorPoint>;
  cycle: number;
  revision: number;
  phase: 'picker' | 'sampling';
  gesture: { snapshot: string | TextColorSnapshot | null } | null;
  samplingTool: EditorTool | null;
  sampled?: boolean | undefined;
}

interface ColorEditState {
  active: boolean;
  phase: 'idle' | 'picker' | 'sampling';
  target: ColorTarget | null;
  color: string | null;
  mixed: boolean;
  editing: boolean;
  x: number;
  y: number;
  cycle: number;
}

const HEX = /^#[0-9a-f]{6}$/i;
const IDLE: Readonly<ColorEditState> = Object.freeze({
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

const state = writable<Readonly<ColorEditState>>(IDLE);
let current: ColorSession | null = null;
let nextCycle = 1;

function normalizedHex(value: string | null | undefined): string | null {
  return HEX.test(value || '') ? value!.toLowerCase() : null;
}

function frozenSelection(layerId: string, supplied: EditorTextSelection | null | undefined): Readonly<EditorTextSelection> | null {
  const selection = supplied ?? textSelectionForLayer(get(textSelection), layerId);
  if (!selection || selection.layerId !== layerId) return null;
  const start = Math.max(0, Math.round(Number(selection.start)) || 0);
  const end = Math.max(start, Math.round(Number(selection.end)) || 0);
  return Object.freeze({ layerId, start, end });
}

function normalizeTarget(target: ColorOpenTarget): ColorTarget | null {
  if (target?.kind === 'toolbar') return Object.freeze({ kind: 'toolbar' });
  if (target?.kind !== 'shape' && target?.kind !== 'text' && target?.kind !== 'effect') return null;
  const layer = getLayer(target.layerId);
  if (!layer || layer.type !== target.kind || get(activeLayerId) !== layer.id) return null;
  if (target.kind === 'shape') {
    return Object.freeze({ kind: 'shape', layerId: layer.id });
  }
  if (target.kind === 'effect') {
    const effectLayer = layer as EditorEffectLayer;
    if (!effectLayer.effect || effectLayer.effect.kind !== 'solid-color') return null;
    return Object.freeze({ kind: 'effect', layerId: layer.id });
  }
  return Object.freeze({
    kind: 'text',
    layerId: layer.id,
    selection: frozenSelection(layer.id, target.selection),
  });
}

function normalizedAnchor(target: ColorOpenTarget, anchor: Partial<EditorPoint> | null): Readonly<EditorPoint> {
  const source = anchor || target?.anchor || target || {};
  return Object.freeze({
    x: Number.isFinite(Number(source.x)) ? Number(source.x) : 0,
    y: Number.isFinite(Number(source.y)) ? Number(source.y) : 0,
  });
}

function targetLayer(target: Extract<ColorTarget, { kind: 'shape' }>): EditorShapeLayer | null;
function targetLayer(target: Extract<ColorTarget, { kind: 'text' }>): EditorTextLayer | null;
function targetLayer(target: Extract<ColorTarget, { kind: 'effect' }>): EditorEffectLayer | null;
function targetLayer(target?: ColorTarget): EditorShapeLayer | EditorTextLayer | EditorEffectLayer | null;
function targetLayer(target: ColorTarget | undefined = current?.target): EditorShapeLayer | EditorTextLayer | EditorEffectLayer | null {
  if (!target || target.kind === 'toolbar') return null;
  const layer = getLayer(target.layerId);
  if (target.kind === 'shape') return layer?.type === 'shape' ? layer : null;
  if (target.kind === 'effect') return layer?.type === 'effect' ? layer : null;
  if (target.kind === 'text') return layer?.type === 'text' ? layer : null;
  return null;
}

function colorState(target: ColorTarget | undefined = current?.target): { color: string | null; mixed: boolean } {
  if (!target) return { color: null, mixed: false };
  if (target.kind === 'toolbar') {
    return { color: normalizedHex(get(paintColor)), mixed: false };
  }
  if (target.kind === 'shape') {
    const layer = targetLayer(target);
    if (!layer) return { color: null, mixed: false };
    return { color: normalizedHex(layer.shape?.fg) || '#ffffff', mixed: false };
  }
  if (target.kind === 'effect') {
    const layer = targetLayer(target);
    if (!layer || !layer.effect || layer.effect.kind !== 'solid-color') return { color: null, mixed: false };
    const color = isEffectColorTrackEnabled(target.layerId)
      ? effectColorAt(target.layerId, get(activeFrameIndex))
      : layer.effect.color;
    return { color: normalizedHex(color) || '#ffffff', mixed: false };
  }
  const layer = targetLayer(target);
  if (!layer) return { color: null, mixed: false };
  return textColorStateForSelection(layer, target.selection);
}

function publicTarget(target: ColorTarget | null): ColorTarget | null {
  if (!target) return null;
  if (target.kind !== 'text') return target;
  return Object.freeze({ ...target, selection: target.selection });
}

function publish(): void {
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

function rememberColor(color: string | null): void {
  if (!color) return;
  recentColors.update((colors) => [
    color,
    ...colors.filter((candidate) => candidate.toLowerCase() !== color),
  ].slice(0, 16));
}

function targetSnapshot(target: ColorTarget): string | TextColorSnapshot | null {
  if (target.kind === 'toolbar') return get(paintColor);
  if (target.kind === 'shape') return targetLayer(target)?.shape?.fg ?? null;
  if (target.kind === 'effect') {
    return colorState(target).color;
  }
  const layer = targetLayer(target);
  return layer ? {
    fg: layer.fg,
    runs: (layer.runs || []).map((run) => ({ ...run })),
  } : null;
}

function sameRuns(left: EditorTextRun[], right: EditorTextRun[]): boolean {
  return left.length === right.length && left.every((run, index) => {
    const other = right[index];
    return run.start === other!.start && run.end === other!.end && run.fg === other!.fg;
  });
}

function targetMatchesSnapshot(target: ColorTarget, snapshot: string | TextColorSnapshot | null): boolean {
  if (target.kind === 'toolbar') return get(paintColor) === snapshot;
  if (target.kind === 'shape') return targetLayer(target)?.shape?.fg === snapshot;
  if (target.kind === 'effect') {
    return colorState(target).color === snapshot;
  }
  const layer = targetLayer(target);
  if (!layer) return false;
  if (!snapshot || typeof snapshot === 'string') return false;
  return layer.fg === snapshot.fg && sameRuns(layer.runs || [], snapshot.runs);
}

function beginGesture(): void {
  if (current!.gesture) return;
  current!.gesture = { snapshot: targetSnapshot(current!.target) };
  if (current!.target.kind !== 'toolbar') beginStroke();
}

function restoreSamplingTool(): void {
  if (!current || current.phase !== 'sampling') return;
  const tool = current.samplingTool;
  current.phase = 'picker';
  current.samplingTool = null;
  activeTool.set(tool!);
}

function finishGesture(cancel = false): boolean {
  if (!current?.gesture) return false;
  const session = current;
  const target = session.target;
  const gesture = session.gesture!;
  if (target.kind === 'toolbar') {
    if (cancel && typeof gesture.snapshot === 'string') paintColor.set(gesture.snapshot);
  } else if (cancel || targetMatchesSnapshot(target, gesture.snapshot)) {
    cancelStroke();
  } else {
    endStroke();
  }
  session.gesture = null;
  if (current === session) publish();
  return true;
}

function abandonMissingTarget(): void {
  if (!current) return;
  // Preserve deletion; its undo entry also discards the uncommitted preview.
  if (current.gesture) endStroke();
  restoreSamplingTool();
  current = null;
  state.set(IDLE);
}

function abandonReplacedProject(): void {
  if (!current) return;
  restoreSamplingTool();
  current = null;
  state.set(IDLE);
}

function validate(): boolean {
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

function applyColor(color: string): boolean {
  const target = current!.target;
  if (target.kind === 'toolbar') {
    if (get(paintColor).toLowerCase() === color) return false;
    beginGesture();
    paintColor.set(color);
    return true;
  }
  const layer = targetLayer(target);
  if (target.kind === 'shape' && layer?.type === 'shape') {
    if ((layer.shape?.fg || '#ffffff').toLowerCase() === color) return false;
    beginGesture();
    setShapeLayerProperties(target.layerId, { fg: color }, renderShapeToCells);
    return true;
  }
  if (target.kind === 'effect' && layer?.type === 'effect') {
    if (layer.effect?.kind !== 'solid-color' || colorState(target).color === color) return false;
    beginGesture();
    if (isEffectColorTrackEnabled(target.layerId)) {
      setEffectColorKey(target.layerId, get(activeFrameIndex), color);
      return true;
    }
    setEffectProperties(target.layerId, { kind: 'solid-color', color });
    return true;
  }
  if (layer?.type !== 'text') return false;
  const textTarget = target as Extract<ColorTarget, { kind: 'text' }>;
  const patch = textColorPatchForSelection(layer, textTarget.selection, color);
  if (!patch) return false;
  beginGesture();
  updateTextLayer(textTarget.layerId, patch, renderTextToCells);
  return true;
}

function open(target: ColorOpenTarget, anchor: Partial<EditorPoint> | null = null): boolean {
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

function preview(value: string): boolean {
  const color = normalizedHex(value);
  if (!color || !validate()) return false;
  const changed = applyColor(color);
  publish();
  return changed;
}

function commit(value?: string | null): boolean {
  const color = normalizedHex(value);
  if (value != null && !color) return false;
  if (!validate()) return false;
  if (color) preview(color);
  const committed = current!.gesture !== null;
  const remembered = color || colorState().color;
  finishGesture(false);
  rememberColor(normalizedHex(remembered));
  restoreSamplingTool();
  publish();
  return committed;
}

function cancel(): boolean {
  if (!current) return false;
  const cancelled = finishGesture(true);
  restoreSamplingTool();
  publish();
  return cancelled;
}

function startSampling(): boolean {
  if (!validate()) return false;
  finishGesture(false);
  const session = current!;
  if (session.phase !== 'sampling') {
    session.samplingTool = get(activeTool);
    session.sampled = false;
    session.phase = 'sampling';
    activeTool.set('eyedropper');
  }
  publish();
  return true;
}

function sample(value: string): boolean {
  const color = normalizedHex(value);
  if (!color || !current || current.phase !== 'sampling' || !validate()) return false;
  current.sampled = true;
  return preview(color);
}

function finishSampling(): boolean {
  if (!current || current.phase !== 'sampling') return false;
  if (!current.sampled) return false;
  return commit();
}

function abort(): boolean {
  if (!current) return false;
  finishGesture(true);
  restoreSamplingTool();
  current = null;
  state.set(IDLE);
  return true;
}

function close(): boolean {
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
