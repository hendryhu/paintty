<script>
  import NumberField from './NumberField.svelte';
  import { PROJECT_PARAMETER_LIMITS } from '../lib/projectPresets.js';

  /**
   * @typedef {Object} Props
   * @property {number} [columns]
   * @property {number} [rows]
   * @property {number} [baseFps]
   * @property {boolean} [disabled]
   * @property {(detail: { columns: number, rows: number, baseFps: number }) => void} [onCommit]
   */

  /** @type {Props} */
  let {
    columns = $bindable(80),
    rows = $bindable(24),
    baseFps = $bindable(24),
    disabled = false,
    onCommit = () => {},
  } = $props();

  function commit() {
    onCommit({ columns, rows, baseFps });
  }
</script>

<div class="project-parameters">
  <div class="parameter-field">
    <span>Columns</span>
    <NumberField ariaLabel="Columns"
      min={PROJECT_PARAMETER_LIMITS.columns.min} max={PROJECT_PARAMETER_LIMITS.columns.max}
      bind:value={columns} {disabled} onChange={commit} />
  </div>
  <div class="parameter-field">
    <span>Rows</span>
    <NumberField ariaLabel="Rows"
      min={PROJECT_PARAMETER_LIMITS.rows.min} max={PROJECT_PARAMETER_LIMITS.rows.max}
      bind:value={rows} {disabled} onChange={commit} />
  </div>
  <div class="parameter-field">
    <span>Base FPS</span>
    <NumberField ariaLabel="Base FPS"
      min={PROJECT_PARAMETER_LIMITS.baseFps.min} max={PROJECT_PARAMETER_LIMITS.baseFps.max}
      bind:value={baseFps} {disabled} onChange={commit} />
  </div>
</div>

<style>
  .project-parameters {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px;
  }
  .parameter-field { display: grid; gap: 5px; color: var(--text-dim); font-size: 11px; }
  :global(.project-parameters .number-field) { width: 100%; padding: 5px 6px; }
  @media (max-width: 440px) {
    .project-parameters { grid-template-columns: 1fr; }
  }
</style>
