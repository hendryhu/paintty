import { get } from 'svelte/store';
import {
  beginStroke,
  cancelStroke,
  dims,
  endStroke,
  resizeCanvas,
} from './grid.js';
import { fps, playing, setFps } from './frames.js';
import { validateProjectDraft } from './projectPresets.js';

export function applyProjectSettings(draftValue) {
  if (get(playing)) return false;
  const draft = validateProjectDraft(draftValue);
  const size = get(dims);
  if (size.w === draft.columns && size.h === draft.rows && get(fps) === draft.baseFps) {
    return false;
  }
  if (beginStroke() !== true) return false;
  try {
    resizeCanvas(draft.columns, draft.rows);
    setFps(draft.baseFps);
    return endStroke();
  } catch (error) {
    cancelStroke();
    throw error;
  }
}
