interface DiscardedProjectAction<T> {
  checkpoint: () => void | Promise<void>;
  action: () => T | Promise<T>;
}

export async function performDiscardedProjectAction<T>({
  checkpoint,
  action,
}: DiscardedProjectAction<T>): Promise<T> {
  if (typeof checkpoint !== 'function' || typeof action !== 'function') {
    throw new TypeError('Discarded project actions require checkpoint and action functions.');
  }
  await checkpoint();
  return action();
}
