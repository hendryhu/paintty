import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { tick } from 'svelte';
import LayersPanel from '../src/components/LayersPanel.svelte';
import MenuBar from '../src/components/MenuBar.svelte';
import TimelineV2 from '../src/components/TimelineV2.svelte';
import {
  activeLayerId,
  authoredRevision,
  canUndo,
  layers,
  removeLayers,
  selectLayer,
  selectedLayerIds,
  setLayers,
  undo,
} from '../src/lib/grid.js';
import { playing } from '../src/lib/frames.js';
import {
  advanceProjectRevision,
  notifyProjectReplaced,
} from '../src/lib/documentLifecycle.js';
import { dirty } from '../src/lib/stores.js';
import { notifications } from '../src/lib/notifications.js';
import {
  keyboardContextOwns,
  resetKeyboardContext,
  setKeyboardContext,
} from '../src/lib/timelineKeys.js';

function canvasContext() {
  return {
    clearRect: vi.fn(),
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    putImageData: vi.fn(),
  };
}

function row(name) {
  return screen.getByText(name).closest('[data-layer-id]');
}

function layerNames() {
  return get(layers).map((layer) => layer.name);
}

function contextTarget(name, context = null) {
  const target = document.createElement('button');
  target.type = 'button';
  target.textContent = name;
  target.dataset.layerDeletionTestTarget = '';
  if (context) target.setAttribute('data-keyboard-context', context);
  document.body.append(target);
  return target;
}

async function activeRenameInput(name) {
  await fireEvent.keyDown(window, { key: 'F2' });
  const input = await screen.findByDisplayValue(name);
  input.focus();
  input.select();
  return input;
}

async function closeLayerMenu() {
  await fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
}

beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(canvasContext);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(async () => {
  playing.set(false);
  dirty.set(false);
  notifications.set([]);
  resetKeyboardContext();
  setLayers([
    { name: 'Alpha', type: 'cell', cells: {} },
    { name: 'Beta', type: 'cell', cells: {} },
    { name: 'Gamma', type: 'cell', cells: {} },
    { name: 'Delta', type: 'cell', cells: {} },
  ]);
  render(LayersPanel);
  await tick();
});

afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-layer-deletion-test-target]').forEach((node) => node.remove());
  playing.set(false);
  notifications.set([]);
  resetKeyboardContext();
});

