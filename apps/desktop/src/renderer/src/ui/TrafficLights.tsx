/**
 * Room for the macOS traffic lights. Every header that can sit under them
 * starts with <TrafficLightSpace/>; it takes exactly the width that keeps the
 * header's content clear of the buttons, measured against their real bounds,
 * and nothing beside or below them, in full screen or in the web build.
 * Main centres the buttons in the header row the spacer reports.
 */
import { constVoid } from "effect/Function";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  DEFAULT_TITLEBAR_AREA,
  holdsTrafficLights,
  trafficLightSpace,
  type TitlebarArea,
} from "../../../shared/window-chrome";
import { isDesktop } from "../lib/platform";

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

let cached: TitlebarArea | null = null;
let cachedKey = "";

/**
 * The titlebar area beside the lights, from the Window Controls Overlay API.
 * It is not visible in full screen, where macOS hides the lights, nor off the
 * Mac. A renderer without the API, such as a test DOM, gets main's default.
 */
function readArea(): TitlebarArea | null {
  if (!isDesktop()) return null;
  const overlay = navigator.windowControlsOverlay;
  if (!overlay) return DEFAULT_TITLEBAR_AREA;
  if (!overlay.visible) return null;
  const rect = overlay.getTitlebarAreaRect();
  const key = `${rect.x},${rect.y},${rect.height}`;
  if (key !== cachedKey) {
    cachedKey = key;
    cached = { x: rect.x, y: rect.y, height: rect.height };
  }
  return cached;
}

function subscribe(onChange: () => void) {
  const overlay = isDesktop() ? navigator.windowControlsOverlay : undefined;
  overlay?.addEventListener("geometrychange", onChange);
  window.addEventListener("resize", onChange);
  return () => {
    overlay?.removeEventListener("geometrychange", onChange);
    window.removeEventListener("resize", onChange);
  };
}

/** Where the lights' row is free for content; null when there are no lights. */
export const useTitlebarArea = () => useSyncExternalStore(subscribe, readArea, () => null);

let send: ((height: number) => void) | undefined;
let pending: number | undefined;
let reported = "";

function reportTitlebarHeight(height: number) {
  const key = `${height}@${window.devicePixelRatio}`;
  if (key === reported) return;
  if (!send) {
    pending = height;
    return;
  }
  reported = key;
  send(height);
}

const px = (value: string | undefined) => Number.parseFloat(value ?? "") || 0;

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
 * gap, and renders nothing where the lights are not. The row that holds the
 * lights reports its height, so main centres them in it.
 */
export function TrafficLightSpace({ className = "" }: { className?: string }) {
  const area = useTitlebarArea();
  const anchor = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const row = anchor.current?.parentElement;
    if (!row) return constVoid;
    const measure = () => {
      const box = layoutBox(row);
      // Test DOMs without CSS have no computed style; the row then has no padding or gap.
      const style = typeof getComputedStyle === "function" ? getComputedStyle(row) : undefined;
      const start = box.left + px(style?.borderLeftWidth) + px(style?.paddingLeft);
      setWidth(trafficLightSpace(area, { ...box, left: start + px(style?.columnGap) }));
      if (holdsTrafficLights(area, box, start)) reportTitlebarHeight(box.bottom - box.top);
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
  // With no width it leaves the flex row, so the row's gap does not add up either.
  return (
    <span
      ref={anchor}
      aria-hidden
      data-traffic-light-space={width}
      hidden={width === 0}
      className={`drag shrink-0 self-stretch ${className}`}
      style={{ width }}
    />
  );
}

/**
 * Sends the lights' row height to main; returns the disconnect. A height
 * measured before the connection goes out once it is made.
 */
export function connectTitlebar(next: (height: number) => void) {
  send = next;
  const waiting = pending;
  pending = undefined;
  if (waiting !== undefined) reportTitlebarHeight(waiting);
  return () => {
    send = undefined;
    reported = "";
  };
}
