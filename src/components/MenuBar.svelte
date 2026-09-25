<script lang="ts">
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
  import type { RecentProjectRecord } from '../lib/recentProjects.js';
  import { errorText } from '../lib/types/project-types.js';

  interface RelinkMediaDetail {
    assetId?: string | null;
  }

  interface Props {
    onExport?: () => void;
    onHelper?: () => void;
    onOpenProject?: () => void;
    onOpenRecent?: (detail: { project: RecentProjectRecord }) => void;
    onNewProject?: () => void;
    onProjectSettings?: () => void;
    onPurgeMedia?: () => void;
    onMenuState?: (detail: { open: boolean }) => void;
    onAssets?: () => void;
    onRelinkMedia?: (detail: RelinkMediaDetail) => void;
    onHelp?: (detail: { page: 'animation-json' | 'shortcuts' }) => void;
  }

  type MenuName = 'Edit' | 'File' | 'Help' | 'Layer';
  type MenuEdge = 'first' | 'last';

  interface MenuItem {
    label: string;
    shortcut?: string;
    action?: () => false | void | Promise<void>;
    recent?: boolean;
    disabled?: boolean | (() => boolean);
  }

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
  }: Props = $props();

  function importImage(): void {
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
      } catch (err: unknown) {
        if (!isProjectRevisionCurrent(revision)) return;
        notifyError('Could not import image: ' + errorText(err));
      }
    };
    input.click();
  }

  function videoAssetId(layerId: string | null): string | null {
    if (layerId == null) return null;
    const layer = getLayer(layerId);
    return layer?.type === 'video' ? layer.videoClip.assetId : null;
  }

  function chooseVideo(relinkId: string | null = null): void {
    if (get(playing)) return;
    const revision = captureProjectRevision();
    const startTick = get(playheadTick);
    const relinkAssetId = videoAssetId(relinkId);
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
              videoAssetId(relinkId) === relinkAssetId,
          });
          return;
        }
        await importMediaFile(file, 'video', {
          startTick,
          valid: () => isProjectRevisionCurrent(revision) && !get(playing),
        });
      } catch (err: unknown) {
        if (!isProjectRevisionCurrent(revision)) return;
        notifyError('Could not import video: ' + errorText(err));
      }
    };
    input.click();
  }

  function relinkVideo(id: string): void {
    if (getLayer(id)?.type !== 'video') {
      notifyError('Select a video layer first.');
      return;
    }
    chooseVideo(id);
  }

  function importAudio(): void {
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
      } catch (err: unknown) {
        if (isProjectRevisionCurrent(revision)) notifyError('Could not import audio: ' + errorText(err));
      }
    };
    input.click();
  }

  onMount(() => {
    const relink = (event: Event): void => {
      if (event instanceof CustomEvent && typeof event.detail?.id === 'string') relinkVideo(event.detail.id);
    };
    const relinkMedia = (event: Event): void => {
      if (event instanceof CustomEvent) onRelinkMedia(event.detail as RelinkMediaDetail);
    };
    const importProjectMedia = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const kind: unknown = event.detail?.kind;
      if (kind === 'image') importImage();
      else if (kind === 'audio') importAudio();
      else if (kind === 'video') chooseVideo();
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

  async function saveProject(saveAs: boolean = false): Promise<void> {
    try {
      await (saveAs ? saveJSONAs() : saveJSON());
    } catch (err: unknown) {
      notifyError(`Could not save file: ${errorText(err)}`);
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
    catch (err: unknown) {
      if (!(err instanceof Error) || err.name !== 'AbortError') notifyError(errorText(err));
    }
  }

  const menus: Record<MenuName, Array<MenuItem | null>> = {
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

  const menuNames = Object.keys(menus) as MenuName[];
  let open = $state<MenuName | null>(null);
  let popupBusyAtOpen = false;
  let recentOpen = $state(false);
  let restoreTrigger: HTMLButtonElement | null = null;
  let dropdownEl = $state<HTMLDivElement>();
  let recentMenuEl = $state<HTMLDivElement>();
  let recentTriggerEl: HTMLButtonElement | null = null;
  let menuFocusEdge = $state<MenuEdge>('first');
  const triggerNodes = new Map<MenuName, HTMLButtonElement>();
  $effect(() => {
    onMenuState({ open: open !== null });
  });
  let selectedLayer = $derived($layers.find((layer) => layer.id === $activeLayerId));
  let purgeUnusedCount = $derived.by(() => {
    $authoredRevision;
    $projectMediaRegistry;
    return unusedMediaAssets($projectMediaRegistry, currentMediaUsageCounts()).length;
  });

  function registerTrigger(node: HTMLButtonElement, name: MenuName): { destroy(): void } {
    triggerNodes.set(name, node);
    return { destroy: () => triggerNodes.delete(name) };
  }
  function registerRecentTrigger(node: HTMLButtonElement, enabled: boolean | undefined) {
    if (enabled) recentTriggerEl = node;
    return {
      update(next: boolean | undefined) { if (next) recentTriggerEl = node; },
      destroy() { if (recentTriggerEl === node) recentTriggerEl = null; },
    };
  }
  function menuItems(container: HTMLElement | null | undefined): HTMLButtonElement[] {
    return [...(container?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])]
      .filter((item) => !item.disabled && item.closest('[role="menu"]') === container);
  }
  function edgeItem(container: HTMLElement | null | undefined, edge: MenuEdge = 'first'): HTMLButtonElement | undefined {
    const items = menuItems(container);
    return edge === 'last' ? items.at(-1) : items[0];
  }
  function focusEdge(container: HTMLElement | null | undefined, edge: MenuEdge = 'first'): void {
    edgeItem(container, edge)?.focus({ preventScroll: true });
  }
  async function openMenu(
    name: MenuName,
    edge: MenuEdge = 'first',
    trigger: HTMLButtonElement | undefined = triggerNodes.get(name),
  ): Promise<void> {
    if (open === null) popupBusyAtOpen = get(popupOpen);
    restoreTrigger = trigger || restoreTrigger;
    menuFocusEdge = edge;
    open = name;
    recentOpen = false;
    await tick();
    focusEdge(dropdownEl, edge);
  }
  function toggle(name: MenuName, event: MouseEvent): void {
    if (open === name) closeAll(true);
    else if (event.currentTarget instanceof HTMLButtonElement) {
      openMenu(name, 'first', event.currentTarget);
    }
  }
  function toggleFromClick(event: MouseEvent, name: MenuName): void {
    event.stopPropagation();
    toggle(name, event);
  }
  function hoverOpen(name: MenuName): void {
    if (open !== null && open !== name) {
      openMenu(name, 'first', triggerNodes.get(name));
    }
  }
  function itemDisabled(item: MenuItem): boolean { return typeof item.disabled === 'function' ? item.disabled() : !!item.disabled; }
  function recentLabel(project: RecentProjectRecord): string {
    const duplicate = $recentProjects.some((item) =>
      item.id !== project.id && item.name.toLocaleLowerCase() === project.name.toLocaleLowerCase());
    if (!duplicate) return project.name;
    return `${project.name} — ${new Date(project.openedAt).toLocaleString()}`;
  }
  function run(item: MenuItem): void {
    if (!item.recent && !itemDisabled(item) && item.action) {
      closeAll(true);
      item.action();
    }
  }
  function runRecent(project: RecentProjectRecord): void {
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
  function closeAll(restore: boolean = false): void {
    const target = restore ? restoreTrigger : null;
    open = null;
    recentOpen = false;
    restoreTrigger = null;
    popupBusyAtOpen = false;
    target?.focus({ preventScroll: true });
  }
  async function openRecentMenu(edge: MenuEdge = 'first'): Promise<void> {
    recentOpen = true;
    await tick();
    focusEdge(recentMenuEl, edge);
  }
  function switchTopMenu(delta: number): void {
    const index = Math.max(0, open === null ? -1 : menuNames.indexOf(open));
    const next = menuNames[(index + delta + menuNames.length) % menuNames.length]!;
    openMenu(next, delta < 0 ? 'last' : 'first', triggerNodes.get(next));
  }
  function moveMenuFocus(container: HTMLElement, current: HTMLButtonElement, delta: number): void {
    const items = menuItems(container);
    const index = items.indexOf(current);
    if (!items.length) return;
    items[(Math.max(0, index) + delta + items.length) % items.length]!
      .focus({ preventScroll: true });
  }
  function consumeMenuKey(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function onTriggerKey(event: KeyboardEvent, name: MenuName): void {
    const edge = menuTriggerEdge(event.key);
    if (!edge) return;
    consumeMenuKey(event);
    if (event.currentTarget instanceof HTMLButtonElement) {
      openMenu(name, edge, event.currentTarget);
    }
  }
  function onMenuKey(event: KeyboardEvent): void {
    if (open === null) return;
    const target = event.target;
    const item = target instanceof Element
      ? target.closest<HTMLButtonElement>('[role="menuitem"]')
      : null;
    const container = item?.closest<HTMLElement>('[role="menu"]');
    const action = desktopMenuKeyAction(event.key, {
      hasSubmenu: item?.dataset['recent'] === 'true',
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
  function onWindowKey(event: KeyboardEvent): void {
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

  function onWindowClick(event: MouseEvent): void {
    if (!(event.target instanceof Element) || !event.target.closest('.menubar')) closeAll(true);
  }

  function toggleDepth() { colorDepth.update((d) => (d === 'truecolor' ? '256' : 'truecolor')); }
</script>

<svelte:window onclick={onWindowClick} onkeydowncapture={onWindowKey} />

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
              <div class="menu-entry" class:has-submenu={item.recent}>
                <button class="menu-item" class:submenu-trigger={item.recent}
                  onpointerenter={() => (recentOpen = !!item.recent)}
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
    position: relative; z-index: var(--z-menubar); white-space: nowrap; overflow: visible;
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
    border-radius: var(--radius); box-shadow: 0 6px 20px var(--shadow-popover); padding: 4px; z-index: var(--z-menu);
  }
  .menu-item {
    display: flex; width: 100%; align-items: center; justify-content: space-between;
    text-align: left; padding: 6px 10px;
    border-radius: var(--radius-sm); background: transparent; border: none;
    color: var(--text); font-size: 12px; white-space: nowrap;
  }
  .menu-item:not(:disabled):hover,
  .menu-item:not(:disabled):focus-visible { background: var(--accent-dim); }
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
