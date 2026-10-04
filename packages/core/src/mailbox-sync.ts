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
import { type Account, type FlushResult, type SyncResult } from "./domain.js";
import { type AuthError, type ProviderError } from "./errors.js";
import { backfillCachedHeaders } from "./header-backfill.js";
import { ImapIdle } from "./imap-idle.js";
import { type makeCacheMailbox } from "./mailbox-cache.js";
import { type makeFeatureMailbox } from "./mailbox-features.js";
import { type makeOrganizationMailbox } from "./mailbox-organization.js";
import {
  PULL_RETRY,
  SYNC_RETRY_MESSAGE,
  WRITE_BATCH,
  type MailboxDependencies,
  type MailboxRuntimeState,
} from "./mailbox-runtime.js";
import { type Mailbox, type SyncState } from "./mailbox.js";
import { BackgroundRead } from "./provider-connectivity.js";
import { type Change } from "./services.js";
import { logSyncCrash, type SyncCrashDiagnostic } from "./sync-crash.js";
import { makeSyncHealth } from "./sync-health.js";
import { makeResetGuard, RESET_VERIFICATION_LIMIT } from "./sync-reset.js";

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
          ? store.setNeedsReauth(account.id, true)
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
    budget = { remaining: RESET_VERIFICATION_LIMIT },
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
    const failed = (text: string, auth: boolean) =>
      Effect.gen(function* () {
        if (auth) yield* store.setNeedsReauth(account.id, true);
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
            .pull(currentAccount, cursor, scope, incrementalOnly)
            .pipe(
              Stream.groupedWithin(WRITE_BATCH, Duration.millis(250)),
              Stream.takeWhileEffect(() =>
                store.getAccount(account.id).pipe(
                  Effect.orDie,
                  Effect.map((a) => a.enabled !== false),
                ),
              ),
              Stream.runForEach(apply(currentAccount, notificationsReady)),
            );
        }),
      ),
    );
    return yield* pull.pipe(
      Effect.retry(scope ? { ...PULL_RETRY, times: 0 } : PULL_RETRY),
      Effect.tap(() => enter("verification")),
      Effect.andThen(scope ? Effect.void : guard.verify()),
      Effect.tap(() => enter("health")),
      Effect.andThen(
        scope
          ? Effect.void
          : guard.sweep(() => makeSyncHealth(store, providers)(account.id).pipe(Effect.orDie)),
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
      Effect.catch((error) => failed(error.message, error._tag === "AuthError")),
      // A bug in one provider must not stop the other accounts from syncing.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : logSyncCrash(cause, phase).pipe(Effect.andThen(failed(SYNC_RETRY_MESSAGE, false))),
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
    const results: SyncResult[] = [];
    const budget = { remaining: RESET_VERIFICATION_LIMIT };
    // One failing account does not stop the rest.
    for (const account of accounts) {
      if (account.enabled === false) continue;
      const result: SyncResult = yield* account.provider === "imap"
        ? pullAccount(account, undefined, false, budget).pipe(
            imapPullLock(account.id).withPermits(1),
          )
        : pullAccount(account, undefined, false, budget);
      if (account.provider === "imap" && !result.error) yield* flush([account.id]);

      results.push(result);
      if (!result.error) runtime.polling.delete(account.id);
      if (!account.needsReauth)
        yield* deps
          .features()
          .refreshContacts(account.id, false)
          .pipe(Effect.catch(() => Effect.void));
      yield* store.getBackfillState(account.id);
      yield* store.evictBodies(account.id, yield* Clock.currentTimeMillis);
    }
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
      yield* Effect.gen(function* () {
        yield* store.evictBodyBudget((yield* store.prefs).bodyCacheBytes);
      }).pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped);

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

      yield* deps
        .organization()
        .wakeSnoozed()
        .pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);
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
    maintainHeaders,
    pullAccount,
    runSync,
    sync,
    pollInbox,
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
