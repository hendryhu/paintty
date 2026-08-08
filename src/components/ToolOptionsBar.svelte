<script>
  import Icon from './Icon.svelte';
  import NumberField from './NumberField.svelte';
  import { activeChar, activeTool, toolOptions } from '../lib/stores.js';
  import { selection, clearSelection, selectMode, moveState, beginMove, beginTransformSelection, finalizeMove, cancelMove, selectionToNewLayer } from '../lib/selection.js';
  import { dims, layers, activeLayerId, activeLayerPart, cropPending, isBackgroundLayer } from '../lib/grid.js';
  import { canvasFont } from '../lib/font.js';
  import { playing } from '../lib/frames.js';
  import { isToolDisabledForLayer } from '../lib/toolAvailability.js';
  import {
    BOX_STYLE_OPTIONS,
    SLOPE_GLYPHS,
    lineStylePatch,
    lineStyleValue,
    maskShapeAppearance,
    updateMaskShapeAppearance,
    updateShapeAppearance,
  } from '../lib/shapes.js';

  const LINE_BOX_STYLE_OPTIONS = BOX_STYLE_OPTIONS.filter((choice) => choice.value !== 'rounded');

  const NAMES = {
    brush: 'Cell brush', eraser: 'Eraser', fill: 'Fill', eyedropper: 'Eyedropper',
    subcell: 'Special brush', line: 'New line', rect: 'New rectangle', circle: 'New circle', polygon: 'New polygon',
    select: 'Select', crop: 'Crop', text: 'Text', move: 'Move',
  };

  function newShapeOptionLabel(tool, option) {
    return `${NAMES[tool] || tool} ${option}`;
  }

  function set(tool, key, value) {
    toolOptions.update((o) => ({
      ...o,
      [tool]: {
        ...o[tool],
        [key]: value,
      },
    }));
  }

  // Keep the text selection alive while changing its wrap setting.
  function preserveEditorFocus(node) {
    const preventFocus = (event) => event.preventDefault();
    node.addEventListener('mousedown', preventFocus);
    return { destroy: () => node.removeEventListener('mousedown', preventFocus) };
  }

  function setShapeChannel(tool, channel) {
    toolOptions.update((all) => {
      const current = all[tool] || {};
      return { ...all, [tool]: updateShapeAppearance(current, { channel }) };
    });
  }

  function setShapeOption(tool, key, value) {
    toolOptions.update((all) => ({
      ...all,
      [tool]: mask
        ? updateMaskShapeAppearance(all[tool] || {}, { [key]: value })
        : updateShapeAppearance(all[tool] || {}, { [key]: value }),
    }));
  }

  function setShapeOptions(tool, patch) {
    toolOptions.update((all) => ({
      ...all,
      [tool]: mask
        ? updateMaskShapeAppearance(all[tool] || {}, patch)
        : updateShapeAppearance(all[tool] || {}, patch),
    }));
  }

  function detailChoices(char) {
    return [
      { value: 'cell', swatch: char, label: 'Active glyph' },
      { value: 'half', swatch: '▀', label: 'Half-cell' },
      { value: 'quarter', swatch: '▚', label: 'Quarter-cell' },
    ];
  }

  function setShapeNumber(tool, key, value, min, max) {
    const number = Math.max(min, Math.min(max, Math.round(Number(value) || min)));
    setShapeOption(tool, key, number);
  }

  function showStrokeControls(options) {
    return options.style !== 'filled' && options.style !== 'special' && options.style !== 'slope';
  }
  let tool = $derived($activeTool);
  let opts = $derived($toolOptions[tool] || {});
  let activeLayer = $derived($layers.find((layer) => layer.id === $activeLayerId));
  let background = $derived(isBackgroundLayer(activeLayer));
  let mask = $derived($activeLayerPart === 'mask' && activeLayer?.type === 'effect');
  let toolUnavailable = $derived(isToolDisabledForLayer(tool, activeLayer, $activeLayerPart));
  let displayShapeOpts = $derived(mask ? maskShapeAppearance(opts) : opts);

  let cropRect = $derived($cropPending || { x: 0, y: 0, w: $dims.w, h: $dims.h });
  let cropW = $derived(cropRect.w);
  let cropH = $derived(cropRect.h);
  function setCropW(v) { const w = Math.max(1, Math.min(256, +v || 1)); cropPending.set({ ...cropRect, w }); }
  function setCropH(v) { const h = Math.max(1, Math.min(256, +v || 1)); cropPending.set({ ...cropRect, h }); }
  function applyCrop() { if (!$playing) window.dispatchEvent(new CustomEvent('apply-crop')); }
  function cancelCrop() { window.dispatchEvent(new CustomEvent('cancel-crop')); }
