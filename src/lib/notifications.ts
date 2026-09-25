import { writable } from 'svelte/store';
import { onProjectReplaced } from './documentLifecycle.js';
import type { TimerHandle } from './types/project-types.js';

export type NotificationTone = 'error' | 'info';
export interface NotificationItem {
  id: number;
  message: string;
  tone: NotificationTone;
}

let nextNotificationId = 1;
const expiryTimers = new Map<number, TimerHandle>();
let currentNotifications: NotificationItem[] = [];

export const INFO_NOTIFICATION_LIFETIME_MS = 5_000;
export const MAX_NOTIFICATIONS = 4;

const notificationStore = writable<NotificationItem[]>(currentNotifications);

function clearExpiry(id: number): void {
  const timer = expiryTimers.get(id);
  if (timer == null) return;
  clearTimeout(timer);
  expiryTimers.delete(id);
}

function publish(items: NotificationItem[]): void {
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

function notify(message: unknown, tone: NotificationTone): number {
  const text = String(message || 'Something went wrong.');
  const item = { id: nextNotificationId++, message: text, tone };
  publish([
    ...currentNotifications.filter((entry) => entry.message !== text),
    item,
  ].slice(-MAX_NOTIFICATIONS));
  if (tone === 'info') {
    // The store owns expiry so notices settle even when their visual stack is not mounted.
    const timer = setTimeout(() => dismissNotification(item.id), INFO_NOTIFICATION_LIFETIME_MS);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer &&
      typeof timer.unref === 'function') timer.unref();
    expiryTimers.set(item.id, timer);
  }
  return item.id;
}

export function notifyError(message: unknown): number {
  return notify(message, 'error');
}

export function notifyInfo(message: unknown): number {
  return notify(message, 'info');
}

export function dismissNotification(id: number): void {
  publish(currentNotifications.filter((item) => item.id !== id));
}

export function clearNotifications(): void {
  publish([]);
}

onProjectReplaced(clearNotifications);
