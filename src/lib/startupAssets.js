import { writable } from 'svelte/store';
import { loadDefaultNerdFont } from './font.js';
import { loadNerdGlyphs } from './nerdglyphs.js';
import { buildCandidatesAsync, resetSketchCandidates } from './sketchMatch.js';

const TASKS = [
  { id: 'font', label: 'Nerd Font' },
  { id: 'glyphs', label: 'Glyph catalog' },
  { id: 'sketch', label: 'Sketch index' },
];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function initialState() {
  return {
    status: 'idle',
    tasks: TASKS.map((task) => ({ ...task, status: 'pending', error: '' })),
  };
}

export function startupProgressState(recoveryReady, assets) {
  const tasks = [
    {
      id: 'recovery',
      label: 'Session recovery',
      status: recoveryReady ? 'ready' : 'loading',
      error: '',
    },
    ...assets.tasks,
  ];
  return {
    tasks,
    readyCount: tasks.filter((task) => task.status === 'ready').length,
    visible: !recoveryReady || assets.status === 'loading',
  };
}

export function createStartupAssetsController({
  loadFont = loadDefaultNerdFont,
  loadGlyphs = loadNerdGlyphs,
  buildSketchIndex = buildCandidatesAsync,
  resetSketchIndex = resetSketchCandidates,
} = {}) {
  let value = initialState();
  let started = false;
  let currentRun = null;
  const store = writable(value);

  function publish(tasks) {
    const unfinished = tasks.some((task) => task.status === 'pending' || task.status === 'loading');
    const failed = tasks.some((task) => task.status === 'failed');
    value = {
      status: unfinished ? 'loading' : failed ? 'failed' : 'ready',
      tasks,
    };
    store.set(value);
  }

  function patchTask(id, patch) {
    publish(value.tasks.map((task) => task.id === id ? { ...task, ...patch } : task));
  }

  async function runTask(id, loader) {
    patchTask(id, { status: 'loading', error: '' });
    try {
      await loader();
      patchTask(id, { status: 'ready', error: '' });
    } catch (error) {
      patchTask(id, { status: 'failed', error: errorMessage(error) });
    }
  }

  function launch({ font, glyphs, sketch }) {
    const resetIds = new Set([
      ...(font ? ['font'] : []),
      ...(glyphs ? ['glyphs'] : []),
      ...(sketch ? ['sketch'] : []),
    ]);
    publish(value.tasks.map((task) => resetIds.has(task.id)
      ? { ...task, status: 'pending', error: '' }
      : task));

    let canBuildSketch = sketch;
    if (sketch) {
      try {
        resetSketchIndex();
      } catch (error) {
        canBuildSketch = false;
        patchTask('sketch', { status: 'failed', error: errorMessage(error) });
      }
    }

    const execution = (async () => {
      const prerequisites = [];
      if (font) prerequisites.push(runTask('font', loadFont));
      if (glyphs) prerequisites.push(runTask('glyphs', loadGlyphs));
      await Promise.all(prerequisites);
      if (canBuildSketch) await runTask('sketch', buildSketchIndex);
      return value;
    })();

    currentRun = execution.finally(() => {
      currentRun = null;
    });
    return currentRun;
  }

  function start() {
    if (currentRun) return currentRun;
    if (started) return Promise.resolve(value);
    started = true;
    return launch({ font: true, glyphs: true, sketch: true });
  }

  function retry() {
    if (currentRun) return currentRun;
    const failed = new Set(value.tasks
      .filter((task) => task.status === 'failed')
      .map((task) => task.id));
    if (!failed.size) return Promise.resolve(value);
    const font = failed.has('font');
    const glyphs = failed.has('glyphs');
    return launch({
      font,
      glyphs,
      sketch: failed.has('sketch') || font || glyphs,
    });
  }

  return {
    subscribe: store.subscribe,
    start,
    retry,
  };
}

export const startupAssets = createStartupAssetsController();

export function startStartupAssets() {
  return startupAssets.start();
}

export function retryStartupAssets() {
  return startupAssets.retry();
}
