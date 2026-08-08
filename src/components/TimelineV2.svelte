<script>
  import Icon from './Icon.svelte';
  import { onMount } from 'svelte';
  import ClipTimeline from './ClipTimeline.svelte';
  import {
    durationTicks as effectiveCanonicalDurationTicks,
    playheadTick as canonicalPlayheadTick,
  } from '../lib/clipTimelineState.js';
  import {
    looping,
    onionSkin,
    playing,
    seekTick,
    togglePlay,
  } from '../lib/frames.js';
  import {
    loadTrackHeaderWidth,
    normalizeTimelineTool,
    persistTrackHeaderWidth,
    timelineToolForShortcut,
    timelineTransportStatus,
    timelineZoomForShortcut,
  } from '../lib/timelineUiState.js';
  import {
    isEditingTarget,
    isPlaybackShortcut,
    keyboardContextOwns,
    planSelectionDeselect,
  } from '../lib/timelineKeys.js';
  import { nativeInputOwnsKey } from '../lib/inputPolicy.js';

  /**
   * @typedef {Object} Props
   * @property {boolean} [expanded]
   * @property {() => void} [onToggle]
   */

  /** @type {Props} */
  let { expanded = false, onToggle = () => {} } = $props();
  const MIN_ZOOM = 4;
  const MAX_ZOOM = 48;
  const ONION_LABEL = { off: 'Off', layer: 'Layer', all: 'All' };

  let clipTimeline = $state();
  let pixelsPerTick = $state(14);
  let showFilmstrip = $state(false);
  let tool = $state('select');
  let trackHeaderWidth = $state(176);
  let settingsLoaded = $state(false);

  let transportStatus = $derived(timelineTransportStatus(
    $canonicalPlayheadTick,
    $effectiveCanonicalDurationTicks,
  ));
  let transportDurationTicks = $derived(transportStatus.finalTick + 1);
  $effect(() => {
    if (settingsLoaded) persistTrackHeaderWidth(trackHeaderWidth);
  });

  onMount(() => {
    trackHeaderWidth = loadTrackHeaderWidth();
    settingsLoaded = true;
  });

  function stepTick(delta) {
    seekTick(Math.max(0, Math.min(
      transportDurationTicks - 1,
      $canonicalPlayheadTick + delta,
    )));
  }

  function cycleOnion() {
    onionSkin.update((value) => value === 'off' ? 'layer' : value === 'layer' ? 'all' : 'off');
  }

  function setZoom(value) {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(value) || pixelsPerTick));
    if (clipTimeline) clipTimeline.setZoom(next);
    else pixelsPerTick = next;
  }

  function setTool(value) {
    tool = normalizeTimelineTool(value);
    clipTimeline?.focusTimeline?.();
  }

  function toggleExpanded() {
    if (expanded) clipTimeline?.prepareCollapse?.();
    onToggle();
  }

  function handleHeaderKeydown(event) {
    if (nativeInputOwnsKey(event)) {
      event.stopPropagation();
      return;
    }
    if (isEditingTarget(event.target)) return;
    const contextOwned = keyboardContextOwns('timeline', event);
    if (contextOwned && isPlaybackShortcut(event, false, 'timeline') &&
      (event.code === 'Space' || event.key === ' ')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      togglePlay();
      return;
    }
    const deselect = planSelectionDeselect(event, {
      context: contextOwned ? 'timeline' : null,
    });
    if (deselect.context === 'timeline') {
      event.preventDefault();
      event.stopImmediatePropagation();
      clipTimeline?.deselectTimeline?.();
      return;
    }
    const zoomShortcut = timelineZoomForShortcut(event, pixelsPerTick, {
      contextOwned,
      minimum: MIN_ZOOM,
      maximum: MAX_ZOOM,
    });
    if (zoomShortcut.handled) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setZoom(zoomShortcut.zoom);
      return;
    }
    const shortcutTool = timelineToolForShortcut(event, {
      contextOwned,
      playing: $playing,
    });
    if (!shortcutTool) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setTool(shortcutTool);
  }
</script>

