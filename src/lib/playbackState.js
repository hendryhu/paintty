import { get, writable } from 'svelte/store';

export const playing = writable(false);

export function authoredEditsAllowed() {
  return !get(playing);
}
