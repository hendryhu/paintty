export function documentName(value) {
  const name = String(value || '').trim();
  return name || 'untitled';
}

export function documentLabel(name, dirty, width, height) {
  const mark = dirty ? '* ' : '';
  return `${mark}${documentName(name)} · ${width}×${height} cells`;
}

export function documentTitle(name, dirty) {
  const mark = dirty ? '* ' : '';
  return `${mark}${documentName(name)} — paintty`;
}
