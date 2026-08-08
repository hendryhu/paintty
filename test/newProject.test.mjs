import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'svelte/store';
import {
  BUILT_IN_PROJECT_PRESETS,
  DEFAULT_PROJECT_PRESET_ID,
  PROJECT_PRESET_STORAGE_KEY,
  createBlankProject,
  defaultProjectDraft,
  deleteUserProjectPreset,
  loadProjectPresetSettings,
  normalizeProjectPresetSettings,
  persistProjectPresetSettings,
  projectPresetById,
  rememberProjectDraft,
  renameUserProjectPreset,
  resetProjectDraftToDefault,
  saveUserProjectPreset,
  selectProjectPreset,
  setDefaultProjectPreset,
  validateProjectDraft,
} from '../src/lib/projectPresets.js';
import {
  COLOR_DEPTH_STORAGE_KEY,
  createColorDepthPreference,
  loadColorDepthPreference,
  persistColorDepthPreference,
} from '../src/lib/appPreferences.js';
import { replaceWithBlankProject } from '../src/lib/newProjectLifecycle.js';
import {
  editorModalOpen,
  newProjectShortcutAction,
} from '../src/lib/timelineKeys.js';
import {
  activeLayerId,
  activeLayerPart,
  authoredRevision,
  canRedo,
  canUndo,
  cellSelection,
  createVideoLayer,
  dims,
  layers,
  resizeCanvas,
  selectedLayerIds,
  undo,
} from '../src/lib/grid.js';
import {
  activeFrameIndex,
  fps,
  frames,
  gotoFrame,
  playheadTick,
  playing,
  setClipSelection,
  setTimelineTag,
  trimClip,
} from '../src/lib/frames.js';
import {
  loadJSON,
  saveJSON,
  serializeJSON,
} from '../src/lib/fileio.js';
import {
  captureProjectRevision,
  onProjectLoaded,
} from '../src/lib/documentLifecycle.js';
import {
  getClipTimelineSelection,
  getClipTimelineState,
} from '../src/lib/clipTimelineState.js';
import {
  currentMediaRegistry,
  mediaRuntimeStatus,
  registerMediaAsset,
} from '../src/lib/mediaRegistry.js';
import { mediaResourceManager } from '../src/lib/mediaRuntime.js';
import {
  recentProjectIdentity,
  recentProjectRecord,
  recentProjects,
} from '../src/lib/recentProjects.js';
import { moveState, selectMode } from '../src/lib/selection.js';
import { activeTool, altEyedrop, colorDepth, dirty, fileName } from '../src/lib/stores.js';
import { audioAssets, audioClips, createAudioTrack } from '../src/lib/audio.js';
import { applyProjectSettings } from '../src/lib/projectSettings.js';

const uuidByKind = {
  project: '41000000-0000-4000-8000-000000000001',
  layer: '42000000-0000-4000-8000-000000000002',
  track: '43000000-0000-4000-8000-000000000003',
  clip: '44000000-0000-4000-8000-000000000004',
};

const blank = createBlankProject(defaultProjectDraft(), {
  makeUuid: (kind) => uuidByKind[kind],
});
assert.deepEqual(blank, {
  format: 'paintty-sprite',
  version: 13,
  projectId: uuidByKind.project,
  width: 80,
  height: 24,
  fps: 24,
  timeline: {
    tags: [],
    tracks: [{
      id: uuidByKind.track,
      kind: 'visual',
      locked: false,
      layer: {
        id: uuidByKind.layer,
        name: 'Layer 1',
        type: 'cell',
        visible: true,
        cells: {},
        offset: { x: 0, y: 0 },
      },
    }],
    clips: [{
      id: uuidByKind.clip,
      trackId: uuidByKind.track,
      kind: 'visual',
      startTick: 0,
      inTick: 0,
      outTick: 1,
      sourceDuration: 1,
      frameKeys: [{
        tick: 0,
        value: { cells: {} },
      }],
      propertyTracks: {},
    }],
  },
  media: { generation: 0, assets: [] },
});

