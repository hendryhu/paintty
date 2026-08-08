export function firstGrapheme(value) {
  const text = String(value ?? '').replace(/[\r\n]/g, '');
  if (!text) return '';
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return segmenter.segment(text)[Symbol.iterator]().next().value?.segment || '';
  }
  return Array.from(text)[0] || '';
}
