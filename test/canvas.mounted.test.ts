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
  removeSelectedLayers,
  resetEditorStateForProjectLoad,
  selectLayer,
  setLayers,
  undo,
} from '../src/lib/grid.ts';
import {
  initTimeline,
  loadCanonicalTimeline,
  playing,
  seekTick,
} from '../src/lib/frames.ts';
import { notifications } from '../src/lib/notifications.ts';
import {
  activeChar,
  activeTool,
  dirty,
  paintColor,
  toolOptions,
} from '../src/lib/stores.ts';
import type {
  EditorCellLayer,
  EditorShapeLayer,
  EditorTool,
} from '../src/lib/types/editor-domain.ts';
import {
  requireElement,
  requireValue,
  testCanvasContext,
  testMediaQueryList,
  testRect,
  TestResizeObserver,
} from './types/ui-test-types.ts';

const LAYER_ID = '10000000-0000-4000-8000-000000000001';
const TRACK_ID = '20000000-0000-4000-8000-000000000002';
const CLIP_ID = '30000000-0000-4000-8000-000000000003';
const BASE_TOOL_OPTIONS = structuredClone(get(toolOptions));

interface PaintOwnerOptions {
  hidden?: boolean;
  absent?: boolean;
  cancelled?: boolean;
}

function createImageData(width: number, height: number, settings?: ImageDataSettings): ImageData;
function createImageData(imageData: ImageData): ImageData;
function createImageData(
  widthOrImageData: number | ImageData,
  height?: number,
  settings?: ImageDataSettings,
): ImageData {
  if (widthOrImageData instanceof ImageData) {
    return new ImageData(widthOrImageData.width, widthOrImageData.height, settings);
  }
  return new ImageData(widthOrImageData, requireValue(height), settings);
}

function canvasContext(): CanvasRenderingContext2D {
  return testCanvasContext({
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    clip: vi.fn(),
    createImageData,
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    getImageData: () => new ImageData(1, 1),
    measureText: () => ({
      width: 11,
      actualBoundingBoxAscent: 17,
      actualBoundingBoxDescent: 5,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 11,
      fontBoundingBoxAscent: 17,
      fontBoundingBoxDescent: 5,
      emHeightAscent: 17,
      emHeightDescent: 5,
      hangingBaseline: 0,
      alphabeticBaseline: 0,
      ideographicBaseline: 0,
    }),
    putImageData: vi.fn(),
    rect: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    translate: vi.fn(),
  });
}

function loadPaintOwner({ hidden = false, absent = false }: PaintOwnerOptions = {}): void {
  const layer: EditorCellLayer = {
    id: LAYER_ID,
    name: 'Owner',
    type: 'cell',
    visible: !hidden,
    cells: {},
    offset: { x: 0, y: 0 },
  };
  loadCanonicalTimeline({
    fps: 24,
    tags: [],
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

async function paintGesture(tool: EditorTool, options: PaintOwnerOptions = {}): Promise<void> {
  activeTool.set(tool);
  loadPaintOwner(options);
  render(Canvas);
  await tick();
  const stage = requireElement<HTMLElement>('.stage');
  stage.getBoundingClientRect = () => testRect(44, 88);
  const target = requireElement<HTMLElement>('.hit-catcher');
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

async function mountToolOptionsAndCanvas(tool: EditorTool): Promise<HTMLElement> {
  activeTool.set(tool);
  loadPaintOwner();
  render(ToolOptionsBar);
  render(Canvas);
  await tick();
  requireElement<HTMLElement>('.stage').getBoundingClientRect = () => testRect(44, 88);
  return requireElement<HTMLElement>('.hit-catcher');
}

beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(canvasContext);
  globalThis.ResizeObserver = TestResizeObserver;
  if (!window.matchMedia) {
    window.matchMedia = (query: string) => testMediaQueryList(query);
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
  const ownerCases = [
    ['Brush', 'brush', { hidden: true }],
    ['Special', 'subcell', { absent: true }],
    ['Fill', 'fill', { hidden: true }],
  ] satisfies ReadonlyArray<readonly [string, EditorTool, PaintOwnerOptions]>;

  test.each(ownerCases)('%s names one visible replacement layer in its existing gesture', async (
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

    const polygon = requireValue(get(layers).find(
      (layer): layer is EditorShapeLayer => layer.type === 'shape',
    ));
    const shape = requireValue(polygon.shape);
    expect(shape.kind).toBe('polygon');
    expect(shape.sides).toBe(7);
    expect(shape.vertices).toHaveLength(7);
  });

  test('Colour Clip channel creates a non-emitting Colour Clip shape', async () => {
    const target = await mountToolOptionsAndCanvas('rect');
    await fireEvent.click(screen.getByRole('button', { name: 'Colour Clip' }));
    expect(get(toolOptions).rect.channel).toBe('color-clip');

    await fireEvent.pointerDown(target, {
      button: 0, pointerId: 52, clientX: 5, clientY: 5,
    });
    await fireEvent.pointerMove(target, {
      pointerId: 52, clientX: 27, clientY: 27,
    });
    await fireEvent.pointerUp(target, {
      button: 0, pointerId: 52, clientX: 27, clientY: 27,
    });
    await tick();

    const shapeLayer = requireValue(get(layers).find(
      (layer): layer is EditorShapeLayer => layer.type === 'shape',
    ));
    expect(requireValue(shapeLayer.shape)).toMatchObject({ channel: 'color-clip', mix: 1 });
  });

  test('Crop height is the drag baseline on the first overlay pointer-down', async () => {
    await mountToolOptionsAndCanvas('crop');
    const input = screen.getByRole('spinbutton', { name: 'Crop height' });
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: '2' } });
    const frame = requireElement<HTMLElement>('.crop-frame');

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

describe('mounted text editing cleanup', () => {
  test('deleting the edited text layer removes its textarea and outline immediately', async () => {
    const id = '40000000-0000-4000-8000-000000000004';
    setLayers([{
      id,
      name: 'Caption',
      type: 'text',
      visible: true,
      text: 'Hello',
      fg: '#ffffff',
      runs: [],
      box: { x: 0, y: 0, w: 3, h: 1 },
      wrap: true,
      cells: {},
    }]);
    initTimeline(get(layers));
    selectLayer(id);
    activeTool.set('text');
    render(Canvas);
    await tick();
    const stage = requireElement<HTMLElement>('.stage');
    stage.getBoundingClientRect = () => testRect(44, 88);
    const target = requireElement<HTMLElement>('.hit-catcher');
    await fireEvent.pointerDown(target, { button: 0, pointerId: 71, clientX: 5, clientY: 5 });
    await fireEvent.pointerUp(target, { button: 0, pointerId: 71, clientX: 5, clientY: 5 });
    await tick();
    expect(document.querySelector('.text-input')).not.toBeNull();

    removeSelectedLayers();
    await tick();
    expect(document.querySelector('.text-input')).toBeNull();
    expect(document.querySelector('.text-box')).toBeNull();
  });
});
