import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TRACK_HEADER_WIDTH,
  MAX_TRACK_HEADER_WIDTH,
  MIN_TRACK_HEADER_WIDTH,
  TIMELINE_POINTER_DRAG_THRESHOLD,
  TRACK_HEADER_WIDTH_STORAGE_KEY,
  clampTrackHeaderWidth,
  clampedRulerTickFromPixel,
  buildTimelineTagMarkers,
  loadTrackHeaderWidth,
  planTimelineTagMove,
  planTimelineTagGesture,
  planTimelineMutationTransition,
  persistTrackHeaderWidth,
  resizeTrackHeaderFromPointer,
  resizeTrackHeaderWithKey,
  rulerTickFromPixel,
  trackHeaderDividerGeometry,
  timelineTagMarkerLayout,
  timelineExtentTicks,
  timelineTransportStatus,
  timelineToolForShortcut,
  timelineWheelZoom,
  timelineZoomForShortcut,
} from '../src/lib/timelineUiState.js';

assert.equal(timelineToolForShortcut({ key: 'V' }, { contextOwned: true }), 'select');
assert.equal(timelineToolForShortcut({ key: 'c' }, { contextOwned: true }), 'razor');
assert.equal(timelineToolForShortcut({ key: 'T' }, { contextOwned: true }), 'tag');
for (const options of [
  { contextOwned: false },
  { contextOwned: true, typing: true },
  { contextOwned: true, playing: true },
]) assert.equal(timelineToolForShortcut({ key: 't' }, options), null);
for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
  assert.equal(timelineToolForShortcut({ key: 't', [modifier]: true }, { contextOwned: true }), null);
}

assert.deepEqual(timelineZoomForShortcut({ key: '=' }, 14, { contextOwned: true }), {
  handled: true, zoom: 16,
});
assert.deepEqual(timelineZoomForShortcut({ key: '+', shiftKey: true }, 47, {
  contextOwned: true,
}), { handled: true, zoom: 48 });
assert.deepEqual(timelineZoomForShortcut({ key: '-' }, 5, { contextOwned: true }), {
  handled: true, zoom: 4,
});
for (const options of [
  { contextOwned: false },
  { contextOwned: true, typing: true },
]) assert.equal(timelineZoomForShortcut({ key: '=' }, 14, options).handled, false);
for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
  assert.equal(timelineZoomForShortcut(
    { key: '=', [modifier]: true },
    14,
    { contextOwned: true },
  ).handled, false);
}
assert.equal(timelineZoomForShortcut({ key: 'v' }, 14, { contextOwned: true }).handled, false,
  'zoom ownership leaves V/C/T tool shortcuts unchanged');

assert.deepEqual(timelineWheelZoom({ deltaY: -100, ctrlKey: true }, 14), {
  handled: true, zoom: 16,
});
assert.deepEqual(timelineWheelZoom({ deltaY: 100, metaKey: true }, 5), {
  handled: true, zoom: 4,
});
assert.equal(timelineWheelZoom({ deltaY: 100 }, 14).handled, false,
  'ordinary wheel input remains native scrolling');
for (const options of [
  { suppressed: true },
  { contextOwned: false },
]) {
  assert.equal(timelineWheelZoom({ deltaY: -1, ctrlKey: true }, 14, options).handled, false);
}
assert.equal(timelineWheelZoom({ deltaY: -1, ctrlKey: true, altKey: true }, 14).handled, false);

assert.deepEqual(timelineTransportStatus(1, 15), {
  currentTick: 1,
  finalTick: 14,
  label: 'Tick 1 / 14',
});
for (const duration of [0, 1]) {
  assert.deepEqual(timelineTransportStatus(0, duration), {
    currentTick: 0,
    finalTick: 0,
    label: 'Tick 0 / 0',
  });
}
assert.equal(timelineTransportStatus(99, 15).label, 'Tick 14 / 14',
  'the status cannot advertise a tick beyond its zero-based final tick');

