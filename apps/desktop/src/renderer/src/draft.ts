import type {
  Account,
  Address,
  DraftInput,
  Message,
  OutgoingAttachment,
  OutgoingMessage,
  StoredDraft,
} from "../../shared/api";
import { displayName } from "./format";

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

/**
 * What the compose window edits. Recipients stay as typed text; only the
 * valid addresses are saved and sent. `id` is the local draft id, chosen here
 * so every autosave of one window updates the same draft.
 */
export interface Draft {
  id: string;
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
  /** The body is Markdown; core sends it with an HTML part. */
  markdown: boolean;
  /** Forward `inReplyTo` as an attached .eml instead of quoting it. */
  forwardAsAttachment: boolean;
  /** The agent proposal this draft came from. */
  proposalId?: number;
}

export const newDraftId = () => `draft:${crypto.randomUUID()}`;

export function emptyDraft(accountId: string): Draft {
  return {
    id: newDraftId(),
    mode: "new",
    accountId,
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    body: "",
    attachments: [],
    markdown: false,
    forwardAsAttachment: false,
  };
}

export function formatAddress(a: Address): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Separators between addresses in a recipient field. */
export const ADDRESS_SEPARATOR = /[,;，；\n]/;

/**
 * Parses "李雷 <li@example.com>, han@example.com". Returns the addresses and
 * the pieces that are not addresses, so the form can point at them.
 */
export function parseAddresses(input: string): { addresses: Address[]; invalid: string[] } {
  const addresses: Address[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(ADDRESS_SEPARATOR)) {
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

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/**
 * The date in a quoted reply or forward header. Quoted text goes out in the
 * mail itself, so it stays in Chinese whatever the UI language is.
 */
function quoteDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return `今天 ${time}`;
  if (sameDay(d, yesterday)) return `昨天 ${time}`;
  const day =
    d.getFullYear() === now.getFullYear()
      ? d.toLocaleDateString("zh-CN", { month: "long", day: "numeric" })
      : d.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  return `${day} ${time}`;
}

function quote(m: Message): string {
  const lines = m.bodyText.trimEnd().split("\n");
  return `\n\n${quoteDate(m.date)}，${displayName(m.from)} <${m.from.address}> 写道：\n${lines
    .map((l) => `> ${l}`)
    .join("\n")}`;
}

/**
 * A reply, reply-all or forward of `m`, sent from the account that received
 * it. `asAttachment` forwards the original as an .eml instead of quoting it.
 */
export function draftFor(
  mode: Exclude<ComposeMode, "new">,
  m: Message,
  account: Account,
  asAttachment = false,
): Draft {
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
  const forwardAsAttachment = mode === "forward" && asAttachment;

  const body = forwardAsAttachment
    ? ""
    : mode === "forward"
      ? `\n\n---------- 转发的邮件 ----------\n发件人：${formatAddress(m.from)}\n日期：${quoteDate(m.date)}\n主题：${m.subject}\n收件人：${m.to.map(formatAddress).join(", ")}\n\n${m.bodyText}`
      : quote(m);

  return {
    id: newDraftId(),
    mode,
    accountId: account.id,
    to: to.map(formatAddress).join(", "),
    cc: cc.map(formatAddress).join(", "),
    bcc: "",
    subject: prefixed(mode === "forward" ? "Fwd" : "Re", m.subject),
    body,
    attachments: [],
    inReplyTo: m.id,
    markdown: false,
    forwardAsAttachment,
  };
}

/** A draft from core, as the compose window edits it. */
export function fromStored(d: StoredDraft): Draft {
  const m = d.message;
  return {
    id: d.id,
    mode: m.mode ?? "new",
    accountId: d.accountId,
    to: m.to.map(formatAddress).join(", "),
    cc: m.cc.map(formatAddress).join(", "),
    bcc: m.bcc.map(formatAddress).join(", "),
    subject: m.subject,
    body: m.text,
    attachments: m.attachments,
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
    markdown: m.markdown ?? false,
    forwardAsAttachment: m.forwardAsAttachment ?? false,
    ...(d.proposalId === null ? {} : { proposalId: d.proposalId }),
  };
}

/** The message a draft stands for, and the recipient text that is not an address. */
export function toMessage(d: Draft): { message: OutgoingMessage; invalid: string[] } {
  const to = parseAddresses(d.to);
  const cc = parseAddresses(d.cc);
  const bcc = parseAddresses(d.bcc);
  return {
    message: {
      to: to.addresses,
      cc: cc.addresses,
      bcc: bcc.addresses,
      subject: d.subject,
      text: d.body,
      attachments: d.attachments,
      mode: d.mode,
      ...(d.inReplyTo ? { inReplyTo: d.inReplyTo } : {}),
      ...(d.markdown ? { markdown: true } : {}),
      ...(d.forwardAsAttachment ? { forwardAsAttachment: true } : {}),
    },
    invalid: [...to.invalid, ...cc.invalid, ...bcc.invalid],
  };
}

/** What autosave stores. Recipient text that is not an address yet is left out. */
export function toDraftInput(d: Draft): DraftInput {
  return { id: d.id, accountId: d.accountId, message: toMessage(d).message };
}

export function isEmpty(d: Draft): boolean {
  return (
    !d.to &&
    !d.cc &&
    !d.bcc &&
    !d.subject &&
    !d.body.trim() &&
    d.attachments.length === 0 &&
    !d.forwardAsAttachment
  );
}
