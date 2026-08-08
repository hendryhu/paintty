<script>
  import { onDestroy, tick } from 'svelte';
  import {
    clampNumber,
    commitNumber,
    dragNumber,
    formatNumber,
    numberDraftPointerDownAction,
    resolveNumberScrubEnd,
    stepNumber,
  } from '../lib/numberField.js';
  import { onProjectReplaced } from '../lib/documentLifecycle.js';

  /**
   * @typedef {Object} Props
   * @property {number} [value]
   * @property {any} [min]
   * @property {any} [max]
   * @property {number} [step]
   * @property {boolean} [disabled]
   * @property {string} [ariaLabel]
   * @property {string} [title]
   * @property {string} [className]
   * @property {any} [precision]
   * @property {(detail: { value: number, source: string }) => void} [onInput]
   * @property {(detail: { value: number, source: string }) => void} [onChange]
   * @property {(detail: { value: number, source: string }) => void} [onScrubStart]
   * @property {(detail: { value: number, source: string }) => void} [onScrubCancel]
   * @property {(detail: { value: number, source: string }) => void} [onEditStart]
   * @property {(detail: { value: number, source: string }) => void} [onEditEnd]
   */

  /** @type {Props} */
  let {
    value = $bindable(0),
    min = undefined,
    max = undefined,
    step = 1,
    disabled = false,
    ariaLabel = '',
    title = '',
    className = '',
    precision = undefined,
    onInput = () => {},
    onChange = () => {},
    onScrubStart = () => {},
    onScrubCancel = () => {},
    onEditStart = () => {},
    onEditEnd = () => {},
  } = $props();

  const threshold = 4;
  let input = $state();
  function displayValue(next) {
    return formatNumber(next, min, max, precision);
  }

  let draft = $state(displayValue(value));
  let dirty = $state(false);
  let dragging = $state(false);
  let scrubStarted = false;
  let pointer = null;
  let suppressClick = false;
  let savedCursor = '';
  let savedSelection = '';

  $effect(() => {
    if (!dirty && !dragging) draft = formatNumber(value, min, max, precision);
  });

  async function selectAll() {
    if (disabled || pointer) return;
    await tick();
    if (pointer) return;
    input?.select();
  }

  function publish(next, source) {
    value = next;
    draft = displayValue(next);
    dirty = false;
    onInput({ value: next, source });
  }

  function commit(source = 'typing') {
    if (!dirty) return;
    const next = commitNumber(draft, value, min, max);
    const changed = next !== Number(value);
    value = next;
    draft = displayValue(next);
    dirty = false;
    if (changed) onInput({ value: next, source });
    onChange({ value: next, source });
  }

  function setDragCursor(active) {
    if (active) {
      savedCursor = document.documentElement.style.cursor;
      savedSelection = document.documentElement.style.userSelect;
      document.documentElement.style.cursor = 'ew-resize';
      document.documentElement.style.userSelect = 'none';
    } else {
      document.documentElement.style.cursor = savedCursor;
      document.documentElement.style.userSelect = savedSelection;
    }
  }

  function onPointerDown(event) {
    if (disabled || event.button !== 0) return;
    suppressClick = false;
    scrubStarted = false;
    pointer = {
      id: event.pointerId,
      x: event.clientX,
      value: commitNumber(draft, value, min, max),
    };
    input?.focus({ preventScroll: true });
    // Delay select-all until pointer-up so horizontal motion can become a scrub.
    const end = input?.value.length || 0;
    input?.setSelectionRange?.(end, end);
    event.preventDefault();
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('blur', onPointerCancel);
  }

  function onCapturedPointerDown(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const action = numberDraftPointerDownAction({
      dirty,
      disabled,
      pointerActive: !!pointer,
      sameField: event.target === input || path.includes(input),
    });
    if (action !== 'commit-blur') return;
    // Capture-phase precommit lets the destination pointer handler observe the displayed draft.
    commit();
    input?.blur();
  }

  function onPointerMove(event) {
    if (!pointer || event.pointerId !== pointer.id) return;
    const delta = event.clientX - pointer.x;
    if (!dragging && Math.abs(delta) < threshold) return;
    const next = dragNumber(pointer.value, delta, step, min, max);
    event.preventDefault();
    if (!dragging) {
      dragging = true;
      suppressClick = true;
      if (document.activeElement === input) {
        const end = input.value.length;
        input.setSelectionRange?.(end, end);
      }
      setDragCursor(true);
    }
    if (next === Number(value)) return;
    if (!scrubStarted) {
      scrubStarted = true;
      onScrubStart({ value: pointer.value, source: 'drag' });
    }
    publish(next, 'drag');
  }

  function removePointerListeners() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('blur', onPointerCancel);
  }

  function finishPointer(cancelled) {
    if (!pointer) return false;
    const outcome = resolveNumberScrubEnd(pointer.value, value, cancelled);
    const wasDragging = dragging;
    const didScrub = scrubStarted;
    pointer = null;
    dragging = false;
    scrubStarted = false;
    removePointerListeners();
    if (wasDragging) {
      setDragCursor(false);
    }
    if (didScrub) {
      if (cancelled) publish(outcome.value, 'drag');
      const detail = { value: outcome.value, source: 'drag' };
      if (outcome.event === 'change') onChange(detail);
      else onScrubCancel(detail);
    }
    if (cancelled) suppressClick = false;
    return wasDragging;
  }

  function onPointerUp(event) {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (!finishPointer(false)) {
      input?.focus({ preventScroll: true });
      selectAll();
    }
  }

  function onPointerCancel(event) {
    if (!pointer || (event.pointerId != null && event.pointerId !== pointer.id)) return;
    finishPointer(true);
  }

  const stopProjectReplaced = onProjectReplaced(() => {
    const wasDragging = dragging;
    pointer = null;
    dragging = false;
    scrubStarted = false;
    suppressClick = false;
    dirty = false;
    removePointerListeners();
    if (wasDragging) setDragCursor(false);
    draft = displayValue(value);
  });

  function onDraftInput(event) {
    draft = event.currentTarget.value;
    dirty = true;
  }

  function onFocus() {
    selectAll();
    onEditStart({ value: Number(value), source: 'typing' });
  }

  function onBlur() {
    commit();
    onEditEnd({ value: Number(value), source: 'typing' });
  }

  function onKeyDown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
      selectAll();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      draft = displayValue(value);
      dirty = false;
      selectAll();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const direction = event.key === 'ArrowUp' ? 1 : -1;
      const next = stepNumber(commitNumber(draft, value, min, max), direction, step, min, max);
      if (next !== Number(value)) {
        publish(next, 'keyboard');
        onChange({ value: next, source: 'keyboard' });
      } else {
        value = next;
        draft = displayValue(next);
        dirty = false;
      }
      selectAll();
    }
  }

  function onClick(event) {
    event.preventDefault();
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    input?.focus({ preventScroll: true });
    selectAll();
  }

  onDestroy(() => {
    stopProjectReplaced();
    finishPointer(true);
    removePointerListeners();
  });
</script>

<svelte:window onpointerdowncapture={onCapturedPointerDown} />

<input
  bind:this={input}
  class:dragging
  class="number-field {className}"
  data-dirty={dirty}
  type="text"
  inputmode="decimal"
  role="spinbutton"
  aria-label={ariaLabel || undefined}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={String(draft).trim() !== '' && Number.isFinite(Number(draft)) ? Number(draft) : Number(value)}
  {title}
  {disabled}
  value={draft}
  autocomplete="off"
  spellcheck="false"
  onfocus={onFocus}
  onblur={onBlur}
  oninput={onDraftInput}
  onkeydown={onKeyDown}
  onpointerdown={onPointerDown}
  onclick={onClick}
/>

<style>
  input {
    width: 48px;
    box-sizing: border-box;
    padding: 2px 5px;
    background: var(--canvas-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font: inherit;
    font-variant-numeric: tabular-nums;
    cursor: ew-resize;
  }
  input:focus { border-color: var(--accent); outline: none; }
  input:disabled { opacity: 0.42; cursor: default; }
  input.dragging { user-select: none; }
</style>
