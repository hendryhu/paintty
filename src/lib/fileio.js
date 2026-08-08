import { get } from 'svelte/store';
import {
  layers, GRID_W, GRID_H, dims, applyBlinkPhase, resetEditorStateForProjectLoad,
  authoredRevision, registerHistoryContributor,
} from './grid.js';
import { cmFromGrid } from './cellmap.js';
import { normalizeTextRuns } from './textLayer.js';
import { notifyError, notifyInfo } from './notifications.js';
import { normalizeTemporalEase } from './temporalEasing.js';
import { normalizeShapePathKey } from './shapePath.js';
import {
  activeFrameIndex,
  canonicalTimelineStateForSave,
  frames,
  loadCanonicalTimeline,
  fps,
  DEFAULT_FPS,
  compositeFrameCells,
  createTimelineFrameSource,
} from './frames.js';
import { moveState, selectMode } from './selection.js';
import { activeTool, altEyedrop, fileName, dirty } from './stores.js';
import { canvasFont } from './font.js';
import {
  createRecentProjectId,
  recentProjectIdentity,
} from './recentProjects.js';
import { normalizeVideoClip, releaseVideoSource as disposeVideoSource } from './video.js';
import { normalizeOutputGrid, paintOutputGrid } from './outputGrid.js';
import {
  audioAssets, audioClips, audioStateForSave, audioTracks, decodeAudioSource, normalizeAudioClip,
} from './audio.js';
import {
  audibleTimelineAudioAssetIds, createTimelineAudioPlan, encodeTimelineAudio,
  encodeTimelineWav, estimateAnimationAudioExportResources, preflightAacEncoder,
  validateDecodedAnimationAudioExportResources,
} from './audioExport.js';
import { decodeProjectArchive, encodeProjectArchive } from './projectArchive.js';
import { getProjectAsset, putProjectAssets, withMediaLease } from './projectAssets.js';
import {
  captureMediaRegistry,
  installMediaRegistryHistory,
  loadMediaRegistry,
  normalizeMediaRegistry,
  serializeMediaRegistry,
} from './mediaRegistry.js';
import { scheduleMediaCacheGc } from './mediaGc.js';
import {
  accountAnimationVisualFrame, createAnimationDocumentAssembler, encodeAnimationZip,
  estimateAnimationVisualExportResources, planAnimationExport, serializeAnimationJSON,
  validateAnimationVisualJsonResources,
} from './animationExport.js';
import {
  frameToAnsiText,
  frameToBashCommand,
  frameToPowerShellCommand as renderPowerShellCommand,
} from './terminalCopy.js';
import {
  advanceProjectRevision,
  captureProjectRevision,
  isProjectRevisionCurrent,
  notifyProjectCheckpoint,
  notifyProjectLoaded,
  notifyProjectReplaced,
  notifyProjectSaved,
} from './documentLifecycle.js';
import { projectId, replaceProjectId } from './projectIdentity.js';
import { assertUuid, uuidKey } from './uuid.js';
import {
  assertCanonicalClipTimelineState,
  getClipTimelineState,
} from './clipTimelineState.js';
import { CURRENT_PROJECT_VERSION } from './projectFormat.js';
import {
  clipTimelineDurationTicks,
  resolveClipTimelineLayers,
} from './clipTimelineResolver.js';
import {
  normalizeTimelineTags,
  runtimeTimelineTags,
  validateTimelineTagRange,
} from './timelineTags.js';
import {
  exportOutputSpec,
  normalizeExportFilename,
  pickExportFileTarget,
} from './exportDestination.js';

installMediaRegistryHistory(registerHistoryContributor);

function serializeMask(mask) {
  const serialized = {
    defaultStrength: mask.defaultStrength ?? 1,
    cells: mask.cells || {},
    offset: {
      x: Math.round(Number(mask.offset?.x) || 0),
      y: Math.round(Number(mask.offset?.y) || 0),
    },
  };
  if ('opacity' in mask) serialized.opacity = mask.opacity;
  return serialized;
}

function serializeEffectLayer(layer) {
  const serialized = { effect: layer.effect };
  if (layer.clipped) serialized.clipped = true;
  if (layer.mask) serialized.mask = serializeMask(layer.mask);
  return serialized;
}
function serializeLayerMeta(l) {
  return {
    id: l.id, name: l.name, type: l.type, visible: l.visible,
    ...(l.type === 'text' ? { text: l.text, box: l.box, wrap: l.wrap, fg: l.fg, runs: l.runs } : {}),
    ...(l.type === 'shape' ? { shape: l.shape } : {}),
    ...(l.type === 'effect' ? serializeEffectLayer(l) : {}),
    ...(l.type === 'image' ? { transform: l.transform, assetId: l.assetId } : {}),
    ...(l.type === 'video' ? { transform: l.transform, assetId: l.assetId } : {}),
    ...(l.groupId != null ? { groupId: l.groupId } : {}),
    ...(l.type === 'group' ? { collapsed: !!l.collapsed } : {}),
    ...(l.type !== 'group' && l.type !== 'effect' && l.opacity != null && l.opacity !== 1 ? { opacity: l.opacity } : {}),
    ...(l.blink ? { blink: true } : {}),
  };
}

function serializableDtoValue(value, label, seen = new WeakSet()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain finite numbers.`);
    return value;
  }
  if (typeof value !== 'object') throw new TypeError(`${label} contains a runtime value.`);
  if (seen.has(value)) throw new TypeError(`${label} must not contain cycles.`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} contains a runtime resource.`);
  }
  seen.add(value);
  const result = Array.isArray(value) ? [] : {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    result[key] = serializableDtoValue(entry, `${label}.${key}`, seen);
  }
  seen.delete(value);
  return result;
}

function serializableCanonicalLayer(layer, label) {
  return {
    ...serializableDtoValue(serializeLayerMeta(layer), label),
    cells: serializableDtoValue(layer?.cells || {}, `${label}.cells`),
    offset: {
      x: Math.round(Number(layer?.offset?.x) || 0),
      y: Math.round(Number(layer?.offset?.y) || 0),
    },
  };
}

function serializableCanonicalPayload(value, label) {
  const output = {};
  for (const field of [
    'cells', 'text', 'box', 'wrap', 'fg', 'runs', 'shape', 'mask',
  ]) {
    if (value && Object.prototype.hasOwnProperty.call(value, field) && value[field] !== undefined) {
      output[field] = serializableDtoValue(value[field], `${label}.${field}`);
    }
  }
  if (!Object.keys(output).length && value != null) {
    throw new TypeError(`${label} is not a canonical frame payload.`);
  }
  return output;
}

function serializableCanonicalKeys(keys, label, valueSerializer = serializableDtoValue) {
  return (keys || []).map((key, index) => ({
    tick: key.tick,
    value: valueSerializer(key.value, `${label}[${index}].value`),
  }));
}

function serializableCanonicalProperties(properties, label) {
  return Object.fromEntries(Object.entries(properties || {}).map(([name, keys]) => [
    name,
    serializableCanonicalKeys(keys, `${label}.${name}`),
  ]));
}

export function canonicalTimelineDto(state) {
  const tracks = (state?.tracks || []).map((track, index) => {
    const visual = track.kind !== 'audio';
    const output = {
      id: track.id,
      kind: track.kind,
      locked: !!track.locked,
      ...(!visual ? { name: track.name } : {}),
      ...(track.parentTrackId != null ? { parentTrackId: track.parentTrackId } : {}),
      ...(track.shapePathKind != null ? { shapePathKind: track.shapePathKind } : {}),
      ...(Array.isArray(track.shapePathComponents) ? {
        shapePathComponents: [...track.shapePathComponents],
      } : {}),
      ...(track.layer ? {
        layer: serializableCanonicalLayer(track.layer, `Canonical track ${index + 1} layer`),
      } : {}),
      ...(Object.keys(track.propertyTracks || {}).length ? {
        propertyTracks: serializableCanonicalProperties(
          track.propertyTracks,
          `Canonical track ${index + 1} properties`,
        ),
      } : {}),
    };
    if (Number.isFinite(Number(track.volume))) output.volume = Number(track.volume);
    if (track.muted) output.muted = true;
    return output;
  });
  const clips = (state?.clips || []).map((clip, index) => {
    const output = {
      id: clip.id,
      trackId: clip.trackId,
      kind: clip.kind,
      startTick: clip.startTick,
      inTick: clip.inTick,
      outTick: clip.outTick,
      sourceDuration: clip.sourceDuration,
      frameKeys: serializableCanonicalKeys(
        clip.frameKeys,
        `Canonical clip ${index + 1} frames`,
        serializableCanonicalPayload,
      ),
      propertyTracks: serializableCanonicalProperties(
        clip.propertyTracks,
        `Canonical clip ${index + 1} properties`,
      ),
    };
    for (const field of [
      'assetId', 'inPoint', 'outPoint', 'playbackRate', 'volume', 'muted', 'name',
    ]) {
      if (clip[field] !== undefined) output[field] = clip[field];
    }
    return output;
  });
  return {
    tracks,
    clips,
    tags: normalizeTimelineTags(state?.tags, { allowMissing: true }),
  };
}

function serializableProject(mediaSnapshot = captureMediaRegistry()) {
  const canonical = canonicalTimelineDto(canonicalTimelineStateForSave());
  return {
    format: 'paintty-sprite',
    version: CURRENT_PROJECT_VERSION,
    projectId: get(projectId),
    width: GRID_W,
    height: GRID_H,
    fps: get(fps),
    timeline: canonical,
    media: serializeMediaRegistry(mediaSnapshot),
  };
}

