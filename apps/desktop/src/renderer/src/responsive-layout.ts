import { useSyncExternalStore } from "react";

const query = "(max-width: 640px)";
function subscribe(changed: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", changed);
  return () => media.removeEventListener("change", changed);
}

/** Browser zoom reduces CSS viewport width, so narrow windows use stacked panes. */
export function useNarrowLayout() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
