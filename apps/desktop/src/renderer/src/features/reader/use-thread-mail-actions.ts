import { useLingui } from "@lingui/react/macro";
import { useAtomValue } from "@effect/atom-react";
import { senderSearchQuery, type BatchResult, providerCapabilities } from "@openmail/core/schema";
import { Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { MailOp, Message } from "../../../../shared/api";
import { causeText } from "../../lib/errors";
import { isDesktop } from "../../lib/platform";
import { emitLocalDesktopEvent } from "../../state/desktop";
import { markUnreadFrom, modifyMessages, useRunMail, withMail } from "../../state/mail";
import { accountsAtom } from "../../state/queries";
import { MailClient } from "../../state/rpc";
import type { Notify } from "./notify";

export type ReaderActionDone = (action: {
  result: BatchResult;
  ids: readonly string[];
  op: MailOp;
}) => void;

/** The thread view's per-message mail commands, each reporting failures through `notify`. */
export function useThreadMailActions({
  accountId,
  notify,
  onMarkUnread,
  onActionDone,
}: {
  accountId: string | undefined;
  notify: Notify;
  onMarkUnread?: (() => void) | undefined;
  onActionDone?: ReaderActionDone | undefined;
}) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const messageAction = (id: string, op: Parameters<typeof modifyMessages>[1]) => {
    if (op.kind === "read" && !op.value) onMarkUnread?.();
    return run(
      modifyMessages([id], op).pipe(
        Effect.tap((result) => Effect.sync(() => onActionDone?.({ result, ids: [id], op }))),
        Effect.catchCause((cause) =>
          Effect.sync(() => notify({ text: causeText(i18n, cause), tone: "error" })),
        ),
      ),
    );
  };
  const unreadFrom = (id: string) => {
    onMarkUnread?.();
    return run(
      markUnreadFrom(id).pipe(
        Effect.tap((result) =>
          Effect.sync(() =>
            onActionDone?.({ result, ids: [id], op: { kind: "read", value: false } }),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => notify({ text: causeText(i18n, cause), tone: "error" })),
        ),
      ),
    );
  };
  const accounts = AsyncResult.getOrElse(useAtomValue(accountsAtom), () => []);
  const provider = accounts.find((account) => account.id === accountId)?.provider;
  const webLabel = provider === "gmail" ? t`Open in Gmail` : t`Open in Outlook`;
  const canShare = AsyncResult.getOrElse(
    useAtomValue(MailClient.query("AttachmentCapabilities", undefined)),
    () => ({ share: false }),
  ).share;
  const shareLink = (id: string, kind: "message" | "thread" | "web") =>
    run(
      withMail((call) => call("ShareMessageLink", { id, kind })).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => notify({ text: causeText(i18n, cause), tone: "error" })),
        ),
      ),
    );
  const canOpenWeb = provider ? providerCapabilities(provider).webLink : false;
  const searchSender = (m: Message) =>
    isDesktop()
      ? run(withMail((call) => call("SearchSender", { address: m.from.address })))
      : emitLocalDesktopEvent({ _tag: "Search", query: senderSearchQuery(m.from.address) });
  const openWeb = (id: string) =>
    run(
      withMail((call) => call("OpenMessageWeb", { id })).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => notify({ text: causeText(i18n, cause), tone: "error" })),
        ),
      ),
    );
  return {
    messageAction,
    unreadFrom,
    webLabel,
    canShare,
    shareLink,
    canOpenWeb,
    searchSender,
    openWeb,
  };
}
