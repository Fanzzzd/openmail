import { constVoid } from "effect/Function";
import { type RefObject, useCallback, useSyncExternalStore } from "react";

/** The element's width in CSS pixels, kept current as it resizes; 0 before it mounts. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const subscribe = useCallback(
    (changed: () => void) => {
      const element = ref.current;
      // Without ResizeObserver (jsdom) the element stays unmeasured: 0.
      if (!element || typeof ResizeObserver === "undefined") return constVoid;
      const observer = new ResizeObserver(changed);
      observer.observe(element);
      return () => observer.disconnect();
    },
    [ref],
  );
  return useSyncExternalStore(subscribe, () => ref.current?.clientWidth ?? 0);
}

/**
 * The same for an element held in state through a callback ref. Use it when the
 * element mounts after its component, such as inside a dialog's portal, which
 * a ref object would not report.
 */
export function useNodeWidth(element: HTMLElement | null): number {
  const subscribe = useCallback(
    (changed: () => void) => {
      // Without ResizeObserver (jsdom) the element stays unmeasured: 0.
      if (!element || typeof ResizeObserver === "undefined") return constVoid;
      const observer = new ResizeObserver(changed);
      observer.observe(element);
      return () => observer.disconnect();
    },
    [element],
  );
  return useSyncExternalStore(subscribe, () => element?.clientWidth ?? 0);
}
