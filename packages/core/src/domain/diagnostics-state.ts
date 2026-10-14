import { Schema } from "effect";
import { storedSyncFailureReason, SyncFailureReason } from "../sync/sync-failure.js";
import { Provider, type Account } from "./account.js";
import { isKeychainLocked, ReauthReason } from "./errors.js";

/**
 * One account's sync state for the diagnostics file. Counts and enums only: accounts are
 * numbered by list position, and no address, name, folder, subject or error text appears.
 */
export const AccountDiagnostics = Schema.Struct({
  index: Schema.Int,
  provider: Provider,
  state: Schema.Literals([
    "ok",
    "disabled",
    "needs-reauth",
    "keychain-locked",
    "sync-failed",
    "never-synced",
  ]),
  reauthReason: Schema.optionalKey(ReauthReason),
  syncFailure: Schema.optionalKey(SyncFailureReason),
  /** Seconds since the last successful sync; null before the first one. */
  lastSyncAgeSeconds: Schema.NullOr(Schema.Int),
  /** Queued local changes waiting for the provider. */
  pendingOps: Schema.Int,
  /** Queued changes waiting out a retry delay. */
  retryingOps: Schema.Int,
  /** Queued changes that have failed at least once. */
  failedOps: Schema.Int,
  /** Messages in the outbox. */
  queuedSends: Schema.Int,
});
export type AccountDiagnostics = typeof AccountDiagnostics.Type;

export const DiagnosticsState = Schema.Struct({
  /** `PRAGMA user_version` of the open database. */
  schemaVersion: Schema.Int,
  accounts: Schema.Array(AccountDiagnostics),
});
export type DiagnosticsState = typeof DiagnosticsState.Type;

export interface AccountOpCounts {
  readonly pending: number;
  readonly retrying: number;
  readonly failed: number;
}

const count = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

/** Builds the state from the account list and per-account queue counts. */
export function diagnosticsState(input: {
  readonly schemaVersion: number;
  readonly accounts: readonly Account[];
  readonly ops: ReadonlyMap<string, AccountOpCounts>;
  readonly queuedSends: ReadonlyMap<string, number>;
  readonly now: number;
}): DiagnosticsState {
  return {
    schemaVersion: count(input.schemaVersion),
    accounts: input.accounts.map((account, index): AccountDiagnostics => {
      const ops = input.ops.get(account.id);
      const keychain = isKeychainLocked(account.lastSyncError);
      const state: AccountDiagnostics["state"] =
        account.enabled === false
          ? "disabled"
          : account.needsReauth
            ? "needs-reauth"
            : keychain
              ? "keychain-locked"
              : account.lastSyncError
                ? "sync-failed"
                : account.lastSyncedAt === null
                  ? "never-synced"
                  : "ok";
      return {
        index,
        provider: account.provider,
        state,
        ...(account.needsReauth && account.reauthReason
          ? { reauthReason: account.reauthReason }
          : {}),
        ...(account.lastSyncError && !keychain
          ? { syncFailure: storedSyncFailureReason(account.lastSyncError) }
          : {}),
        lastSyncAgeSeconds:
          account.lastSyncedAt === null
            ? null
            : Math.max(0, Math.trunc((input.now - account.lastSyncedAt) / 1000)),
        pendingOps: count(ops?.pending),
        retryingOps: count(ops?.retrying),
        failedOps: count(ops?.failed),
        queuedSends: count(input.queuedSends.get(account.id)),
      };
    }),
  };
}
