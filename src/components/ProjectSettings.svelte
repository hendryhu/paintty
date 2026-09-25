<script lang="ts">
  import ProjectParameterFields from './ProjectParameterFields.svelte';
  import { dims } from '../lib/grid.js';
  import { fps, playing } from '../lib/frames.js';
  import { applyProjectSettings } from '../lib/projectSettings.js';
  import { notifyError } from '../lib/notifications.js';
  import { popupFocus } from '../lib/popupFocus.js';
  import { errorText } from '../lib/types/project-types.js';

  interface Props {
    onClose?: () => void;
  }

  let { onClose = () => {} }: Props = $props();
  let dialog = $state<HTMLDivElement>();
  let columns = $state($dims.w);
  let rows = $state($dims.h);
  let baseFps = $state($fps);

  function close() { onClose(); }
  function apply() {
    if ($playing) return;
    try {
      applyProjectSettings({ columns, rows, baseFps });
      close();
    } catch (error: unknown) {
      notifyError(`Could not update project settings: ${errorText(error)}`);
    }
  }
  function onKey(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    if (event.target instanceof Element &&
      event.target.closest('.number-field[data-dirty="true"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="modal-backdrop" role="presentation">
  <div class="modal-dialog settings-dialog" role="dialog" aria-modal="true"
    aria-labelledby="project-settings-title" tabindex="-1" bind:this={dialog}
    use:popupFocus={{ initialFocus: 'input' }}>
    <header class="modal-head">
      <span id="project-settings-title">Project Settings</span>
      <button class="modal-close" type="button" aria-label="Close" onclick={close}>&times;</button>
    </header>
    <div class="body">
      <ProjectParameterFields bind:columns bind:rows bind:baseFps disabled={$playing} />
      <p>Resizing anchors content to the top-left. Growing adds empty cells; shrinking crops.</p>
    </div>
    <footer class="ui-dialog-footer">
      <button class="secondary-button" type="button" onclick={close}>Cancel</button>
      <button class="primary-button" type="button" disabled={$playing} onclick={apply}>Apply</button>
    </footer>
  </div>
</div>

<style>
  .settings-dialog { width: min(460px, calc(100vw - 32px)); }
  .body { padding: 14px; }
  p { margin: 10px 0 0; color: var(--text-dim); font-size: 11px; line-height: 1.5; }
  .ui-dialog-footer { border-top: 1px solid var(--border); }
</style>
