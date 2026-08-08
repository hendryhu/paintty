<script>
  import MenuBar from './components/MenuBar.svelte';
  import ToolOptionsBar from './components/ToolOptionsBar.svelte';
  import ToolsPanel from './components/ToolsPanel.svelte';
  import Canvas from './components/Canvas.svelte';
  import ColorPicker from './components/ColorPicker.svelte';
  import LayerPropertiesPanel from './components/LayerPropertiesPanel.svelte';
  import CharPicker from './components/CharPicker.svelte';
  import LayersPanel from './components/LayersPanel.svelte';
  import TimelineV2 from './components/TimelineV2.svelte';
  import SketchPopup from './components/SketchPopup.svelte';
  import GlyphContextMenu from './components/GlyphContextMenu.svelte';
  import ResizeHandle from './components/ResizeHandle.svelte';
  import Preferences from './components/Preferences.svelte';
  import ExportPopup from './components/ExportPopup.svelte';
  import ConvertPopup from './components/ConvertPopup.svelte';
  import TuiHelperPopup from './components/TuiHelperPopup.svelte';
  import HelpPopup from './components/HelpPopup.svelte';
  import StartupAssetsStrip from './components/StartupAssetsStrip.svelte';
  import ProjectAssets from './components/ProjectAssets.svelte';
  import NewProjectPopup from './components/NewProjectPopup.svelte';
  import ProjectSettings from './components/ProjectSettings.svelte';
  import PurgeUnusedMediaPopup from './components/PurgeUnusedMediaPopup.svelte';
  import DiscardChangesPopup from './components/DiscardChangesPopup.svelte';
  import { undo, redo, layers, activeLayerId, activeLayerPart, clearLayerSelection, cropPending } from './lib/grid.js';
  import {
    clipboardMediaPlacementSucceeded,
    clipboardPasteIntent,
    copyClipsForContext,
    pasteClipsFromClipboard,
  } from './lib/clipboard.js';
  import { importMediaFile } from './lib/mediaCommands.js';
  import { scheduleMediaCacheGc } from './lib/mediaGc.js';
  import { activeTool, altEyedrop, dirty, fileName, recentColors } from './lib/stores.js';
  import { colorEditSession } from './lib/colorEditSession.js';
  import { documentTitle } from './lib/documentState.js';
  import { dismissNotification, notifications, notifyError, notifyInfo } from './lib/notifications.js';
  import { selection, clearSelection, hasSelection, moveState, beginTransformSelection, beginLayerMove, finalizeMove, cancelMove } from './lib/selection.js';
  import {
    activeFrameIndex,
    clearClipSelection,
    durationTicks,
    fps,
    frames,
    gotoFrame,
    looping,
    playbackCycle,
    togglePlay,
  } from './lib/frames.js';
  import { playing } from './lib/playbackState.js';
  import { closeAudioPreview, startAudioPreview, stopAudioPreview } from './lib/audioPlayback.js';
  import { timelineTags } from './lib/clipTimelineState.js';
  import { validLoopRange } from './lib/timelineTags.js';
  import {
    editorEscapeAction,
    editorModalOpen,
    getKeyboardContext,
    isEditingTarget,
    isPlaybackShortcut,
    newProjectShortcutAction,
    noteKeyboardContext,
    planSelectionDeselect,
    releaseKeyboardContext,
  } from './lib/timelineKeys.js';
  import { onMount, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { disconnectWatchFolder, retryPreviewSync, startPreviewSync, watchFolderState } from './lib/livePreview.js';
  import { recoveryState, startBrowserRecovery } from './lib/recoveryRuntime.js';
  import { forgetRecentProject, recentProjectIdentity, startRecentProjectTracking } from './lib/recentProjects.js';
  import {
    captureProjectRevision, isProjectRevisionCurrent, notifyProjectCheckpoint,
    notifyProjectLoaded, onProjectReplaced,
  } from './lib/documentLifecycle.js';
  import { loadJSON, openFileDialog, saveJSON, saveJSONAs, serializeJSON } from './lib/fileio.js';
  import { performDiscardedProjectAction } from './lib/documentReplacement.js';
  import { popupFocus, popupOpen } from './lib/popupFocus.js';
  import { layerRenameShortcutAction, nativeInputOwnsKey, projectSaveShortcutAction } from './lib/inputPolicy.js';
  import { MINIMUM_VIEWPORT, viewportGate } from './lib/viewportGate.js';
  import { glyphPaintingUnavailable as glyphPaintingUnavailableFor } from './lib/toolAvailability.js';
  import {
    resizeRightPanelFromPointer,
    resizeRightPanelWithKey,
    rightPanelDividerGeometry,
  } from './lib/panelLayout.js';

  const CAN_EYEDROP = new Set([
    'brush', 'eraser', 'subcell', 'fill', 'line', 'rect', 'circle', 'polygon',
  ]);
  function refreshAlt(e) {
    altEyedrop.set(e.altKey && CAN_EYEDROP.has(get(activeTool)));
  }

  let rightEl = $state();
  let propertiesSectEl = $state();
  let charSectEl = $state();

  let sketchOpen = $state(false);
  let sketchTop = $state(100);
  let rightPanelLeft = $state(0);
  function measureRight() { if (rightEl) rightPanelLeft = rightEl.getBoundingClientRect().left; }

  let rightPanelWidth = $state(260);
  let timelineHeight = $state(280);
  let timelineExpanded = $state(false);
  let viewportState = $state(viewportGate(
    typeof window === 'undefined' ? MINIMUM_VIEWPORT.width : window.innerWidth,
    typeof window === 'undefined' ? MINIMUM_VIEWPORT.height : window.innerHeight,
  ));
  function measureViewport() {
    viewportState = viewportGate(window.innerWidth, window.innerHeight);
    measureRight();
  }
  let rightPanelDivider = $derived(rightPanelDividerGeometry(viewportState.width, rightPanelWidth));
  function startPanelResize(event, panel) {
    if (event.button !== 0) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    const startX = event.clientX, startY = event.clientY;
    const startWidth = rightPanelWidth, startHeight = timelineHeight;
    const move = (next) => {
      if (next.pointerId !== pointerId) return;
      if (panel === 'right') {
        rightPanelWidth = resizeRightPanelFromPointer(startWidth, startX, next.clientX);
        measureRight();
      } else {
        timelineHeight = Math.max(180, Math.min(window.innerHeight - 120, startHeight + startY - next.clientY));
      }
    };
    const end = (next) => {
      if (next?.pointerId != null && next.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
  }
  function resizePanelWithKey(event, panel) {
    const rightWidth = panel === 'right' ? resizeRightPanelWithKey(rightPanelWidth, event.key) : null;
    const direction = panel === 'timeline' ? (event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0) : 0;
    if (rightWidth == null && !direction) return;
    event.preventDefault();
    if (panel === 'right') rightPanelWidth = rightWidth;
    else timelineHeight = Math.max(180, Math.min(window.innerHeight - 120, timelineHeight + direction * 16));
    measureRight();
  }

  function onSketch(detail) {
    sketchOpen = !sketchOpen;
    sketchTop = detail.top;
    measureRight();
  }

  function openColorPicker(detail) {
    colorEditSession.open({ kind: 'toolbar' }, detail);
  }

  let exportOpen = $state(false);
  let prefsOpen = $state(false);
  let newProjectOpen = $state(false);
  let projectSettingsOpen = $state(false);
  let purgeMediaOpen = $state(false);
  let helperOpen = $state(false);
  let assetsOpen = $state(false);
  let assetsFocusId = $state(null);
  let helpPage = $state(null);
  let discardRequest = $state(null);
  let discardBusy = $state(false);
  let recoveryReady = $state(false);
  let recoveryStartupError = $state('');
  let recoveryError = $derived(recoveryStartupError || ($recoveryState.state === 'error' ? $recoveryState.error : ''));
  let watchFolderError = $derived($watchFolderState.state === 'error' ? $watchFolderState.error : '');
  let canRetryWatchFolder = $derived(!!$watchFolderState.name);
  let watchFolderActive = $derived(!!$watchFolderState.name && $watchFolderState.state !== 'off');
  let activeLayer = $derived($layers.find((layer) => layer.id === $activeLayerId));
  let glyphPaintingUnavailable = $derived(glyphPaintingUnavailableFor(activeLayer, $activeLayerPart));
  $effect(() => {
    if ($colorEditSession.active && $colorEditSession.target?.kind !== 'toolbar') {
      $activeLayerId;
      colorEditSession.validate();
    }
  });
  let convertLayerId = $state(null);
  function audioPreviewOptions(tick = get(activeFrameIndex)) {
    return {
      tick,
      fps: get(fps),
      loopRange: get(looping)
        ? validLoopRange(get(timelineTags), get(durationTicks))
        : null,
    };
  }
  async function disconnectPreview() {
    try { await disconnectWatchFolder(); }
    catch (error) { notifyError(`Could not disconnect watch folder: ${error.message}`); }
  }

  onMount(() => {
    let disposed = false;
    let stopPreviewSync = () => {};
    let stopRecovery = () => {};
    const recentTracking = startRecentProjectTracking();
    const stopPlaybackWatch = playing.subscribe((active) => {
      if (active) startAudioPreview(audioPreviewOptions());
      else stopAudioPreview();
    });
    let lastAudioCycle = get(playbackCycle).id;
    const stopAudioCycleWatch = playbackCycle.subscribe((cycle) => {
      if (cycle.id === lastAudioCycle) return;
      lastAudioCycle = cycle.id;
      if (get(playing)) startAudioPreview(audioPreviewOptions(cycle.tick));
    });
    let previousTool = get(activeTool);
    const stopToolWatch = activeTool.subscribe((tool) => {
      if (tool === previousTool) return;
      previousTool = tool;
      releaseKeyboardContext();
    });
    startBrowserRecovery().then((stop) => {
      if (disposed) {
        stop();
        return;
      }
      stopRecovery = stop;
      stopPreviewSync = startPreviewSync();
      recoveryReady = true;
    }).catch((error) => {
      console.warn('Browser recovery could not start.', error);
      recoveryStartupError = error instanceof Error ? error.message : String(error);
      if (!disposed) {
        stopPreviewSync = startPreviewSync();
        recoveryReady = true;
      }
    });
    const h = () => (prefsOpen = true);
    const mv = () => beginLayerMove();
    const convert = (event) => (convertLayerId = event.detail.id);
    const stopProjectReplaced = onProjectReplaced(() => {
      releaseKeyboardContext();
      exportOpen = false;
      prefsOpen = false;
      newProjectOpen = false;
      projectSettingsOpen = false;
      purgeMediaOpen = false;
      helperOpen = false;
      assetsOpen = false;
      assetsFocusId = null;
      helpPage = null;
      colorEditSession.abort();
      convertLayerId = null;
      sketchOpen = false;
      menu = null;
      topMenuOpen = false;
      discardRequest = null;
      discardBusy = false;
    });
    window.addEventListener('open-prefs', h);
    window.addEventListener('move-layer', mv);
    window.addEventListener('open-image-convert', convert);
    scheduleMediaCacheGc();
    return () => {
      disposed = true;
      stopPreviewSync();
      stopRecovery();
      recentTracking.stop();
      stopPlaybackWatch();
      stopAudioCycleWatch();
      stopToolWatch();
      closeAudioPreview();
      stopProjectReplaced();
      window.removeEventListener('open-prefs', h);
      window.removeEventListener('move-layer', mv);
      window.removeEventListener('open-image-convert', convert);
    };
  });

  let menu = $state(null);
  let topMenuOpen = $state(false);
  let pointerInputActive = false;
  function onGlyphMenu(detail) { menu = detail; }
  function closeMenu() { menu = null; }

  function onWindowClick(e) {
    if (menu && !e.target.closest('.ctx-menu')) closeMenu();
  }
  function onWindowPointerDown(e) {
    if (viewportState.blocked) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    noteKeyboardContext(e);
    pointerInputActive = true;
    if (!$colorEditSession.active) return;
    const target = e.target instanceof Element ? e.target : null;
    if ($colorEditSession.phase === 'sampling') {
      if (target?.closest('.hit-catcher')) return;
      colorEditSession.abort();
      return;
    }
    if (target?.closest('.picker, .color-tool, .shape-color-control, .text-color-control')) return;
    colorEditSession.close();
    e.preventDefault();
    e.stopPropagation();
  }
  function releasePointerInput() {
    pointerInputActive = false;
  }
  function onWindowBlur() {
    pointerInputActive = false;
    altEyedrop.set(false);
  }
  function onWindowKeyDown(event) {
    onKey(event);
    refreshAlt(event);
  }
  function documentModalOpen() {
    return editorModalOpen({
      exportOpen,
      prefsOpen,
      newProjectOpen,
      projectSettingsOpen,
      purgeMediaOpen,
      assetsOpen,
      helperOpen,
      helpOpen: helpPage != null,
      convertOpen: convertLayerId != null,
      discardOpen: discardRequest != null,
    });
  }
  function requestDocumentReplacement(request) {
    if (get(dirty)) {
      discardRequest = request;
      return;
    }
    request.run();
  }
  function requestOpenProject() {
    requestDocumentReplacement({ run: () => openFileDialog() });
  }
  function requestOpenRecent(project) {
    requestDocumentReplacement({ run: () => openRecentProject(project) });
  }
  async function openRecentProject(project) {
    try {
      loadJSON(project.contents);
      fileName.set(project.name);
      recentProjectIdentity.set(project.id);
      notifyProjectLoaded({
        contents: serializeJSON(),
        fileName: project.name,
        recentId: project.id,
      });
    } catch (error) {
      await forgetRecentProject(project.id);
      notifyError(`Could not open recent project: ${error.message}`);
    }
  }
  async function confirmDocumentReplacement() {
    const request = discardRequest;
    if (!request || discardBusy) return;
    discardBusy = true;
    try {
      await performDiscardedProjectAction({
        checkpoint: () => notifyProjectCheckpoint({
          contents: serializeJSON(),
          fileName: get(fileName),
        }),
        action: async () => {
          if (discardRequest !== request) return;
          discardRequest = null;
          await tick();
          return request.run();
        },
      });
    } catch (error) {
      notifyError(`Could not open project: ${error.message}`);
    } finally {
      discardBusy = false;
    }
  }
  function onCopy(e) {
    if (!recoveryReady || viewportState.blocked || $popupOpen || isEditingTarget(e.target)) return;
    const keyboardContext = getKeyboardContext();
    if (keyboardContext !== 'layers' && keyboardContext !== 'timeline') return;
    const copied = copyClipsForContext(keyboardContext, e.clipboardData);
    if (!copied) {
      notifyInfo(keyboardContext === 'layers'
        ? 'No active clips at the playhead.'
        : 'No clips selected.');
      return;
    }
    e.preventDefault();
    notifyInfo(`Copied ${copied} clip${copied === 1 ? '' : 's'}.`);
  }
  async function onPaste(e) {
    if (!recoveryReady || viewportState.blocked || $popupOpen) return;
    if (isEditingTarget(e.target)) return;
    const intent = clipboardPasteIntent(e.clipboardData, getKeyboardContext());
    if (intent.kind === 'image') {
      e.preventDefault();
      const revision = captureProjectRevision();
      try {
        const imported = await importMediaFile(intent.file, 'image', {
          valid: () => isProjectRevisionCurrent(revision),
        });
        if (isProjectRevisionCurrent(revision) && clipboardMediaPlacementSucceeded(imported)) {
          notifyInfo('Pasted image as a reference layer.');
        }
      } catch (err) {
        if (!isProjectRevisionCurrent(revision)) return;
        notifyError('Could not paste image: ' + err.message);
      }
      return;
    }
    if (intent.kind !== 'clips') return;
    e.preventDefault();
    const pasted = pasteClipsFromClipboard(e.clipboardData);
    if (pasted.changed) {
      notifyInfo(`Pasted ${pasted.clipIds.length} clip${pasted.clipIds.length === 1 ? '' : 's'}.`);
    } else if (pasted.reason === 'stale-project') {
      notifyInfo('Clipboard clips belong to another project.');
    } else if (pasted.reason === 'stale-media') {
      notifyInfo('Clipboard media changed. Copy the clips again.');
    } else if (pasted.reason === 'stale-fps') {
      notifyInfo('Project frame rate changed. Copy the clips again.');
    }
  }

  function onKey(e) {
    if (viewportState.blocked) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!recoveryReady) {
      if (newProjectShortcutAction(e, { modalOpen: true })) e.preventDefault();
      return;
    }

    const typing = isEditingTarget(e.target);
    const modalOpen = documentModalOpen() || $popupOpen;
    const newProjectAction = newProjectShortcutAction(e, {
      typing,
      modalOpen,
      gestureActive: pointerInputActive || !!menu || sketchOpen ||
        topMenuOpen || $colorEditSession.active || !!get(moveState) || !!get(cropPending),
    });
    if (newProjectAction) {
      e.preventDefault();
      if (newProjectAction === 'open') newProjectOpen = true;
      return;
    }
    if (modalOpen) return;
    const committedEditorControl = e.target?.matches?.(
      'select, .number-field[data-dirty="false"]',
    );

    const saveAction = projectSaveShortcutAction(e, {
      typing,
      popupOpen: modalOpen,
      playing: get(playing),
    });
    if (saveAction) {
      e.preventDefault();
      e.stopImmediatePropagation();
      Promise.resolve(saveAction === 'save-as' ? saveJSONAs() : saveJSON())
        .catch((error) => notifyError(`Could not save project: ${error.message}`));
      return;
    }

    if (layerRenameShortcutAction(e, {
      typing,
      popupOpen: modalOpen,
      playing: get(playing),
      activeLayerId: $activeLayerId,
    })) {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.dispatchEvent(new CustomEvent('rename-active-layer'));
      return;
    }

    if (nativeInputOwnsKey(e)) return;

    if (e.key === 'Escape') {
      const action = editorEscapeAction({
        menuOpen: !!menu,
        sketchOpen,
        colorEditActive: $colorEditSession.active,
        typing,
        moveActive: !!get(moveState),
        activeTool: get(activeTool),
        cropPending: !!get(cropPending),
      });
      if (action === 'menu') { menu = null; return; }
      if (action === 'sketch') { sketchOpen = false; return; }
      if (action === 'color') { colorEditSession.abort(); return; }
      if (action === 'move') { cancelMove(); return; }
      if (action === 'crop') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('cancel-crop'));
        return;
      }
      return;
    }
    if (get(moveState) && e.key === 'Enter' && !typing) { e.preventDefault(); finalizeMove(); return; }

    if (isPlaybackShortcut(e, typing, getKeyboardContext())) {
      e.preventDefault();
      togglePlay();
      return;
    }
    if (!typing && e.key === 'ArrowRight' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault(); gotoFrame(Math.min(get(frames).length - 1, get(activeFrameIndex) + 1)); return;
    }
    if (!typing && e.key === 'ArrowLeft' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault(); gotoFrame(Math.max(0, get(activeFrameIndex) - 1)); return;
    }

    const ctrl = e.ctrlKey || e.metaKey;
    if (!typing || committedEditorControl) {
      const deselect = planSelectionDeselect(e, {
        context: getKeyboardContext(),
        typing: false,
        popupOpen: modalOpen,
      });
      if (deselect.handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (deselect.context === 'canvas') clearSelection();
        else if (deselect.context === 'layers' && !clearLayerSelection() && $activeLayerId != null) {
          notifyInfo('Selection cleared.');
        }
        else if (deselect.context === 'timeline') clearClipSelection();
        return;
      }
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (get(moveState)) cancelMove(); else undo();
        return;
      }
      if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        if (!get(moveState)) redo();
        return;
      }
      if (ctrl && e.key.toLowerCase() === 't') {
        e.preventDefault();
        if (hasSelection()) {
          activeTool.set('select');
          beginTransformSelection();
        } else {
          activeTool.set('move');
          beginLayerMove();
        }
        return;
      }
    }

  }
  let pageTitle = $derived(documentTitle($fileName, $dirty));
