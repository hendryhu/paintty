import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import {
  activeLayerPart,
  layers,
  selectLayerPart,
  setLayers,
} from '../src/lib/grid.ts';
import {
  beginLayerMove,
  canMoveLayerTarget,
  cancelMove,
  moveState,
} from '../src/lib/selection.ts';
import type {
  EditorCellLayer,
  EditorEffectLayer,
  EditorLayer,
  EditorLayerPart,
  EditorShapeLayer,
} from '../src/lib/types/editor-domain.ts';

const glyphCells = { '0,0': { c: 'X', fg: '#ffffff' } };
const backgroundCells = { '0,0': { bg: '#224466' } };
const maskCells = { '0,0': { mask: 1 } };

const cases: Array<[string, EditorLayer | null, EditorLayerPart, boolean]> = [
  ['populated glyph layer', { type: 'cell', cells: glyphCells } as unknown as EditorCellLayer, 'layer', true],
  ['populated background layer', { type: 'background', cells: backgroundCells } as unknown as EditorCellLayer, 'layer', true],
  ['effect mask', { type: 'effect', cells: {}, mask: { cells: maskCells } } as unknown as EditorEffectLayer, 'mask', true],
  ['empty glyph layer', { type: 'cell', cells: {} } as EditorCellLayer, 'layer', false],
  ['non-raster layer', { type: 'shape', cells: glyphCells } as unknown as EditorShapeLayer, 'layer', false],
  ['effect layer body', { type: 'effect', cells: glyphCells, mask: { cells: maskCells } } as unknown as EditorEffectLayer, 'layer', false],
  ['empty effect mask', { type: 'effect', cells: {}, mask: { cells: {} } } as EditorEffectLayer, 'mask', false],
  ['missing target', null, 'layer', false],
];

for (const [name, layer, part, expected] of cases) {
  assert.equal(canMoveLayerTarget(layer, part), expected, name);
}

setLayers([{
  name: 'Masked effect',
  type: 'effect',
  visible: true,
  cells: {},
  effect: { kind: 'brightness', intensity: 0.25 },
  mask: { defaultStrength: 1, cells: maskCells, offset: { x: 0, y: 0 } },
}]);
const effectId = get(layers)[0]!.id;

assert.equal(selectLayerPart(effectId, 'mask'), true);
assert.equal(get(activeLayerPart), 'mask');
assert.equal(beginLayerMove(), true);
assert.equal(get(moveState)?.target, 'mask');
cancelMove();

assert.equal(selectLayerPart(effectId, 'layer', true), true);
assert.equal(get(activeLayerPart), 'layer');
assert.equal(beginLayerMove(), false);
assert.equal(get(moveState), null);

console.log('ok - layer context Move follows explicit target capability and mask part');
