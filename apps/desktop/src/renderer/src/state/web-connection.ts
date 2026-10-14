import { useSyncExternalStore } from "react";
import type { WebConnection } from "./web-socket-bridge";

let current: WebConnection = "open";
let updated = false;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export function setWebConnection(next: WebConnection) {
  current = next;
  notify();
}

/** The Mac now serves a newer build than this page; a reload picks it up. */
export function setWebUpdate() {
  updated = true;
  notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The web build's link to the Mac. Always "open" in the desktop app. */
export const useWebConnection = () => useSyncExternalStore(subscribe, () => current);

/** Whether the Mac serves a newer build than this page. Always false in the desktop app. */
export const useWebUpdate = () => useSyncExternalStore(subscribe, () => updated);
