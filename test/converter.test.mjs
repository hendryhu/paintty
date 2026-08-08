import assert from 'node:assert/strict';
import {
  CHARACTER_SETS,
  convertImage,
  convertImageAsync,
  imageToLayerPair,
  limitCharacters,
  uniqueCharacters,
} from '../src/lib/converter.js';

class FakeCanvas {
  constructor(width = 0, height = 0, pixels = null) {
    this._width = width;
    this._height = height;
    this.pixels = pixels ? new Uint8ClampedArray(pixels) : new Uint8ClampedArray(width * height * 4);
    this.context = new FakeContext(this);
  }

  get width() { return this._width; }
  set width(value) { this.resize(value, this._height); }
  get height() { return this._height; }
  set height(value) { this.resize(this._width, value); }

  resize(width, height) {
    this._width = Number(width);
    this._height = Number(height);
    this.pixels = new Uint8ClampedArray(this._width * this._height * 4);
  }

  getContext() { return this.context; }
}

class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000000';
    this.font = '';
    this.textAlign = '';
    this.textBaseline = '';
    this.imageSmoothingEnabled = false;
  }

  clearRect() {
    this.canvas.pixels.fill(0);
  }

  drawImage(source, _x, _y, width, height) {
    const targetWidth = width ?? source.width;
    const targetHeight = height ?? source.height;
    for (let y = 0; y < targetHeight; y++) {
      const sourceY = Math.min(source.height - 1, Math.floor(y * source.height / targetHeight));
      for (let x = 0; x < targetWidth; x++) {
        const sourceX = Math.min(source.width - 1, Math.floor(x * source.width / targetWidth));
        const from = (sourceY * source.width + sourceX) * 4;
        const to = (y * this.canvas.width + x) * 4;
        this.canvas.pixels.set(source.pixels.subarray(from, from + 4), to);
      }
    }
  }

  fillText(character) {
    const { width, height } = this.canvas;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!syntheticGlyphPixel(character, x, y, width, height)) continue;
        const index = (y * width + x) * 4;
        this.canvas.pixels[index] = 255;
        this.canvas.pixels[index + 1] = 255;
        this.canvas.pixels[index + 2] = 255;
        this.canvas.pixels[index + 3] = 255;
      }
    }
  }

  getImageData() {
    return {
      data: new Uint8ClampedArray(this.canvas.pixels),
      width: this.canvas.width,
      height: this.canvas.height,
    };
  }
}

function syntheticGlyphPixel(character, x, y, width, height) {
  if (character === 'L') return x < width / 2;
  if (character === 'R') return x >= width / 2;
  const codepoint = character.codePointAt(0);
  if (codepoint >= 0x100 && codepoint < 0x180) {
    const index = y * width + x;
    return (index + codepoint - 0x100) % (width * height) < width * height / 2;
  }
  if (character === '░') return x % 4 === 0;
  if (character === '▒') return x % 2 === 0;
  if (character === '▓') return x % 4 !== 0;
  if (character === '▁') return y === height - 1;
  if (character === '▅') return y >= height * 3 / 8;
  if (character === '▀') return y < height / 2;
  if (character === '▞') return (x + y) % 2 === 0;
  return true;
}

globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas');
    return new FakeCanvas();
  },
};

let passed = 0;
let failed = 0;
const asyncTests = [];

function test(name, run) {
  try {
    run();
    passed++;
  } catch (error) {
    failed++;
    console.error('FAIL ' + name, error.stack);
  }
}

function testAsync(name, run) {
  asyncTests.push({ name, run });
}

function fixture(width, height, rgba) {
  assert.equal(rgba.length, width * height * 4);
  return new FakeCanvas(width, height, rgba);
}

const transparentPair = fixture(4, 1, [
  255, 0, 0, 255,
  0, 0, 255, 64,
  0, 0, 0, 0,
  0, 0, 0, 0,
]);

