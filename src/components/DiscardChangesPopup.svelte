<script>
  import { popupFocus } from '../lib/popupFocus.js';

  /**
   * @typedef {Object} Props
   * @property {boolean} [busy]
   * @property {() => void} [onClose]
   * @property {() => void} [onConfirm]
   */

  /** @type {Props} */
  let { busy = false, onClose = () => {}, onConfirm = () => {} } = $props();

  function close() { if (!busy) onClose(); }
  function backdropClick(event) { if (event.target === event.currentTarget) close(); }
  function onKey(event) {
    if (event.key !== 'Escape' || busy) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="modal-backdrop" role="presentation" onclick={backdropClick}>
  <section class="modal-dialog discard-dialog" role="alertdialog" aria-modal="true"
    aria-labelledby="discard-title" tabindex="-1"
    use:popupFocus={{ initialFocus: '.cancel' }}>
    <header class="modal-head"><span id="discard-title">Discard changes?</span></header>
    <footer>
      <button class="secondary-button cancel" type="button" disabled={busy} onclick={close}>Cancel</button>
      <button class="danger-button" type="button" disabled={busy} onclick={onConfirm}>
        {busy ? 'Opening…' : 'Discard'}
      </button>
    </footer>
  </section>
</div>

<style>
  .discard-dialog { width: 330px; }
  footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px; }
  .danger-button { padding: 7px 12px; font-size: 12px; }
</style>
