import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import ClipTimeline from '../src/components/ClipTimeline.svelte';
import TimelineV2 from '../src/components/TimelineV2.svelte';
import ProjectAssets from '../src/components/ProjectAssets.svelte';
import {
  canUndo,
  authoredRevision,
  redo,
  resetEditorStateForProjectLoad,
  undo,
} from '../src/lib/grid.js';
import {
  loadCanonicalTimeline,
  looping,
  onionSkin,
  playheadTick,
  playing,
  seekTick,
  setClipSelection,
} from '../src/lib/frames.js';
import {
  getClipTimelineSelection,
  getClipTimelineState,
} from '../src/lib/clipTimelineState.js';
import { dirty } from '../src/lib/stores.js';
import {
  keyboardContextOwns,
  resetKeyboardContext,
} from '../src/lib/timelineKeys.js';
import { projectMediaRegistry } from '../src/lib/mediaRegistry.js';

const TAG_ID = '30000000-0000-4000-8000-000000000003';
const TAG_ID_2 = '40000000-0000-4000-8000-000000000004';
const LOOP_START_ID = '50000000-0000-4000-8000-000000000005';
const LOOP_END_ID = '60000000-0000-4000-8000-000000000006';

function cell(character) {
  return { c: character, fg: '#ffffff', bg: null };
}

function timelineState() {
  const layer = {
    id: 'mounted-layer', name: 'Mounted', type: 'cell', visible: true,
    cells: { '0,0': cell('A') }, offset: { x: 0, y: 0 },
  };
  return {
    fps: 24,
    tags: [{ id: TAG_ID, tick: 1, type: 'custom', value: 'beat' }],
    tracks: [{ id: 'mounted-track', kind: 'visual', locked: false, layer }],
    clips: [{
      id: 'mounted-clip', trackId: 'mounted-track', kind: 'visual',
      startTick: 0, inTick: 0, outTick: 5, sourceDuration: 5,
      frameKeys: [
        { tick: 0, value: { cells: { '0,0': cell('A') } } },
        { tick: 2, value: { cells: { '0,0': cell('B') } } },
        { tick: 4, value: { cells: { '0,0': cell('C') } } },
      ],
      propertyTracks: {
        position: [
          { tick: 0, value: { x: 0, y: 0 } },
          { tick: 2, value: { x: 2, y: 0 } },
          { tick: 4, value: { x: 4, y: 0 } },
        ],
        visibility: [
          { tick: 1, value: true },
          { tick: 3, value: false },
        ],
        effectIntensity: [{ tick: 1, value: 0.25 }],
        maskPosition: [{ tick: 2, value: { x: 1, y: 1 } }],
        maskOpacity: [{ tick: 1, value: 0.5 }],
        shapePath: [{ tick: 2, value: { path: { kind: 'line' } } }],
      },
    }],
  };
}

function denseOpeningKeyState({ locked = false } = {}) {
  const state = timelineState();
  state.tracks[0].locked = locked;
  state.clips[0].frameKeys = [
    { tick: 0, value: { cells: { '0,0': cell('A') } } },
    { tick: 1, value: { cells: { '0,0': cell('B') } } },
  ];
  state.clips[0].propertyTracks = {
    position: [
      { tick: 0, value: { x: 0, y: 0 } },
      { tick: 1, value: { x: 1, y: 0 } },
    ],
    visibility: [
      { tick: 0, value: true },
      { tick: 1, value: false },
    ],
    effectIntensity: [
      { tick: 0, value: 0.25 },
      { tick: 1, value: 0.75 },
    ],
  };
  return state;
}

function currentClip() {
  return getClipTimelineState().clips.find((clip) => clip.id === 'mounted-clip');
}

function completeSelection() {
  return {
    clipIds: new Set(['mounted-clip']),
    frameKeys: [{ clipId: 'mounted-clip', sourceTick: 0 }],
    propertyKeys: [{
      clipId: 'mounted-clip', sourceTick: 2, propertyName: 'position',
    }],
    trackHeaderIds: new Set(['mounted-track']),
    gap: { trackIds: ['mounted-track'], startTick: 5, endTick: 6 },
    rulerRange: null,
  };
}

function expectNoTimelineSelection() {
  expect(getClipTimelineSelection()).toEqual({
    clipIds: new Set(),
    frameKeys: [],
    propertyKeys: [],
    trackHeaderIds: new Set(),
    gap: null,
    rulerRange: null,
  });
}

function setTimelineViewportRect(width = 640, height = 220) {
  const viewport = document.querySelector('.timeline-viewport');
  viewport.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
  });
  return viewport;
}

function wheelEvent(properties) {
  const event = new Event('wheel', { bubbles: true, cancelable: true });
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(event, name, { configurable: true, value });
  }
  return event;
}

async function dispatchPointerEvent(target, type, properties) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(event, name, { configurable: true, value });
  }
  target.dispatchEvent(event);
  await tick();
}

async function pointerGesture(target, options = {}) {
  const pointerId = options.pointerId ?? 1;
  const startX = options.startX ?? 100;
  const startY = options.startY ?? 100;
  await fireEvent.pointerDown(target, {
    button: 0,
    pointerId,
    clientX: startX,
    clientY: startY,
    ctrlKey: options.ctrlKey,
    metaKey: options.metaKey,
    shiftKey: options.shiftKey,
  });
  if (options.endX != null || options.endY != null) {
    await fireEvent.pointerMove(window, {
      pointerId,
      clientX: options.endX ?? startX,
      clientY: options.endY ?? startY,
    });
  }
  if (options.cancelled) {
    await fireEvent.pointerCancel(window, { pointerId });
  } else {
    await fireEvent.pointerUp(window, {
      pointerId,
      clientX: options.endX ?? startX,
      clientY: options.endY ?? startY,
    });
  }
  await tick();
}

async function selectThreeMixedKeys() {
  await pointerGesture(screen.getByRole('button', { name: 'Frame key at tick 0' }), {
    pointerId: 101,
  });
  await pointerGesture(screen.getByRole('button', { name: 'Position key at tick 2' }), {
    pointerId: 102,
    ctrlKey: true,
  });
  await pointerGesture(screen.getByRole('button', { name: 'Visibility key at tick 1' }), {
    pointerId: 103,
    ctrlKey: true,
  });
}

beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(220);
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
  }));
});

beforeEach(async () => {
  playing.set(false);
  looping.set(true);
  onionSkin.set('off');
  dirty.set(false);
  resetKeyboardContext();
  loadCanonicalTimeline(timelineState());
  resetEditorStateForProjectLoad();
  render(ClipTimeline, { expanded: true, pixelsPerTick: 14 });
  await tick();
});

afterEach(() => {
  cleanup();
  playing.set(false);
  resetKeyboardContext();
});

