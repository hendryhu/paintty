<script>
  import { onDestroy, onMount } from 'svelte';
  import NumberField from './NumberField.svelte';
  import { get } from 'svelte/store';
  import {
    dims,
    insertConvertedLayerPair,
    layers,
    snapshotLayerForConversion,
  } from '../lib/grid.js';
  import {
    CHARACTER_SETS,
    convertImageAsync,
    drawConversionPreview,
    uniqueCharacters,
  } from '../lib/converter.js';
  import { canvasFont } from '../lib/font.js';
  import { paintColor } from '../lib/stores.js';
  import { playheadTick } from '../lib/frames.js';
  import {
    requestVideoFrameDecode,
    videoRasterReadyAt,
    videoRasterStatus,
  } from '../lib/video.js';
  import { captureProjectRevision, isProjectRevisionCurrent } from '../lib/documentLifecycle.js';
  import {
    releaseVisualMediaRequests,
    syncVisualMediaRequests,
  } from '../lib/mediaRuntime.js';
  import { popupFocus } from '../lib/popupFocus.js';

  /**
   * @typedef {Object} Props
   * @property {number} layerId
   * @property {() => void} [onClose]
   */

  /** @type {Props} */
  let { layerId, onClose = () => {} } = $props();
  let mode = $state('auto');
  let charset = $state('unicodeArt');
  let characters = $state('');
  let glyphLimit = $state(256);
  let colorLimit = $state(16);
  let background = $state('transparent');
  let alphaThreshold = $state(32);
  let invert = $state(false);
  let busy = $state(false);
  let error = $state('');
  let previewCanvas = $state();
  let previewTimer = null;
  let previewController = null;
  let previewTicket = 0;
  let previewBusy = $state(false);
  let previewError = $state('');
  let previewResult = $state(null);
  let previewRevision = null;
  let previewFrameToken = null;
  let previewProjectTick = null;
  let releaseVideoDecode = () => {};
  const visualRequestOwner = {};
  function videoIdentity(layer, projectTick) {
    return {
      clipId: layer?.id,
      assetId: layer?.videoClip?.assetId ?? null,
      projectTick,
    };
  }

  function conversionOptions() {
    return {
      charset,
      characters,
      glyphLimit: +glyphLimit,
      colorLimit: +colorLimit,
      background,
      backgroundColor: get(paintColor),
      alphaThreshold: +alphaThreshold,
      invert,
      fontFamily: get(canvasFont),
    };
  }

  function stopPreview(clearResult = true) {
    previewTicket++;
    if (previewTimer != null) clearTimeout(previewTimer);
    previewTimer = null;
    previewController?.abort();
    previewController = null;
    previewBusy = false;
    if (clearResult) {
      previewCanvas?.getContext('2d')?.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      previewResult = null;
      previewRevision = null;
      previewFrameToken = null;
      previewProjectTick = null;
    }
  }

  // Reject previews from a replaced project or a different video tick.
  function sourceIsCurrent(revision, frameToken, projectTick) {
    if (!isProjectRevisionCurrent(revision)) return false;
    const current = get(layers).find((layer) => layer.id === layerId);
    if (!current || (current.type !== 'image' && current.type !== 'video') || !current.raster) return false;
    if (current.type !== 'video') return true;
    const status = get(videoRasterStatus).get(layerId);
    return get(playheadTick) === projectTick &&
      videoRasterReadyAt(status, videoIdentity(current, projectTick)) &&
      status.token === frameToken;
  }

  function schedulePreview() {
    stopPreview();
    previewError = '';
    if (!sourceReady) return;
    const ticket = ++previewTicket;
    const revision = captureProjectRevision();
    const frameToken = sourceLayer.type === 'video' ? videoStatus?.token : null;
    const projectTick = get(playheadTick);
    previewBusy = true;
    previewTimer = setTimeout(
      () => buildPreview(ticket, revision, frameToken, projectTick),
      120,
    );
  }

  async function buildPreview(ticket, revision, frameToken, projectTick) {
    previewTimer = null;
    const controller = new AbortController();
    previewController = controller;
    try {
      const raster = snapshotLayerForConversion(layerId);
      if (!raster) throw new Error('Source unavailable.');
      const result = await convertImageAsync(raster, mode, conversionOptions(), {
        signal: controller.signal,
      });
      if (ticket !== previewTicket ||
        !sourceIsCurrent(revision, frameToken, projectTick)) return;
      previewResult = result;
      previewRevision = revision;
      previewFrameToken = frameToken;
      previewProjectTick = projectTick;
      drawConversionPreview(previewCanvas, result, {
        cols: get(dims).w,
        rows: get(dims).h,
        fontFamily: get(canvasFont),
      });
    } catch (cause) {
      if (cause?.name !== 'AbortError' && ticket === previewTicket) {
        previewError = cause?.message || 'Preview failed';
      }
    } finally {
      if (ticket === previewTicket) {
        previewBusy = false;
        previewController = null;
      }
    }
  }

  function close() {
    if (busy) return;
    stopPreview();
    onClose();
  }

  function run() {
    if (!previewResult || previewBusy ||
      !sourceIsCurrent(previewRevision, previewFrameToken, previewProjectTick)) {
      schedulePreview();
      return;
    }
    busy = true;
    error = '';
    const result = previewResult;
    stopPreview(false);
    if (insertConvertedLayerPair(layerId, result) != null) {
      onClose();
      return;
    }
    error = 'Source unavailable.';
    busy = false;
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      if (event.target.closest?.('.number-field[data-dirty="true"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    }
    if (event.key === 'Enter' && event.ctrlKey && !busy) {
      event.preventDefault();
      event.stopImmediatePropagation();
      run();
    }
  }

  onMount(() => {
    const current = get(layers).find((layer) => layer.id === layerId);
    if (current?.type === 'video') releaseVideoDecode = requestVideoFrameDecode(layerId);
  });

  onDestroy(() => {
    releaseVideoDecode();
    releaseVisualMediaRequests(visualRequestOwner);
    stopPreview();
  });
  let sourceLayer = $derived($layers.find((layer) => layer.id === layerId));
  $effect(() => {
    syncVisualMediaRequests(visualRequestOwner, [
      sourceLayer?.type === 'image'
        ? sourceLayer.assetId
        : sourceLayer?.type === 'video' ? sourceLayer.videoClip?.assetId : null,
    ].filter(Boolean));
  });
  let videoStatus = $derived($videoRasterStatus.get(layerId));
  let videoReady = $derived(sourceLayer?.type !== 'video' ||
    videoRasterReadyAt(videoStatus, videoIdentity(sourceLayer, $playheadTick)));
  let sourceReady = $derived(!!sourceLayer?.raster && videoReady);
  let characterSource = $derived(mode === 'blocks'
    ? CHARACTER_SETS.blocks
    : charset === 'custom'
      ? characters
      : (CHARACTER_SETS[charset] || CHARACTER_SETS.extended));
  let availableGlyphs = $derived(uniqueCharacters(characterSource).length);
  let previewGlyphs = $derived(previewResult
    ? uniqueCharacters(previewResult.meta.characters).length
    : 0);
  let sourceMessage = $derived(!sourceLayer
    ? 'Source unavailable.'
    : sourceLayer.type === 'video' && !sourceLayer.raster
      ? 'Video not found.'
      : sourceLayer.type === 'video' && videoStatus?.state === 'inactive'
        ? 'No video at this frame.'
        : sourceLayer.type === 'video' && videoStatus?.state === 'error'
          ? 'Could not read this video frame.'
          : sourceLayer.type === 'video' && !videoReady
            ? 'Waiting for frame…'
            : '');
  let previewInputs = $derived([
    sourceLayer,
    videoStatus?.token,
    videoStatus?.state,
    $playheadTick,
    mode,
    charset,
    characters,
    glyphLimit,
    colorLimit,
    background,
    alphaThreshold,
    invert,
    $canvasFont,
    $paintColor,
    $dims.w,
    $dims.h,
  ]);
  $effect(() => {
    if (previewCanvas && previewInputs) schedulePreview();
  });
  function backdropClick(event) { if (event.target === event.currentTarget) close(); }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="backdrop" onclick={backdropClick} role="presentation">
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="convert-title"
    tabindex="-1" use:popupFocus={{ initialFocus: 'select' }}>
    <div class="head">
      <span id="convert-title">{sourceLayer?.type === 'video' ? 'Video frame to cells' : 'Image to cells'}</span>
      <button class="x" onclick={close} title="Close">×</button>
    </div>

    <div class="body">
      <section class="controls">
        <label class="field" for="convert-mode">Method</label>
        <select id="convert-mode" bind:value={mode}>
          <option value="auto">Auto</option>
          <option value="glyph">Glyph match</option>
          <option value="blocks">Fractional blocks</option>
          <option value="density">Density ramp</option>
        </select>

        {#if mode !== 'blocks'}
          <label class="field" for="convert-charset">Characters</label>
          <select id="convert-charset" bind:value={charset}>
            <option value="unicodeArt">Terminal glyphs</option>
            <option value="extended">Extended</option>
            <option value="asciiArt">ASCII art</option>
            <option value="ascii">Compact ASCII</option>
            <option value="custom">Custom</option>
          </select>
        {/if}

        {#if charset === 'custom' && mode !== 'blocks'}
          <textarea aria-label="Custom characters" bind:value={characters} rows="3" spellcheck="false"></textarea>
        {/if}

        <div class="columns">
          <div>
            <span>Glyphs <small>{availableGlyphs.toLocaleString()} available</small></span>
            <NumberField ariaLabel="Glyph limit" min={2} max={2048} bind:value={glyphLimit} />
          </div>
          <div>
            <span>Colors</span>
            <NumberField ariaLabel="Color limit" min={1} max={64} bind:value={colorLimit} />
          </div>
        </div>

        <label class="field" for="convert-background">Background</label>
        <select id="convert-background" bind:value={background}>
          <option value="transparent">Transparent</option>
          <option value="source">Sample image</option>
          <option value="solid">Current color</option>
        </select>

        <div class="number-row">
          <span>Alpha cutoff</span>
          <NumberField ariaLabel="Alpha cutoff" min={0} max={254} step={1} bind:value={alphaThreshold} />
        </div>

        <label class="check"><input type="checkbox" bind:checked={invert} /> Invert glyph density</label>

        <p class="note">Auto uses glyph shapes for low-color or transparent art and fractional blocks for photographs. Conversion creates a glyph/background group and keeps the source reference.</p>
        {#if error}<p class="error">{error}</p>{/if}

        <button class="primary"
          disabled={busy || previewBusy || !previewResult || !sourceReady}
          onclick={run}>{busy ? 'Converting…' : previewBusy ? 'Previewing…' : 'Convert'}</button>
        <span class="shortcut">Ctrl+Enter</span>
      </section>

      <section class="preview-pane">
        <div class="preview-head">
          <span>Preview</span>
          {#if previewBusy}<small>Updating…</small>{/if}
        </div>
        <div class="preview-frame">
          <canvas bind:this={previewCanvas} aria-label="Cell conversion preview"></canvas>
          {#if previewError || sourceMessage}
            <div class="preview-message">{previewError || sourceMessage}</div>
          {/if}
        </div>
        {#if previewResult}
          <div class="preview-meta">
            <span>{previewResult.meta.mode}</span>
            <span>{previewGlyphs.toLocaleString()} glyphs</span>
            <span>{previewResult.meta.palette.length} colors</span>
          </div>
        {/if}
      </section>
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 90; background: var(--modal-backdrop); display: flex; align-items: center; justify-content: center; }
  .dialog { width: min(780px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; background: var(--panel-hi); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 8px 30px var(--shadow-modal); }
  .head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text); font-size: 13px; }
  .x { width: 24px; height: 24px; padding: 0; background: transparent; border: none; color: var(--text-dim); font-size: 18px; }
  .x:hover { color: var(--text); }
  .body { display: grid; grid-template-columns: minmax(260px, 310px) minmax(320px, 1fr); gap: 16px; padding: 14px 12px; }
  .field, .columns span, .number-row, .check { display: block; font-size: 11px; color: var(--text-dim); }
  .field { margin: 0 0 5px; }
  select, textarea, .body :global(.number-field) { width: 100%; box-sizing: border-box; margin: 0 0 12px; padding: 6px 7px; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  textarea { resize: vertical; font-family: var(--font-mono); }
  .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .columns span { margin-bottom: 5px; }
  .columns small { margin-left: 3px; color: var(--text-faint); font-size: 9px; }
  .number-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 2px 0 12px; }
  .number-row :global(.number-field) { width: 64px; margin: 0; }
  .check { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
  .note { margin: 0 0 12px; color: var(--text-dim); font-size: 11px; line-height: 1.45; }
  .error { color: var(--danger); font-size: 11px; }
  .primary { width: 100%; padding: 9px; background: var(--accent-dim); color: var(--on-accent); border: 1px solid var(--accent-dim); border-radius: var(--radius-sm); }
  .primary:not(:disabled):hover { background: var(--accent); }
  .primary:disabled { opacity: 0.6; cursor: wait; }
  .shortcut { display: block; margin-top: 5px; color: var(--text-faint); font-size: 9px; text-align: center; }
  .preview-pane { min-width: 0; }
  .preview-head { display: flex; justify-content: space-between; margin: 0 0 5px; color: var(--text-dim); font-size: 11px; }
  .preview-head small { color: var(--text-faint); font-size: 10px; }
  .preview-frame { position: relative; display: flex; min-height: 260px; align-items: center; justify-content: center; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-sm); background-color: var(--canvas-bg); background-image: linear-gradient(45deg, var(--transparency-check) 25%, transparent 25%), linear-gradient(-45deg, var(--transparency-check) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--transparency-check) 75%), linear-gradient(-45deg, transparent 75%, var(--transparency-check) 75%); background-position: 0 0, 0 5px, 5px -5px, -5px 0; background-size: 10px 10px; }
  .preview-frame canvas { display: block; width: 100%; height: auto; max-height: 340px; object-fit: contain; image-rendering: auto; }
  .preview-message { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 20px; background: color-mix(in srgb, var(--canvas-bg) 82%, transparent); color: var(--text-dim); font-size: 11px; text-align: center; }
  .preview-meta { display: flex; gap: 8px; margin-top: 6px; color: var(--text-faint); font-size: 10px; text-transform: capitalize; }
  @media (max-width: 700px) {
    .body { grid-template-columns: 1fr; }
    .preview-frame { min-height: 200px; }
  }
</style>
