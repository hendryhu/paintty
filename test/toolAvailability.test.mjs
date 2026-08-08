import assert from 'node:assert/strict';
import {
  glyphPaintingUnavailable,
  isToolDisabledForLayer,
  paintOwnerCreatedNotice,
  paintOwnerDisposition,
} from '../src/lib/toolAvailability.js';

const cell = { type: 'cell' };
const background = { type: 'background' };
const text = { type: 'text' };
const group = { type: 'group' };
const effect = { type: 'effect' };
const effectMask = { type: 'effect', mask: { cells: {} } };

assert.equal(glyphPaintingUnavailable(cell), false, 'Character remains full opacity for a cell layer');
for (const layer of [background, text, group, effect, { type: 'image' }, { type: 'video' }, { type: 'shape' }, null]) {
  assert.equal(glyphPaintingUnavailable(layer), true,
    `Character dims for ${layer?.type || 'no'} active target`);
}
assert.equal(glyphPaintingUnavailable(effectMask, 'mask'), true,
  'Character dims while an effect mask is active');

for (const tool of ['brush', 'eraser', 'fill']) {
  assert.deepEqual(
    [cell, background, text, effect, null]
      .map((layer) => isToolDisabledForLayer(tool, layer, 'layer')),
    [false, false, true, true, true],
    `${tool} should edit either raster channel and reject non-raster targets`,
  );
}

assert.deepEqual(
  [cell, background, text].map((layer) =>
    isToolDisabledForLayer('subcell', layer, 'layer')),
  [false, true, true],
  'the special brush should require glyph cells',
);

assert.deepEqual(
  [cell, text, group, effect, null].map((layer) =>
    isToolDisabledForLayer('move', layer, 'layer')),
  [false, false, false, true, true],
  'Move should accept movable layer bodies but reject effects and a missing target',
);

assert.deepEqual(
  [cell, background, text, group, null].map((layer) =>
    isToolDisabledForLayer('select', layer, 'layer')),
  [false, false, true, true, true],
  'Select should require a raster channel',
);

assert.deepEqual(
  [cell, group, null].map((layer) =>
    isToolDisabledForLayer('text', layer, 'layer')),
  [false, false, false],
  'Text should create a new layer independently of the selected layer body',
);

for (const tool of [
  'brush',
  'eraser',
  'fill',
  'eyedropper',
  'line',
  'rect',
  'circle',
  'move',
  'select',
  'crop',
  'color',
]) {
  assert.equal(
    isToolDisabledForLayer(tool, effectMask, 'mask'),
    false,
    `${tool} should target an effect mask`,
  );
}

for (const tool of ['text', 'subcell', 'polygon']) {
  assert.equal(
    isToolDisabledForLayer(tool, effectMask, 'mask'),
    true,
    `${tool} should stay unavailable for an effect mask`,
  );
}

for (const tool of ['eyedropper', 'line', 'crop', 'text', 'color']) {
  assert.equal(
    isToolDisabledForLayer(tool, effect, 'layer'),
    false,
    `${tool} should remain useful with an effect layer selected`,
  );
}
assert.equal(isToolDisabledForLayer('brush', effect, 'layer'), true);
assert.equal(isToolDisabledForLayer('move', effect, 'layer'), true);

assert.deepEqual([
  paintOwnerDisposition('brush', { ...cell, visible: true }, {
    activeClip: true, effectiveVisible: true,
  }),
  paintOwnerDisposition('brush', { ...cell, visible: true }, {
    activeClip: false, effectiveVisible: true,
  }),
  paintOwnerDisposition('fill', { ...background, visible: false }, {
    activeClip: true, effectiveVisible: true,
  }),
  paintOwnerDisposition('subcell', { ...cell, visible: true }, {
    activeClip: true, effectiveVisible: false,
  }),
  paintOwnerDisposition('brush', text, {
    activeClip: false, effectiveVisible: false,
  }),
], ['reuse', 'create', 'create', 'create', 'blocked'],
'positive paint reuses only a present visible compatible owner');
assert.equal(paintOwnerDisposition('brush', effectMask, {
  activePart: 'mask', activeClip: false, effectiveVisible: false,
}), 'reuse', 'effect-mask painting retains its explicit mask owner');
assert.equal(paintOwnerDisposition('eraser', { ...cell, visible: false }, {
  activeClip: false, effectiveVisible: false,
}), 'reuse', 'eraser does not create an empty replacement layer');

assert.equal(
  paintOwnerCreatedNotice({ name: 'Layer 7' }),
  'Created Layer 7 for this tick.',
  'fresh paint ownership names the visible replacement layer tersely',
);
for (const layer of [null, {}, { name: '   ' }]) {
  assert.equal(paintOwnerCreatedNotice(layer), null,
    'ordinary owner reuse has no synthetic creation notice');
}

console.log('ok - tool availability covers each distinct target capability');
