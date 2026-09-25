interface ShortcutEvent {
  key?: string | undefined;
  ctrlKey?: boolean | undefined;
  metaKey?: boolean | undefined;
  altKey?: boolean | undefined;
  shiftKey?: boolean | undefined;
  target?: {
    closest?: (selector: string) => { type?: string | undefined } | null;
    blur?: () => void;
  } | null | undefined;
  preventDefault?: () => void;
  stopImmediatePropagation?: () => void;
}

interface ShortcutState {
  typing?: boolean | undefined;
  popupOpen?: boolean | undefined;
  viewportBlocked?: boolean | undefined;
  playing?: boolean | undefined;
  activeLayerId?: string | null | undefined;
}

type BrowserZoomShortcutEvent = Pick<ShortcutEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>;

export function blockUnsupportedTab(event: ShortcutEvent): boolean {
  if (event?.key !== 'Tab') return false;
  event.preventDefault?.();
  event.stopImmediatePropagation?.();
  return true;
}

export function installUniversalTabBlock(target: Pick<Document, 'addEventListener' | 'removeEventListener'> | undefined = globalThis.document): () => void {
  if (!target?.addEventListener) return () => {};
  const listener: EventListener = (event) => blockUnsupportedTab(event as unknown as ShortcutEvent);
  target.addEventListener('keydown', listener, true);
  return () => target.removeEventListener('keydown', listener, true);
}

export function applicationShortcutBlocked(state: ShortcutState = {}): boolean {
  return !!(state.popupOpen || state.viewportBlocked);
}

export function nativeBrowserZoomShortcut(event: BrowserZoomShortcutEvent): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  return event.key === '+' || event.key === '=' || event.key === '-' || event.key === '0';
}

const RANGE_NATIVE_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End',
]);

export function nativeInputOwnsKey(event: ShortcutEvent): boolean {
  if (!event.key || !RANGE_NATIVE_KEYS.has(event.key)) return false;
  const input = event?.target?.closest?.('input');
  return input?.type === 'range';
}

export function layerRenameShortcutAction(event: ShortcutEvent, state: ShortcutState = {}): 'rename-active-layer' | null {
  if (event?.key !== 'F2' || state.typing || state.popupOpen || state.playing || !state.activeLayerId) {
    return null;
  }
  return 'rename-active-layer';
}

export function projectSaveShortcutAction(event: ShortcutEvent, state: ShortcutState = {}): 'save' | 'save-as' | null {
  if (event?.key?.toLowerCase() !== 's' || !(event.ctrlKey || event.metaKey) ||
      state.typing || state.popupOpen || state.playing) {
    return null;
  }
  return event.shiftKey ? 'save-as' : 'save';
}

export function menuTriggerEdge(key: string): 'first' | 'last' | null {
  if (key === 'ArrowDown') return 'first';
  if (key === 'ArrowUp') return 'last';
  return null;
}

export function desktopMenuKeyAction(
  key: string,
  options: { hasSubmenu?: boolean; inSubmenu?: boolean } = {},
): 'next-item' | 'previous-item' | 'first-item' | 'last-item' | 'close' | 'activate' |
  'enter-submenu' | 'next-menu' | 'leave-submenu' | 'previous-menu' | null {
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
