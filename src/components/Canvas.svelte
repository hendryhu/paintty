<script module>
  const CANVAS_OVERSCAN = 2;
  const canvasDimensionAdapters = new WeakMap();

  function finiteCanvasNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function visibleCanvasViewport(viewportSize, documentSize, cellSize, pan, overscan = CANVAS_OVERSCAN) {
    const viewportW = Math.max(1, finiteCanvasNumber(viewportSize?.w, 1));
    const viewportH = Math.max(1, finiteCanvasNumber(viewportSize?.h, 1));
    const documentW = Math.max(1, finiteCanvasNumber(documentSize?.w, 1));
    const documentH = Math.max(1, finiteCanvasNumber(documentSize?.h, 1));
    const cellW = Math.max(1, finiteCanvasNumber(cellSize?.w, 1));
    const cellH = Math.max(1, finiteCanvasNumber(cellSize?.h, 1));
    const extra = Math.max(0, Math.floor(finiteCanvasNumber(overscan, CANVAS_OVERSCAN)));
    const originX = (viewportW - documentW * cellW) / 2 + finiteCanvasNumber(pan?.x, 0);
    const originY = (viewportH - documentH * cellH) / 2 + finiteCanvasNumber(pan?.y, 0);
    const x = Math.floor(-originX / cellW) - extra;
    const y = Math.floor(-originY / cellH) - extra;
    const right = Math.ceil((viewportW - originX) / cellW) + extra;
    const bottom = Math.ceil((viewportH - originY) / cellH) + extra;
    return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
  }

  function incrementCanvasMetric(canvas, key) {
    if (!canvas.dataset) return;
    canvas.dataset[key] = String((Number(canvas.dataset[key]) || 0) + 1);
  }

  function assignCanvasDimension(canvas, dimension, value) {
    const next = Math.max(0, Math.round(finiteCanvasNumber(value, 0)));
    if (canvas[dimension] === next) return false;
    canvas[dimension] = next;
    incrementCanvasMetric(canvas, dimension === 'width' ? 'widthAssignments' : 'heightAssignments');
    return true;
  }

  function setCanvasPixelStyle(canvas, property, value) {
    if (!canvas.style) return;
    const next = `${value}px`;
    if (canvas.style[property] !== next) canvas.style[property] = next;
  }

  function sizeCanvasBacking(canvas, cssWidth, cssHeight, dpr = 1) {
    const width = Math.max(0, finiteCanvasNumber(cssWidth, 0));
    const height = Math.max(0, finiteCanvasNumber(cssHeight, 0));
    const ratio = Math.max(0.01, finiteCanvasNumber(dpr, 1));
    const widthChanged = assignCanvasDimension(canvas, 'width', Math.max(1, Math.round(width * ratio)));
    const heightChanged = assignCanvasDimension(canvas, 'height', Math.max(1, Math.round(height * ratio)));
    setCanvasPixelStyle(canvas, 'width', width);
    setCanvasPixelStyle(canvas, 'height', height);
    if (widthChanged || heightChanged) incrementCanvasMetric(canvas, 'backingResizes');
    return {
      resized: widthChanged || heightChanged,
      cssWidth: width,
      cssHeight: height,
      width: canvas.width,
      height: canvas.height,
    };
  }

  function layoutViewportCanvas(canvas, viewport, cellSize, dpr) {
    const cssWidth = viewport.w * cellSize.w;
    const cssHeight = viewport.h * cellSize.h;
    const layout = sizeCanvasBacking(canvas, cssWidth, cssHeight, dpr);
    setCanvasPixelStyle(canvas, 'left', viewport.x * cellSize.w);
    setCanvasPixelStyle(canvas, 'top', viewport.y * cellSize.h);
    return layout;
  }

  function canvasWithStableDimensions(canvas) {
    let adapter = canvasDimensionAdapters.get(canvas);
    if (adapter) return adapter;
    adapter = {
      get width() { return canvas.width; },
      set width(value) { assignCanvasDimension(canvas, 'width', value); },
      get height() { return canvas.height; },
      set height(value) { assignCanvasDimension(canvas, 'height', value); },
      style: canvas.style,
      getContext(...args) { return canvas.getContext(...args); },
    };
    canvasDimensionAdapters.set(canvas, adapter);
    return adapter;
  }
</script>

