import { writable } from 'svelte/store';
import { applyTextColor } from './textLayer.js';

export const textSelection = writable(null);

export function createTextInputHistory(limit = 64) {
  const capacity = Math.max(1, Math.floor(limit));
  let undo = [];
  let redo = [];

  const push = (stack, state) => {
    stack.push(state);
    if (stack.length > capacity) stack.shift();
  };
  const step = (source, target, current) => {
    const state = source.pop();
    if (!state) return null;
    push(target, current);
    return state;
  };

  return {
    reset() {
      undo = [];
      redo = [];
    },
    record(state) {
      push(undo, state);
      redo = [];
    },
    undo(current) {
      return step(undo, redo, current);
    },
    redo(current) {
      return step(redo, undo, current);
    },
  };
}

export function createControlledTextHistory(limit = 64) {
  const history = createTextInputHistory(limit);
  let before = null;

  return {
    reset() {
      history.reset();
      before = null;
    },
    beforeInput(event, state) {
      if (!event.inputType?.startsWith('history')) before = state;
    },
    input(changed) {
      if (before && changed) history.record(before);
      before = null;
    },
    keydown(event, current, restore) {
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const direction = ctrl && !event.shiftKey && key === 'z'
        ? 'undo'
        : ctrl && (key === 'y' || (event.shiftKey && key === 'z'))
          ? 'redo'
          : null;
      if (!direction) return false;
      const state = history[direction](current);
      if (!state) return false;
      event.preventDefault();
      event.stopPropagation();
      restore(state);
      return true;
    },
  };
}

export function textSelectionAfterEvent(previous, layerId, start, end, source = 'programmatic') {
  const from = Math.max(0, Math.round(Number(start)) || 0);
  const to = Math.max(from, Math.round(Number(end)) || 0);
  if (source === 'blur' && previous?.layerId === layerId) return previous;
  return { layerId, start: from, end: to };
}

export function rememberTextSelection(layerId, start, end, source = 'programmatic') {
  textSelection.update((previous) => textSelectionAfterEvent(
    previous,
    layerId,
    start,
    end,
    source,
  ));
}

export function textSelectionForLayer(selection, layerId) {
  if (layerId == null || !selection || selection.layerId !== layerId) return null;
  return {
    layerId,
    start: selection.start,
    end: selection.end,
  };
}

export function clearTextSelection(layerId = null) {
  textSelection.update((selection) => (
    layerId == null || selection?.layerId === layerId ? null : selection
  ));
}

export function textColorStateForSelection(layer, selection) {
  const base = (layer?.fg || '#ffffff').toLowerCase();
  const active = selection?.layerId === layer?.id ? selection : null;
  if (!active || active.start >= active.end) return { color: base, mixed: false };

  const length = String(layer.text || '').length;
  const start = Math.max(0, Math.min(length, active.start));
  const end = Math.max(start, Math.min(length, active.end));
  if (start === end) return { color: base, mixed: false };

  const colors = new Set();
  let cursor = start;
  const runs = [...(layer.runs || [])].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const run of runs) {
    const runStart = Math.max(start, run.start);
    const runEnd = Math.min(end, run.end);
    if (runEnd <= runStart) continue;
    if (runStart > cursor) colors.add(base);
    colors.add((run.fg || base).toLowerCase());
    cursor = Math.max(cursor, runEnd);
  }
  if (cursor < end) colors.add(base);

  const [color = base] = colors;
  return { color, mixed: colors.size > 1 };
}

function runsEqual(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  return left.length === right.length && left.every((run, index) => {
    const other = right[index];
    return run.start === other.start && run.end === other.end && run.fg === other.fg;
  });
}

export function textColorPatchForSelection(layer, selection, color) {
  if (!layer || !/^#[0-9a-f]{6}$/i.test(color || '')) return null;
  const normalized = color.toLowerCase();
  const activeSelection = selection?.layerId === layer.id ? selection : null;
  if (activeSelection && activeSelection.start < activeSelection.end) {
    const runs = applyTextColor(
      layer.runs || [],
      activeSelection.start,
      activeSelection.end,
      normalized,
      layer.text || '',
      layer.fg,
    );
    return runsEqual(runs, layer.runs) ? null : { runs };
  }
  if ((layer.fg || '#ffffff').toLowerCase() === normalized && !(layer.runs || []).length) {
    return null;
  }
  return { fg: normalized, runs: [] };
}