export function serializeJSON(mediaSnapshot) {
  return JSON.stringify(serializableProject(mediaSnapshot));
}

export function serializeRecoverySnapshot() {
  const project = serializableProject();
  // Preserve panel state in recovery contents but exclude it from content-change deduplication.
  const contents = JSON.stringify(project);
  for (const track of project.timeline.tracks) {
    if (track.layer?.type === 'group') delete track.layer.collapsed;
  }
  return { contents, contentKey: JSON.stringify(project) };
}

function serializePreviewLayer(layer) {
  return {
    ...serializeLayerMeta(layer),
    cells: serializableDtoValue(layer?.cells || {}, 'Preview layer cells'),
    offset: {
      x: Math.round(Number(layer?.offset?.x) || 0),
      y: Math.round(Number(layer?.offset?.y) || 0),
    },
  };
}

export function serializeLivePreview() {
  const source = createTimelineFrameSource();
  return JSON.stringify({
    format: 'paintty-preview',
    version: 1,
    width: GRID_W,
    height: GRID_H,
    fps: get(fps),
    tags: runtimeTimelineTags(getClipTimelineState().tags, source.frameCount),
    ticks: Array.from({ length: source.frameCount }, (_, tick) => ({
      layers: source.resolve(tick).layers.map(serializePreviewLayer),
    })),
  });
}

function currentOutputGrid() {
  const { w, h } = get(dims);
  const frame = get(frames)[get(activeFrameIndex)] || { layers: [] };
  return compositeFrameCells(frame, w, h, null, 0, 0, { referenceOpacity: false });
}

export function serializeTXT() {
  const { w, h } = get(dims);
  const g = normalizeOutputGrid(currentOutputGrid(), w, h);
  return g.map((row) => row.map((cell) => (
    cell?.cont ? '' : cell?.c || ' '
  )).join('')).join('\n');
}

export async function copyAsText() {
  try { await navigator.clipboard.writeText(serializeTXT()); return true; }
  catch { return false; }
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 5000);
}

export function releaseVideoSource(source) {
  disposeVideoSource(source);
}

let projectSaveTarget = null;
let latestOpenRequest = 0;
const projectSaveQueues = new Map();

// Queue saves per project revision so repeated writes stay ordered while replacements invalidate old work.
function queueProjectSave(revision, operation) {
  const previous = projectSaveQueues.get(revision) || Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const tail = result.catch(() => {});
  projectSaveQueues.set(revision, tail);
  tail.finally(() => {
    if (projectSaveQueues.get(revision) === tail) projectSaveQueues.delete(revision);
  });
  return result;
}

function extensionOf(filename) {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot) : '';
}

export async function chooseSaveTarget(filename, type, description, { signal } = {}) {
  throwIfAborted(signal);
  const selected = await pickExportFileTarget(filename, {
    extension: extensionOf(filename),
    mime: type,
    description,
  }, { signal });
  if (selected !== undefined) return selected;
  throwIfAborted(signal);
  return {
    name: filename,
    durable: false,
    async write(blob, { signal: writeSignal = signal } = {}) {
      throwIfAborted(writeSignal);
      downloadBlob(filename, blob);
      throwIfAborted(writeSignal);
    },
  };
}

async function saveText(filename, text, type, description, options = {}) {
  const { signal, chooseTarget = chooseSaveTarget } = options;
  throwIfAborted(signal);
  const blob = new Blob([text], { type });
  const target = await abortable(
    chooseTarget(filename, type, description, { signal }),
    signal,
  );
  throwIfAborted(signal);
  if (!target) return false;
  await abortable(target.write(blob, { signal }), signal);
  throwIfAborted(signal);
  return target;
}

async function withMediaLeases(hashes, operation, index = 0) {
  if (index >= hashes.length) return operation();
  return withMediaLease(hashes[index], () => withMediaLeases(hashes, operation, index + 1));
}

// Lease every captured hash before reading any blob so GC cannot remove bytes from
// an archive while it is being assembled.
async function encodeRegistrySnapshot(contents, registry) {
  const hashes = [...new Set(registry.assets.map((asset) => asset.hash))];
  return withMediaLeases(hashes, async () => {
    const mediaBlobs = new Map();
    for (const asset of registry.assets) {
      if (mediaBlobs.has(asset.hash)) continue;
      const record = await getProjectAsset(asset.hash);
      if (!record?.blob) throw new Error(`Media bytes are missing for ${asset.sourceName}.`);
      mediaBlobs.set(asset.hash, record.blob);
    }
    return encodeProjectArchive({ document: contents, mediaRegistry: registry, mediaBlobs });
  });
}

export async function saveJSON({
  saveAs = false,
  chooseTarget = chooseSaveTarget,
  serialize = serializeJSON,
  checkpoint = notifyProjectCheckpoint,
  notifySaved = notifyProjectSaved,
  reportRecoveryError = (error) => console.warn('Recovery could not record the saved project.', error),
  reportUnverifiedSave = () => notifyInfo('Download created; project remains unsaved.'),
} = {}) {
  const revision = captureProjectRevision();
  const name = get(fileName) || 'untitled';
  const packaged = serialize === serializeJSON && (saveAs || !/\.json$/i.test(name));
  // Freeze document text and media metadata before entering the per-revision queue;
  // later edits cannot change the bytes represented by this save.
  const mediaSnapshot = packaged ? captureMediaRegistry() : null;
  const contents = mediaSnapshot ? serialize(mediaSnapshot) : serialize();
  const blobPromise = packaged
    ? encodeRegistrySnapshot(contents, mediaSnapshot)
    : Promise.resolve(new Blob([contents], { type: 'application/json' }));
  const checkpointResult = Promise.resolve()
    .then(() => checkpoint({ contents, fileName: name }))
    .then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
  return queueProjectSave(revision, async () => {
    const checkpointStatus = await checkpointResult;
    if (!checkpointStatus.ok) reportRecoveryError(checkpointStatus.error);
    if (!isProjectRevisionCurrent(revision)) return false;
    const target = !saveAs && projectSaveTarget
      ? projectSaveTarget
      : await chooseTarget(
         packaged
           ? `${name.replace(/\.(?:paintty|json)$/i, '') || 'untitled'}.paintty`
           : (/\.json$/i.test(name) ? name : `${name}.json`),
         packaged ? 'application/zip' : 'application/json',
         packaged ? 'Paintty project' : 'Paintty JSON project',
      );
    if (!target) return false;
    if (!isProjectRevisionCurrent(revision)) return false;
    await target.write(await blobPromise);
    if (!isProjectRevisionCurrent(revision)) return true;
    if (target.durable === false) {
      // A browser download cannot prove durable completion, so it never clears dirty state.
      reportUnverifiedSave();
      return true;
    }
    projectSaveTarget = target;
    fileName.set(target.name);
    let currentContents = null;
    try { currentContents = serialize(); } catch {}
    const unchanged = currentContents === contents;
    dirty.set(!unchanged);
    try {
      let recentId = saveAs ? null : get(recentProjectIdentity);
      if (!recentId) {
        recentId = createRecentProjectId();
        recentProjectIdentity.set(recentId);
      }
      await notifySaved({ contents, currentContents, fileName: target.name, recentId });
    } catch (error) {
      reportRecoveryError(error);
    }
    scheduleMediaCacheGc();
    return true;
  });
}

export function saveJSONAs(options = {}) {
  return saveJSON({ ...options, saveAs: true });
}

export async function exportTXT(options = {}) {
  throwIfAborted(options.signal);
  const name = (get(fileName) || 'untitled').replace(/\.json$/i, '');
  const filename = normalizeExportFilename(options.filename ?? name, '.txt', name);
  return !!(await saveText(filename, serializeTXT(), 'text/plain', 'Text', options));
}

export async function exportANSI(options = {}) {
  throwIfAborted(options.signal);
  const name = (get(fileName) || 'untitled').replace(/\.json$/i, '');
  const filename = normalizeExportFilename(options.filename ?? name, '.ans', name);
  return !!(await saveText(filename, frameToAnsi(), 'text/plain', 'ANSI text', options));
}

export async function exportJSON(download = false) {
  if (!download) return saveJSONAs();
  const name = (get(fileName) || 'untitled').replace(/\.json$/i, '');
  const filename = `${name}.json`;
  downloadBlob(filename, new Blob([serializeJSON()], { type: 'application/json' }));
  return true;
}

export function currentAnimationExportPlan({ includeAudio = false } = {}) {
  const audioState = audioStateForSave();
  const registry = captureMediaRegistry();
  const durationTicks = clipTimelineDurationTicks(getClipTimelineState());
  const captured = capturedAudibleAudioAssets(audioState.tracks, registry, {
    durationTicks,
    fps: Math.max(1, Number(get(fps)) || DEFAULT_FPS),
  });
  return planAnimationExport({
    fileName: get(fileName),
    includeAudio,
    hasAudio: captured.length > 0,
    audioCount: captured.length,
  });
}

function capturedAudibleAudioAssets(tracks, registry, {
  durationTicks,
  fps: rate,
  runtimeAssets = [],
} = {}) {
  const registryAudio = registry.assets
    .filter((asset) => asset.kind === 'audio')
    .map((asset) => ({ ...asset, id: asset.assetId }));
  const audible = audibleTimelineAudioAssetIds({
    assets: registryAudio,
    tracks,
    durationTicks,
    fps: rate,
  });
  const runtimeById = new Map(runtimeAssets.map((asset) => [String(asset.id), asset]));
  return registry.assets
    .filter((asset) => asset.kind === 'audio' && audible.has(String(asset.assetId)))
    .map((asset) => {
      const runtime = runtimeById.get(String(asset.assetId));
      const key = `${asset.assetId}:${asset.hash}:${asset.generation}`;
      const buffer = runtime?.buffer &&
        (!runtime.runtimeMediaKey || runtime.runtimeMediaKey === key)
        ? runtime.buffer
        : null;
      return {
        id: asset.assetId,
        size: asset.size,
        duration: asset.duration,
        hash: asset.hash,
        generation: asset.generation,
        buffer,
      };
    });
}

