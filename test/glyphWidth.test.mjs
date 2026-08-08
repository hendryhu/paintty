import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { isWide } from '../src/lib/width.js';
import { normalizeOutputGrid } from '../src/lib/outputGrid.js';
import { activeChar, activeTool, paintColor } from '../src/lib/stores.js';
import { applyTool } from '../src/lib/tools.js';
import { dims, layers, setLayers } from '../src/lib/grid.js';
import { selection } from '../src/lib/selection.js';

let pass = 0;
let fail = 0;

function eq(name, got, want) {
  try {
    assert.deepStrictEqual(got, want);
    pass++;
  } catch (error) {
    fail++;
    console.error('FAIL ' + name + '\n' + error.message);
  }
}

// Expected widths are the ones paintty-cli (unicode-width) uses when it renders
// the same saved artwork, so a glyph Paintty stores in one column here cannot
// silently claim two columns in a terminal.
const TERMINAL_WIDE = [
  ['\u26a1', 'U+26A1 high voltage, offered by the Misc character tab'],
  ['\u2614', 'U+2614 umbrella with rain'],
  ['\u2648', 'U+2648 Aries'],
  ['\u26bd', 'U+26BD soccer ball'],
  ['\u2630', 'U+2630 trigram for heaven'],
  ['\u231a', 'U+231A watch'],
  ['\u23f0', 'U+23F0 alarm clock'],
  ['\u25fd', 'U+25FD white medium-small square'],
  ['\u2705', 'U+2705 check mark button'],
  ['\u2753', 'U+2753 red question mark'],
  ['\u2795', 'U+2795 heavy plus sign'],
  ['\u2b1b', 'U+2B1B black large square'],
  ['\u2b50', 'U+2B50 star'],
  ['\u{1f004}', 'U+1F004 mahjong red dragon'],
  ['\u{1f0cf}', 'U+1F0CF joker'],
  ['\u{1f18e}', 'U+1F18E AB button'],
  ['\u{1f201}', 'U+1F201 Japanese here button'],
  ['\ua960', 'U+A960 Hangul choseong tikeut-mieum'],
  ['\u6f22', 'U+6F22 CJK ideograph'],
  ['\u2764\ufe0f', 'U+2764 U+FE0F red heart with emoji presentation'],
  ['\u00a9\ufe0f', 'U+00A9 U+FE0F copyright with emoji presentation'],
  ['\u2122\ufe0f', 'U+2122 U+FE0F trade mark with emoji presentation'],
  ['1\ufe0f\u20e3', 'keycap digit one'],
  ['\u{1f1fa}\u{1f1f8}', 'regional indicator pair'],
  ['\u261d\u{1f3fd}', 'index pointing up with a skin tone modifier'],
  ['\u{1f9d1}\u200d\u{1f91d}\u200d\u{1f9d1}', 'people holding hands ZWJ sequence'],
];

// Bare keycaps and flag sequences are deliberately absent: they render as
// replacement boxes on Windows terminals, so they are not usable artwork and
// Paintty makes no promise about their width.
const TERMINAL_NARROW = [
  ['\u{1f321}', 'U+1F321 thermometer, a text-presentation pictograph'],
  ['\u{1f396}', 'U+1F396 military medal'],
  ['\u{1f3cb}', 'U+1F3CB person lifting weights'],
  ['\u{1fa00}', 'U+1FA00 neutral chess king'],
  ['\u3248', 'U+3248 circled ten on black square, East Asian ambiguous'],
  ['\ua4cf', 'U+A4CF unassigned codepoint'],
  ['\ue0b0', 'U+E0B0 Nerd Font powerline separator'],
  ['A', 'ASCII letter'],
  ['\u00a9', 'U+00A9 bare copyright'],
  ['\u2764', 'U+2764 bare heart'],
  ['\u2764\ufe0e', 'U+2764 U+FE0E heart forced to text presentation'],
  ['\u{1f1fa}', 'single regional indicator'],
  ['A\ufe0f', 'ASCII letter with an emoji presentation selector'],
  ['\u2502', 'U+2502 box drawings light vertical'],
  ['e\u0301', 'e with a combining acute accent'],
];

for (const [glyph, label] of TERMINAL_WIDE) {
  eq(`terminal-wide ${label}`, isWide(glyph), true);
}
for (const [glyph, label] of TERMINAL_NARROW) {
  eq(`terminal-narrow ${label}`, isWide(glyph), false);
}

dims.set({ w: 3, h: 1 });
setLayers([{ name: 'picker glyph', type: 'cell', visible: true, cells: {} }]);
selection.set(new Set());
activeTool.set('brush');
activeChar.set('\u26a1');
paintColor.set('#ffee00');
applyTool(0, 0, {}, 'down');
eq('painting a double-width picker glyph reserves its continuation cell', get(layers)[0].cells, {
  '0,0': { c: '\u26a1', fg: '#ffee00', bg: null },
  '1,0': { c: '', fg: '#ffee00', bg: null, cont: true },
});

const composited = normalizeOutputGrid([[
  { c: '\u26a1', fg: '#ffee00', bg: null },
  { c: '', fg: '#ffee00', bg: null, cont: true },
  { c: 'Z', fg: '#ffffff', bg: null },
]]);
eq('terminal output keeps the double-width pair instead of demoting it', [
  composited[0][0]?.c,
  composited[0][1]?.cont === true,
  composited[0][2]?.c,
], ['\u26a1', true, 'Z']);

console.log(`glyphWidth: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
