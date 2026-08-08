import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import * as F from '../src/lib/frames.js';
import * as G from '../src/lib/grid.js';

function snapshot() {
  return structuredClone({
    dims: get(G.dims),
    fps: get(F.fps),
    layers: get(G.layers),
    timeline: F.canonicalTimelineStateForSave(),
    authoredRevision: get(G.authoredRevision),
    canUndo: get(G.canUndo),
    canRedo: get(G.canRedo),
  });
}

function unchanged(name, before) {
  assert.deepEqual(snapshot(), before, name);
}

G.setLayers([{
  name: 'Ink',
  type: 'cell',
  visible: true,
  opacity: 1,
  cells: { '0,0': { c: 'A', fg: '#ffffff' } },
}]);
G.resizeCanvas(4, 3);
F.initTimeline(get(G.layers));
const layerId = get(G.layers)[0].id;
G.renameLayer(layerId, 'Ink authored');
F.commitLayersToActiveFrame();
G.undo();
const before = snapshot();

F.playing.set(true);
try {
  assert.equal(G.addLayer('cell'), false);
  unchanged('Add Layer is a no-op during playback', before);

  assert.equal(G.toggleLayerVisible(layerId), false);
  unchanged('layer visibility is a no-op during playback', before);

  assert.equal(G.setLayerOpacity(layerId, 0.25), false);
  assert.equal(G.renameLayer(layerId, 'discarded'), false);
  assert.equal(G.setCells([{ x: 1, y: 0, cell: { c: 'B', fg: '#ffffff' } }]), false);
  assert.equal(G.removeLayer(layerId), false);
  assert.equal(G.undo(), false);
  unchanged('other layer authoring entry points are no-ops during playback', before);

  assert.equal(F.setFps(30), false);
  assert.equal(F.setPosKey(layerId, 0, true), false);
  assert.equal(F.cropTimeline({ x: 1, y: 0, w: 2, h: 2 }), false);
  unchanged('timeline properties and crop Apply are no-ops during playback', before);
} finally {
  F.playing.set(false);
}

G.redo();
assert.equal(get(G.layers)[0].name, 'Ink authored', 'playback keeps the prior Redo entry intact');
G.undo();
assert.equal(get(G.layers)[0].name, 'Ink', 'Undo still reaches the same authored state after playback');

console.log('ok - playback rejects authored layer and crop mutations');
