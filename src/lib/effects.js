import { hexToOklch, hexToRgb, oklchToHex, rgbToHex } from './color.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function colorLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return clamp((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, 0, 1);
}

export function effectMaskStrength(mask, x, y) {
  if (!mask) return 1;
  const cell = mask.cells?.[`${x},${y}`];
  if (!cell) return clamp(mask.defaultStrength ?? 1, 0, 1);
  if (Number.isFinite(cell.mask)) return clamp(cell.mask, 0, 1);
  return colorLuminance(cell.bg || cell.fg || '#000000');
}

export function transformTerminalColor(hex, kind, amount) {
  const t = clamp(Number(amount) || 0, -1, 1);
  if (!hex || t === 0) return hex;
  if (kind === 'brightness') {
    const { r, g, b } = hexToRgb(hex);
    const delta = t * 255;
    return rgbToHex(r + delta, g + delta, b + delta);
  }
  if (kind === 'contrast') {
    const { r, g, b } = hexToRgb(hex);
    const factor = t >= 0 ? 1 + t * 3 : 1 + t;
    return rgbToHex((r - 127.5) * factor + 127.5, (g - 127.5) * factor + 127.5, (b - 127.5) * factor + 127.5);
  }
  const { L, C, H } = hexToOklch(hex);
  if (kind === 'saturation') return oklchToHex(L, Math.max(0, C * (1 + t)), H);
  if (kind === 'hue') return oklchToHex(L, C, (H + t * 180 + 360) % 360);
  return hex;
}

function applyEffectToCell(cell, effect, strength = 1, channels = null) {
  if (!cell) return cell;
  const amount = clamp((effect?.intensity ?? 0) * clamp(strength, 0, 1), -1, 1);
  if (amount === 0) return cell;
  const out = { ...cell };
  if (out.fg && (!channels || channels.fg)) out.fg = transformTerminalColor(out.fg, effect.kind, amount);
  if (out.bg && (!channels || channels.bg)) out.bg = transformTerminalColor(out.bg, effect.kind, amount);
  return out;
}

export function applyEffectToGrid(grid, layer, viewport, coverage = null) {
  if (!layer?.effect || layer.visible === false) return grid;
  for (let gy = 0; gy < grid.length; gy++) {
    for (let gx = 0; gx < grid[gy].length; gx++) {
      const channels = coverage?.[gy]?.[gx] || null;
      if (coverage && !channels) continue;
      const cell = grid[gy][gx];
      if (!cell) continue;
      const maskOpacity = clamp(layer.mask?.opacity ?? 1, 0, 1);
      const strength = effectMaskStrength(layer.mask, gx + viewport.x, gy + viewport.y) * maskOpacity;
      grid[gy][gx] = applyEffectToCell(cell, layer.effect, strength, channels);
    }
  }
  return grid;
}
