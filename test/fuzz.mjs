import { get } from 'svelte/store';
import * as F from '../src/lib/frames.js';
import * as G from '../src/lib/grid.js';
import * as S from '../src/lib/selection.js';
import { applyTextColor, cutTextToBox, normalizeTextRuns, renderTextToCells, textOverflowsBox } from '../src/lib/textLayer.js';
import { applyTool, paintSpecialBrushPath, visibleColorFromCell } from '../src/lib/tools.js';
import { activeChar, activeTool, paintColor, toolOptions } from '../src/lib/stores.js';
import { BOX_STYLES, renderShapeToCells } from '../src/lib/shapes.js';
import { colorEditSession } from '../src/lib/colorEditSession.js';
import { textSelection } from '../src/lib/textEditing.js';
import { applyShapeBodyDrag, captureShapeBodyDrag } from '../src/lib/shapeBodyDrag.js';
import { applyRasterBodyDrag, captureRasterBodyDrag } from '../src/lib/rasterBodyDrag.js';

const {
  activeLayerId,
  activeLayerPart,
  cellSelection,
  dims,
  layers,
  selectedLayerIds,
} = G;

const fuzzWide = (glyph) => glyph === '😀';
const specialGlyphs = new Set(Object.values(BOX_STYLES).flatMap((style) => Object.values(style)));
const shapeKinds = new Set(['line', 'rect', 'circle']);
const interpolationPresets = new Set(['linear', 'ease-in', 'ease-out', 'ease-in-out']);
let colorSessionFailure = null;
const renderFuzzText = (text, box, fg, wrap, runs) =>
  renderTextToCells(text, box, fg, wrap, runs, fuzzWide);

function shapeGeometryValid(shape) {
  return !!shape
    && shapeKinds.has(shape.kind)
    && [shape.x0, shape.y0, shape.x1, shape.y1].every(Number.isFinite);
}

function shapePathGeometryValid(path, kind) {
  if (!path || path.kind !== kind || !shapeKinds.has(path.kind)) return false;
  if (path.kind === 'line') {
    return [path.x0, path.y0, path.x1, path.y1].every(Number.isFinite);
  }
  return [path.cx, path.cy, path.w, path.h].every(Number.isFinite)
    && path.w >= 1
    && path.h >= 1;
}

function temporalEaseValid(ease) {
  if (ease == null) return true;
  if (typeof ease !== 'object') return false;
  return ['in', 'out'].every((side) => {
    const handle = ease[side];
    return handle == null || (
      Number.isFinite(handle.time)
      && Number.isFinite(handle.value)
      && handle.time >= 0
      && handle.time <= 1
      && handle.value >= 0
      && handle.value <= 1
    );
  });
}
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, values) {
  return values[Math.floor(random() * values.length)];
}

function canonical(value) {
  if (value instanceof Set) return [...value].sort();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (typeof value[key] !== 'function') result[key] = canonical(value[key]);
    }
    return result;
  }
  return value;
}

function firstDifference(expected, actual, path = '$') {
  if (Object.is(expected, actual)) return null;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return `${path}.length: expected ${expected.length}, actual ${actual.length}`;
    }
    for (let index = 0; index < expected.length; index++) {
      const difference = firstDifference(expected[index], actual[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  } else if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    const keyDifference = firstDifference(expectedKeys, actualKeys, `${path} keys`);
    if (keyDifference) return keyDifference;
    for (const key of expectedKeys) {
      const difference = firstDifference(expected[key], actual[key], `${path}.${key}`);
      if (difference) return difference;
    }
    return null;
  }
  return `${path}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`;
}

function stateDifference(expected, actual) {
  return firstDifference(JSON.parse(expected), JSON.parse(actual));
}

function authoredAndRenderedState() {
  F.canonicalTimelineStateForSave();
  const size = get(dims);
  const frameViews = get(F.frames).map((frame) => ({
    hold: frame.hold,
    duration: frame.duration,
    layers: frame.layers,
    cells: F.compositeFrameCells(frame, size.w, size.h),
  }));
  return JSON.stringify(canonical({
    document: {
      dims: size,
      layers: get(layers),
      frames: frameViews,
      fps: get(F.fps),
    },
    editor: {
      activeFrame: get(F.activeFrameIndex),
      activeLayer: get(activeLayerId),
      activePart: get(activeLayerPart),
      selectedLayers: get(selectedLayerIds),
      selectedCells: get(cellSelection),
    },
  }));
}

function invariant(name, condition, detail) {
  return condition ? null : { name, detail };
}

