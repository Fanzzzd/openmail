import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Reactivity } from "effect/reactivity";
import { useContext, useEffect, useRef } from "react";
import { visiblePanes, type MailLayout } from "../lib/responsive-layout";
import { Keys } from "../state/keys";
import { historyAtom, locationAtom } from "../state/location";
import { useRunMail, withMail } from "../state/mail";
import type { useMailSelection } from "./use-mail-selection";

const focusReader = () =>
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('[data-mail-pane="reader"]')?.focus(),
  );

/** Moving between the sidebar, list and reader in whichever layout the window has. */
export function usePaneNavigation({
  layout,
  navigation,
  run,
}: {
  layout: MailLayout;
  navigation: ReturnType<typeof useMailSelection>;
  run: ReturnType<typeof useRunMail>;
}) {
  const { view, selectedId, prefs, focusList } = navigation;
  const viewKey = JSON.stringify(view);
  const history = useAtomValue(historyAtom);
  const registry = useContext(RegistryContext);
  // In the narrow layout the open reader has its own history entry, so the
  // browser's Back (or the iOS edge swipe) returns to the list. This is its index.
  const readerEntry = useRef<number | null>(null);
  // The reader's entry that Back left, still ahead in history: Forward onto it opens the reader
  // again. A push drops it, as the browser drops every entry ahead.
  const leftEntry = useRef<{ index: number; viewKey: string } | null>(null);
  const { setReaderViewKey } = layout;
  const readerViewKey = useRef(layout.readerViewKey);
  useEffect(() => {
    readerViewKey.current = layout.readerViewKey;
  });
  useEffect(
    () =>
      history.listen((move) => {
        if (move === "push") leftEntry.current = null;
        const left = leftEntry.current;
        if (move === "forward" && left && history.index() === left.index) {
          leftEntry.current = null;
          readerEntry.current = left.index;
          setReaderViewKey(left.viewKey);
          focusReader();
          return;
        }
        const entry = readerEntry.current;
        if (entry === null || history.index() >= entry) return;
        readerEntry.current = null;
        const shownKey = readerViewKey.current;
        if (shownKey !== null) leftEntry.current = { index: entry, viewKey: shownKey };
        setReaderViewKey(null);
      }),
    [history, setReaderViewKey],
  );
  const shown = visiblePanes(layout.mode, {
    readingPane: prefs.readingPaneVisible,
    readerViewKey: layout.readerViewKey,
    viewKey,
    selectedId,
  });
  // The reader's entry belongs to the narrow layout. A wider window selects without new entries,
  // so the entry before the reader's can hold an older conversation by the time the window is
  // narrow again; the reader then gets a fresh entry, and Back lands on what it shows.
  const narrowReader = layout.mode === "narrow" && shown.reader;
  useEffect(() => {
    if (layout.mode !== "narrow") {
      readerEntry.current = null;
      leftEntry.current = null;
    } else if (narrowReader && readerEntry.current === null) {
      history.pushSame(registry.get(locationAtom).href);
      readerEntry.current = history.index();
    }
  }, [layout.mode, narrowReader, history, registry]);
  return {
    shown,
    /** Opens the selected conversation; in the narrow layout the reader replaces the list and takes focus. */
    openReader: () => {
      layout.setReaderViewKey(viewKey);
      if (layout.mode !== "narrow") return;
      const entry = readerEntry.current;
      if (entry === null || history.index() < entry) {
        // The route as of now: the row's selection was written in this same tick.
        history.pushSame(registry.get(locationAtom).href);
        readerEntry.current = history.index();
      }
      focusReader();
    },
    /** Back from the reader to the list in the narrow layout, focus on the same row. */
    back: () => {
      const entry = readerEntry.current;
      readerEntry.current = null;
      layout.setReaderViewKey(null);
      // Leave the reader's entry too, so Forward and Back stay in step with the screen.
      if (entry !== null && history.index() >= entry) {
        leftEntry.current = { index: entry, viewKey };
        history.back();
      }
      focusList(selectedId);
    },
    /** Docks or hides the sidebar when wide; otherwise opens or closes its drawer. */
    toggleSidebar: () => {
      if (layout.mode !== "wide") {
        layout.setDrawerOpen((open) => !open);
        return;
      }
      run(
        withMail((call) =>
          call("SetPrefs", { patch: { sidebarVisible: !prefs.sidebarVisible } }),
        ).pipe(Reactivity.mutation([Keys.prefs])),
      );
    },
  };
}
export type PaneNavigation = ReturnType<typeof usePaneNavigation>;
