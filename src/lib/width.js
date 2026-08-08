import stringWidth from 'string-width';

// Cell width must match the terminal, not the editor font: a font is free to
// draw a glyph wider than its cell while a terminal still advances one column.
// string-width applies the Unicode rules paintty-cli's renderer follows, so
// nothing here measures pixels or hand-maintains a codepoint table.
const cache = new Map();

export function isWide(ch) {
  if (!ch) return false;
  let wide = cache.get(ch);
  if (wide === undefined) {
    wide = stringWidth(ch) > 1;
    cache.set(ch, wide);
  }
  return wide;
}
