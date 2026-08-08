import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import {
  activeLayerId,
  activeLayerPart,
  canRedo,
  canUndo,
  clearLayerSelection,
  layers,
  redo,
  removeLayers,
  removeSelectedLayers,
  selectLayer,
  selectLayerPart,
  selectLayerWithModifiers,
  selectedLayerIds,
  setLayers,
  undo,
} from '../src/lib/grid.js';
import {
  keyboardDeleteAction,
} from '../src/lib/timelineKeys.js';
import {
  layerDeleteClosure,
  layerDeleteLabel,
  planLayerDeleteContext,
} from '../src/lib/layerActions.js';
import {
  commitLayersToActiveFrame,
  loadCanonicalTimeline,
} from '../src/lib/frames.js';
import { getClipTimelineState } from '../src/lib/clipTimelineState.js';
import { deterministicUuid } from './projectFixture.mjs';

function captureEditorState() {
  return {
    layers: structuredClone(get(layers)),
    timeline: structuredClone(getClipTimelineState()),
    activeLayerId: get(activeLayerId),
    activeLayerPart: get(activeLayerPart),
    selectedLayerIds: [...get(selectedLayerIds)],
  };
}

async function settleTimeline() {
  await Promise.resolve();
  await Promise.resolve();
}

test('context targeting advertises one, two, and three explicit selected rows', () => {
  setLayers([
    { name: 'A', type: 'cell', cells: {} },
    { name: 'B', type: 'cell', cells: {} },
    { name: 'C', type: 'cell', cells: {} },
    { name: 'D', type: 'cell', cells: {} },
  ]);
  const [a, b, c, d] = get(layers);

  selectLayer(b.id);
  selectLayerWithModifiers(c.id, { ctrlKey: true });
  assert.deepEqual([...get(selectedLayerIds)], [b.id, c.id]);
  assert.deepEqual(planLayerDeleteContext(get(layers), get(selectedLayerIds), b.id), {
    preserveSelection: true,
    deleteIds: [b.id, c.id],
    deleteCount: 2,
    deleteLabel: 'Delete 2 layers',
  });

  selectLayer(c.id);
  selectLayerWithModifiers(a.id, { shiftKey: true });
  assert.deepEqual([...get(selectedLayerIds)], [a.id, b.id, c.id]);
  assert.deepEqual(planLayerDeleteContext(get(layers), get(selectedLayerIds), b.id), {
    preserveSelection: true,
    deleteIds: [a.id, b.id, c.id],
    deleteCount: 3,
    deleteLabel: 'Delete 3 layers',
  });

  const retargeted = planLayerDeleteContext(get(layers), get(selectedLayerIds), d.id);
  assert.deepEqual(retargeted, {
    preserveSelection: false,
    deleteIds: [d.id],
    deleteCount: 1,
    deleteLabel: 'Delete layer',
  });
  selectLayerPart(d.id, 'layer', retargeted.preserveSelection);
  assert.deepEqual([...get(selectedLayerIds)], [d.id]);
  assert.equal(planLayerDeleteContext(get(layers), get(selectedLayerIds), 'missing'), null);
  assert.equal(layerDeleteLabel(1), 'Delete layer');
  assert.equal(layerDeleteLabel(12), 'Delete 12 layers');
});

test('context targeting freezes the complete group row closure and actual count', () => {
  const group = { id: 'group', name: 'Bundle', type: 'group' };
  const children = Array.from({ length: 10 }, (_, index) => ({
    id: `child-${index}`,
    groupId: group.id,
    name: `Child ${index}`,
    type: 'cell',
  }));
  const outside = { id: 'outside', name: 'Outside', type: 'cell' };
  const stack = [group, ...children, outside];
  const selected = new Set([group.id]);
  const plan = planLayerDeleteContext(stack, selected, group.id);

  assert.deepEqual(layerDeleteClosure(stack, selected), stack.slice(0, 11).map((layer) => layer.id));
  assert.deepEqual(plan, {
    preserveSelection: true,
    deleteIds: stack.slice(0, 11).map((layer) => layer.id),
    deleteCount: 11,
    deleteLabel: 'Delete 11 layers',
  });

  selected.clear();
  selected.add(outside.id);
  children[0].groupId = null;
  assert.deepEqual(plan.deleteIds, stack.slice(0, 11).map((layer) => layer.id),
    'selection and hierarchy changes cannot rewrite an open menu plan');
});

test('one selected layer follows the zero-layer policy through Undo and Redo', async () => {
  const onlyId = deterministicUuid('layer', 1);
  setLayers([{ id: onlyId, name: 'Only', type: 'cell', cells: {} }]);
  commitLayersToActiveFrame();
  const before = captureEditorState();

  assert.equal(removeSelectedLayers(), true);
  await settleTimeline();
  assert.deepEqual(get(layers), []);
  assert.equal(get(activeLayerId), null);
  assert.deepEqual([...get(selectedLayerIds)], []);

  undo();
  await settleTimeline();
  assert.deepEqual(captureEditorState(), before);
  redo();
  await settleTimeline();
  assert.deepEqual(get(layers), []);
});