let freshCounter = 10;
const freshUuid = () => `45000000-0000-4000-8000-${(++freshCounter).toString(16).padStart(12, '0')}`;
const firstFresh = createBlankProject(defaultProjectDraft(), { makeUuid: freshUuid });
const secondFresh = createBlankProject(defaultProjectDraft(), { makeUuid: freshUuid });
const idsOf = (project) => new Set([
  project.projectId,
  ...project.timeline.tracks.flatMap((track) => track.layer ? [track.layer.id] : []),
  ...project.timeline.tracks.map((track) => track.id),
  ...project.timeline.clips.map((clip) => clip.id),
]);
assert.equal([...idsOf(firstFresh)].some((id) => idsOf(secondFresh).has(id)), false,
  'each blank project must allocate fresh project, layer, track, and clip UUIDs');
assert.throws(() => createBlankProject(defaultProjectDraft(), {
  makeUuid: () => uuidByKind.project,
}), /must be unique/);

for (const [draft, pattern] of [
  [{ columns: 0, rows: 24, baseFps: 24 }, /Columns/],
  [{ columns: 257, rows: 24, baseFps: 24 }, /Columns/],
  [{ columns: 80, rows: 0, baseFps: 24 }, /Rows/],
  [{ columns: 80, rows: 257, baseFps: 24 }, /Rows/],
  [{ columns: 80, rows: 24, baseFps: 0 }, /Base FPS/],
  [{ columns: 80, rows: 24, baseFps: 61 }, /Base FPS/],
  [{ columns: 1.5, rows: 24, baseFps: 24 }, /Columns/],
  [{ columns: 80, rows: 24, baseFps: Number.NaN }, /Base FPS/],
]) assert.throws(() => validateProjectDraft(draft), pattern);
assert.deepEqual(validateProjectDraft({ columns: '1', rows: '256', baseFps: '60' }), {
  columns: 1, rows: 256, baseFps: 60,
});

assert.equal(Object.isFrozen(BUILT_IN_PROJECT_PRESETS), true);
assert.equal(BUILT_IN_PROJECT_PRESETS.every(Object.isFrozen), true);
assert.equal(BUILT_IN_PROJECT_PRESETS[0].name, '80x24 · 24 fps');
assert.throws(() => { BUILT_IN_PROJECT_PRESETS[0].columns = 1; }, TypeError);

const defaultSettings = normalizeProjectPresetSettings(null);
assert.deepEqual(defaultSettings, {
  version: 1,
  userPresets: [],
  defaultPresetId: DEFAULT_PROJECT_PRESET_ID,
  lastUsed: { presetId: DEFAULT_PROJECT_PRESET_ID, draft: { columns: 80, rows: 24, baseFps: 24 } },
});
assert.deepEqual(normalizeProjectPresetSettings('{bad json'), defaultSettings);
assert.deepEqual(normalizeProjectPresetSettings({ version: 99 }), defaultSettings);

const validUserId = 'user:51000000-0000-4000-8000-000000000001';
const recovered = normalizeProjectPresetSettings({
  version: 1,
  userPresets: [
    { id: validUserId, name: 'Compact', columns: 40, rows: 12, baseFps: 12 },
    { id: 'user:51000000-0000-4000-8000-000000000002', name: 'Bad bounds', columns: 0, rows: 12, baseFps: 12 },
    { id: 'user:51000000-0000-4000-8000-000000000003', name: ' compact ', columns: 60, rows: 20, baseFps: 24 },
    { id: 'user:51000000-0000-4000-8000-000000000004', name: '   ', columns: 60, rows: 20, baseFps: 24 },
    { id: validUserId, name: 'Duplicate ID', columns: 60, rows: 20, baseFps: 24 },
    { id: DEFAULT_PROJECT_PRESET_ID, name: 'Built-in collision', columns: 60, rows: 20, baseFps: 24 },
  ],
  defaultPresetId: 'user:missing',
  lastUsed: {
    presetId: 'user:missing',
    draft: { columns: 80, rows: 24, baseFps: 200 },
  },
});
assert.deepEqual(recovered, {
  version: 1,
  userPresets: [{ id: validUserId, name: 'Compact', columns: 40, rows: 12, baseFps: 12 }],
  defaultPresetId: DEFAULT_PROJECT_PRESET_ID,
  lastUsed: { presetId: DEFAULT_PROJECT_PRESET_ID, draft: { columns: 80, rows: 24, baseFps: 24 } },
});

