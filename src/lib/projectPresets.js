import { assertUuid, isUuid, newUuid } from './uuid.js';
import { CURRENT_PROJECT_VERSION } from './projectFormat.js';

export const PROJECT_PARAMETER_LIMITS = Object.freeze({
  columns: Object.freeze({ min: 1, max: 256 }),
  rows: Object.freeze({ min: 1, max: 256 }),
  baseFps: Object.freeze({ min: 1, max: 60 }),
});

export const DEFAULT_PROJECT_PRESET_ID = 'builtin:80x24-24';
export const PROJECT_PRESET_STORAGE_KEY = 'paintty-new-project-presets-v1';
export const PROJECT_PRESET_SETTINGS_VERSION = 1;

function builtIn(id, name, columns, rows, baseFps) {
  return Object.freeze({ id, name, columns, rows, baseFps, builtIn: true });
}

export const BUILT_IN_PROJECT_PRESETS = Object.freeze([
  builtIn(DEFAULT_PROJECT_PRESET_ID, '80x24 · 24 fps', 80, 24, 24),
  builtIn('builtin:80x50-24', '80x50 · 24 fps', 80, 50, 24),
  builtIn('builtin:132x43-24', '132x43 · 24 fps', 132, 43, 24),
]);

const DEFAULT_PRESET = BUILT_IN_PROJECT_PRESETS[0];
const MAX_PRESET_NAME_LENGTH = 64;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function draftFromPreset(preset) {
  return {
    columns: preset.columns,
    rows: preset.rows,
    baseFps: preset.baseFps,
  };
}

export function defaultProjectDraft() {
  return draftFromPreset(DEFAULT_PRESET);
}

function boundedInteger(value, field, label) {
  const number = Number(value);
  const bounds = PROJECT_PARAMETER_LIMITS[field];
  if (!Number.isSafeInteger(number) || number < bounds.min || number > bounds.max) {
    throw new RangeError(`${label} must be an integer from ${bounds.min} to ${bounds.max}.`);
  }
  return number;
}

export function validateProjectDraft(value) {
  if (!isRecord(value)) throw new TypeError('Project settings must be an object.');
  return {
    columns: boundedInteger(value.columns, 'columns', 'Columns'),
    rows: boundedInteger(value.rows, 'rows', 'Rows'),
    baseFps: boundedInteger(value.baseFps, 'baseFps', 'Base FPS'),
  };
}

function validatedPresetName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw new Error('Preset name is required.');
  if (name.length > MAX_PRESET_NAME_LENGTH) {
    throw new Error(`Preset name must be ${MAX_PRESET_NAME_LENGTH} characters or fewer.`);
  }
  return name;
}

function presetNameKey(value) {
  return String(value).trim().toLocaleLowerCase();
}

function defaultSettings() {
  return {
    version: PROJECT_PRESET_SETTINGS_VERSION,
    userPresets: [],
    defaultPresetId: DEFAULT_PROJECT_PRESET_ID,
    lastUsed: {
      presetId: DEFAULT_PROJECT_PRESET_ID,
      draft: defaultProjectDraft(),
    },
  };
}

function cloneSettings(settings) {
  return {
    version: PROJECT_PRESET_SETTINGS_VERSION,
    userPresets: settings.userPresets.map((preset) => ({ ...preset })),
    defaultPresetId: settings.defaultPresetId,
    lastUsed: {
      presetId: settings.lastUsed.presetId,
      draft: { ...settings.lastUsed.draft },
    },
  };
}

function presetMap(settings) {
  return new Map([
    ...BUILT_IN_PROJECT_PRESETS.map((preset) => [preset.id, preset]),
    ...settings.userPresets.map((preset) => [preset.id, preset]),
  ]);
}

export function normalizeProjectPresetSettings(value) {
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      return defaultSettings();
    }
  }
  if (!isRecord(source) || source.version !== PROJECT_PRESET_SETTINGS_VERSION) {
    return defaultSettings();
  }

  const userPresets = [];
  const ids = new Set(BUILT_IN_PROJECT_PRESETS.map((preset) => preset.id));
  const names = new Set(BUILT_IN_PROJECT_PRESETS.map((preset) => presetNameKey(preset.name)));
  for (const candidate of Array.isArray(source.userPresets) ? source.userPresets : []) {
    try {
      if (!isRecord(candidate)) continue;
      const id = String(candidate.id || '');
      if (!id.startsWith('user:') || !isUuid(id.slice(5)) || ids.has(id)) continue;
      const name = validatedPresetName(candidate.name);
      const nameKey = presetNameKey(name);
      if (names.has(nameKey)) continue;
      const draft = validateProjectDraft(candidate);
      ids.add(id);
      names.add(nameKey);
      userPresets.push({ id, name, ...draft });
    } catch {
      // Keep valid settings even when one persisted user preset is malformed.
    }
  }

  const settings = {
    version: PROJECT_PRESET_SETTINGS_VERSION,
    userPresets,
    defaultPresetId: String(source.defaultPresetId || ''),
    lastUsed: {
      presetId: String(source.lastUsed?.presetId || ''),
      draft: null,
    },
  };
  const presets = presetMap(settings);
  if (!presets.has(settings.defaultPresetId)) settings.defaultPresetId = DEFAULT_PROJECT_PRESET_ID;
  if (!presets.has(settings.lastUsed.presetId)) settings.lastUsed.presetId = settings.defaultPresetId;
  try {
    settings.lastUsed.draft = validateProjectDraft(source.lastUsed?.draft);
  } catch {
    settings.lastUsed.draft = draftFromPreset(presets.get(settings.lastUsed.presetId));
  }
  return settings;
}

