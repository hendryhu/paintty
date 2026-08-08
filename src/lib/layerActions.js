export function canConvertImageToCells(layer) { return layer?.type === 'image'; }

export function canConvertVideoFrameToCells(layer) { return layer?.type === 'video'; }

function videoStatusMatchesSource(layer, rasterStatus) {
  return rasterStatus?.clipId === layer?.id &&
    rasterStatus?.assetId === (layer?.videoClip?.assetId ?? null);
}

export function videoReferenceState(layer, rasterStatus = null) {
  if (layer?.type !== 'video') return null;
  if (videoStatusMatchesSource(layer, rasterStatus) && rasterStatus.state === 'error') return 'error';
  return layer.videoElement ? 'ready' : 'missing';
}

export function canRelinkVideo(layer, rasterStatus = null) {
  const state = videoReferenceState(layer, rasterStatus);
  return state === 'missing' || state === 'error';
}

export function layerDeleteLabel(count) {
  return count > 1 ? `Delete ${count} layers` : 'Delete layer';
}

export function layerDeleteClosure(layerList, requestedIds) {
  const list = layerList || [];
  const available = new Set(list.map((layer) => layer.id));
  const groupIds = new Set(
    list.filter((layer) => layer.type === 'group').map((layer) => layer.id),
  );
  const closure = new Set([...(requestedIds || [])].filter((id) => available.has(id)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const layer of list) {
      if (!layer.groupId || !groupIds.has(layer.groupId) || !closure.has(layer.groupId) ||
        closure.has(layer.id)) continue;
      closure.add(layer.id);
      changed = true;
    }
  }
  return list.filter((layer) => closure.has(layer.id)).map((layer) => layer.id);
}

export function planLayerDeleteContext(layerList, selectedIds, targetId) {
  const available = new Set((layerList || []).map((layer) => layer.id));
  if (!available.has(targetId)) return null;
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const preserveSelection = selected.has(targetId);
  const roots = preserveSelection
    ? (layerList || []).filter((layer) => selected.has(layer.id)).map((layer) => layer.id)
    : [targetId];
  // Freeze the full descendant closure so the menu count and later action name the same rows.
  const deleteIds = layerDeleteClosure(layerList, roots);
  return {
    preserveSelection,
    deleteIds,
    deleteCount: deleteIds.length,
    deleteLabel: layerDeleteLabel(deleteIds.length),
  };
}

export function visibleVideoReferenceLayers(layerList) {
  const collapsedGroups = new Set(layerList
    .filter((layer) => layer.type === 'group' && layer.collapsed)
    .map((layer) => layer.id));
  return layerList.filter((layer) =>
    layer.type === 'video' &&
    layer.videoClip &&
    !(layer.groupId && collapsedGroups.has(layer.groupId)));
}