function checkInvariants() {
  const currentLayers = get(layers);
  const ids = currentLayers.map((layer) => layer.id);
  const idSet = new Set(ids);
  const active = get(activeLayerId);
  const activePart = get(activeLayerPart);
  const activeLayer = currentLayers.find((candidate) => candidate.id === active);
  const selected = get(selectedLayerIds);
  const size = get(dims);
  const timelineLength = get(F.frames).length;

  let failure = invariant('unique layer ids', idSet.size === ids.length, ids.join(','));
  if (failure) return failure;

  const colorSession = get(colorEditSession);
  failure = invariant(
    'color edit session and gesture are closed',
    !colorSession.active && !colorSession.editing,
    JSON.stringify(colorSession),
  );
  if (failure) return failure;

  failure = invariant(
    'color edit history remains responsive',
    colorSessionFailure === null,
    colorSessionFailure,
  );
  if (failure) return failure;

  failure = invariant(
    'active layer exists',
    active == null || idSet.has(active),
    'active ' + active + ', ids ' + ids.join(','),
  );
  if (failure) return failure;

  failure = invariant(
    'active layer is selected',
    active == null || selected.has(active),
    'active ' + active + ', selected ' + [...selected].join(','),
  );
  if (failure) return failure;

  failure = invariant(
    'selection references live layers',
    [...selected].every((id) => idSet.has(id)),
    'selected ' + [...selected].join(',') + ', ids ' + ids.join(','),
  );
  if (failure) return failure;

  if (!currentLayers.length) {
    failure = invariant(
      'empty stack resets editor',
      active == null && selected.size === 0 && activePart === 'layer',
      'active ' + active + ', selected ' + selected.size + ', part ' + activePart,
    );
    if (failure) return failure;
  }

  if (activePart === 'mask') {
    failure = invariant(
      'mask selection owns a mask',
      activeLayer?.type === 'effect' && !!activeLayer.mask,
      'active ' + active,
    );
    if (failure) return failure;
  }

  const cellSelectionEligible = activePart === 'mask'
    ? activeLayer?.type === 'effect' && !!activeLayer.mask
    : activeLayer?.type === 'cell'
      || activeLayer?.type === 'background';
  failure = invariant(
    'ineligible targets never retain a cell selection',
    cellSelectionEligible || get(cellSelection).size === 0,
    'active ' + active + ' (' + (activeLayer?.type || 'none') + '/' + activePart
      + '), selected cells ' + get(cellSelection).size,
  );
  if (failure) return failure;

  failure = invariant('selection move is closed', !get(S.moveState), 'move transaction leaked');
  if (failure) return failure;

  for (const layer of currentLayers) {
    if (layer.type === 'background') continue;
    for (const [position, cell] of Object.entries(layer.cells || {})) {
      const [x, y] = position.split(',').map(Number);
      if (cell?.cont) {
        const left = layer.cells[(x - 1) + ',' + y];
        failure = invariant(
          'wide continuations have a primary immediately left',
          !!left && !left.cont,
          'layer ' + layer.id + ', cell ' + position,
        );
        if (failure) return failure;
      }
      if (specialGlyphs.has(cell?.c)) {
        failure = invariant(
          'special strokes never own wide-glyph continuations',
          !layer.cells[(x + 1) + ',' + y]?.cont,
          'layer ' + layer.id + ', cell ' + position,
        );
        if (failure) return failure;
      }
    }
  }

  failure = invariant(
    'canvas dimensions are positive integers',
    Number.isInteger(size.w) && Number.isInteger(size.h) && size.w > 0 && size.h > 0,
    JSON.stringify(size),
  );
  if (failure) return failure;

  const groupIds = new Set(currentLayers.filter((layer) => layer.type === 'group')
    .map((layer) => layer.id));
  for (let index = 0; index < currentLayers.length; index++) {
    const layer = currentLayers[index];
    if (layer.type === 'group' && layer.groupId) {
      return { name: 'groups do not nest', detail: layer.id + ' belongs to ' + layer.groupId };
    }
    if (layer.groupId) {
      if (!groupIds.has(layer.groupId)) {
        return { name: 'group child has a header', detail: layer.id + ' -> ' + layer.groupId };
      }
      let contiguous = false;
      for (let previous = index - 1; previous >= 0; previous--) {
        const row = currentLayers[previous];
        if (row.type === 'group' && row.id === layer.groupId) {
          contiguous = true;
          break;
        }
        if (row.groupId !== layer.groupId) break;
      }
      if (!contiguous) {
        return {
          name: 'group children stay contiguous',
          detail: currentLayers.map((row) => row.id + ':' + (row.groupId || '-')).join(' '),
        };
      }
    }

    for (const key of Object.keys(layer.cells || {})) {
      if (!/^-?\d+,-?\d+$/.test(key)) {
        return { name: 'cell keys are integer coordinates', detail: layer.id + ': ' + key };
      }
    }

    if (layer.type === 'shape' && layer.shape && !shapeGeometryValid(layer.shape)) {
      return {
        name: 'authored shape geometry stays finite and supported',
        detail: layer.id + ': ' + JSON.stringify(layer.shape),
      };
    }

    if (layer.type === 'effect') {
      const effectKinds = new Set(['brightness', 'contrast', 'saturation', 'hue']);
      if (!effectKinds.has(layer.effect?.kind)) {
        return { name: 'effect kind is supported', detail: layer.id + ': ' + layer.effect?.kind };
      }
      if (!Number.isFinite(layer.effect.intensity)
        || layer.effect.intensity < -1
        || layer.effect.intensity > 1) {
        return { name: 'effect intensity is bounded', detail: layer.id + ': ' + layer.effect.intensity };
      }
      const opacity = layer.mask?.opacity ?? 1;
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
        return { name: 'effect mask opacity is bounded', detail: layer.id + ': ' + opacity };
      }
      for (const [key, cell] of Object.entries(layer.mask?.cells || {})) {
        if (!/^-?\d+,-?\d+$/.test(key)
          || !Number.isFinite(cell.mask)
          || cell.mask < 0
          || cell.mask > 1) {
          return { name: 'effect mask cells are valid', detail: layer.id + ': ' + key };
        }
      }
    }

    if (layer.type === 'text') {
      const text = typeof layer.text === 'string' ? layer.text : '';
      const normalizedRuns = normalizeTextRuns(layer.runs, text, layer.fg || '#ffffff');
      if (JSON.stringify(canonical(layer.runs || [])) !== JSON.stringify(canonical(normalizedRuns))) {
        return { name: 'stored text color runs stay in canonical form', detail: layer.id + ': ' + JSON.stringify(layer.runs) };
      }
      const rendered = renderFuzzText(text, layer.box, layer.fg, layer.wrap, layer.runs || []);
      if (JSON.stringify(canonical(layer.cells || {})) !== JSON.stringify(canonical(rendered))) {
        return {
          name: 'materialized text cells stay synchronized with the canonical renderer',
          detail: layer.id + ': ' + JSON.stringify({
            text, box: layer.box, fg: layer.fg, wrap: layer.wrap, runs: layer.runs,
            cells: canonical(layer.cells || {}), rendered: canonical(rendered),
            activeFrame: get(F.activeFrameIndex),
            frames: get(F.frames).map((frame) => {
              const textLayer = frame.layers.find((candidate) => candidate.id === layer.id);
              return textLayer ? {
                index: frame.index, text: textLayer.text, box: textLayer.box,
                cells: canonical(textLayer.cells || {}),
              } : { index: frame.index, missing: true };
            }),
          }),
        };
      }
    }
    if (layer.type === 'video' && layer.videoClip) {
      const clip = layer.videoClip;
      if (!Number.isInteger(clip.startTick) || clip.startTick < 0) {
        return { name: 'video start is a nonnegative project tick', detail: layer.id + ': ' + clip.startTick };
      }
      if (!Number.isFinite(clip.inPoint) || clip.inPoint < 0) {
        return { name: 'video trim is nonnegative', detail: layer.id + ': ' + clip.inPoint };
      }
      if (!Number.isFinite(clip.duration) || clip.duration < 0
        || !Number.isFinite(clip.outPoint)
        || clip.outPoint < clip.inPoint
        || clip.outPoint > clip.duration
        || (clip.duration > 0 && clip.inPoint >= clip.duration)) {
        return { name: 'video source range fits duration', detail: layer.id + ': ' + JSON.stringify(clip) };
      }
      if (!Number.isFinite(clip.playbackRate) || clip.playbackRate <= 0) {
        return { name: 'video rate stays positive', detail: layer.id + ': ' + clip.playbackRate };
      }
    }
  }

  const frameViews = get(F.frames);
  const activeFrame = get(F.activeFrameIndex);
  failure = invariant(
    'active frame exists',
    Number.isInteger(activeFrame) && activeFrame >= 0 && activeFrame < frameViews.length,
    activeFrame + ' of ' + frameViews.length,
  );
  if (failure) return failure;

  failure = invariant(
    'frame holds are positive integers',
    frameViews.every((frame) => Number.isInteger(frame.hold) && frame.hold > 0),
    frameViews.map((frame) => frame.hold).join(','),
  );
  if (failure) return failure;

  const activeViewIds = (frameViews[activeFrame]?.layers || []).map((layer) => layer.id);
  failure = invariant(
    'active frame matches editor layer order',
    JSON.stringify(activeViewIds) === JSON.stringify(ids),
    activeViewIds.join(',') + ' != ' + ids.join(','),
  );
  if (failure) return failure;

  for (const frame of frameViews) {
    for (const layer of frame.layers.filter((candidate) =>
      candidate.type === 'shape' && candidate.shape)) {
      if (!shapeGeometryValid(layer.shape)) {
        return {
          name: 'every shape frame has valid authored geometry',
          detail: JSON.stringify({ layer: layer.id, frame: frame.index, shape: layer.shape }),
        };
      }
    }
    for (const layer of frame.layers.filter((candidate) => candidate.type === 'text')) {
      const rendered = renderFuzzText(
        typeof layer.text === 'string' ? layer.text : '',
        layer.box,
        layer.fg,
        layer.wrap,
        layer.runs || [],
      );
      if (JSON.stringify(canonical(layer.cells || {})) !== JSON.stringify(canonical(rendered))) {
        return {
          name: 'every text frame matches its durable metadata',
          detail: JSON.stringify({
            layer: layer.id,
            frame: frame.index,
            activeFrame,
            text: layer.text,
            box: layer.box,
            cells: canonical(layer.cells || {}),
            rendered: canonical(rendered),
          }),
        };
      }
    }
  }

  const durableRows = new Map(
    F.canonicalTimelineStateForSave().tracks
      .filter((track) => track.layer)
      .map((track) => [track.layer.id, track]),
  );
  const rows = F.dopeRows();
  failure = invariant(
    'timeline rows match editor layer order',
    JSON.stringify(rows.map((row) => row.id)) === JSON.stringify(ids),
    rows.map((row) => row.id).join(',') + ' != ' + ids.join(','),
  );
  if (failure) return failure;

  const keyLists = [
    'celFrames',
    'heldFrames',
    'keyFrames',
    'visibilityKeyFrames',
    'effectIntensityKeyFrames',
    'maskOpacityKeyFrames',
    'maskPositionKeyFrames',
    'shapePathKeyFrames',
  ];
  for (const row of rows) {
    for (const field of keyLists) {
      if (!(row[field] || []).every((frame) =>
        Number.isInteger(frame) && frame >= 0 && frame < frameViews.length)) {
        return { name: 'timeline markers fit the frame range', detail: row.id + ': ' + field };
      }
    }
  }

  for (const row of rows) {
    const scalarTracks = [
      ['effect intensity', F.effectIntensityKeys(row.id), -1, 1],
      ['mask opacity', F.maskOpacityKeys(row.id), 0, 1],
    ];
    for (const [kind, keys, min, max] of scalarTracks) {
      for (const { frame, value } of keys) {
        if (!Number.isInteger(frame) || frame < 0 || frame >= frameViews.length ||
          !Number.isFinite(value) || value < min || value > max) {
          return {
            name: kind + ' keys stay bounded and on the timeline',
            detail: row.id + ': ' + frame + '=' + value,
          };
        }
      }
    }
  }
  for (const row of rows) {
    for (const { frame, x, y, interpolation } of F.positionKeys(row.id)) {
      if (!Number.isInteger(frame) || frame < 0 || frame >= frameViews.length ||
        !Number.isInteger(x) || !Number.isInteger(y) ||
        !interpolationPresets.has(interpolation)) {
        return {
          name: 'position keys stay integral and on the timeline',
          detail: row.id + ': ' + frame + '=(' + x + ',' + y + ') ' + interpolation,
        };
      }
    }
    for (const { frame, x, y, interpolation } of F.maskPositionKeys(row.id)) {
      if (!Number.isInteger(frame) || frame < 0 || frame >= frameViews.length ||
        !Number.isInteger(x) || !Number.isInteger(y) ||
        !interpolationPresets.has(interpolation)) {
        return {
          name: 'mask position keys stay integral and on the timeline',
          detail: row.id + ': ' + frame + '=(' + x + ',' + y + ') ' + interpolation,
        };
      }
    }
    const shapeKind = durableRows.get(row.id)?.shapePathKind ?? null;
    for (const key of F.shapePathKeys(row.id)) {
      if (!Number.isInteger(key.frame) || key.frame < 0 || key.frame >= frameViews.length ||
        !shapePathGeometryValid(key, shapeKind) ||
        !interpolationPresets.has(key.interpolation) ||
        !temporalEaseValid(key.temporalEase)) {
        return {
          name: 'shape path keys stay finite, compatible, and on the timeline',
          detail: row.id + ': ' + JSON.stringify(key),
        };
      }
    }
    if (row.shapePathTrackEnabled) {
      for (let frame = 0; frame < frameViews.length; frame++) {
        const path = F.shapePathAt(row.id, frame);
        const resolvedShape = frameViews[frame].layers
          .find((layer) => layer.id === row.id)?.shape;
        if (!resolvedShape && path == null) continue;
        if (!shapePathGeometryValid(path, shapeKind)) {
          return {
            name: 'resolved shape paths preserve the authored shape kind',
            detail: row.id + ' frame ' + frame + ': ' + JSON.stringify(path),
          };
        }
      }
    }
  }

  if (!currentLayers.length) {
    failure = invariant(
      'empty stack resets timeline',
      frameViews.length === 1
        && activeFrame === 0,
      JSON.stringify({
        frames: frameViews.length,
        activeFrame,
      }),
    );
    if (failure) return failure;
  }

  for (let index = 0; index < frameViews.length; index++) {
    const grid = F.compositeFrameCells(frameViews[index], size.w, size.h);
    const rectangular = grid.length === size.h
      && grid.every((row) => row.length === size.w);
    if (!rectangular) {
      return { name: 'rendered frames match canvas', detail: 'frame ' + index };
    }
  }

  return null;
}

