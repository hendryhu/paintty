import type {
  ClipTimelineSelection,
  ClipTimelineState,
  TimelineFrameKeyMove,
  TimelineKeyMotionPlan,
  TimelineKeyMove,
  TimelinePropertyKeyMove,
} from './types/timeline-models.js';
import type {
  TimelineKeyboardEventLike,
  TimelineModifierState,
  TimelineRowModel,
} from './types/timeline-ui.js';

type TimelineKeyboardContext = 'canvas' | 'timeline' | 'layers';
type TimelineKeyTrackKind =
  | 'position'
  | 'visibility'
  | 'intensity'
  | 'mask-opacity'
  | 'mask-position'
  | 'shape-path';

interface ClosestTarget {
  closest(selector: string): ClosestTarget | null;
  getAttribute?(name: string): string | null;
  type?: string;
}

interface TimelineContextEvent extends Omit<TimelineKeyboardEventLike, 'target'> {
  target?: ClosestTarget | null;
}

interface LegacyKeySelection {
  layerId: string | null;
  kind: TimelineKeyTrackKind | null;
  frames: Set<number>;
}

interface LegacyKeyAnchor {
  layerId: string;
  kind: TimelineKeyTrackKind;
  frame: number;
}

const KEY_FRAME_FIELDS: Record<TimelineKeyTrackKind, keyof TimelineRowModel> = {
  position: 'keyFrames',
  visibility: 'visibilityKeyFrames',
  intensity: 'effectIntensityKeyFrames',
  'mask-opacity': 'maskOpacityKeyFrames',
  'mask-position': 'maskPositionKeyFrames',
  'shape-path': 'shapePathKeyFrames',
};

const KEYBOARD_CONTEXTS: ReadonlySet<TimelineKeyboardContext> = new Set([
  'canvas', 'timeline', 'layers',
]);
const NEUTRAL_KEYBOARD_CONTEXT = 'neutral';
let lastKeyboardContext: TimelineKeyboardContext | null = null;

function closestTarget(value: unknown): value is ClosestTarget {
  return value !== null && typeof value === 'object' &&
    'closest' in value && typeof value.closest === 'function';
}

function isKeyboardContext(value: unknown): value is TimelineKeyboardContext {
  return value === 'canvas' || value === 'timeline' || value === 'layers';
}

function blurElement(value: unknown): void {
  if (value !== null && typeof value === 'object' && 'blur' in value &&
    typeof value.blur === 'function') value.blur();
}

function keyboardContextMarkerForTarget(target: unknown): string | null {
  if (!closestTarget(target)) return null;
  const marker = target?.closest?.('[data-keyboard-context]');
  return marker?.getAttribute?.('data-keyboard-context') || null;
}

function keyboardContextForTarget(target: unknown): TimelineKeyboardContext | null {
  const context = keyboardContextMarkerForTarget(target);
  return isKeyboardContext(context) ? context : null;
}

export function noteKeyboardContext(
  event: TimelineContextEvent,
  activeElement: Element | null | undefined = globalThis.document?.activeElement,
) {
  const markerContext = keyboardContextMarkerForTarget(event?.target);
  const nextContext = isEditingTarget(event?.target)
    ? null
    : markerContext === NEUTRAL_KEYBOARD_CONTEXT
      ? lastKeyboardContext
      : isKeyboardContext(markerContext) ? markerContext : null;
  const focusedContext = keyboardContextForTarget(activeElement);
  if (focusedContext && focusedContext !== nextContext) blurElement(activeElement);
  return setKeyboardContext(nextContext);
}

export function setKeyboardContext(context: unknown): TimelineKeyboardContext | null {
  lastKeyboardContext = isKeyboardContext(context) ? context : null;
  return lastKeyboardContext;
}

export function getKeyboardContext() {
  return lastKeyboardContext;
}

export function releaseKeyboardContext(
  context: TimelineKeyboardContext | null = null,
  activeElement: Element | null | undefined = globalThis.document?.activeElement,
) {
  if (context != null && lastKeyboardContext !== context) return lastKeyboardContext;
  const focusedContext = keyboardContextForTarget(activeElement);
  if (focusedContext && (context == null || focusedContext === context)) blurElement(activeElement);
  lastKeyboardContext = null;
  return lastKeyboardContext;
}

export function resetKeyboardContext() {
  releaseKeyboardContext();
}

export function keyboardContextOwns(context: unknown, event: TimelineKeyboardEventLike): boolean {
  if (event?.defaultPrevented || !isKeyboardContext(context)) return false;
  return lastKeyboardContext === context;
}

