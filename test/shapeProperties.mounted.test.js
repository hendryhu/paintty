import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { tick } from 'svelte';
import LayerPropertiesPanel from '../src/components/LayerPropertiesPanel.svelte';
import ToolOptionsBar from '../src/components/ToolOptionsBar.svelte';
import {
  canUndo,
  layers,
  redo,
  resetEditorStateForProjectLoad,
  selectLayer,
  setLayers,
  undo,
} from '../src/lib/grid.js';
import {
  activeFrameIndex,
  effectIntensityKeys,
  isEffectIntensityTrackEnabled,
  loadCanonicalTimeline,
  playing,
  shapePathAt,
} from '../src/lib/frames.js';
import { regularPolygonVertices, renderShapeToCells } from '../src/lib/shapes.js';
import {
  activeChar,
  activeTool,
  dirty,
  toolOptions,
} from '../src/lib/stores.js';

const GROUP_ID = '10000000-0000-4000-8000-000000000001';
const POLYGON_ID = '20000000-0000-4000-8000-000000000002';
const EFFECT_ID = '30000000-0000-4000-8000-000000000003';
const EFFECT_TRACK_ID = '40000000-0000-4000-8000-000000000004';
const EFFECT_CLIP_ID = '50000000-0000-4000-8000-000000000005';
const BASE_TOOL_OPTIONS = structuredClone(get(toolOptions));

function polygonShape(sides) {
  const shape = {
    kind: 'polygon',
    style: 'outline',
    detail: 'cell',
    channel: 'glyph',
    char: '█',
    fg: '#abcdef',
    sides,
    thickness: 1,
    strokeAlign: 'center',
    x0: 2,
    y0: 2,
    x1: 14,
    y1: 10,
    anchor: { x: 8, y: 6 },
    rotation: 17,
  };
  return {
    ...shape,
    vertices: regularPolygonVertices(
      shape.x0,
      shape.y0,
      shape.x1,
      shape.y1,
      sides,
    ),
  };
}

function mountPolygon(sides) {
  const shape = polygonShape(sides);
  setLayers([
    {
      id: GROUP_ID,
      name: 'Moved group',
      type: 'group',
      visible: true,
      collapsed: false,
      offset: { x: -2, y: 4 },
      cells: {},
    },
    {
      id: POLYGON_ID,
      name: `${sides}-side polygon`,
      type: 'shape',
      visible: true,
      groupId: GROUP_ID,
      offset: { x: 3, y: -1 },
      shape,
      cells: renderShapeToCells(shape),
    },
  ]);
  selectLayer(POLYGON_ID);
  render(ToolOptionsBar);
  render(LayerPropertiesPanel);
}

function polygonLayer() {
  return get(layers).find((layer) => layer.id === POLYGON_ID);
}

function stablePolygonState() {
  const layer = polygonLayer();
  const shape = layer.shape;
  return structuredClone({
    id: layer.id,
    groupId: layer.groupId,
    offset: layer.offset,
    bounds: [shape.x0, shape.y0, shape.x1, shape.y1],
    vertices: shape.vertices,
    sides: shape.sides,
    anchor: shape.anchor,
    rotation: shape.rotation,
    path: shapePathAt(layer.id, get(activeFrameIndex)),
  });
}

function option(select, value) {
  return [...select.options].find((candidate) => candidate.value === value);
}

async function selectValue(select, value) {
  await fireEvent.change(select, { target: { value } });
  await waitFor(() => expect(polygonLayer().shape.detail === value ||
    polygonLayer().shape.style === value).toBe(true));
}

beforeEach(() => {
  activeChar.set('█');
  activeTool.set('polygon');
  playing.set(false);
  dirty.set(false);
  toolOptions.set(structuredClone(BASE_TOOL_OPTIONS));
});

afterEach(() => {
  cleanup();
  playing.set(false);
});