function randomLayer(random, predicate = () => true) {
  const candidates = get(layers).filter(predicate);
  return candidates.length ? pick(random, candidates) : null;
}

function prepareShapePathLayer(random) {
  let layer = randomLayer(random, (candidate) =>
    candidate.type === 'shape' && shapeGeometryValid(candidate.shape));
  if (!layer) {
    const kind = pick(random, ['line', 'rect', 'circle']);
    const style = kind === 'line' && random() < 0.25 ? 'slope' : 'outline';
    const id = G.createShapeLayer({
      kind,
      x0: 2,
      y0: 2,
      x1: kind === 'line' ? 8 : 6,
      y1: kind === 'line' ? 5 : 6,
      style,
      detail: 'cell',
      channel: 'glyph',
      char: '#',
      fg: '#ffffff',
    }, renderShapeToCells);
    layer = G.getLayer(id);
  } else {
    G.selectLayer(layer.id);
  }
  return layer;
}

function mutateShapePath(path, random) {
  if (!path) return null;
  const delta = 1 + Math.floor(random() * 4);
  if (path.kind === 'line') {
    const field = pick(random, ['x0', 'y0', 'x1', 'y1']);
    return { ...path, [field]: path[field] + (random() < 0.5 ? -delta : delta) };
  }
  const field = pick(random, ['cx', 'cy', 'w', 'h']);
  if (field === 'w' || field === 'h') return { ...path, [field]: path[field] + delta };
  return { ...path, [field]: path[field] + (random() < 0.5 ? -delta : delta) };
}

function offsetShapePath(path, amount) {
  if (!path) return null;
  if (path.kind === 'line') {
    return { ...path, x1: path.x1 + amount, y1: path.y1 + Math.round(amount / 2) };
  }
  return { ...path, cx: path.cx + amount, w: path.w + Math.abs(amount) };
}

function ensureFrameCount(count) {
  while (get(F.frames).length < count) F.addFrame();
}

function resetShapePathKeys(layerId) {
  const keys = F.shapePathKeys(layerId).map((key) => key.frame);
  if (keys.length) F.deleteShapePathKeys(layerId, keys);
}

function prepareSelectedCell(random) {
  const layer = randomLayer(random, (candidate) =>
    candidate.type === 'cell' || candidate.type === 'background');
  if (!layer) return false;
  const localX = Math.floor(random() * 8) - 2;
  const localY = Math.floor(random() * 8) - 2;
  const offset = G.effOffset(get(layers), layer);
  G.selectLayer(layer.id);
  G.beginStroke();
  G.layers.update((items) => items.map((item) => {
    if (item.id !== layer.id) return item;
    return {
      ...item,
      cells: {
        ...item.cells,
        [localX + ',' + localY]: { c: 'X', fg: '#ffffff', bg: null },
      },
    };
  }));
  G.endStroke();
  const world = (localX + Math.round(offset.x)) + ',' + (localY + Math.round(offset.y));
  G.cellSelection.set(new Set([world]));
  return true;
}

function prepareSelectedWideCell() {
  G.addLayer('cell');
  const id = get(activeLayerId);
  G.beginStroke();
  G.layers.update((items) => items.map((item) => (
    item.id === id
      ? {
        ...item,
        cells: {
          '0,0': { c: '😀', fg: '#ffffff', bg: null },
          '1,0': { c: '', fg: '#ffffff', bg: null, cont: true },
        },
      }
      : item
  )));
  G.endStroke();
  G.cellSelection.set(new Set(['0,0']));
  return true;
}
function prepareSelectedMaskCell(random) {
  const layer = randomLayer(random, (candidate) => candidate.type === 'effect');
  if (!layer) return false;
  if (!layer.mask) G.toggleEffectMask(layer.id);
  const localX = Math.floor(random() * 8) - 2;
  const localY = Math.floor(random() * 8) - 2;
  const current = get(layers).find((candidate) => candidate.id === layer.id);
  const offset = G.effMaskOffset(get(layers), current);
  const worldX = localX + Math.round(offset.x);
  const worldY = localY + Math.round(offset.y);
  G.selectEffectMask(layer.id);
  G.beginStroke();
  G.setCell(worldX, worldY, { mask: random() });
  G.endStroke();
  const world = worldX + ',' + worldY;
  G.cellSelection.set(new Set([world]));
  return true;
}

