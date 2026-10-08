import { Trans } from "@lingui/react/macro";

import type { Account, SyncState } from "../../../shared/api";
import { syncNow, useRunMail } from "../state/mail";

const box = "rounded-lg px-3 py-2 text-[12px] leading-relaxed";
const danger = `${box} bg-red-500/[0.08] text-red-700 dark:text-red-300`;
const action = "font-semibold hover:underline";

/**
 * Sync errors other than expired sign-ins. Core reports each failure as "accountId: message"; an
 * expired account fails every sync and has its own notice, so its error is left out.
 */
export function syncFailures(accounts: readonly Account[], syncState: SyncState) {
  const expired = accounts.filter((a) => a.needsReauth).map((a) => `${a.id}: `);
  return syncState.errors.filter((e) => !expired.some((prefix) => e.startsWith(prefix)));
}

/** An account whose token expired: say so and offer the sign-in. */
export function ReauthNotice({
  account,
  onReauth,
  className = "",
}: {
  account: Account;
  onReauth: (account: Account) => void;
  className?: string;
}) {
  return (
    <div className={`${danger} ${className}`}>
      <p>
        <Trans>{account.email}'s sign-in has expired. Sync is paused.</Trans>
      </p>
      <button type="button" onClick={() => onReauth(account)} className={`mt-1 ${action}`}>
        <Trans>Sign in again</Trans>
      </button>
    </div>
  );
}

/**
 * Connection and sync problems above the message list. The docked sidebar shows sign-in and sync
 * failures itself, so the list repeats them only when the sidebar is a rail, a drawer or hidden.
 */
export function MailStatusNotice({
  accounts,
  space,
  online,
  syncState,
  accountIssues,
  onReauth,
}: {
  /** Every account: sync errors cover them all. */
  accounts: readonly Account[];
  /** The accounts of the open space, whose sign-ins and names the notice shows. */
  space: readonly Account[];
  online: boolean;
  syncState: SyncState;
  /** Show sign-in and sync failures; false while the docked sidebar shows them. */
  accountIssues: boolean;
  onReauth: (account: Account) => void;
}) {
  const run = useRunMail();
  const expired = accountIssues ? space.filter((a) => a.needsReauth) : [];
  const failed = accountIssues ? syncFailures(accounts, syncState) : [];
  if (online && expired.length === 0 && failed.length === 0) return null;
  const names = space
    .filter((a) => failed.some((e) => e.startsWith(`${a.id}: `)))
    .map((a) => a.email)
    .join(", ");
  return (
    <div className="mx-3 mb-2 grid gap-2">
      {!online && (
        <output className={`${box} block bg-black/[0.04] text-a11y-muted dark:bg-white/5`}>
          <Trans>You're offline. Mail syncs again when you reconnect.</Trans>
        </output>
      )}
      {expired.map((a) => (
        <ReauthNotice key={a.id} account={a} onReauth={onReauth} />
      ))}
      {failed.length > 0 && !syncState.running && (
        <div role="alert" className={danger} title={failed.join("\n")}>
          <p>{names ? <Trans>Could not sync {names}.</Trans> : <Trans>Sync failed</Trans>}</p>
          <button type="button" onClick={() => run(syncNow)} className={`mt-1 ${action}`}>
            <Trans>Try again</Trans>
          </button>
        </div>
      )}
    </div>
  );
}
