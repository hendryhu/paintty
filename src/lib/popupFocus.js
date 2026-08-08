import { writable } from 'svelte/store';

let popupCount = 0;
const popupStack = [];
export const popupOpen = writable(false);

function updatePopupCount(delta) {
  popupCount = Math.max(0, popupCount + delta);
  popupOpen.set(popupCount > 0);
}

function focusTarget(node, options) {
  const requested = typeof options?.initialFocus === 'function'
    ? options.initialFocus(node)
    : options?.initialFocus;
  const target = typeof requested === 'string'
    ? node.querySelector?.(requested)
    : requested || node.querySelector?.(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) || node;
  target?.focus?.({ preventScroll: true });
}

// Popup nodes form an ownership stack so callers can reserve Escape for the top;
// each action restores the focus it captured when mounted.
export function popupFocus(node, options = {}) {
  const previousFocus = options.returnFocus || globalThis.document?.activeElement;
  let current = options;
  let active = true;
  popupStack.push(node);
  updatePopupCount(1);
  queueMicrotask(() => {
    if (active) focusTarget(node, current);
  });
  return {
    update(next = {}) {
      current = next;
    },
    destroy() {
      active = false;
      const index = popupStack.lastIndexOf(node);
      if (index >= 0) popupStack.splice(index, 1);
      updatePopupCount(-1);
      const restore = current.restoreFocus === false ? null : previousFocus;
      if (restore?.isConnected !== false) restore?.focus?.({ preventScroll: true });
    },
  };
}

export function isTopPopup(node) {
  return !!node && popupStack.at(-1) === node;
}

export function popupCountForTests() {
  return popupCount;
}
