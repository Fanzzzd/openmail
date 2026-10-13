import { Clock, Effect, Option, Semaphore } from "effect";
import { DEFAULT_CACHE_WINDOWS, keepBody, type BackfillState } from "../domain/cache.js";
import { trackImapBackfill } from "../providers/imap/imap-cursor.js";
import type { ThreadQuery } from "../domain/domain.js";
import { ProviderError } from "../domain/errors.js";
import type { PerformError } from "./mailbox.js";
import type { Providers } from "../providers/adapter.js";
import type { Store } from "../store/service.js";

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
        if (account.enabled === false || account.needsReauth || account.lastSyncedAt === null)
          return;
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
                    const existing = yield* store.messageIdForProvider(
                      accountId,
                      message.providerId,
                    );
                    if (existing) continue;
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
  const backfillOlder = Effect.fn("Mailbox.backfillOlder")(function* (query: ThreadQuery) {
    const accounts = yield* store.listAccounts;
    for (const account of accounts) {
      if (query.accountIds === undefined || query.accountIds.includes(account.id))
        yield* onePage(account.id).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
  });
  const folders = new Map<string, { cursor: string | null; done: boolean }>();
  const fetchOlder = Effect.fn("Mailbox.fetchOlder")(function* (query: ThreadQuery) {
    if (query.mailbox === undefined && query.label === undefined) {
      yield* backfillOlder(query);
      return { done: false };
    }
    if (query.search || query.mailbox === "drafts" || query.mailbox === "snoozed")
      return { done: true };
    return yield* network
      .withPermit(
        Effect.gen(function* () {
          let done = true;
          for (const account of yield* store.listAccounts) {
            if (
              account.enabled === false ||
              account.needsReauth ||
              (query.accountIds && !query.accountIds.includes(account.id))
            )
              continue;
            const scope = {
              mailbox: query.mailbox ?? "inbox",
              ...(query.label ? { label: query.label } : {}),
            };
            const key = JSON.stringify([account.id, account.createdAt, scope]);
            const state = folders.get(key) ?? { cursor: null, done: false };
            if (state.done) continue;
            const adapter = providers.get(account.provider);
            yield* Effect.gen(function* () {
              // Skip already cached pages without replacing local edits. One request stays bounded.
              for (let attempt = 0; attempt < 10; attempt++) {
                const page = yield* adapter.listFolderMessages(account, scope, state.cursor, {
                  newestFirst: true,
                });
                const candidates = yield* store.backfillCandidates(account.id, page.ids);
                const messages = yield* Effect.forEach(
                  candidates,
                  (id) => adapter.fetchMessage(account, id),
                  { concurrency: 3 },
                );
                yield* store.transaction(
                  Effect.gen(function* () {
                    const current = yield* store.getAccount(account.id).pipe(Effect.option);
                    if (Option.isNone(current) || current.value.enabled === false) return;
                    const allowed = new Set(
                      yield* store.backfillCandidates(account.id, candidates),
                    );
                    for (const message of messages)
                      if (allowed.has(message.providerId))
                        yield* store.upsertMessage(account.id, message);
                  }),
                );
                state.cursor = page.next;
                state.done = page.next === null;
                folders.set(key, state);
                if (messages.length || state.done) break;
              }
              done &&= state.done;
            }).pipe(
              Effect.onExit((exit) =>
                exit._tag === "Failure"
                  ? Effect.sync(() => {
                      folders.delete(key);
                    })
                  : Effect.void,
              ),
            );
          }
          yield* progress;
          return { done };
        }),
      )
      .pipe(
        Effect.timeout("90 seconds"),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(new ProviderError({ message: "Older mail download timed out" })),
        ),
      );
  });
  const readerThread = Effect.fn("Mailbox.readerThread")(function* (
    id: string,
  ): Effect.fn.Return<import("../domain/domain.js").Message[], PerformError> {
    const messages = yield* store.getThread(id);
    const now = yield* Clock.currentTimeMillis;
    const failed = new Set<string>();
    const refills = Effect.forEach(
      messages,
      (message) =>
        Effect.gen(function* () {
          yield* store.touchBody(message.id, now);
          if (message.bodyCached !== false && message.replyTo !== undefined) return;
          const hydrate = Effect.gen(function* () {
            const ref = yield* store.messageRef(message.id);
            const account = yield* store.getAccount(ref.accountId);
            if (account.enabled === false) return;
            const full = yield* providers
              .get(account.provider)
              .fetchMessage(account, ref.providerId);
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
                  attachments: full.attachments,
                  bodyCached: true,
                });
              }),
            );
          });
          // Remote data is optional for reading. Keep unknown Reply-To distinct from an empty header.
          yield* hydrate.pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                failed.add(message.id);
              }),
            ),
          );
        }),
      { concurrency: 3, discard: true },
    );
    // Bound the whole thread, including slow providers, rather than waiting per cached message.
    yield* refills.pipe(
      Effect.timeout("5 seconds"),
      Effect.catchTag("TimeoutError", () =>
        Effect.sync(() => {
          for (const message of messages)
            if (message.bodyCached === false || message.replyTo === undefined)
              failed.add(message.id);
        }),
      ),
    );
    return (yield* store.getThread(id)).map((message) =>
      failed.has(message.id) && (message.bodyCached === false || message.replyTo === undefined)
        ? { ...message, bodyRefresh: "failed" as const }
        : message,
    );
  });
  const backfillState: Effect.Effect<BackfillState[]> = Effect.gen(function* () {
    for (const a of yield* store.listAccounts) yield* store.getBackfillState(a.id);
    return yield* store.backfillStates;
  });
  return {
    backfillOlder,
    fetchOlder,
    readerThread,
    backfillState,
    pauseBackfill: (accountId: string, paused: boolean) =>
      store.setBackfillPaused(accountId, paused).pipe(Effect.andThen(progress), Effect.asVoid),
    cacheWindows: store.cacheWindows,
    setCacheWindow: (input: import("../domain/cache.js").CacheWindowInput) =>
      Effect.gen(function* () {
        yield* store.getAccount(input.accountId);
        yield* store.setCacheWindow(input);
        yield* store.evictBodies(input.accountId, yield* Clock.currentTimeMillis, true);
        yield* changed;
      }),
  };
}
