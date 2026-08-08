import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { ICON_DATA } from '../src/lib/iconData.js';

const iconDataUrl = new URL('../src/lib/iconData.js', import.meta.url);
const iconComponentUrl = new URL('../src/components/Icon.svelte', import.meta.url);
await access(iconDataUrl);
await access(iconComponentUrl);

const componentSource = await readFile(iconComponentUrl, 'utf8');
assert.match(componentSource, /@iconify\/svelte\/dist\/OfflineIcon\.svelte/);
assert.doesNotMatch(componentSource, /from\s+['"]@iconify\/svelte['"]/);
assert.doesNotMatch(componentSource, /(?:api\.iconify\.design|api\.unisvg\.com|api\.simplesvg\.com)/);

const icons = Object.entries(ICON_DATA);
assert.ok(icons.length > 0, 'local icon data must not be empty');
for (const [name, data] of icons) {
  assert.match(data.body, /<(?:path|circle|rect|line|polygon|polyline)\b/, `${name} must contain SVG geometry`);
}

console.log(`Checked ${icons.length} locally bundled icons.`);
