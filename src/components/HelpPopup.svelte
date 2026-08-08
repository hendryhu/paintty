<script>
  import { popupFocus } from '../lib/popupFocus.js';

  /**
   * @typedef {Object} Props
   * @property {string} [page]
   * @property {() => void} [onClose]
   */

  /** @type {Props} */
  let { page = 'animation-json', onClose = () => {} } = $props();
  const shortcuts = [
    ['Ctrl/Cmd+N', 'New project'],
    ['Ctrl/Cmd+S', 'Save project'],
    ['Ctrl/Cmd+Shift+S', 'Save As'],
    ['Ctrl/Cmd+Z', 'Undo'],
    ['Ctrl/Cmd+Y / Ctrl/Cmd+Shift+Z', 'Redo'],
    ['Ctrl/Cmd+C / Ctrl/Cmd+V', 'Copy / paste selected layer clips or Timeline clips'],
    ['Ctrl/Cmd+D', 'Deselect active context'],
    ['Ctrl/Cmd+T', 'Transform selection / move layer'],
    ['K / Space (Timeline)', 'Play / stop'],
    ['Left / Right', 'Previous / next tick'],
    ['V / C / T', 'Timeline Select / Razor / Tag'],
    ['Timeline ruler drag', 'Scrub / stop'],
    ['Select lane drag', 'Marquee clips / keys'],
    ['Shift+drag clip', 'Duplicate and move selected clips'],
    ['Razor lane drag', 'Split crossed clips'],
    ['Tag lane click / drag', 'Preview, then add / edit at release'],
    ['Select tag / key drag', 'Move on snapped project ticks'],
    ['Tick N / M', 'Zero-based current / final project tick'],
    ['+ / = / - / Ctrl/Cmd+wheel', 'Timeline zoom'],
    ['F2', 'Rename selected layer'],
    ['Delete / Backspace', 'Delete selected Timeline clips/keys or selected layers'],
    ['Space+drag / middle-drag', 'Pan canvas'],
    ['Escape', 'Close or cancel frontmost action'],
    ['Tab / Shift+Tab', 'Reserved / unsupported'],
  ];
  const fields = [
    ['format', 'string', '`paintty-animation`'],
    ['version', 'integer', '`1`'],
    ['canvas.columns, canvas.rows', 'positive integer', 'Terminal frame size'],
    ['timebase.ticksPerSecond', 'positive integer', 'Playback tick rate'],
    ['tags[]', 'tag', 'Sequence markers and programmer events'],
    ['tags[].tick', 'non-negative integer', 'Zero-based project tick'],
    ['layers[]', 'layer', 'Back-to-front runtime layer metadata'],
    ['frames[].hold', 'positive integer', 'Frame duration in ticks'],
    ['frames[].layers[]', 'layer frame', 'Sparse cells by runtime layer index'],
    ['frames[].composite[]', 'cell[]', 'Flattened terminal frame'],
    ['audio', 'mixed audio | omitted', 'One ZIP-bundled WAV starting at tick 0'],
    ['audio.source, audio.mime', 'string', '`audio.wav`, `audio/wav`'],
    ['audio.sampleRate, audio.channels', 'integer', '`48000` Hz stereo (`2`)'],
    ['audio.durationUs', 'non-negative integer', 'Mixed WAV duration in microseconds'],
    ['cell.x, cell.y', 'integer', 'Terminal cell position'],
    ['cell.glyph', 'string | null', 'Glyph or background-only cell'],
    ['cell.foreground, cell.background', 'string | null', 'Hex colors'],
    ['cell.width', '1 | 2', 'Terminal glyph width'],
  ];
  const tags = [
    ['loop-start', 'none', 'Inclusive start; without end, loops to sequence end'],
    ['loop-end', 'none', 'Inclusive loop end; at most one'],
    ['custom', 'non-empty string', 'Programmer event'],
  ];
  const indexes = [
    ['layers[].id', 'Dense back-to-front index from 0'],
    ['frames[].layers[].layerId', 'Index into `layers`'],
  ];
  const jsonExample = `{
  "format": "paintty-animation",
  "version": 1,
  "canvas": { "columns": 2, "rows": 1 },
  "timebase": { "ticksPerSecond": 12 },
  "tags": [{ "tick": 0, "type": "custom", "value": "ready" }],
  "audio": { "source": "audio.wav", "mime": "audio/wav", "sampleRate": 48000, "channels": 2, "durationUs": 83333 },
  "layers": [{ "id": 0, "name": "Ink", "order": 0 }],
  "frames": [{
    "hold": 1,
    "layers": [{
      "layerId": 0,
      "cells": [{ "x": 0, "y": 0, "glyph": "@", "foreground": "#ffffff", "background": null, "width": 1 }]
    }],
    "composite": [{ "x": 0, "y": 0, "glyph": "@", "foreground": "#ffffff", "background": null, "width": 1 }]
  }]
}`;

  let shortcutsPage = $derived(page === 'shortcuts');
  let title = $derived(shortcutsPage ? 'Keyboard Shortcuts' : 'Animation JSON Format');

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

