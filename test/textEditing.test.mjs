import assert from 'node:assert/strict';
import {
  createControlledTextHistory,
  createTextInputHistory,
  textColorPatchForSelection,
  textColorStateForSelection,
  textSelectionAfterEvent,
  textSelectionForLayer,
} from '../src/lib/textEditing.js';

const inputHistory = createTextInputHistory(2);
inputHistory.record({ text: '' });
inputHistory.record({ text: 'A' });
inputHistory.record({ text: 'AB' });
assert.deepEqual(inputHistory.undo({ text: 'ABC' }), { text: 'AB' });
assert.deepEqual(inputHistory.undo({ text: 'AB' }), { text: 'A' }, 'history obeys its memory bound');
assert.equal(inputHistory.undo({ text: 'A' }), null);
assert.deepEqual(inputHistory.redo({ text: 'A' }), { text: 'AB' });
inputHistory.record({ text: 'AX' });
assert.equal(inputHistory.redo({ text: 'AXY' }), null, 'new input discards the divergent redo branch');

const controlledHistory = createControlledTextHistory();
controlledHistory.beforeInput({ inputType: 'insertText' }, { value: 'A' });
controlledHistory.input(true);
let restoredInput = null;
let shortcutStopped = false;
const undoEvent = {
  key: 'z',
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  preventDefault() { shortcutStopped = true; },
  stopPropagation() {},
};
assert.equal(
  controlledHistory.keydown(undoEvent, { value: 'AB' }, (state) => { restoredInput = state; }),
  true,
);
assert.deepEqual(restoredInput, { value: 'A' });
assert.equal(shortcutStopped, true, 'a handled controlled-input shortcut must not reach editor Undo');

const layer = {
  id: 42,
  type: 'text',
  text: 'ABCDEFGHIJKL',
  fg: '#ffffff',
  runs: [],
};

let selection = null;
const keyup = (start, end) => {
  selection = textSelectionAfterEvent(selection, layer.id, start, end, 'keyup');
};

// Expand a saved range one offset at a time.
keyup(0, layer.text.length);
keyup(0, 0);
for (let caret = 1; caret <= 4; caret++) keyup(caret, caret);
for (let end = 5; end <= 8; end++) keyup(4, end);

assert.deepEqual(selection, { layerId: 42, start: 4, end: 8 });
const pickerSelection = textSelectionForLayer(selection, layer.id);

// Chromium may report a collapsed textarea selection while focus moves to
// Layer Properties. Blur must not replace the last explicit keyboard selection.
selection = textSelectionAfterEvent(selection, layer.id, 8, 8, 'blur');
assert.deepEqual(selection, { layerId: 42, start: 4, end: 8 });
const laterLiveSelection = textSelectionAfterEvent(selection, layer.id, 8, 8, 'select');
assert.deepEqual(laterLiveSelection, { layerId: 42, start: 8, end: 8 });

assert.deepEqual(
  textColorPatchForSelection(layer, pickerSelection, '#c94f4f'),
  { runs: [{ start: 4, end: 8, fg: '#c94f4f' }] },
  'the properties color action should create a range run, not replace the base color',
);

// A later explicit caret selection clears the saved range.
keyup(8, 8);
assert.deepEqual(
  textColorPatchForSelection(layer, selection, '#c94f4f'),
  { fg: '#c94f4f', runs: [] },
);

const colored = {
  ...layer,
  runs: [
    { start: 0, end: 4, fg: '#c94f4f' },
    { start: 8, end: 12, fg: '#c94f4f' },
  ],
};
assert.deepEqual(
  textColorStateForSelection(colored, { layerId: 42, start: 0, end: 4 }),
  { color: '#c94f4f', mixed: false },
);
assert.deepEqual(
  textColorStateForSelection(colored, { layerId: 42, start: 0, end: 12 }),
  { color: '#c94f4f', mixed: true },
  'an uncolored gap keeps a same-colored pair of runs from appearing uniform',
);
assert.deepEqual(
  textColorStateForSelection(colored, { layerId: 7, start: 0, end: 4 }),
  { color: '#ffffff', mixed: false },
  'a range saved for another text layer cannot change this layer property',
);

console.log('ok - text selection state preserves an explicit range across blur');
