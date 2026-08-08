const TL = 1, TR = 2, BL = 4, BR = 8;

const MASK_TO_GLYPH = {
  0: '',
  [TL]: '▘', [TR]: '▝', [BL]: '▖', [BR]: '▗',
  [TL | TR]: '▀', [BL | BR]: '▄', [TL | BL]: '▌', [TR | BR]: '▐',
  [TL | BR]: '▚', [TR | BL]: '▞',
  [TL | TR | BL]: '▛', [TL | TR | BR]: '▜', [TL | BL | BR]: '▙', [TR | BL | BR]: '▟',
  [TL | TR | BL | BR]: '█',
};
const GLYPH_TO_MASK = Object.fromEntries(
  Object.entries(MASK_TO_GLYPH).filter(([, g]) => g).map(([m, g]) => [g, +m]),
);

export function maskFromChar(c) {
  if (!c) return 0;
  return GLYPH_TO_MASK[c] ?? 0;
}

export function glyphForMask(mask) { return MASK_TO_GLYPH[mask] || ''; }

export function quadrantBit(top, left) {
  if (top && left) return TL;
  if (top && !left) return TR;
  if (!top && left) return BL;
  return BR;
}

export function bitsForStroke(resolution, top, left) {
  if (resolution === 'half') return top ? (TL | TR) : (BL | BR);
  return quadrantBit(top, left);
}

export function applySubcell(prevCell, addBits, fg) {
  const prevMask = maskFromChar(prevCell?.c);
  const mask = prevMask | addBits;
  const glyph = MASK_TO_GLYPH[mask] || '';
  const bg = prevCell?.bg ?? null;
  if (!glyph && !bg) return null;
  return { c: glyph, fg, bg };
}
