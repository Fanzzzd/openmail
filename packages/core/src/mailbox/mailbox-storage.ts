import { Effect, Option, Ref } from "effect";
import { adaptiveBodyLimit, cacheAccounting } from "../domain/cache.js";
import type { CacheCompactionResult } from "../domain/cache.js";
import type { MailboxRuntimeState } from "./mailbox-runtime.js";
import type { Store } from "../store/service.js";
import type { AttachmentFileCache } from "../platform/runtime.js";
import { CacheStorage } from "../platform/cache-storage.js";
import { cacheIO } from "./mailbox-shared.js";
import type { MailboxSync } from "./mailbox.js";

export const makeStorageMailbox = Effect.fn("makeStorageMailbox")(function* (
  store: Store["Service"],
  runtime: MailboxRuntimeState,
  attachments: AttachmentFileCache | undefined,
  readOnly: boolean,
  changed: Effect.Effect<unknown>,
) {
  const storage = yield* CacheStorage;
  const measure = Effect.gen(function* () {
    const files = yield* storage.measure(yield* store.cacheDatabaseFile);
    const pages = yield* store.cacheDatabaseSize;
    const bodyBytes = yield* store.cachedBodyBytes;
    const attachmentBytes = attachments ? yield* cacheIO(() => attachments.size(), 0) : 0;
    const size = cacheAccounting(pages, bodyBytes, attachmentBytes, files);
    const canReclaim = !(yield* store.cacheNeedsVacuum);
    return {
      ...size,
      canReclaim,
      ...adaptiveBodyLimit(size, files.disk, yield* store.prefs, canReclaim),
    };
  });
  let previousLowDisk = false;
  const enforceCacheBudget = (force = false) =>
    runtime.syncLock
      .withPermitsIfAvailable(1)(
        runtime.flushLock.withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            if (readOnly) return;
            const size = yield* measure;
            const pressureChanged = previousLowDisk !== size.lowDisk;
            previousLowDisk = size.lowDisk;
            const count =
              size.effectiveBodyBytes === null
                ? 0
                : yield* store.evictBodyBudget(
                    size.effectiveBodyBytes,
                    force || size.lowDisk,
                    true,
                  );
            if (
              count > 0 ||
              (size.lowDisk && size.canReclaim && size.reusableBytes > 0) ||
              size.reusableBytes >= 1024 ** 2 ||
              size.walBytes >= 8 * 1024 ** 2
            ) {
              // Shrink only after the user has enabled incremental vacuum once.
              yield* store.reclaimCachePages;
              yield* changed;
            } else if (pressureChanged) {
              yield* changed;
            }
          }),
        ),
      )
      .pipe(Effect.asVoid);
  const compactCache: Effect.Effect<CacheCompactionResult> = Effect.gen(function* () {
    if (readOnly) return "read-only";
    if (Option.isSome(yield* Ref.get(runtime.inflight))) return "busy";
    const result = yield* runtime.syncLock.withPermitsIfAvailable(1)(
      runtime.flushLock.withPermitsIfAvailable(1)(
        Effect.gen(function* () {
          const size = yield* measure;
          // A first VACUUM can need twice the current database size temporarily.
          if (
            (yield* store.cacheNeedsVacuum) &&
            size.freeDiskBytes !== null &&
            size.freeDiskBytes < 2 * size.totalBytes
          )
            return "low-disk" as const;
          const status = yield* store.compactCache(readOnly);
          yield* changed;
          return status;
        }),
      ),
    );
    return Option.isSome(result) && Option.isSome(result.value) ? result.value.value : "busy";
  });
  return {
    enforceCacheBudget,
    cacheDatabaseSize: measure,
    compactCache,
    cacheSize: Effect.gen(function* () {
      const bodies = yield* store.bodySizes;
      return yield* Effect.forEach(yield* store.listAccounts, (a) =>
        Effect.gen(function* () {
          const attachmentBytes = attachments ? yield* cacheIO(() => attachments.size(a.id), 0) : 0;
          return {
            accountId: a.id,
            bodyBytes: bodies.find((b) => b.accountId === a.id)?.bytes ?? 0,
            attachmentBytes,
          };
        }),
      );
    }),
    clearCache: (accountId?: string) =>
      Effect.gen(function* () {
        runtime.attachmentEpoch++;
        runtime.attachmentCache.clear();
        if (attachments) yield* cacheIO(() => attachments.clear(accountId), undefined);
        for (const a of yield* store.listAccounts)
          if (accountId === undefined || a.id === accountId) yield* store.clearBodies(a.id);
        yield* changed;
      }),
  } satisfies Pick<
    MailboxSync,
    "cacheDatabaseSize" | "compactCache" | "cacheSize" | "clearCache"
  > & {
    enforceCacheBudget: unknown;
  };
});
