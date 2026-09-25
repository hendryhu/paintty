<script lang="ts">
  import Icon from './Icon.svelte';
  import { tick } from 'svelte';
  import { activeChar, addFavourite, favourites } from '../lib/stores.js';
  import { firstGrapheme } from '../lib/glyphInput.js';
  import { createControlledTextHistory } from '../lib/textEditing.js';
  import { CHAR_TABS, charsForTab, codepoint } from '../lib/charTabs.js';
  import { canvasFont } from '../lib/font.js';
  import { nerdGlyphs } from '../lib/nerdglyphs.js';
  import { isTopPopup, popupFocus } from '../lib/popupFocus.js';
  import type { CharacterTab } from '../lib/charTabs.js';
  import type { NerdGlyph } from '../lib/nerdglyphs.js';
  import type {
    CharPickerProps,
    CustomGlyphInputState,
  } from '../lib/types/canvas-components.js';

  let {
    onGlyphMenu = () => {},
    onSketch = () => {},
  }: CharPickerProps = $props();

  let activeTab = $state<string>('fav');
  let sketchBtnEl = $state<HTMLButtonElement | null>(null);
  let customGlyph = $state<string>('');
  let addGlyphEl = $state<HTMLButtonElement | null>(null);
  let customInputEl = $state<HTMLInputElement | null>(null);
  let customOpen = $state<boolean>(false);
  let customPopoverEl = $state<HTMLDialogElement | null>(null);
  let customPosition = $state<{ x: number; y: number }>({ x: 0, y: 0 });
  const customGlyphHistory = createControlledTextHistory();
  let pendingGlyph = $derived<string>(firstGrapheme(customGlyph));

  let nfGroup = $state<string | null>(null);
  let nfSearch = $state<string>('');
  let nfFilterOpen = $state<boolean>(false);
  let nfFilterButton = $state<HTMLButtonElement | null>(null);
  let nfFilterMenuEl = $state<HTMLDivElement | null>(null);
  let nfFilterPosition = $state<{ x: number; y: number }>({ x: 0, y: 0 });
  const NF_PAGE = 300;
  let nfShown = $state<number>(NF_PAGE);

  let currentTabDef = $derived<CharacterTab | undefined>(CHAR_TABS.find((t) => t.id === activeTab));
  let chars = $derived<string[]>((activeTab !== 'nf' && currentTabDef) ? charsForTab(currentTabDef, $favourites) : []);

  let nfAll = $derived<NerdGlyph[]>($nerdGlyphs.ready
    ? (nfGroup ? ($nerdGlyphs.groups.find((g) => g.id === nfGroup)?.glyphs ?? []) : $nerdGlyphs.all)
    : []);
  let nfMatched = $derived<NerdGlyph[]>((() => {
    const q = nfSearch.trim().toLowerCase();
    return q ? nfAll.filter((g) => g.names.some((n) => n.includes(q))) : nfAll;
  })());
  $effect(() => { nfGroup; nfSearch; nfShown = NF_PAGE; });
  let nfFiltered = $derived<NerdGlyph[]>(nfMatched.slice(0, nfShown));

  function onNfScroll(event: Event & { currentTarget: HTMLDivElement }): void {
    const el = event.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60 && nfShown < nfMatched.length) {
      nfShown += NF_PAGE;
    }
  }

  function selectChar(ch: string): void {
    activeChar.set(ch);
    closeCustomGlyph();
  }
  function selectTab(id: string): void {
    activeTab = id;
    if (id !== 'fav') closeCustomGlyph();
    if (id !== 'nf') closeNfFilter();
  }
  async function toggleNfFilter(): Promise<void> {
    if (nfFilterOpen) {
      closeNfFilter();
      return;
    }
    const rect = nfFilterButton?.getBoundingClientRect();
    if (rect) {
      const width = 188;
      const height = Math.min(292, 38 + $nerdGlyphs.groups.length * 28);
      const x = Math.max(4, Math.min(rect.right - width, window.innerWidth - width - 4));
      const below = rect.bottom + 5;
      const y = below + height <= window.innerHeight - 4
        ? below
        : Math.max(4, rect.top - height - 5);
      nfFilterPosition = { x, y };
    }
    nfFilterOpen = true;
    await tick();
  }
  function closeNfFilter(): void {
    nfFilterOpen = false;
  }
  function chooseNfGroup(id: string | null): void {
    nfGroup = id;
    closeNfFilter();
  }
  async function openCustomGlyph(): Promise<void> {
    if (customOpen) {
      closeCustomGlyph();
      return;
    }
    const rect = addGlyphEl?.getBoundingClientRect();
    if (rect) {
      const width = 220;
      const height = 48;
      const x = Math.max(4, Math.min(rect.right - width, window.innerWidth - width - 4));
      const above = rect.top - height - 8;
      const y = above >= 4 ? above : Math.min(rect.bottom + 8, window.innerHeight - height - 4);
      customPosition = { x, y };
    }
    customGlyphHistory.reset();
    customOpen = true;
    await tick();
    customInputEl?.focus();
  }
  function closeCustomGlyph(): void {
    customOpen = false;
    customGlyph = '';
    customGlyphHistory.reset();
  }
  function customGlyphState(): CustomGlyphInputState {
    return {
      value: customGlyph,
      start: customInputEl?.selectionStart ?? customGlyph.length,
      end: customInputEl?.selectionEnd ?? customGlyph.length,
      direction: customInputEl?.selectionDirection || 'none',
    };
  }
  function onCustomGlyphBeforeInput(event: InputEvent): void {
    customGlyphHistory.beforeInput(event, customGlyphState());
  }
  function typeCustomGlyph(event: Event & { currentTarget: HTMLInputElement }): void {
    const next = firstGrapheme(event.currentTarget.value);
    customGlyphHistory.input(next !== customGlyph);
    customGlyph = next;
    if (event.currentTarget.value !== customGlyph) event.currentTarget.value = customGlyph;
  }
  async function restoreCustomGlyph(state: CustomGlyphInputState): Promise<void> {
    if (!customOpen) return;
    customGlyph = state.value;
    await tick();
    if (!customOpen || !customInputEl) return;
    customInputEl.focus({ preventScroll: true });
    customInputEl.setSelectionRange(state.start, state.end, state.direction);
  }
  function saveCustomGlyph(): void {
    if (!pendingGlyph) return;
    addFavourite(pendingGlyph);
    selectChar(pendingGlyph);
    closeCustomGlyph();
  }
  function onCustomGlyphKeydown(event: KeyboardEvent): void {
    if (customGlyphHistory.keydown(event, customGlyphState(), restoreCustomGlyph)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeCustomGlyph();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      saveCustomGlyph();
    }
  }
  function closePopoversOnOutsidePointer(event: PointerEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (customOpen && !target?.closest('.custom-popover') && !target?.closest('.add-glyph')) {
      closeCustomGlyph();
    }
    if (nfFilterOpen && !target?.closest('.nf-filter-menu') && !target?.closest('.nf-filter-button')) {
      closeNfFilter();
    }
  }
  function onWindowKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    const closeFilter = nfFilterOpen && isTopPopup(nfFilterMenuEl);
    const closeCustom = customOpen && isTopPopup(customPopoverEl);
    if (!closeFilter && !closeCustom) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (closeFilter) closeNfFilter();
    else closeCustomGlyph();
  }
  function onContext(event: MouseEvent, ch: string): void {
    event.preventDefault();
    onGlyphMenu({ x: event.clientX, y: event.clientY, ch });
  }
  function openSketch(): void {
    if (!sketchBtnEl) return;
    const rect = sketchBtnEl.getBoundingClientRect();
    onSketch({ top: rect.top });
  }
  function submitCustomGlyph(event: SubmitEvent): void {
    event.preventDefault();
    saveCustomGlyph();
  }
