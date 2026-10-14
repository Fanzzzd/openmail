/**
 * The titlebar area beside the macOS traffic lights, as one value per window
 * that only changes when the lights really move.
 *
 * Electron reports a wrong rect for one frame after every resize: AppKit lays
 * the title bar out again and resets the buttons to its default spacing, the
 * overlay rect is computed from those frames, and only then does Electron put
 * the buttons back at `trafficLightPosition`. On macOS 26 `x` reads 87 for
 * that frame instead of 96, through `getTitlebarAreaRect()` and through
 * `env(titlebar-area-x)` alike. Anything laid out from the raw rect jumps 9 px
 * left and back on every resize step. The store below ignores a changed rect
 * until the overlay has reported it for `SETTLE_MS` with no further change.
 * Showing or hiding the lights (entering or leaving full screen) applies at
 * once.
 */
import type { TitlebarArea } from "../../../shared/window-chrome";

/** How long a new rect must hold before layout follows it. */
export const SETTLE_MS = 200;

const same = (a: TitlebarArea | null, b: TitlebarArea | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.height === b.height);

export interface TitlebarAreaStore {
  /** The settled area; the same object until it changes. */
  readonly get: () => TitlebarArea | null;
  /** Reads the overlay again after a resize or a geometry change. */
  readonly update: () => void;
  readonly subscribe: (onChange: () => void) => () => void;
}

export function titlebarAreaStore(
  read: () => TitlebarArea | null,
  settleMs = SETTLE_MS,
): TitlebarAreaStore {
  let current = read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const set = (next: TitlebarArea | null) => {
    if (same(next, current)) return;
    current = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => current,
    update() {
      const next = read();
      if ((next === null) !== (current === null)) set(next);
      clearTimeout(timer);
      timer = setTimeout(() => set(read()), settleMs);
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) clearTimeout(timer);
      };
    },
  };
}
