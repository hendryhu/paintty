export async function performDiscardedProjectAction({ checkpoint, action }) {
  if (typeof checkpoint !== 'function' || typeof action !== 'function') {
    throw new TypeError('Discarded project actions require checkpoint and action functions.');
  }
  await checkpoint();
  return action();
}
