  <script>
  import Icon from './Icon.svelte';
  import { activeTool, altEyedrop, paintColor } from '../lib/stores.js';
  import { layers, activeLayerId, activeLayerPart } from '../lib/grid.js';
  import { isToolDisabledForLayer } from '../lib/toolAvailability.js';

  /**
   * @typedef {Object} Props
   * @property {(detail: { x: number, y: number }) => void} [onColor]
   */

  /** @type {Props} */
  let { onColor = () => {} } = $props();

  const tools = [
    { id: 'brush',      icon: 'material-symbols:edit',              title: 'Brush' },
    { id: 'subcell',    glyph: '▚',                                 title: 'Special brush' },
    { id: 'eraser',     icon: 'material-symbols:ink-eraser',        title: 'Eraser' },
    { id: 'fill',       icon: 'material-symbols:format-color-fill', title: 'Fill' },
    { id: 'eyedropper', icon: 'material-symbols:colorize',          title: 'Eyedropper' },
    { id: 'color',                                                   title: 'Color' },
    null,
    { id: 'line',       icon: 'ph:line-segment-fill',               title: 'Line' },
    { id: 'rect',       icon: 'material-symbols:rectangle',         title: 'Rectangle' },
    { id: 'circle',     icon: 'material-symbols:circle',            title: 'Circle' },
    { id: 'polygon',    icon: 'material-symbols:pentagon',           title: 'Polygon' },
    null,
    { id: 'move',       icon: 'material-symbols:open-with',         title: 'Move' },
    { id: 'select',     icon: 'material-symbols:select',            title: 'Select' },
    { id: 'crop',       icon: 'material-symbols:crop',              title: 'Crop' },
    null,
    { id: 'text',       icon: 'material-symbols:title',             title: 'Text' },
  ];

  let activeLayer = $derived($layers.find((layer) => layer.id === $activeLayerId));

  function choose(t) { activeTool.set(t.id); }
  function openColor(event) {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const pickerWidth = 292;
    const pickerHeight = 340;
    let x = rect.right + 10;
    if (x + pickerWidth > window.innerWidth - 4) x = Math.max(4, rect.left - pickerWidth - 10);
    const y = Math.max(4, Math.min(rect.top, window.innerHeight - pickerHeight - 4));
    onColor({ x, y });
  }
</script>

<div class="tools">
  {#each tools as t}
    {#if t === null}
      <div class="sep"></div>
    {:else}
      {#if t.id === 'color'}
        <button type="button" class="color-tool"
          aria-label="Color" title="Color" onclick={openColor}>
          <span class="color-chip" style="background: {$paintColor}"></span>
        </button>
      {:else}
      <button
        class="tool icon-tool-button"
        class:active={$altEyedrop ? t.id === 'eyedropper' : $activeTool === t.id}
        class:glyph={t.glyph}
        disabled={isToolDisabledForLayer(t.id, activeLayer, $activeLayerPart)}
        title={t.title}
        onclick={() => choose(t)}
      >
        {#if t.icon}<Icon icon={t.icon} />{:else}{t.glyph}{/if}
      </button>
      {/if}
    {/if}
  {/each}
</div>

<style>
  .tools {
    grid-area: tools; background: var(--panel);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column; align-items: center;
    gap: 3px; padding: 6px 0; overflow-y: auto;
  }
  .tool {
    flex: 0 0 30px;
  }
  .tool.glyph { font-family: var(--font-mono); font-size: 15px; }
  .color-tool {
    width: 30px; height: 30px; flex: 0 0 30px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    background: transparent; border: 0; border-radius: var(--radius-sm);
  }
  .color-chip {
    width: 17px; height: 17px;
    border: 1px solid var(--text); border-radius: 2px;
    box-shadow: 0 0 0 1px var(--canvas-bg);
  }
  .color-tool:hover { background: var(--panel-hi); }
  .color-tool:hover .color-chip { border-color: var(--accent); }
  .sep { width: 22px; height: 1px; background: var(--border); margin: 3px 0; }
</style>
