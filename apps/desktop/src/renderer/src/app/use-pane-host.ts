import { useCallback, useState } from "react";

/**
 * A pane that keeps its React state when the layout moves it. The caller
 * portals the pane into `host` at one fixed place in the tree, and each
 * layout gives the host a slot through the `slot` ref. Changing layouts then
 * moves one DOM node instead of remounting the list or the reader.
 */
export function usePaneHost() {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "flex h-full min-w-0 flex-1";
    return element;
  });
  const slot = useCallback(
    (element: HTMLElement | null) => {
      element?.append(host);
    },
    [host],
  );
  return { host, slot };
}
