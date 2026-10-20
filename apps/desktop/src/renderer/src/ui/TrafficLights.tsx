/**
 * Room for the macOS traffic lights. Every window's first row uses the
 * `titlebarRow` recipe, the 52 px row main centres the lights in, and every
 * header that can sit under them starts with <TrafficLightSpace/>. The spacer
 * takes exactly the width that keeps the header's content clear of the
 * buttons, measured against their real bounds, and nothing beside or below
 * them, in full screen or in the web build.
 */
import { constVoid } from "effect/Function";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

import {
  trafficLightClearance,
  trafficLightSpace,
  trafficLightSpacer,
  type TitlebarArea,
} from "../../../shared/window-chrome";
import { isDesktop } from "../lib/platform";
import { titlebarAreaStore, type TitlebarAreaStore } from "./titlebar-area";

declare global {
  /** Chromium's Window Controls Overlay API; TypeScript's DOM types do not have it yet. */
  interface WindowControlsOverlay extends EventTarget {
    readonly visible: boolean;
    getTitlebarAreaRect(): DOMRect;
  }
  interface Navigator {
    readonly windowControlsOverlay?: WindowControlsOverlay;
  }
}

/**
 * The titlebar area beside the lights, read from the overlay. The overlay is
 * not visible in full screen, where macOS hides the lights, nor off the Mac.
 */
function readArea(overlay: WindowControlsOverlay): TitlebarArea | null {
  if (!overlay.visible) return null;
  const rect = overlay.getTitlebarAreaRect();
  return { x: rect.x, y: rect.y, height: rect.height };
}

let store: { overlay: WindowControlsOverlay; area: TitlebarAreaStore } | undefined;

/** One settled store per overlay; tests swap the overlay between cases. */
function areaStore() {
  const overlay = isDesktop() ? navigator.windowControlsOverlay : null;
  if (!overlay) return null;
  if (store?.overlay !== overlay)
    store = { overlay, area: titlebarAreaStore(() => readArea(overlay)) };
  return store;
}

function subscribe(onChange: () => void) {
  const current = areaStore();
  if (!current) return constVoid;
  const { overlay, area } = current;
  const unsubscribe = area.subscribe(onChange);
  const update = () => area.update();
  overlay.addEventListener("geometrychange", update);
  window.addEventListener("resize", update);
  return () => {
    unsubscribe();
    overlay.removeEventListener("geometrychange", update);
    window.removeEventListener("resize", update);
  };
}

/** Where the lights' row is free for content; null when there are no lights. */
export const useTitlebarArea = () =>
  useSyncExternalStore(
    subscribe,
    () => areaStore()?.area.get() ?? null,
    () => null,
  );

const px = (value: string) => Number.parseFloat(value) || 0;

/**
 * Where `el` sits in the window by layout alone. Transforms do not count, so
 * a drawer or sheet that is still sliding in measures where it comes to rest.
 */
function layoutBox(el: HTMLElement) {
  let left = 0;
  let top = 0;
  for (let node: HTMLElement | null = el; node;) {
    const parent: Element | null = node.offsetParent;
    left += node.offsetLeft + (parent?.clientLeft ?? 0);
    top += node.offsetTop + (parent?.clientTop ?? 0);
    node = parent instanceof HTMLElement ? parent : null;
  }
  return { left, top, bottom: top + el.offsetHeight };
}

/** The measure of every mounted spacer; see `rowsMoved`. */
const spacers = new Set<() => void>();

/**
 * Re-measures every spacer, now and again in the next animation frame. Call
 * after the layout moves a header row without resizing it, such as a pane
 * host that moves to a new slot when the sidebar docks, undocks or becomes
 * the rail. A ResizeObserver does not fire for a move. The second pass
 * catches a pane that its library sizes in a later effect of the same commit.
 */
export function rowsMoved() {
  for (const measure of spacers) measure();
}

/**
 * A drag-region spacer, first in a header row. It sizes itself so the next
 * item starts where the lights' row is free, after the row's own padding and
 * gap, and renders nothing where the lights are not.
 */
export function TrafficLightSpace({ className = "" }: { className?: string }) {
  const area = useTitlebarArea();
  const anchor = useRef<HTMLSpanElement>(null);
  // The width goes straight to the DOM, not through React state: a resize or
  // a moved row then lays out with the new width in the same frame. A state
  // update from a ResizeObserver would paint one frame with the old width.
  useLayoutEffect(() => {
    const space = anchor.current;
    const row = space?.parentElement;
    if (!space || !row) return constVoid;
    let last = "";
    let frame = 0;
    const measureNow = () => {
      const box = layoutBox(row);
      const style = getComputedStyle(row);
      const start = box.left + px(style.borderLeftWidth) + px(style.paddingLeft);
      const need = trafficLightSpace(area, { ...box, left: start });
      const gap = px(style.columnGap);
      if (`${need},${gap}` === last) return;
      last = `${need},${gap}`;
      const { shown, width, marginEnd } = trafficLightSpacer(need, gap);
      // How far the row's first item moves: to the free area's left edge.
      space.dataset.trafficLightSpace = String(shown ? need : 0);
      space.style.width = `${width}px`;
      space.style.marginInlineEnd = marginEnd < 0 ? `${marginEnd}px` : "";
      // A hidden spacer leaves the flex row, so the row's gap does not add up either.
      space.hidden = !shown;
    };
    const measure = () => {
      measureNow();
      if (frame || typeof requestAnimationFrame !== "function") return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measureNow();
      });
    };
    measureNow();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measureNow);
    observer?.observe(row);
    // The window's resize event comes before the media queries report a new
    // breakpoint and React moves the panes, so the row may still move in this
    // frame. The animation frame callback runs after that commit and before paint.
    window.addEventListener("resize", measure);
    spacers.add(measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      spacers.delete(measure);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [area]);
  if (!area) return null;
  return <span ref={anchor} aria-hidden className={`drag shrink-0 self-stretch ${className}`} />;
}

/**
 * Sets `--titlebar-clearance`, the strip a full-window sheet keeps clear for
 * the lights. Mount once per desktop window.
 */
export function TitlebarClearance() {
  const area = useTitlebarArea();
  useLayoutEffect(() => {
    document.documentElement.style.setProperty(
      "--titlebar-clearance",
      `${trafficLightClearance(area)}px`,
    );
  }, [area]);
  return null;
}
