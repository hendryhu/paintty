import { writable } from 'svelte/store';
import { createColorDepthPreference } from './appPreferences.js';

export const BRUSH_TOOLS = new Set(['brush', 'eraser', 'subcell']);
export const activeTool = writable('brush');
export const altEyedrop = writable(false);

export const paintColor = writable('#ffffff');
export const recentColors = writable([
  '#000000', '#c94f4f', '#5fb37a', '#e0a458', '#5b8fd6', '#a86fc9', '#4fb8c9', '#d8d8dc',
  '#4a4a52', '#e06c6c', '#7fd39a', '#f0c078', '#7fafff', '#c88fe9', '#6fd8e9', '#ffffff',
]);

export const activeChar = writable('█');

export const favourites = writable(new Set(['█', '◉', '●', '▲', '◆', '■', '░', '▓', '│', '─']));
export function addFavourite(ch) {
  if (!ch) return;
  favourites.update((set) => {
    const next = new Set(set); next.add(ch); return next;
  });
}

export function toggleFavourite(ch) {
  favourites.update((set) => {
    const next = new Set(set);
    if (next.has(ch)) next.delete(ch); else next.add(ch);
    return next;
  });
}

export const fileName = writable('untitled');
export const dirty = writable(false);
export const colorDepth = createColorDepthPreference();

export const toolOptions = writable({
  brush:      {},
  eraser:     {},
  fill:       { contiguous: true, sampleAll: false, resolution: 'cell' },
  subcell:    { mode: 'half' },
  eyedropper: { pick: 'char' },
  rect:       { style: 'outline', detail: 'cell', channel: 'glyph', boxStyle: 'single', thickness: 1, strokeAlign: 'center' },
  circle:     { style: 'outline', detail: 'cell', channel: 'glyph', boxStyle: 'single', thickness: 1, strokeAlign: 'center' },
  line:       { style: 'outline', detail: 'cell', channel: 'glyph', boxStyle: 'single', thickness: 1, strokeAlign: 'center' },
  polygon:    { style: 'outline', detail: 'cell', channel: 'glyph', sides: 5, thickness: 1, strokeAlign: 'center' },
  select:     { shape: 'rectangle' },
  crop:       {},
  text:       { wrap: true },
});

export const shapeGeometryHover = writable(null);