describe('mounted layer deletion', () => {
  test('startup keeps layer authoring disabled until recovery is ready', async () => {
    cleanup();
    const mounted = render(LayersPanel, { props: { disabled: true } });
    await tick();

    expect(screen.getByTitle('Add layer').disabled).toBe(true);
    expect(screen.getByTitle('New group').disabled).toBe(true);

    await mounted.rerender({ disabled: false });
    expect(screen.getByTitle('Add layer').disabled).toBe(false);
    expect(screen.getByTitle('New group').disabled).toBe(false);
  });

  test('finds exact singular, two-layer, and three-layer context labels semantically', async () => {
    await fireEvent.click(row('Alpha'));
    await fireEvent.contextMenu(row('Alpha'), { clientX: 20, clientY: 20 });
    expect(screen.getByRole('menuitem', { name: 'Delete layer' })).not.toBeNull();
    await closeLayerMenu();

    await fireEvent.click(row('Beta'), { ctrlKey: true });
    await fireEvent.contextMenu(row('Alpha'), { clientX: 20, clientY: 20 });
    expect(screen.getByRole('menuitem', { name: 'Delete 2 layers' })).not.toBeNull();
    await closeLayerMenu();

    await fireEvent.click(row('Alpha'));
    await fireEvent.click(row('Gamma'), { shiftKey: true });
    await fireEvent.contextMenu(row('Beta'), { clientX: 20, clientY: 20 });
    expect(screen.getByRole('menuitem', { name: 'Delete 3 layers' })).not.toBeNull();
    expect([...get(selectedLayerIds)]).toEqual(get(layers).slice(0, 3).map((layer) => layer.id));
  });

  test('retargets an unselected context row and deletes only that row', async () => {
    await fireEvent.click(row('Alpha'));
    await fireEvent.click(row('Gamma'), { ctrlKey: true });
    await fireEvent.contextMenu(row('Delta'), { clientX: 20, clientY: 20 });

    expect(screen.getByRole('menuitem', { name: 'Delete layer' })).not.toBeNull();
    expect([...get(selectedLayerIds)]).toEqual([get(layers)[3].id]);
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete layer' }));
    expect(layerNames()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  test('the plural context action deletes the frozen selected set', async () => {
    await fireEvent.click(row('Alpha'));
    await fireEvent.click(row('Gamma'), { ctrlKey: true });
    await fireEvent.contextMenu(row('Alpha'), { clientX: 20, clientY: 20 });

    await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete 2 layers' }));
    expect(layerNames()).toEqual(['Beta', 'Delta']);
    undo();
    await waitFor(() => expect(layerNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']));
    expect([...get(selectedLayerIds)]).toEqual([get(layers)[0].id, get(layers)[2].id]);
  });

  test('a group menu advertises and deletes its frozen eleven-row closure in one Undo', async () => {
    const group = {
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Bundle',
      type: 'group',
      collapsed: false,
      cells: {},
    };
    setLayers([
      group,
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `10000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
        name: `Bundled ${index + 1}`,
        type: 'cell',
        groupId: group.id,
        cells: {},
      })),
      {
        id: '10000000-0000-4000-8000-000000000012',
        name: 'Survivor',
        type: 'cell',
        cells: {},
      },
    ]);
    await tick();
    const authored = structuredClone(get(layers));
    const groupId = get(layers)[0].id;
    const survivorId = get(layers).at(-1).id;

    await fireEvent.click(row('Bundle'));
    await fireEvent.contextMenu(row('Bundle'), { clientX: 20, clientY: 20 });
    const action = screen.getByRole('menuitem', { name: 'Delete 11 layers' });

    selectLayer(survivorId);
    expect(get(activeLayerId)).toBe(survivorId);
    await fireEvent.click(action);
    expect(get(layers).map((layer) => layer.id)).toEqual([survivorId]);
    expect(get(canUndo)).toBe(true);

    undo();
    await waitFor(() => expect(get(layers)).toEqual(authored));
    expect(get(layers)[0].id).toBe(groupId);
    expect(get(canUndo)).toBe(false);
  });

  test('suppresses Delete while the menu is open and preserves the selected set after Escape', async () => {
    await fireEvent.click(row('Alpha'));
    await fireEvent.click(row('Beta'), { ctrlKey: true });
    await fireEvent.contextMenu(row('Beta'), { clientX: 20, clientY: 20 });
    expect(screen.getByRole('menuitem', { name: 'Delete 2 layers' })).not.toBeNull();

    await fireEvent.keyDown(window, { key: 'Delete' });
    expect(layerNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
    await closeLayerMenu();
    await fireEvent.keyDown(window, { key: 'Backspace' });
    expect(layerNames()).toEqual(['Gamma', 'Delta']);

    undo();
    await waitFor(() => expect(layerNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']));
    expect([...get(selectedLayerIds)]).toEqual(get(layers).slice(0, 2).map((layer) => layer.id));
  });

  test.each(['Delete', 'Backspace'])('%s deletes the Ctrl-selected set from explicit layer context', async (key) => {
    await fireEvent.click(row('Alpha'));
    await fireEvent.click(row('Gamma'), { ctrlKey: true });
    await fireEvent.keyDown(window, { key });

    expect(layerNames()).toEqual(['Beta', 'Delta']);
    expect(get(canUndo)).toBe(true);
    undo();
    await waitFor(() => expect(layerNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']));
    expect([...get(selectedLayerIds)]).toEqual([get(layers)[0].id, get(layers)[2].id]);
  });

  test('Ctrl+D collapses a multi-layer selection to the active layer without authored state', async () => {
    await fireEvent.click(row('Alpha'));
    await fireEvent.click(row('Beta'), { ctrlKey: true });
    await fireEvent.click(row('Gamma'), { ctrlKey: true });
    const active = get(activeLayerId);
    const revision = get(authoredRevision);

    await fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    expect([...get(selectedLayerIds)]).toEqual([active]);
    expect(get(activeLayerId)).toBe(active);
    expect(row('Gamma').classList.contains('active')).toBe(true);
    expect(row('Gamma').classList.contains('selected')).toBe(true);
    expect(document.querySelectorAll('.layer.selected')).toHaveLength(1);
    expect(get(authoredRevision)).toBe(revision);
    expect(get(canUndo)).toBe(false);
    expect(get(dirty)).toBe(false);
    expect(get(notifications)).toEqual([]);

    await fireEvent.keyDown(window, { key: 'Delete' });
    expect(layerNames()).toEqual(['Alpha', 'Beta', 'Delta']);
  });

  test('Ctrl+D on the sole active layer reports one non-authored clear', async () => {
    await fireEvent.click(row('Beta'));
    const active = get(activeLayerId);
    const revision = get(authoredRevision);

    await fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    await fireEvent.keyDown(window, { key: 'd', ctrlKey: true });

    expect([...get(selectedLayerIds)]).toEqual([active]);
    expect(row('Beta').classList.contains('active')).toBe(true);
    expect(row('Beta').classList.contains('selected')).toBe(true);
    expect(get(notifications)).toEqual([expect.objectContaining({
      message: 'Selection cleared.',
      tone: 'info',
    })]);
    expect(get(authoredRevision)).toBe(revision);
    expect(get(canUndo)).toBe(false);
    expect(get(dirty)).toBe(false);
  });

  test('context menu and rename typing suppress Ctrl+D, then Escape-close restores Layers ownership', async () => {
    await fireEvent.click(row('Alpha'));
    await fireEvent.click(row('Beta'), { ctrlKey: true });
    await fireEvent.contextMenu(row('Beta'), { clientX: 20, clientY: 20 });

    await fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    expect([...get(selectedLayerIds)]).toEqual(get(layers).slice(0, 2).map((layer) => layer.id));
    await closeLayerMenu();
    await fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    expect([...get(selectedLayerIds)]).toEqual([get(activeLayerId)]);

    await fireEvent.click(row('Gamma'));
    await fireEvent.keyDown(window, { key: 'F2' });
    const input = await screen.findByDisplayValue('Gamma');
    await fireEvent.keyDown(input, { key: 'd', ctrlKey: true });
    expect([...get(selectedLayerIds)]).toEqual([get(activeLayerId)]);
  });

  test.each([
    ['one selected layer', 'Delete', ['Beta'], 'Beta'],
    ['multiple selected layers', 'Backspace', ['Alpha', 'Gamma'], 'Gamma'],
  ])('Enter restores Layers context for %s before immediate %s', async (_label, key, selectedNames, editedName) => {
    await fireEvent.click(row(selectedNames[0]));
    for (const name of selectedNames.slice(1)) {
      await fireEvent.click(row(name), { ctrlKey: true });
    }
    const selected = [...get(selectedLayerIds)];
    const active = get(activeLayerId);
    const revision = get(authoredRevision);
    const renamed = `${editedName} renamed`;
    const input = await activeRenameInput(editedName);

    await fireEvent.input(input, { target: { value: renamed } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(document.activeElement).toBe(row(renamed)));
    expect(keyboardContextOwns('layers', { target: document.activeElement })).toBe(true);
    expect([...get(selectedLayerIds)]).toEqual(selected);
    expect(get(activeLayerId)).toBe(active);
    expect(get(authoredRevision)).toBe(revision + 1);

    await fireEvent.keyDown(document.activeElement, { key });
    expect(layerNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']
      .filter((name) => !selectedNames.includes(name)));
    expect(get(authoredRevision)).toBe(revision + 2);

    undo();
    await waitFor(() => expect(layerNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']
      .map((name) => name === editedName ? renamed : name)));
    expect([...get(selectedLayerIds)]).toEqual(selected);
    expect(get(activeLayerId)).toBe(active);
    expect(get(canUndo)).toBe(true);

    undo();
    await waitFor(() => expect(layerNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']));
    expect(get(canUndo)).toBe(false);
  });

  test('Escape cancels rename, restores the edited row, and leaves no rename history entry', async () => {
    await fireEvent.click(row('Alpha'));
    await fireEvent.click(row('Gamma'), { ctrlKey: true });
    const selected = [...get(selectedLayerIds)];
    const active = get(activeLayerId);
    const revision = get(authoredRevision);
    const input = await activeRenameInput('Gamma');

    await fireEvent.input(input, { target: { value: 'Discarded name' } });
    await fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(document.activeElement).toBe(row('Gamma')));
    expect(keyboardContextOwns('layers', { target: document.activeElement })).toBe(true);
    expect(layerNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
    expect([...get(selectedLayerIds)]).toEqual(selected);
    expect(get(activeLayerId)).toBe(active);
    expect(get(authoredRevision)).toBe(revision);
    expect(get(canUndo)).toBe(false);

    await fireEvent.keyDown(document.activeElement, { key: 'Delete' });
    expect(layerNames()).toEqual(['Beta', 'Delta']);
    undo();
    await waitFor(() => expect(layerNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']));
    expect(get(canUndo)).toBe(false);
  });

  test('blur commit to Canvas preserves Canvas focus and context as one rename operation', async () => {
    const canvas = contextTarget('Mounted canvas destination', 'canvas');
    await fireEvent.click(row('Alpha'));
    const revision = get(authoredRevision);
    const input = await activeRenameInput('Alpha');
    await fireEvent.input(input, { target: { value: 'Canvas rename' } });

    await fireEvent.pointerDown(canvas);
    canvas.focus();

    await waitFor(() => expect(layerNames()[0]).toBe('Canvas rename'));
    expect(document.activeElement).toBe(canvas);
    expect(keyboardContextOwns('canvas', { target: canvas })).toBe(true);
    expect(keyboardContextOwns('layers', { target: canvas })).toBe(false);
    expect(get(authoredRevision)).toBe(revision + 1);

    await fireEvent.keyDown(canvas, { key: 'Delete' });
    expect(layerNames()).toHaveLength(4);
    undo();
    await waitFor(() => expect(layerNames()[0]).toBe('Alpha'));
    expect(get(canUndo)).toBe(false);
  });

  test.each([
    ['Timeline', 'timeline'],
    ['popup', null],
  ])('blur commit to %s does not restore the edited layer row', async (name, context) => {
    const destination = contextTarget(`Mounted ${name} destination`, context);
    await fireEvent.click(row('Beta'));
    const input = await activeRenameInput('Beta');
    await fireEvent.input(input, { target: { value: `${name} rename` } });

    await fireEvent.pointerDown(destination);
    destination.focus();

    await waitFor(() => expect(layerNames()[1]).toBe(`${name} rename`));
    expect(document.activeElement).toBe(destination);
    expect(keyboardContextOwns('layers', { target: destination })).toBe(false);
    if (context) expect(keyboardContextOwns(context, { target: destination })).toBe(true);
    undo();
    await waitFor(() => expect(layerNames()[1]).toBe('Beta'));
    expect(get(canUndo)).toBe(false);
  });

  test('project replacement abandons an in-progress rename without mutating the replacement', async () => {
    await fireEvent.click(row('Beta'));
    const id = get(activeLayerId);
    const revision = get(authoredRevision);
    const input = await activeRenameInput('Beta');
    await fireEvent.input(input, { target: { value: 'Stale pending name' } });

    const replacementRevision = advanceProjectRevision();
    setLayers([{ id, name: 'Replacement layer', type: 'cell', cells: {} }]);
    notifyProjectReplaced({ revision: replacementRevision });
    await waitFor(() => expect(screen.queryByDisplayValue('Stale pending name')).toBeNull());

    expect(layerNames()).toEqual(['Replacement layer']);
    expect(keyboardContextOwns('layers', {})).toBe(false);
    expect(get(authoredRevision)).toBe(revision);
    expect(get(canUndo)).toBe(false);
    expect(get(dirty)).toBe(false);
  });

  test('deleting the edited layer abandons rename without a second history operation', async () => {
    await fireEvent.click(row('Alpha'));
    const id = get(activeLayerId);
    const revision = get(authoredRevision);
    const input = await activeRenameInput('Alpha');
    await fireEvent.input(input, { target: { value: 'Deleted pending name' } });

    removeLayers([id]);
    await tick();

    expect(layerNames()).toEqual(['Beta', 'Gamma', 'Delta']);
    expect(screen.queryByDisplayValue('Deleted pending name')).toBeNull();
    expect(get(authoredRevision)).toBe(revision + 1);
    expect(get(canUndo)).toBe(true);
    undo();
    await waitFor(() => expect(layerNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']));
    expect(get(canUndo)).toBe(false);
  });

  test('Delete removes a Shift-selected range as one layer operation', async () => {
    await fireEvent.click(row('Alpha'));
    await fireEvent.click(row('Gamma'), { shiftKey: true });
    await fireEvent.keyDown(window, { key: 'Delete' });

    expect(layerNames()).toEqual(['Delta']);
    undo();
    await waitFor(() => expect(layerNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']));
    expect([...get(selectedLayerIds)]).toEqual(get(layers).slice(0, 3).map((layer) => layer.id));
  });

  test.each([
    ['one selected layer', ['Alpha'], 'Delete', ['Beta', 'Gamma', 'Delta']],
    ['multiple selected layers', ['Alpha', 'Gamma'], 'Backspace', ['Beta', 'Delta']],
  ])('neutral controls preserve Layers deletion ownership for %s', async (
    _label, selectedNames, key, remaining,
  ) => {
    render(MenuBar);
    render(TimelineV2, { expanded: false });
    await tick();
    await fireEvent.click(row(selectedNames[0]));
    for (const name of selectedNames.slice(1)) {
      await fireEvent.click(row(name), { ctrlKey: true });
    }

    const controls = [
      screen.getByTitle('Toggle color depth'),
      screen.getByRole('button', { name: /^Loop / }),
      screen.getByRole('button', { name: /^Onion:/ }),
      screen.getByRole('button', { name: /frame thumbnails/ }),
      screen.getByRole('button', { name: 'Zoom out' }),
      screen.getByRole('slider', { name: 'Timeline zoom' }),
      screen.getByRole('button', { name: 'Zoom in' }),
    ];
    let pointerId = 500;
    for (const control of controls) {
      await fireEvent.pointerDown(control, { button: 0, pointerId: pointerId++ });
      if (control.type === 'range') {
        await fireEvent.input(control, { target: { value: '19' } });
      } else {
        await fireEvent.click(control);
      }
      expect(keyboardContextOwns('layers', { target: control })).toBe(true);
    }

    await fireEvent.keyDown(controls.at(-2), { key });
    expect(layerNames()).toEqual(remaining);
  });

  test('transport preserves Layers ownership while playback blocks deletion', async () => {
    render(TimelineV2, { expanded: false });
    await tick();
    await fireEvent.click(row('Alpha'));
    await fireEvent.click(row('Gamma'), { ctrlKey: true });

    let transport = screen.getByRole('button', { name: 'Play' });
    await fireEvent.pointerDown(transport, { button: 0, pointerId: 600 });
    await fireEvent.click(transport);
    expect(get(playing)).toBe(true);
    expect(keyboardContextOwns('layers', { target: transport })).toBe(true);
    await fireEvent.keyDown(transport, { key: 'Delete' });
    expect(layerNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);

    transport = screen.getByRole('button', { name: 'Stop (K)' });
    await fireEvent.pointerDown(transport, { button: 0, pointerId: 601 });
    await fireEvent.click(transport);
    expect(get(playing)).toBe(false);
    expect(keyboardContextOwns('layers', { target: transport })).toBe(true);
    await fireEvent.keyDown(transport, { key: 'Backspace' });
    expect(layerNames()).toEqual(['Beta', 'Delta']);
  });

  test('Canvas, Timeline, text input, playback, and project replacement suppress stale layer deletion', async () => {
    const canvas = document.createElement('div');
    const timeline = document.createElement('div');
    const input = document.createElement('input');
    canvas.dataset.layerDeletionTestTarget = '';
    canvas.setAttribute('data-keyboard-context', 'canvas');
    timeline.dataset.layerDeletionTestTarget = '';
    input.dataset.layerDeletionTestTarget = '';
    timeline.setAttribute('data-keyboard-context', 'timeline');
    document.body.append(canvas, timeline, input);

    await fireEvent.click(row('Alpha'));
    await fireEvent.pointerDown(canvas);
    expect(keyboardContextOwns('canvas', {})).toBe(true);
    await fireEvent.keyDown(window, { key: 'Delete' });
    expect(layerNames()).toHaveLength(4);

    await fireEvent.click(row('Alpha'));
    await fireEvent.pointerDown(timeline);
    expect(keyboardContextOwns('timeline', {})).toBe(true);
    await fireEvent.keyDown(window, { key: 'Backspace' });
    expect(layerNames()).toHaveLength(4);

    await fireEvent.click(row('Alpha'));
    await fireEvent.pointerDown(input);
    await fireEvent.keyDown(input, { key: 'Delete' });
    expect(layerNames()).toHaveLength(4);

    await fireEvent.click(row('Alpha'));
    playing.set(true);
    await fireEvent.keyDown(window, { key: 'Delete' });
    expect(layerNames()).toHaveLength(4);
    playing.set(false);

    const alpha = row('Alpha');
    await fireEvent.click(alpha);
    alpha.focus();
    notifyProjectReplaced({ revision: 1 });
    expect(keyboardContextOwns('layers', { target: alpha })).toBe(false);
    await fireEvent.keyDown(alpha, { key: 'Delete' });
    expect(layerNames()).toHaveLength(4);
    expect(keyboardContextOwns('layers', { target: alpha })).toBe(false);

  });

  test('an explicit empty layer context is a no-op', async () => {
    setLayers([]);
    setKeyboardContext('layers');
    await fireEvent.keyDown(window, { key: 'Delete' });
    expect(get(layers)).toEqual([]);
    expect(get(activeLayerId)).toBeNull();
    expect(get(canUndo)).toBe(false);
  });
});
