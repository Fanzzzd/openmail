import { Clock, Effect, Option, Semaphore } from "effect";
import { DEFAULT_CACHE_WINDOWS, keepBody, type BackfillState } from "./cache.js";
import { trackImapBackfill } from "./imap.js";
import type { ThreadQuery } from "./domain.js";
import type { PerformError } from "./mailbox.js";
import type { Providers, Store } from "./services.js";

/** Pages yield the network lock between requests; sync claims it before historical work. */
export function makeCacheMailbox(
  store: Store["Service"],
  providers: Providers["Service"],
  network: Semaphore.Semaphore,
  syncPending: () => Effect.Effect<boolean>,
  changed: Effect.Effect<unknown>,
  progress: Effect.Effect<unknown>,
) {
  const onePage = (accountId: string) =>
    network.withPermit(
      Effect.gen(function* () {
        if (yield* syncPending()) return;
        const account = yield* store.getAccount(accountId);
        if (account.needsReauth || account.lastSyncedAt === null) return;
        const state = yield* store.getBackfillState(accountId);
        const now = yield* Clock.currentTimeMillis;
        if (state.paused || state.done || state.nextRunAt > now) return;
        yield* providers
          .get(account.provider)
          .backfill(account, state, (ids) => store.backfillCandidates(accountId, ids))
          .pipe(
            Effect.timeout("90 seconds"),
            Effect.flatMap((page) =>
              store.transaction(
                Effect.gen(function* () {
                  const custom = (yield* store.cacheWindows).filter(
                    (w) => w.accountId === accountId,
                  );
                  const windows = [
                    ...DEFAULT_CACHE_WINDOWS.filter(
                      (w) => !custom.some((c) => c.label === w.label),
                    ),
                    ...custom,
                  ];
                  const allowed = new Set(
                    yield* store.backfillCandidates(
                      accountId,
                      page.messages.map((m) => m.providerId),
                    ),
                  );
                  for (const message of page.messages) {
                    if (!allowed.has(message.providerId)) continue;
                    // Historical overlap must not overwrite cached headers or queued local edits.
                    const existing = yield* store
                      .messageRef(`${accountId}/${message.providerId}`)
                      .pipe(Effect.option);
                    if (Option.isSome(existing)) continue;
                    const cached = keepBody(message, windows, now);
                    yield* store.upsertMessage(
                      accountId,
                      cached
                        ? message
                        : { ...message, bodyText: "", bodyHtml: "", bodyCached: false },
                    );
                  }
                  if (account.provider === "imap") {
                    const cursor = trackImapBackfill(
                      yield* store.getSyncCursor(accountId),
                      page.messages,
                    );
                    if (Option.isSome(cursor))
                      yield* store.saveSyncCursor(accountId, cursor.value, false);
                  }
                  yield* store.saveBackfillState({
                    ...state,
                    cursor: page.cursor,
                    fetched: state.fetched + page.scanned,
                    done: page.cursor === null,
                    lastError: null,
                    nextRunAt: now + 10_000,
                  });
                }),
              ),
            ),
            Effect.catch((error) =>
              store.saveBackfillState({
                ...state,
                cursor:
                  error._tag === "ProviderError" && (error.status === 400 || error.status === 410)
                    ? null
                    : state.cursor,
                lastError: error._tag === "TimeoutError" ? "Backfill timed out" : error.message,
                nextRunAt: now + 5 * 60_000,
              }),
            ),
          );
        yield* progress;
      }),
    );
  const fetchOlder = Effect.fn("Mailbox.fetchOlder")(function* (query: ThreadQuery) {
    const accounts = yield* store.listAccounts;
    for (const account of accounts) {
      if (query.accountIds === undefined || query.accountIds.includes(account.id))
        yield* onePage(account.id).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
  });
  const readerThread = Effect.fn("Mailbox.readerThread")(function* (
    id: string,
  ): Effect.fn.Return<import("./domain.js").Message[], PerformError> {
    const messages = yield* store.getThread(id);
    const now = yield* Clock.currentTimeMillis;
    for (const message of messages) {
      yield* store.touchBody(message.id, now);
      if (message.bodyCached !== false && message.replyTo !== undefined) continue;
      const hydrate = Effect.gen(function* () {
        const ref = yield* store.messageRef(message.id);
        const account = yield* store.getAccount(ref.accountId);
        const full = yield* providers.get(account.provider).fetchMessage(account, ref.providerId);
        yield* store.transaction(
          Effect.gen(function* () {
            const current = yield* store.getMessage(message.id);
            yield* store.upsertMessage(account.id, {
              ...current,
              providerId: ref.providerId,
              from: full.from,
              to: full.to,
              cc: full.cc,
              replyTo: full.replyTo ?? [],
              bodyText: full.bodyText,
              bodyHtml: full.bodyHtml,
              bodyCached: true,
            });
          }),
        );
      });
      // A reply cannot choose targets while its headers remain unknown.
      // Known headers still allow offline reading if an evicted body fails to load.
      yield* message.replyTo === undefined
        ? hydrate
        : hydrate.pipe(Effect.catch(() => Effect.void));
    }
    return yield* store.getThread(id);
  });
  const backfillState: Effect.Effect<BackfillState[]> = Effect.gen(function* () {
    for (const a of yield* store.listAccounts) yield* store.getBackfillState(a.id);
    return yield* store.backfillStates;
  });
  return {
    fetchOlder,
    readerThread,
    backfillState,
    pauseBackfill: (accountId: string, paused: boolean) =>
      store.setBackfillPaused(accountId, paused).pipe(Effect.andThen(progress), Effect.asVoid),
    cacheWindows: store.cacheWindows,
    setCacheWindow: (input: import("./cache.js").CacheWindowInput) =>
      Effect.gen(function* () {
        yield* store.getAccount(input.accountId);
        yield* store.setCacheWindow(input);
        yield* store.evictBodies(input.accountId, yield* Clock.currentTimeMillis, true);
        yield* changed;
      }),
  };
}
