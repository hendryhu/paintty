export interface EditorPoint {
  x: number;
  y: number;
}

export interface EditorSize {
  w: number;
  h: number;
}

export interface EditorBounds extends EditorPoint, EditorSize {}

export interface EditorCell {
  c?: string | undefined;
  fg?: string | null | undefined;
  bg?: string | null | undefined;
  cont?: boolean | undefined;
  blink?: boolean | undefined;
  offCanvas?: boolean | undefined;
  mask?: number | undefined;
}

export type EditorCellValue = EditorCell | null | undefined;
export type EditorCellMap = Record<string, EditorCell | null>;
export type EditorCellGrid = EditorCellValue[][];

export interface EditorCellUpdate extends EditorPoint {
  cell: EditorCellValue;
}

export interface EditorTextRun {
  start: number;
  end: number;
  fg: string;
}

export type EditorShapeKind = 'line' | 'rect' | 'circle' | 'polygon';
export type EditorShapeStyle = 'outline' | 'filled' | 'special' | 'slope';
export type EditorShapeDetail = 'cell' | 'half' | 'quarter';
export type EditorShapeChannel = 'glyph' | 'background' | 'color-clip';
export type EditorBoxStyle = 'single' | 'rounded' | 'double' | 'heavy';
export type EditorStrokeAlign = 'center' | 'inside' | 'outside';

interface EditorShapeBase {
  style: EditorShapeStyle;
  detail?: EditorShapeDetail | undefined;
  channel?: EditorShapeChannel | undefined;
  boxStyle?: string | undefined;
  char?: string | undefined;
  fg?: string | undefined;
  wide?: boolean | undefined;
  thickness?: number | undefined;
  strokeAlign?: EditorStrokeAlign | undefined;
  sides?: number | undefined;
  vertices?: EditorPoint[] | undefined;
  anchor?: EditorPoint | undefined;
  rotation?: number | undefined;
  rotationAspect?: number | undefined;
  glyphStyle?: EditorShapeStyle | undefined;
  glyphDetail?: EditorShapeDetail | undefined;
  glyphBoxStyle?: string | undefined;
  glyphWide?: boolean | undefined;
  backgroundStyle?: 'outline' | 'filled' | undefined;
  maskStyle?: 'outline' | 'filled' | undefined;
  maskThickness?: number | undefined;
  maskStrokeAlign?: EditorStrokeAlign | undefined;
  mix?: number | undefined;
}