export function planSelectionDeselect(
  event: TimelineKeyboardEventLike,
  state: { typing?: boolean; popupOpen?: boolean; context?: unknown } = {},
) {
  const shortcut = Boolean(event?.ctrlKey || event?.metaKey) &&
    !event?.altKey && !event?.shiftKey && event?.key?.toLowerCase() === 'd';
  if (!shortcut || event?.defaultPrevented || state.typing || state.popupOpen) {
    return { handled: false, context: null };
  }
  return {
    handled: true,
    context: isKeyboardContext(state.context) ? state.context : null,
  };
}

export function keyboardDeleteAction(
  context: unknown,
  state: {
    editing?: boolean;
    playing?: boolean;
    activeLayerId?: unknown;
    selectedLayerCount?: number;
  } = {},
): 'layer' | null {
  if (state.editing || state.playing) return null;
  if (context === 'layers') return state.activeLayerId != null && (state.selectedLayerCount ?? 0) > 0
    ? 'layer'
    : null;
  return null;
}

export function timelineKeyTargetsMask(kind: unknown): boolean {
  return kind === 'mask-position' || kind === 'mask-opacity';
}

export function timelineKeyPasteCompatible(
  payload: unknown,
  kind: TimelineKeyTrackKind,
  shapeKind: string | null = null,
): boolean {
  if (!payload || typeof payload !== 'object' || !('type' in payload) || payload.type !== kind) {
    return false;
  }
  if (kind !== 'shape-path') return true;
  return typeof shapeKind === 'string' && 'shapeKind' in payload && payload.shapeKind === shapeKind;
}

export function keyFramesForRow(row: TimelineRowModel | null | undefined, kind: TimelineKeyTrackKind): number[] {
  const frames = row?.[KEY_FRAME_FIELDS[kind]];
  return Array.isArray(frames) ? frames : [];
}

