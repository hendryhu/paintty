  <script>
  import { CLI_RELEASES_URL } from '../lib/cliDownloads.js';
  import { popupFocus } from '../lib/popupFocus.js';

  /**
   * @typedef {Object} Props
   * @property {() => void} [onClose]
   */

  /** @type {Props} */
  let { onClose = () => {} } = $props();
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

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={backdropClick}>
  <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="helper-title"
    tabindex="-1" use:popupFocus={{ initialFocus: '.close' }}>
    <header>
      <div>
        <h2 id="helper-title">CLI Preview</h2>
        <p>Preview your artwork in a real terminal.</p>
      </div>
      <button class="close" onclick={close} aria-label="Close">×</button>
    </header>

    <ol>
      <li>Open the paintty-cli Releases page and download the binary for your platform.</li>
      <li>Choose <strong>File → Watch folder…</strong> and pick a folder.</li>
      <li>On Windows, double-click <code>paintty-cli-windows-x86_64.exe</code> and choose the same folder.</li>
      <li>On Linux, run <code>chmod +x paintty-cli-linux-x86_64</code> once for each newly downloaded binary, then run <code>./paintty-cli-linux-x86_64 &lt;folder&gt;</code>.</li>
    </ol>

    <div class="downloads" aria-label="Paintty CLI download">
      <a href={CLI_RELEASES_URL} target="_blank" rel="noreferrer">Open paintty-cli Releases</a>
    </div>

  </section>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center; background: var(--modal-backdrop-strong); }
  .dialog { width: min(520px, calc(100vw - 32px)); background: var(--panel-hi); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 10px 34px var(--shadow-modal-strong); }
  header { display: flex; justify-content: space-between; gap: 16px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
  h2 { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: var(--text); }
  header p { margin: 0; font-size: 11px; color: var(--text-dim); }
  .close { align-self: flex-start; width: 24px; height: 24px; border: 0; background: transparent; color: var(--text-dim); font-size: 18px; }
  .close:hover { color: var(--text); }
  ol { margin: 0; padding: 16px 22px 8px 38px; color: var(--text); font-size: 12px; line-height: 1.7; }
  code { padding: 1px 4px; color: var(--accent); background: var(--panel); border: 1px solid var(--border); border-radius: 3px; font-family: var(--font-mono); }
  .downloads { padding: 8px 16px 14px; }
  .downloads a { display: block; padding: 10px; text-align: center; text-decoration: none; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .downloads a:hover { border-color: var(--accent); background: var(--accent-dim); }
</style>
