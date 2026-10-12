import { useSyncExternalStore } from "react";
import type { WebConnection } from "./web-socket-bridge";

let current: WebConnection = "open";
const listeners = new Set<() => void>();

export function setWebConnection(next: WebConnection) {
  current = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The web build's link to the Mac. Always "open" in the desktop app. */
export const useWebConnection = () => useSyncExternalStore(subscribe, () => current);