export function timelineKeyTrackAvailable(
  row: TimelineRowModel | null | undefined,
  kind: TimelineKeyTrackKind,
  editingMask = false,
): boolean {
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

export function timelineContainsTarget(
  container: Node | null | undefined,
  target: Node | null | undefined,
): boolean {
  return !!container && !!target && typeof target.nodeType === 'number' && container.contains(target);
}

export function isEditingTarget(target: unknown): boolean {
  if (!closestTarget(target)) return false;
  if (target?.closest?.('textarea, select, [contenteditable="true"]')) return true;
  const input = target?.closest?.('input');
  if (!input) return false;
  return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(input.type ?? '');
}

export function isPlaybackShortcut(
  event: TimelineKeyboardEventLike,
  typing = false,
  context: TimelineKeyboardContext | null = null,
): boolean {
  if (typing || event?.defaultPrevented || event?.repeat ||
    event?.ctrlKey || event?.altKey || event?.metaKey) return false;
  if (context !== 'timeline' || event?.shiftKey) return false;
  if (event?.key?.toLowerCase() === 'k') return true;
  return event?.code === 'Space' || event?.key === ' ';
}

export function newProjectShortcutAction(
  event: TimelineKeyboardEventLike,
  state: { typing?: boolean; modalOpen?: boolean; gestureActive?: boolean } = {},
): 'suppress' | 'open' | null {
  const command = !!(event?.ctrlKey || event?.metaKey)
    && !event?.altKey
    && !event?.shiftKey
    && event?.key?.toLowerCase() === 'n';
  if (!command) return null;
  if (event.repeat || state.typing || state.modalOpen || state.gestureActive) return 'suppress';
  return 'open';
}

export function editorModalOpen(state: {
  exportOpen?: boolean;
  prefsOpen?: boolean;
  assetsOpen?: boolean;
  helperOpen?: boolean;
  helpOpen?: boolean;
  convertOpen?: boolean;
  newProjectOpen?: boolean;
  projectSettingsOpen?: boolean;
  discardOpen?: boolean;
} = {}): boolean {
  return !!(state.exportOpen || state.prefsOpen || state.assetsOpen || state.helperOpen ||
    state.helpOpen || state.convertOpen || state.newProjectOpen || state.projectSettingsOpen ||
    state.discardOpen);
}

export function editorEscapeAction(state: {
  menuOpen?: boolean;
  sketchOpen?: boolean;
  colorEditActive?: boolean;
  typing?: boolean;
  moveActive?: boolean;
  activeTool?: unknown;
  cropPending?: boolean;
} = {}): 'menu' | 'sketch' | 'color' | 'move' | 'crop' | null {
  if (state.menuOpen) return 'menu';
  if (state.sketchOpen) return 'sketch';
  if (state.colorEditActive) return 'color';
  if (state.typing) return null;
  if (state.moveActive) return 'move';
  if (state.activeTool === 'crop' && state.cropPending) return 'crop';
  return null;
}

export function selectTimelineKey(
  selection: LegacyKeySelection,
  anchor: LegacyKeyAnchor | null,
  row: TimelineRowModel,
  kind: TimelineKeyTrackKind,
  frame: number,
  modifiers: TimelineModifierState = {},
): { selection: LegacyKeySelection; anchor: LegacyKeyAnchor | null } {
  const sameTrack = selection.layerId === row.id && selection.kind === kind;
  let frames = sameTrack ? new Set(selection.frames) : new Set<number>();
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

function motionKeyIdentity(
  key: { clipId: string; sourceTick: number; propertyName?: string },
  property = false,
): string {
  return property
    ? `${String(key.clipId)}\u0000${String(key.propertyName)}\u0000${Number(key.sourceTick)}`
    : `${String(key.clipId)}\u0000${Number(key.sourceTick)}`;
}

function cloneMotionSelection(selection: ClipTimelineSelection): ClipTimelineSelection {
  return {
    clipIds: new Set(selection.clipIds || []),
    frameKeys: (selection.frameKeys || []).map((key) => ({ ...key })),
    propertyKeys: (selection.propertyKeys || []).map((key) => ({ ...key })),
    trackHeaderIds: new Set(selection.trackHeaderIds || []),
    gap: selection.gap ? { ...selection.gap, trackIds: [...(selection.gap.trackIds || [])] } : null,
    rulerRange: selection.rulerRange ? { ...selection.rulerRange } : null,
  };
}

export function planTimelineKeyMotion(
  state: ClipTimelineState,
  selection: ClipTimelineSelection,
  requestedDeltaTicks: unknown,
): TimelineKeyMotionPlan {
  const clips = new Map((state?.clips || []).map((clip) => [String(clip.id), clip]));
  const tracks = new Map((state?.tracks || []).map((track) => [String(track.id), track]));
  const requested = Math.round(Number(requestedDeltaTicks) || 0);
  const sourceFrameKeys = selection?.frameKeys || [];
  const sourcePropertyKeys = selection?.propertyKeys || [];
  const moves: Array<{
    kind: 'frame' | 'property';
    clipId: string;
    propertyName: string | null;
    sourceTick: number;
    projectTick: number;
    keys: import('./types/timeline-models.js').TimelineStoredKey[];
  }> = [];
  const seen = new Set();
  let minimumDelta = -Infinity;
  let maximumDelta = Infinity;

  function addMove(
    key: { clipId: string; sourceTick: number; propertyName?: string },
    property: boolean,
  ): boolean {
    const clip = clips.get(String(key?.clipId));
    const sourceTick = Number(key?.sourceTick);
    const propertyName = property ? String(key?.propertyName || '') : null;
    const keys = property && propertyName
      ? clip?.propertyTracks?.[propertyName]
      : clip?.frameKeys;
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
  const selectedByTrack = new Map<string, Set<number>>();
  for (const move of moves) {
    const trackKey = `${move.kind}\u0000${move.clipId}\u0000${move.propertyName || ''}`;
    const selected = selectedByTrack.get(trackKey) || new Set<number>();
    selected.add(move.sourceTick);
    selectedByTrack.set(trackKey, selected);
  }
  const previewMoves: TimelineKeyMove[] = moves.map((move): TimelineKeyMove => {
    const common = {
      clipId: move.clipId,
      sourceTick: move.sourceTick,
      destinationSourceTick: move.sourceTick + deltaTicks,
      projectTick: move.projectTick,
      destinationProjectTick: move.projectTick + deltaTicks,
    };
    return move.kind === 'property' && move.propertyName
      ? { ...common, kind: 'property', propertyName: move.propertyName } satisfies TimelinePropertyKeyMove
      : { ...common, kind: 'frame' } satisfies TimelineFrameKeyMove;
  });

  for (const move of moves) {
    const trackKey = `${move.kind}\u0000${move.clipId}\u0000${move.propertyName || ''}`;
    const selected = selectedByTrack.get(trackKey);
    const destination = move.sourceTick + deltaTicks;
    if (move.keys.some((key) => Number(key.tick) === destination && !selected?.has(destination))) {
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
