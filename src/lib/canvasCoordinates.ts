import type { EditorBounds, EditorPoint, EditorSize } from './types/editor-domain.js';

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function canvasCoordinates(
  pointer: Pick<PointerEvent, 'clientX' | 'clientY'>,
  rect: Pick<DOMRect, 'left' | 'top'>,
  cellSize: EditorSize,
  bounds: Pick<EditorBounds, 'w' | 'h'>,
): {
  fractional: EditorPoint;
  cell: EditorPoint;
  withinCell: EditorPoint;
  subcell: EditorPoint;
  boundedCell: EditorPoint;
} {
  const fractional = {
    x: (pointer.clientX - rect.left) / cellSize.w,
    y: (pointer.clientY - rect.top) / cellSize.h,
  };
  const cell = {
    x: Math.floor(fractional.x),
    y: Math.floor(fractional.y),
  };
  return {
    fractional,
    cell,
    withinCell: {
      x: fractional.x - cell.x,
      y: fractional.y - cell.y,
    },
    subcell: {
      x: Math.floor(fractional.x * 2),
      y: Math.floor(fractional.y * 2),
    },
    boundedCell: {
      x: clamp(cell.x, 0, bounds.w - 1),
      y: clamp(cell.y, 0, bounds.h - 1),
    },
  };
}