function operationTable(random) {
  const frameCount = () => get(F.frames).length;
  let colorCase = null;
  let shapeDragCase = null;
  let shapePathCase = null;
  let rasterDragCase = null;
  let maskPositionLayerId = null;
  return [
    {
      name: 'add layer',
      undoable: true,
      run() {
        G.addLayer(pick(random, ['cell', 'cell', 'background', 'text', 'shape', 'video', 'effect']));
      },
    },
    { name: 'add empty group', undoable: true, run: () => G.addGroup() },
    {
      name: 'insert converted layer pair',
      undoable: true,
      prepare() {
        G.addLayer('image');
        const sourceId = get(activeLayerId);
        G.layers.update((items) => items.map((layer) => (
          layer.id === sourceId
            ? { ...layer, raster: { width: 2, height: 2 } }
            : layer
        )));
        return true;
      },
      run() {
        const sourceId = get(activeLayerId);
        G.insertConvertedLayerPair(sourceId, {
          foreground: { '0,0': { c: '@', fg: '#ffffff', bg: null } },
          background: { '0,0': { c: '', fg: null, bg: '#112233' } },
          meta: { mode: 'glyph' },
        });
      },
    },
    {
      name: 'remove layer',
      undoable: true,
      run() {
        const layer = randomLayer(random);
        if (layer) G.removeLayer(layer.id);
      },
    },
    {
      name: 'select layer',
      run() {
        const layer = randomLayer(random);
        if (layer) G.selectLayer(layer.id);
      },
    },
    {
      name: 'toggle layer selection',
      run() {
        const layer = randomLayer(random);
        if (layer) G.toggleLayerSelected(layer.id);
      },
    },
    { name: 'group selection', undoable: true, run: () => G.groupActiveLayer() },
    {
      name: 'rename layer',
      undoable: true,
      run() {
        const layer = randomLayer(random);
        if (layer) G.renameLayer(layer.id, 'renamed-' + Math.floor(random() * 10000));
      },
    },
    {
      name: 'drag shape body',
      undoable: true,
      prepare() {
        let layer = randomLayer(random, (candidate) =>
          candidate.type === 'shape' && candidate.shape);
        if (!layer) {
          const id = G.createShapeLayer({
            kind: 'rect', x0: 1, y0: 1, x1: 5, y1: 4,
            style: 'outline', detail: 'cell', channel: 'glyph',
            char: '#', fg: '#ffffff',
          }, renderShapeToCells);
          layer = G.getLayer(id);
        } else {
          G.selectLayer(layer.id);
        }
        const frame = get(F.activeFrameIndex);
        if (random() < 0.5) {
          if (!F.anyPosKeys(layer.id)) F.togglePosKey(layer.id, frame);
        } else if (F.anyPosKeys(layer.id)) {
          F.clearPosKeys(layer.id);
        }
        let dx = Math.floor(random() * 7) - 3;
        const dy = Math.floor(random() * 7) - 3;
        if (!dx && !dy) dx = 1;
        shapeDragCase = {
          drag: captureShapeBodyDrag(layer.id),
          frame,
          dx,
          dy,
          shape: { ...G.getLayer(layer.id).shape },
        };
        return !!shapeDragCase.drag;
      },
      run() {
        G.beginStroke();
        applyShapeBodyDrag(
          shapeDragCase.drag,
          shapeDragCase.frame,
          shapeDragCase.dx,
          shapeDragCase.dy,
        );
        G.endStroke();
        const layer = G.getLayer(shapeDragCase.drag.layerId);
        if (shapeDragCase.drag.positionAnimated) {
          if (JSON.stringify(layer.shape) !== JSON.stringify(shapeDragCase.shape)) {
            throw new Error('animated body drag rewrote base shape geometry');
          }
          const key = F.positionKeys(layer.id).find(({ frame }) =>
            frame === shapeDragCase.frame);
          const expectedX = shapeDragCase.drag.offset.x + shapeDragCase.dx;
          const expectedY = shapeDragCase.drag.offset.y + shapeDragCase.dy;
          if (key?.x !== expectedX || key?.y !== expectedY) {
            throw new Error('animated body drag did not author the active-frame position');
          }
        } else {
          const expected = {
            x0: shapeDragCase.shape.x0 + shapeDragCase.dx,
            y0: shapeDragCase.shape.y0 + shapeDragCase.dy,
            x1: shapeDragCase.shape.x1 + shapeDragCase.dx,
            y1: shapeDragCase.shape.y1 + shapeDragCase.dy,
          };
          if (layer.shape.x0 !== expected.x0 || layer.shape.y0 !== expected.y0 ||
            layer.shape.x1 !== expected.x1 || layer.shape.y1 !== expected.y1) {
            throw new Error('static body drag did not translate base shape geometry');
          }
        }
      },
    },
    {
      name: 'drag raster body',
      undoable: true,
      prepare() {
        let layer = randomLayer(random, (candidate) =>
          candidate.type === 'image' || candidate.type === 'video');
        if (!layer) {
          G.addLayer(pick(random, ['image', 'video']));
          layer = G.getLayer(get(activeLayerId));
        } else {
          G.selectLayer(layer.id);
        }
        G.layers.update((items) => items.map((candidate) => (
          candidate.id === layer.id && !candidate.transform
            ? { ...candidate, transform: { x: 12, y: 9, scale: 0.75, rot: 15 } }
            : candidate
        )));
        layer = G.getLayer(layer.id);
        const frame = get(F.activeFrameIndex);
        if (random() < 0.5) {
          if (!F.anyPosKeys(layer.id)) F.togglePosKey(layer.id, frame);
        } else if (F.anyPosKeys(layer.id)) {
          F.clearPosKeys(layer.id);
        }
        layer = G.getLayer(layer.id);
        let dx = Math.floor(random() * 7) - 3;
        const dy = Math.floor(random() * 7) - 3;
        if (!dx && !dy) dx = 1;
        rasterDragCase = {
          drag: captureRasterBodyDrag(layer.id),
          frame,
          dx,
          dy,
          transform: structuredClone(layer.transform),
          keys: F.positionKeys(layer.id).map(({ frame: keyFrame, x, y }) => ({
            frame: keyFrame, x, y,
          })),
        };
        return !!rasterDragCase.drag;
      },
      run() {
        G.beginStroke();
        applyRasterBodyDrag(
          rasterDragCase.drag,
          rasterDragCase.frame,
          rasterDragCase.dx,
          rasterDragCase.dy,
        );
        G.endStroke();
        const layer = G.getLayer(rasterDragCase.drag.layerId);
        if (rasterDragCase.drag.positionAnimated) {
          if (JSON.stringify(layer.transform) !== JSON.stringify(rasterDragCase.transform)) {
            throw new Error('animated raster body drag rewrote the base transform');
          }
          const keys = F.positionKeys(layer.id).map(({ frame, x, y }) => ({ frame, x, y }));
          const unchanged = keys.filter((key) => key.frame !== rasterDragCase.frame);
          const expectedUnchanged = rasterDragCase.keys.filter((key) =>
            key.frame !== rasterDragCase.frame);
          if (JSON.stringify(unchanged) !== JSON.stringify(expectedUnchanged)) {
            throw new Error('animated raster body drag changed another frame position');
          }
          const active = keys.find((key) => key.frame === rasterDragCase.frame);
          const expectedX = rasterDragCase.drag.offset.x + rasterDragCase.dx;
          const expectedY = rasterDragCase.drag.offset.y + rasterDragCase.dy;
          if (active?.x !== expectedX || active?.y !== expectedY) {
            throw new Error('animated raster body drag did not author the active-frame position');
          }
        } else {
          const expectedX = rasterDragCase.drag.transform.x + rasterDragCase.dx;
          const expectedY = rasterDragCase.drag.transform.y + rasterDragCase.dy;
          if (layer.transform?.x !== expectedX || layer.transform?.y !== expectedY) {
            throw new Error('static raster body drag did not update the base transform');
          }
          if (F.anyPosKeys(layer.id)) {
            throw new Error('static raster body drag created a position key');
          }
        }
      },
    },
    {
      name: 'target-aware color edit session',
      undoable: true,
      prepare() {
        const kind = pick(random, ['toolbar', 'shape', 'text']);
        const flow = pick(random, [
          'preview-commit',
          'preview-cancel',
          'sample-finish',
          'sample-cancel',
          'abort',
        ]);
        if (kind === 'toolbar') {
          colorCase = { kind, flow, target: { kind } };
          return true;
        }
        if (kind === 'shape') {
          let layer = randomLayer(random, (candidate) => candidate.type === 'shape' && candidate.shape);
          if (!layer) {
            const id = G.createShapeLayer({
              kind: 'rect', x0: 1, y0: 1, x1: 5, y1: 4,
              style: 'outline', detail: 'cell',
              channel: random() < 0.5 ? 'glyph' : 'background',
              char: '#', fg: '#ffffff',
            }, renderShapeToCells);
            layer = get(layers).find((candidate) => candidate.id === id);
          } else {
            G.selectLayer(layer.id);
          }
          colorCase = { kind, flow, target: { kind, layerId: layer.id } };
          return true;
        }
        let layer = randomLayer(random, (candidate) =>
          candidate.type === 'text' && candidate.box && (candidate.text || '').length >= 3);
        if (!layer) {
          const id = G.createTextLayer(
            { x: 1, y: 1, w: 6, h: 2 },
            'MARKET',
            '#ffffff',
            true,
            renderFuzzText,
          );
          layer = get(layers).find((candidate) => candidate.id === id);
        } else {
          G.selectLayer(layer.id);
        }
        const selection = { layerId: layer.id, start: 1, end: layer.text.length - 1 };
        textSelection.set(selection);
        colorCase = { kind, flow, target: { kind, layerId: layer.id, selection } };
        return true;
      },
      run() {
        colorSessionFailure = null;
        const before = authoredAndRenderedState();
        const beforePaint = get(paintColor);
        const beforeUndo = get(G.canUndo);
        const previousTool = get(activeTool);
        const fail = (detail) => { colorSessionFailure ||= detail; };
        if (!colorEditSession.open(colorCase.target, { x: 20, y: 30 })) {
          fail('picker did not open for ' + colorCase.kind);
          return;
        }
        if (colorCase.kind === 'text') {
          const layer = G.getLayer(colorCase.target.layerId);
          textSelection.set({ layerId: layer.id, start: 0, end: layer.text.length });
        }
        const initial = get(colorEditSession).color;
        const colors = initial === '#13579b'
          ? ['#e86452', '#2cba79']
          : ['#13579b', '#e86452'];
        if (colorCase.flow.startsWith('sample')) {
          colorEditSession.startSampling();
          const layer = colorCase.kind === 'shape' ? G.getLayer(colorCase.target.layerId) : null;
          const preferBackground = layer?.shape?.channel === 'background';
          const transparent = visibleColorFromCell({ c: '', fg: null, bg: null }, preferBackground);
          const sampled = visibleColorFromCell(
            { c: '@', fg: colors[0], bg: colors[1] },
            preferBackground,
          );
          if (colorEditSession.sample(transparent)) fail('transparent sample changed the target');
          colorEditSession.sample(sampled);
          colorEditSession.sample(colors[1]);
          if (colorCase.flow === 'sample-finish') colorEditSession.finishSampling();
          else colorEditSession.cancel();
        } else {
          colorEditSession.preview(colors[0]);
          colorEditSession.preview(colors[1]);
          if (colorCase.flow === 'preview-commit') colorEditSession.commit();
          else if (colorCase.flow === 'preview-cancel') colorEditSession.cancel();
          else colorEditSession.abort();
        }
        if (get(colorEditSession).active) colorEditSession.close();
        if (get(activeTool) !== previousTool) fail('sampling did not restore the previous tool');
        const after = authoredAndRenderedState();
        const cancelled = colorCase.flow === 'preview-cancel'
          || colorCase.flow === 'sample-cancel'
          || colorCase.flow === 'abort';
        if (cancelled) {
          if (after !== before || get(paintColor) !== beforePaint) {
            fail('cancel or abort did not restore its target');
          }
          if (get(G.canUndo) !== beforeUndo) fail('cancel left an empty history entry');
          return;
        }
        if (colorCase.kind === 'toolbar' || after === before) return;
        if (!get(G.canUndo)) {
          fail('committed target color has no undo entry');
          return;
        }
        G.undo();
        if (authoredAndRenderedState() !== before) fail('one undo did not restore the color target');
        G.redo();
        if (authoredAndRenderedState() !== after) fail('one redo did not restore the color target');
      },
    },
    {
      name: 'edit text metadata',
      undoable: true,
      run() {
        const layer = randomLayer(random, (candidate) => candidate.type === 'text');
        if (!layer) return;
        const text = pick(random, ['ABCDEFGHI', 'A😀BC', 'écho ', 'one two three']);
        const start = Math.floor(random() * (text.length + 1));
        const end = start + Math.floor(random() * (text.length - start + 1));
        const fg = pick(random, ['#ffffff', '#5fb37a', '#e0a458']);
        const runs = applyTextColor([], start, end, '#c94f4f', text, fg);
        const size = get(dims);
        const box = {
          x: Math.floor(random() * (size.w + 10)) - 5,
          y: Math.floor(random() * (size.h + 10)) - 5,
          w: 1 + Math.floor(random() * 6),
          h: 1 + Math.floor(random() * 3),
        };
        G.beginStroke();
        G.updateTextLayer(layer.id, { text, box, wrap: random() < 0.8, fg, runs }, renderFuzzText);
        G.endStroke();
      },
    },
    {
      name: 'cut off text overflow',
      undoable: true,
      run() {
        const layer = randomLayer(random, (candidate) =>
          candidate.type === 'text' && candidate.box &&
          textOverflowsBox(candidate.text || '', candidate.box, candidate.wrap, fuzzWide));
        if (!layer) return;
        const cut = cutTextToBox(
          layer.text,
          layer.box,
          layer.wrap,
          layer.runs || [],
          layer.fg,
          fuzzWide,
        );
        G.beginStroke();
        G.updateTextLayer(layer.id, cut, renderFuzzText);
        G.endStroke();
      },
    },
    {
      name: 'set layer opacity',
      undoable: true,
      run() {
        const layer = randomLayer(random, (candidate) =>
          candidate.type !== 'group' && candidate.type !== 'effect');
        if (layer) G.setLayerOpacity(layer.id, Math.floor(random() * 5) / 4);
      },
    },
    {
      name: 'toggle layer visibility',
      undoable: true,
      run() {
        const layer = randomLayer(random);
        if (layer) G.toggleLayerVisible(layer.id);
      },
    },
    {
      name: 'resize canvas',
      undoable: true,
      run() {
        const width = 1 + Math.floor(random() * 40);
        const height = 1 + Math.floor(random() * 40);
        if (!G.resizeCanvas(width, height)) return;
        const outside = [...get(cellSelection)].find((position) => {
          const [x, y] = position.split(',').map(Number);
          return x < 0 || y < 0 || x >= width || y >= height;
        });
        if (outside) {
          throw new Error('canvas resize retained out-of-bounds selection ' + outside);
        }
      },
    },
    {
      name: 'translate cell layer',
      run() {
        const layer = randomLayer(random);
        if (layer) {
          G.translateLayerCells(
            layer.id,
            Math.floor(random() * 7) - 3,
            Math.floor(random() * 7) - 3,
          );
        }
      },
    },
    {
      name: 'rasterize shape',
      undoable: true,
      run() {
        const layer = randomLayer(random, (candidate) => candidate.type === 'shape');
        if (layer) G.rasterizeLayer(layer.id);
      },
    },
    {
      name: 'move layer to gap',
      undoable: true,
      run() {
        const layer = randomLayer(random);
        const before = random() < 0.3 ? null : randomLayer(random);
        if (layer) G.moveLayerToGap(layer.id, before?.id ?? null, random() < 0.5);
      },
    },
    {
      name: 'move selected layers',
      undoable: true,
      run() {
        const before = random() < 0.3 ? null : randomLayer(random);
        G.reorderSelectedLayers(before?.id ?? null, random() < 0.5);
      },
    },
    {
      name: 'trim video',
      undoable: true,
      run() {
        const layer = randomLayer(random, (candidate) => candidate.type === 'video');
        if (layer) {
          G.updateVideoClip(layer.id, {
            startTick: Math.floor(random() * 80),
            inPoint: Math.floor(random() * 30) / 10,
            outPoint: Math.floor(random() * 40) / 10,
            playbackRate: pick(random, [-2, 0, 0.25, 0.5, 1, 2, 4]),
          });
        }
      },
    },
    { name: 'undo', run: () => G.undo() },
    { name: 'redo', run: () => G.redo() },
    {
      name: 'change effect',
      undoable: true,
      run() {
        const layer = randomLayer(random, (candidate) => candidate.type === 'effect');
        if (layer) {
          G.setEffectProperties(layer.id, {
            kind: pick(random, ['brightness', 'contrast', 'saturation', 'hue']),
            intensity: random() * 2 - 1,
          });
        }
      },
    },
    {
      name: 'clip effect',
      undoable: true,
      run() {
        const layer = randomLayer(random, (candidate) => candidate.type === 'effect');
        if (layer) G.toggleEffectClipped(layer.id);
      },
    },
    {
      name: 'toggle effect mask',
      undoable: true,
      run() {
        const layer = randomLayer(random, (candidate) => candidate.type === 'effect');
        if (layer) G.toggleEffectMask(layer.id);
      },
    },
    {
      name: 'paint effect mask',
      run() {
        const layer = randomLayer(random, (candidate) => candidate.type === 'effect');
        if (!layer) return;
        if (!layer.mask) G.toggleEffectMask(layer.id);
        G.selectEffectMask(layer.id);
        G.beginStroke();
        G.setCell(
          Math.floor(random() * 8),
          Math.floor(random() * 8),
          { fg: pick(random, ['#000000', '#808080', '#ffffff']) },
        );
        G.endStroke();
      },
    },
    {
      name: 'fill cell or background layer',
      undoable: true,
      prepare() {
        const layer = randomLayer(random, (candidate) =>
          candidate.type === 'cell' || candidate.type === 'background');
        if (!layer) return false;
        G.selectLayer(layer.id);
        return true;
      },
      run() {
        const size = get(dims);
        activeTool.set('fill');
        activeChar.set('#');
        paintColor.set(pick(random, ['#112233', '#5fb37a', '#e0a458']));
        toolOptions.update((options) => ({
          ...options,
          fill: {
            contiguous: random() < 0.7,
            sampleAll: random() < 0.5,
            resolution: pick(random, ['cell', 'half', 'quarter']),
          },
        }));
        G.beginStroke();
        applyTool(
          Math.floor(random() * size.w),
          Math.floor(random() * size.h),
          {},
          'down',
          random() < 0.5 ? 0.25 : 0.75,
          random() < 0.5 ? 0.25 : 0.75,
        );
        G.endStroke();
      },
    },
    {
      name: 'paint special brush path',
      undoable: true,
      prepare() {
        const layer = randomLayer(random, (candidate) => candidate.type === 'cell');
        if (!layer) return false;
        G.selectLayer(layer.id);
        cellSelection.set(new Set());
        return true;
      },
      run() {
        const size = get(dims);
        const x0 = Math.floor(random() * size.w);
        const y0 = Math.floor(random() * size.h);
        const x1 = Math.floor(random() * size.w);
        const y1 = Math.floor(random() * size.h);
        const style = pick(random, ['single', 'rounded', 'double', 'heavy']);
        activeTool.set('subcell');
        paintColor.set(pick(random, ['#112233', '#5fb37a', '#e0a458']));
        toolOptions.update((options) => ({
          ...options,
          subcell: { ...options.subcell, mode: style },
        }));
        G.beginStroke();
        paintSpecialBrushPath([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }], style);
        G.endStroke();
      },
    },
    {
      name: 'combine cell selection',
      prepare() {
        const layer = randomLayer(random, (candidate) =>
          candidate.type === 'cell' || candidate.type === 'background');
        if (!layer) return false;
        G.selectLayer(layer.id);
        return true;
      },
      run() {
        const size = get(dims);
        const event = random() < 0.34
          ? { altKey: true }
          : random() < 0.5
            ? { shiftKey: true }
            : {};
        S.applyRegion([{
          x: Math.floor(random() * size.w),
          y: Math.floor(random() * size.h),
        }], S.selectionModeForModifiers(event));
      },
    },
    {
      name: 'move cell selection',
      undoable: true,
      prepare() {
        return prepareSelectedCell(random);
      },
      run() {
        S.beginMove();
        if (!get(S.moveState)) return;
        S.updateMove(Math.floor(random() * 7) - 3, Math.floor(random() * 7) - 3);
        if (random() < 0.25) S.cancelMove();
        else S.finalizeMove();
      },
    },
    {
      name: 'move effect mask selection',
      undoable: true,
      prepare() {
        return prepareSelectedMaskCell(random);
      },
      run() {
        S.beginMove();
        if (!get(S.moveState)) return;
        S.updateMove(Math.floor(random() * 7) - 3, Math.floor(random() * 7) - 3);
        if (random() < 0.25) S.cancelMove();
        else S.finalizeMove();
      },
    },
    {
      name: 'transform cell selection',
      undoable: true,
      prepare() {
        if (random() < 0.25) return prepareSelectedWideCell();
        return prepareSelectedCell(random);
      },
      run() {
        if (!S.beginTransformSelection()) return;
        const source = get(S.moveState).sourceBounds;
        const update = () => S.updateTransformBounds({
          x: source.x + Math.floor(random() * 11) - 5,
          y: source.y + Math.floor(random() * 11) - 5,
          w: 1 + Math.floor(random() * 8),
          h: 1 + Math.floor(random() * 6),
        });
        update();
        if (random() < 0.5) update();
        if (random() < 0.3) S.cancelMove();
        else S.finalizeMove();
      },
    },
    {
      name: 'transform effect mask selection',
      undoable: true,
      prepare() {
        return prepareSelectedMaskCell(random);
      },
      run() {
        if (!S.beginTransformSelection()) return;
        const source = get(S.moveState).sourceBounds;
        S.updateTransformBounds({
          x: source.x + Math.floor(random() * 11) - 5,
          y: source.y + Math.floor(random() * 11) - 5,
          w: 1 + Math.floor(random() * 8),
          h: 1 + Math.floor(random() * 6),
        });
        if (random() < 0.3) S.cancelMove();
        else S.finalizeMove();
      },
    },
    {
      name: 'translate whole effect mask',
      undoable: true,
      prepare() {
        return prepareSelectedMaskCell(random);
      },
      run() {
        const layer = randomLayer(random, (candidate) =>
          candidate.type === 'effect' && !!candidate.mask && candidate.id === get(activeLayerId));
        if (!layer) return;
        G.beginStroke();
        G.translateEffectMaskCells(
          layer.id,
          Math.floor(random() * 7) - 3,
          Math.floor(random() * 7) - 3,
        );
        G.endStroke();
      },
    },
    {
      name: 'selection to layer',
      undoable: true,
      prepare() {
        return prepareSelectedCell(random);
      },
      run() {
        S.selectionToNewLayer(random() < 0.5);
      },
    },
    {
      name: 'add frame',
      undoable: true,
      run() {
        if (frameCount() < 8) F.addFrame(random() < 0.2);
      },
    },
    {
      name: 'go to frame',
      run() {
        F.gotoFrame(Math.floor(random() * frameCount()));
      },
    },
    {
      name: 'set frame rate',
      undoable: true,
      run() {
        F.setFps(1 + Math.floor(random() * 60));
      },
    },
    {
      name: 'toggle position key',
      undoable: true,
      run() {
        const layer = randomLayer(random);
        if (layer) F.togglePosKey(layer.id, Math.floor(random() * frameCount()));
      },
    },
    {
      name: 'set position key state',
      undoable: true,
      run() {
        const layer = randomLayer(random);
        if (layer) {
          F.setPosKey(
            layer.id,
            Math.floor(random() * frameCount()),
            random() < 0.5,
          );
        }
      },
    },
    {
      name: 'toggle shape path track',
      undoable: true,
      prepare() {
        const layer = prepareShapePathLayer(random);
        shapePathCase = {
          layerId: layer.id,
          enabled: F.isShapePathTrackEnabled(layer.id),
        };
        return true;
      },
      run() {
        F.setShapePathTrackEnabled(shapePathCase.layerId, !shapePathCase.enabled);
      },
    },
    {
      name: 'author shape path key',
      undoable: true,
      prepare() {
        const layer = prepareShapePathLayer(random);
        if (!F.isShapePathTrackEnabled(layer.id)) {
          F.setShapePathTrackEnabled(layer.id, true);
        }
        const frame = Math.floor(random() * frameCount());
        const path = F.shapePathAt(layer.id, frame);
        shapePathCase = {
          layerId: layer.id,
          frame,
          path: mutateShapePath(path, random),
        };
        return true;
      },
      run() {
        G.beginStroke();
        F.setShapePathById(shapePathCase.frame, shapePathCase.layerId, shapePathCase.path);
        G.endStroke();
      },
    },
    {
      name: 'toggle shape path key',
      undoable: true,
      prepare() {
        const layer = prepareShapePathLayer(random);
        if (!F.isShapePathTrackEnabled(layer.id)) {
          F.setShapePathTrackEnabled(layer.id, true);
        }
        shapePathCase = {
          layerId: layer.id,
          frame: Math.floor(random() * frameCount()),
        };
        return true;
      },
      run() {
        F.toggleShapePathKey(shapePathCase.layerId, shapePathCase.frame);
      },
    },
    {
      name: 'move shape path keys',
      undoable: true,
      prepare() {
        ensureFrameCount(4);
        const layer = prepareShapePathLayer(random);
        if (!F.isShapePathTrackEnabled(layer.id)) {
          F.setShapePathTrackEnabled(layer.id, true);
        }
        resetShapePathKeys(layer.id);
        const first = F.shapePathAt(layer.id, 0);
        G.beginStroke();
        F.setShapePathById(0, layer.id, first);
        F.setShapePathById(3, layer.id, offsetShapePath(first, 12));
        G.endStroke();
        shapePathCase = { layerId: layer.id, frames: [0], delta: 1 };
        return true;
      },
      run() {
        F.moveShapePathKeys(
          shapePathCase.layerId,
          shapePathCase.frames,
          shapePathCase.delta,
        );
      },
    },
    {
      name: 'delete shape path keys',
      undoable: true,
      prepare() {
        const layer = prepareShapePathLayer(random);
        if (!F.isShapePathTrackEnabled(layer.id)) {
          F.setShapePathTrackEnabled(layer.id, true);
        }
        resetShapePathKeys(layer.id);
        const frame = Math.floor(random() * frameCount());
        G.beginStroke();
        F.setShapePathById(
          frame,
          layer.id,
          mutateShapePath(F.shapePathAt(layer.id, frame), random),
        );
        G.endStroke();
        shapePathCase = { layerId: layer.id, frames: [frame] };
        return true;
      },
      run() {
        F.deleteShapePathKeys(shapePathCase.layerId, shapePathCase.frames);
      },
    },
    {
      name: 'copy and paste shape path keys',
      undoable: true,
      prepare() {
        ensureFrameCount(3);
        const layer = prepareShapePathLayer(random);
        if (!F.isShapePathTrackEnabled(layer.id)) {
          F.setShapePathTrackEnabled(layer.id, true);
        }
        resetShapePathKeys(layer.id);
        G.beginStroke();
        F.setShapePathById(0, layer.id, mutateShapePath(F.shapePathAt(layer.id, 0), random));
        G.endStroke();
        shapePathCase = {
          layerId: layer.id,
          destination: 2,
          payload: F.copyShapePathKeys(layer.id, [0]),
        };
        return true;
      },
      run() {
        F.pasteShapePathKeys(
          shapePathCase.layerId,
          shapePathCase.destination,
          shapePathCase.payload,
        );
      },
    },
    {
      name: 'set shape path easing',
      undoable: true,
      prepare() {
        ensureFrameCount(4);
        const layer = prepareShapePathLayer(random);
        if (!F.isShapePathTrackEnabled(layer.id)) {
          F.setShapePathTrackEnabled(layer.id, true);
        }
        resetShapePathKeys(layer.id);
        const first = F.shapePathAt(layer.id, 0);
        G.beginStroke();
        F.setShapePathById(0, layer.id, first);
        F.setShapePathById(3, layer.id, offsetShapePath(first, 12));
        G.endStroke();
        F.setShapePathKeyTemporalPreset(layer.id, [0, 3], 'linear');
        shapePathCase = { layerId: layer.id, frames: [0, 3] };
        return true;
      },
      run() {
        F.setShapePathKeyTemporalPreset(
          shapePathCase.layerId,
          shapePathCase.frames,
          'ease-in-out',
        );
      },
    },
    {
      name: 'toggle visibility track',
      undoable: true,
      run() {
        const layer = randomLayer(random);
        if (layer) {
          F.setVisibilityTrackEnabled(layer.id, !F.isVisibilityTrackEnabled(layer.id));
        }
      },
    },
    {
      name: 'set visibility key',
      undoable: true,
      run() {
        const layer = randomLayer(random);
        if (layer) {
          F.setVisibilityKey(
            layer.id,
            Math.floor(random() * frameCount()),
            random() < 0.5,
          );
        }
      },
    },
    {
      name: 'toggle effect intensity track',
      undoable: true,
      run() {
        const layer = randomLayer(random, (candidate) => candidate.type === 'effect');
        if (layer) {
          F.setEffectIntensityTrackEnabled(
            layer.id,
            !F.isEffectIntensityTrackEnabled(layer.id),
          );
        }
      },
    },
    {
      name: 'set effect intensity key',
      undoable: true,
      run() {
        const layer = randomLayer(random, (candidate) => candidate.type === 'effect');
        if (layer) {
          F.setEffectIntensityKey(
            layer.id,
            Math.floor(random() * frameCount()),
            random() * 2 - 1,
          );
        }
      },
    },
    {
      name: 'toggle mask opacity track',
      undoable: true,
      run() {
        const layer = randomLayer(random, (candidate) =>
          candidate.type === 'effect' && !!candidate.mask);
        if (layer) {
          F.setMaskOpacityTrackEnabled(
            layer.id,
            !F.isMaskOpacityTrackEnabled(layer.id),
          );
        }
      },
    },
    {
      name: 'set mask opacity key',
      undoable: true,
      run() {
        const layer = randomLayer(random, (candidate) =>
          candidate.type === 'effect' && !!candidate.mask);
        if (layer) {
          F.setMaskOpacityKey(
            layer.id,
            Math.floor(random() * frameCount()),
            random(),
          );
        }
      },
    },
    {
      name: 'toggle mask position track',
      undoable: true,
      run() {
        const layer = randomLayer(random, (candidate) =>
          candidate.type === 'effect' && !!candidate.mask);
        if (layer) {
          F.setMaskPositionTrackEnabled(
            layer.id,
            !F.isMaskPositionTrackEnabled(layer.id),
          );
        }
      },
    },
    {
      name: 'set mask position key',
      undoable: true,
      prepare() {
        let layer = randomLayer(random, (candidate) =>
          candidate.type === 'effect' && !!candidate.mask);
        if (!layer) {
          G.addLayer('effect');
          layer = G.getLayer(get(activeLayerId));
          G.toggleEffectMask(layer.id);
          layer = G.getLayer(layer.id);
        }
        if (!F.isMaskPositionTrackEnabled(layer.id)) {
          F.setMaskPositionTrackEnabled(layer.id, true);
        }
        maskPositionLayerId = layer.id;
        return true;
      },
      run() {
        const frame = Math.floor(random() * frameCount());
        const current = F.maskPositionAt(maskPositionLayerId, frame);
        F.setMaskPositionById(frame, maskPositionLayerId, {
          x: current.x + 1 + Math.floor(random() * 10),
          y: current.y - 1 - Math.floor(random() * 10),
        });
      },
    },
    {
      name: 'move scalar keys',
      undoable: true,
      run() {
        const mask = random() < 0.5;
        const layer = randomLayer(random, (candidate) =>
          candidate.type === 'effect' && (!mask || !!candidate.mask));
        if (!layer) return;
        const keys = mask
          ? F.maskOpacityKeys(layer.id)
          : F.effectIntensityKeys(layer.id);
        if (!keys.length) return;
        const selected = keys.filter(() => random() < 0.6).map((key) => key.frame);
        if (!selected.length) selected.push(keys[0].frame);
        const delta = Math.floor(random() * (frameCount() * 2 + 1)) - frameCount();
        if (mask) F.moveMaskOpacityKeys(layer.id, selected, delta);
        else F.moveEffectIntensityKeys(layer.id, selected, delta);
      },
    },
    {
      name: 'delete scalar keys',
      undoable: true,
      run() {
        const mask = random() < 0.5;
        const layer = randomLayer(random, (candidate) =>
          candidate.type === 'effect' && (!mask || !!candidate.mask));
        if (!layer) return;
        const keys = mask
          ? F.maskOpacityKeys(layer.id)
          : F.effectIntensityKeys(layer.id);
        if (!keys.length) return;
        const selected = keys.filter(() => random() < 0.6).map((key) => key.frame);
        if (!selected.length) selected.push(keys[0].frame);
        if (mask) F.deleteMaskOpacityKeys(layer.id, selected);
        else F.deleteEffectIntensityKeys(layer.id, selected);
      },
    },
    {
      name: 'copy and paste scalar keys',
      undoable: true,
      run() {
        const mask = random() < 0.5;
        const layer = randomLayer(random, (candidate) =>
          candidate.type === 'effect' && (!mask || !!candidate.mask));
        if (!layer) return;
        const keys = mask
          ? F.maskOpacityKeys(layer.id)
          : F.effectIntensityKeys(layer.id);
        if (!keys.length) return;
        const selected = keys.filter(() => random() < 0.6).map((key) => key.frame);
        if (!selected.length) selected.push(keys[0].frame);
        const payload = mask
          ? F.copyMaskOpacityKeys(layer.id, selected)
          : F.copyEffectIntensityKeys(layer.id, selected);
        const destination = Math.floor(random() * frameCount());
        if (mask) F.pasteMaskOpacityKeys(layer.id, destination, payload);
        else F.pasteEffectIntensityKeys(layer.id, destination, payload);
      },
    },

    {
      name: 'attempt authored mutations during playback',
      run() {
        const before = authoredAndRenderedState();
        F.playing.set(true);
        try {
          F.setFps(get(F.fps) === 60 ? 59 : get(F.fps) + 1);
          F.addFrame();
          const layerId = get(activeLayerId);
          G.addLayer('cell');
          G.addGroup();
          if (layerId != null) {
            F.setPosKey(layerId, get(F.activeFrameIndex), true);
            G.toggleLayerVisible(layerId);
            G.renameLayer(layerId, 'blocked');
            G.setLayerOpacity(layerId, 0.25);
            G.removeLayer(layerId);
          }
          F.cropTimeline({ x: 1, y: 0, w: Math.max(1, get(dims).w - 1), h: get(dims).h });
        } finally {
          F.playing.set(false);
        }
        if (authoredAndRenderedState() !== before) {
          throw new Error('authored state changed while playback was active');
        }
      },
    },
  ];
}

