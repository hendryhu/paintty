import { get } from 'svelte/store';
import { loadJSON, serializeJSON } from './fileio.js';
import {
  notifyProjectCheckpoint,
  notifyProjectLoaded,
} from './documentLifecycle.js';
import { recentProjectIdentity } from './recentProjects.js';
import { dirty, fileName } from './stores.js';
import { createBlankProject } from './projectPresets.js';
import type {
  ProjectCheckpointDetail,
  ProjectLoadedDetail,
  UnknownRecord,
} from './types/project-types.js';

interface NewProjectLifecycleOptions {
  createProject?: (draft: unknown, options?: UnknownRecord) => unknown;
  serializeCurrent?: () => string;
  replaceProject?: (contents: string) => void;
  checkpoint?: (detail: ProjectCheckpointDetail) => void | Promise<void>;
  notifyLoaded?: (detail: ProjectLoadedDetail) => void;
  currentDirty?: boolean;
  currentName?: string;
  setFileName?: (value: string) => void;
  clearRecentIdentity?: () => void;
  createOptions?: UnknownRecord;
}

export async function replaceWithBlankProject(
  draft: unknown,
  options: NewProjectLifecycleOptions = {},
) {
  const createProject = options.createProject || createBlankProject;
  const serializeCurrent: () => string = options.serializeCurrent || (() => serializeJSON());
  const replaceProject = options.replaceProject || loadJSON;
  const checkpoint = options.checkpoint || notifyProjectCheckpoint;
  const notifyLoaded = options.notifyLoaded || notifyProjectLoaded;
  const currentDirty = options.currentDirty ?? get(dirty);
  const currentName = options.currentName ?? get(fileName);
  const setFileName = options.setFileName || ((value) => fileName.set(value));
  const clearRecentIdentity = options.clearRecentIdentity || (() => recentProjectIdentity.set(null));

  const project = createProject(draft, options.createOptions);
  const nextContents = JSON.stringify(project);
  if (currentDirty) {
    const previousContents = serializeCurrent();
    await checkpoint({ contents: previousContents, fileName: currentName });
  }

  replaceProject(nextContents);
  setFileName('untitled');
  clearRecentIdentity();
  const loadedContents = serializeCurrent();
  notifyLoaded({
    contents: loadedContents,
    fileName: 'untitled',
    recent: false,
  });
  return { project, contents: loadedContents };
}
