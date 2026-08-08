import { get } from 'svelte/store';
import { anyPosKeys, setLayerOffsetById } from './frames.js';
import { dims, getLayer, layers, noteAuthoredMutation } from './grid.js';
import { authoredEditsAllowed } from './playbackState.js';
import {
  isRasterLayer,
  rasterLayerTransform,
  renderedRasterPosition,
} from './layerPosition.js';

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function captureRasterBodyDrag(layerId) {
  const layer = getLayer(layerId);
  if (!isRasterLayer(layer)) return null;
  const size = get(dims);
  const transform = rasterLayerTransform(layer, size);
  const offset = {
    x: finite(layer.offset?.x, 0),
    y: finite(layer.offset?.y, 0),
  };
  const currentLayers = get(layers);
  return {
    layerId,
    layerType: layer.type,
    transform,
    offset,
    visibleCenter: renderedRasterPosition(currentLayers, layer, size),
    positionAnimated: anyPosKeys(layerId),
  };
}

export function rasterBodyDelta(drag, dx, dy, canvasCenter = null) {
  if (!drag || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  let visibleX = drag.visibleCenter.x + dx;
  let visibleY = drag.visibleCenter.y + dy;
  if (canvasCenter) {
    if (Math.abs(visibleX - canvasCenter.x) < 0.6) visibleX = canvasCenter.x;
    if (Math.abs(visibleY - canvasCenter.y) < 0.6) visibleY = canvasCenter.y;
  }
  return {
    dx: visibleX - drag.visibleCenter.x,
    dy: visibleY - drag.visibleCenter.y,
  };
}

export function applyRasterBodyDrag(drag, frame, dx, dy) {
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
