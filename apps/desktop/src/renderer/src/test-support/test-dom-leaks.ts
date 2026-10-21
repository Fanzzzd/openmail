/**
 * The testDom roots a test has not disposed yet. The desktop setup file (wait-defaults.ts)
 * unmounts any left after a test and fails it: a mounted root keeps its timers running, and they
 * fire after a later test restores `window`. The set lives on globalThis because a test file that
 * calls vi.resetModules gets its own copy of this module, apart from the setup file's.
 */
declare global {
  var openmailMountedTestDoms: Set<() => void> | undefined;
}

export function mountedTestDoms() {
  globalThis.openmailMountedTestDoms ??= new Set();
  return globalThis.openmailMountedTestDoms;
}

/** Unmounts every root still mounted and returns how many there were. */
export function disposeMountedTestDoms() {
  const left = [...mountedTestDoms()];
  for (const dispose of left) dispose();
  return left.length;
}
