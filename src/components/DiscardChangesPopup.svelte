<script lang="ts">
  import { popupFocus } from '../lib/popupFocus.js';

  interface Props {
    busy?: boolean;
    onClose?: () => void;
    onConfirm?: () => void;
  }

  let { busy = false, onClose = () => {}, onConfirm = () => {} }: Props = $props();

  function close() { if (!busy) onClose(); }
  function onKey(event: KeyboardEvent) {
    if (event.key !== 'Escape' || busy) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="modal-backdrop" role="presentation">
  <div class="modal-dialog discard-dialog" role="alertdialog" aria-modal="true"
    aria-labelledby="discard-title" tabindex="-1"
    use:popupFocus={{ initialFocus: '.cancel' }}>
    <header class="modal-head"><span id="discard-title">Discard changes?</span></header>
    <footer class="ui-dialog-footer">
      <button class="secondary-button cancel" type="button" disabled={busy} onclick={close}>Cancel</button>
      <button class="danger-button" type="button" disabled={busy} onclick={onConfirm}>
        {busy ? 'Opening…' : 'Discard'}
      </button>
    </footer>
  </div>
</div>

<style>
  .discard-dialog { width: 330px; }
  .ui-dialog-footer { padding: 12px; }
  .danger-button { padding: 7px 12px; font-size: 12px; }
</style>
