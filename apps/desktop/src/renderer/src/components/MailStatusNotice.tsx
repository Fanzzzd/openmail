import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { isKeychainLocked } from "@openmail/core/schema";
import { useEffectEvent, useLayoutEffect, useRef, useState } from "react";

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

/**
 * A polite announcement of `text` when it changes after mount. The list remounts its notice on
 * every search or view change and the drawer remounts the sidebar, so a remount stays silent
 * instead of repeating the last state.
 */
function ChangeAnnouncement({ text }: { text: string }) {
  const [last, setLast] = useState(text);
  const [said, setSaid] = useState("");
  if (text !== last) {
    setLast(text);
    setSaid(text);
  }
  return (
    <output aria-live="polite" aria-atomic="true" className="sr-only">
      {said}
    </output>
  );
}

/** Sync ticks and progress stay visual; only entering and clearing failure is announced. */
export function SyncStatusAnnouncement({ failed }: { failed: boolean }) {
  const { t } = useLingui();
  return <ChangeAnnouncement text={failed ? t`Sync failed` : t`Syncing normally`} />;
}

/** A sync failure with Try again. When it leaves while it has focus, `onFocusList` takes focus. */
function SyncFailure({
  names,
  failed,
  onFocusList,
}: {
  names: string;
  failed: readonly string[];
  onFocusList: () => void;
}) {
  const run = useRunMail();
  const root = useRef<HTMLDivElement>(null);
  const focusList = useEffectEvent(onFocusList);
  useLayoutEffect(() => {
    const element = root.current;
    return () => {
      if (element?.contains(document.activeElement)) focusList();
    };
  }, []);
  return (
    <div ref={root} className={danger} title={failed.join("\n")}>
      <p>{names ? <Trans>Could not sync {names}.</Trans> : <Trans>Sync failed</Trans>}</p>
      <button type="button" onClick={() => run(syncNow)} className={`mt-1 ${action}`}>
        <Trans>Try again</Trans>
      </button>
    </div>
  );
}

/** Why `account` must sign in again, from the reason core recorded when it paused sync. */
export function reauthText(i18n: I18n, account: Account): string {
  const email = account.email;
  switch (account.reauthReason) {
    case "testing_mode_expiry":
      // Core only reports this for the built-in client, whose app OpenMail publishes.
      return i18n._(
        msg`Google currently limits OpenMail's sign-in to 7 days. Sign in again to keep syncing ${email}.`,
      );
    case "scope_missing":
      return i18n._(msg`${email} needs to grant mail permissions again. Sync is paused.`);
    case "client_mismatch":
      return i18n._(
        msg`The OAuth client that signed in ${email} is no longer configured. Sync is paused.`,
      );
    case "keychain_missing":
      return i18n._(msg`${email}'s saved sign-in is missing from the keychain. Sync is paused.`);
    case "imap_auth_failed":
      return i18n._(msg`The mail server rejected the password for ${email}. Sync is paused.`);
    case "token_revoked":
      return i18n._(msg`${email}'s sign-in was revoked or has expired. Sync is paused.`);
    default:
      // Marked before migration 44 recorded reasons.
      return i18n._(msg`${email}'s sign-in has expired. Sync is paused.`);
  }
}

/** The keychain could not be read, usually locked after sleep. Not a sign-in problem. */
export function KeychainNotice({ className = "" }: { className?: string }) {
  return (
    <p className={`${box} bg-orange-500/[0.08] text-orange-800 dark:text-orange-300 ${className}`}>
      <Trans>The keychain is locked. Unlock your computer and sync resumes on its own.</Trans>
    </p>
  );
}

/** An account that must sign in again: say why and offer the sign-in. */
export function ReauthNotice({
  account,
  onReauth,
  className = "",
}: {
  account: Account;
  onReauth: (account: Account) => void;
  className?: string;
}) {
  const { i18n } = useLingui();
  return (
    <div className={`${danger} ${className}`}>
      <p>{reauthText(i18n, account)}</p>
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
  onFocusList,
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
  /** Focuses the message list, for when a notice that has focus goes away. */
  onFocusList: () => void;
}) {
  const { t } = useLingui();
  const expired = accountIssues ? space.filter((a) => a.needsReauth) : [];
  const failures = accountIssues ? syncFailures(accounts, syncState) : [];
  const keychain = failures.some(isKeychainLocked);
  const failed = failures.filter((failure) => !isKeychainLocked(failure));
  const offline = t`You're offline. Mail syncs again when you reconnect.`;
  const names = space
    .filter((a) => failed.some((e) => e.startsWith(`${a.id}: `)))
    .map((a) => a.email)
    .join(", ");
  const showFailure = failed.length > 0 && !syncState.running;
  return (
    <>
      <ChangeAnnouncement text={online ? "" : offline} />
      {accountIssues && <SyncStatusAnnouncement failed={failures.length > 0} />}
      {(!online || expired.length > 0 || showFailure || keychain) && (
        <div className="mx-3 mb-2 grid gap-2">
          {!online && (
            <p className={`${box} bg-black/[0.04] text-a11y-muted dark:bg-white/5`}>{offline}</p>
          )}
          {expired.map((a) => (
            <ReauthNotice key={a.id} account={a} onReauth={onReauth} />
          ))}
          {keychain && <KeychainNotice />}
          {showFailure && <SyncFailure names={names} failed={failed} onFocusList={onFocusList} />}
        </div>
      )}
    </>
  );
}