</script>

<svelte:head><title>{pageTitle}</title></svelte:head>
<svelte:window onpointerdowncapture={onWindowPointerDown}
  onpointerupcapture={releasePointerInput} onpointercancelcapture={releasePointerInput}
  onclick={onWindowClick} oncopy={onCopy} onpaste={onPaste}
  onkeydown={onWindowKeyDown}
  onkeyup={refreshAlt} onblur={onWindowBlur} onresize={measureViewport} />

<div
  class="app"
  inert={!recoveryReady || viewportState.blocked}
  aria-busy={!recoveryReady}
  style={`--right-panel-w:${rightPanelWidth}px; --right-panel-gutter-w:${rightPanelDivider.gutterWidth}px; --timeline-panel-h:${timelineExpanded ? timelineHeight : 34}px;`}
>
  <MenuBar onExport={() => (exportOpen = true)} onHelper={() => (helperOpen = true)}
    onOpenProject={requestOpenProject} onOpenRecent={({ project }) => requestOpenRecent(project)}
    onNewProject={() => (newProjectOpen = true)}
    onProjectSettings={() => (projectSettingsOpen = true)}
    onPurgeMedia={() => (purgeMediaOpen = true)}
    onMenuState={({ open }) => (topMenuOpen = open)}
    onAssets={() => { assetsFocusId = null; assetsOpen = true; }}
    onRelinkMedia={(detail) => { assetsFocusId = detail?.assetId || null; assetsOpen = true; }}
    onHelp={({ page }) => (helpPage = page)} />
  <ToolOptionsBar />
  <ToolsPanel onColor={openColorPicker} />
  <Canvas />

  <div class="right" bind:this={rightEl}>
    <button type="button" class="panel-resizer right-resizer" aria-label="Resize right panel" tabindex="0"
      onpointerdown={(event) => startPanelResize(event, 'right')} onkeydown={(event) => resizePanelWithKey(event, 'right')}></button>
    <div class="right-content">
      <div class="sect" bind:this={propertiesSectEl} style="height: 210px;">
        <LayerPropertiesPanel />
      </div>
      <ResizeHandle target={propertiesSectEl} />
      <div class="sect" class:dimmed-section={glyphPaintingUnavailable} bind:this={charSectEl}
        title={glyphPaintingUnavailable ? 'Glyph painting unavailable' : undefined} style="height: 220px;">
        <CharPicker onSketch={onSketch} onGlyphMenu={onGlyphMenu} />
      </div>
      <ResizeHandle target={charSectEl} />
      <LayersPanel disabled={!recoveryReady} />
    </div>
  </div>

  <TimelineV2 expanded={timelineExpanded} onToggle={() => (timelineExpanded = !timelineExpanded)} />
  {#if timelineExpanded}
    <button type="button" class="panel-resizer timeline-resizer" aria-label="Resize timeline" tabindex="0"
      onpointerdown={(event) => startPanelResize(event, 'timeline')} onkeydown={(event) => resizePanelWithKey(event, 'timeline')}></button>
  {/if}
  {#if recoveryError || watchFolderError || watchFolderActive}
    <div class="warning-stack">
      {#if watchFolderActive}
        <div class="watch-folder-indicator" role="status">
          <span title={$watchFolderState.name}>{$watchFolderState.name}</span>
          <button type="button" onclick={disconnectPreview}>Disconnect</button>
        </div>
      {/if}
      {#if recoveryError}
        <div class="status-warning" role="status" title={recoveryError}>Autosave unavailable</div>
      {/if}
      {#if watchFolderError}
        {#if canRetryWatchFolder}
          <button type="button" class="status-warning" title={watchFolderError}
            onclick={retryPreviewSync}>Watch folder out of sync · Retry</button>
        {:else}
          <div class="status-warning" role="status" title={watchFolderError}>Watch folder unavailable</div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

{#if viewportState.blocked}
  <section class="viewport-blocker" role="alertdialog" aria-modal="true"
    aria-labelledby="unsupported-viewport-title" aria-describedby="unsupported-viewport-size"
    tabindex="-1" use:popupFocus={{ initialFocus: (node) => node, restoreFocus: false }}>
    <h1 id="unsupported-viewport-title">Unsupported viewport</h1>
    <p id="unsupported-viewport-size">Current: {viewportState.width} × {viewportState.height}</p>
    <p>Minimum: {viewportState.minimumWidth} × {viewportState.minimumHeight}</p>
  </section>
{/if}

{#if $notifications.length}
  <div class="notification-stack" aria-live="polite">
    {#each $notifications as notification (notification.id)}
      <div class="notification" class:error={notification.tone === 'error'} role="status">
        <span>{notification.message}</span>
        <button type="button" aria-label="Dismiss notification" onclick={() => dismissNotification(notification.id)}>×</button>
      </div>
    {/each}
  </div>
{/if}

{#if $colorEditSession.active && $colorEditSession.phase === 'picker'}
  {#key $colorEditSession.cycle}
  <ColorPicker
    value={$colorEditSession.color || '#ffffff'}
    recent={$recentColors}
    x={$colorEditSession.x} y={$colorEditSession.y}
    onChange={(color) => colorEditSession.preview(color)}
    onCommit={(color) => colorEditSession.commit(color)}
    onGestureCancel={() => colorEditSession.cancel()}
    onEyedropper={() => colorEditSession.startSampling()}
    onClose={() => colorEditSession.abort()}
  />
  {/key}
{/if}

{#if sketchOpen}
  <SketchPopup top={sketchTop} {rightPanelLeft} onGlyphMenu={onGlyphMenu} onClose={() => (sketchOpen = false)} />
{/if}

{#if menu}
  <GlyphContextMenu x={menu.x} y={menu.y} ch={menu.ch} onClose={closeMenu} />
{/if}

{#if exportOpen}
  <ExportPopup onClose={() => (exportOpen = false)} />
{/if}

{#if prefsOpen}
  <Preferences onClose={() => (prefsOpen = false)} />
{/if}

{#if newProjectOpen}
  <NewProjectPopup onClose={() => (newProjectOpen = false)} />
{/if}

{#if projectSettingsOpen}
  <ProjectSettings onClose={() => (projectSettingsOpen = false)} />
{/if}

{#if purgeMediaOpen}
  <PurgeUnusedMediaPopup onClose={() => (purgeMediaOpen = false)} />
{/if}

{#if assetsOpen}
  <ProjectAssets focusAssetId={assetsFocusId} onClose={() => { assetsOpen = false; assetsFocusId = null; }} />
{/if}

{#if helperOpen}
  <TuiHelperPopup onClose={() => (helperOpen = false)} />
{/if}

{#if helpPage}
  <HelpPopup page={helpPage} onClose={() => (helpPage = null)} />
{/if}

{#if convertLayerId != null}
  <ConvertPopup layerId={convertLayerId} onClose={() => (convertLayerId = null)} />
{/if}

{#if discardRequest}
  <DiscardChangesPopup busy={discardBusy} onClose={() => (discardRequest = null)}
    onConfirm={confirmDocumentReplacement} />
{/if}

<StartupAssetsStrip {recoveryReady} />

<style>
  .app {
    display: grid;
    grid-template-columns: var(--tools-w) minmax(0, 1fr) var(--right-panel-w);
    grid-template-rows: var(--menubar-h) var(--optbar-h) minmax(0, 1fr) var(--timeline-panel-h);
    grid-template-areas:
      "menubar menubar menubar"
      "optbar  optbar  optbar"
      "tools   canvas  right"
      "tools   timeline right";
    height: 100vh; position: relative;
  }
  .right {
    grid-area: right; background: var(--panel);
    /* The panel owns the complete resize gutter, so controls and workspace hits never share it. */
    display: grid; grid-template-columns: var(--right-panel-gutter-w) minmax(0, 1fr); overflow: hidden;
    container-type: inline-size;
  }
  .right-content {
    grid-column: 2; grid-row: 1; min-width: 0;
    display: flex; flex-direction: column; overflow: hidden;
  }
  .panel-resizer { padding: 0; border: 0; z-index: 68; background: transparent; }
  .panel-resizer:focus { outline: none; }
  .right-resizer {
    position: relative; grid-column: 1; grid-row: 1; width: 100%; height: 100%; cursor: col-resize;
  }
  .right-resizer::after {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 1px;
    background: var(--border); pointer-events: none;
  }
  .right-resizer:hover::after, .right-resizer:focus::after { background: var(--accent); }
  .timeline-resizer:hover, .timeline-resizer:focus { background: var(--accent); }
  .timeline-resizer {
    position: absolute; left: var(--tools-w); right: var(--right-panel-w);
    bottom: calc(var(--timeline-panel-h) - 3px); height: 6px; cursor: row-resize;
  }
  .sect { flex-shrink: 0; overflow: hidden; }
  .dimmed-section { opacity: 0.42; }
  .viewport-blocker {
    position: fixed; inset: 0; z-index: 1000; display: grid; place-content: center; gap: 8px;
    background: var(--bg); color: var(--text); text-align: left;
  }
  .viewport-blocker h1 { font-size: 16px; font-weight: 600; }
  .viewport-blocker p { color: var(--text-dim); font: 12px var(--font-mono); }
  .warning-stack {
    position: absolute; z-index: 67;
    left: calc(var(--tools-w) + 8px); top: calc(var(--menubar-h) + var(--optbar-h) + 8px);
    display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
  }
  .status-warning {
    padding: 3px 7px; border: 1px solid var(--danger); border-radius: 3px;
    background: var(--panel); color: var(--danger); font-size: 11px;
  }
  button.status-warning { cursor: pointer; }
  button.status-warning:hover { background: var(--panel-hi); }
  .watch-folder-indicator {
    display: flex; max-width: 300px; align-items: center; gap: 7px; padding: 3px 5px 3px 7px;
    border: 1px solid var(--border); border-radius: 3px; background: var(--panel); font-size: 11px;
  }
  .watch-folder-indicator span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .watch-folder-indicator button {
    padding: 2px 5px; border: 1px solid var(--border); border-radius: 2px;
    background: var(--panel-hi); color: var(--text);
  }
  .notification-stack {
    position: fixed; z-index: 120; top: calc(var(--menubar-h) + 8px); right: 10px;
    width: min(360px, calc(100vw - 20px)); display: flex; flex-direction: column; gap: 6px;
    pointer-events: none;
  }
  .notification {
    display: flex; align-items: flex-start; gap: 10px; padding: 8px 9px;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--panel); color: var(--text); box-shadow: 0 4px 14px var(--shadow-raised);
    font-size: 11px; line-height: 1.35;
    pointer-events: none;
  }
  .notification.error { border-color: var(--danger); }
  .notification span { flex: 1; overflow-wrap: anywhere; }
  .notification button {
    flex: 0 0 auto; padding: 0 2px; border: 0; background: transparent;
    color: var(--text-dim); font-size: 15px; line-height: 1; cursor: pointer;
    pointer-events: auto;
  }
  .notification button:hover { color: var(--text); }
</style>
