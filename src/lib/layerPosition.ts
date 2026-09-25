import type {
  EditorImageLayer,
  EditorLayer,
  EditorLayerTransform,
  EditorPoint,
  EditorSize,
  EditorVideoLayer,
} from './types/editor-domain.js';

type RasterLayer = EditorImageLayer | EditorVideoLayer;

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function wholePoint(value: Partial<EditorPoint> | null | undefined): EditorPoint {
  return {
    x: Math.round(finite(value?.x)),
    y: Math.round(finite(value?.y)),
  };
}

function groupOffset(items: EditorLayer[], layer: EditorLayer | null | undefined): EditorPoint {
  const group = layer?.groupId == null
    ? null
    : items.find((candidate) => candidate.id === layer.groupId && candidate.type === 'group');
  return {
    x: finite(group?.offset?.x),
    y: finite(group?.offset?.y),
  };
}

export function isRasterLayer(layer: EditorLayer | null | undefined): layer is RasterLayer {
  return layer?.type === 'image' || layer?.type === 'video';
}

export function rasterLayerTransform(layer: RasterLayer | null | undefined, size: Partial<EditorSize> = {}): EditorLayerTransform {
  const transform = layer?.transform
    ? { ...layer.transform }
    : { x: finite(size.w) / 2, y: finite(size.h) / 2, scale: 1, rot: 0 };
  transform.x = finite(transform.x, finite(size.w) / 2);
  transform.y = finite(transform.y, finite(size.h) / 2);
  return transform;
}

export function rasterLayerSourceSize(layer: RasterLayer | null | undefined): { width: number; height: number } | null {
  const metadataWidth = layer?.type === 'video'
    ? finite(layer?.videoClip?.width)
    : finite(layer?.sourceWidth);
  const metadataHeight = layer?.type === 'video'
    ? finite(layer?.videoClip?.height)
    : finite(layer?.sourceHeight);
  if (metadataWidth > 0 && metadataHeight > 0) {
    return { width: metadataWidth, height: metadataHeight };
  }
  const rasterWidth = finite(layer?.raster?.width);
  const rasterHeight = finite(layer?.raster?.height);
  return rasterWidth > 0 && rasterHeight > 0
    ? { width: rasterWidth, height: rasterHeight }
    : null;
}

export function renderedRasterPosition(items: EditorLayer[], layer: RasterLayer, size: Partial<EditorSize> = {}): EditorPoint {
  const transform = rasterLayerTransform(layer, size);
  const group = groupOffset(items, layer);
  return {
    x: transform.x + finite(layer?.offset?.x) + group.x,
    y: transform.y + finite(layer?.offset?.y) + group.y,
  };
}

// Missing-video UI and decoded raster rendering share this geometry so relinking cannot jump.
export function rasterDisplayGeometry(
  items: EditorLayer[],
  layer: RasterLayer,
  size: Partial<EditorSize> = {},
  fallbackSource: { width: number; height: number } | null = null,
) {
  const source = rasterLayerSourceSize(layer) || fallbackSource;
  if (!(finite(source?.width) > 0) || !(finite(source?.height) > 0)) return null;
  const transform = rasterLayerTransform(layer, size);
  const scale = finite(transform.scale, 1);
  const scaleX = finite(transform.scaleX, scale);
  const scaleY = finite(transform.scaleY, scale);
  const position = renderedRasterPosition(items, layer, size);
  return {
    ...position,
    width: Math.abs(finite(source!.width) * scaleX),
    height: Math.abs(finite(source!.height) * scaleY) / 2,
    scaleX,
    scaleY,
    rot: finite(transform.rot),
    opacity: layer?.opacity ?? 1,
  };
}

export function rasterScaleFromDrag(
  initialScale: Partial<EditorPoint> | null | undefined,
  initialVector: Partial<EditorPoint> | null | undefined,
  currentVector: Partial<EditorPoint> | null | undefined,
  axis: 'x' | 'y' | null,
  free = false,
): EditorPoint {
  const scaleX = Math.max(0.02, finite(initialScale?.x, 1));
  const scaleY = Math.max(0.02, finite(initialScale?.y, 1));
  const initialX = Math.abs(finite(initialVector?.x, 1)) || 1;
  const initialY = Math.abs(finite(initialVector?.y, 1)) || 1;
  const currentX = Math.abs(finite(currentVector?.x));
  const currentY = Math.abs(finite(currentVector?.y));
  if (free) {
    return {
      x: axis === 'y' ? scaleX : Math.max(0.02, scaleX * currentX / initialX),
      y: axis === 'x' ? scaleY : Math.max(0.02, scaleY * currentY / initialY),
    };
  }
  const initialDistance = Math.hypot(initialX, initialY) || 1;
  const ratio = axis === 'x'
    ? currentX / initialX
    : axis === 'y'
      ? currentY / initialY
      : Math.hypot(currentX, currentY) / initialDistance;
  return {
    x: Math.max(0.02, scaleX * ratio),
    y: Math.max(0.02, scaleY * ratio),
  };
}

export function timelinePositionEditor(
  items: EditorLayer[],
  layer: EditorLayer | null | undefined,
  animated: boolean,
  size: Partial<EditorSize> = {},
) {
  const raster = isRasterLayer(layer);
  const staticRaster = raster && !animated;
  return {
    editable: !!layer && (staticRaster || !!animated),
    mode: staticRaster ? 'raster-transform' : 'offset-track',
    value: raster
      ? renderedRasterPosition(items, layer, size)
      : wholePoint(layer?.offset),
  };
}

// Raster fields stay in canvas coordinates even though animation stores offsets.
export function planTimelinePositionEdit(
  items: EditorLayer[],
  layerId: string,
  animated: boolean,
  value: Partial<EditorPoint> | null | undefined,
  size: Partial<EditorSize> = {},
) {
  const layer = items.find((candidate) => candidate.id === layerId);
  const editor = timelinePositionEditor(items, layer, animated, size);
  if (!editor.editable) return null;
  if (editor.mode === 'offset-track') {
    if (!isRasterLayer(layer)) {
      return { mode: editor.mode, value: wholePoint(value) };
    }
    const group = groupOffset(items, layer);
    const transform = rasterLayerTransform(layer, size);
    return {
      mode: editor.mode,
      value: wholePoint({
        x: finite(value?.x, editor.value.x) - transform.x - group.x,
        y: finite(value?.y, editor.value.y) - transform.y - group.y,
      }),
    };
  }

  const group = groupOffset(items, layer);
  const rasterLayer = layer as RasterLayer;
  const transform = rasterLayerTransform(rasterLayer, size);
  const next = {
    x: finite(value?.x, editor.value.x) - finite(rasterLayer.offset?.x) - group.x,
    y: finite(value?.y, editor.value.y) - finite(rasterLayer.offset?.y) - group.y,
  };
  const nextItems = items.map((candidate) => candidate.id === layerId ? {
    ...candidate,
    transform: { ...transform, ...next },
  } : candidate);
  return { mode: editor.mode, value: next, items: nextItems };
}
