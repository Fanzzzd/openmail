/**
 * Work on screen that the Mac does not have yet, such as a draft typed since
 * its last save. Both builds flush it when the page is hidden, the desktop app
 * before quit; the web build never reloads itself while any is left.
 */
const unsaved = new Set<string>();
const flushers = new Set<() => Promise<void>>();

/** Marks `key` (a draft id) as holding unsaved work, or clears it. */
export function setUnsaved(key: string, value: boolean) {
  if (value) unsaved.add(key);
  else unsaved.delete(key);
}

export const hasUnsavedWork = () => unsaved.size > 0;

/** Registers a save-now callback that settles once saved; returns its unregister function. */
export function onFlush(flush: () => Promise<void>) {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}

/** Saves all unsaved work now instead of after its debounce; settles when every save has. */
export async function flushUnsavedWork(): Promise<void> {
  await Promise.all([...flushers].map((flush) => flush()));
}