// Capture durable state and enforce memory bounds before resolving every visual frame.
function prepareAnimationExport({ includeAudio, filename }, dependencies = {}) {
  const size = get(dims);
  const dimensions = { w: size.w, h: size.h };
  const rate = Math.max(1, Number(get(fps)) || DEFAULT_FPS);
  const timelineState = getClipTimelineState();
  const initialDurationTicks = clipTimelineDurationTicks(timelineState);
  const estimateVisualResources = dependencies.estimateVisualResources ||
    estimateAnimationVisualExportResources;
  let visualResources = estimateVisualResources({
    frameCount: initialDurationTicks,
    columns: dimensions.w,
    rows: dimensions.h,
  });
  const audioState = audioStateForSave();
  const mediaSnapshot = captureMediaRegistry();
  const audioAssetSnapshots = includeAudio ? capturedAudibleAudioAssets(
    audioState.tracks,
    mediaSnapshot,
    {
      durationTicks: initialDurationTicks,
      fps: rate,
      runtimeAssets: get(audioAssets),
    },
  ) : [];
  const estimateResources = dependencies.estimateAudioResources ||
    estimateAnimationAudioExportResources;
  let resources = audioAssetSnapshots.length ? estimateResources({
    assets: audioAssetSnapshots,
    durationTicks: initialDurationTicks,
    fps: rate,
  }) : null;
  const createFrameSource = dependencies.createFrameSource || createTimelineFrameSource;
  const source = createFrameSource();
  if (source.frameCount !== initialDurationTicks) {
    visualResources = estimateVisualResources({
      frameCount: source.frameCount,
      columns: dimensions.w,
      rows: dimensions.h,
    });
  }
  if (resources && source.frameCount !== initialDurationTicks) {
    resources = estimateResources({
      assets: audioAssetSnapshots,
      durationTicks: source.frameCount,
      fps: rate,
    });
  }
  const plan = planAnimationExport({
    fileName: filename ?? get(fileName),
    includeAudio,
    hasAudio: audioAssetSnapshots.length > 0,
    audioCount: audioAssetSnapshots.length,
  });
  const tags = timelineState.tags.map((tag) => ({ ...tag }));
  return Object.freeze({
    filename: filename ?? get(fileName),
    plan,
    source,
    resources,
    visualResources,
    dimensions,
    fps: rate,
    durationTicks: source.frameCount,
    tags,
    includeAudio: !!includeAudio,
    audioTracks: audioState.tracks,
    audioAssets: audioAssetSnapshots,
    hashes: [...new Set(audioAssetSnapshots.map((asset) => asset.hash))],
  });
}

async function resolveAnimationVisuals(snapshot, dependencies = {}) {
  const { signal, onProgress = () => {} } = dependencies;
  const yieldControl = dependencies.visualYieldControl || defaultYield;
  const yieldInterval = Math.max(1, Math.round(Number(dependencies.visualYieldInterval)) || 8);
  const composite = dependencies.compositeAnimationFrame || compositeFrameCells;
  const createAssembler = dependencies.createAnimationAssembler || createAnimationDocumentAssembler;
  const accountFrame = dependencies.accountVisualFrame || accountAnimationVisualFrame;
  const validateJson = dependencies.validateVisualJson || validateAnimationVisualJsonResources;
  const frames = [];
  let assembler = null;
  let resources = snapshot.visualResources;
  onProgress({ completed: 0, total: snapshot.source.frameCount, phase: 'resolving-animation' });
  for (let index = 0; index < snapshot.source.frameCount; index++) {
    throwIfAborted(signal);
    const resolved = snapshot.source.resolve(index);
    throwIfAborted(signal);
    const compositeCells = composite(
      resolved,
      snapshot.dimensions.w,
      snapshot.dimensions.h,
    );
    assembler ||= createAssembler({
      dimensions: snapshot.dimensions,
      fps: snapshot.fps,
      frames: [resolved],
      layerMetadata: resolved?.layers || [],
    });
    const runtimeFrame = assembler.frame(
      resolved,
      index,
      snapshot.source.frameCount,
      compositeCells,
    );
    resources = accountFrame(resources, runtimeFrame);
    frames.push(runtimeFrame);
    onProgress({
      completed: index + 1,
      total: snapshot.source.frameCount,
      phase: 'resolving-animation',
    });
    if ((index + 1) % yieldInterval === 0 && index + 1 < snapshot.source.frameCount) {
      await abortable(yieldControl(), signal);
    }
  }
  resources = validateJson(resources, { layers: assembler.layers, tags: snapshot.tags });
  return { assembler, frames, resources };
}

const pendingAnimationAudioDecodes = new Map();

function capturedAudioDecodeKey(asset) {
  return `${asset.hash}:${asset.generation}`;
}

function sharedAnimationAudioDecode(asset, blob, decodeAudio) {
  const key = capturedAudioDecodeKey(asset);
  const existing = pendingAnimationAudioDecodes.get(key);
  if (existing) return existing;
  const pending = Promise.resolve().then(() => decodeAudio(blob, { asset }));
  pendingAnimationAudioDecodes.set(key, pending);
  const release = () => {
    if (pendingAnimationAudioDecodes.get(key) === pending) {
      pendingAnimationAudioDecodes.delete(key);
    }
  };
  pending.then(release, release);
  return pending;
}

async function resolveCapturedAudioBuffers(assets, { signal, getAsset, decodeAudio }) {
  const buffers = new Map();
  for (const asset of assets) {
    const key = capturedAudioDecodeKey(asset);
    if (asset.buffer && !buffers.has(key)) buffers.set(key, asset.buffer);
  }
  for (const asset of assets) {
    const key = capturedAudioDecodeKey(asset);
    if (buffers.has(key)) continue;
    throwIfAborted(signal);
    const record = await abortable(getAsset(asset.hash), signal);
    throwIfAborted(signal);
    if (!record?.blob) throw new Error('Captured Animation audio bytes are missing.');
    if (record.hash !== asset.hash || record.blob.size !== asset.size) {
      throw new Error('Captured Animation audio bytes changed before decoding.');
    }
    const pendingDecode = sharedAnimationAudioDecode(asset, record.blob, decodeAudio);
    const decoded = await abortable(pendingDecode, signal);
    throwIfAborted(signal);
    const buffer = decoded?.buffer ?? decoded;
    if (!buffer || !Number.isFinite(Number(buffer.duration)) || Number(buffer.duration) <= 0) {
      throw new Error('Animation audio decoding did not return a valid PCM buffer.');
    }
    buffers.set(key, buffer);
  }
  return assets.map((asset) => ({
    id: asset.id,
    hash: asset.hash,
    generation: asset.generation,
    size: asset.size,
    buffer: buffers.get(capturedAudioDecodeKey(asset)),
  }));
}

async function acquireReferencedAudioRuntime() {
  const { acquireMediaResource } = await import('./mediaRuntime.js');
  const leases = new Map();
  const assetIds = new Set(get(audioClips).map((clip) => clip.assetId));
  await Promise.all([...assetIds].map(async (assetId) => {
    try {
      leases.set(assetId, await acquireMediaResource(assetId));
    } catch {}
  }));
  return {
    assets: get(audioAssets).map((asset) => ({
      ...asset,
      buffer: leases.get(asset.id)?.value?.buffer || asset.buffer || null,
    })),
    release() {
      for (const lease of leases.values()) lease.release();
      leases.clear();
    },
  };
}

export async function exportAnimation(options = {}) {
  const {
    includeAudio = false,
    filename,
    download = false,
    chooseTarget = chooseSaveTarget,
    getAsset = getProjectAsset,
    signal,
  } = options;
  throwIfAborted(signal);
  const snapshot = prepareAnimationExport({ includeAudio, filename }, options);
  throwIfAborted(signal);
  let pendingTarget = null;
  if (!download) {
    // Invoke the selector in the original click turn so the native picker retains user activation.
    pendingTarget = Promise.resolve(chooseTarget(
      snapshot.plan.filename,
      snapshot.plan.mime,
      snapshot.plan.description,
      { signal },
    ));
  }
  return withMediaLeases(snapshot.hashes, async () => {
    const target = download ? null : await abortable(pendingTarget, signal);
    throwIfAborted(signal);
    if (!download && !target) return false;
    const visual = await resolveAnimationVisuals(snapshot, options);
    throwIfAborted(signal);
    const decodeAudio = options.decodeAudio || decodeAudioSource;
    const runtimeAudio = snapshot.audioAssets.length
      ? await resolveCapturedAudioBuffers(snapshot.audioAssets, { signal, getAsset, decodeAudio })
      : [];
    throwIfAborted(signal);
    if (runtimeAudio.length) {
      const validateResources = options.validateDecodedAudioResources ||
        validateDecodedAnimationAudioExportResources;
      validateResources({
        assets: runtimeAudio,
        numberOfFrames: snapshot.resources.numberOfFrames,
      });
    }
    const createAudioPlan = options.createAudioPlan || createTimelineAudioPlan;
    const audioPlan = runtimeAudio.length ? createAudioPlan({
      assets: runtimeAudio,
      tracks: snapshot.audioTracks,
      durationTicks: snapshot.durationTicks,
      fps: snapshot.fps,
      exactDuration: true,
    }) : null;
    if (snapshot.plan.includeAudio && !audioPlan) {
      throw new Error('Captured audible Animation audio could not be mixed.');
    }
    if (audioPlan && audioPlan.numberOfFrames !== snapshot.resources.numberOfFrames) {
      throw new Error('Animation audio duration changed after resource preflight.');
    }
    const encodeWav = options.encodeTimelineWav || encodeTimelineWav;
    const audioBytes = audioPlan
      ? await encodeWav(audioPlan, options)
      : null;
    throwIfAborted(signal);
    const document = visual.assembler.document(visual.frames, {
      tags: snapshot.tags,
      exportPlan: snapshot.plan,
      ...(audioPlan && audioBytes ? { audio: { durationUs: audioPlan.durationUs } } : {}),
    });
    const json = serializeAnimationJSON(document);
    const blob = snapshot.plan.kind === 'zip'
      ? await encodeAnimationZip({
        plan: snapshot.plan,
        json,
        audioBytes,
        output: 'blob',
        signal,
        yieldControl: options.zipYieldControl,
      })
      : new Blob([json], { type: 'application/json' });
    throwIfAborted(signal);
    if (download) {
      downloadBlob(snapshot.plan.filename, blob);
      throwIfAborted(signal);
      return true;
    }
    await abortable(target.write(blob, { signal }), signal);
    throwIfAborted(signal);
    return true;
  });
}

