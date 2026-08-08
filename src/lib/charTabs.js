export const CHAR_TABS = [
  { id: 'fav',   label: '★' },
  { id: 'ascii', label: 'ASCII',    ranges: [[0x21, 0x7E]] },
  { id: 'latin', label: 'Latin+',   ranges: [[0x00A1, 0x017F]] },
  { id: 'box',   label: 'Box',      ranges: [[0x2500, 0x257F]] },
  { id: 'block', label: 'Block',    ranges: [[0x2580, 0x259F]] },
  { id: 'geom',  label: 'Geom',     ranges: [[0x25A0, 0x25FF]] },
  { id: 'arrow', label: 'Arrows',   ranges: [[0x2190, 0x21FF]] },
  { id: 'brail', label: 'Braille',  ranges: [[0x2800, 0x28FF]] },
  { id: 'misc',  label: 'Misc',     ranges: [[0x2600, 0x26FF]] },
  { id: 'nf',    label: 'NerdFont', ranges: [[0xE000, 0xE0FF]] },
];

export function charsForTab(tab, favourites) {
  if (tab.id === 'fav') return [...favourites];
  const out = [];
  for (const [a, b] of tab.ranges || []) {
    for (let cp = a; cp <= b; cp++) out.push(String.fromCodePoint(cp));
  }
  return out;
}

export function codepoint(ch) {
  return [...String(ch || '')]
    .map((part) => 'U+' + part.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
    .join(' ');
}
