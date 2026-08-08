<script>
  import { tick, untrack } from 'svelte';
  import { favourites, toggleFavourite } from '../lib/stores.js';
  import { codepoint } from '../lib/charTabs.js';
  import { canvasFont } from '../lib/font.js';
  import { isTopPopup, popupFocus } from '../lib/popupFocus.js';

  /**
   * @typedef {Object} Props
   * @property {number} [x]
   * @property {number} [y]
   * @property {string} [ch]
   * @property {any} [onClose]
   */

  /** @type {Props} */
  let {
    x = 0,
    y = 0,
    ch = '',
    onClose = () => {}
  } = $props();


  let menuEl = $state();
  let px = $state(untrack(() => x)), py = $state(untrack(() => y));
  async function reposition() {
    await tick();
    const r = menuEl.getBoundingClientRect();
    px = (x + r.width > window.innerWidth) ? Math.max(4, x - r.width) : x;
    py = (y + r.height > window.innerHeight) ? Math.max(4, y - r.height) : y;
  }

  function act(kind) {
    if (kind === 'fav') toggleFavourite(ch);
    else if (kind === 'copy') navigator.clipboard?.writeText(ch);
    else if (kind === 'copycp') navigator.clipboard?.writeText(cp);
    onClose();
  }
  function onKey(event) {
    if (event.key !== 'Escape' || !isTopPopup(menuEl)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onClose();
  }
  let isFav = $derived($favourites.has(ch));
  let cp = $derived(codepoint(ch));
  $effect(() => {
    if (menuEl && (x || y)) reposition();
  });
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="ctx-menu" bind:this={menuEl} role="menu" tabindex="-1"
  use:popupFocus={{ initialFocus: 'button' }} style="left: {px}px; top: {py}px;">
  <button class="ci" role="menuitem" onclick={() => act('fav')}>
    {isFav ? '★ Remove favourite' : '☆ Add to favourites'}
  </button>
  <button class="ci" role="menuitem" onclick={() => act('copy')}>
    Copy character <span class="k glyph" style="font-family: {$canvasFont};">{ch}</span>
  </button>
  <button class="ci" role="menuitem" onclick={() => act('copycp')}>
    Copy codepoint <span class="k">{cp}</span>
  </button>
</div>

<style>
  .ctx-menu {
    position: fixed; z-index: 60; min-width: 150px;
    background: var(--panel-hi); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: 0 4px 16px var(--shadow-popover); padding: 4px;
  }
  .ci {
    width: 100%; text-align: left; background: transparent; border: none;
    padding: 6px 10px; border-radius: var(--radius-sm); cursor: pointer;
    font: inherit; font-size: 12px; color: var(--text); display: flex; gap: 8px; align-items: center;
  }
  .ci:hover { background: var(--accent-dim); }
  .k { margin-left: auto; color: var(--text-dim); font-size: 10px; font-family: var(--font-mono); }
  .glyph { font-size: 14px; }
</style>
