import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');

function collect(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collect(target);
    return entry.isFile() && entry.name.endsWith('.svelte') ? [target] : [];
  });
}

const prohibited = [
  [/from\s+['"]svelte\/legacy['"]/, 'svelte/legacy import'],
  [/\bcreateEventDispatcher\b/, 'createEventDispatcher'],
  [/\bexport\s+let\b/, 'export let'],
  [/^\s*\$:\s/m, 'legacy reactive label'],
  [/\bon:[a-zA-Z]+(?:\||=)/, 'legacy event directive'],
  [/<slot\b/, 'legacy slot'],
  [/\$\$restProps\b/, '$$restProps'],
  [/<svelte:component\b/, 'legacy dynamic component'],
];

const files = collect(src);
assert.ok(files.length > 0);
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const [pattern, label] of prohibited) {
    assert.doesNotMatch(source, pattern, `${path.relative(root, file)} contains ${label}`);
  }
}

const vite = fs.readFileSync(path.join(root, 'vite.config.js'), 'utf8');
assert.match(vite, /compilerOptions:\s*\{\s*runes:\s*true\s*\}/);
const entry = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
assert.match(entry, /import \{ mount \} from 'svelte'/);
assert.match(entry, /mount\(App, \{ target:/);
assert.doesNotMatch(entry, /new App\(/);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.match(pkg.devDependencies.svelte, /^\^5\./);
assert.match(pkg.devDependencies.vite, /^\^8\./);
assert.match(pkg.devDependencies['@sveltejs/vite-plugin-svelte'], /^\^7\./);
assert.match(pkg.devDependencies.vitest, /^\^4\./);

console.log(`Verified ${files.length} native Svelte 5 runes components.`);
