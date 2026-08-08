import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  INFO_NOTIFICATION_LIFETIME_MS,
  MAX_NOTIFICATIONS,
  clearNotifications,
  dismissNotification,
  notifications,
  notifyError,
  notifyInfo,
} from '../src/lib/notifications.js';
import { notifyProjectReplaced } from '../src/lib/documentLifecycle.js';

function currentNotifications() {
  return get(notifications);
}

beforeEach(() => {
  vi.useFakeTimers();
  clearNotifications();
});

afterEach(() => {
  clearNotifications();
  vi.useRealTimers();
});

describe('notification lifetime ownership', () => {
  test('one info notice expires at the tested short lifetime', () => {
    notifyInfo('Created Layer 1 for this tick.');
    expect(currentNotifications()).toHaveLength(1);
    vi.advanceTimersByTime(INFO_NOTIFICATION_LIFETIME_MS - 1);
    expect(currentNotifications()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(currentNotifications()).toEqual([]);
  });

  test('three info notices retain independent deadlines', () => {
    notifyInfo('first');
    vi.advanceTimersByTime(1_000);
    notifyInfo('second');
    vi.advanceTimersByTime(1_000);
    notifyInfo('third');
    vi.advanceTimersByTime(INFO_NOTIFICATION_LIFETIME_MS - 2_000);
    expect(currentNotifications().map((item) => item.message)).toEqual(['second', 'third']);
    vi.advanceTimersByTime(1_000);
    expect(currentNotifications().map((item) => item.message)).toEqual(['third']);
    vi.advanceTimersByTime(1_000);
    expect(currentNotifications()).toEqual([]);
  });

  test('many info notices cap the stack and release evicted timers', () => {
    for (let index = 0; index < MAX_NOTIFICATIONS + 3; index++) notifyInfo(`notice ${index}`);
    expect(currentNotifications().map((item) => item.message)).toEqual([
      'notice 3', 'notice 4', 'notice 5', 'notice 6',
    ]);
    expect(vi.getTimerCount()).toBe(MAX_NOTIFICATIONS);
    vi.advanceTimersByTime(INFO_NOTIFICATION_LIFETIME_MS);
    expect(currentNotifications()).toEqual([]);
  });

  test('errors remain until manually dismissed', () => {
    const id = notifyError('Could not save project.');
    vi.advanceTimersByTime(INFO_NOTIFICATION_LIFETIME_MS * 10);
    expect(currentNotifications()).toEqual([
      expect.objectContaining({ id, tone: 'error', message: 'Could not save project.' }),
    ]);
    dismissNotification(id);
    expect(currentNotifications()).toEqual([]);
  });

  test('project replacement clears contextual notices and pending expiry', () => {
    notifyInfo('Created Layer 3 for this tick.');
    notifyError('Old project error.');
    notifyProjectReplaced({ revision: 42 });
    expect(currentNotifications()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

test('notification chrome passes through body input but retains its close action', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(root, 'src/App.svelte'), 'utf8');
  const stackRule = source.match(/\.notification-stack\s*\{[\s\S]*?\}/)?.[0] || '';
  const bodyRule = source.match(/\.notification\s*\{[\s\S]*?\}/)?.[0] || '';
  const buttonRule = source.match(/\.notification button\s*\{[\s\S]*?\}/)?.[0] || '';
  expect(stackRule).toMatch(/pointer-events:\s*none/);
  expect(bodyRule).toMatch(/pointer-events:\s*none/);
  expect(buttonRule).toMatch(/pointer-events:\s*auto/);
  expect(source).toMatch(/aria-label="Dismiss notification"[\s\S]*onclick=\{\(\) => dismissNotification/);
});
