import { Clock, Effect, Option } from "effect";
import type { Account } from "../domain/account.js";
import type { MailOp } from "../domain/changes.js";
import type { ProviderError } from "../domain/errors.js";
import { decodeProviderId } from "../providers/imap/imap-cursor.js";
import { applyOpToLabels } from "../domain/mail-ops.js";
import type { makeBatchMailbox } from "./mailbox-batch.js";
import type { makeOrganizationMailbox } from "./mailbox-organization.js";
import type { MailboxDependencies } from "./mailbox-runtime.js";
import { withPendingOps } from "./mailbox-shared.js";
import { sha256Hex } from "../platform/crypto.js";
import type { Change } from "../providers/adapter.js";
import { notificationEligible, profileNotificationsActive } from "../app/system.js";
import { providerCapabilities } from "../providers/capabilities.js";

/**
 * A message's date comes from the server's clock and last_synced_at from ours.
 * New mail dated up to this much before the last pull started still notifies;
 * seen_incoming keeps a message from notifying twice.
 */
const NOTIFY_CLOCK_SKEW_MS = 2 * 60_000;

/**
 * Applies a page of provider changes to the store during a pull: new and updated messages,
 * deletions, remapped ids, pending local ops replayed on top, and new-mail notifications.
 */
export const makeApplyChanges = (
  deps: MailboxDependencies & {
    batchMailbox: () => Effect.Success<ReturnType<typeof makeBatchMailbox>>;
    organization: () => Pick<ReturnType<typeof makeOrganizationMailbox>, "wakeOnReply">;
  },
) => {
  const { store, providers, emit } = deps;

  const applyChanges = (
    account: Account,
    counts: { changed: number; deleted: number },
    notificationsReady: boolean,
    pullStartedAt: number,
    scope?: "inbox",
  ) => {
    const remapped = new Set<string>();
    return Effect.fnUntraced(function* (batch: readonly Change[]) {
      account = yield* store.getAccount(account.id).pipe(Effect.orDie);
      if (account.enabled === false) return;
      const prefs = yield* store.prefs;
      const now = new Date(yield* Clock.currentTimeMillis);
      const writes: Effect.Effect<void, ProviderError>[] = [];
      const newIds: string[] = [];
      const repliedThreads = new Set<string>();
      const pendingById = new Map<string, MailOp[]>();
      const deletingDrafts = new Set<string>();
      for (const change of batch) {
        // Polling only discovers arrivals/flags; full sync reconciles moves and resets.
        if (
          scope &&
          ["Delete", "DeleteLabel", "Reset", "Labels", "VerifyCandidates"].includes(change._tag)
        )
          continue;
        switch (change._tag) {
          case "FetchLater":
            writes.push(
              store
                .enqueueOp(account.id, change.providerId, { kind: "reconcile" })
                .pipe(Effect.asVoid),
            );
            break;
          case "Remap":
          case "Upsert":
            counts.changed++;
            writes.push(
              Effect.gen(function* () {
                if (deletingDrafts.has(change.message.providerId)) return;
                if (
                  change._tag === "Remap" &&
                  change.message.rfcMessageId &&
                  !(yield* store.messageIdForProvider(account.id, change.message.providerId))
                ) {
                  const local = yield* store.findMessageByRfcId(
                    account.id,
                    change.message.rfcMessageId,
                    change.previous,
                  );
                  if (local && !remapped.has(local)) {
                    remapped.add(local);
                    const ref = yield* store.messageRef(local).pipe(Effect.orDie);
                    yield* store.remapProviderIds(account.id, [
                      { from: ref.providerId, to: change.message.providerId },
                    ]);
                  }
                }
                const existingId = yield* store.messageIdForProvider(
                  account.id,
                  change.message.providerId,
                );
                const id = existingId ?? `${account.id}/${change.message.providerId}`;
                const known = existingId !== null;
                // IMAP moves assign a new folder/UID while preserving the mail itself.
                const identity = providerCapabilities(account.provider).moveChangesId
                  ? sha256Hex(
                      JSON.stringify([
                        change.message.threadId,
                        change.message.date,
                        change.message.from.address,
                        change.message.subject,
                        change.message.bodyText,
                      ]),
                    )
                  : change.message.providerId;
                const first = yield* store.observeIncoming(account.id, identity);
                const remappedOps =
                  change._tag === "Remap"
                    ? (yield* store.pendingOpsForMessages(account.id, [
                        change.message.providerId,
                      ])).flatMap((pending) =>
                        pending.op.kind === "saveDraft" ||
                        pending.op.kind === "deleteDraft" ||
                        pending.op.kind === "reconcile"
                          ? []
                          : [pending.op],
                      )
                    : (pendingById.get(change.message.providerId) ?? []);
                const incoming = withPendingOps(change.message, remappedOps, account.provider);
                yield* store.upsertMessage(account.id, incoming);
                const storedId =
                  (yield* store.messageIdForProvider(account.id, incoming.providerId)) ?? id;
                const arrived =
                  first &&
                  !known &&
                  notificationsReady &&
                  change.message.date >= (account.lastSyncedAt ?? 0) - NOTIFY_CLOCK_SKEW_MS &&
                  change.message.labels.includes("INBOX");
                if (
                  arrived &&
                  !change.message.labels.some((l) => ["DRAFT", "SENT", "SPAM", "TRASH"].includes(l))
                )
                  repliedThreads.add(incoming.threadId);
                if (arrived && change.message.isUnread) {
                  const message = {
                    ...change.message,
                    id: storedId,
                    accountId: account.id,
                    hasAttachments: change.message.attachments.length > 0,
                  };
                  if (notificationEligible(account, message, prefs))
                    yield* store.enqueueNotification(
                      storedId,
                      !profileNotificationsActive(account, prefs, now),
                    );
                  newIds.push(storedId);
                }
              }),
            );
            // Gmail keeps the message id when a draft is sent elsewhere; it only loses DRAFT.
            if (!change.message.labels.includes("DRAFT")) {
              writes.push(store.dropSyncedDrafts(account.id, change.message.providerId));
            }
            break;
          case "Delete":
            counts.deleted++;
            writes.push(
              store.deleteMessage(account.id, change.providerId),
              // A draft deleted or sent in another client goes here too.
              store.dropSyncedDrafts(account.id, change.providerId),
            );
            break;
          case "MessageLabels":
            counts.changed++;
            if (!change.labels.includes("DRAFT"))
              writes.push(store.dropSyncedDrafts(account.id, change.providerId));
            if (!(yield* store.messageIdForProvider(account.id, change.providerId))) {
              const fetched = yield* providers
                .get(account.provider)
                .fetchMessage(account, change.providerId)
                .pipe(
                  Effect.map(Option.some),
                  Effect.catchTag("PermanentError", () => Effect.succeed(Option.none())),
                );
              if (Option.isSome(fetched))
                writes.push(
                  Effect.gen(function* () {
                    yield* store.upsertMessage(
                      account.id,
                      withPendingOps(
                        fetched.value,
                        pendingById.get(change.providerId) ?? [],
                        account.provider,
                      ),
                    );
                  }),
                );
              break;
            }
            writes.push(
              Effect.gen(function* () {
                const id = yield* store.messageIdForProvider(account.id, change.providerId);
                if (!id) return;
                const message = yield* store.getMessage(id).pipe(Effect.orDie);
                yield* store.upsertMessage(
                  account.id,
                  withPendingOps(
                    {
                      ...message,
                      providerId: change.providerId,
                      labels: [...change.labels],
                      isUnread: change.labels.includes("UNREAD"),
                      isStarred: change.labels.includes("STARRED"),
                    },
                    pendingById.get(change.providerId) ?? [],
                    account.provider,
                  ),
                );
              }),
            );
            break;
          case "Flags":
            counts.changed++;
            writes.push(
              Effect.gen(function* () {
                const id = yield* store.messageIdForProvider(account.id, change.providerId);
                if (!id) return;
                const cached = yield* store.getMessage(id).pipe(Effect.option);
                if (Option.isNone(cached)) return;
                const message = cached.value;
                const labels = applyOpToLabels(
                  applyOpToLabels(
                    message.labels.filter((label) => label !== "SNOOZED"),
                    { kind: "read", value: !change.isUnread },
                    account.provider,
                  ),
                  { kind: "star", value: change.isStarred },
                  account.provider,
                );
                yield* store.upsertMessage(
                  account.id,
                  withPendingOps(
                    {
                      ...message,
                      providerId: change.providerId,
                      labels,
                      isUnread: change.isUnread,
                      isStarred: change.isStarred,
                    },
                    pendingById.get(change.providerId) ?? [],
                    account.provider,
                  ),
                );
              }),
            );
            break;
          case "InvalidateFolder":
            writes.push(
              store.invalidateImapFolder(account.id, change.previous).pipe(
                Effect.tap(deps.batchMailbox().forgetMessages),
                Effect.asVoid,
                Effect.tap(() =>
                  Effect.sync(() => {
                    for (const id of pendingById.keys()) {
                      const ref = decodeProviderId(id);
                      if (
                        Option.isSome(ref) &&
                        ref.value.path === change.previous.path &&
                        ref.value.uidValidity === change.previous.uidValidity
                      )
                        pendingById.delete(id);
                    }
                  }),
                ),
              ),
            );
            break;
          case "VerifyCandidates":
          case "RebuildFolder":
          case "DeleteLabel":
          case "Reset":
            break; // Verification and reset barriers run outside the write transaction.
          case "BackfillReset":
            writes.push(store.resetBackfill(account.id));
            break;
          case "Labels":
            writes.push(store.replaceLabels(account.id, change.labels));
            break;
          case "Cursor":
            // A full sync covers the inbox too, so it renews the inbox cursor. Without this a
            // phone's inbox-only background polls would keep an expired Gmail history id or
            // Graph delta link after a foreground sync. A poll that ran meanwhile may have a
            // newer one; starting from the older cursor only fetches some changes again.
            writes.push(
              change.checkpoint
                ? scope
                  ? Effect.void
                  : store.saveSyncCursor(account.id, change.cursor, false)
                : scope
                  ? store.saveInboxCursor(account.id, change.cursor)
                  : store
                      .saveSyncCursor(account.id, change.cursor, true, pullStartedAt)
                      .pipe(Effect.andThen(store.saveInboxCursor(account.id, change.cursor))),
            );
            break;
          case "Progress":
            if (scope) break;
            writes.push(
              emit({
                _tag: "SyncProgress",
                progress: {
                  accountId: account.id,
                  fetched: change.fetched,
                  total: change.total,
                },
              }).pipe(Effect.asVoid),
            );
            break;
        }
      }
      // Changes apply in order, so a Cursor inside the batch is saved only
      // together with everything before it.
      yield* store.transaction(
        Effect.gen(function* () {
          const ids = [
            ...new Set(
              batch.flatMap((change) =>
                change._tag === "Upsert" || change._tag === "Remap"
                  ? [change.message.providerId]
                  : change._tag === "Flags" || change._tag === "MessageLabels"
                    ? [change.providerId]
                    : [],
              ),
            ),
          ];
          for (const pending of yield* store.pendingOpsForMessages(account.id, ids)) {
            if (pending.op.kind === "deleteDraft") deletingDrafts.add(pending.providerId);
            if (
              pending.op.kind === "saveDraft" ||
              pending.op.kind === "deleteDraft" ||
              pending.op.kind === "reconcile"
            )
              continue;
            const ops = pendingById.get(pending.providerId) ?? [];
            ops.push(pending.op);
            pendingById.set(pending.providerId, ops);
          }
          yield* Effect.all(writes, { discard: true });
        }),
      );
      if (repliedThreads.size)
        yield* deps.organization().wakeOnReply(account.id, [...repliedThreads]);
      if (newIds.length) yield* emit({ _tag: "NewMail", accountId: account.id, ids: newIds });
    });
  };
  return applyChanges;
};
