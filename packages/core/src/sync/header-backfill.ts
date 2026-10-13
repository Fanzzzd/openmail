import { Clock, Effect } from "effect";
import type { Account } from "../domain/account.js";
import type { ProviderAdapter } from "../providers/adapter.js";
import type { Store } from "../store/service.js";
import { retryAfterMillis } from "../providers/provider-retry.js";
import { ProviderError } from "../domain/errors.js";
import type {
  CachedHeaders,
  HeaderBackfillState,
  HeaderBackfillCandidate,
} from "./sync-records.js";

/** Headers needed for identity, threading, local header searches and security. */
export const CACHED_HEADER_NAMES = [
  "message-id",
  "references",
  "in-reply-to",
  "from",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "delivered-to",
  "return-path",
  "received",
  "sender",
  "list-id",
  "list-post",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "list-owner",
  "list-help",
  "list-archive",
  "list-subscribe",
  "authentication-results",
  "arc-authentication-results",
  "dkim-signature",
  "received-spf",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "content-language",
  "x-priority",
  "importance",
  "x-mailer",
];

/** Fold continuations and retain repeated fields, unlike a Map of MIME headers. */
export function cachedHeaders(
  id: string,
  raw: string,
): Extract<CachedHeaders, { kind: "headers" }> {
  const headers = raw
    .replace(/\r?\n[ \t]+/g, " ")
    .split(/\r?\n/)
    .flatMap((line) => {
      const colon = line.indexOf(":");
      return colon > 0
        ? [{ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() }]
        : [];
    });
  return {
    kind: "headers",
    id,
    headers,
    rfcMessageId: headers.find((h) => h.name === "message-id")?.value || null,
  };
}

export const HEADER_BACKFILL_LIMIT = 500;
export const HEADER_BACKFILL_BATCH = 20;

/** Independent of listing cursors. Commit each page and its position together. */
export function backfillCachedHeaders(
  store: Store["Service"],
  adapter: ProviderAdapter,
  account: Account,
) {
  return Effect.gen(function* () {
    if (!adapter.fetchCachedHeaders) return;
    const saved = yield* store.headerBackfillState(account.id);
    if (saved.kind === "done") return;
    let state: Extract<HeaderBackfillState, { kind: "running" }> = saved;
    if ((state.retryAt ?? 0) > (yield* Clock.currentTimeMillis)) return;
    for (let remaining = HEADER_BACKFILL_LIMIT; remaining > 0;) {
      const current = yield* store.getAccount(account.id).pipe(Effect.orDie);
      if (current.enabled === false || current.needsReauth) return;
      const rows: readonly (typeof HeaderBackfillCandidate.Type)[] =
        yield* store.headerBackfillCandidates(
          account.id,
          state.after,
          Math.min(remaining, HEADER_BACKFILL_BATCH),
        );
      const last = rows.at(-1);
      if (!last) {
        yield* store.saveHeaderBackfillState(account.id, {
          kind: "done",
          completedAt: yield* Clock.currentTimeMillis,
        });
        return;
      }
      const results = yield* adapter
        .fetchCachedHeaders(
          current,
          rows.map((row) => row.providerId),
        )
        .pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              yield* store.saveHeaderBackfillState(account.id, {
                ...state,
                retryAt:
                  now +
                  Math.max(
                    60_000,
                    retryAfterMillis(
                      error._tag === "ProviderError" ? error.retryAfter : undefined,
                      now,
                    ),
                  ),
              });
              return yield* Effect.fail(error);
            }),
          ),
        );
      const byId = new Map(results.map((result) => [result.id, result]));
      // Missing replies and failed batches cannot advance the durable cursor.
      if (rows.some((row) => !byId.has(row.providerId))) {
        yield* store.saveHeaderBackfillState(account.id, {
          ...state,
          retryAt: (yield* Clock.currentTimeMillis) + 60_000,
        });
        yield* new ProviderError({ message: "Header backfill response incomplete" });
      }
      state = { kind: "running", after: { date: last.date, id: last.id } };
      yield* store.transaction(
        Effect.gen(function* () {
          for (const row of rows) {
            const result = byId.get(row.providerId);
            if (result?.kind === "headers")
              yield* store.updateCachedHeaders(account.id, row, result);
          }
          yield* store.saveHeaderBackfillState(account.id, state);
        }),
      );
      remaining -= rows.length;
    }
  });
}

/** Keep the first field, unless a provider's existing JSON mapping keeps the last. */
export function firstHeaders(
  cached: Pick<Extract<CachedHeaders, { kind: "headers" }>, "headers">,
  duplicate: "first" | "last" = "first",
): Map<string, string> {
  const out = new Map<string, string>();
  for (const header of cached.headers) {
    const name = header.name.toLowerCase();
    if (duplicate === "last" || !out.has(name)) out.set(name, header.value);
  }
  return out;
}
