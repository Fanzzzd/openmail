import { useState, useSyncExternalStore } from "react";

/**
 * How many panes the main window shows. Three when wide; two when medium,
 * with the sidebar in a drawer; one when narrow, switching between the list
 * and the reader.
 */
export type LayoutMode = "wide" | "medium" | "narrow";

/** The narrowest width at which each pane's content stays readable, in CSS pixels. */
export const PANE_MIN = { sidebar: 200, list: 300, reader: 340 } as const;

/** The sidebar docks only once the reader keeps 460 px beside it; below that the reader gets its room. */
export const WIDE_MIN = PANE_MIN.sidebar + PANE_MIN.list + 460;
/** Equal to Tailwind's `sm` breakpoint, so `max-sm:` styles apply exactly in the narrow layout. */
export const MEDIUM_MIN = PANE_MIN.list + PANE_MIN.reader;

export function layoutMode(width: number): LayoutMode {
  return width >= WIDE_MIN ? "wide" : width >= MEDIUM_MIN ? "medium" : "narrow";
}

// Browser zoom shrinks the CSS viewport, so media queries track zoom as well as window size.
const queries = [`(width < ${WIDE_MIN}px)`, `(width < ${MEDIUM_MIN}px)`];
function subscribe(changed: () => void) {
  const lists = queries.map((query) => window.matchMedia(query));
  for (const list of lists) list.addEventListener("change", changed);
  return () => {
    for (const list of lists) list.removeEventListener("change", changed);
  };
}
function snapshot(): LayoutMode {
  const [belowWide, belowMedium] = queries.map((query) => window.matchMedia(query).matches);
  return belowMedium ? "narrow" : belowWide ? "medium" : "wide";
}

export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * Window-level layout state: the mode, the sidebar drawer used when the
 * sidebar is not docked, and in the narrow layout the view whose reader is open.
 */
export function useMailLayout() {
  const mode = useLayoutMode();
  const [drawer, setDrawerOpen] = useState(false);
  const [readerIn, setReaderIn] = useState<string | null>(null);
  return {
    mode,
    drawerOpen: drawer && mode !== "wide",
    setDrawerOpen,
    readerIn,
    setReaderIn,
  };
}
export type MailLayout = ReturnType<typeof useMailLayout>;

/**
 * Which of the list and reader are on screen. The narrow layout shows the
 * reader only after a row was opened in the current view, and only while a
 * conversation is selected.
 */
export function visiblePanes(
  mode: LayoutMode,
  state: {
    readingPane: boolean;
    readerIn: string | null;
    viewKey: string;
    selectedId: string | null;
  },
): { list: boolean; reader: boolean } {
  if (!state.readingPane) return { list: true, reader: false };
  if (mode !== "narrow") return { list: true, reader: true };
  const reader = state.readerIn === state.viewKey && state.selectedId !== null;
  return { list: !reader, reader };
}

/** Escape or ⌘[ returns from the reader to the list in the narrow layout. */
export function isBackKey(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
) {
  if (event.altKey || event.shiftKey) return false;
  if (event.key === "Escape") return !event.metaKey && !event.ctrlKey;
  return event.key === "[" && event.metaKey && !event.ctrlKey;
}
