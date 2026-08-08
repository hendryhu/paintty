import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'svelte/store';
import {
  chooseSaveTarget,
  exportANSI,
  exportAnimation,
  exportTXT,
  exportVideo,
  saveAsImage,
  serializeJSON,
} from '../src/lib/fileio.js';
import {
  compatibleRetainedTarget,
  createFileHandleTarget,
  exportOutputSpec,
  exportPickerAvailable,
  normalizeExportFilename,
  pickExportFileTarget,
  sanitizeExportFilenameDraft,
} from '../src/lib/exportDestination.js';
import { canUndo } from '../src/lib/grid.js';
import { dirty } from '../src/lib/stores.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

assert.equal(sanitizeExportFilenameDraft('C:\\outside\\scene?.png'), 'scene-.png');
assert.equal(normalizeExportFilename('scene.paintty', '.png'), 'scene.png');
assert.equal(normalizeExportFilename('scene.PNG', '.png'), 'scene.PNG');
assert.equal(normalizeExportFilename('scene.zip', '.json'), 'scene.json');
assert.equal(normalizeExportFilename('scene.json', '.zip'), 'scene.zip');
assert.equal(normalizeExportFilename('CON', '.txt'), 'CON-file.txt');
assert.equal(normalizeExportFilename('', '.ans', 'fallback.paintty'), 'fallback.ans');
for (const [source, expected] of [
  ['CON.backup', 'CON-file.backup.txt'],
  ['PRN.foo', 'PRN-file.foo.txt'],
  ['AUX.x', 'AUX-file.x.txt'],
  ['COM1.any', 'COM1-file.any.txt'],
  ['LPT9.any', 'LPT9-file.any.txt'],
  ['safe.backup', 'safe.backup.txt'],
]) assert.equal(normalizeExportFilename(source, '.txt'), expected);
assert.equal(normalizeExportFilename('con.backup.PNG', '.png'), 'con-file.backup.PNG',
  'reserved first stems do not disturb an already-correct extension');

for (const [format, extension] of [
  ['png', '.png'],
  ['jpg', '.jpg'],
  ['video', '.mp4'],
  ['txt', '.txt'],
  ['ansi', '.ans'],
]) {
  assert.equal(exportOutputSpec(format).extension, extension);
}
assert.deepEqual(exportOutputSpec('animation-json', { includeAudio: true }), {
  extension: '.zip',
  mime: 'application/zip',
  description: 'Paintty Animation ZIP',
});
assert.deepEqual(exportOutputSpec('animation-json', { includeAudio: false }), {
  extension: '.json',
  mime: 'application/json',
  description: 'Paintty Animation JSON',
});

const writes = [];
let pickerOptions = null;
let writableCreations = 0;
let closes = 0;
let aborts = 0;
const handle = {
  name: 'chosen.zip',
  createWritable() {
    writableCreations++;
    return {
      async write(blob) { writes.push(await blob.text()); },
      async close() { closes++; },
      async abort() { aborts++; },
    };
  },
};
const browsed = await pickExportFileTarget(
  'suggested.zip',
  exportOutputSpec('animation-json', { includeAudio: true }),
  {
    async showSaveFilePicker(options) {
      pickerOptions = options;
      return handle;
    },
  },
);
assert.deepEqual(pickerOptions, {
  suggestedName: 'suggested.zip',
  types: [{
    description: 'Paintty Animation ZIP',
    accept: { 'application/zip': ['.zip'] },
  }],
});
assert.equal(browsed.name, 'chosen.zip');
assert.equal(writableCreations, 0, 'Browse retains the handle without opening a writable');
assert.equal(writes.length, 0, 'Browse writes no bytes');
await browsed.write(new Blob(['one export']));
assert.deepEqual(writes, ['one export']);
assert.deepEqual({ writableCreations, closes, aborts }, {
  writableCreations: 1,
  closes: 1,
  aborts: 0,
}, 'the subsequent Export commits exactly one handle write');

assert.equal(compatibleRetainedTarget(browsed, 'chosen.zip', '.zip'), browsed);
assert.equal(compatibleRetainedTarget(browsed, 'chosen.json', '.json'), null,
  'audio exclusion invalidates a ZIP handle');
assert.equal(compatibleRetainedTarget(browsed, 'renamed.zip', '.zip'), null,
  'editing the filename invalidates a retained handle');
assert.equal(compatibleRetainedTarget(browsed, 'chosen.zip', '.json'), null,
  'changing format invalidates a retained handle');

const rawNamedTarget = createFileHandleTarget({
  name: 'C:\\private\\leaf.txt',
  async createWritable() {
    return { async write() {}, async close() {}, async abort() {} };
  },
});
assert.equal(rawNamedTarget.name, 'leaf.txt', 'only a selected handle leaf name is exposed');