let presetId = 1;
const makePresetId = () => `52000000-0000-4000-8000-${(presetId++).toString(16).padStart(12, '0')}`;
let settings = defaultSettings;
settings = saveUserProjectPreset(settings, 'Small', {
  columns: 32, rows: 10, baseFps: 15,
}, { makeId: makePresetId });
const smallId = settings.lastUsed.presetId;
assert.equal(settings.userPresets.length, 1, 'one saved preset must survive normalization');
settings = saveUserProjectPreset(settings, 'Large', {
  columns: 200, rows: 100, baseFps: 60,
}, { makeId: makePresetId });
const largeId = settings.lastUsed.presetId;
assert.deepEqual(settings.userPresets.map((preset) => preset.name), ['Small', 'Large'],
  'many saved presets must retain insertion order');
assert.throws(() => saveUserProjectPreset(settings, ' ', defaultProjectDraft(), { makeId: makePresetId }),
  /required/);
assert.throws(() => saveUserProjectPreset(settings, 'small', defaultProjectDraft(), { makeId: makePresetId }),
  /already exists/);
assert.throws(() => saveUserProjectPreset(settings, '80X24 · 24 FPS', defaultProjectDraft(), { makeId: makePresetId }),
  /already exists/);
assert.throws(() => renameUserProjectPreset(settings, DEFAULT_PROJECT_PRESET_ID, 'Changed'),
  /cannot be renamed/);
assert.throws(() => deleteUserProjectPreset(settings, DEFAULT_PROJECT_PRESET_ID),
  /cannot be deleted/);
assert.throws(() => renameUserProjectPreset(settings, largeId, ' Small '), /already exists/);
assert.throws(() => renameUserProjectPreset(settings, largeId, '   '), /required/);

settings = renameUserProjectPreset(settings, smallId, 'Tiny');
assert.equal(projectPresetById(settings, smallId).name, 'Tiny');
settings = setDefaultProjectPreset(settings, smallId);
assert.equal(settings.defaultPresetId, smallId);
settings = rememberProjectDraft(settings, { columns: 77, rows: 23, baseFps: 30 }, largeId);
assert.deepEqual(settings.lastUsed, {
  presetId: largeId,
  draft: { columns: 77, rows: 23, baseFps: 30 },
}, 'last-used draft must remain independent from its selected preset values');
settings = resetProjectDraftToDefault(settings);
assert.deepEqual(settings.lastUsed, {
  presetId: smallId,
  draft: { columns: 32, rows: 10, baseFps: 15 },
});
settings = deleteUserProjectPreset(settings, smallId);
assert.equal(settings.defaultPresetId, DEFAULT_PROJECT_PRESET_ID,
  'deleting the designated user default must fall back to the required built-in');
assert.deepEqual(settings.lastUsed, {
  presetId: DEFAULT_PROJECT_PRESET_ID,
  draft: { columns: 80, rows: 24, baseFps: 24 },
}, 'deleting the selected default must visibly settle on the built-in preset and its exact draft');
settings = selectProjectPreset(settings, largeId);
assert.deepEqual(settings.lastUsed.draft, { columns: 200, rows: 100, baseFps: 60 });
settings = deleteUserProjectPreset(settings, largeId);
assert.equal(settings.userPresets.length, 0);
assert.equal(settings.lastUsed.presetId, DEFAULT_PROJECT_PRESET_ID);
assert.deepEqual(settings.lastUsed.draft, { columns: 80, rows: 24, baseFps: 24 },
  'deleting the final user preset must not retain fields from the removed preset');

let fallbackSettings = defaultSettings;
fallbackSettings = saveUserProjectPreset(fallbackSettings, 'Fallback', {
  columns: 40, rows: 16, baseFps: 20,
}, { makeId: makePresetId });
const fallbackId = fallbackSettings.lastUsed.presetId;
fallbackSettings = setDefaultProjectPreset(fallbackSettings, fallbackId);
fallbackSettings = saveUserProjectPreset(fallbackSettings, 'Temporary', {
  columns: 120, rows: 36, baseFps: 30,
}, { makeId: makePresetId });
const temporaryId = fallbackSettings.lastUsed.presetId;
const fallbackBeforeDeletion = JSON.stringify(fallbackSettings);
const deletedSelected = deleteUserProjectPreset(fallbackSettings, temporaryId);
assert.equal(JSON.stringify(fallbackSettings), fallbackBeforeDeletion,
  'preparing or cancelling preset deletion can retain byte-identical settings');
