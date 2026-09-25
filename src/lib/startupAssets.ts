import { writable } from 'svelte/store';
import { loadDefaultNerdFont } from './font.js';
import { loadNerdGlyphs } from './nerdglyphs.js';
import { buildCandidatesAsync, resetSketchCandidates } from './sketchMatch.js';

type StartupTaskId = 'font' | 'glyphs' | 'sketch';
type StartupTaskStatus = 'pending' | 'loading' | 'ready' | 'failed';

export interface StartupTask {
  id: StartupTaskId;
  label: string;
  status: StartupTaskStatus;
  error: string;
}

export interface StartupAssetsState {
  status: 'idle' | 'loading' | 'ready' | 'failed';
  tasks: StartupTask[];
}

interface StartupProgressTask {
  id: StartupTaskId | 'recovery';
  label: string;
  status: StartupTaskStatus;
  error: string;
}

interface StartupProgress {
  tasks: StartupProgressTask[];
  readyCount: number;
  visible: boolean;
}

type StartupLoader = () => unknown | Promise<unknown>;

interface StartupControllerOptions {
  loadFont?: StartupLoader;
  loadGlyphs?: StartupLoader;
  buildSketchIndex?: StartupLoader;
  resetSketchIndex?: () => void;
}

interface LaunchSelection {
  font: boolean;
  glyphs: boolean;
  sketch: boolean;
}

const TASKS: ReadonlyArray<Pick<StartupTask, 'id' | 'label'>> = [
  { id: 'font', label: 'Nerd Font' },
  { id: 'glyphs', label: 'Glyph catalog' },
  { id: 'sketch', label: 'Sketch index' },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialState(): StartupAssetsState {
  return {
    status: 'idle',
    tasks: TASKS.map((task) => ({ ...task, status: 'pending', error: '' })),
  };
}

export function startupProgressState(
  recoveryReady: boolean,
  assets: StartupAssetsState,
): StartupProgress {
  const tasks: StartupProgressTask[] = [
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
}: StartupControllerOptions = {}) {
  let value = initialState();
  let started = false;
  let currentRun: Promise<StartupAssetsState> | null = null;
  const store = writable(value);

  function publish(tasks: StartupTask[]): void {
    const unfinished = tasks.some((task) => task.status === 'pending' || task.status === 'loading');
    const failed = tasks.some((task) => task.status === 'failed');
    value = {
      status: unfinished ? 'loading' : failed ? 'failed' : 'ready',
      tasks,
    };
    store.set(value);
  }

  function patchTask(id: StartupTaskId, patch: Partial<Pick<StartupTask, 'status' | 'error'>>): void {
    publish(value.tasks.map((task) => task.id === id ? { ...task, ...patch } : task));
  }

  async function runTask(id: StartupTaskId, loader: StartupLoader): Promise<void> {
    patchTask(id, { status: 'loading', error: '' });
    try {
      await loader();
      patchTask(id, { status: 'ready', error: '' });
    } catch (error) {
      patchTask(id, { status: 'failed', error: errorMessage(error) });
    }
  }

  function launch({ font, glyphs, sketch }: LaunchSelection): Promise<StartupAssetsState> {
    const resetIds = new Set<StartupTaskId>();
    if (font) resetIds.add('font');
    if (glyphs) resetIds.add('glyphs');
    if (sketch) resetIds.add('sketch');
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
      const prerequisites: Promise<void>[] = [];
      if (font) prerequisites.push(runTask('font', loadFont));
      if (glyphs) prerequisites.push(runTask('glyphs', loadGlyphs));
      await Promise.all(prerequisites);
      if (canBuildSketch) await runTask('sketch', buildSketchIndex);
      return value;
    })();

    currentRun = execution.finally((): void => {
      currentRun = null;
    });
    return currentRun;
  }

  function start(): Promise<StartupAssetsState> {
    if (currentRun) return currentRun;
    if (started) return Promise.resolve(value);
    started = true;
    return launch({ font: true, glyphs: true, sketch: true });
  }

  function retry(): Promise<StartupAssetsState> {
    if (currentRun) return currentRun;
    const failed = new Set<StartupTaskId>(value.tasks
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
