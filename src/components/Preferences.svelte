<script>
  import { canvasFont, loadedFontName, nerdFontReady, loadFontFile, useDefaultFont, DEFAULT_FAMILY } from '../lib/font.js';
  import { colorDepth } from '../lib/stores.js';
  import { popupFocus } from '../lib/popupFocus.js';

  /**
   * @typedef {Object} Props
   * @property {() => void} [onClose]
   */

  /** @type {Props} */
  let { onClose = () => {} } = $props();
  let error = $state('');
  let dialog = $state();

  async function onFontFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    error = '';
    try {
      await loadFontFile(file);
    } catch (err) {
      error = 'Could not load font: ' + err.message;
    }
  }
  function close() { onClose(); }
  function backdropClick(event) { if (event.target === event.currentTarget) close(); }
  function onKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="overlay" onclick={backdropClick} role="presentation">
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="preferences-title"
    tabindex="-1" bind:this={dialog} use:popupFocus={{ initialFocus: 'button' }}>
    <div class="head">
      <span id="preferences-title">Preferences</span>
      <button class="x" onclick={close}>×</button>
    </div>

    <!-- Preferences are app-local; project-authoring settings belong in Project Settings. -->
    <div class="section">
      <div class="label">Canvas font</div>
      <div class="current">{$loadedFontName || ($nerdFontReady ? `${DEFAULT_FAMILY} (fetched)` : 'system monospace (Nerd Font not loaded)')}</div>
      <p class="hint">Load a local Nerd Font (.ttf/.otf/.woff2) so PUA glyphs render as they will in your terminal.</p>
      <div class="row">
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
      <div class="seg">
        <button class:on={$colorDepth === 'truecolor'} onclick={() => colorDepth.set('truecolor')}>truecolor</button>
        <button class:on={$colorDepth === '256'} onclick={() => colorDepth.set('256')}>256 (fallback)</button>
      </div>
      <p class="hint">256 mode previews how art maps onto a 256-color terminal (nearest-color).</p>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0; background: var(--modal-backdrop); z-index: 100;
    display: flex; align-items: center; justify-content: center;
  }
  .dialog {
    width: 460px; background: var(--panel); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: 0 10px 40px var(--shadow-modal); overflow: hidden;
  }
  .head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; background: var(--panel-hi); border-bottom: 1px solid var(--border);
    font-weight: bold;
  }
  .x { width: 24px; height: 24px; padding: 0; background: transparent; border: none; color: var(--text-dim); font-size: 18px; line-height: 1; }
  .x:hover { color: var(--text); }
  .section { padding: 14px; border-bottom: 1px solid var(--border); }
  .section:last-child { border-bottom: none; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim); margin-bottom: 6px; }
  .current { font-family: var(--font-mono); font-size: 12px; margin-bottom: 6px; }
  .hint { font-size: 11px; color: var(--text-dim); margin: 6px 0; line-height: 1.5; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
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
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  /* Fixed width prevents the toggle from shifting. */
  .seg button { background: var(--panel-hi); color: var(--text-dim); border: none; padding: 5px 0; width: 120px; text-align: center; font-size: 12px; border-right: 1px solid var(--border); }
  .seg button:last-child { border-right: none; }
  .seg button.on { background: var(--accent-dim); color: var(--on-accent); }
</style>
