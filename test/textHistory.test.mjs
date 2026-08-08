import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import {
  beginStroke,
  cancelStroke,
  createTextLayer,
  endStroke,
  layers,
  redo,
  renameLayer,
  setLayers,
  undo,
  updateTextLayer,
} from '../src/lib/grid.js';
import { renderTextToCells } from '../src/lib/textLayer.js';

const renderNarrowText = (text, box, fg, wrap, runs) =>
  renderTextToCells(text, box, fg, wrap, runs, () => false);

function textDefinition(text, wrap = true) {
  const box = { x: 1, y: 1, w: 3, h: 1 };
  return {
    name: 'Layer 1',
    type: 'text',
    visible: true,
    text,
    box,
    wrap,
    fg: '#ffffff',
    runs: [],
    cells: renderNarrowText(text, box, '#ffffff', wrap, []),
  };
}

function activeText() {
  return get(layers).find((layer) => layer.type === 'text');
}

setLayers([textDefinition('Old')]);
const existingId = activeText().id;
renameLayer(existingId, 'Dialogue');

beginStroke();
updateTextLayer(existingId, { text: 'N' }, renderNarrowText);
updateTextLayer(existingId, { text: 'Ne' }, renderNarrowText);
updateTextLayer(existingId, { text: 'New', wrap: false }, renderNarrowText);
endStroke();

assert.equal(activeText().text, 'New');
assert.equal(activeText().wrap, false);
undo();
assert.deepEqual(
  { name: activeText().name, text: activeText().text, wrap: activeText().wrap },
  { name: 'Dialogue', text: 'Old', wrap: true },
  'one undo must restore the whole edit gesture without crossing the earlier rename',
);
undo();
assert.equal(activeText().name, 'Layer 1', 'the next undo must reach the earlier action');
redo();
redo();
assert.deepEqual(
  { name: activeText().name, text: activeText().text, wrap: activeText().wrap },
  { name: 'Dialogue', text: 'New', wrap: false },
  'one redo must restore the whole edit gesture',
);

setLayers([{ name: 'Layer 1', type: 'cell', visible: true, cells: {} }]);
const baseId = get(layers)[0].id;
renameLayer(baseId, 'Kept');
beginStroke();
createTextLayer({ x: 0, y: 0, w: 2, h: 1 }, '', '#ffffff', true, renderNarrowText);
assert.equal(get(layers).length, 2);
cancelStroke();
assert.deepEqual(
  get(layers).map((layer) => ({ name: layer.name, type: layer.type })),
  [{ name: 'Kept', type: 'cell' }],
  'cancelling a new empty text gesture must remove its layer',
);
undo();
assert.equal(get(layers)[0].name, 'Layer 1', 'cancelling text must preserve earlier undo history');

setLayers([{ name: 'Layer 1', type: 'cell', visible: true, cells: {} }]);
beginStroke();
const createdId = createTextLayer(
  { x: 0, y: 0, w: 2, h: 1 },
  '',
  '#ffffff',
  true,
  renderNarrowText,
);
updateTextLayer(createdId, { text: 'A' }, renderNarrowText);
updateTextLayer(createdId, { text: 'AB' }, renderNarrowText);
endStroke();
undo();
assert.equal(get(layers).some((layer) => layer.type === 'text'), false);
redo();
assert.equal(activeText().text, 'AB', 'new text and all keystrokes must redo as one gesture');

console.log('ok - text edits and text creation use coherent gesture-level history');
