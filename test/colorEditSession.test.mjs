import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { colorEditSession } from '../src/lib/colorEditSession.js';
import {
  canUndo,
  layers,
  removeLayer,
  setLayers,
  undo,
} from '../src/lib/grid.js';
import { activeTool, paintColor, recentColors } from '../src/lib/stores.js';
import { textSelection } from '../src/lib/textEditing.js';
import {
  advanceProjectRevision,
  notifyProjectReplaced,
} from '../src/lib/documentLifecycle.js';

function shapeDefinition(color = '#112233') {
  return {
    name: 'Shape',
    type: 'shape',
    visible: true,
    shape: {
      kind: 'rect',
      x0: 0,
      y0: 0,
      x1: 3,
      y1: 2,
      style: 'outline',
      detail: 'cell',
      channel: 'glyph',
      char: '#',
      fg: color,
    },
    cells: {},
  };
}

function textDefinition() {
  return {
    name: 'Text',
    type: 'text',
    visible: true,
    text: 'ABCD',
    box: { x: 0, y: 0, w: 4, h: 1 },
    wrap: false,
    fg: '#ffffff',
    runs: [],
    cells: {},
  };
}

function state() {
  return get({ subscribe: colorEditSession.subscribe });
}

colorEditSession.close();
setLayers([{ name: 'Layer', type: 'cell', visible: true, cells: {} }]);
paintColor.set('#112233');
assert.equal(colorEditSession.open({ kind: 'toolbar' }), true);
assert.equal(colorEditSession.preview('#445566'), true);
assert.equal(get(paintColor), '#445566');
assert.equal(colorEditSession.cancel(), true);
assert.equal(get(paintColor), '#112233', 'toolbar cancellation restores the gesture start color');
assert.equal(get(canUndo), false, 'toolbar color changes do not create empty canvas history');
colorEditSession.preview('#778899');
colorEditSession.commit();
colorEditSession.cancel();
assert.equal(get(paintColor), '#778899', 'cancelling after a commit does not cross the gesture boundary');
assert.equal(get(recentColors)[0], '#778899');
colorEditSession.close();

setLayers([shapeDefinition()]);
const shapeId = get(layers)[0].id;
assert.equal(colorEditSession.open({ kind: 'shape', layerId: shapeId }), true);
colorEditSession.preview('#334455');
colorEditSession.preview('#aabbcc');
colorEditSession.commit();
assert.equal(get(layers)[0].shape.fg, '#aabbcc');
undo();
assert.equal(get(layers)[0].shape.fg, '#112233', 'all shape previews commit as one undo gesture');
assert.equal(get(canUndo), false, 'shape preview does not leak extra history entries');
colorEditSession.close();

setLayers([shapeDefinition()]);
const cancelledShapeId = get(layers)[0].id;
colorEditSession.open({ kind: 'shape', layerId: cancelledShapeId });
colorEditSession.preview('#abcdef');
colorEditSession.cancel();
assert.equal(get(layers)[0].shape.fg, '#112233');
assert.equal(get(canUndo), false, 'cancelled property previews leave no history entry');
colorEditSession.close();

setLayers([textDefinition()]);
const textId = get(layers)[0].id;
textSelection.set({ layerId: textId, start: 1, end: 3 });
assert.equal(colorEditSession.open({ kind: 'text', layerId: textId }), true);
textSelection.set({ layerId: textId, start: 0, end: 4 });
colorEditSession.preview('#ff0000');
colorEditSession.commit();
assert.deepEqual(
  get(layers)[0].runs,
  [{ start: 1, end: 3, fg: '#ff0000' }],
  'the text range is frozen when the picker opens',
);
undo();
assert.deepEqual(get(layers)[0].runs, []);
colorEditSession.close();

