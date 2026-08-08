import { writable } from 'svelte/store';
import { assertUuid, newUuid } from './uuid.js';

export const projectId = writable(newUuid('project'));

export function replaceProjectId(value) {
  projectId.set(assertUuid(value, 'Project ID'));
}
