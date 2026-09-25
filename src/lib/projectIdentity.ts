import { writable } from 'svelte/store';
import { assertUuid, newUuid } from './uuid.js';

export const projectId = writable<string>(newUuid('project'));

export function replaceProjectId(value: unknown): void {
  projectId.set(assertUuid(value, 'Project ID'));
}
