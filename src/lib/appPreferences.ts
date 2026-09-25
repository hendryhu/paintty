import { writable } from 'svelte/store';
import type { StorageLike } from './types/project-types.js';

export const COLOR_DEPTH_STORAGE_KEY = 'paintty.color-depth';
export const DEFAULT_COLOR_DEPTH = 'truecolor';
export type ColorDepth = 'truecolor' | '256';

function browserStorage(): StorageLike | null {
  if (typeof globalThis.document === 'undefined') return null;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function normalizeColorDepth(value: unknown): ColorDepth {
  return value === '256' ? '256' : DEFAULT_COLOR_DEPTH;
}

export function loadColorDepthPreference(
  storage: StorageLike | null = browserStorage(),
): ColorDepth {
  try {
    return normalizeColorDepth(storage?.getItem?.(COLOR_DEPTH_STORAGE_KEY));
  } catch {
    return DEFAULT_COLOR_DEPTH;
  }
}

export function persistColorDepthPreference(
  value: unknown,
  storage: StorageLike | null = browserStorage(),
): ColorDepth {
  const depth = normalizeColorDepth(value);
  try {
    storage?.setItem?.(COLOR_DEPTH_STORAGE_KEY, depth);
  } catch {}
  return depth;
}

export function createColorDepthPreference(storage: StorageLike | null = browserStorage()) {
  const preference = writable<ColorDepth>(loadColorDepthPreference(storage));
  return {
    subscribe: preference.subscribe,
    set(value: ColorDepth) {
      preference.set(persistColorDepthPreference(value, storage));
    },
    update(updater: (value: ColorDepth) => ColorDepth) {
      preference.update((value) => persistColorDepthPreference(updater(value), storage));
    },
  };
}
