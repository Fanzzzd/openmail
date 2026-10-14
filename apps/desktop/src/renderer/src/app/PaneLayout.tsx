import { useCallback, useState, type ComponentProps } from "react";
import { BatchActions } from "../features/mail-list/BatchActions";
import { ThreadActions } from "../features/organize/ThreadActions";
import { Separator } from "react-resizable-panels";

/** The reader's actions: for the selected rows when several are selected, otherwise for the open thread. */
export function ReaderToolbar({
  batch,
  thread,
}: {
  batch: ComponentProps<typeof BatchActions> | null;
  thread: ComponentProps<typeof ThreadActions> | null;
}) {
  if (batch) return <BatchActions {...batch} />;
  return thread && <ThreadActions {...thread} />;
}

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

/**
 * The line between two panes. It draws the 1 px border the panes used to
 * carry themselves; the group's resizeTargetMinimumSize widens what the
 * pointer can grab without widening the line. Keyboard focus draws the app's
 * 2 px focus ring around it, raised over the panes so they don't cover it.
 */
export function ResizeHandle({
  label,
  orientation = "horizontal",
}: {
  /** Names the pane the handle resizes. The library's separator takes arrow keys, Home and End. */
  label: string;
  orientation?: "horizontal" | "vertical";
}) {
  return (
    <Separator
      aria-label={label}
      className={`no-drag ${orientation === "vertical" ? "h-px" : "w-px"} bg-black/5 transition-colors focus-ring relative focus-visible:z-10 data-[separator=active]:bg-blue-500 data-[separator=focus]:bg-blue-500 data-[separator=hover]:bg-blue-500/60 dark:bg-white/5`}
    />
  );
}
