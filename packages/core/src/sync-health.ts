import { Clock, Effect, Option, Schema } from "effect";
import { Provider } from "./domain.js";
import { DEFAULT_CACHE_WINDOWS } from "./cache.js";
import { readCursor, parseUidSet } from "./imap-cursor.js";
import { sha256Hex } from "./platform/crypto.js";
import type { Providers, Store } from "./services.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const HealthCounts = Schema.Struct({
  total: Count,
  unread: Count,
  threads: Schema.NullOr(Count),
});
export type HealthCounts = typeof HealthCounts.Type;
export const FolderStatus = Schema.Struct({
  ...HealthCounts.fields,
  uidNext: Schema.NullOr(Count),
  uidValidity: Schema.NullOr(Schema.String.check(Schema.isPattern(/^\d+$/))),
});
export type FolderStatus = typeof FolderStatus.Type;
const ServerStatus = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("available"), ...FolderStatus.fields }),
  Schema.Struct({ kind: Schema.Literal("unavailable") }),
]);
export const HealthVerdict = Schema.Literals([
  "in sync",
  "local has fewer — window",
  "local has fewer — missing",
  "local has more — stale",
  "server unavailable",
]);
export type HealthVerdict = typeof HealthVerdict.Type;
export const HealthFolder = Schema.Struct({
  scope: Schema.String,
  local: HealthCounts,
  server: ServerStatus,
  bodyCacheWindowDays: Schema.NullOr(Count),
  headerWindow: Schema.NullOr(
    Schema.Struct({ days: Count, messageLimit: Count, before: Schema.NullOr(Schema.Number) }),
  ),
  cursorAgeMs: Schema.NullOr(Count),
  pendingOps: Count,
  verdict: HealthVerdict,
});
export type HealthFolder = typeof HealthFolder.Type;
export const SyncHealth = Schema.Struct({
  provider: Provider,
  accountDomainHash: Schema.String,
  checkedAt: Schema.Number,
  cursorAgeMs: Schema.NullOr(Count),
  pendingOps: Count,
  folders: Schema.Array(HealthFolder),
});
export type SyncHealth = typeof SyncHealth.Type;

const GMAIL_SCOPES = [
  "INBOX",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "STARRED",
  "IMPORTANT",
  "UNREAD",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
];
const OUTLOOK_SCOPES = ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "ARCHIVE"];
const SYSTEM_SCOPES = new Set([...GMAIL_SCOPES, ...OUTLOOK_SCOPES]);

/** Counts compare message rows, never conversation rows or cached bodies. */
export function healthVerdict(
  local: HealthCounts,
  server: HealthFolder["server"],
  windowed: boolean,
): HealthVerdict {
  if (server.kind === "unavailable") return "server unavailable";
  if (local.total > server.total || local.unread > server.unread) return "local has more — stale";
  if (local.total < server.total)
    return windowed ? "local has fewer — window" : "local has fewer — missing";
  if (local.unread < server.unread) return "local has fewer — missing";
  return "in sync";
}

/** Shared exports contain only numbers, fixed vocabulary and the account's domain hash.
 * Custom scope IDs/paths can contain addresses or private project names. */
export function redactSyncHealth(report: SyncHealth): SyncHealth {
  return {
    ...report,
    folders: report.folders.map((folder, index) => ({
      ...folder,
      scope: SYSTEM_SCOPES.has(folder.scope) ? folder.scope : `folder:${index + 1}`,
    })),
  };
}

export function makeSyncHealth(store: Store["Service"], providers: Providers["Service"]) {
  return Effect.fn("Mailbox.syncHealth")(function* (accountId: string) {
    const account = yield* store.getAccount(accountId);
    const now = yield* Clock.currentTimeMillis;
    const cursor = yield* store.getSyncCursor(accountId);
    const outlookWindowed =
      account.provider === "outlook" &&
      Option.isSome(cursor) &&
      Option.isSome(
        Schema.decodeUnknownOption(
          Schema.fromJsonString(Schema.Struct({ __windowDays: Schema.Literal("90") })),
        )(cursor.value),
      );
    const labels = yield* store.syncHealthLabels(accountId, account.provider === "gmail");
    const custom = (yield* store.cacheWindows).filter((entry) => entry.accountId === accountId);
    const windows = [
      ...DEFAULT_CACHE_WINDOWS.filter((entry) => !custom.some((w) => w.label === entry.label)),
      ...custom,
    ];
    const backfill = (yield* store.backfillStates).find((entry) => entry.accountId === accountId);
    const pendingOps = (yield* store.listPendingOps).filter(
      (op) => op.accountId === accountId,
    ).length;
    const cursorAgeMs =
      Option.isSome(cursor) && account.lastSyncedAt !== null
        ? Math.max(0, now - account.lastSyncedAt)
        : null;
    const paths = readCursor(cursor).folders;
    const scopes =
      account.provider === "imap"
        ? Object.keys(paths)
        : [
            ...new Set([
              ...(account.provider === "gmail" ? GMAIL_SCOPES : OUTLOOK_SCOPES),
              ...labels.filter(
                (label) =>
                  !["SNOOZED", "OUTBOX"].includes(label) &&
                  (account.provider !== "outlook" || !label.startsWith("category:")),
              ),
            ]),
          ];
    const folders = yield* Effect.forEach(
      scopes,
      (scope) =>
        Effect.gen(function* () {
          const local = yield* store.syncHealthLocal(accountId, scope, account.provider === "imap");
          const label = account.provider === "imap" ? (local.label ?? scope) : scope;
          const bodyCacheWindowDays =
            (
              windows.find((entry) => entry.label === label) ??
              windows.find((entry) => entry.label === "ALL")
            )?.days ?? null;
          // Cache settings expire bodies only. Header gaps can be expected while the
          // provider's bounded initial snapshot still awaits historical backfill.
          const headerWindow =
            (account.provider !== "outlook" || outlookWindowed) &&
            account.lastSyncedAt !== null &&
            backfill?.done !== true
              ? {
                  days: 90,
                  messageLimit:
                    account.provider === "outlook"
                      ? 5000
                      : account.provider === "gmail"
                        ? 2000
                        : 1000,
                  before: backfill?.before ?? null,
                }
              : null;
          const server = yield* providers
            .get(account.provider)
            .folderStatus(account, scope)
            .pipe(
              Effect.timeout(Math.max(1, 10_000 - ((yield* Clock.currentTimeMillis) - now))),
              Effect.map((status): HealthFolder["server"] => ({ kind: "available", ...status })),
              // Never serialize provider errors: they can contain URLs and credentials.
              Effect.catch(() => Effect.succeed<HealthFolder["server"]>({ kind: "unavailable" })),
            );
          const tracked = account.provider === "imap" ? paths[scope] : undefined;
          const missingTracked =
            tracked !== undefined && local.total < parseUidSet(tracked.uids).length;
          return {
            scope,
            local: { total: local.total, unread: local.unread, threads: local.threads },
            server,
            bodyCacheWindowDays,
            headerWindow,
            cursorAgeMs,
            pendingOps: local.pendingOps,
            verdict: healthVerdict(local, server, headerWindow !== null && !missingTracked),
          } satisfies HealthFolder;
        }),
      { concurrency: 4 },
    );
    return {
      provider: account.provider,
      accountDomainHash: sha256Hex(
        account.email.slice(account.email.lastIndexOf("@") + 1).toLowerCase(),
      ),
      checkedAt: now,
      cursorAgeMs,
      pendingOps,
      folders,
    } satisfies SyncHealth;
  });
}
