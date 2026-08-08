import assert from 'node:assert/strict';
import {
  canvasEscapeAction,
  captureGestureOwner,
  canvasPointerStartsPan,
  gestureOwnerMatches,
  gesturePointerMatches,
  moveToolChangeAction,
} from '../src/lib/gestureOwnership.js';

assert.equal(canvasEscapeAction({ hasPointerGesture: true, hasSelectionMenu: true }), 'cancel-pointer');
assert.equal(canvasEscapeAction({ hasPointerGesture: false, hasSelectionMenu: true }), 'close-selection-menu');
assert.equal(canvasEscapeAction({ hasPointerGesture: false, hasSelectionMenu: false }), null);

const source = {
  layerId: 17,
  frameIndex: 23,
  tool: 'brush',
  layerPart: 'mask',
  projectRevision: 9,
};
const owner = captureGestureOwner(source, 41);

source.layerId = 99;
assert.deepEqual(owner, {
  layerId: 17,
  frameIndex: 23,
  tool: 'brush',
  layerPart: 'mask',
  projectRevision: 9,
  pointerId: 41,
});
assert.equal(Object.isFrozen(owner), true, 'gesture ownership must be an immutable snapshot');

const exact = { ...owner };
delete exact.pointerId;
assert.equal(gestureOwnerMatches(owner, exact), true);

for (const [field, replacement] of [
  ['layerId', 18],
  ['frameIndex', 24],
  ['tool', 'eraser'],
  ['layerPart', 'layer'],
  ['projectRevision', 10],
]) {
  assert.equal(
    gestureOwnerMatches(owner, { ...exact, [field]: replacement }),
    false,
    `${field} replacement must invalidate the gesture`,
  );
}

assert.equal(gesturePointerMatches(owner, 41), true);
assert.equal(gesturePointerMatches(owner, 42), false);
assert.equal(gesturePointerMatches(owner, null), true, 'window blur has no pointer id');
assert.equal(gesturePointerMatches(captureGestureOwner(exact), 99), true, 'keyboard gestures may omit a pointer id');

assert.equal(canvasPointerStartsPan(false, 0), false, 'plain left drag remains an editing gesture');
assert.equal(canvasPointerStartsPan(true, 0), true, 'Space routes left drag to canvas panning');
assert.equal(canvasPointerStartsPan(false, 1), true, 'middle drag routes to canvas panning');
assert.equal(canvasPointerStartsPan(false, 2), false, 'plain right click remains available to context menus');

assert.equal(moveToolChangeAction({ hasMoveState: false, tool: 'brush' }), null);
assert.equal(moveToolChangeAction({ hasMoveState: true, tool: 'select' }), null);
assert.equal(moveToolChangeAction({ hasMoveState: true, tool: 'move' }), null);
assert.equal(moveToolChangeAction({
  hasMoveState: true,
  tool: 'brush',
  pointerOwnsMoveState: true,
}), 'cancel-pointer', 'an active captured selection drag must roll back');
assert.equal(moveToolChangeAction({
  hasMoveState: true,
  tool: 'brush',
  windowOwnsMoveState: true,
}), 'cancel-window', 'an active selection transform handle must roll back');
assert.equal(moveToolChangeAction({
  hasMoveState: true,
  tool: 'brush',
}), 'finalize', 'an idle pending move keeps the existing commit behavior');

console.log('gesture ownership tests passed');