export function frameToAnsi() {
  return frameToAnsiText(currentOutputGrid());
}

export function frameToTerminalCommand() {
  return frameToBashCommand(currentOutputGrid());
}

function frameToPowerShellCommand() {
  return renderPowerShellCommand(currentOutputGrid());
}

export async function copyForTerminal() {
  try { await navigator.clipboard.writeText(frameToTerminalCommand()); return true; }
  catch { return false; }
}
export async function copyForPowerShell() {
  try { await navigator.clipboard.writeText(frameToPowerShellCommand()); return true; }
  catch { return false; }
}

async function renderImageSnapshot(snapshot, { format, type, createCanvas, signal }) {
  throwIfAborted(signal);
  const { cells, width, height, cellWidth, cellHeight, font } = snapshot;
  const canvas = createCanvas();
  canvas.width = width * cellWidth;
  canvas.height = height * cellHeight;
  const ctx = canvas.getContext('2d');
  if (format === 'jpg' || format === 'jpeg') {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(cellHeight * 0.9)}px ${font}`;
  paintOutputGrid(ctx, cells, width, height, cellWidth, cellHeight);
  const blob = await abortable(new Promise((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error('Could not encode image.')),
    type,
    0.92,
  )), signal);
  throwIfAborted(signal);
  return blob;
}

export async function saveAsImage(format = 'png', cellPx = 16, dependencies = {}) {
  const { signal } = dependencies;
  throwIfAborted(signal);
  const normalizedFormat = format === 'jpeg' ? 'jpg' : format;
  const spec = exportOutputSpec(normalizedFormat);
  const type = spec.mime;
  const name = (get(fileName) || 'untitled').replace(/\.json$/i, '');
  const filename = normalizeExportFilename(dependencies.filename ?? name, spec.extension, name);
  const size = get(dims);
  // Rendering and picker work are asynchronous, so capture cells, geometry, and font first.
  const snapshot = {
    cells: normalizeOutputGrid(currentOutputGrid(), size.w, size.h),
    width: size.w,
    height: size.h,
    cellWidth: cellPx,
    cellHeight: cellPx * 2,
    font: get(canvasFont),
  };
  const chooseTarget = dependencies.chooseTarget || chooseSaveTarget;
  const render = dependencies.render || renderImageSnapshot;
  const download = dependencies.download === true;
  const pendingTarget = download ? null : Promise.resolve(chooseTarget(
    filename,
    type,
    spec.description,
    { signal },
  ));
  const target = download ? null : await abortable(pendingTarget, signal);
  throwIfAborted(signal);
  if (!download && !target) return false;
  const blob = await abortable(Promise.resolve().then(() => render(snapshot, {
    format,
    type,
    createCanvas: dependencies.createCanvas || (() => document.createElement('canvas')),
    signal,
  })), signal);
  throwIfAborted(signal);
  if (download) {
    downloadBlob(filename, blob);
    throwIfAborted(signal);
    return true;
  }
  await abortable(target.write(blob, { signal }), signal);
  throwIfAborted(signal);
  return true;
}

function paintFrameToCtx(ctx, cells, w, h, cw, ch, font) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, ctx.canvas?.width || w * cw, ctx.canvas?.height || h * ch);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(ch * 0.9)}px ${font}`;
  paintOutputGrid(ctx, cells, w, h, cw, ch);
}

export function videoFramePlan(frameDefs, frameRate) {
  const rate = Math.max(1, Number(frameRate) || DEFAULT_FPS);
  const duration = 1 / rate;
  const plan = [];
  let outputIndex = 0;
  for (let sourceIndex = 0; sourceIndex < frameDefs.length; sourceIndex++) {
    const frame = frameDefs[sourceIndex];
    const ticks = Math.max(1, frame.hold || 1);
    for (let tick = 0; tick < ticks; tick++) {
      plan.push({
        sourceIndex,
        tick,
        timestamp: outputIndex / rate,
        duration,
      });
      outputIndex++;
    }
  }
  return plan;
}

export function videoFrameCells(frame, w, h, timestamp = 0) {
  const blinkVisible = Math.floor(Math.max(0, timestamp) * 2) % 2 === 0;
  const cells = compositeFrameCells(frame, w, h, null, 0, 0, { referenceOpacity: false });
  return applyBlinkPhase(normalizeOutputGrid(cells, w, h), blinkVisible);
}

export const MP4_EXPORT_FORMAT = Object.freeze({
  label: 'MP4',
  extension: 'mp4',
  mime: 'video/mp4',
  pickerMime: 'video/mp4',
  description: 'MP4 video',
});

export function videoRenderGeometry(width, height, cellPx) {
  let cellWidth = Math.max(1, Math.round(Number(cellPx) || 16));
  if (cellWidth % 2) cellWidth++;
  const cellHeight = cellWidth * 2;
  return {
    width: Math.max(1, Math.round(Number(width) || 1)),
    height: Math.max(1, Math.round(Number(height) || 1)),
    cellWidth,
    cellHeight,
  };
}

const H264_CODEC = 'avc1.420028';
const VIDEO_BITRATE = 8_000_000;

export function selectVideoExportFormat({
  VideoEncoderClass = globalThis.VideoEncoder,
  VideoFrameClass = globalThis.VideoFrame,
  createFrameImage = globalThis.createImageBitmap,
} = {}) {
  const hasWebCodecs = typeof VideoEncoderClass === 'function'
    && typeof VideoFrameClass === 'function'
    && typeof VideoEncoderClass.isConfigSupported === 'function'
    && typeof createFrameImage === 'function';
  return hasWebCodecs ? MP4_EXPORT_FORMAT : null;
}

function h264EncoderConfig(width, height, rate) {
  return {
    codec: H264_CODEC,
    width,
    height,
    bitrate: VIDEO_BITRATE,
    framerate: rate,
    latencyMode: 'realtime',
    avc: { format: 'avc' },
  };
}

function copyBytes(source) {
  if (source instanceof Uint8Array) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  }
  return new Uint8Array(source);
}

function encodedTicks(plan, rate) {
  return plan.map((sample, outputIndex) => {
    const timestamp = Math.round(outputIndex * 1_000_000 / rate);
    const end = Math.round((outputIndex + 1) * 1_000_000 / rate);
    return { ...sample, timestamp, duration: end - timestamp };
  });
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  if (typeof DOMException === 'function') return new DOMException('Export cancelled.', 'AbortError');
  const error = new Error('Export cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortable(promise, signal) {
  const pending = Promise.resolve(promise);
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      callback(value);
    };
    const cancel = () => finish(reject, abortError(signal));
    signal.addEventListener('abort', cancel, { once: true });
    pending.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) cancel();
  });
}

function defaultYield() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function createImmutableFrameImage(canvas, createFrameImage, signal) {
  const pending = Promise.resolve().then(() => createFrameImage(canvas));
  let image = null;
  try {
    image = await abortable(pending, signal);
    throwIfAborted(signal);
    return image;
  } catch (error) {
    if (image) image.close?.();
    else if (signal?.aborted) pending.then((value) => value?.close?.()).catch(() => {});
    throw error;
  }
}

async function waitForEncoderCapacity(encoder, signal, yieldControl, outputError, limit = 8) {
  while (encoder.encodeQueueSize >= limit) {
    await abortable(yieldControl(), signal);
    throwIfAborted(signal);
    const error = outputError();
    if (error) throw error;
  }
}

function unsupportedH264(message) {
  const error = new Error(message);
  error.code = 'H264_UNSUPPORTED';
  return error;
}

async function loadH264Muxer() {
  const { muxH264Mp4 } = await import('./mp4.js');
  return muxH264Mp4;
}