assert.deepEqual(deletedSelected.lastUsed, {
  presetId: fallbackId,
  draft: { columns: 40, rows: 16, baseFps: 20 },
}, 'deleting one of many presets must select the designated default and copy its exact fields');
assert.equal(deletedSelected.defaultPresetId, fallbackId);
assert.deepEqual(deletedSelected.userPresets.map((preset) => preset.name), ['Fallback']);

const deletedUnselectedDefault = deleteUserProjectPreset(fallbackSettings, fallbackId);
assert.equal(deletedUnselectedDefault.defaultPresetId, DEFAULT_PROJECT_PRESET_ID,
  'deleting an unselected designated default must reset only the default identity');
assert.deepEqual(deletedUnselectedDefault.lastUsed, {
  presetId: temporaryId,
  draft: { columns: 120, rows: 36, baseFps: 30 },
}, 'deleting a preset other than last-used must retain the valid selected preset and draft');

const storageValues = new Map();
const storage = {
  getItem(key) { return storageValues.get(key) ?? null; },
  setItem(key, value) { storageValues.set(key, String(value)); },
};
const storedSettings = persistProjectPresetSettings(recovered, storage);
assert.equal(storageValues.has(PROJECT_PRESET_STORAGE_KEY), true);
assert.deepEqual(loadProjectPresetSettings(storage), storedSettings);
const projectBeforePresetStorage = serializeJSON();
const historyBeforePresetStorage = [get(canUndo), get(canRedo)];
persistProjectPresetSettings(storedSettings, storage);
assert.equal(serializeJSON(), projectBeforePresetStorage,
  'preset settings must never enter project JSON, media, or history');
assert.deepEqual([get(canUndo), get(canRedo)], historyBeforePresetStorage);
assert.deepEqual(loadProjectPresetSettings({ getItem() { throw new Error('blocked'); } }), defaultSettings,
  'unavailable or malformed application storage must recover without touching a project');
assert.throws(() => persistProjectPresetSettings(defaultSettings, {
  setItem() { throw new Error('quota'); },
}), /quota/);

const colorDepthValues = new Map();
const colorDepthStorage = {
  getItem(key) { return colorDepthValues.get(key) ?? null; },
  setItem(key, value) { colorDepthValues.set(key, String(value)); },
};
assert.equal(loadColorDepthPreference(colorDepthStorage), 'truecolor',
  'an absent app preference must start in truecolor');
colorDepthValues.set(COLOR_DEPTH_STORAGE_KEY, 'malformed');
assert.equal(loadColorDepthPreference(colorDepthStorage), 'truecolor');
colorDepthValues.set(COLOR_DEPTH_STORAGE_KEY, '"256"');
assert.equal(loadColorDepthPreference(colorDepthStorage), 'truecolor',
  'JSON-looking or otherwise malformed values cannot accidentally enable fallback mode');
assert.equal(loadColorDepthPreference({ getItem() { throw new Error('blocked'); } }), 'truecolor',
  'unavailable local storage must safely fall back to truecolor');
assert.equal(persistColorDepthPreference('256', colorDepthStorage), '256');
assert.equal(colorDepthValues.get(COLOR_DEPTH_STORAGE_KEY), '256');
assert.doesNotThrow(() => persistColorDepthPreference('256', {
  setItem() { throw new Error('quota'); },
}), 'a storage write failure must not break the current editor session');

const firstDepthStore = createColorDepthPreference(colorDepthStorage);
firstDepthStore.set('truecolor');
firstDepthStore.update((value) => value === 'truecolor' ? '256' : 'truecolor');
assert.equal(colorDepthValues.get(COLOR_DEPTH_STORAGE_KEY), '256',
  'both set and update routes must persist through the shared preference store');
const reloadedDepthStore = createColorDepthPreference(colorDepthStorage);
assert.equal(get(reloadedDepthStore), '256', 'a new app store must restore the prior color depth');

const colorDepthBefore = get(colorDepth);
const projectBeforeColorDepth = serializeJSON();
const projectStateBeforeColorDepth = {
  dirty: get(dirty),
  authoredRevision: get(authoredRevision),
  canUndo: get(canUndo),
  canRedo: get(canRedo),
};
colorDepth.set(colorDepthBefore === 'truecolor' ? '256' : 'truecolor');
assert.equal(serializeJSON(), projectBeforeColorDepth,
  'color depth must never enter project JSON');
