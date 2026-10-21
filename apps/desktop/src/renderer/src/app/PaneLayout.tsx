import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { plural } from "@lingui/core/macro";
import { constVoid } from "effect/Function";
import { useLingui } from "@lingui/react/macro";
import { BatchActions } from "../features/mail-list/BatchActions";
import { ThreadActions } from "../features/organize/ThreadActions";
import { Separator } from "react-resizable-panels";
import { rowsMoved } from "../ui/TrafficLights";

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
 * moves one DOM node instead of remounting the list or the reader. A moved
 * node drops focus, so `moved` runs with the host after each move to put it back.
 */
export function usePaneHost(moved: (host: HTMLElement) => void) {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "flex h-full min-w-0 flex-1";
    return element;
  });
  const slot = useCallback(
    (element: HTMLElement | null) => {
      if (!element) return;
      element.append(host);
      // The pane's header rows moved, often without changing size.
      rowsMoved();
      moved(host);
    },
    [host, moved],
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
  const { t } = useLingui();
  const ref = useRef<HTMLDivElement>(null);
  // The library reports the pane's share of the group as a raw percentage, such as
  // 17.589000701904297. Screen readers read the pane's width (or height) in pixels instead.
  const [pixels, setPixels] = useState<number | null>(null);
  useEffect(() => {
    const pane = ref.current?.previousElementSibling;
    if (!pane) return constVoid;
    const measure = () => {
      const rect = pane.getBoundingClientRect();
      setPixels(Math.round(orientation === "vertical" ? rect.height : rect.width));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [orientation]);
  return (
    <Separator
      elementRef={ref}
      aria-valuetext={
        pixels === null
          ? undefined
          : t({
              message: plural(pixels, { one: "# pixel", other: "# pixels" }),
              comment:
                "A pane divider's value for screen readers: the width or height of the pane it resizes.",
            })
      }
      aria-label={label}
      className={`no-drag ${orientation === "vertical" ? "h-px" : "w-px"} bg-black/5 transition-colors focus-ring relative focus-visible:z-10 data-[separator=active]:bg-blue-500 data-[separator=focus]:bg-blue-500 data-[separator=hover]:bg-blue-500/60 dark:bg-white/5`}
    />
  );
}
