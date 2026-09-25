<script lang="ts">
  import Icon from './Icon.svelte';
  import NumberField from './NumberField.svelte';
  import ShapeProperties from './ShapeProperties.svelte';
  import {
    layers, activeLayerId, activeLayerPart, dims, setEffectProperties, setEffectMaskOpacity,
    setContentMaskOffsetDirect, setEffectMaskOffsetDirect, updateTextLayer,
    beginStroke, endStroke, cancelStroke, noteAuthoredMutation,
  } from '../lib/grid.js';
  import {
    frames, activeFrameIndex, playing, setLayerOffsetById, hasPosKey, setPosKey,
    togglePosKey, anyPosKeys, clearPosKeys,
    isVisibilityTrackEnabled, visibilityAt, hasVisibilityKey, setVisibilityTrackEnabled,
    setVisibilityKey, toggleVisibilityKey,
    isEffectIntensityTrackEnabled, hasEffectIntensityKey,
    setEffectIntensityTrackEnabled, setEffectIntensityKey, toggleEffectIntensityKey,
    isEffectColorTrackEnabled, hasEffectColorKey, setEffectColorTrackEnabled,
    setEffectColorKey, toggleEffectColorKey, effectColorAt,
    isMaskOpacityTrackEnabled, hasMaskOpacityKey, setMaskOpacityTrackEnabled,
    setMaskOpacityKey, toggleMaskOpacityKey,
    isMaskPositionTrackEnabled, hasMaskPositionKey, setMaskPositionTrackEnabled,
    setMaskPositionById, toggleMaskPositionKey,
  } from '../lib/frames.js';
  import { planTimelinePositionEdit, timelinePositionEditor } from '../lib/layerPosition.js';
  import { colorEditSession } from '../lib/colorEditSession.js';
  import { cutTextToBox, renderTextToCells, textOverflowsBox } from '../lib/textLayer.js';
  import {
    textColorStateForSelection,
    textSelection,
    textSelectionForLayer,
    type EditorTextSelection,
  } from '../lib/textEditing.js';
  import type { EditorEffect } from '../lib/types/editor-domain.js';

  interface NumberFieldDetail {
    value: number;
    source: 'drag' | 'keyboard' | 'typing';
  }

  const PICKER_W = 292;
  const PICKER_H = 340;
  let pendingTextSelection: EditorTextSelection | null = null;

  let activeLayer = $derived($layers.find((layer) => layer.id === $activeLayerId));
  let effectLayer = $derived(activeLayer?.type === 'effect' ? activeLayer : null);
  let shapeLayer = $derived(activeLayer?.type === 'shape' ? activeLayer : null);
  let textLayer = $derived(activeLayer?.type === 'text' ? activeLayer : null);
  let selectedText = $derived(textSelectionForLayer($textSelection, textLayer?.id));
  let sessionTextSelection = $derived($colorEditSession.target?.kind === 'text' &&
    $colorEditSession.target.layerId === textLayer?.id
      ? $colorEditSession.target.selection
      : null);
  let colorSelection = $derived(sessionTextSelection || selectedText);
  let textColorState = $derived(textColorStateForSelection(textLayer, colorSelection));
  let textColor = $derived(textColorState.color);
  let textColorMixed = $derived(textColorState.mixed);
  let textHasOverflow = $derived(textLayer ? textOverflowsBox(textLayer.text, textLayer.box, textLayer.wrap) : false);
  let effect = $derived(effectLayer?.effect || null);
  let editingEffectMask = $derived(!!effect && $activeLayerPart === 'mask');
  let editingContentMask = $derived(!!activeLayer?.contentMask && $activeLayerPart === 'content-mask');
  let editingMask = $derived(editingEffectMask || editingContentMask);
  let hasEditableProperties = $derived(!!activeLayer);
  let positionAnimated = $derived.by(() => {
    $frames;
    return activeLayer && !editingMask ? anyPosKeys(activeLayer.id) : false;
  });
  let positionKeyed = $derived.by(() => {
    $frames;
    return activeLayer && !editingMask ? hasPosKey(activeLayer.id, $activeFrameIndex) : false;
  });
  let positionEditor = $derived(timelinePositionEditor(
    $layers, editingMask ? null : activeLayer, positionAnimated, $dims,
  ));
  let positionOffset = $derived(positionEditor.value);
  let visibilityAnimated = $derived.by(() => {
    $frames;
    return activeLayer && !editingMask ? isVisibilityTrackEnabled(activeLayer.id) : false;
  });
  let visibilityKeyed = $derived.by(() => {
    $frames;
    return activeLayer && !editingMask ? hasVisibilityKey(activeLayer.id, $activeFrameIndex) : false;
  });
  let visibleHere = $derived.by(() => {
    $frames;
    return activeLayer && !editingMask ? visibilityAt(activeLayer.id, $activeFrameIndex) : false;
  });
  let intensityAnimated = $derived.by(() => {
    $frames;
    return activeLayer ? isEffectIntensityTrackEnabled(activeLayer.id) : false;
  });
  let intensityKeyed = $derived.by(() => {
    $frames;
    return activeLayer ? hasEffectIntensityKey(activeLayer.id, $activeFrameIndex) : false;
  });
  let effectColorAnimated = $derived.by(() => {
    $frames;
    return activeLayer ? isEffectColorTrackEnabled(activeLayer.id) : false;
  });
  let effectColorKeyed = $derived.by(() => {
    $frames;
    return activeLayer ? hasEffectColorKey(activeLayer.id, $activeFrameIndex) : false;
  });
  let effectColorValue = $derived.by(() => {
    $frames;
    return activeLayer?.type === 'effect' && activeLayer.effect?.kind === 'solid-color'
      ? effectColorAt(activeLayer.id, $activeFrameIndex)
      : '#ffffff';
  });
  let isSolidColor = $derived(!!effect && effect.kind === 'solid-color');
  let isColorClip = $derived(!!effect && effect.kind === 'color-clip');
  let maskOpacityAnimated = $derived.by(() => {
    $frames;
    return activeLayer ? isMaskOpacityTrackEnabled(activeLayer.id) : false;
  });
  let maskOpacityKeyed = $derived.by(() => {
    $frames;
    return activeLayer ? hasMaskOpacityKey(activeLayer.id, $activeFrameIndex) : false;
  });
  let maskPositionAnimated = $derived.by(() => {
    $frames;
    return activeLayer ? isMaskPositionTrackEnabled(activeLayer.id) : false;
  });
  let maskPositionKeyed = $derived.by(() => {
    $frames;
    return activeLayer ? hasMaskPositionKey(activeLayer.id, $activeFrameIndex) : false;
  });
  let maskOffset = $derived(editingEffectMask
    ? activeLayer?.type === 'effect' ? activeLayer.mask?.offset || { x: 0, y: 0 } : { x: 0, y: 0 }
    : editingContentMask
      ? activeLayer?.contentMask?.offset || { x: 0, y: 0 }
      : { x: 0, y: 0 });

  function pickerAnchor(event: Event): { x: number; y: number } {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return { x: 4, y: 4 };
    const rect = target.getBoundingClientRect();
    const maxX = Math.max(4, window.innerWidth - PICKER_W - 4);
    const maxY = Math.max(4, window.innerHeight - PICKER_H - 4);
    let x = rect.left - PICKER_W - 10;
    if (x < 4) x = rect.right + 10;
    x = Math.max(4, Math.min(x, maxX));
    const y = Math.max(4, Math.min(rect.top, maxY));
    return { x, y };
  }

  // Snapshot the text range before the color control takes focus.
  function captureTextColorSelection() {
    pendingTextSelection = textSelectionForLayer($textSelection, textLayer?.id);
  }

  function normalizedHex(value: string): string | null {
    const raw = value.trim();
    const hex = raw.startsWith('#') ? raw : `#${raw}`;
    return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : null;
  }

  function openTextPicker(event: MouseEvent): void {
    if (!textLayer) return;
    const selection = pendingTextSelection ?? textSelectionForLayer($textSelection, textLayer.id);
    pendingTextSelection = null;
    event.stopPropagation();
    colorEditSession.open(
      { kind: 'text', layerId: textLayer.id, selection },
      pickerAnchor(event),
    );
  }

  function updateTextColor(event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const value = normalizedHex(input.value);
    if (!value || !textLayer) return;
    const target = $colorEditSession.target;
    if (target?.kind !== 'text' || target.layerId !== textLayer.id) {
      colorEditSession.open(
        { kind: 'text', layerId: textLayer.id, selection: colorSelection },
        pickerAnchor(event),
      );
    }
    colorEditSession.preview(value);
    colorEditSession.commit(value);
  }

  function resetInvalidTextColor(event: Event): void {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    if (!normalizedHex(input.value)) {
      input.value = textColorMixed ? '' : textColor;
    }
  }

  function cutTextOverflow() {
    if (!textLayer || !textHasOverflow) return;
    const cut = cutTextToBox(
      textLayer.text,
      textLayer.box,
      textLayer.wrap,
      textLayer.runs || [],
      textLayer.fg,
    );
    if (cut.text === textLayer.text && JSON.stringify(cut.runs) === JSON.stringify(textLayer.runs || [])) return;
    beginStroke();
    updateTextLayer(textLayer.id, cut, renderTextToCells);
    endStroke();
    textSelection.update((selection) => selection?.layerId === textLayer.id
      ? { ...selection, start: Math.min(selection.start, cut.text.length), end: Math.min(selection.end, cut.text.length) }
      : selection);
  }

  function updateEffect(patch: Partial<EditorEffect>): void {
    if (effect && activeLayer?.type === 'effect') setEffectProperties(activeLayer.id, patch);
  }

  function updateEffectKind(event: Event): void {
    const select = event.currentTarget;
    if (!(select instanceof HTMLSelectElement)) return;
    const kind = select.value;
    if (kind === 'brightness' || kind === 'contrast' || kind === 'saturation' || kind === 'hue') {
      updateEffect({ kind });
    } else if (kind === 'solid-color') {
      if (effect?.kind === 'solid-color') return;
      const color = '#ffffff';
      const intensity = 1;
      updateEffect({ kind: 'solid-color', color, intensity } as Partial<EditorEffect>);
    }
  }

  function updateEffectColorValue(hex: string): void {
    if (!activeLayer || activeLayer.type !== 'effect') return;
    if (effectColorAnimated) setEffectColorKey(activeLayer.id, $activeFrameIndex, hex);
    else updateEffect({ kind: 'solid-color', color: hex } as Partial<EditorEffect>);
  }

  function openEffectColorPicker(event: MouseEvent): void {
    if (!activeLayer || activeLayer.type !== 'effect') return;
    event.stopPropagation();
    const target = $colorEditSession.target;
    if (target?.kind !== 'effect' || target.layerId !== activeLayer.id) {
      colorEditSession.open({ kind: 'effect', layerId: activeLayer.id }, pickerAnchor(event));
    }
  }

  function toggleEffectColorAnimation() {
    if (!activeLayer) return;
    setEffectColorTrackEnabled(activeLayer.id, !effectColorAnimated);
  }

  function toggleEffectColorKeyHere() {
    if (activeLayer) toggleEffectColorKey(activeLayer.id, $activeFrameIndex);
  }

  function togglePositionAnimation() {
    if (!activeLayer || editingMask) return;
    if (!positionAnimated) togglePosKey(activeLayer.id, $activeFrameIndex);
    else clearPosKeys(activeLayer.id);
  }

  function togglePositionKey() {
    if (activeLayer && !editingMask) {
      setPosKey(activeLayer.id, $activeFrameIndex, !positionKeyed);
    }
  }

  function setPosition(axis: 'x' | 'y', value: number): void {
    if (!activeLayer || editingMask) return;
    const edit = planTimelinePositionEdit(
      $layers,
      activeLayer.id,
      positionAnimated,
      { ...positionOffset, [axis]: Number(value) },
      $dims,
    );
    if (edit?.mode === 'raster-transform' && edit.items) {
      layers.set(edit.items);
      noteAuthoredMutation();
    } else if (edit?.mode === 'offset-track') {
      setLayerOffsetById($activeFrameIndex, activeLayer.id, edit.value);
    }
  }

  function updatePosition(axis: 'x' | 'y', detail: NumberFieldDetail): void {
    const dragging = detail.source === 'drag';
    if (!dragging) beginStroke();
    setPosition(axis, detail.value);
    if (!dragging) endStroke();
  }

  function toggleVisibilityAnimation() {
    if (activeLayer && !editingMask) {
      setVisibilityTrackEnabled(activeLayer.id, !visibilityAnimated);
    }
  }

  function toggleVisibilityKeyHere() {
    if (activeLayer && !editingMask) {
      toggleVisibilityKey(activeLayer.id, $activeFrameIndex);
    }
  }

  function toggleVisibilityValue() {
    if (activeLayer && !editingMask) {
      setVisibilityKey(activeLayer.id, $activeFrameIndex, !visibleHere);
    }
  }

  function updateIntensity(detail: NumberFieldDetail): void {
    if (activeLayer?.type !== 'effect') return;
    const min = (isSolidColor || isColorClip) ? 0 : -100;
    const max = 100;
    const value = Math.max(min, Math.min(max, detail.value)) / 100;
    if (intensityAnimated) setEffectIntensityKey(activeLayer.id, $activeFrameIndex, value);
    else updateEffect({ intensity: value });
  }

  function updateMaskOpacity(detail: NumberFieldDetail): void {
    if (activeLayer?.type !== 'effect') return;
    const value = detail.value / 100;
    if (maskOpacityAnimated) setMaskOpacityKey(activeLayer.id, $activeFrameIndex, value);
    else setEffectMaskOpacity(activeLayer.id, value);
  }

  function updateMaskPosition(axis: 'x' | 'y', detail: NumberFieldDetail): void {
    if (!activeLayer || !editingMask) return;
    const dragging = detail.source === 'drag';
    if (!dragging) beginStroke();
    const next = { ...maskOffset, [axis]: Math.round(detail.value) || 0 };
    if (editingEffectMask && maskPositionAnimated) {
      setMaskPositionById($activeFrameIndex, activeLayer.id, next);
    } else if (editingEffectMask) {
      setEffectMaskOffsetDirect(activeLayer.id, next);
    } else {
      setContentMaskOffsetDirect(activeLayer.id, next);
    }
    if (!dragging) endStroke();
  }

  function finishNumberScrub(detail: NumberFieldDetail): void {
    if (detail.source === 'drag') endStroke();
  }
