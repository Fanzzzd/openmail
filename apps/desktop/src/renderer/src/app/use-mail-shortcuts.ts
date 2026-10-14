import { isDesktop } from "../lib/platform";
import { Reactivity } from "effect/reactivity";
import { type RefObject, useEffect, useEffectEvent } from "react";
import type { Profile } from "../../../shared/api";
import {
  favoriteShortcut,
  folderShortcut,
  historyShortcut,
  paneShortcut,
  selectionShortcut,
  shortcutAction,
  spaceShortcut,
} from "../../../shared/shortcuts";
import { useThreadPrint } from "../features/reader/use-thread-print";
import type { ThreadState } from "../lib/focused-inbox";
import { usesDeletePreference } from "../lib/delete-key";
import { favoriteView, numberedFavorites } from "../features/sidebar/favorite-navigation";
import { moveMailPaneFocus } from "./pane-navigation";
import { Keys } from "../state/keys";
import { syncNow, useRunMail, withMail } from "../state/mail";
import { useBatchUndo } from "../state/undo";
import { ALL, OVERVIEW } from "../lib/view";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { editingProfileAtom } from "../features/accounts/profile-editing";
import {
  labelPickerAtom,
  pickerModeAtom,
  snoozeIdsAtom,
} from "../features/organize/organize-state";
import { filterSeedAtom } from "../features/settings/filter-seed";
import { goToFolderAtom } from "../features/sidebar/go-to-folder";
import { dialogAtom } from "../state/ui";
import { historyAtom } from "../state/location";
import type { useMailActions } from "./use-mail-actions";
import type { useMailCompose } from "./use-mail-compose";
import type { useMailSelection } from "./use-mail-selection";
import type { PaneNavigation } from "./use-pane-navigation";
import { isBackKey } from "../lib/responsive-layout";
import { isTypingTarget } from "../lib/typing-target";
import { checkingRows } from "../lib/selection";
import { escapeClearsSearch } from "./search-escape";
export function useMailShortcuts({
  searchRef,
  navigation,
  panes,
  mailActions,
  composition,
  run,
  profileList,
  favorites,
  undoRef,
  openWindow,
  threadState,
  print,
}: {
  searchRef: RefObject<HTMLInputElement | null>;
  navigation: ReturnType<typeof useMailSelection>;
  panes: PaneNavigation;
  mailActions: ReturnType<typeof useMailActions>;
  composition: ReturnType<typeof useMailCompose>;
  run: ReturnType<typeof useRunMail>;
  profileList: readonly Profile[];
  favorites: ReturnType<typeof numberedFavorites>;
  undoRef: ReturnType<typeof useBatchUndo>["undoRef"];
  openWindow: (id: string) => void;
  threadState: ThreadState | null;
  print: ReturnType<typeof useThreadPrint>;
}) {
  const [dialog, setDialog] = useAtom(dialogAtom);
  const history = useAtomValue(historyAtom);
  const editing = useAtomValue(editingProfileAtom);
  const [goToFolder, setGoToFolder] = useAtom(goToFolderAtom);
  const [snoozeIds, setSnoozeIds] = useAtom(snoozeIdsAtom);
  const filterSeed = useAtomValue(filterSeedAtom);
  const setPickerMode = useAtomSet(pickerModeAtom);
  const setLabelPicker = useAtomSet(labelPickerAtom);
  const {
    deleteRequest,
    selectedId,
    prefs,
    switchSpace,
    changeView,
    view,
    focusList,
    selection,
    setQuery,
    threads,
    setFilters,
    deleteFolder,
    batchRows,
  } = navigation;
  const { deleteKeyPrompt, act, applyDeleteKey, setDeleteKeyPrompt } = mailActions;
  const { compose, startCompose } = composition;
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (
      dialog ||
      compose ||
      editing ||
      goToFolder ||
      snoozeIds ||
      filterSeed ||
      deleteRequest ||
      deleteKeyPrompt ||
      e.defaultPrevented
    )
      return;
    if (e.target instanceof Element && e.target.closest('[role="menu"],[role="dialog"]')) return;
    const typing = isTypingTarget(e.target);
    if (
      !typing &&
      selectedId &&
      isDesktop() &&
      (e.metaKey || e.ctrlKey) &&
      !e.altKey &&
      !e.shiftKey &&
      e.key.toLowerCase() === "c" &&
      !window.getSelection()?.toString() &&
      e.target instanceof Element &&
      e.target.closest('[role="listbox"]')
    ) {
      e.preventDefault();
      run(
        withMail((call) =>
          call("CopyMessageLink", {
            id: selectedId,
            kind: prefs.threadGrouping ? "thread" : "message",
          }),
        ),
      );
      return;
    }
    const spaceKey = !typing ? spaceShortcut(e, prefs.shortcutSet) : null;
    if (spaceKey) {
      e.preventDefault();
      const space =
        spaceKey.kind === "overview"
          ? OVERVIEW
          : spaceKey.kind === "all"
            ? ALL
            : profileList[spaceKey.index]?.id;
      if (space) switchSpace(space);
      return;
    }
    const favoriteIndex = favoriteShortcut(e, typing);
    if (favoriteIndex !== null) {
      const favorite = favorites[favoriteIndex];
      if (favorite) {
        e.preventDefault();
        changeView(favoriteView(view, favorite));
        focusList(null);
      }
      return;
    }
    const mailboxKey = folderShortcut(prefs.shortcutSet, e, typing);
    if (mailboxKey) {
      e.preventDefault();
      changeView({
        ...view,
        space: view.space === OVERVIEW ? ALL : view.space,
        mailbox: mailboxKey,
        label: undefined,
      });
      focusList(null);
      return;
    }
    const direction = !typing ? paneShortcut(e) : null;
    if (
      direction &&
      view.space !== OVERVIEW &&
      moveMailPaneFocus(document, direction, selection.focus)
    ) {
      e.preventDefault();
      return;
    }
    if (!panes.shown.list && !typing && isBackKey(e)) {
      e.preventDefault();
      panes.back();
      return;
    }
    // With the list on screen, ⌘[ is the window's Back rather than the narrow reader's.
    const step = typing ? null : historyShortcut(e);
    if (step) {
      e.preventDefault();
      if (step === "back") history.back();
      else history.forward();
      return;
    }
    if (e.key === "Escape") {
      // Checked rows clear before the search; popups and the search field keep Escape.
      if (
        !typing &&
        checkingRows(selection) &&
        selection.focus !== null &&
        !(e.target instanceof Element && e.target.closest('[role="alertdialog"]'))
      ) {
        e.preventDefault();
        navigation.clearChecks();
        return;
      }
      if (
        escapeClearsSearch({
          target: e.target,
          field: searchRef.current,
          readerOpen: panes.shown.reader && selectedId !== null,
        })
      ) {
        setQuery("");
        searchRef.current?.blur();
      }
      return;
    }
    if (!typing && view.space !== OVERVIEW && !threads.loading) {
      const gesture = selectionShortcut(e);
      if (gesture === "all") {
        if (document.activeElement?.closest("iframe,[data-reader-text]")) return;
        e.preventDefault();
        navigation.selectAll(true);
        return;
      }
      if (gesture === "extendNext" || gesture === "extendPrevious") {
        e.preventDefault();
        navigation.move(gesture === "extendNext" ? 1 : -1, true);
        return;
      }
    }
    const action = shortcutAction(prefs.shortcutSet, e, typing);
    if (
      !action ||
      [
        "nextWindow",
        "previousWindow",
        "focusMainWindow",
        "toggleFullScreen",
        "nextTab",
        "previousTab",
      ].includes(action)
    )
      return;
    if (
      view.space === OVERVIEW &&
      ![
        "compose",
        "newWindow",
        "settings",
        "help",
        "search",
        "sync",
        "toggleSidebar",
        "toggleReadingPane",
        "toggleToolbar",
        "toggleReader",
      ].includes(action)
    )
      return;
    e.preventDefault();
    switch (action) {
      case "compose":
        startCompose("new");
        break;
      case "newWindow":
        if (isDesktop()) run(withMail((call) => call("NewWindow", undefined)));
        break;
      case "settings":
        setDialog("settings");
        break;
      case "help":
        setDialog("help");
        break;
      case "search":
        if (panes.shown.list) searchRef.current?.focus();
        else {
          // A narrow window searches from the list.
          panes.back();
          requestAnimationFrame(() => searchRef.current?.focus());
        }
        break;
      case "sync":
        run(syncNow);
        break;
      case "undo":
        undoRef.current?.();
        break;
      case "goToFolder":
        setGoToFolder(true);
        break;
      case "filterUnread":
        setFilters((f) => ({ ...f, enabled: !f.enabled }));
        break;
      case "openThread":
        if (selectedId && view.mailbox !== "drafts" && isDesktop()) openWindow(selectedId);
        break;
      case "print":
        if (selectedId && threadState && isDesktop())
          print(selectedId, false, prefs.threadGrouping ? undefined : selectedId);
        break;
      case "archive":
        act({ kind: "archive" });
        break;
      case "trash": {
        if (!usesDeletePreference(e) || deleteFolder) {
          applyDeleteKey("trash");
          break;
        }
        if (prefs.deleteKeyAction === "ask") {
          setDeleteKeyPrompt(true);
          break;
        }
        applyDeleteKey(prefs.deleteKeyAction);
        break;
      }
      case "toggleToolbar":
      case "toggleReader":
        run(
          withMail((call) =>
            call("SetPrefs", {
              patch:
                action === "toggleToolbar"
                  ? { toolbarVisible: !prefs.toolbarVisible }
                  : { readingPaneVisible: !prefs.readingPaneVisible },
            }),
          ).pipe(Reactivity.mutation([Keys.prefs])),
        );
        break;
      case "toggleReadingPane":
        run(
          withMail((call) =>
            call("SetPrefs", {
              patch: {
                readingPanePosition: prefs.readingPanePosition === "right" ? "bottom" : "right",
              },
            }),
          ).pipe(Reactivity.mutation([Keys.prefs])),
        );
        break;
      case "toggleSidebar":
        panes.toggleSidebar();
        break;
      case "spam":
        act({ kind: "spam" });
        break;
      case "inbox":
        act({ kind: "inbox" });
        break;
      case "read":
        if (batchRows.length) act({ kind: "read", value: batchRows.some((row) => row.isUnread) });
        break;
      case "markRead":
      case "markUnread":
        if (batchRows.length) act({ kind: "read", value: action === "markRead" });
        break;
      case "select":
        navigation.toggleFocusedRow();
        break;
      case "star":
        if (batchRows.length)
          act({ kind: "star", value: !batchRows.every((row) => row.isStarred) });
        break;
      case "important":
        if (threadState && threadState.provider !== "imap")
          act({ kind: "important", value: !threadState.isImportant });
        break;
      case "reply":
        startCompose("reply");
        break;
      case "replyAll":
        startCompose("replyAll");
        break;
      case "forward":
        startCompose("forward");
        break;
      case "forwardAttachment":
        startCompose("forward", true);
        break;
      case "snooze":
        if (batchRows.length) setSnoozeIds(batchRows.map((row) => row.id));
        break;
      case "label":
      case "move":
        if (batchRows.length) {
          setPickerMode(action);
          setLabelPicker(true);
        }
        break;
      case "next":
      case "previous": {
        const by = action === "next" ? 1 : -1;
        // Gmail's J and K move a cursor over checked rows; the arrows still select.
        if (!e.key.startsWith("Arrow") && checkingRows(selection)) navigation.moveListCursor(by);
        else navigation.move(by);
        break;
      }
      case "nextWindow":
      case "previousWindow":
      case "focusMainWindow":
      case "findNext":
      case "findPrevious":
      case "findSelection":
      case "jumpSelection":
      case "fontSizeIncrease":
      case "fontSizeDecrease":
      case "toggleFullScreen":
      case "nextTab":
      case "previousTab":
      case "bold":
      case "italic":
      case "underline":
      case "link":
      case "strikethrough":
      case "pasteMatchStyle":
      case "pasteQuotation":
      // Composer and Reader own these actions.
      case "templates":
      case "sendArchive":
      case "attach":
      case "saveDraft":
      case "showCc":
      case "closeCompose":
      case "zoomIn":
      case "zoomOut":
      case "zoomReset":
      case "expandAll":
      case "collapseAll":
      case "saveMessage":
      case "searchSender":
      case "openMessageWeb":
      case "send":
      // AiPanel and ComposerAi own these.
      case "assistant":
      case "composeAssistant":
        break;
    }
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  return {};
}
