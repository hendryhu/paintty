<script lang="ts">
  import { canvasFont, loadedFontName, nerdFontReady, loadFontFile, useDefaultFont, DEFAULT_FAMILY } from '../lib/font.js';
  import { colorDepth } from '../lib/stores.js';
  import { popupFocus } from '../lib/popupFocus.js';
  import { errorText } from '../lib/types/project-types.js';

  interface Props {
    onClose?: () => void;
  }

  let { onClose = () => {} }: Props = $props();
  let error = $state('');
  let dialog = $state<HTMLDivElement>();

  async function onFontFile(event: Event): Promise<void> {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const file = input.files?.[0];
    if (!file) return;
    error = '';
    try {
      await loadFontFile(file);
    } catch (err: unknown) {
      error = 'Could not load font: ' + errorText(err);
    }
  }
  function close() { onClose(); }
  function onKey(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="modal-backdrop overlay" role="presentation">
  <div class="modal-dialog dialog" role="dialog" aria-modal="true" aria-labelledby="preferences-title"
    tabindex="-1" bind:this={dialog} use:popupFocus={{ initialFocus: 'button' }}>
    <div class="modal-head head">
      <span id="preferences-title">Preferences</span>
      <button class="modal-close x" onclick={close}>×</button>
    </div>

    <!-- Preferences are app-local; project-authoring settings belong in Project Settings. -->
    <div class="section">
      <div class="label">Canvas font</div>
      <div class="current">{$loadedFontName || ($nerdFontReady ? `${DEFAULT_FAMILY} (fetched)` : 'system monospace (Nerd Font not loaded)')}</div>
      <p class="hint">Load a local Nerd Font (.ttf/.otf/.woff2) so PUA glyphs render as they will in your terminal.</p>
      <div class="preferences-row">
        <label class="filebtn">
          Load font…
          <input type="file" accept=".ttf,.otf,.woff,.woff2,.ttc" onchange={onFontFile} />
        </label>
        {#if $loadedFontName}
          <button class="reset" onclick={useDefaultFont}>Reset to default</button>
        {/if}
      </div>
      {#if error}<div class="err">{error}</div>{/if}
      <div class="sample" style="font-family: {$canvasFont};">
        ABCabc 123 █▀▄▚ ◉●▲ &#xE0A0; &#xE700; &#xF031;
      </div>
    </div>

    <div class="section">
      <div class="label">Color depth</div>
       <div class="ui-segmented seg">
        <button class:on={$colorDepth === 'truecolor'} onclick={() => colorDepth.set('truecolor')}>truecolor</button>
        <button class:on={$colorDepth === '256'} onclick={() => colorDepth.set('256')}>256 (fallback)</button>
      </div>
      <p class="hint">256 mode previews how art maps onto a 256-color terminal (nearest-color).</p>
    </div>
  </div>
</div>

<style>
  .dialog { width: 460px; background: var(--panel); box-shadow: 0 10px 40px var(--shadow-modal); }
  .head { padding: 10px 14px; background: var(--panel-hi); font-weight: bold; }
  .section { padding: 14px; border-bottom: 1px solid var(--border); }
  .section:last-child { border-bottom: none; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-bottom: 6px; }
  .current { font-family: var(--font-mono); font-size: 12px; margin-bottom: 6px; }
  .hint { font-size: 11px; color: var(--text-dim); margin: 6px 0; line-height: 1.5; }
  .preferences-row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .filebtn {
    display: inline-block; padding: 5px 12px; background: var(--accent-dim); color: var(--on-accent);
    border-radius: var(--radius-sm); cursor: pointer; font-size: 12px;
  }
  .filebtn input { display: none; }
  .reset { padding: 5px 12px; background: var(--panel-hi); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; }
  .err { color: var(--danger); font-size: 11px; margin-top: 6px; }
  .sample {
    margin-top: 10px; padding: 10px; background: var(--canvas-bg); border-radius: var(--radius-sm);
    font-size: 20px; color: var(--text); letter-spacing: 2px;
    white-space: nowrap; overflow-x: auto;
  }
   /* Fixed width prevents the toggle from shifting. */
   .seg button { width: 120px; padding: 5px 0; text-align: center; }
</style>