</script>

<svelte:window onpointerdown={closePopoversOnOutsidePointer} onkeydowncapture={onWindowKey} />

<div class="charsect">
  <div class="ui-panel-title section-title">Character</div>

  <div class="char-tabs">
    {#each CHAR_TABS as t}
      <button class:active={activeTab === t.id} onclick={() => selectTab(t.id)}>{t.label}</button>
    {/each}
    <button class="sketch-tab" bind:this={sketchBtnEl} onclick={openSketch}>✎ sketch</button>
  </div>

  {#if activeTab === 'nf'}

    {#if !$nerdGlyphs.ready}
      <div class="nf-status">{$nerdGlyphs.error ? 'Could not load Nerd Font glyph list.' : 'Loading glyphs…'}</div>
    {:else}
      <div class="nf-bar">
        <input class="nf-search" type="text" placeholder="search icons (e.g. arrow, git)" bind:value={nfSearch} />
        <button class="nf-filter-button" class:on={nfGroup !== null} bind:this={nfFilterButton}
          aria-haspopup="menu" aria-expanded={nfFilterOpen} onclick={toggleNfFilter}>Filter</button>
      </div>
      {#if nfFilterOpen}
        <div class="nf-filter-menu scroll" role="menu" tabindex="-1" bind:this={nfFilterMenuEl}
          use:popupFocus={{ initialFocus: nfGroup === null ? '[data-group="all"]' : `[data-group="${nfGroup}"]` }}
          style="left: {nfFilterPosition.x}px; top: {nfFilterPosition.y}px;">
          <button role="menuitemradio" aria-checked={nfGroup === null} data-group="all"
            class:on={nfGroup === null} onclick={() => chooseNfGroup(null)}>All</button>
          {#each $nerdGlyphs.groups as g}
            <button role="menuitemradio" aria-checked={nfGroup === g.id} data-group={g.id}
              class:on={nfGroup === g.id} onclick={() => chooseNfGroup(g.id)}>{g.label}</button>
          {/each}
        </div>
      {/if}
      <div class="char-grid scroll" onscroll={onNfScroll}>
        {#each nfFiltered as g (g.code)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="glyph" class:fav={$favourites.has(g.char)} class:selected={$activeChar === g.char}
            title={`${g.name}  (U+${g.code.toUpperCase()})`} style="font-family: {$canvasFont};"
            onclick={() => selectChar(g.char)} oncontextmenu={(e) => onContext(e, g.char)}
            role="button" tabindex="0">{g.char}</div>
        {/each}
        {#if nfFiltered.length === 0}
          <div class="nf-status">No icons match “{nfSearch}”.</div>
        {/if}
      </div>
    {/if}
  {:else}
    <div class="char-grid scroll" class:favourites-grid={activeTab === 'fav'}>
      {#each chars as ch (ch)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="glyph" class:fav={$favourites.has(ch)} class:selected={$activeChar === ch}
          title={codepoint(ch)} style="font-family: {$canvasFont};"
          onclick={() => selectChar(ch)} oncontextmenu={(e) => onContext(e, ch)}
          role="button" tabindex="0">{ch}</div>
      {/each}
    </div>
  {/if}

  {#if activeTab === 'fav'}
    <button class="add-glyph" bind:this={addGlyphEl} class:open={customOpen} onclick={openCustomGlyph}
      aria-label="Add favourite glyph" aria-expanded={customOpen}
      title={customOpen ? 'Close glyph entry' : 'Add glyph'}>
      <Icon icon="material-symbols:add-rounded" width="18" />
    </button>
    {#if customOpen}
      <dialog open class="custom-popover" style="left: {customPosition.x}px; top: {customPosition.y}px;"
        aria-label="Add favourite glyph" bind:this={customPopoverEl}
        use:popupFocus={{ initialFocus: 'input' }}>
        <form onsubmit={submitCustomGlyph}>
          <input bind:this={customInputEl} aria-label="Favourite glyph" placeholder="Glyph"
            style="font-family: {$canvasFont};" value={customGlyph}
            onbeforeinput={onCustomGlyphBeforeInput} oninput={typeCustomGlyph}
            onkeydown={onCustomGlyphKeydown} />
          <button class="custom-add" type="submit" disabled={!pendingGlyph}>Add</button>
          <button class="custom-close" type="button" onclick={closeCustomGlyph} aria-label="Close">&times;</button>
        </form>
      </dialog>
    {/if}
  {/if}
</div>

<style>
  .charsect {
    display: flex; flex-direction: column; border-bottom: 1px solid var(--border);
    position: relative; overflow: hidden; height: 100%;
  }
  .char-tabs {
    display: flex; flex-wrap: wrap; gap: 2px; padding: 6px;
    background: var(--panel-lo); border-bottom: 1px solid var(--border);
  }
  .char-tabs button {
    font-size: 10px; padding: 3px 6px; background: var(--panel-hi); color: var(--text-dim);
    border: none; border-radius: 3px;
  }
  .char-tabs button:hover { color: var(--text); }
  .char-tabs button.active { background: var(--accent-dim); color: var(--on-accent); }
  .char-tabs button.sketch-tab { margin-left: auto; color: var(--accent); }

  .nf-bar {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px;
    padding: 6px; border-bottom: 1px solid var(--border);
  }
  .nf-search { min-width: 0; width: 100%; font-size: 11px; }
  .nf-filter-button {
    padding: 3px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--panel-hi); color: var(--text-dim); font-size: 10px;
  }
  .nf-filter-button:hover, .nf-filter-button.on { color: var(--text); border-color: var(--accent); }
  .nf-filter-menu {
    position: fixed; z-index: var(--z-popover); display: grid; width: 188px; max-height: 292px;
    overflow-y: auto; padding: 4px; background: var(--panel-hi); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: 0 6px 18px var(--shadow-popover-strong);
  }
  .nf-filter-menu button {
    width: 100%; padding: 6px 8px; border: 0; border-radius: var(--radius-sm);
    background: transparent; color: var(--text); font-size: 11px; text-align: left;
  }
  .nf-filter-menu button:hover { background: var(--accent-wash); }
  .nf-filter-menu button.on { background: var(--accent-dim); color: var(--on-accent); }
  .nf-status { padding: 12px 10px; font-size: 11px; color: var(--text-dim); }

  .char-grid {
    display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; padding: 6px;
    flex: 1; overflow-y: auto; align-content: start; min-height: 72px;
  }
  .char-grid.favourites-grid { padding-bottom: 46px; }
  .glyph {
    aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
    background: var(--glyph-bg); border: 1px solid var(--glyph-border); border-radius: 3px; cursor: pointer;
    font-size: 16px; position: relative;
  }
  .glyph:hover { background: var(--glyph-hover); }
  .glyph.selected { background: var(--accent-dim); color: var(--on-accent); border-color: var(--accent); }
  .glyph.fav::after {
    content: ''; position: absolute; top: 2px; right: 2px;
    width: 4px; height: 4px; border-radius: 50%; background: var(--accent);
  }
  .add-glyph {
    position: absolute; right: 10px; bottom: 10px; z-index: 2;
    width: 28px; height: 28px; border-radius: 50%;
    display: grid; place-items: center; padding: 0;
    border: 1px solid var(--border); background: var(--panel-hi); color: var(--text);
    box-shadow: 0 3px 10px var(--shadow-raised);
  }
  .add-glyph :global(svg) { display: block; }
  .add-glyph:hover, .add-glyph.open { border-color: var(--accent); color: var(--accent); }
  .custom-popover {
    position: fixed; z-index: var(--z-menu);
    display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 6px;
    width: 220px; padding: 9px;
    box-sizing: border-box;
    background: var(--panel-hi); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: 0 5px 16px var(--shadow-popover-strong);
  }
  .custom-popover form { display: contents; }
  .custom-popover input {
    min-width: 0; width: 100%; height: 28px; padding: 3px 7px;
    background: var(--canvas-bg); color: var(--text); border: 1px solid var(--border);
    border-radius: var(--radius-sm); font-size: 16px; user-select: text;
  }
  .custom-popover input:focus { border-color: var(--accent); outline: none; }
  .custom-close {
    width: 28px; height: 28px; padding: 0;
    border: 1px solid var(--border); border-radius: 50%;
    background: var(--panel-hi); color: var(--text-dim); font-size: 16px;
  }
  .custom-close:hover { color: var(--text); border-color: var(--accent-dim); }
  .custom-add {
    padding: 3px 9px; background: var(--accent-dim); color: var(--on-accent);
    border: 1px solid var(--accent-dim); border-radius: var(--radius-sm);
  }
  .custom-add:disabled { opacity: 0.4; cursor: default; }
</style>
