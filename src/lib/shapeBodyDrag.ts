import { getLayer, updateShapeLayer } from './grid.js';
import {
  anyPosKeys,
  isShapePathTrackEnabled,
  setLayerOffsetById,
  setShapePathComponentValues,
  setShapePathById,
  shapePathAnimationComponents,
  shapePathAt,
  translateShapeLayerBaseById,
} from './frames.js';
import { authoredEditsAllowed } from './playbackState.js';
import {
  enumerateShapePathComponents,
  pathValueFromShape,
  shapePathComponentEqual,
  shapePathComponentValue,
  shapeWithPathValue,
  translateShapePathKey,
} from './shapePath.js';
import { renderShapeToCells } from './shapes.js';
import type {
  EditorLayer,
  EditorPoint,
  EditorShape,
  EditorShapeKind,
  EditorShapeLayer,
  EditorShapePath,
} from './types/editor-domain.js';

interface ShapeBodyDrag {
  layerId: string;
  shape: EditorShape;
  path: EditorShapePath;
  offset: EditorPoint;
  positionAnimated: boolean;
  pathAnimated: boolean;
  componentAnimated: boolean;
  translatedDx: number;
  translatedDy: number;
}

export function shapeDirectEditEnabled(tool: string, playing: boolean, shapeKind: EditorShapeKind | null = null): boolean {
  return !playing && (tool === 'move' || tool === shapeKind);
}

export function shapeDirectEditTarget(
  layer: EditorLayer | null | undefined,
  tool: string,
  playing: boolean,
  hoverVisible = false,
): { interactive: boolean; layer: EditorShapeLayer | null } {
  const interactive = shapeDirectEditEnabled(
    tool,
    playing,
    layer?.type === 'shape' ? layer.shape?.kind ?? null : null,
  );
  const visible = (interactive || hoverVisible) &&
    layer?.type === 'shape' && !!layer.shape;
  return { interactive, layer: visible && layer?.type === 'shape' ? layer : null };
}

export function blankShapeLayerAcceptsKind(
  layer: EditorLayer | null | undefined,
  pathEnabled: boolean,
  pathKind: EditorShapeKind | null,
  requestedKind: EditorShapeKind,
  ownerActive = true,
) {
  if (!ownerActive || layer?.visible === false || layer?.type !== 'shape' || layer.shape) return false;
  return !pathEnabled || pathKind === requestedKind;
}

export function captureShapeBodyDrag(layerId: string, frame: number): ShapeBodyDrag | null {
  const layer = getLayer(layerId);
  if (layer?.type !== 'shape' || !layer.shape) return null;
  const pathAnimated = isShapePathTrackEnabled(layerId);
  const componentAnimated = shapePathAnimationComponents(layerId, frame)
    .some((component) => component.enabled);
  const path = (pathAnimated
    ? shapePathAt(layerId, frame) || pathValueFromShape(layer.shape)
    : pathValueFromShape(layer.shape))!;
  return {
    layerId,
    shape: { ...layer.shape },
    path,
    offset: { x: layer.offset?.x || 0, y: layer.offset?.y || 0 },
    positionAnimated: anyPosKeys(layerId),
    pathAnimated,
    componentAnimated,
    translatedDx: 0,
    translatedDy: 0,
  };
}

function changedShapePathComponents(from: EditorShapePath | null, to: EditorShapePath | null): Array<{
  componentId: string;
  value: EditorPoint | number | null;
}> {
  if (!from || !to || from.kind !== to.kind) return [];
  return enumerateShapePathComponents(to).flatMap((component) => {
    // Vertex edits move a derived anchor, but must not silently author one.
    if (component.id === 'anchor' &&
      !Object.prototype.hasOwnProperty.call(from, 'anchor') &&
      !Object.prototype.hasOwnProperty.call(to, 'anchor')) return [];
    const before = shapePathComponentValue(from, component.id);
    const after = shapePathComponentValue(to, component.id);
    return shapePathComponentEqual(component.id, before, after)
      ? []
      : [{ componentId: component.id, value: after }];
  });
}

function applyComponentGeometry(layerId: string, frame: number, proposed: EditorShapePath): boolean {
  const current = shapePathAt(layerId, frame);
  const edits = changedShapePathComponents(current, proposed);
  return edits.length
    ? setShapePathComponentValues(frame, layerId, edits).length > 0
    : false;
}

export function applyShapeBodyDrag(
  drag: ShapeBodyDrag | null,
  frame: number,
  dx: number,
  dy: number,
): boolean {
  if (!authoredEditsAllowed()) return false;
  if (!drag || !Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  const layer = getLayer(drag.layerId);
  if (layer?.type !== 'shape') return false;
  // Whole-layer Position takes precedence over Path geometry and static geometry.
  if (drag.positionAnimated) {
    setLayerOffsetById(frame, drag.layerId, {
      x: drag.offset.x + dx,
      y: drag.offset.y + dy,
    });
  } else if (drag.componentAnimated) {
    // Base curves mutate each event, so incremental deltas make return-to-origin exact.
    const stepX = dx - drag.translatedDx;
    const stepY = dy - drag.translatedDy;
    if ((stepX || stepY) &&
      !translateShapeLayerBaseById(drag.layerId, stepX, stepY)) return false;
    drag.translatedDx = dx;
    drag.translatedDy = dy;
  } else if (drag.pathAnimated) {
    const path = translateShapePathKey(drag.path, dx, dy);
    if (!path) return false;
    setShapePathById(frame, drag.layerId, path);
  } else {
    const translated = translateShapePathKey(drag.path, dx, dy);
    if (!translated) return false;
    const shape = shapeWithPathValue(drag.shape, translated);
    updateShapeLayer(drag.layerId, shape, renderShapeToCells);
  }
  return true;
}

export function applyShapeGeometryEdit(
  layerId: string,
  frame: number,
  shape: EditorShape | null,
  gestureStartShape: EditorShape | null = null,
): boolean {
  if (!authoredEditsAllowed() || !shape || !pathValueFromShape(shape)) return false;
  const layer = getLayer(layerId);
  if (layer?.type !== 'shape') return false;
  const proposed = pathValueFromShape(shape)!;
  const componentAnimated = shapePathAnimationComponents(layerId, frame)
    .some((component) => component.enabled);
  if (componentAnimated) {
    return applyComponentGeometry(layerId, frame, proposed);
  }
  if (isShapePathTrackEnabled(layerId)) {
    const current = shapePathAt(layerId, frame);
    const advancedGeometry = proposed.vertices || proposed.anchor ||
      Object.prototype.hasOwnProperty.call(proposed, 'rotation');
    if (current && gestureStartShape && proposed.kind !== 'line' &&
      proposed.kind !== 'polygon' && !advancedGeometry) {
      const changedX = shape.x0 !== gestureStartShape.x0 ||
        shape.x1 !== gestureStartShape.x1;
      const changedY = shape.y0 !== gestureStartShape.y0 ||
        shape.y1 !== gestureStartShape.y1;
      // Inclusive bounds can snap one axis; preserve the untouched interpolated axis.
      return setShapePathById(frame, layerId, {
        ...current,
        ...(changedX ? { cx: proposed.cx, w: proposed.w } : {}),
        ...(changedY ? { cy: proposed.cy, h: proposed.h } : {}),
      });
    }
    return setShapePathById(frame, layerId, proposed);
  }
  updateShapeLayer(layerId, shape, renderShapeToCells);
  return true;
}
