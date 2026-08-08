const KEY_FRAME_FIELDS = {
  position: 'keyFrames',
  visibility: 'visibilityKeyFrames',
  intensity: 'effectIntensityKeyFrames',
  'mask-opacity': 'maskOpacityKeyFrames',
  'mask-position': 'maskPositionKeyFrames',
  'shape-path': 'shapePathKeyFrames',
};

const KEYBOARD_CONTEXTS = new Set(['canvas', 'timeline', 'layers']);
const NEUTRAL_KEYBOARD_CONTEXT = 'neutral';
let lastKeyboardContext = null;

function keyboardContextMarkerForTarget(target) {
  const marker = target?.closest?.('[data-keyboard-context]');
  return marker?.getAttribute?.('data-keyboard-context') || null;
}

function keyboardContextForTarget(target) {
  const context = keyboardContextMarkerForTarget(target);
  return KEYBOARD_CONTEXTS.has(context) ? context : null;
}

export function noteKeyboardContext(event, activeElement = globalThis.document?.activeElement) {
  const markerContext = keyboardContextMarkerForTarget(event?.target);
  const nextContext = isEditingTarget(event?.target)
    ? null
    : markerContext === NEUTRAL_KEYBOARD_CONTEXT
      ? lastKeyboardContext
      : KEYBOARD_CONTEXTS.has(markerContext) ? markerContext : null;
  const focusedContext = keyboardContextForTarget(activeElement);
  if (focusedContext && focusedContext !== nextContext) activeElement?.blur?.();
  return setKeyboardContext(nextContext);
}

export function setKeyboardContext(context) {
  lastKeyboardContext = KEYBOARD_CONTEXTS.has(context) ? context : null;
  return lastKeyboardContext;
}

export function getKeyboardContext() {
  return lastKeyboardContext;
}

export function releaseKeyboardContext(context = null, activeElement = globalThis.document?.activeElement) {
  if (context != null && lastKeyboardContext !== context) return lastKeyboardContext;
  const focusedContext = keyboardContextForTarget(activeElement);
  if (focusedContext && (context == null || focusedContext === context)) activeElement?.blur?.();
  lastKeyboardContext = null;
  return lastKeyboardContext;
}

export function resetKeyboardContext() {
  releaseKeyboardContext();
}

export function keyboardContextOwns(context, event) {
  if (event?.defaultPrevented || !KEYBOARD_CONTEXTS.has(context)) return false;
  return lastKeyboardContext === context;
}

export function planSelectionDeselect(event, state = {}) {
  const shortcut = Boolean(event?.ctrlKey || event?.metaKey) &&
    !event?.altKey && !event?.shiftKey && event?.key?.toLowerCase() === 'd';
  if (!shortcut || event?.defaultPrevented || state.typing || state.popupOpen) {
    return { handled: false, context: null };
  }
  return {
    handled: true,
    context: KEYBOARD_CONTEXTS.has(state.context) ? state.context : null,
  };
}

export function keyboardDeleteAction(context, state = {}) {
  if (state.editing || state.playing) return null;
  if (context === 'layers') return state.activeLayerId != null && state.selectedLayerCount > 0
    ? 'layer'
    : null;
  return null;
}

export function timelineKeyTargetsMask(kind) {
  return kind === 'mask-position' || kind === 'mask-opacity';
}

export function timelineKeyPasteCompatible(payload, kind, shapeKind = null) {
  if (!payload || payload.type !== kind) return false;
  if (kind !== 'shape-path') return true;
  return typeof shapeKind === 'string' && payload.shapeKind === shapeKind;
}

export function keyFramesForRow(row, kind) {
  const frames = row?.[KEY_FRAME_FIELDS[kind]];
  return Array.isArray(frames) ? frames : [];
}

export function timelineKeyTrackAvailable(row, kind, editingMask = false) {
  if (!row) return false;
  if (kind === 'position') return !editingMask && keyFramesForRow(row, kind).length > 0;
  if (kind === 'mask-position') return editingMask && !!row.maskPositionTrackEnabled;
  if (kind === 'visibility') return !editingMask && !!row.visibilityTrackEnabled;
  if (kind === 'intensity') return !editingMask && !!row.effectIntensityTrackEnabled;
  if (kind === 'mask-opacity') return editingMask && !!row.maskOpacityTrackEnabled;
  if (kind === 'shape-path') {
    return !editingMask && row.type === 'shape' && !!row.shapePathTrackEnabled;
  }
  return false;
}

