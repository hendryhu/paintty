import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'svelte/store';
import {
  applicationShortcutBlocked,
  blockUnsupportedTab,
  desktopMenuKeyAction,
  installUniversalTabBlock,
  layerRenameShortcutAction,
  nativeInputOwnsKey,
  projectSaveShortcutAction,
  menuTriggerEdge,
} from '../src/lib/inputPolicy.js';
import {
  RIGHT_PANEL_DIVIDER_HIT_WIDTH,
  RIGHT_PANEL_GUTTER_WIDTH,
  resizeRightPanelFromPointer,
  resizeRightPanelWithKey,
  rightPanelDividerGeometry,
} from '../src/lib/panelLayout.js';
import { isTopPopup, popupCountForTests, popupFocus, popupOpen } from '../src/lib/popupFocus.js';
import { MINIMUM_VIEWPORT, viewportGate } from '../src/lib/viewportGate.js';
import { performDiscardedProjectAction } from '../src/lib/documentReplacement.js';

let prevented = 0;
let stopped = 0;
let blurred = 0;
assert.equal(blockUnsupportedTab({
  key: 'Tab',
  preventDefault() { prevented++; },
  stopImmediatePropagation() { stopped++; },
  target: { blur() { blurred++; } },
}), true);
assert.deepEqual({ prevented, stopped, blurred }, { prevented: 1, stopped: 1, blurred: 0 });
assert.equal(blockUnsupportedTab({ key: 'Enter' }), false);

let installed;
let removed;
const eventTarget = {
  addEventListener(type, listener, capture) { installed = { type, listener, capture }; },
  removeEventListener(type, listener, capture) { removed = { type, listener, capture }; },
};
const uninstall = installUniversalTabBlock(eventTarget);
assert.deepEqual(installed, { type: 'keydown', listener: blockUnsupportedTab, capture: true });
uninstall();
assert.deepEqual(removed, installed);

assert.equal(applicationShortcutBlocked({ popupOpen: true }), true);
assert.equal(applicationShortcutBlocked({ viewportBlocked: true }), true);
assert.equal(applicationShortcutBlocked({}), false);
const rangeInput = {
  type: 'range',
  closest(selector) { return selector === 'input' ? this : null; },
};
const textInput = {
  type: 'text',
  closest(selector) { return selector === 'input' ? this : null; },
};
for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
  assert.equal(nativeInputOwnsKey({ key, target: rangeInput }), true, `${key} remains range-native`);
}
assert.equal(nativeInputOwnsKey({ key: 'n', ctrlKey: true, target: rangeInput }), false);
assert.equal(nativeInputOwnsKey({ key: 's', ctrlKey: true, target: rangeInput }), false);
assert.equal(nativeInputOwnsKey({ key: 'ArrowRight', target: textInput }), false);
assert.equal(nativeInputOwnsKey({ key: 'ArrowRight', target: null }), false);
assert.equal(layerRenameShortcutAction({ key: 'F2' }, { activeLayerId: 'layer-1' }), 'rename-active-layer');
assert.equal(layerRenameShortcutAction({ key: 'F2' }, { activeLayerId: 'layer-1', typing: true }), null);
assert.equal(layerRenameShortcutAction({ key: 'F2' }, { activeLayerId: 'layer-1', popupOpen: true }), null);
assert.equal(layerRenameShortcutAction({ key: 'F2' }, { activeLayerId: 'layer-1', playing: true }), null);
assert.equal(layerRenameShortcutAction({ key: 'F2' }, {}), null);
assert.equal(layerRenameShortcutAction({ key: 'F3' }, { activeLayerId: 'layer-1' }), null);
assert.equal(projectSaveShortcutAction({ key: 's', ctrlKey: true }, {}), 'save');
assert.equal(projectSaveShortcutAction({ key: 'S', metaKey: true, shiftKey: true }, {}), 'save-as');
assert.equal(projectSaveShortcutAction({ key: 's', ctrlKey: true }, { typing: true }), null);
assert.equal(projectSaveShortcutAction({ key: 's', ctrlKey: true }, { popupOpen: true }), null);
assert.equal(projectSaveShortcutAction({ key: 's', ctrlKey: true }, { playing: true }), null);
assert.equal(projectSaveShortcutAction({ key: 's' }, {}), null);
assert.equal(menuTriggerEdge('ArrowDown'), 'first');
assert.equal(menuTriggerEdge('ArrowUp'), 'last');
assert.equal(menuTriggerEdge('Tab'), null);
assert.deepEqual([
  desktopMenuKeyAction('ArrowDown'),
  desktopMenuKeyAction('ArrowUp'),
  desktopMenuKeyAction('Home'),
  desktopMenuKeyAction('End'),
  desktopMenuKeyAction('ArrowLeft'),
  desktopMenuKeyAction('ArrowRight'),
  desktopMenuKeyAction('ArrowRight', { hasSubmenu: true }),
  desktopMenuKeyAction('ArrowLeft', { inSubmenu: true }),
  desktopMenuKeyAction('Enter'),
  desktopMenuKeyAction(' '),
  desktopMenuKeyAction('Escape'),
  desktopMenuKeyAction('Tab'),
], [
  'next-item', 'previous-item', 'first-item', 'last-item', 'previous-menu', 'next-menu',
  'enter-submenu', 'leave-submenu', 'activate', 'activate', 'close', null,
]);

