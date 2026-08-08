import assert from 'node:assert/strict';
import { get } from 'svelte/store';

let fontAttempts = 0;
globalThis.FontFace = class MockFontFace {
  async load() {
    fontAttempts++;
    if (fontAttempts === 1) throw new Error('font offline');
    return this;
  }
};
globalThis.document = {
  fonts: {
    add() {},
  },
};

const { loadDefaultNerdFont, nerdFontReady } = await import('../src/lib/font.js');
await assert.rejects(loadDefaultNerdFont(), /font offline/);
await loadDefaultNerdFont();
assert.equal(fontAttempts, 2);
assert.equal(get(nerdFontReady), true);

let glyphAttempts = 0;
globalThis.fetch = async () => {
  glyphAttempts++;
  if (glyphAttempts === 1) return { ok: false, status: 503 };
  return {
    ok: true,
    async json() {
      return {
        'nf-fa-paint-brush': {
          char: '\uf1fc',
          code: 'f1fc',
        },
      };
    },
  };
};

const { loadNerdGlyphs, nerdGlyphs } = await import('../src/lib/nerdglyphs.js');
await assert.rejects(loadNerdGlyphs(), /503/);
await loadNerdGlyphs();
assert.equal(glyphAttempts, 2);
assert.equal(get(nerdGlyphs).ready, true);
assert.equal(get(nerdGlyphs).all.length, 1);

console.log('startup loader retry tests passed');