assert.deepEqual({
  dirty: get(dirty),
  authoredRevision: get(authoredRevision),
  canUndo: get(canUndo),
  canRedo: get(canRedo),
}, projectStateBeforeColorDepth,
  'color depth changes must not dirty the project or create history');
colorDepth.set(colorDepthBefore);

const shortcut = (event, state) => newProjectShortcutAction(event, state);
assert.equal(shortcut({ key: 'n', ctrlKey: true }, {}), 'open');
assert.equal(shortcut({ key: 'N', metaKey: true }, {}), 'open');
for (const state of [
  { typing: true },
  { modalOpen: true },
  { gestureActive: true },
]) assert.equal(shortcut({ key: 'n', ctrlKey: true }, state), 'suppress');
assert.equal(shortcut({ key: 'n', ctrlKey: true, repeat: true }, {}), 'suppress');
assert.equal(shortcut({ key: 'n', ctrlKey: true, shiftKey: true }, {}), null);
assert.equal(shortcut({ key: 'n', metaKey: true, altKey: true }, {}), null);
assert.equal(shortcut({ key: 'x', ctrlKey: true }, {}), null);
assert.equal(editorModalOpen({ newProjectOpen: true }), true);
assert.equal(editorModalOpen({ projectSettingsOpen: true }), true);

const injectedOld = JSON.stringify({ project: 'old', revision: 7 });
let injectedLive = injectedOld;
let injectedName = 'old.paintty';
let injectedRecent = 'recent-old';
const injectedEvents = [];
const injectedResult = await replaceWithBlankProject(defaultProjectDraft(), {
  currentDirty: true,
  currentName: injectedName,
  createProject() {
    injectedEvents.push('construct');
    return blank;
  },
  serializeCurrent() {
    injectedEvents.push('serialize');
    return injectedLive;
  },
  async checkpoint(detail) {
    injectedEvents.push('checkpoint');
    assert.deepEqual(detail, { contents: injectedOld, fileName: 'old.paintty' });
  },
  replaceProject(contents) {
    injectedEvents.push('replace');
    injectedLive = contents;
  },
  setFileName(value) {
    injectedEvents.push('name');
    injectedName = value;
  },
  clearRecentIdentity() {
    injectedEvents.push('recent');
    injectedRecent = null;
  },
  notifyLoaded(detail) {
    injectedEvents.push('baseline');
    assert.deepEqual(detail, { contents: injectedLive, fileName: 'untitled', recent: false });
  },
});
assert.deepEqual(injectedEvents, [
  'construct', 'serialize', 'checkpoint', 'replace', 'name', 'recent', 'serialize', 'baseline',
]);
assert.equal(injectedName, 'untitled');
assert.equal(injectedRecent, null);
assert.equal(injectedResult.contents, JSON.stringify(blank));

let cleanCheckpointed = false;
await replaceWithBlankProject(defaultProjectDraft(), {
  currentDirty: false,
  createProject: () => blank,
  serializeCurrent: () => JSON.stringify(blank),
  checkpoint: async () => { cleanCheckpointed = true; },
  replaceProject() {},
  setFileName() {},
  clearRecentIdentity() {},
  notifyLoaded() {},
});
assert.equal(cleanCheckpointed, false, 'clean creation must not create a discard checkpoint');

let replacementAttempted = false;
await assert.rejects(replaceWithBlankProject(defaultProjectDraft(), {
  currentDirty: true,
  currentName: 'old.paintty',
  createProject: () => blank,
  serializeCurrent: () => injectedOld,
  checkpoint: async () => { throw new Error('checkpoint failed'); },
  replaceProject() { replacementAttempted = true; },
}), /checkpoint failed/);
assert.equal(replacementAttempted, false, 'a failed required checkpoint must leave the old project active');

let constructionSideEffect = false;
await assert.rejects(replaceWithBlankProject({ columns: 0, rows: 24, baseFps: 24 }, {
  currentDirty: true,
  checkpoint: async () => { constructionSideEffect = true; },
  replaceProject() { constructionSideEffect = true; },
}), /Columns/);
assert.equal(constructionSideEffect, false, 'invalid construction must be atomic');

