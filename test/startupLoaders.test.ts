import assert from 'node:assert/strict';
import { get } from 'svelte/store';

let fontAttempts = 0;
class MockFontFace implements FontFace {
  family: string;
  style = 'normal';
  weight = 'normal';
  stretch = 'normal';
  unicodeRange = 'U+0-10FFFF';
  variant = 'normal';
  featureSettings = 'normal';
  variationSettings = 'normal';
  display: FontDisplay = 'auto';
  ascentOverride = 'normal';
  descentOverride = 'normal';
  lineGapOverride = 'normal';
  status: FontFaceLoadStatus = 'unloaded';
  loaded: Promise<FontFace>;

  constructor(
    family: string,
    _source: string | BufferSource,
    _descriptors?: FontFaceDescriptors,
  ) {
    this.family = family;
    this.loaded = Promise.resolve(this);
  }

  async load(): Promise<FontFace> {
    fontAttempts++;
    if (fontAttempts === 1) throw new Error('font offline');
    return this;
  }
}
globalThis.FontFace = MockFontFace;
const fontSet: FontFaceSet = Object.create(null);
fontSet.add = () => fontSet;
const documentDouble: Document = Object.create(null);
globalThis.document = Object.assign(documentDouble, { fonts: fontSet });

const { loadDefaultNerdFont, nerdFontReady } = await import('../src/lib/font.ts');
await assert.rejects(loadDefaultNerdFont(), /font offline/);
await loadDefaultNerdFont();
assert.equal(fontAttempts, 2);
assert.equal(get(nerdFontReady), true);

let glyphAttempts = 0;
globalThis.fetch = async (): Promise<Response> => {
  glyphAttempts++;
  if (glyphAttempts === 1) return new Response(null, { status: 503 });
  return Response.json({
    'nf-fa-paint-brush': {
      char: '\uf1fc',
      code: 'f1fc',
    },
  });
};

const { loadNerdGlyphs, nerdGlyphs } = await import('../src/lib/nerdglyphs.ts');
await assert.rejects(loadNerdGlyphs(), /503/);
await loadNerdGlyphs();
assert.equal(glyphAttempts, 2);
assert.equal(get(nerdGlyphs).ready, true);
assert.equal(get(nerdGlyphs).all.length, 1);

console.log('startup loader retry tests passed');
