import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_RELEASES_URL } from '../src/lib/cliDownloads.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(CLI_RELEASES_URL, 'https://github.com/hendryhu/paintty-cli/releases/latest');

const popup = fs.readFileSync(path.join(root, 'src/components/TuiHelperPopup.svelte'), 'utf8');
assert.match(popup, /href=\{CLI_RELEASES_URL\}/);
assert.match(popup, /target="_blank"/);
assert.match(popup, /chmod \+x paintty-cli-linux-x86_64/);
assert.match(popup, /once for each newly downloaded binary/);

console.log('CLI release-link tests passed');