</script>

<div class="properties scroll" class:playback-locked={$playing} inert={$playing} aria-disabled={$playing}>
  <div class="ui-panel-title">Layer properties</div>
  {#if activeLayer && hasEditableProperties}
    <!-- Layer identity and shared animated properties. -->
    <div class="identity">
      <strong>{activeLayer.name}</strong>
      <span>{editingMask ? 'mask' : activeLayer.type === 'cell' ? 'glyph' : activeLayer.type}</span>
    </div>

    {#if !editingMask}
      <div class="row animated-row">
        <span>Position</span>
        <button class:active={positionAnimated} class="track-button"
          onclick={togglePositionAnimation}
          title={positionAnimated ? 'Disable position keyframes' : 'Enable position keyframes'}
          aria-label={positionAnimated ? 'Disable position keyframes' : 'Enable position keyframes'}>
          <Icon icon="mdi:stopwatch-outline" width="15" />
        </button>
        <button class:keyed={positionKeyed} class="key-button" disabled={!positionAnimated}
          onclick={togglePositionKey}
          title={positionKeyed ? 'Remove position keyframe' : 'Add position keyframe'}
          aria-label={`${positionKeyed ? 'Remove' : 'Add'} position keyframe ${positionKeyed ? 'from' : 'to'} current frame`}>
          <span></span>
        </button>
      </div>
      <div class="row position-coordinate-row">
        <span></span>
        <span class="number-value compact">
          X
          <NumberField ariaLabel="Layer horizontal position" step={1} value={positionOffset.x}
            disabled={!positionEditor.editable} onScrubStart={beginStroke}
            onInput={(detail) => updatePosition('x', detail)} onChange={finishNumberScrub}
            onScrubCancel={cancelStroke} />
        </span>
        <span class="number-value compact">
          Y
          <NumberField ariaLabel="Layer vertical position" step={1} value={positionOffset.y}
            disabled={!positionEditor.editable} onScrubStart={beginStroke}
            onInput={(detail) => updatePosition('y', detail)} onChange={finishNumberScrub}
            onScrubCancel={cancelStroke} />
        </span>
      </div>
      <div class="row animated-row">
        <span>Visibility</span>
        <button class:active={visibilityAnimated} class="track-button"
          onclick={toggleVisibilityAnimation}
          title={visibilityAnimated ? 'Disable visibility keyframes' : 'Enable visibility keyframes'}
          aria-label={visibilityAnimated ? 'Disable visibility keyframes' : 'Enable visibility keyframes'}>
          <Icon icon="mdi:stopwatch-outline" width="15" />
        </button>
        <button class:keyed={visibilityKeyed} class="key-button" disabled={!visibilityAnimated}
          onclick={toggleVisibilityKeyHere}
          title={visibilityKeyed ? 'Remove visibility keyframe' : 'Add visibility keyframe'}
          aria-label={visibilityKeyed ? 'Remove visibility keyframe from current frame' : 'Add visibility keyframe to current frame'}>
          <span></span>
        </button>
        <button class:hidden={!visibleHere} class="visibility-value" disabled={!visibilityAnimated}
          onclick={toggleVisibilityValue}
          title={visibleHere ? 'Visible at this frame' : 'Hidden at this frame'}
          aria-label={visibleHere ? 'Visible at this frame' : 'Hidden at this frame'}>
          <Icon icon={visibleHere ? 'material-symbols:visibility-outline' : 'material-symbols:visibility-off-outline'} width="15" />
        </button>
      </div>
    {/if}

    <!-- The selected layer part determines whether this is mask or effect editing. -->
    {#if editingMask}
      <div class="row animated-row mask-position-row">
        <span>Position</span>
        {#if editingEffectMask}
          <button class:active={maskPositionAnimated} class="track-button"
            onclick={() => setMaskPositionTrackEnabled(activeLayer.id, !maskPositionAnimated)}
            title="Animate mask position" aria-label="Animate mask position">
            <Icon icon="mdi:stopwatch-outline" width="15" />
          </button>
          <button class:keyed={maskPositionKeyed} class="key-button" disabled={!maskPositionAnimated}
            onclick={() => toggleMaskPositionKey(activeLayer.id, $activeFrameIndex)}
            title="Add or remove mask position keyframe" aria-label="Add or remove mask position keyframe">
            <span></span>
          </button>
        {/if}
      </div>
      <div class="row mask-coordinate-row">
        <span></span>
        <span class="number-value compact">
          X
          <NumberField ariaLabel="Mask horizontal position" step={1} value={maskOffset.x}
            onScrubStart={beginStroke} onInput={(detail) => updateMaskPosition('x', detail)}
            onChange={finishNumberScrub} onScrubCancel={cancelStroke} />
        </span>
        <span class="number-value compact">
          Y
          <NumberField ariaLabel="Mask vertical position" step={1} value={maskOffset.y}
            onScrubStart={beginStroke} onInput={(detail) => updateMaskPosition('y', detail)}
            onChange={finishNumberScrub} onScrubCancel={cancelStroke} />
        </span>
      </div>
      {#if editingEffectMask}
      <div class="row animated-row">
        <span>Opacity</span>
        <button class:active={maskOpacityAnimated} class="track-button"
          onclick={() => setMaskOpacityTrackEnabled(activeLayer.id, !maskOpacityAnimated)}
          title="Animate mask opacity" aria-label="Animate mask opacity">
          <Icon icon="mdi:stopwatch-outline" width="15" />
        </button>
        <button class:keyed={maskOpacityKeyed} class="key-button" disabled={!maskOpacityAnimated}
          onclick={() => toggleMaskOpacityKey(activeLayer.id, $activeFrameIndex)}
          title="Add or remove mask opacity keyframe" aria-label="Add or remove mask opacity keyframe">
          <span></span>
        </button>
        <span class="number-value">
          <NumberField ariaLabel="Mask opacity" min={0} max={100} step={1}
            value={Math.round((effectLayer?.mask?.opacity ?? 1) * 100)} onScrubStart={beginStroke}
            onInput={updateMaskOpacity} onChange={finishNumberScrub}
            onScrubCancel={cancelStroke} />
          %
        </span>
      </div>
      <div class="hint">Brush luminance controls effect strength. Erase blocks the effect.</div>
      {:else}
      <div class="hint">White reveals content. Any other color blocks it.</div>
      {/if}
    {:else if effect}
      {#if !isColorClip}
        <label class="row">
          <span>Effect</span>
          <select value={effect.kind || 'brightness'} onchange={updateEffectKind}>
            <option value="brightness">Brightness</option>
            <option value="contrast">Contrast</option>
            <option value="saturation">Saturation</option>
            <option value="hue">Hue</option>
            <option value="solid-color">Solid Color</option>
          </select>
        </label>
      {:else}
        <div class="row"><span>Type</span><span class="number-value" style="margin-left:0">Colour Clip</span></div>
      {/if}
      {#if isSolidColor}
        <div class="row animated-row">
          <span>Color</span>
          <button class:active={effectColorAnimated} class="track-button"
            onclick={toggleEffectColorAnimation}
            title={effectColorAnimated ? 'Disable color animation' : 'Animate color'}
            aria-label={effectColorAnimated ? 'Disable color animation' : 'Animate color'}
            aria-pressed={effectColorAnimated}>
            <Icon icon="mdi:stopwatch-outline" width="15" />
          </button>
          <button class:keyed={effectColorKeyed} class="key-button" disabled={!effectColorAnimated}
            onclick={toggleEffectColorKeyHere}
            title="Add or remove color keyframe" aria-label="Add or remove color keyframe">
            <span></span>
          </button>
          <button class="effect-color-control"
            style="background: {effectColorValue}"
            aria-label="Effect color"
            title="Effect color"
            onclick={(event) => openEffectColorPicker(event)}
          ></button>
        </div>
      {/if}
      <div class="row animated-row">
        <span>{(isSolidColor || isColorClip) ? 'Mix' : 'Intensity'}</span>
        <button class:active={intensityAnimated} class="track-button"
          onclick={() => setEffectIntensityTrackEnabled(activeLayer.id, !intensityAnimated)}
          title={intensityAnimated ? 'Disable intensity animation' : 'Animate intensity'}
          aria-label={intensityAnimated ? 'Disable intensity animation' : 'Animate intensity'}
          aria-pressed={intensityAnimated}>
          <Icon icon="mdi:stopwatch-outline" width="15" />
        </button>
        <button class:keyed={intensityKeyed} class="key-button" disabled={!intensityAnimated}
          onclick={() => toggleEffectIntensityKey(activeLayer.id, $activeFrameIndex)}
          title="Add or remove intensity keyframe" aria-label="Add or remove intensity keyframe">
          <span></span>
        </button>
        <span class="number-value">
          <NumberField ariaLabel={(isSolidColor || isColorClip) ? 'Effect mix' : 'Effect intensity'}
            min={(isSolidColor || isColorClip) ? 0 : -100} max={100} step={1}
            value={Math.round((effect.intensity || 0) * 100)} onScrubStart={beginStroke}
            onInput={updateIntensity} onChange={finishNumberScrub}
            onScrubCancel={cancelStroke} />
          %
        </span>
      </div>
      <div class="hint">
        {isColorClip ? 'Paint colours to adjust the layer below.' : (effectLayer?.clipped ? 'Affects the layer below.' : 'Affects all visible layers below.')}
      </div>
    {/if}

    <!-- Type-specific controls remain after the shared layer/effect controls. -->
    {#if textLayer}
      <div class="row">
        <span>Color</span>
        <input class="hex text-color-control" value={textColorMixed ? '' : textColor}
          placeholder={textColorMixed ? 'Mixed' : ''} maxlength="7"
          aria-label={textColorMixed ? 'Text colors mixed' : 'Text color'}
          onpointerdown={captureTextColorSelection}
          oninput={updateTextColor} onchange={resetInvalidTextColor} />
        <button class="swatch text-color-control" class:mixed={textColorMixed}
          style:background={textColorMixed ? null : textColor}
          onpointerdown={captureTextColorSelection} onclick={openTextPicker}
          aria-label={textColorMixed ? 'Text colors mixed' : 'Text color'}
          title={textColorMixed ? 'Mixed colors' : 'Choose color'}></button>
      </div>
      <div class="row">
        <span>Overflow</span>
        <button class="action" disabled={!textHasOverflow} onclick={cutTextOverflow}>Cut off overflow</button>
      </div>
    {/if}
    {#if shapeLayer}
      <ShapeProperties activeLayer={shapeLayer} />
    {/if}
  {/if}
</div>

<style>
  .properties { height: 100%; overflow-y: auto; border-bottom: 1px solid var(--border); }
  .identity { display: flex; justify-content: space-between; gap: 8px; padding: 8px 10px 5px; font-size: 11px; }
  .identity strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .identity span { color: var(--text-dim); text-transform: capitalize; }
  .effect-color-control { min-width: 0; height: 22px; flex: 1; padding: 0;
    background: var(--canvas-bg); border: 1px solid var(--border); border-radius: var(--radius-sm);
    cursor: pointer; }
  .swatch.mixed {
    background: linear-gradient(135deg,
      var(--canvas-bg) 0 44%, var(--text-dim) 44% 56%, var(--panel-hi) 56% 100%);
  }
  .action {
    min-width: 0; height: 22px; flex: 1; padding: 2px 7px;
    background: var(--panel-hi); color: var(--text); border: 1px solid var(--border);
    border-radius: var(--radius-sm); font: inherit;
  }
  .action:disabled { opacity: 0.35; }
  .animated-row > span:first-child { width: 48px; }
  .position-coordinate-row > span:first-child { width: 48px; }
  .mask-coordinate-row > span:first-child { width: 48px; }
  .position-coordinate-row .number-value,
  .mask-coordinate-row .number-value {
    min-width: 0; flex: 1; margin-left: 0;
  }
  .position-coordinate-row .number-value :global(.number-field),
  .mask-coordinate-row .number-value :global(.number-field) {
    min-width: 0; width: 100%;
  }
</style>