const failedReplacementState = { contents: injectedOld, name: 'old.paintty', recent: 'old-id' };
await assert.rejects(replaceWithBlankProject(defaultProjectDraft(), {
  currentDirty: false,
  createProject: () => blank,
  serializeCurrent: () => failedReplacementState.contents,
  replaceProject() { throw new Error('replace failed'); },
  setFileName(value) { failedReplacementState.name = value; },
  clearRecentIdentity() { failedReplacementState.recent = null; },
  notifyLoaded() {},
}), /replace failed/);
assert.deepEqual(failedReplacementState, {
  contents: injectedOld, name: 'old.paintty', recent: 'old-id',
}, 'replacement failure must not publish new-project identity or recovery state');

const startupBlank = JSON.parse(serializeJSON());
assert.deepEqual({
  dimensions: [startupBlank.width, startupBlank.height],
  fps: startupBlank.fps,
  layers: startupBlank.timeline.tracks.filter((track) => track.layer).length,
  tracks: startupBlank.timeline.tracks.length,
  clips: startupBlank.timeline.clips.length,
  media: startupBlank.media,
}, {
  dimensions: [80, 24],
  fps: 24,
  layers: 1,
  tracks: 1,
  clips: 1,
  media: { generation: 0, assets: [] },
}, 'the first-run module state must use the same exact blank-project contract');
assert.equal(new Set([...idsOf(startupBlank)].map((id) => id.toLowerCase())).size, 4);
assert.deepEqual(startupBlank.timeline.clips[0].frameKeys, [{ tick: 0, value: { cells: {} } }]);

loadJSON(JSON.stringify(createBlankProject({ columns: 12, rows: 6, baseFps: 12 })));
fileName.set('authored.paintty');
let staleTargetWrites = 0;
const staleTarget = {
  name: 'authored.paintty',
  async write() { staleTargetWrites++; },
};
await saveJSON({
  chooseTarget: async () => staleTarget,
  checkpoint: async () => {},
  notifySaved: async () => {},
});
const videoAsset = registerMediaAsset({
  hash: 'b'.repeat(64),
  sourceName: 'stale.mp4',
  mime: 'video/mp4',
  size: 0,
  kind: 'video',
  duration: 2,
  width: 16,
  height: 9,
}).asset;
createVideoLayer('Stale video', {
  assetId: videoAsset.assetId,
  duration: videoAsset.duration,
  width: videoAsset.width,
  height: videoAsset.height,
}, 0);
const audioBlob = new Blob(['a'], { type: 'audio/wav' });
const audioAsset = registerMediaAsset({
  hash: 'c'.repeat(64),
  sourceName: 'stale.wav',
  mime: 'audio/wav',
  size: audioBlob.size,
  kind: 'audio',
  duration: 1,
}).asset;
createAudioTrack({
  id: audioAsset.assetId,
  sourceName: audioAsset.sourceName,
  mime: audioAsset.mime,
  size: audioAsset.size,
  duration: audioAsset.duration,
  blob: audioBlob,
  buffer: { duration: audioAsset.duration },
}, 0, { assetId: audioAsset.assetId });
registerMediaAsset({
  hash: 'a'.repeat(64),
  sourceName: 'unused.png',
  mime: 'image/png',
  size: 0,
  kind: 'image',
  width: 1,
  height: 1,
});
await Promise.resolve();

trimClip(getClipTimelineState().clips.find((clip) => clip.kind === 'visual').id, 'end', 2);
assert.equal(setTimelineTag({ tick: 1, type: 'custom', value: 'old-project' }).changed, true);
gotoFrame(1);
resizeCanvas(13, 6);
resizeCanvas(14, 6);
undo();
assert.equal(get(canUndo), true);
assert.equal(get(canRedo), true);
cellSelection.set(new Set(['2,2']));
activeLayerPart.set('mask');
selectedLayerIds.set(new Set(['stale-layer']));
moveState.set({ mode: 'move', layerId: get(activeLayerId) });
activeTool.set('rect');
selectMode.set('add');
altEyedrop.set(true);
colorDepth.set('256');
recentProjectIdentity.set('recent-authored');
recentProjects.set([{
  id: 'existing-recent',
  name: 'existing.paintty',
  contents: serializeJSON(),
  openedAt: 1,
}]);
mediaRuntimeStatus.set(new Map([['stale', { state: 'ready' }]]));
const staleClip = getClipTimelineState().clips[0];
setClipSelection({ clipIds: [staleClip.id] });
dirty.set(true);

