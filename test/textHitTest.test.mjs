import {
  beginTextGesture,
  moveTextGesture,
  resolveTextGesture,
  textGestureSelection,
  textLayerAt,
} from '../src/lib/textHitTest.js';

let pass = 0;
let fail = 0;
function eq(name, got, want) {
  if (got === want) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  }
}

function deepEq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  }
}

const overlay = {
  id: 'overlay',
  type: 'text',
  visible: true,
  box: { x: 0, y: 0, w: 80, h: 30 },
  offset: { x: 0, y: 0 },
  cells: { '12,10': { c: '.' }, '70,20': { c: '.' } },
};
const runner = {
  id: 'runner',
  type: 'text',
  visible: true,
  box: { x: 10, y: 9, w: 8, h: 4 },
  offset: { x: 0, y: 0 },
  cells: { '12,10': { c: '@' } },
};
const label = {
  id: 'label',
  type: 'text',
  visible: true,
  box: { x: 20, y: 4, w: 10, h: 3 },
  offset: { x: 0, y: 0 },
  cells: { '20,4': { c: 'L' } },
};
const overflow = {
  id: 'overflow',
  type: 'text',
  visible: true,
  box: { x: 2, y: 2, w: 5, h: 1 },
  offset: { x: 4, y: 3 },
  cells: { '3,5': { c: 'A' }, '4,5': { c: '界' }, '5,5': { c: '', cont: true } },
};
const castleShape = {
  id: 'castle-shape',
  type: 'shape',
  visible: true,
  cells: { '7,8': { c: '#' } },
};
const helpers = {
  isVisible: (layer) => layer.visible,
  offsetOf: (layer) => layer.offset,
  boxOf: (layer) => layer.box,
};

eq('selected-text-box-wins-over-full-canvas-text-glyph',
  textLayerAt([overlay, runner], runner.id, 12, 10, helpers)?.id,
  runner.id,
);
eq('selected-text-captures-empty-space-inside-its-box',
  textLayerAt([overlay, runner], runner.id, 16, 11, helpers)?.id,
  runner.id,
);
eq('visible-glyph-wins-over-empty-space-in-selected-text-box',
  textLayerAt([label, overlay], overlay.id, 20, 4, helpers)?.id,
  label.id,
);
eq('inactive-text-captures-empty-space-inside-its-box',
  textLayerAt([label, overlay, runner], runner.id, 27, 5, helpers)?.id,
  label.id,
);
eq('top-visible-glyph-wins-outside-selected-box',
  textLayerAt([overlay, runner], runner.id, 70, 20, helpers)?.id,
  overlay.id,
);
runner.visible = false;
eq('hidden-selected-text-does-not-capture',
  textLayerAt([overlay, runner], runner.id, 12, 10, helpers)?.id,
  overlay.id,
);
eq('visible-overflow-glyph-reopens-its-text-layer',
  textLayerAt([overflow], null, 7, 8, helpers)?.id,
  overflow.id,
);
eq('wide-overflow-continuation-reopens-the-owning-text-layer',
  textLayerAt([overflow], null, 9, 8, helpers)?.id,
  overflow.id,
);
eq('blank-space-beyond-the-text-box-does-not-create-a-phantom-hit-area',
  textLayerAt([overflow], null, 10, 8, helpers)?.id,
  undefined,
);

const overflowHit = textLayerAt([overflow, castleShape], castleShape.id, 7, 8, helpers);
const clickedOverflow = beginTextGesture(7, 8, overflowHit?.id, { onGlyph: true });
deepEq('clicking-overflow-text-still-edits-the-hit-layer',
  resolveTextGesture(clickedOverflow),
  { action: 'edit', layerId: overflow.id },
);

const draggedAcrossOverflow = moveTextGesture(clickedOverflow, 12, 11);
deepEq('dragging-from-overflow-text-edits-the-hit-layer',
  resolveTextGesture(draggedAcrossOverflow),
  { action: 'edit', layerId: overflow.id },
);

const draggedFromBlankTextInterior = moveTextGesture(
  beginTextGesture(6, 6, overflow.id),
  12,
  11,
);
deepEq('dragging-from-blank-text-interior-creates-a-new-box',
  resolveTextGesture(draggedFromBlankTextInterior),
  { action: 'create', box: { x: 6, y: 6, w: 7, h: 6 } },
);

const blankDrag = moveTextGesture(beginTextGesture(4, 6), 2, 3);
deepEq('dragging-empty-space-normalizes-the-new-text-box',
  resolveTextGesture(blankDrag),
  { action: 'create', box: { x: 2, y: 3, w: 3, h: 4 } },
);

const textBox = { x: 10, y: 5, w: 4, h: 3 };
const plainText = { text: 'ABCD', wrap: true };
deepEq('click-at-a-glyph-midpoint-places-a-caret',
  textGestureSelection(
    plainText,
    textBox,
    beginTextGesture(10, 5, 'plain', { x: 0.5, y: 0.5 }),
  ),
  { start: 1, end: 1, direction: 'none' },
);
deepEq('forward-drag-selects-the-glyphs-under-both-endpoints',
  textGestureSelection(
    plainText,
    textBox,
    moveTextGesture(
      beginTextGesture(10, 5, 'plain', { x: 0.1, y: 0.5 }),
      13,
      5,
      { x: 0.9, y: 0.5 },
    ),
  ),
  { start: 0, end: 4, direction: 'forward' },
);
deepEq('reverse-drag-keeps-the-range-and-direction',
  textGestureSelection(
    plainText,
    textBox,
    moveTextGesture(
      beginTextGesture(13, 5, 'plain', { x: 0.9, y: 0.5 }),
      10,
      5,
      { x: 0.1, y: 0.5 },
    ),
  ),
  { start: 0, end: 4, direction: 'backward' },
);

const wrappedText = { text: 'AB CD\nEF', wrap: true };
deepEq('wrapped-lines-and-explicit-newlines-map-to-source-offsets',
  textGestureSelection(
    wrappedText,
    { ...textBox, w: 3 },
    moveTextGesture(
      beginTextGesture(10, 6, 'wrapped', { x: 0.1, y: 0.5 }),
      11,
      7,
      { x: 0.9, y: 0.5 },
    ),
  ),
  { start: 3, end: 8, direction: 'forward' },
);

const wideText = { text: 'A界B', wrap: true };
deepEq('wide-glyph-halves-map-to-one-grapheme-range',
  textGestureSelection(
    wideText,
    textBox,
    moveTextGesture(
      beginTextGesture(11, 5, 'wide', { x: 0.1, y: 0.5 }),
      12,
      5,
      { x: 0.9, y: 0.5 },
    ),
  ),
  { start: 1, end: 2, direction: 'forward' },
);

const emojiText = { text: 'A🙂B', wrap: true };
deepEq('emoji-selection-preserves-utf16-boundaries',
  textGestureSelection(
    emojiText,
    textBox,
    moveTextGesture(
      beginTextGesture(11, 5, 'emoji', { x: 0.1, y: 0.5 }),
      12,
      5,
      { x: 0.9, y: 0.5 },
    ),
  ),
  { start: 1, end: 3, direction: 'forward' },
);

deepEq('selection-points-outside-the-layout-clamp-to-the-text',
  textGestureSelection(
    plainText,
    textBox,
    moveTextGesture(
      beginTextGesture(0, 0, 'plain'),
      40,
      40,
    ),
  ),
  { start: 0, end: 4, direction: 'forward' },
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