test('unicode art exposes thousands of unique adjustable glyph candidates', () => {
  const characters = uniqueCharacters(CHARACTER_SETS.unicodeArt);
  assert.ok(characters.length > 2_000);
  for (const glyph of [' ', '@', '╬', '▟', '⣿', '∑', '→']) {
    assert.ok(characters.includes(glyph), 'missing ' + glyph);
  }
  const limited = limitCharacters(characters, 2_048);
  assert.equal(limited.length, 2_048);
  assert.equal(new Set(limited).size, limited.length);
  assert.equal(limited[0], ' ');
  const core = limitCharacters(characters, 192, true);
  for (const glyph of ['@', '╬', '▟', '⣿']) {
    assert.ok(core.includes(glyph), 'ranked core missing ' + glyph);
  }
  assert.ok(characters.every((glyph) =>
    glyph === ' ' || !/[\p{Cc}\p{Cf}\p{Cs}\p{M}\p{Z}\p{Emoji_Presentation}]/u.test(glyph)));
});

test('conversion preserves transparent cells and separates foreground from source background', () => {
  const result = imageToLayerPair(transparentPair, {
    cols: 2,
    rows: 1,
    sampleW: 2,
    sampleH: 1,
    mode: 'glyph',
    charset: 'custom',
    characters: 'X',
    glyphLimit: 2,
    colorLimit: 2,
    background: 'source',
  });

  assert.deepEqual(result.foreground, {
    '0,0': { c: 'X', fg: '#ff0000', bg: null },
  });
  assert.deepEqual(result.background, {
    '0,0': { c: '', fg: null, bg: '#0000ff' },
  });
  assert.equal(result.meta.transparentRatio, 0.5);
});

test('solid background reaches fully transparent cells without inventing foreground', () => {
  const result = convertImage(transparentPair, 'glyph', {
    cols: 2,
    rows: 1,
    sampleW: 2,
    sampleH: 1,
    charset: 'custom',
    characters: 'Q',
    glyphLimit: 2,
    background: 'solid',
    backgroundColor: '#123456',
  });

  assert.equal(result.foreground['1,0'], undefined);
  assert.deepEqual(result.background, {
    '0,0': { c: '', fg: null, bg: '#123456' },
    '1,0': { c: '', fg: null, bg: '#123456' },
  });
});

test('custom charset is deduplicated and is the only source of emitted glyphs', () => {
  const source = fixture(1, 1, [0, 0, 0, 255]);
  const result = imageToLayerPair(source, {
    cols: 1,
    rows: 1,
    sampleW: 1,
    sampleH: 1,
    mode: 'glyph',
    charset: 'custom',
    characters: 'ΩΩ',
    glyphLimit: 8,
    colorLimit: 8,
  });

  assert.equal(result.meta.characters, ' Ω');
  assert.deepEqual(result.foreground, {
    '0,0': { c: 'Ω', fg: '#000000', bg: null },
  });
});

test('one-color quantization independently averages the RGBA fixture', () => {
  const source = fixture(4, 1, [
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 0, 255,
  ]);
  const result = imageToLayerPair(source, {
    cols: 4,
    rows: 1,
    sampleW: 1,
    sampleH: 1,
    mode: 'glyph',
    charset: 'custom',
    characters: 'X',
    glyphLimit: 2,
    colorLimit: 1,
    background: 'source',
  });

  const expectedAverage = '#808040';
  assert.deepEqual(result.meta.palette, [expectedAverage]);
  assert.deepEqual(
    Object.values(result.background).map((cell) => cell.bg),
    [expectedAverage, expectedAverage, expectedAverage, expectedAverage],
  );
  assert.deepEqual(result.foreground, {
    '0,0': { c: 'X', fg: expectedAverage, bg: null },
    '2,0': { c: 'X', fg: expectedAverage, bg: null },
  });
});