assert.deepEqual(planTimelineMutationTransition(null, 3, {
  pointerEdit: { type: 'move-clip' },
}), {
  revision: 3,
  changed: false,
  cancelPointer: false,
  cancelHeaderResize: false,
});
for (const type of ['move-clip', 'trim-clip', 'move-key', 'marquee', 'razor-path', 'tag-place']) {
  const transition = planTimelineMutationTransition(3, 4, { pointerEdit: { type } });
  assert.equal(transition.cancelPointer, true, `${type} preview is stale after mutation`);
  assert.equal(transition.cancelHeaderResize, false);
}
assert.deepEqual(planTimelineMutationTransition(3, 4, { headerResize: {} }), {
  revision: 4,
  changed: true,
  cancelPointer: false,
  cancelHeaderResize: true,
});
assert.equal(planTimelineMutationTransition(4, 4, {
  pointerEdit: { type: 'move-clip' },
  headerResize: {},
}).changed, false, 'a no-op revision update keeps the active gesture');

const values = new Map();
const storage = {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { values.set(key, value); },
};
assert.equal(loadTrackHeaderWidth(storage), DEFAULT_TRACK_HEADER_WIDTH);
values.set(TRACK_HEADER_WIDTH_STORAGE_KEY, 'malformed');
assert.equal(loadTrackHeaderWidth(storage), DEFAULT_TRACK_HEADER_WIDTH);
values.set(TRACK_HEADER_WIDTH_STORAGE_KEY, '999');
assert.equal(loadTrackHeaderWidth(storage), MAX_TRACK_HEADER_WIDTH);
assert.equal(persistTrackHeaderWidth(204, storage), 204);
assert.equal(values.get(TRACK_HEADER_WIDTH_STORAGE_KEY), '204');
assert.equal(clampTrackHeaderWidth(300, 210), 138);
assert.equal(clampTrackHeaderWidth(40, 1000), MIN_TRACK_HEADER_WIDTH);

assert.deepEqual(resizeTrackHeaderWithKey({ key: 'ArrowLeft' }, 176, 1000), {
  handled: true, width: 168,
});
assert.deepEqual(resizeTrackHeaderWithKey({ key: 'ArrowRight' }, 176, 1000), {
  handled: true, width: 184,
});
assert.equal(resizeTrackHeaderWithKey({ key: 'Home' }, 176, 1000).width, MIN_TRACK_HEADER_WIDTH);
assert.equal(resizeTrackHeaderWithKey({ key: 'End' }, 176, 1000).width, MAX_TRACK_HEADER_WIDTH);
assert.equal(resizeTrackHeaderWithKey({ key: 'End' }, 176, 250).width, 178);
assert.equal(resizeTrackHeaderWithKey({ key: 'Enter' }, 176, 1000).handled, false);
assert.equal(resizeTrackHeaderFromPointer(176, 400, 520, 1000), 296);
assert.equal(resizeTrackHeaderFromPointer(176, 400, 100, 1000), MIN_TRACK_HEADER_WIDTH);
assert.equal(resizeTrackHeaderFromPointer(176, 400, 520, 1000, true), 176,
  'pointer cancellation restores the gesture-start width');
for (const width of [MIN_TRACK_HEADER_WIDTH, DEFAULT_TRACK_HEADER_WIDTH, MAX_TRACK_HEADER_WIDTH]) {
  const divider = trackHeaderDividerGeometry(width);
  assert.deepEqual(divider, {
    hitLeft: width - 12,
    hitRight: width - 5,
    hitWidth: 7,
    gripLeft: width - 10,
    gripRight: width - 7,
    gripWidth: 3,
  });
  assert.ok(divider.gripLeft >= divider.hitLeft && divider.gripRight <= divider.hitRight,
    'the visible track grip is wholly owned by its hit area');
  for (const dpr of [1, 1.25, 2]) {
    assert.ok(divider.hitRight * dpr <= width * dpr,
      `the track divider remains inside its header at DPR ${dpr}`);
  }
}

