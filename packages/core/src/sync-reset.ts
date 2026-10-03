import { Effect, Option, Schema } from "effect";
import type { Account } from "./domain.js";
import type { Change, ProviderAdapter, Store } from "./services.js";
import { sha256Hex } from "./platform/crypto.js";
import { trackImapBackfill } from "./imap-cursor.js";
import { applyOpToLabels } from "./mail-ops.js";

export const ResetCandidate = Schema.Struct({
  providerId: Schema.String,
  /** Original UID is unsafe after a namespace reset; only Message-ID can verify it. */
  resetProviderId: Schema.optionalKey(Schema.String),
  rfcMessageId: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
});
export type ResetCandidate = typeof ResetCandidate.Type;
export type ResetChange = Extract<Change, { _tag: "Reset" | "DeleteLabel" | "RebuildFolder" }>;
export type ResetVerification =
  | { readonly kind: "gone"; readonly id: string }
  | {
      readonly kind: "present";
      readonly id: string;
      readonly providerId: string;
      readonly labels: readonly string[];
    };
const stateLabel = (label: string) =>
  ["UNREAD", "STARRED", "IMPORTANT"].includes(label) || label.startsWith("category:");
export const RESET_VERIFICATION_LIMIT = 500;
export const needsResetVerification = (local: number, candidates: number) =>
  candidates > Math.max(50, local * 0.2);

export const SyncResetDiagnostic = Schema.Struct({
  _tag: Schema.Literal("SyncResetDiagnostic"),
  provider: Schema.Literals(["gmail", "outlook", "imap"]),
  accountHash: Schema.String,
  folderHash: Schema.String,
  phase: Schema.Literals(["listing", "reset", "verification"]),
  listed: Schema.Number,
  kept: Schema.Number,
  local: Schema.Number,
  candidates: Schema.Number,
  verified: Schema.Number,
  incomplete: Schema.Number,
  deferred: Schema.Number,
});
export type SyncResetDiagnostic = typeof SyncResetDiagnostic.Type;
export function logSyncReset(
  account: Account,
  folder: string,
  counts: Omit<SyncResetDiagnostic, "_tag" | "provider" | "accountHash" | "folderHash">,
) {
  return Effect.logWarning({
    _tag: "SyncResetDiagnostic",
    provider: account.provider,
    accountHash: sha256Hex(account.id.toLowerCase()).slice(0, 16),
    folderHash: sha256Hex(folder).slice(0, 16),
    ...counts,
  } satisfies SyncResetDiagnostic);
}

