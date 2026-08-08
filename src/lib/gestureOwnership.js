const CONTEXT_FIELDS = [
  'layerId',
  'frameIndex',
  'tool',
  'layerPart',
  'projectRevision',
];

// Pointer identity alone is insufficient: every mutating gesture owns the project,
// layer, frame, tool, and layer part it started against.
export function captureGestureOwner(context, pointerId = null) {
  return Object.freeze({
    layerId: context?.layerId ?? null,
    frameIndex: context?.frameIndex ?? 0,
    tool: context?.tool ?? null,
    layerPart: context?.layerPart ?? 'layer',
    projectRevision: context?.projectRevision ?? 0,
    pointerId,
  });
}

export function gestureOwnerMatches(owner, context) {
  return !!owner && CONTEXT_FIELDS.every((field) => owner[field] === context?.[field]);
}

export function gesturePointerMatches(owner, pointerId) {
  return !!owner && (pointerId == null || owner.pointerId == null || owner.pointerId === pointerId);
}

export function canvasPointerStartsPan(spaceHeld, button) {
  return !!spaceHeld || button === 1;
}

export function canvasEscapeAction({ hasPointerGesture, hasSelectionMenu } = {}) {
  if (hasPointerGesture) return 'cancel-pointer';
  if (hasSelectionMenu) return 'close-selection-menu';
  return null;
}

export function moveToolChangeAction({
  hasMoveState,
  tool,
  pointerOwnsMoveState = false,
  windowOwnsMoveState = false,
}) {
  if (!hasMoveState || tool === 'select' || tool === 'move') return null;
  if (pointerOwnsMoveState) return 'cancel-pointer';
  if (windowOwnsMoveState) return 'cancel-window';
  return 'finalize';
}