function prepareOperation(operation) {
  return !operation.prepare || operation.prepare() !== false;
}

function boundedCount(argumentIndex, fallback, maximum, label) {
  if (process.argv[argumentIndex] == null) return fallback;
  const value = Number(process.argv[argumentIndex]);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    console.error(`${label} must be an integer from 1 to ${maximum}.`);
    process.exit(2);
  }
  return value;
}

const seedStart = Number(process.argv[2]) || 12345;
const runCount = boundedCount(3, 12, 16, 'random document count');
const operationsPerRun = boundedCount(4, 24, 32, 'operations per document');
const fuzzFocus = process.argv[5] === 'shape-path' ? 'shape-path' : null;
const failures = [];
const operationCoverage = new Map();

function availableOperations(random) {
  const operations = operationTable(random);
  return fuzzFocus === 'shape-path'
    ? operations.filter((operation) => operation.name.includes('shape path'))
    : operations;
}

const operationNames = availableOperations(rng(seedStart ^ 0x51EC710))
  .map((operation) => operation.name);

function coverageFor(name) {
  let coverage = operationCoverage.get(name);
  if (!coverage) {
    coverage = { attempted: 0, effective: 0 };
    operationCoverage.set(name, coverage);
  }
  return coverage;
}

function resetDocument() {
  colorEditSession.abort();
  colorSessionFailure = null;
  dims.set({ w: 24, h: 18 });
  G.setLayers([{ name: 'base', type: 'cell', visible: true, cells: {} }]);
  F.fps.set(12);
  F.initTimeline(get(layers));
}

