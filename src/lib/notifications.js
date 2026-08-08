import { writable } from 'svelte/store';
import { onProjectReplaced } from './documentLifecycle.js';

let nextNotificationId = 1;
const expiryTimers = new Map();
let currentNotifications = [];

export const INFO_NOTIFICATION_LIFETIME_MS = 5_000;
export const MAX_NOTIFICATIONS = 4;

const notificationStore = writable(currentNotifications);

function clearExpiry(id) {
  const timer = expiryTimers.get(id);
  if (timer == null) return;
  clearTimeout(timer);
  expiryTimers.delete(id);
}

function publish(items) {
  const next = Array.isArray(items) ? items : [];
  const retainedIds = new Set(next.map((item) => item.id));
  for (const id of expiryTimers.keys()) {
    if (!retainedIds.has(id)) clearExpiry(id);
  }
  currentNotifications = next;
  notificationStore.set(next);
}

export const notifications = {
  subscribe: notificationStore.subscribe,
  set: publish,
};

function notify(message, tone) {
  const text = String(message || 'Something went wrong.');
  const item = { id: nextNotificationId++, message: text, tone };
  publish([
    ...currentNotifications.filter((entry) => entry.message !== text),
    item,
  ].slice(-MAX_NOTIFICATIONS));
  if (tone === 'info') {
    // The store owns expiry so notices settle even when their visual stack is not mounted.
    const timer = setTimeout(() => dismissNotification(item.id), INFO_NOTIFICATION_LIFETIME_MS);
    timer?.unref?.();
    expiryTimers.set(item.id, timer);
  }
  return item.id;
}

export function notifyError(message) {
  return notify(message, 'error');
}

export function notifyInfo(message) {
  return notify(message, 'info');
}

export function dismissNotification(id) {
  publish(currentNotifications.filter((item) => item.id !== id));
}

export function clearNotifications() {
  publish([]);
}

onProjectReplaced(clearNotifications);