describe('mounted polygon detail editing', () => {
  test.each([3, 5, 8])(
    '%s sides keeps selected detail reversible and separate from New polygon defaults',
    async (sides) => {
      mountPolygon(sides);
      await tick();

      const detail = screen.getByRole('combobox', { name: 'Detail' });
      const style = screen.getByRole('combobox', { name: 'Style' });
      const initialGeometry = stablePolygonState();
      const initialCells = structuredClone(polygonLayer().cells);
      const initialDefault = structuredClone(get(toolOptions).polygon);
      expect(option(detail, 'cell').disabled).toBe(false);
      expect(screen.queryByRole('combobox', { name: 'Channel' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'background' })).toBeNull();

      await selectValue(detail, 'half');
      const halfCells = structuredClone(polygonLayer().cells);
      expect(polygonLayer().shape).toMatchObject({
        style: 'outline',
        detail: 'half',
        glyphDetail: 'half',
      });
      expect(halfCells).not.toEqual(initialCells);
      expect(stablePolygonState()).toEqual(initialGeometry);
      expect(get(toolOptions).polygon).toEqual(initialDefault);
      expect(option(detail, 'cell').disabled).toBe(false);

      undo();
      await waitFor(() => expect(polygonLayer().shape.detail).toBe('cell'));
      expect(polygonLayer().cells).toEqual(initialCells);
      expect(get(canUndo)).toBe(false);
      redo();
      await waitFor(() => expect(polygonLayer().shape.detail).toBe('half'));
      expect(polygonLayer().cells).toEqual(halfCells);

      await selectValue(detail, 'quarter');
      const quarterCells = structuredClone(polygonLayer().cells);
      expect(quarterCells).not.toEqual(halfCells);
      expect(stablePolygonState()).toEqual(initialGeometry);
      expect(option(detail, 'cell').disabled).toBe(false);

      await selectValue(detail, 'cell');
      expect(polygonLayer().cells).toEqual(initialCells);
      expect(stablePolygonState()).toEqual(initialGeometry);

      await selectValue(detail, 'half');
      const outlineHalfCells = structuredClone(polygonLayer().cells);
      await selectValue(style, 'filled');
      expect(polygonLayer().shape.detail).toBe('half');
      expect(polygonLayer().cells).not.toEqual(outlineHalfCells);
      await selectValue(style, 'outline');
      expect(polygonLayer().shape.detail).toBe('half');
      expect(polygonLayer().cells).toEqual(outlineHalfCells);
      expect(option(detail, 'cell').disabled).toBe(false);
      expect(stablePolygonState()).toEqual(initialGeometry);

      await fireEvent.click(screen.getByRole('button', { name: 'Half-cell' }));
      expect(get(toolOptions).polygon.detail).toBe('half');
      await fireEvent.click(screen.getByRole('button', { name: 'Quarter-cell' }));
      expect(get(toolOptions).polygon.detail).toBe('quarter');
      await fireEvent.click(screen.getByRole('button', { name: 'Active glyph' }));
      expect(get(toolOptions).polygon.detail).toBe('cell');
      await fireEvent.click(screen.getByRole('button', { name: 'filled' }));
      expect(get(toolOptions).polygon).toMatchObject({ style: 'filled', detail: 'cell' });
      await fireEvent.click(screen.getByRole('button', { name: 'outline' }));
      expect(get(toolOptions).polygon).toMatchObject({ style: 'outline', detail: 'cell' });
      expect(polygonLayer().shape.detail).toBe('half');
      expect(polygonLayer().cells).toEqual(outlineHalfCells);
    },
  );
});

describe('mounted effect intensity animation', () => {
  test('exposes pressed identity and disables the complete intensity track', async () => {
    const effectLayer = {
      id: EFFECT_ID,
      name: 'Animated effect',
      type: 'effect',
      visible: true,
      cells: {},
      effect: { kind: 'brightness', intensity: 0.25 },
    };
    loadCanonicalTimeline({
      fps: 24,
      tracks: [{ id: EFFECT_TRACK_ID, kind: 'visual', locked: false, layer: effectLayer }],
      clips: [{
        id: EFFECT_CLIP_ID,
        trackId: EFFECT_TRACK_ID,
        kind: 'visual',
        startTick: 0,
        inTick: 0,
        outTick: 3,
        sourceDuration: 3,
        frameKeys: [{ tick: 0, value: { cells: {} } }],
        propertyTracks: {
          effectIntensity: [
            { tick: 0, value: 0.25 },
            { tick: 2, value: 0.75 },
          ],
        },
      }],
    });
    resetEditorStateForProjectLoad();
    selectLayer(EFFECT_ID);
    render(LayerPropertiesPanel);
    await tick();

    const enabled = screen.getByRole('button', { name: 'Disable intensity animation' });
    expect(enabled.getAttribute('aria-pressed')).toBe('true');
    expect(effectIntensityKeys(EFFECT_ID).map((key) => key.frame)).toEqual([0, 2]);

    await fireEvent.click(enabled);
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Animate intensity' }).getAttribute('aria-pressed'),
    ).toBe('false'));
    expect(isEffectIntensityTrackEnabled(EFFECT_ID)).toBe(false);
    expect(effectIntensityKeys(EFFECT_ID)).toEqual([]);
    expect(get(layers).find((layer) => layer.id === EFFECT_ID).effect.intensity).toBe(0.25);
  });
});