<section class="timeline-v2" class:expanded aria-label="Timeline">
  <header class="timeline-header" data-keyboard-context="timeline" role="toolbar" tabindex="-1"
    aria-label="Timeline controls"
    onkeydown={handleHeaderKeydown}>
    <button class="timeline-title" type="button"
      title={expanded ? 'Collapse timeline' : 'Expand timeline'}
      aria-expanded={expanded} onclick={toggleExpanded}>
      <Icon icon={expanded
        ? 'material-symbols:keyboard-arrow-down'
        : 'material-symbols:keyboard-arrow-up'} />
      <span>Timeline</span>
    </button>

    <span class="header-separator"></span>
    <button class="header-button play" class:stop={$playing} type="button"
      data-keyboard-context="neutral" onclick={togglePlay}
      aria-label={$playing ? 'Stop (K)' : 'Play'} title={$playing ? 'Stop (K)' : 'Play (K)'}>
      <Icon icon={$playing ? 'material-symbols:stop-rounded' : 'material-symbols:play-arrow'} />
    </button>
    <button class="header-button tick-step" type="button" data-keyboard-context="neutral"
      onclick={() => stepTick(-1)}
      disabled={$canonicalPlayheadTick <= 0} aria-label="Previous tick" title="Previous tick (Left arrow)">
      <Icon icon="material-symbols:chevron-left" />
    </button>
    <button class="header-button tick-step" type="button" data-keyboard-context="neutral"
      onclick={() => stepTick(1)}
      disabled={$canonicalPlayheadTick >= transportDurationTicks - 1} aria-label="Next tick" title="Next tick (Right arrow)">
      <Icon icon="material-symbols:chevron-right" />
    </button>
    <output class="timeline-time"
      aria-label={`${transportStatus.label}, zero-based project ticks`}
      title={`${transportStatus.label} (zero-based project ticks)`}>
      Tick {transportStatus.currentTick}<span>/</span>{transportStatus.finalTick}
    </output>

    {#if expanded}
      <div class="timeline-tools" aria-label="Timeline tools">
        <button class="icon-tool-button timeline-tool" class:active={tool === 'select'}
          type="button" aria-label="Select tool" aria-pressed={tool === 'select'}
          title="Select (V)" onclick={() => setTool('select')}>
          <Icon icon="material-symbols:select" />
        </button>
        <button class="icon-tool-button timeline-tool" class:active={tool === 'razor'}
          type="button" aria-label="Razor tool" aria-pressed={tool === 'razor'}
          title="Razor (C)" onclick={() => setTool('razor')}>
          <Icon icon="material-symbols:content-cut" />
        </button>
        <button class="icon-tool-button timeline-tool" class:active={tool === 'tag'}
          type="button" aria-label="Tag tool" aria-pressed={tool === 'tag'}
          title="Tag (T)" disabled={$playing} onclick={() => setTool('tag')}>
          <Icon icon="material-symbols:label-outline" />
        </button>
      </div>
    {/if}

    <span class="header-spacer"></span>
    <button class="header-button toggle" class:on={$looping} type="button" data-keyboard-context="neutral"
      aria-label={`Loop ${$looping ? 'on' : 'off'}`} aria-pressed={$looping}
      title="Toggle loop" onclick={() => looping.update((value) => !value)}>
      <Icon icon="material-symbols:repeat" />
    </button>
    <button class="header-button toggle onion-toggle" class:on={$onionSkin !== 'off'} type="button"
      data-keyboard-context="neutral"
      data-onion-state={$onionSkin} aria-label={`Onion: ${ONION_LABEL[$onionSkin]}`}
      title={`Onion: ${ONION_LABEL[$onionSkin]}`} onclick={cycleOnion}>
      {#if $onionSkin === 'off'}
        <span class="onion-single" data-onion-icon="off"><Icon icon="mdi:ghost-off-outline" /></span>
      {:else if $onionSkin === 'layer'}
        <span class="onion-single" data-onion-icon="layer"><Icon icon="mdi:ghost-outline" /></span>
      {:else}
        <span class="onion-stack" data-onion-icon="all" aria-hidden="true">
          <Icon icon="mdi:ghost-outline" />
          <Icon icon="mdi:ghost-outline" />
        </span>
      {/if}
    </button>
    <button class="header-button toggle thumbnail-toggle" class:on={showFilmstrip} type="button"
      data-keyboard-context="neutral"
      aria-label={`${showFilmstrip ? 'Hide' : 'Show'} frame thumbnails`} aria-pressed={showFilmstrip}
      title={`${showFilmstrip ? 'Hide' : 'Show'} frame thumbnails`} onclick={() => (showFilmstrip = !showFilmstrip)}>
      <Icon icon="mdi:filmstrip-box-multiple" />
    </button>

    <span class="header-separator"></span>
    <span class="zoom-control" data-keyboard-context="neutral"
      title={`Zoom: ${Math.round(pixelsPerTick)} pixels per tick (+/= or -)`}>
      <button class="header-button" type="button" aria-label="Zoom out"
        title="Zoom out (-)"
        disabled={pixelsPerTick <= MIN_ZOOM} onclick={() => setZoom(pixelsPerTick - 2)}>
        <Icon icon="material-symbols:remove" />
      </button>
      <input class="zoom-slider" type="range" min={MIN_ZOOM} max={MAX_ZOOM} step="1"
        value={pixelsPerTick} aria-label="Timeline zoom"
        oninput={(event) => setZoom(event.currentTarget.value)} />
      <button class="header-button" type="button" aria-label="Zoom in"
        title="Zoom in (+ or =)"
        disabled={pixelsPerTick >= MAX_ZOOM} onclick={() => setZoom(pixelsPerTick + 2)}>
        <Icon icon="material-symbols:add" />
      </button>
    </span>
  </header>

  <div class="timeline-content" aria-hidden={!expanded}>
    <ClipTimeline bind:this={clipTimeline} {expanded}
      bind:pixelsPerTick bind:showFilmstrip bind:tool bind:trackHeaderWidth />
  </div>
</section>

<style>
  .timeline-v2 {
    grid-area: timeline;
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    border-top: 1px solid var(--border);
    background: var(--panel);
  }
  .timeline-header {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    height: var(--timeline-h);
    flex: 0 0 var(--timeline-h);
    padding: 0 7px;
    border-bottom: 1px solid transparent;
    background: var(--panel);
  }
  .expanded .timeline-header { border-bottom-color: var(--border); }
  .timeline-title,
  .header-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 26px;
    flex: 0 0 auto;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-dim);
  }
  .timeline-title {
    gap: 3px;
    min-width: 78px;
    padding: 0 6px 0 3px;
    color: var(--accent);
    font-weight: 600;
  }
  .header-button { width: 26px; font-size: 16px; }
  .timeline-title:hover,
  .header-button:hover:not(:disabled),
  .header-button.on {
    border-color: var(--accent-dim);
    background: var(--accent-wash);
  }
  .header-button.on { color: var(--accent); }
  .onion-single { display: contents; }
  .onion-single[data-onion-icon='off'] { opacity: 0.7; }
  .onion-stack { position: relative; display: block; width: 20px; height: 18px; }
  .onion-stack :global(svg) { position: absolute; width: 13px; height: 13px; }
  .onion-stack :global(svg:first-child) { left: 0; top: 5px; opacity: 0.76; }
  .onion-stack :global(svg:last-child) { left: 7px; top: 0; }
  .header-button.play { color: var(--play); font-size: 17px; }
  .header-button.play.stop { color: var(--stop); }
  .header-button:disabled { opacity: 0.3; }
  .header-separator {
    width: 1px;
    height: 17px;
    flex: 0 0 1px;
    margin: 0 2px;
    background: var(--border);
  }
  .timeline-time {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-width: 72px;
    color: var(--text-dim);
    font: 10px var(--font-mono);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .timeline-time span { color: var(--text-faint); }
  .timeline-tools {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-left: 6px;
  }
  .header-spacer { min-width: 0; flex: 1; }
  .zoom-control {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
  }
  .zoom-slider { width: 76px; accent-color: var(--accent); }
  .timeline-content {
    min-width: 0;
    min-height: 0;
    flex: 1;
    overflow: hidden;
  }
  .timeline-content :global(.clip-timeline) { height: 100%; }

  @media (max-width: 900px) {
    .timeline-header { gap: 2px; padding-inline: 4px; }
    .zoom-slider { width: 50px; }
  }

  @media (max-width: 840px) {
    .timeline-header { padding-inline: 2px; }
    .timeline-title { min-width: 26px; width: 26px; padding: 0; }
    .timeline-title span { display: none; }
    .header-button { width: 24px; }
    .timeline-tools { gap: 1px; margin-left: 2px; }
    .header-separator { display: none; }
    .timeline-time { min-width: 43px; gap: 2px; }
    .zoom-slider { display: none; }
  }

  @media (max-width: 640px) {
    .timeline-title { min-width: 30px; width: 30px; padding: 0; }
    .timeline-title span { display: none; }
    .timeline-time,
    .tick-step { display: none; }
  }

  @media (max-width: 560px) {
    .thumbnail-toggle,
    .zoom-control { display: none; }
  }
</style>
