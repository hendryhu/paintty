import type {
  EditorBounds,
  EditorCellGrid,
  EditorLayerPart,
  EditorPoint,
  EditorTextRun,
  EditorTool,
} from './editor-domain.js';
import type { GestureOwner } from '../gestureOwnership.js';
import type { captureRasterBodyDrag } from '../rasterBodyDrag.js';
import type { captureShapeBodyDrag } from '../shapeBodyDrag.js';

export interface GlyphMenuDetail extends EditorPoint {
  ch: string;
}

export interface SketchOpenDetail {
  top: number;
}

export interface CanvasProps {
  onpointerdown?: ((event: PointerEvent) => void) | undefined;
}

export interface CharPickerProps {
  onGlyphMenu?: ((detail: GlyphMenuDetail) => void) | undefined;
  onSketch?: ((detail: SketchOpenDetail) => void) | undefined;
}

export interface ColorPickerProps {
  value?: string | undefined;
  recent?: readonly string[] | undefined;
  x?: number | undefined;
  y?: number | undefined;
  showEyedropper?: boolean | undefined;
  onChange?: ((hex: string) => void) | undefined;
  onCommit?: ((hex: string) => void) | undefined;
  onGestureCancel?: (() => void) | undefined;
  onEyedropper?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
}

export interface SketchPopupProps {
  top?: number | undefined;
  rightPanelLeft?: number | undefined;
  onGlyphMenu?: ((detail: GlyphMenuDetail) => void) | undefined;
  onClose?: (() => void) | undefined;
}

export interface GlyphContextMenuProps {
  x?: number | undefined;
  y?: number | undefined;
  ch?: string | undefined;
  onClose?: (() => void) | undefined;
}

export interface CanvasViewport extends EditorBounds {}

export interface CanvasBackingLayout {
  resized: boolean;
  cssWidth: number;
  cssHeight: number;
  width: number;
  height: number;
}

export interface CanvasOwnershipContext {
  layerId: string | null;
  frameIndex: number;
  tool: EditorTool;
  layerPart: EditorLayerPart;
  projectRevision: number;
}

export type CanvasPointerGestureKind =
  | 'selection-move'
  | 'layer-move'
  | 'text'
  | 'shape-create'
  | 'select'
  | 'paint';

export interface CanvasPointerGesture {
  kind: CanvasPointerGestureKind;
  owner: Readonly<GestureOwner>;
  historyOpen: boolean;
  ownsMoveState: boolean;
  freshPaintOwner: boolean;
  freshPaintOwnerId: string | null;
  contentMutated: boolean;
}

export interface StartPointerGestureOptions {
  owner?: Partial<CanvasOwnershipContext> | undefined;
  historyOpen?: boolean | undefined;
  ownsMoveState?: boolean | undefined;
  freshPaintOwnerId?: string | null | undefined;
}

export interface CanvasShapeDrag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface CanvasSelectionRect extends CanvasShapeDrag {}

export type CanvasSelectionAction = 'move' | 'copy' | 'cut' | 'deselect';

export interface CanvasMoveAnchor extends EditorPoint {
  dx0: number;
  dy0: number;
}

export type RasterBodyDrag = NonNullable<ReturnType<typeof captureRasterBodyDrag>>;
export type ShapeBodyDrag = NonNullable<ReturnType<typeof captureShapeBodyDrag>>;

export interface CanvasOffsetDrag extends EditorPoint {
  startX: number;
  startY: number;
  o0: EditorPoint;
  animatePosition: boolean;
  isMask: boolean;
  rasterDrag: RasterBodyDrag | null;
  shapeDrag: ShapeBodyDrag | null;
  isCell: boolean;
  type: string | null;
  dx: number;
  dy: number;
  lastDx: number;
  lastDy: number;
  box0: EditorBounds | null;
}

export interface CanvasTextEdit {
  layerId: string;
  box: EditorBounds;
  wrap: boolean;
  created: boolean;
  historyOpen: boolean;
  sessionId: number;
}

export interface CanvasTextInputState {
  text: string;
  runs: EditorTextRun[];
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
}

export interface CanvasHover extends EditorPoint {
  char: string;
}

export interface CanvasOnionGhost {
  cells: EditorCellGrid;
  direction: 'previous' | 'next';
  alpha: number;
}

export interface CanvasImageGizmo {
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
  rot: number;
}

export interface ShapeGeometryHover {
  layerId: string;
  componentId?: string | undefined;
}

export interface WindowDragOptions {
  owned?: boolean | undefined;
  owner?: Readonly<GestureOwner> | undefined;
  cancel?: (() => void) | undefined;
  ownsMoveState?: boolean | undefined;
}

export type WindowDragStop = (cancelled?: boolean, event?: PointerEvent | null) => void;

export interface SketchPoint extends EditorPoint {}

export interface CustomGlyphInputState {
  value: string;
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
}

export interface NumberFieldDetail {
  value: number;
  source: string;
}
