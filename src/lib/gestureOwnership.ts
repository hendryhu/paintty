interface GestureContext {
  layerId?: string | null | undefined;
  frameIndex?: number | undefined;
  tool?: string | null | undefined;
  layerPart?: string | undefined;
  projectRevision?: number | undefined;
}

export interface GestureOwner {
  layerId: string | null;
  frameIndex: number;
  tool: string | null;
  layerPart: string;
  projectRevision: number;
  pointerId: number | null;
}

const CONTEXT_FIELDS: ReadonlyArray<keyof GestureContext> = [
  'layerId',
  'frameIndex',
  'tool',
  'layerPart',
  'projectRevision',
];

// Pointer identity alone is insufficient: every mutating gesture owns the project,
// layer, frame, tool, and layer part it started against.
export function captureGestureOwner(context: GestureContext | null | undefined, pointerId: number | null = null): Readonly<GestureOwner> {
  return Object.freeze({
    layerId: context?.layerId ?? null,
    frameIndex: context?.frameIndex ?? 0,
    tool: context?.tool ?? null,
    layerPart: context?.layerPart ?? 'layer',
    projectRevision: context?.projectRevision ?? 0,
    pointerId,
  });
}

export function gestureOwnerMatches(owner: GestureOwner | null | undefined, context: GestureContext | null | undefined): boolean {
  return !!owner && CONTEXT_FIELDS.every((field) => owner[field] === context?.[field]);
}

export function gesturePointerMatches(owner: GestureOwner | null | undefined, pointerId: number | null): boolean {
  return !!owner && (pointerId == null || owner.pointerId == null || owner.pointerId === pointerId);
}

export function canvasPointerStartsPan(spaceHeld: boolean, button: number): boolean {
  return !!spaceHeld || button === 1;
}

export function canvasEscapeAction({
  hasPointerGesture,
  hasSelectionMenu,
}: { hasPointerGesture?: boolean; hasSelectionMenu?: boolean } = {}): 'cancel-pointer' | 'close-selection-menu' | null {
  if (hasPointerGesture) return 'cancel-pointer';
  if (hasSelectionMenu) return 'close-selection-menu';
  return null;
}

export function moveToolChangeAction({
  hasMoveState,
  tool,
  pointerOwnsMoveState = false,
  windowOwnsMoveState = false,
}: {
  hasMoveState: boolean;
  tool: string;
  pointerOwnsMoveState?: boolean;
  windowOwnsMoveState?: boolean;
}): 'cancel-pointer' | 'cancel-window' | 'finalize' | null {
  if (!hasMoveState || tool === 'select' || tool === 'move') return null;
  if (pointerOwnsMoveState) return 'cancel-pointer';
  if (windowOwnsMoveState) return 'cancel-window';
  return 'finalize';
}
