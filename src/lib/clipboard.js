import {
  captureLayerClipClipboard,
  captureTimelineClipClipboard,
  pasteClipClipboard,
} from './frames.js';
import { onProjectReplaced } from './documentLifecycle.js';

let copiedClips = null;
let copiedMarker = null;
let markerSequence = 0;

export const PAINTTY_CLIPBOARD_MIME = 'application/x-paintty-clip';
export const PAINTTY_CLIPBOARD_TEXT = 'Paintty clip selection';

export function clipboardImageFile(clipboardData) {
  const files = [...(clipboardData?.files || [])];
  const direct = files.find((entry) => String(entry?.type || '').startsWith('image/'));
  if (direct) return direct;
  const item = [...(clipboardData?.items || [])].find((entry) =>
    entry?.kind === 'file' && String(entry.type || '').startsWith('image/'));
  return item?.getAsFile?.() || null;
}

export function clipboardPasteIntent(
  clipboardData,
  context,
) {
  const file = clipboardImageFile(clipboardData);
  if (file) return { kind: 'image', file };
  if ((context === 'layers' || context === 'timeline') &&
    clipboardHasMatchingClipMarker(clipboardData)) {
    return { kind: 'clips', file: null };
  }
  return { kind: 'none', file: null };
}

function nextClipboardMarker() {
  const random = globalThis.crypto?.randomUUID?.();
  return random
    ? `paintty-${random}`
    : `paintty-${Date.now().toString(36)}-${(++markerSequence).toString(36)}`;
}

export function writeClipClipboardMarker(clipboardData, marker, clipCount) {
  if (!clipboardData?.clearData || !clipboardData?.setData || !marker) return false;
  try {
    clipboardData.clearData();
    clipboardData.setData(PAINTTY_CLIPBOARD_MIME, marker);
    clipboardData.setData(
      'text/plain',
      `${PAINTTY_CLIPBOARD_TEXT} (${Math.max(1, Number(clipCount) || 1)})`,
    );
    return clipboardData.getData?.(PAINTTY_CLIPBOARD_MIME) === marker;
  } catch {
    return false;
  }
}

export function clipboardHasMatchingClipMarker(clipboardData) {
  if (!copiedClips?.clips?.length || !copiedMarker || !clipboardData?.getData) return false;
  try {
    return clipboardData.getData(PAINTTY_CLIPBOARD_MIME) === copiedMarker;
  } catch {
    return false;
  }
}

function storeCapturedClips(payload, clipboardData) {
  if (!payload?.clips?.length) return 0;
  const marker = nextClipboardMarker();
  if (!writeClipClipboardMarker(clipboardData, marker, payload.clips.length)) return 0;
  copiedClips = payload;
  copiedMarker = marker;
  return payload.clips.length;
}

export function copyLayerClipsToClipboard(clipboardData) {
  return storeCapturedClips(captureLayerClipClipboard(), clipboardData);
}

export function copyTimelineClipsToClipboard(clipboardData) {
  return storeCapturedClips(captureTimelineClipClipboard(), clipboardData);
}

export function copyClipsForContext(context, clipboardData) {
  if (context === 'layers') return copyLayerClipsToClipboard(clipboardData);
  if (context === 'timeline') return copyTimelineClipsToClipboard(clipboardData);
  return 0;
}

export function pasteClipsFromClipboard(clipboardData) {
  if (!clipboardHasMatchingClipMarker(clipboardData)) {
    return { changed: false, reason: 'clipboard-marker', clipIds: [], trackIds: [], layerIds: [] };
  }
  const result = pasteClipClipboard(copiedClips);
  if (result.reason === 'stale-media' || result.reason === 'stale-project' ||
    result.reason === 'stale-fps') clearClipClipboard();
  return result;
}

export function hasClipClipboard() {
  return !!copiedClips?.clips?.length;
}

export function clearClipClipboard() {
  copiedClips = null;
  copiedMarker = null;
}

export function clipboardMediaPlacementSucceeded(result) {
  return Boolean(result?.placement);
}

onProjectReplaced(clearClipClipboard);