export function allProjectPresets(settings) {
  const normalized = normalizeProjectPresetSettings(settings);
  return [
    ...BUILT_IN_PROJECT_PRESETS,
    ...normalized.userPresets.map((preset) => ({ ...preset, builtIn: false })),
  ];
}

export function projectPresetById(settings, id) {
  return allProjectPresets(settings).find((preset) => preset.id === id) || null;
}

function assertUniquePresetName(settings, name, exceptId = null) {
  const key = presetNameKey(name);
  if (allProjectPresets(settings).some((preset) => preset.id !== exceptId && presetNameKey(preset.name) === key)) {
    throw new Error('A preset with that name already exists.');
  }
}

function userPresetIndex(settings, id) {
  return settings.userPresets.findIndex((preset) => preset.id === id);
}

export function saveUserProjectPreset(settings, nameValue, draftValue, options = {}) {
  const next = cloneSettings(normalizeProjectPresetSettings(settings));
  const name = validatedPresetName(nameValue);
  const draft = validateProjectDraft(draftValue);
  assertUniquePresetName(next, name);
  const makeId = options.makeId || (() => newUuid('preset'));
  let id = null;
  for (let attempt = 0; attempt < 100 && !id; attempt++) {
    const candidate = `user:${assertUuid(makeId('preset'), 'Preset ID')}`;
    if (!projectPresetById(next, candidate)) id = candidate;
  }
  if (!id) throw new Error('Could not allocate a unique preset ID.');
  next.userPresets.push({ id, name, ...draft });
  next.lastUsed = { presetId: id, draft: { ...draft } };
  return next;
}

export function renameUserProjectPreset(settings, id, nameValue) {
  const next = cloneSettings(normalizeProjectPresetSettings(settings));
  const index = userPresetIndex(next, id);
  if (index < 0) throw new Error('Built-in presets cannot be renamed.');
  const name = validatedPresetName(nameValue);
  assertUniquePresetName(next, name, id);
  next.userPresets[index] = { ...next.userPresets[index], name };
  return next;
}

export function deleteUserProjectPreset(settings, id) {
  const next = cloneSettings(normalizeProjectPresetSettings(settings));
  const index = userPresetIndex(next, id);
  if (index < 0) throw new Error('Built-in presets cannot be deleted.');
  next.userPresets.splice(index, 1);
  if (next.defaultPresetId === id) next.defaultPresetId = DEFAULT_PROJECT_PRESET_ID;
  if (next.lastUsed.presetId === id) {
    const fallback = presetMap(next).get(next.defaultPresetId) || DEFAULT_PRESET;
    next.lastUsed = { presetId: fallback.id, draft: draftFromPreset(fallback) };
  }
  return next;
}

export function setDefaultProjectPreset(settings, id) {
  const next = cloneSettings(normalizeProjectPresetSettings(settings));
  if (!projectPresetById(next, id)) throw new Error('Choose an existing preset.');
  next.defaultPresetId = id;
  return next;
}

export function selectProjectPreset(settings, id) {
  const next = cloneSettings(normalizeProjectPresetSettings(settings));
  const preset = projectPresetById(next, id);
  if (!preset) throw new Error('Choose an existing preset.');
  next.lastUsed = { presetId: id, draft: draftFromPreset(preset) };
  return next;
}

export function rememberProjectDraft(settings, draftValue, presetId = null) {
  const next = cloneSettings(normalizeProjectPresetSettings(settings));
  const requestedId = presetId || next.lastUsed.presetId;
  next.lastUsed = {
    presetId: projectPresetById(next, requestedId) ? requestedId : next.defaultPresetId,
    draft: validateProjectDraft(draftValue),
  };
  return next;
}

export function resetProjectDraftToDefault(settings) {
  const next = cloneSettings(normalizeProjectPresetSettings(settings));
  const preset = projectPresetById(next, next.defaultPresetId) || DEFAULT_PRESET;
  next.lastUsed = { presetId: preset.id, draft: draftFromPreset(preset) };
  return next;
}

function browserStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function loadProjectPresetSettings(storage = browserStorage()) {
  try {
    return normalizeProjectPresetSettings(storage?.getItem?.(PROJECT_PRESET_STORAGE_KEY));
  } catch {
    return defaultSettings();
  }
}

export function persistProjectPresetSettings(settings, storage = browserStorage()) {
  const normalized = normalizeProjectPresetSettings(settings);
  storage?.setItem?.(PROJECT_PRESET_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

function uniqueProjectIds(makeUuid) {
  const ids = {
    projectId: assertUuid(makeUuid('project'), 'Generated project UUID'),
    layerId: assertUuid(makeUuid('layer'), 'Generated layer UUID'),
    trackId: assertUuid(makeUuid('track'), 'Generated track UUID'),
    clipId: assertUuid(makeUuid('clip'), 'Generated clip UUID'),
  };
  if (new Set(Object.values(ids).map((id) => id.toLowerCase())).size !== 4) {
    throw new Error('New project entity UUIDs must be unique.');
  }
  return ids;
}

export function createBlankProject(draftValue = defaultProjectDraft(), options = {}) {
  const { columns, rows, baseFps } = validateProjectDraft(draftValue);
  const makeUuid = options.makeUuid || ((kind) => newUuid(kind));
  const { projectId, layerId, trackId, clipId } = uniqueProjectIds(makeUuid);
  return {
    format: 'paintty-sprite',
    version: CURRENT_PROJECT_VERSION,
    projectId,
    width: columns,
    height: rows,
    fps: baseFps,
    timeline: {
      tags: [],
      tracks: [{
        id: trackId,
        kind: 'visual',
        locked: false,
        layer: {
          id: layerId,
          name: 'Layer 1',
          type: 'cell',
          visible: true,
          cells: {},
          offset: { x: 0, y: 0 },
        },
      }],
      clips: [{
        id: clipId,
        trackId,
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
  };
}