export function timelineContainsTarget(container, target) {
  return !!container && !!target && typeof target.nodeType === 'number' && container.contains(target);
}

export function isEditingTarget(target) {
  if (target?.closest?.('textarea, select, [contenteditable="true"]')) return true;
  const input = target?.closest?.('input');
  if (!input) return false;
  return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(input.type);
}

export function isPlaybackShortcut(event, typing = false, context = null) {
  if (typing || event?.defaultPrevented || event?.repeat ||
    event?.ctrlKey || event?.altKey || event?.metaKey) return false;
  if (event?.key?.toLowerCase() === 'k') return true;
  return context === 'timeline' && !event?.shiftKey &&
    (event?.code === 'Space' || event?.key === ' ');
}

export function newProjectShortcutAction(event, state = {}) {
  const command = !!(event?.ctrlKey || event?.metaKey)
    && !event?.altKey
    && !event?.shiftKey
    && event?.key?.toLowerCase() === 'n';
  if (!command) return null;
  if (event.repeat || state.typing || state.modalOpen || state.gestureActive) return 'suppress';
  return 'open';
}

export function editorModalOpen(state = {}) {
  return !!(state.exportOpen || state.prefsOpen || state.assetsOpen || state.helperOpen ||
    state.helpOpen || state.convertOpen || state.newProjectOpen || state.projectSettingsOpen ||
    state.discardOpen);
}

export function editorEscapeAction(state = {}) {
  if (state.menuOpen) return 'menu';
  if (state.sketchOpen) return 'sketch';
  if (state.colorEditActive) return 'color';
  if (state.typing) return null;
  if (state.moveActive) return 'move';
  if (state.activeTool === 'crop' && state.cropPending) return 'crop';
  return null;
}

export function selectTimelineKey(selection, anchor, row, kind, frame, modifiers = {}) {
  const sameTrack = selection.layerId === row.id && selection.kind === kind;
  let frames = sameTrack ? new Set(selection.frames) : new Set();
  let nextAnchor = anchor;

  if (modifiers.shiftKey && anchor?.layerId === row.id && anchor.kind === kind) {
    const lower = Math.min(anchor.frame, frame);
    const upper = Math.max(anchor.frame, frame);
    frames = new Set(keyFramesForRow(row, kind)
      .filter((keyFrame) => keyFrame >= lower && keyFrame <= upper));
  } else if (modifiers.ctrlKey || modifiers.metaKey) {
    if (frames.has(frame)) frames.delete(frame);
    else frames.add(frame);
    nextAnchor = { layerId: row.id, kind, frame };
  } else if (!sameTrack || !frames.has(frame)) {
    frames = new Set([frame]);
    nextAnchor = { layerId: row.id, kind, frame };
  }

  return {
    selection: frames.size
      ? { layerId: row.id, kind, frames }
      : { layerId: null, kind: null, frames: new Set() },
    anchor: nextAnchor,
  };
}

function motionKeyIdentity(key, property = false) {
  return property
    ? `${String(key.clipId)}\u0000${String(key.propertyName)}\u0000${Number(key.sourceTick)}`
    : `${String(key.clipId)}\u0000${Number(key.sourceTick)}`;
}

function cloneMotionSelection(selection = {}) {
  return {
    clipIds: new Set(selection.clipIds || []),
    frameKeys: (selection.frameKeys || []).map((key) => ({ ...key })),
    propertyKeys: (selection.propertyKeys || []).map((key) => ({ ...key })),
    trackHeaderIds: new Set(selection.trackHeaderIds || []),
    gap: selection.gap ? { ...selection.gap, trackIds: [...(selection.gap.trackIds || [])] } : null,
    rulerRange: selection.rulerRange ? { ...selection.rulerRange } : null,
  };
}

