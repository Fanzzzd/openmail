import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  FiberSet,
  Option,
  Ref,
  Schedule,
  Semaphore,
  Stream,
} from "effect";
import { type Account, type FlushResult, type SyncResult } from "../domain/domain.js";
import { type AuthError, type ProviderError, type ProviderFailure } from "../domain/errors.js";
import { runTokenKeepAlive } from "../sync/token-keepalive.js";
import { backfillCachedHeaders } from "../sync/header-backfill.js";
import { ImapIdle } from "../providers/imap/imap-idle.js";
import { type makeCacheMailbox } from "./mailbox-cache.js";
import { type makeFeatureMailbox } from "./mailbox-features.js";
import { type makeOrganizationMailbox } from "./mailbox-organization.js";
import { type MailboxDependencies, type MailboxRuntimeState } from "./mailbox-runtime.js";
import { type Mailbox, type SyncState } from "./mailbox.js";
import { BackgroundRead } from "../providers/provider-connectivity.js";
import { retryAfterMillis } from "../providers/provider-retry.js";
import type { Change } from "../providers/adapter.js";
import { logSyncCrash, type SyncCrashDiagnostic } from "../sync/sync-crash.js";
import { logSyncFailed, SYNC_FAILURE_TEXT, syncFailureText } from "../sync/sync-failure.js";
import { makeSyncHealth } from "../sync/sync-health.js";
import { makeResetGuard, resetBudgets, resetVerificationLimit } from "../sync/sync-reset.js";

// Changes per write transaction (an Upsert and its Progress are two). Each one blocks
// the main thread; 100 real messages took up to 509 ms of CPU, 10 took up to 104 ms.
const WRITE_BATCH = 20;
// Body text per write transaction, in UTF-16 code units (bytes for ASCII HTML). 20 messages
// of about 105 KB HTML each, with the FTS and search_flags triggers, blocked for over 50 ms.
const WRITE_BATCH_BODY = 200_000;

/** Cuts a batch before a message whose body would take the transaction over `budget`. */
export function splitWriteBatch(batch: readonly Change[], budget = WRITE_BATCH_BODY): Change[][] {
  const parts: Change[][] = [];
  let part: Change[] = [];
  let size = 0;
  for (const change of batch) {
    const body =
      change._tag === "Upsert" || change._tag === "Remap"
        ? change.message.bodyHtml.length + change.message.bodyText.length
        : 0;
    if (body && part.length && size + body > budget) {
      parts.push(part);
      part = [];
      size = 0;
    }
    part.push(change);
    size += body;
  }
  if (part.length) parts.push(part);
  return parts;
}

type PullError = {
  readonly _tag: string;
  readonly status?: number | undefined;
  readonly reason?: string | undefined;
  readonly deferred?: boolean;
  readonly retryAfter?: string | undefined;
};

/**
 * A pull that failed on the network (no status: the connection dropped, DNS
 * failed after a wake from sleep), a rate limit or a 5xx is tried again before
 * the sync counts as failed. The adapters already retry each request for
 * about 8 s; this covers an outage that outlasts that.
 */
const isTransientPull = (e: PullError) =>
  e._tag === "ProviderError" &&
  !e.deferred &&
  // The server refuses this sign-in until the person changes a setting.
  e.reason !== "unsafe_login" &&
  (e.status === undefined || e.status === 429 || e.status >= 500 || e.reason === "quota");

/** A server that asks for a longer wait is left to the next scheduled sync. */
const PULL_RETRY_MAX_WAIT = 120_000;

/**
 * Tries a transient pull failure again after 5 s, then 10 s. A rate limit waits 30 s, then
 * 60 s, since Gmail's per-minute quota sends no Retry-After; a Retry-After is honoured.
 */
