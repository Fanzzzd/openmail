import {
  type Account,
  type AuditEntry,
  type Command as MailCommand,
  type Message,
  type Outcome,
  type Proposal,
  type SyncResult,
  type ThreadSummary,
  actorLabel,
} from "@openmail/core";

const stamp = (ms: number) => new Date(ms).toLocaleString("sv-SE").slice(0, 16);

export function threadTable(rows: readonly ThreadSummary[]): string {
  if (rows.length === 0) return "(no messages)";
  return rows
    .map((m) => {
      const flags = `${m.isUnread ? "●" : " "}${m.isStarred ? "★" : " "}${m.hasAttachments ? "📎" : "  "}`;
      const from = (m.from.name || m.from.address).slice(0, 24).padEnd(24);
      const count = m.threadCount > 1 ? ` (${m.threadCount})` : "";
      return `${flags} ${stamp(m.date)}  ${from}  ${m.subject}${count}\n      ${m.id}`;
    })
    .join("\n");
}

export function accountTable(rows: readonly Account[]): string {
  if (rows.length === 0) return "(no accounts; run `openmail accounts add gmail`)";
  return rows
    .map((a) => {
      const synced = a.lastSyncedAt ? new Date(a.lastSyncedAt).toLocaleString() : "never";
      const reauth = a.needsReauth ? `  needs sign-in: openmail accounts reauth ${a.id}` : "";
      const error = a.lastSyncError ? `  error: ${a.lastSyncError}` : "";
      return `${a.id}  last sync: ${synced}${reauth}${error}`;
    })
    .join("\n");
}

export function messageText(m: Message): string {
  return [
    `From:    ${m.from.name} <${m.from.address}>`,
    `To:      ${m.to.map((a) => a.address).join(", ")}`,
    ...(m.cc.length ? [`Cc:      ${m.cc.map((a) => a.address).join(", ")}`] : []),
    `Date:    ${new Date(m.date).toLocaleString()}`,
    `Subject: ${m.subject}`,
    ...(m.attachments.length
      ? [`Attach:  ${m.attachments.map((a) => a.filename).join(", ")}`]
      : []),
    `Id:      ${m.id}`,
    "",
    m.bodyText,
  ].join("\n");
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
        p.actor.kind === "agent" && p.actor.rationale ? `\n      why: ${p.actor.rationale}` : "";
      return `#${p.id}  ${stamp(p.createdAt)}  ${p.status.padEnd(8)}  ${actorLabel(p.actor)}\n      ${commandSummary(p.command)}${why}`;
    })
    .join("\n");
}

export function auditTable(rows: readonly AuditEntry[]): string {
  if (rows.length === 0) return "(no entries)";
  return rows
    .map((e) => {
      const detail = e.detail === undefined ? "" : JSON.stringify(e.detail);
      const short = detail.length > 80 ? `${detail.slice(0, 79)}…` : detail;
      return `${stamp(e.at)}  ${e.actor.padEnd(24)}  ${e.action.padEnd(12)}  ${e.accountId ?? "-"}  ${short}`;
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
