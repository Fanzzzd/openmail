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
    const measure = () => {
      const box = layoutBox(row);
      const style = getComputedStyle(row);
      const start = box.left + px(style.borderLeftWidth) + px(style.paddingLeft);
      const width = trafficLightSpace(area, { ...box, left: start + px(style.columnGap) });
      if (space.dataset.trafficLightSpace === String(width)) return;
      space.dataset.trafficLightSpace = String(width);
      space.style.width = `${width}px`;
      // With no width it leaves the flex row, so the row's gap does not add up either.
      space.hidden = width === 0;
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(row);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
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