for (let run = 0; run < runCount && failures.length < 12; run++) {
  const seed = seedStart + run;
  const random = rng(seed);
  resetDocument();
  const trail = [];
  for (let step = 0; step < operationsPerRun; step++) {
    const operations = availableOperations(random);
    const operation = pick(random, operations);
    const coverage = coverageFor(operation.name);
    coverage.attempted++;
    trail.push(operation.name);
    let prepared = false;
    let beforeRun = null;
    try {
      prepared = prepareOperation(operation);
      if (prepared) {
        beforeRun = authoredAndRenderedState();
        operation.run();
      }
    } catch (error) {
      failures.push({
        seed,
        step,
        operation: operation.name,
        trail: [...trail],
        kind: 'THREW',
        detail: error.stack || error.message,
      });
      break;
    }
    if (prepared && authoredAndRenderedState() !== beforeRun) coverage.effective++;
    const violation = checkInvariants();
    if (violation) {
      failures.push({
        seed,
        step,
        operation: operation.name,
        trail: [...trail],
        kind: 'INVARIANT',
        detail: violation.name + ': ' + violation.detail,
      });
      break;
    }
  }
}

if (fuzzFocus && !failures.length) {
  const deliberatelyIneffective = new Set(['attempt authored mutations during playback']);
  const unattempted = operationNames.filter((name) => !operationCoverage.get(name)?.attempted);
  const ineffective = operationNames.filter((name) =>
    !deliberatelyIneffective.has(name) && !operationCoverage.get(name)?.effective);
  if (unattempted.length || ineffective.length) {
    failures.push({
      seed: seedStart,
      step: runCount * operationsPerRun,
      operation: 'operation coverage',
      trail: [],
      kind: 'COVERAGE',
      detail: 'unattempted=' + JSON.stringify(unattempted)
        + ', never effective=' + JSON.stringify(ineffective),
    });
  }
}

