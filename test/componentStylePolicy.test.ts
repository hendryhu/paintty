import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const COMPONENTS = join(import.meta.dirname, '..', 'src', 'components');
const SHARED_SELECTORS = [
  '.section-title',
  '.row',
  '.swatch',
  '.track-button',
  '.key-button',
  '.modal-backdrop',
  '.modal-dialog',
  '.modal-head',
  '.modal-close',
];
const violations: string[] = [];

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.name.endsWith('.svelte') ? [path] : [];
  });
}

for (const file of files(COMPONENTS)) {
  const source = readFileSync(file, 'utf8');
  const styles = [...source.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)]
    .map((match) => match[1] || '');
  for (const selector of SHARED_SELECTORS) {
    const pattern = new RegExp(`^\\s*${selector.replace('.', '\\.')}\\s*(?:,|\\{)`, 'm');
    if (styles.some((style) => pattern.test(style))) {
      violations.push(`${relative(join(import.meta.dirname, '..'), file)} redefines ${selector}`);
    }
  }
}

assert.deepEqual(violations, [], `Shared visual primitives belong in styles/components.css:\n${violations.join('\n')}`);
console.log('component style policy passed across Svelte components');