const dirtySnapshot = serializeJSON();
const oldIds = idsOf(JSON.parse(dirtySnapshot));
assert.equal(get(layers).some((layer) => layer.type === 'video'), true);
assert.equal(get(audioAssets).length, 1);
assert.equal(get(audioClips).length, 1);
assert.equal(currentMediaRegistry().assets.length, 3);
const revisionBeforeNew = captureProjectRevision();
let checkpointRevision = null;
let checkpointContents = null;
let recoveryBaseline = null;
const stopLoaded = onProjectLoaded((detail) => { recoveryBaseline = detail; });
const result = await replaceWithBlankProject(defaultProjectDraft(), {
  checkpoint: async (detail) => {
    checkpointRevision = captureProjectRevision();
    checkpointContents = detail.contents;
  },
});
stopLoaded();

const created = JSON.parse(serializeJSON());
assert.equal(checkpointRevision, revisionBeforeNew,
  'dirty checkpoint must complete before the project revision advances');
assert.equal(checkpointContents, dirtySnapshot,
  'dirty checkpoint must preserve the complete old document bytes');
assert.equal([...idsOf(created)].some((id) => oldIds.has(id)), false);
assert.deepEqual({ width: created.width, height: created.height, fps: created.fps }, {
  width: 80, height: 24, fps: 24,
});
assert.equal(created.timeline.tracks.length, 1);
assert.equal(created.timeline.clips.length, 1);
assert.deepEqual(created.timeline.tags, [], 'New clears sequence tags');
assert.deepEqual(created.timeline.clips[0].frameKeys, [{ tick: 0, value: { cells: {} } }]);
assert.deepEqual(created.media, { generation: 0, assets: [] });
assert.equal(result.contents, serializeJSON());
assert.deepEqual(recoveryBaseline, {
  contents: serializeJSON(), fileName: 'untitled', recent: false,
}, 'New must establish a clean non-recent recovery baseline');
assert.equal(recentProjectRecord(recoveryBaseline), null,
  'untitled New projects must not enter Open Recent');
assert.deepEqual(get(recentProjects).map((project) => project.name), ['existing.paintty']);
assert.equal(get(recentProjectIdentity), null);
assert.equal(get(fileName), 'untitled');
assert.equal(get(dirty), false);
assert.deepEqual(get(dims), { w: 80, h: 24 });
assert.equal(get(fps), 24);
assert.equal(get(frames).length, 1);
assert.equal(get(activeFrameIndex), 0);
assert.equal(get(playheadTick), 0);
assert.equal(get(layers).length, 1);
assert.equal(get(activeLayerId), get(layers)[0].id);
assert.equal(get(activeLayerPart), 'layer');
assert.deepEqual([...get(selectedLayerIds)], [get(activeLayerId)]);
assert.equal(get(cellSelection).size, 0);
assert.equal(get(moveState), null);
assert.equal(get(canUndo), false);
assert.equal(get(canRedo), false);
assert.equal(getClipTimelineSelection().clipIds.size, 0);
assert.equal(getClipTimelineSelection().trackHeaderIds.size, 0);
assert.equal(get(activeTool), 'brush');
assert.equal(get(selectMode), 'new');
assert.equal(get(altEyedrop), false);
assert.equal(get(colorDepth), '256', 'preview color depth is an application setting');
assert.deepEqual(currentMediaRegistry(), { generation: 0, assets: [] });
assert.equal(get(mediaRuntimeStatus).size, 0);
assert.equal(mediaResourceManager.inspect().length, 0);
assert.equal(get(audioAssets).length, 0);
assert.equal(get(audioClips).length, 0);

let newTargetChoices = 0;
let newTargetWrites = 0;
await saveJSON({
  chooseTarget: async () => {
    newTargetChoices++;
    return { name: 'new.paintty', async write() { newTargetWrites++; } };
  },
  checkpoint: async () => {},
  notifySaved: async () => {},
});
assert.deepEqual({ staleTargetWrites, newTargetChoices, newTargetWrites }, {
  staleTargetWrites: 1,
  newTargetChoices: 1,
  newTargetWrites: 1,
}, 'New must clear the native save target before the next Save');

