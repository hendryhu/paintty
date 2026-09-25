import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const visibleSources: Array<readonly [file: string, source: string]> = [];

function collect(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(target);
    else if (entry.isFile() && /\.(?:svelte|ts)$/.test(entry.name)) {
      visibleSources.push([path.relative(root, target), fs.readFileSync(target, 'utf8')]);
    }
  }
}

collect(path.join(root, 'src'));

const forbidden = [
  /\bas requested\b/i,
  /\byou asked\b/i,
  /\byour prompt\b/i,
  /\buser requested\b/i,
  /\bacceptance criteria\b/i,
  /\bimplementation rationale\b/i,
  /\bwhole-cell, untransformed geometry\b/i,
  /Scale proportionally \(Shift for/i,
];

for (const [file, source] of visibleSources) {
  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern, `${file} contains prompt-derived product copy`);
  }
}

console.log(`Checked UI-copy policy across ${visibleSources.length} source files.`);