</script>

<div class="optbar">
  <span class="tool-name">{NAMES[tool] || tool}</span>

  {#if toolUnavailable}
    <span class="lbl">{mask ? 'Unavailable for effect masks' : 'Unavailable for this layer'}</span>
  {:else if mask && tool === 'brush'}
    <span class="lbl">Paint effect strength</span>
  {:else if mask && tool === 'eraser'}
    <span class="lbl">Erase effect</span>
  {:else if mask && tool === 'fill'}
    <label class="chk"><input type="checkbox" checked={opts.contiguous}
      onchange={(e) => set(tool, 'contiguous', e.target.checked)} /> contiguous</label>
  {:else if mask && tool === 'eyedropper'}
    <span class="lbl">Pick effect strength</span>
  {:else if tool === 'brush'}
    <span class="lbl">{background ? 'Paint background' : 'Paint glyph'}</span>

  {:else if tool === 'eraser'}
    <span class="lbl">{background ? 'Erase background color' : 'Erase glyph'}</span>

  {:else if tool === 'fill'}
    {#if !background}
      <div class="grp"><span class="lbl">resolution</span>
        <div class="seg">
          {#each [['cell','whole'],['half','half'],['quarter','quarter']] as [val, label]}
            <button class:on={opts.resolution === val} onclick={() => set(tool, 'resolution', val)}>{label}</button>
          {/each}
        </div>
      </div>
    {/if}

    <label class="chk"><input type="checkbox" checked={opts.contiguous}
      onchange={(e) => set(tool, 'contiguous', e.target.checked)} /> contiguous</label>

    <label class="chk"><input type="checkbox" checked={opts.sampleAll}
      onchange={(e) => set(tool, 'sampleAll', e.target.checked)} /> sample all layers</label>

  {:else if tool === 'eyedropper'}
    {#if background}
      <span class="lbl">Pick background color</span>
    {:else}
      <div class="grp"><span class="lbl">pick</span>
        <div class="seg">
          {#each [['char','char'],['color','color'],['both','char + color']] as [val, label]}
            <button class:on={opts.pick === val} onclick={() => set(tool, 'pick', val)}>{label}</button>
          {/each}
        </div>
      </div>
    {/if}

  {:else if tool === 'subcell'}
    <div class="grp"><span class="lbl">mode</span>
      <div class="seg pictographic">
        {#each [
          { value: 'half', swatch: '▀', label: 'Half-cell' },
          { value: 'quarter', swatch: '▚', label: 'Quarter-cell' },
          ...BOX_STYLE_OPTIONS,
        ] as choice}
          <button class="glyph-choice" class:on={(opts.mode || opts.resolution || 'half') === choice.value}
            title={choice.label} aria-label={choice.label}
            onclick={() => set(tool, 'mode', choice.value)}>{choice.swatch}</button>
        {/each}
      </div>
    </div>

  {:else if tool === 'rect' || tool === 'circle' || tool === 'polygon'}
    {#if !mask && tool !== 'polygon'}
      <div class="grp" aria-label={newShapeOptionLabel(tool, 'channel')}><span class="lbl">channel</span>
        <div class="seg">
          {#each [['glyph','glyph'],['background','background']] as [val, label]}
            <button class:on={opts.channel === val} onclick={() => setShapeChannel(tool, val)}>{label}</button>
          {/each}
        </div>
      </div>
    {/if}
    <div class="grp" aria-label={newShapeOptionLabel(tool, 'style')}><span class="lbl">style</span>
      <div class="seg">
        {#each tool !== 'polygon' && !mask && opts.channel !== 'background' ? [['outline','outline'],['filled','filled'],['special','special']] : [['outline','outline'],['filled','filled']] as [val, label]}
          <button class:on={displayShapeOpts.style === val} onclick={() => setShapeOption(tool, 'style', val)}>{label}</button>
        {/each}
      </div>
    </div>
    {#if tool !== 'polygon' && !mask && opts.style === 'special' && opts.channel === 'glyph'}
      <div class="grp"><span class="lbl">border</span>
        <div class="seg pictographic">
          {#each BOX_STYLE_OPTIONS as choice}
            <button class="glyph-choice" class:on={(opts.boxStyle || 'single') === choice.value}
              title={choice.label} aria-label={choice.label}
              onclick={() => setShapeOption(tool, 'boxStyle', choice.value)}>{choice.swatch}</button>
          {/each}
        </div>
      </div>
    {/if}
    {#if !mask && (tool === 'polygon' || opts.channel === 'glyph') && opts.style !== 'special'}
      <div class="grp"><span class="lbl">detail</span>
        <div class="seg pictographic">
          {#each detailChoices($activeChar) as choice}
            <button class="glyph-choice canvas-glyph" class:on={(opts.detail || 'cell') === choice.value}
              style="font-family: {$canvasFont};" title={choice.label} aria-label={choice.label}
              onclick={() => setShapeOption(tool, 'detail', choice.value)}>{choice.swatch}</button>
          {/each}
        </div>
      </div>
    {/if}
    {#if tool === 'polygon'}
      <div class="grp" aria-label={newShapeOptionLabel(tool, 'sides')}><span class="lbl">sides</span>
        <NumberField ariaLabel={newShapeOptionLabel(tool, 'sides')} min={3} max={64} value={displayShapeOpts.sides || 5}
          onInput={(detail) => setShapeNumber(tool, 'sides', detail.value, 3, 64)} />
      </div>
    {/if}
    {#if showStrokeControls(displayShapeOpts)}
      <div class="grp" aria-label={newShapeOptionLabel(tool, 'thickness')}><span class="lbl">thickness</span>
        <NumberField ariaLabel={newShapeOptionLabel(tool, 'thickness')} min={1} max={64} value={displayShapeOpts.thickness || 1}
          onInput={(detail) => setShapeNumber(tool, 'thickness', detail.value, 1, 64)} />
      </div>
      <div class="grp" aria-label={newShapeOptionLabel(tool, 'stroke alignment')}><span class="lbl">stroke</span>
        <div class="seg">
          {#each [['center','middle'],['inside','inwards'],['outside','outwards']] as [val, label]}
            <button class:on={(displayShapeOpts.strokeAlign || 'center') === val}
              onclick={() => setShapeOption(tool, 'strokeAlign', val)}>{label}</button>
          {/each}
        </div>
      </div>
    {/if}

  {:else if tool === 'line'}
    {#if !mask}
      <div class="grp" aria-label={newShapeOptionLabel(tool, 'channel')}><span class="lbl">channel</span>
        <div class="seg">
          {#each [['glyph','glyph'],['background','background']] as [val, label]}
            <button class:on={opts.channel === val} onclick={() => setShapeChannel(tool, val)}>{label}</button>
          {/each}
        </div>
      </div>
      {#if opts.channel === 'glyph'}
        <div class="grp" aria-label={newShapeOptionLabel(tool, 'style')}><span class="lbl">style</span>
          <div class="seg pictographic">
            {#each detailChoices($activeChar) as choice}
              <button class="glyph-choice canvas-glyph" class:on={lineStyleValue(opts) === choice.value}
                style="font-family: {$canvasFont};" title={choice.label} aria-label={choice.label}
                onclick={() => setShapeOptions(tool, lineStylePatch(choice.value))}>{choice.swatch}</button>
            {/each}
            {#each LINE_BOX_STYLE_OPTIONS as choice}
              <button class="glyph-choice" class:on={lineStyleValue(opts) === `special:${choice.value}`}
                title={choice.label + ' orthogonal'} aria-label={choice.label + ' orthogonal'}
                onclick={() => setShapeOptions(tool, lineStylePatch(`special:${choice.value}`))}>{choice.swatch}</button>
            {/each}
            <button class="glyph-choice canvas-glyph" class:on={opts.style === 'slope'}
              style="font-family: {$canvasFont};" title="Diagonal triangles" aria-label="Diagonal triangles"
              onclick={() => setShapeOptions(tool, lineStylePatch('slope'))}>{SLOPE_GLYPHS.rising.join('')}</button>
          </div>
        </div>
      {/if}
    {/if}
    {#if showStrokeControls(displayShapeOpts)}
      <div class="grp" aria-label={newShapeOptionLabel(tool, 'thickness')}><span class="lbl">thickness</span>
        <NumberField ariaLabel={newShapeOptionLabel(tool, 'thickness')} min={1} max={64} value={displayShapeOpts.thickness || 1}
          onInput={(detail) => setShapeNumber(tool, 'thickness', detail.value, 1, 64)} />
      </div>
      <div class="grp" aria-label={newShapeOptionLabel(tool, 'stroke alignment')}><span class="lbl">stroke</span>
        <div class="seg">
          {#each [['center','middle'],['inside','inwards'],['outside','outwards']] as [val, label]}
            <button class:on={(displayShapeOpts.strokeAlign || 'center') === val}
              onclick={() => setShapeOption(tool, 'strokeAlign', val)}>{label}</button>
          {/each}
        </div>
      </div>
    {/if}

  {:else if tool === 'select'}
    {#if $moveState}
      <span class="lbl">{$moveState.mode === 'transform' ? 'Transforming selection' : 'Moving selection'}</span>
      <button class="primary" onclick={finalizeMove}><Icon icon="material-symbols:check" /> Apply</button>
      <button class="ghost" onclick={cancelMove}><Icon icon="material-symbols:close" /> Cancel</button>
    {:else}
      <div class="grp"><span class="lbl">shape</span>
        <div class="seg">
          {#each [['rectangle','rectangle'],['lasso','lasso']] as [val, label]}
            <button class:on={opts.shape === val} onclick={() => set(tool, 'shape', val)}>{label}</button>
          {/each}
        </div>
      </div>
      <div class="grp"><span class="lbl">mode</span>
        <div class="seg">
          <button class:on={$selectMode === 'new'} onclick={() => selectMode.set('new')} title="Replace">new</button>
          <button class:on={$selectMode === 'add'} onclick={() => selectMode.set('add')} title="Add (Shift)">＋</button>
          <button class:on={$selectMode === 'sub'} onclick={() => selectMode.set('sub')} title="Subtract (Alt)">−</button>
        </div>
      </div>
      <button class="ghost" disabled={$playing || !$selection.size} onclick={beginTransformSelection}><Icon icon="material-symbols:transform" /> Transform</button>
      <button class="ghost" disabled={$playing || !$selection.size} onclick={beginMove}><Icon icon="material-symbols:open-with" /> Move</button>
      {#if !mask}
        <button class="ghost" disabled={$playing || !$selection.size} onclick={() => selectionToNewLayer(false)}>New layer via copy</button>
        <button class="ghost" disabled={$playing || !$selection.size} onclick={() => selectionToNewLayer(true)}>New layer via cut</button>
      {/if}
      <button class="ghost" disabled={!$selection.size} onclick={clearSelection}>Deselect</button>
    {/if}

  {:else if tool === 'move'}
    {#if $moveState}
      <span class="lbl">{$moveState.mode === 'transform' ? 'Transforming selection' : 'Moving selection'}</span>
      <button class="primary" onclick={finalizeMove}><Icon icon="material-symbols:check" /> Apply</button>
      <button class="ghost" onclick={cancelMove}><Icon icon="material-symbols:close" /> Cancel</button>
    {:else}
      <span class="lbl">{$selection.size ? 'Move selection' : 'Move layer'}</span>
    {/if}

  {:else if tool === 'crop'}
    <div class="grp"><span class="lbl">W</span>
      <NumberField ariaLabel="Crop width" min={1} max={256} value={cropW} disabled={$playing} onInput={(detail) => setCropW(detail.value)} />
    </div>
    <div class="grp"><span class="lbl">H</span>
      <NumberField ariaLabel="Crop height" min={1} max={256} value={cropH} disabled={$playing} onInput={(detail) => setCropH(detail.value)} />
    </div>
    <button class="primary" disabled={$playing} onclick={applyCrop}><Icon icon="material-symbols:check" /> Apply</button>
    <button class="ghost" onclick={cancelCrop}><Icon icon="material-symbols:close" /> Cancel</button>

  {:else if tool === 'text'}
    <label class="chk" use:preserveEditorFocus><input type="checkbox" checked={opts.wrap}
      onchange={(e) => set(tool, 'wrap', e.target.checked)} /> wrap in box</label>
  {/if}
</div>

<style>
  .optbar {
    grid-area: optbar; display: flex; align-items: center; gap: 12px;
    padding: 0 12px; background: var(--panel-lo); border-bottom: 1px solid var(--border);
    font-size: 12px; color: var(--text-dim); overflow-x: auto; white-space: nowrap;
  }
  .optbar > :global(*) { flex-shrink: 0; }
  .tool-name { color: var(--accent); font-weight: bold; width: 120px; flex-shrink: 0; }
  .grp { display: flex; align-items: center; gap: 6px; }
  .lbl { color: var(--text-dim); }
  .seg { display: flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .seg button {
    background: var(--panel); color: var(--text-dim); border: none;
    padding: 3px 9px; border-right: 1px solid var(--border);
  }
  .seg button:last-child { border-right: none; }
  .seg button.on { background: var(--accent-dim); color: var(--on-accent); }
  .seg.pictographic .glyph-choice {
    min-width: 34px; height: 24px; padding: 1px 6px;
    font-family: var(--font-mono); font-size: 15px; line-height: 1;
  }
  .chk { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  button.primary, button.ghost {
    display: flex; align-items: center; gap: 4px; padding: 3px 10px;
    border-radius: var(--radius-sm); font-size: 12px; border: 1px solid var(--border);
  }
  button.primary { background: var(--accent-dim); color: var(--on-accent); border-color: var(--accent-dim); }
  button.ghost { background: var(--panel); color: var(--text); }
  button.primary:disabled, button.ghost:disabled { opacity: 0.4; cursor: default; }
  .optbar :global(.number-field) { width: 52px; }
</style>
