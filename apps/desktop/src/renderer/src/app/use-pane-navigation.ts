import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Reactivity } from "effect/reactivity";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef } from "react";
import { visiblePanes, type MailLayout } from "../lib/responsive-layout";
import { Keys } from "../state/keys";
import { historyAtom, locationAtom, locationOf } from "../state/location";
import { mailHref } from "../../../shared/routes";
import { useRunMail, withMail } from "../state/mail";
import type { useMailSelection } from "./use-mail-selection";

const readerPane = () => document.querySelector<HTMLElement>('[data-mail-pane="reader"]');
const focusReader = () => requestAnimationFrame(() => readerPane()?.focus());

const paneOf = (element: Element) =>
  element.closest<HTMLElement>("[data-mail-pane]")?.dataset.mailPane ?? null;
/** Whether an element is in the document and not in a hidden pane. */
const shows = (element: Element) => element.isConnected && !element.closest("[hidden]");

/**
 * The control that stands for `element` once a layout replaced it: the shown element with the same
 * `data-focus-key`, as the same mailbox in the docked sidebar, the rail or the drawer, or the search
 * field in the list header or the reader header.
 */
function sameControl(element: HTMLElement) {
  const key = element.dataset.focusKey;
  if (key === undefined) return null;
  return [...document.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
    (control) => control.dataset.focusKey === key && shows(control),
  );
}
/** The open mailbox's control in the sidebar, rail or drawer that shows. */
const currentMailbox = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[data-mail-pane="sidebar"] [data-focus-key][aria-current="page"]',
    ),
  ].find(shows);

/** Focuses `target` for a restore, marked in `restoring` so its focusin is not remembered. */
function restore(
  target: HTMLElement | null | undefined,
  restoring: { current: HTMLElement | "list" | null },
) {
  if (!target) return false;
  restoring.current = target;
  target.focus({ preventScroll: true });
  restoring.current = null;
  return document.activeElement === target;
}

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
  // Changing layouts moves the list's and the reader's hosts into new slots (usePaneHost) and
  // remounts the sidebar. The focused element leaves the document for a moment, so focus falls to
  // the page; or it stays in a pane the new layout hides, as when the window narrows with a
  // conversation open or Back returns to the narrow reader's entry from another mailbox. Only
  // then does focus come back, and only to an element the move displaced: one in a moved host, an
  // unmounted sidebar or a hidden pane. It goes to that element when it still shows, else to the
  // same control in the version of its pane now shown (sameControl), else to the open mailbox in
  // the sidebar shown, else to the reader when the reader is the only pane or had focus, else to
  // the list's selected row. An element the person left, as by clicking an empty part of the
  // window, is forgotten, so a later move never sends focus back to it.
  const focused = useRef<{ pane: string | null; element: HTMLElement | null }>({
    pane: null,
    element: null,
  });
  // What a restore focused in place of the remembered element, while it keeps focus. The next
  // move tries the remembered element again, as when the search field shows again after the
  // narrow reader stood in for it.
  const placed = useRef<HTMLElement | null>(null);
  // What a restore is focusing: an element, or any element of the list while focusList looks for
  // its row. Its focusin goes to `placed`, not to `focused`.
  const restoring = useRef<HTMLElement | "list" | null>(null);
  // Counts moves, so a focusout during a move's commit is not taken for the person leaving.
  const moves = useRef(0);
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      const pane = paneOf(event.target);
      const expected = restoring.current;
      restoring.current = null;
      if (expected === event.target || (expected === "list" && pane === "list")) {
        placed.current = event.target === focused.current.element ? null : event.target;
        return;
      }
      focused.current = { pane, element: event.target };
      placed.current = null;
    };
    // Focus that leaves for the page while its element still shows and no pane moved was left
    // by the person, as by a click on an empty part of the window.
    const leave = (event: FocusEvent) => {
      const target = event.target;
      if (target !== focused.current.element && target !== placed.current) return;
      if (!(target instanceof HTMLElement)) return;
      const at = moves.current;
      queueMicrotask(() => {
        const active = document.activeElement;
        if (moves.current !== at || (active && active !== document.body) || !shows(target)) return;
        focused.current = { pane: null, element: null };
        placed.current = null;
      });
    };
    // A restore still waiting for the list's row gives way to the person's own input.
    const input = () => {
      restoring.current = null;
    };
    // A click in the element a restore focused makes it the person's own, though focus does not
    // move and no focusin comes.
    const press = (event: PointerEvent) => {
      input();
      const standIn = placed.current;
      if (!standIn || !(event.target instanceof Node) || !standIn.contains(event.target)) return;
      focused.current = { pane: paneOf(standIn), element: standIn };
      placed.current = null;
    };
    document.addEventListener("focusin", remember);
    document.addEventListener("focusout", leave);
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("keydown", input, true);
    return () => {
      document.removeEventListener("focusin", remember);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("keydown", input, true);
    };
  }, []);
  // What the rendered layout shows, for the frame after a move. Layout effects run in the same
  // commit as the slot refs, so the frame never sees an older layout.
  const latest = useRef({ shown, selectedId, focusList });
  useLayoutEffect(() => {
    latest.current = { shown, selectedId, focusList };
  });
  const moveFrame = useRef<number | null>(null);
  const movedHosts = useRef(new Set<HTMLElement>());
  const panesMoved = useCallback((host: HTMLElement) => {
    moves.current += 1;
    movedHosts.current.add(host);
    if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = null;
      const hosts = [...movedHosts.current];
      movedHosts.current.clear();
      const { pane, element } = focused.current;
      if (!element || pane === null) return;
      const active = document.activeElement;
      const standIn = active !== null && active === placed.current;
      const lost = !active || active === document.body || active.closest("[hidden]") !== null;
      if (!lost && !standIn) return;
      const displaced =
        standIn || !shows(element) || hosts.some((moved) => moved.contains(element));
      if (!displaced) return;
      if (shows(element) && restore(element, restoring)) return;
      if (restore(sameControl(element), restoring)) return;
      if (pane === "sidebar" && restore(currentMailbox(), restoring)) return;
      const { shown: panes, selectedId: row, focusList: toList } = latest.current;
      if (panes.reader && (pane === "reader" || !panes.list)) restore(readerPane(), restoring);
      else {
        // focusList may wait a few frames for the row, so its focusin comes later.
        restoring.current = "list";
        toList(row);
      }
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
