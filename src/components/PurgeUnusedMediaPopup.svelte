<script>
  import { authoredRevision } from '../lib/grid.js';
  import { playing } from '../lib/frames.js';
  import {
    currentMediaUsageCounts,
    purgeUnusedMedia,
  } from '../lib/mediaCommands.js';
  import { projectMediaRegistry } from '../lib/mediaRegistry.js';
  import {
    canPurgeUnusedMedia,
    formatByteSize,
    planUnusedMediaPurge,
  } from '../lib/mediaPurge.js';
  import { notifyInfo } from '../lib/notifications.js';
  import { popupFocus } from '../lib/popupFocus.js';
  import { serializeJSON } from '../lib/fileio.js';

  /**
   * @typedef {Object} Props
   * @property {() => void} [onClose]
   */

  /** @type {Props} */
  let { onClose = () => {} } = $props();
  let usage = $derived(($authoredRevision, currentMediaUsageCounts()));
  let plan = $derived(planUnusedMediaPurge({
    registry: $projectMediaRegistry,
    usageCounts: usage,
    serializedProject: serializeJSON(),
  }));
  let enabled = $derived(canPurgeUnusedMedia({ playing: $playing, unusedCount: plan.assets.length }));

  function close() { onClose(); }
  function backdropClick(event) { if (event.target === event.currentTarget) close(); }
  function purge() {
    if (!enabled) return;
    const count = purgeUnusedMedia();
    close();
    if (count) notifyInfo(`Purged ${count} unused media ${count === 1 ? 'item' : 'items'}.`);
  }
  function onKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="modal-backdrop" role="presentation" onclick={backdropClick}>
  <section class="modal-dialog purge-dialog" role="alertdialog" aria-modal="true"
    aria-labelledby="purge-title" tabindex="-1" use:popupFocus={{ initialFocus: '.cancel' }}>
    <header class="modal-head"><span id="purge-title">Purge unused media?</span></header>
    <div class="purge-list scroll">
      {#each plan.assets as asset (asset.assetId)}
        <div class="purge-row">
          <strong title={asset.sourceName}>{asset.sourceName}</strong>
          <span>{asset.kind}</span>
          <span>{formatByteSize(asset.size)}</span>
        </div>
      {/each}
    </div>
    <p class="summary">{formatByteSize(plan.freedBytes)} / {formatByteSize(plan.totalBytes)} will be freed from the project.</p>
    <footer>
      <button class="secondary-button cancel" type="button" onclick={close}>Cancel</button>
      <button class="danger-button" type="button" disabled={!enabled} onclick={purge}>Purge</button>
    </footer>
  </section>
</div>

<style>
  .purge-dialog { width: min(520px, calc(100vw - 32px)); }
  .purge-list { max-height: min(320px, calc(100dvh - 220px)); overflow: auto; background: var(--panel-lo); }
  .purge-row { display: grid; grid-template-columns: minmax(0, 1fr) 70px 82px; gap: 12px; padding: 9px 12px; border-bottom: 1px solid var(--border); font-size: 11px; }
  .purge-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .purge-row span { color: var(--text-dim); text-align: right; }
  .summary { margin: 0; padding: 11px 12px; color: var(--text-dim); font-size: 11px; }
  footer { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); }
  footer .danger-button { padding: 7px 12px; font-size: 12px; }
</style>