assert.equal(rulerTickFromPixel(0, 10, 1), 0);
assert.equal(rulerTickFromPixel(9.9, 10, 1), 0);
assert.equal(rulerTickFromPixel(10, 10, 1), null);
assert.equal(rulerTickFromPixel(39, 10, 4), 3);
assert.equal(rulerTickFromPixel(40, 10, 4), null);
assert.equal(rulerTickFromPixel(47.999, 48, 4), 0);
assert.equal(rulerTickFromPixel(48, 48, 4), 1);
assert.equal(rulerTickFromPixel(-1, 10, 4), null);
assert.equal(rulerTickFromPixel(null, 10, 4), null);
assert.equal(clampedRulerTickFromPixel(-100, 10, 4), 0);
assert.equal(clampedRulerTickFromPixel(100, 10, 4), 3);
assert.equal(clampedRulerTickFromPixel(39, 10, 4), 3);
assert.equal(clampedRulerTickFromPixel(95.999, 48, 4), 1);
assert.equal(clampedRulerTickFromPixel(null, 10, 4), null);

const tagStart = { tick: 1, rowId: 'visual', valid: true };
const tagRelease = { tick: 2, rowId: 'audio', valid: true };
assert.deepEqual(planTimelineTagGesture(
  tagStart,
  tagRelease,
  TIMELINE_POINTER_DRAG_THRESHOLD - 0.01,
), {
  moved: false,
  preview: tagStart,
  release: { tick: 1, rowId: 'visual' },
}, 'sub-threshold release opens the clicked tick and row');
assert.deepEqual(planTimelineTagGesture(
  tagStart,
  tagRelease,
  TIMELINE_POINTER_DRAG_THRESHOLD,
), {
  moved: true,
  preview: tagRelease,
  release: { tick: 2, rowId: 'audio' },
}, 'a horizontal or vertical drag opens at its release target');
assert.equal(planTimelineTagGesture(
  tagStart,
  { tick: 2, rowId: 'group', valid: false },
  8,
).release, null, 'a group-row release cannot open the tag editor');
assert.deepEqual(planTimelineTagGesture(
  tagStart,
  { tick: clampedRulerTickFromPixel(100, 10, 4), rowId: 'audio', valid: true },
  20,
).release, { tick: 3, rowId: 'audio' },
  'a drag beyond duration clamps to the final tick instead of wrapping to zero');
assert.deepEqual(planTimelineTagGesture(tagStart, tagRelease, 0, true).release, {
  tick: 2,
  rowId: 'audio',
}, 'crossing the threshold remains a drag after returning near its origin');
const globalTagStart = { tick: 0, rowId: null, surface: 'global', valid: true };
assert.deepEqual(planTimelineTagGesture(globalTagStart, globalTagStart, 0), {
  moved: false,
  preview: globalTagStart,
  release: { tick: 0, surface: 'global' },
}, 'the zero-track tag lane authors globally without inventing a track ID');
assert.equal(planTimelineTagGesture(
  globalTagStart,
  { tick: 0, rowId: null, surface: 'global', valid: false },
  TIMELINE_POINTER_DRAG_THRESHOLD,
).release, null, 'a global tag drag still requires release inside its visible lane');

assert.deepEqual(planTimelineTagMove(
  { id: 'exact-tag', tick: 2, type: 'custom', value: 'event' },
  29,
  14,
  8,
), {
  moved: true,
  changed: true,
  tick: 4,
  tag: { id: 'exact-tag', tick: 4, type: 'custom', value: 'event' },
}, 'tag motion snaps horizontally while retaining exact identity and value');
assert.equal(planTimelineTagMove({ id: 'start', tick: 2 }, -999, 14, 8).tick, 0);
assert.equal(planTimelineTagMove({ id: 'end', tick: 2 }, 999, 14, 8).tick, 7);
assert.equal(planTimelineTagMove({ id: 'click', tick: 2 }, 2.99, 14, 8).moved, false,
  'sub-threshold marker motion remains a transport click');

const stackedTagLayouts = Array.from({ length: 3 }, (_, index) => timelineTagMarkerLayout(140, index, 14));
assert.deepEqual(stackedTagLayouts.map((layout) => layout.left), [134, 134, 134]);
assert.equal(stackedTagLayouts[0].top, 8,
  'the first tag body begins below the playhead head hit zone');
