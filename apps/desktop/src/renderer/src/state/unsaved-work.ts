/**
 * Work on screen that the Mac does not have yet, such as a draft typed since
 * its last save. The web build flushes it when the page is hidden and never
 * reloads itself while any is left.
 */
const unsaved = new Set<string>();
const flushers = new Set<() => void>();

/** Marks `key` (a draft id) as holding unsaved work, or clears it. */
export function setUnsaved(key: string, value: boolean) {
  if (value) unsaved.add(key);
  else unsaved.delete(key);
}

export const hasUnsavedWork = () => unsaved.size > 0;

/** Registers a save-now callback; returns its unregister function. */
export function onFlush(flush: () => void) {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}

/** Saves all unsaved work now instead of after its debounce. */
export function flushUnsavedWork() {
  for (const flush of flushers) flush();
}