function checkUndoRedo(seed) {
  const random = rng(seed);
  resetDocument();

  const setupCount = 8 + Math.floor(random() * 24);
  const trail = [];
  for (let index = 0; index < setupCount; index++) {
    const candidates = availableOperations(random).filter((operation) => operation.undoable);
    const operation = pick(random, candidates);
    trail.push(operation.name);
    try {
      if (prepareOperation(operation)) operation.run();
    } catch (error) {
      return {
        seed,
        kind: 'THREW-IN-SETUP',
        operation: operation.name,
          detail: error.stack || error.message,
      };
    }
  }

  const operation = pick(
    random,
    availableOperations(random).filter((candidate) => candidate.undoable),
  );
  let prepared;
  try {
    prepared = prepareOperation(operation);
  } catch (error) {
    return { seed, kind: 'THREW-IN-PREP', operation: operation.name, detail: error.stack || error.message };
  }
  const before = authoredAndRenderedState();
  try {
    if (prepared) operation.run();
  } catch (error) {
    return { seed, kind: 'THREW', operation: operation.name, detail: error.stack || error.message };
  }
  const after = authoredAndRenderedState();
  if (after === before) return null;

  if (!get(G.canUndo)) {
    return {
      seed,
      kind: 'NO-UNDO-FRAME',
      operation: operation.name,
      detail: 'operation changed authored/rendered state without an undo frame',
    };
  }

  G.undo();
  const restored = authoredAndRenderedState();
  if (restored !== before) {
    return {
      seed,
      kind: 'UNDO-MISMATCH',
      operation: operation.name,
      trail,
      detail: stateDifference(before, restored),
    };
  }

  if (!get(G.canRedo)) {
    return {
      seed,
      kind: 'NO-REDO-FRAME',
      operation: operation.name,
      detail: 'undo produced no redo frame',
    };
  }

  G.redo();
  const redone = authoredAndRenderedState();
  if (redone !== after) {
    return {
      seed,
      kind: 'REDO-MISMATCH',
      operation: operation.name,
      trail,
      detail: stateDifference(after, redone),
    };
  }
  return null;
}

