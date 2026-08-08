<script>
  import { colorDepth } from '../lib/stores.js';
  import {
    saveJSON, saveJSONAs, copyForTerminal, copyForPowerShell, copyAsText,
  } from '../lib/fileio.js';
  import { onMount, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { chooseWatchFolder } from '../lib/livePreview.js';

  import {
    activeLayerId, authoredRevision, canRedo, canUndo, getLayer, layers, redo, undo,
  } from '../lib/grid.js';
  import { playheadTick, playing } from '../lib/frames.js';
  import { canConvertImageToCells } from '../lib/layerActions.js';
  import {
    currentMediaUsageCounts,
    importMediaFile,
    replaceMediaFile,
  } from '../lib/mediaCommands.js';
  import { projectMediaRegistry } from '../lib/mediaRegistry.js';
  import { canPurgeUnusedMedia, unusedMediaAssets } from '../lib/mediaPurge.js';
  import {
    captureProjectRevision, isProjectRevisionCurrent,
    onProjectReplaced,
  } from '../lib/documentLifecycle.js';
  import {
    clearRecentProjects,
    recentProjects,
  } from '../lib/recentProjects.js';
  import { cancelMove, moveState } from '../lib/selection.js';
  import { notifyError, notifyInfo } from '../lib/notifications.js';
  import { popupFocus, popupOpen } from '../lib/popupFocus.js';
  import { desktopMenuKeyAction, menuTriggerEdge } from '../lib/inputPolicy.js';

  /**
   * @typedef {Object} Props
   * @property {() => void} [onExport]
   * @property {() => void} [onHelper]
   * @property {() => void} [onOpenProject]
   * @property {(detail: { project: any }) => void} [onOpenRecent]
   * @property {() => void} [onNewProject]
   * @property {() => void} [onProjectSettings]
   * @property {() => void} [onPurgeMedia]
   * @property {(detail: { open: boolean }) => void} [onMenuState]
   * @property {() => void} [onAssets]
   * @property {(detail: any) => void} [onRelinkMedia]
   * @property {(detail: { page: string }) => void} [onHelp]
   */

  /** @type {Props} */
  let {
    onExport = () => {},
    onHelper = () => {},
    onOpenProject = () => {},
    onOpenRecent = () => {},
    onNewProject = () => {},
    onProjectSettings = () => {},
    onPurgeMedia = () => {},
    onMenuState = () => {},
    onAssets = () => {},
    onRelinkMedia = () => {},
    onHelp = () => {},
  } = $props();

  function importImage() {
    if (get(playing)) return;
    const revision = captureProjectRevision();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await importMediaFile(file, 'image', {
          valid: () => isProjectRevisionCurrent(revision) && !get(playing),
        });
      } catch (err) {
        if (!isProjectRevisionCurrent(revision)) return;
        notifyError('Could not import image: ' + err.message);
      }
    };
    input.click();
  }

  function chooseVideo(relinkId = null) {
    if (get(playing)) return;
    const revision = captureProjectRevision();
    const startTick = get(playheadTick);
    const relinkAssetId = relinkId == null ? null : getLayer(relinkId)?.videoClip?.assetId;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        if (relinkAssetId) {
          await replaceMediaFile(relinkAssetId, file, {
            valid: () => isProjectRevisionCurrent(revision) &&
              !get(playing) &&
              getLayer(relinkId)?.videoClip?.assetId === relinkAssetId,
          });
          return;
        }
        await importMediaFile(file, 'video', {
          startTick,
          valid: () => isProjectRevisionCurrent(revision) && !get(playing),
        });
      } catch (err) {
        if (!isProjectRevisionCurrent(revision)) return;
        notifyError('Could not import video: ' + err.message);
      }
    };
    input.click();
  }

  function relinkVideo(id) {
    if (getLayer(id)?.type !== 'video') {
      notifyError('Select a video layer first.');
      return;
    }
    chooseVideo(id);
  }

  function importAudio() {
    if (get(playing)) return;
    const revision = captureProjectRevision();
    const startTick = get(playheadTick);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await importMediaFile(file, 'audio', {
          startTick,
          valid: () => isProjectRevisionCurrent(revision) && !get(playing),
        });
      } catch (err) {
        if (isProjectRevisionCurrent(revision)) notifyError('Could not import audio: ' + err.message);
      }
    };
    input.click();
  }

  onMount(() => {
    const relink = (event) => relinkVideo(event.detail?.id);
    const relinkMedia = (event) => onRelinkMedia(event.detail);
    const importProjectMedia = (event) => {
      if (event.detail?.kind === 'image') importImage();
      else if (event.detail?.kind === 'audio') importAudio();
      else if (event.detail?.kind === 'video') chooseVideo();
    };
    window.addEventListener('relink-video', relink);
    window.addEventListener('relink-media', relinkMedia);
    window.addEventListener('import-project-media', importProjectMedia);
    const stopProjectReplaced = onProjectReplaced(() => closeAll());
    return () => {
      stopProjectReplaced();
      window.removeEventListener('relink-video', relink);
      window.removeEventListener('relink-media', relinkMedia);
      window.removeEventListener('import-project-media', importProjectMedia);
    };
  });

  async function saveProject(saveAs = false) {
    try {
      await (saveAs ? saveJSONAs() : saveJSON());
    } catch (err) {
      notifyError(`Could not save file: ${err.message}`);
    }
  }
  async function copyTerminal() {
    const ok = await copyForTerminal();
    if (ok) notifyInfo('Copied.');
    else notifyError('Could not copy to clipboard.');
  }
  async function copyPowerShell() {
    const ok = await copyForPowerShell();
    if (ok) notifyInfo('Copied.');
    else notifyError('Could not copy to clipboard.');
  }
  async function copyText() {
    const ok = await copyAsText();
    if (ok) notifyInfo('Copied.');
    else notifyError('Could not copy to clipboard.');
  }
  async function selectWatchFolder() {
    try { await chooseWatchFolder(); }
    catch (err) {
      if (err.name !== 'AbortError') notifyError(err.message);
    }
  }

  const menus = {
    File: [
      { label: 'New project…', shortcut: 'Ctrl+N', action: () => onNewProject() },
      { label: 'Open…', action: () => onOpenProject() },
      { label: 'Open Recent…', recent: true },
      { label: 'Save', shortcut: 'Ctrl+S', action: () => saveProject() },
      { label: 'Save As…', shortcut: 'Ctrl+Shift+S', action: () => saveProject(true) },
      null,
      { label: 'Project Settings…', action: () => onProjectSettings(), disabled: () => $playing },
      { label: 'Purge unused media…', action: () => onPurgeMedia(), disabled: () => !canPurgeUnusedMedia({
        playing: $playing,
        unusedCount: purgeUnusedCount,
        popupBusy: popupBusyAtOpen,
      }) },
      { label: 'Watch folder…', action: selectWatchFolder },
      { label: 'CLI Preview', action: () => onHelper() },
      null,
      { label: 'Copy for Bash/Zsh', action: copyTerminal },
      { label: 'Copy for PowerShell', action: copyPowerShell },
      { label: 'Copy as Text', action: copyText },
      null,
      { label: 'Export…', action: () => onExport() },
    ],
    Edit: [
      { label: 'Undo', action: () => $moveState ? cancelMove() : undo(), disabled: () => !$canUndo && !$moveState },
      { label: 'Redo', action: () => redo(), disabled: () => !$canRedo || !!$moveState },
      null,
      { label: 'Preferences…', action: () => openPrefs() },
    ],
    Layer: [
      { label: 'Import image…', action: importImage, disabled: () => $playing },
      { label: 'Import video…', action: () => chooseVideo(), disabled: () => $playing },
      { label: 'Import audio…', action: importAudio, disabled: () => $playing },
      { label: 'Project assets…', action: () => onAssets() },
      { label: 'Convert image to cells…', action: () => window.dispatchEvent(new CustomEvent('convert-image')), disabled: () => $playing || !canConvertImageToCells(selectedLayer) },
    ],
    Help: [
      { label: 'Keyboard Shortcuts…', action: () => onHelp({ page: 'shortcuts' }) },
      { label: 'Animation JSON Format…', action: () => onHelp({ page: 'animation-json' }) },
    ],
  };

  const menuNames = Object.keys(menus);
  let open = $state(null);
  let popupBusyAtOpen = false;
  let recentOpen = $state(false);
  let restoreTrigger = null;
  let dropdownEl = $state(null);
  let recentMenuEl = $state(null);
  let recentTriggerEl = null;
  let menuFocusEdge = $state('first');
  const triggerNodes = new Map();
  $effect(() => {
    onMenuState({ open: open !== null });
  });
  let selectedLayer = $derived($layers.find((layer) => layer.id === $activeLayerId));
  let purgeUnusedCount = $derived(($authoredRevision, $projectMediaRegistry,
    unusedMediaAssets($projectMediaRegistry, currentMediaUsageCounts()).length));

  function registerTrigger(node, name) {
    triggerNodes.set(name, node);
    return { destroy: () => triggerNodes.delete(name) };
  }
  function registerRecentTrigger(node, enabled) {
    if (enabled) recentTriggerEl = node;
    return {
      update(next) { if (next) recentTriggerEl = node; },
      destroy() { if (recentTriggerEl === node) recentTriggerEl = null; },
    };
  }
  function menuItems(container) {
    return [...(container?.querySelectorAll?.('[role="menuitem"]') || [])]
      .filter((item) => !item.disabled && item.closest('[role="menu"]') === container);
  }
  function edgeItem(container, edge = 'first') {
    const items = menuItems(container);
    return edge === 'last' ? items.at(-1) : items[0];
  }
  function focusEdge(container, edge = 'first') {
    edgeItem(container, edge)?.focus({ preventScroll: true });
  }
  async function openMenu(name, edge = 'first', trigger = triggerNodes.get(name)) {
    if (!menus[name]) return;
    if (open === null) popupBusyAtOpen = get(popupOpen);
    restoreTrigger = trigger || restoreTrigger;
    menuFocusEdge = edge;
    open = name;
    recentOpen = false;
    await tick();
    focusEdge(dropdownEl, edge);
  }
  function toggle(name, event) {
    if (open === name) closeAll(true);
    else openMenu(name, 'first', event.currentTarget);
  }
  function toggleFromClick(event, name) {
    event.stopPropagation();
    toggle(name, event);
  }
  function hoverOpen(name) {
    if (open !== null && open !== name) {
      openMenu(name, 'first', triggerNodes.get(name));
    }
  }
  function itemDisabled(item) { return typeof item?.disabled === 'function' ? item.disabled() : !!item?.disabled; }
  function recentLabel(project) {
    const duplicate = $recentProjects.some((item) =>
      item.id !== project.id && item.name.toLocaleLowerCase() === project.name.toLocaleLowerCase());
    if (!duplicate) return project.name;
    return `${project.name} — ${new Date(project.openedAt).toLocaleString()}`;
  }
  function run(item) {
    if (item && !item.recent && !itemDisabled(item)) {
      closeAll(true);
      item.action();
    }
  }
  function runRecent(project) {
    closeAll(true);
    onOpenRecent({ project });
  }
  async function clearRecents() {
    if (!await clearRecentProjects()) {
      notifyError('Could not clear recent projects.');
      return;
    }
    closeAll(true);
  }
  function closeAll(restore = false) {
    const target = restore ? restoreTrigger : null;
    open = null;
    recentOpen = false;
    restoreTrigger = null;
    popupBusyAtOpen = false;
    target?.focus?.({ preventScroll: true });
  }
  async function openRecentMenu(edge = 'first') {
    recentOpen = true;
    await tick();
    focusEdge(recentMenuEl, edge);
  }
  function switchTopMenu(delta) {
    const index = Math.max(0, menuNames.indexOf(open));
    const next = menuNames[(index + delta + menuNames.length) % menuNames.length];
    openMenu(next, delta < 0 ? 'last' : 'first', triggerNodes.get(next));
  }
  function moveMenuFocus(container, current, delta) {
    const items = menuItems(container);
    const index = items.indexOf(current);
    if (!items.length) return;
    items[(Math.max(0, index) + delta + items.length) % items.length]
      .focus({ preventScroll: true });
  }
  function consumeMenuKey(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function onTriggerKey(event, name) {
    const edge = menuTriggerEdge(event.key);
    if (!edge) return;
    consumeMenuKey(event);
    openMenu(name, edge, event.currentTarget);
  }
  function onMenuKey(event) {
    if (open === null) return;
    const item = event.target?.closest?.('[role="menuitem"]');
    const container = item?.closest?.('[role="menu"]');
    const action = desktopMenuKeyAction(event.key, {
      hasSubmenu: item?.dataset.recent === 'true',
      inSubmenu: container === recentMenuEl,
    });
    if (action === 'close') {
      consumeMenuKey(event);
      closeAll(true);
      return;
    }
    if (!item || !container || !action) return;
    if (action === 'next-item' || action === 'previous-item') {
      consumeMenuKey(event);
      moveMenuFocus(container, item, action === 'next-item' ? 1 : -1);
    } else if (action === 'first-item' || action === 'last-item') {
      consumeMenuKey(event);
      focusEdge(container, action === 'first-item' ? 'first' : 'last');
    } else if (action === 'enter-submenu') {
      consumeMenuKey(event);
      openRecentMenu('first');
    } else if (action === 'next-menu' || action === 'previous-menu') {
      consumeMenuKey(event);
      switchTopMenu(action === 'next-menu' ? 1 : -1);
    } else if (action === 'leave-submenu') {
      consumeMenuKey(event);
      recentOpen = false;
      recentTriggerEl?.focus({ preventScroll: true });
    } else if (action === 'activate') {
      consumeMenuKey(event);
      item.click();
    }
  }
  function onWindowKey(event) {
    if (open !== null && (event.ctrlKey || event.metaKey) &&
      !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (open === null && get(popupOpen)) return;
    if (event.key !== 'Escape' || open === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeAll(true);
  }

  function openPrefs() { window.dispatchEvent(new CustomEvent('open-prefs')); }

  function toggleDepth() { colorDepth.update((d) => (d === 'truecolor' ? '256' : 'truecolor')); }
</script>

<svelte:window onclick={(e) => { if (!e.target.closest('.menubar')) closeAll(true); }} onkeydowncapture={onWindowKey} />

<div class="menubar" role="menubar" aria-label="Application menu" tabindex="-1" onkeydown={onMenuKey}>
  <span class="logo">paintty</span>
  {#each menuNames as name}
    <div class="menu-wrap">
      <button class="item" class:open={open === name} role="menuitem" aria-haspopup="menu"
        aria-expanded={open === name} use:registerTrigger={name}
        onclick={(event) => toggleFromClick(event, name)}
        onkeydown={(event) => onTriggerKey(event, name)} onpointerenter={() => hoverOpen(name)}>{name}</button>
      {#if open === name}
        <div class="dropdown" role="menu" aria-label={`${name} menu`} tabindex="-1" bind:this={dropdownEl}
          use:popupFocus={{ initialFocus: (node) => edgeItem(node, menuFocusEdge), restoreFocus: false }}>
          {#each menus[name] as item}
            {#if item === null}
              <div class="divider" role="separator"></div>
            {:else}
              <div class="menu-entry" class:has-submenu={item.recent}
                onpointerenter={() => (recentOpen = !!item.recent)}>
                <button class="menu-item" class:submenu-trigger={item.recent}
                  role="menuitem" data-recent={item.recent ? 'true' : undefined}
                  use:registerRecentTrigger={item.recent}
                  disabled={itemDisabled(item)}
                  aria-haspopup={item.recent ? 'menu' : undefined}
                  aria-expanded={item.recent ? recentOpen : undefined}
                  onclick={() => item.recent ? openRecentMenu('first') : run(item)}>
                  <span>{item.label}</span>
                  {#if item.shortcut}<span class="menu-shortcut">{item.shortcut}</span>{/if}
                  {#if item.recent}<span class="submenu-arrow">›</span>{/if}
                </button>
                {#if item.recent && recentOpen}
                  <div class="dropdown submenu" role="menu" aria-label="Open Recent" tabindex="-1"
                    bind:this={recentMenuEl}
                    use:popupFocus={{ initialFocus: (node) => edgeItem(node, 'first'), restoreFocus: false }}>
                    {#if !$recentProjects.length}
                      <button class="menu-item" role="menuitem" disabled>No recent projects</button>
                    {:else}
                      {#each $recentProjects as project (project.id)}
                        <button class="menu-item recent-item" role="menuitem" title={project.name}
                          onclick={() => runRecent(project)}>{recentLabel(project)}</button>
                      {/each}
                    {/if}
                    <div class="divider" role="separator"></div>
                    <button class="menu-item" role="menuitem" disabled={!$recentProjects.length}
                      onclick={clearRecents}>Clear Recent</button>
                  </div>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/each}
  <span class="spacer"></span>
  <button class="colortoggle" data-keyboard-context="neutral"
    onclick={toggleDepth} title="Toggle color depth">{$colorDepth}</button>
</div>

<style>
  .menubar {
    grid-area: menubar; display: flex; align-items: center; gap: 2px;
    padding: 0 10px; background: var(--panel); border-bottom: 1px solid var(--border);
    position: relative; z-index: 70; white-space: nowrap; overflow: visible;
  }
  .logo {
    color: var(--accent); font-weight: bold; letter-spacing: 0.5px;
    margin-right: 12px; font-family: var(--font-mono);
  }
  .menu-wrap { position: relative; flex-shrink: 0; }
  .item {
    padding: 4px 8px; border-radius: var(--radius-sm); color: var(--text-dim);
    background: transparent; border: none; white-space: nowrap;
  }
  .item:hover, .item.open { background: var(--panel-hi); color: var(--text); }
  .dropdown {
    position: absolute; top: 100%; left: 0; min-width: 170px; margin-top: 2px;
    background: var(--panel-hi); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: 0 6px 20px var(--shadow-popover); padding: 4px; z-index: 80;
  }
  .menu-item {
    display: flex; width: 100%; align-items: center; justify-content: space-between;
    text-align: left; padding: 6px 10px;
    border-radius: var(--radius-sm); background: transparent; border: none;
    color: var(--text); font-size: 12px; white-space: nowrap;
  }
  .menu-item:not(:disabled):hover { background: var(--accent-dim); }
  .menu-item:disabled { color: var(--text-faint); cursor: not-allowed; }
  .menu-entry { position: relative; }
  .submenu-trigger { gap: 18px; }
  .submenu-arrow { color: var(--text-dim); font-size: 14px; line-height: 10px; }
  .menu-shortcut { margin-left: 20px; color: var(--text-faint); font-size: 11px; }
  .submenu { top: -5px; left: calc(100% + 3px); min-width: 210px; margin-top: 0; }
  .recent-item { display: block; overflow: hidden; text-overflow: ellipsis; }
  .divider { height: 1px; background: var(--border); margin: 4px 6px; }
  .spacer { flex: 1; }
  .colortoggle {
    color: var(--text); font-size: 11px; padding: 3px 8px; width: 74px; text-align: center;
    border: 1px solid var(--accent-dim); border-radius: var(--radius-sm); background: var(--accent-wash);
  }
  .colortoggle:hover { background: var(--accent-wash-hover); }
</style>
