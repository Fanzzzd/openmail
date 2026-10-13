import { requestFocusedPermission } from "../lib/focused-inbox";
import { useLingui } from "@lingui/react/macro";
import { type DeleteFolder, type Prefs } from "@openmail/core/schema";
import { Cause, Effect, Option } from "effect";
import { Reactivity } from "effect/reactivity";
import { useState } from "react";
import type { Account, Label, MailOp, ThreadSummary } from "../../../shared/api";
import type { AppMessages } from "./use-app-messages";
import type { ThreadState } from "../lib/focused-inbox";
import { type ToastState } from "../ui/Toast";
import { deleteKeyOp } from "../lib/delete-key";
import { causeText } from "../lib/errors";
import { leavesList } from "../state/batch";
import { MAIL_KEYS } from "../state/keys";
import { pageAfterRemoval } from "../state/list-pages";
import { modifyWithUndo, reauthAccount, useRunMail, withMail } from "../state/mail";
import {
  batchScope,
  EMPTY_SELECTION,
  requiresBatchDeleteConfirmation,
  selectionAfterRemoval,
  singleSelection,
} from "../lib/selection";
import { useBatchUndo } from "../state/undo";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { snoozeIdsAtom } from "../features/organize/organize-state";
import { dialogAtom, signInAgainAtom } from "../state/ui";
import type { useMailSelection } from "./use-mail-selection";
export function useMailActions({
  navigation,
  accountList,
  labels,
  run,
  say,
  showUndo,
  selectedAccount,
  messages,
}: {
  messages: AppMessages;
  navigation: ReturnType<typeof useMailSelection>;
  accountList: readonly Account[];
  labels: readonly Label[];
  run: ReturnType<typeof useRunMail>;
  say: (next: Omit<ToastState, "id">) => void;
  showUndo: ReturnType<typeof useBatchUndo>["showUndo"];
  selectedAccount: Account | undefined;
}) {
  const setDialog = useAtomSet(dialogAtom);
  const setSignInAgain = useAtomSet(signInAgainAtom);
  const [snoozeIds, setSnoozeIds] = useAtom(snoozeIdsAtom);
  const {
    deleteFolder,
    prefs,
    selection,
    rowMap,
    threads,
    setDeleteRequest,
    scopeKey,
    listQuery,
    list,
    setReadTarget,
    applyActionSelection,
    restoreActionSelection,
    view,
    batchRows,
  } = navigation;
  const { i18n } = useLingui();
  const [deleteKeyPrompt, setDeleteKeyPrompt] = useState(false);
  const [permanentRequest, setPermanentRequest] = useState<{
    ids: readonly string[];
    flat: boolean;
    folder: DeleteFolder;
  } | null>(null);
  const requestPermanentDelete = (ids: readonly string[]) => {
    if (deleteFolder)
      setPermanentRequest({ ids: [...ids], flat: !prefs.threadGrouping, folder: deleteFolder });
  };
  const [permissionAccount, setPermissionAccount] = useState<string | null>(null);

  /** A list row's state, for its context menu; the list already has what the menu needs. */
  const rowState = (m: ThreadSummary): ThreadState | null => {
    const account = accountList.find((a) => a.id === m.accountId);
    if (!account) return null;
    return {
      provider: account.provider,
      focusedSender: { messageId: m.id, address: m.from.address },
      isUnread: m.isUnread,
      isStarred: m.isStarred,
      isImportant: m.labels.includes("IMPORTANT"),
      labels: [...m.labels],
    };
  };

  /** The selected IDs are captured once; core records exact per-message undo. */
  const act = (
    op: MailOp,
    opts: { quiet?: boolean; accountId?: string; confirmedIds?: ReadonlySet<string> } = {},
    target?: { id: string; state: ThreadState },
  ) => {
    const selectionScope = opts.confirmedIds ? { ...selection, ids: opts.confirmedIds } : selection;
    const {
      rows,
      ids: targets,
      count,
    } = batchScope(selectionScope, rowMap, target?.id, opts.accountId);
    if (!targets.length || threads.loading) return;
    if (op.kind === "trash" && requiresBatchDeleteConfirmation(count) && !opts.confirmedIds) {
      setDeleteRequest({ ids: new Set(targets), scopeKey });
      return;
    }
    const before = selection;
    const actionScopeKey = scopeKey;
    const targetSet = new Set(targets);
    const removed = new Set(
      rows
        .filter((row) => {
          if (!targetSet.has(row.id)) return false;
          const state = rowState(row);
          if (!state) return false;
          return listQuery ? leavesList(row, op, state.provider, listQuery, labels) : false;
        })
        .map((row) => row.id),
    );
    const next = removed.size
      ? selectionAfterRemoval(
          before,
          list.map((row) => row.id),
          removed,
          prefs.nextSelection,
        )
      : before;
    const nextPaged = removed.size
      ? selectionAfterRemoval(
          before,
          list.map((row) => row.id),
          removed,
          prefs.nextSelection,
          threads.canLoadMore,
        )
      : before;
    const lastLoaded = list.at(-1);
    const needsPage =
      nextPaged === EMPTY_SELECTION &&
      before.ids.size > 0 &&
      [...before.ids].every((id) => removed.has(id)) &&
      threads.canLoadMore &&
      prefs.nextSelection === "below" &&
      lastLoaded &&
      listQuery;
    if (needsPage) navigation.beginRemoval(before, next, actionScopeKey);
    setReadTarget(null);
    run(
      modifyWithUndo(
        targets,
        op,
        op.kind === "classification" ? false : !prefs.threadGrouping,
      ).pipe(
        Effect.tap(() =>
          needsPage
            ? pageAfterRemoval(listQuery, lastLoaded, (nextQuery) =>
                withMail((call) => call("Threads", { query: nextQuery })),
              ).pipe(
                Effect.matchCause({
                  onSuccess: (page) =>
                    navigation.settleRemoval(
                      before,
                      actionScopeKey,
                      page[0] ? singleSelection(page[0].id) : next,
                    ),
                  onFailure: () => {
                    navigation.settleRemoval(before, actionScopeKey, next);
                    say({ text: messages.couldNotLoadTheNextMessage, tone: "error" });
                  },
                }),
              )
            : Effect.void,
        ),
        Effect.matchCause({
          onFailure: (cause) => {
            navigation.cancelRemoval(before);
            if (requestFocusedPermission(cause)) return;
            const reason = causeText(i18n, cause);
            say({ text: messages.actionFailed(reason), tone: "error" });
          },
          onSuccess: (result) => {
            if (!needsPage) applyActionSelection(before, next, actionScopeKey);
            if (opts.quiet) return;
            showUndo(result, targets, messages.opDone(op), () => {
              restoreActionSelection(before, actionScopeKey, rows);
            });
          },
        }),
      ),
    );
  };

  const applyDeleteKey = (action: Exclude<Prefs["deleteKeyAction"], "ask">) => {
    const { op, fallback } = deleteKeyOp(action, {
      mailbox: view.mailbox,
      ...(view.label ? { currentLabel: view.label.id } : {}),
      ...(selectedAccount ? { provider: selectedAccount.provider } : {}),
    });
    if (fallback) say({ text: messages.noCurrentLabelAppliesMovingToTrash });
    if (op.kind === "trash" && deleteFolder) requestPermanentDelete(batchRows.map((row) => row.id));
    else act(op, fallback ? { quiet: true } : {});
  };

  const reauth = (account: Account) => {
    if (account.provider === "imap") {
      setSignInAgain(account.id);
      setDialog("add");
      return;
    }
    say({ text: messages.finishSigningInInYourBrowser, duration: 60_000 });
    run(
      reauthAccount(account.id).pipe(
        Effect.matchCause({
          onSuccess: () => {
            const email = account.email;
            say({ text: messages.isSignedInAgain(email) });
          },
          onFailure: (cause) => {
            const reason = causeText(i18n, cause);
            say({ text: messages.signInFailed(reason), tone: "error" });
          },
        }),
      ),
    );
  };

  const startSnooze = () => {
    const ids = snoozeIds ?? [];
    const before = selection;
    const actionScope = scopeKey;
    const rows = list;
    const next = selectionAfterRemoval(
      before,
      rows.map((row) => row.id),
      new Set(ids),
      prefs.nextSelection,
    );
    navigation.beginRemoval(before, next, actionScope);
    return (result: Parameters<typeof showUndo>[0] | null) => {
      if (!result) {
        navigation.cancelRemoval(before);
        return;
      }
      navigation.settleRemoval(before, actionScope, next);
      showUndo(result, ids, messages.snoozed, () =>
        restoreActionSelection(before, actionScope, rows),
      );
      setSnoozeIds(null);
    };
  };

  const confirmPermanentDelete = () => {
    const request = permanentRequest;
    if (!request) return;
    setPermanentRequest(null);
    run(
      withMail((call) =>
        call("PermanentlyDelete", {
          threads: request.ids,
          flat: request.flat,
          folder: request.folder,
          confirmed: true,
        }),
      ).pipe(
        Reactivity.mutation(MAIL_KEYS),
        Effect.matchCause({
          onSuccess: (count) => {
            say({ text: messages.permanentlyDeletedMessages(count) });
            navigation.setSelectedId(null);
          },
          onFailure: (cause) => {
            const error = Cause.findErrorOption(cause);
            if (
              Option.isSome(error) &&
              error.value._tag === "FeatureScopeMissing" &&
              error.value.feature === "permanentDelete"
            ) {
              setPermissionAccount(error.value.accountId);
              return;
            }
            const reason = causeText(i18n, cause);
            say({ text: messages.couldntDelete(reason), tone: "error" });
          },
        }),
      ),
    );
  };

  return {
    reauth,
    startSnooze,
    confirmPermanentDelete,
    actionDone: (result: Parameters<typeof showUndo>[0], ids: readonly string[], op: MailOp) =>
      showUndo(result, ids, messages.opDone(op)),
    deleteKeyPrompt,
    setDeleteKeyPrompt,
    permanentRequest,
    setPermanentRequest,
    permissionAccount,
    setPermissionAccount,
    requestPermanentDelete,
    rowState,
    act,
    applyDeleteKey,
  };
}
