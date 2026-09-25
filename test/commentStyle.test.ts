import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = [
  join(import.meta.dirname, '..', 'src'),
  join(import.meta.dirname),
];
const SOURCE_EXTENSIONS = new Set(['.ts', '.svelte', '.css']);
const failures: string[] = [];

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.'))) ? [path] : [];
  });
}

function endsSentence(text: string): boolean {
  return /[.!?]$/.test(text.trim());
}

for (const root of ROOTS) for (const file of files(root)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*\/\/\//.test(line)) continue;
    if (/^\s*\/\//.test(line)) {
      const start = index;
      let text = '';
      while (index < lines.length && /^\s*\/\//.test(lines[index]!)) {
        text = lines[index]!.replace(/^\s*\/\/\s?/, '').trim();
        index++;
      }
      index--;
      if (!endsSentence(text)) failures.push(`${relative(join(import.meta.dirname, '..'), file)}:${start + 1}`);
      continue;
    }
    if (!/^\s*\/\*/.test(line)) continue;
    const start = index;
    let text = line.replace(/^\s*\/\*+\s?/, '').replace(/\*\/\s*$/, '').trim();
    while (!lines[index]!.includes('*/') && index + 1 < lines.length) {
      index++;
      const next = lines[index]!.replace(/\*\/\s*$/, '').replace(/^\s*\*?\s?/, '').trim();
      if (next) text = next;
    }
    if (!endsSentence(text)) failures.push(`${relative(join(import.meta.dirname, '..'), file)}:${start + 1}`);
  }
}

assert.deepEqual(failures, [], `Comments must end with a period: ${failures.join(', ')}`);
console.log('comment style policy passed across source and test files');