assert.deepEqual(viewportGate(800, 600), {
  width: 800,
  height: 600,
  minimumWidth: 800,
  minimumHeight: 600,
  blocked: false,
});
assert.equal(viewportGate(799, 600).blocked, true);
assert.equal(viewportGate(800, 599).blocked, true);
assert.equal(viewportGate(1200, 900).blocked, false);
assert.deepEqual(MINIMUM_VIEWPORT, { width: 800, height: 600 });

assert.equal(resizeRightPanelFromPointer(260, 500, 452), 308);
assert.equal(resizeRightPanelFromPointer(260, 500, 900), 220);
assert.equal(resizeRightPanelFromPointer(500, 500, 100), 520);
assert.equal(resizeRightPanelWithKey(260, 'ArrowLeft'), 276);
assert.equal(resizeRightPanelWithKey(260, 'ArrowRight'), 244);
assert.equal(resizeRightPanelWithKey(220, 'ArrowRight'), 220);
assert.equal(resizeRightPanelWithKey(520, 'ArrowLeft'), 520);
assert.equal(resizeRightPanelWithKey(260, 'ArrowUp'), null);
for (const viewportWidth of [800, 1024, 1920]) {
  for (const panelWidth of [220, 260, 520]) {
    const geometry = rightPanelDividerGeometry(viewportWidth, panelWidth);
    const panelLeft = viewportWidth - panelWidth;
    assert.deepEqual(geometry, {
      lineX: panelLeft,
      hitLeft: panelLeft,
      hitRight: panelLeft + RIGHT_PANEL_DIVIDER_HIT_WIDTH,
      hitWidth: RIGHT_PANEL_DIVIDER_HIT_WIDTH,
      gutterLeft: panelLeft,
      gutterRight: panelLeft + RIGHT_PANEL_GUTTER_WIDTH,
      gutterWidth: RIGHT_PANEL_GUTTER_WIDTH,
      contentLeft: panelLeft + RIGHT_PANEL_GUTTER_WIDTH,
    });
    assert.equal(geometry.hitLeft, geometry.lineX,
      'the visible boundary belongs to the right-panel hit region');
    assert.equal(geometry.hitRight, geometry.contentLeft,
      'group carets and the first Character tab begin after the resize hit region');
    assert.ok(panelWidth - geometry.gutterWidth >= 212,
      'the 800px layout retains usable panel content at every supported width');
    for (const dpr of [1, 1.25, 2]) {
      const physicalHit = {
        left: geometry.hitLeft * dpr,
        right: geometry.hitRight * dpr,
      };
      const physicalContentLeft = geometry.contentLeft * dpr;
      assert.equal(physicalHit.right, physicalContentLeft,
        `DPR ${dpr} keeps the gutter and panel content exactly adjacent`);
    }
  }
}

const replacementOrder = [];
assert.equal(await performDiscardedProjectAction({
  checkpoint: async () => { replacementOrder.push('checkpoint'); },
  action: async () => { replacementOrder.push('open'); return 'opened'; },
}), 'opened');
assert.deepEqual(replacementOrder, ['checkpoint', 'open']);
await assert.rejects(performDiscardedProjectAction({
  checkpoint: async () => { throw new Error('checkpoint failed'); },
  action: async () => { replacementOrder.push('must not run'); },
}), /checkpoint failed/);
assert.deepEqual(replacementOrder, ['checkpoint', 'open']);

