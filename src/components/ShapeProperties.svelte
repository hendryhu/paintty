<script>
  import { onDestroy } from 'svelte';
  import Icon from './Icon.svelte';
  import NumberField from './NumberField.svelte';
  import {
    setShapeLayerProperties, beginStroke, endStroke, cancelStroke,
  } from '../lib/grid.js';
  import {
    frames, activeFrameIndex,
    isShapePathWholeTrackEnabled, hasShapePathWholeKey, setShapePathWholeTrackEnabled,
    setShapePathById, shapePathAt, shapePathWholeKeys, toggleShapePathWholeKey,
    canAnimateShapePath, shapePathAnimationComponents, setShapePathComponentTrackEnabled,
    setShapePathComponentValue, setShapePathComponentValues,
    toggleShapePathComponentKey,
  } from '../lib/frames.js';
  import { colorEditSession } from '../lib/colorEditSession.js';
  import {
    BOX_STYLE_OPTIONS,
    SLOPE_GLYPHS,
    constrainShape,
    isSlopeLine,
    lineStylePatch,
    lineStyleValue,
    renderShapeToCells,
    resolvedShapeAnchor,
    updateShapeAppearance,
  } from '../lib/shapes.js';
  import { canvasFont } from '../lib/font.js';
  import { shapeGeometryHover } from '../lib/stores.js';
  import { isWide } from '../lib/width.js';
  import {
    editShapePathField,
    pathValueFromShape,
    shapePathComponentValue,
  } from '../lib/shapePath.js';
  import {
    canConvertShapeDetailToCell,
    editPolygonSides,
    editShapePathAggregate,
    shapeForAnchorComponentEdit,
    shapeForStaticPathEdit,
    shapePathAggregateMetrics,
  } from '../lib/shapePathEditing.js';
  import { applyShapeGeometryEdit } from '../lib/shapeBodyDrag.js';

  let { activeLayer } = $props();

  const LINE_BOX_STYLE_OPTIONS = BOX_STYLE_OPTIONS.filter((choice) => choice.value !== 'rounded');
  const PICKER_W = 292;
  const PICKER_H = 340;
  let shapePathScrub = null;
  let shapeComponentScrubPath = null;
  let shapePropertyScrubShape = null;
  let expandedShapeComponents = $state(new Set());
  let expandedShapeLayerId = $state(null);

  let shape = $derived(activeLayer?.shape || null);
  let slopeLineLocked = $derived(isSlopeLine(shape));
  let shapeStrokeEditable = $derived(shape &&
    shape.style !== 'filled' && shape.style !== 'special' && shape.style !== 'slope');
  let shapePathAnimated = $derived(($frames,
    activeLayer ? isShapePathWholeTrackEnabled(activeLayer.id) : false));
  let shapePathAnimationAvailable = $derived(($frames,
    activeLayer ? canAnimateShapePath(activeLayer.id) : false));
  let shapePathUnavailableHint = $derived(shape?.kind === 'polygon'
    ? 'Use one polygon side count across all frames'
    : 'Use one shape type across all frames');
  let shapePathKeyed = $derived(($frames,
    activeLayer ? hasShapePathWholeKey(activeLayer.id, $activeFrameIndex) : false));
  let shapePath = $derived(($frames, $activeFrameIndex,
    activeLayer ? shapePathAt(activeLayer.id, $activeFrameIndex) : null));
  let linePathStart = $derived(shapePath?.kind === 'line'
    ? shapePathComponentValue(shapePath, 'vertex:0')
    : null);
  let linePathEnd = $derived(shapePath?.kind === 'line'
    ? shapePathComponentValue(shapePath, 'vertex:1')
    : null);
  let shapeComponents = $derived(($frames, $activeFrameIndex,
    activeLayer ? shapePathAnimationComponents(activeLayer.id, $activeFrameIndex) : []));
  let legacyShapePathKeys = $derived(($frames,
    activeLayer ? shapePathWholeKeys(activeLayer.id) : []));
  let shapeGeometryAnimated = $derived(shapePathAnimated ||
    shapeComponents.some((component) => component.enabled));
  let shapeCanFreeTransform = $derived(shape && shape.channel !== 'background' &&
    shape.style !== 'special' && shape.style !== 'slope');
  let shapeDefaultAnchor = $derived(shape
    ? resolvedShapeAnchor({ ...shape, anchor: null })
    : null);
  let shapeHasAdvancedGeometry = $derived(!!shape && (
    Array.isArray(shape.vertices) ||
    Math.abs(Number(shape.rotation) || 0) > 1e-9 ||
    (Number.isFinite(shape.anchor?.x) && Number.isFinite(shape.anchor?.y) &&
      shapeDefaultAnchor &&
      (Math.abs(shape.anchor.x - shapeDefaultAnchor.x) > 1e-9 ||
        Math.abs(shape.anchor.y - shapeDefaultAnchor.y) > 1e-9)) ||
    shapeComponents.some((component) => component.enabled)
  ));
  $effect(() => {
    if (activeLayer?.id !== expandedShapeLayerId) {
      expandedShapeLayerId = activeLayer?.id ?? null;
      expandedShapeComponents = new Set();
      shapeGeometryHover.set(null);
    }
  });
  let shapeGeometryStep = $derived(shape &&
    (shape.detail === 'half' || shape.detail === 'quarter') &&
    shape.style !== 'special' && shape.style !== 'slope'
      ? 0.5
      : 1);
  let shapeCenterStep = $derived(shapeGeometryStep / 2);
  let shapeCenterPrecision = $derived(shapeCenterStep < 0.5 ? 2 : 1);
  let shapeAggregate = $derived(shapePathAggregateMetrics(shapePath));
  let shapeCellDetailSafe = $derived(canConvertShapeDetailToCell(shape, shapeGeometryAnimated));
  let shapeCellDetailBlocked = $derived(shape?.detail !== 'cell' && !shapeCellDetailSafe);
  let polygonSidesEditable = $derived(shape?.kind === 'polygon' && !shapeGeometryAnimated);
  let polygonSides = $derived(shape?.kind === 'polygon'
    ? Math.max(3, Math.min(64, Math.round(Number(shape.sides) ||
      shape.vertices?.length || 3)))
    : 3);

  onDestroy(() => shapeGeometryHover.set(null));

  function pickerAnchor(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const maxX = Math.max(4, window.innerWidth - PICKER_W - 4);
    const maxY = Math.max(4, window.innerHeight - PICKER_H - 4);
    let x = rect.left - PICKER_W - 10;
    if (x < 4) x = rect.right + 10;
    x = Math.max(4, Math.min(x, maxX));
    const y = Math.max(4, Math.min(rect.top, maxY));
    return { x, y };
  }

  function openShapePicker(event) {
    if (!shape) return;
    event.stopPropagation();
    colorEditSession.open({ kind: 'shape', layerId: activeLayer.id }, pickerAnchor(event));
  }

  function normalizedHex(value) {
    const raw = value.trim();
    const hex = raw.startsWith('#') ? raw : `#${raw}`;
    return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : null;
  }

  function updateShapePatch(sourcePatch) {
    if (!shape) return;
    // Slope glyph pairs and locked angles cannot survive an appearance change.
    if (slopeLineLocked && ['channel', 'style', 'detail', 'boxStyle']
      .some((key) => Object.hasOwn(sourcePatch, key))) return;
    const requestedChannel = sourcePatch.channel || shape.channel || 'glyph';
    const requestedStyle = sourcePatch.style || shape.style || 'outline';
    const currentlyRestricted = shape.channel === 'background' ||
      shape.style === 'special' || shape.style === 'slope';
    const requestedRestricted = requestedChannel === 'background' ||
      requestedStyle === 'special' || requestedStyle === 'slope';
    const requestsWholeCells = sourcePatch.detail === 'cell' ||
      requestedChannel === 'background' ||
      requestedStyle === 'special' || requestedStyle === 'slope';
    if (shape.detail !== 'cell' && requestsWholeCells && !shapeCellDetailSafe) return;
    if (shapeHasAdvancedGeometry && !currentlyRestricted && requestedRestricted) return;
    const next = updateShapeAppearance(shape, sourcePatch);
    if (next.channel === 'glyph' && next.style !== 'special' && next.style !== 'slope' &&
      next.detail === 'cell') {
      next.wide = isWide(next.char);
      next.glyphWide = next.wide;
    }
    const constrained = constrainShape(next);
    if (shape.kind === 'line' && (constrained.style === 'special' || constrained.style === 'slope')) {
      next.x0 = constrained.x0;
      next.y0 = constrained.y0;
      next.x1 = constrained.x1;
      next.y1 = constrained.y1;
    }
    setShapeLayerProperties(activeLayer.id, next, renderShapeToCells);
  }

  function updateShape(key, value) {
    updateShapePatch({ [key]: value });
  }

  function updateShapeNumber(key, detail, min, max) {
    const value = Math.max(min, Math.min(max, Math.round(Number(detail.value) || min)));
    updateShape(key, value);
  }

  function beginShapePropertyScrub() {
    shapePropertyScrubShape = shape ? structuredClone(shape) : null;
    beginStroke();
  }

  function finishShapePropertyScrub(detail) {
    if (detail.source !== 'drag') return;
    shapePropertyScrubShape = null;
    endStroke();
  }

  function cancelShapePropertyScrub() {
    shapePropertyScrubShape = null;
    cancelStroke();
  }

  function updateLineStyle(event) {
    updateShapePatch(lineStylePatch(event.currentTarget.value));
  }

  function updatePolygonSides(detail) {
    if (!shape || !activeLayer || !polygonSidesEditable) return;
    const sides = Math.max(3, Math.min(64,
      Math.round(Number(detail.value) || 3)));
    const baseline = detail.source === 'drag' && shapePropertyScrubShape?.kind === 'polygon'
      ? shapePropertyScrubShape
      : shape;
    const edited = editPolygonSides(shape, sides, baseline);
    if (!edited) return;
    setShapePathById($activeFrameIndex, activeLayer.id, pathValueFromShape(edited));
  }

  function updateShapePathValue(key, detail) {
    if (!shape || !shapePath || !activeLayer) return;
    const dragging = detail.source === 'drag';
    if (!dragging) beginStroke();
    const value = key === 'w' || key === 'h'
      ? Math.max(1, detail.value)
      : detail.value;
    const nextPath = editShapePathField(
      shapePath,
      key,
      value,
      dragging ? shapePathScrub : null,
    );
    const changed = applyPanelShapePathEdit(nextPath);
    if (!dragging) {
      if (changed) endStroke();
      else cancelStroke();
    }
  }

  function applyPanelShapePathEdit(nextPath) {
    if (!nextPath || !activeLayer || !shape || !shapePath) return false;
    const currentShape = shapeForStaticPathEdit(shape, shapePath);
    const nextShape = shapeForStaticPathEdit(shape, nextPath);
    const enabledComponents = shapeComponents.filter((component) =>
      component.enabled && (shape.kind !== 'line' || component.type === 'vertex'));
    // Whole-Path edits must also update component tracks that would override them.
    if (shapePathAnimated && enabledComponents.length) {
      const changedWhole = setShapePathById(
        $activeFrameIndex,
        activeLayer.id,
        nextPath,
      );
      const changedComponents = setShapePathComponentValues(
        $activeFrameIndex,
        activeLayer.id,
        enabledComponents.map((component) => ({
          componentId: component.id,
          value: shapePathComponentValue(nextPath, component.id),
        })),
      );
      return changedWhole || changedComponents.length > 0;
    }
    return applyShapeGeometryEdit(
      activeLayer.id,
      $activeFrameIndex,
      nextShape,
      currentShape,
    );
  }

  function updateShapeAggregateValue(key, detail) {
    if (!shape || !shapePath || !shapeAggregate || !activeLayer) return;
    const dragging = detail.source === 'drag';
    if (!dragging) beginStroke();
    const value = key === 'w' || key === 'h'
      ? Math.max(1, detail.value)
      : detail.value;
    const nextPath = editShapePathAggregate(
      shapePath,
      key,
      value,
      dragging ? shapePathScrub : null,
    );
    const changed = applyPanelShapePathEdit(nextPath);
    if (!dragging) {
      if (changed) endStroke();
      else cancelStroke();
    }
  }

  function beginShapePathScrub() {
    shapePathScrub = shapePath ? { ...shapePath } : null;
    beginStroke();
  }

  function finishShapePathScrub(detail) {
    if (detail.source !== 'drag') return;
    shapePathScrub = null;
    endStroke();
  }

  function cancelShapePathScrub() {
    shapePathScrub = null;
    cancelStroke();
  }

  function toggleShapeComponentExpanded(componentId) {
    const next = new Set(expandedShapeComponents);
    if (next.has(componentId)) next.delete(componentId);
    else next.add(componentId);
    expandedShapeComponents = next;
  }

  function hoverShapeComponent(componentId) {
    shapeGeometryHover.set(componentId && activeLayer
      ? { layerId: activeLayer.id, componentId }
      : null);
  }

  function componentLabel(component) {
    if (shape?.kind === 'line' && component.type === 'vertex') {
      return component.index === 0 ? 'Start' : 'End';
    }
    return component.type === 'anchor' ? 'Anchor' : component.label;
  }

  function beginShapeComponentScrub() {
    shapeComponentScrubPath = shapePath ? structuredClone(shapePath) : null;
    beginStroke();
  }

  function updateShapeComponentValue(component, field, detail) {
    if (!activeLayer || !shape || !shapePath) return;
    const dragging = detail.source === 'drag';
    if (!dragging) beginStroke();
    const value = component.type === 'rotation'
      ? detail.value
      : { ...component.value, [field]: detail.value };
    let changed;
    if (component.type === 'anchor') {
      // Route through the transform path so a rotated shape stays fixed as its anchor moves.
      const sourcePath = dragging && shapeComponentScrubPath
        ? shapeComponentScrubPath
        : shapePath;
      const currentShape = shapeForStaticPathEdit(shape, sourcePath);
      const nextShape = shapeForAnchorComponentEdit(shape, sourcePath, value);
      changed = nextShape
        ? applyShapeGeometryEdit(
          activeLayer.id,
          $activeFrameIndex,
          nextShape,
          currentShape,
        )
        : false;
    } else {
      changed = setShapePathComponentValue(
        $activeFrameIndex,
        activeLayer.id,
        component.id,
        value,
      );
    }
    if (!dragging) {
      if (changed) endStroke();
      else cancelStroke();
    }
  }

  function finishShapeComponentScrub(detail) {
    if (detail.source !== 'drag') return;
    shapeComponentScrubPath = null;
    endStroke();
  }

  function cancelShapeComponentScrub() {
    shapeComponentScrubPath = null;
    cancelStroke();
  }

  function authoredPrecision(value) {
    if (Math.abs(value - Math.round(value)) < 1e-9) return 0;
    if (Math.abs(value * 2 - Math.round(value * 2)) < 1e-9) return 1;
    if (Math.abs(value * 4 - Math.round(value * 4)) < 1e-9) return 2;
    return 3;
  }

  function shapeCoordinatePrecision(component) {
    if (component.type === 'rotation') return 1;
    return Math.max(
      authoredPrecision(component.value.x),
      authoredPrecision(component.value.y),
      shapeGeometryStep < 1 ? 1 : 0,
    );
  }

  function updateColor(event) {
    const value = normalizedHex(event.currentTarget.value);
    if (!value) return;
    const target = $colorEditSession.target;
    if (target?.kind !== 'shape' || target.layerId !== activeLayer?.id) {
      colorEditSession.open(
        { kind: 'shape', layerId: activeLayer.id },
        pickerAnchor(event),
      );
    }
    colorEditSession.preview(value);
    colorEditSession.commit(value);
  }

  function resetInvalidShapeColor(event) {
    if (!normalizedHex(event.currentTarget.value)) {
      event.currentTarget.value = shape?.fg || '#ffffff';
    }
  }