loadJSON(JSON.stringify(createBlankProject(defaultProjectDraft())));
assert.equal(applyProjectSettings({ columns: 100, rows: 40, baseFps: 30 }), true);
assert.deepEqual({ dimensions: get(dims), fps: get(fps) }, {
  dimensions: { w: 100, h: 40 }, fps: 30,
});
undo();
assert.deepEqual({ dimensions: get(dims), fps: get(fps) }, {
  dimensions: { w: 80, h: 24 }, fps: 24,
}, 'Project Settings must apply dimensions and FPS as one Undo step');
playing.set(true);
assert.equal(applyProjectSettings({ columns: 2, rows: 2, baseFps: 2 }), false);
assert.deepEqual({ dimensions: get(dims), fps: get(fps) }, {
  dimensions: { w: 80, h: 24 }, fps: 24,
}, 'Project Settings must be inert during playback');
playing.set(false);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const appSource = readSource('src/App.svelte');
const menuSource = readSource('src/components/MenuBar.svelte');
const newPopupSource = readSource('src/components/NewProjectPopup.svelte');
const projectSettingsSource = readSource('src/components/ProjectSettings.svelte');
const parameterSource = readSource('src/components/ProjectParameterFields.svelte');
const preferencesSource = readSource('src/components/Preferences.svelte');
const storesSource = readSource('src/lib/stores.js');
const mainSource = readSource('src/main.js');

assert.match(menuSource, /New project…/);
assert.match(menuSource, /onNewProject\(\)/);
assert.match(menuSource, /Project Settings…/);
assert.match(appSource, /onNewProject=\{\(\) => \(newProjectOpen = true\)\}/);
assert.match(appSource, /newProjectShortcutAction/);
assert.match(appSource, /gestureActive: pointerInputActive/);
assert.match(appSource, /topMenuOpen \|\| \$colorEditSession\.active \|\| !!get\(moveState\) \|\| !!get\(cropPending\)/);
assert.match(newPopupSource, /ProjectParameterFields/);
assert.match(projectSettingsSource, /ProjectParameterFields/);
assert.match(parameterSource, /PROJECT_PARAMETER_LIMITS\.columns/);
assert.match(parameterSource, /PROJECT_PARAMETER_LIMITS\.baseFps/);
assert.match(newPopupSource, /use:popupFocus/);
assert.match(newPopupSource, /cancelConfirmationButton\?\.focus/);
assert.doesNotMatch(newPopupSource, /trapModalFocus/);
assert.match(newPopupSource, /Delete preset\?/);
assert.match(newPopupSource, /pendingPresetDeletion\.name/,
  'the confirmation must identify the preset being deleted');
assert.match(newPopupSource, /function requestPresetDeletion\(\)[\s\S]*pendingPresetDeletion = \{/);
assert.doesNotMatch(
  newPopupSource.match(/function requestPresetDeletion\(\)[\s\S]*?\n  \}/)?.[0] || '',
  /deleteUserProjectPreset|applySettings|applyLastUsed/,
  'requesting deletion must not mutate or persist preset settings before confirmation',
);
assert.match(newPopupSource, /function confirmPresetDeletion\(\)[\s\S]*deleteUserProjectPreset/);
assert.match(newPopupSource,
  /function cancelConfirmation\(\)[\s\S]*pendingPresetDeletion = null;[\s\S]*deletePresetButton/,
  'Cancel and Escape must return from deletion confirmation to the preset editor');
assert.match(newPopupSource,
  /if \(confirmingCreate \|\| pendingPresetDeletion\)[\s\S]*cancelConfirmationButton\?\.focus/,
  'every confirmation state must explicitly focus Cancel');
assert.match(newPopupSource, /bind:this=\{deletePresetButton\}[\s\S]*onclick=\{requestPresetDeletion\}/);
assert.doesNotMatch(newPopupSource, /\b(?:alert|confirm|prompt)\s*\(/);
assert.doesNotMatch(preferencesSource, /Canvas size|Project timing|Base frame rate/);
assert.match(storesSource, /createColorDepthPreference\(\)/);
assert.match(menuSource, /import \{ colorDepth \} from '\.\.\/lib\/stores\.js'/);
assert.match(preferencesSource, /import \{ colorDepth \} from '\.\.\/lib\/stores\.js'/);
assert.match(mainSource, /installUniversalTabBlock\(\)/,
  'Tab remains globally inert while preset confirmation owns focus');

console.log('new project, preset, shortcut, lifecycle, and settings tests passed');
