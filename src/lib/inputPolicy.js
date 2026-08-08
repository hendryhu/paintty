export function blockUnsupportedTab(event) {
  if (event?.key !== 'Tab') return false;
  event.preventDefault?.();
  event.stopImmediatePropagation?.();
  return true;
}

export function installUniversalTabBlock(target = globalThis.document) {
  if (!target?.addEventListener) return () => {};
  target.addEventListener('keydown', blockUnsupportedTab, true);
  return () => target.removeEventListener('keydown', blockUnsupportedTab, true);
}

export function applicationShortcutBlocked(state = {}) {
  return !!(state.popupOpen || state.viewportBlocked);
}

const RANGE_NATIVE_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End',
]);

export function nativeInputOwnsKey(event) {
  if (!RANGE_NATIVE_KEYS.has(event?.key)) return false;
  const input = event?.target?.closest?.('input');
  return input?.type === 'range';
}

export function layerRenameShortcutAction(event, state = {}) {
  if (event?.key !== 'F2' || state.typing || state.popupOpen || state.playing || !state.activeLayerId) {
    return null;
  }
  return 'rename-active-layer';
}

export function projectSaveShortcutAction(event, state = {}) {
  if (event?.key?.toLowerCase() !== 's' || !(event.ctrlKey || event.metaKey) ||
      state.typing || state.popupOpen || state.playing) {
    return null;
  }
  return event.shiftKey ? 'save-as' : 'save';
}

export function menuTriggerEdge(key) {
  if (key === 'ArrowDown') return 'first';
  if (key === 'ArrowUp') return 'last';
  return null;
}

export function desktopMenuKeyAction(key, options = {}) {
  if (key === 'ArrowDown') return 'next-item';
  if (key === 'ArrowUp') return 'previous-item';
  if (key === 'Home') return 'first-item';
  if (key === 'End') return 'last-item';
  if (key === 'Escape') return 'close';
  if (key === 'Enter' || key === ' ') return 'activate';
  if (key === 'ArrowRight') {
    if (options.hasSubmenu) return 'enter-submenu';
    return options.inSubmenu ? null : 'next-menu';
  }
  if (key === 'ArrowLeft') return options.inSubmenu ? 'leave-submenu' : 'previous-menu';
  return null;
}