describe('mounted mixed timeline keys', () => {
  test('shows complete context wording and deletes all three key kinds in one entry', async () => {
    await selectThreeMixedKeys();
    expect(getClipTimelineSelection().frameKeys).toEqual([
      { clipId: 'mounted-clip', sourceTick: 0 },
    ]);
    expect(getClipTimelineSelection().propertyKeys).toEqual([
      { clipId: 'mounted-clip', sourceTick: 2, propertyName: 'position' },
      { clipId: 'mounted-clip', sourceTick: 1, propertyName: 'visibility' },
    ]);

    await fireEvent.contextMenu(screen.getByRole('button', { name: 'Frame key at tick 0' }), {
      clientX: 40,
      clientY: 40,
    });
    expect(screen.getByText('3 keys')).not.toBeNull();
    const action = screen.getByRole('button', { name: 'Delete 3 keys' });
    await fireEvent.click(action);

    expect(currentClip().frameKeys.map((key) => key.tick)).toEqual([2, 4]);
    expect({
      startTick: currentClip().startTick,
      inTick: currentClip().inTick,
      outTick: currentClip().outTick,
    }).toEqual({ startTick: 2, inTick: 2, outTick: 5 });
    expect(currentClip().propertyTracks.position.map((key) => key.tick)).toEqual([0, 4]);
    expect(currentClip().propertyTracks.visibility.map((key) => key.tick)).toEqual([3]);
    expect(get(canUndo)).toBe(true);

    undo();
    expect(currentClip().frameKeys.map((key) => key.tick)).toEqual([0, 2, 4]);
    expect({
      startTick: currentClip().startTick,
      inTick: currentClip().inTick,
      outTick: currentClip().outTick,
    }).toEqual({ startTick: 0, inTick: 0, outTick: 5 });
    expect(getClipTimelineSelection().frameKeys).toEqual([
      { clipId: 'mounted-clip', sourceTick: 0 },
    ]);
    expect(getClipTimelineSelection().propertyKeys).toHaveLength(2);
    redo();
    expect(currentClip().frameKeys.map((key) => key.tick)).toEqual([2, 4]);
    expect(getClipTimelineSelection().frameKeys).toEqual([]);
    expect(getClipTimelineSelection().propertyKeys).toEqual([]);
  });

  test('right-clicking an unselected key retargets a singular specific heading', async () => {
    await selectThreeMixedKeys();
    await fireEvent.contextMenu(screen.getByRole('button', { name: 'Frame key at tick 2' }), {
      clientX: 40,
      clientY: 40,
    });

    expect(screen.getByText('Frame key')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Delete key' })).not.toBeNull();
    expect(getClipTimelineSelection().frameKeys).toEqual([
      { clipId: 'mounted-clip', sourceTick: 2 },
    ]);
    expect(getClipTimelineSelection().propertyKeys).toEqual([]);
  });

  test.each(['Delete', 'Backspace'])('%s removes the complete mixed key selection', async (key) => {
    await selectThreeMixedKeys();
    const root = screen.getByRole('application', { name: 'Clip timeline' });
    await fireEvent.keyDown(root, { key });

    expect(currentClip().frameKeys.map((entry) => entry.tick)).toEqual([2, 4]);
    expect(currentClip().propertyTracks.position.map((entry) => entry.tick)).toEqual([0, 4]);
    expect(currentClip().propertyTracks.visibility.map((entry) => entry.tick)).toEqual([3]);
  });

  test('popup suppresses Ctrl+D and Escape-close preserves ownership for one UI-only clear', async () => {
    await selectThreeMixedKeys();
    const frame = screen.getByRole('button', { name: 'Frame key at tick 0' });
    await fireEvent.contextMenu(frame, { clientX: 40, clientY: 40 });
    const action = screen.getByRole('button', { name: 'Delete 3 keys' });

    await fireEvent.keyDown(action, { key: 'd', ctrlKey: true });
    expect(getClipTimelineSelection().frameKeys).toHaveLength(1);
    expect(getClipTimelineSelection().propertyKeys).toHaveLength(2);
    await fireEvent.keyDown(action, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete 3 keys' })).toBeNull());

    const before = structuredClone(getClipTimelineState());
    const revision = get(authoredRevision);
    const root = screen.getByRole('application', { name: 'Clip timeline' });
    await fireEvent.keyDown(root, { key: 'd', ctrlKey: true });
    expect(getClipTimelineSelection().frameKeys).toEqual([]);
    expect(getClipTimelineSelection().propertyKeys).toEqual([]);
    expect(getClipTimelineState()).toEqual(before);
    expect(get(canUndo)).toBe(false);
    expect(get(authoredRevision)).toBe(revision);
    expect(get(dirty)).toBe(false);

    await fireEvent.keyDown(root, { key: 'Delete' });
    await fireEvent.keyDown(root, { key: 'Backspace' });
    expect(getClipTimelineState()).toEqual(before);
  });
});

describe('mounted timeline background selection release', () => {
  test.each(['Delete', 'Backspace'])(
    'a true blank click clears every selection and leaves %s inert',
    async (key) => {
      setClipSelection(completeSelection());
      const before = structuredClone(getClipTimelineState());
      const revision = get(authoredRevision);
      const root = screen.getByRole('application', { name: 'Clip timeline' });
      const background = document.querySelector('.timeline-surface');

      await pointerGesture(background);

      expectNoTimelineSelection();
      expect(keyboardContextOwns('timeline', {})).toBe(false);
      await fireEvent.keyDown(root, { key });
      expect(getClipTimelineState()).toEqual(before);
      expect(get(authoredRevision)).toBe(revision);
      expect(get(canUndo)).toBe(false);
      expect(get(dirty)).toBe(false);
    },
  );

  test('blank clearing stays below the exact drag threshold and rolls back on cancel', async () => {
    const background = document.querySelector('.timeline-surface');

    setClipSelection({ clipIds: ['mounted-clip'] });
    await pointerGesture(background, { pointerId: 2, endX: 102.999 });
    expectNoTimelineSelection();

    setClipSelection({ clipIds: ['mounted-clip'] });
    await pointerGesture(background, { pointerId: 3, endX: 103 });
    expect([...getClipTimelineSelection().clipIds]).toEqual(['mounted-clip']);

    await pointerGesture(background, { pointerId: 4, cancelled: true });
    expect([...getClipTimelineSelection().clipIds]).toEqual(['mounted-clip']);
  });

  test('scrollbar, resizer, ruler, row, clip, key, tag, and editor targets are not blank', async () => {
    const unchangedTargets = [
      document.querySelector('.timeline-viewport'),
      screen.getByRole('separator', { name: 'Resize track headers' }),
      document.querySelector('.ruler-active-range'),
      document.querySelector('.timeline-row'),
      screen.getByRole('button', { name: /Custom tag/ }),
    ];
    let pointerId = 10;
    for (const target of unchangedTargets) {
      setClipSelection(completeSelection());
      await pointerGesture(target, { pointerId: pointerId++ });
      expect(getClipTimelineSelection()).toEqual(completeSelection());
    }

    setClipSelection(completeSelection());
    await pointerGesture(screen.getByRole('button', { name: 'visual clip Mounted' }), {
      pointerId: pointerId++,
    });
    expect([...getClipTimelineSelection().clipIds]).toEqual(['mounted-clip']);

    setClipSelection(completeSelection());
    const frameKey = screen.getByRole('button', { name: 'Frame key at tick 0' });
    await pointerGesture(frameKey, { pointerId: pointerId++ });
    expect(getClipTimelineSelection().frameKeys).toEqual([
      { clipId: 'mounted-clip', sourceTick: 0 },
    ]);

    setClipSelection(completeSelection());
    await fireEvent.contextMenu(frameKey, { clientX: 40, clientY: 40 });
    const editorAction = screen.getByRole('button', { name: 'Delete 2 keys' });
    await pointerGesture(editorAction, { pointerId });
    expect(getClipTimelineSelection().frameKeys).toHaveLength(1);
    expect(getClipTimelineSelection().propertyKeys).toHaveLength(1);
  });
});

describe('mounted sequence tag targets', () => {
  test('track lanes open Tag editing on the first and final active ticks only on release', async () => {
    cleanup();
    loadCanonicalTimeline(timelineState());
    resetEditorStateForProjectLoad();
    render(ClipTimeline, { expanded: true, pixelsPerTick: 14, tool: 'tag' });
    await tick();
    setTimelineViewportRect();
    const lane = document.querySelector('.track-lane');
    const laneLeft = Number.parseFloat(lane.style.left);

    for (const tickValue of [0, 4]) {
      const clientX = laneLeft + tickValue * 14;
      await fireEvent.pointerDown(lane, {
        button: 0,
        pointerId: 40 + tickValue,
        clientX,
        clientY: 50,
      });
      expect(screen.queryByRole('dialog')).toBeNull();
      await fireEvent.pointerUp(window, {
        pointerId: 40 + tickValue,
        clientX,
        clientY: 50,
      });
      const editor = screen.getByRole('dialog', { name: `Edit tags at tick ${tickValue}` });
      expect(editor).not.toBeNull();
      const input = screen.getByRole('textbox', { name: 'Custom tag value' });
      expect(document.activeElement).toBe(input);
      await fireEvent.keyDown(input, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('application', { name: 'Clip timeline' }));
    }
  });

  test('zero-track Tag mode exposes a global lane with exact drag, focus, cancel, and Undo', async () => {
    cleanup();
    loadCanonicalTimeline({ fps: 24, tracks: [], clips: [], tags: [] });
    resetEditorStateForProjectLoad();
    render(ClipTimeline, { expanded: true, pixelsPerTick: 14, tool: 'tag' });
    await tick();
    setTimelineViewportRect();
    const root = screen.getByRole('application', { name: 'Clip timeline' });
    const lane = screen.getByRole('button', { name: 'Sequence tag lane, ticks 0 through 0' });
    const ruler = document.querySelector('.ruler-active-range');
    const laneLeft = Number.parseFloat(lane.style.left);

    await pointerGesture(ruler, { pointerId: 51, startX: laneLeft, startY: 10 });
    expect(screen.queryByRole('dialog')).toBeNull();

    await fireEvent.pointerDown(lane, {
      button: 0,
      pointerId: 52,
      clientX: laneLeft,
      clientY: 50,
    });
    expect(document.activeElement).toBe(root);
    expect(screen.queryByRole('dialog')).toBeNull();
    await fireEvent.pointerCancel(window, { pointerId: 52, clientX: laneLeft, clientY: 50 });
    expect(screen.queryByRole('dialog')).toBeNull();

    await fireEvent.pointerDown(lane, {
      button: 0,
      pointerId: 53,
      clientX: laneLeft,
      clientY: 50,
    });
    await fireEvent.pointerMove(window, {
      pointerId: 53,
      clientX: laneLeft + 80,
      clientY: 60,
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    await fireEvent.pointerUp(window, {
      pointerId: 53,
      clientX: laneLeft + 80,
      clientY: 60,
    });

    const editor = screen.getByRole('dialog', { name: 'Edit tags at tick 0' });
    expect(editor).not.toBeNull();
    const input = screen.getByRole('textbox', { name: 'Custom tag value' });
    expect(document.activeElement).toBe(input);
    await fireEvent.input(input, { target: { value: 'empty-project-ready' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(getClipTimelineState().tracks).toEqual([]);
    expect(getClipTimelineState().tags.map(({ tick: tagTick, type, value }) => ({
      tick: tagTick,
      type,
      value,
    }))).toEqual([{ tick: 0, type: 'custom', value: 'empty-project-ready' }]);
    expect(get(canUndo)).toBe(true);

    undo();
    expect(getClipTimelineState().tags).toEqual([]);
    expect(get(canUndo)).toBe(false);
  });
});

describe('mounted movable sequence tags', () => {
  test('Select drag moves the exact tag once and supports cancel, Undo, and Redo', async () => {
    const marker = screen.getByRole('button', { name: /Custom tag “beat” at tick 1/ });
    const revision = get(authoredRevision);
    await fireEvent.pointerDown(marker, {
      button: 0, pointerId: 61, clientX: 100, clientY: 10,
    });
    await fireEvent.pointerMove(window, { pointerId: 61, clientX: 128, clientY: 10 });
    expect(screen.getByRole('button', { name: /Custom tag “beat” at tick 3/ })
      .classList.contains('moving')).toBe(true);
    await fireEvent.pointerUp(window, { pointerId: 61, clientX: 128, clientY: 10 });
    await tick();

    expect(getClipTimelineState().tags).toEqual([
      { id: TAG_ID, tick: 3, type: 'custom', value: 'beat' },
    ]);
    expect(get(authoredRevision)).toBe(revision + 1);
    expect(get(canUndo)).toBe(true);
    undo();
    expect(getClipTimelineState().tags[0]).toEqual({
      id: TAG_ID, tick: 1, type: 'custom', value: 'beat',
    });
    redo();
    expect(getClipTimelineState().tags[0]).toEqual({
      id: TAG_ID, tick: 3, type: 'custom', value: 'beat',
    });

    const movedMarker = screen.getByRole('button', { name: /Custom tag “beat” at tick 3/ });
    const beforeCancel = structuredClone(getClipTimelineState());
    await pointerGesture(movedMarker, {
      pointerId: 62,
      startX: 128,
      endX: 100,
      cancelled: true,
    });
    expect(getClipTimelineState()).toEqual(beforeCancel);
  });

  test('loop singleton drag clamps and preserves its authoring identity', async () => {
    cleanup();
    const state = timelineState();
    state.tags = [
      { id: LOOP_START_ID, tick: 1, type: 'loop-start' },
      { id: LOOP_END_ID, tick: 4, type: 'loop-end' },
    ];
    loadCanonicalTimeline(state);
    resetEditorStateForProjectLoad();
    render(ClipTimeline, { expanded: true, pixelsPerTick: 14 });
    await tick();

    await pointerGesture(screen.getByRole('button', { name: 'Loop start at tick 1' }), {
      pointerId: 63,
      startX: 100,
      endX: 114,
    });
    expect(getClipTimelineState().tags).toEqual([
      { id: LOOP_START_ID, tick: 2, type: 'loop-start' },
      { id: LOOP_END_ID, tick: 4, type: 'loop-end' },
    ]);
  });

  test('a custom cluster opens an exact choice and updates only the chosen tag tick', async () => {
    cleanup();
    const state = timelineState();
    state.tags.push({ id: TAG_ID_2, tick: 1, type: 'custom', value: 'pulse' });
    loadCanonicalTimeline(state);
    resetEditorStateForProjectLoad();
    render(ClipTimeline, { expanded: true, pixelsPerTick: 14 });
    await tick();

    const cluster = screen.getByRole('button', { name: /2 custom tags at tick 1/ });
    await fireEvent.pointerDown(cluster, { button: 0, pointerId: 64, clientX: 100, clientY: 10 });
    expect(screen.getByRole('dialog', { name: 'Edit tags at tick 1' })).not.toBeNull();
    expect(get(canUndo)).toBe(false);
    await fireEvent.click(screen.getByRole('button', { name: 'pulse' }));
    const tickInput = screen.getByRole('spinbutton', { name: 'Tag tick' });
    await fireEvent.input(tickInput, { target: { value: '3' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    expect(getClipTimelineState().tags).toEqual([
      { id: TAG_ID, tick: 1, type: 'custom', value: 'beat' },
      { id: TAG_ID_2, tick: 3, type: 'custom', value: 'pulse' },
    ]);
  });

  test('Tag tool edits an existing marker tick in the same editor', async () => {
    cleanup();
    loadCanonicalTimeline(timelineState());
    resetEditorStateForProjectLoad();
    render(ClipTimeline, { expanded: true, pixelsPerTick: 14, tool: 'tag' });
    await tick();

    await fireEvent.pointerDown(screen.getByRole('button', { name: /Custom tag “beat” at tick 1/ }), {
      button: 0,
      pointerId: 65,
      clientX: 100,
      clientY: 10,
    });
    const tickInput = screen.getByRole('spinbutton', { name: 'Tag tick' });
    await fireEvent.input(tickInput, { target: { value: '4' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(getClipTimelineState().tags[0]).toEqual({
      id: TAG_ID, tick: 4, type: 'custom', value: 'beat',
    });
  });
});

describe('mounted draggable frame and property keys', () => {
  async function selectMovableMixedKeys() {
    const targets = [
      ['Frame key at tick 2', false],
      ['Position key at tick 2', true],
      ['Visibility key at tick 1', true],
      ['Effect intensity key at tick 1', true],
      ['Mask position key at tick 2', true],
      ['Mask opacity key at tick 1', true],
      ['Shape path key at tick 2', true],
    ];
    let pointerId = 110;
    for (const [name, ctrlKey] of targets) {
      await pointerGesture(screen.getByRole('button', { name }), {
        pointerId: pointerId++,
        ctrlKey,
      });
    }
  }

  test('mixed keys preview and move together in one recoverable history entry', async () => {
    await selectMovableMixedKeys();
    expect(getClipTimelineSelection().frameKeys).toHaveLength(1);
    expect(getClipTimelineSelection().propertyKeys).toHaveLength(6);
    const revision = get(authoredRevision);
    const target = screen.getByRole('button', { name: 'Frame key at tick 2' });
    await fireEvent.pointerDown(target, {
      button: 0, pointerId: 120, clientX: 100, clientY: 30,
    });
    await fireEvent.pointerMove(window, { pointerId: 120, clientX: 114, clientY: 30 });
    expect(screen.getByRole('button', { name: 'Frame key at tick 3' }).classList.contains('moving')).toBe(true);
    expect(document.querySelectorAll('.frame-key.moving, .property-key.moving')).toHaveLength(7);
    await fireEvent.pointerUp(window, { pointerId: 120, clientX: 114, clientY: 30 });
    await tick();

    expect(currentClip().frameKeys.map((key) => key.tick)).toEqual([0, 3, 4]);
    expect(currentClip().propertyTracks.position.map((key) => key.tick)).toEqual([0, 3, 4]);
    expect(currentClip().propertyTracks.visibility.map((key) => key.tick)).toEqual([2, 3]);
    expect(currentClip().propertyTracks.effectIntensity.map((key) => key.tick)).toEqual([2]);
    expect(currentClip().propertyTracks.maskPosition.map((key) => key.tick)).toEqual([3]);
    expect(currentClip().propertyTracks.maskOpacity.map((key) => key.tick)).toEqual([2]);
    expect(currentClip().propertyTracks.shapePath.map((key) => key.tick)).toEqual([3]);
    expect(get(authoredRevision)).toBe(revision + 1);
    expect(getClipTimelineSelection().frameKeys).toEqual([
      { clipId: 'mounted-clip', sourceTick: 3 },
    ]);
    expect(getClipTimelineSelection().propertyKeys).toHaveLength(6);

    undo();
    expect(currentClip().frameKeys.map((key) => key.tick)).toEqual([0, 2, 4]);
    expect(currentClip().propertyTracks.shapePath.map((key) => key.tick)).toEqual([2]);
    expect(getClipTimelineSelection().frameKeys[0].sourceTick).toBe(2);
    redo();
    expect(currentClip().frameKeys.map((key) => key.tick)).toEqual([0, 3, 4]);
    expect(currentClip().propertyTracks.shapePath.map((key) => key.tick)).toEqual([3]);
  });

  test('collision preview is visibly invalid and commits no history', async () => {
    const target = screen.getByRole('button', { name: 'Position key at tick 2' });
    await fireEvent.pointerDown(target, {
      button: 0, pointerId: 130, clientX: 100, clientY: 30,
    });
    const before = structuredClone(getClipTimelineState());
    const revision = get(authoredRevision);
    await fireEvent.pointerMove(window, { pointerId: 130, clientX: 128, clientY: 30 });
    const preview = screen.getAllByRole('button', { name: 'Position key at tick 4' })
      .find((candidate) => candidate.classList.contains('invalid-move'));
    expect(preview).toBeDefined();
    expect(preview.classList.contains('invalid-move')).toBe(true);
    await fireEvent.pointerUp(window, { pointerId: 130, clientX: 128, clientY: 30 });
    expect(getClipTimelineState()).toEqual(before);
    expect(get(authoredRevision)).toBe(revision);
    expect(get(canUndo)).toBe(false);
  });

  test('pointer cancellation restores exact mixed-key state and selection', async () => {
    await selectMovableMixedKeys();
    const before = structuredClone(getClipTimelineState());
    const selection = getClipTimelineSelection();
    await pointerGesture(screen.getByRole('button', { name: 'Frame key at tick 2' }), {
      pointerId: 140,
      startX: 100,
      endX: 114,
      cancelled: true,
    });
    expect(getClipTimelineState()).toEqual(before);
    expect(getClipTimelineSelection()).toEqual(selection);
    expect(get(canUndo)).toBe(false);
  });
});

describe('mounted Shift-drag clip duplication', () => {
  async function mountTwoClips() {
    cleanup();
    const state = timelineState();
    state.clips.push({
      ...structuredClone(state.clips[0]),
      id: 'second-clip',
      name: 'Second',
      startTick: 6,
    });
    loadCanonicalTimeline(state);
    resetEditorStateForProjectLoad();
    setClipSelection({ clipIds: ['mounted-clip'] });
    render(ClipTimeline, { expanded: true, pixelsPerTick: 14 });
    await tick();
    setTimelineViewportRect();
  }

  test('an ordinary drag still moves the original without creating a ghost', async () => {
    setTimelineViewportRect();
    const original = screen.getByRole('button', { name: 'visual clip Mounted' });
    await dispatchPointerEvent(original, 'pointerdown', {
      button: 0, pointerId: 144, clientX: 180, clientY: 50, shiftKey: false,
    });
    await fireEvent.pointerMove(window, { pointerId: 144, clientX: 194, clientY: 50 });
    expect(document.querySelector('.timeline-clip.duplicate-ghost')).toBeNull();
    await fireEvent.pointerUp(window, { pointerId: 144, clientX: 194, clientY: 50 });

    expect(getClipTimelineState().clips).toHaveLength(1);
    expect(currentClip().startTick).toBe(1);
  });

  test('captures Shift at pointer-down, renders a ghost, and commits one selectable copy', async () => {
    setTimelineViewportRect();
    const original = screen.getByRole('button', { name: 'visual clip Mounted' });
    const revision = get(authoredRevision);
    await dispatchPointerEvent(original, 'pointerdown', {
      button: 0, pointerId: 145, clientX: 180, clientY: 50, shiftKey: true,
    });
    await fireEvent.pointerMove(window, {
      pointerId: 145, clientX: 250, clientY: 50, shiftKey: false,
    });
    await tick();

    const ghost = document.querySelector('.timeline-clip.duplicate-ghost');
    expect(ghost).not.toBeNull();
    expect(ghost.classList.contains('invalid-duplicate')).toBe(false);
    expect(ghost.style.left).toBe('70px');
    expect(screen.getByRole('button', { name: 'visual clip Mounted' }).style.left).toBe('0px');

    await fireEvent.pointerUp(window, { pointerId: 145, clientX: 250, clientY: 50 });
    await tick();
    const clips = getClipTimelineState().clips;
    const copied = clips.find((clip) => clip.id !== 'mounted-clip');
    expect(clips.map((clip) => clip.startTick).sort((first, second) => first - second))
      .toEqual([0, 5]);
    expect(copied.id).not.toBe('mounted-clip');
    expect([...getClipTimelineSelection().clipIds]).toEqual([copied.id]);
    expect(get(authoredRevision)).toBe(revision + 1);
    expect(get(canUndo)).toBe(true);

    undo();
    expect(getClipTimelineState().clips.map((clip) => clip.id)).toEqual(['mounted-clip']);
    redo();
    expect(getClipTimelineState().clips).toHaveLength(2);
    expect([...getClipTimelineSelection().clipIds]).toEqual([copied.id]);
  });

  test('overlap shows an invalid ghost and pointer-up leaves the timeline exact', async () => {
    setTimelineViewportRect();
    const target = screen.getByRole('button', { name: 'visual clip Mounted' });
    const before = structuredClone(getClipTimelineState());
    const revision = get(authoredRevision);
    await dispatchPointerEvent(target, 'pointerdown', {
      button: 0, pointerId: 146, clientX: 180, clientY: 50, shiftKey: true,
    });
    await fireEvent.pointerMove(window, { pointerId: 146, clientX: 208, clientY: 50 });
    await tick();

    const ghost = document.querySelector('.timeline-clip.duplicate-ghost');
    expect(ghost).not.toBeNull();
    expect(ghost.classList.contains('invalid-duplicate')).toBe(true);
    await fireEvent.pointerUp(window, { pointerId: 146, clientX: 208, clientY: 50 });
    expect(getClipTimelineState()).toEqual(before);
    expect(get(authoredRevision)).toBe(revision);
    expect(get(canUndo)).toBe(false);
  });

  test('Escape and pointer cancellation discard valid duplicate previews', async () => {
    setTimelineViewportRect();
    const root = screen.getByRole('application', { name: 'Clip timeline' });
    let target = screen.getByRole('button', { name: 'visual clip Mounted' });
    const before = structuredClone(getClipTimelineState());
    await dispatchPointerEvent(target, 'pointerdown', {
      button: 0, pointerId: 147, clientX: 180, clientY: 50, shiftKey: true,
    });
    await fireEvent.pointerMove(window, { pointerId: 147, clientX: 250, clientY: 50 });
    expect(document.querySelector('.timeline-clip.duplicate-ghost')).not.toBeNull();
    await fireEvent.keyDown(root, { key: 'Escape' });
    await fireEvent.pointerUp(window, { pointerId: 147, clientX: 250, clientY: 50 });
    expect(getClipTimelineState()).toEqual(before);

    target = screen.getByRole('button', { name: 'visual clip Mounted' });
    await dispatchPointerEvent(target, 'pointerdown', {
      button: 0, pointerId: 148, clientX: 180, clientY: 50, shiftKey: true,
    });
    await fireEvent.pointerMove(window, { pointerId: 148, clientX: 250, clientY: 50 });
    await fireEvent.pointerCancel(window, { pointerId: 148, clientX: 250, clientY: 50 });
    expect(getClipTimelineState()).toEqual(before);
    expect(get(canUndo)).toBe(false);
  });

  test('Shift-dragging an unselected clip duplicates only that target', async () => {
    await mountTwoClips();
    const target = screen.getByRole('button', { name: 'visual clip Second' });
    await dispatchPointerEvent(target, 'pointerdown', {
      button: 0, pointerId: 149, clientX: 267, clientY: 50, shiftKey: true,
    });
    await fireEvent.pointerMove(window, { pointerId: 149, clientX: 337, clientY: 50 });
    expect([...getClipTimelineSelection().clipIds]).toEqual(['mounted-clip']);
    expect(document.querySelectorAll('.timeline-clip.duplicate-ghost')).toHaveLength(1);
    await fireEvent.pointerUp(window, { pointerId: 149, clientX: 337, clientY: 50 });

    const clips = getClipTimelineState().clips;
    const copy = clips.find((clip) => clip.id !== 'mounted-clip' && clip.id !== 'second-clip');
    expect(clips.map((clip) => [clip.id, clip.startTick])).toEqual([
      ['mounted-clip', 0],
      ['second-clip', 6],
      [copy.id, 11],
    ]);
    expect([...getClipTimelineSelection().clipIds]).toEqual([copy.id]);
  });

  test('Shift-click without crossing the threshold retains ordinary range selection', async () => {
    await mountTwoClips();
    const first = screen.getByRole('button', { name: 'visual clip Mounted' });
    const second = screen.getByRole('button', { name: 'visual clip Second' });
    await pointerGesture(first, { pointerId: 150, startX: 183, startY: 50 });
    await dispatchPointerEvent(second, 'pointerdown', {
      button: 0, pointerId: 151, clientX: 267, clientY: 50, shiftKey: true,
    });
    await fireEvent.pointerUp(window, { pointerId: 151, clientX: 267, clientY: 50 });

    expect(getClipTimelineState().clips).toHaveLength(2);
    expect([...getClipTimelineSelection().clipIds]).toEqual(['mounted-clip', 'second-clip']);
    expect(get(canUndo)).toBe(false);
  });

  test('lost pointer capture cancels a valid ghost without history or commit', async () => {
    setTimelineViewportRect();
    const target = screen.getByRole('button', { name: 'visual clip Mounted' });
    const before = structuredClone(getClipTimelineState());
    await dispatchPointerEvent(target, 'pointerdown', {
      button: 0, pointerId: 152, clientX: 180, clientY: 50, shiftKey: true,
    });
    await fireEvent.pointerMove(window, { pointerId: 152, clientX: 250, clientY: 50 });
    expect(document.querySelector('.timeline-clip.duplicate-ghost')).not.toBeNull();
    await dispatchPointerEvent(target, 'lostpointercapture', { pointerId: 152 });
    await fireEvent.pointerUp(window, { pointerId: 152, clientX: 250, clientY: 50 });

    expect(document.querySelector('.timeline-clip.duplicate-ghost')).toBeNull();
    expect(getClipTimelineState()).toEqual(before);
    expect(get(canUndo)).toBe(false);
  });
});

describe('mounted timeline presentation and input geometry', () => {
  test('Timeline-owned Space toggles transport and popup input suppresses it', async () => {
    const root = screen.getByRole('application', { name: 'Clip timeline' });
    await fireEvent.pointerDown(root, { button: 0, pointerId: 150, clientX: 5, clientY: 5 });
    expect(keyboardContextOwns('timeline', {})).toBe(true);
    expect(await fireEvent.keyDown(root, { key: ' ', code: 'Space' })).toBe(false);
    expect(get(playing)).toBe(true);
    await fireEvent.pointerDown(root, { button: 0, pointerId: 151, clientX: 5, clientY: 5 });
    expect(keyboardContextOwns('timeline', {})).toBe(true);
    expect(await fireEvent.keyDown(root, { key: ' ', code: 'Space' })).toBe(false);
    expect(get(playing)).toBe(false);

    await fireEvent.contextMenu(screen.getByRole('button', { name: /Custom tag/ }), {
      clientX: 40, clientY: 40,
    });
    const input = screen.getByRole('spinbutton', { name: 'Tag tick' });
    await fireEvent.keyDown(input, { key: ' ', code: 'Space' });
    expect(get(playing)).toBe(false);
  });

  test('Ctrl/Cmd+wheel zooms around the pointer while ordinary and input wheel stay native', async () => {
    const viewport = setTimelineViewportRect(640, 220);
    viewport.scrollLeft = 70;
    await fireEvent.scroll(viewport);
    const surface = document.querySelector('.timeline-surface');
    const ordinary = wheelEvent({ deltaY: 100, clientX: 246, ctrlKey: false, metaKey: false });
    expect(viewport.dispatchEvent(ordinary)).toBe(true);
    expect(surface.style.getPropertyValue('--tick-width')).toBe('14px');

    const zoom = wheelEvent({ deltaY: -100, ctrlKey: true, metaKey: false, clientX: 246 });
    expect(viewport.dispatchEvent(zoom)).toBe(false);
    await waitFor(() => expect(surface.style.getPropertyValue('--tick-width')).toBe('16px'));
    await waitFor(() => expect(viewport.scrollLeft).toBe(90));

    await fireEvent.contextMenu(screen.getByRole('button', { name: /Custom tag/ }), {
      clientX: 40, clientY: 40,
    });
    const input = screen.getByRole('spinbutton', { name: 'Tag tick' });
    const suppressed = wheelEvent({ deltaY: -100, ctrlKey: true, metaKey: false, clientX: 246 });
    expect(input.dispatchEvent(suppressed)).toBe(true);
    expect(surface.style.getPropertyValue('--tick-width')).toBe('16px');
  });

  test.each([
    { name: 'minimum', zoom: 4, awayDelta: -100, awayZoom: 6, backDelta: 100 },
    { name: 'maximum', zoom: 48, awayDelta: 100, awayZoom: 46, backDelta: -100 },
  ])('Ctrl+wheel restores exact scroll and tick coordinates at $name zoom', async ({
    zoom, awayDelta, awayZoom, backDelta,
  }) => {
    cleanup();
    loadCanonicalTimeline(timelineState());
    resetEditorStateForProjectLoad();
    render(ClipTimeline, { expanded: true, pixelsPerTick: zoom });
    await tick();
    const viewport = setTimelineViewportRect();
    const initialScrollLeft = 73.5;
    const clientX = 312.25;
    const logicalTick = 7.25;
    viewport.scrollLeft = initialScrollLeft;
    await fireEvent.scroll(viewport);
    const surface = document.querySelector('.timeline-surface');
    const laneLeft = Number.parseFloat(document.querySelector('.track-lane').style.left);
    const initialScreenX = laneLeft + logicalTick * zoom - initialScrollLeft;

    expect(viewport.dispatchEvent(wheelEvent({
      deltaY: awayDelta, ctrlKey: true, metaKey: false, clientX,
    }))).toBe(false);
    await waitFor(() => expect(surface.style.getPropertyValue('--tick-width')).toBe(`${awayZoom}px`));
    expect(viewport.dispatchEvent(wheelEvent({
      deltaY: backDelta, ctrlKey: true, metaKey: false, clientX,
    }))).toBe(false);
    await waitFor(() => expect(surface.style.getPropertyValue('--tick-width')).toBe(`${zoom}px`));

    await waitFor(() => expect(viewport.scrollLeft).toBe(initialScrollLeft));
    expect(laneLeft + logicalTick * zoom - viewport.scrollLeft).toBe(initialScreenX);
  });

  test('fractional-DPR anchor resets after header resize and collapse remount, then reverses exactly', async () => {
    cleanup();
    loadCanonicalTimeline(timelineState());
    resetEditorStateForProjectLoad();
    const descriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.25 });
    try {
      const mounted = render(ClipTimeline, { expanded: true, pixelsPerTick: 14 });
      await tick();
      const separator = screen.getByRole('separator', { name: 'Resize track headers' });
      await fireEvent.keyDown(separator, { key: 'ArrowRight' });
      await fireEvent.keyDown(separator, { key: 'ArrowRight' });
      expect(separator.getAttribute('aria-valuenow')).toBe('192');

      await mounted.rerender({ expanded: false, pixelsPerTick: 14 });
      await mounted.rerender({ expanded: true, pixelsPerTick: 14 });
      const viewport = setTimelineViewportRect();
      const initialScrollLeft = 70.4;
      const clientX = 321.75;
      const logicalTick = 9.5;
      viewport.scrollLeft = initialScrollLeft;
      await fireEvent.scroll(viewport);
      const surface = document.querySelector('.timeline-surface');
      const laneLeft = Number.parseFloat(document.querySelector('.track-lane').style.left);
      const initialScreenX = laneLeft + logicalTick * 14 - initialScrollLeft;

      viewport.dispatchEvent(wheelEvent({
        deltaY: 100, ctrlKey: true, metaKey: false, clientX,
      }));
      await waitFor(() => expect(surface.style.getPropertyValue('--tick-width')).toBe('12px'));
      expect(viewport.scrollLeft * 1.25).toBe(Math.round(viewport.scrollLeft * 1.25));
      viewport.dispatchEvent(wheelEvent({
        deltaY: -100, ctrlKey: true, metaKey: false, clientX,
      }));
      await waitFor(() => expect(surface.style.getPropertyValue('--tick-width')).toBe('14px'));

      await waitFor(() => expect(viewport.scrollLeft).toBe(initialScrollLeft));
      expect(laneLeft + logicalTick * 14 - viewport.scrollLeft).toBe(initialScreenX);
    } finally {
      if (descriptor) Object.defineProperty(window, 'devicePixelRatio', descriptor);
      else delete window.devicePixelRatio;
    }
  });

  test('filmstrip mode expands and restores complete row geometry', async () => {
    const row = document.querySelector('.timeline-row');
    expect(row.style.height).toBe('42px');
    await fireEvent.contextMenu(screen.getByRole('button', { name: 'visual clip Mounted' }), {
      clientX: 40, clientY: 40,
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Show frame thumbnails' }));
    await waitFor(() => expect(row.style.height).toBe('56px'));
    expect(document.querySelector('.clip-timeline').classList.contains('filmstrip-mode')).toBe(true);
    expect(document.querySelector('.track-lane').parentElement.style.height).toBe('56px');
    expect(document.querySelectorAll('.frame-thumbnail').length).toBeGreaterThan(0);
    await fireEvent.click(screen.getByRole('button', { name: 'Hide frame thumbnails' }));
    await waitFor(() => expect(row.style.height).toBe('42px'));
  });

  test('maximum zoom remount resets stale scroll and maps each visible tick cell exactly', async () => {
    cleanup();
    loadCanonicalTimeline(timelineState());
    resetEditorStateForProjectLoad();
    const mounted = render(ClipTimeline, { expanded: true, pixelsPerTick: 48 });
    await tick();
    let viewport = setTimelineViewportRect();
    viewport.scrollLeft = 96;
    await fireEvent.scroll(viewport);

    await mounted.rerender({ expanded: false, pixelsPerTick: 48 });
    await mounted.rerender({ expanded: true, pixelsPerTick: 48 });
    viewport = setTimelineViewportRect();
    expect(viewport.scrollLeft).toBe(0);
    const lane = document.querySelector('.track-lane');
    const laneLeft = Number.parseFloat(lane.style.left);
    await pointerGesture(lane, {
      pointerId: 159,
      startX: laneLeft + 47.9,
      startY: 50,
    });
    expect(get(playheadTick)).toBe(0);
    await pointerGesture(lane, {
      pointerId: 160,
      startX: laneLeft + 48,
      startY: 50,
    });
    expect(get(playheadTick)).toBe(1);
  });

  test.each([4, 14, 48])(
    'playhead visual and tag drag zones stay separate at %ipx zoom',
    async (zoom) => {
      cleanup();
      loadCanonicalTimeline(timelineState());
      resetEditorStateForProjectLoad();
      seekTick(1);
      render(ClipTimeline, { expanded: true, pixelsPerTick: zoom });
      await tick();
      setTimelineViewportRect();
      const head = document.querySelector('.cti-head');
      const rulerLine = document.querySelector('.cti-ruler-line');
      const marker = screen.getByRole('button', { name: /Custom tag/ });
      const line = document.querySelector('.playhead-line');
      expect(head.style.zIndex).toBe('12');
      expect(rulerLine.style.zIndex).toBe('11');
      expect(marker.style.zIndex).toBe('9');
      expect(line.style.zIndex).toBe('21');
      expect(Number.parseFloat(marker.style.top)).toBeGreaterThanOrEqual(
        Number.parseFloat(head.style.height),
      );
      expect(rulerLine.tagName).toBe('SPAN');
      expect(rulerLine.getAttribute('aria-hidden')).toBe('true');

      const markerX = 176 + zoom;
      await pointerGesture(marker, {
        pointerId: 161 + zoom,
        startX: markerX,
        startY: 10,
        endX: markerX + zoom,
        endY: 10,
      });
      expect(getClipTimelineState().tags[0].tick).toBe(2);
      const movedMarker = screen.getByRole('button', { name: /Custom tag .* at tick 2/ });
      await fireEvent.contextMenu(movedMarker, { clientX: 40, clientY: 40 });
      expect(screen.getByRole('dialog', { name: 'Edit tags at tick 2' })).not.toBeNull();
      await fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Tag tick' }), { key: 'Escape' });

      await pointerGesture(head, {
        pointerId: 261 + zoom,
        startX: markerX,
        startY: 3,
        endX: markerX + zoom,
        endY: 3,
      });
      expect(get(playheadTick)).toBe(2);
    },
  );

  test.each([
    { name: 'minimum compact', zoom: 4, filmstrip: false },
    { name: 'default compact', zoom: 14, filmstrip: false },
    { name: 'maximum compact', zoom: 48, filmstrip: false },
    { name: 'minimum filmstrip', zoom: 4, filmstrip: true },
  ])('$name keeps every dense opening key hit box disjoint', async ({ zoom, filmstrip }) => {
    cleanup();
    loadCanonicalTimeline(denseOpeningKeyState());
    resetEditorStateForProjectLoad();
    render(ClipTimeline, { expanded: true, pixelsPerTick: zoom, showFilmstrip: filmstrip });
    await tick();

    const keys = [...document.querySelectorAll('.frame-key, .property-key')];
    expect(keys).toHaveLength(8);
    const boxes = keys.map((key) => ({
      name: key.getAttribute('aria-label'),
      left: Number.parseFloat(key.style.left),
      top: Number.parseFloat(key.style.top),
      width: Number.parseFloat(key.style.width),
      height: Number.parseFloat(key.style.height),
    })).map((box) => ({
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
    }));
    for (let first = 0; first < boxes.length; first++) {
      expect(boxes[first].width).toBeGreaterThanOrEqual(4);
      expect(boxes[first].height).toBeGreaterThanOrEqual(6);
      for (let second = first + 1; second < boxes.length; second++) {
        const overlaps = boxes[first].left < boxes[second].right &&
          boxes[second].left < boxes[first].right &&
          boxes[first].top < boxes[second].bottom &&
          boxes[second].top < boxes[first].bottom;
        expect(overlaps, `${boxes[first].name} overlaps ${boxes[second].name}`).toBe(false);
      }
    }
    expect(keys.filter((key) => key.getAttribute('aria-label').endsWith('tick 0')))
      .toHaveLength(4);
  });

  test.each([4, 14, 48])(
    'final trim target stays inside its clip and remains draggable at %ipx zoom',
    async (zoom) => {
      cleanup();
      loadCanonicalTimeline(timelineState());
      resetEditorStateForProjectLoad();
      const descriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.25 });
      try {
        render(ClipTimeline, { expanded: true, pixelsPerTick: zoom });
        await tick();
        const clip = screen.getByRole('button', { name: 'visual clip Mounted' });
        const start = screen.getByRole('button', { name: 'Trim start of Mounted' });
        const end = screen.getByRole('button', { name: 'Trim end of Mounted' });
        const clipWidth = Number.parseFloat(clip.style.width);
        const startLeft = Number.parseFloat(start.style.left);
        const startWidth = Number.parseFloat(start.style.width);
        const endLeft = Number.parseFloat(end.style.left);
        const endWidth = Number.parseFloat(end.style.width);
        expect(end.disabled).toBe(false);
        expect(startLeft).toBeGreaterThanOrEqual(0);
        expect(startLeft + startWidth).toBeLessThanOrEqual(clipWidth);
        expect(endLeft).toBeGreaterThanOrEqual(0);
        expect(endLeft + endWidth).toBe(clipWidth);
        expect((endLeft + endWidth) * window.devicePixelRatio)
          .toBe(clipWidth * window.devicePixelRatio);

        await fireEvent.pointerDown(end, {
          button: 0, pointerId: 500 + zoom, clientX: 100, clientY: 30, altKey: true,
        });
        expect([...getClipTimelineSelection().clipIds]).toEqual(['mounted-clip']);
        await fireEvent.pointerMove(window, {
          pointerId: 500 + zoom, clientX: 100 + zoom, clientY: 30, altKey: true,
        });
        await tick();
        expect(Number.parseFloat(
          screen.getByRole('button', { name: 'visual clip Mounted' }).style.width,
        )).toBe(6 * zoom);
        await fireEvent.pointerUp(window, {
          pointerId: 500 + zoom, clientX: 100 + zoom, clientY: 30, altKey: true,
        });
        expect(currentClip().outTick).toBe(6);
      } finally {
        if (descriptor) Object.defineProperty(window, 'devicePixelRatio', descriptor);
        else delete window.devicePixelRatio;
      }
    },
  );

  test.each([
    ['Frame key at tick 1', 'frameKeys'],
    ['Position key at tick 1', 'position'],
    ['Visibility key at tick 1', 'visibility'],
    ['Effect intensity key at tick 1', 'effectIntensity'],
  ])('%s can start its own direct drag', async (name, target) => {
    cleanup();
    loadCanonicalTimeline(denseOpeningKeyState());
    resetEditorStateForProjectLoad();
    render(ClipTimeline, { expanded: true, pixelsPerTick: 14 });
    await tick();

    await pointerGesture(screen.getByRole('button', { name }), {
      pointerId: 360 + name.length,
      startX: 100,
      startY: 20,
      endX: 128,
      endY: 20,
    });
    const clip = currentClip();
    const keys = target === 'frameKeys' ? clip.frameKeys : clip.propertyTracks[target];
    expect(keys.map((key) => key.tick).sort((first, second) => first - second)).toEqual([0, 3]);
  });

  test('locked dense opening keys retain their geometry and reject direct motion', async () => {
    cleanup();
    loadCanonicalTimeline(denseOpeningKeyState({ locked: true }));
    resetEditorStateForProjectLoad();
    render(ClipTimeline, { expanded: true, pixelsPerTick: 4 });
    await tick();
    const before = structuredClone(currentClip());
    const revision = get(authoredRevision);
    await pointerGesture(screen.getByRole('button', { name: 'Effect intensity key at tick 1' }), {
      pointerId: 410,
      startX: 100,
      startY: 20,
      endX: 108,
      endY: 20,
    });
    expect(currentClip()).toEqual(before);
    expect(get(authoredRevision)).toBe(revision);
    expect(get(canUndo)).toBe(false);
    expect(document.querySelectorAll('.frame-key, .property-key')).toHaveLength(8);
  });

  test('start-only loop band reaches the inclusive final sequence tick', async () => {
    cleanup();
    const state = timelineState();
    state.tags = [{ id: LOOP_START_ID, tick: 1, type: 'loop-start' }];
    loadCanonicalTimeline(state);
    resetEditorStateForProjectLoad();
    render(ClipTimeline, { expanded: true, pixelsPerTick: 14 });
    await tick();
    const band = document.querySelector('.loop-range-band');
    expect(band.title).toBe('Loop range: ticks 1 through 4, inclusive');
    expect(band.style.width).toBe('56px');
  });
});

describe('mounted header and media empty states', () => {
  test('Timeline zoom range keeps native navigation local while command keys bubble', async () => {
    cleanup();
    loadCanonicalTimeline(timelineState());
    resetEditorStateForProjectLoad();
    seekTick(2);
    render(TimelineV2, { expanded: true });
    await tick();
    const slider = screen.getByRole('slider', { name: 'Timeline zoom' });
    const globalKeys = [];
    const recordGlobalKey = (event) => globalKeys.push(event.key);
    window.addEventListener('keydown', recordGlobalKey);
    try {
      slider.focus();
      for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        expect(slider.dispatchEvent(event)).toBe(true);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(document.activeElement).toBe(slider);
      expect(get(playheadTick)).toBe(2);
      expect(globalKeys).toEqual([]);

      slider.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'n', ctrlKey: true, bubbles: true, cancelable: true,
      }));
      slider.dispatchEvent(new KeyboardEvent('keydown', {
        key: 's', ctrlKey: true, bubbles: true, cancelable: true,
      }));
      expect(globalKeys).toEqual(['n', 's']);
    } finally {
      window.removeEventListener('keydown', recordGlobalKey);
    }
  });

  test('onion Off, Layer, and All have distinct resting icon structures', async () => {
    cleanup();
    onionSkin.set('off');
    render(TimelineV2, { expanded: false });
    await tick();
    let button = screen.getByRole('button', { name: 'Onion: Off' });
    expect(button.dataset.onionState).toBe('off');
    expect(button.querySelector('[data-onion-icon="off"]')).not.toBeNull();
    await fireEvent.click(button);
    button = screen.getByRole('button', { name: 'Onion: Layer' });
    expect(button.dataset.onionState).toBe('layer');
    expect(button.querySelector('[data-onion-icon="layer"]')).not.toBeNull();
    expect(button.querySelector('.onion-stack')).toBeNull();
    await fireEvent.click(button);
    button = screen.getByRole('button', { name: 'Onion: All' });
    expect(button.dataset.onionState).toBe('all');
    expect(button.querySelector('[data-onion-icon="all"].onion-stack')).not.toBeNull();
  });

  test('empty Project Assets names the state above the three import commands', async () => {
    cleanup();
    projectMediaRegistry.set({ generation: 0, assets: [] });
    const requested = [];
    const listener = (event) => requested.push(event.detail.kind);
    window.addEventListener('import-project-media', listener);
    render(ProjectAssets);
    await tick();
    expect(screen.getByText('No project assets.')).not.toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Import image…' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Import audio…' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Import video…' }));
    expect(requested).toEqual(['image', 'audio', 'video']);
    window.removeEventListener('import-project-media', listener);
  });
});
