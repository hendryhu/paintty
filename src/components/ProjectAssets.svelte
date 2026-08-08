<script>
  import { onMount, tick } from 'svelte';
  import { authoredRevision } from '../lib/grid.js';
  import {
    currentMediaUsageCounts,
    placeMediaAsset,
    replaceMediaFile,
  } from '../lib/mediaCommands.js';
  import { mediaRuntimeStatus, projectMediaRegistry } from '../lib/mediaRegistry.js';
  import { notifyError } from '../lib/notifications.js';
  import { listProjectAssets } from '../lib/projectAssets.js';
  import {
    captureProjectRevision,
    isProjectRevisionCurrent,
  } from '../lib/documentLifecycle.js';
  import { playing } from '../lib/frames.js';
  import { get } from 'svelte/store';
  import { popupFocus } from '../lib/popupFocus.js';

  /**
   * @typedef {Object} Props
   * @property {any} [focusAssetId]
   * @property {() => void} [onClose]
   */

  /** @type {Props} */
  let { focusAssetId = null, onClose = () => {} } = $props();
  let dialog = $state();
  let fileInput = $state();
  let pickerAsset = null;
  let busyAssetId = $state(null);
  let cachedHashes = $state(new Set());
  let cacheGeneration = $state(-1);


  function close() { onClose(); }
  function backdropClick(event) { if (event.target === event.currentTarget) close(); }

  function requestImport(kind) {
    if ($playing || busyAssetId != null) return;
    window.dispatchEvent(new CustomEvent('import-project-media', { detail: { kind } }));
  }

  async function refreshCache(generation) {
    cacheGeneration = generation;
    try {
      const records = await listProjectAssets();
      if (cacheGeneration === generation) cachedHashes = new Set(records.map((record) => record.hash));
    } catch {
      if (cacheGeneration === generation) cachedHashes = new Set();
    }
  }

  function assetStatus(asset, statuses, hashes) {
    const runtime = statuses.get(asset.assetId)?.state;
    if (runtime === 'decode-failed') return 'decode failed';
    if (runtime === 'missing' || !hashes.has(asset.hash)) return 'missing';
    return 'ready';
  }

  function acceptFor(kind) {
    return kind === 'image' ? 'image/*' : kind === 'audio' ? 'audio/*' : 'video/*';
  }

  function chooseReplacement(asset) {
    pickerAsset = asset;
    fileInput.accept = acceptFor(asset.kind);
    fileInput.value = '';
    fileInput.click();
  }

  async function onFile() {
    const file = fileInput.files?.[0];
    const asset = pickerAsset;
    pickerAsset = null;
    if (!file || !asset) return;
    const revision = captureProjectRevision();
    busyAssetId = asset.assetId;
    try {
      await replaceMediaFile(asset.assetId, file, {
        valid: () => isProjectRevisionCurrent(revision) && !get(playing),
      });
      await refreshCache($projectMediaRegistry.generation);
    } catch (error) {
      notifyError(`Could not update media: ${error.message}`);
    } finally {
      busyAssetId = null;
    }
  }

  async function place(asset) {
    const revision = captureProjectRevision();
    busyAssetId = asset.assetId;
    try {
      await placeMediaAsset(asset.assetId, {
        valid: () => isProjectRevisionCurrent(revision) && !get(playing),
      });
    } catch (error) {
      notifyError(`Could not place media: ${error.message}`);
    } finally {
      busyAssetId = null;
    }
  }

  function details(asset) {
    if (asset.kind === 'image') return `${asset.width}x${asset.height}`;
    if (asset.kind === 'video') return `${asset.width}x${asset.height} / ${asset.duration.toFixed(2)}s`;
    return `${asset.duration.toFixed(2)}s`;
  }

  function sizeLabel(size) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  function onKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }

  onMount(async () => {
    await refreshCache(registry.generation);
    await tick();
    dialog?.querySelector(`[data-asset-id="${focusAssetId}"]`)?.scrollIntoView({ block: 'center' });
  });
  let registry = $derived($projectMediaRegistry);
  let usage = $derived(($authoredRevision, currentMediaUsageCounts()));
  let rows = $derived(registry.assets.map((asset) => ({
    ...asset,
    usage: usage.get(asset.assetId) || 0,
    status: assetStatus(asset, $mediaRuntimeStatus, cachedHashes),
  })));
  $effect(() => {
    if (registry.generation !== cacheGeneration) refreshCache(registry.generation);
  });
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="modal-backdrop" onclick={backdropClick} role="presentation">
  <section class="modal-dialog assets-dialog" role="dialog" aria-modal="true" aria-labelledby="assets-title"
    tabindex="-1" bind:this={dialog} use:popupFocus={{ initialFocus: '.modal-close' }}>
    <header class="modal-head">
      <span id="assets-title">Project Assets</span>
      <button class="modal-close" onclick={close} aria-label="Close">×</button>
    </header>
    <div class="asset-list scroll">
      {#each rows as asset (asset.assetId)}
        <article class:focused={asset.assetId === focusAssetId} data-asset-id={asset.assetId}>
          <div class="asset-copy">
            <strong title={asset.sourceName}>{asset.sourceName}</strong>
            <span>{asset.kind} / {details(asset)} / {sizeLabel(asset.size)}</span>
            <code title={asset.hash}>{asset.hash.slice(0, 12)}</code>
          </div>
          <div class="asset-state">
            <span class:bad={asset.status !== 'ready'}>{asset.status}</span>
            <span>{asset.usage} use{asset.usage === 1 ? '' : 's'}</span>
          </div>
          <div class="asset-actions">
            <button disabled={$playing || busyAssetId != null || asset.status !== 'ready'} onclick={() => place(asset)}>
              {asset.usage ? 'Reuse' : 'Place'}
            </button>
            <button disabled={$playing || busyAssetId != null} onclick={() => chooseReplacement(asset)}>
              {asset.status === 'ready' ? 'Replace…' : 'Relink…'}
            </button>
          </div>
        </article>
      {/each}
      {#if !rows.length}
        <div class="empty" aria-label="Import project media">
          <span>No project assets.</span>
          <div class="empty-actions">
            <button disabled={$playing || busyAssetId != null} onclick={() => requestImport('image')}>Import image…</button>
            <button disabled={$playing || busyAssetId != null} onclick={() => requestImport('audio')}>Import audio…</button>
            <button disabled={$playing || busyAssetId != null} onclick={() => requestImport('video')}>Import video…</button>
          </div>
        </div>
      {/if}
    </div>
    <input class="native-picker" type="file" bind:this={fileInput} onchange={onFile} />
  </section>
</div>

<style>
  .assets-dialog { width: min(720px, calc(100vw - 32px)); max-height: min(680px, calc(100dvh - 32px)); }
  .asset-list { min-height: 140px; max-height: 540px; overflow: auto; background: var(--panel-lo); }
  article { display: grid; grid-template-columns: minmax(0, 1fr) 100px auto; gap: 12px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  article.focused { background: var(--accent-wash); box-shadow: inset 2px 0 var(--accent); }
  .asset-copy { min-width: 0; display: grid; gap: 3px; }
  .asset-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .asset-copy span, .asset-state { color: var(--text-dim); font-size: 10px; }
  .asset-copy code { color: var(--text-faint); font: 10px var(--font-mono); }
  .asset-state { display: grid; gap: 4px; text-align: right; text-transform: lowercase; }
  .asset-state .bad { color: var(--danger); }
  .asset-actions { display: flex; gap: 6px; }
  .asset-actions button { min-width: 68px; padding: 5px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel-hi); color: var(--text); font-size: 11px; }
  .asset-actions button:not(:disabled):hover { border-color: var(--accent); }
  .asset-actions button:disabled { opacity: 0.4; }
  .empty { display: flex; min-height: 140px; box-sizing: border-box; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 16px; color: var(--text-dim); font-size: 11px; }
  .empty-actions { display: flex; gap: 8px; }
  .empty button { min-width: 104px; padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel-hi); color: var(--text); font-size: 11px; }
  .empty button:not(:disabled):hover { border-color: var(--accent); background: var(--accent-wash); }
  .empty button:disabled { opacity: 0.4; }
  .native-picker { display: none; }
  @media (max-width: 620px) {
    .assets-dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); }
    article { grid-template-columns: minmax(0, 1fr) auto; }
    .asset-state { text-align: left; }
    .asset-actions { grid-column: 1 / -1; }
    .asset-actions button { flex: 1; }
    .empty { flex-direction: column; }
    .empty button { width: min(220px, 100%); }
  }
</style>
