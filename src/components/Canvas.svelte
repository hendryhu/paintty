<script module lang="ts">
  import type { EditorPoint as CanvasModulePoint, EditorSize } from '../lib/types/editor-domain.js';
  import type {
    CanvasBackingLayout,
    CanvasViewport,
  } from '../lib/types/canvas-components.js';

  const CANVAS_OVERSCAN = 2;
  const canvasDimensionAdapters = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();

  function finiteCanvasNumber(value: unknown, fallback: number): number {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function visibleCanvasViewport(
    viewportSize: EditorSize,
    documentSize: EditorSize,
    cellSize: EditorSize,
    pan: CanvasModulePoint,
    overscan = CANVAS_OVERSCAN,
  ): CanvasViewport {
    const viewportW = Math.max(1, finiteCanvasNumber(viewportSize.w, 1));
    const viewportH = Math.max(1, finiteCanvasNumber(viewportSize.h, 1));
    const documentW = Math.max(1, finiteCanvasNumber(documentSize.w, 1));
    const documentH = Math.max(1, finiteCanvasNumber(documentSize.h, 1));
    const cellW = Math.max(1, finiteCanvasNumber(cellSize.w, 1));
    const cellH = Math.max(1, finiteCanvasNumber(cellSize.h, 1));
    const extra = Math.max(0, Math.floor(finiteCanvasNumber(overscan, CANVAS_OVERSCAN)));
    const originX = (viewportW - documentW * cellW) / 2 + finiteCanvasNumber(pan.x, 0);
    const originY = (viewportH - documentH * cellH) / 2 + finiteCanvasNumber(pan.y, 0);
    const x = Math.floor(-originX / cellW) - extra;
    const y = Math.floor(-originY / cellH) - extra;
    const right = Math.ceil((viewportW - originX) / cellW) + extra;
    const bottom = Math.ceil((viewportH - originY) / cellH) + extra;
    return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
  }

  function viewportLocalPoint(point: CanvasModulePoint, viewport: CanvasViewport): CanvasModulePoint {
    return { x: point.x - viewport.x, y: point.y - viewport.y };
  }

  function incrementCanvasMetric(canvas: HTMLCanvasElement, key: string): void {
    canvas.dataset[key] = String((Number(canvas.dataset[key]) || 0) + 1);
  }

  function assignCanvasDimension(
    canvas: HTMLCanvasElement,
    dimension: 'width' | 'height',
    value: unknown,
  ): boolean {
    const next = Math.max(0, Math.round(finiteCanvasNumber(value, 0)));
    if (canvas[dimension] === next) return false;
    canvas[dimension] = next;
    incrementCanvasMetric(canvas, dimension === 'width' ? 'widthAssignments' : 'heightAssignments');
    return true;
  }

  function setCanvasPixelStyle(
    canvas: HTMLCanvasElement,
    property: 'width' | 'height' | 'left' | 'top',
    value: number,
  ): void {
    const next = `${value}px`;
    if (canvas.style[property] !== next) canvas.style[property] = next;
  }

  function sizeCanvasBacking(
    canvas: HTMLCanvasElement,
    cssWidth: number,
    cssHeight: number,
    dpr = 1,
  ): CanvasBackingLayout {
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

  function layoutViewportCanvas(
    canvas: HTMLCanvasElement,
    viewport: CanvasViewport,
    cellSize: EditorSize,
    dpr: number,
  ): CanvasBackingLayout {
    const cssWidth = viewport.w * cellSize.w;
    const cssHeight = viewport.h * cellSize.h;
    const layout = sizeCanvasBacking(canvas, cssWidth, cssHeight, dpr);
    setCanvasPixelStyle(canvas, 'left', viewport.x * cellSize.w);
    setCanvasPixelStyle(canvas, 'top', viewport.y * cellSize.h);
    return layout;
  }

  function canvasWithStableDimensions(canvas: HTMLCanvasElement): HTMLCanvasElement {
    let adapter = canvasDimensionAdapters.get(canvas);
    if (adapter) return adapter;
    adapter = {
      get width() { return canvas.width; },
      set width(value) { assignCanvasDimension(canvas, 'width', value); },
      get height() { return canvas.height; },
      set height(value) { assignCanvasDimension(canvas, 'height', value); },
      style: canvas.style,
      getContext(...args: Parameters<HTMLCanvasElement['getContext']>) {
        return Reflect.apply(canvas.getContext, canvas, args);
      },
    } as HTMLCanvasElement;
    canvasDimensionAdapters.set(canvas, adapter);
    return adapter;
  }
</script>

<script lang="ts">
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
            cropPending, isBackgroundLayer, isEditingContentMask, isEditingEffectMask, noteAuthoredMutation } from '../lib/grid.js';
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
           moveState, beginMove, updateMove, updateTransformBounds,
           finalizeMove, cancelMove, minimumTransformWidth, transformBoundsFromDrag,
           TRANSFORM_HANDLES,
           selectionToNewLayer, clearSelection, key as selectionKey } from '../lib/selection.js';
  import { canvasBackingScale, metricsForCellWidth, drawGrid, drawGlyph, drawOnionCells } from '../lib/render.js';
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
    shapeRotationAngle,
    shapeTransformCageVertices,
    shapeTransformHandles,
    transformShapeFromCageHandle,
    transformShapeFromHandle,
  } from '../lib/shapeTransform.js';
  import {
    applyRasterBodyDrag,
    captureRasterBodyDrag,
    rasterBodyDelta,
    type RasterSnapGuides,
  } from '../lib/rasterBodyDrag.js';
  import {
    rasterDisplayGeometry,
    rasterLayerSourceSize,
    rasterScaleFromDrag,
  } from '../lib/layerPosition.js';
  import {
    captureGestureOwner,
    canvasEscapeAction,
    canvasPointerStartsPan,
    gestureOwnerMatches,
    gesturePointerMatches,
    moveToolChangeAction,
  } from '../lib/gestureOwnership.js';
  import type { Readable } from 'svelte/store';
  import type {
    EditorBounds,
    EditorBoxStyle,
    EditorCellGrid,
    EditorImageLayer,
    EditorLayer,
    EditorLayerTransform,
    EditorPoint,
    EditorShape,
    EditorShapeAppearance,
    EditorShapeChannel,
    EditorShapeDetail,
    EditorShapeKind,
    EditorShapeLayer,
    EditorShapeStyle,
    EditorTextLayer,
    EditorTool,
    EditorVideoLayer,
  } from '../lib/types/editor-domain.js';
  import type { EditorFontMetrics } from '../lib/render.js';
  import type { GestureOwner } from '../lib/gestureOwnership.js';
  import type { TextGesture } from '../lib/textHitTest.js';
  import type { ShapeTransformHandle } from '../lib/shapeTransform.js';
  import type { CropHandle } from '../lib/crop.js';
  import type { ProjectLayer } from '../lib/types/project-types.js';
  import type {
    CanvasHover,
    CanvasImageGizmo,
    CanvasMoveAnchor,
    CanvasOffsetDrag,
    CanvasOnionGhost,
    CanvasOwnershipContext,
    CanvasPointerGesture,
    CanvasPointerGestureKind,
    CanvasProps,
    CanvasSelectionAction,
    CanvasSelectionRect,
    CanvasShapeDrag,
    CanvasTextEdit,
    CanvasTextInputState,
    StartPointerGestureOptions,
    WindowDragOptions,
    WindowDragStop,
  } from '../lib/types/canvas-components.js';

  type StoreValue<T> = T extends Readable<infer Value> ? Value : never;
  type SelectionMoveState = NonNullable<StoreValue<typeof moveState>>;
  type SelectionMode = ReturnType<typeof selectionModeForModifiers>;
  type SelectionTransformHandle = Parameters<typeof transformBoundsFromDrag>[1];
  type ShapeGlyph = ReturnType<typeof shapeGlyphs>[number];
  type TextGestureSelection = NonNullable<ReturnType<typeof textGestureSelection>>;
  type RasterLayer = EditorImageLayer | EditorVideoLayer;
  type PointerElementEvent<T extends HTMLElement = HTMLElement> = PointerEvent & {
    currentTarget: EventTarget & T;
  };
  type MouseElementEvent<T extends HTMLElement = HTMLElement> = MouseEvent & {
    currentTarget: EventTarget & T;
  };
  type LineAnchor = EditorPoint & {
    sx: number;
    sy: number;
    owner: Readonly<GestureOwner>;
  };
  type SubcellPoint = { sx: number; sy: number };
  type PanGesture = { sx: number; sy: number; px: number; py: number };
  type SelectionMenuPosition = EditorPoint;

  const CROP_HANDLES: readonly Exclude<CropHandle, 'move'>[] = [
    'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w',
  ];
  const SELECTION_TRANSFORM_HANDLES = TRANSFORM_HANDLES as readonly Exclude<SelectionTransformHandle, 'body'>[];

  // App mounts <Canvas /> without data props and coordinates crop through the
  // window events below. Keep the former bubbled pointer callback explicit.
  let { onpointerdown = undefined }: CanvasProps = $props();


  function disp(hex: string | null | undefined): string {
    if (!hex) return '';
    return $colorDepth === '256' ? nearest256(hex).hex : hex;
  }

  function blankShapeAcceptsTool(
    layer: EditorLayer | null,
    tool: EditorShapeKind,
    drag: CanvasShapeDrag,
    frame: number,
  ): layer is EditorShapeLayer {
    const pathEnabled = layer?.type === 'shape' && isShapePathTrackEnabled(layer.id);
    const ownerActive = layer?.id != null &&
      !!findActiveTimelineClip(getClipTimelineState(), layer.id, frame);
    return blankShapeLayerAcceptsKind(
      layer,
      pathEnabled,
      pathEnabled ? shapePathAt(layer.id, frame)?.kind ?? null : null,
      shapeSpec(tool, drag).kind,
      ownerActive,
    );
  }

  const ZOOM_STEPS = [8, 11, 14, 18, 24, 32, 44, 60];
  let zoomIdx = $state<number>(3);
  function zoomIn(): void { zoomIdx = Math.min(ZOOM_STEPS.length - 1, zoomIdx + 1); }
  function zoomOut(): void { zoomIdx = Math.max(0, zoomIdx - 1); }
  function onWheel(event: WheelEvent): void {
    if (!event.ctrlKey) return;
    event.preventDefault();
    if (event.deltaY < 0) zoomIn(); else zoomOut();
  }
  function fitToViewport(): void {
    const wrap = canvasWrapEl?.getBoundingClientRect(); if (!wrap) return;
    const pad = 24;
    let best = 0;
    for (let i = 0; i < ZOOM_STEPS.length; i++) {
      const m = metricsForCellWidth($canvasFont, ZOOM_STEPS[i]!);
      if (W * m.cellW <= wrap.width - pad && H * m.cellH <= wrap.height - pad) best = i;
    }
    zoomIdx = best;
    pan = { x: 0, y: 0 };
  }
  let lastFitDims = $state<string>('');

  let pan = $state<EditorPoint>({ x: 0, y: 0 });
  let spaceHeld = $state<boolean>(false);
  let panning = $state<PanGesture | null>(null);
  function onPanKeyDown(event: KeyboardEvent): void {
    if (event.code !== 'Space' || isTypingTarget(event.target) || get(popupOpen) ||
      getKeyboardContext() === 'timeline') return;
    event.preventDefault();
    if (event.target instanceof HTMLElement) event.target.blur();
    spaceHeld = true;
  }
  function onPanKeyUp(event: KeyboardEvent): void {
    if (event.code !== 'Space' || isTypingTarget(event.target) || get(popupOpen) ||
      (getKeyboardContext() === 'timeline' && !spaceHeld)) return;
    event.preventDefault();
    spaceHeld = false;
  }
  function isTypingTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  }
  function beginPan(event: PointerEvent): void {
    const pointerId = event.pointerId;
    const state: PanGesture = { sx: event.clientX, sy: event.clientY, px: pan.x, py: pan.y };
    panning = state;
    trackWindowDrag(pointerId, (event) => {
      pan = { x: state.px + event.clientX - state.sx, y: state.py + event.clientY - state.sy };
    }, () => { panning = null; }, { owned: false });
  }

  let metrics = $state<EditorFontMetrics>({ cellW: 11, cellH: 22, baseline: 17, fontPx: 18, advance: 11 });
  let fontReady = $state<boolean>(false);
  function remeasure(): void {
    metrics = metricsForCellWidth($canvasFont, targetW ?? ZOOM_STEPS[0]!);
    updateCanvasViewportState();
    const root = document.documentElement.style;
    root.setProperty('--cell-w', `${metrics.cellW}px`);
    root.setProperty('--cell-h', `${metrics.cellH}px`);
    root.setProperty('--cell-fontpx', `${metrics.fontPx}px`);
    root.setProperty('--cell-baseline', `${metrics.baseline}px`);
    redraw();
  }

  let canvasEl = $state<HTMLCanvasElement | null>(null);
  let hoverCanvasEl = $state<HTMLCanvasElement | null>(null);
  let imageCanvasEl = $state<HTMLCanvasElement | null>(null);
  function drawImages(): void {
    if (!imageCanvasEl) return;
    const vp = canvasViewport;
    const { cssWidth: w, cssHeight: h } = layoutViewportCanvas(
      imageCanvasEl,
      vp,
      { w: metrics.cellW, h: metrics.cellH },
      canvasDpr,
    );
    const ctx = imageCanvasEl.getContext('2d')!;
    ctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (let i = $layers.length - 1; i >= 0; i--) {
      const layer = $layers[i];
      if (!layer || (layer.type !== 'image' && layer.type !== 'video') ||
        !layer.raster || !effVisible($layers, layer)) continue;
      if (layer.type === 'video' && !videoStateAtTick(layer.videoClip, $playheadTick, $fps).active) continue;
      if (layer.type === 'video' && $videoRasterStatus.get(layer.id)?.state === 'error') continue;
      const geometry = rasterDisplayGeometry($layers, layer, { w: W, h: H });
      if (!geometry) continue;
      const center = viewportLocalPoint({ x: geometry.x, y: geometry.y }, vp);
      const cxpx = center.x * metrics.cellW;
      const cypx = center.y * metrics.cellH;
      ctx.save();
      ctx.globalAlpha = geometry.opacity;
      ctx.translate(cxpx, cypx);
      ctx.rotate(geometry.rot * Math.PI / 180);
      const sx = geometry.scaleX * metrics.cellW;
      const sy = geometry.scaleY * (metrics.cellH / 2);
      ctx.scale(sx, sy);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(layer.raster, -layer.raster.width / 2, -layer.raster.height / 2);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
  let blinkOn = $state<boolean>(true);
  function redraw(): void {
    if (!canvasEl) return;
    drawGrid(canvasWithStableDimensions(canvasEl), visibleGrid, metrics, {
      fontFamily: $canvasFont,
      disp,
      canvasBg: readThemeColor('--canvas-bg', canvasEl),
      fillBg: false, // Preserve image layers below terminal cells.
    });
  }

  let canvasViewportSize = $state<{ w: number; h: number }>({ w: 1, h: 1 });
  let canvasDpr = $state<number>(1);

  function updateCanvasViewportState(): void {
    const rect = canvasWrapEl?.getBoundingClientRect();
    if (rect) {
      const next = { w: Math.max(1, rect.width), h: Math.max(1, rect.height) };
      if (next.w !== canvasViewportSize.w || next.h !== canvasViewportSize.h) canvasViewportSize = next;
    }
    const nextDpr = canvasBackingScale(
      window.devicePixelRatio,
      W * metrics.cellW,
      H * metrics.cellH,
    );
    if (nextDpr !== canvasDpr) canvasDpr = nextDpr;
  }

  let worldCanvasEl = $state<HTMLCanvasElement | null>(null);
  function drawWorld(): void {
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
    const ctx = worldCanvasEl.getContext('2d')!;
    ctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    ctx.font = `${metrics.fontPx}px ${$canvasFont}`;
    ctx.globalAlpha = 0.28;
    for (let y = 0; y < vp.h; y++) for (let x = 0; x < vp.w; x++) {
      const c = cells[y]?.[x]; if (!c || !c.offCanvas) continue;
      if (c.bg) { ctx.fillStyle = disp(c.bg); ctx.fillRect(x * metrics.cellW, y * metrics.cellH, metrics.cellW, metrics.cellH); }
      if (c.c) drawGlyph(ctx, c.c, disp(c.fg) || '#fff', x, y, metrics);
    }
    ctx.globalAlpha = 1;
  }

  function drawHover(): void {
    if (!hoverCanvasEl) return;
    const vp = canvasViewport;
    const { cssWidth: w, cssHeight: h } = layoutViewportCanvas(
      hoverCanvasEl,
      vp,
      { w: metrics.cellW, h: metrics.cellH },
      canvasDpr,
    );
    const ctx = hoverCanvasEl.getContext('2d')!;
    ctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!hover) return;
    const x = hover.x - vp.x, y = hover.y - vp.y;
    if (x < 0 || y < 0 || x >= vp.w || y >= vp.h) return;
    if (editingMask) {
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
  let onionCanvasEl = $state<HTMLCanvasElement | null>(null);
  function drawOnion(): void {
    if (!onionCanvasEl) return;
    const w = W * metrics.cellW, h = H * metrics.cellH;
    sizeCanvasBacking(onionCanvasEl, w, h, canvasDpr);
    const ctx = onionCanvasEl.getContext('2d')!;
    ctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = `${metrics.fontPx}px ${$canvasFont}`;
    const colors: Record<CanvasOnionGhost['direction'], string> = {
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
    let dprMediaQuery: MediaQueryList | null = null;
    const unwatchDpr = (): void => {
      dprMediaQuery?.removeEventListener('change', onDprChange);
    };
    const watchDpr = (): void => {
      unwatchDpr();
      dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprMediaQuery.addEventListener('change', onDprChange);
    };
    const onDprChange = (): void => {
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
    const onApplyCrop = (): void => { void applyCrop(); };
    const onCancelCrop = (): void => { cancelPendingCrop(); };
    window.addEventListener('apply-crop', onApplyCrop);
    window.addEventListener('cancel-crop', onCancelCrop);
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
      window.removeEventListener('apply-crop', onApplyCrop);
      window.removeEventListener('cancel-crop', onCancelCrop);
    };
  });

  let canvasWrapEl = $state<HTMLDivElement | null>(null);
  let gridEl = $state<HTMLDivElement | null>(null);
  let gridOn = $state<boolean>(true);

  let painting: boolean = false;
  let last: EditorPoint | null = null;
  let lastSub: SubcellPoint | null = null;
  let temporaryErase = $state<boolean>(false);
  let lineAnchor: LineAnchor | null = null;
  let colorSamplePointer: number | null = null;
  let pointerGesture = $state<CanvasPointerGesture | null>(null);
  let activeWindowDrag = $state<WindowDragStop | null>(null);
  let activeWindowOwner = $state<Readonly<GestureOwner> | null>(null);
  let activeWindowOwnsMoveState = $state<boolean>(false);
  let rasterSnapGuides = $state<RasterSnapGuides>({ x: null, y: null });

  function clearRasterSnapGuides(): void {
    if (rasterSnapGuides.x !== null || rasterSnapGuides.y !== null) {
      rasterSnapGuides = { x: null, y: null };
    }
  }

  // Snapshot gesture ownership so context changes cancel a drag before it can mutate a new target.
  function currentOwnershipContext(): CanvasOwnershipContext {
    return {
      layerId: $activeLayerId,
      frameIndex: $activeFrameIndex,
      tool: $activeTool,
      layerPart: $activeLayerPart,
      projectRevision: captureProjectRevision(),
    };
  }


  function ownGesture(
    pointerId: number | null,
    overrides: Partial<CanvasOwnershipContext> = {},
  ): Readonly<GestureOwner> {
    return captureGestureOwner({ ...currentOwnershipContext(), ...overrides }, pointerId);
  }

  function ownerIsCurrent(owner: GestureOwner): boolean {
    return gestureOwnerMatches(owner, currentOwnershipContext());
  }

  function startPointerGesture(
    kind: CanvasPointerGestureKind,
    event: Pick<PointerEvent, 'pointerId'>,
    options: StartPointerGestureOptions = {},
  ): CanvasPointerGesture {
    const gesture: CanvasPointerGesture = {
      kind,
      owner: ownGesture(event?.pointerId, options.owner),
      historyOpen: !!options.historyOpen,
      ownsMoveState: !!options.ownsMoveState,
      freshPaintOwner: typeof options.freshPaintOwnerId === 'string',
      freshPaintOwnerId: typeof options.freshPaintOwnerId === 'string'
        ? options.freshPaintOwnerId
        : null,
      contentMutated: false,
    };
    pointerGesture = gesture;
    return gesture;
  }

  function recordPaintMutation<Changed>(changed: Changed): Changed {
    if (changed && pointerGesture) pointerGesture.contentMutated = true;
    return changed;
  }

  function clearPointerGestureState(): void {
    clearRasterSnapGuides();
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
    temporaryErase = false;
  }

  function abortPointerGesture(): void {
    if (pointerGesture?.ownsMoveState && get(moveState)) cancelMove();
    else if (pointerGesture?.historyOpen) cancelStroke();
    clearPointerGestureState();
  }

  function pointerGestureAccepts(event: Pick<PointerEvent, 'pointerId'>): boolean {
    if (!pointerGesture) return false;
    if (!gesturePointerMatches(pointerGesture.owner, event?.pointerId)) return false;
    if (!ownerIsCurrent(pointerGesture.owner)) {
      abortPointerGesture();
      return false;
    }
    return true;
  }


  function coordinatesAt(event: Pick<PointerEvent, 'clientX' | 'clientY'>) {
    if (!gridEl) throw new Error('Canvas stage is not mounted.');
    return canvasCoordinates(
      event,
      gridEl.getBoundingClientRect(),
      { w: metrics.cellW, h: metrics.cellH },
      { w: W, h: H },
    );
  }

  const MUTATING = new Set<EditorTool>(['brush', 'eraser', 'subcell', 'fill']);
  const STROKE_TOOLS = new Set<EditorTool>(['brush', 'eraser', 'subcell']);
  const SHAPE_TOOLS = new Set<EditorShapeKind>(['line', 'rect', 'circle', 'polygon']);
  const CANVAS_BOUND = new Set<EditorTool>(['crop']);

  function isShapeTool(tool: EditorTool | string | null): tool is EditorShapeKind {
    return typeof tool === 'string' && SHAPE_TOOLS.has(tool as EditorShapeKind);
  }

  function isProjectLayerList(value: unknown): value is ProjectLayer[] {
    return Array.isArray(value) && value.every((layer: unknown) =>
      layer !== null && typeof layer === 'object' &&
      'id' in layer && typeof layer.id === 'string' &&
      'name' in layer && typeof layer.name === 'string' &&
      'type' in layer && typeof layer.type === 'string' &&
      'visible' in layer && typeof layer.visible === 'boolean' &&
      'cells' in layer && layer.cells !== null && typeof layer.cells === 'object');
  }


  function preparePaintOwner(tool: EditorTool): { ready: boolean; createdId: string | null } {
    const state = getClipTimelineState();
    const disposition = paintOwnerDisposition(tool, activeLayer, {
      activePart: $activeLayerPart,
      activeClip: !!findActiveTimelineClip(state, activeLayer?.id, $activeFrameIndex),
      effectiveVisible: !!activeLayer && effVisible($layers, activeLayer),
    });
    if (disposition === 'blocked') return { ready: false, createdId: null };
    if (disposition !== 'create') return { ready: true, createdId: null };
    if (activeLayer?.type !== 'cell' && activeLayer?.type !== 'background') {
      return { ready: false, createdId: null };
    }
    if (beginStroke() !== true) return { ready: false, createdId: null };
    const createdId = createPaintLayer(activeLayer.type);
    if (!createdId) {
      cancelStroke();
      return { ready: false, createdId: null };
    }
    return { ready: true, createdId };
  }

  let shapeDrag: CanvasShapeDrag | null = null;
  let shapePreview = $state<ShapeGlyph[]>([]);
  function specialBrushMode(): EditorBoxStyle | null {
    const options = $toolOptions.subcell || {};
    const mode = options.mode || options.resolution || 'half';
    return mode in BOX_STYLES ? mode as EditorBoxStyle : null;
  }
  function shapeSpec(tool: EditorShapeKind, d: CanvasShapeDrag): EditorShape {
    const selectedLayer = get(layers).find((layer) => layer.id === get(activeLayerId)) || null;
    const drawingMask = isEditingEffectMask(selectedLayer) || isEditingContentMask(selectedLayer);
    const rawOpts: EditorShapeAppearance = $toolOptions[tool];
    const opts = drawingMask ? maskShapeAppearance(rawOpts) : rawOpts;
    const channel: EditorShapeChannel = drawingMask ? 'background' : (opts.channel || 'glyph');
    const styled = !drawingMask && channel === 'glyph' &&
      (tool === 'rect' || tool === 'circle' || tool === 'line' || tool === 'polygon');
    const style: EditorShapeStyle = styled && (opts.style === 'special' || opts.style === 'slope')
      ? opts.style
      : (opts.style === 'filled' ? 'filled' : 'outline');
    const detail: EditorShapeDetail = drawingMask || channel !== 'glyph' || style === 'special' || style === 'slope'
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
      mix: channel === 'color-clip' ? 1 : undefined,
      wide: !drawingMask && channel === 'glyph' && style !== 'special' &&
        style !== 'slope' && detail === 'cell' && isWide($activeChar),
    } as EditorShape;
    if (tool === 'polygon') {
      shape.vertices = regularPolygonVertices(d.x0, d.y0, d.x1, d.y1, shape.sides);
      shape.anchor = { x: (d.x0 + d.x1) / 2, y: (d.y0 + d.y1) / 2 };
      shape.rotation = 0;
    }
    return constrainShape(shape);
  }

  let selDrag = $state<CanvasSelectionRect | null>(null);
  let lassoPts: EditorPoint[] | null = null;
  let selectionGestureMode: SelectionMode | null = null;
  let moveAnchor: CanvasMoveAnchor | null = null;
  let offsetDrag: CanvasOffsetDrag | null = null;
  let selectionMenu = $state<SelectionMenuPosition | null>(null);
  let selectionMenuEl = $state<HTMLDivElement | null>(null);

  async function onSelectionContext(event: MouseElementEvent<HTMLDivElement>): Promise<void> {
    if ($activeTool !== 'select' || !$selection.size) return;
    const { x, y } = coordinatesAt(event).cell;
    if (!$selection.has(selectionKey(x, y))) return;
    event.preventDefault();
    event.stopPropagation();
    setKeyboardContext('canvas');
    selectionMenu = { x: event.clientX, y: event.clientY };
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
  function selectionAction(action: CanvasSelectionAction): void {
    selectionMenu = null;
    if (action === 'move') beginMove();
    else if (action === 'copy') selectionToNewLayer(false);
    else if (action === 'cut') selectionToNewLayer(true);
    else if (action === 'deselect') selection.set(new Set());
  }
  function onSelectionMenuPointerDown(event: PointerEvent): void {
    event.stopPropagation();
    onpointerdown?.(event);
  }
  function onActionPointerDown(
    event: PointerEvent,
    action: (event?: PointerEvent) => unknown,
  ): unknown {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    return action(event);
  }
  function onCanvasWindowKey(event: KeyboardEvent): void {
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
      const pointerId = pointerGesture?.owner.pointerId ?? null;
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

  let textEdit = $state<CanvasTextEdit | null>(null);
  let textValue = $state<string>('');
  let textInputEl = $state<HTMLTextAreaElement | null>(null);
  let textGesture = $state<TextGesture | null>(null);
  let textEditSession: number = 0;
  // Controlled textarea rendering replaces the browser's native undo state.
  const textInputHistory = createControlledTextHistory();

  function resetCanvasInteractions(): void {
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

  function rasterColorAt(x: number, y: number, fx = 0.5, fy = 0.5): string | null {
    if (!imageCanvasEl || !inBounds(x, y)) return null;
    try {
      const vp = canvasViewport;
      const sample = viewportLocalPoint({ x: x + fx, y: y + fy }, vp);
      const scaleX = imageCanvasEl.width / (vp.w * metrics.cellW);
      const scaleY = imageCanvasEl.height / (vp.h * metrics.cellH);
      const px = Math.max(0, Math.min(imageCanvasEl.width - 1,
        Math.floor(sample.x * metrics.cellW * scaleX)));
      const py = Math.max(0, Math.min(imageCanvasEl.height - 1,
        Math.floor(sample.y * metrics.cellH * scaleY)));
      const [r, g, b, a] = imageCanvasEl.getContext('2d')!.getImageData(px, py, 1, 1).data;
      if (!a) return null;
      return `#${[r!, g!, b!].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    } catch {
      return null;
    }
  }

  function visibleSampleCell(x: number, y: number, fx = 0.5, fy = 0.5) {
    const terminal = visibleGrid?.[y]?.[x] || null;
    return displayedSampleCell(terminal, rasterColorAt(x, y, fx, fy));
  }

  function colorForSessionSample(x: number, y: number, fx = 0.5, fy = 0.5): string | null {
    if (editingMask) {
      if (isEditingContentMask(activeLayer)) return getCell(x, y)?.bg || null;
      const strength = getCell(x, y)?.mask ??
        (activeLayer?.type === 'effect' ? activeLayer.mask?.defaultStrength : undefined);
      if (strength == null) return null;
      const byte = Math.round(Math.max(0, Math.min(1, strength)) * 255)
        .toString(16).padStart(2, '0');
      return `#${byte}${byte}${byte}`;
    }
    const target = $colorEditSession.target;
    const targetLayer = target?.kind === 'shape' ? getLayer(target.layerId) : null;
    const targetShape = targetLayer?.type === 'shape' ? targetLayer : null;
    const preferBackground = targetShape
      ? targetShape.shape?.channel !== 'glyph'
      : target?.kind === 'toolbar' && activeBackground;
    return visibleColorFromCell(visibleSampleCell(x, y, fx, fy), preferBackground);
  }

  function beginSessionSample(
    event: PointerElementEvent<HTMLDivElement>,
    x: number,
    y: number,
    fx: number,
    fy: number,
  ): boolean {
    if ($colorEditSession.phase !== 'sampling' || event.button !== 0) return false;
    event.preventDefault();
    event.stopPropagation();
    colorSamplePointer = event.pointerId;
    const color = colorForSessionSample(x, y, fx, fy);
    if (color) colorEditSession.sample(color);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    return true;
  }

  function onPointerDown(event: PointerElementEvent<HTMLDivElement>): void {
    if (isTypingTarget(event.target)) return;
    if (canvasPointerStartsPan(spaceHeld, event.button)) { event.preventDefault(); beginPan(event); return; }
    const point = coordinatesAt(event);
    const { x, y } = point.cell;
    const { x: fx, y: fy } = point.withinCell;
    const { x: sx, y: sy } = point.subcell;
    if (beginSessionSample(event, x, y, fx, fy)) return;
    const rightErase = event.button === 2 &&
      ($activeTool === 'brush' || $activeTool === 'subcell') && !wrongLayer;
    if (event.button !== 0 && !rightErase) return;
    if ($playing) return;
    event.preventDefault();
    temporaryErase = rightErase;
    const sampling = $altEyedrop && (isBrush || $activeTool === 'fill' || isShapeTool($activeTool));
    if (wrongLayer && !sampling) return;
    if (CANVAS_BOUND.has($activeTool) && !inBounds(x, y)) return;

    if ($moveState) {
      if ($moveState.mode === 'transform') return;
      startPointerGesture('selection-move', event, {
        historyOpen: true,
        ownsMoveState: true,
        owner: {
          layerId: $moveState.layerId,
          layerPart: $moveState.target === 'mask' ? 'mask' : $moveState.target === 'content-mask' ? 'content-mask' : 'layer',
        },
      });
      moveAnchor = { x, y, dx0: $moveState.dx, dy0: $moveState.dy };
      painting = true; event.currentTarget.setPointerCapture?.(event.pointerId); return;
    }

    if (sampling) {
      if (editingMask) {
        if (isEditingContentMask(activeLayer)) {
          const color = getCell(x, y)?.bg;
          if (color) paintColor.set(color);
          return;
        }
        const strength = getCell(x, y)?.mask ??
          (activeLayer?.type === 'effect' ? activeLayer.mask?.defaultStrength : undefined) ?? 1;
        const byte = Math.round(strength * 255).toString(16).padStart(2, '0');
        paintColor.set(`#${byte}${byte}${byte}`);
      } else {
        const cell = visibleSampleCell(x, y, fx, fy);
        const backgroundTarget = activeBackground ||
          (isShapeTool($activeTool) && $toolOptions[$activeTool].channel !== 'glyph');
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
        startPointerGesture('selection-move', event, {
          historyOpen: true,
          ownsMoveState: true,
          owner: {
            layerId: state.layerId,
            layerPart: state.target === 'mask' ? 'mask' : state.target === 'content-mask' ? 'content-mask' : 'layer',
          },
        });
        moveAnchor = { x, y, dx0: state.dx, dy0: state.dy };
        painting = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        return;
      }
      if (!activeLayer) return;
      const sourceLayer = getLayer($activeLayerId);
      const isMask = editingMask;
      const origin = isMask && sourceLayer?.type === 'effect' ? sourceLayer.mask?.offset : sourceLayer?.offset;
      const rasterDrag = isMask || $activeLayerId == null ? null : captureRasterBodyDrag($activeLayerId);
      startPointerGesture('layer-move', event, { historyOpen: true });
      offsetDrag = { x, y, startX: x, startY: y, o0: { ...(origin || { x: 0, y: 0 }) },
        animatePosition: isMask ? isMaskPositionTrackEnabled($activeLayerId) : anyPosKeys($activeLayerId),
        isMask,
        rasterDrag,
        shapeDrag: isMask || $activeLayerId == null ? null : captureShapeBodyDrag($activeLayerId, $activeFrameIndex),
        isCell: activeLayerType === 'cell' || activeLayerType === 'background', type: activeLayerType,
        dx: 0, dy: 0, lastDx: 0, lastDy: 0,
        box0: sourceLayer?.box ? { ...sourceLayer.box } : null };
      if (rasterDrag) clearRasterSnapGuides();
      beginStroke();
      painting = true; event.currentTarget.setPointerCapture?.(event.pointerId); return;
    }
    if ($activeTool === 'text') {
      const onLayer = topTextLayerAt(x, y);
      finishTextEdit();
      startPointerGesture('text', event);
      textGesture = beginTextGesture(x, y, onLayer?.id, {
        x: fx,
        y: fy,
        onGlyph: textLayerHasGlyph(onLayer, x, y, {
          boxOf: (layer) => layerBox($layers, layer) || layer.box,
          isVisible: (layer) => effVisible($layers, layer),
          offsetOf: (layer) => effOffset($layers, layer),
        }),
      });
      painting = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (isShapeTool($activeTool)) {
      const initialShapeDrag = { x0: x, y0: y, x1: x, y1: y };
      const fillsBlankShapeCel = blankShapeAcceptsTool(
        activeLayer,
        $activeTool,
        initialShapeDrag,
        $activeFrameIndex,
      );
      startPointerGesture('shape-create', event, {
        historyOpen: editingMask || fillsBlankShapeCel,
      });
      shapeDrag = initialShapeDrag; shapePreview = [];
      if (editingMask || fillsBlankShapeCel) beginStroke();
      painting = true; event.currentTarget.setPointerCapture?.(event.pointerId); return;
    }
    if ($activeTool === 'crop') return;
    if ($activeTool === 'select') {
      if ($selection.size && $selection.has(selectionKey(x, y))) return;
      startPointerGesture('select', event);
      selectionGestureMode = selectionModeForModifiers(event);
      const selectionShape: string = $toolOptions.select.shape;
      if (selectionShape === 'lasso') lassoPts = [{ x, y }];
      else selDrag = { x0: x, y0: y, x1: x, y1: y };
      painting = true; event.currentTarget.setPointerCapture?.(event.pointerId); return;
    }
    const paintOwner = preparePaintOwner($activeTool);
    if (!paintOwner.ready) return;
    startPointerGesture('paint', event, {
      historyOpen: MUTATING.has($activeTool),
      freshPaintOwnerId: paintOwner.createdId,
    });
    painting = true; last = { x, y }; lastSub = { sx, sy };
    if (MUTATING.has($activeTool) && !paintOwner.createdId) beginStroke();
    const straightAnchor = event.shiftKey && STROKE_TOOLS.has($activeTool) &&
      gestureOwnerMatches(lineAnchor?.owner, currentOwnershipContext())
      ? lineAnchor
      : null;
    const special = !temporaryErase && $activeTool === 'subcell' ? specialBrushMode() : null;
    if (straightAnchor && special) {
      recordPaintMutation(paintSpecialBrushPath(
        [{ x: straightAnchor.x, y: straightAnchor.y }, { x, y }],
        special,
      ));
    } else if (straightAnchor && $activeTool === 'subcell') {
      for (const q of linePoints(straightAnchor.sx, straightAnchor.sy, sx, sy)) {
        const cx = Math.floor(q.x / 2), cy = Math.floor(q.y / 2);
        const qfx = (((q.x % 2) + 2) % 2 === 0) ? 0.25 : 0.75;
        const qfy = (((q.y % 2) + 2) % 2 === 0) ? 0.25 : 0.75;
        applyToolToSelection(cx, cy, event, 'move', qfx, qfy);
      }
    } else if (straightAnchor) {
      const wide = $activeTool === 'brush' && isWide(previewChar(fx, fy));
      const pts = linePoints(straightAnchor.x, straightAnchor.y, x, y);
      for (let i = 0; i < pts.length; i++) {
        if (wide && i % 2) continue;
        const point = pts[i];
        if (point) applyToolToSelection(point.x, point.y, event, 'move', fx, fy);
      }
    } else if (special) {
      // Semantic line brushes need at least two distinct cells. A click/hold with no
      // movement is an accidental no-op, unlike Half and Quarter subcell painting.
    } else {
      applyToolToSelection(x, y, event, 'down', fx, fy);
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function applyToolToSelection(
    x: number,
    y: number,
    event: PointerEvent,
    kind: 'down' | 'move',
    fx: number,
    fy: number,
  ): false | void | true | number {
    if (isSelected(x, y)) {
      const sampledCell = $activeTool === 'eyedropper'
        ? visibleSampleCell(x, y, fx, fy)
        : undefined;
      return recordPaintMutation(applyTool(
        x, y, event, kind, fx, fy, sampledCell, temporaryErase ? 'eraser' : null,
      ));
    }
    return false;
  }

  function onPointerMove(event: PointerElementEvent<HTMLDivElement>): void {
    const point = coordinatesAt(event);
    const { x, y } = point.cell;
    const { x: fx, y: fy } = point.withinCell;
    const { x: sx, y: sy } = point.subcell;
    if (colorSamplePointer === event.pointerId && $colorEditSession.phase === 'sampling') {
      event.preventDefault();
      event.stopPropagation();
      hover = null;
      const color = colorForSessionSample(x, y, fx, fy);
      if (color) colorEditSession.sample(color);
      return;
    }
    if (isBrush && !wrongLayer && !event.altKey) {
      hoverCellX = x; hoverCellY = y;
      hover = { x, y, char: previewChar(fx, fy) };
    } else hover = null;

    if (!painting) return;
    if (!pointerGestureAccepts(event)) return;
    const gesture = pointerGesture;
    if (!gesture) return;
    const owner = gesture.owner;
    const ownerLayerId = owner.layerId;
    const gestureTool = owner.tool;
    if (offsetDrag) {
      if (ownerLayerId == null) {
        abortPointerGesture();
        return;
      }
      const dx = x - offsetDrag.startX, dy = y - offsetDrag.startY;
      if (!offsetDrag.rasterDrag && dx === offsetDrag.dx && dy === offsetDrag.dy) return;
      offsetDrag.dx = dx; offsetDrag.dy = dy;
      const stepX = dx - offsetDrag.lastDx, stepY = dy - offsetDrag.lastDy;
      if (offsetDrag.isMask) {
        const next = { x: offsetDrag.o0.x + dx, y: offsetDrag.o0.y + dy };
        if (offsetDrag.animatePosition) {
          setMaskPositionById(owner.frameIndex, ownerLayerId, next);
        } else {
          setEffectMaskOffsetDirect(ownerLayerId, next);
        }
      } else if (offsetDrag.rasterDrag) {
        const delta = rasterBodyDelta(
          offsetDrag.rasterDrag,
          dx,
          dy,
          event.ctrlKey || event.metaKey ? null : { w: W, h: H },
        );
        if (!delta) return;
        rasterSnapGuides = delta.guides;
        if (delta.dx === offsetDrag.lastDx && delta.dy === offsetDrag.lastDy) return;
        applyRasterBodyDrag(offsetDrag.rasterDrag, owner.frameIndex, delta.dx, delta.dy);
        offsetDrag.lastDx = delta.dx;
        offsetDrag.lastDy = delta.dy;
      } else if (offsetDrag.animatePosition) {
        setLayerOffsetById(owner.frameIndex, ownerLayerId, { x: offsetDrag.o0.x + dx, y: offsetDrag.o0.y + dy });
      } else if (offsetDrag.isCell) {
        if (stepX || stepY) { translateLayerCells(ownerLayerId, stepX, stepY); offsetDrag.lastDx = dx; offsetDrag.lastDy = dy; }
      } else if (offsetDrag.shapeDrag) {
        applyShapeBodyDrag(offsetDrag.shapeDrag, owner.frameIndex, dx, dy);
      } else if (offsetDrag.type === 'text' && offsetDrag.box0) {
        const b = offsetDrag.box0;
        updateTextLayer(ownerLayerId, { box: { ...b, x: b.x + dx, y: b.y + dy } }, renderTextToCells);
      } else {
        setLayerOffsetDirect(ownerLayerId, { x: offsetDrag.o0.x + dx, y: offsetDrag.o0.y + dy });
      }
      return;
    }
    if ($moveState && moveAnchor) { updateMove(moveAnchor.dx0 + (x - moveAnchor.x), moveAnchor.dy0 + (y - moveAnchor.y)); return; }
    if (gestureTool === 'text' && textGesture) {
      textGesture = moveTextGesture(textGesture, x, y, { x: fx, y: fy });
      return;
    }
    if (isShapeTool(gestureTool) && shapeDrag) {
      shapeDrag = { ...shapeDrag, x1: x, y1: y };
      const preview = shapeGlyphs(shapeSpec(gestureTool, shapeDrag));
      shapePreview = owner.layerPart !== 'layer'
        ? preview.filter((point) => isSelected(point.x, point.y))
        : preview;
      return;
    }
    if (gestureTool === 'select') {
      if (lassoPts) { lassoPts = [...lassoPts, { x, y }]; return; }
      if (selDrag) { selDrag = { ...selDrag, x1: x, y1: y }; return; }
    }
    if (gestureTool === 'subcell') {
      const special = temporaryErase ? null : specialBrushMode();
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
        applyToolToSelection(cx, cy, event, 'move', qfx, qfy);
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
        applyToolToSelection(p.x, p.y, event, 'move', fx, fy);
      }
      last = { x, y };
      return;
    }
    last = { x, y };
    applyToolToSelection(x, y, event, 'move', fx, fy);
  }

  function onPointerUp(event: PointerElementEvent<HTMLDivElement>): void {
    if (colorSamplePointer !== null &&
      colorSamplePointer === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      colorSamplePointer = null;
      colorEditSession.finishSampling();
      return;
    }
    if (!painting && !offsetDrag && !moveAnchor && !shapeDrag && !selDrag && !lassoPts &&
      !textGesture) return;
    if (pointerGesture && !pointerGestureAccepts(event)) return;
    const owner = pointerGesture?.owner;
    const gestureTool = owner?.tool ?? $activeTool;
    if (offsetDrag) {
      const changed = offsetDrag.rasterDrag
        ? offsetDrag.lastDx !== 0 || offsetDrag.lastDy !== 0
        : offsetDrag.dx !== 0 || offsetDrag.dy !== 0;
      if (changed) endStroke();
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
        if (layer?.type === 'text' && box) editExistingText(layer, textGestureSelection(layer, box, gesture));
      } else if (result?.action === 'create') {
        startTextEdit(result.box);
      }
      return;
    }
    if ($moveState && moveAnchor) { clearPointerGestureState(); return; }
    if (isShapeTool(gestureTool) && shapeDrag) {
      if (owner?.layerPart !== 'layer') {
        if (shapeDragHasExtent(shapeDrag) && shapePreview.length) {
          setCells(shapePreview.map(({ x, y }) => ({ x, y, cell: { fg: $paintColor } })));
          endStroke();
        } else {
          cancelStroke();
        }
      } else {
        const spec = shapeSpec(gestureTool, shapeDrag);
        const blankShapeLayer = getLayer(owner?.layerId ?? null);
        if (hasShapeExtent(spec) && blankShapeAcceptsTool(
          blankShapeLayer,
          gestureTool,
          shapeDrag,
          owner?.frameIndex ?? $activeFrameIndex,
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
      if (selDrag) {
        if (selDrag.x0 !== selDrag.x1 || selDrag.y0 !== selDrag.y1) commitRect(normSel(selDrag));
        clearPointerGestureState(); return;
      }
    }
    const strokeTool = gestureTool === 'brush' || gestureTool === 'eraser' || gestureTool === 'subcell'
      ? gestureTool
      : null;
    if (!temporaryErase && strokeTool && last &&
      (!pointerGesture?.freshPaintOwner || pointerGesture.contentMutated)) {
      lineAnchor = {
        x: last.x, y: last.y,
        sx: lastSub?.sx ?? last.x * 2, sy: lastSub?.sy ?? last.y * 2,
        owner: owner ?? ownGesture(null, { tool: strokeTool }),
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

  function cancelPointerInteraction(event: PointerElementEvent<HTMLDivElement>): void {
    if (colorSamplePointer !== null &&
      colorSamplePointer === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      colorSamplePointer = null;
      colorEditSession.cancel();
      return;
    }
    if (pointerGesture && !gesturePointerMatches(pointerGesture.owner, event.pointerId)) return;
    abortPointerGesture();
  }

  function onWindowBlur(): void {
    spaceHeld = false;
    panning = null;
    if (colorSamplePointer !== null) {
      colorSamplePointer = null;
      colorEditSession.cancel();
      return;
    }
    abortPointerGesture();
  }

  function normSel(drag: CanvasSelectionRect): CanvasSelectionRect {
    return { x0: Math.min(drag.x0, drag.x1), y0: Math.min(drag.y0, drag.y1), x1: Math.max(drag.x0, drag.x1), y1: Math.max(drag.y0, drag.y1) };
  }
  function shapeDragHasExtent(drag: CanvasShapeDrag): boolean {
    return Math.round(drag.x0) !== Math.round(drag.x1) ||
      Math.round(drag.y0) !== Math.round(drag.y1);
  }
  function commitRect(rect: CanvasSelectionRect): void {
    const cells: EditorPoint[] = [];
    for (let y = rect.y0; y <= rect.y1; y++) for (let x = rect.x0; x <= rect.x1; x++) cells.push({ x, y });
    if (selectionGestureMode) applyRegion(cells, selectionGestureMode);
    else applyRegion(cells);
  }
  function commitLasso(pts: EditorPoint[]): void {
    if (pts.length < 3) return;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const inside = (px: number, py: number): boolean => {
      let c = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i]!.x, yi = pts[i]!.y, xj = pts[j]!.x, yj = pts[j]!.y;
        if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) c = !c;
      }
      return c;
    };
    const cells: EditorPoint[] = [];
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (inside(x + 0.5, y + 0.5)) cells.push({ x, y });
    if (selectionGestureMode) applyRegion(cells, selectionGestureMode);
    else applyRegion(cells);
  }

  function topTextLayerAt(x: number, y: number): EditorTextLayer | null {
    return textLayerAt($layers, $activeLayerId, x, y, {
      isVisible: (layer) => effVisible($layers, layer),
      offsetOf: (layer) => effOffset($layers, layer),
      boxOf: (layer) => layerBox($layers, layer) || layer.box,
    });
  }

  async function startTextEdit(box: EditorBounds): Promise<void> {
    const wrap = $toolOptions.text.wrap;
    beginStroke();
    const id = createTextLayer(box, '', $paintColor, wrap, renderTextToCells) as string;
    const sessionId = ++textEditSession;
    const session = { layerId: id, box, wrap, created: true, historyOpen: true, sessionId };
    textEdit = session;
    textValue = '';
    resetTextInputHistory();
    rememberTextSelection(id, 0, 0);
    await tick();
    if (textEdit?.sessionId === sessionId) textInputEl?.focus({ preventScroll: true });
  }
  async function editExistingText(
    layer: EditorTextLayer,
    selection: TextGestureSelection | null = null,
  ): Promise<void> {
    selectLayer(layer.id);
    const wrap = layer.wrap !== false;
    toolOptions.update((options) => options.text.wrap === wrap ? options : ({
      ...options,
      text: { ...options.text, wrap },
    }));
    const sessionId = ++textEditSession;
    const session = {
      layerId: layer.id,
      box: layerBox($layers, layer) || layer.box,
      wrap,
      created: false,
      historyOpen: false,
      sessionId,
    };
    textEdit = session;
    textValue = layer.text || '';
    resetTextInputHistory();
    await tick();
    if (textEdit?.sessionId !== sessionId || !textInputEl) return;
    textInputEl.focus({ preventScroll: true });
    const start = Math.max(0, Math.min(textValue.length, selection?.start ?? textValue.length));
    const end = Math.max(start, Math.min(textValue.length, selection?.end ?? start));
    textInputEl.setSelectionRange(start, end, selection?.direction || 'none');
    rememberCurrentTextSelection();
  }
  function rememberCurrentTextSelection(event?: Event): void {
    if (!textEdit || !textInputEl) return;
    rememberTextSelection(
      textEdit.layerId,
      textInputEl.selectionStart ?? 0,
      textInputEl.selectionEnd ?? 0,
      event?.type || 'programmatic',
    );
  }
  function beginTextHistory(): void {
    if (!textEdit || textEdit.historyOpen) return;
    beginStroke();
    textEdit = { ...textEdit, historyOpen: true };
  }
  function resetTextInputHistory(): void {
    textInputHistory.reset();
  }
  function captureTextInputState(): CanvasTextInputState | null {
    const layer = textEdit ? getLayer(textEdit.layerId) : null;
    if (!textEdit || layer?.type !== 'text') return null;
    return {
      text: textValue,
      runs: (layer.runs || []).map((run) => ({ ...run })),
      start: textInputEl?.selectionStart ?? textValue.length,
      end: textInputEl?.selectionEnd ?? textValue.length,
      direction: textInputEl?.selectionDirection || 'none',
    };
  }
  function onTextBeforeInput(event: InputEvent): void {
    if (!textEdit) return;
    textInputHistory.beforeInput(event, captureTextInputState());
  }
  async function restoreTextInputState(state: CanvasTextInputState | null): Promise<void> {
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
  function onTextInput(): void {
    if (!textEdit) return;
    const layer = getLayer(textEdit.layerId);
    if (layer?.type !== 'text') return;
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
  function updateActiveTextWrap(wrap: boolean): void {
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
  function commitText(event?: Event): void {
    rememberCurrentTextSelection(event);
    if (textEdit?.historyOpen) endStroke();
    textEdit = null;
    textValue = '';
    resetTextInputHistory();
  }
  function cancelEmptyText(): void {
    const id = textEdit?.layerId;
    if (textEdit?.historyOpen) cancelStroke();
    clearTextSelection(id);
    textEdit = null;
    textValue = '';
    resetTextInputHistory();
  }
  function finishTextEdit(event?: Event): void {
    if (textEdit?.created && textValue.length === 0) cancelEmptyText();
    else commitText(event);
  }
  function onTextKey(event: KeyboardEvent): void {
    if (textInputHistory.keydown(event, captureTextInputState(), restoreTextInputState)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finishTextEdit(event);
    }
  }
  function onPointerLeave(): void { hover = null; }


  function updateRasterTransform(
    layerId: string,
    baseTransform: EditorLayerTransform,
    patch: Partial<EditorLayerTransform>,
  ): void {
    layers.update(($l) => $l.map((l) => (l.id === layerId ? {
      ...l,
      transform: { ...baseTransform, ...patch },
    } : l)));
    noteAuthoredMutation();
  }
  // Window drags replace any prior owner and revalidate its captured editor context
  // before every move; their finish/cancel callbacks own history cleanup.
  function trackWindowDrag(
    pointerId: number,
    move: (event: PointerEvent) => void,
    finish: () => void = () => {},
    options: WindowDragOptions = {},
  ): void {
    activeWindowDrag?.(true);
    const owner = options.owned === false ? null : (options.owner || ownGesture(pointerId));
    const cancel = options.cancel || finish;
    let open = true;
    const close = (cancelled: boolean, event: PointerEvent | null = null): void => {
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
    const stop: WindowDragStop = (cancelled = true, event = null) => close(cancelled, event);
    const onMove = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return;
      if (owner && !ownerIsCurrent(owner)) { stop(true, event); return; }
      move(event);
    };
    const onUp = (event: PointerEvent): void => stop(false, event);
    const onCancel = (event: PointerEvent): void => stop(true, event);
    const onBlur = (): void => stop(true);
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
  function dragImageBody(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const owner = ownGesture(event.pointerId);
    if (owner.layerId == null) return;
    const drag = captureRasterBodyDrag(owner.layerId);
    if (!drag) return;
    clearRasterSnapGuides();
    beginStroke();
    const start = coordinatesAt(event).fractional;
    let current = { dx: 0, dy: 0 };
    const move = (nextEvent: PointerEvent): void => {
      const p = coordinatesAt(nextEvent).fractional;
      const delta = rasterBodyDelta(
        drag,
        p.x - start.x,
        p.y - start.y,
        nextEvent.ctrlKey || nextEvent.metaKey ? null : { w: W, h: H },
      );
      if (!delta) return;
      rasterSnapGuides = delta.guides;
      if (delta.dx === current.dx && delta.dy === current.dy) return;
      current = delta;
      applyRasterBodyDrag(drag, owner.frameIndex, delta.dx, delta.dy);
    };
    trackWindowDrag(event.pointerId, move, () => {
      clearRasterSnapGuides();
      if (!current.dx && !current.dy) cancelStroke();
      else endStroke();
    }, { owner, cancel: () => {
      clearRasterSnapGuides();
      cancelStroke();
    } });
  }
  function dragImageScale(event: PointerEvent, axis: 'x' | 'y' | 'both' = 'both'): void {
    if (event.button !== 0 || !activeImage || !imgGizmo || !gridEl) return;
    event.preventDefault(); event.stopPropagation();
    const owner = ownGesture(event.pointerId);
    if (owner.layerId == null) return;
    const layerId = owner.layerId;
    const image = activeImage;
    const gizmo = { ...imgGizmo };
    beginStroke();
    const t0: EditorLayerTransform = {
      ...image.transform,
      x: image.transform.x ?? W / 2,
      y: image.transform.y ?? H / 2,
      scale: image.transform.scale ?? 1,
      rot: image.transform.rot ?? 0,
    };
    const s0x = t0.scaleX ?? t0.scale ?? 1, s0y = t0.scaleY ?? t0.scale ?? 1;
    let current = { x: s0x, y: s0y };
    const cxpx = gizmo.cx * metrics.cellW, cypx = gizmo.cy * metrics.cellH;
    const r = gridEl.getBoundingClientRect();
    const angle = -(gizmo.rot || 0) * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const localVector = (pointerEvent: PointerEvent): EditorPoint => {
      const dx = pointerEvent.clientX - r.left - cxpx;
      const dy = pointerEvent.clientY - r.top - cypx;
      return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
    };
    const initial = localVector(event);
    const dx0 = initial.x, dy0 = initial.y;
    const move = (nextEvent: PointerEvent): void => {
      const local = localVector(nextEvent);
      const next = rasterScaleFromDrag(
        { x: s0x, y: s0y },
        initial,
        local,
        axis === 'both' ? null : axis,
        nextEvent.shiftKey,
      );
      const nx = next.x, ny = next.y;
      if (nx === current.x && ny === current.y) return;
      current = { x: nx, y: ny };
      updateRasterTransform(layerId, t0, { scaleX: nx, scaleY: ny, scale: undefined });
    };
    trackWindowDrag(event.pointerId, move, () => {
      if (current.x === s0x && current.y === s0y) cancelStroke();
      else endStroke();
    }, { owner, cancel: cancelStroke });
  }
  function dragImageRotate(event: PointerEvent): void {
    if (event.button !== 0 || !activeImage || !imgGizmo || !gridEl) return;
    event.preventDefault(); event.stopPropagation();
    const owner = ownGesture(event.pointerId);
    if (owner.layerId == null) return;
    const layerId = owner.layerId;
    const image = activeImage;
    const gizmo = { ...imgGizmo };
    beginStroke();
    const t0: EditorLayerTransform = {
      ...image.transform,
      x: image.transform.x ?? W / 2,
      y: image.transform.y ?? H / 2,
      scale: image.transform.scale ?? 1,
      rot: image.transform.rot ?? 0,
    };
    const initial = Number(t0.rot) || 0;
    let current = initial;
    const cxpx = gizmo.cx * metrics.cellW, cypx = gizmo.cy * metrics.cellH;
    const r = gridEl.getBoundingClientRect();
    const move = (nextEvent: PointerEvent): void => {
      const ang = Math.atan2(nextEvent.clientY - r.top - cypx, nextEvent.clientX - r.left - cxpx) * 180 / Math.PI + 90;
      let a = ang; if (nextEvent.shiftKey) a = Math.round(a / 15) * 15;
      const next = Math.round(a);
      if (next === current) return;
      current = next;
      updateRasterTransform(layerId, t0, { rot: next });
    };
    trackWindowDrag(event.pointerId, move, () => {
      if (current === initial) cancelStroke();
      else endStroke();
    }, { owner, cancel: cancelStroke });
  }
  function dragTextBox(mode: 'move' | 'resize', event: PointerEvent): void {
    if (event.button !== 0 || activeText?.type !== 'text') return;
    event.preventDefault();
    event.stopPropagation();
    const owner = ownGesture(event.pointerId);
    const id = activeText.id;
    const editing = textEdit?.layerId === id;
    const historyWasOpen = !!(editing && textEdit?.historyOpen);
    const b0 = { ...activeText.box };
    const start = coordinatesAt(event).cell;
    let changed = false;
    const move = (nextEvent: PointerEvent): void => {
      const point = coordinatesAt(nextEvent).cell;
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
        textEdit = { ...textEdit, box: updated ? layerBox(get(layers), updated) || box : box };
      }
    };
    trackWindowDrag(event.pointerId, move, () => {
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
            box: layerBox(get(layers), restored) || b0,
            historyOpen: historyWasOpen,
          };
        }
      },
    });
  }
  function dragSelectionTransform(handle: SelectionTransformHandle, event: PointerEvent): void {
    const current = get(moveState);
    if (event.button !== 0 || !current ||
      (handle !== 'body' && current.mode !== 'transform')) return;
    event.preventDefault();
    event.stopPropagation();
    const owner = ownGesture(event.pointerId, {
      layerId: current.layerId,
      layerPart: current.target === 'mask' ? 'mask' : current.target === 'content-mask' ? 'content-mask' : 'layer',
    });
    const startBounds = { ...current.bounds };
    const start = coordinatesAt(event).fractional;
    const move = (nextEvent: PointerEvent): void => {
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
  function dragShapeBody(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const owner = ownGesture(event.pointerId);
    if (owner.layerId == null) return;
    beginStroke();
    const drag = captureShapeBodyDrag(owner.layerId, owner.frameIndex);
    if (!drag) { cancelStroke(); return; }
    const start = coordinatesAt(event).cell;
    let current = { dx: 0, dy: 0 };
    const move = (nextEvent: PointerEvent): void => {
      const p = coordinatesAt(nextEvent).cell;
      const dx = p.x - start.x, dy = p.y - start.y;
      if (dx === current.dx && dy === current.dy) return;
      current = { dx, dy };
      applyShapeBodyDrag(drag, owner.frameIndex, dx, dy);
    };
    trackWindowDrag(event.pointerId, move, () => {
      if (current.dx || current.dy) endStroke();
      else cancelStroke();
    }, { owner, cancel: cancelStroke });
  }
  function shapeHandleType(value: string | undefined): { type?: ShapeTransformHandle['type'] } {
    return value === 'vertex' || value === 'edge' || value === 'anchor' || value === 'rotation'
      ? { type: value }
      : {};
  }
  function dragShapeHandle(which: string, event: PointerEvent): void {
    if (event.button !== 0 || !gridEl || activeShape?.type !== 'shape' || !activeShape.shape) return;
    event.preventDefault(); event.stopPropagation();
    const hitTargets = [...gridEl.querySelectorAll<HTMLElement>('.shape-handle:not(.passive)')]
      .map((node, stackOrder) => ({
        id: node.dataset['shapeHandleId'],
        ...shapeHandleType(node.dataset['shapeHandleType']),
        stackOrder,
        rect: node.getBoundingClientRect(),
      }));
    const handleId = pickShapeTransformHandle(
      hitTargets,
      { x: event.clientX, y: event.clientY },
    ) || which;
    const owner = ownGesture(event.pointerId);
    if (owner.layerId == null) return;
    beginStroke();
    const id = owner.layerId;
    const s0 = activeShape.shape;
    const rotationAspect = metrics.cellW / metrics.cellH;
    const moving = shapeTransformHandles(s0, { rotationAspect })
      .find((handle) => handle.id === handleId);
    if (!moving) { cancelStroke(); return; }
    const startClient = { x: event.clientX, y: event.clientY };
    const initialPath = pathValueFromShape(s0);
    let currentPath = initialPath;
    const rotationAnchor = moving.type === 'rotation' ? resolvedShapeAnchor(s0) : null;
    // Accumulate shortest angular steps so crossing ±π never snaps the gesture backward.
    let rotationAngle = rotationAnchor
      ? shapeRotationAngle(moving, rotationAnchor, rotationAspect) ?? 0
      : 0;
    let rotationDelta = 0;
    const move = (nextEvent: PointerEvent): void => {
      const target = shapeHandleDragTarget(
        moving,
        startClient,
        { x: nextEvent.clientX, y: nextEvent.clientY },
        { w: metrics.cellW, h: metrics.cellH },
      );
      if (!target) return;
      if (rotationAnchor && Math.hypot(
        target.x - rotationAnchor.x,
        target.y - rotationAnchor.y,
      ) > 1e-9) {
        const nextAngle = shapeRotationAngle(target, rotationAnchor, rotationAspect) ?? rotationAngle;
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
        ctrl: nextEvent.ctrlKey,
        alt: nextEvent.altKey,
        shift: nextEvent.shiftKey,
        rotationDelta: rotationAnchor ? rotationDelta : undefined,
        rotationAspect,
      });
      if (!next) return;
      const nextPath = pathValueFromShape(next);
      if (shapePathEqual(nextPath, currentPath)) return;
      currentPath = nextPath;
      applyShapeGeometryEdit(id, owner.frameIndex, next, s0);
    };
    trackWindowDrag(event.pointerId, move, () => {
      if (shapePathEqual(currentPath, initialPath)) cancelStroke();
      else endStroke();
    }, { owner, cancel: cancelStroke });
  }

  function shapeHandleTitle(handle: ShapeTransformHandle): string {
    if (handle.type === 'anchor') return 'Move transform anchor';
    if (handle.type === 'rotation') return 'Rotate';
    if (handle.localMove) return `Move ${handle.label.toLowerCase()}`;
    return handle.label;
  }

  function shapeHandleCursor(handle: ShapeTransformHandle, shape: EditorShape): string {
    if (handle.type === 'anchor') return 'move';
    if (handle.type === 'rotation') return 'grab';
    const anchor = resolvedShapeAnchor(shape);
    const dx = handle.x - anchor.x;
    const dy = handle.y - anchor.y;
    if (handle.localMove) return 'move';
    const angle = (Math.atan2(dy * metrics.cellH, dx * metrics.cellW) * 180 / Math.PI + 180) % 180;
    if (angle < 22.5 || angle >= 157.5) return 'ew-resize';
    if (angle < 67.5) return 'nwse-resize';
    if (angle < 112.5) return 'ns-resize';
    return 'nesw-resize';
  }

  let hover = $state<CanvasHover | null>(null);
  let hoverCellX: number = -1;
  let hoverCellY: number = -1;
  function previewChar(fx = 0.5, fy = 0.5, x = hoverCellX, y = hoverCellY): string {
    if ($activeTool === 'eraser' || temporaryErase) return '';
    if ($activeTool === 'subcell') {
      const special = specialBrushMode();
      if (special) {
        const points = painting && last ? [last, { x, y }] : [{ x, y }];
        return previewSpecialBrushGlyph(points, x, y, special);
      }
      const options = $toolOptions.subcell || {};
      const resolution = options.mode === 'quarter' || options.resolution === 'quarter'
        ? 'quarter'
        : 'half';
      const bits = bitsForStroke(resolution, fy < 0.5, fx < 0.5);
      const resolved = applySubcell(getCell(hoverCellX, hoverCellY), bits, $paintColor);
      return resolved?.c || '';
    }
    return $activeChar;
  }

  function startCrop(handle: CropHandle, event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (canvasPointerStartsPan(spaceHeld, event.button)) {
      beginPan(event);
      return;
    }
    const owner = ownGesture(event.pointerId);
    const original = $cropPending ? { ...$cropPending } : null;
    const base = original || canvasCrop(W, H);
    const startX = event.clientX, startY = event.clientY;
    const move = (nextEvent: PointerEvent): void => {
      const next = dragCrop(
        base,
        handle,
        (nextEvent.clientX - startX) / metrics.cellW,
        (nextEvent.clientY - startY) / metrics.cellH,
      );
      cropPending.set(next);
    };
    trackWindowDrag(event.pointerId, move, () => {}, {
      owner,
      cancel: () => cropPending.set(original),
    });
  }
  async function applyCrop(): Promise<void> {
    const rect = $cropPending || canvasCrop(W, H);
    if (cropDiffers(rect, W, H)) cropTimeline(rect);
    cropPending.set(null);
    await tick();
    fitToViewport();
    window.dispatchEvent(new CustomEvent('crop-finished'));
  }
  function cancelPendingCrop(): void {
    activeWindowDrag?.(true);
    cropPending.set(null);
    window.dispatchEvent(new CustomEvent('crop-finished'));
  }
  let W = $derived<number>($dims.w);
  let H = $derived<number>($dims.h);
  let targetW = $derived<number>(ZOOM_STEPS[zoomIdx] ?? ZOOM_STEPS[0]!);
  let zoomPct = $derived<number>(Math.round((targetW / 18) * 100));
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
    untrack(() => {
      if (isProjectLayerList(layerList)) syncVisibleMediaResources(layerList, clipIds);
    });
  });
  $effect.pre(() => {
    const layerList = $layers;
    const tickValue = $playheadTick;
    const fpsValue = $fps;
    const allowIntermediate = $playing;
    const requestedClipIds = new Set($videoDecodeRequests.keys());
    untrack(() => {
      if (isProjectLayerList(layerList)) {
        syncVideoLayerFrames(layerList, tickValue, fpsValue, {
          allowIntermediate,
          requestedClipIds,
        });
      }
    });
  });
  $effect(() => {
    if (imageCanvasEl) {
      $layers;
      W;
      H;
      metrics;
      $videoFrameRevision;
      $videoRasterStatus;
      $playheadTick;
      $fps;
      canvasViewportKey;
      canvasDpr;
      untrack(drawImages);
    }
  });
  let anyBlink = $derived<boolean>(hasVisibleBlinkingGlyph($layers));
  let visibleGrid = $derived<EditorCellGrid>(applyBlinkPhase(normalizeOutputGrid($grid, W, H), blinkOn));
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
  let canvasViewportKey = $derived<string>(`${canvasViewport.x},${canvasViewport.y},${canvasViewport.w},${canvasViewport.h}`);
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
  let activeLayer = $derived<EditorLayer | null>($layers.find((layer) => layer.id === $activeLayerId) || null);
  let activeBackground = $derived<boolean>(isBackgroundLayer(activeLayer));
  let editingMask = $derived<boolean>(isEditingEffectMask(activeLayer) || isEditingContentMask(activeLayer));
  $effect(() => {
    if (hoverCanvasEl) {
      hover;
      metrics;
      canvasViewportKey;
      canvasDpr;
      $paintColor;
      $activeTool;
      activeBackground;
      editingMask;
      $colorDepth;
      untrack(drawHover);
    }
  });
  let onionGhosts = $derived<CanvasOnionGhost[]>((() => {
    if ($playing || $onionSkin === 'off') return [];
    const layerIdx = $onionSkin === 'layer' ? $layers.findIndex((l) => l.id === $activeLayerId) : null;
    if ($onionSkin === 'layer' && (layerIdx ?? -1) < 0) return [];
    const out: CanvasOnionGhost[] = [];
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
  let ownershipContext = $derived<CanvasOwnershipContext>({
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
  function isVideoLayer(layer: EditorLayer): layer is EditorVideoLayer {
    return layer.type === 'video';
  }
  function selectionCoordinate(key: string, index: 0 | 1): number {
    return Number(key.split(',')[index] ?? 0);
  }

  let activeLayerType = $derived<EditorLayer['type'] | null>(activeLayer?.type || null);
  let wrongLayer = $derived<boolean>(isToolDisabledForLayer($activeTool, activeLayer, $activeLayerPart));
  let shapeBackground = $derived<boolean>(isShapeTool($activeTool) &&
    (editingMask || $toolOptions[$activeTool].channel !== 'glyph'));
  let textEditLayout = $derived(textEdit ? layoutText(textValue, textEdit.box.w, textEdit.wrap) : null);
  let textEditRows = $derived<number>(textEdit && textEditLayout ? Math.max(textEdit.box.h, textEditLayout.lineCount) : 1);
  let textEditColumns = $derived<number>(textEdit && textEditLayout ? textLayoutColumns(textEditLayout, textEdit.box.w) : 1);
  let activeTextGestureBox = $derived<EditorBounds | null>(textGestureBox(textGesture));
  let shapeGeometryHoverDetailValue = $derived($shapeGeometryHover);
  let shapeHoverVisible = $derived<boolean>(!$playing &&
    shapeGeometryHoverDetailValue?.layerId === $activeLayerId);
  let selectedShapeLayer = $derived<EditorShapeLayer | null>((() => {
    const layer = $layers.find((candidate) => candidate.id === $activeLayerId);
    return layer?.type === 'shape' && effVisible($layers, layer) && layer.shape ? layer : null;
  })());
  let shapeDirectEdit = $derived(shapeDirectEditTarget(
    selectedShapeLayer,
    $activeTool,
    $playing,
    shapeHoverVisible,
  ));
  let shapeHandlesInteractive = $derived<boolean>(shapeDirectEdit.interactive);
  let activeShape = $derived<EditorShapeLayer | null>(shapeDirectEdit.layer);
  let activeText = $derived<EditorTextLayer | null>((() => {
    if ($playing) return null;
    const layer = $layers.find((candidate) => candidate.id === $activeLayerId);
    return layer?.type === 'text' && effVisible($layers, layer) ? layer : null;
  })());
  $effect(() => {
    const edit = textEdit;
    if (edit && !$layers.some((layer) => layer.id === edit.layerId)) {
      if (edit.historyOpen) endStroke();
      clearTextSelection(edit.layerId);
      textEdit = null;
      textValue = '';
      textGesture = null;
    }
  });
  let activeImage = $derived<RasterLayer | null>((() => {
    if ($playing || $activeTool !== 'move') return null;
    const layer = $layers.find((candidate) => candidate.id === $activeLayerId);
    if (!layer || (layer.type !== 'image' && layer.type !== 'video') ||
      !effVisible($layers, layer) || !rasterLayerSourceSize(layer) ||
      (layer.type === 'video' && !videoStateAtTick(layer.videoClip, $playheadTick, $fps).active)) return null;
    return layer;
  })());
  let imgGizmo = $derived<CanvasImageGizmo | null>((() => {
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
  let moveBounds = $derived<EditorBounds | null>($moveState?.bounds || null);
  let isBrush = $derived<boolean>(BRUSH_TOOLS.has($activeTool));
  let missingVideoLayers = $derived<EditorVideoLayer[]>($layers.filter((layer): layer is EditorVideoLayer =>
    isVideoLayer(layer) &&
    (!layer.videoElement || $videoRasterStatus.get(layer.id)?.state === 'error') &&
    (layer.opacity ?? 1) > 0 &&
    effVisible($layers, layer) &&
    videoStateAtTick(layer.videoClip, $playheadTick, $fps).active));
  $effect.pre(() => {
    if ($activeTool !== 'crop' && $cropPending) untrack(() => cropPending.set(null));
  });
</script>
<svelte:window onblur={onWindowBlur} onkeydowncapture={onCanvasWindowKey} />


<div class="canvas-wrap scroll" bind:this={canvasWrapEl} data-keyboard-context="canvas"
  role="application" aria-label="Artwork canvas"
  onwheel={onWheel} onpointerdowncapture={(event) => noteKeyboardContext({
    target: event.target instanceof Element ? event.target : null,
  })}
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
    {#if gridOn}
      <div class="outside-grid"
        style="left: {canvasViewport.x * metrics.cellW}px; top: {canvasViewport.y * metrics.cellH}px; width: {canvasViewport.w * metrics.cellW}px; height: {canvasViewport.h * metrics.cellH}px;"></div>
      <div class="grid-overlay"></div>
    {/if}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <canvas bind:this={worldCanvasEl} class="world-canvas"></canvas>
    <canvas bind:this={imageCanvasEl} class="image-canvas"></canvas>
    <canvas bind:this={onionCanvasEl} class="onion-canvas"></canvas>
    <canvas bind:this={canvasEl} class="cells"></canvas>
    <canvas bind:this={hoverCanvasEl} class="hover-canvas"></canvas>

    {#each shapePreview as p}
      <div class="glyph-overlay" class:bg-preview={shapeBackground}
        style="left: calc({p.x} * var(--cell-w)); top: calc({p.y} * var(--cell-h)); color: {disp($paintColor)}; background: {shapeBackground ? disp($paintColor) : 'transparent'}; font-family: {$canvasFont};">{shapeBackground ? '' : p.ch}</div>
    {/each}
    {#if !$moveState}
      {#each [...$selection] as k}
        {@const sx = selectionCoordinate(k, 0)}
        {@const sy = selectionCoordinate(k, 1)}
        <div class="sel-cell" style="left: calc({sx} * var(--cell-w)); top: calc({sy} * var(--cell-h));"></div>
      {/each}
    {/if}
    {#if selDrag}
      {@const s = normSel(selDrag)}
      <div class="sel-box" style="left: calc({s.x0} * var(--cell-w)); top: calc({s.y0} * var(--cell-h)); width: calc({s.x1 - s.x0 + 1} * var(--cell-w)); height: calc({s.y1 - s.y0 + 1} * var(--cell-h));"></div>
    {/if}

    {#if $moveState && moveBounds}
      <div class="move-box" class:transform-preview={$moveState.mode === 'transform'}
        role="button" aria-label="Move selection" tabindex="-1"
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
          {#each SELECTION_TRANSFORM_HANDLES as handle}
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

    {#if activeTextGestureBox}
      <div class="text-box drag" style="left: calc({activeTextGestureBox.x} * var(--cell-w)); top: calc({activeTextGestureBox.y} * var(--cell-h)); width: calc({activeTextGestureBox.w} * var(--cell-w)); height: calc({activeTextGestureBox.h} * var(--cell-h));"></div>
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
      <div class="crop-frame" class:pending={!!$cropPending} role="button" aria-label="Move crop" tabindex="-1" style="left: calc({crop.x} * var(--cell-w)); top: calc({crop.y} * var(--cell-h)); width: calc({crop.w} * var(--cell-w)); height: calc({crop.h} * var(--cell-h));" onpointerdown={(e) => startCrop('move', e)}></div>
      {#each CROP_HANDLES as cropHandle}
        <div class="crop-handle {cropHandle}" role="button" aria-label={`Resize crop ${cropHandle}`} tabindex="-1"
          style={cropHandle === 'nw' ? `left: calc(${crop.x} * var(--cell-w)); top: calc(${crop.y} * var(--cell-h));` :
            cropHandle === 'n' ? `left: calc((${crop.x} + ${crop.w} / 2) * var(--cell-w)); top: calc(${crop.y} * var(--cell-h));` :
            cropHandle === 'ne' ? `left: calc((${crop.x} + ${crop.w}) * var(--cell-w)); top: calc(${crop.y} * var(--cell-h));` :
            cropHandle === 'e' ? `left: calc((${crop.x} + ${crop.w}) * var(--cell-w)); top: calc((${crop.y} + ${crop.h} / 2) * var(--cell-h));` :
            cropHandle === 'se' ? `left: calc((${crop.x} + ${crop.w}) * var(--cell-w)); top: calc((${crop.y} + ${crop.h}) * var(--cell-h));` :
            cropHandle === 's' ? `left: calc((${crop.x} + ${crop.w} / 2) * var(--cell-w)); top: calc((${crop.y} + ${crop.h}) * var(--cell-h));` :
            cropHandle === 'sw' ? `left: calc(${crop.x} * var(--cell-w)); top: calc((${crop.y} + ${crop.h}) * var(--cell-h));` :
            `left: calc(${crop.x} * var(--cell-w)); top: calc((${crop.y} + ${crop.h} / 2) * var(--cell-h));`}
          onpointerdown={(event) => startCrop(cropHandle, event)}></div>
      {/each}
      {#if cropDiffers(crop, W, H)}
        <button class="crop-apply" style="left: calc(({crop.x} + {crop.w}) * var(--cell-w)); top: calc(({crop.y} + {crop.h}) * var(--cell-h));" onpointerdown={(event) => onActionPointerDown(event, applyCrop)} title="Apply crop">✓ {crop.w}×{crop.h}</button>
      {/if}
    {/if}

    {#if activeShape && activeShape.shape}
      {@const s = activeShape.shape}
      {@const o = effOffset($layers, activeShape)}
      {@const cw = metrics.cellW}{@const ch = metrics.cellH}
      {@const vertices = resolvedShapeVertices(s)}
      {@const cageVertices = shapeTransformCageVertices(s)}
      {@const handles = shapeTransformHandles(s, { rotationAspect: cw / ch })}
      {@const hasEditableAnchor = handles.some((handle) => handle.type === 'anchor')}
      {@const hitPoints = vertices.map((point) => `${(point.x + o.x + 0.5) * cw},${(point.y + o.y + 0.5) * ch}`).join(' ')}
      {@const cagePoints = cageVertices.map((point) => `${(point.x + o.x + 0.5) * cw},${(point.y + o.y + 0.5) * ch}`).join(' ')}
      {@const rotationHandle = handles.find((handle) => handle.type === 'rotation')}
      {@const firstEdge = handles.find((handle) => handle.id === 'edge:0')}
      {@const rotationLinkStart = firstEdge || handles.find((handle) => handle.type === 'anchor')}
      {@const rotationHighlighted = shapeGeometryHoverDetailValue?.layerId === activeShape.id &&
        shapeGeometryHoverDetailValue?.componentId === 'rotation'}
      <svg class="shape-guide" class:interactive={shapeHandlesInteractive} width={W * cw} height={H * ch}>
        {#if s.kind === 'line'}
          <polyline points={cagePoints} />
          <polyline class="shape-hit" points={hitPoints} role="button" aria-label="Move shape" tabindex="-1" onpointerdown={dragShapeBody} />
        {:else}
          <polygon points={cagePoints} />
          <polygon class="shape-hit" points={hitPoints} role="button" aria-label="Move shape" tabindex="-1" onpointerdown={dragShapeBody} />
        {/if}
        {#each handles.filter((handle) => handle.type === 'edge') as handle (handle.id)}
          {@const edgeStart = handle.from == null ? null : cageVertices[handle.from]}
          {@const edgeEnd = handle.to == null ? null : cageVertices[handle.to]}
          {#if shapeHandlesInteractive && edgeStart && edgeEnd}
            <line class="shape-edge-hit" role="button" tabindex="-1"
              aria-label={handle.label}
              x1={(edgeStart.x + o.x + 0.5) * cw} y1={(edgeStart.y + o.y + 0.5) * ch}
              x2={(edgeEnd.x + o.x + 0.5) * cw} y2={(edgeEnd.y + o.y + 0.5) * ch}
              style:cursor={shapeHandleCursor(handle, s)}
              onpointerdown={(event) => dragShapeHandle(handle.id, event)} />
          {/if}
        {/each}
        {#if (shapeHandlesInteractive || rotationHighlighted) && rotationHandle && rotationLinkStart}
          <line class="rotation-link"
            x1={(rotationLinkStart.x + o.x + 0.5) * cw} y1={(rotationLinkStart.y + o.y + 0.5) * ch}
            x2={(rotationHandle.x + o.x + 0.5) * cw} y2={(rotationHandle.y + o.y + 0.5) * ch} />
        {/if}
      </svg>
      {#each handles as handle (handle.id)}
        {@const highlighted = shapeGeometryHoverDetailValue?.layerId === activeShape.id &&
          shapeGeometryHoverDetailValue?.componentId === handle.id}
        {#if shapeHandlesInteractive || highlighted}
          <div class="shape-handle {handle.type}"
            role="button" tabindex="-1"
            class:highlighted class:passive={!shapeHandlesInteractive}
            data-shape-handle-id={handle.id} data-shape-handle-type={handle.type}
            style="left: calc(({handle.x + o.x} + 0.5) * var(--cell-w)); top: calc(({handle.y + o.y} + 0.5) * var(--cell-h)); cursor: {shapeHandleCursor(handle, s)};"
             aria-label={handle.label} title={shapeHandleTitle(handle)}
            onpointerdown={(e) => shapeHandlesInteractive && dragShapeHandle(handle.id, e)}></div>
        {/if}
      {/each}
    {/if}

    {#if !$playing}
      {#each missingVideoLayers as missingVideo (missingVideo.id)}
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
    {#if rasterSnapGuides.x !== null}
      <div class="raster-snap-guide vertical" aria-hidden="true"
        style="left: calc({rasterSnapGuides.x} * var(--cell-w));"></div>
    {/if}
    {#if rasterSnapGuides.y !== null}
      <div class="raster-snap-guide horizontal" aria-hidden="true"
        style="top: calc({rasterSnapGuides.y} * var(--cell-h));"></div>
    {/if}
    {#if activeImage && imgGizmo && $activeTool !== 'crop'}
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
        <div class="img-edge n" title="Resize image" onpointerdown={(e) => dragImageScale(e, 'y')}></div>
        <div class="img-edge e" title="Resize image" onpointerdown={(e) => dragImageScale(e, 'x')}></div>
        <div class="img-edge s" title="Resize image" onpointerdown={(e) => dragImageScale(e, 'y')}></div>
        <div class="img-edge w" title="Resize image" onpointerdown={(e) => dragImageScale(e, 'x')}></div>
        <div class="img-rotate" onpointerdown={dragImageRotate}></div>
      </div>
    {/if}

    {#if $activeTool === 'text' && !$playing}
      {#each $layers.filter((l) => l.type === 'text' && effVisible($layers, l) && l.box) as l (l.id)}
        {@const b = layerBox($layers, l)}
        {#if b}
          <div class="text-box outline" class:active={l.id === $activeLayerId} style="left: calc({b.x} * var(--cell-w)); top: calc({b.y} * var(--cell-h)); width: calc({b.w} * var(--cell-w)); height: calc({b.h} * var(--cell-h));"></div>
        {/if}
      {/each}
      {#if activeText}
        {@const b = layerBox($layers, activeText)}
        {#if b}
          <div class="text-grip" role="button" aria-label="Move text" tabindex="-1" title="Move text" style="left: calc({b.x} * var(--cell-w)); top: calc({b.y} * var(--cell-h));" onpointerdown={(e) => dragTextBox('move', e)}>✜</div>
          <div class="text-resize" role="button" aria-label="Resize text" tabindex="-1" title="Resize" style="left: calc({b.x + b.w} * var(--cell-w)); top: calc({b.y + b.h} * var(--cell-h));" onpointerdown={(e) => dragTextBox('resize', e)}></div>
        {/if}
      {/if}
    {/if}
  </div>

  {#if selectionMenu}
    <div class="selection-menu" bind:this={selectionMenuEl} role="menu" tabindex="-1"
      use:popupFocus={{ initialFocus: 'button:not([disabled])' }}
      style="left:{selectionMenu.x}px; top:{selectionMenu.y}px;" data-keyboard-context="canvas"
      onpointerdown={onSelectionMenuPointerDown}>
      <button role="menuitem" onclick={() => selectionAction('move')}>Move</button>
      {#if !editingMask}
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
  .stage.playing .raster-snap-guide,
  .stage.playing .img-gizmo { display: none; }
  .stage.eyedrop-cursor {
    cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Cpath d='M14 2l4 4-2 2-4-4zM11 5l4 4-8 8-4 1 1-4z' fill='none' stroke='%23e0a458' stroke-width='1.5'/%3E%3C/svg%3E") 2 18, crosshair;
  }
  .hit-catcher { position: absolute; z-index: 5; background: transparent; }
  .world-canvas { position: absolute; display: block; z-index: 1; pointer-events: none; }
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
  .raster-snap-guide {
    position: absolute; z-index: 11; pointer-events: none; background: var(--snap-guide);
    box-shadow: 0 0 2px var(--pure-black);
  }
  .raster-snap-guide.vertical { top: 0; bottom: 0; width: 1px; transform: translateX(-0.5px); }
  .raster-snap-guide.horizontal { left: 0; right: 0; height: 1px; transform: translateY(-0.5px); }
  .img-body { position: absolute; inset: 0; cursor: move; }
  .img-scale { position: absolute; width: 12px; height: 12px; background: var(--accent); border: 1px solid var(--pure-black); border-radius: 2px; }
  .img-scale.tl { left: -6px; top: -6px; cursor: nwse-resize; }
  .img-scale.tr { right: -6px; top: -6px; cursor: nesw-resize; }
  .img-scale.bl { left: -6px; bottom: -6px; cursor: nesw-resize; }
  .img-scale.br { right: -6px; bottom: -6px; cursor: nwse-resize; }
  .img-edge { position: absolute; z-index: 3; }
  .img-edge::after { content: ''; position: absolute; width: 12px; height: 12px; background: var(--accent); border: 1px solid var(--pure-black); border-radius: 2px; box-sizing: border-box; }
  .img-edge.e, .img-edge.w { top: 8px; bottom: 8px; width: 12px; cursor: ew-resize; }
  .img-edge.e { right: -6px; }
  .img-edge.w { left: -6px; }
  .img-edge.e::after, .img-edge.w::after { top: 50%; margin-top: -6px; }
  .img-edge.e::after { right: 0; }
  .img-edge.w::after { left: 0; }
  .img-edge.n, .img-edge.s { left: 8px; right: 8px; height: 12px; cursor: ns-resize; }
  .img-edge.n { top: -6px; }
  .img-edge.s { bottom: -6px; }
  .img-edge.n::after, .img-edge.s::after { left: 50%; margin-left: -6px; }
  .img-edge.n::after { top: 0; }
  .img-edge.s::after { bottom: 0; }
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
    position: absolute; inset: 0; pointer-events: none; z-index: 0;
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
    position: absolute; z-index: 12; margin: -20px 0 0 -9px; width: 18px; height: 18px;
    background: var(--accent); color: var(--pure-black); border: 1px solid var(--pure-black); border-radius: 3px;
    font-size: 12px; line-height: 16px; text-align: center; cursor: move;
  }
  .text-resize {
    position: absolute; z-index: 12; width: 12px; height: 12px;
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
  .shape-guide .shape-edge-hit {
    stroke: transparent; stroke-width: 12; stroke-dasharray: none; pointer-events: stroke;
  }
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
