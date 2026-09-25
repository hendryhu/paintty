export interface CropRect { x: number; y: number; w: number; h: number }
export type CropHandle = 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function canvasCrop(width: number, height: number): CropRect {
  return {
    x: 0,
    y: 0,
    w: Math.max(1, Math.min(256, Math.round(width) || 1)),
    h: Math.max(1, Math.min(256, Math.round(height) || 1)),
  };
}

export function dragCrop(rect: CropRect, handle: CropHandle, deltaX: number, deltaY: number): CropRect {
  const dx = Math.round(deltaX) || 0;
  const dy = Math.round(deltaY) || 0;
  if (handle === 'move') return { ...rect, x: rect.x + dx, y: rect.y + dy };

  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;

  if (handle.includes('w')) left = clamp(left + dx, right - 256, right - 1);
  if (handle.includes('e')) right = clamp(right + dx, left + 1, left + 256);
  if (handle.includes('n')) top = clamp(top + dy, bottom - 256, bottom - 1);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + 1, top + 256);

  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function cropDiffers(rect: CropRect, width: number, height: number): boolean {
  return rect.x !== 0 || rect.y !== 0 || rect.w !== width || rect.h !== height;
}
