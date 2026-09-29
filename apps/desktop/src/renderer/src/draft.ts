import type { Account, Address, Message, OutgoingAttachment } from "@openmail/core/schema";

import { displayName, threadDate } from "./format";

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

/** What the compose window edits. Recipients stay as typed text until send. */
export interface Draft {
  mode: ComposeMode;
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  attachments: readonly OutgoingAttachment[];
  /** Local id of the message replied to or forwarded. */
  inReplyTo?: string;
}

export function emptyDraft(accountId: string): Draft {
  return {
    mode: "new",
    accountId,
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    body: "",
    attachments: [],
  };
}

export function formatAddress(a: Address): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Parses "李雷 <li@example.com>, han@example.com". Returns the addresses and
 * the pieces that are not addresses, so the form can point at them.
 */
export function parseAddresses(input: string): { addresses: Address[]; invalid: string[] } {
  const addresses: Address[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[,;，；\n]/)) {
    const part = raw.trim();
    if (!part) continue;
    const angle = /^(.*)<([^>]+)>$/.exec(part);
    const name = angle ? angle[1]!.trim().replace(/^"|"$/g, "") : "";
    const address = (angle ? angle[2]! : part).trim();
    if (EMAIL.test(address)) addresses.push({ name, address });
    else invalid.push(part);
  }
  return { addresses, invalid };
}

function prefixed(prefix: string, subject: string): string {
  return new RegExp(`^${prefix}:`, "i").test(subject) ? subject : `${prefix}: ${subject}`;
}

function quote(m: Message): string {
  const lines = m.bodyText.trimEnd().split("\n");
  return `\n\n${threadDate(m.date)}，${displayName(m.from)} <${m.from.address}> 写道：\n${lines
    .map((l) => `> ${l}`)
    .join("\n")}`;
}

/** A reply, reply-all or forward of `m`, sent from the account that received it. */
export function draftFor(mode: Exclude<ComposeMode, "new">, m: Message, account: Account): Draft {
  const me = account.email.toLowerCase();
  const notMe = (a: Address) => a.address.toLowerCase() !== me;
  const sentByMe = !notMe(m.from);
  // Replying to your own message goes to its original recipients.
  const replyTo = sentByMe ? m.to : [m.from];
  const others = mode === "replyAll" ? [...m.to, ...m.cc].filter(notMe) : [];
  const seen = new Set<string>();
  const unique = (list: readonly Address[]) =>
    list.filter((a) => {
      const key = a.address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const to = mode === "forward" ? [] : unique(replyTo);
  const cc = mode === "replyAll" ? unique(others) : [];

  const body =
    mode === "forward"
      ? `\n\n---------- 转发的邮件 ----------\n发件人：${formatAddress(m.from)}\n日期：${threadDate(
          m.date,
        )}\n主题：${m.subject}\n收件人：${m.to.map(formatAddress).join(", ")}\n\n${m.bodyText}`
      : quote(m);

  return {
    mode,
    accountId: account.id,
    to: to.map(formatAddress).join(", "),
    cc: cc.map(formatAddress).join(", "),
    bcc: "",
    subject: prefixed(mode === "forward" ? "Fwd" : "Re", m.subject),
    body,
    attachments: [],
    inReplyTo: m.id,
  };
}

export function isEmpty(d: Draft): boolean {
  return !d.to && !d.cc && !d.bcc && !d.subject && !d.body.trim() && d.attachments.length === 0;
}
