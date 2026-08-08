import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { tick } from 'svelte';
import Canvas from '../src/components/Canvas.svelte';
import ToolOptionsBar from '../src/components/ToolOptionsBar.svelte';
import {
  canUndo,
  cropPending,
  dims,
  layers,
  resetEditorStateForProjectLoad,
  undo,
} from '../src/lib/grid.js';
import {
  loadCanonicalTimeline,
  playing,
  seekTick,
} from '../src/lib/frames.js';
import { notifications } from '../src/lib/notifications.js';
import {
  activeChar,
  activeTool,
  dirty,
  paintColor,
  toolOptions,
} from '../src/lib/stores.js';

const LAYER_ID = '10000000-0000-4000-8000-000000000001';
const TRACK_ID = '20000000-0000-4000-8000-000000000002';
const CLIP_ID = '30000000-0000-4000-8000-000000000003';
const BASE_TOOL_OPTIONS = structuredClone(get(toolOptions));

function canvasContext() {
  return {
    clearRect: vi.fn(),
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }),
    measureText: () => ({
      width: 11,
      fontBoundingBoxAscent: 17,
      fontBoundingBoxDescent: 5,
    }),
    putImageData: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    translate: vi.fn(),
  };
}

function loadPaintOwner({ hidden = false, absent = false } = {}) {
  const layer = {
    id: LAYER_ID,
    name: 'Owner',
    type: 'cell',
    visible: !hidden,
    cells: {},
    offset: { x: 0, y: 0 },
  };
  loadCanonicalTimeline({
    fps: 24,
    tracks: [{ id: TRACK_ID, kind: 'visual', locked: false, layer }],
    clips: [{
      id: CLIP_ID,
      trackId: TRACK_ID,
      kind: 'visual',
      startTick: absent ? 2 : 0,
      inTick: 0,
      outTick: 1,
      sourceDuration: 1,
      frameKeys: [{ tick: 0, value: { cells: {} } }],
      propertyTracks: {},
    }],
  });
  resetEditorStateForProjectLoad();
  seekTick(0);
}

async function paintGesture(tool, options = {}) {
  activeTool.set(tool);
  loadPaintOwner(options);
  render(Canvas);
  await tick();
  const stage = document.querySelector('.stage');
  stage.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 44, bottom: 88, width: 44, height: 88,
  });
  const target = document.querySelector('.hit-catcher');
  await fireEvent.pointerDown(target, {
    button: 0, pointerId: 41, clientX: 5, clientY: 5,
  });
  await fireEvent.pointerMove(target, {
    pointerId: 41, clientX: 16, clientY: 5,
  });
  if (options.cancelled) {
    await fireEvent.pointerCancel(target, {
      pointerId: 41, clientX: 16, clientY: 5,
    });
  } else {
    await fireEvent.pointerUp(target, {
      button: 0, pointerId: 41, clientX: 16, clientY: 5,
    });
  }
  await tick();
}

async function mountToolOptionsAndCanvas(tool) {
  activeTool.set(tool);
  loadPaintOwner();
  render(ToolOptionsBar);
  render(Canvas);
  await tick();
  document.querySelector('.stage').getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 44, bottom: 88, width: 44, height: 88,
  });
  return document.querySelector('.hit-catcher');
}

beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(canvasContext);
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  if (!window.matchMedia) {
    window.matchMedia = () => ({
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
  }
});

beforeEach(() => {
  dims.set({ w: 4, h: 4 });
  playing.set(false);
  dirty.set(false);
  activeChar.set('X');
  paintColor.set('#abcdef');
  toolOptions.set(structuredClone(BASE_TOOL_OPTIONS));
  cropPending.set(null);
  notifications.set([]);
});

afterEach(() => {
  cleanup();
  playing.set(false);
  cropPending.set(null);
  notifications.set([]);
});

describe('mounted fresh paint-owner feedback', () => {
  test.each([
    ['Brush', 'brush', { hidden: true }],
    ['Special', 'subcell', { absent: true }],
    ['Fill', 'fill', { hidden: true }],
  ])('%s names one visible replacement layer in its existing gesture', async (
    _label, tool, owner,
  ) => {
    await paintGesture(tool, owner);

    expect(get(layers).map((layer) => layer.name)).toEqual(['Layer 1', 'Owner']);
    expect(get(notifications)).toEqual([expect.objectContaining({
      message: 'Created Layer 1 for this tick.',
      tone: 'info',
    })]);
    expect(get(canUndo)).toBe(true);
    undo();
    expect(get(layers).map((layer) => layer.name)).toEqual(['Owner']);
    expect(get(canUndo)).toBe(false);
  });

  test('a present empty owner paints without a creation notice or replacement layer', async () => {
    await paintGesture('brush');

    expect(get(layers).map((layer) => layer.name)).toEqual(['Owner']);
    expect(get(notifications)).toEqual([]);
    expect(get(canUndo)).toBe(true);
  });

  test('cancelling a fresh-owner gesture removes the layer without a notice', async () => {
    await paintGesture('brush', { absent: true, cancelled: true });

    expect(get(layers).map((layer) => layer.name)).toEqual(['Owner']);
    expect(get(notifications)).toEqual([]);
    expect(get(canUndo)).toBe(false);
  });
});

describe('mounted number drafts consumed by canvas pointers', () => {
  test('Polygon sides commits before the first creation pointer-down', async () => {
    const target = await mountToolOptionsAndCanvas('polygon');
    const input = screen.getByRole('spinbutton', { name: 'New polygon sides' });
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: '7' } });

    await fireEvent.pointerDown(target, {
      button: 0, pointerId: 51, clientX: 5, clientY: 5,
    });
    expect(get(toolOptions).polygon.sides).toBe(7);
    await fireEvent.pointerMove(target, {
      pointerId: 51, clientX: 27, clientY: 49,
    });
    await fireEvent.pointerUp(target, {
      button: 0, pointerId: 51, clientX: 27, clientY: 49,
    });
    await tick();

    const polygon = get(layers).find((layer) => layer.type === 'shape');
    expect(polygon?.shape.kind).toBe('polygon');
    expect(polygon?.shape.sides).toBe(7);
    expect(polygon?.shape.vertices).toHaveLength(7);
  });

  test('Crop height is the drag baseline on the first overlay pointer-down', async () => {
    await mountToolOptionsAndCanvas('crop');
    const input = screen.getByRole('spinbutton', { name: 'Crop height' });
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: '2' } });
    const frame = document.querySelector('.crop-frame');

    await fireEvent.pointerDown(frame, {
      button: 0, pointerId: 61, clientX: 5, clientY: 5,
    });
    expect(get(cropPending)?.h).toBe(2);
    await fireEvent.pointerMove(window, {
      pointerId: 61, clientX: 16, clientY: 27,
    });
    await fireEvent.pointerUp(window, {
      pointerId: 61, clientX: 16, clientY: 27,
    });
    expect(get(cropPending)).toMatchObject({ x: 1, y: 1, w: 4, h: 2 });
  });
});
