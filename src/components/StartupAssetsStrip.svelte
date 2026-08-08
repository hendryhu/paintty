<script>
  import {
    retryStartupAssets,
    startupAssets,
    startupProgressState,
  } from '../lib/startupAssets.js';

  /**
   * @typedef {Object} Props
   * @property {boolean} [recoveryReady]
   */

  /** @type {Props} */
  let { recoveryReady = false } = $props();

  let progress = $derived(startupProgressState(recoveryReady, $startupAssets));
  let failedTasks = $derived($startupAssets.tasks.filter((task) => task.status === 'failed'));
  let failureTitle = $derived(failedTasks.map((task) => `${task.label}: ${task.error}`).join('\n'));
</script>

{#if progress.visible}
  <div
    class="startup-progress"
    role="progressbar"
    aria-label="Preparing editor resources"
    aria-valuemin="0"
    aria-valuemax={progress.tasks.length}
    aria-valuenow={progress.readyCount}
  >
    {#each progress.tasks as task (task.id)}
      <span
        class:ready={task.status === 'ready'}
        class:loading={task.status === 'loading'}
        class:failed={task.status === 'failed'}
        title={`${task.label}: ${task.status}`}
      ></span>
    {/each}
  </div>
{:else if $startupAssets.status === 'failed'}
  <button class="startup-retry" type="button" title={failureTitle} onclick={retryStartupAssets}>
    Optional assets incomplete · Retry
  </button>
{/if}

<style>
  .startup-progress {
    position: fixed; z-index: 140; left: 0; right: 0; bottom: 0; height: 3px;
    display: flex; gap: 1px; background: var(--panel-lo); pointer-events: none;
  }
  .startup-progress span {
    flex: 1; background: var(--border);
    transition: background-color 120ms ease;
  }
  .startup-progress span.loading {
    background: linear-gradient(90deg, var(--accent-dim), var(--accent), var(--accent-dim));
    background-size: 200% 100%;
    animation: loading-sweep 1.2s linear infinite;
  }
  .startup-progress span.ready { background: var(--play); animation: none; }
  .startup-progress span.failed { background: var(--danger); animation: none; }
  .startup-retry {
    position: fixed; z-index: 140; right: 8px; bottom: 6px;
    padding: 3px 7px; border: 1px solid var(--danger); border-radius: var(--radius-sm);
    background: var(--panel); color: var(--danger); font-size: 11px;
    box-shadow: 0 2px 8px var(--shadow-subtle);
  }
  .startup-retry:hover { background: var(--panel-hi); }
  @keyframes loading-sweep {
    to { background-position: -200% 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .startup-progress span.loading { animation: none; background: var(--accent); }
  }
</style>
