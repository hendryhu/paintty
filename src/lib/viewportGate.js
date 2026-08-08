export const MINIMUM_VIEWPORT = Object.freeze({ width: 800, height: 600 });

export function viewportGate(width, height, minimum = MINIMUM_VIEWPORT) {
  const currentWidth = Math.max(0, Math.floor(Number(width) || 0));
  const currentHeight = Math.max(0, Math.floor(Number(height) || 0));
  const minimumWidth = Math.max(1, Math.floor(Number(minimum.width) || 1));
  const minimumHeight = Math.max(1, Math.floor(Number(minimum.height) || 1));
  return {
    width: currentWidth,
    height: currentHeight,
    minimumWidth,
    minimumHeight,
    blocked: currentWidth < minimumWidth || currentHeight < minimumHeight,
  };
}