<div class="backdrop" role="presentation" onclick={backdropClick}>
  <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="help-popup-title"
    tabindex="-1" use:popupFocus={{ initialFocus: '.close' }}>
    <header>
      <h2 id="help-popup-title">{title}</h2>
      <button class="close" type="button" aria-label="Close help" onclick={close}>&times;</button>
    </header>

    <div class="body scroll">
      {#if shortcutsPage}
        <table aria-label="Supported keyboard shortcuts">
          <thead><tr><th>Shortcut</th><th>Action</th></tr></thead>
          <tbody>
            {#each shortcuts as row}
              <tr><td><kbd>{row[0]}</kbd></td><td>{row[1]}</td></tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <section>
          <h3>Fields</h3>
          <table>
            <thead><tr><th>Field</th><th>Type</th><th>Meaning</th></tr></thead>
            <tbody>
              {#each fields as row}
                <tr><td><code>{row[0]}</code></td><td>{row[1]}</td><td>{@html row[2].replaceAll(/`([^`]+)`/g, '<code>$1</code>')}</td></tr>
              {/each}
            </tbody>
          </table>
        </section>
        <section>
          <h3>Tags</h3>
          <table>
            <thead><tr><th>Type</th><th>Value</th><th>Semantics</th></tr></thead>
            <tbody>
              {#each tags as row}<tr><td><code>{row[0]}</code></td><td>{row[1]}</td><td>{row[2]}</td></tr>{/each}
            </tbody>
          </table>
        </section>
        <section>
          <h3>Indexes</h3>
          <table>
            <thead><tr><th>Field</th><th>Semantics</th></tr></thead>
            <tbody>
              {#each indexes as row}<tr><td><code>{row[0]}</code></td><td>{row[1]}</td></tr>{/each}
            </tbody>
          </table>
        </section>
        <section>
          <h3>Example</h3>
          <pre><code>{jsonExample}</code></pre>
        </section>
      {/if}
    </div>
  </section>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center;
    padding: 16px; background: var(--modal-backdrop-strong);
  }
  .dialog {
    display: flex; flex-direction: column; width: min(760px, 100%); max-height: calc(100dvh - 32px);
    overflow: hidden; background: var(--panel-hi); color: var(--text); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: 0 10px 34px var(--shadow-modal-strong);
  }
  header {
    display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between;
    padding: 10px 12px; border-bottom: 1px solid var(--border);
  }
  h2 { margin: 0; font-size: 14px; font-weight: 600; }
  .close { width: 24px; height: 24px; padding: 0; border: 0; background: transparent; color: var(--text-dim); font-size: 18px; }
  .close:hover { color: var(--text); }
  .body { min-height: 0; overflow: auto; padding: 12px; user-select: text; }
  .body :global(*) { user-select: text; }
  section + section { margin-top: 14px; }
  h3 { margin: 0 0 6px; color: var(--text-dim); font-size: 10px; letter-spacing: 0.6px; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { padding: 6px 7px; border: 1px solid var(--border); text-align: left; vertical-align: top; }
  th { background: var(--panel); color: var(--text-dim); font-weight: 600; }
  kbd, code { color: var(--accent); font-family: var(--font-mono); }
  pre { margin: 0; padding: 10px; overflow: auto; background: var(--canvas-bg); border: 1px solid var(--border); font: 11px/1.5 var(--font-mono); }
</style>
