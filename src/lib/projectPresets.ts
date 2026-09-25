import { assertUuid, isUuid, newUuid } from './uuid.js';
import { CURRENT_PROJECT_VERSION } from './projectFormat.js';
import type {
  ProjectDraft,
  ProjectPreset,
  ProjectPresetSettings,
  StorageLike,
  UnknownRecord,
} from './types/project-types.js';

export const PROJECT_PARAMETER_LIMITS = Object.freeze({
  columns: Object.freeze({ min: 1, max: 256 }),
  rows: Object.freeze({ min: 1, max: 256 }),
  baseFps: Object.freeze({ min: 1, max: 60 }),
});

export const DEFAULT_PROJECT_PRESET_ID = 'builtin:80x24-24';
export const PROJECT_PRESET_STORAGE_KEY = 'paintty-new-project-presets-v1';
export const PROJECT_PRESET_SETTINGS_VERSION = 1;

type ProjectParameter = keyof typeof PROJECT_PARAMETER_LIMITS;
type IdGenerator = (kind: string) => unknown;

interface ProjectPresetSaveOptions {
  makeId?: IdGenerator;
}

interface BlankProjectOptions {
  makeUuid?: IdGenerator;
}

function builtIn(
  id: string,
  name: string,
  columns: number,
  rows: number,
  baseFps: number,
): Readonly<ProjectPreset> {
  return Object.freeze({ id, name, columns, rows, baseFps, builtIn: true });
}

export const BUILT_IN_PROJECT_PRESETS = Object.freeze([
  builtIn(DEFAULT_PROJECT_PRESET_ID, '80x24 · 24 fps', 80, 24, 24),
  builtIn('builtin:80x50-24', '80x50 · 24 fps', 80, 50, 24),
  builtIn('builtin:132x43-24', '132x43 · 24 fps', 132, 43, 24),
]);

const DEFAULT_PRESET = BUILT_IN_PROJECT_PRESETS[0]!;
const MAX_PRESET_NAME_LENGTH = 64;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function draftFromPreset(preset: ProjectDraft): ProjectDraft {
  return {
    columns: preset['columns'],
    rows: preset['rows'],
    baseFps: preset['baseFps'],
  };
}

export function defaultProjectDraft(): ProjectDraft {
  return draftFromPreset(DEFAULT_PRESET);
}

function boundedInteger(value: unknown, field: ProjectParameter, label: string): number {
  const number = Number(value);
  const bounds = PROJECT_PARAMETER_LIMITS[field];
  if (!Number.isSafeInteger(number) || number < bounds.min || number > bounds.max) {
    throw new RangeError(`${label} must be an integer from ${bounds.min} to ${bounds.max}.`);
  }
  return number;
}

export function validateProjectDraft(value: unknown): ProjectDraft {
  if (!isRecord(value)) throw new TypeError('Project settings must be an object.');
  return {
    columns: boundedInteger(value['columns'], 'columns', 'Columns'),
    rows: boundedInteger(value['rows'], 'rows', 'Rows'),
    baseFps: boundedInteger(value['baseFps'], 'baseFps', 'Base FPS'),
  };
}

function validatedPresetName(value: unknown): string {
  const name = String(value ?? '').trim();
  if (!name) throw new Error('Preset name is required.');
  if (name.length > MAX_PRESET_NAME_LENGTH) {
    throw new Error(`Preset name must be ${MAX_PRESET_NAME_LENGTH} characters or fewer.`);
  }
  return name;
}

function presetNameKey(value: unknown): string {
  return String(value).trim().toLocaleLowerCase();
}