test('one transaction deletes selected groups and special layers and restores exact authored state', async () => {
  const groupId = deterministicUuid('layer', 10);
  const childId = deterministicUuid('layer', 11);
  const imageId = deterministicUuid('layer', 12);
  const videoId = deterministicUuid('layer', 13);
  const effectId = deterministicUuid('layer', 14);
  const imageAssetId = deterministicUuid('asset', 1);
  const videoAssetId = deterministicUuid('asset', 2);
  setLayers([
    {
      id: groupId,
      name: 'Grouped source',
      type: 'group',
      collapsed: false,
      cells: {},
    },
    {
      id: childId,
      groupId,
      name: 'Locked child',
      type: 'cell',
      cells: { '0,0': { c: 'G', fg: '#ffffff' } },
    },
    {
      id: imageId,
      name: 'Image survivor',
      type: 'image',
      assetId: imageAssetId,
      sourceWidth: 16,
      sourceHeight: 8,
      transform: { x: 4, y: 3, scale: 1, rot: 0 },
      cells: {},
    },
    {
      id: videoId,
      name: 'Video reference',
      type: 'video',
      videoClip: {
        assetId: videoAssetId,
        startTick: 0,
        inPoint: 0,
        outPoint: 2,
        playbackRate: 1,
        duration: 2,
        width: 32,
        height: 16,
      },
      transform: { x: 4, y: 3, scale: 1, rot: 0 },
      cells: {},
    },
    {
      id: effectId,
      name: 'Masked effect',
      type: 'effect',
      effect: { kind: 'brightness', intensity: 0.4 },
      mask: {
        defaultStrength: 1,
        opacity: 0.75,
        offset: { x: 1, y: -1 },
        cells: { '1,1': { mask: 0.5 } },
      },
      cells: {},
    },
  ]);

  const timeline = structuredClone(getClipTimelineState());
  const lockedTrack = timeline.tracks.find((track) => track.layer?.id === childId);
  lockedTrack.locked = true;
  loadCanonicalTimeline(timeline);
  commitLayersToActiveFrame();

  selectLayer(groupId);
  selectLayerWithModifiers(videoId, { ctrlKey: true });
  selectLayerWithModifiers(effectId, { ctrlKey: true });
  assert.deepEqual([...get(selectedLayerIds)], [groupId, videoId, effectId]);
  assert.equal(get(activeLayerId), effectId);
  const before = captureEditorState();

  assert.equal(removeSelectedLayers(), true);
  await settleTimeline();
  assert.deepEqual(get(layers).map((layer) => layer.id), [imageId]);
  assert.deepEqual(
    getClipTimelineState().tracks.filter((track) => track.kind !== 'audio').map((track) => track.layer.id),
    [imageId],
  );
  const deleted = captureEditorState();
  assert.equal(get(canUndo), true);

  undo();
  await settleTimeline();
  assert.deepEqual(captureEditorState(), before);
  assert.equal(get(canUndo), false, 'one Undo consumes the selected-set deletion entry');
  assert.equal(get(canRedo), true);

  redo();
  await settleTimeline();
  assert.deepEqual(captureEditorState(), deleted);
});

test('empty targets and suppressed keyboard states are no-ops', () => {
  setLayers([{ name: 'A', type: 'cell', cells: {} }]);
  const before = captureEditorState();
  assert.equal(removeLayers([]), false);
  assert.equal(removeLayers(['missing']), false);
  assert.deepEqual(captureEditorState(), before);
  assert.equal(get(canUndo), false);
  assert.equal(keyboardDeleteAction('layers', { activeLayerId: null, selectedLayerCount: 1 }), null);
  assert.equal(keyboardDeleteAction('layers', {
    activeLayerId: 'a', selectedLayerCount: 1, editing: true,
  }), null);
  assert.equal(keyboardDeleteAction('layers', {
    activeLayerId: 'a', selectedLayerCount: 1, playing: true,
  }), null);
  assert.equal(keyboardDeleteAction('layers', { activeLayerId: 'a', selectedLayerCount: 0 }), null);
  assert.equal(keyboardDeleteAction('canvas', { activeLayerId: 'a' }), null);
});

test('clearing a multi-layer selection collapses to the active layer without creating history', () => {
  setLayers([
    { name: 'A', type: 'cell', cells: {} },
    { name: 'B', type: 'cell', cells: {} },
  ]);
  const [a, b] = get(layers);
  selectLayer(a.id);
  selectLayerWithModifiers(b.id, { ctrlKey: true });
  const active = get(activeLayerId);

  assert.equal(clearLayerSelection(), true);
  assert.deepEqual([...get(selectedLayerIds)], [active]);
  assert.equal(get(activeLayerId), active);
  assert.equal(get(canUndo), false);
  assert.equal(clearLayerSelection(), false);
  assert.equal(get(activeLayerId), b.id);
});
