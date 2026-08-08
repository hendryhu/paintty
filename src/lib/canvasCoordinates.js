function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function canvasCoordinates(pointer, rect, cellSize, bounds) {
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
