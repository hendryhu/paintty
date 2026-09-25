export function readThemeColor(property: string, element: Element | undefined = globalThis.document?.documentElement): string {
  if (!element || typeof globalThis.getComputedStyle !== 'function') return '';
  return globalThis.getComputedStyle(element).getPropertyValue(property).trim();
}

export function readThemeColors<const T extends Record<string, string>>(
  properties: T,
  element?: Element,
): { [K in keyof T]: string } {
  return Object.fromEntries(Object.entries(properties).map(([name, property]) =>
    [name, readThemeColor(property, element)])) as { [K in keyof T]: string };
}
