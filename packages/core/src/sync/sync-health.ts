import { Clock, Effect, Option, Schema } from "effect";
import { Provider } from "../domain/account.js";
import { DEFAULT_CACHE_WINDOWS } from "../domain/cache.js";
import { readCursor, parseUidSet } from "../providers/imap/imap-cursor.js";
import { sha256Hex } from "../platform/crypto.js";
import type { Providers } from "../providers/adapter.js";
import type { Store } from "../store/service.js";
import { FolderStatus, Count, HealthCounts } from "./sync-records.js";
import { providerCapabilities } from "../providers/capabilities.js";

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
const OutlookDraftExcess = Schema.Struct({
  code: Schema.Literal("OUTLOOK_DRAFT_COUNT_EXCESS"),
  cachedTotal: Count,
  unmirroredDraftTotal: Count,
  sampled: Count,
  gone: Count,
  outsideDrafts: Count,
  presentInDrafts: Count,
  unverified: Count,
});
export const HealthFolder = Schema.Struct({
  diagnostic: Schema.optionalKey(OutlookDraftExcess),
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

export function makeSyncHealth(
  store: Store["Service"],
  providers: Providers["Service"],
  options: { diagnoseDraftExcess?: boolean } = {},
) {
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
    const caps = providerCapabilities(account.provider);
    // Labels stack, so labels seen on messages count as scopes too.
    const labels = yield* store.syncHealthLabels(accountId, caps.organization === "labels");
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
                  (!caps.categories || !label.startsWith("category:")),
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
    // Optional rechecks start only after all primary summaries have settled.
    const checkedFolders = yield* Effect.forEach(
      folders,
      (folder) =>
        Effect.gen(function* () {
          if (
            folder.server.kind !== "available" ||
            folder.local.total <= folder.server.total ||
            !(
              (account.provider === "gmail" &&
                (folder.scope === "DRAFT" || folder.scope.startsWith("CATEGORY_"))) ||
              (account.provider === "outlook" && folder.scope === "DRAFT")
            )
          )
            return folder;
          const remaining = 10_000 - ((yield* Clock.currentTimeMillis) - now);
          if (remaining <= 0) return folder;
          const summary = folder.server;
          const server = yield* providers
            .get(account.provider)
            .folderStatus(account, folder.scope, { localTotal: folder.local.total, summary })
            .pipe(
              Effect.timeout(Math.min(1000, remaining)),
              Effect.map((status): HealthFolder["server"] => ({ kind: "available", ...status })),
              Effect.catch(() => Effect.succeed(summary)),
            );
          return {
            ...folder,
            server,
            verdict: healthVerdict(folder.local, server, folder.headerWindow !== null),
          };
        }),
      { concurrency: 1 },
    );
    const diagnosed = yield* Effect.forEach(checkedFolders, (folder) =>
      Effect.gen(function* () {
        if (
          options.diagnoseDraftExcess === false ||
          account.provider !== "outlook" ||
          folder.scope !== "DRAFT" ||
          folder.server.kind !== "available" ||
          folder.local.total <= folder.server.total
        )
          return folder;
        const local = yield* store.syncHealthLocal(accountId, "DRAFT", false);
        // Bounded metadata reads establish absence/location without editing cache or composers.
        const sample = yield* store.staleCandidates(accountId, ["DRAFT"], false, "", 50);
        const adapter = providers.get("outlook");
        const remaining = Math.min(1000, 10_000 - ((yield* Clock.currentTimeMillis) - now));
        const results =
          adapter.verifyResetCandidates && remaining > 0
            ? yield* adapter.verifyResetCandidates(account, sample).pipe(
                Effect.timeout(remaining),
                Effect.catch(() => Effect.succeed([])),
              )
            : [];
        const requested = new Set(sample.map((candidate) => candidate.providerId));
        const completed = new Set<string>();
        let gone = 0,
          outsideDrafts = 0,
          presentInDrafts = 0;
        for (const result of results) {
          if (!requested.has(result.id) || completed.has(result.id)) continue;
          completed.add(result.id);
          if (result.kind === "gone") gone++;
          else if (result.labels.includes("DRAFT")) presentInDrafts++;
          else outsideDrafts++;
        }
        return {
          ...folder,
          diagnostic: {
            code: "OUTLOOK_DRAFT_COUNT_EXCESS",
            cachedTotal: local.cachedTotal,
            unmirroredDraftTotal: local.unmirroredDraftTotal,
            sampled: sample.length,
            gone,
            outsideDrafts,
            presentInDrafts,
            unverified: sample.length - completed.size,
          },
        } satisfies HealthFolder;
      }),
    );
    return {
      provider: account.provider,
      accountDomainHash: sha256Hex(
        account.email.slice(account.email.lastIndexOf("@") + 1).toLowerCase(),
      ),
      checkedAt: now,
      cursorAgeMs,
      pendingOps,
      folders: diagnosed,
    } satisfies SyncHealth;
  });
}
