import { get, writable } from 'svelte/store';

export const playing = writable<boolean>(false);

export function authoredEditsAllowed(): boolean {
  return !get(playing);
}
