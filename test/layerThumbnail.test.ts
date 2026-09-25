import { drawContentMaskThumbnail, drawEffectMaskThumbnail, drawLayerThumbnail, THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from '../src/lib/layerThumbnail.ts';
import {
  canvasElement,
  requireValue,
  type EditorCellMap,
} from './types/timeline-media-test-types.ts';

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const actual = JSON.stringify(got);
  const expected = JSON.stringify(want);
  if (actual === expected) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  got:  ${actual}\n  want: ${expected}`);
  }
}

type RectCall = [number, number, number, number];
type TextCall = [string, number, number, number?];
interface FillCall { args: RectCall; color: string | CanvasGradient | CanvasPattern }
interface TextDrawCall {
  args: TextCall;
  color: string | CanvasGradient | CanvasPattern;
  font: string;
}
interface ImageDrawCall {
  args: [CanvasImageSource, number, number, number, number];
  alpha: number;
}
interface ImageDataCall { image: ImageData; x: number; y: number }

function mockCanvas() {
  const calls = {
    clearRect: [] as RectCall[],
    fillRect: [] as FillCall[],
    fillText: [] as TextDrawCall[],
    drawImage: [] as ImageDrawCall[],
    putImageData: [] as ImageDataCall[],
  };
  const context = Object.assign(Object.create(null) as CanvasRenderingContext2D, {
    globalAlpha: 1,
    fillStyle: '',
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    font: '',
    clearRect(...args: RectCall): void { calls.clearRect.push(args); },
    fillRect(...args: RectCall): void { calls.fillRect.push({ args, color: this.fillStyle }); },
    fillText(...args: TextCall): void {
      calls.fillText.push({ args, color: this.fillStyle, font: this.font });
    },
    save(): void {},
    restore(): void {},
    beginPath(): void {},
    rect(): void {},
    clip(): void {},
    translate(): void {},
    drawImage(...args: ImageDrawCall['args']): void {
      calls.drawImage.push({ args, alpha: this.globalAlpha });
    },
    createImageData(width: number, height: number): ImageData {
      return Object.assign(Object.create(null) as ImageData, {
        width,
        height,
        colorSpace: 'srgb' as PredefinedColorSpace,
        data: new Uint8ClampedArray(width * height * 4),
      });
    },
    putImageData(image: ImageData, x: number, y: number): void {
      calls.putImageData.push({ image, x, y });
    },
  });
  return Object.assign(canvasElement(context), { calls, context });
}

function pixel(image: ImageData, x: number, y: number): number[] {
  const index = (y * image.width + x) * 4;
  return Array.from(image.data.slice(index, index + 4));
}

const textCanvas = mockCanvas();
drawLayerThumbnail(textCanvas, {
  id: 'text',
  name: 'Text',
  type: 'text',
  visible: true,
  text: 'Hi',
  fg: '#ffffff',
  wrap: false,
  runs: [],
  box: { x: 0, y: 0, w: 2, h: 1 },
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
  Array.from({ length: 3 }, () => [['H', '#ff0000'], ['i', '#00ff00']]).flat(),
);
eq('transparent-text-does-not-become-a-filled-rectangle', textCanvas.calls.fillRect.length, 0);

const backgroundCanvas = mockCanvas();
drawLayerThumbnail(backgroundCanvas, {
  id: 'background',
  name: 'Background',
  type: 'background',
  visible: true,
  cells: { '0,0': { c: '', fg: null, bg: '#123456' } },
});
eq('background-thumbnail-still-draws-color-channel',
  backgroundCanvas.calls.fillRect.map((call) => call.color),
  ['#123456'],
);

const imageCanvas = mockCanvas();
const raster = canvasElement();
raster.width = 100;
raster.height = 50;
drawLayerThumbnail(imageCanvas, {
  id: 'image',
  name: 'Image',
  type: 'image',
  visible: true,
  cells: {},
  assetId: 'asset',
  sourceWidth: 100,
  sourceHeight: 50,
  transform: { x: 0, y: 0 },
  raster,
  opacity: 0.4,
});
eq('image-thumbnail-draws-the-raster-with-opacity', {
  raster: requireValue(imageCanvas.calls.drawImage[0]).args[0] === raster,
  alpha: requireValue(imageCanvas.calls.drawImage[0]).alpha,
  restoredAlpha: imageCanvas.context.globalAlpha,
}, {
  raster: true,
  alpha: 0.4,
  restoredAlpha: 1,
});

const maskCanvas = mockCanvas();
drawEffectMaskThumbnail(maskCanvas, { defaultStrength: 1, cells: { '0,0': { mask: 0 }, '1,0': { mask: 0.5 } } }, 2, 1);
const maskImage = requireValue(maskCanvas.calls.putImageData[0]).image;
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
const contentMaskCanvas = mockCanvas();
drawContentMaskThumbnail(contentMaskCanvas, {
  defaultStrength: 1,
  cells: { '0,0': { bg: '#e06c6c' }, '1,0': { bg: '#ffffff' } },
}, 2, 1);
const contentMaskImage = requireValue(contentMaskCanvas.calls.putImageData[0]).image;
eq('content-mask-thumbnail-uses-binary-white-reveal-semantics', [
  pixel(contentMaskImage, 0, 22),
  pixel(contentMaskImage, 55, 22),
], [
  [0, 0, 0, 255],
  [255, 255, 255, 255],
]);
const shiftedMaskCanvas = mockCanvas();
drawEffectMaskThumbnail(shiftedMaskCanvas, {
  defaultStrength: 1,
  offset: { x: 1, y: 0 },
  cells: { '0,0': { mask: 0 } },
}, 2, 1);
const shiftedMaskImage = requireValue(shiftedMaskCanvas.calls.putImageData[0]).image;
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
const fullyShiftedMaskImage = requireValue(fullyShiftedMaskCanvas.calls.putImageData[0]).image;
eq('effect-mask-thumbnail-uses-the-full-layer-and-group-position', [
  pixel(fullyShiftedMaskImage, 13, 22),
  pixel(fullyShiftedMaskImage, 42, 22),
], [
  [255, 255, 255, 255],
  [0, 0, 0, 255],
]);

const blackCells: EditorCellMap = {};
for (let y = 0; y < 30; y++) {
  for (let x = 0; x < 80; x++) blackCells[x + ',' + y] = { mask: 0 };
}
const blackMaskCanvas = mockCanvas();
drawEffectMaskThumbnail(blackMaskCanvas, { defaultStrength: 1, cells: blackCells }, 80, 30);
const blackImage = requireValue(blackMaskCanvas.calls.putImageData[0]).image;
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