async function preflightH264Encoder(canvas, rate, {
  VideoEncoderClass = globalThis.VideoEncoder,
  VideoFrameClass = globalThis.VideoFrame,
  createFrameImage = globalThis.createImageBitmap,
} = {}) {
  if (typeof VideoEncoderClass !== 'function' || typeof VideoFrameClass !== 'function') {
    throw unsupportedH264('This browser does not provide WebCodecs H.264 encoding.');
  }
  if (typeof VideoEncoderClass.isConfigSupported !== 'function') {
    throw unsupportedH264('This browser cannot check H.264 encoder support.');
  }
  if (typeof createFrameImage !== 'function') {
    throw unsupportedH264('This browser cannot create stable video frame snapshots.');
  }

  const config = h264EncoderConfig(canvas.width, canvas.height, rate);
  const support = await VideoEncoderClass.isConfigSupported(config);
  if (!support?.supported) {
    throw unsupportedH264('This browser does not support H.264 MP4 encoding at this size.');
  }
  return { VideoEncoderClass, VideoFrameClass, createFrameImage, config };
}

async function encodeVideoWithSupportedH264({
  canvas,
  ctx,
  frameDefs,
  resolveFrame,
  plan,
  width,
  height,
  cellWidth,
  cellHeight,
  font,
  rate,
  audioPlan,
}, dependencies = {}, {
  VideoEncoderClass,
  VideoFrameClass,
  createFrameImage,
  config,
}) {
  const {
    mux,
    loadMux = loadH264Muxer,
    signal,
    onProgress = () => {},
    yieldControl = defaultYield,
  } = dependencies;
  const ticks = encodedTicks(plan, rate);
  const samples = [];
  let avcDecoderConfig = null;
  let outputError = null;
  let encoderClosed = false;
  throwIfAborted(signal);
  const encoder = new VideoEncoderClass({
    output(chunk, metadata) {
      const expected = ticks[samples.length];
      if (!expected) {
        outputError ||= new Error('The H.264 encoder produced extra frames.');
        return;
      }
      if (chunk.timestamp !== expected.timestamp) {
        outputError ||= new Error('The H.264 encoder returned frames out of order.');
      }
      if (chunk.duration != null && chunk.duration !== expected.duration) {
        outputError ||= new Error('The H.264 encoder changed a frame duration.');
      }
      if (!avcDecoderConfig && metadata?.decoderConfig?.description) {
        avcDecoderConfig = copyBytes(metadata.decoderConfig.description);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, key: chunk.type === 'key' });
    },
    error(error) {
      outputError ||= error instanceof Error ? error : new Error(String(error));
    },
  });

  const closeEncoder = () => {
    if (encoderClosed) return;
    encoderClosed = true;
    try { encoder.close?.(); } catch {}
  };
  const cancelEncoding = () => closeEncoder();
  signal?.addEventListener('abort', cancelEncoding, { once: true });

  let activeSourceIndex = -1;
  let activeFrame = null;
  try {
    encoder.configure(config);
    onProgress({ completed: 0, total: ticks.length, phase: 'rendering' });
    for (let outputIndex = 0; outputIndex < ticks.length; outputIndex++) {
      throwIfAborted(signal);
      const tick = ticks[outputIndex];
      if (tick.sourceIndex !== activeSourceIndex) {
        activeFrame = resolveFrame
          ? resolveFrame(tick.sourceIndex)
          : frameDefs[tick.sourceIndex];
        activeSourceIndex = tick.sourceIndex;
      }
      const cells = videoFrameCells(activeFrame, width, height, tick.timestamp / 1_000_000);
      paintFrameToCtx(ctx, cells, width, height, cellWidth, cellHeight, font);
      const frameImage = await createImmutableFrameImage(canvas, createFrameImage, signal);
      let videoFrame = null;
      try {
        if (outputError) throw outputError;
        videoFrame = new VideoFrameClass(frameImage, {
          timestamp: tick.timestamp,
          duration: tick.duration,
        });
        encoder.encode(videoFrame, { keyFrame: outputIndex % rate === 0 });
      } finally {
        videoFrame?.close();
        frameImage?.close?.();
      }
      await waitForEncoderCapacity(encoder, signal, yieldControl, () => outputError);
      if (outputError) throw outputError;
      onProgress({ completed: outputIndex + 1, total: ticks.length, phase: 'rendering' });
      if ((outputIndex + 1) % 8 === 0 && outputIndex + 1 < ticks.length) {
        await abortable(yieldControl(), signal);
      }
    }
    activeFrame = null;
    throwIfAborted(signal);
    await abortable(encoder.flush(), signal);
  } finally {
    activeFrame = null;
    signal?.removeEventListener('abort', cancelEncoding);
    closeEncoder();
  }

  throwIfAborted(signal);
  if (outputError) throw outputError;
  if (samples.length !== ticks.length) {
    throw new Error('The H.264 encoder produced ' + samples.length + ' of ' + ticks.length + ' frames.');
  }
  if (!avcDecoderConfig?.length) {
    throw new Error('The H.264 encoder did not provide an AVC decoder configuration.');
  }
  let audio = null;
  if (audioPlan) {
    const encodeAudioTrack = dependencies.encodeTimelineAudio || encodeTimelineAudio;
    audio = await encodeAudioTrack(audioPlan, dependencies, dependencies.audioPreflight);
    throwIfAborted(signal);
  }
  const muxVideo = mux || await loadMux();
  throwIfAborted(signal);
  const muxArgs = {
    samples,
    avcDecoderConfig,
    width: canvas.width,
    height: canvas.height,
    timescale: rate,
    ...(audio ? { audio } : {}),
  };
  const output = muxVideo(muxArgs);
  throwIfAborted(signal);
  return output;
}

export async function encodeVideoWithWebCodecs(args, dependencies = {}) {
  throwIfAborted(dependencies.signal);
  const preflight = await preflightH264Encoder(args.canvas, args.rate, dependencies);
  throwIfAborted(dependencies.signal);
  return encodeVideoWithSupportedH264(args, dependencies, preflight);
}

export async function exportVideo(cellPx = 16, download = false, dependencies = {}) {
  const { signal } = dependencies;
  throwIfAborted(signal);
  const format = MP4_EXPORT_FORMAT;
  const name = (get(fileName) || 'untitled').replace(/\.json$/i, '');
  const filename = normalizeExportFilename(
    dependencies.filename ?? name,
    `.${format.extension}`,
    name,
  );
  const geometry = videoRenderGeometry(get(dims).w, get(dims).h, cellPx);
  const { width, height, cellWidth, cellHeight } = geometry;
  const font = get(canvasFont);
  const rate = Math.max(1, Math.round(Number(get(fps)) || DEFAULT_FPS));
  const createFrameSource = dependencies.createFrameSource || createTimelineFrameSource;
  const frameSource = createFrameSource();
  const frameDefs = frameSource.holds.map((hold) => ({ hold }));
  const plan = videoFramePlan(frameDefs, rate);
  const suppliedAudioState = typeof dependencies.getAudioState === 'function'
    ? dependencies.getAudioState()
    : dependencies.audioState;
  const audioState = typeof suppliedAudioState === 'function'
    ? suppliedAudioState()
    : suppliedAudioState;
  const hasSuppliedAudioState = audioState != null;
  const chooseTarget = dependencies.chooseTarget || chooseSaveTarget;
  const pendingTarget = download ? null : Promise.resolve(chooseTarget(
    filename,
    format.pickerMime,
    format.description,
    { signal },
  ));
  const target = download ? null : await abortable(pendingTarget, signal);
  throwIfAborted(signal);
  if (!download && !target) return false;
  const audioRuntime = hasSuppliedAudioState
    ? { assets: audioState.assets ?? [], release() {} }
    : await acquireReferencedAudioRuntime();
  try {
    const planAudio = dependencies.createAudioPlan || createTimelineAudioPlan;
    const audioPlan = planAudio({
      assets: audioRuntime.assets,
      tracks: hasSuppliedAudioState ? audioState.tracks ?? [] : get(audioTracks),
      clips: hasSuppliedAudioState ? audioState.clips : get(audioClips),
      durationTicks: plan.length,
      fps: rate,
    });
    const canvas = dependencies.createCanvas?.() || document.createElement('canvas');
    canvas.width = width * cellWidth;
    canvas.height = height * cellHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create the MP4 render canvas.');
    const preflight = await (dependencies.preflight || preflightH264Encoder)(
      canvas,
      rate,
      dependencies,
    );
    throwIfAborted(signal);
    let audioPreflight = null;
    if (audioPlan) {
      audioPreflight = dependencies.preflightAudio
        ? await dependencies.preflightAudio(audioPlan, dependencies)
        : await preflightAacEncoder(dependencies);
      throwIfAborted(signal);
    }

    const args = {
      canvas,
      ctx,
      frameDefs,
      resolveFrame: frameSource.resolve,
      plan,
      width,
      height,
      cellWidth,
      cellHeight,
      font,
      rate,
      audioPlan,
    };
    let output;
    try {
      const encodeVideo = dependencies.encodeVideo || encodeVideoWithSupportedH264;
      const encodeDependencies = audioPlan
        ? { ...dependencies, audioPreflight }
        : dependencies;
      output = await encodeVideo(args, encodeDependencies, preflight);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw abortError(signal);
      if (error?.code === 'H264_UNSUPPORTED' || error?.code === 'AAC_UNSUPPORTED') throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`H.264 MP4 encoding failed before the file was saved: ${detail}`, { cause: error });
    }

    throwIfAborted(signal);
    dependencies.onProgress?.({
      completed: plan.length,
      total: plan.length,
      phase: 'saving',
    });
    const blob = new Blob([output], { type: format.mime });
    if (download) downloadBlob(filename, blob);
    else await target.write(blob, { signal });
    throwIfAborted(signal);
    return true;
  } finally {
    audioRuntime.release();
  }
}
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordOrEmpty(value, label) {
  if (value == null) return {};
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function validateCell(cell, label) {
  if (cell == null) return;
  if (!isRecord(cell)) throw new Error(`${label} must be a cell object`);
}

function validateCellKey(key, label) {
  if (!/^-?\d+,-?\d+$/.test(key)) throw new Error(`${label} has an invalid cell position`);
  const [x, y] = key.split(',').map(Number);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new Error(`${label} has an invalid cell position`);
  }
}