const undoRedoFailures = [];
const undoRedoRunCount = fuzzFocus ? 6 : 8;
for (let index = 0; index < undoRedoRunCount && undoRedoFailures.length < 6; index++) {
  const failure = checkUndoRedo(9000 + index);
  if (failure) undoRedoFailures.push(failure);
}
console.log(
  'fuzz' + (fuzzFocus ? ' [' + fuzzFocus + ']' : '') + ': '
  + runCount + ' random-op runs (' + operationsPerRun
  + ' ops each) + ' + undoRedoRunCount + ' undo/redo runs',
);
console.log(
  'coverage: ' + operationNames.filter((name) => operationCoverage.get(name)?.attempted).length
  + '/' + operationNames.length + ' attempted, '
  + operationNames.filter((name) => operationCoverage.get(name)?.effective).length
  + '/' + operationNames.length + ' effective',
);
if (!failures.length && !undoRedoFailures.length) {
  console.log('\nPASS — no editor or undo/redo invariant violations.');
  process.exit(0);
}

console.error('\nFOUND ' + (failures.length + undoRedoFailures.length) + ' bug(s):\n');
for (const failure of failures) {
  console.error(
    '[' + failure.kind + '] seed=' + failure.seed + ' step=' + failure.step
    + ' op=' + failure.operation,
  );
  console.error('  ' + failure.detail);
  console.error('  trail: ' + failure.trail.join(' -> '));
}
for (const failure of undoRedoFailures) {
  console.error(
    '[' + failure.kind + '] seed=' + failure.seed + ' op=' + failure.operation,
  );
  console.error('  ' + failure.detail);
  if (failure.trail) console.error('  setup: ' + failure.trail.join(' -> '));
}
process.exit(1);