for (let index = 1; index < stackedTagLayouts.length; index++) {
  assert.ok(stackedTagLayouts[index].top >=
    stackedTagLayouts[index - 1].top + stackedTagLayouts[index - 1].height,
  'same-tick marker hit boxes must not overlap');
}
const adjacentMinimumZoom = [
  timelineTagMarkerLayout(0, 0, 4),
  timelineTagMarkerLayout(4, 0, 4),
];
assert.ok(adjacentMinimumZoom[1].left >= adjacentMinimumZoom[0].left + adjacentMinimumZoom[0].width,
  'neighboring tick markers must not overlap at minimum zoom');

const clusteredMarkers = buildTimelineTagMarkers([
  { id: 'loop-start', tick: 2, type: 'loop-start' },
  ...Array.from({ length: 100 }, (_, index) => ({
    id: `custom-${index}`,
    tick: 2,
    type: 'custom',
    value: `event-${index}`,
  })),
  { id: 'loop-end', tick: 2, type: 'loop-end' },
  { id: 'outside', tick: 8, type: 'custom', value: 'outside' },
], { startTick: 0, endTick: 8 });
assert.deepEqual(clusteredMarkers.map((marker) => marker.type), ['loop-start', 'custom', 'loop-end']);
assert.deepEqual(clusteredMarkers.map((marker) => marker.stackIndex), [0, 1, 2]);
assert.equal(clusteredMarkers[1].cluster, true);
assert.equal(clusteredMarkers[1].customCount, 100);
assert.equal(clusteredMarkers[1].customValues.length, 100);
assert.equal(buildTimelineTagMarkers([
  { id: 'only', tick: 1, type: 'custom', value: 'only' },
], { startTick: 0, endTick: 2 })[0].id, 'only', 'one custom tag keeps its exact marker');
assert.equal(timelineExtentTicks(12, 98, 14), 16,
  'narrow lanes use a half-lane tail instead of hiding content behind the sticky header');
assert.equal(timelineExtentTicks(100, 476, 14), 117, 'long desktop sequences keep half a viewport of trailing space');
assert.equal(timelineExtentTicks(1, 476, 14), 34, 'short sequences still fill the visible lane');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clipTimelineSource = fs.readFileSync(
  path.join(root, 'src/components/ClipTimeline.svelte'),
  'utf8',
);
const timelineHeaderSource = fs.readFileSync(
  path.join(root, 'src/components/TimelineV2.svelte'),
  'utf8',
);
const helpSource = fs.readFileSync(
  path.join(root, 'src/components/HelpPopup.svelte'),
  'utf8',
);
const appSource = fs.readFileSync(path.join(root, 'src/App.svelte'), 'utf8');
const canvasSource = fs.readFileSync(path.join(root, 'src/components/Canvas.svelte'), 'utf8');
const menuSource = fs.readFileSync(path.join(root, 'src/components/MenuBar.svelte'), 'utf8');
const assetsSource = fs.readFileSync(path.join(root, 'src/components/ProjectAssets.svelte'), 'utf8');
const helperSource = fs.readFileSync(path.join(root, 'src/components/TuiHelperPopup.svelte'), 'utf8');
assert.match(clipTimelineSource,
  /if \(transition\.cancelPointer\) finishPointer\(null, true\);\s*if \(transition\.cancelHeaderResize\) finishHeaderResize\(null, true\);/,
  'canonical mutation cancellation rolls back previews before later pointer-up');
assert.match(clipTimelineSource, /guard: captureClipTimelineRevisionGuard\(\)/);
assert.match(clipTimelineSource,
  /moveClips\(edit\.plan\.operations, \{ guard: commitGuard \}\)/);
assert.match(clipTimelineSource,
  /trimClips\(edit\.plan\.operations, \{ guard: commitGuard \}\)/);
assert.match(clipTimelineSource,
  /if \(guard\) commitLayersToActiveFrame\(\);\s*const commitGuard = guard \? captureClipTimelineRevisionGuard\(\) : null;\s*if \(beginStroke\(\) !== true\) return false;/,
  'guarded pointer commits validate first, then rebase only their own synchronous layer flush');