let initialFocus = 0;
let restoredFocus = 0;
const initial = { focus() { initialFocus++; } };
const previous = { isConnected: true, focus() { restoredFocus++; } };
const originalDocument = globalThis.document;
globalThis.document = { activeElement: previous };
const node = {
  querySelector(selector) { return selector === '.initial' ? initial : null; },
  focus() { throw new Error('the explicit initial target should be used'); },
};
const action = popupFocus(node, { initialFocus: '.initial' });
assert.equal(get(popupOpen), true);
assert.equal(popupCountForTests(), 1);
await Promise.resolve();
assert.equal(initialFocus, 1);
action.destroy();
assert.equal(get(popupOpen), false);
assert.equal(popupCountForTests(), 0);
assert.equal(restoredFocus, 1);
const outer = { querySelector() { return null; }, focus() {} };
const inner = { querySelector() { return null; }, focus() {} };
const outerAction = popupFocus(outer, { restoreFocus: false });
const innerAction = popupFocus(inner, { restoreFocus: false });
assert.equal(isTopPopup(outer), false);
assert.equal(isTopPopup(inner), true);
innerAction.destroy();
assert.equal(isTopPopup(outer), true, 'closing a nested popup reveals the prior Escape owner');
outerAction.destroy();
globalThis.document = originalDocument;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const app = source('src/App.svelte');
const main = source('src/main.js');
const menu = source('src/components/MenuBar.svelte');
const characters = source('src/components/CharPicker.svelte');
const canvas = source('src/components/Canvas.svelte');
const timeline = source('src/components/TimelineV2.svelte');
const clipTimeline = source('src/components/ClipTimeline.svelte');
const help = source('src/components/HelpPopup.svelte');
const toolOptions = source('src/components/ToolOptionsBar.svelte');
const shapeProperties = source('src/components/ShapeProperties.svelte');
const sketchPopup = source('src/components/SketchPopup.svelte');
const layersPanel = source('src/components/LayersPanel.svelte');