interface EditorShapeCoordinates {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type EditorShape = EditorShapeBase & EditorShapeCoordinates & (
  | { kind: 'line' }
  | { kind: 'rect' }
  | { kind: 'circle' }
  | { kind: 'polygon'; sides?: number | undefined }
);

export type EditorShapeAppearance = Partial<EditorShapeBase> & {
  kind?: EditorShapeKind | undefined;
  x0?: number | undefined;
  y0?: number | undefined;
  x1?: number | undefined;
  y1?: number | undefined;
};

interface EditorShapePathAdvanced {
  vertices?: EditorPoint[] | undefined;
  anchor?: EditorPoint | undefined;
  rotation?: number | undefined;
  rotationAspect?: number | undefined;
}

export type EditorShapePath = EditorShapePathAdvanced & (
  | { kind: 'line'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'rect' | 'circle'; cx: number; cy: number; w: number; h: number }
  | { kind: 'polygon'; vertices: EditorPoint[] }
);

export interface EditorLayerTransform extends EditorPoint {
  scale?: number | undefined;
  scaleX?: number | undefined;
  scaleY?: number | undefined;
  rot?: number | undefined;
}

export type EditorEffectKind = 'brightness' | 'contrast' | 'saturation' | 'hue' | 'solid-color' | 'color-clip';

export type EditorEffect =
  | {
      kind: 'brightness' | 'contrast' | 'saturation' | 'hue';
      intensity: number;
    }
  | {
      kind: 'solid-color';
      color: string;
      intensity: number;
    }
  | {
      kind: 'color-clip';
      intensity: number;
    };

export interface EditorEffectMask {
  defaultStrength?: number | undefined;
  opacity?: number | undefined;
  cells: EditorCellMap;
  offset?: EditorPoint | undefined;
}

export interface EditorContentMask {
  defaultStrength?: number | undefined;
  cells: EditorCellMap;
  offset?: EditorPoint | undefined;
}

export interface EditorVideoClip extends VideoClip {
  assetId: string;
  width: number;
  height: number;
}

export type EditorRasterSource = HTMLCanvasElement | ImageBitmap | OffscreenCanvas;

interface EditorLayerBase {
  id: string;
  name: string;
  visible: boolean;
  cells: EditorCellMap;
  groupId?: string | null | undefined;
  offset?: EditorPoint | undefined;
  opacity?: number | undefined;
  blink?: boolean | undefined;
  box?: EditorBounds | undefined;
  contentMask?: EditorContentMask | null | undefined;
}

export interface EditorGroupLayer extends EditorLayerBase {
  type: 'group';
  collapsed?: boolean | undefined;
}

export interface EditorCellLayer extends EditorLayerBase {
  type: 'cell' | 'background';
}

export interface EditorEffectLayer extends EditorLayerBase {
  type: 'effect';
  effect?: EditorEffect | undefined;
  mask?: EditorEffectMask | null | undefined;
  clipped?: boolean | undefined;
}

export interface EditorShapeLayer extends EditorLayerBase {
  type: 'shape';
  shape?: EditorShape | undefined;
}

export interface EditorTextLayer extends EditorLayerBase {
  type: 'text';
  text: string;
  fg: string;
  wrap: boolean;
  runs: EditorTextRun[];
  box: EditorBounds;
}

export interface EditorImageLayer extends EditorLayerBase {
  type: 'image';
  assetId: string;
  sourceWidth: number;
  sourceHeight: number;
  transform: EditorLayerTransform;
  raster?: EditorRasterSource | undefined;
  runtimeMediaKey?: string | undefined;
}

export interface EditorVideoLayer extends EditorLayerBase {
  type: 'video';
  videoClip: EditorVideoClip;
  transform: EditorLayerTransform;
  raster?: EditorRasterSource | undefined;
  videoElement?: HTMLVideoElement | undefined;
  videoBlob?: Blob | undefined;
  videoURL?: string | undefined;
  runtimeMediaKey?: string | undefined;
}

export type EditorLayer =
  | EditorGroupLayer
  | EditorCellLayer
  | EditorEffectLayer
  | EditorShapeLayer
  | EditorTextLayer
  | EditorImageLayer
  | EditorVideoLayer;

export type EditorLayerPart = 'layer' | 'mask' | 'content-mask';
export type EditorTool =
  | 'brush' | 'eraser' | 'subcell' | 'fill' | 'eyedropper'
  | 'rect' | 'circle' | 'line' | 'polygon' | 'select' | 'crop'
  | 'text' | 'move' | 'color';

export interface EditorToolOptions {
  brush: Record<string, never>;
  eraser: Record<string, never>;
  fill: {
    contiguous: boolean;
    sampleAll: boolean;
    resolution: EditorShapeDetail;
  };
  subcell: {
    mode: 'half' | 'quarter' | EditorBoxStyle;
    resolution?: 'half' | 'quarter' | undefined;
  };
  eyedropper: { pick: 'char' | 'color' | 'both' };
  rect: EditorShapeAppearance;
  circle: EditorShapeAppearance;
  line: EditorShapeAppearance;
  polygon: EditorShapeAppearance;
  select: { shape: 'rectangle' };
  crop: Record<string, never>;
  text: { wrap: boolean };
}

export interface EditorPointerModifiers {
  altKey?: boolean | undefined;
  shiftKey?: boolean | undefined;
  ctrlKey?: boolean | undefined;
  metaKey?: boolean | undefined;
}
import type { VideoClip } from './project-types.js';
