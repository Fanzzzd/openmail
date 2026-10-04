import { constVoid } from "effect/Function";
import { type RefObject, useCallback, useSyncExternalStore } from "react";

/** The element's width in CSS pixels, kept current as it resizes; 0 before it mounts. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const subscribe = useCallback(
    (changed: () => void) => {
      const element = ref.current;
      if (!element) return constVoid;
      const observer = new ResizeObserver(changed);
      observer.observe(element);
      return () => observer.disconnect();
    },
    [ref],
  );
  return useSyncExternalStore(subscribe, () => ref.current?.clientWidth ?? 0);
}
