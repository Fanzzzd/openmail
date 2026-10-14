import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Reactivity } from "effect/reactivity";
import { useContext, useEffect, useRef } from "react";
import { visiblePanes, type MailLayout } from "../lib/responsive-layout";
import { Keys } from "../state/keys";
import { historyAtom, locationAtom } from "../state/location";
import { useRunMail, withMail } from "../state/mail";
import type { useMailSelection } from "./use-mail-selection";

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
  const { setReaderViewKey } = layout;
  useEffect(
    () =>
      history.listen(() => {
        const entry = readerEntry.current;
        if (entry === null || history.index() >= entry) return;
        readerEntry.current = null;
        setReaderViewKey(null);
      }),
    [history, setReaderViewKey],
  );
  return {
    shown: visiblePanes(layout.mode, {
      readingPane: prefs.readingPaneVisible,
      readerViewKey: layout.readerViewKey,
      viewKey,
      selectedId,
    }),
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
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[data-mail-pane="reader"]')?.focus(),
      );
    },
    /** Back from the reader to the list in the narrow layout, focus on the same row. */
    back: () => {
      const entry = readerEntry.current;
      readerEntry.current = null;
      layout.setReaderViewKey(null);
      // Leave the reader's entry too, so Forward and Back stay in step with the screen.
      if (entry !== null && history.index() >= entry) history.back();
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
