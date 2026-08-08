<script>
  import { notifyError } from '../lib/notifications.js';
  import { onDestroy, onMount } from 'svelte';
  import NumberField from './NumberField.svelte';
  import {
    saveAsImage,
    exportTXT,
    exportANSI,
    exportVideo, exportAnimation,
    selectVideoExportFormat,
  } from '../lib/fileio.js';
  import { audioClips, audioTracks } from '../lib/audio.js';
  import { audibleTimelineAudioAssetIds } from '../lib/audioExport.js';
  import { projectMediaRegistry } from '../lib/mediaRegistry.js';
  import { onProjectReplaced } from '../lib/documentLifecycle.js';
  import { popupFocus } from '../lib/popupFocus.js';
  import { fileName } from '../lib/stores.js';
  import { get } from 'svelte/store';
  import {
    compatibleRetainedTarget,
    exportOutputSpec,
    exportPickerAvailable,
    normalizeExportFilename,
    pickExportFileTarget,
    sanitizeExportFilenameDraft,
  } from '../lib/exportDestination.js';

  /**
   * @typedef {Object} Props
   * @property {() => void} [onClose]
   */

  /** @type {Props} */
  let { onClose = () => {} } = $props();
  function close() {
    cancel();
    onClose();
  }

  const videoFormat = selectVideoExportFormat();
  const FORMATS = [
    { id: 'png', label: 'PNG', img: true },
    { id: 'jpg', label: 'JPG', img: true },
    { id: 'video', label: 'MP4', img: true },
    { id: 'txt', label: 'Text', img: false },
    { id: 'ansi', label: 'ANSI', img: false },
    { id: 'animation-json', label: 'Animation JSON', img: false },
  ];
  let format = $state('png');
  let cellPx = $state(16);
  let busy = $state(false);
  let progress = $state(0);
  let exportPhase = $state('rendering');
  let exportController = null;
  let browseController = null;
  let browsing = $state(false);
  let excludeAudio = $state(false);
  let filename = $state('');
  let retainedTarget = $state(null);
  let activeExtension = $state('');
  const browseSupported = exportPickerAvailable();
  let audibleAudioIds = $derived(audibleTimelineAudioAssetIds({
    assets: $projectMediaRegistry.assets
      .filter((asset) => asset.kind === 'audio')
      .map((asset) => ({ ...asset, id: asset.assetId })),
    tracks: $audioTracks,
    clips: $audioClips,
  }));
  let audibleAudioCount = $derived(audibleAudioIds.size);
  $effect(() => {
    if (!audibleAudioCount) excludeAudio = false;
  });
  let includeAudio = $derived(format === 'animation-json' && audibleAudioCount > 0 && !excludeAudio);
  let outputSpec = $derived(exportOutputSpec(format, { includeAudio }));
  $effect(() => {
    if (outputSpec.extension !== activeExtension) {
      activeExtension = outputSpec.extension;
      filename = normalizeExportFilename(filename || get(fileName), activeExtension, get(fileName));
      retainedTarget = null;
    }
  });
  $effect(() => {
    if (retainedTarget && !compatibleRetainedTarget(retainedTarget, filename, activeExtension)) {
      retainedTarget = null;
    }
  });
  let isImage = $derived(FORMATS.find((f) => f.id === format)?.img);
  $effect(() => {
    if (format === 'video' && cellPx % 2) cellPx = Math.min(48, cellPx + 1);
  });

  function cancel() {
    exportController?.abort();
    browseController?.abort();
    retainedTarget = null;
  }
  function normalizeName() {
    filename = normalizeExportFilename(filename, activeExtension, get(fileName));
    return filename;
  }
  function onNameInput(event) {
    filename = sanitizeExportFilenameDraft(event.currentTarget.value);
    retainedTarget = null;
  }
  async function browse() {
    if (!browseSupported || busy || browsing) return;
    const expectedSpec = outputSpec;
    const expectedName = normalizeName();
    const controller = new AbortController();
    browseController = controller;
    browsing = true;
    try {
      const target = await pickExportFileTarget(expectedName, expectedSpec, {
        signal: controller.signal,
      });
      if (!target || controller.signal.aborted || outputSpec.extension !== expectedSpec.extension) return;
      filename = normalizeExportFilename(target.name, expectedSpec.extension, expectedName);
      retainedTarget = compatibleRetainedTarget(target, filename, expectedSpec.extension);
    } catch (error) {
      if (!controller.signal.aborted && error?.name !== 'AbortError') {
        notifyError(`Could not select location: ${error.message}`);
      }
    } finally {
      browsing = false;
      if (browseController === controller) browseController = null;
    }
  }
  function onKey(event) {
    if (event.key !== 'Escape') return;
    // Let a dirty number field consume the first Escape to restore its committed value.
    if (!busy && event.target.closest?.('.number-field[data-dirty="true"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }
  function primaryLabel() {
    if (!busy) return 'Export';
    if (format === 'video' && exportPhase === 'rendering') return `Rendering ${progress}%`;
    if (format === 'animation-json') {
      if (exportPhase === 'resolving-animation') return `Preparing frames ${progress}%`;
      if (exportPhase === 'mixing-audio') return `Mixing audio ${progress}%`;
      if (exportPhase === 'encoding-wav') return `Encoding WAV ${progress}%`;
    }
    return 'Saving…';
  }
  onDestroy(cancel);
  onMount(() => onProjectReplaced(close));

  async function run() {
    if (busy || browsing) return;
    const exportFilename = normalizeName();
    const target = compatibleRetainedTarget(retainedTarget, exportFilename, activeExtension);
    if (!target) retainedTarget = null;
    const chooseTarget = target ? async () => target : undefined;
    const controller = new AbortController();
    busy = true;
    progress = 0;
    exportPhase = 'rendering';
    exportController = controller;
    try {
      let saved = false;
      if (format === 'video') saved = await exportVideo(cellPx, false, {
        signal: controller.signal,
        filename: exportFilename,
        ...(chooseTarget ? { chooseTarget } : {}),
        onProgress({ completed, total, phase }) {
          if (controller.signal.aborted) return;
          progress = total ? Math.round(completed * 100 / total) : 0;
          exportPhase = phase || 'rendering';
        },
      });
      else if (format === 'png' || format === 'jpg') {
        saved = await saveAsImage(format, cellPx, {
          signal: controller.signal,
          filename: exportFilename,
          ...(chooseTarget ? { chooseTarget } : {}),
        });
      } else if (format === 'txt') saved = await exportTXT({
        signal: controller.signal,
        filename: exportFilename,
        ...(chooseTarget ? { chooseTarget } : {}),
      });
      else if (format === 'ansi') saved = await exportANSI({
        signal: controller.signal,
        filename: exportFilename,
        ...(chooseTarget ? { chooseTarget } : {}),
      });
      else if (format === 'animation-json') {
        saved = await exportAnimation({
          includeAudio,
          signal: controller.signal,
          filename: exportFilename,
          ...(chooseTarget ? { chooseTarget } : {}),
          onProgress({ completed, total, phase }) {
            if (controller.signal.aborted) return;
            progress = total ? Math.round(completed * 100 / total) : 0;
            exportPhase = phase || 'saving';
          },
        });
      }
      if (saved && !controller.signal.aborted) {
        exportController = null;
        onClose();
      }
    } catch (error) {
      if (!controller.signal.aborted && error?.name !== 'AbortError') {
        notifyError(`Could not save file: ${error.message}`);
      }
    } finally {
      busy = false;
      if (exportController === controller) exportController = null;
    }
  }
  function backdropClick(event) { if (event.target === event.currentTarget) close(); }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="modal-backdrop" onclick={backdropClick} role="presentation">
  <div class="modal-dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title"
    tabindex="-1" use:popupFocus={{ initialFocus: '.seg button:not([disabled])' }}>
    <div class="modal-head">
      <span id="export-title">Export</span>
      <button class="modal-close" onclick={close} title="Close">×</button>
    </div>
    <div class="body">
      <div class="field">Format</div>
      <div class="seg">
        {#each FORMATS as f}
          <button disabled={busy || browsing} class:on={format === f.id} onclick={() => (format = f.id)}>{f.label}</button>
        {/each}
      </div>

      <label class="file-row">
        <span class="field">File name</span>
        <input type="text" value={filename} disabled={busy || browsing} oninput={onNameInput}
          onblur={normalizeName} aria-label="File name" />
      </label>

      <div class="location-row">
        <span class="field">Location</span>
        <span class="location" title={retainedTarget?.name || 'Default location'}>
          {retainedTarget?.name || 'Default location'}
        </span>
        <button class="browse" type="button" disabled={busy || browsing || !browseSupported}
          onclick={browse}>{browsing ? 'Browsing…' : 'Browse…'}</button>
      </div>

      {#if isImage}
        <div class="number-row">
          <span class="field">Cell size <span class="dim">{cellPx}px wide · {cellPx * 2}px tall</span></span>
          <NumberField ariaLabel="Cell size" min={4} max={48} step={format === 'video' ? 2 : 1} bind:value={cellPx} disabled={busy} />
        </div>
      {/if}
      {#if format === 'video'}
        {#if !videoFormat}<p class="status">MP4 unavailable</p>{/if}
      {:else if format === 'animation-json'}
        {#if audibleAudioCount}
          {#if !excludeAudio}<p class="audio-status">One mixed WAV included; export will be ZIP.</p>{/if}
          <label class="check"><input type="checkbox" bind:checked={excludeAudio}
            disabled={busy || browsing} /> Exclude audio</label>
        {/if}
      {/if}

      <button class="primary" disabled={busy || browsing || (format === 'video' && !videoFormat)} onclick={run}>{primaryLabel()}</button>
      {#if busy && (format === 'video' || format === 'animation-json')}
        <button class="secondary" onclick={cancel}>Cancel export</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .export-dialog { width: min(440px, calc(100vw - 32px)); }
  .body { padding: 14px 12px; }
  .field { display: block; font-size: 11px; color: var(--text-dim); margin: 0 0 6px; }
  .field .dim { color: var(--text-faint); }
  .seg { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; margin-bottom: 14px; }
  .seg button { padding: 6px; background: var(--panel); color: var(--text-dim); border: none; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); font-size: 12px; }
  .seg button:last-child { border-right: none; }
  .seg button.on { background: var(--accent-dim); color: var(--on-accent); }
  .file-row { display: block; margin-bottom: 12px; }
  .file-row input { width: 100%; user-select: text; }
  .location-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 9px; margin-bottom: 14px; }
  .location-row .field { margin: 0; }
  .location { min-width: 0; overflow: hidden; color: var(--text); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .browse { padding: 5px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel); color: var(--text); font-size: 11px; }
  .browse:not(:disabled):hover { border-color: var(--accent); }
  .browse:disabled { opacity: 0.4; }
  .number-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
  .number-row .field { margin: 0; }
  .number-row :global(.number-field) { width: 58px; }
  .status { margin: 0 0 14px; font-size: 11px; color: var(--danger); }
  .audio-status { margin: 0 0 7px; color: var(--text-dim); font-size: 11px; }
  .check { display: flex; align-items: center; gap: 7px; margin: 0 0 9px; color: var(--text); font-size: 11px; }
  .primary { width: 100%; padding: 9px; background: var(--accent-dim); color: var(--on-accent); border: 1px solid var(--accent-dim); border-radius: var(--radius-sm); font-size: 12px; }
  .primary:not(:disabled):hover { background: var(--accent); }
  .secondary { width: 100%; margin-top: 8px; padding: 7px; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; }
  .secondary:not(:disabled):hover { border-color: var(--accent); }
  .seg button:disabled, .primary:disabled, .secondary:disabled {
    opacity: 0.4; cursor: default;
  }
</style>