assert.match(clipTimelineSource, /if \(\$playing\) seekTick\(marker\.timelineTick\);/,
  'key hits cannot retain Tag or Razor behavior during playback');
assert.match(clipTimelineSource,
  /function deleteCurrentSelection[\s\S]*runHistoryEdit\(\(\) =>[\s\S]*deleteClipSelection/,
  'mounted Timeline Delete opens its own history entry before canonical deletion');
assert.match(clipTimelineSource,
  /if \(\$playing \|\| \(guard && !isClipTimelineRevisionGuardCurrent\(guard\)\)\) return false;/,
  'mounted Timeline edits never close or coalesce into an already-open history gesture');
assert.match(clipTimelineSource,
  /oncontextmenu=\{\(event\) => openFrameKeyMenu\(event, row, clip, marker\)\}/,
  'mounted frame keys own their context event instead of bubbling to the clip');
assert.match(clipTimelineSource,
  /oncontextmenu=\{\(event\) => openPropertyKeyMenu\(event, row, clip, marker\)\}/,
  'mounted property keys own their context event instead of bubbling to the clip');
assert.match(clipTimelineSource,
  /function keyPointerDown[\s\S]*event\.stopPropagation\(\);[\s\S]*event\.button !== 0/,
  'every key pointer button is stopped before a non-primary press can reach the clip');
assert.match(clipTimelineSource, /surface: 'ruler'/,
  'the ruler explicitly owns transport independently of the editing tool');
assert.match(clipTimelineSource,
  /seekTick\(intent\.tick\);\s*capturePointer\(event, \{ type: 'scrub' \}\);/,
  'stopped and playing ruler presses both continue as scrub drags');
assert.match(clipTimelineSource, /type: 'marquee'/);
assert.match(clipTimelineSource, /type: 'razor-path'/);
assert.match(clipTimelineSource, /type: 'tag-place'/);
assert.match(clipTimelineSource, /type: 'move-tag'/);
assert.match(clipTimelineSource, /type: 'move-key'/);
assert.match(clipTimelineSource, /timeline-marquee/);
assert.match(clipTimelineSource, /timeline-tool-preview/);
assert.match(clipTimelineSource,
  /function tagPointerTarget[\s\S]*const tick = clampedEventTick\(event\)/,
  'Tag targets clamp horizontal overflow with the same visible preview tick');
const startTagPointerSource = clipTimelineSource.match(
  /function startTagPointer\([\s\S]*?\n  \}/,
)?.[0] || '';
assert.match(startTagPointerSource, /hoverPreview = tagHoverPreview\(target\)/,
  'Tag pointer-down renders its snapped preview');
assert.match(startTagPointerSource, /focusTimeline\(\)/,
  'every Tag lane surface gives Escape to the Timeline during its gesture');
assert.doesNotMatch(startTagPointerSource, /openTagEditor/,
  'Tag pointer-down must not open the editor');
assert.match(clipTimelineSource,
  /if \(edit\.type === 'tag-place'\) \{[\s\S]*if \(plan\.release\) openTagEditor\(event, plan\.release\.tick\);/,
  'only a valid Tag release opens the editor at the release tick');
assert.doesNotMatch(clipTimelineSource,
  /if \(intent\.kind === 'tag'\) \{\s*openTagEditor/,
  'lane presses cannot retain the old immediate editor path');
assert.match(clipTimelineSource,
  /function markerPointerDown[\s\S]*openTagEditor\(event, tag\.tick, tag\.cluster \? null : tag\)/,
  'existing marker presses retain direct Tag editing');
assert.match(clipTimelineSource,
  /tag\.cluster[\s\S]*openTagEditor\(event, tag\.tick, tag\.cluster \? null : tag\)/,
  'a custom cluster opens an explicit exact-tag chooser instead of moving ambiguously');
assert.match(clipTimelineSource,
  /id: edit\.tag\.id,[\s\S]*tick: plan\.tick,[\s\S]*type: edit\.tag\.type/,
  'marker drag commits the exact authoring tag identity');
assert.match(clipTimelineSource,
  /oncontextmenu=\{\(event\) => openTagEditor\(event, tag\.tick, tag\.cluster \? null : tag\)\}/,
  'existing marker context editing remains direct');
assert.match(clipTimelineSource, /onpointercancel=\{\(event\) => finishPointer\(event, true\)\}/);
assert.match(clipTimelineSource, /onblur=\{\(event\) => finishPointer\(event, true\)\}/);
assert.match(clipTimelineSource, /if \(pointerEdit\) finishPointer\(null, true\);/,
  'Escape, tool changes, collapse, and project replacement share exact preview cancellation');
assert.match(clipTimelineSource, /onProjectReplaced\(\(\) => \{[\s\S]*clearTimelineContext\(true\);/);
assert.match(clipTimelineSource,
  /use:popupFocus=\{\{ initialFocus: \(\) => tagType === 'custom' \? tagInputEl : tagTypeEl \}\}/);
assert.match(clipTimelineSource, /onkeydown=\{tagEditorKeydown\}/);
assert.doesNotMatch(clipTimelineSource, /razor-all/,
  'Timeline Razor has no Shift-wide route');
assert.match(clipTimelineSource, /buildFilmstripSamples\(clip, tickRange, zoom\)/,
  'filmstrip sampling is bounded to the virtualized visible tick range');
assert.match(clipTimelineSource, /frameWidth: \$dims\.w,\s*frameHeight: \$dims\.h/,
  'filmstrip frames use full project dimensions');
assert.match(clipTimelineSource, /\.filmstrip \.clip-label \{ display: none; \}/,
  'filmstrip mode completely hides clip name overlays');
assert.match(clipTimelineSource, /\.timeline-clip\.filmstrip \{[\s\S]*background: transparent; box-shadow: none;/,
  'filmstrip mode removes ordinary clip fill and shadow');
assert.match(clipTimelineSource, /const FILMSTRIP_ROW_H = 56;/);
assert.match(clipTimelineSource, /rowHeight = \$derived\(showFilmstrip \? FILMSTRIP_ROW_H : COMPACT_ROW_H\)/);
assert.match(clipTimelineSource, /buildRowPrefixIndex\(rows, \(\) => rowHeight\)/,
  'filmstrip row height drives virtualization rather than only clip paint');
assert.match(clipTimelineSource, /onwheel=\{handleWheel\}/);
assert.match(clipTimelineSource,
  /update\(\);\s*scrollLeft = node\.scrollLeft;\s*scrollTop = node\.scrollTop;/,
  'a remounted viewport cannot retain stale hit-test scroll coordinates');
assert.match(clipTimelineSource, /setZoom\(planned\.zoom, event\.clientX, \{ source: 'wheel' \}\)/,
  'modified wheel zoom supplies the pointer anchor');
assert.match(clipTimelineSource, /\.cti-head \{[\s\S]*z-index: 12;/);
assert.match(clipTimelineSource, /\.cti-ruler-line \{[\s\S]*pointer-events: none;/);
assert.match(clipTimelineSource,
  /class="cti-head"[\s\S]*onpointerdown=\{\(event\) => startRulerPointer\(event, true\)\}/,
  'the playhead head owns scrubbing while its visible stem passes marker input through');
assert.match(clipTimelineSource, /\.timeline-tag-marker \{[\s\S]*z-index: 9;/);
assert.match(clipTimelineSource, /\.playhead-line \{[\s\S]*z-index: 21;/);
assert.match(clipTimelineSource,
  /planTimelineKeyMarkerLayout\(markers, propertyMarkers, \{[\s\S]*pixelsPerTick: zoom,[\s\S]*rowHeight/,
  'frame and property keys share the disjoint mounted hit-zone planner');
assert.match(clipTimelineSource,
  /\.trim-handle \{[\s\S]*z-index: 16;[\s\S]*bottom: 0;[\s\S]*height: 8px;/,
  'trim handles own a reachable lower hit zone above overlapping clip-start keys');
assert.match(clipTimelineSource, /trackHeaderDividerGeometry\(headerWidth\)/,
  'the mounted divider shares the tested header-owned geometry');
assert.match(clipTimelineSource, /--track-grip-left:\$\{headerDivider\.gripLeft - headerDivider\.hitLeft\}px/,
  'the visible track grip and hit strip use one geometry');
assert.ok(clipTimelineSource.indexOf('class="timeline-tag-marker') <
  clipTimelineSource.indexOf('class="cti-head"'),
'playhead head is painted after markers within the ruler stacking context');
const narrowLayout = timelineHeaderSource.match(/@media \(max-width: 640px\) \{([\s\S]*?)\n  \}/)?.[1] || '';
assert.match(narrowLayout, /\.tick-step \{ display: none; \}/);
assert.doesNotMatch(narrowLayout, /\.zoom-control \{ display: none; \}/);
assert.match(timelineHeaderSource, /Zoom in \(\+ or =\)/);
assert.match(timelineHeaderSource,
  /<header class="timeline-header" data-keyboard-context="timeline"[\s\S]*onkeydown=\{handleHeaderKeydown\}/,
  'the mounted header routes shortcuts from focused transport, tool, and zoom buttons');
assert.match(timelineHeaderSource,
  /function handleHeaderKeydown[\s\S]*timelineZoomForShortcut[\s\S]*timelineToolForShortcut/,
  'header shortcut routing shares the lane planners');
assert.match(timelineHeaderSource,
  /if \(isEditingTarget\(event\.target\)\) return;/,
  'the Timeline zoom input remains typing-owned');
assert.doesNotMatch(timelineHeaderSource,
  /<section[^>]*onkeydown=\{handleHeaderKeydown\}/,
  'header shortcuts do not also handle key events bubbling out of the lane root');
assert.doesNotMatch(timelineHeaderSource, /cuts all|Shift.*Razor|Razor.*Shift/);
assert.doesNotMatch(timelineHeaderSource, /<kbd>[VCT]<\/kbd>|\.timeline-tool kbd/);
assert.match(timelineHeaderSource,
  /aria-label=\{`\$\{transportStatus\.label\}, zero-based project ticks`\}/);
assert.match(timelineHeaderSource,
  /Tick \{transportStatus\.currentTick\}<span>\/<\/span>\{transportStatus\.finalTick\}/);
assert.doesNotMatch(timelineHeaderSource, /\$canonicalPlayheadTick \+ 1/,
  'transport presentation cannot drift back to one-based tick ordinals');
assert.match(helpSource, /Zero-based current \/ final project tick/);
assert.match(helpSource, /Preview, then add \/ edit at release/);
assert.match(helpSource, /K \/ Space \(Timeline\)/);
assert.match(helpSource, /Ctrl\/Cmd\+wheel/);
assert.match(timelineHeaderSource, /mdi:ghost-off-outline/);
assert.match(timelineHeaderSource, /class="onion-stack"/);
assert.match(timelineHeaderSource, /data-onion-state=\{\$onionSkin\}/);
assert.match(canvasSource, /getKeyboardContext\(\) === 'timeline'/,
  'Timeline-owned Space cannot arm Canvas panning');
assert.match(menuSource, /label: 'CLI Preview'/);
assert.doesNotMatch(menuSource, /CLI Preview…|Terminal preview/);
assert.match(helperSource, /<h2 id="helper-title">CLI Preview<\/h2>/);
assert.doesNotMatch(helperSource, /CLI \/ watch folder/);
assert.match(assetsSource, />Import image…<\/button>/);
assert.match(assetsSource, />Import audio…<\/button>/);
assert.match(assetsSource, />Import video…<\/button>/);
assert.equal((assetsSource.match(/No project assets\./g) || []).length, 1,
  'empty Project Assets has exactly one terse state label');
assert.match(appSource, /playbackCycle\.subscribe\(\(cycle\) =>/,
  'App audio sync consumes explicit wraps, including same-tick cycles');
assert.doesNotMatch(appSource, /index < lastAudioFrame/);
console.log('timeline tools, tag gestures, tick status, ruler range, and track width tests passed');