<script>
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { captureProjectRevision, onProjectReplaced } from '../lib/documentLifecycle.js';
  import { get } from 'svelte/store';
  import { isTopPopup, popupFocus, popupOpen } from '../lib/popupFocus.js';
  import {
    getKeyboardContext,
    noteKeyboardContext,
    planSelectionDeselect,
    releaseKeyboardContext,
    setKeyboardContext,
  } from '../lib/timelineKeys.js';
  import { activeTool, activeChar, paintColor, colorDepth, BRUSH_TOOLS, toolOptions, altEyedrop, dirty, fileName, shapeGeometryHover } from '../lib/stores.js';
  import { documentLabel } from '../lib/documentState.js';
  import { grid, dims, layers, inBounds, beginStroke, endStroke, cancelStroke,
           createTextLayer, updateTextLayer, createShapeLayer, createPaintLayer, updateShapeLayer,
           getLayer, getCell, getComposited, activeLayerId, activeLayerPart, selectLayer, setLayerOffsetDirect, setCells,
           translateLayerCells, setEffectMaskOffsetDirect, groupOf, effOffset, effVisible, layerBox, applyBlinkPhase, compositeWorld,
           hasVisibleBlinkingGlyph,
           cropPending, isBackgroundLayer, isEditingEffectMask, noteAuthoredMutation } from '../lib/grid.js';
  import {
    applyTool,
    displayedSampleCell,
    paintSpecialBrushPath,
    previewSpecialBrushGlyph,
    visibleColorFromCell,
  } from '../lib/tools.js';
  import {
    BOX_STYLES,
    maskShapeAppearance,
    constrainShape,
    hasShapeExtent,
    regularPolygonVertices,
    resolvedShapeAnchor,
    resolvedShapeVertices,
    shapeGlyphs,
    renderShapeToCells,
    linePoints,
  } from '../lib/shapes.js';
  import { canvasFont } from '../lib/font.js';
  import { nearest256 } from '../lib/color.js';
  import { layoutText, remapTextColorRuns, renderTextToCells, textLayoutColumns } from '../lib/textLayer.js';
  import { clearTextSelection, createControlledTextHistory, rememberTextSelection } from '../lib/textEditing.js';
  import {
    beginTextGesture,
    moveTextGesture,
    resolveTextGesture,
    textGestureBox,
    textGestureSelection,
    textLayerHasGlyph,
    textLayerAt,
  } from '../lib/textHitTest.js';
  import { canvasCrop, cropDiffers, dragCrop } from '../lib/crop.js';
  import { canvasCoordinates } from '../lib/canvasCoordinates.js';
  import {
    isToolDisabledForLayer,
    paintOwnerCreatedNotice,
    paintOwnerDisposition,
  } from '../lib/toolAvailability.js';
  import { notifyInfo } from '../lib/notifications.js';
  import { bitsForStroke, applySubcell } from '../lib/subcell.js';
  import { isWide } from '../lib/width.js';
  import { selection, isSelected, applyRegion, selectionModeForModifiers,
           moveState, beginMove, beginTransformSelection, updateMove, updateTransformBounds,
           finalizeMove, cancelMove, minimumTransformWidth, transformBoundsFromDrag,
           TRANSFORM_HANDLES,
           selectionToNewLayer, clearSelection, key as selectionKey } from '../lib/selection.js';
  import { metricsForCellWidth, drawGrid, drawGlyph, drawOnionCells } from '../lib/render.js';
  import { readThemeColor } from '../lib/themeColors.js';
  import { normalizeOutputGrid } from '../lib/outputGrid.js';
  import {
    frames, activeFrameIndex, activeFrameTick, playheadTick, fps, onionSkin, compositeFrameCells, playing, anyPosKeys,
    cropTimeline, setLayerOffsetById, isMaskPositionTrackEnabled, setMaskPositionById,
    isShapePathTrackEnabled, shapePathAt,
  } from '../lib/frames.js';
  import {
    findActiveTimelineClip,
    getClipTimelineState,
  } from '../lib/clipTimelineState.js';
  import {
    videoDecodeRequests,
    syncVideoLayerFrames,
    videoFrameRevision,
    videoRasterStatus,
    videoStateAtTick,
  } from '../lib/video.js';
  import {
    releaseVisibleMediaResources,
    syncVisibleMediaResources,
    visualMediaRequestRevision,
  } from '../lib/mediaRuntime.js';
  import { colorEditSession } from '../lib/colorEditSession.js';
  import {
    applyShapeGeometryEdit,
    applyShapeBodyDrag,
    blankShapeLayerAcceptsKind,
    captureShapeBodyDrag,
    shapeDirectEditTarget,
  } from '../lib/shapeBodyDrag.js';
  import { pathValueFromShape, shapePathEqual } from '../lib/shapePath.js';
  import {
    pickShapeTransformHandle,
    shapeHandleDragTarget,
    shapeTransformCageVertices,
    shapeTransformHandles,
    transformShapeFromCageHandle,
    transformShapeFromHandle,
  } from '../lib/shapeTransform.js';
  import {
    applyRasterBodyDrag,
    captureRasterBodyDrag,
    rasterBodyDelta,
  } from '../lib/rasterBodyDrag.js';
  import {
    rasterDisplayGeometry,
    rasterLayerSourceSize,
  } from '../lib/layerPosition.js';
  import {
    captureGestureOwner,
    canvasEscapeAction,
    canvasPointerStartsPan,
    gestureOwnerMatches,
    gesturePointerMatches,
    moveToolChangeAction,
  } from '../lib/gestureOwnership.js';

  // App mounts <Canvas /> without data props and coordinates crop through the
  // window events below. Keep the former bubbled pointer callback explicit.
  let { onpointerdown } = $props();


  function disp(hex) {
    if (!hex) return hex;
    return $colorDepth === '256' ? nearest256(hex).hex : hex;
  }

  function blankShapeAcceptsTool(layer, tool, drag, frame) {
    const pathEnabled = layer?.type === 'shape' && isShapePathTrackEnabled(layer.id);
    const ownerActive = layer?.id != null &&
      !!findActiveTimelineClip(getClipTimelineState(), layer.id, frame);
    return blankShapeLayerAcceptsKind(
      layer,
      pathEnabled,
      pathEnabled ? shapePathAt(layer.id, frame)?.kind : null,
      shapeSpec(tool, drag).kind,
      ownerActive,
    );
  }

  const ZOOM_STEPS = [8, 11, 14, 18, 24, 32, 44, 60];
  let zoomIdx = $state(3);
  function zoomIn() { zoomIdx = Math.min(ZOOM_STEPS.length - 1, zoomIdx + 1); }
  function zoomOut() { zoomIdx = Math.max(0, zoomIdx - 1); }
  function onWheel(e) { if (!e.ctrlKey) return; e.preventDefault(); if (e.deltaY < 0) zoomIn(); else zoomOut(); }
  function fitToViewport() {
    const wrap = canvasWrapEl?.getBoundingClientRect(); if (!wrap) return;
    const pad = 24;
    let best = 0;
    for (let i = 0; i < ZOOM_STEPS.length; i++) {
      const m = metricsForCellWidth($canvasFont, ZOOM_STEPS[i]);
      if (W * m.cellW <= wrap.width - pad && H * m.cellH <= wrap.height - pad) best = i;
    }
    zoomIdx = best;
    pan = { x: 0, y: 0 };
  }
  let lastFitDims = $state('');

  let pan = $state({ x: 0, y: 0 });
  let spaceHeld = $state(false);
  let panning = $state(null);
  function onPanKeyDown(e) {
    if (e.code !== 'Space' || isTypingTarget(e.target) || get(popupOpen) ||
      getKeyboardContext() === 'timeline') return;
    e.preventDefault();
    if (e.target instanceof HTMLElement) e.target.blur();
    spaceHeld = true;
  }
  function onPanKeyUp(e) {
    if (e.code !== 'Space' || isTypingTarget(e.target) || get(popupOpen) ||
      (getKeyboardContext() === 'timeline' && !spaceHeld)) return;
    e.preventDefault();
    spaceHeld = false;
  }
  function isTypingTarget(t) { return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); }
  function beginPan(e) {
    const pointerId = e.pointerId;
    const state = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y };
    panning = state;
    trackWindowDrag(pointerId, (event) => {
      pan = { x: state.px + event.clientX - state.sx, y: state.py + event.clientY - state.sy };
    }, () => { panning = null; }, { owned: false });
  }

  let metrics = $state({ cellW: 11, cellH: 22, baseline: 17, fontPx: 18, advance: 11 });
  let fontReady = $state(false);
  function remeasure() {
    metrics = metricsForCellWidth($canvasFont, targetW);
    const root = document.documentElement.style;
    root.setProperty('--cell-w', `${metrics.cellW}px`);
    root.setProperty('--cell-h', `${metrics.cellH}px`);
    root.setProperty('--cell-fontpx', `${metrics.fontPx}px`);
    root.setProperty('--cell-baseline', `${metrics.baseline}px`);
    redraw();
  }

  let canvasEl = $state();
  let hoverCanvasEl = $state();
  let imageCanvasEl = $state();
  function drawImages() {
    if (!imageCanvasEl) return;
    const w = W * metrics.cellW, h = H * metrics.cellH;
    sizeCanvasBacking(imageCanvasEl, w, h, canvasDpr);
    const ctx = imageCanvasEl.getContext('2d');
    ctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (let i = $layers.length - 1; i >= 0; i--) {
      const L = $layers[i];
      if ((L.type !== 'image' && L.type !== 'video') || !L.raster || !effVisible($layers, L)) continue;
      if (L.type === 'video' && !videoStateAtTick(L.videoClip, $playheadTick, $fps).active) continue;
      if (L.type === 'video' && $videoRasterStatus.get(L.id)?.state === 'error') continue;
      const geometry = rasterDisplayGeometry($layers, L, { w: W, h: H });
      if (!geometry) continue;
      const cxpx = geometry.x * metrics.cellW;
      const cypx = geometry.y * metrics.cellH;
      ctx.save();
      ctx.globalAlpha = geometry.opacity;
      ctx.translate(cxpx, cypx);
      ctx.rotate(geometry.rot * Math.PI / 180);
      const sx = geometry.scaleX * metrics.cellW;
      const sy = geometry.scaleY * (metrics.cellH / 2);
      ctx.scale(sx, sy);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(L.raster, -L.raster.width / 2, -L.raster.height / 2);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
  let blinkOn = $state(true);
  function redraw() {
    if (!canvasEl) return;
    drawGrid(canvasWithStableDimensions(canvasEl), visibleGrid, metrics, {
      fontFamily: $canvasFont,
      disp,
      canvasBg: readThemeColor('--canvas-bg', canvasEl),
      fillBg: false, // Preserve image layers below terminal cells.
    });
  }

  let canvasViewportSize = $state({ w: 1, h: 1 });
  let canvasDpr = $state(1);

  function updateCanvasViewportState() {
    const rect = canvasWrapEl?.getBoundingClientRect();
    if (rect) {
      const next = { w: Math.max(1, rect.width), h: Math.max(1, rect.height) };
      if (next.w !== canvasViewportSize.w || next.h !== canvasViewportSize.h) canvasViewportSize = next;
    }
    const nextDpr = Math.max(0.01, window.devicePixelRatio || 1);
    if (nextDpr !== canvasDpr) canvasDpr = nextDpr;
  }

  let worldCanvasEl = $state();
  function drawWorld() {
    if (!worldCanvasEl) return;
    const vp = canvasViewport;
    const cells = applyBlinkPhase(normalizeOutputGrid(
      compositeWorld($layers, vp, { x: 0, y: 0, w: W, h: H }),
      vp.w,
      vp.h,
    ), blinkOn);
    const { cssWidth: pw, cssHeight: ph } = layoutViewportCanvas(
      worldCanvasEl,
      vp,
      { w: metrics.cellW, h: metrics.cellH },
      canvasDpr,
    );
    const ctx = worldCanvasEl.getContext('2d');
    ctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    ctx.font = `${metrics.fontPx}px ${$canvasFont}`;
    ctx.globalAlpha = 0.28;
    for (let y = 0; y < vp.h; y++) for (let x = 0; x < vp.w; x++) {
      const c = cells[y][x]; if (!c || !c.offCanvas) continue;
      if (c.bg) { ctx.fillStyle = disp(c.bg); ctx.fillRect(x * metrics.cellW, y * metrics.cellH, metrics.cellW, metrics.cellH); }
      if (c.c) drawGlyph(ctx, c.c, disp(c.fg) || '#fff', x, y, metrics);
    }
    ctx.globalAlpha = 1;
  }

  function drawHover() {
    if (!hoverCanvasEl) return;
    const vp = canvasViewport;
    const { cssWidth: w, cssHeight: h } = layoutViewportCanvas(
      hoverCanvasEl,
      vp,
      { w: metrics.cellW, h: metrics.cellH },
      canvasDpr,
    );
    const ctx = hoverCanvasEl.getContext('2d');
    ctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!hover) return;
    const x = hover.x - vp.x, y = hover.y - vp.y;
    if (x < 0 || y < 0 || x >= vp.w || y >= vp.h) return;
    if (editingEffectMask) {
      ctx.fillStyle = $activeTool === 'eraser' ? '#000000' : disp($paintColor);
      ctx.fillRect(x * metrics.cellW, y * metrics.cellH, metrics.cellW, metrics.cellH);
      return;
    }
    if (activeBackground) {
      ctx.fillStyle = disp($paintColor);
      ctx.fillRect(x * metrics.cellW, y * metrics.cellH, metrics.cellW, metrics.cellH);
      return;
    }
    if (!hover.char) return;
    ctx.font = `${metrics.fontPx}px ${$canvasFont}`;
    drawGlyph(ctx, hover.char, disp($paintColor), x, y, metrics);
  }

  const ONION_DEPTH = 2;
  let onionCanvasEl = $state();
  function drawOnion() {
    if (!onionCanvasEl) return;
    const w = W * metrics.cellW, h = H * metrics.cellH;
    sizeCanvasBacking(onionCanvasEl, w, h, canvasDpr);
    const ctx = onionCanvasEl.getContext('2d');
    ctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = `${metrics.fontPx}px ${$canvasFont}`;
    const colors = {
      previous: readThemeColor('--onion-previous', onionCanvasEl),
      next: readThemeColor('--onion-next', onionCanvasEl),
    };
    for (const g of onionGhosts) {
      drawOnionCells(ctx, g.cells, metrics, colors[g.direction], g.alpha);
    }
    ctx.globalAlpha = 1;
  }

  onMount(() => {
    updateCanvasViewportState();
    const viewportObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(updateCanvasViewportState)
      : null;
    if (canvasWrapEl) viewportObserver?.observe(canvasWrapEl);
    let dprMediaQuery = null;
    const unwatchDpr = () => {
      dprMediaQuery?.removeEventListener?.('change', onDprChange);
      dprMediaQuery?.removeListener?.(onDprChange);
    };
    const watchDpr = () => {
      unwatchDpr();
      dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      if (dprMediaQuery.addEventListener) dprMediaQuery.addEventListener('change', onDprChange);
      else dprMediaQuery.addListener?.(onDprChange);
    };
    const onDprChange = () => {
      updateCanvasViewportState();
      watchDpr();
    };
    watchDpr();
    fontReady = true;
    remeasure();
    fitToViewport();
    if (document.fonts?.ready) document.fonts.ready.then(() => { remeasure(); fitToViewport(); });
    const blinkTimer = setInterval(() => { if (anyBlink) blinkOn = !blinkOn; else if (!blinkOn) blinkOn = true; }, 500);
    window.addEventListener('keydown', onPanKeyDown);
    window.addEventListener('keyup', onPanKeyUp);
    window.addEventListener('resize', updateCanvasViewportState);
    window.visualViewport?.addEventListener('resize', updateCanvasViewportState);
    const stopProjectReplaced = onProjectReplaced(resetCanvasInteractions);
    return () => {
      clearInterval(blinkTimer);
      viewportObserver?.disconnect();
      unwatchDpr();
      stopProjectReplaced();
      window.removeEventListener('keydown', onPanKeyDown);
      window.removeEventListener('keyup', onPanKeyUp);
      window.removeEventListener('resize', updateCanvasViewportState);
      window.visualViewport?.removeEventListener('resize', updateCanvasViewportState);
    };
  });

  let canvasWrapEl = $state();
  let gridEl = $state();
  let gridOn = $state(true);

  let painting = false;
  let last = null;
  let lastSub = null;
  let lineAnchor = null;
  let colorSamplePointer = null;
  let pointerGesture = $state(null);
  let activeWindowDrag = $state(null);
  let activeWindowOwner = $state(null);
  let activeWindowOwnsMoveState = $state(false);

  // Snapshot gesture ownership so context changes cancel a drag before it can mutate a new target.
  function currentOwnershipContext() {
    return {
      layerId: $activeLayerId,
      frameIndex: $activeFrameIndex,
      tool: $activeTool,
      layerPart: $activeLayerPart,
      projectRevision: captureProjectRevision(),
    };
  }


  function ownGesture(pointerId, overrides = {}) {
    return captureGestureOwner({ ...currentOwnershipContext(), ...overrides }, pointerId);
  }

  function ownerIsCurrent(owner) {
    return gestureOwnerMatches(owner, currentOwnershipContext());
  }

  function startPointerGesture(kind, event, options = {}) {
    pointerGesture = {
      kind,
      owner: ownGesture(event?.pointerId, options.owner),
      historyOpen: !!options.historyOpen,
      ownsMoveState: !!options.ownsMoveState,
      freshPaintOwner: options.freshPaintOwnerId != null,
      freshPaintOwnerId: options.freshPaintOwnerId ?? null,
      contentMutated: false,
    };
    return pointerGesture;
  }

  function recordPaintMutation(changed) {
    if (changed && pointerGesture) pointerGesture.contentMutated = true;
    return changed;
  }

  function clearPointerGestureState() {
    painting = false;
    last = null;
    lastSub = null;
    shapeDrag = null;
    shapePreview = [];
    selDrag = null;
    lassoPts = null;
    selectionGestureMode = null;
    moveAnchor = null;
    offsetDrag = null;
    textGesture = null;
    pointerGesture = null;
  }

  function abortPointerGesture() {
    if (pointerGesture?.ownsMoveState && get(moveState)) cancelMove();
    else if (pointerGesture?.historyOpen) cancelStroke();
    clearPointerGestureState();
  }

  function pointerGestureAccepts(event) {
    if (!pointerGesture) return false;
    if (!gesturePointerMatches(pointerGesture.owner, event?.pointerId)) return false;
    if (!ownerIsCurrent(pointerGesture.owner)) {
      abortPointerGesture();
      return false;
    }
    return true;
  }


  function coordinatesAt(event) {
    return canvasCoordinates(
      event,
      gridEl.getBoundingClientRect(),
      { w: metrics.cellW, h: metrics.cellH },
      { w: W, h: H },
    );
  }

  const MUTATING = new Set(['brush', 'eraser', 'subcell', 'fill']);
  const STROKE_TOOLS = new Set(['brush', 'eraser', 'subcell']);
  const SHAPE_TOOLS = new Set(['line', 'rect', 'circle', 'polygon']);
  const CANVAS_BOUND = new Set(['crop', 'select']);


  function preparePaintOwner(tool) {
    const state = getClipTimelineState();
    const disposition = paintOwnerDisposition(tool, activeLayer, {
      activePart: $activeLayerPart,
      activeClip: !!findActiveTimelineClip(state, activeLayer?.id, $activeFrameIndex),
      effectiveVisible: !!activeLayer && effVisible($layers, activeLayer),
    });
    if (disposition === 'blocked') return { ready: false, createdId: null };
    if (disposition !== 'create') return { ready: true, createdId: null };
    if (beginStroke() !== true) return { ready: false, createdId: null };
    const createdId = createPaintLayer(activeLayer.type);
    if (!createdId) {
      cancelStroke();
      return { ready: false, createdId: null };
    }
    return { ready: true, createdId };
  }

  let shapeDrag = null;
  let shapePreview = $state([]);
  function specialBrushMode() {
    const options = $toolOptions.subcell || {};
    const mode = options.mode || options.resolution || 'half';
    return BOX_STYLES[mode] ? mode : null;
  }
  function shapeSpec(tool, d) {
    const rawOpts = $toolOptions[tool] || {};
    const opts = editingEffectMask ? maskShapeAppearance(rawOpts) : rawOpts;
    const channel = editingEffectMask ? 'background' : (opts.channel || 'glyph');
    const styled = !editingEffectMask && channel === 'glyph' &&
      (tool === 'rect' || tool === 'circle' || tool === 'line' || tool === 'polygon');
    const style = styled && (opts.style === 'special' || opts.style === 'slope')
      ? opts.style
      : (opts.style === 'filled' ? 'filled' : 'outline');
    const detail = editingEffectMask || channel === 'background' || style === 'special' || style === 'slope'
      ? 'cell'
      : (opts.detail || 'cell');
    const shape = {
      kind: tool, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1,
      style, detail, boxStyle: opts.boxStyle || 'single',
      sides: opts.sides || 5,
      thickness: opts.thickness || 1,
      strokeAlign: opts.strokeAlign || 'center',
      channel, char: $activeChar,
      fg: $paintColor,
      wide: !editingEffectMask && channel === 'glyph' && style !== 'special' &&
        style !== 'slope' && detail === 'cell' && isWide($activeChar),
    };
    if (tool === 'polygon') {
      shape.vertices = regularPolygonVertices(d.x0, d.y0, d.x1, d.y1, shape.sides);
      shape.anchor = { x: (d.x0 + d.x1) / 2, y: (d.y0 + d.y1) / 2 };
      shape.rotation = 0;
    }
    return constrainShape(shape);
  }

  let selDrag = $state(null), lassoPts = null, selectionGestureMode = null, moveAnchor = null, offsetDrag = null;
  let selectionMenu = $state(null);
  let selectionMenuEl = $state();

  async function onSelectionContext(e) {
    if ($activeTool !== 'select' || !$selection.size) return;
    const { x, y } = coordinatesAt(e).cell;
    if (!$selection.has(selectionKey(x, y))) return;
    e.preventDefault();
    e.stopPropagation();
    setKeyboardContext('canvas');
    selectionMenu = { x: e.clientX, y: e.clientY };
    await tick();
    if (!selectionMenuEl || !selectionMenu) return;
    const rect = selectionMenuEl.getBoundingClientRect();
    const margin = 6;
    selectionMenu = {
      ...selectionMenu,
      x: Math.max(margin, Math.min(selectionMenu.x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(selectionMenu.y, window.innerHeight - rect.height - margin)),
    };
  }
  function selectionAction(action) {
    selectionMenu = null;
    if (action === 'transform') beginTransformSelection();
    else if (action === 'move') beginMove();
    else if (action === 'copy') selectionToNewLayer(false);
    else if (action === 'cut') selectionToNewLayer(true);
    else if (action === 'deselect') selection.set(new Set());
  }
  function onSelectionMenuPointerDown(event) {
    event.stopPropagation();
    onpointerdown?.(event);
  }
  function onActionPointerDown(event, action) {
    event.stopPropagation();
    event.preventDefault();
    return action(event);
  }
  function onCanvasWindowKey(event) {
    const deselect = planSelectionDeselect(event, {
      context: getKeyboardContext(),
      typing: isTypingTarget(event.target),
      popupOpen: get(popupOpen),
    });
    if (deselect.context === 'canvas') {
      event.preventDefault();
      event.stopImmediatePropagation();
      selectionMenu = null;
      clearSelection();
      return;
    }
    if (event.key !== 'Escape') return;
    if (get(popupOpen) && (!selectionMenu || !isTopPopup(selectionMenuEl))) return;
    const action = canvasEscapeAction({
      hasPointerGesture: !!pointerGesture,
      hasSelectionMenu: !!selectionMenu,
    });
    if (!action) return;
    if (action === 'cancel-pointer') {
      event.preventDefault();
      event.stopImmediatePropagation();
      const pointerId = pointerGesture.owner?.pointerId;
      if (pointerId != null && gridEl?.hasPointerCapture?.(pointerId)) {
        gridEl.releasePointerCapture(pointerId);
      }
      abortPointerGesture();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    selectionMenu = null;
  }

  let textEdit = $state(null), textValue = $state(''), textInputEl = $state(), textGesture = $state(null);
  // Controlled textarea rendering replaces the browser's native undo state.
  const textInputHistory = createControlledTextHistory();

  function resetCanvasInteractions() {
    releaseKeyboardContext('canvas');
    activeWindowDrag?.(true);
    activeWindowDrag = null;
    activeWindowOwner = null;
    activeWindowOwnsMoveState = false;
    abortPointerGesture();
    if (textEdit?.layerId != null) clearTextSelection(textEdit.layerId);
    lineAnchor = null;
    textEdit = null;
    textValue = '';
    selectionMenu = null;
    panning = null;
    hover = null;
    colorSamplePointer = null;
  }

  function rasterColorAt(x, y, fx = 0.5, fy = 0.5) {
    if (!imageCanvasEl || !inBounds(x, y)) return null;
    try {
      const scaleX = imageCanvasEl.width / (W * metrics.cellW);
      const scaleY = imageCanvasEl.height / (H * metrics.cellH);
      const px = Math.max(0, Math.min(imageCanvasEl.width - 1,
        Math.floor((x + fx) * metrics.cellW * scaleX)));
      const py = Math.max(0, Math.min(imageCanvasEl.height - 1,
        Math.floor((y + fy) * metrics.cellH * scaleY)));
      const [r, g, b, a] = imageCanvasEl.getContext('2d').getImageData(px, py, 1, 1).data;
      if (!a) return null;
      return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    } catch {
      return null;
    }
  }

  function visibleSampleCell(x, y, fx = 0.5, fy = 0.5) {
    const terminal = visibleGrid?.[y]?.[x] || null;
    return displayedSampleCell(terminal, rasterColorAt(x, y, fx, fy));
  }

  function colorForSessionSample(x, y, fx = 0.5, fy = 0.5) {
    if (editingEffectMask) {
      const strength = getCell(x, y)?.mask ?? activeLayer?.mask?.defaultStrength;
      if (strength == null) return null;
      const byte = Math.round(Math.max(0, Math.min(1, strength)) * 255)
        .toString(16).padStart(2, '0');
      return `#${byte}${byte}${byte}`;
    }
    const target = $colorEditSession.target;
    const targetShape = target?.kind === 'shape' ? getLayer(target.layerId) : null;
    const preferBackground = targetShape
      ? targetShape.shape?.channel === 'background'
      : target?.kind === 'toolbar' && activeBackground;
    return visibleColorFromCell(visibleSampleCell(x, y, fx, fy), preferBackground);
  }

  function beginSessionSample(event, x, y, fx, fy) {
    if ($colorEditSession.phase !== 'sampling' || event.button !== 0) return false;
    event.preventDefault();
    event.stopPropagation();
    colorSamplePointer = event.pointerId;
    const color = colorForSessionSample(x, y, fx, fy);
    if (color) colorEditSession.sample(color);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    return true;
  }

  function onPointerDown(e) {
    if (isTypingTarget(e.target)) return;
    if (canvasPointerStartsPan(spaceHeld, e.button)) { e.preventDefault(); beginPan(e); return; }
    const point = coordinatesAt(e);
    const { x, y } = point.cell;
    const { x: fx, y: fy } = point.withinCell;
    const { x: sx, y: sy } = point.subcell;
    if (beginSessionSample(e, x, y, fx, fy)) return;
    if (e.button !== 0) return;
    if ($playing) return;
    e.preventDefault();
    const sampling = e.altKey && (isBrush || $activeTool === 'fill' || SHAPE_TOOLS.has($activeTool));
    if (wrongLayer && !sampling) return;
    if (CANVAS_BOUND.has($activeTool) && !inBounds(x, y)) return;

    if ($moveState) {
      if ($moveState.mode === 'transform') return;
      startPointerGesture('selection-move', e, {
        historyOpen: true,
        ownsMoveState: true,
        owner: {
          layerId: $moveState.layerId,
          layerPart: $moveState.target === 'mask' ? 'mask' : 'layer',
        },
      });
      moveAnchor = { x, y, dx0: $moveState.dx, dy0: $moveState.dy };
      painting = true; e.currentTarget.setPointerCapture?.(e.pointerId); return;
    }

    if (sampling) {
      if (editingEffectMask) {
        const strength = getCell(x, y)?.mask ?? activeLayer.mask?.defaultStrength ?? 1;
        const byte = Math.round(strength * 255).toString(16).padStart(2, '0');
        paintColor.set(`#${byte}${byte}${byte}`);
      } else {
        const cell = visibleSampleCell(x, y, fx, fy);
        const backgroundTarget = activeBackground ||
          (SHAPE_TOOLS.has($activeTool) && $toolOptions[$activeTool]?.channel === 'background');
        const color = visibleColorFromCell(cell, backgroundTarget);
        if (color) paintColor.set(color);
        if (!backgroundTarget && cell?.c) activeChar.set(cell.c);
      }
      return;
    }
    if ($activeTool === 'move') {
      if ($selection.size) {
        if (!$moveState) beginMove();
        const state = get(moveState);
        if (!state) return;
        startPointerGesture('selection-move', e, {
          historyOpen: true,
          ownsMoveState: true,
          owner: {
            layerId: state.layerId,
            layerPart: state.target === 'mask' ? 'mask' : 'layer',
          },
        });
        moveAnchor = { x, y, dx0: state.dx, dy0: state.dy };
        painting = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        return;
      }
      if (!activeLayer) return;
      const sourceLayer = getLayer($activeLayerId);
      const isMask = editingEffectMask;
      const origin = isMask ? sourceLayer?.mask?.offset : sourceLayer?.offset;
      startPointerGesture('layer-move', e, { historyOpen: true });
      offsetDrag = { x, y, startX: x, startY: y, o0: { ...(origin || { x: 0, y: 0 }) },
        animatePosition: isMask ? isMaskPositionTrackEnabled($activeLayerId) : anyPosKeys($activeLayerId),
        isMask,
        rasterDrag: isMask ? null : captureRasterBodyDrag($activeLayerId),
        shapeDrag: isMask ? null : captureShapeBodyDrag($activeLayerId, $activeFrameIndex),
        isCell: activeLayerType === 'cell' || activeLayerType === 'background', type: activeLayerType,
        dx: 0, dy: 0, lastDx: 0, lastDy: 0,
        box0: sourceLayer?.box ? { ...sourceLayer.box } : null };
      beginStroke();
      painting = true; e.currentTarget.setPointerCapture?.(e.pointerId); return;
    }
    if ($activeTool === 'text') {
      const onLayer = topTextLayerAt(x, y);
      finishTextEdit();
      startPointerGesture('text', e);
      textGesture = beginTextGesture(x, y, onLayer?.id, {
        x: fx,
        y: fy,
        onGlyph: textLayerHasGlyph(onLayer, x, y, { offsetOf: (layer) => effOffset($layers, layer) }),
      });
      painting = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return;
    }
    if (SHAPE_TOOLS.has($activeTool)) {
      const initialShapeDrag = { x0: x, y0: y, x1: x, y1: y };
      const fillsBlankShapeCel = blankShapeAcceptsTool(
        activeLayer,
        $activeTool,
        initialShapeDrag,
        $activeFrameIndex,
      );
      startPointerGesture('shape-create', e, {
        historyOpen: editingEffectMask || fillsBlankShapeCel,
      });
      shapeDrag = initialShapeDrag; shapePreview = [];
      if (editingEffectMask || fillsBlankShapeCel) beginStroke();
      painting = true; e.currentTarget.setPointerCapture?.(e.pointerId); return;
    }
    if ($activeTool === 'crop') return;
    if ($activeTool === 'select') {
      startPointerGesture('select', e);
      selectionGestureMode = selectionModeForModifiers(e);
      if ($toolOptions.select.shape === 'lasso') lassoPts = [{ x, y }];
      else selDrag = { x0: x, y0: y, x1: x, y1: y };
      painting = true; e.currentTarget.setPointerCapture?.(e.pointerId); return;
    }
    const paintOwner = preparePaintOwner($activeTool);
    if (!paintOwner.ready) return;
    startPointerGesture('paint', e, {
      historyOpen: MUTATING.has($activeTool),
      freshPaintOwnerId: paintOwner.createdId,
    });
    painting = true; last = { x, y }; lastSub = { sx, sy };
    if (MUTATING.has($activeTool) && !paintOwner.createdId) beginStroke();
    const straight = e.shiftKey && STROKE_TOOLS.has($activeTool) &&
      gestureOwnerMatches(lineAnchor?.owner, currentOwnershipContext());
    const special = $activeTool === 'subcell' ? specialBrushMode() : null;
    if (straight && special) {
      recordPaintMutation(paintSpecialBrushPath(
        [{ x: lineAnchor.x, y: lineAnchor.y }, { x, y }],
        special,
      ));
    } else if (straight && $activeTool === 'subcell') {
      for (const q of linePoints(lineAnchor.sx, lineAnchor.sy, sx, sy)) {
        const cx = Math.floor(q.x / 2), cy = Math.floor(q.y / 2);
        const qfx = (((q.x % 2) + 2) % 2 === 0) ? 0.25 : 0.75;
        const qfy = (((q.y % 2) + 2) % 2 === 0) ? 0.25 : 0.75;
        applyToolToSelection(cx, cy, e, 'drag', qfx, qfy);
      }
    } else if (straight) {
      const wide = $activeTool === 'brush' && isWide(previewChar(fx, fy));
      const pts = linePoints(lineAnchor.x, lineAnchor.y, x, y);
      for (let i = 0; i < pts.length; i++) {
        if (wide && i % 2) continue;
        applyToolToSelection(pts[i].x, pts[i].y, e, 'drag', fx, fy);
      }
    } else if (special) {
      // Semantic line brushes need at least two distinct cells. A click/hold with no
      // movement is an accidental no-op, unlike Half and Quarter subcell painting.
    } else {
      applyToolToSelection(x, y, e, 'down', fx, fy);
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function applyToolToSelection(x, y, event, kind, fx, fy) {
    if (isSelected(x, y)) {
      const sampledCell = $activeTool === 'eyedropper'
        ? visibleSampleCell(x, y, fx, fy)
        : undefined;
      return recordPaintMutation(applyTool(x, y, event, kind, fx, fy, sampledCell));
    }
    return false;
  }

  function onPointerMove(e) {
    const point = coordinatesAt(e);
    const { x, y } = point.cell;
    const { x: fx, y: fy } = point.withinCell;
    const { x: sx, y: sy } = point.subcell;
    if (colorSamplePointer === e.pointerId && $colorEditSession.phase === 'sampling') {
      e.preventDefault();
      e.stopPropagation();
      hover = null;
      const color = colorForSessionSample(x, y, fx, fy);
      if (color) colorEditSession.sample(color);
      return;
    }
    if (isBrush && !wrongLayer && !e.altKey) {
      hoverCellX = x; hoverCellY = y;
      hover = { x, y, char: previewChar(fx, fy) };
    } else hover = null;

    if (!painting) return;
    if (!pointerGestureAccepts(e)) return;
    const owner = pointerGesture.owner;
    const gestureTool = owner.tool;
    if (offsetDrag) {
      const dx = x - offsetDrag.startX, dy = y - offsetDrag.startY;
      if (dx === offsetDrag.dx && dy === offsetDrag.dy) return;
      offsetDrag.dx = dx; offsetDrag.dy = dy;
      const stepX = dx - offsetDrag.lastDx, stepY = dy - offsetDrag.lastDy;
      if (offsetDrag.isMask) {
        const next = { x: offsetDrag.o0.x + dx, y: offsetDrag.o0.y + dy };
        if (offsetDrag.animatePosition) {
          setMaskPositionById(owner.frameIndex, owner.layerId, next);
        } else {
          setEffectMaskOffsetDirect(owner.layerId, next);
        }
      } else if (offsetDrag.rasterDrag) {
        applyRasterBodyDrag(offsetDrag.rasterDrag, owner.frameIndex, dx, dy);
      } else if (offsetDrag.animatePosition) {
        setLayerOffsetById(owner.frameIndex, owner.layerId, { x: offsetDrag.o0.x + dx, y: offsetDrag.o0.y + dy });
      } else if (offsetDrag.isCell) {
        if (stepX || stepY) { translateLayerCells(owner.layerId, stepX, stepY); offsetDrag.lastDx = dx; offsetDrag.lastDy = dy; }
      } else if (offsetDrag.shapeDrag) {
        applyShapeBodyDrag(offsetDrag.shapeDrag, owner.frameIndex, dx, dy);
      } else if (offsetDrag.type === 'text' && offsetDrag.box0) {
        const b = offsetDrag.box0;
        updateTextLayer(owner.layerId, { box: { ...b, x: b.x + dx, y: b.y + dy } }, renderTextToCells);
      } else {
        setLayerOffsetDirect(owner.layerId, { x: offsetDrag.o0.x + dx, y: offsetDrag.o0.y + dy });
      }
      return;
    }
    if ($moveState && moveAnchor) { updateMove(moveAnchor.dx0 + (x - moveAnchor.x), moveAnchor.dy0 + (y - moveAnchor.y)); return; }
    if (gestureTool === 'text' && textGesture) {
      textGesture = moveTextGesture(textGesture, x, y, { x: fx, y: fy });
      return;
    }
    if (SHAPE_TOOLS.has(gestureTool) && shapeDrag) {
      shapeDrag = { ...shapeDrag, x1: x, y1: y };
      const preview = shapeGlyphs(shapeSpec(gestureTool, shapeDrag));
      shapePreview = owner.layerPart === 'mask'
        ? preview.filter((point) => isSelected(point.x, point.y))
        : preview;
      return;
    }
    if (gestureTool === 'select') {
      if (lassoPts) { lassoPts = [...lassoPts, { x, y }]; return; }
      if (selDrag) { selDrag = { ...selDrag, x1: x, y1: y }; return; }
    }
    if (gestureTool === 'subcell') {
      const special = specialBrushMode();
      if (special) {
        if (last && x === last.x && y === last.y) return;
        recordPaintMutation(paintSpecialBrushPath([last || { x, y }, { x, y }], special));
        last = { x, y };
        lastSub = { sx, sy };
        return;
      }
      // Interpolate in quadrant space so fast subcell strokes stay continuous.
      if (lastSub && sx === lastSub.sx && sy === lastSub.sy) return;
      const from = lastSub || { sx, sy };
      for (const q of linePoints(from.sx, from.sy, sx, sy)) {
        if (lastSub && q.x === lastSub.sx && q.y === lastSub.sy) continue;
        const cx = Math.floor(q.x / 2), cy = Math.floor(q.y / 2);
        // Positive modulo preserves quadrant parity outside the canvas.
        const qfx = (((q.x % 2) + 2) % 2 === 0) ? 0.25 : 0.75;
        const qfy = (((q.y % 2) + 2) % 2 === 0) ? 0.25 : 0.75;
        applyToolToSelection(cx, cy, e, 'drag', qfx, qfy);
      }
      lastSub = { sx, sy }; last = { x, y };
      return;
    }
    if (last && last.x === x && last.y === y) return;
    // Wide glyphs advance two cells to preserve continuation slots.
    if (isBrush && last && last.y === y && isWide(previewChar(fx, fy))) {
      if (Math.abs(x - last.x) < 2) return;
    }
    if (last && (Math.abs(x - last.x) > 1 || Math.abs(y - last.y) > 1)) {
      const wide = isBrush && isWide(previewChar(fx, fy));
      for (const p of linePoints(last.x, last.y, x, y)) {
        if (p.x === last.x && p.y === last.y) continue;
        if (wide && (p.x - last.x) % 2 !== 0) continue;
        applyToolToSelection(p.x, p.y, e, 'drag', fx, fy);
      }
      last = { x, y };
      return;
    }
    last = { x, y };
    applyToolToSelection(x, y, e, 'drag', fx, fy);
  }

  function onPointerUp(e) {
    if (colorSamplePointer !== null &&
      (e?.pointerId == null || colorSamplePointer === e.pointerId)) {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      colorSamplePointer = null;
      colorEditSession.finishSampling();
      return;
    }
    if (!painting && !offsetDrag && !moveAnchor && !shapeDrag && !selDrag && !lassoPts &&
      !textGesture) return;
    if (pointerGesture && !pointerGestureAccepts(e)) return;
    const owner = pointerGesture?.owner;
    const gestureTool = owner?.tool ?? $activeTool;
    if (offsetDrag) {
      if (offsetDrag.dx || offsetDrag.dy) endStroke();
      else cancelStroke();
      clearPointerGestureState(); return;
    }
    if (gestureTool === 'text' && textGesture) {
      const gesture = textGesture;
      const result = resolveTextGesture(gesture);
      clearPointerGestureState();
      if (result?.action === 'edit') {
        const layer = getLayer(result.layerId);
        const box = layer ? layerBox($layers, layer) : null;
        if (layer && box) editExistingText(layer, textGestureSelection(layer, box, gesture));
      } else if (result?.action === 'create') {
        startTextEdit(result.box);
      }
      return;
    }
    if ($moveState && moveAnchor) { clearPointerGestureState(); return; }
    if (SHAPE_TOOLS.has(gestureTool) && shapeDrag) {
      if (owner?.layerPart === 'mask') {
        if (hasShapeExtent(shapeDrag) && shapePreview.length) {
          setCells(shapePreview.map(({ x, y }) => ({ x, y, cell: { fg: $paintColor } })));
          endStroke();
        } else {
          cancelStroke();
        }
      } else {
        const spec = shapeSpec(gestureTool, shapeDrag);
        const blankShapeLayer = getLayer(owner?.layerId);
        if (hasShapeExtent(spec) && blankShapeAcceptsTool(
          blankShapeLayer,
          gestureTool,
          shapeDrag,
          owner?.frameIndex,
        )) {
          updateShapeLayer(blankShapeLayer.id, spec, renderShapeToCells);
          endStroke();
        } else if (hasShapeExtent(spec)) {
          createShapeLayer(spec, renderShapeToCells);
        } else if (pointerGesture?.historyOpen) {
          cancelStroke();
        }
      }
      clearPointerGestureState(); return;
    }
    if (gestureTool === 'select') {
      if (lassoPts) { commitLasso(lassoPts); clearPointerGestureState(); return; }
      if (selDrag) { commitRect(normSel(selDrag)); clearPointerGestureState(); return; }
    }
    if (STROKE_TOOLS.has(gestureTool) && last &&
      (!pointerGesture?.freshPaintOwner || pointerGesture.contentMutated)) {
      lineAnchor = {
        x: last.x, y: last.y,
        sx: lastSub?.sx ?? last.x * 2, sy: lastSub?.sy ?? last.y * 2,
        owner: owner ?? ownGesture(null, { tool: gestureTool }),
      };
    }
    if (pointerGesture?.freshPaintOwner && !pointerGesture.contentMutated) {
      cancelStroke();
    } else {
      const createdLayer = pointerGesture?.freshPaintOwnerId
        ? getLayer(pointerGesture.freshPaintOwnerId)
        : null;
      const committed = endStroke();
      const notice = committed ? paintOwnerCreatedNotice(createdLayer) : null;
      if (notice) notifyInfo(notice);
    }
    clearPointerGestureState();
  }

  function cancelPointerInteraction(e) {
    if (colorSamplePointer !== null &&
      (e?.pointerId == null || colorSamplePointer === e.pointerId)) {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      colorSamplePointer = null;
      colorEditSession.cancel();
      return;
    }
    if (pointerGesture && !gesturePointerMatches(pointerGesture.owner, e?.pointerId)) return;
    abortPointerGesture();
  }

  function onWindowBlur() {
    spaceHeld = false;
    panning = null;
    if (colorSamplePointer !== null) {
      colorSamplePointer = null;
      colorEditSession.cancel();
      return;
    }
    abortPointerGesture();
  }

  function normSel(d) { return { x0: Math.min(d.x0, d.x1), y0: Math.min(d.y0, d.y1), x1: Math.max(d.x0, d.x1), y1: Math.max(d.y0, d.y1) }; }
  function commitRect(s) {
    const cells = [];
    for (let y = s.y0; y <= s.y1; y++) for (let x = s.x0; x <= s.x1; x++) if (inBounds(x, y)) cells.push({ x, y });
    applyRegion(cells, selectionGestureMode);
  }
  function commitLasso(pts) {
    if (pts.length < 3) return;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const inside = (px, py) => {
      let c = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
        if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) c = !c;
      }
      return c;
    };
    const cells = [];
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (inBounds(x, y) && inside(x + 0.5, y + 0.5)) cells.push({ x, y });
    applyRegion(cells, selectionGestureMode);
  }

  function topTextLayerAt(x, y) {
    return textLayerAt($layers, $activeLayerId, x, y, {
      isVisible: (layer) => effVisible($layers, layer),
      offsetOf: (layer) => effOffset($layers, layer),
      boxOf: (layer) => layerBox($layers, layer),
    });
  }

  async function startTextEdit(box) {
    const wrap = $toolOptions.text.wrap;
    beginStroke();
    const id = createTextLayer(box, '', $paintColor, wrap, renderTextToCells);
    const session = { layerId: id, box, wrap, created: true, historyOpen: true };
    textEdit = session;
    textValue = '';
    resetTextInputHistory();
    rememberTextSelection(id, 0, 0);
    await tick();
    if (textEdit === session) textInputEl?.focus({ preventScroll: true });
  }
  async function editExistingText(layer, selection = null) {
    selectLayer(layer.id);
    const wrap = layer.wrap !== false;
    toolOptions.update((options) => options.text.wrap === wrap ? options : ({
      ...options,
      text: { ...options.text, wrap },
    }));
    const session = {
      layerId: layer.id,
      box: layerBox($layers, layer),
      wrap,
      created: false,
      historyOpen: false,
    };
    textEdit = session;
    textValue = layer.text || '';
    resetTextInputHistory();
    await tick();
    if (textEdit !== session || !textInputEl) return;
    textInputEl.focus({ preventScroll: true });
    const start = Math.max(0, Math.min(textValue.length, selection?.start ?? textValue.length));
    const end = Math.max(start, Math.min(textValue.length, selection?.end ?? start));
    textInputEl.setSelectionRange(start, end, selection?.direction || 'none');
    rememberCurrentTextSelection();
  }
  function rememberCurrentTextSelection(event) {
    if (!textEdit || !textInputEl) return;
    rememberTextSelection(
      textEdit.layerId,
      textInputEl.selectionStart ?? 0,
      textInputEl.selectionEnd ?? 0,
      event?.type || 'programmatic',
    );
  }
  function beginTextHistory() {
    if (!textEdit || textEdit.historyOpen) return;
    beginStroke();
    textEdit = { ...textEdit, historyOpen: true };
  }
  function resetTextInputHistory() {
    textInputHistory.reset();
  }
  function captureTextInputState() {
    const layer = textEdit ? getLayer(textEdit.layerId) : null;
    if (!textEdit || !layer) return null;
    return {
      text: textValue,
      runs: (layer.runs || []).map((run) => ({ ...run })),
      start: textInputEl?.selectionStart ?? textValue.length,
      end: textInputEl?.selectionEnd ?? textValue.length,
      direction: textInputEl?.selectionDirection || 'none',
    };
  }
  function onTextBeforeInput(event) {
    if (!textEdit) return;
    textInputHistory.beforeInput(event, captureTextInputState());
  }
  async function restoreTextInputState(state) {
    if (!textEdit || !state || !getLayer(textEdit.layerId)) return;
    textValue = state.text;
    updateTextLayer(textEdit.layerId, {
      text: state.text,
      runs: state.runs,
      wrap: textEdit.wrap,
    }, renderTextToCells);
    rememberTextSelection(textEdit.layerId, state.start, state.end);
    await tick();
    if (!textEdit || !textInputEl) return;
    textInputEl.focus({ preventScroll: true });
    textInputEl.setSelectionRange(state.start, state.end, state.direction);
  }
  function onTextInput() {
    if (!textEdit) return;
    const layer = getLayer(textEdit.layerId);
    if (!layer) return;
    textInputHistory.input(layer.text !== textValue);
    beginTextHistory();
    const runs = remapTextColorRuns(layer.text || '', textValue, layer.runs || [], layer.fg);
    updateTextLayer(textEdit.layerId, {
      text: textValue,
      runs,
      wrap: textEdit.wrap,
    }, renderTextToCells);
    rememberCurrentTextSelection();
  }
  function updateActiveTextWrap(wrap) {
    if (!textEdit || textEdit.wrap === wrap || !getLayer(textEdit.layerId)) return;
    beginTextHistory();
    textEdit = { ...textEdit, wrap };
    updateTextLayer(textEdit.layerId, { wrap }, renderTextToCells);
  }
  let previousTextWrap = get(toolOptions).text.wrap;
  const stopTextWrapSubscription = toolOptions.subscribe((options) => {
    const wrap = options.text.wrap;
    const changed = wrap !== previousTextWrap;
    previousTextWrap = wrap;
    if (!changed || !textEdit || get(activeTool) !== 'text' ||
      textEdit.layerId !== get(activeLayerId)) return;
    // Apply before Svelte's render pass so the canvas cannot retain the old text raster.
    updateActiveTextWrap(wrap);
  });
  function commitText(event) {
    rememberCurrentTextSelection(event);
    if (textEdit?.historyOpen) endStroke();
    textEdit = null;
    textValue = '';
    resetTextInputHistory();
  }
  function cancelEmptyText() {
    const id = textEdit?.layerId;
    if (textEdit?.historyOpen) cancelStroke();
    clearTextSelection(id);
    textEdit = null;
    textValue = '';
    resetTextInputHistory();
  }
  function finishTextEdit(event) {
    if (textEdit?.created && textValue.length === 0) cancelEmptyText();
    else commitText(event);
  }
  function onTextKey(e) {
    if (textInputHistory.keydown(e, captureTextInputState(), restoreTextInputState)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finishTextEdit(e);
    }
  }
  function onPointerLeave() { hover = null; }


  function updateRasterTransform(layerId, baseTransform, patch) {
    layers.update(($l) => $l.map((l) => (l.id === layerId ? {
      ...l,
      transform: { ...baseTransform, ...patch },
    } : l)));
    noteAuthoredMutation();
  }
  // Window drags replace any prior owner and revalidate its captured editor context
  // before every move; their finish/cancel callbacks own history cleanup.
  function trackWindowDrag(pointerId, move, finish = () => {}, options = {}) {
    activeWindowDrag?.(true);
    const owner = options.owned === false ? null : (options.owner || ownGesture(pointerId));
    const cancel = options.cancel || finish;
    let open = true;
    const close = (cancelled, event) => {
      if (!open || (event?.pointerId != null && event.pointerId !== pointerId)) return;
      open = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
      if (activeWindowDrag === stop) {
        activeWindowDrag = null;
        activeWindowOwner = null;
        activeWindowOwnsMoveState = false;
      }
      if (cancelled) cancel();
      else finish();
    };
    const stop = (cancelled = true, event = null) => close(cancelled, event);
    const onMove = (event) => {
      if (event.pointerId !== pointerId) return;
      if (owner && !ownerIsCurrent(owner)) { stop(true, event); return; }
      move(event);
    };
    const onUp = (event) => stop(false, event);
    const onCancel = (event) => stop(true, event);
    const onBlur = () => stop(true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    activeWindowDrag = stop;
    activeWindowOwner = owner;
    activeWindowOwnsMoveState = !!options.ownsMoveState;
  }
  onDestroy(() => {
    releaseKeyboardContext('canvas');
    activeWindowDrag?.(true);
    if (textEdit?.historyOpen) endStroke();
    stopTextWrapSubscription();
    releaseVisibleMediaResources();
  });
  function dragImageBody(e) {
    e.preventDefault(); e.stopPropagation();
    const owner = ownGesture(e.pointerId);
    const drag = captureRasterBodyDrag(owner.layerId);
    if (!drag) return;
    beginStroke();
    const start = coordinatesAt(e).fractional;
    let current = { dx: 0, dy: 0 };
    const move = (ev) => {
      const p = coordinatesAt(ev).fractional;
      const delta = rasterBodyDelta(
        drag,
        p.x - start.x,
        p.y - start.y,
        ev.ctrlKey || ev.metaKey ? null : { x: W / 2, y: H / 2 },
      );
      if (!delta || (delta.dx === current.dx && delta.dy === current.dy)) return;
      current = delta;
      applyRasterBodyDrag(drag, owner.frameIndex, delta.dx, delta.dy);
    };
    trackWindowDrag(e.pointerId, move, () => {
      if (!current.dx && !current.dy) cancelStroke();
      else endStroke();
    }, { owner, cancel: cancelStroke });
  }
  function dragImageScale(e, axis = 'both') {
    e.preventDefault(); e.stopPropagation();
    const owner = ownGesture(e.pointerId);
    const image = activeImage;
    const gizmo = { ...imgGizmo };
    beginStroke();
    const t0 = { x: W / 2, y: H / 2, scale: 1, rot: 0, ...(image.transform || {}) };
    const s0x = t0.scaleX ?? t0.scale ?? 1, s0y = t0.scaleY ?? t0.scale ?? 1;
    let current = { x: s0x, y: s0y };
    const cxpx = gizmo.cx * metrics.cellW, cypx = gizmo.cy * metrics.cellH;
    const r = gridEl.getBoundingClientRect();
    const angle = -(gizmo.rot || 0) * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const localVector = (event) => {
      const dx = event.clientX - r.left - cxpx;
      const dy = event.clientY - r.top - cypx;
      return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
    };
    const initial = localVector(e);
    const dx0 = initial.x, dy0 = initial.y;
    const d0 = Math.hypot(dx0, dy0) || 1;
    const ax0 = Math.abs(dx0) || 1, ay0 = Math.abs(dy0) || 1;
    const move = (ev) => {
      const local = localVector(ev);
      const dxN = local.x, dyN = local.y;
      let nx = s0x, ny = s0y;
      if (axis === 'x') nx = Math.max(0.02, s0x * (Math.abs(dxN) / ax0));
      else if (axis === 'y') ny = Math.max(0.02, s0y * (Math.abs(dyN) / ay0));
      else if (ev.shiftKey) {
        nx = Math.max(0.02, s0x * (Math.abs(dxN) / ax0));
        ny = Math.max(0.02, s0y * (Math.abs(dyN) / ay0));
      } else {
        const k = Math.hypot(dxN, dyN) / d0;
        nx = Math.max(0.02, s0x * k); ny = Math.max(0.02, s0y * k);
      }
      if (nx === current.x && ny === current.y) return;
      current = { x: nx, y: ny };
      updateRasterTransform(owner.layerId, t0, { scaleX: nx, scaleY: ny, scale: undefined });
    };
    trackWindowDrag(e.pointerId, move, () => {
      if (current.x === s0x && current.y === s0y) cancelStroke();
      else endStroke();
    }, { owner, cancel: cancelStroke });
  }
  function dragImageRotate(e) {
    e.preventDefault(); e.stopPropagation();
    const owner = ownGesture(e.pointerId);
    const image = activeImage;
    const gizmo = { ...imgGizmo };
    beginStroke();
    const t0 = { x: W / 2, y: H / 2, scale: 1, rot: 0, ...(image.transform || {}) };
    const initial = Number(t0.rot) || 0;
    let current = initial;
    const cxpx = gizmo.cx * metrics.cellW, cypx = gizmo.cy * metrics.cellH;
    const r = gridEl.getBoundingClientRect();
    const move = (ev) => {
      const ang = Math.atan2(ev.clientY - r.top - cypx, ev.clientX - r.left - cxpx) * 180 / Math.PI + 90;
      let a = ang; if (ev.shiftKey) a = Math.round(a / 15) * 15;
      const next = Math.round(a);
      if (next === current) return;
      current = next;
      updateRasterTransform(owner.layerId, t0, { rot: next });
    };
    trackWindowDrag(e.pointerId, move, () => {
      if (current === initial) cancelStroke();
      else endStroke();
    }, { owner, cancel: cancelStroke });
  }
  function dragTextBox(mode, e) {
    if (!activeText) return;
    e.preventDefault();
    e.stopPropagation();
    const owner = ownGesture(e.pointerId);
    const id = activeText.id;
    const editing = textEdit?.layerId === id;
    const historyWasOpen = !!(editing && textEdit?.historyOpen);
    const b0 = { ...activeText.box };
    const start = coordinatesAt(e).cell;
    let changed = false;
    const move = (event) => {
      const point = coordinatesAt(event).cell;
      const dx = point.x - start.x;
      const dy = point.y - start.y;
      const box = mode === 'move'
        ? { x: b0.x + dx, y: b0.y + dy, w: b0.w, h: b0.h }
        : { x: b0.x, y: b0.y, w: Math.max(1, b0.w + dx), h: Math.max(1, b0.h + dy) };
      if (box.x === b0.x && box.y === b0.y && box.w === b0.w && box.h === b0.h) return;
      if (!changed) {
        if (editing) beginTextHistory();
        else beginStroke();
        changed = true;
      }
      updateTextLayer(id, { box }, renderTextToCells);
      if (editing && textEdit?.layerId === id) {
        const updated = getLayer(id);
        textEdit = { ...textEdit, box: updated ? layerBox(get(layers), updated) : box };
      }
    };
    trackWindowDrag(e.pointerId, move, () => {
      if (changed && !editing) endStroke();
    }, {
      owner,
      cancel: () => {
        if (!changed) return;
        if (editing && historyWasOpen) {
          updateTextLayer(id, { box: b0 }, renderTextToCells);
        } else {
          cancelStroke();
        }
        if (editing && textEdit?.layerId === id) {
          const restored = getLayer(id);
          if (restored) textEdit = {
            ...textEdit,
            box: layerBox(get(layers), restored),
            historyOpen: historyWasOpen,
          };
        }
      },
    });
  }
  function dragSelectionTransform(handle, event) {
    const current = get(moveState);
    if (event.button !== 0 || !current ||
      (handle !== 'body' && current.mode !== 'transform')) return;
    event.preventDefault();
    event.stopPropagation();
    const owner = ownGesture(event.pointerId, {
      layerId: current.layerId,
      layerPart: current.target === 'mask' ? 'mask' : 'layer',
    });
    const startBounds = { ...current.bounds };
    const start = coordinatesAt(event).fractional;
    const move = (nextEvent) => {
      const point = coordinatesAt(nextEvent).fractional;
      const bounds = transformBoundsFromDrag(
        startBounds,
        handle,
        start,
        point,
        minimumTransformWidth(current),
      );
      if (current.mode === 'transform') {
        updateTransformBounds(bounds);
      } else {
        updateMove(
          current.dx + bounds.x - startBounds.x,
          current.dy + bounds.y - startBounds.y,
        );
      }
    };
    trackWindowDrag(event.pointerId, move, () => {}, {
      owner,
      cancel: cancelMove,
      ownsMoveState: true,
    });
  }
  function dragShapeBody(e) {
    e.preventDefault(); e.stopPropagation();
    const owner = ownGesture(e.pointerId);
    beginStroke();
    const drag = captureShapeBodyDrag(owner.layerId, owner.frameIndex);
    if (!drag) { cancelStroke(); return; }
    const start = coordinatesAt(e).cell;
    let current = { dx: 0, dy: 0 };
    const move = (ev) => {
      const p = coordinatesAt(ev).cell;
      const dx = p.x - start.x, dy = p.y - start.y;
      if (dx === current.dx && dy === current.dy) return;
      current = { dx, dy };
      applyShapeBodyDrag(drag, owner.frameIndex, dx, dy);
    };
    trackWindowDrag(e.pointerId, move, () => {
      if (current.dx || current.dy) endStroke();
      else cancelStroke();
    }, { owner, cancel: cancelStroke });
  }
  function dragShapeHandle(which, e) {
    e.preventDefault(); e.stopPropagation();
    const hitTargets = [...gridEl.querySelectorAll('.shape-handle:not(.passive)')]
      .map((node, stackOrder) => ({
        id: node.dataset.shapeHandleId,
        type: node.dataset.shapeHandleType,
        stackOrder,
        rect: node.getBoundingClientRect(),
      }));
    const handleId = pickShapeTransformHandle(
      hitTargets,
      { x: e.clientX, y: e.clientY },
    ) || which;
    const owner = ownGesture(e.pointerId);
    beginStroke();
    const id = owner.layerId;
    const s0 = activeShape.shape;
    const moving = shapeTransformHandles(s0).find((handle) => handle.id === handleId);
    if (!moving) { cancelStroke(); return; }
    const startClient = { x: e.clientX, y: e.clientY };
    const initialPath = pathValueFromShape(s0);
    let currentPath = initialPath;
    const rotationAnchor = moving.type === 'rotation' ? resolvedShapeAnchor(s0) : null;
    // Accumulate shortest angular steps so crossing ±π never snaps the gesture backward.
    let rotationAngle = rotationAnchor
      ? Math.atan2(moving.y - rotationAnchor.y, moving.x - rotationAnchor.x)
      : 0;
    let rotationDelta = 0;
    const move = (ev) => {
      const target = shapeHandleDragTarget(
        moving,
        startClient,
        { x: ev.clientX, y: ev.clientY },
        { w: metrics.cellW, h: metrics.cellH },
      );
      if (!target) return;
      if (rotationAnchor && Math.hypot(
        target.x - rotationAnchor.x,
        target.y - rotationAnchor.y,
      ) > 1e-9) {
        const nextAngle = Math.atan2(
          target.y - rotationAnchor.y,
          target.x - rotationAnchor.x,
        );
        let step = nextAngle - rotationAngle;
        if (step > Math.PI) step -= Math.PI * 2;
        if (step < -Math.PI) step += Math.PI * 2;
        rotationDelta += step * 180 / Math.PI;
        rotationAngle = nextAngle;
      }
      const transform = moving.type === 'vertex' || moving.type === 'edge'
        ? transformShapeFromCageHandle
        : transformShapeFromHandle;
      const next = transform(s0, handleId, target, {
        ctrl: ev.ctrlKey,
        alt: ev.altKey,
        shift: ev.shiftKey,
        rotationDelta: rotationAnchor ? rotationDelta : undefined,
      });
      if (!next) return;
      const nextPath = pathValueFromShape(next);
      if (shapePathEqual(nextPath, currentPath)) return;
      currentPath = nextPath;
      applyShapeGeometryEdit(id, owner.frameIndex, next, s0);
    };
    trackWindowDrag(e.pointerId, move, () => {
      if (shapePathEqual(currentPath, initialPath)) cancelStroke();
      else endStroke();
    }, { owner, cancel: cancelStroke });
  }

  function shapeHandleTitle(handle) {
    if (handle.type === 'anchor') return 'Move transform anchor';
    if (handle.type === 'rotation') return 'Rotate';
    if (handle.localMove) return `Move ${handle.label.toLowerCase()}`;
    return handle.label;
  }

  function shapeHandleCursor(handle, shape) {
    if (handle.type === 'anchor') return 'move';
    if (handle.type === 'rotation') return 'grab';
    const anchor = resolvedShapeAnchor(shape);
    const dx = handle.x - anchor.x;
    const dy = handle.y - anchor.y;
    if (handle.type === 'edge' && !handle.localMove) {
      return Math.abs(dx) >= Math.abs(dy) ? 'ew-resize' : 'ns-resize';
    }
    if (handle.localMove) return 'move';
    return dx * dy >= 0 ? 'nwse-resize' : 'nesw-resize';
  }

  let hover = $state(null);
  let hoverCellX = -1, hoverCellY = -1;
  function previewChar(fx = 0.5, fy = 0.5, x = hoverCellX, y = hoverCellY) {
    if ($activeTool === 'eraser') return '';
    if ($activeTool === 'subcell') {
      const special = specialBrushMode();
      if (special) {
        const points = painting && last ? [last, { x, y }] : [{ x, y }];
        return previewSpecialBrushGlyph(points, x, y, special);
      }
      const options = $toolOptions.subcell || {};
      const bits = bitsForStroke(options.mode || options.resolution || 'half', fy < 0.5, fx < 0.5);
      const resolved = applySubcell(getCell(hoverCellX, hoverCellY), bits, $paintColor);
      return resolved ? resolved.c : '';
    }
    return $activeChar;
  }

  function startCrop(handle, e) {
    e.preventDefault();
    e.stopPropagation();
    if (canvasPointerStartsPan(spaceHeld, e.button)) {
      beginPan(e);
      return;
    }
    const owner = ownGesture(e.pointerId);
    const original = $cropPending ? { ...$cropPending } : null;
    const base = original || canvasCrop(W, H);
    const startX = e.clientX, startY = e.clientY;
    const move = (ev) => {
      const next = dragCrop(
        base,
        handle,
        (ev.clientX - startX) / metrics.cellW,
        (ev.clientY - startY) / metrics.cellH,
      );
      cropPending.set(next);
    };
    trackWindowDrag(e.pointerId, move, () => {}, {
      owner,
      cancel: () => cropPending.set(original),
    });
  }
  async function applyCrop() {
    const rect = $cropPending || canvasCrop(W, H);
    if (cropDiffers(rect, W, H)) cropTimeline(rect);
    cropPending.set(null);
    await tick();
    fitToViewport();
  }
  function cancelPendingCrop() {
    activeWindowDrag?.(true);
    cropPending.set(null);
  }
  let W = $derived($dims.w);
  let H = $derived($dims.h);
  let targetW = $derived(ZOOM_STEPS[zoomIdx]);
  let zoomPct = $derived(Math.round((targetW / 18) * 100));
  $effect.pre(() => {
    if (fontReady && canvasWrapEl) {
      const key = $dims.w + 'x' + $dims.h;
      if (key !== lastFitDims) {
        lastFitDims = key;
        tick().then(fitToViewport);
      }
    }
  });
  $effect.pre(() => {
    if (fontReady) {
      $canvasFont;
      targetW;
      untrack(remeasure);
    }
  });
  $effect.pre(() => {
    $visualMediaRequestRevision;
    const layerList = $layers;
    const clipIds = new Set($videoDecodeRequests.keys());
    untrack(() => syncVisibleMediaResources(layerList, clipIds));
  });
  $effect.pre(() => {
    const layerList = $layers;
    const tickValue = $playheadTick;
    const fpsValue = $fps;
    const allowIntermediate = $playing;
    const requestedClipIds = new Set($videoDecodeRequests.keys());
    untrack(() => syncVideoLayerFrames(layerList, tickValue, fpsValue, {
      allowIntermediate,
      requestedClipIds,
    }));
  });
  $effect(() => {
    if (imageCanvasEl) {
      $layers;
      metrics;
      $videoFrameRevision;
      $videoRasterStatus;
      $playheadTick;
      $fps;
      canvasDpr;
      untrack(drawImages);
    }
  });
  let anyBlink = $derived(hasVisibleBlinkingGlyph($layers));
  let visibleGrid = $derived(applyBlinkPhase(normalizeOutputGrid($grid, W, H), blinkOn));
  $effect(() => {
    if (canvasEl) {
      visibleGrid;
      metrics;
      $colorDepth;
      canvasDpr;
      untrack(redraw);
    }
  });
  let canvasViewport = $derived(visibleCanvasViewport(
    canvasViewportSize,
    { w: W, h: H },
    { w: metrics.cellW, h: metrics.cellH },
    pan,
  ));
  let canvasViewportKey = $derived(`${canvasViewport.x},${canvasViewport.y},${canvasViewport.w},${canvasViewport.h}`);
  $effect(() => {
    if (worldCanvasEl) {
      $layers;
      $grid;
      metrics;
      $colorDepth;
      blinkOn;
      canvasViewportKey;
      canvasDpr;
      untrack(drawWorld);
    }
  });
  let activeLayer = $derived($layers.find((l) => l.id === $activeLayerId) || null);
  let activeBackground = $derived(isBackgroundLayer(activeLayer));
  let editingEffectMask = $derived($activeLayerPart === 'mask' && isEditingEffectMask(activeLayer));
  $effect(() => {
    if (hoverCanvasEl) {
      hover;
      metrics;
      canvasViewportKey;
      canvasDpr;
      $paintColor;
      $activeTool;
      activeBackground;
      editingEffectMask;
      $colorDepth;
      untrack(drawHover);
    }
  });
  let onionGhosts = $derived((() => {
    if ($playing || $onionSkin === 'off') return [];
    const layerIdx = $onionSkin === 'layer' ? $layers.findIndex((l) => l.id === $activeLayerId) : null;
    if ($onionSkin === 'layer' && layerIdx < 0) return [];
    const out = [];
    for (let d = ONION_DEPTH; d >= 1; d--) {
      const alpha = 0.34 * (1 - (d - 1) / (ONION_DEPTH + 0.5));
      const next = $frames[$activeFrameIndex + d];
      if (next) out.push({ cells: compositeFrameCells(next, W, H, layerIdx), direction: 'next', alpha });
      const prev = $frames[$activeFrameIndex - d];
      if (prev) out.push({ cells: compositeFrameCells(prev, W, H, layerIdx), direction: 'previous', alpha });
    }
    return out;
  })());
  $effect(() => {
    if (onionCanvasEl) {
      onionGhosts;
      metrics;
      $colorDepth;
      canvasDpr;
      untrack(drawOnion);
    }
  });
  let ownershipContext = $derived({
    layerId: $activeLayerId,
    frameIndex: $activeFrameIndex,
    tool: $activeTool,
    layerPart: $activeLayerPart,
    projectRevision: captureProjectRevision(),
  });
  $effect.pre(() => {
    if (pointerGesture && !gestureOwnerMatches(pointerGesture.owner, {
      ...ownershipContext,
      projectRevision: captureProjectRevision(),
    })) {
      untrack(abortPointerGesture);
    }
  });
  $effect.pre(() => {
    if (activeWindowOwner && !gestureOwnerMatches(activeWindowOwner, {
      ...ownershipContext,
      projectRevision: captureProjectRevision(),
    })) {
      untrack(() => activeWindowDrag?.(true));
    }
  });
  let activeLayerType = $derived(activeLayer?.type || null);
  let wrongLayer = $derived(isToolDisabledForLayer($activeTool, activeLayer, $activeLayerPart));
  let shapeBackground = $derived(SHAPE_TOOLS.has($activeTool) && (editingEffectMask || $toolOptions[$activeTool]?.channel === 'background'));
  let textEditLayout = $derived(textEdit ? layoutText(textValue, textEdit.box.w, textEdit.wrap) : null);
  let textEditRows = $derived(textEdit ? Math.max(textEdit.box.h, textEditLayout.lineCount) : 1);
  let textEditColumns = $derived(textEdit ? textLayoutColumns(textEditLayout, textEdit.box.w) : 1);
  let shapeHoverVisible = $derived(!$playing &&
    $shapeGeometryHover?.layerId === $activeLayerId);
  let selectedShapeLayer = $derived($layers.find((layer) =>
    layer.id === $activeLayerId && layer.type === 'shape' &&
    effVisible($layers, layer) && layer.shape) || null);
  let shapeDirectEdit = $derived(shapeDirectEditTarget(
    selectedShapeLayer,
    $activeTool,
    $playing,
    shapeHoverVisible,
  ));
  let shapeHandlesInteractive = $derived(shapeDirectEdit.interactive);
  let activeShape = $derived(shapeDirectEdit.layer);
  let activeText = $derived(!$playing && $layers.find((l) => l.id === $activeLayerId && l.type === 'text' && effVisible($layers, l) && l.box));
  let activeImage = $derived(!$playing && $activeTool === 'move' && $layers.find((l) => l.id === $activeLayerId &&
    (l.type === 'image' || l.type === 'video') && effVisible($layers, l) && rasterLayerSourceSize(l) &&
    (l.type !== 'video' || videoStateAtTick(l.videoClip, $playheadTick, $fps).active)));
  let imgGizmo = $derived((() => {
    if (!activeImage) return null;
    const geometry = rasterDisplayGeometry($layers, activeImage, { w: W, h: H });
    return geometry && {
      cx: geometry.x,
      cy: geometry.y,
      halfW: geometry.width / 2,
      halfH: geometry.height / 2,
      rot: geometry.rot,
    };
  })());
  let moveToolAction = $derived(moveToolChangeAction({
    hasMoveState: !!$moveState,
    tool: $activeTool,
    pointerOwnsMoveState: !!pointerGesture?.ownsMoveState,
    windowOwnsMoveState: activeWindowOwnsMoveState,
  }));
  $effect.pre(() => {
    if (moveToolAction === 'cancel-pointer') untrack(abortPointerGesture);
  });
  $effect.pre(() => {
    if (moveToolAction === 'cancel-window') untrack(() => activeWindowDrag?.(true));
  });
  $effect.pre(() => {
    if (moveToolAction === 'finalize') untrack(finalizeMove);
  });
  let moveBounds = $derived($moveState?.bounds || null);
  let isBrush = $derived(BRUSH_TOOLS.has($activeTool));
  $effect.pre(() => {
    if ($activeTool !== 'crop' && $cropPending) untrack(() => cropPending.set(null));
  });
</script>
<svelte:window onblur={onWindowBlur} onapply-crop={applyCrop}
  oncancel-crop={cancelPendingCrop} onkeydowncapture={onCanvasWindowKey} />


<div class="canvas-wrap scroll" bind:this={canvasWrapEl} data-keyboard-context="canvas"
  onwheel={onWheel} onpointerdowncapture={noteKeyboardContext}
  onpointerdown={() => (selectionMenu = null)}>
  <span class="canvas-label">{documentLabel($fileName, $dirty, W, H)}</span>

  <div class="stage" bind:this={gridEl}
    class:brush-cursor={isBrush && !$altEyedrop && $colorEditSession.phase !== 'sampling' && !wrongLayer && !spaceHeld}
    class:eyedrop-cursor={$altEyedrop || $colorEditSession.phase === 'sampling'}
    class:move-cursor={($activeTool === 'move' || $moveState) && !spaceHeld}
    class:no-cursor={wrongLayer && !$altEyedrop && $colorEditSession.phase !== 'sampling' && !spaceHeld}
    class:pan-cursor={spaceHeld || panning}
    class:playing={$playing}
    style="width: calc({W} * var(--cell-w)); height: calc({H} * var(--cell-h)); left: {pan.x}px; top: {pan.y}px;"
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="hit-catcher"
      style="left: {canvasViewport.x * metrics.cellW}px; top: {canvasViewport.y * metrics.cellH}px; width: {canvasViewport.w * metrics.cellW}px; height: {canvasViewport.h * metrics.cellH}px;"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={cancelPointerInteraction}
      onlostpointercapture={cancelPointerInteraction}
      onpointerleave={onPointerLeave}
      oncontextmenu={onSelectionContext}
    ></div>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <canvas bind:this={worldCanvasEl} class="world-canvas"></canvas>
    <canvas bind:this={imageCanvasEl} class="image-canvas"></canvas>
    <canvas bind:this={onionCanvasEl} class="onion-canvas"></canvas>
    <canvas bind:this={canvasEl} class="cells"></canvas>
    <canvas bind:this={hoverCanvasEl} class="hover-canvas"></canvas>

    {#if gridOn}
      <div class="outside-grid"
        style="left: {canvasViewport.x * metrics.cellW}px; top: {canvasViewport.y * metrics.cellH}px; width: {canvasViewport.w * metrics.cellW}px; height: {canvasViewport.h * metrics.cellH}px;"></div>
      <div class="grid-overlay"></div>
    {/if}

    {#each shapePreview as p}
      <div class="glyph-overlay" class:bg-preview={shapeBackground}
        style="left: calc({p.x} * var(--cell-w)); top: calc({p.y} * var(--cell-h)); color: {disp($paintColor)}; background: {shapeBackground ? disp($paintColor) : 'transparent'}; font-family: {$canvasFont};">{shapeBackground ? '' : p.ch}</div>
    {/each}
    {#if !$moveState}
      {#each [...$selection] as k}
        {@const sx = +k.split(',')[0]}
        {@const sy = +k.split(',')[1]}
        <div class="sel-cell" style="left: calc({sx} * var(--cell-w)); top: calc({sy} * var(--cell-h));"></div>
      {/each}
    {/if}
    {#if selDrag}
      {@const s = normSel(selDrag)}
      <div class="sel-box" style="left: calc({s.x0} * var(--cell-w)); top: calc({s.y0} * var(--cell-h)); width: calc({s.x1 - s.x0 + 1} * var(--cell-w)); height: calc({s.y1 - s.y0 + 1} * var(--cell-h));"></div>
    {/if}

    {#if $moveState && moveBounds}
      <div class="move-box" class:transform-preview={$moveState.mode === 'transform'}
        style="left: calc({moveBounds.x} * var(--cell-w)); top: calc({moveBounds.y} * var(--cell-h)); width: calc({moveBounds.w} * var(--cell-w)); height: calc({moveBounds.h} * var(--cell-h));"
        onpointerdown={(event) => $moveState.mode !== 'transform' && dragSelectionTransform('body', event)}>
      </div>
      {#if $moveState.mode === 'transform'}
        <div class="transform-controls"
          style="left: calc(({moveBounds.x} + {moveBounds.w} / 2) * var(--cell-w)); top: calc(({moveBounds.y} + {moveBounds.h} / 2) * var(--cell-h)); width: max(calc({moveBounds.w} * var(--cell-w)), 48px); height: max(calc({moveBounds.h} * var(--cell-h)), 48px);">
          <button class="transform-body" aria-label="Move transform preview" title="Move transform preview"
            onpointerdown={(event) => dragSelectionTransform('body', event)}>
            <span aria-hidden="true"></span>
          </button>
          {#each TRANSFORM_HANDLES as handle}
            <button class="transform-handle {handle}" aria-label="Resize selection {handle}" title="Resize selection"
              onpointerdown={(event) => dragSelectionTransform(handle, event)}></button>
          {/each}
          <button class="move-done" onpointerdown={(event) => onActionPointerDown(event, finalizeMove)} title="Apply (Enter)">✓</button>
          <button class="move-cancel" onpointerdown={(event) => onActionPointerDown(event, cancelMove)} title="Cancel (Esc)">&times;</button>
        </div>
      {:else}
        <button class="move-done" style="left: calc({moveBounds.x + moveBounds.w} * var(--cell-w)); top: calc({moveBounds.y} * var(--cell-h));" onpointerdown={(event) => onActionPointerDown(event, finalizeMove)} title="Apply (Enter)">✓</button>
        <button class="move-cancel" style="left: calc({moveBounds.x + moveBounds.w} * var(--cell-w)); top: calc({moveBounds.y} * var(--cell-h));" onpointerdown={(event) => onActionPointerDown(event, cancelMove)} title="Cancel (Esc)">&times;</button>
      {/if}
    {/if}

    {#if textGestureBox(textGesture)}
      {@const b = textGestureBox(textGesture)}
      <div class="text-box drag" style="left: calc({b.x} * var(--cell-w)); top: calc({b.y} * var(--cell-h)); width: calc({b.w} * var(--cell-w)); height: calc({b.h} * var(--cell-h));"></div>
    {/if}
    {#if textEdit}
      <div class="text-box edit" style="left: calc({textEdit.box.x} * var(--cell-w)); top: calc({textEdit.box.y} * var(--cell-h)); width: calc({textEdit.box.w} * var(--cell-w)); height: calc({textEdit.box.h} * var(--cell-h));"></div>
      <textarea class="text-input" class:nowrap={!textEdit.wrap} bind:this={textInputEl} bind:value={textValue}
        aria-label="Text layer content" wrap={textEdit.wrap ? 'soft' : 'off'} spellcheck="false"
        onbeforeinput={onTextBeforeInput} oninput={onTextInput} onselect={rememberCurrentTextSelection}
        onmouseup={rememberCurrentTextSelection} onkeyup={rememberCurrentTextSelection}
        onblur={finishTextEdit} onkeydown={onTextKey}
        style="left: calc({textEdit.box.x} * var(--cell-w)); top: calc({textEdit.box.y} * var(--cell-h)); width: calc({textEditColumns} * var(--cell-w)); height: calc({textEditRows} * var(--cell-h)); font-family: {$canvasFont};"
      ></textarea>
    {/if}

    {#if $activeTool === 'crop'}
      {@const crop = $cropPending || canvasCrop(W, H)}
      <div class="crop-frame" class:pending={!!$cropPending} style="left: calc({crop.x} * var(--cell-w)); top: calc({crop.y} * var(--cell-h)); width: calc({crop.w} * var(--cell-w)); height: calc({crop.h} * var(--cell-h));" onpointerdown={(e) => startCrop('move', e)}></div>
      <div class="crop-handle nw" style="left: calc({crop.x} * var(--cell-w)); top: calc({crop.y} * var(--cell-h));" onpointerdown={(e) => startCrop('nw', e)}></div>
      <div class="crop-handle n" style="left: calc(({crop.x} + {crop.w} / 2) * var(--cell-w)); top: calc({crop.y} * var(--cell-h));" onpointerdown={(e) => startCrop('n', e)}></div>
      <div class="crop-handle ne" style="left: calc(({crop.x} + {crop.w}) * var(--cell-w)); top: calc({crop.y} * var(--cell-h));" onpointerdown={(e) => startCrop('ne', e)}></div>
      <div class="crop-handle e" style="left: calc(({crop.x} + {crop.w}) * var(--cell-w)); top: calc(({crop.y} + {crop.h} / 2) * var(--cell-h));" onpointerdown={(e) => startCrop('e', e)}></div>
      <div class="crop-handle se" style="left: calc(({crop.x} + {crop.w}) * var(--cell-w)); top: calc(({crop.y} + {crop.h}) * var(--cell-h));" onpointerdown={(e) => startCrop('se', e)}></div>
      <div class="crop-handle s" style="left: calc(({crop.x} + {crop.w} / 2) * var(--cell-w)); top: calc(({crop.y} + {crop.h}) * var(--cell-h));" onpointerdown={(e) => startCrop('s', e)}></div>
      <div class="crop-handle sw" style="left: calc({crop.x} * var(--cell-w)); top: calc(({crop.y} + {crop.h}) * var(--cell-h));" onpointerdown={(e) => startCrop('sw', e)}></div>
      <div class="crop-handle w" style="left: calc({crop.x} * var(--cell-w)); top: calc(({crop.y} + {crop.h} / 2) * var(--cell-h));" onpointerdown={(e) => startCrop('w', e)}></div>
      {#if cropDiffers(crop, W, H)}
        <button class="crop-apply" style="left: calc(({crop.x} + {crop.w}) * var(--cell-w)); top: calc(({crop.y} + {crop.h}) * var(--cell-h));" onpointerdown={(event) => onActionPointerDown(event, applyCrop)} title="Apply crop">✓ {crop.w}×{crop.h}</button>
      {/if}
    {/if}

    {#if activeShape}
      {@const s = activeShape.shape}
      {@const o = effOffset($layers, activeShape)}
      {@const cw = metrics.cellW}{@const ch = metrics.cellH}
      {@const vertices = resolvedShapeVertices(s)}
      {@const cageVertices = shapeTransformCageVertices(s)}
      {@const handles = shapeTransformHandles(s)}
      {@const hasEditableAnchor = handles.some((handle) => handle.type === 'anchor')}
      {@const hitPoints = vertices.map((point) => `${(point.x + o.x + 0.5) * cw},${(point.y + o.y + 0.5) * ch}`).join(' ')}
      {@const cagePoints = cageVertices.map((point) => `${(point.x + o.x + 0.5) * cw},${(point.y + o.y + 0.5) * ch}`).join(' ')}
      {@const rotationHandle = handles.find((handle) => handle.type === 'rotation')}
      {@const firstEdge = handles.find((handle) => handle.id === 'edge:0')}
      {@const rotationLinkStart = firstEdge || handles.find((handle) => handle.type === 'anchor')}
      {@const rotationHighlighted = $shapeGeometryHover?.layerId === activeShape.id &&
        $shapeGeometryHover?.componentId === 'rotation'}
      <svg class="shape-guide" class:interactive={shapeHandlesInteractive} width={W * cw} height={H * ch}>
        {#if s.kind === 'line'}
          <polyline points={cagePoints} />
          <polyline class="shape-hit" points={hitPoints} onpointerdown={dragShapeBody} />
        {:else}
          <polygon points={cagePoints} />
          <polygon class="shape-hit" points={hitPoints} onpointerdown={dragShapeBody} />
        {/if}
        {#if (shapeHandlesInteractive || rotationHighlighted) && rotationHandle && rotationLinkStart}
          <line class="rotation-link"
            x1={(rotationLinkStart.x + o.x + 0.5) * cw} y1={(rotationLinkStart.y + o.y + 0.5) * ch}
            x2={(rotationHandle.x + o.x + 0.5) * cw} y2={(rotationHandle.y + o.y + 0.5) * ch} />
        {/if}
      </svg>
      {#each handles as handle (handle.id)}
        {@const highlighted = $shapeGeometryHover?.layerId === activeShape.id &&
          $shapeGeometryHover?.componentId === handle.id}
        {#if shapeHandlesInteractive || highlighted}
          <div class="shape-handle {handle.type}"
            class:highlighted class:passive={!shapeHandlesInteractive}
            data-shape-handle-id={handle.id} data-shape-handle-type={handle.type}
            style="left: calc(({handle.x + o.x} + 0.5) * var(--cell-w)); top: calc(({handle.y + o.y} + 0.5) * var(--cell-h)); cursor: {shapeHandleCursor(handle, s)};"
             aria-label={handle.label} title={shapeHandleTitle(handle)}
            onpointerdown={(e) => shapeHandlesInteractive && dragShapeHandle(handle.id, e)}></div>
        {/if}
      {/each}
    {/if}

    {#if !$playing}
      {#each $layers.filter((layer) =>
        layer.type === 'video' &&
        (!layer.videoElement || $videoRasterStatus.get(layer.id)?.state === 'error') &&
        (layer.opacity ?? 1) > 0 &&
        effVisible($layers, layer) &&
        videoStateAtTick(layer.videoClip, $playheadTick, $fps).active
      ) as missingVideo (missingVideo.id)}
        {@const decodeFailed = $videoRasterStatus.get(missingVideo.id)?.state === 'error'}
        {@const geometry = rasterDisplayGeometry(
          $layers,
          missingVideo,
          { w: W, h: H },
          { width: 12, height: 6 },
        )}
        {#if geometry}
          <div class="video-missing" class:active={missingVideo.id === $activeLayerId}
            style="left: calc({geometry.x} * var(--cell-w)); top: calc({geometry.y} * var(--cell-h)); width: calc({geometry.width} * var(--cell-w)); height: calc({geometry.height} * var(--cell-h)); opacity: {geometry.opacity}; transform: translate(-50%, -50%) rotate({geometry.rot}deg);">
            <strong>{decodeFailed ? 'Video could not be read' : 'Video not found'}</strong>
            <span>{missingVideo.name}</span>
          </div>
        {/if}
      {/each}
    {/if}
    {#if activeImage && imgGizmo}
      {@const cw = metrics.cellW}{@const ch = metrics.cellH}
      {@const cxp = imgGizmo.cx * cw}{@const cyp = imgGizmo.cy * ch}
      {@const wpx = imgGizmo.halfW * 2 * cw}{@const hpx = imgGizmo.halfH * 2 * ch}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="img-gizmo" style="left: {cxp}px; top: {cyp}px; width: {wpx}px; height: {hpx}px; transform: translate(-50%,-50%) rotate({imgGizmo.rot}deg);">
        <div class="img-body" onpointerdown={dragImageBody}></div>
        <div class="img-scale tl" onpointerdown={(e) => dragImageScale(e, 'both')}></div>
        <div class="img-scale tr" onpointerdown={(e) => dragImageScale(e, 'both')}></div>
        <div class="img-scale bl" onpointerdown={(e) => dragImageScale(e, 'both')}></div>
        <div class="img-scale br" onpointerdown={(e) => dragImageScale(e, 'both')}></div>
        <div class="img-edge e" title="Scale width" onpointerdown={(e) => dragImageScale(e, 'x')}></div>
        <div class="img-edge s" title="Scale height" onpointerdown={(e) => dragImageScale(e, 'y')}></div>
        <div class="img-rotate" onpointerdown={dragImageRotate}></div>
      </div>
    {/if}

    {#if $activeTool === 'text' && !$playing}
      {#each $layers.filter((l) => l.type === 'text' && effVisible($layers, l) && l.box) as l (l.id)}
        {@const b = layerBox($layers, l)}
        <div class="text-box outline" class:active={l.id === $activeLayerId} style="left: calc({b.x} * var(--cell-w)); top: calc({b.y} * var(--cell-h)); width: calc({b.w} * var(--cell-w)); height: calc({b.h} * var(--cell-h));"></div>
      {/each}
      {#if activeText}
        {@const b = layerBox($layers, activeText)}
        <div class="text-grip" title="Move text" style="left: calc({b.x} * var(--cell-w)); top: calc({b.y} * var(--cell-h));" onpointerdown={(e) => dragTextBox('move', e)}>✜</div>
        <div class="text-resize" title="Resize" style="left: calc({b.x + b.w} * var(--cell-w)); top: calc({b.y + b.h} * var(--cell-h));" onpointerdown={(e) => dragTextBox('resize', e)}></div>
      {/if}
    {/if}
  </div>

  {#if selectionMenu}
    <div class="selection-menu" bind:this={selectionMenuEl} role="menu" tabindex="-1"
      use:popupFocus={{ initialFocus: 'button:not([disabled])' }}
      style="left:{selectionMenu.x}px; top:{selectionMenu.y}px;" data-keyboard-context="canvas"
      onpointerdown={onSelectionMenuPointerDown}>
      <button role="menuitem" onclick={() => selectionAction('transform')}>Transform selection</button>
      <button role="menuitem" onclick={() => selectionAction('move')}>Move</button>
      {#if !editingEffectMask}
        <button role="menuitem" onclick={() => selectionAction('copy')}>New layer via copy</button>
        <button role="menuitem" onclick={() => selectionAction('cut')}>New layer via cut</button>
      {/if}
      <button role="menuitem" onclick={() => selectionAction('deselect')}>Deselect</button>
    </div>
  {/if}

  <div class="zoombar" data-keyboard-context="neutral">
    <label><input type="checkbox" bind:checked={gridOn} /> grid</label>
    <button onclick={zoomOut} title="Zoom out">−</button>
    <span>{zoomPct}%</span>
    <button onclick={zoomIn} title="Zoom in">+</button>
  </div>
</div>

<style>
  .canvas-wrap { grid-area: canvas; background: var(--workspace); position: relative; display: flex; align-items: center; justify-content: center; overflow: clip; }
  .stage {
    flex-shrink: 0;
    position: relative; cursor: crosshair; overflow: visible; background-color: var(--canvas-bg);
    background-image:
      linear-gradient(45deg, var(--transparency-check) 25%, transparent 25%),
      linear-gradient(-45deg, var(--transparency-check) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, var(--transparency-check) 75%),
      linear-gradient(-45deg, transparent 75%, var(--transparency-check) 75%);
    background-size: 16px 16px;
    background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  }
  .stage.brush-cursor {
    cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18'%3E%3Ccircle cx='9' cy='9' r='6' fill='none' stroke='%23000' stroke-opacity='0.6' stroke-width='3'/%3E%3Ccircle cx='9' cy='9' r='6' fill='none' stroke='%23fff' stroke-width='1.5'/%3E%3Ccircle cx='9' cy='9' r='1.5' fill='%23e0a458'/%3E%3C/svg%3E") 9 9, crosshair;
  }
  .stage.move-cursor { cursor: move; }
  .stage.no-cursor { cursor: not-allowed; }
  .stage.pan-cursor { cursor: grab; }
  .stage.playing .hover-canvas,
  .stage.playing .outside-grid,
  .stage.playing .grid-overlay,
  .stage.playing .glyph-overlay,
  .stage.playing .sel-cell,
  .stage.playing .sel-box,
  .stage.playing .move-box,
  .stage.playing .move-done,
  .stage.playing .move-cancel,
  .stage.playing .text-box,
  .stage.playing .text-input,
  .stage.playing .text-grip,
  .stage.playing .text-resize,
  .stage.playing .crop-frame,
  .stage.playing .crop-handle,
  .stage.playing .crop-apply,
  .stage.playing .onion-canvas,
  .stage.playing .shape-guide,
  .stage.playing .shape-handle,
  .stage.playing .img-gizmo { display: none; }
  .stage.eyedrop-cursor {
    cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Cpath d='M14 2l4 4-2 2-4-4zM11 5l4 4-8 8-4 1 1-4z' fill='none' stroke='%23e0a458' stroke-width='1.5'/%3E%3C/svg%3E") 2 18, crosshair;
  }
  .hit-catcher { position: absolute; z-index: 5; background: transparent; }
  .world-canvas { position: absolute; display: block; z-index: 0; pointer-events: none; }
  .cells { position: absolute; left: 0; top: 0; display: block; z-index: 1; transform-origin: center center; }
  .image-canvas { position: absolute; left: 0; top: 0; display: block; z-index: 0; }
  .video-missing {
    position: absolute; z-index: 0; pointer-events: none; box-sizing: border-box;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-width: 80px; min-height: 48px; overflow: hidden; padding: 8px;
    color: var(--text-dim); background: repeating-linear-gradient(135deg, var(--panel) 0 8px, var(--panel-hi) 8px 16px);
    border: 1px dashed var(--text-dim); text-align: center;
  }
  .video-missing.active { border-color: var(--accent); color: var(--text); }
  .video-missing strong { font-size: 12px; }
  .video-missing span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
  .img-gizmo { position: absolute; z-index: 12; box-sizing: border-box; border: 1px dashed var(--accent); }
  .img-body { position: absolute; inset: 0; cursor: move; }
  .img-scale { position: absolute; width: 12px; height: 12px; background: var(--accent); border: 1px solid var(--pure-black); border-radius: 2px; }
  .img-scale.tl { left: -6px; top: -6px; cursor: nwse-resize; }
  .img-scale.tr { right: -6px; top: -6px; cursor: nesw-resize; }
  .img-scale.bl { left: -6px; bottom: -6px; cursor: nesw-resize; }
  .img-scale.br { right: -6px; bottom: -6px; cursor: nwse-resize; }
  .img-edge { position: absolute; width: 12px; height: 12px; background: var(--accent); border: 1px solid var(--pure-black); border-radius: 2px; }
  .img-edge.e { right: -6px; top: 50%; margin-top: -6px; cursor: ew-resize; }
  .img-edge.s { bottom: -6px; left: 50%; margin-left: -6px; cursor: ns-resize; }
  .img-rotate { position: absolute; left: 50%; top: -26px; width: 12px; height: 12px; margin-left: -6px; background: var(--pure-white); border: 1px solid var(--pure-black); border-radius: 50%; cursor: grab; }
  .img-rotate::after { content: ''; position: absolute; left: 50%; top: 12px; width: 1px; height: 14px; background: var(--accent); }
  .hover-canvas { position: absolute; left: 0; top: 0; display: block; pointer-events: none; z-index: 4; opacity: 0.55; }
  .onion-canvas { position: absolute; left: 0; top: 0; display: block; pointer-events: none; z-index: 2; }

  .outside-grid {
    position: absolute; pointer-events: none; z-index: 0; opacity: 0.22;
    background-image:
      linear-gradient(to right, var(--grid-line) 1px, transparent 1px),
      linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px);
    background-size: var(--cell-w) var(--cell-h);
  }

  .grid-overlay {
    position: absolute; inset: 0; pointer-events: none; z-index: 3;
    background-image:
      linear-gradient(to right, var(--grid-line) 1px, transparent 1px),
      linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px);
    background-size: var(--cell-w) var(--cell-h);
  }
  .glyph-overlay {
    position: absolute; pointer-events: none; z-index: 4; opacity: 0.5;
    width: var(--cell-w); height: var(--cell-h);
    font-size: var(--cell-fontpx); line-height: var(--cell-h);
    text-align: center; overflow: visible;
  }
  .sel-cell {
    position: absolute; pointer-events: none; z-index: 5;
    width: var(--cell-w); height: var(--cell-h);
    background: var(--accent-wash); outline: 1px solid var(--selection-outline); outline-offset: -1px;
  }
  .sel-box { position: absolute; pointer-events: none; z-index: 5; box-sizing: border-box; border: 1px dashed var(--accent); background: var(--accent-wash); }
  .move-box { position: absolute; pointer-events: auto; z-index: 12; box-sizing: border-box; border: 1px dashed var(--accent); cursor: move; }
  .move-box.transform-preview { pointer-events: none; background: var(--accent-wash); }
  .transform-controls {
    position: absolute; z-index: 13; box-sizing: border-box; transform: translate(-50%, -50%);
    border: 1px dotted var(--accent-dim); touch-action: none; user-select: none;
  }
  .transform-body {
    position: absolute; inset: 7px; z-index: 1; padding: 0;
    border: 0; background: transparent; cursor: move; touch-action: none;
  }
  .transform-body span {
    position: absolute; left: 50%; top: 50%; width: 14px; height: 14px;
    box-sizing: border-box; transform: translate(-50%, -50%);
    background: var(--panel); border: 1px solid var(--accent); border-radius: 2px;
    pointer-events: none;
  }
  .transform-body span::before,
  .transform-body span::after {
    content: ''; position: absolute; background: var(--accent);
  }
  .transform-body span::before { left: 2px; right: 2px; top: 6px; height: 1px; }
  .transform-body span::after { top: 2px; bottom: 2px; left: 6px; width: 1px; }
  .transform-handle {
    position: absolute; z-index: 2; width: 12px; height: 12px; padding: 0;
    margin: -6px 0 0 -6px; background: var(--accent); border: 2px solid var(--pure-black);
    touch-action: none;
  }
  .transform-handle.nw { left: 0; top: 0; cursor: nwse-resize; }
  .transform-handle.n { left: 50%; top: 0; cursor: ns-resize; }
  .transform-handle.ne { left: 100%; top: 0; cursor: nesw-resize; }
  .transform-handle.e { left: 100%; top: 50%; cursor: ew-resize; }
  .transform-handle.se { left: 100%; top: 100%; cursor: nwse-resize; }
  .transform-handle.s { left: 50%; top: 100%; cursor: ns-resize; }
  .transform-handle.sw { left: 0; top: 100%; cursor: nesw-resize; }
  .transform-handle.w { left: 0; top: 50%; cursor: ew-resize; }
  .move-done {
    position: absolute; z-index: 30; margin: -12px 0 0 6px; width: 28px; height: 28px;
    background: var(--accent); color: var(--pure-black); border: 2px solid var(--pure-black); border-radius: 50%;
    font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    box-shadow: 0 2px 6px var(--shadow-popover);
  }
  .move-done:hover { background: var(--pure-white); }
  .move-cancel {
    position: absolute; z-index: 30; margin: 20px 0 0 6px; width: 28px; height: 28px;
    background: var(--panel); color: var(--text); border: 2px solid var(--pure-black); border-radius: 50%;
    font-size: 19px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    box-shadow: 0 2px 6px var(--shadow-popover);
  }
  .move-cancel:hover { background: var(--danger); color: var(--pure-white); }
  .transform-controls .move-done,
  .transform-controls .move-cancel { left: calc(100% + 10px); top: 0; }
  .transform-controls .move-done { margin: -14px 0 0 0; }
  .transform-controls .move-cancel { margin: 20px 0 0 0; }
  .selection-menu {
    position: fixed; z-index: 80; min-width: 132px; padding: 4px;
    background: var(--panel-hi); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: 0 6px 18px var(--shadow-raised);
  }
  .selection-menu button {
    display: block; width: 100%; padding: 5px 9px; text-align: left;
    background: transparent; color: var(--text); border: 0; border-radius: var(--radius-sm);
  }
  .selection-menu button:hover { background: var(--accent-dim); color: var(--on-accent); }
  .text-box { position: absolute; pointer-events: none; z-index: 4; box-sizing: border-box; }
  .text-box.drag { border: 1px dashed var(--accent); background: var(--accent-wash); }
  .text-box.edit { border: 1px solid var(--accent); }
  .text-box.outline { border: 1px dashed var(--accent-dim); }
  .text-box.outline.active { border-color: var(--accent); }
  .text-grip {
    position: absolute; z-index: 12; margin: -9px 0 0 -9px; width: 18px; height: 18px;
    background: var(--accent); color: var(--pure-black); border: 1px solid var(--pure-black); border-radius: 3px;
    font-size: 12px; line-height: 16px; text-align: center; cursor: move;
  }
  .text-resize {
    position: absolute; z-index: 12; margin: -6px 0 0 -6px; width: 12px; height: 12px;
    background: var(--accent); border: 1px solid var(--pure-black); border-radius: 2px; cursor: nwse-resize;
  }
  .text-input {
    position: absolute; z-index: 12; resize: none;
    background: var(--accent-wash-faint); color: transparent; caret-color: var(--accent);
    border: none; outline: none; padding: 0; margin: 0;
    font-size: var(--cell-fontpx); line-height: var(--cell-h);
    letter-spacing: calc(var(--cell-w) - 1ch); overflow: hidden; white-space: pre-wrap;
    user-select: text; cursor: text;
  }
  .text-input.nowrap { white-space: pre; }
  .text-input::selection { background: var(--accent-dim); }
  .crop-frame { position: absolute; z-index: 8; box-sizing: border-box; border: 1px solid var(--accent); cursor: move; }
  .crop-frame.pending { border-style: dashed; background: var(--accent-wash-faint); }
  .crop-handle { position: absolute; z-index: 11; width: 12px; height: 12px; margin: -6px 0 0 -6px; background: var(--accent); border: 1px solid var(--pure-black); border-radius: 2px; }
  .crop-apply { position: absolute; z-index: 30; margin: 14px 0 0 14px; padding: 3px 8px; background: var(--accent); color: var(--pure-black); border: 1px solid var(--pure-black); border-radius: var(--radius-sm); font-size: 11px; cursor: pointer; white-space: nowrap; box-shadow: 0 2px 6px var(--shadow-popover); }
  .crop-handle.e, .crop-handle.w { cursor: ew-resize; }
  .crop-handle.n, .crop-handle.s { cursor: ns-resize; }
  .crop-handle.ne, .crop-handle.sw { cursor: nesw-resize; }
  .crop-handle.nw, .crop-handle.se { cursor: nwse-resize; }
  .shape-guide { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; z-index: 8; }
  .shape-guide line, .shape-guide polygon, .shape-guide polyline {
    stroke: var(--accent); stroke-width: 1; fill: none; stroke-dasharray: 4 3;
  }
  .shape-guide .rotation-link { stroke-dasharray: none; opacity: 0.7; }
  .shape-guide .shape-hit { stroke: transparent; stroke-width: 10; stroke-dasharray: none; }
  .shape-guide.interactive .shape-hit { pointer-events: stroke; cursor: move; }
  .shape-handle {
    position: absolute; z-index: 11; width: 20px; height: 20px; margin: -10px 0 0 -10px;
    box-sizing: border-box; background: transparent; border: 0;
    cursor: move;
  }
  .shape-handle::before {
    content: ''; position: absolute; inset: 4px; box-sizing: border-box;
    background: var(--accent); border: 2px solid var(--pure-black); border-radius: 2px;
  }
  .shape-handle.edge {
    width: 18px; height: 18px; margin: -9px 0 0 -9px;
  }
  .shape-handle.edge::before { background: var(--panel); border-color: var(--accent); }
  .shape-handle.anchor {
    width: 18px; height: 18px; margin: -9px 0 0 -9px;
  }
  .shape-handle.anchor::before { background: var(--panel); border-color: var(--accent); transform: rotate(45deg); }
  .shape-handle.rotation {
    cursor: grab;
  }
  .shape-handle.rotation::before { border-radius: 50%; background: var(--panel); border-color: var(--accent); }
  .shape-handle.highlighted {
    width: 22px; height: 22px; margin: -11px 0 0 -11px;
  }
  .shape-handle.highlighted::before {
    inset: 3px; background: var(--on-accent); border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-dim);
  }
  .shape-handle.passive { pointer-events: none; }
  .canvas-label { position: absolute; top: 8px; left: 10px; font-size: 11px; color: var(--text-dim); z-index: 10; pointer-events: none; }
  .zoombar { position: absolute; bottom: 8px; right: 10px; display: flex; gap: 6px; align-items: center; font-size: 11px; color: var(--text-dim); z-index: 10; }
  .zoombar button { background: var(--panel); color: var(--text-dim); border: 1px solid var(--border); border-radius: var(--radius-sm); width: 22px; height: 22px; }
  .zoombar button:hover { color: var(--text); border-color: var(--accent-dim); }
  .zoombar label { display: flex; align-items: center; gap: 4px; }
</style>
