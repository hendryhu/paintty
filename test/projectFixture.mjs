import assert from 'node:assert/strict';

export function deterministicUuidGenerator(first = 1) {
  const initial = Math.max(1, Math.floor(Number(first) || 1));
  const nextByKind = new Map();
  return (kind = 'item') => {
    const next = nextByKind.get(kind) || initial;
    nextByKind.set(kind, next + 1);
    return deterministicUuid(kind, next);
  };
}

export function deterministicUuid(kind, index) {
  const codes = {
    project: '00000000',
    layer: '01000000',
    track: '10000000',
    clip: '20000000',
    asset: '30000000',
  };
  const code = codes[kind] || '40000000';
  const tail = Math.max(1, Math.floor(Number(index) || 1)).toString(16).padStart(12, '0');
  return `${code}-0000-4000-8000-${tail}`;
}

export function sequentialUuidGenerator(first = 1) {
  let next = Math.max(1, Math.floor(Number(first) || 1));
  return () => deterministicUuid('item', next++);
}

export function currentProjectFixture(project) {
  assert.equal(project?.format, 'paintty-sprite');
  assert.equal(project?.version, 13);
  assert.deepEqual(Object.keys(project.timeline || {}).sort(), ['clips', 'tags', 'tracks']);
  return structuredClone(project);
}
