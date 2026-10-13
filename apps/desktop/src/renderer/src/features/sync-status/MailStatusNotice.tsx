import { Collapsible } from "@base-ui/react/collapsible";
import type { I18n } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { isKeychainLocked } from "@openmail/core/schema";
import { ChevronRight, CircleAlert, Lock, WifiOff } from "lucide-react";
import { type ReactNode, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import type { Account, SyncState } from "../../../../shared/api";
import { canCall } from "../../lib/platform";
import { syncNow, useRunMail } from "../../state/mail";
import { SignInAgainOnMac } from "../../ui/SignInAgainOnMac";
import { noticeRow, noticeTone } from "../../ui/styles";

const action =
  "shrink-0 rounded-item font-semibold whitespace-nowrap outline-offset-1 outline-a11y-focus hover:underline focus-visible:outline-2";
const icon = "size-3.5 shrink-0";

/** One status line: an icon, text cut to one line (the full text in its tooltip), then an action. */
function NoticeLine({
  tone,
  glyph,
  title,
  className = "",
  children,
  action: trailing,
  detail,
}: {
  tone: keyof typeof noticeTone;
  glyph: ReactNode;
  title?: string | undefined;
  className?: string;
  children: ReactNode;
  action?: ReactNode;
  /** A second line under the text, such as the full reason. */
  detail?: ReactNode;
}) {
  return (
    <div
      className={`group/notice flex-wrap ${noticeRow} ${noticeTone[tone]} ${className}`}
      title={title}
    >
      {glyph}
      <div className="min-w-0 flex-1 truncate">{children}</div>
      {trailing}
      {detail}
    </div>
  );
}

/**
 * Sync errors other than expired sign-ins. Core reports each failure as "accountId: message"; an
 * expired account fails every sync and has its own notice, so its error is left out.
 */
export function syncFailures(accounts: readonly Account[], syncState: SyncState) {
  const expired = accounts.filter((a) => a.needsReauth).map((a) => `${a.id}: `);
  return syncState.errors.filter((e) => !expired.some((prefix) => e.startsWith(prefix)));
}

/** The account id of a failure that core reported as "accountId: message". */
const failedAccount = (failure: string) => failure.slice(0, failure.indexOf(": "));

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
    <div ref={root}>
      <NoticeLine
        tone="danger"
        glyph={<CircleAlert aria-hidden className={icon} />}
        title={failed.join("\n")}
        action={
          <button type="button" onClick={() => run(syncNow)} className={action}>
            <Trans>Try again</Trans>
          </button>
        }
      >
        <p className="truncate">
          {names ? <Trans>Could not sync {names}.</Trans> : <Trans>Sync failed</Trans>}
        </p>
      </NoticeLine>
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

/** Brand names stay as they are; a custom IMAP server goes by its address's domain. */
const PRESET_NAMES: Record<string, string | ReturnType<typeof msg>> = {
  icloud: "iCloud",
  yahoo: "Yahoo",
  fastmail: "Fastmail",
  qq: msg`QQ Mail`,
  "163": msg`163 Mail`,
};

/** The account's provider as the person knows it: Gmail, Outlook, iCloud or the mail domain. */
function providerName(i18n: I18n, account: Account): string {
  if (account.provider === "gmail") return "Gmail";
  if (account.provider === "outlook") return "Outlook";
  const preset = account.imap?.preset ? PRESET_NAMES[account.imap.preset] : undefined;
  if (preset) return typeof preset === "string" ? preset : i18n._(preset);
  return account.email.split("@")[1] ?? account.email;
}

/** One short line for the notice, such as "Gmail sign-in expired"; {@link reauthText} says more. */
export function reauthHeadline(i18n: I18n, account: Account): string {
  const provider = providerName(i18n, account);
  switch (account.reauthReason) {
    case "scope_missing":
      return i18n._(msg`${provider} needs permission again`);
    case "client_mismatch":
      return i18n._(msg`${provider} sign-in client changed`);
    case "keychain_missing":
      return i18n._(msg`${provider} sign-in missing`);
    case "imap_auth_failed":
      return i18n._(msg`${provider} password rejected`);
    default:
      return i18n._(msg`${provider} sign-in expired`);
  }
}

/** The keychain could not be read, usually locked after sleep. Not a sign-in problem. */
export function KeychainNotice({ className = "" }: { className?: string }) {
  const { t } = useLingui();
  const text = t`The keychain is locked. Unlock your computer and sync resumes on its own.`;
  return (
    <NoticeLine
      tone="warning"
      glyph={<Lock aria-hidden className={icon} />}
      title={text}
      className={className}
    >
      <p className="truncate">{text}</p>
    </NoticeLine>
  );
}

/** An account that must sign in again: name it, offer the sign-in, and give the reason. */
export function ReauthNotice({
  account,
  onReauth,
  detailed = false,
  className = "",
}: {
  account: Account;
  onReauth: (account: Account) => void;
  /** Always show the reason; otherwise it shows while the line has keyboard focus. */
  detailed?: boolean;
  className?: string;
}) {
  const { i18n } = useLingui();
  const reason = reauthText(i18n, account);
  // The line says what happened in a few words, which fit where the address was cut off. The
  // reason, with the full address, is a second line once the person opens the group or tabs to
  // Sign in again; until then it is the tooltip and what a screen reader reads after the line.
  return (
    <NoticeLine
      tone="danger"
      glyph={<CircleAlert aria-hidden className={icon} />}
      title={`${account.email}\n${reason}`}
      className={className}
      detail={
        <p
          className={`w-full pl-5 leading-4 ${detailed ? "" : "sr-only group-focus-within/notice:not-sr-only"}`}
        >
          {reason}
        </p>
      }
      action={
        // IMAP signs in again through Add Account (Connect); OAuth providers through Reauth.
        canCall(account.provider === "imap" ? "Connect" : "Reauth") ? (
          <button type="button" onClick={() => onReauth(account)} className={action}>
            <Trans>Sign in again</Trans>
          </button>
        ) : (
          <SignInAgainOnMac className="font-semibold" />
        )
      }
    >
      <span className="font-medium">{reauthHeadline(i18n, account)}</span>
    </NoticeLine>
  );
}

/**
 * Sign-in, keychain and sync problems. One affected account shows its lines; two or more fold
 * into one "N accounts need attention" line that opens to show them.
 */
export function AccountIssues({
  expired,
  keychain,
  failure,
  affected,
  onReauth,
  className = "",
}: {
  expired: readonly Account[];
  keychain: boolean;
  /** The sync failure line, if any. */
  failure?: ReactNode;
  /** How many accounts the problems touch. */
  affected: number;
  onReauth: (account: Account) => void;
  className?: string;
}) {
  if (!expired.length && !keychain && !failure) return null;
  const lines = (
    <>
      {expired.map((a) => (
        <ReauthNotice key={a.id} account={a} onReauth={onReauth} detailed={affected >= 2} />
      ))}
      {keychain && <KeychainNotice />}
      {failure}
    </>
  );
  if (affected < 2)
    return <div className={`grid grid-cols-[minmax(0,1fr)] gap-1.5 ${className}`}>{lines}</div>;
  return (
    <Collapsible.Root className={className}>
      <Collapsible.Trigger
        className={`group w-full text-left outline-offset-1 outline-a11y-focus focus-visible:outline-2 ${noticeRow} ${noticeTone.danger}`}
      >
        <CircleAlert aria-hidden className={icon} />
        <span className="min-w-0 flex-1 truncate font-medium">
          {plural(affected, {
            one: "# account needs attention",
            other: "# accounts need attention",
          })}
        </span>
        <ChevronRight
          aria-hidden
          className={`${icon} transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none`}
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className="grid grid-cols-[minmax(0,1fr)] gap-1.5 pt-1.5">
        {lines}
      </Collapsible.Panel>
    </Collapsible.Root>
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
  const affected = new Set([
    ...expired.map((a) => a.id),
    ...failures.filter((f) => (isKeychainLocked(f) ? keychain : showFailure)).map(failedAccount),
  ]).size;
  return (
    <>
      <ChangeAnnouncement text={online ? "" : offline} />
      {accountIssues && <SyncStatusAnnouncement failed={failures.length > 0} />}
      {(!online || expired.length > 0 || showFailure || keychain) && (
        <div className="mx-3 mb-2 grid grid-cols-[minmax(0,1fr)] gap-1.5">
          {!online && (
            <NoticeLine
              tone="neutral"
              glyph={<WifiOff aria-hidden className={icon} />}
              title={offline}
            >
              <p className="truncate">{offline}</p>
            </NoticeLine>
          )}
          <AccountIssues
            expired={expired}
            keychain={keychain}
            affected={affected}
            onReauth={onReauth}
            failure={
              showFailure && <SyncFailure names={names} failed={failed} onFocusList={onFocusList} />
            }
          />
        </div>
      )}
    </>
  );
}

/** The sidebar's account problems: the same lines and grouping as the list's notice. */
export function SidebarAccountIssues({
  members,
  failures,
  onReauth,
  className,
}: {
  members: readonly Account[];
  failures: readonly string[];
  onReauth: (account: Account) => void;
  className?: string;
}) {
  const expired = members.filter((a) => a.needsReauth);
  const locked = failures.filter(isKeychainLocked);
  const affected = new Set([...expired.map((a) => a.id), ...locked.map(failedAccount)]).size;
  return (
    <AccountIssues
      expired={expired}
      keychain={locked.length > 0}
      affected={affected}
      onReauth={onReauth}
      className={className}
    />
  );
}