function defaultSettings(): ProjectPresetSettings {
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

function cloneSettings(settings: ProjectPresetSettings): ProjectPresetSettings {
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

function presetMap(settings: ProjectPresetSettings): Map<string, ProjectPreset> {
  return new Map<string, ProjectPreset>([
    ...BUILT_IN_PROJECT_PRESETS.map((preset) => [preset.id, preset] as const),
    ...settings.userPresets.map((preset) => [preset.id, preset] as const),
  ]);
}

export function normalizeProjectPresetSettings(value: unknown): ProjectPresetSettings {
  let source: unknown = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      return defaultSettings();
    }
  }
  if (!isRecord(source) || source['version'] !== PROJECT_PRESET_SETTINGS_VERSION) {
    return defaultSettings();
  }

  const userPresets: ProjectPreset[] = [];
  const ids = new Set<string>(BUILT_IN_PROJECT_PRESETS.map((preset) => preset.id));
  const names = new Set<string>(BUILT_IN_PROJECT_PRESETS.map((preset) => presetNameKey(preset.name)));
  for (const candidate of Array.isArray(source['userPresets']) ? source['userPresets'] : []) {
    try {
      if (!isRecord(candidate)) continue;
      const id = String(candidate['id'] || '');
      if (!id.startsWith('user:') || !isUuid(id.slice(5)) || ids.has(id)) continue;
      const name = validatedPresetName(candidate['name']);
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

  const lastUsedSource = isRecord(source['lastUsed']) ? source['lastUsed'] : {};
  const provisional = {
    version: PROJECT_PRESET_SETTINGS_VERSION,
    userPresets,
    defaultPresetId: String(source['defaultPresetId'] || ''),
    lastUsedPresetId: String(lastUsedSource['presetId'] || ''),
  };
  const settingsForMap: ProjectPresetSettings = {
    version: provisional.version,
    userPresets: provisional.userPresets,
    defaultPresetId: provisional.defaultPresetId,
    lastUsed: { presetId: provisional.lastUsedPresetId, draft: defaultProjectDraft() },
  };
  const presets = presetMap(settingsForMap);
  const defaultPresetId = presets.has(provisional.defaultPresetId)
    ? provisional.defaultPresetId
    : DEFAULT_PROJECT_PRESET_ID;
  const presetId = presets.has(provisional.lastUsedPresetId)
    ? provisional.lastUsedPresetId
    : defaultPresetId;
  let draft: ProjectDraft;
  try {
    draft = validateProjectDraft(lastUsedSource['draft']);
  } catch {
    draft = draftFromPreset(presets.get(presetId) ?? DEFAULT_PRESET);
  }
  return {
    version: PROJECT_PRESET_SETTINGS_VERSION,
    userPresets,
    defaultPresetId,
    lastUsed: { presetId, draft },
  };
}

export function allProjectPresets(settings: unknown): ProjectPreset[] {
  const normalized = normalizeProjectPresetSettings(settings);
  return [
    ...BUILT_IN_PROJECT_PRESETS,
    ...normalized.userPresets.map((preset) => ({ ...preset, builtIn: false })),
  ];
}

export function projectPresetById(settings: unknown, id: unknown): ProjectPreset | null {
  return allProjectPresets(settings).find((preset) => preset.id === id) || null;
}

function assertUniquePresetName(
  settings: ProjectPresetSettings,
  name: string,
  exceptId: string | null = null,
): void {
  const key = presetNameKey(name);
  if (allProjectPresets(settings).some((preset) => preset.id !== exceptId && presetNameKey(preset.name) === key)) {
    throw new Error('A preset with that name already exists.');
  }
}

function userPresetIndex(settings: ProjectPresetSettings, id: unknown): number {
  return settings.userPresets.findIndex((preset) => preset.id === id);
}

export function saveUserProjectPreset(
  settings: unknown,
  nameValue: unknown,
  draftValue: unknown,
  options: ProjectPresetSaveOptions = {},
): ProjectPresetSettings {
  const next = cloneSettings(normalizeProjectPresetSettings(settings));
  const name = validatedPresetName(nameValue);
  const draft = validateProjectDraft(draftValue);
  assertUniquePresetName(next, name);
  const makeId = options.makeId || (() => newUuid('preset'));
  let id: string | null = null;
  for (let attempt = 0; attempt < 100 && !id; attempt++) {
    const candidate = `user:${assertUuid(makeId('preset'), 'Preset ID')}`;
    if (!projectPresetById(next, candidate)) id = candidate;
  }
  if (!id) throw new Error('Could not allocate a unique preset ID.');
  next.userPresets.push({ id, name, ...draft });
  next.lastUsed = { presetId: id, draft: { ...draft } };
  return next;
}

export function renameUserProjectPreset(
  settings: unknown,
  id: string,
  nameValue: unknown,
): ProjectPresetSettings {
  const next = cloneSettings(normalizeProjectPresetSettings(settings));
  const index = userPresetIndex(next, id);
  if (index < 0) throw new Error('Built-in presets cannot be renamed.');
  const name = validatedPresetName(nameValue);
  assertUniquePresetName(next, name, id);
  next.userPresets[index] = { ...next.userPresets[index]!, name };
  return next;
}

export function deleteUserProjectPreset(settings: unknown, id: string): ProjectPresetSettings {
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

export function setDefaultProjectPreset(settings: unknown, id: string): ProjectPresetSettings {
  const next = cloneSettings(normalizeProjectPresetSettings(settings));
  if (!projectPresetById(next, id)) throw new Error('Choose an existing preset.');
  next.defaultPresetId = id;
  return next;
}

export function selectProjectPreset(settings: unknown, id: string): ProjectPresetSettings {
  const next = cloneSettings(normalizeProjectPresetSettings(settings));
  const preset = projectPresetById(next, id);
  if (!preset) throw new Error('Choose an existing preset.');
  next.lastUsed = { presetId: id, draft: draftFromPreset(preset) };
  return next;
}

export function rememberProjectDraft(
  settings: unknown,
  draftValue: unknown,
  presetId: string | null = null,
): ProjectPresetSettings {
  const next = cloneSettings(normalizeProjectPresetSettings(settings));
  const requestedId = presetId || next.lastUsed.presetId;
  next.lastUsed = {
    presetId: projectPresetById(next, requestedId) ? requestedId : next.defaultPresetId,
    draft: validateProjectDraft(draftValue),
  };
  return next;
}

export function resetProjectDraftToDefault(settings: unknown): ProjectPresetSettings {
  const next = cloneSettings(normalizeProjectPresetSettings(settings));
  const preset = projectPresetById(next, next.defaultPresetId) || DEFAULT_PRESET;
  next.lastUsed = { presetId: preset.id, draft: draftFromPreset(preset) };
  return next;
}

function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function loadProjectPresetSettings(
  storage: StorageLike | null = browserStorage(),
): ProjectPresetSettings {
  try {
    return normalizeProjectPresetSettings(storage?.getItem?.(PROJECT_PRESET_STORAGE_KEY));
  } catch {
    return defaultSettings();
  }
}

export function persistProjectPresetSettings(
  settings: unknown,
  storage: StorageLike | null = browserStorage(),
): ProjectPresetSettings {
  const normalized = normalizeProjectPresetSettings(settings);
  storage?.setItem?.(PROJECT_PRESET_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

function uniqueProjectIds(makeUuid: IdGenerator): {
  projectId: string;
  layerId: string;
  trackId: string;
  clipId: string;
} {
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

export function createBlankProject(
  draftValue: unknown = defaultProjectDraft(),
  options: BlankProjectOptions = {},
) {
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
