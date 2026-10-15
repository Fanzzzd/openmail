import { constVoid } from "effect/Function";
import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Dialogs, sheets and popovers that are open in this window, newest last. Close window (⌘W)
 * closes the newest one instead of the window, the way Escape would. The shared primitives
 * register themselves, so a new dialog or popover is covered without its own wiring.
 */
const open: { close: () => void }[] = [];
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const anyOpen = () => open.length > 0;

/** Registers a dismissible surface while `isOpen`. `close` may change between renders. */
export function useOpenSurface(isOpen: boolean, close: (() => void) | undefined) {
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  const dismissible = close !== undefined;
  useEffect(() => {
    if (!isOpen || !dismissible) return constVoid;
    const entry = { close: () => latest.current?.() };
    open.push(entry);
    publish();
    return () => {
      const index = open.indexOf(entry);
      if (index >= 0) open.splice(index, 1);
      publish();
    };
  }, [isOpen, dismissible]);
}

/** Some dialog, sheet or popover is open, so Close window should close it first. */
export function useSurfaceOpen(): boolean {
  return useSyncExternalStore(subscribe, anyOpen, anyOpen);
}

/** Closes the newest open surface. False when none is open. */
function closeNewestSurface(): boolean {
  const newest = open.at(-1);
  if (!newest) return false;
  newest.close();
  return true;
}

/**
 * Close window while this window's menu state says a sheet is open. The newest surface closes
 * first, then `closeOther` (an app dialog or the inline composer). With nothing to close, the
 * state main acted on was out of date, so the window closes: the key never does nothing.
 */
export function closeSheet(closeWindow: () => void, closeOther = () => false): void {
  if (closeNewestSurface() || closeOther()) return;
  closeWindow();
}
