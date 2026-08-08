export function readThemeColor(property, element = globalThis.document?.documentElement) {
  if (!element || typeof globalThis.getComputedStyle !== 'function') return '';
  return globalThis.getComputedStyle(element).getPropertyValue(property).trim();
}

export function readThemeColors(properties, element) {
  return Object.fromEntries(Object.entries(properties).map(([name, property]) =>
    [name, readThemeColor(property, element)]));
}
