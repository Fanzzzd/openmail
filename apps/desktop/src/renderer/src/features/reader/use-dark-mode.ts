import { useSyncExternalStore } from "react";

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

/** Whether the app is in dark mode right now. */
export function useDarkMode(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = darkQuery();
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => darkQuery().matches,
  );
}