function normalizeCells(src, overflow, label = 'Layer cells') {
  const extra = recordOrEmpty(overflow, `${label} overflow`);
  if (Array.isArray(src)) {
    src.forEach((row, y) => {
      if (row == null) return;
      if (!Array.isArray(row)) throw new Error(`${label} row ${y} must be an array`);
      row.forEach((cell, x) => validateCell(cell, `${label} at ${x},${y}`));
    });
    for (const [key, cell] of Object.entries(extra)) {
      validateCellKey(key, `${label} overflow`);
      validateCell(cell, `${label} overflow at ${key}`);
    }
    return cmFromGrid(src, extra);
  }
  const source = recordOrEmpty(src, label);
  const cells = {};
  for (const [key, cell] of Object.entries(source)) {
    validateCellKey(key, label);
    validateCell(cell, `${label} at ${key}`);
    if (cell != null) cells[key] = { ...cell };
  }
  return cells;
}

function normalizeOptionalRecord(value, label) {
  if (value == null) return value;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return { ...value };
}

function normalizeMask(mask, label) {
  if (!isRecord(mask)) throw new Error(`${label} must be an object`);
  const offset = normalizeOptionalRecord(mask.offset, `${label} offset`) || {};
  const normalized = {
    defaultStrength: mask.defaultStrength ?? 1,
    cells: normalizeCells(mask.cells, null, `${label} cells`),
    offset: {
      x: Math.round(Number(offset.x) || 0),
      y: Math.round(Number(offset.y) || 0),
    },
  };
  if ('opacity' in mask) {
    normalized.opacity = Math.max(0, Math.min(1, Number(mask.opacity)));
  }
  return normalized;
}

function normalizeEffectLayer(layer, label) {
  return {
    effect: normalizeOptionalRecord(layer.effect, `${label} effect`)
      || { kind: 'brightness', intensity: 0.25 },
    clipped: !!layer.clipped,
    ...(layer.mask ? { mask: normalizeMask(layer.mask, `${label} mask`) } : {}),
  };
}

function normalizeMediaTransform(layer, width, height) {
  if (layer.type !== 'image' && layer.type !== 'video') return layer;
  const transform = layer.transform || {};
  const numberOr = (value, fallback) => {
    if (value == null) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  const scale = numberOr(transform.scale, 1);
  return {
    ...layer,
    transform: {
      ...transform,
      x: numberOr(transform.x, width / 2),
      y: numberOr(transform.y, height / 2),
      rot: numberOr(transform.rot, 0),
      ...(transform.scale != null || (transform.scaleX == null && transform.scaleY == null)
        ? { scale }
        : {}),
      ...(transform.scaleX != null ? { scaleX: numberOr(transform.scaleX, scale) } : {}),
      ...(transform.scaleY != null ? { scaleY: numberOr(transform.scaleY, scale) } : {}),
    },
  };
}

const VIDEO_PLACEMENT_FIELDS = new Set([
  'assetId', 'startTick', 'inPoint', 'outPoint', 'playbackRate',
]);

function normalizeVideoPlacement(value, label) {
  const placement = normalizeOptionalRecord(value, label) || {};
  assertOnlyKeys(placement, VIDEO_PLACEMENT_FIELDS, label);
  return placement;
}

function normalizeLayer(l, label = 'Layer') {
  if (!isRecord(l)) throw new Error(`${label} must be an object`);
  const id = assertUuid(l.id, `${label} ID`);
  const type = l.type || 'cell';
  if (typeof type !== 'string') throw new Error(`${label} type must be text`);
  const text = typeof l.text === 'string' ? l.text : '';
  const fg = typeof l.fg === 'string' ? l.fg : '#ffffff';
  const box = normalizeOptionalRecord(l.box, `${label} text box`);
  const runs = type === 'text' ? normalizeTextRuns(l.runs, text, fg) : l.runs;
  const videoPlacement = type === 'video'
    ? normalizeVideoPlacement(l.video, `${label} video`)
    : null;
  return {
    id, name: typeof l.name === 'string' ? l.name : 'layer',
    type, visible: l.visible !== false,
    cells: normalizeCells(l.cells, l.overflow, `${label} cells`),
    text: type === 'text' ? text : l.text,
    box,
    wrap: type === 'text' ? l.wrap !== false : l.wrap,
    fg: type === 'text' ? fg : l.fg,
    runs,
    shape: normalizeOptionalRecord(l.shape, `${label} shape`),
    offset: normalizeOptionalRecord(l.offset, `${label} offset`),
    transform: normalizeOptionalRecord(l.transform, `${label} transform`),
    assetId: type === 'image' ? l.assetId : undefined,
    videoClip: type === 'video'
      ? normalizeVideoClip(videoPlacement)
      : normalizeOptionalRecord(l.video, `${label} video`),
    videoPlacement: type === 'video' ? videoPlacement : undefined,
    groupId: l.groupId, collapsed: l.collapsed, blink: l.blink,
    ...(type === 'effect' ? normalizeEffectLayer(l, label) : {}),
    ...(type !== 'group' && type !== 'effect' && l.opacity != null ? { opacity: l.opacity } : {}),
  };
}

const POSITION_INTERPOLATIONS = new Set(['linear', 'ease-in', 'ease-out', 'ease-in-out']);

function boundedInteger(value, fallback, label, min, max) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value || {})) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

const CANONICAL_LAYER_FIELDS = new Set([
  'id', 'name', 'type', 'visible', 'cells', 'offset', 'text', 'box', 'wrap', 'fg', 'runs',
  'shape', 'effect', 'clipped', 'mask', 'transform', 'assetId', 'groupId', 'collapsed',
  'opacity', 'blink',
]);
const CANONICAL_PAYLOAD_FIELDS = new Set([
  'cells', 'text', 'box', 'wrap', 'fg', 'runs', 'shape', 'mask',
]);
const CANONICAL_TRACK_FIELDS = new Set([
  'id', 'kind', 'name', 'locked', 'parentTrackId', 'layer',
  'propertyTracks', 'volume', 'muted', 'shapePathKind', 'shapePathComponents',
]);
const CANONICAL_CLIP_FIELDS = new Set([
  'id', 'trackId', 'kind', 'startTick', 'inTick', 'outTick',
  'sourceDuration', 'frameKeys', 'propertyTracks', 'assetId', 'inPoint', 'outPoint',
  'playbackRate', 'volume', 'muted', 'name',
]);
const CANONICAL_PROPERTY_NAMES = new Set([
  'position', 'visibility', 'effectIntensity', 'maskOpacity', 'maskPosition',
  'shapePath', 'shapeAnchorCompensation',
]);
function normalizeCanonicalLayer(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertOnlyKeys(value, CANONICAL_LAYER_FIELDS, label);
  const normalized = normalizeLayer(value.type === 'video'
    ? { ...value, video: { assetId: value.assetId } }
    : value, label);
  normalized.offset = {
    x: Math.round(Number(value.offset?.x) || 0),
    y: Math.round(Number(value.offset?.y) || 0),
  };
  if (value.type === 'video') {
    normalized.assetId = value.assetId;
    delete normalized.videoClip;
    delete normalized.videoPlacement;
  }
  return normalized;
}

function normalizeCanonicalPayload(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertOnlyKeys(value, CANONICAL_PAYLOAD_FIELDS, label);
  const payload = serializableDtoValue(value, label);
  if (Object.prototype.hasOwnProperty.call(value, 'cells')) {
    payload.cells = normalizeCells(value.cells, null, `${label} cells`);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'offset')) {
    if (!isRecord(value.offset)) throw new Error(`${label} offset must be an object`);
    payload.offset = {
      x: Math.round(Number(value.offset.x) || 0),
      y: Math.round(Number(value.offset.y) || 0),
    };
  }
  if (Object.prototype.hasOwnProperty.call(value, 'mask') && value.mask != null) {
    payload.mask = normalizeMask(value.mask, `${label} mask`);
  }
  return payload;
}

function normalizeCanonicalKeys(source, label, normalizeValue) {
  if (!Array.isArray(source)) throw new Error(`${label} must be an array`);
  let previous = -1;
  return source.map((key, index) => {
    const keyLabel = `${label} key ${index + 1}`;
    if (!isRecord(key)) throw new Error(`${keyLabel} must be an object`);
    assertOnlyKeys(key, new Set(['tick', 'value']), keyLabel);
    if (!Number.isSafeInteger(key.tick) || key.tick < 0 || key.tick <= previous) {
      throw new Error(`${label} ticks must be unique and strictly increasing`);
    }
    if (!Object.prototype.hasOwnProperty.call(key, 'value')) {
      throw new Error(`${keyLabel} must contain a value`);
    }
    previous = key.tick;
    const value = normalizeValue(key.value, `${keyLabel} value`);
    return { tick: key.tick, value };
  });
}

