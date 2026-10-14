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
import type { ThreadSummary } from "@openmail/core/schema";

const two = (n: number) => String(n).padStart(2, "0");
/**
 * Every date the CLI prints for people: local time as `2026-10-14 17:48`, the same in every
 * command and every system locale. --json prints the stored values unchanged.
 */
export const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

export function accountTable(rows: readonly Account[]): string {
  if (rows.length === 0) return "(no accounts; run `openmail accounts add gmail`)";
  return rows
    .map((a) => {
      const synced = a.lastSyncedAt ? stamp(a.lastSyncedAt) : "never";
      const reason = a.reauthReason ? ` (${a.reauthReason})` : "";
      const reauth = a.needsReauth
        ? `  needs sign-in${reason}: openmail accounts reauth ${a.id}`
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

export function syncTable(results: readonly SyncResult[]): string {
  if (results.length === 0) return "(no accounts)";
  return results
    .map((r) => {
      if (r.needsReauth)
        return `${r.accountId}  needs sign-in: openmail accounts reauth ${r.accountId}`;
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
