import { get } from 'svelte/store';
import { anyPosKeys, setLayerOffsetById } from './frames.js';
import { dims, getLayer, layers, noteAuthoredMutation } from './grid.js';
import { authoredEditsAllowed } from './playbackState.js';
import {
  isRasterLayer,
  rasterDisplayGeometry,
  rasterLayerTransform,
  renderedRasterPosition,
} from './layerPosition.js';
import type { EditorLayerTransform, EditorPoint, EditorSize } from './types/editor-domain.js';

const SNAP_THRESHOLD = 0.6;

export interface RasterSnapGuides {
  x: number | null;
  y: number | null;
}

interface RasterBodyDrag {
  layerId: string;
  layerType: 'image' | 'video';
  transform: EditorLayerTransform;
  offset: EditorPoint;
  visibleCenter: EditorPoint;
  visibleHalfExtent: EditorPoint;
  positionAnimated: boolean;
}

export interface RasterBodyDelta {
  dx: number;
  dy: number;
  guides: RasterSnapGuides;
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function captureRasterBodyDrag(layerId: string): RasterBodyDrag | null {
  const layer = getLayer(layerId);
  if (!isRasterLayer(layer)) return null;
  const size = get(dims);
  const transform = rasterLayerTransform(layer, size);
  const offset = {
    x: finite(layer.offset?.x, 0),
    y: finite(layer.offset?.y, 0),
  };
  const currentLayers = get(layers);
  const geometry = rasterDisplayGeometry(currentLayers, layer, size);
  const radians = (geometry?.rot || 0) * Math.PI / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const halfWidth = (geometry?.width || 0) / 2;
  const halfHeight = (geometry?.height || 0) / 2;
  return {
    layerId,
    layerType: layer.type,
    transform,
    offset,
    visibleCenter: renderedRasterPosition(currentLayers, layer, size),
    visibleHalfExtent: {
      x: halfWidth * cosine + halfHeight * sine,
      y: halfWidth * sine + halfHeight * cosine,
    },
    positionAnimated: anyPosKeys(layerId),
  };
}

function snappedAxis(
  center: number,
  halfExtent: number,
  canvasSize: number,
): { center: number; guide: number | null } {
  const candidates = [
    { center: canvasSize / 2, guide: canvasSize / 2 },
    { center: halfExtent, guide: 0 },
    { center: canvasSize - halfExtent, guide: canvasSize },
  ];
  let closest = { center, guide: null as number | null };
  let distance = SNAP_THRESHOLD;
  for (const candidate of candidates) {
    const nextDistance = Math.abs(center - candidate.center);
    if (nextDistance >= distance) continue;
    closest = candidate;
    distance = nextDistance;
  }
  return closest;
}

export function rasterBodyDelta(
  drag: RasterBodyDrag | null,
  dx: number,
  dy: number,
  canvasSize: EditorSize | null = null,
): RasterBodyDelta | null {
  if (!drag || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  let visibleX = drag.visibleCenter.x + dx;
  let visibleY = drag.visibleCenter.y + dy;
  const guides: RasterSnapGuides = { x: null, y: null };
  if (canvasSize) {
    const x = snappedAxis(visibleX, drag.visibleHalfExtent.x, canvasSize.w);
    const y = snappedAxis(visibleY, drag.visibleHalfExtent.y, canvasSize.h);
    visibleX = x.center;
    visibleY = y.center;
    guides.x = x.guide;
    guides.y = y.guide;
  }
  return {
    dx: visibleX - drag.visibleCenter.x,
    dy: visibleY - drag.visibleCenter.y,
    guides,
  };
}

export function applyRasterBodyDrag(drag: RasterBodyDrag | null, frame: number, dx: number, dy: number): boolean {
  if (!authoredEditsAllowed()) return false;
  if (!drag || !Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  const layer = getLayer(drag.layerId);
  if (!isRasterLayer(layer) || layer.type !== drag.layerType) return false;
  if (drag.positionAnimated) {
    setLayerOffsetById(frame, drag.layerId, {
      x: drag.offset.x + dx,
      y: drag.offset.y + dy,
    });
  } else {
    layers.update((items) => items.map((item) => item.id === drag.layerId ? {
      ...item,
      transform: {
        ...drag.transform,
        x: drag.transform.x + dx,
        y: drag.transform.y + dy,
      },
    } : item));
    noteAuthoredMutation();
  }
  return true;
}
