<script>
  import { onDestroy, onMount } from 'svelte';
  import { activeChar } from '../lib/stores.js';
  import { canvasFont } from '../lib/font.js';
  import { codepoint } from '../lib/charTabs.js';
  import { matchGlyphsAsync, rasterizeSketchStrokes } from '../lib/sketchMatch.js';
  import { isTopPopup, popupFocus } from '../lib/popupFocus.js';

  /**
   * @typedef {Object} Props
   * @property {number} [top]
   * @property {number} [rightPanelLeft]
   * @property {(detail: { x: number, y: number, ch: string }) => void} [onGlyphMenu]
   * @property {() => void} [onClose]
   */

  /** @type {Props} */
  let {
    top = 100,
    rightPanelLeft = 0,
    onGlyphMenu = () => {},
    onClose = () => {},
  } = $props();
  const WIDTH = 190;
  const BOX_W = 84, BOX_H = 168;

  let canvasEl = $state();
  let panelEl = $state();
  let ctx;
  let drawing = false;
  let pointerId = null;
  let results = $state([]);
  let matching = $state(false);
  let matchComplete = $state(false);
  let matchRevision = 0;
  let strokes = [];
  let currentStroke = null;

  let left = $derived(rightPanelLeft - WIDTH - 8);

  onMount(() => {
    ctx = canvasEl.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, BOX_W, BOX_H);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  });

  function pos(e) {
    const r = canvasEl.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (BOX_W / r.width), y: (e.clientY - r.top) * (BOX_H / r.height) };
  }
  function down(e) {
    if (e.button !== 0 || drawing) return;
    e.preventDefault();
    drawing = true;
    pointerId = e.pointerId;
    canvasEl.setPointerCapture?.(pointerId);
    const p = pos(e);
    currentStroke = [p];
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }
  function move(e) {
    if (!drawing || (e.pointerId != null && e.pointerId !== pointerId)) return;
    const p = pos(e);
    const previous = currentStroke?.at(-1);
    if (!previous || Math.hypot(p.x - previous.x, p.y - previous.y) < 0.35) return;
    currentStroke.push(p);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  function up(e) {
    if (!drawing || (e?.pointerId != null && e.pointerId !== pointerId)) return;
    const captured = pointerId;
    drawing = false;
    pointerId = null;
    if (captured != null && canvasEl.hasPointerCapture?.(captured)) {
      canvasEl.releasePointerCapture(captured);
    }
    if (currentStroke?.length) strokes = [...strokes, currentStroke];
    currentStroke = null;
    recompute();
  }

  async function recompute() {
    const revision = ++matchRevision;
    const bitmap = rasterizeSketchStrokes(strokes, {
      sourceWidth: BOX_W,
      sourceHeight: BOX_H,
      lineWidth: 6,
    });
    if (!bitmap) {
      results = [];
      matching = false;
      matchComplete = false;
      return;
    }
    matching = true;
    matchComplete = false;
    try {
      const matches = await matchGlyphsAsync(bitmap, 9);
      if (revision !== matchRevision) return;
      results = matches;
      matchComplete = true;
    } catch {
      if (revision !== matchRevision) return;
      results = [];
      matchComplete = true;
    } finally {
      if (revision === matchRevision) matching = false;
    }
  }

  function clear() {
    matchRevision++;
    matching = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, BOX_W, BOX_H);
    results = [];
    strokes = [];
    currentStroke = null;
    matchComplete = false;
  }

  function choose(ch) { activeChar.set(ch); }
  function onContext(e, ch) { e.preventDefault(); onGlyphMenu({ x: e.clientX, y: e.clientY, ch }); }
  function onKey(event) {
    if (event.key !== 'Escape' || !isTopPopup(panelEl)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onClose();
  }
  onDestroy(() => { matchRevision++; });
</script>

<svelte:window onblur={up} onkeydowncapture={onKey} />

<div class="sketch-panel" role="dialog" aria-label="Sketch glyph" tabindex="-1"
  bind:this={panelEl} use:popupFocus={{ initialFocus: '.close' }}
  style="top: {top}px; left: {left}px; width: {WIDTH}px;">
  <div class="sketch-head">
    <span>sketch</span>
    <button class="close" title="Close" aria-label="Close"
      onclick={onClose}>&times;</button>
  </div>
  <canvas
    bind:this={canvasEl}
    class="sketch-box"
    width={BOX_W} height={BOX_H}
    onpointerdown={down} onpointermove={move} onpointerup={up}
    onpointercancel={up} onlostpointercapture={up}
  ></canvas>
  <button class="clear" onclick={clear}>clear</button>
  <div class="sketch-results">
    {#each results as ch}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="glyph" style="font-family: {$canvasFont};" title={codepoint(ch)} onclick={() => choose(ch)} oncontextmenu={(e) => onContext(e, ch)} role="button" tabindex="0">{ch}</div>
    {/each}
    {#if results.length === 0}
      <div class="empty">{matching ? 'matching…' : matchComplete ? 'no matches' : 'draw a shape above'}</div>
    {/if}
  </div>
</div>

<style>
  .sketch-panel {
    position: fixed; z-index: 40; padding: 10px;
    background: var(--panel-hi); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: -4px 4px 16px var(--shadow-panel);
  }
  .sketch-head {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px;
    color: var(--text-dim); margin-bottom: 6px;
  }
  .sketch-head .close {
    width: 24px; height: 24px; padding: 0; font-size: 15px; line-height: 1;
    background: var(--panel); color: var(--text-dim); border: 1px solid var(--border); border-radius: 3px;
  }
  .sketch-head .close:hover { color: var(--text); }
  .sketch-box {
    width: 84px; height: 168px; border: 1px dashed var(--accent-dim); border-radius: var(--radius-sm);
    display: block; margin: 0 auto 6px; cursor: crosshair; touch-action: none; background: var(--pure-black);
  }
  .clear {
    display: block; margin: 0 auto 10px; padding: 3px 12px; font-size: 11px;
    background: var(--panel); color: var(--text-dim); border: 1px solid var(--border); border-radius: var(--radius-sm);
  }
  .clear:hover { color: var(--text); }
  .sketch-results { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; min-height: 30px; }
  .glyph {
    aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
    background: var(--glyph-bg); border: 1px solid var(--glyph-border); border-radius: 3px; cursor: pointer;
    font-size: 16px;
  }
  .glyph:hover { background: var(--glyph-hover); }
  .empty { grid-column: 1 / -1; text-align: center; color: var(--text-dim); font-size: 10px; padding: 8px 0; }
</style>
