<script>
  import Icon from './Icon.svelte';
  import { untrack } from 'svelte';
  import { oklchToHex, maxChroma, oklchInGamut } from '../lib/color.js';
  import {
    pickerStateFromHex, pickerStateFromOklch,
    setPickerLightness, setPickerChroma, setPickerHue,
  } from '../lib/colorPickerState.js';
  import NumberField from './NumberField.svelte';
  import { isTopPopup, popupFocus } from '../lib/popupFocus.js';

  /**
   * @typedef {Object} Props
   * @property {string} [value]
   * @property {any} [recent]
   * @property {number} [x]
   * @property {number} [y]
   * @property {boolean} [showEyedropper]
   * @property {(hex: string) => void} [onChange]
   * @property {(hex: string) => void} [onCommit]
   * @property {() => void} [onGestureCancel]
   * @property {() => void} [onEyedropper]
   * @property {() => void} [onClose]
   */

  /** @type {Props} */
  let {
    value = '#ffffff',
    recent = [],
    x = 0,
    y = 0,
    showEyedropper = true,
    onChange = () => {},
    onCommit = () => {},
    onGestureCancel = () => {},
    onEyedropper = () => {},
    onClose = () => {},
  } = $props();

  const SIZE = 200, R = SIZE / 2;
  const N = 120;
  const C_AXIS = 0.4;

  let mode = $state('wheel');
  let pickerEl = $state();

  const initialValue = untrack(() => value);
  let pickerState = $state(pickerStateFromHex(initialValue));
  let observedValue = $state(initialValue);
  let L = $derived(pickerState.L);
  let C = $derived(pickerState.C);
  let Hue = $derived(pickerState.H);
  $effect(() => {
    if (value !== observedValue) {
      observedValue = value;
      const next = pickerStateFromHex(value);
      if (next.hex !== pickerState.hex) pickerState = next;
    }
  });
  let lightnessValue = $derived(Math.round(L * 1000) / 10);
  let chromaValue = $derived(Math.round(C * 1000) / 1000);
  let hueValue = $derived(Math.round(Hue));

  let wheelEl = $state(), drawnKey = '';

  function fieldDrawKey() {
    if (mode === 'wheel') return mode + ':' + Math.round(L * 100);
    if (mode === 'lc') return mode + ':' + Math.round(Hue);
    return mode + ':' + Math.round(C * 1000);
  }

  function fieldColor(i, j) {
    if (mode === 'wheel') {
      const dx = i - N / 2;
      const dy = j - N / 2;
      const distance = Math.hypot(dx, dy);
      if (distance > N / 2) return null;
      let hue = Math.atan2(dy, dx) * 180 / Math.PI;
      if (hue < 0) hue += 360;
      return oklchToHex(L, (distance / (N / 2)) * maxChroma(L, hue), hue);
    }
    if (mode === 'lc') {
      const lightness = i / (N - 1);
      const chroma = (1 - j / (N - 1)) * C_AXIS;
      return oklchInGamut(lightness, chroma, Hue)
        ? oklchToHex(lightness, chroma, Hue)
        : null;
    }
    const hue = (i / (N - 1)) * 360;
    const lightness = 1 - j / (N - 1);
    return oklchInGamut(lightness, C, hue)
      ? oklchToHex(lightness, C, hue)
      : null;
  }

  function writePixel(data, index, hex) {
    if (!hex) {
      data[index + 3] = 0;
      return;
    }
    const rgb = parseInt(hex.slice(1), 16);
    data[index] = (rgb >> 16) & 255;
    data[index + 1] = (rgb >> 8) & 255;
    data[index + 2] = rgb & 255;
    data[index + 3] = 255;
  }

  function putField() {
    if (!wheelEl) return;
    const key = fieldDrawKey();
    if (key === drawnKey) return;
    drawnKey = key;
    wheelEl.width = N;
    wheelEl.height = N;
    const ctx = wheelEl.getContext('2d');
    const image = ctx.createImageData(N, N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const index = (j * N + i) * 4;
        writePixel(image.data, index, fieldColor(i, j));
      }
    }
    ctx.putImageData(image, 0, 0);
  }
  $effect(() => {
    mode; L; C; Hue;
    putField();
  });

  let markX = $derived(mode === 'wheel'
      ? R + Math.cos(Hue * Math.PI / 180) * (maxChroma(L, Hue) > 0 ? Math.min(1, C / maxChroma(L, Hue)) * R : 0)
      : mode === 'lc' ? L * SIZE : (Hue / 360) * SIZE);
  let markY = $derived(mode === 'wheel'
      ? R + Math.sin(Hue * Math.PI / 180) * (maxChroma(L, Hue) > 0 ? Math.min(1, C / maxChroma(L, Hue)) * R : 0)
      : mode === 'lc' ? (1 - Math.min(1, C / C_AXIS)) * SIZE : (1 - L) * SIZE);

  let pointerId = null;
  let pendingColor = null;
  let scalarSource = null;
  function emit(hex, commit = false) {
    onChange(hex);
    if (commit) onCommit(hex);
  }
  function preview(next) {
    pickerState = next;
    pendingColor = next.hex;
    emit(next.hex);
  }
  function pick(e) {
    const r = wheelEl.getBoundingClientRect();
    if (mode === 'wheel') {
      const dx = e.clientX - r.left - R, dy = e.clientY - r.top - R;
      let hue = Math.atan2(dy, dx) * 180 / Math.PI; if (hue < 0) hue += 360;
      const frac = Math.min(1, Math.hypot(dx, dy) / R);
      preview(pickerStateFromOklch(L, frac * maxChroma(L, hue), hue));
    } else {
      const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      // Clamp chroma before RGB conversion so the chosen hue stays stable.
      if (mode === 'lc') {
        const Lv = fx, Cv = Math.min((1 - fy) * C_AXIS, maxChroma(fx, Hue));
        preview(pickerStateFromOklch(Lv, Cv, Hue));
      } else {
        const Lv = 1 - fy, Hv = fx * 360;
        preview(pickerStateFromOklch(Lv, Math.min(C, maxChroma(Lv, Hv)), Hv));
      }
    }
  }
  function down(e) {
    if (pointerId !== null || e.button !== 0 || e.isPrimary === false) return;
    pointerId = e.pointerId;
    pendingColor = null;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(pointerId);
    pick(e);
  }
  function move(e) {
    if (pointerId === e.pointerId) pick(e);
  }
  function up(e) {
    if (pointerId !== e.pointerId) return;
    const color = pendingColor;
    pointerId = null;
    pendingColor = null;
    if (color) onCommit(color);
  }
  function cancelGesture(e) {
    if (e?.pointerId != null && pointerId !== e.pointerId) return;
    const active = pointerId !== null;
    pointerId = null;
    pendingColor = null;
    if (active) onGestureCancel();
  }

  function beginScalar(source) { scalarSource ||= source; }
  function updateL(next, source) { beginScalar(source); preview(setPickerLightness(pickerState, next)); }
  function updateC(next, source) { beginScalar(source); preview(setPickerChroma(pickerState, next)); }
  function updateHue(next, source) { beginScalar(source); preview(setPickerHue(pickerState, next)); }
  function commitPreview() {
    scalarSource = null;
    onCommit(pickerState.hex);
  }
  function cancelNumberScrub() {
    if (scalarSource === 'number') scalarSource = null;
  }
  function cancelRangeGesture() {
    if (scalarSource !== 'range') return;
    scalarSource = null;
    onGestureCancel();
  }
  function cancelWindowGesture(event) {
    cancelGesture(event);
    cancelRangeGesture();
  }
  function numberValue(detail) { return Number(detail.value); }
  function sliderValue(event) { return Number(event.currentTarget.value); }
  function previewHex(event) {
    let hex = event.currentTarget.value.trim();
    if (!hex.startsWith('#')) hex = '#' + hex;
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
    pickerState = pickerStateFromHex(hex);
    emit(pickerState.hex);
  }
  function setHex(event) {
    let hex = event.currentTarget.value.trim();
    if (!hex.startsWith('#')) hex = '#' + hex;
    if (/^#[0-9a-f]{6}$/i.test(hex)) {
      pickerState = pickerStateFromHex(hex);
      emit(pickerState.hex, true);
    } else event.currentTarget.value = pickerState.hex;
  }
  function onHexKeyDown(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    setHex(event);
    event.currentTarget.select();
  }
  function chooseRecent(color) {
    pickerState = pickerStateFromHex(color);
    emit(pickerState.hex, true);
  }
  function onKey(event) {
    if (event.key !== 'Escape' || !isTopPopup(pickerEl) ||
      event.target.closest?.('.number-field[data-dirty="true"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onClose();
  }
</script>

<svelte:window onpointermove={move} onpointerup={up} onpointercancel={cancelWindowGesture}
  onblur={cancelWindowGesture} onkeydowncapture={onKey} />

<div class="picker" role="dialog" aria-label="Color picker" tabindex="-1"
  bind:this={pickerEl} use:popupFocus={{ initialFocus: '.modes button' }} style="left: {x}px; top: {y}px;">
  <div class="picker-main">
    <div class="modes">
      <button class:on={mode === 'wheel'} onclick={() => mode = 'wheel'} title="Hue and chroma">Wheel</button>
      <button class:on={mode === 'lc'} onclick={() => mode = 'lc'} title="Lightness and chroma">Fix H</button>
      <button class:on={mode === 'hl'} onclick={() => mode = 'hl'} title="Hue and lightness">Fix C</button>
    </div>

    <div class="wheel-wrap" style="width: {SIZE}px; height: {SIZE}px;">
      <canvas bind:this={wheelEl} class="wheel" class:square={mode !== 'wheel'}
        onpointerdown={down} onlostpointercapture={cancelGesture}></canvas>
      <div class="marker" style="left: {markX}px; top: {markY}px;"></div>
    </div>

    {#if mode === 'wheel'}
      <div class="scalar-row">
        <span class="lbl">L</span>
        <input class="scalar-slider" aria-label="OKLCH lightness slider" type="range"
          min="0" max="100" step="0.5" value={lightnessValue}
          onpointerdown={() => beginScalar('range')}
          onpointercancel={cancelRangeGesture}
          oninput={(event) => updateL(sliderValue(event), 'range')}
          onchange={commitPreview} />
        <NumberField ariaLabel="OKLCH lightness" min={0} max={100} step={0.5}
          value={lightnessValue} onInput={(detail) => updateL(numberValue(detail), 'number')}
          onChange={commitPreview} onScrubCancel={cancelNumberScrub} />
        <span class="unit">%</span>
      </div>
    {:else if mode === 'lc'}
      <div class="scalar-row">
        <span class="lbl">H</span>
        <input class="scalar-slider hue" aria-label="OKLCH hue slider" type="range"
          min="0" max="360" step="1" value={hueValue}
          onpointerdown={() => beginScalar('range')}
          onpointercancel={cancelRangeGesture}
          oninput={(event) => updateHue(sliderValue(event), 'range')}
          onchange={commitPreview} />
        <NumberField ariaLabel="OKLCH hue" min={0} max={360} step={1}
          value={hueValue} onInput={(detail) => updateHue(numberValue(detail), 'number')}
          onChange={commitPreview} onScrubCancel={cancelNumberScrub} />
        <span class="unit">°</span>
      </div>
    {:else}
      <div class="scalar-row">
        <span class="lbl">C</span>
        <input class="scalar-slider chroma" aria-label="OKLCH chroma slider" type="range"
          min="0" max={C_AXIS} step="0.002" value={chromaValue}
          onpointerdown={() => beginScalar('range')}
          onpointercancel={cancelRangeGesture}
          oninput={(event) => updateC(sliderValue(event), 'range')}
          onchange={commitPreview} />
        <NumberField ariaLabel="OKLCH chroma" min={0} max={C_AXIS} step={0.002}
          value={chromaValue} onInput={(detail) => updateC(numberValue(detail), 'number')}
          onChange={commitPreview} onScrubCancel={cancelNumberScrub} />
        <span class="unit"></span>
      </div>
    {/if}

    <div class="value-row">
      <div class="preview" style="background: {value};"></div>
      <input class="hex" aria-label="Hex color" type="text" value={value}
        oninput={previewHex} onchange={setHex} onkeydown={onHexKeyDown}
        maxlength="7" spellcheck="false" />
      {#if showEyedropper}
        <button class="eyedropper" onclick={onEyedropper}
          aria-label="Eyedropper" title="Eyedropper"><Icon icon="material-symbols:colorize" /></button>
      {/if}
    </div>
  </div>

  <div class="recent-panel">
    <div class="recent-label">Recent</div>
    <div class="recent-grid">
      {#each recent.slice(0, 16) as color}
        <button class="recent-swatch" style="background: {color};"
          onclick={() => chooseRecent(color)} aria-label={color} title={color}></button>
      {/each}
    </div>
  </div>
</div>

<style>
  .picker {
    position: fixed; z-index: 50; width: 292px; padding: 10px;
    background: var(--panel-hi); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: 0 6px 20px var(--shadow-popover);
    display: flex; align-items: flex-start; gap: 9px;
  }
  .picker-main { width: 200px; display: flex; flex-direction: column; gap: 8px; }
  .modes { display: flex; gap: 4px; }
  .modes button {
    flex: 1; font-size: 11px; padding: 3px 0; cursor: pointer;
    background: var(--panel); color: var(--text-dim);
    border: 1px solid var(--border); border-radius: var(--radius-sm);
  }
  .modes button:hover { color: var(--text); border-color: var(--accent-dim); }
  .modes button.on { color: var(--on-accent); background: var(--accent-dim); border-color: var(--accent); }
  .wheel-wrap { position: relative; margin: 0 auto; }
  .wheel { width: 100%; height: 100%; display: block; border-radius: 50%; cursor: crosshair; image-rendering: pixelated; touch-action: none; }
  .wheel.square { border-radius: var(--radius-sm); }
  .marker {
    position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px;
    border: 2px solid var(--pure-white); border-radius: 50%;
    box-shadow: 0 0 0 1px var(--pure-black); pointer-events: none;
  }
  .scalar-row {
    display: grid; grid-template-columns: 10px minmax(0, 1fr) 48px 12px;
    align-items: center; gap: 5px;
  }
  .scalar-row :global(.number-field) { width: 48px; }
  .lbl, .unit { color: var(--text-dim); font-size: 11px; }
  .scalar-slider {
    width: 100%; height: 16px; margin: 0; appearance: none;
    background: transparent; cursor: pointer;
  }
  .scalar-slider::-webkit-slider-runnable-track {
    height: 4px; background: linear-gradient(to right, var(--pure-black), var(--pure-white));
    border: 1px solid var(--border); border-radius: 999px;
  }
  .scalar-slider.hue::-webkit-slider-runnable-track {
    /* The hue spectrum is functional color data, not an interface theme color. */
    background: linear-gradient(to right, #f44, #ff4, #4f4, #4ff, #44f, #f4f, #f44);
  }
  .scalar-slider.chroma::-webkit-slider-runnable-track {
    background: linear-gradient(to right, var(--canvas-bg), var(--accent));
  }
  .scalar-slider::-webkit-slider-thumb {
    width: 10px; height: 14px; margin-top: -6px; appearance: none;
    background: var(--text); border: 1px solid var(--pure-black); border-radius: 3px;
    box-shadow: 0 0 0 1px var(--border);
  }
  .scalar-slider::-moz-range-track {
    height: 4px; background: linear-gradient(to right, var(--pure-black), var(--pure-white));
    border-radius: 999px;
  }
  .scalar-slider.hue::-moz-range-track {
    background: linear-gradient(to right, #f44, #ff4, #4f4, #4ff, #44f, #f4f, #f44);
  }
  .scalar-slider.chroma::-moz-range-track {
    background: linear-gradient(to right, var(--canvas-bg), var(--accent));
  }
  .scalar-slider::-moz-range-thumb {
    width: 10px; height: 14px; background: var(--text);
    border: 1px solid var(--pure-black); border-radius: 3px;
  }
  .scalar-slider:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
  .value-row { display: flex; align-items: center; gap: 6px; }
  .preview {
    width: 28px; height: 26px; flex-shrink: 0;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
  }
  .hex {
    min-width: 0; height: 26px; flex: 1; padding: 3px 6px;
    color: var(--text); background: var(--canvas-bg);
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    font-family: var(--font-mono); font-size: 11px; user-select: text;
  }
  .hex:focus { border-color: var(--accent); outline: none; }
  .eyedropper {
    width: 28px; height: 26px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-dim); background: var(--panel);
    border: 1px solid var(--border); border-radius: var(--radius-sm);
  }
  .eyedropper:hover { color: var(--text); border-color: var(--accent-dim); }
  .eyedropper :global(svg) { font-size: 16px; }
  .recent-panel {
    width: 53px; padding-left: 8px; border-left: 1px solid var(--border);
  }
  .recent-label {
    margin: 1px 0 7px; color: var(--text-dim);
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.4px;
  }
  .recent-grid { display: grid; grid-template-columns: repeat(2, 19px); gap: 4px; }
  .recent-swatch {
    width: 19px; height: 19px; padding: 0;
    border: 1px solid var(--border); border-radius: 3px;
  }
  .recent-swatch:hover { outline: 1px solid var(--accent); outline-offset: 1px; }
</style>
