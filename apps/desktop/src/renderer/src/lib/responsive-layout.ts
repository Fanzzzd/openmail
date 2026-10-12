import { useState, useSyncExternalStore } from "react";
import { MEDIUM_MIN, WIDE_MIN } from "../../../shared/layout";

/**
 * How many panes the main window shows. Three when wide; two when medium,
 * with the sidebar in a drawer; one when narrow, switching between the list
 * and the reader.
 */
export type LayoutMode = "wide" | "medium" | "narrow";

export function layoutMode(width: number): LayoutMode {
  if (width >= WIDE_MIN) return "wide";
  if (width >= MEDIUM_MIN) return "medium";
  return "narrow";
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
  return layoutMode(window.innerWidth);
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
  const [drawerRequested, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState(mode);
  const [readerViewKey, setReaderViewKey] = useState<string | null>(null);
  // A drawer opened in one layout does not reappear after the window crosses into another.
  if (drawerMode !== mode) {
    setDrawerMode(mode);
    setDrawerOpen(false);
  }
  return {
    mode,
    drawerOpen: drawerRequested && mode !== "wide",
    setDrawerOpen,
    readerViewKey,
    setReaderViewKey,
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
    readerViewKey: string | null;
    viewKey: string;
    selectedId: string | null;
  },
): { list: boolean; reader: boolean } {
  if (!state.readingPane) return { list: true, reader: false };
  if (mode !== "narrow") return { list: true, reader: true };
  const reader = state.readerViewKey === state.viewKey && state.selectedId !== null;
  return { list: !reader, reader };
}

const BACK_KEY = "[";
/** The label of the ⌘ shortcut that {@link isBackKey} accepts. */
export const BACK_SHORTCUT = `⌘${BACK_KEY}`;

/** Escape or ⌘[ returns from the reader to the list in the narrow layout. */
export function isBackKey(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
) {
  if (event.altKey || event.shiftKey) return false;
  if (event.key === "Escape") return !event.metaKey && !event.ctrlKey;
  return event.key === BACK_KEY && event.metaKey && !event.ctrlKey;
}
