export const EFFECT_MASK_TOOLS = new Set([
  'brush', 'eraser', 'fill', 'eyedropper', 'line', 'rect', 'circle', 'move', 'select', 'crop', 'color',
]);

const POSITIVE_PAINT_TOOLS = new Set(['brush', 'subcell', 'fill']);

export function glyphPaintingUnavailable(layer, activePart = 'layer') {
  return activePart === 'mask' || layer?.type !== 'cell';
}

export function isToolDisabledForLayer(tool, layer, activePart = 'layer') {
  const editingMask = activePart === 'mask' && layer?.type === 'effect' && !!layer.mask;
  if (editingMask) return !EFFECT_MASK_TOOLS.has(tool);
  if (tool === 'brush' || tool === 'eraser' || tool === 'fill') {
    return layer?.type !== 'cell' && layer?.type !== 'background';
  }
  if (tool === 'subcell') return layer?.type !== 'cell';
  if (tool === 'move') return !layer || layer.type === 'effect';
  if (tool === 'select') {
    return !['cell', 'background'].includes(layer?.type);
  }
  return false;
}

export function paintOwnerDisposition(tool, layer, options = {}) {
  const activePart = options.activePart === 'mask' ? 'mask' : 'layer';
  if (isToolDisabledForLayer(tool, layer, activePart)) return 'blocked';
  if (activePart === 'mask' || !POSITIVE_PAINT_TOOLS.has(tool)) return 'reuse';
  return options.activeClip && options.effectiveVisible && layer?.visible !== false
    ? 'reuse'
    : 'create';
}

export function paintOwnerCreatedNotice(layer) {
  const name = String(layer?.name || '').trim();
  return name ? `Created ${name} for this tick.` : null;
}
