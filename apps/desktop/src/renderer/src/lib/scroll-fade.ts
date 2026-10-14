import { constVoid } from "effect/Function";
import { useCallback, useState } from "react";

/** Which ends of a horizontal scroller have content past them. */
export interface ScrollEdges {
  start: boolean;
  end: boolean;
}

/** The edges of `element` that hide content, with a pixel of slack for fractional widths. */
export function scrollEdges(element: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): ScrollEdges {
  const hidden = element.scrollWidth - element.clientWidth;
  return { start: element.scrollLeft > 1, end: element.scrollLeft < hidden - 1 };
}

/**
 * A mask that fades a horizontal scroller's clipped ends, so a cut-off row reads as scrollable.
 * Undefined when nothing is clipped.
 */
export function scrollFadeMask(edges: ScrollEdges): string | undefined {
  if (!edges.start && !edges.end) return undefined;
  const start = edges.start ? "transparent 0, black 1.5rem" : "black 0";
  const end = edges.end ? "black calc(100% - 2rem), transparent 100%" : "black 100%";
  return `linear-gradient(to right, ${start}, ${end})`;
}

/**
 * Tracks a horizontal scroller's clipped ends for {@link scrollFadeMask}, and lets a vertical
 * wheel scroll it sideways, since a mouse has no other way to reach the clipped end. Give the
 * scroller a `key` that changes with what it holds, so the new content is measured.
 */
export function useScrollFade() {
  const [edges, setEdges] = useState<ScrollEdges>({ start: false, end: false });
  const ref = useCallback((element: HTMLElement | null) => {
    if (!element) return constVoid;
    const update = () =>
      setEdges((previous) => {
        const next = scrollEdges(element);
        return next.start === previous.start && next.end === previous.end ? previous : next;
      });
    const wheel = (event: WheelEvent) => {
      if (element.scrollWidth <= element.clientWidth || event.deltaX !== 0) return;
      element.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    element.addEventListener("scroll", update, { passive: true });
    element.addEventListener("wheel", wheel, { passive: false });
    update();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
      element.removeEventListener("wheel", wheel);
    };
  }, []);
  return { ref, mask: scrollFadeMask(edges) };
}
