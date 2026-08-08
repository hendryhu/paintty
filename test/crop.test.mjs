import { canvasCrop, cropDiffers, dragCrop } from '../src/lib/crop.js';

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

const base = { x: 10, y: 5, w: 20, h: 10 };
eq('move-crop-window', dragCrop(base, 'move', -4, 3), { x: 6, y: 8, w: 20, h: 10 });
eq('resize-west-keeps-east-edge', dragCrop(base, 'w', 3, 0), { x: 13, y: 5, w: 17, h: 10 });
eq('resize-north-keeps-south-edge', dragCrop(base, 'n', 0, -2), { x: 10, y: 3, w: 20, h: 12 });
eq('resize-southeast', dragCrop(base, 'se', 4, 6), { x: 10, y: 5, w: 24, h: 16 });
eq('resize-northwest', dragCrop(base, 'nw', -5, -4), { x: 5, y: 1, w: 25, h: 14 });
eq('resize-cannot-invert', dragCrop(base, 'w', 100, 0), { x: 29, y: 5, w: 1, h: 10 });
eq('resize-is-limited-to-256-cells', dragCrop(base, 'e', 1000, 0), { x: 10, y: 5, w: 256, h: 10 });
eq('default-crop-is-full-canvas', canvasCrop(80, 30), { x: 0, y: 0, w: 80, h: 30 });
eq('crop-change-detects-moved-origin', cropDiffers({ x: 1, y: 0, w: 80, h: 30 }, 80, 30), true);
eq('crop-change-recognizes-full-canvas', cropDiffers(canvasCrop(80, 30), 80, 30), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
