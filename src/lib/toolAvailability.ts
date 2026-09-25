import type { EditorLayer, EditorLayerPart, EditorTool } from './types/editor-domain.js';

export const EFFECT_MASK_TOOLS = new Set<EditorTool>([
  'brush', 'eraser', 'fill', 'eyedropper', 'line', 'rect', 'circle', 'move', 'select', 'crop', 'color',
]);

const POSITIVE_PAINT_TOOLS = new Set<EditorTool>(['brush', 'subcell', 'fill']);

function isColorClipLayer(layer: EditorLayer | null | undefined): boolean {
  return layer?.type === 'effect' && !!layer.effect && layer.effect.kind === 'color-clip';
}

export function isBackgroundPaintTarget(layer: EditorLayer | null | undefined): boolean {
  return layer?.type === 'background' || isColorClipLayer(layer);
}

export function glyphPaintingUnavailable(layer: EditorLayer | null | undefined, activePart: EditorLayerPart = 'layer'): boolean {
  return activePart !== 'layer' || layer?.type !== 'cell';
}

export function isToolDisabledForLayer(tool: EditorTool, layer: EditorLayer | null | undefined, activePart: EditorLayerPart = 'layer'): boolean {
  const editingEffectMask = activePart === 'mask' && layer?.type === 'effect' && !!layer.mask;
  const editingContentMask = activePart === 'content-mask' && !!layer?.contentMask;
  if (editingEffectMask) return !EFFECT_MASK_TOOLS.has(tool);
  if (editingContentMask) return !EFFECT_MASK_TOOLS.has(tool);
  const colorClip = isColorClipLayer(layer);
  if (tool === 'brush' || tool === 'eraser' || tool === 'fill') {
    return layer?.type !== 'cell' && layer?.type !== 'background' && !colorClip;
  }
  if (tool === 'subcell') return layer?.type !== 'cell';
  if (tool === 'move') return !layer || (layer.type === 'effect' && !colorClip);
  if (tool === 'select') {
    return layer?.type !== 'cell' && layer?.type !== 'background' && !colorClip;
  }
  return false;
}

export function paintOwnerDisposition(
  tool: EditorTool,
  layer: EditorLayer | null | undefined,
  options: { activePart?: EditorLayerPart; activeClip?: boolean; effectiveVisible?: boolean } = {},
): 'blocked' | 'reuse' | 'create' {
  const activePart = options.activePart === 'mask' || options.activePart === 'content-mask'
    ? options.activePart
    : 'layer';
  if (isToolDisabledForLayer(tool, layer, activePart)) return 'blocked';
  if (activePart !== 'layer' || !POSITIVE_PAINT_TOOLS.has(tool)) return 'reuse';
  return options.activeClip && options.effectiveVisible && layer?.visible !== false
    ? 'reuse'
    : 'create';
}

export function paintOwnerCreatedNotice(layer: EditorLayer | null | undefined): string | null {
  const name = String(layer?.name || '').trim();
  return name ? `Created ${name} for this tick.` : null;
}