test('a flat image reports one quantized color even when the limit is higher', () => {
  const source = fixture(4, 1, new Array(4).fill([12, 34, 56, 255]).flat());
  const result = imageToLayerPair(source, {
    cols: 4,
    rows: 1,
    sampleW: 1,
    sampleH: 1,
    mode: 'glyph',
    charset: 'custom',
    characters: 'X',
    glyphLimit: 2,
    colorLimit: 16,
  });

  assert.deepEqual(result.meta.palette, ['#0c2238']);
});

test('synthetic glyph atlas distinguishes equal-density shapes', () => {
  const source = fixture(2, 2, [
    0, 0, 0, 0, 12, 34, 56, 255,
    0, 0, 0, 0, 12, 34, 56, 255,
  ]);
  const result = imageToLayerPair(source, {
    cols: 1,
    rows: 1,
    sampleW: 2,
    sampleH: 2,
    mode: 'glyph',
    charset: 'custom',
    characters: 'LR',
    glyphLimit: 3,
    colorLimit: 4,
  });

  assert.deepEqual(result.foreground, {
    '0,0': { c: 'R', fg: '#0c2238', bg: null },
  });
});

test('synthetic glyph atlas searches beyond a local equal-density coverage window', () => {
  const pixels = [];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      pixels.push(...(x >= 8 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    }
  }
  const distractors = Array.from({ length: 96 }, (_, index) =>
    String.fromCodePoint(0x100 + index)).join('');
  const result = imageToLayerPair(fixture(16, 16, pixels), {
    cols: 1,
    rows: 1,
    sampleW: 16,
    sampleH: 16,
    mode: 'glyph',
    charset: 'custom',
    characters: distractors + 'R',
    glyphLimit: 128,
    colorLimit: 2,
  });

  assert.ok(uniqueCharacters(result.meta.characters).length > 64);
  assert.equal(result.foreground['0,0'].c, 'R');
});

