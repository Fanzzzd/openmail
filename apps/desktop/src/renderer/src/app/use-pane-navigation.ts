import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Reactivity } from "effect/reactivity";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef } from "react";
import { visiblePanes, type MailLayout } from "../lib/responsive-layout";
import { Keys } from "../state/keys";
import { historyAtom, locationAtom, locationOf } from "../state/location";
import { mailHref } from "../../../shared/routes";
import { useRunMail, withMail } from "../state/mail";
import type { useMailSelection } from "./use-mail-selection";

const focusReaderNow = () =>
  document.querySelector<HTMLElement>('[data-mail-pane="reader"]')?.focus();
const focusReader = () => requestAnimationFrame(focusReaderNow);

/**
 * A route without the message picked in the open thread. The reader writes that pick into its
 * own entry once it shows, so the entry before it never has it, yet Back to it shows the same
 * conversation.
 */
function withoutMessage(href: string) {
  const { route } = locationOf(href);
  if (route.kind !== "mail") return href;
  const { message: _message, ...state } = route.state;
  return mailHref(route.view, state);
}

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
  // The route of the entry before the reader's, as it was when the reader's entry was added,
  // without the picked message.
  const beforeReader = useRef<string | null>(null);
  // The reader's entry that Back left, still ahead in history: Forward onto it opens the reader
  // again. A push drops it, as the browser drops every entry ahead.
  const leftEntry = useRef<{ index: number; viewKey: string } | null>(null);
  // The reader's entry that widening stepped back over. It shows the route of the entry before
  // it, so Forward onto it would change nothing. It is always the last entry, since the reader's
  // entry is pushed and a push drops every entry ahead, so Forward onto it steps back off it.
  const steppedOver = useRef<number | null>(null);
  const { setReaderViewKey } = layout;
  const pushReaderEntry = useCallback(() => {
    // The route as of now: a row's selection may have been written in this same tick.
    const href = registry.get(locationAtom).href;
    history.pushSame(href);
    readerEntry.current = history.index();
    beforeReader.current = withoutMessage(href);
  }, [history, registry]);
  const readerViewKey = useRef(layout.readerViewKey);
  useEffect(() => {
    readerViewKey.current = layout.readerViewKey;
  });
  useEffect(
    () =>
      history.listen((move) => {
        if (move === "push") {
          leftEntry.current = null;
          steppedOver.current = null;
        }
        if (move === "forward" && history.index() === steppedOver.current) {
          history.back();
          return;
        }
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
  // Leaving the narrow layout on the reader's entry steps back over it while it still holds the
  // route of the entry before it, apart from the message the reader picked; otherwise each pass
  // through the narrow layout would leave an entry that Back steps through with nothing changing.
  // An entry whose route moved on, as after the next conversation or a pick while wide, stays:
  // Back from it still changes the screen.
  const narrowReader = layout.mode === "narrow" && shown.reader;
  useEffect(() => {
    const entry = readerEntry.current;
    if (layout.mode !== "narrow") {
      readerEntry.current = null;
      leftEntry.current = null;
      if (
        entry !== null &&
        history.index() === entry &&
        withoutMessage(registry.get(locationAtom).href) === beforeReader.current
      ) {
        steppedOver.current = entry;
        history.back();
      }
    } else if (narrowReader && entry === null) pushReaderEntry();
  }, [layout.mode, narrowReader, history, registry, pushReaderEntry]);
  // Changing layouts moves the list's and the reader's hosts into new slots (usePaneHost). The
  // focused element leaves the document for a moment, so focus falls to the page; or it stays in a
  // pane the new layout hides, as when the window narrows with a conversation open or Back returns
  // to the narrow reader's entry from another mailbox. Either way focus goes back to the element
  // that had it when that element still shows. Otherwise it goes to the reader when the reader is
  // the only pane or had focus, else to the selected row when the list had focus.
  const focused = useRef<{ pane: string | null; element: HTMLElement | null }>({
    pane: null,
    element: null,
  });
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      focused.current = {
        pane: event.target.closest<HTMLElement>("[data-mail-pane]")?.dataset.mailPane ?? null,
        element: event.target,
      };
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);
  // What the rendered layout shows, for the frame after a move. Layout effects run in the same
  // commit as the slot refs, so the frame never sees an older layout.
  const latest = useRef({ shown, selectedId, focusList });
  useLayoutEffect(() => {
    latest.current = { shown, selectedId, focusList };
  });
  const moveFrame = useRef<number | null>(null);
  const panesMoved = useCallback(() => {
    if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = null;
      const active = document.activeElement;
      if (active && active !== document.body && !active.closest("[hidden]")) return;
      const { pane, element } = focused.current;
      if (element?.isConnected && !element.closest("[hidden]")) {
        element.focus({ preventScroll: true });
        if (document.activeElement === element) return;
      }
      const { shown: panes, selectedId: row, focusList: toList } = latest.current;
      if (panes.reader && (pane === "reader" || !panes.list)) focusReaderNow();
      else if (pane === "reader" || pane === "list") toList(row);
    });
  }, []);
  useEffect(
    () => () => {
      if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
    },
    [],
  );
  return {
    shown,
    /** usePaneHost calls this after it moves a pane into a new slot. */
    panesMoved,
    /** Opens the selected conversation; in the narrow layout the reader replaces the list and takes focus. */
    openReader: () => {
      layout.setReaderViewKey(viewKey);
      if (layout.mode !== "narrow") return;
      const entry = readerEntry.current;
      if (entry === null || history.index() < entry) pushReaderEntry();
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