export function planTimelineKeyMotion(state, selection, requestedDeltaTicks) {
  const clips = new Map((state?.clips || []).map((clip) => [String(clip.id), clip]));
  const tracks = new Map((state?.tracks || []).map((track) => [String(track.id), track]));
  const requested = Math.round(Number(requestedDeltaTicks) || 0);
  const sourceFrameKeys = selection?.frameKeys || [];
  const sourcePropertyKeys = selection?.propertyKeys || [];
  const moves = [];
  const seen = new Set();
  let minimumDelta = -Infinity;
  let maximumDelta = Infinity;

  function addMove(key, property) {
    const clip = clips.get(String(key?.clipId));
    const sourceTick = Number(key?.sourceTick);
    const propertyName = property ? String(key?.propertyName || '') : null;
    const keys = property ? clip?.propertyTracks?.[propertyName] : clip?.frameKeys;
    const identity = motionKeyIdentity(key, property);
    if (seen.has(`${property ? 'p' : 'f'}\u0000${identity}`)) return true;
    if (!clip || !Number.isInteger(sourceTick) ||
      !keys?.some((entry) => Number(entry.tick) === sourceTick)) return false;
    const track = tracks.get(String(clip.trackId));
    if (!track || track.locked) return false;
    seen.add(`${property ? 'p' : 'f'}\u0000${identity}`);
    minimumDelta = Math.max(minimumDelta, Number(clip.inTick) - sourceTick);
    maximumDelta = Math.min(maximumDelta, Number(clip.outTick) - 1 - sourceTick);
    moves.push({
      kind: property ? 'property' : 'frame',
      clipId: String(clip.id),
      propertyName,
      sourceTick,
      projectTick: Number(clip.startTick) + sourceTick - Number(clip.inTick),
      keys,
      clip,
    });
    return true;
  }

  for (const key of sourceFrameKeys) {
    if (!addMove(key, false)) return { valid: false, changed: false, reason: 'missing-or-locked-key', deltaTicks: 0, moves: [] };
  }
  for (const key of sourcePropertyKeys) {
    if (!addMove(key, true)) return { valid: false, changed: false, reason: 'missing-or-locked-key', deltaTicks: 0, moves: [] };
  }
  if (!moves.length) {
    return { valid: false, changed: false, reason: 'missing-key-selection', deltaTicks: 0, moves: [] };
  }

  // One shared clamp preserves mixed-key spacing; collision checks then treat the move atomically.
  const deltaTicks = Math.max(minimumDelta, Math.min(maximumDelta, requested));
  const selectedByTrack = new Map();
  for (const move of moves) {
    const trackKey = `${move.kind}\u0000${move.clipId}\u0000${move.propertyName || ''}`;
    const selected = selectedByTrack.get(trackKey) || new Set();
    selected.add(move.sourceTick);
    selectedByTrack.set(trackKey, selected);
  }
  const previewMoves = moves.map((move) => ({
    kind: move.kind,
    clipId: move.clipId,
    ...(move.propertyName ? { propertyName: move.propertyName } : {}),
    sourceTick: move.sourceTick,
    destinationSourceTick: move.sourceTick + deltaTicks,
    projectTick: move.projectTick,
    destinationProjectTick: move.projectTick + deltaTicks,
  }));

  for (const move of moves) {
    const trackKey = `${move.kind}\u0000${move.clipId}\u0000${move.propertyName || ''}`;
    const selected = selectedByTrack.get(trackKey);
    const destination = move.sourceTick + deltaTicks;
    if (move.keys.some((key) => Number(key.tick) === destination && !selected.has(destination))) {
      return {
        valid: false,
        changed: false,
        reason: 'key-collision',
        deltaTicks,
        moves: previewMoves,
      };
    }
  }

  const nextSelection = cloneMotionSelection(selection);
  nextSelection.frameKeys = previewMoves
    .filter((move) => move.kind === 'frame')
    .map((move) => ({ clipId: move.clipId, sourceTick: move.destinationSourceTick }));
  nextSelection.propertyKeys = previewMoves
    .filter((move) => move.kind === 'property')
    .map((move) => ({
      clipId: move.clipId,
      propertyName: move.propertyName,
      sourceTick: move.destinationSourceTick,
    }));
  return {
    valid: true,
    changed: deltaTicks !== 0,
    reason: deltaTicks ? null : 'unchanged',
    requestedDeltaTicks: requested,
    deltaTicks,
    moves: previewMoves,
    selection: nextSelection,
  };
}
