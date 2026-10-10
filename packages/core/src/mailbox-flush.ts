import { Clock, Effect, FiberSet, Option, Schema } from "effect";
import { type Account } from "./domain.js";
import { type ProviderFailure } from "./errors.js";
import { decodeProviderId, readCursor } from "./imap-cursor.js";
import { type MailboxDependencies, type MailboxRuntimeState } from "./mailbox-runtime.js";
import { withPendingOps } from "./mailbox-shared.js";
import { READ_ONLY_MESSAGE } from "./read-only.js";
import { type PendingOp, type ProviderPushContext, type ProviderPushResult } from "./services.js";

class PendingOpClaimLost extends Schema.TaggedError<PendingOpClaimLost>()("PendingOpClaimLost", {
  message: Schema.String,
}) {}

/** Only a week-old mutation can expire; reconciliation waits for connectivity. */
const MAX_OP_AGE = 7 * 86_400_000;

export const makeFlushMailbox = (
  deps: MailboxDependencies & {
    pushDraft: (
      account: Account,
      draftId: string,
      claim?: { readonly id: number; readonly token: string },
      context?: ProviderPushContext,
    ) => Effect.Effect<void, ProviderFailure>;
  },
  runtime: MailboxRuntimeState,
) => {
  const { options, providers, store, pushDraft, readOnly, crypto, imapPullLock, changed } = deps;

  const refreshMessage = (account: Account, providerId: string) =>
    providers
      .get(account.provider)
      .fetchMessage(account, providerId)
      .pipe(
        Effect.flatMap((message) =>
          Effect.gen(function* () {
            const pending = (yield* store.pendingOpsForMessages(account.id, [providerId])).flatMap(
              (item) =>
                item.op.kind === "saveDraft" ||
                item.op.kind === "deleteDraft" ||
                item.op.kind === "reconcile"
                  ? []
                  : [item.op],
            );
            yield* store.upsertMessage(
              account.id,
              withPendingOps(message, pending, account.provider),
            );
          }),
        ),
        Effect.catchTag("PermanentError", () => store.deleteMessage(account.id, providerId)),
      );

  const imapPushCursor = (account: Account): Effect.Effect<string | undefined> =>
    account.provider === "imap"
      ? Effect.gen(function* () {
          const full = readCursor(yield* store.getSyncCursor(account.id));
          const inbox = readCursor(yield* store.getInboxCursor(account.id));
          return JSON.stringify({ folders: { ...full.folders, ...inbox.folders } });
        })
      : Effect.succeed(undefined);

  const pushContext = (items: readonly PendingOp[], token: string): ProviderPushContext => ({
    messageIds: new Map(
      items.flatMap((item) => (item.rfcMessageId ? [[item.providerId, item.rfcMessageId]] : [])),
    ),
    progress: new Set(items.flatMap((item) => item.progress)),
    ...(items[0]?.appendedMessageId ? { appendedDraftMessageId: items[0].appendedMessageId } : {}),
    beforeCopy: (destination, ids) =>
      store.transaction(
        Effect.forEach(
          items.filter((item) => ids.includes(item.providerId)),
          (item) =>
            store.recordCopyProgress(item.id, token, destination, item.providerId, "issued"),
          { discard: true },
        ),
      ),
    afterCopy: (destination, ids) =>
      store.transaction(
        Effect.forEach(
          items.filter((item) => ids.includes(item.providerId)),
          (item) =>
            store.recordCopyProgress(item.id, token, destination, item.providerId, "accepted"),
          { discard: true },
        ),
      ),
    clearCopy: (destination, ids) =>
      store.transaction(
        Effect.forEach(
          items.filter((item) => ids.includes(item.providerId)),
          (item) => store.recordCopyProgress(item.id, token, destination, item.providerId, "clear"),
          { discard: true },
        ),
      ),
    beforeAppendDraft: (messageId) =>
      Effect.forEach(items, (item) => store.recordAppendedMessageId(item.id, token, messageId), {
        discard: true,
      }),
  });

  const pushOp = (account: Account, pending: PendingOp, token: string) => {
    const { op } = pending;
    const context = pushContext([pending], token);
    switch (op.kind) {
      case "saveDraft":
        return pushDraft(account, op.draftId, { id: pending.id, token }, context);
      case "deleteDraft":
        return providers.get(account.provider).deleteDraft(account, op.remote);
      case "reconcile":
        return refreshMessage(account, pending.providerId);
      default:
        return imapPushCursor(account).pipe(
          Effect.flatMap((cursor) =>
            providers.get(account.provider).push(account, pending.providerId, op, cursor, context),
          ),
        );
    }
  };

  const reconcileDropped = Effect.fnUntraced(function* (
    account: Account,
    item: PendingOp,
    error: string,
  ) {
    if (
      item.op.kind === "saveDraft" ||
      item.op.kind === "deleteDraft" ||
      item.op.kind === "reconcile"
    )
      return;
    yield* refreshMessage(account, item.providerId).pipe(
      Effect.catch(() => store.enqueueOp(account.id, item.providerId, { kind: "reconcile" })),
    );
    yield* store.appendAudit({
      actor: { kind: "user", surface: "app" },
      accountId: account.id,
      action: "sync-failed",
      detail: { providerId: item.providerId, op: item.op, error },
    });
  });

  const flush = Effect.fn("Mailbox.flush")(
    function* (accountIds?: readonly string[], skipImap = false) {
      const result = { done: 0, failed: 0, reauth: new Array<string>() };
      const blocked = new Set<string>();
      const queued = yield* store.listPendingOps;
      if (readOnly) {
        for (const item of queued)
          if (item.op.kind === "saveDraft")
            yield* store.setDraftSyncError(item.op.draftId, READ_ONLY_MESSAGE);
        return { ...result, failed: queued.length };
      }
      const refreshQueued = store.listPendingOps.pipe(
        Effect.tap((updated) =>
          Effect.sync(() => {
            const byId = new Map(updated.map((item) => [item.id, item]));
            for (let i = 0; i < queued.length; i++) {
              const next = byId.get(queued[i]!.id);
              if (next) queued[i] = next;
            }
          }),
        ),
        Effect.asVoid,
      );
      const claimToken = crypto.randomUUID();
      const activeClaims = new Set<number>();
      const settle = (
        account: Account,
        items: readonly PendingOp[],
        push: Effect.Effect<ProviderPushResult, import("./errors.js").ProviderFailure>,
      ): Effect.Effect<void> =>
        push.pipe(
          Effect.result,
          Effect.flatMap((outcome) => {
            const reconciliations: Array<{ item: PendingOp; error: string }> = [];
            return store
              .transaction(
                Effect.gen(function* () {
                  const owned: PendingOp[] = [];
                  for (const item of items)
                    if (yield* store.ownsPendingOp(item.id, claimToken)) owned.push(item);
                  if (owned.length !== items.length) return;
                  if (outcome._tag === "Success") {
                    const needsReconcile =
                      outcome.success !== undefined && "reconcile" in outcome.success;
                    if (outcome.success && !needsReconcile) {
                      yield* store.remapProviderIds(account.id, outcome.success);
                      yield* refreshQueued;
                    }
                    for (const item of owned) {
                      yield* store.removePendingOp(item.id, claimToken);
                      if (needsReconcile) {
                        blocked.add(`${item.accountId}/${item.providerId}`);
                        yield* store.enqueueOp(item.accountId, item.providerId, {
                          kind: "reconcile",
                        });
                      }
                    }
                    result.done += owned.length;
                    return;
                  }
                  const error = outcome.failure;
                  if (error._tag === "AuthError") {
                    yield* store.markReauth(account.id, error);
                    result.reauth.push(account.id);
                  }
                  for (const item of owned) {
                    if (item.op.kind === "saveDraft")
                      yield* store.setDraftSyncError(item.op.draftId, error.message);
                    if (error._tag === "AuthError") {
                      yield* store.releasePendingOp(item.id, claimToken);
                      continue;
                    }
                    blocked.add(`${item.accountId}/${item.providerId}`);
                    const expired =
                      item.op.kind !== "reconcile" &&
                      (yield* Clock.currentTimeMillis) - item.createdAt >= MAX_OP_AGE;
                    if (error._tag === "PermanentError" || expired) {
                      yield* store.removePendingOp(item.id, claimToken);
                      if (item.op.kind !== "reconcile")
                        yield* store.recordFailedOp({
                          accountId: account.id,
                          providerId: item.providerId,
                          kind: item.op.kind,
                          reason: error.message,
                        });
                      if (error._tag === "PermanentError" && error.imapReset) {
                        yield* store.invalidateImapFolder(account.id, error.imapReset);
                        yield* refreshQueued;
                      } else reconciliations.push({ item, error: error.message });
                    } else
                      yield* store.failPendingOp(
                        item.id,
                        error.message,
                        claimToken,
                        error.status === 0,
                      );
                    if (item.op.kind !== "reconcile") result.failed++;
                  }
                }),
              )
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    for (const item of items) activeClaims.delete(item.id);
                  }),
                ),
                Effect.andThen(() =>
                  Effect.forEach(
                    reconciliations,
                    ({ item, error }) => reconcileDropped(account, item, error),
                    { discard: true },
                  ),
                ),
              );
          }),
          Effect.catchTag("ProviderError", (error) => settle(account, items, Effect.fail(error))),
        );
      for (let index = 0; index < queued.length; index++) {
        const pending = queued[index];
        if (!pending || (accountIds && !accountIds.includes(pending.accountId))) continue;
        if (options.localDraftQueue && pending.op.kind === "saveDraft") continue;
        const key = `${pending.accountId}/${pending.providerId}`;
        if (blocked.has(key) || result.reauth.includes(pending.accountId)) continue;
        if (pending.retryAt > (yield* Clock.currentTimeMillis)) {
          blocked.add(key);
          continue;
        }
        const account = yield* store.getAccount(pending.accountId).pipe(Effect.option);
        if (Option.isNone(account)) {
          yield* store.removePendingOp(pending.id);
          continue;
        }
        if (account.value.enabled === false || (skipImap && account.value.provider === "imap"))
          continue;
        if (account.value.needsReauth) {
          result.reauth.push(account.value.id);
          continue;
        }
        const owner = account.value;
        const leasedIds: number[] = [];
        const heartbeat = Effect.gen(function* () {
          for (;;) {
            yield* Effect.sleep("30 seconds");
            for (const id of leasedIds)
              if (activeClaims.has(id) && !(yield* store.renewPendingOp(id, claimToken)))
                return yield* new PendingOpClaimLost({
                  message: "The queued operation is no longer owned by this worker",
                });
          }
        });
        const pushOne = Effect.gen(function* () {
          if (!(yield* store.claimPendingOp(pending.id, claimToken))) {
            blocked.add(key);
            return;
          }
          leasedIds.push(pending.id);
          activeClaims.add(pending.id);
          const adapter = providers.get(owner.provider);
          const op = pending.op;
          const batch: PendingOp[] = [pending];
          if (
            adapter.pushBatch &&
            op.kind !== "saveDraft" &&
            op.kind !== "deleteDraft" &&
            op.kind !== "reconcile" &&
            op.kind !== "trash" &&
            op.kind !== "inbox"
          ) {
            const signature = JSON.stringify(op);
            for (const next of queued.slice(index + 1, index + 1000)) {
              if (
                next.accountId !== pending.accountId ||
                JSON.stringify(next.op) !== signature ||
                (owner.provider === "imap" &&
                  !Option.getOrElse(
                    Option.zipWith(
                      decodeProviderId(pending.providerId),
                      decodeProviderId(next.providerId),
                      (first, other) =>
                        first.path === other.path && first.uidValidity === other.uidValidity,
                    ),
                    () => false,
                  )) ||
                next.retryAt > (yield* Clock.currentTimeMillis) ||
                blocked.has(`${next.accountId}/${next.providerId}`)
              )
                break;
              if (!(yield* store.claimPendingOp(next.id, claimToken))) {
                blocked.add(`${next.accountId}/${next.providerId}`);
                break;
              }
              leasedIds.push(next.id);
              activeClaims.add(next.id);
              batch.push(next);
            }
            index += batch.length - 1;
            if (batch.length > 1) {
              // A stale provider ID must not cause other messages to be dropped.
              const pushBatch = adapter.pushBatch;
              const bulk = imapPushCursor(owner)
                .pipe(
                  Effect.flatMap((cursor) =>
                    pushBatch(
                      owner,
                      batch.map((item) => item.providerId),
                      op,
                      cursor,
                      pushContext(batch, claimToken),
                    ),
                  ),
                )
                .pipe(
                  Effect.catchTag("PermanentError", () =>
                    Effect.gen(function* () {
                      for (const item of batch) {
                        if (
                          result.reauth.includes(item.accountId) ||
                          blocked.has(`${item.accountId}/${item.providerId}`)
                        ) {
                          yield* store.releasePendingOp(item.id, claimToken);
                          activeClaims.delete(item.id);
                          continue;
                        }
                        yield* settle(owner, [item], pushOp(owner, item, claimToken));
                      }
                    }).pipe(Effect.as("fallback" as const)),
                  ),
                );
              const sent = yield* bulk.pipe(Effect.result);
              if (sent._tag === "Failure") yield* settle(owner, batch, Effect.fail(sent.failure));
              else {
                if (sent.success === "fallback") return;
                yield* settle(owner, batch, Effect.succeed(sent.success));
              }
              return;
            }
          }
          yield* settle(owner, [pending], pushOp(owner, pending, claimToken));
        }).pipe(
          Effect.raceFirst(heartbeat),
          Effect.catchTag("PendingOpClaimLost", (error) =>
            Effect.gen(function* () {
              for (const id of leasedIds) {
                const item = queued.find((candidate) => candidate.id === id);
                if (item) blocked.add(`${item.accountId}/${item.providerId}`);
                if (yield* store.ownsPendingOp(id, claimToken))
                  yield* store.failPendingOp(id, error.message, claimToken);
              }
              result.failed += leasedIds.length;
            }),
          ),
          Effect.ensuring(
            Effect.forEach(
              leasedIds,
              (id) =>
                store
                  .releasePendingOp(id, claimToken)
                  .pipe(Effect.tap(() => Effect.sync(() => activeClaims.delete(id)))),
              {
                discard: true,
              },
            ),
          ),
        );
        yield* owner.provider === "imap"
          ? imapPullLock(owner.id).withPermitsIfAvailable(1)(pushOne)
          : pushOne;
      }
      return result;
    },
    (effect, _accountIds?: readonly string[], _skipImap?: boolean) =>
      runtime.flushLock.withPermits(1)(effect),
  );

  /** Flushes without making the caller wait for the network. */
  const flushNow = flush().pipe(
    Effect.flatMap((result) =>
      result.reauth.length || result.failed || result.done ? changed : Effect.void,
    ),
    Effect.catchCause((cause) => Effect.logWarning("flush failed", cause)),
  );

  const flushLater = options.localDraftQueue
    ? Effect.void
    : options.backgroundFlush === false
      ? flushNow
      : FiberSet.run(runtime.background, flushNow).pipe(Effect.asVoid);
  return {
    flush,
    flushNow,
    flushLater,
  };
};