test('bounded palette sampling does not alias alternating image colors', () => {
  const pixels = [];
  for (let x = 0; x < 24000; x++) {
    pixels.push(...(x % 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  }
  const result = imageToLayerPair(fixture(24000, 1, pixels), {
    cols: 1,
    rows: 1,
    sampleW: 24000,
    sampleH: 1,
    mode: 'density',
    charset: 'custom',
    characters: 'X',
    glyphLimit: 2,
    colorLimit: 2,
  });

  assert.deepEqual(new Set(result.meta.palette), new Set(['#0000ff', '#ff0000']));
});

test('density conversion matches coverage independently of shape', () => {
  const source = fixture(4, 1, [
    0, 0, 0, 255,
    0, 0, 0, 255,
    255, 255, 255, 255,
    255, 255, 255, 255,
  ]);
  const result = imageToLayerPair(source, {
    cols: 1,
    rows: 1,
    sampleW: 4,
    sampleH: 1,
    mode: 'density',
    charset: 'custom',
    characters: '░▒▓',
    glyphLimit: 4,
    colorLimit: 2,
  });

  assert.equal(result.foreground['0,0'].c, '▒');
});

test('block conversion preserves a directional block and its two colors', () => {
  const source = fixture(2, 4, [
    255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255,
    0, 0, 0, 255, 0, 0, 0, 255,
  ]);
  const result = imageToLayerPair(source, {
    cols: 1,
    rows: 1,
    sampleW: 2,
    sampleH: 4,
    mode: 'blocks',
    charset: 'custom',
    characters: '▁▀█',
    glyphLimit: 4,
    colorLimit: 4,
    background: 'source',
  });

  assert.deepEqual(result.foreground, {
    '0,0': { c: '▁', fg: '#000000', bg: null },
  });
  assert.deepEqual(result.background, {
    '0,0': { c: '', fg: null, bg: '#ffffff' },
  });
});

test('block conversion ignores the hidden character-set preference', () => {
  const source = fixture(2, 4, [
    255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255,
    0, 0, 0, 255, 0, 0, 0, 255,
  ]);
  const options = {
    cols: 1,
    rows: 1,
    sampleW: 2,
    sampleH: 4,
    glyphLimit: 6,
    colorLimit: 2,
    background: 'source',
  };

  const unicode = imageToLayerPair(source, {
    ...options,
    mode: 'blocks',
    charset: 'unicodeArt',
  });
  const ascii = imageToLayerPair(source, {
    ...options,
    mode: 'blocks',
    charset: 'ascii',
  });
  assert.deepEqual(unicode, ascii);
});

test('auto conversion sends an opaque high-color image through block matching', () => {
  const source = fixture(5, 1, [
    0, 0, 0, 255,
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 255, 255,
  ]);
  const result = imageToLayerPair(source, {
    cols: 5,
    rows: 1,
    sampleW: 1,
    sampleH: 1,
    mode: 'auto',
    glyphLimit: 5,
    colorLimit: 5,
  });

  assert.equal(result.meta.mode, 'blocks');
  assert.equal(result.foreground['0,0'].c, '█');
});

testAsync('cooperative conversion is invariant to batch boundaries', async () => {
  const source = fixture(4, 2, [
    0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 12, 34, 56, 255,
    0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 12, 34, 56, 255,
  ]);
  const options = {
    cols: 2,
    rows: 1,
    sampleW: 2,
    sampleH: 2,
    charset: 'custom',
    characters: 'LR░',
    glyphLimit: 4,
    colorLimit: 3,
    background: 'source',
  };
  const fineBatches = await convertImageAsync(source, 'glyph', options, {
    batchCells: 1,
    batchGlyphs: 1,
    yieldControl: () => Promise.resolve(),
  });
  const coarseBatches = await convertImageAsync(source, 'glyph', options, {
    batchCells: 64,
    batchGlyphs: 64,
    yieldControl: () => Promise.resolve(),
  });
  assert.deepEqual(fineBatches, coarseBatches);
});

testAsync('cooperative conversion can abort before pixel analysis', async () => {
  const controller = new AbortController();
  const source = fixture(1, 1, [0, 0, 0, 255]);
  let yields = 0;
  await assert.rejects(
    convertImageAsync(source, 'glyph', {
      cols: 1,
      rows: 1,
      sampleW: 100,
      sampleH: 1,
      charset: 'custom',
      characters: 'PX',
    }, {
      signal: controller.signal,
      batchPixels: 1,
      yieldControl: async () => {
        if (++yields === 1) controller.abort();
      },
    }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(yields, 1);
});

testAsync('cooperative conversion aborts without publishing a partial atlas', async () => {
  const controller = new AbortController();
  const source = fixture(1, 1, [0, 0, 0, 255]);
  let yields = 0;
  await assert.rejects(
    convertImageAsync(source, 'glyph', {
      cols: 1,
      rows: 1,
      sampleW: 3,
      sampleH: 3,
      charset: 'custom',
      characters: 'abcdefΩЖ∑╬',
      glyphLimit: 12,
    }, {
      signal: controller.signal,
      batchGlyphs: 1,
      yieldControl: async () => {
        if (++yields === 2) controller.abort();
      },
    }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(yields, 2);
});

testAsync('cooperative conversion aborts between cell batches', async () => {
  const pixels = new Array(4 * 4 * 4).fill(255);
  const source = fixture(4, 4, pixels);
  const options = {
    cols: 4,
    rows: 4,
    sampleW: 1,
    sampleH: 1,
    charset: 'custom',
    characters: 'LR',
    glyphLimit: 3,
  };
  convertImage(source, 'glyph', options);
  const controller = new AbortController();
  let yields = 0;
  await assert.rejects(
    convertImageAsync(source, 'glyph', options, {
      signal: controller.signal,
      batchCells: 1,
      yieldControl: async () => {
        if (++yields === 2) controller.abort();
      },
    }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(yields, 2);
});

for (const { name, run } of asyncTests) {
  try {
    await run();
    passed++;
  } catch (error) {
    failed++;
    console.error('FAIL ' + name, error.stack);
  }
}

console.log();
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
