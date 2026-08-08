import assert from 'node:assert/strict';
import { drawOnionCells } from '../src/lib/render.js';

const calls = [];
const context = {
  globalAlpha: 1,
  fillStyle: '',
  textAlign: '',
  textBaseline: '',
  fillRect(...args) { calls.push(['background', this.globalAlpha, this.fillStyle, ...args]); },
  fillText(...args) { calls.push(['glyph', this.globalAlpha, this.fillStyle, ...args]); },
};
const metrics = { cellW: 10, cellH: 20, baseline: 15 };
drawOnionCells(context, [[
  { bg: '#112233' },
  { c: '@', fg: '#ffffff' },
  { c: 'X', fg: '#ffffff', bg: '#445566' },
  { c: '', cont: true },
]], metrics, '#e06c6c', 0.3);

assert.deepEqual(calls, [
  ['background', 0.3, '#e06c6c', 0, 0, 10, 20],
  ['background', 0.3, '#e06c6c', 20, 0, 10, 20],
  ['glyph', 0.3, '#e06c6c', '@', 10, 15],
  ['glyph', 0.3, '#e06c6c', 'X', 20, 15],
]);
assert.equal(context.globalAlpha, 1);

console.log('ok - onion rendering includes background and glyph channels');