function normalizeCanonicalProperties(source, label, shapeKind = null) {
  const properties = recordOrEmpty(source, label);
  return Object.fromEntries(Object.entries(properties).map(([name, keys]) => {
    if (!CANONICAL_PROPERTY_NAMES.has(name)) {
      throw new Error(`${label} contains unsupported property ${name || '(empty)'}`);
    }
    const normalizeValue = (value, valueLabel) => {
      if (name === 'shapeAnchorCompensation') {
        if (!isRecord(value) || typeof value.x !== 'number' || typeof value.y !== 'number' ||
          !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
          throw new Error(`${valueLabel} must contain finite x/y numbers`);
        }
        const interpolation = POSITION_INTERPOLATIONS.has(value.interpolation)
          ? value.interpolation
          : null;
        const temporalEase = normalizeTemporalEase(value.temporalEase);
        return {
          x: value.x,
          y: value.y,
          ...(interpolation ? { interpolation } : {}),
          ...(temporalEase ? { temporalEase } : {}),
        };
      }
      if (name === 'position' || name === 'maskPosition') {
        if (!isRecord(value)) throw new Error(`${valueLabel} must be an object`);
        if (!Number.isInteger(value.x) || !Number.isInteger(value.y)) {
          throw new Error(`${valueLabel} must contain integer x/y values`);
        }
        const interpolation = POSITION_INTERPOLATIONS.has(value.interpolation)
          ? value.interpolation
          : null;
        const temporalEase = normalizeTemporalEase(value.temporalEase);
        return {
          x: value.x,
          y: value.y,
          ...(interpolation ? { interpolation } : {}),
          ...(temporalEase ? { temporalEase } : {}),
        };
      }
      if (name === 'visibility') {
        if (typeof value !== 'boolean') throw new Error(`${valueLabel} must be boolean`);
        return value;
      }
      if (name === 'effectIntensity' || name === 'maskOpacity') {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error(`${valueLabel} must be finite`);
        const min = name === 'effectIntensity' ? -1 : 0;
        if (number < min || number > 1) throw new Error(`${valueLabel} is outside its range`);
        return number;
      }
      if (name === 'shapePath') {
        if (!isRecord(value)) throw new Error(`${valueLabel} must be an object`);
        const envelope = Object.prototype.hasOwnProperty.call(value, 'path') ||
          Object.prototype.hasOwnProperty.call(value, 'components');
        const path = envelope ? value.path : value;
        if (path != null && !normalizeShapePathKey(path, shapeKind || undefined)) {
          throw new Error(`${valueLabel} has invalid shape geometry`);
        }
        if (envelope) {
          assertOnlyKeys(value, new Set(['path', 'components']), valueLabel);
          if (value.components != null && !isRecord(value.components)) {
            throw new Error(`${valueLabel} components must be an object`);
          }
          for (const [componentId, component] of Object.entries(value.components || {})) {
            if (!componentId || !isRecord(component)) {
              throw new Error(`${valueLabel} has an invalid shape component`);
            }
            const raw = componentId === 'rotation' ? component.value : component;
            if (componentId === 'rotation') {
              if (!Number.isFinite(raw)) throw new Error(`${valueLabel} rotation must be finite`);
            } else if (!Number.isFinite(raw?.x) || !Number.isFinite(raw?.y)) {
              throw new Error(`${valueLabel} component ${componentId} must contain finite x/y`);
            }
          }
        }
        return serializableDtoValue(value, valueLabel);
      }
      return serializableDtoValue(value, valueLabel);
    };
    return [name, normalizeCanonicalKeys(keys, `${label} ${name}`, normalizeValue)];
  }));
}

function normalizeCanonicalTimeline(timeline, rate) {
  if (!Array.isArray(timeline.tracks)) throw new Error('Canonical timeline tracks must be an array');
  if (!Array.isArray(timeline.clips)) throw new Error('Canonical timeline clips must be an array');
  const tracks = timeline.tracks.map((value, index) => {
    const label = `Canonical track ${index + 1}`;
    if (!isRecord(value)) throw new Error(`${label} must be an object`);
    assertOnlyKeys(value, CANONICAL_TRACK_FIELDS, label);
    const kind = String(value.kind || '');
    if (!['visual', 'video', 'group', 'audio'].includes(kind)) {
      throw new Error(`${label} kind is invalid`);
    }
    if (kind !== 'audio' && value.name != null) {
      throw new Error(`${label} duplicates its layer name`);
    }
    if (value.shapePathComponents != null && !Array.isArray(value.shapePathComponents)) {
      throw new Error(`${label} shape path components must be an array`);
    }
    const track = {
      id: assertUuid(value.id, `${label} ID`),
      kind,
      name: String(value.name || (kind === 'audio' ? 'Audio' : value.layer?.name || 'Layer')),
      locked: !!value.locked,
      ...(value.parentTrackId != null
        ? { parentTrackId: assertUuid(value.parentTrackId, `${label} parent track ID`) }
        : {}),
      ...(value.shapePathKind != null ? { shapePathKind: String(value.shapePathKind) } : {}),
      ...(value.shapePathComponents != null
        ? { shapePathComponents: value.shapePathComponents.map(String) }
        : {}),
      ...(value.layer != null ? { layer: normalizeCanonicalLayer(value.layer, `${label} layer`) } : {}),
      propertyTracks: normalizeCanonicalProperties(
        value.propertyTracks,
        `${label} properties`,
        value.shapePathKind,
      ),
    };
    if (value.volume != null) {
      const volume = Number(value.volume);
      if (!Number.isFinite(volume)) throw new Error(`${label} volume must be finite`);
      track.volume = Math.max(0, Math.min(1, volume));
    }
    if (value.muted) track.muted = true;
    return track;
  });
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const clips = timeline.clips.map((value, index) => {
    const label = `Canonical clip ${index + 1}`;
    if (!isRecord(value)) throw new Error(`${label} must be an object`);
    assertOnlyKeys(value, CANONICAL_CLIP_FIELDS, label);
    const trackId = assertUuid(value.trackId, `${label} owner track ID`);
    const track = trackById.get(trackId);
    const startTick = boundedInteger(value.startTick, null, `${label} startTick`, 0, 1000000);
    const inTick = boundedInteger(value.inTick, null, `${label} inTick`, 0, 1000000);
    const outTick = boundedInteger(value.outTick, null, `${label} outTick`, 1, 1000001);
    const sourceDuration = boundedInteger(
      value.sourceDuration,
      null,
      `${label} sourceDuration`,
      1,
      1000001,
    );
    if (outTick <= inTick || outTick > sourceDuration) {
      throw new Error(`${label} has invalid source tick bounds`);
    }
    const clip = {
      id: assertUuid(value.id, `${label} ID`),
      trackId,
      kind: String(value.kind || ''),
      startTick,
      inTick,
      outTick,
      sourceDuration,
      frameKeys: normalizeCanonicalKeys(
        value.frameKeys,
        `${label} frames`,
        normalizeCanonicalPayload,
      ),
      propertyTracks: normalizeCanonicalProperties(
        value.propertyTracks,
        `${label} properties`,
        track?.shapePathKind,
      ),
    };
    for (const field of [
      'assetId', 'inPoint', 'outPoint', 'playbackRate', 'volume', 'muted', 'name',
    ]) {
      if (value[field] !== undefined) clip[field] = value[field];
    }
    if (track?.kind === 'audio' && clip.assetId != null) {
      clip.assetId = assertUuid(clip.assetId, `${label} asset ID`);
    }
    return clip;
  });
  const state = {
    tracks,
    clips,
    tags: normalizeTimelineTags(timeline.tags),
    fps: rate,
    tickDuration: 1000 / rate,
  };
  validateTimelineTagRange(state.tags, clipTimelineDurationTicks(state));
  return state;
}

