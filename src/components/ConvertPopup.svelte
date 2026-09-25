<script lang="ts">
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
    convertImageAsync,
    drawConversionPreview,
    type CharacterSetName,
    type ConversionMode,
    type ConversionResult,
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
  import type { EditorVideoLayer } from '../lib/types/editor-domain.js';
  import { errorText, type TimerHandle } from '../lib/types/project-types.js';

  interface Props {
    layerId: string;
    onClose?: () => void;
  }

  interface VideoRasterStatus {
    state: 'error' | 'inactive' | 'missing' | 'pending' | 'ready';
    clipId: string;
    assetId: string | null;
    projectTick: number;
    token: number;
  }

  let { layerId, onClose = () => {} }: Props = $props();
  let mode = $state<ConversionMode>('auto');
  let charset = $state<CharacterSetName>('unicodeArt');
  let characters = $state('');
  let background = $state<'transparent' | 'source' | 'solid'>('source');
  let alphaThreshold = $state(32);
  let invert = $state(false);
  let busy = $state(false);
  let error = $state('');
  let previewCanvas = $state<HTMLCanvasElement>();
  let previewTimer: TimerHandle | null = null;
  let previewController: AbortController | null = null;
  let previewTicket = 0;
  let previewBusy = $state(false);
  let previewError = $state('');
  let previewResult = $state<ConversionResult | null>(null);
  let previewRevision: number | null = null;
  let previewFrameToken: number | null = null;
  let previewProjectTick: number | null = null;
  let releaseVideoDecode: () => void = () => {};
  const visualRequestOwner: object = {};
  function videoIdentity(layer: EditorVideoLayer, projectTick: number) {
    return {
      clipId: layer.id,
      assetId: layer.videoClip.assetId ?? null,
      projectTick,
    };
  }

  function conversionOptions() {
    return {
      charset,
      characters,
      background,
      backgroundColor: get(paintColor),
      alphaThreshold: +alphaThreshold,
      invert,
      glyphLimit: 256,
      colorLimit: 16,
      fontFamily: get(canvasFont),
    };
  }

  function stopPreview(clearResult: boolean = true): void {
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
  function sourceIsCurrent(
    revision: number | null,
    frameToken: number | null,
    projectTick: number | null,
  ): boolean {
    if (revision == null || projectTick == null || !isProjectRevisionCurrent(revision)) return false;
    const current = get(layers).find((layer) => layer.id === layerId);
    if (!current || (current.type !== 'image' && current.type !== 'video') || !current.raster) return false;
    if (current.type !== 'video') return true;
    const status = get(videoRasterStatus).get(layerId);
    return get(playheadTick) === projectTick &&
      videoRasterReadyAt(status, videoIdentity(current, projectTick)) &&
      status?.token === frameToken;
  }

  function schedulePreview() {
    stopPreview();
    previewError = '';
    if (!sourceReady) return;
    const ticket = ++previewTicket;
    const revision = captureProjectRevision();
    const frameToken = sourceLayer?.type === 'video' ? videoStatus?.token ?? null : null;
    const projectTick = get(playheadTick);
    previewBusy = true;
    previewTimer = setTimeout(
      () => buildPreview(ticket, revision, frameToken, projectTick),
      120,
    );
  }

  async function buildPreview(
    ticket: number,
    revision: number,
    frameToken: number | null,
    projectTick: number,
  ): Promise<void> {
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
      if (!previewCanvas) return;
      drawConversionPreview(previewCanvas, result, {
        cols: get(dims).w,
        rows: get(dims).h,
        fontFamily: get(canvasFont),
      });
    } catch (cause: unknown) {
      if ((!(cause instanceof Error) || cause.name !== 'AbortError') && ticket === previewTicket) {
        previewError = errorText(cause) || 'Preview failed';
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

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (event.target instanceof Element &&
        event.target.closest('.number-field[data-dirty="true"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
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
    const assetId = sourceLayer?.type === 'image'
      ? sourceLayer.assetId
      : sourceLayer?.type === 'video' ? sourceLayer.videoClip.assetId : null;
    syncVisualMediaRequests(visualRequestOwner, assetId ? [assetId] : []);
  });
  let videoStatus = $derived($videoRasterStatus.get(layerId) as VideoRasterStatus | undefined);
  let videoReady = $derived(sourceLayer?.type !== 'video' ||
    videoRasterReadyAt(videoStatus, videoIdentity(sourceLayer, $playheadTick)));
  let sourceReady = $derived(
    (sourceLayer?.type === 'image' || sourceLayer?.type === 'video') &&
    !!sourceLayer.raster && videoReady,
  );
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
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="modal-backdrop backdrop" role="presentation">
  <div class="modal-dialog dialog" role="dialog" aria-modal="true" aria-labelledby="convert-title"
    tabindex="-1" use:popupFocus={{ initialFocus: 'select' }}>
    <div class="modal-head head">
      <span id="convert-title">{sourceLayer?.type === 'video' ? 'Video frame to cells' : 'Image to cells'}</span>
      <button class="modal-close x" onclick={close} title="Close">×</button>
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

        {#if error}<p class="error">{error}</p>{/if}

        <button class="primary"
          disabled={busy || previewBusy || !previewResult || !sourceReady}
          onclick={run}>{busy ? 'Converting…' : previewBusy ? 'Previewing…' : 'Convert'}</button>
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
      </section>
    </div>
  </div>
</div>

<style>
  .dialog { width: min(780px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; }
  .body { display: grid; grid-template-columns: minmax(260px, 310px) minmax(320px, 1fr); gap: 16px; padding: 14px 12px; }
  .field, .number-row, .check { display: block; font-size: 11px; color: var(--text-dim); }
  .field { margin: 0 0 5px; }
  select, textarea, .body :global(.number-field) { width: 100%; box-sizing: border-box; margin: 0 0 12px; padding: 6px 7px; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  textarea { resize: vertical; font-family: var(--font-mono); }
  .number-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 2px 0 12px; }
  .number-row :global(.number-field) { width: 64px; margin: 0; }
  .check { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
  .error { color: var(--danger); font-size: 11px; }
  .primary { width: 100%; padding: 9px; background: var(--accent-dim); color: var(--on-accent); border: 1px solid var(--accent-dim); border-radius: var(--radius-sm); }
  .primary:not(:disabled):hover { background: var(--accent); }
  .primary:disabled { opacity: 0.6; cursor: wait; }
  .preview-pane { min-width: 0; }
  .preview-head { display: flex; justify-content: space-between; margin: 0 0 5px; color: var(--text-dim); font-size: 11px; }
  .preview-head small { color: var(--text-faint); font-size: 10px; }
  .preview-frame { position: relative; display: flex; min-height: 260px; align-items: center; justify-content: center; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-sm); background-color: var(--canvas-bg); background-image: linear-gradient(45deg, var(--transparency-check) 25%, transparent 25%), linear-gradient(-45deg, var(--transparency-check) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--transparency-check) 75%), linear-gradient(-45deg, transparent 75%, var(--transparency-check) 75%); background-position: 0 0, 0 5px, 5px -5px, -5px 0; background-size: 10px 10px; }
  .preview-frame canvas { display: block; width: 100%; height: auto; max-height: 340px; object-fit: contain; image-rendering: auto; }
  .preview-message { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 20px; background: color-mix(in srgb, var(--canvas-bg) 82%, transparent); color: var(--text-dim); font-size: 11px; text-align: center; }
  @media (max-width: 700px) {
    .body { grid-template-columns: 1fr; }
    .preview-frame { min-height: 200px; }
  }
</style>
