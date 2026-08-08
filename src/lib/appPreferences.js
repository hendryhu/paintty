import { writable } from 'svelte/store';

export const COLOR_DEPTH_STORAGE_KEY = 'paintty.color-depth';
export const DEFAULT_COLOR_DEPTH = 'truecolor';

function browserStorage() {
  if (typeof globalThis.document === 'undefined') return null;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function normalizeColorDepth(value) {
  return value === '256' ? '256' : DEFAULT_COLOR_DEPTH;
}

export function loadColorDepthPreference(storage = browserStorage()) {
  try {
    return normalizeColorDepth(storage?.getItem?.(COLOR_DEPTH_STORAGE_KEY));
  } catch {
    return DEFAULT_COLOR_DEPTH;
  }
}

export function persistColorDepthPreference(value, storage = browserStorage()) {
  const depth = normalizeColorDepth(value);
  try {
    storage?.setItem?.(COLOR_DEPTH_STORAGE_KEY, depth);
  } catch {}
  return depth;
}

export function createColorDepthPreference(storage = browserStorage()) {
  const preference = writable(loadColorDepthPreference(storage));
  return {
    subscribe: preference.subscribe,
    set(value) {
      preference.set(persistColorDepthPreference(value, storage));
    },
    update(updater) {
      preference.update((value) => persistColorDepthPreference(updater(value), storage));
    },
  };
}