</script>

{#if shape}
  {#if shapeCanFreeTransform && shape.kind === 'line' && shapePath &&
    linePathStart && linePathEnd}
    <div class="row animated-row">
      <span>Path</span>
      <button class:active={shapePathAnimated} class="track-button"
        disabled={!shapePathAnimationAvailable}
        onclick={() => setShapePathWholeTrackEnabled(activeLayer.id, !shapePathAnimated)}
        title={shapePathAnimationAvailable
          ? 'Animate start and end'
          : shapePathUnavailableHint}
        aria-label="Animate line start and end">
        <Icon icon="mdi:stopwatch-outline" width="15" />
      </button>
      <button class:keyed={shapePathKeyed} class="key-button"
        disabled={!shapePathAnimated || !shapePathAnimationAvailable}
        onclick={() => toggleShapePathWholeKey(activeLayer.id, $activeFrameIndex)}
        title="Add or remove start and end keyframe"
        aria-label="Add or remove line start and end keyframe">
        <span></span>
      </button>
    </div>
  {:else if shapeCanFreeTransform && shape.kind !== 'line' && shapeAggregate}
    <div class="shape-components">
      <div class="shape-component">
        <div class="row animated-row shape-component-summary">
          <button class="component-toggle"
            class:expanded={expandedShapeComponents.has('path')}
            onclick={() => toggleShapeComponentExpanded('path')}
            aria-expanded={expandedShapeComponents.has('path')}>
            <Icon icon="material-symbols:chevron-right" width="15" />
            <span>Path</span>
          </button>
          <button class:active={shapePathAnimated} class="track-button"
            disabled={!shapePathAnimationAvailable}
            onclick={() => setShapePathWholeTrackEnabled(activeLayer.id, !shapePathAnimated)}
            title={shapePathAnimationAvailable
              ? 'Animate center and size'
              : shapePathUnavailableHint}
            aria-label="Animate shape center and size">
            <Icon icon="mdi:stopwatch-outline" width="15" />
          </button>
          <button class:keyed={shapePathKeyed} class="key-button"
            disabled={!shapePathAnimated || !shapePathAnimationAvailable}
            onclick={() => toggleShapePathWholeKey(activeLayer.id, $activeFrameIndex)}
            title="Add or remove center and size keyframe"
            aria-label="Add or remove shape center and size keyframe">
            <span></span>
          </button>
        </div>
        {#if expandedShapeComponents.has('path')}
          <div class="row shape-coordinate-row component-values">
            <span>Center</span>
            <span class="number-value compact">
              X
              <NumberField ariaLabel="Shape center X" step={shapeCenterStep}
                precision={Math.max(shapeCenterPrecision,
                  authoredPrecision(shapeAggregate.cx))} value={shapeAggregate.cx}
                onScrubStart={beginShapePathScrub}
                onInput={(detail) => updateShapeAggregateValue('cx', detail)}
                onChange={finishShapePathScrub}
                onScrubCancel={cancelShapePathScrub} />
            </span>
            <span class="number-value compact">
              Y
              <NumberField ariaLabel="Shape center Y" step={shapeCenterStep}
                precision={Math.max(shapeCenterPrecision,
                  authoredPrecision(shapeAggregate.cy))} value={shapeAggregate.cy}
                onScrubStart={beginShapePathScrub}
                onInput={(detail) => updateShapeAggregateValue('cy', detail)}
                onChange={finishShapePathScrub}
                onScrubCancel={cancelShapePathScrub} />
            </span>
          </div>
          <div class="row shape-coordinate-row component-values">
            <span>Size</span>
            <span class="number-value compact">
              W
              <NumberField ariaLabel="Shape width" min={1} step={shapeGeometryStep}
                precision={Math.max(shapeGeometryStep < 1 ? 1 : 0,
                  authoredPrecision(shapeAggregate.w))} value={shapeAggregate.w}
                onScrubStart={beginShapePathScrub}
                onInput={(detail) => updateShapeAggregateValue('w', detail)}
                onChange={finishShapePathScrub}
                onScrubCancel={cancelShapePathScrub} />
            </span>
            <span class="number-value compact">
              H
              <NumberField ariaLabel="Shape height" min={1} step={shapeGeometryStep}
                precision={Math.max(shapeGeometryStep < 1 ? 1 : 0,
                  authoredPrecision(shapeAggregate.h))} value={shapeAggregate.h}
                onScrubStart={beginShapePathScrub}
                onInput={(detail) => updateShapeAggregateValue('h', detail)}
                onChange={finishShapePathScrub}
                onScrubCancel={cancelShapePathScrub} />
            </span>
          </div>
        {/if}
      </div>
    </div>
  {:else if !shapeCanFreeTransform || legacyShapePathKeys.length}
    <div class="row animated-row">
      <span>Path</span>
      <button class:active={shapePathAnimated} class="track-button"
        disabled={!shapePathAnimationAvailable}
        onclick={() => setShapePathWholeTrackEnabled(activeLayer.id, !shapePathAnimated)}
        title={shapePathAnimationAvailable
          ? 'Animate shape path'
          : shapePathUnavailableHint}
        aria-label="Animate shape path">
        <Icon icon="mdi:stopwatch-outline" width="15" />
      </button>
      <button class:keyed={shapePathKeyed} class="key-button"
        disabled={!shapePathAnimated || !shapePathAnimationAvailable}
        onclick={() => toggleShapePathWholeKey(activeLayer.id, $activeFrameIndex)}
        title="Add or remove shape path keyframe"
        aria-label="Add or remove shape path keyframe">
        <span></span>
      </button>
    </div>
  {/if}

  {#if shapeCanFreeTransform}
    <div class="shape-components">
      {#each shapeComponents as component (component.id)}
        <div class="shape-component"
          role="group" aria-label={`${componentLabel(component)} controls`}
          onmouseenter={() => hoverShapeComponent(component.id)}
          onmouseleave={() => hoverShapeComponent(null)}>
          <div class="row animated-row shape-component-summary">
            <button class="component-toggle"
              class:expanded={expandedShapeComponents.has(component.id)}
              onclick={() => toggleShapeComponentExpanded(component.id)}
              aria-expanded={expandedShapeComponents.has(component.id)}>
              <Icon icon="material-symbols:chevron-right" width="15" />
              <span>{componentLabel(component)}</span>
            </button>
            <button class:active={component.enabled} class="track-button"
              disabled={!shapePathAnimationAvailable}
              onclick={() => setShapePathComponentTrackEnabled(activeLayer.id, component.id, !component.enabled)}
              title={shapePathAnimationAvailable
                ? `Animate ${componentLabel(component).toLowerCase()}`
                : shapePathUnavailableHint}
              aria-label={`Animate ${componentLabel(component).toLowerCase()}`}>
              <Icon icon="mdi:stopwatch-outline" width="15" />
            </button>
            <button class:keyed={component.keyed} class="key-button"
              disabled={!component.enabled || !shapePathAnimationAvailable}
              onclick={() => toggleShapePathComponentKey(activeLayer.id, component.id, $activeFrameIndex)}
              title={`Add or remove ${componentLabel(component).toLowerCase()} keyframe`}
              aria-label={`Add or remove ${componentLabel(component).toLowerCase()} keyframe`}>
              <span></span>
            </button>
          </div>
          {#if expandedShapeComponents.has(component.id)}
            {#if component.type === 'rotation'}
              <div class="row shape-coordinate-row component-values">
                <span>Degrees</span>
                <span class="number-value compact">
                  <NumberField ariaLabel="Shape rotation" step={0.1} precision={1}
                    value={component.value}
                    onScrubStart={beginShapeComponentScrub}
                    onInput={(detail) => updateShapeComponentValue(component, null, detail)}
                    onChange={finishShapeComponentScrub}
                    onScrubCancel={cancelShapeComponentScrub} />
                </span>
              </div>
            {:else}
              <div class="row shape-coordinate-row component-values">
                <span>Position</span>
                <span class="number-value compact">
                  X
                  <NumberField ariaLabel={`${componentLabel(component)} X`}
                    step={shapeGeometryStep} precision={shapeCoordinatePrecision(component)}
                    value={component.value.x}
                    onScrubStart={beginShapeComponentScrub}
                    onInput={(detail) => updateShapeComponentValue(component, 'x', detail)}
                    onChange={finishShapeComponentScrub}
                    onScrubCancel={cancelShapeComponentScrub} />
                </span>
                <span class="number-value compact">
                  Y
                  <NumberField ariaLabel={`${componentLabel(component)} Y`}
                    step={shapeGeometryStep} precision={shapeCoordinatePrecision(component)}
                    value={component.value.y}
                    onScrubStart={beginShapeComponentScrub}
                    onInput={(detail) => updateShapeComponentValue(component, 'y', detail)}
                    onChange={finishShapeComponentScrub}
                    onScrubCancel={cancelShapeComponentScrub} />
                </span>
              </div>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  {:else if shapePath}
    {#if shape.kind === 'line'}
      <div class="row shape-coordinate-row">
        <span>Start</span>
        <span class="number-value compact">
          X
          <NumberField ariaLabel="Line start X" step={shapeGeometryStep}
            precision={shapeGeometryStep < 1 ? 1 : 0} value={linePathStart.x}
            onScrubStart={beginShapePathScrub}
            onInput={(detail) => updateShapePathValue('x0', detail)}
            onChange={finishShapePathScrub} onScrubCancel={cancelShapePathScrub} />
        </span>
        <span class="number-value compact">
          Y
          <NumberField ariaLabel="Line start Y" step={shapeGeometryStep}
            precision={shapeGeometryStep < 1 ? 1 : 0} value={linePathStart.y}
            onScrubStart={beginShapePathScrub}
            onInput={(detail) => updateShapePathValue('y0', detail)}
            onChange={finishShapePathScrub} onScrubCancel={cancelShapePathScrub} />
        </span>
      </div>
      <div class="row shape-coordinate-row">
        <span>End</span>
        <span class="number-value compact">
          X
          <NumberField ariaLabel="Line end X" step={shapeGeometryStep}
            precision={shapeGeometryStep < 1 ? 1 : 0} value={linePathEnd.x}
            onScrubStart={beginShapePathScrub}
            onInput={(detail) => updateShapePathValue('x1', detail)}
            onChange={finishShapePathScrub} onScrubCancel={cancelShapePathScrub} />
        </span>
        <span class="number-value compact">
          Y
          <NumberField ariaLabel="Line end Y" step={shapeGeometryStep}
            precision={shapeGeometryStep < 1 ? 1 : 0} value={linePathEnd.y}
            onScrubStart={beginShapePathScrub}
            onInput={(detail) => updateShapePathValue('y1', detail)}
            onChange={finishShapePathScrub} onScrubCancel={cancelShapePathScrub} />
        </span>
      </div>
    {:else}
      <div class="row shape-coordinate-row">
        <span>Center</span>
        <span class="number-value compact">
          X
          <NumberField ariaLabel="Shape center X" step={shapeCenterStep}
            precision={shapeCenterPrecision} value={shapePath.cx}
            onScrubStart={beginShapePathScrub}
            onInput={(detail) => updateShapePathValue('cx', detail)}
            onChange={finishShapePathScrub} onScrubCancel={cancelShapePathScrub} />
        </span>
        <span class="number-value compact">
          Y
          <NumberField ariaLabel="Shape center Y" step={shapeCenterStep}
            precision={shapeCenterPrecision} value={shapePath.cy}
            onScrubStart={beginShapePathScrub}
            onInput={(detail) => updateShapePathValue('cy', detail)}
            onChange={finishShapePathScrub} onScrubCancel={cancelShapePathScrub} />
        </span>
      </div>
      <div class="row shape-coordinate-row">
        <span>Size</span>
        <span class="number-value compact">
          W
          <NumberField ariaLabel="Shape width" min={1} step={shapeGeometryStep}
            precision={shapeGeometryStep < 1 ? 1 : 0} value={shapePath.w}
            onScrubStart={beginShapePathScrub}
            onInput={(detail) => updateShapePathValue('w', detail)}
            onChange={finishShapePathScrub} onScrubCancel={cancelShapePathScrub} />
        </span>
        <span class="number-value compact">
          H
          <NumberField ariaLabel="Shape height" min={1} step={shapeGeometryStep}
            precision={shapeGeometryStep < 1 ? 1 : 0} value={shapePath.h}
            onScrubStart={beginShapePathScrub}
            onInput={(detail) => updateShapePathValue('h', detail)}
            onChange={finishShapePathScrub} onScrubCancel={cancelShapePathScrub} />
        </span>
      </div>
    {/if}
  {/if}

  {#if shape.kind !== 'polygon'}
    <label class="row">
      <span>Channel</span>
      <select value={shape.channel || 'glyph'} disabled={slopeLineLocked}
        onchange={(event) => updateShape('channel', event.currentTarget.value)}>
        <option value="glyph">Glyph</option>
        <option value="background"
          disabled={(shapeHasAdvancedGeometry || shapeCellDetailBlocked) &&
            shape.channel !== 'background'}>Background</option>
      </select>
    </label>
  {/if}

  {#if shape.kind === 'polygon'}
    <div class="row">
      <span>Sides</span>
      <NumberField ariaLabel="Polygon sides" min={3} max={64} value={polygonSides}
        disabled={!polygonSidesEditable}
        title={polygonSidesEditable ? 'Polygon sides' :
          'Sides are fixed while geometry is animated'}
        onScrubStart={beginShapePropertyScrub}
        onInput={updatePolygonSides}
        onChange={finishShapePropertyScrub}
        onScrubCancel={cancelShapePropertyScrub} />
    </div>
    {#if !polygonSidesEditable}
      <div class="hint">Sides are fixed while geometry is animated.</div>
    {/if}
  {/if}

  {#if shape.kind === 'rect' || shape.kind === 'circle' || shape.kind === 'polygon'}
    <label class="row">
      <span>Style</span>
      <select value={shape.style || 'outline'} onchange={(event) => updateShape('style', event.currentTarget.value)}>
        <option value="outline">Outline</option>
        <option value="filled">Filled</option>
        {#if shape.kind !== 'polygon' && shape.channel !== 'background'}
          <option value="special"
            disabled={(shapeHasAdvancedGeometry || shapeCellDetailBlocked) &&
              shape.style !== 'special'}>Special</option>
        {/if}
      </select>
    </label>
  {/if}

  {#if shape.kind === 'line' && shape.channel !== 'background'}
    <label class="row">
      <span>Style</span>
      <select class="shape-glyph-select" value={lineStyleValue(shape)}
        style="font-family: {$canvasFont};" disabled={slopeLineLocked}
        aria-label="Line style" onchange={updateLineStyle}>
        <option value="cell" disabled={shapeCellDetailBlocked}>{shape.char}</option>
        <option value="half">▀</option>
        <option value="quarter">▚</option>
        {#each LINE_BOX_STYLE_OPTIONS as choice}
          <option value={`special:${choice.value}`}
            disabled={(shapeHasAdvancedGeometry || shapeCellDetailBlocked) &&
              shape.style !== 'special'}>{choice.swatch}</option>
        {/each}
        <option value="slope"
          title="Diagonal triangles"
          disabled={(shapeHasAdvancedGeometry || shapeCellDetailBlocked) &&
            shape.style !== 'slope'}>{SLOPE_GLYPHS.rising.join('')}</option>
      </select>
    </label>
  {/if}

  {#if (shape.kind === 'rect' || shape.kind === 'circle') && shape.style === 'special' && shape.channel !== 'background'}
    <div class="row">
      <span>Border</span>
      <div class="shape-style-seg">
        {#each BOX_STYLE_OPTIONS as choice}
          <button class:active={(shape.boxStyle || 'single') === choice.value}
            title={choice.label} aria-label={choice.label}
            onclick={() => updateShape('boxStyle', choice.value)}>{choice.swatch}</button>
        {/each}
      </div>
    </div>
  {/if}

  {#if shape.channel !== 'background' && shape.kind !== 'line' && shape.style !== 'special'}
    <label class="row">
      <span>Detail</span>
      <select class="shape-glyph-select" value={shape.detail || 'cell'}
        style="font-family: {$canvasFont};"
        onchange={(event) => updateShape('detail', event.currentTarget.value)}>
        <option value="cell" disabled={shapeCellDetailBlocked}>{shape.char}</option>
        <option value="half">▀</option>
        <option value="quarter">▚</option>
      </select>
    </label>
  {/if}
  {#if shapeCellDetailBlocked}
    <div class="hint">Cell detail needs static, whole-cell handles.</div>
  {/if}

  {#if shapeStrokeEditable}
    <div class="row">
      <span>Thickness</span>
      <NumberField ariaLabel="Stroke thickness" min={1} max={64} value={shape.thickness || 1}
        onScrubStart={beginShapePropertyScrub}
        onInput={(detail) => updateShapeNumber('thickness', detail, 1, 64)}
        onChange={finishShapePropertyScrub}
        onScrubCancel={cancelShapePropertyScrub} />
    </div>
    <label class="row">
      <span>Stroke</span>
      <select value={shape.strokeAlign || 'center'}
        onchange={(event) => updateShape('strokeAlign', event.currentTarget.value)}>
        <option value="center">Middle</option>
        <option value="inside">Inwards</option>
        <option value="outside">Outwards</option>
      </select>
    </label>
  {/if}

  <div class="row">
    <span>Color</span>
    <input class="hex shape-color-control" value={shape.fg || '#ffffff'} maxlength="7"
      aria-label="Shape color"
      oninput={updateColor} onchange={resetInvalidShapeColor} />
    <button class="swatch shape-color-control" style="background: {shape.fg}"
      onclick={openShapePicker} aria-label="Shape color" title="Choose color"></button>
  </div>
{/if}

<style>
  :global(.properties.playback-locked) .row { opacity: 0.45; }
  .row { display: flex; align-items: center; gap: 7px; min-height: 27px; padding: 2px 10px; font-size: 11px; }
  .row > span:first-child { width: 60px; flex-shrink: 0; color: var(--text-dim); }
  .row select, .row .hex {
    min-width: 0; height: 22px; flex: 1; padding: 2px 5px;
    background: var(--canvas-bg); color: var(--text);
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    font: inherit; line-height: 1.2; color-scheme: dark;
  }
  .row select:disabled { opacity: 0.4; cursor: not-allowed; }
  .number-value { display: flex; align-items: center; gap: 3px; margin-left: auto; color: var(--text-dim); }
  .number-value :global(.number-field) { width: 52px; text-align: right; }
  .hex { font-family: var(--font-mono); }
  .swatch { width: 22px; height: 22px; flex-shrink: 0; border: 1px solid var(--border); border-radius: 3px; }
  .shape-style-seg {
    min-width: 0; flex: 1; display: flex;
    border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden;
  }
  .shape-style-seg button {
    min-width: 0; height: 22px; flex: 1; padding: 1px 2px;
    background: var(--panel); color: var(--text-dim);
    border: none; border-right: 1px solid var(--border);
    font-family: var(--font-mono); font-size: 12px; line-height: 1;
  }
  .shape-style-seg button:last-child { border-right: 0; }
  .shape-style-seg button.active { background: var(--accent-dim); color: var(--on-accent); }
  .hint { padding: 12px 10px; color: var(--text-dim); font-size: 11px; }
  .animated-row > span:first-child { width: 48px; }
  .shape-components { border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .shape-component + .shape-component { border-top: 1px solid var(--border); }
  .shape-component:hover { background: color-mix(in srgb, var(--accent) 5%, transparent); }
  .shape-component-summary { padding-left: 5px; }
  .component-toggle {
    min-width: 0; flex: 1; height: 22px; padding: 0 2px;
    display: flex; align-items: center; gap: 2px;
    color: var(--text); background: transparent; border: 0; font: inherit;
    text-align: left;
  }
  .component-toggle :global(svg) { flex: 0 0 auto; transition: transform 100ms ease; }
  .component-toggle.expanded :global(svg) { transform: rotate(90deg); }
  .component-toggle span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .component-values { padding-left: 18px; padding-bottom: 5px; }
  .shape-coordinate-row > span:first-child { width: 48px; }
  .shape-coordinate-row .number-value {
    min-width: 0; flex: 1; margin-left: 0;
  }
  .shape-coordinate-row .number-value :global(.number-field) {
    min-width: 0; width: 100%;
  }
  .track-button, .key-button {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; flex: 0 0 20px; padding: 0;
    color: var(--text-dim); background: transparent; border-color: transparent;
  }
  .track-button.active { color: var(--accent); }
  .key-button span {
    width: 8px; height: 8px; border: 1px solid currentColor;
    transform: rotate(45deg);
  }
  .key-button.keyed { color: var(--accent); }
  .key-button.keyed span { background: currentColor; }
  .track-button:disabled, .key-button:disabled {
    opacity: 0.3; color: var(--text-dim);
  }
  select:disabled { opacity: 0.4; }
</style>
