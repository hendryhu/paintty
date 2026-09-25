<script lang="ts">
  import Icon from './Icon.svelte';
  import { onMount, tick } from 'svelte';
  import NumberField from './NumberField.svelte';
  import { canvasFont } from '../lib/font.js';
  import { drawContentMaskThumbnail, drawEffectMaskThumbnail, drawLayerThumbnail } from '../lib/layerThumbnail.js';
  import { layers, dims, activeLayerId, activeLayerPart, selectedLayerIds, selectLayerPart, selectContentMask, selectEffectMask, selectLayerWithModifiers, clearLayerSelection, addLayer, addGroup, removeLayers, removeSelectedLayers, toggleLayerVisible, toggleEffectClipped, toggleEffectMask, toggleContentMask, createContentMask, createEffectMask, fillContentMask, fillEffectMask, invertContentMask, invertEffectMask, isContentMaskable, reorderSelectedLayers, moveLayerToGap, rasterizeLayer, renameLayer, groupActiveLayer, toggleGroupCollapsed, setLayerOpacity, beginStroke, endStroke, cancelStroke, effContentMaskOffset, effMaskOffset, canonicalLayerDropGap } from '../lib/grid.js';
  import { playing } from '../lib/frames.js';
  import { canConvertImageToCells, canConvertVideoFrameToCells, canRelinkVideo, planLayerDeleteContext } from '../lib/layerActions.js';
  import { videoRasterStatus } from '../lib/video.js';
  import {
    captureProjectRevision,
    isProjectRevisionCurrent,
    onProjectReplaced,
  } from '../lib/documentLifecycle.js';
  import { canMoveLayerTarget } from '../lib/selection.js';
  import { createControlledTextHistory } from '../lib/textEditing.js';
  import {
    releaseVisualMediaRequests,
    syncVisualMediaRequests,
  } from '../lib/mediaRuntime.js';
  import {
    isEditingTarget,
    keyboardContextOwns,
    keyboardDeleteAction,
    noteKeyboardContext,
    planSelectionDeselect,
    releaseKeyboardContext,
    setKeyboardContext,
  } from '../lib/timelineKeys.js';
  import { popupFocus, popupOpen } from '../lib/popupFocus.js';
  import { notifyInfo } from '../lib/notifications.js';
  import type {
    EditorContentMask,
    EditorEffectMask,
    EditorLayer,
    EditorLayerPart,
    EditorPoint,
  } from '../lib/types/editor-domain.js';

  interface Props {
    disabled?: boolean;
    onclick?: (event: MouseEvent) => void;
  }

  interface NumberFieldDetail {
    value: number;
    source: 'drag' | 'keyboard' | 'typing';
  }

  interface LayerDropGap {
    beforeId: string | null;
    intoGroup: boolean;
  }

  type LayerDeletePlan = NonNullable<ReturnType<typeof planLayerDeleteContext>>;
  type LayerContext = LayerDeletePlan & {
    x: number;
    y: number;
    id: string;
    part: EditorLayerPart;
  };
  type LayerContextAction =
    | 'clip-effect' | 'convert' | 'create-mask-white' | 'create-mask-black'
    | 'create-content-mask-white' | 'create-content-mask-black'
    | 'delete' | 'fill-mask-white' | 'fill-mask-black' | 'fill-content-mask-white' | 'fill-content-mask-black'
    | 'group' | 'invert-mask' | 'invert-content-mask'
    | 'mask-effect' | 'mask-content' | 'move' | 'rasterize' | 'relink' | 'rename';

  interface RenameState {
    value: string;
    start: number;
    end: number;
    direction: 'backward' | 'forward' | 'none';
  }

  interface LayerThumbnailParams {
    layer: EditorLayer;
    font: string;
  }

  interface MaskThumbnailParams {
    mask: EditorEffectMask | EditorContentMask;
    width: number;
    height: number;
    offset: EditorPoint;
  }

  let { disabled = false, onclick = () => {} }: Props = $props();

  function onLayerClick(e: MouseEvent, id: string): void {
    setKeyboardContext('layers');
    selectLayerWithModifiers(id, e);
  }
  function requestConvert(id: string): void {
    window.dispatchEvent(new CustomEvent('open-image-convert', { detail: { id } }));
  }


  function updateLayerOpacity(detail: NumberFieldDetail): void {
    if (!$playing && canSetOpacity && activeLayer) setLayerOpacity(activeLayer.id, detail.value / 100);
  }

  function finishNumberScrub(detail: NumberFieldDetail): void {
    if (detail.source === 'drag') endStroke();
  }

  onMount(() => {
    const h = () => {
      if ($playing) return;
      const active = $layers.find((l) => l.id === $activeLayerId);
      if (canConvertImageToCells(active) && active) requestConvert(active.id);
    };
    window.addEventListener('convert-image', h);
    const renameActive = () => startRename($activeLayerId);
    window.addEventListener('rename-active-layer', renameActive);
    const stopProjectReplaced = onProjectReplaced(() => {
      renameSession += 1;
      renameCommitAllowed = false;
      editingId = null;
      renameHistory.reset();
      ctx = null;
      dragFromId = null;
      dropGap = null;
      releaseKeyboardContext('layers');
    });
    return () => {
      stopProjectReplaced();
      window.removeEventListener('convert-image', h);
      window.removeEventListener('rename-active-layer', renameActive);
    };
  });

  let dragFromId: string | null = null;
  let dropGap = $state<LayerDropGap | null>(null);
  const INDENT_PX = 24;
  function onDragStart(id: string): void { if (!$playing) dragFromId = id; }
  function onDragOver(layer: EditorLayer, e: DragEvent): void {
    if ($playing) return;
    e.preventDefault();
    if (layer.id === dragFromId) { dropGap = null; return; }
    const target = e.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const r = target.getBoundingClientRect();
    const after = (e.clientY - r.top) > r.height / 2;
    // Resolve gaps against visible rows so the indicator matches the eventual drop.
    const vis = visibleLayers;
    const vidx = vis.findIndex((l) => l.id === layer.id);
    let beforeId = after ? (vis[vidx + 1]?.id ?? null) : layer.id;
    if (beforeId === dragFromId) beforeId = vis[vidx + 2]?.id ?? null;
    const indented = (e.clientX - r.left) > INDENT_PX;
    const near = after ? vis[vidx + 1] : layer;
    const nearInGroup = !!(near && near.groupId) || (layer.type === 'group' && after);
    const sourceId = dragFromId;
    if (sourceId == null) return;
    dropGap = canonicalLayerDropGap(
      $layers, $selectedLayerIds, sourceId, beforeId, indented || nearInGroup,
    );
  }
  function onDrop(): void {
    if ($playing) { onDragEnd(); return; }
    if (dragFromId != null && dropGap) {
      if ($selectedLayerIds.has(dragFromId) && $selectedLayerIds.size > 1) {
        reorderSelectedLayers(dropGap.beforeId, dropGap.intoGroup);
      } else {
        moveLayerToGap(dragFromId, dropGap.beforeId, dropGap.intoGroup);
      }
    }
    dragFromId = null; dropGap = null;
  }
  function onDragEnd(): void { dragFromId = null; dropGap = null; }
  function onDragOverContainer(e: DragEvent): void {
    e.preventDefault();
    if ($playing || dragFromId == null) return;
    if (e.target instanceof Element && e.target.closest('.layer')) return;
    dropGap = { beforeId: null, intoGroup: false };
  }

  let editingId = $state<string | null>(null), editValue = $state('');
  let editInputEl = $state<HTMLInputElement>();
  let renameSession = $state(0);
  let renameCommitAllowed = $state(false);
  let renameProjectRevision: number | null = null;
  const renameHistory = createControlledTextHistory();
  function captureRenameState(): RenameState {
    return {
      value: editValue,
      start: editInputEl?.selectionStart ?? editValue.length,
      end: editInputEl?.selectionEnd ?? editValue.length,
      direction: editInputEl?.selectionDirection || 'none',
    };
  }
  function onRenameBeforeInput(event: InputEvent): void {
    renameHistory.beforeInput(event, captureRenameState());
  }
  function onRenameInput() {
    renameHistory.input(true);
  }
  async function restoreRenameState(state: RenameState): Promise<void> {
    if (editingId == null) return;
    editValue = state.value;
    await tick();
    if (editingId == null || !editInputEl) return;
    editInputEl.focus({ preventScroll: true });
    editInputEl.setSelectionRange(state.start, state.end, state.direction);
  }
  async function startRename(id: string | null): Promise<void> {
    if ($playing || id == null) return;
    const l = $layers.find((x) => x.id === id);
    if (!l) return;
    const session = ++renameSession;
    releaseKeyboardContext('layers');
    activeLayerId.set(id);
    renameCommitAllowed = true;
    renameProjectRevision = captureProjectRevision();
    editingId = id; editValue = l.name;
    renameHistory.reset();
    await tick();
    if (session === renameSession && editingId === id) editInputEl?.select();
  }
  async function restoreRenameRow(id: string, session: number): Promise<void> {
    await tick();
    if (session !== renameSession || editingId != null) return;
    const row = panelEl?.querySelector<HTMLElement>(`[data-layer-id="${id}"]`);
    if (!row) return;
    row.focus({ preventScroll: true });
    if (document.activeElement === row) setKeyboardContext('layers');
  }
  function finishRename({ commit = true, restoreRow = false }: {
    commit?: boolean;
    restoreRow?: boolean;
  } = {}): void {
    if (editingId == null) return;
    const id = editingId;
    const name = editValue.trim();
    const projectCurrent = renameProjectRevision != null &&
      isProjectRevisionCurrent(renameProjectRevision);
    const session = ++renameSession;
    renameCommitAllowed = false;
    editingId = null;
    renameHistory.reset();
    if (commit && projectCurrent && name) renameLayer(id, name);
    if (restoreRow && projectCurrent) restoreRenameRow(id, session);
  }
  function commitRename() {
    if (renameCommitAllowed) finishRename();
  }
  function onRenameKey(e: KeyboardEvent): void {
    if (renameHistory.keydown(e, captureRenameState(), restoreRenameState)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      finishRename({ restoreRow: true });
    }
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finishRename({ commit: false, restoreRow: true });
    }
  }

  let panelEl = $state<HTMLDivElement>();
  let lastRevealedId = $state<string | null>(null);
  function onKey(e: KeyboardEvent): void {
    if (disabled) return;
    if (e.key === 'Escape' && ctx) {
      e.preventDefault();
      e.stopImmediatePropagation();
      ctx = null;
      return;
    }
    if ($popupOpen) return;
    if (!keyboardContextOwns('layers', e)) return;
    const editing = editingId != null || isEditingTarget(e.target);
    const deselect = planSelectionDeselect(e, {
      context: 'layers',
      typing: editing,
      popupOpen: $popupOpen,
    });
    if (deselect.context === 'layers') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!clearLayerSelection() && $activeLayerId != null) notifyInfo('Selection cleared.');
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (editing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const action = keyboardDeleteAction('layers', {
        editing,
        playing: $playing,
        activeLayerId: $activeLayerId,
        selectedLayerCount: $selectedLayerIds.size,
      });
      if (action === 'layer') removeSelectedLayers();
      return;
    }
    if (editing || $playing) return;
    if (e.key === 'F2') { e.preventDefault(); startRename($activeLayerId); }
  }

  let newLayerOpen = $state(false);
  let newLayerEl = $state<HTMLDivElement>();
  let newLayerTriggerEl = $state<HTMLButtonElement>();
  type NewLayerKind = 'cell' | 'background' | 'effect' | 'color-clip';
  const NEW_LAYER_OPTIONS: Array<{ kind: NewLayerKind; label: string }> = [
    { kind: 'cell', label: 'Glyph Layer' },
    { kind: 'background', label: 'Background Layer' },
    { kind: 'effect', label: 'Effect Layer' },
    { kind: 'color-clip', label: 'Colour Clip Layer' },
  ];

  async function openNewLayer(trigger: HTMLButtonElement): Promise<void> {
    if (disabled || $playing) return;
    ctx = null;
    newLayerOpen = true;
    newLayerTriggerEl = trigger;
    setKeyboardContext('layers');
    await tick();
    if (newLayerEl) {
      const first = newLayerEl.querySelector('button:not(:disabled)') as HTMLButtonElement | null;
      first?.focus();
    }
  }

  function closeNewLayer(): void {
    if (!newLayerOpen) return;
    newLayerOpen = false;
    newLayerTriggerEl?.focus();
  }

  function createNewLayer(kind: NewLayerKind): void {
    newLayerOpen = false;
    addLayer(kind);
  }

  function onNewLayerKey(e: KeyboardEvent): void {
    if (!newLayerOpen || !newLayerEl) return;
    const buttons = [...newLayerEl.querySelectorAll('button:not(:disabled)')] as HTMLButtonElement[];
    if (!buttons.length) return;
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault(); e.stopImmediatePropagation();
      buttons[(currentIndex + 1) % buttons.length]!.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); e.stopImmediatePropagation();
      buttons[(currentIndex - 1 + buttons.length) % buttons.length]!.focus();
    } else if (e.key === 'Home') {
      e.preventDefault(); e.stopImmediatePropagation();
      buttons[0]!.focus();
    } else if (e.key === 'End') {
      e.preventDefault(); e.stopImmediatePropagation();
      buttons.at(-1)!.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      closeNewLayer();
    }
  }

  let ctx = $state<LayerContext | null>(null);
  let ctxEl = $state<HTMLDivElement>();
  async function openCtx(e: MouseEvent, id: string, part: EditorLayerPart = 'layer'): Promise<void> {
    e.preventDefault();
    const planned = planLayerDeleteContext(
      $layers,
      part === 'layer' ? $selectedLayerIds : new Set([id]),
      id,
    );
    if (!planned || !selectLayerPart(id, part, part === 'layer' && planned.preserveSelection)) return;
    setKeyboardContext('layers');
    ctx = { x: e.clientX, y: e.clientY, id, part, ...planned };
    await tick();
    if (!ctxEl || ctx?.id !== id) return;
    const rect = ctxEl.getBoundingClientRect();
    const margin = 6;
    ctx = {
      ...ctx,
      x: Math.max(margin, Math.min(ctx.x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(ctx.y, window.innerHeight - rect.height - margin)),
    };
  }
  function ctxAction(kind: LayerContextAction): void {
    if ($playing || !ctx) return;
    const id = ctx.id;
    if (kind === 'delete') removeLayers(ctx.deleteIds, { includeGroupDescendants: false });
    if (kind === 'move' && canMoveLayerTarget(contextLayer, ctx.part)) {
      selectLayerPart(id, ctx.part, ctx.part === 'layer' && $selectedLayerIds.has(id));
      window.dispatchEvent(new CustomEvent('move-layer'));
    }
    if (kind === 'convert') requestConvert(id);
    if (kind === 'relink') window.dispatchEvent(new CustomEvent('relink-video', { detail: { id } }));
    if (kind === 'rasterize') rasterizeLayer(id);
    if (kind === 'group') { activeLayerId.set(id); groupActiveLayer(); }
    if (kind === 'clip-effect') toggleEffectClipped(id);
    if (kind === 'mask-effect') toggleEffectMask(id);
    if (kind === 'create-mask-white') createEffectMask(id, 1);
    if (kind === 'create-mask-black') createEffectMask(id, 0);
    if (kind === 'fill-mask-white') fillEffectMask(id, 1);
    if (kind === 'fill-mask-black') fillEffectMask(id, 0);
    if (kind === 'invert-mask') invertEffectMask(id);
    if (kind === 'mask-content') toggleContentMask(id);
    if (kind === 'create-content-mask-white') { createContentMask(id, 1); selectContentMask(id); }
    if (kind === 'create-content-mask-black') { createContentMask(id, 0); selectContentMask(id); }
    if (kind === 'fill-content-mask-white') fillContentMask(id, 1);
    if (kind === 'fill-content-mask-black') fillContentMask(id, 0);
    if (kind === 'invert-content-mask') invertContentMask(id);
    if (kind === 'rename') { ctx = null; startRename(id); return; }
    ctx = null;
  }
  function closeCtx() { ctx = null; }
  function selectMask(id: string): void {
    ctx = null;
    setKeyboardContext('layers');
    selectEffectMask(id);
  }
  function selectContentMaskFromRow(event: MouseEvent, id: string): void {
    event.stopPropagation();
    ctx = null;
    setKeyboardContext('layers');
    selectContentMask(id);
  }
  function addContentMaskFromRow(event: MouseEvent, id: string): void {
    event.stopPropagation();
    createContentMask(id, 1);
    selectContentMask(id);
  }
  function toggleGroup(event: MouseEvent, id: string): void {
    event.stopPropagation();
    if (!$playing) toggleGroupCollapsed(id);
  }
  function toggleVisibility(event: MouseEvent, id: string): void {
    event.stopPropagation();
    toggleLayerVisible(id);
  }
  function selectMaskFromRow(event: MouseEvent, id: string): void {
    event.stopPropagation();
    selectMask(id);
  }
  function openMaskContext(event: MouseEvent, id: string): void {
    event.stopPropagation();
    openCtx(event, id, 'mask');
  }
  function openContentMaskContext(event: MouseEvent, id: string): void {
    event.stopPropagation();
    openCtx(event, id, 'content-mask');
  }
  function renameInputClick(event: MouseEvent): void {
    event.stopPropagation();
    onclick(event);
  }
  function startRenameFromRow(event: MouseEvent, id: string): void {
    event.stopPropagation();
    startRename(id);
  }

  function drawThumb(node: HTMLCanvasElement, value: LayerThumbnailParams) {
    const requestOwner: object = {};
    const render = ({ layer, font }: LayerThumbnailParams): void => drawLayerThumbnail(node, layer, font);
    const update = (next: LayerThumbnailParams): void => {
      syncVisualMediaRequests(
        requestOwner,
        next.layer?.type === 'image' && next.layer.assetId ? [next.layer.assetId] : [],
      );
      render(next);
    };
    update(value);
    return {
      update,
      destroy() { releaseVisualMediaRequests(requestOwner); },
    };
  }
  function drawMaskThumb(node: HTMLCanvasElement, value: MaskThumbnailParams) {
    const render = ({ mask, width, height, offset }: MaskThumbnailParams): void =>
      drawEffectMaskThumbnail(node, mask, width, height, offset);
    render(value);
    return { update: render };
  }
  function drawContentMaskThumb(node: HTMLCanvasElement, value: MaskThumbnailParams) {
    const render = ({ mask, width, height, offset }: MaskThumbnailParams): void =>
      drawContentMaskThumbnail(node, mask as EditorContentMask, width, height, offset);
    render(value);
    return { update: render };
  }
  let collapsed = $derived(new Set($layers.filter((l) => l.type === 'group' && l.collapsed).map((l) => l.id)));
  let visibleLayers = $derived($layers.filter((l) => !(l.groupId && collapsed.has(l.groupId))));
  let activeLayer = $derived($layers.find((l) => l.id === $activeLayerId));
  let canSetOpacity = $derived(!!activeLayer && activeLayer.type !== 'group' && activeLayer.type !== 'effect');
  let layerOpacity = $derived(Math.round((activeLayer && activeLayer.type !== 'group' && activeLayer.type !== 'effect'
    ? activeLayer.opacity ?? 1 : 1) * 100));
  let contextLayer = $derived.by(() => {
    const contextId = ctx?.id;
    return contextId ? $layers.find((layer) => layer.id === contextId) : null;
  });
  $effect(() => {
    if (editingId != null && !$layers.some((layer) => layer.id === editingId)) {
      renameSession += 1;
      renameCommitAllowed = false;
      editingId = null;
      renameHistory.reset();
    }
  });
  $effect(() => {
    if (panelEl && $activeLayerId !== lastRevealedId) {
      const id = $activeLayerId;
      lastRevealedId = id;
      tick().then(() => {
        if (id === $activeLayerId) panelEl?.querySelector(`[data-layer-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
      });
    }
  });
</script>

<svelte:window onkeydowncapture={onKey}
  onpointerdowncapture={(event) => noteKeyboardContext({
    target: event.target instanceof Element ? event.target : null,
  })} onclick={(e) => { closeCtx(); if (newLayerOpen && newLayerEl && !newLayerEl.contains(e.target as Node) && !newLayerTriggerEl?.contains(e.target as Node)) closeNewLayer(); }} />

<div class="ui-panel-title layers-title" data-keyboard-context="layers">
  <span>Layers</span>
  <span class="opacity-control">
    <span>Opacity</span>
    <NumberField ariaLabel="Layer opacity" min={0} max={100} step={1} value={layerOpacity}
      disabled={disabled || $playing || !canSetOpacity} onScrubStart={beginStroke} onInput={updateLayerOpacity}
      onChange={finishNumberScrub} onScrubCancel={cancelStroke} />
    <span>%</span>
    <span class="info" title="For reference only" aria-label="For reference only">
      <Icon icon="material-symbols:info-outline" />
    </span>
  </span>
  <!-- Stack-level actions stay separate from layer creation choices. -->
  <span class="title-actions">
    <button class="delete-layer" disabled={disabled || $playing || $activeLayerId == null}
      onclick={removeSelectedLayers} title="Delete selected layers"><Icon icon="material-symbols:delete-outline" /></button>
    <button class="add" disabled={disabled || $playing} onclick={addGroup} title="New group"><Icon icon="material-symbols:create-new-folder-outline" /></button>
    <button class="add" disabled={disabled || $playing}
      onclick={(e) => { if (newLayerOpen) closeNewLayer(); else openNewLayer(e.currentTarget); }}
      title="New layer" aria-haspopup="menu" aria-expanded={newLayerOpen}
      onkeydown={(e) => { if (e.key === 'ArrowDown' && !newLayerOpen) { e.preventDefault(); openNewLayer(e.currentTarget as HTMLButtonElement); } }}>
      <Icon icon="material-symbols:add" />
    </button>
  </span>
</div>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="layers scroll" bind:this={panelEl} tabindex="0"
     role="group" aria-label="Layer stack" data-keyboard-context="layers"
     ondragover={onDragOverContainer} ondrop={onDrop}>
  <!-- Each row owns selection, drag positioning, visibility, and its type preview. -->
  {#each visibleLayers as layer (layer.id)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="layer" class:active={$activeLayerId === layer.id} class:selected={$selectedLayerIds.has(layer.id)}
      data-layer-id={layer.id}
      class:drop-before={dropGap && dropGap.beforeId === layer.id}
      class:drop-into={dropGap && dropGap.beforeId === layer.id && dropGap.intoGroup}
      class:group={layer.type === 'group'} class:child={!!layer.groupId}
      draggable={!disabled && !$playing}
      ondragstart={() => onDragStart(layer.id)}
      ondragover={(e) => onDragOver(layer, e)}
      ondrop={onDrop}
      ondragend={onDragEnd}
      onclick={(e) => onLayerClick(e, layer.id)}
      oncontextmenu={(e) => openCtx(e, layer.id, 'layer')}
      role="button" tabindex="0"
    >
      {#if layer.type === 'group'}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <span class="caret" class:locked={$playing} onclick={(event) => toggleGroup(event, layer.id)}
          role="button" tabindex={$playing ? -1 : 0} aria-disabled={$playing}>
          <Icon icon={layer.collapsed ? 'material-symbols:chevron-right' : 'material-symbols:expand-more'} />
        </span>
      {:else}
        <span class="caret-spacer"></span>
      {/if}
      <button class="eye" disabled={disabled || $playing} onclick={(event) => toggleVisibility(event, layer.id)} title={layer.visible ? 'Hide layer' : 'Show layer'}>
        <Icon icon={layer.visible ? 'material-symbols:visibility' : 'material-symbols:visibility-off'} />
      </button>
      {#if layer.type === 'group'}
        <span class="thumb group-icon"><Icon icon="material-symbols:folder" /></span>
      {:else if layer.type === 'video'}
        <span class="thumb video-icon"><Icon icon="material-symbols:movie-outline" /></span>
      {:else if layer.type === 'effect'}
        {#if layer.clipped || layer.effect?.kind === 'color-clip'}
          <span class="clip-indicator" title="Clipped to layer below" aria-label="Clipped to layer below">
            <Icon icon="material-symbols:keyboard-arrow-down" />
          </span>
        {/if}
        <span class="thumb effect-icon"><Icon icon="material-symbols:auto-fix-high" /></span>
      {:else if layer.type === 'shape' && layer.shape?.channel === 'color-clip'}
        <span class="clip-indicator" title="Clipped to layer below" aria-label="Clipped to layer below">
          <Icon icon="material-symbols:keyboard-arrow-down" />
        </span>
        <canvas class="thumb" use:drawThumb={{ layer, font: $canvasFont }}></canvas>
      {:else}
        <canvas class="thumb" use:drawThumb={{ layer, font: $canvasFont }}></canvas>
      {/if}
      {#if layer.type === 'effect' && layer.mask}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <canvas class="thumb mask-thumb" class:active-mask={$activeLayerId === layer.id && $activeLayerPart === 'mask'}
          use:drawMaskThumb={{ mask: layer.mask, width: $dims.w, height: $dims.h, offset: effMaskOffset($layers, layer) }}
          onclick={(event) => selectMaskFromRow(event, layer.id)}
          oncontextmenu={(event) => openMaskContext(event, layer.id)} title="Effect mask"></canvas>
      {/if}
      {#if isContentMaskable(layer)}
        {#if layer.contentMask}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <canvas class="thumb mask-thumb" class:active-mask={$activeLayerId === layer.id && $activeLayerPart === 'content-mask'}
            use:drawContentMaskThumb={{ mask: layer.contentMask, width: $dims.w, height: $dims.h, offset: effContentMaskOffset($layers, layer) }}
            onclick={(event) => selectContentMaskFromRow(event, layer.id)}
            oncontextmenu={(event) => openContentMaskContext(event, layer.id)} title="Content mask"></canvas>
        {:else}
          <button class="mask-button" disabled={disabled || $playing}
            onclick={(event) => addContentMaskFromRow(event, layer.id)}
            oncontextmenu={(event) => { event.stopPropagation(); openCtx(event, layer.id, 'layer'); }}
            title="Add content mask" aria-label="Add content mask">◐</button>
        {/if}
      {/if}
      {#if editingId === layer.id}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <input class="name-input" bind:this={editInputEl} bind:value={editValue}
          onclick={renameInputClick} onbeforeinput={onRenameBeforeInput} oninput={onRenameInput}
          onblur={commitRename} onkeydown={onRenameKey} />
      {:else}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <span class="name" ondblclick={(event) => startRenameFromRow(event, layer.id)}>{layer.name}</span>
      {/if}
      <span class="type">{layer.type === 'cell' ? 'glyph' : layer.type === 'background' ? 'bg' : layer.type === 'effect' && layer.effect?.kind === 'color-clip' ? 'clip' : layer.type === 'shape' && layer.shape?.channel === 'color-clip' ? 'clip shape' : layer.type}</span>
    </div>
  {/each}
  <div class="drop-end" class:active={dropGap && dropGap.beforeId === null}></div>
  {#if !$layers.length}
    <div class="empty">
      <span>Transparent canvas</span>
      <button disabled={disabled || $playing} onclick={(e) => openNewLayer(e.currentTarget)}>New Layer</button>
    </div>
  {/if}
</div>

<!-- Layer and mask context actions are anchored to the explicit row part. -->
{#if ctx}
  <div class="ctx ui-popover-menu" bind:this={ctxEl} role="menu" tabindex="-1"
    use:popupFocus={{ initialFocus: 'button:not([disabled])' }}
    style="left: {ctx.x}px; top: {ctx.y}px;" data-keyboard-context="layers">
    <button role="menuitem" disabled={$playing} onclick={() => ctxAction('rename')}>Rename</button>
    {#if canMoveLayerTarget(contextLayer, ctx.part)}
      <button role="menuitem" disabled={$playing} onclick={() => ctxAction('move')}>Move</button>
    {/if}
    {#if canConvertImageToCells(contextLayer)}
      <button role="menuitem" disabled={$playing} onclick={() => ctxAction('convert')}>Convert image to cells…</button>
    {/if}
    {#if canConvertVideoFrameToCells(contextLayer)}
      <button role="menuitem" disabled={$playing} onclick={() => ctxAction('convert')}>Convert current frame to cells…</button>
    {/if}
    {#if canRelinkVideo(contextLayer, contextLayer ? $videoRasterStatus.get(contextLayer.id) || null : null)}
      <button role="menuitem" disabled={$playing} onclick={() => ctxAction('relink')}>Relink…</button>
    {/if}
    {#if contextLayer?.type === 'effect'}
      <button role="menuitem" disabled={$playing} onclick={() => ctxAction('clip-effect')}>{contextLayer.clipped ? '✓ Clip to layer below' : 'Clip to layer below'}</button>
      {#if contextLayer.mask}
        {#if ctx.part === 'mask'}
          <button role="menuitem" disabled={$playing} onclick={() => ctxAction('fill-mask-white')}>Fill mask white</button>
          <button role="menuitem" disabled={$playing} onclick={() => ctxAction('fill-mask-black')}>Fill mask black</button>
          <button role="menuitem" disabled={$playing} onclick={() => ctxAction('invert-mask')}>Invert mask</button>
        {/if}
        <button role="menuitem" disabled={$playing} onclick={() => ctxAction('mask-effect')}>Remove mask</button>
      {:else}
        <button role="menuitem" disabled={$playing} onclick={() => ctxAction('create-mask-white')}>Create white mask</button>
        <button role="menuitem" disabled={$playing} onclick={() => ctxAction('create-mask-black')}>Create black mask</button>
      {/if}
    {/if}
    {#if isContentMaskable(contextLayer)}
      {#if contextLayer?.contentMask}
        {#if ctx.part === 'content-mask'}
          <button role="menuitem" disabled={$playing} onclick={() => ctxAction('fill-content-mask-white')}>Fill mask white</button>
          <button role="menuitem" disabled={$playing} onclick={() => ctxAction('fill-content-mask-black')}>Fill mask black</button>
          <button role="menuitem" disabled={$playing} onclick={() => ctxAction('invert-content-mask')}>Invert mask</button>
        {/if}
        <button role="menuitem" disabled={$playing} onclick={() => ctxAction('mask-content')}>Remove content mask</button>
      {:else}
        <button role="menuitem" disabled={$playing} onclick={() => ctxAction('create-content-mask-white')}>Create white content mask</button>
        <button role="menuitem" disabled={$playing} onclick={() => ctxAction('create-content-mask-black')}>Create black content mask</button>
      {/if}
    {/if}
    {#if contextLayer?.type === 'shape'}
      <button role="menuitem" disabled={$playing} onclick={() => ctxAction('rasterize')}>Rasterize</button>
    {/if}
    {#if contextLayer?.type !== 'group'}
      <button role="menuitem" disabled={$playing} onclick={() => ctxAction('group')}>Group</button>
    {/if}
    <div class="divider" role="separator"></div>
    <button class="danger" role="menuitem" disabled={$playing} onclick={() => ctxAction('delete')}>{ctx.deleteLabel}</button>
  </div>
{/if}

<!-- Layer creation uses one shared flyout rather than separate type buttons. -->
{#if newLayerOpen}
  <div class="ctx ui-popover-menu new-layer-menu" bind:this={newLayerEl} role="menu" tabindex="-1"
    aria-label="New layer" data-keyboard-context="layers"
    use:popupFocus
    onkeydown={onNewLayerKey}
    style="right: 10px; top: {newLayerTriggerEl ? newLayerTriggerEl.getBoundingClientRect().bottom + 4 : 0}px;">
    {#each NEW_LAYER_OPTIONS as option}
      <button role="menuitem" disabled={$playing} onclick={() => createNewLayer(option.kind)}>{option.label}</button>
    {/each}
  </div>
{/if}

<style>
  .layers-title {
    display: flex; flex-wrap: nowrap; align-items: center; gap: 5px 6px; flex-shrink: 0;
    white-space: nowrap;
  }
  .opacity-control { display: flex; align-items: center; gap: 3px; min-width: 0; margin-left: auto; font-size: 9px; letter-spacing: 0; text-transform: none; }
  .opacity-control :global(.number-field) { width: 38px; padding: 1px 4px; font-size: 10px; text-align: right; }
  .info { display: flex; align-items: center; color: var(--text-dim); font-size: 13px; }
  .title-actions { display: flex; gap: 3px; }
  .delete-layer,
  .add {
    width: 22px; height: 22px; padding: 0; color: var(--accent); cursor: pointer;
    font-size: 14px; display: flex; align-items: center; justify-content: center;
    background: transparent; border: none;
  }
  .delete-layer { color: var(--danger); background: transparent; border: none; }
  .delete-layer:disabled { opacity: 0.4; cursor: default; }
  .add:disabled, .empty button:disabled { opacity: 0.4; cursor: default; }
  .layers { flex: 1; overflow-y: auto; min-height: 40px; outline: none; }
  .empty { min-height: 120px; display: flex; flex-direction: column; align-items: stretch; justify-content: center; gap: 7px; padding: 16px; color: var(--text-dim); font-size: 11px; text-align: center; }
  .empty button { padding: 5px 8px; background: var(--panel-hi); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .layer {
    display: flex; align-items: center; gap: 8px; padding: 7px 10px;
    border-bottom: 1px solid var(--border); cursor: pointer;
  }
  .layer.group { background: var(--group-row); }
  .layer:hover { background: var(--panel-hi); }
  .layer.selected, .layer.active { background: var(--accent-dim); }
  .layer.active { box-shadow: inset 2px 0 0 var(--accent); }
  .layer.drop-before { box-shadow: inset 0 2px 0 var(--accent); }
  .layer.drop-before.drop-into { box-shadow: inset 24px 2px 0 -22px var(--accent), inset 0 2px 0 var(--accent-dim); }
  .drop-end { height: 8px; margin: 0 10px; border-top: 2px solid transparent; box-sizing: border-box; }
  .drop-end.active { border-color: var(--accent); }
  .layer.child { padding-left: 26px; position: relative; }
  .layer.child::before {
    content: ''; position: absolute; left: 15px; top: 0; bottom: 0;
    width: 1px; background: var(--accent-dim);
  }
  .caret, .caret-spacer { width: 16px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
  .caret { color: var(--text-dim); font-size: 15px; cursor: pointer; }
  .caret.locked { opacity: 0.4; cursor: default; }
  .group-icon { display: flex; align-items: center; justify-content: center; color: var(--accent); font-size: 18px; }
  .eye { color: var(--text-dim); display: flex; align-items: center; padding: 0; background: transparent; border: 0; font-size: 15px; }
  .eye:disabled { opacity: 0.4; }
  .layer.active .eye { color: var(--on-accent); }
  .thumb {
    width: 28px; height: 22px; background: var(--canvas-bg); border: 1px solid var(--border);
    border-radius: 3px; flex-shrink: 0; image-rendering: pixelated; object-fit: contain;
  }
  .video-icon, .effect-icon { display: flex; align-items: center; justify-content: center; color: var(--accent); font-size: 16px; }
  .clip-indicator { flex: 0 0 13px; display: flex; align-items: center; justify-content: center; color: var(--accent); font-size: 14px; }
  .mask-thumb { cursor: pointer; }
  .mask-thumb.active-mask { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .mask-button {
    width: 28px; height: 22px; flex: 0 0 28px; padding: 0;
    background: var(--canvas-bg); color: var(--text-faint); border: 1px dashed var(--border);
    border-radius: 3px; font: 14px/1 var(--font-mono);
  }
  .mask-button:not(:disabled):hover { color: var(--text); border-color: var(--accent); }
  .name {
    min-width: 0; flex: 1; overflow: hidden; font-size: 12px;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .name-input {
    flex: 1; min-width: 0; font-size: 12px; padding: 1px 4px;
    background: var(--panel); color: var(--text); border: 1px solid var(--accent); border-radius: 3px;
  }
  .type { font-size: 9px; color: var(--text-dim); text-transform: uppercase; }
  :global(.layers svg), :global(.add svg) { display: block; }

  .ctx { min-width: 150px; }
  .ctx button.danger:not(:disabled):hover { background: var(--danger-bg); }
  @container (max-width: 270px) {
    .layers-title {
      display: grid; grid-template-columns: auto 1fr;
      row-gap: 4px; white-space: normal;
    }
    .opacity-control { justify-self: end; }
    .title-actions { grid-column: 1 / -1; justify-self: end; }
  }
</style>
