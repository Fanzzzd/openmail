import { Reactivity } from "effect/reactivity";
import { visiblePanes, type MailLayout } from "../responsive-layout";
import { Keys } from "../state/keys";
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
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[data-mail-pane="reader"]')?.focus(),
      );
    },
    /** Back from the reader to the list in the narrow layout, focus on the same row. */
    back: () => {
      layout.setReaderViewKey(null);
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