function validateIdentityGraph(project, canonical, media) {
  const definitions = new Map();
  const define = (id, label) => {
    const key = uuidKey(id);
    const previous = definitions.get(key);
    if (previous) throw new Error(`Duplicate UUID ${id} for ${previous} and ${label}`);
    definitions.set(key, label);
  };
  define(project.projectId, 'project');
  for (const [index, asset] of media.assets.entries()) define(asset.assetId, `media asset ${index + 1}`);
  for (const [index, track] of canonical.tracks.entries()) define(track.id, `track ${index + 1}`);
  for (const [index, track] of canonical.tracks.entries()) {
    if (track.layer) define(track.layer.id, `layer ${index + 1}`);
  }
  for (const [index, clip] of canonical.clips.entries()) define(clip.id, `clip ${index + 1}`);
  for (const [index, tag] of canonical.tags.entries()) define(tag.id, `timeline tag ${index + 1}`);

  const mediaById = new Map(media.assets.map((asset) => [asset.assetId, asset]));
  const trackById = new Map(canonical.tracks.map((track) => [track.id, track]));
  const visualTracks = canonical.tracks.filter((track) => track.kind !== 'audio');
  const trackByLayerId = new Map(visualTracks.map((track) => [track.layer?.id, track]));
  for (const track of canonical.tracks) {
    if (track.kind === 'audio') {
      if (track.layer != null || track.parentTrackId != null) {
        throw new Error(`Audio track ${track.id} cannot own a visual layer`);
      }
      continue;
    }
    const layer = track.layer;
    if (!layer) throw new Error(`Visual track ${track.id} must own one layer`);
    const expectedKind = layer.type === 'group'
      ? 'group'
      : layer.type === 'video' ? 'video' : 'visual';
    if (track.kind !== expectedKind) {
      throw new Error(`Track ${track.id} kind does not match layer ${layer.id}`);
    }
    const expectedParent = layer.groupId == null
      ? null
      : trackByLayerId.get(layer.groupId)?.id || null;
    if ((track.parentTrackId || null) !== expectedParent) {
      throw new Error(`Track ${track.id} has a dangling or mismatched parent track reference`);
    }
    if (layer.type === 'group' && track.parentTrackId) {
      throw new Error(`Group ${layer.id} cannot have a parent group`);
    }
    if (layer.type === 'image' || layer.type === 'video') {
      const asset = mediaById.get(layer.assetId);
      if (!asset || asset.kind !== layer.type) {
        throw new Error(`${layer.type === 'video' ? 'Video' : 'Image'} layer ${layer.id} has a dangling or wrong-kind asset reference`);
      }
    }
  }
  if (trackByLayerId.size !== visualTracks.length) {
    throw new Error('Every visual track must own a distinct layer UUID');
  }
  for (const clip of canonical.clips) {
    const owner = trackById.get(clip.trackId);
    if (!owner) throw new Error(`Clip ${clip.id} has a dangling owner track reference`);
    if (owner.kind === 'audio') {
      if (mediaById.get(clip.assetId)?.kind !== 'audio') {
        throw new Error(`Audio clip ${clip.id} has a dangling or wrong-kind asset reference`);
      }
      continue;
    }
    if (!owner.layer || owner.layer.type === 'group') {
      throw new Error(`Clip ${clip.id} has an invalid visual owner`);
    }
    const expectedKind = owner.layer.type === 'video' ? 'video' : 'visual';
    if (clip.kind !== expectedKind) {
      throw new Error(`Clip ${clip.id} kind does not match its owner layer`);
    }
    if (owner.layer.type === 'video') {
      const asset = mediaById.get(clip.assetId);
      if (!asset || asset.kind !== 'video' || clip.assetId !== owner.layer.assetId) {
        throw new Error(`Video clip ${clip.id} has a dangling or wrong-kind asset reference`);
      }
      const playbackRate = Number(clip.playbackRate);
      const inPoint = Number(clip.inPoint);
      const outPoint = Number(clip.outPoint);
      if (!Number.isFinite(playbackRate) || playbackRate <= 0 ||
        !Number.isFinite(inPoint) || !Number.isFinite(outPoint) ||
        inPoint < 0 || outPoint <= inPoint || outPoint > asset.duration) {
        throw new Error(`Video clip ${clip.id} has invalid source bounds`);
      }
      const expectedTicks = Math.max(1, Math.ceil(
        ((outPoint - inPoint) / playbackRate) * canonical.fps - Number.EPSILON * 32,
      ));
      if (clip.inTick !== 0 || clip.outTick !== expectedTicks ||
        clip.sourceDuration !== expectedTicks) {
        throw new Error(`Video clip ${clip.id} has stale canonical tick bounds`);
      }
    }
  }
}

function enrichMediaLayer(layer, mediaById, label) {
  if (layer.type === 'image') {
    const assetId = assertUuid(layer.assetId, `${label} asset ID`);
    const asset = mediaById.get(assetId);
    if (!asset || asset.kind !== 'image') return { ...layer, assetId };
    return {
      ...layer,
      assetId,
      sourceWidth: asset.width,
      sourceHeight: asset.height,
    };
  }
  if (layer.type !== 'video') return layer;
  const assetId = assertUuid(layer.assetId, `${label} asset ID`);
  const asset = mediaById.get(assetId);
  return {
    ...layer,
    assetId,
    ...(asset?.kind === 'video' ? {
      sourceWidth: asset.width,
      sourceHeight: asset.height,
      sourceDuration: asset.duration,
    } : {}),
  };
}

function enrichCanonicalMedia(canonical, mediaById) {
  canonical.tracks = canonical.tracks.map((track, index) => track.layer ? {
    ...track,
    layer: enrichMediaLayer(track.layer, mediaById, `Canonical track ${index + 1} layer`),
  } : track);
  canonical.clips = canonical.clips.map((clip) => {
    if (clip.kind === 'video') {
      const asset = mediaById.get(clip.assetId);
      return asset?.kind === 'video'
        ? { ...clip, duration: asset.duration, width: asset.width, height: asset.height }
        : clip;
    }
    if (clip.kind !== 'audio') return clip;
    const asset = mediaById.get(clip.assetId);
    if (!asset || asset.kind !== 'audio') return clip;
    return normalizeAudioClip({ ...clip, duration: asset.duration });
  });
  return canonical;
}

function validateCanonicalMediaState(canonical) {
  assertCanonicalClipTimelineState(canonical, 'saved canonical timeline');
  const duration = clipTimelineDurationTicks(canonical);
  for (let tick = 0; tick < duration; tick++) resolveClipTimelineLayers(canonical, tick);
}

function prepareProject(data) {
  if (!isRecord(data) || data.format !== 'paintty-sprite') {
    throw new Error('Not a paintty sprite file');
  }
  assertOnlyKeys(data, new Set([
    'format', 'version', 'projectId', 'width', 'height', 'fps', 'timeline', 'media',
  ]), 'Project');
  if (data.version !== CURRENT_PROJECT_VERSION) {
    throw new Error(`Development project schema mismatch. Expected ${CURRENT_PROJECT_VERSION}.`);
  }
  const loadedProjectId = assertUuid(data.projectId, 'Project ID');
  const currentDimensions = get(dims);
  const width = boundedInteger(data.width, currentDimensions.w, 'Width', 1, 256);
  const height = boundedInteger(data.height, currentDimensions.h, 'Height', 1, 256);
  const rate = boundedInteger(data.fps, null, 'Frame rate', 1, 60);
  if (!isRecord(data.timeline)) throw new Error('Timeline must be an object');
  assertOnlyKeys(data.timeline, new Set(['tracks', 'clips', 'tags']), 'Timeline');
  const media = normalizeMediaRegistry(data.media, 'Project media registry');
  const mediaById = new Map(media.assets.map((asset) => [asset.assetId, asset]));
  const canonical = enrichCanonicalMedia(normalizeCanonicalTimeline(data.timeline, rate), mediaById);
  canonical.tracks = canonical.tracks.map((track) => track.layer ? {
    ...track,
    layer: normalizeMediaTransform(track.layer, width, height),
  } : track);
  validateIdentityGraph({ projectId: loadedProjectId }, canonical, media);
  validateCanonicalMediaState(canonical);
  return {
    projectId: loadedProjectId,
    width,
    height,
    rate,
    media,
    canonical,
  };
}

export function loadJSON(text) {
  const data = JSON.parse(text);
  const prepared = prepareProject(data);
  const previousVideoSources = get(layers).filter((layer) => layer.videoURL && !layer.runtimeMediaKey);
  const revision = advanceProjectRevision();

  replaceProjectId(prepared.projectId);
  loadMediaRegistry(prepared.media);
  dims.set({ w: prepared.width, h: prepared.height });
  fps.set(prepared.rate);
  loadCanonicalTimeline(prepared.canonical);
  moveState.set(null);
  resetEditorStateForProjectLoad();
  projectSaveTarget = null;
  recentProjectIdentity.set(null);
  dirty.set(false);
  notifyProjectReplaced({ revision });
  activeTool.set('brush');
  altEyedrop.set(false);
  selectMode.set('new');
  previousVideoSources.forEach(releaseVideoSource);
}

export function openFileDialog({
  createInput = () => document.createElement('input'),
  createReader = () => new FileReader(),
  showError = notifyError,
  serializeCurrent = serializeJSON,
  decodeArchive = decodeProjectArchive,
  storeAssets = putProjectAssets,
  loadProject = loadJSON,
} = {}) {
  // A delayed picker or reader may apply only if revision and serialized contents
  // still match the document that opened it.
  const request = ++latestOpenRequest;
  const revision = captureProjectRevision();
  const generation = get(authoredRevision);
  const initialContents = serializeCurrent();
  const requestIsCurrent = () => request === latestOpenRequest &&
    isProjectRevisionCurrent(revision) && get(authoredRevision) === generation &&
    serializeCurrent() === initialContents;
  const input = createInput();
  input.type = 'file';
  input.accept = '.paintty,.json,application/zip,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (/\.paintty$/i.test(file.name) && typeof file.arrayBuffer === 'function') {
      try {
        const decoded = await decodeArchive(await file.arrayBuffer());
        if (!requestIsCurrent()) return;
        const contents = JSON.stringify(decoded.document);
        await storeAssets([...decoded.mediaBlobs].map(([hash, blob]) => ({
          hash,
          blob,
          size: blob.size,
          mime: blob.type,
        })));
        if (!requestIsCurrent()) return;
        loadProject(contents);
        fileName.set(file.name);
        const recentId = createRecentProjectId();
        recentProjectIdentity.set(recentId);
        notifyProjectLoaded({ contents: serializeJSON(), fileName: file.name, recentId });
        scheduleMediaCacheGc();
      } catch (error) {
        if (requestIsCurrent()) {
          showError('Could not load file: ' + error.message);
        }
      }
      return;
    }
    const reader = createReader();
    const fail = (error) => {
      if (!requestIsCurrent()) return;
      latestOpenRequest++;
      showError('Could not load file: ' + (error?.message || 'Could not read file.'));
    };
    reader.onload = () => {
      if (!requestIsCurrent()) return;
      try {
        const contents = String(reader.result);
        loadProject(contents);
        fileName.set(file.name);
        const recentId = createRecentProjectId();
        recentProjectIdentity.set(recentId);
        notifyProjectLoaded({ contents: serializeJSON(), fileName: file.name, recentId });
        scheduleMediaCacheGc();
      } catch (err) {
        fail(err);
      }
    };
    reader.onerror = () => fail(reader.error);
    try {
      reader.readAsText(file);
    } catch (error) {
      fail(error);
    }
  };
  input.click();
  return true;
}
