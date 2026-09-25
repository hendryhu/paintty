import { blendHex, hexToOklch, hexToRgb, oklchToHex, rgbToHex } from './color.js';
import type {
  EditorCell,
  EditorCellGrid,
  EditorCellMap,
  EditorEffect,
  EditorEffectLayer,
  EditorEffectMask,
  EditorPoint,
} from './types/editor-domain.js';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function colorLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return clamp((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, 0, 1);
}

export function effectMaskStrength(mask: (Omit<EditorEffectMask, 'cells'> & { cells?: EditorEffectMask['cells'] }) | null | undefined, x: number, y: number): number {
  if (!mask) return 1;
  const cell = mask.cells?.[`${x},${y}`];
  if (!cell) return clamp(mask.defaultStrength ?? 1, 0, 1);
  if (typeof cell.mask === 'number' && Number.isFinite(cell.mask)) return clamp(cell.mask, 0, 1);
  return colorLuminance(cell.bg || cell.fg || '#000000');
}

export function transformTerminalColor(hex: string, kind: EditorEffect['kind'], amount: number): string {
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

export function mixTerminalColor(target: string, source: string, amount: number): string {
  const t = clamp(Number(amount) || 0, 0, 1);
  if (!target || !source || t === 0) return target;
  return blendHex(source, target, t);
}

export interface EffectChannels {
  fg?: boolean | undefined;
  bg?: boolean | undefined;
}

export function applyColorClipToGrid(
  grid: EditorCellGrid,
  sourceCells: EditorCellMap,
  mix: number,
  viewport: EditorPoint,
  coverage: Array<Array<EffectChannels | null>>,
): EditorCellGrid {
  const amount = clamp(mix, 0, 1);
  if (amount === 0) return grid;
  for (let gy = 0; gy < grid.length; gy++) {
    const row = grid[gy]!;
    for (let gx = 0; gx < row.length; gx++) {
      const channels = coverage[gy]?.[gx];
      if (!channels) continue;
      const cell = row[gx];
      if (!cell) continue;
      const source = sourceCells[`${gx + viewport.x},${gy + viewport.y}`];
      const color = source?.bg || source?.fg;
      if (!color) continue;
      const out = { ...cell };
      if (out.fg && channels.fg) out.fg = mixTerminalColor(out.fg, color, amount);
      if (out.bg && channels.bg) out.bg = mixTerminalColor(out.bg, color, amount);
      row[gx] = out;
    }
  }
  return grid;
}

function applyEffectToCell(
  cell: EditorCell | null | undefined,
  effect: EditorEffect,
  strength = 1,
  channels: EffectChannels | null = null,
  sourceColor: string | null = null,
): EditorCell | null | undefined {
  if (!cell) return cell;
  const maskStrength = clamp(strength, 0, 1);
  if (maskStrength === 0) return cell;
  if (effect.kind === 'solid-color') {
    const amount = clamp(effect.intensity, 0, 1) * maskStrength;
    if (amount === 0) return cell;
    const out = { ...cell };
    if (out.fg && (!channels || channels.fg)) out.fg = mixTerminalColor(out.fg, effect.color, amount);
    if (out.bg && (!channels || channels.bg)) out.bg = mixTerminalColor(out.bg, effect.color, amount);
    return out;
  }
  if (effect.kind === 'color-clip') {
    if (!sourceColor) return cell;
    const amount = clamp(effect.intensity, 0, 1) * maskStrength;
    if (amount === 0) return cell;
    const out = { ...cell };
    if (out.fg && (!channels || channels.fg)) out.fg = mixTerminalColor(out.fg, sourceColor, amount);
    if (out.bg && (!channels || channels.bg)) out.bg = mixTerminalColor(out.bg, sourceColor, amount);
    return out;
  }
  const amount = clamp(effect.intensity ?? 0, -1, 1) * maskStrength;
  if (amount === 0) return cell;
  const out = { ...cell };
  if (out.fg && (!channels || channels.fg)) out.fg = transformTerminalColor(out.fg, effect.kind, amount);
  if (out.bg && (!channels || channels.bg)) out.bg = transformTerminalColor(out.bg, effect.kind, amount);
  return out;
}

export function applyEffectToGrid(
  grid: EditorCellGrid,
  layer: EditorEffectLayer,
  viewport: EditorPoint,
  coverage: Array<Array<EffectChannels | null>> | null = null,
  contentMaskViewport: EditorPoint = viewport,
): EditorCellGrid {
  if (!layer?.effect || layer.visible === false) return grid;
  const isColorClip = layer.effect.kind === 'color-clip';
  const sourceCells = isColorClip ? (layer.cells || {}) : null;
  for (let gy = 0; gy < grid.length; gy++) {
    const row = grid[gy]!;
    for (let gx = 0; gx < row.length; gx++) {
      const channels = coverage?.[gy]?.[gx] || null;
      if (coverage && !channels) continue;
      const cell = row[gx];
      if (!cell) continue;
      if (layer.contentMask) {
        const maskCell = layer.contentMask.cells[`${gx + contentMaskViewport.x},${gy + contentMaskViewport.y}`];
        const color = maskCell?.bg || maskCell?.fg;
        if (color ? color.toLowerCase() !== '#ffffff' : (layer.contentMask.defaultStrength ?? 1) !== 1) continue;
      }
      const maskOpacity = clamp(layer.mask?.opacity ?? 1, 0, 1);
      const strength = effectMaskStrength(layer.mask, gx + viewport.x, gy + viewport.y) * maskOpacity;
      let sourceColor: string | null = null;
      if (isColorClip && sourceCells) {
        const sourceCell = sourceCells[`${gx + viewport.x},${gy + viewport.y}`];
        sourceColor = sourceCell?.bg || null;
        if (!sourceColor) continue;
      }
      row[gx] = applyEffectToCell(cell, layer.effect, strength, channels, sourceColor);
    }
  }
  return grid;
}