setLayers([shapeDefinition()]);
const sampledShapeId = get(layers)[0].id;
activeTool.set('select');
colorEditSession.open({ kind: 'shape', layerId: sampledShapeId }, { x: 41, y: 73 });
const sampledCycle = state().cycle;
assert.deepEqual({ x: state().x, y: state().y }, { x: 41, y: 73 });
assert.equal(colorEditSession.startSampling(), true);
assert.equal(get(activeTool), 'eyedropper');
assert.equal(colorEditSession.sample(null), false);
assert.equal(get(activeTool), 'eyedropper', 'transparent samples keep the session in sampling mode');
assert.equal(get(layers)[0].shape.fg, '#112233', 'transparent samples do not change the target');
assert.equal(colorEditSession.finishSampling(), false);
assert.equal(state().phase, 'sampling', 'releasing over transparency keeps sampling active');
assert.equal(get(activeTool), 'eyedropper');
assert.equal(colorEditSession.sample('#abcdef'), true);
assert.equal(colorEditSession.sample('#fedcba'), true);
assert.equal(get(activeTool), 'eyedropper', 'drag samples stay in sampling mode until pointer-up');
assert.equal(get(layers)[0].shape.fg, '#fedcba');
colorEditSession.cancel();
assert.equal(get(activeTool), 'select');
assert.equal(get(layers)[0].shape.fg, '#112233', 'cancelling a sample drag restores its start');
assert.equal(get(canUndo), false, 'cancelled drag samples leave no history entry');
colorEditSession.startSampling();
colorEditSession.sample('#abcdef');
colorEditSession.sample('#fedcba');
assert.equal(colorEditSession.finishSampling(), true);
assert.equal(get(activeTool), 'select', 'finishing a sample drag restores the previous tool');
assert.equal(state().phase, 'picker');
undo();
assert.equal(get(layers)[0].shape.fg, '#112233', 'all drag samples coalesce into one undo gesture');
colorEditSession.close();

setLayers([shapeDefinition()]);
const switchedToolShapeId = get(layers)[0].id;
activeTool.set('select');
colorEditSession.open({ kind: 'shape', layerId: switchedToolShapeId });
colorEditSession.startSampling();
colorEditSession.sample('#abcdef');
activeTool.set('brush');
assert.equal(state().active, false, 'choosing another tool closes an active sample session');
assert.equal(get(activeTool), 'brush', 'sample cleanup never overwrites the newly chosen tool');
assert.equal(get(layers)[0].shape.fg, '#112233', 'changing tools cancels an unfinished sample');
assert.equal(get(canUndo), false);

setLayers([shapeDefinition()]);
const abortedId = get(layers)[0].id;
colorEditSession.open({ kind: 'shape', layerId: abortedId }, { x: 5, y: 6 });
assert.ok(state().cycle > sampledCycle, 'each open has a new picker remount cycle');
colorEditSession.preview('#010203');
assert.equal(colorEditSession.abort(), true);
assert.equal(state().active, false);
assert.equal(get(layers)[0].shape.fg, '#112233', 'abort cancels the gesture and closes the session');
assert.equal(get(canUndo), false);

setLayers([shapeDefinition()]);
const deletedId = get(layers)[0].id;
activeTool.set('move');
colorEditSession.open({ kind: 'shape', layerId: deletedId });
colorEditSession.startSampling();
removeLayer(deletedId);
assert.equal(get(layers).length, 0, 'target deletion is preserved');
assert.equal(state().active, false, 'deleting the target cancels the stale session');
assert.equal(get(activeTool), 'move', 'target deletion restores the pre-sampling tool');
assert.equal(colorEditSession.sample('#123456'), false, 'a deleted target cannot receive a late sample');
undo();
assert.equal(get(layers)[0].shape.fg, '#112233', 'deletion remains one undoable operation');

setLayers([shapeDefinition()]);
const deletedDuringPreviewId = get(layers)[0].id;
colorEditSession.open({ kind: 'shape', layerId: deletedDuringPreviewId });
colorEditSession.preview('#fedcba');
removeLayer(deletedDuringPreviewId);
assert.equal(get(layers).length, 0, 'cancelling a stale preview must not resurrect its deleted target');
assert.equal(state().active, false);
undo();
assert.equal(
  get(layers)[0].shape.fg,
  '#112233',
  'undoing deletion restores the target from before its uncommitted preview',
);

assert.equal(colorEditSession.open({ kind: 'shape', layerId: -1 }), false);
assert.equal(state().active, false);

setLayers([shapeDefinition('#102030')]);
const replacedId = get(layers)[0].id;
activeTool.set('select');
colorEditSession.open({ kind: 'shape', layerId: replacedId });
colorEditSession.preview('#abcdef');
const replacementRevision = advanceProjectRevision();
setLayers([shapeDefinition('#fedcba')]);
notifyProjectReplaced({ revision: replacementRevision });
assert.equal(state().active, false, 'project replacement abandons the old target session');
assert.equal(get(layers)[0].shape.fg, '#fedcba', 'old preview rollback cannot touch the new project');
assert.equal(get(activeTool), 'select');
assert.equal(get(canUndo), false, 'replacement leaves the new project history empty');

console.log('ok - target-aware color editing has coherent preview, sampling, and history');
