export function documentName(value: unknown): string {
  const name = String(value || '').trim();
  return name || 'untitled';
}

export function documentLabel(
  name: unknown,
  dirty: boolean,
  width: number,
  height: number,
): string {
  const mark = dirty ? '* ' : '';
  return `${mark}${documentName(name)} · ${width}×${height} cells`;
}

export function documentTitle(name: unknown, dirty: boolean): string {
  const mark = dirty ? '* ' : '';
  return `${mark}${documentName(name)} — paintty`;
}