assert.match(main, /installUniversalTabBlock\(\)/);
assert.doesNotMatch(app, /e\.target instanceof HTMLElement\) e\.target\.blur/);
assert.match(app, /role="alertdialog"/);
assert.match(app, /Unsupported viewport/);
assert.match(app, /Current: \{viewportState\.width\} × \{viewportState\.height\}/);
assert.match(app, /Minimum: \{viewportState\.minimumWidth\} × \{viewportState\.minimumHeight\}/);
assert.match(app, /class:dimmed-section/);
assert.doesNotMatch(app, /dimmed-section[^}]*pointer-events:\s*none/);
assert.match(app, /--right-panel-gutter-w:\$\{rightPanelDivider\.gutterWidth\}px/);
assert.match(app, /\.right\s*\{[^}]*grid-template-columns:\s*var\(--right-panel-gutter-w\)\s+minmax\(0, 1fr\)/s);
assert.match(app, /\.right-resizer::after\s*\{[^}]*left:\s*0;/s);
const rightPanelMarkup = app.slice(app.indexOf('<div class="right"'), app.indexOf('<TimelineV2'));
assert.ok(rightPanelMarkup.indexOf('class="right-resizer"') < rightPanelMarkup.indexOf('class="right-content"'));
assert.ok(rightPanelMarkup.indexOf('<CharPicker') > rightPanelMarkup.indexOf('class="right-content"'));
assert.ok(rightPanelMarkup.indexOf('<LayersPanel') > rightPanelMarkup.indexOf('class="right-content"'));
assert.match(characters, /<div class="char-tabs">\s*\{#each CHAR_TABS as t\}\s*<button/s);
assert.match(layersPanel, /<span class="caret"/);
assert.doesNotMatch(app, /right:\s*calc\(var\(--right-panel-w\)\s*-\s*3px\)/);
assert.match(app, /nativeInputOwnsKey\(e\)/);

for (const component of [
  'NewProjectPopup.svelte', 'ProjectSettings.svelte', 'Preferences.svelte', 'ExportPopup.svelte',
  'ConvertPopup.svelte', 'ProjectAssets.svelte', 'PurgeUnusedMediaPopup.svelte', 'TuiHelperPopup.svelte', 'HelpPopup.svelte',
  'ColorPicker.svelte', 'SketchPopup.svelte', 'GlyphContextMenu.svelte', 'DiscardChangesPopup.svelte',
]) assert.match(source(`src/components/${component}`), /use:popupFocus/, `${component} must own focus`);
for (const component of [
  'MenuBar.svelte', 'CharPicker.svelte', 'Canvas.svelte', 'LayersPanel.svelte',
  'ClipTimeline.svelte', 'AudioTracks.svelte',
]) assert.match(source(`src/components/${component}`), /use:popupFocus/, `${component} menus must own focus`);
assert.doesNotMatch(source('src/components/NewProjectPopup.svelte'), /trapModalFocus/);
assert.doesNotMatch(source('src/components/ProjectSettings.svelte'), /trapModalFocus/);
assert.doesNotMatch(source('src/components/Preferences.svelte'), /trapModalFocus/);

assert.match(menu, /role="menubar"/);
assert.match(menu, /aria-expanded=\{open === name\}/);
assert.match(menu, /role="menuitem"/);
assert.match(menu, /desktopMenuKeyAction/);
assert.match(menu, /\$moveState \? cancelMove\(\) : undo\(\)/);
assert.match(menu, /label: 'Redo', action: \(\) => redo\(\)/);
assert.doesNotMatch(menu, /label: 'Copy'|label: 'Paste'|Copy layers|Paste layers/);
assert.doesNotMatch(menu, /dispatchKey\(/);
assert.match(menu, /Keyboard Shortcuts…/);
assert.match(menu, /onOpenProject\(\)/);
assert.match(menu, /onOpenRecent\(\{ project \}\)/);
assert.doesNotMatch(menu, /\bloadJSON\b/);
assert.match(app, /const modalOpen = documentModalOpen\(\) \|\| \$popupOpen/);
assert.match(canvas, /get\(popupOpen\)/);
assert.match(canvas, /data-keyboard-context="canvas"/);
assert.match(canvas, /class="zoombar" data-keyboard-context="neutral"/);
assert.match(canvas, /planSelectionDeselect/);
assert.match(source('src/components/LayersPanel.svelte'), /if \(\$popupOpen\) return/);
assert.match(source('src/components/ClipTimeline.svelte'), /\(contextMenu \|\| tagEditor\) && event\.key !== 'Escape'/);
assert.match(app, /getKeyboardContext\(\)/);
assert.match(app, /keyboardContext !== 'layers' && keyboardContext !== 'timeline'/);
assert.match(app, /function onCopy\(e\)/);
assert.match(app, /copyClipsForContext\(keyboardContext, e\.clipboardData\)/);
assert.match(app, /oncopy=\{onCopy\}/);
assert.doesNotMatch(app, /key\.toLowerCase\(\) === 'c'/,
  'Ctrl\/Cmd+C remains owned by the browser copy event');
assert.match(app, /clipboardPasteIntent\(e\.clipboardData, getKeyboardContext\(\)\)/);
assert.match(app, /intent\.kind === 'image'[\s\S]+intent\.kind !== 'clips'/,
  'bitmap clipboard content is handled before the internal clip clipboard');
assert.doesNotMatch(app, /key\.toLowerCase\(\) === 'v'/,
  'Ctrl\/Cmd+V remains owned by the browser paste event');
assert.match(app, /clipboardMediaPlacementSucceeded\(imported\)/,
  'bitmap paste only reports success for a placed reference layer');
assert.doesNotMatch(app, /e\.key\.toLowerCase\(\) === 'd'\) \{ e\.preventDefault\(\); clearSelection/);
assert.doesNotMatch(menu, /About Paintty/);
assert.match(characters, /class="nf-filter-button"/);
assert.match(characters, /class="nf-filter-menu" role="menu"/);
assert.doesNotMatch(characters, /class="nf-groups"/);
assert.doesNotMatch(timeline, /<kbd>[VCT]<\/kbd>/);
assert.doesNotMatch(timeline, /\.timeline-tool kbd/);
assert.match(timeline, /nativeInputOwnsKey\(event\)/);
assert.match(clipTimeline, /const duplicate = Boolean\(event\.shiftKey\)/);
assert.match(clipTimeline, /type: duplicate \? 'duplicate-clip' : 'move-clip'/);
assert.match(clipTimeline, /planClipDuplicateMove\(/);
assert.match(clipTimeline, /class:duplicate-ghost=\{clip\.duplicateGhost\}/);
assert.match(clipTimeline, /class:invalid-duplicate=\{clip\.duplicateGhost && !clip\.duplicateValid\}/);
assert.equal((clipTimeline.match(/onlostpointercapture=\{\(event\) => finishPointer\(event, true\)\}/g) || []).length, 2,
  'visual and audio clips cancel on lost pointer capture');
assert.match(help, /Reserved \/ unsupported/);
assert.doesNotMatch(help, /About Paintty|Terminal-ready|Save and export|Minimal terminal player/);
for (const label of ['New line', 'New rectangle', 'New circle', 'New polygon']) {
  assert.match(toolOptions, new RegExp(label), `${label} qualifies creation defaults`);
  assert.doesNotMatch(shapeProperties, new RegExp(label), `${label} must not label selected properties`);
}
for (const label of ['New layer via copy', 'New layer via cut']) {
  assert.match(toolOptions, new RegExp(`>${label}</button>`), `${label} appears in the toolbar`);
  assert.match(canvas, new RegExp(`>${label}</button>`), `${label} appears in the Canvas menu`);
}
assert.match(toolOptions, /newShapeOptionLabel\(tool, 'sides'\)/);
assert.match(toolOptions, /newShapeOptionLabel\(tool, 'thickness'\)/);
assert.match(sketchPopup, /rasterizeSketchStrokes\(strokes/);
assert.match(sketchPopup, /finally \{\s*if \(revision === matchRevision\) matching = false;/);
assert.match(sketchPopup, /matchComplete \? 'no matches'/);

console.log('universal input, popup focus, menu, and viewport policy tests passed');
