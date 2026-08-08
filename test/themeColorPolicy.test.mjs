import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readThemeColor, readThemeColors } from '../src/lib/themeColors.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const literalPattern = /#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\([^)]*\)|%23[0-9a-f]{3,8}\b/gi;
const approvals = new Map([
  ['src/components/ColorPicker.svelte|#f44', 4],
  ['src/components/ColorPicker.svelte|#ff4', 2],
  ['src/components/ColorPicker.svelte|#4f4', 2],
  ['src/components/ColorPicker.svelte|#4ff', 2],
  ['src/components/ColorPicker.svelte|#44f', 2],
  ['src/components/ColorPicker.svelte|#f4f', 2],
  ['src/components/Canvas.svelte|%23000', 1],
  ['src/components/Canvas.svelte|%23fff', 1],
  ['src/components/Canvas.svelte|%23e0a458', 2],
]);
const approvalCounts = new Map();

function componentFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.svelte') ? [absolute] : [];
  });
}

function styleSections(file) {
  const source = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.css')) return [{ css: source, startLine: 1 }];
  return [...source.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)].map((match) => ({
    css: match[1],
    startLine: source.slice(0, match.index).split('\n').length,
  }));
}

const files = [
  ...componentFiles(path.join(root, 'src')),
  path.join(root, 'src', 'styles', 'global.css'),
];
const violations = [];
for (const file of files) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  for (const section of styleSections(file)) {
    for (const [index, line] of section.css.split('\n').entries()) {
      for (const match of line.matchAll(literalPattern)) {
        const literal = match[0].toLowerCase();
        const key = `${relative}|${literal}`;
        const count = (approvalCounts.get(key) || 0) + 1;
        approvalCounts.set(key, count);
        if (!approvals.has(key) || count > approvals.get(key)) {
          violations.push(`${relative}:${section.startLine + index}: ${literal}`);
        }
      }
    }
  }
}

assert.deepEqual(violations, [], `Unapproved component/global CSS color literals:\n${violations.join('\n')}`);
for (const [key, expected] of approvals) {
  assert.equal(approvalCounts.get(key), expected, `stale CSS color approval: ${key}`);
}

const originalGetComputedStyle = globalThis.getComputedStyle;
globalThis.getComputedStyle = () => ({
  getPropertyValue(property) {
    return property === '--waveform' ? '  rgba(1, 2, 3, 0.5)  ' : ' #abcdef ';
  },
});
assert.equal(readThemeColor('--waveform', {}), 'rgba(1, 2, 3, 0.5)');
assert.deepEqual(readThemeColors({ waveform: '--waveform', onion: '--onion-next' }, {}), {
  waveform: 'rgba(1, 2, 3, 0.5)',
  onion: '#abcdef',
});
globalThis.getComputedStyle = originalGetComputedStyle;

console.log(`theme color policy passed across ${files.length} component/global CSS files`);