/** Network verification runs outside SQLite transactions; unknown results stay durable. */
export function makeResetGuard(
  store: Store["Service"],
  adapter: ProviderAdapter,
  account: Account,
  counts: { changed: number; deleted: number },
  budget: { remaining: number },
) {
  const verify = Effect.fnUntraced(function* () {
    const pending = yield* store.pendingResetCandidates(account.id);
    const selected = pending.slice(0, budget.remaining);
    if (!selected.length || !adapter.verifyResetCandidates) return;
    budget.remaining -= selected.length;
    const results = yield* adapter
      .verifyResetCandidates(account, selected)
      .pipe(Effect.catch(() => Effect.succeed<readonly ResetVerification[]>([])));
    const requested = new Map(selected.map((item) => [item.providerId, item]));
    const completed = new Set<string>();
    let incomplete = 0;
    yield* store.transaction(
      Effect.gen(function* () {
        for (const result of results) {
          const candidate = requested.get(result.id);
          if (!candidate || completed.has(result.id)) continue;
          const id = yield* store.messageIdForProvider(account.id, result.id);
          if (result.kind === "gone") {
            yield* store.deleteMessage(account.id, result.id);
            yield* store.dropSyncedDrafts(account.id, result.id);
            if (id) counts.deleted++;
          } else if (id) {
            let local = yield* store.getMessage(id).pipe(Effect.orDie);
            if (
              candidate.labels.some(
                (label) =>
                  result.labels.includes(label) &&
                  !["UNREAD", "STARRED", "IMPORTANT"].includes(label) &&
                  !label.startsWith("category:"),
              )
            )
              incomplete++;
            if (candidate.resetProviderId) {
              const target = yield* store.messageIdForProvider(account.id, result.providerId);
              if (target) {
                const existing = yield* store.getMessage(target).pipe(Effect.orDie);
                if (existing.rfcMessageId !== local.rfcMessageId) continue;
                // Prefer the freshly refetched epoch row over invalidated cached flags/content.
                local = existing;
              }
            } else if (result.providerId !== result.id)
              yield* store.remapProviderIds(account.id, [
                { from: result.id, to: result.providerId },
              ]);
            const ops = (yield* store.pendingOpsForMessages(account.id, [
              result.providerId,
            ])).flatMap((pendingOp) =>
              pendingOp.op.kind === "saveDraft" ||
              pendingOp.op.kind === "deleteDraft" ||
              pendingOp.op.kind === "reconcile"
                ? []
                : [pendingOp.op],
            );
            // Graph/IMAP presence probes read location only; preserve current local flags.
            const verifiedLabels =
              account.provider === "gmail"
                ? [...result.labels]
                : [
                    ...result.labels.filter((label) => !stateLabel(label)),
                    ...local.labels.filter(stateLabel),
                  ];
            const labels = ops.reduce(
              (current, op) => applyOpToLabels(current, op, account.provider),
              verifiedLabels,
            );
            yield* store.upsertMessage(account.id, {
              ...local,
              providerId: result.providerId,
              labels,
              isUnread: labels.includes("UNREAD"),
              isStarred: labels.includes("STARRED"),
            });
            // A reused UID namespace gets a fresh epoch ID, never the invalidated handle.
            if (candidate.resetProviderId) yield* store.deleteMessage(account.id, result.id);
            if (account.provider === "imap") {
              const cursor = yield* store.getSyncCursor(account.id);
              const tracked = trackImapBackfill(cursor, [
                {
                  ...local,
                  providerId: result.providerId,
                  labels,
                  isUnread: labels.includes("UNREAD"),
                  isStarred: labels.includes("STARRED"),
                },
              ]);
              if (Option.isSome(tracked))
                yield* store.saveSyncCursor(account.id, tracked.value, false);
            }
            counts.changed++;
          }
          completed.add(result.id);
        }
        // Rotate uncertain ids so a permanently failing first page cannot starve later ids.
        yield* store.saveResetCandidates(account.id, [
          ...pending
            .slice(selected.length)
            .filter((candidate) => !completed.has(candidate.providerId)),
          ...selected.filter((candidate) => !completed.has(candidate.providerId)),
        ]);
      }),
    );
    yield* logSyncReset(account, "account", {
      phase: "verification",
      listed: 0,
      kept: 0,
      local: pending.length,
      candidates: pending.length,
      verified: completed.size,
      incomplete,
      deferred: pending.length - completed.size,
    });
  });
  const reset = Effect.fnUntraced(function* (change: ResetChange) {
    const snapshot = yield* store.resetCandidates(account.id, change);
    const pending = yield* store.pendingResetCandidates(account.id);
    const guarded =
      change.partial === true ||
      needsResetVerification(snapshot.local, snapshot.candidates.length) ||
      pending.length > 0;
    const folder =
      change._tag === "DeleteLabel"
        ? change.label
        : change._tag === "RebuildFolder"
          ? change.previous.path
          : "account";
    yield* logSyncReset(account, folder, {
      phase: "reset",
      listed: change.keep?.length ?? 0,
      kept: change.keep?.length ?? 0,
      local: snapshot.local,
      candidates: snapshot.candidates.length,
      verified: 0,
      incomplete: 0,
      deferred: guarded ? snapshot.candidates.length : 0,
    });
    yield* store.transaction(
      Effect.gen(function* () {
        if (guarded) {
          const keep = new Set(change.keep ?? []);
          const merged = new Map(
            pending
              .filter((item) => !keep.has(item.providerId))
              .map((item) => [item.providerId, item]),
          );
          for (const candidate of snapshot.candidates) merged.set(candidate.providerId, candidate);
          yield* store.saveResetCandidates(account.id, [...merged.values()]);
        } else {
          for (const candidate of snapshot.candidates) {
            yield* store.deleteMessage(account.id, candidate.providerId);
            yield* store.dropSyncedDrafts(account.id, candidate.providerId);
            counts.deleted++;
          }
        }
        if (change._tag === "Reset") yield* store.resetBackfill(account.id);
      }),
    );
  });
  return { reset, verify };
}