const retryPull = <A, E extends PullError, R>(pull: Effect.Effect<A, E, R>, times: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; ; attempt++) {
      const result = yield* Effect.result(pull);
      if (result._tag === "Success") return result.success;
      const error = result.failure;
      if (attempt >= times || !isTransientPull(error)) return yield* Effect.fail(error);
      const base = (error.reason === "quota" ? 30_000 : 5_000) * 2 ** attempt;
      const asked = retryAfterMillis(error.retryAfter, yield* Clock.currentTimeMillis);
      if (asked > PULL_RETRY_MAX_WAIT) return yield* Effect.fail(error);
      yield* Effect.sleep(Math.max(base, asked));
    }
  });

type PullFailed = {
  readonly _tag: "PullFailed";
  readonly cause: Cause.Cause<ProviderFailure>;
};

/** Accounts a full sync pulls at the same time. */
const SYNC_ACCOUNTS = 3;

const SYNC_RETRY_MESSAGE = SYNC_FAILURE_TEXT.unknown;

export const makeSyncMailbox = (
  deps: MailboxDependencies & {
    applyChanges: (
      account: Account,
      counts: { changed: number; deleted: number },
      notificationsReady: boolean,
      scope?: "inbox",
    ) => (batch: readonly Change[]) => Effect.Effect<void, ProviderError | AuthError>;
    organization: () => ReturnType<typeof makeOrganizationMailbox>;
    flush: (accountIds?: readonly string[], skipImap?: boolean) => Effect.Effect<FlushResult>;
    features: () => ReturnType<typeof makeFeatureMailbox>;
    cache: () => ReturnType<typeof makeCacheMailbox>;
    enforceCacheBudget: (force?: boolean) => Effect.Effect<void>;
  },
  runtime: MailboxRuntimeState,
) => {
  const {
    options,
    store,
    providers,
    applyChanges,
    emit,
    flush,
    imapPullLock,
    changed,
    pollInterval,
    backgroundReady,
    onBattery,
    resetConnectivity,
  } = deps;

  const maintainHeaders = (account: Account) => {
    let lock = runtime.headerLocks.get(account.id);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      runtime.headerLocks.set(account.id, lock);
    }
    return backfillCachedHeaders(store, providers.get(account.provider), account).pipe(
      lock.withPermits(1),
      Effect.catch((error) =>
        error._tag === "AuthError"
          ? store.markReauth(account.id, error)
          : error._tag === "ProviderError" && (error.status === 429 || error.deferred)
            ? Effect.logInfo("Header backfill deferred")
            : Effect.logWarning("Header backfill failed"),
      ),
    );
  };

  const pullAccount = Effect.fn("Mailbox.pullAccount")(function* (
    account: Account,
    scope?: "inbox",
    incrementalOnly = false,
    budget = { remaining: resetVerificationLimit(account.provider) },
  ) {
    let phase: typeof SyncCrashDiagnostic.Type.phase = "pull";
    const enter = (next: typeof phase) =>
      Effect.sync(() => {
        phase = next;
      });
    const counts = { changed: 0, deleted: 0 };
    const guard = makeResetGuard(store, providers.get(account.provider), account, counts, budget);
    const apply = (current: Account, notificationsReady: boolean) =>
      Effect.fnUntraced(function* (batch: readonly Change[]) {
        let changes: Change[] = [];
        for (const change of batch) {
          if (
            !scope &&
            (change._tag === "VerifyCandidates" ||
              change._tag === "Reset" ||
              change._tag === "DeleteLabel" ||
              change._tag === "RebuildFolder")
          ) {
            if (changes.length)
              yield* applyChanges(current, counts, notificationsReady, scope)(changes);
            changes = [];
            yield* change._tag === "VerifyCandidates"
              ? guard.enqueue(change.providerIds)
              : guard.reset(change);
          } else changes.push(change);
        }
        if (changes.length)
          yield* applyChanges(current, counts, notificationsReady, scope)(changes);
      });
    account = yield* store.getAccount(account.id).pipe(Effect.orDie);
    if (account.enabled === false) return { accountId: account.id, ...counts };
    if (account.needsReauth) {
      return { accountId: account.id, ...counts, error: "Sign in again", needsReauth: true };
    }
    const failed = (text: string, auth: AuthError | undefined) =>
      Effect.gen(function* () {
        if (auth) yield* store.markReauth(account.id, auth);
        yield* scope ? store.setInboxError(account.id, text) : store.setSyncError(account.id, text);
        return {
          accountId: account.id,
          ...counts,
          error: text,
          ...(auth ? { needsReauth: true } : {}),
        } satisfies SyncResult;
      });
    if (!scope && account.lastSyncedAt === null) yield* store.beginInitialSync(account.id);
    const notificationsReady = yield* store.notificationsReady(account.id);
    const storedIds = (providerIds: readonly string[]) =>
      Effect.gen(function* () {
        const found = new Set<string>();
        for (const providerId of providerIds)
          if (yield* store.messageIdForProvider(account.id, providerId)) found.add(providerId);
        return found;
      });
    // A retry starts from the cursor the failed attempt left: batches it
    // wrote stay, and the cursor only moves once a whole pull is in.
    const pull = Effect.sync(() => {
      counts.changed = 0;
      counts.deleted = 0;
    }).pipe(
      Effect.andThen(
        scope
          ? store
              .getInboxCursor(account.id)
              .pipe(
                Effect.flatMap((cursor) =>
                  Option.isSome(cursor) ? Effect.succeed(cursor) : store.getSyncCursor(account.id),
                ),
              )
          : store.getSyncCursor(account.id),
      ),
      Effect.flatMap((cursor) =>
        Effect.gen(function* () {
          const currentAccount = yield* store.getAccount(account.id).pipe(Effect.orDie);
          if (currentAccount.enabled === false) return;
          yield* providers
            .get(account.provider)
            .pull(currentAccount, cursor, scope, incrementalOnly, storedIds)
            .pipe(
              // A failure ends the stream after the changes before it are written, so a
              // checkpoint (an Outlook folder's cursor) still in the batch buffer is kept.
              Stream.map((change): Change | PullFailed => change),
              Stream.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Stream.failCause(cause)
                  : Stream.succeed<Change | PullFailed>({ _tag: "PullFailed", cause }),
              ),
              Stream.groupedWithin(WRITE_BATCH, Duration.millis(250)),
              Stream.takeWhileEffect(() =>
                store.getAccount(account.id).pipe(
                  Effect.orDie,
                  Effect.map((a) => a.enabled !== false),
                ),
              ),
              // Let timers and IPC run between write transactions.
              Stream.runForEach((batch) => {
                const changes = batch.filter((c): c is Change => c._tag !== "PullFailed");
                const failure = batch.find((c): c is PullFailed => c._tag === "PullFailed");
                return Effect.forEach(
                  splitWriteBatch(changes),
                  (part) =>
                    Effect.andThen(
                      apply(currentAccount, notificationsReady)(part),
                      Effect.yieldNow,
                    ),
                  { discard: true },
                ).pipe(Effect.andThen(failure ? Effect.failCause(failure.cause) : Effect.void));
              }),
            );
        }),
      ),
    );
    return yield* retryPull(pull, scope ? 0 : 2).pipe(
      Effect.tap(() => enter("verification")),
      Effect.andThen(scope ? Effect.void : guard.verify()),
      Effect.tap(() => enter("health")),
      Effect.andThen(
        scope
          ? Effect.void
          : guard.sweep(() =>
              makeSyncHealth(store, providers, { diagnoseDraftExcess: false })(account.id).pipe(
                Effect.orDie,
              ),
            ),
      ),
      Effect.andThen(
        scope
          ? store.setInboxError(account.id, null)
          : store
              .setSyncError(account.id, null)
              .pipe(Effect.andThen(store.setInboxError(account.id, null))),
      ),
      Effect.andThen(scope ? Effect.void : store.finishInitialSync(account.id)),
      Effect.andThen(
        !scope && account.provider === "gmail"
          ? store.getAccount(account.id).pipe(
              Effect.orDie,
              Effect.flatMap((a) =>
                a.enabled === false || guard.isDeferred()
                  ? Effect.void
                  : providers
                      .get("gmail")
                      .sendAs(a)
                      .pipe(
                        Effect.flatMap((aliases) =>
                          store.transaction(store.replaceSendAs(a.id, aliases)),
                        ),
                        // Settings permission is optional for existing mail accounts.
                        Effect.catch(() => Effect.void),
                      ),
              ),
            )
          : Effect.void,
      ),
      Effect.tap(() => enter("headers")),
      Effect.andThen(
        Effect.suspend(() =>
          scope || guard.isDeferred() ? Effect.void : maintainHeaders(account),
        ),
      ),
      // `counts` is filled while the stream runs, so read it afterwards.
      Effect.map(() => ({ accountId: account.id, ...counts }) satisfies SyncResult),
      Effect.catch((error) =>
        logSyncFailed(account, scope ? "inbox" : "full", error).pipe(
          Effect.andThen(
            failed(syncFailureText(error), error._tag === "AuthError" ? error : undefined),
          ),
        ),
      ),
      // A bug in one provider must not stop the other accounts from syncing.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : logSyncCrash(cause, phase).pipe(Effect.andThen(failed(SYNC_RETRY_MESSAGE, undefined))),
      ),
    );
  });

  const runSync = Effect.fn("Mailbox.runSync")(function* (accountId?: string) {
    yield* Ref.update(runtime.syncState, (s) => ({ ...s, running: true }));
    yield* emit({ _tag: "SyncState", state: yield* Ref.get(runtime.syncState) });
    yield* deps.organization().wakeSnoozed();
    // IMAP must check UID namespaces before replaying persisted operations.
    // Other providers retain stable identities and can push first.
    yield* flush(undefined, true);
    const accounts = accountId
      ? [yield* store.getAccount(accountId).pipe(Effect.orDie)]
      : yield* store.listAccounts;
    const budgets = resetBudgets();
    // Up to SYNC_ACCOUNTS accounts pull at once; each account appears once per run, and
    // syncLock keeps polls and other runs out. SQLite writes still go one transaction at a
    // time through the shared connection. One failing account does not stop the rest.
    const results = yield* Effect.forEach(
      accounts.filter((account) => account.enabled !== false),
      (account) =>
        Effect.gen(function* () {
          const result: SyncResult = yield* account.provider === "imap"
            ? pullAccount(account, undefined, false, budgets.imap).pipe(
                imapPullLock(account.id).withPermits(1),
              )
            : pullAccount(account, undefined, false, budgets[account.provider]);
          if (account.provider === "imap" && !result.error) yield* flush([account.id]);
          if (!result.error) runtime.polling.delete(account.id);
          if (!account.needsReauth)
            yield* deps
              .features()
              .refreshContacts(account.id, false)
              .pipe(Effect.catch(() => Effect.void));
          yield* store.getBackfillState(account.id);
          yield* store.evictBodies(account.id, yield* Clock.currentTimeMillis);
          return result;
        }),
      { concurrency: SYNC_ACCOUNTS },
    );
    const next: SyncState = {
      running: false,
      lastFinishedAt: Date.now(),
      errors: results.flatMap((r) => (r.error ? [`${r.accountId}: ${r.error}`] : [])),
    };
    yield* Ref.set(runtime.syncState, next);
    yield* emit({ _tag: "SyncState", state: next });
    yield* changed;
    yield* store.checkpoint;
    return results;
  });

  /** One sync at a time: a call during a run waits for that run instead of starting another. */
  const sync = Effect.fn("Mailbox.sync")(function* (accountId?: string) {
    const current = yield* Ref.get(runtime.inflight);
    if (Option.isSome(current)) return yield* Deferred.await(current.value);
    const done = yield* Deferred.make<SyncResult[]>();
    yield* Ref.set(runtime.inflight, Option.some(done));
    return yield* runSync(accountId).pipe(
      runtime.syncLock.withPermits(1),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : logSyncCrash(cause, "maintenance").pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  yield* Ref.update(runtime.syncState, (s) => ({
                    ...s,
                    running: false,
                    errors: [SYNC_RETRY_MESSAGE],
                  }));
                  yield* emit({ _tag: "SyncState", state: yield* Ref.get(runtime.syncState) });
                  return [
                    {
                      accountId: accountId ?? "all",
                      changed: 0,
                      deleted: 0,
                      error: SYNC_RETRY_MESSAGE,
                    },
                  ];
                }),
              ),
            ),
      ),
      Effect.onExit((exit) =>
        Ref.set(runtime.inflight, Option.none()).pipe(
          Effect.andThen(Deferred.done(done, exit)),
          Effect.andThen(
            exit._tag === "Failure"
              ? Ref.update(runtime.syncState, (s) => ({ ...s, running: false }))
              : Effect.void,
          ),
        ),
      ),
    );
  });

  const pollInbox = Effect.fn("Mailbox.pollInbox")(function* (
    accountIds?: readonly string[],
    incrementalOnly = false,
  ) {
    if (runtime.syncPaused) return [];
    const task = Effect.gen(function* () {
      if (accountIds === undefined) yield* flush(undefined, true);
      const accounts = yield* store.listAccounts;
      const now = yield* Clock.currentTimeMillis;
      const results: SyncResult[] = [];
      let anyChange = false;
      for (const account of accounts) {
        if (
          account.enabled === false ||
          (accountIds !== undefined && !accountIds.includes(account.id)) ||
          (accountIds === undefined &&
            (runtime.idle?.active(account.id) || runtime.idle?.reconnecting(account.id))) ||
          account.lastSyncedAt === null ||
          (accountIds === undefined && (runtime.polling.get(account.id)?.due ?? 0) > now)
        )
          continue;
        const before = yield* store.getInboxError(account.id);
        const pulled: SyncResult = yield* account.provider === "imap"
          ? pullAccount(account, "inbox", incrementalOnly).pipe(
              imapPullLock(account.id).withPermits(1),
            )
          : pullAccount(account, "inbox", incrementalOnly);
        if (account.provider === "imap" && !pulled.error) yield* flush([account.id]);
        results.push(pulled);
        const error = yield* store.getInboxError(account.id);
        anyChange ||= pulled.changed + pulled.deleted > 0 || before !== error;
        if (pulled.error) {
          const failures = (runtime.polling.get(account.id)?.failures ?? 0) + 1;
          runtime.polling.set(account.id, {
            failures,
            due: now + Math.min(900_000, pollInterval * 2 ** Math.min(failures, 5)),
          });
        } else runtime.polling.delete(account.id);
      }
      const live = new Set(accounts.map((account) => account.id));
      for (const id of runtime.polling.keys()) if (!live.has(id)) runtime.polling.delete(id);
      if (anyChange) yield* changed;
      return results;
    });
    if (accountIds !== undefined) return yield* runtime.syncLock.withPermits(1)(task);
    const result = yield* runtime.syncLock.withPermitsIfAvailable(1)(task);
    return Option.getOrElse(result, () => []);
  });
  const start = Effect.gen(function* () {
    if (options.imapIdle) {
      const runIdle = yield* FiberSet.makeRuntimePromise();
      runtime.idle = new ImapIdle(
        (account, signal, onChange, ready) => {
          const watch = providers.get(account.provider).watchInbox;
          return watch
            ? runIdle(watch(account, signal, onChange, ready))
            : Promise.resolve("unsupported");
        },
        (accountIds) => runIdle(pollInbox(accountIds)),
      );
      const watcher = runtime.idle;
      yield* Effect.addFinalizer(() => Effect.sync(() => watcher.close()));
      yield* store.listAccounts.pipe(
        Effect.tap((accounts) => Effect.sync(() => watcher.reconcile(accounts))),
        Effect.repeat(Schedule.spaced("5 seconds")),
        Effect.forkScoped,
      );
    }

    if (options.autoSync !== undefined) {
      // Old cached metadata can progress even while Graph is rebuilding its delta snapshot.
      // One account and at most 500 rows per maintenance pass; share the cursor lock with sync.

      yield* Effect.gen(function* () {
        yield* backgroundReady;
        yield* Effect.sleep("10 seconds");
        if (runtime.syncPaused) return;
        const now = yield* Clock.currentTimeMillis;
        const accounts: Account[] = [];
        for (const account of yield* store.listAccounts) {
          if (account.enabled === false || account.needsReauth || account.lastSyncedAt === null)
            continue;
          const progress = yield* store.headerBackfillState(account.id);
          if (progress.kind === "running" && (progress.retryAt ?? 0) <= now) accounts.push(account);
        }
        const account = accounts[runtime.nextHeadersAccount % Math.max(1, accounts.length)];
        runtime.nextHeadersAccount++;
        if (!account) return;
        yield* account.provider === "imap"
          ? maintainHeaders(account).pipe(
              imapPullLock(account.id).withPermitsIfAvailable(1),
              Effect.asVoid,
            )
          : maintainHeaders(account);
        yield* changed;
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("Header backfill failed"),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* backgroundReady.pipe(
        Effect.andThen(Effect.sleep("1 minute")),
        Effect.andThen(deps.enforceCacheBudget().pipe(Effect.repeat(Schedule.spaced("1 hour")))),
        Effect.forkScoped,
      );

      // Start after the first normal sync. A single account/page per tick
      // prevents large accounts from starving smaller ones.

      yield* Effect.gen(function* () {
        yield* Effect.sleep("10 seconds");
        if (runtime.syncPaused) return;
        const accounts = yield* store.listAccounts;
        const account = accounts[runtime.nextAccount % Math.max(1, accounts.length)];
        runtime.nextAccount++;
        if (account) yield* deps.cache().backfillOlder({ accountIds: [account.id] });
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("backfill failed", cause)),
        Effect.repeat(Schedule.spaced("10 seconds")),
        Effect.forkScoped,
      );

      // A failed pass (a busy database, a defect) is logged; the next tick tries again.
      yield* deps
        .organization()
        .wakeSnoozed()
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("snooze wake failed", cause),
          ),
          Effect.repeat(Schedule.spaced("30 seconds")),
          Effect.forkScoped,
        );
      // Runs while sync is paused and in read-only sessions: it only refreshes tokens.
      yield* backgroundReady.pipe(
        Effect.andThen(runTokenKeepAlive(store, providers, changed)),
        Effect.forkScoped,
      );
      yield* backgroundReady.pipe(
        Effect.andThen(
          Effect.suspend(() => (runtime.syncPaused ? Effect.void : sync())).pipe(
            Effect.provideService(BackgroundRead, true),
            Effect.catchCause(() => Effect.void),
            Effect.repeat(Schedule.spaced(options.autoSync)),
          ),
        ),
        Effect.forkScoped,
      );
    }

    if (options.inboxPoll !== undefined) {
      yield* Effect.suspend(() => Effect.sleep(pollInterval * (onBattery() ? 2 : 1))).pipe(
        Effect.andThen(pollInbox()),
        Effect.catchCause((cause) => Effect.logWarning("inbox poll failed", cause)),
        Effect.forever,
        Effect.forkScoped,
      );
    }
  });
  return {
    sync,
    start,
    service: {
      resetConnectivity: () => resetConnectivity,

      setSyncPaused: (paused) =>
        Effect.gen(function* () {
          runtime.syncPaused = paused;
          runtime.idle?.pause(paused);
          if (!paused) yield* resetConnectivity;
          if (paused)
            for (const provider of new Set(
              (yield* store.listAccounts).map((account) => account.provider),
            ))
              yield* providers.get(provider).closeSessions?.() ?? Effect.void;
        }),

      sync: (accountId) => sync(accountId),

      pollInbox,

      syncState: Ref.get(runtime.syncState),

      events: Stream.fromPubSub(runtime.pubsub),
    } satisfies Pick<
      Mailbox["Service"],
      "resetConnectivity" | "setSyncPaused" | "sync" | "pollInbox" | "syncState" | "events"
    >,
  };
};
