import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import type { DockFileReason } from "../../../shared/dock-files";
import { nativeShareKind } from "../../../shared/native-actions";
import { causeText } from "../lib/errors";
import { isTypingTarget } from "../lib/typing-target";
import { useLingui } from "@lingui/react/macro";
import { attachmentProblem } from "@openmail/core/schema";
import { Effect } from "effect";
import { constVoid } from "effect/Function";
import { type RefObject, useEffect, useEffectEvent, useState } from "react";
import type { Account } from "../../../shared/api";
import { desktopEventRoute, editCommandRoute, type DesktopEvent } from "../../../shared/desktop";
import type { AppMessages } from "./App";
import { attachmentProblemMessage } from "../lib/attachment-problem-message";
import type { ThreadState } from "../lib/focused-inbox";
import type { ToastState } from "../ui/Toast";
import { loadDrafts } from "../features/compose/draft-loader";
import { dispatchNativeAction } from "./native-actions";
import { useDesktopEvents } from "../state/desktop";
import { saveDraft, useRunMail, withMail } from "../state/mail";
import { useBatchUndo } from "../state/undo";
import { ALL, OVERVIEW } from "../lib/view";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { editingProfileAtom } from "../features/accounts/profile-editing";
import { labelCreationAtom, snoozeIdsAtom } from "../features/organize/organize-state";
import { filterSeedAtom } from "../features/settings/filter-seed";
import { goToFolderAtom } from "../features/sidebar/go-to-folder";
import { dialogAtom } from "../state/ui";
import type { useMailCompose } from "./use-mail-compose";
import type { useMailSelection } from "./use-mail-selection";
export function useNativeMenuBridge({
  searchRef,
  navigation,
  composition,
  run,
  threadState,
  say,
  accountList,
  undoRef,
  messages,
}: {
  messages: AppMessages;
  searchRef: RefObject<HTMLInputElement | null>;
  navigation: ReturnType<typeof useMailSelection>;
  composition: ReturnType<typeof useMailCompose>;
  run: ReturnType<typeof useRunMail>;
  threadState: ThreadState | null;
  say: (next: Omit<ToastState, "id">) => void;
  accountList: readonly Account[];
  undoRef: ReturnType<typeof useBatchUndo>["undoRef"];
}) {
  const [dialog, setDialog] = useAtom(dialogAtom);
  const editing = useAtomValue(editingProfileAtom);
  const goToFolder = useAtomValue(goToFolderAtom);
  const snoozeIds = useAtomValue(snoozeIdsAtom);
  const filterSeed = useAtomValue(filterSeedAtom);
  const labelCreation = useAtomValue(labelCreationAtom);
  const { selectedId, prefs, changeView, setQuery, view, threads, setSearchScope } = navigation;
  const {
    compose,
    startCompose,
    newMessageDraft,
    setPopOutRequested,
    setCloseRequested,
    hasPendingSends,
    reportSendState,
    undoSend,
    startNewMessage,
    setCrashFeedback,
  } = composition;
  const { i18n } = useLingui();
  const [desktopEvents, setDesktopEvents] = useState<readonly DesktopEvent[]>([]);

  const provider = threadState?.provider;
  useEffect(() => {
    run(
      withMail((call) =>
        call("SetNativeMenuState", {
          state: {
            selected: Boolean(selectedId) && !dialog,
            composing: Boolean(compose) && !dialog,
            gmail: provider === "gmail",
            ...(provider ? { web: provider === "gmail" || provider === "outlook" } : {}),
          },
        }),
      ),
    );
  }, [run, selectedId, compose, dialog, provider]);

  const receiveDesktop = (event: DesktopEvent) => {
    setDesktopEvents((events) => events.filter((item) => item !== event));
    switch (event._tag) {
      case "NativeAction": {
        const kind = nativeShareKind(event.action);
        if (kind && selectedId)
          run(
            withMail((call) => call("ShareMessageLink", { id: selectedId, kind })).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => say({ text: causeText(i18n, cause), tone: "error" })),
              ),
            ),
          );
        else dispatchNativeAction(prefs.shortcutSet, event.action, event.triggeredByAccelerator);
        break;
      }
      case "Navigate":
        // Main builds these with shared/routes; openLink still takes only mail routes.
        navigation.openLink(event.href);
        break;
      case "FileError":
        say({ text: i18n._(DOCK_FILE_MESSAGES[event.reason]), tone: "error" });
        break;
      case "ComposeMessage":
        startCompose(event.mode, event.asAttachment, event.id);
        break;
      case "ComposeFiles":
        run(
          newMessageDraft().pipe(
            Effect.flatMap((base) => {
              if (!base) return Effect.void;
              const account = accountList.find((a) => a.id === base.accountId);
              const problem = account
                ? attachmentProblem(account.provider, event.attachments)
                : undefined;
              if (problem) {
                say({ text: attachmentProblemMessage(problem, messages), tone: "error" });
                return Effect.void;
              }
              const draft = { ...base, attachments: event.attachments };
              return loadDrafts.pipe(
                Effect.flatMap(({ toDraftInput }) => saveDraft(toDraftInput(draft))),
                Effect.flatMap((saved) =>
                  withMail((call) => call("OpenComposeWindow", { id: saved.id })),
                ),
              );
            }),
          ),
        );
        break;
      case "AttachFiles":
        window.dispatchEvent(new Event("openmail-attach-files"));
        break;
      case "PopOutDraft":
        if (compose?.id === event.id) setPopOutRequested((n) => n + 1);
        break;
      case "ComposeClose":
        if (compose) setCloseRequested((n) => n + 1);
        else if (!hasPendingSends()) run(withMail((call) => call("CloseComposeWindow", undefined)));
        break;
      case "QuitCheck":
        reportSendState();
        break;
      case "UndoSend":
        undoSend();
        break;
      case "Edit": {
        const busy = Boolean(
          dialog ||
          compose ||
          editing ||
          goToFolder ||
          snoozeIds ||
          filterSeed ||
          view.space === OVERVIEW ||
          threads.loading ||
          document.querySelector('[role="dialog"],[role="alertdialog"]'),
        );
        const typing = isTypingTarget(document.activeElement);
        if (
          editCommandRoute(
            busy,
            typing,
            event.action === "selectAll" &&
              Boolean(document.activeElement?.closest("iframe,[data-reader-text]")),
          ) === "text"
        )
          run(withMail((call) => call("NativeEdit", { action: event.action })));
        else if (event.action === "undo") undoRef.current?.();
        else {
          navigation.selectAll();
        }
        break;
      }
      case "Search":
        changeView({ space: ALL, mailbox: "all" });
        setSearchScope("all");
        setQuery(event.query);
        searchRef.current?.focus();
        break;
      case "Compose":
        startNewMessage(event.draft);
        break;
      case "Command":
        if (event.command === "feedback") {
          setCrashFeedback(false);
          setDialog("feedback");
        }
        if (event.command === "compose") startCompose("new");
        else if (event.command === "inbox") {
          changeView({ space: view.space === OVERVIEW ? ALL : view.space, mailbox: "inbox" });
          setQuery("");
        } else setDialog(event.command === "help" ? "help" : "settings");
        break;
    }
  };
  useDesktopEvents((event) => {
    if (event._tag === "ComposeFiles" && accountList.length) {
      receiveDesktop(event);
      return;
    }
    if (event._tag === "NativeAction") {
      if (
        !dialog &&
        !editing &&
        !goToFolder &&
        !snoozeIds &&
        !filterSeed &&
        !labelCreation &&
        !document.querySelector('[role="dialog"]:not([data-compose]),[role="alertdialog"]')
      )
        receiveDesktop(event);
      return;
    }
    const route = desktopEventRoute(
      event,
      Boolean(
        dialog ||
        compose ||
        editing ||
        goToFolder ||
        snoozeIds ||
        filterSeed ||
        document.querySelector('[role="dialog"],[role="alertdialog"]'),
      ),
    );
    if (route === "dispatch") receiveDesktop(event);
    else if (route === "defer") setDesktopEvents((events) => [...events, event]);
  });
  const receiveLink = useEffectEvent(receiveDesktop);
  useEffect(() => {
    // An incoming link waits while another draft/dialog is being edited.
    if (dialog || compose || editing || goToFolder || snoozeIds || filterSeed || labelCreation)
      return constVoid;
    const event = desktopEvents.find(
      (item) => accountList.length || (item._tag === "Command" && item.command !== "compose"),
    );
    if (!event) return constVoid;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) receiveLink(event);
    });
    return () => {
      cancelled = true;
    };
  }, [
    desktopEvents,
    accountList.length,
    dialog,
    compose,
    editing,
    goToFolder,
    snoozeIds,
    labelCreation,
    filterSeed,
  ]);

  return {};
}

const DOCK_FILE_MESSAGES: Record<DockFileReason, MessageDescriptor> = {
  tooMany: msg`Too many attachments. Attach up to 256 files.`,
  notFile: msg`Only regular files can be attached. Folders cannot be attached.`,
  tooLarge: msg`Attachments exceed the 30 MB compose limit.`,
  changed: msg`An attachment changed while reading. Try adding it again.`,
  unreadable: msg`Could not read the attachments. Check the files and their permissions.`,
};
