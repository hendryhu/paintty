function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function wholePoint(value) {
  return {
    x: Math.round(finite(value?.x)),
    y: Math.round(finite(value?.y)),
  };
}

function groupOffset(items, layer) {
  const group = layer?.groupId == null
    ? null
    : items.find((candidate) => candidate.id === layer.groupId && candidate.type === 'group');
  return {
    x: finite(group?.offset?.x),
    y: finite(group?.offset?.y),
  };
}

export function isRasterLayer(layer) {
  return layer?.type === 'image' || layer?.type === 'video';
}

export function rasterLayerTransform(layer, size = {}) {
  const transform = layer?.transform
    ? { ...layer.transform }
    : { x: finite(size.w) / 2, y: finite(size.h) / 2, scale: 1, rot: 0 };
  transform.x = finite(transform.x, finite(size.w) / 2);
  transform.y = finite(transform.y, finite(size.h) / 2);
  return transform;
}

export function rasterLayerSourceSize(layer) {
  const metadataWidth = layer?.type === 'video'
    ? finite(layer?.videoClip?.width)
    : finite(layer?.sourceWidth);
  const metadataHeight = layer?.type === 'video'
    ? finite(layer?.videoClip?.height)
    : finite(layer?.sourceHeight);
  if (metadataWidth > 0 && metadataHeight > 0) {
    return { width: metadataWidth, height: metadataHeight };
  }
  const rasterWidth = finite(layer?.raster?.width);
  const rasterHeight = finite(layer?.raster?.height);
  return rasterWidth > 0 && rasterHeight > 0
    ? { width: rasterWidth, height: rasterHeight }
    : null;
}

export function renderedRasterPosition(items, layer, size = {}) {
  const transform = rasterLayerTransform(layer, size);
  const group = groupOffset(items, layer);
  return {
    x: transform.x + finite(layer?.offset?.x) + group.x,
    y: transform.y + finite(layer?.offset?.y) + group.y,
  };
}

// Missing-video UI and decoded raster rendering share this geometry so relinking cannot jump.
export function rasterDisplayGeometry(items, layer, size = {}, fallbackSource = null) {
  const source = rasterLayerSourceSize(layer) || fallbackSource;
  if (!(finite(source?.width) > 0) || !(finite(source?.height) > 0)) return null;
  const transform = rasterLayerTransform(layer, size);
  const scale = finite(transform.scale, 1);
  const scaleX = finite(transform.scaleX, scale);
  const scaleY = finite(transform.scaleY, scale);
  const position = renderedRasterPosition(items, layer, size);
  return {
    ...position,
    width: Math.abs(finite(source.width) * scaleX),
    height: Math.abs(finite(source.height) * scaleY) / 2,
    scaleX,
    scaleY,
    rot: finite(transform.rot),
    opacity: layer?.opacity ?? 1,
  };
}

export function timelinePositionEditor(items, layer, animated, size = {}) {
  const raster = isRasterLayer(layer);
  const staticRaster = raster && !animated;
  return {
    editable: !!layer && (staticRaster || !!animated),
    mode: staticRaster ? 'raster-transform' : 'offset-track',
    value: raster
      ? renderedRasterPosition(items, layer, size)
      : wholePoint(layer?.offset),
  };
}

// Raster fields stay in canvas coordinates even though animation stores offsets.
export function planTimelinePositionEdit(items, layerId, animated, value, size = {}) {
  const layer = items.find((candidate) => candidate.id === layerId);
  const editor = timelinePositionEditor(items, layer, animated, size);
  if (!editor.editable) return null;
  if (editor.mode === 'offset-track') {
    if (!isRasterLayer(layer)) {
      return { mode: editor.mode, value: wholePoint(value) };
    }
    const group = groupOffset(items, layer);
    const transform = rasterLayerTransform(layer, size);
    return {
      mode: editor.mode,
      value: wholePoint({
        x: finite(value?.x, editor.value.x) - transform.x - group.x,
        y: finite(value?.y, editor.value.y) - transform.y - group.y,
      }),
    };
  }

  const group = groupOffset(items, layer);
  const transform = rasterLayerTransform(layer, size);
  const next = {
    x: finite(value?.x, editor.value.x) - finite(layer.offset?.x) - group.x,
    y: finite(value?.y, editor.value.y) - finite(layer.offset?.y) - group.y,
  };
  const nextItems = items.map((candidate) => candidate.id === layerId ? {
    ...candidate,
    transform: { ...transform, ...next },
  } : candidate);
  return { mode: editor.mode, value: next, items: nextItems };
}
