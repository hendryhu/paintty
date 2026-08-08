import { drawEffectMaskThumbnail, drawLayerThumbnail, THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from '../src/lib/layerThumbnail.js';

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  const actual = JSON.stringify(got);
  const expected = JSON.stringify(want);
  if (actual === expected) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  got:  ${actual}\n  want: ${expected}`);
  }
}

function mockCanvas() {
  const calls = { clearRect: [], fillRect: [], fillText: [], drawImage: [], putImageData: [] };
  const context = {
    globalAlpha: 1,
    fillStyle: '',
    textAlign: '',
    textBaseline: '',
    font: '',
    clearRect(...args) { calls.clearRect.push(args); },
    fillRect(...args) { calls.fillRect.push({ args, color: this.fillStyle }); },
    fillText(...args) { calls.fillText.push({ args, color: this.fillStyle, font: this.font }); },
    drawImage(...args) { calls.drawImage.push({ args, alpha: this.globalAlpha }); },
    createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
    putImageData(image, x, y) { calls.putImageData.push({ image, x, y }); },
  };
  return {
    width: 0,
    height: 0,
    calls,
    context,
    getContext() { return context; },
  };
}

function pixel(image, x, y) {
  const index = (y * image.width + x) * 4;
  return Array.from(image.data.slice(index, index + 4));
}

const textCanvas = mockCanvas();
drawLayerThumbnail(textCanvas, {
  type: 'text',
  cells: {
    '0,0': { c: 'H', fg: '#ff0000', bg: null },
    '1,0': { c: 'i', fg: '#00ff00', bg: null },
  },
}, '"Terminal Font"');
eq('text-thumbnail-keeps-useful-resolution', {
  width: textCanvas.width,
  height: textCanvas.height,
}, {
  width: THUMBNAIL_WIDTH,
  height: THUMBNAIL_HEIGHT,
});
eq('text-thumbnail-draws-glyphs-instead-of-solid-blocks',
  textCanvas.calls.fillText.map((call) => [call.args[0], call.color]),
  [['H', '#ff0000'], ['i', '#00ff00']],
);
eq('transparent-text-does-not-become-a-filled-rectangle', textCanvas.calls.fillRect.length, 0);

const backgroundCanvas = mockCanvas();
drawLayerThumbnail(backgroundCanvas, {
  type: 'background',
  cells: { '0,0': { c: '', fg: null, bg: '#123456' } },
});
eq('background-thumbnail-still-draws-color-channel',
  backgroundCanvas.calls.fillRect.map((call) => call.color),
  ['#123456'],
);

const imageCanvas = mockCanvas();
const raster = { width: 100, height: 50 };
drawLayerThumbnail(imageCanvas, { type: 'image', raster, opacity: 0.4 });
eq('image-thumbnail-draws-the-raster-with-opacity', {
  raster: imageCanvas.calls.drawImage[0].args[0] === raster,
  alpha: imageCanvas.calls.drawImage[0].alpha,
  restoredAlpha: imageCanvas.context.globalAlpha,
}, {
  raster: true,
  alpha: 0.4,
  restoredAlpha: 1,
});

const maskCanvas = mockCanvas();
drawEffectMaskThumbnail(maskCanvas, { defaultStrength: 1, cells: { '0,0': { mask: 0 }, '1,0': { mask: 0.5 } } }, 2, 1);
const maskImage = maskCanvas.calls.putImageData[0].image;
eq('effect-mask-thumbnail-samples-cell-strengths-without-fractional-seams', [
  pixel(maskImage, 0, 0),
  pixel(maskImage, 27, 43),
  pixel(maskImage, 28, 0),
  pixel(maskImage, 55, 43),
], [
  [0, 0, 0, 255],
  [0, 0, 0, 255],
  [128, 128, 128, 255],
  [128, 128, 128, 255],
]);
const shiftedMaskCanvas = mockCanvas();
drawEffectMaskThumbnail(shiftedMaskCanvas, {
  defaultStrength: 1,
  offset: { x: 1, y: 0 },
  cells: { '0,0': { mask: 0 } },
}, 2, 1);
const shiftedMaskImage = shiftedMaskCanvas.calls.putImageData[0].image;
eq('effect-mask-thumbnail-follows-mask-position', [
  pixel(shiftedMaskImage, 0, 22),
  pixel(shiftedMaskImage, 55, 22),
], [
  [255, 255, 255, 255],
  [0, 0, 0, 255],
]);
const fullyShiftedMaskCanvas = mockCanvas();
drawEffectMaskThumbnail(fullyShiftedMaskCanvas, {
  defaultStrength: 1,
  offset: { x: 1, y: 0 },
  cells: { '0,0': { mask: 0 } },
}, 4, 1, { x: 3, y: 0 });
const fullyShiftedMaskImage = fullyShiftedMaskCanvas.calls.putImageData[0].image;
eq('effect-mask-thumbnail-uses-the-full-layer-and-group-position', [
  pixel(fullyShiftedMaskImage, 13, 22),
  pixel(fullyShiftedMaskImage, 42, 22),
], [
  [255, 255, 255, 255],
  [0, 0, 0, 255],
]);

const blackCells = {};
for (let y = 0; y < 30; y++) {
  for (let x = 0; x < 80; x++) blackCells[x + ',' + y] = { mask: 0 };
}
const blackMaskCanvas = mockCanvas();
drawEffectMaskThumbnail(blackMaskCanvas, { defaultStrength: 1, cells: blackCells }, 80, 30);
const blackImage = blackMaskCanvas.calls.putImageData[0].image;
let solidBlack = true;
for (let index = 0; index < blackImage.data.length; index += 4) {
  if (blackImage.data[index] !== 0 || blackImage.data[index + 1] !== 0
    || blackImage.data[index + 2] !== 0 || blackImage.data[index + 3] !== 255) {
    solidBlack = false;
    break;
  }
}
eq('filled-black-mask-thumbnail-has-no-grid-artifacts', solidBlack, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
