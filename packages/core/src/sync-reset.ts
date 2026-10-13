import { Clock, Effect, Option, Schema } from "effect";
import { isOutlookClassification, type Account } from "./domain.js";
import type { Change, ProviderAdapter, Store } from "./services.js";
import { sha256Hex } from "./platform/crypto.js";
import { trackImapBackfill } from "./imap-cursor.js";
import { applyOpToLabels } from "./mail-ops.js";
import type { SyncHealth } from "./sync-health.js";

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
export const stateLabel = (label: string) =>
  ["UNREAD", "STARRED", "IMPORTANT"].includes(label) || label.startsWith("category:");
export const outlookStateLabel = (label: string) =>
  stateLabel(label) || isOutlookClassification(label);
export const RESET_VERIFICATION_LIMIT = 500;
/**
 * Outlook verifies 20 ids per $batch request, so 2000 is 100 requests. A bulk delete on the
 * server reaches the local store within a few syncs; a throttled batch still defers the rest.
 */
export const OUTLOOK_RESET_VERIFICATION_LIMIT = 2000;
export const resetVerificationLimit = (provider: Account["provider"]) =>
  provider === "outlook" ? OUTLOOK_RESET_VERIFICATION_LIMIT : RESET_VERIFICATION_LIMIT;
/** One sync's verification budget per provider, shared by that provider's accounts. */
export const resetBudgets = (): Record<Account["provider"], { remaining: number }> => ({
  gmail: { remaining: RESET_VERIFICATION_LIMIT },
  outlook: { remaining: OUTLOOK_RESET_VERIFICATION_LIMIT },
  imap: { remaining: RESET_VERIFICATION_LIMIT },
});
export const STALE_SWEEP_LIMIT = 500;
const staleFingerprint = (candidate: ResetCandidate) =>
  sha256Hex(
    JSON.stringify([candidate.providerId, candidate.rfcMessageId, candidate.labels.toSorted()]),
  ).slice(0, 16);

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
  return Effect.logInfo({
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
  const attempted = new Set<string>();
  const sweepBudget = { remaining: STALE_SWEEP_LIMIT };
  let verificationDeferred = false;
  const verify = Effect.fnUntraced(function* (candidates?: readonly ResetCandidate[]) {
    const pending = candidates ?? (yield* store.pendingResetCandidates(account.id));
    const activeBudget = candidates === undefined ? budget : sweepBudget;
    const selected = pending.slice(
      0,
      Math.min(
        activeBudget.remaining,
        candidates === undefined ? resetVerificationLimit(account.provider) : STALE_SWEEP_LIMIT,
      ),
    );
    if (!selected.length || !adapter.verifyResetCandidates) return;
    activeBudget.remaining -= selected.length;
    for (const candidate of selected) attempted.add(candidate.providerId);
    const results = yield* adapter
      .verifyResetCandidates(account, selected)
      .pipe(Effect.catch(() => Effect.succeed<readonly ResetVerification[]>([])));
    const requested = new Map(selected.map((item) => [item.providerId, item]));
    const completed = new Set<string>();
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
            const preservedState = account.provider === "outlook" ? outlookStateLabel : stateLabel;
            const verifiedLabels =
              account.provider === "gmail"
                ? [...result.labels]
                : [
                    ...result.labels.filter((label) => !preservedState(label)),
                    ...local.labels.filter(preservedState),
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
          if (result.kind === "present" && !result.labels.includes("DRAFT"))
            yield* store.dropSyncedDrafts(account.id, result.id);
          completed.add(result.id);
        }
        // Rotate uncertain ids so a permanently failing first page cannot starve later ids.
        // Re-read the queue: candidates queued during the network call stay.
        if (candidates === undefined) {
          const current = yield* store.pendingResetCandidates(account.id);
          yield* store.saveResetCandidates(account.id, [
            ...current.filter((candidate) => !requested.has(candidate.providerId)),
            ...current.filter(
              (candidate) =>
                requested.has(candidate.providerId) && !completed.has(candidate.providerId),
            ),
          ]);
        }
      }),
    );
    if (candidates !== undefined)
      yield* store.saveStaleSweepVerified(
        account.id,
        selected.filter((candidate) => completed.has(candidate.providerId)).map(staleFingerprint),
        yield* Clock.currentTimeMillis,
      );
    verificationDeferred ||= completed.size < selected.length;
    yield* logSyncReset(account, "account", {
      phase: "verification",
      listed: 0,
      kept: 0,
      local: pending.length,
      candidates: pending.length,
      verified: completed.size,
      incomplete: selected.length - completed.size,
      deferred: pending.length - completed.size,
    });
  });
  const reset = Effect.fnUntraced(function* (change: ResetChange) {
    const snapshot = yield* store.resetCandidates(account.id, change);
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
      deferred: snapshot.candidates.length,
    });
    yield* store.transaction(
      Effect.gen(function* () {
        const pending = yield* store.pendingResetCandidates(account.id);
        // Every keep-set omission is a candidate, irrespective of count or listing completeness.
        const keep = new Set(change.keep ?? []);
        const merged = new Map(
          pending
            .filter((item) => !keep.has(item.providerId))
            .map((item) => [item.providerId, item]),
        );
        for (const candidate of snapshot.candidates) merged.set(candidate.providerId, candidate);
        yield* store.saveResetCandidates(account.id, [...merged.values()]);
        if (change._tag === "Reset") yield* store.resetBackfill(account.id);
      }),
    );
  });
  const sweep = Effect.fnUntraced(function* (health: () => Effect.Effect<SyncHealth>) {
    if (!adapter.verifyResetCandidates || sweepBudget.remaining <= 0 || verificationDeferred)
      return;
    const now = yield* Clock.currentTimeMillis;
    const state = yield* store.claimStaleSweep(account.id, now);
    if (Option.isNone(state)) return;
    const report = yield* health();
    const scopes = report.folders
      .filter(
        (folder) => folder.server.kind === "available" && folder.local.total > folder.server.total,
      )
      .map((folder) => folder.scope);
    if (!scopes.length) return;
    const selected = yield* store.staleCandidates(
      account.id,
      scopes,
      account.provider === "imap",
      state.value.after,
      sweepBudget.remaining,
    );
    // Counts identify suspect folders, not missing identities. Probe each bounded
    // page; only an explicit absence or current server labels can change a row.
    yield* store.saveStaleSweepPosition(account.id, selected.at(-1)?.providerId ?? "");
    const queued = new Set(
      (yield* store.pendingResetCandidates(account.id)).map((candidate) => candidate.providerId),
    );
    const unchecked = selected.filter(
      (candidate) =>
        state.value.verified?.[staleFingerprint(candidate)] === undefined &&
        !attempted.has(candidate.providerId) &&
        !queued.has(candidate.providerId),
    );
    if (!unchecked.length) return;
    let knownDrafts = new Set<string>();
    if (unchecked.some((candidate) => candidate.draftOnly) && adapter.draftMessageIds) {
      const page = yield* adapter.draftMessageIds(account).pipe(
        Effect.map(Option.some),
        Effect.catch(() => Effect.succeed(Option.none())),
      );
      if (Option.isNone(page)) {
        verificationDeferred = true;
        return;
      }
      knownDrafts = new Set(page.value);
    }
    yield* verify(
      unchecked.filter(
        (candidate) => !candidate.draftOnly || !knownDrafts.has(candidate.providerId),
      ),
    );
  });
  const enqueue = (providerIds: readonly string[]) =>
    store.transaction(
      Effect.gen(function* () {
        const pending = new Map(
          (yield* store.pendingResetCandidates(account.id)).map((candidate) => [
            candidate.providerId,
            candidate,
          ]),
        );
        for (const providerId of providerIds) {
          if (pending.has(providerId)) continue;
          const id = yield* store.messageIdForProvider(account.id, providerId);
          // Nothing local to clear: a removal of mail this device never stored, such as
          // old mail outside the sync window. A synced draft still needs its verdict.
          if (!id) {
            const draft = yield* store.draftByRemoteMessage(account.id, providerId);
            if (Option.isNone(draft)) continue;
          }
          const local = id ? yield* store.getMessage(id).pipe(Effect.orDie) : null;
          pending.set(providerId, {
            providerId,
            rfcMessageId: local?.rfcMessageId ?? null,
            labels: local?.labels ?? [],
          });
        }
        yield* store.saveResetCandidates(account.id, [...pending.values()]);
      }),
    );
  return { reset, verify, sweep, enqueue, isDeferred: () => verificationDeferred };
}
