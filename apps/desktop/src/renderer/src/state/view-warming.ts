/**
 * Loads the lists a person is likely to open next into the list cache while the window is idle,
 * one at a time, so a sidebar switch paints from the cache. See docs/list-loading.md.
 */
import { constVoid } from "effect/Function";
import type { AsyncResult, AtomRegistry } from "effect/reactivity";
import type { View } from "../lib/view";
import { prefetchView } from "./threads";

/** At most this many views warm per pass. */
export const WARM_LIMIT = 12;
/** A pass waits this long after the person's last key or click before the next view. */
export const INPUT_QUIET_MS = 1000;
/** Gap between two warmed views, so the main process answers other requests in between. */
export const WARM_GAP_MS = 250;

export interface WarmClock {
  now: () => number;
  /** Runs `run` when the window is idle; returns a cancel function. */
  idle: (run: () => void) => () => void;
  /** Runs `run` after `ms`; returns a cancel function. */
  after: (ms: number, run: () => void) => () => void;
}

export const browserClock: WarmClock = {
  now: () => performance.now(),
  idle: (run) => {
    // jsdom and the web build's older browsers have no idle callback.
    if (typeof requestIdleCallback !== "function") {
      const timer = setTimeout(run, 50);
      return () => clearTimeout(timer);
    }
    const id = requestIdleCallback(run, { timeout: 2000 });
    return () => cancelIdleCallback(id);
  },
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * Warms `views` in order: each starts only after the previous list arrived, the window was idle
 * and no key or click came in the last second. Returns a function that stops the pass.
 */
export function warmViews(
  registry: AtomRegistry.AtomRegistry,
  views: readonly View[],
  lastInput: () => number,
  clock: WarmClock = browserClock,
) {
  let stopped = false;
  let cancel: () => void = constVoid;
  const queue = views.slice(0, WARM_LIMIT);
  const step = () => {
    if (stopped) return;
    const quietFor = clock.now() - lastInput();
    if (quietFor < INPUT_QUIET_MS) {
      cancel = clock.after(INPUT_QUIET_MS - quietFor, () => {
        cancel = clock.idle(step);
      });
      return;
    }
    const view = queue.shift();
    if (!view) return;
    const loaded = prefetchView(registry, view, { missingOnly: true });
    const next = () => {
      cancel = clock.after(WARM_GAP_MS, () => {
        cancel = clock.idle(step);
      });
    };
    if (!loaded || settled(registry.get(loaded))) {
      next();
      return;
    }
    // Wait for this list before the next one, so warming sends one list request at a time.
    const unsubscribe = registry.subscribe(loaded, (result) => {
      if (!settled(result)) return;
      unsubscribe();
      next();
    });
    cancel = unsubscribe;
  };
  cancel = clock.idle(step);
  return () => {
    stopped = true;
    cancel();
  };
}

const settled = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  result._tag !== "Initial" && !result.waiting;
