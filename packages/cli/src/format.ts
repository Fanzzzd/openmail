import {
  type Account,
  type AuditEntry,
  type Command as MailCommand,
  type Message,
  type Outcome,
  type Proposal,
  type SyncResult,
  actorLabel,
  printable,
  printableLines,
} from "@openmail/core";
import { type ImapSettings, SYNC_FAILURE_TEXT, type ThreadSummary } from "@openmail/core/schema";

const two = (n: number) => String(n).padStart(2, "0");
/**
 * Every date the CLI prints for people: local time as `2026-10-14 17:48`, the same in every
 * command and every system locale. --json prints the stored values unchanged.
 */
export const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

const IMAP_ID = "imap:";
const shellWord = (word: string) =>
  /^[\w@.+:/-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/**
 * The command that signs an account in again. IMAP has no OAuth grant to renew, so it signs
 * in again by adding the address again: that replaces the password and keeps the sender name
 * and the rest of the account. The flags repeat the stored server settings.
 */
export function signInCommand(accountId: string, imap?: ImapSettings): string {
  if (!accountId.startsWith(IMAP_ID)) return `openmail accounts reauth ${accountId}`;
  const email = accountId.slice(IMAP_ID.length);
  const flags = [`--preset ${imap ? shellWord(imap.preset) : "<preset>"}`, `--email ${email}`];
  if (imap && imap.username !== email) flags.push(`--username ${shellWord(imap.username)}`);
  if (imap?.preset === "custom")
    flags.push(
      `--imap-host ${imap.imapHost} --imap-port ${imap.imapPort}`,
      `--smtp-host ${imap.smtpHost} --smtp-port ${imap.smtpPort}`,
      imap.smtpSecure ? "--smtp-secure" : "--no-smtp-secure",
    );
  return `openmail accounts add imap ${flags.join(" ")}`;
}

export function accountTable(rows: readonly Account[]): string {
  if (rows.length === 0) return "(no accounts; run `openmail accounts add gmail`)";
  return rows
    .map((a) => {
      const synced = a.lastSyncedAt ? stamp(a.lastSyncedAt) : "never";
      const reason = a.reauthReason ? ` (${a.reauthReason})` : "";
      const reauth = a.needsReauth
        ? `  needs sign-in${reason}: ${signInCommand(a.id, a.imap)}`
        : "";
      const error = a.lastSyncError ? `  error: ${a.lastSyncError}` : "";
      return `${a.id}  last sync: ${synced}${reauth}${error}`;
    })
    .join("\n");
}

const addresses = (list: readonly { readonly address: string }[]) =>
  printable(list.map((a) => a.address).join(", "));
/**
 * A message for `openmail show`. Mail is untrusted: header fields and the body go through
 * printable, so escape and bidi sequences in them show as `\u{...}` instead of driving the
 * terminal. The body keeps its line breaks and tabs.
 */
export function messageText(m: Message): string {
  return [
    `From:    ${printable(m.from.name)} <${printable(m.from.address)}>`,
    `To:      ${addresses(m.to)}`,
    ...(m.cc.length ? [`Cc:      ${addresses(m.cc)}`] : []),
    `Date:    ${stamp(m.date)}`,
    `Subject: ${printable(m.subject)}`,
    ...(m.attachments.length
      ? [`Attach:  ${printable(m.attachments.map((a) => a.filename).join(", "))}`]
      : []),
    `Id:      ${printable(m.id)}`,
    "",
    printableLines(m.bodyText),
  ].join("\n");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Cuts to `width` characters, with an ellipsis, then pads; control characters and bidi
 * embeddings, overrides and isolates become spaces.
 */
function cell(text: string, width: number): string {
  const flat = text.replace(/[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]+/gu, " ").trim();
  const parts = Array.from(graphemes.segment(flat), (part) => part.segment);
  const cut = parts.length > width ? `${parts.slice(0, width - 1).join("")}…` : flat;
  return cut.padEnd(width);
}

/** list and search for people: date, sender, subject and the id `openmail show` takes. */
export function threadTable(rows: readonly ThreadSummary[]): string {
  if (rows.length === 0) return "(no conversations)";
  return rows
    .map((t) => {
      const from = t.from.name || t.from.address;
      const count = t.threadCount > 1 ? ` (${t.threadCount})` : "";
      return `${stamp(t.date)}  ${t.isUnread ? "*" : " "} ${cell(from, 24)}  ${cell(`${t.subject || "(no subject)"}${count}`, 50)}  ${t.id}`;
    })
    .join("\n");
}

/** The next step after a failed `openmail sync`. Errors are all it logs by default. */
export const SYNC_FAILED_HINT = "Run it again, or add --log-level warn to see why.";

/**
 * The rerun hint. With --log-level warn or lower the log above already says why, so it does
 * not send people to the flag they passed.
 */
const rerunHint = (verbose: boolean) => (verbose ? "Run it again." : SYNC_FAILED_HINT);

/**
 * The hint for a failed `openmail sync`. An account that needs sign-in has its reauth command
 * on its own line, or `needs_reauth` in --json; signing in again is the fix for it, not a rerun.
 */
export function syncFailedHint(
  results: readonly SyncResult[],
  { json, verbose }: { readonly json: boolean; readonly verbose: boolean },
): string {
  const failed = results.filter((r) => r.error);
  const needSignIn = failed.filter((r) => r.needsReauth);
  const signIns = needSignIn.length;
  const imap = needSignIn.filter((r) => r.accountId.startsWith(IMAP_ID)).length;
  const signIn = !json
    ? "Sign in again with the commands above."
    : imap === 0
      ? "Sign in again with `openmail accounts reauth <account_id>` for each result with needs_reauth."
      : imap === signIns
        ? "Sign in again with `openmail accounts add imap --preset <preset> --email <address>` for each result with needs_reauth."
        : "Sign in again for each result with needs_reauth: `openmail accounts reauth <account_id>`, or for an imap account `openmail accounts add imap --preset <preset> --email <address>`.";
  if (signIns === 0) return rerunHint(verbose);
  if (signIns === failed.length) return signIn;
  return verbose
    ? `${signIn} Run sync again for the other accounts.`
    : `${signIn} Run sync again for the other accounts, or add --log-level warn to see why.`;
}

/**
 * The app retries a failed sync on its own and says so. `openmail sync` runs once, so these
 * failures say what to do instead. Only an unknown failure is logged at warn level.
 */
const cliSyncFailureText = (verbose: boolean) =>
  new Map([
    [SYNC_FAILURE_TEXT.unknown, `Sync could not finish. ${rerunHint(verbose)}`],
    [SYNC_FAILURE_TEXT.quota, "The mail provider is limiting requests. Run sync again later."],
    [SYNC_FAILURE_TEXT.server, "The mail server had a problem. Run sync again later."],
  ]);

/** A sync result as `openmail sync` reports it. */
export const cliSyncResult = (result: SyncResult, verbose = false): SyncResult => {
  const error = result.error && cliSyncFailureText(verbose).get(result.error);
  return error ? { ...result, error } : result;
};

export function syncTable(
  results: readonly SyncResult[],
  accounts: readonly Account[] = [],
): string {
  if (results.length === 0) return "(no accounts)";
  return results
    .map((r) => {
      if (r.needsReauth)
        return `${r.accountId}  needs sign-in: ${signInCommand(
          r.accountId,
          accounts.find((a) => a.id === r.accountId)?.imap,
        )}`;
      if (r.error) return `${r.accountId}  error: ${r.error}`;
      return `${r.accountId}  ${r.changed} changed, ${r.deleted} deleted`;
    })
    .join("\n");
}

export function commandSummary(c: MailCommand): string {
  switch (c.kind) {
    case "modify": {
      const op = c.op;
      const what =
        op.kind === "label"
          ? `${op.value ? "add" : "remove"} label ${op.labelId}`
          : "value" in op
            ? `${op.value ? "" : "un"}${op.kind}`
            : op.kind;
      return `${what}: ${c.threads.length} thread(s)`;
    }
    case "snooze":
      return `snooze until ${stamp(c.due)}: ${c.threads.length} thread(s)`;
    case "send":
    case "draft": {
      const to = c.message.to.map((a) => a.address).join(", ");
      return `${c.kind} from ${c.accountId} to ${to}: ${c.message.subject}`;
    }
    default:
      return `remove account ${c.accountId}`;
  }
}

export function proposalTable(rows: readonly Proposal[]): string {
  if (rows.length === 0) return "(no proposals)";
  return rows
    .map((p) => {
      const why =
        p.actor.kind === "agent" && p.actor.rationale
          ? `\n      why: ${printable(p.actor.rationale.replace(/\r?\n/g, " "))}`
          : "";
      return `#${p.id}  ${stamp(p.createdAt)}  ${p.status.padEnd(8)}  ${printable(actorLabel(p.actor))}\n      ${commandSummary(p.command)}${why}`;
    })
    .join("\n");
}

export function auditTable(rows: readonly AuditEntry[]): string {
  if (rows.length === 0) return "(no entries)";
  return rows
    .map((e) => {
      const detail = e.detail === undefined ? "" : JSON.stringify(e.detail);
      const short = detail.length > 80 ? `${detail.slice(0, 79)}…` : detail;
      return `${stamp(e.at)}  ${printable(e.actor).padEnd(24)}  ${e.action.padEnd(12)}  ${e.accountId ?? "-"}  ${short}`;
    })
    .join("\n");
}

export function outcomeText(outcome: Outcome, applied: string): string {
  switch (outcome.status) {
    case "applied": {
      const failed = outcome.flush?.failed ?? 0;
      return failed > 0 ? `${applied} ${failed} change(s) are queued for the next sync.` : applied;
    }
    case "proposed":
      return `Waiting for approval (proposal ${outcome.proposalId}).`;
    default:
      return `Not done: ${outcome.reason}`;
  }
}