const pickerCancelled = new Error('cancelled');
pickerCancelled.name = 'AbortError';
assert.equal(await pickExportFileTarget('cancel.png', exportOutputSpec('png'), {
  async showSaveFilePicker() { throw pickerCancelled; },
}), null, 'picker cancellation selects no target');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const writeStarted = deferred();
const writeCompletion = deferred();
let cancelledCloses = 0;
let cancelledAborts = 0;
const cancellable = createFileHandleTarget({
  name: 'cancel.png',
  async createWritable() {
    return {
      async write() {
        writeStarted.resolve();
        await writeCompletion.promise;
      },
      async close() { cancelledCloses++; },
      async abort() { cancelledAborts++; },
    };
  },
});
const writeController = new AbortController();
const cancelledWrite = cancellable.write(new Blob(['cancel']), { signal: writeController.signal });
await writeStarted.promise;
writeController.abort();
writeCompletion.resolve();
await assert.rejects(cancelledWrite, (error) => error?.name === 'AbortError');
assert.deepEqual({ cancelledCloses, cancelledAborts }, { cancelledCloses: 0, cancelledAborts: 1 });

const originalWindow = globalThis.window;
try {
  let defaultPickerCalls = 0;
  let defaultWritableCreations = 0;
  globalThis.window = {
    async showSaveFilePicker(options) {
      defaultPickerCalls++;
      assert.equal(options.suggestedName, 'native.png');
      return {
        name: 'native.png',
        async createWritable() {
          defaultWritableCreations++;
          return { async write() {}, async close() {}, async abort() {} };
        },
      };
    },
  };
  assert.equal(exportPickerAvailable(), true);
  const pendingNativeDefault = chooseSaveTarget('native.png', 'image/png', 'PNG image');
  assert.equal(defaultPickerCalls, 1,
    'Export without Browse invokes the native picker in the calling activation turn');
  assert.equal(defaultWritableCreations, 0, 'selecting the normal target does not write early');
  const nativeDefault = await pendingNativeDefault;
  assert.equal(nativeDefault.name, 'native.png');

  delete globalThis.window;
  assert.equal(exportPickerAvailable(), false);
  const fallback = await chooseSaveTarget('fallback.txt', 'text/plain', 'Text');
  assert.equal(fallback.name, 'fallback.txt');
  assert.equal(fallback.durable, false, 'unsupported File System Access falls back to download');
} finally {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}

const projectBefore = serializeJSON();
const dirtyBefore = get(dirty);
const undoBefore = get(canUndo);
const selectedNames = [];
const targetFor = async (filename) => {
  selectedNames.push(filename);
  return { async write() {} };
};
assert.equal(await exportTXT({ filename: 'wrong.zip', chooseTarget: targetFor }), true);
assert.equal(await exportANSI({ filename: 'wrong.json', chooseTarget: targetFor }), true);
assert.equal(await saveAsImage('png', 8, {
  filename: 'wrong.ans',
  render: async () => new Blob(['png'], { type: 'image/png' }),
  chooseTarget: targetFor,
}), true);
assert.equal(await saveAsImage('jpg', 8, {
  filename: 'wrong.png',
  render: async () => new Blob(['jpg'], { type: 'image/jpeg' }),
  chooseTarget: targetFor,
}), true);
assert.equal(await exportVideo(8, false, {
  filename: 'wrong.json',
  createCanvas: () => ({ width: 0, height: 0, getContext: () => ({}) }),
  preflight: async () => ({}),
  encodeVideo: async () => new Uint8Array([1, 2, 3]),
  getAudioState: () => ({ assets: [], tracks: [], clips: [] }),
  chooseTarget: targetFor,
}), true);
assert.equal(await exportAnimation({ filename: 'wrong.zip', chooseTarget: targetFor }), true);
assert.deepEqual(selectedNames, [
  'wrong.txt',
  'wrong.ans',
  'wrong.png',
  'wrong.jpg',
  'wrong.mp4',
  'wrong.json',
],
  'every exporter normalizes the editable filename to its actual output');
assert.equal(serializeJSON(), projectBefore);
assert.equal(get(dirty), dirtyBefore);
assert.equal(get(canUndo), undoBefore, 'destination selection and exports add no project history');

const popupSource = fs.readFileSync(path.join(root, 'src/components/ExportPopup.svelte'), 'utf8');
assert.match(popupSource, />File name</);
assert.match(popupSource, />Location</);
assert.match(popupSource, /Default location/);
assert.match(popupSource, /'Browse…'/);
assert.match(popupSource, /let excludeAudio = \$state\(false\)/,
  'audible animation audio defaults to included');
assert.match(popupSource, /audibleAudioCount > 0 && !excludeAudio/);
assert.match(popupSource, /One mixed WAV included; export will be ZIP\./);
assert.match(popupSource, /> Exclude audio</);
assert.doesNotMatch(popupSource, /Include audio|Package (?:as )?ZIP|Download (?:ZIP|JSON)/);
assert.match(popupSource, /retainedTarget = null/);
assert.match(popupSource, /onProjectReplaced\(close\)/);
assert.match(popupSource, /pickExportFileTarget/);
assert.match(popupSource, /filename: exportFilename/);
assert.match(popupSource, /chooseTarget \? \{ chooseTarget \}/);

console.log('export filename and retained destination tests passed');
