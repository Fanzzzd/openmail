import {
  displayName,
  applySignature,
  isEmailAddress,
  replyRecipients,
  splitAddresses,
  type SendAs,
  type ComposeBody,
  outgoingComposeBody,
  normalizeComposeMessage,
  richComposeBody,
  remoteComposeBody,
  preservedComposeHtml,
  textComposeHtml,
} from "@openmail/core/schema";
import type {
  Account,
  Address,
  DraftInput,
  Message,
  OutgoingAttachment,
  OutgoingMessage,
  StoredDraft,
} from "../../shared/api";

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
  from?: Address;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: ComposeBody;
  attachments: readonly OutgoingAttachment[];
  /** Local id of the message replied to or forwarded. */
  inReplyTo?: string;
  /** Forward `inReplyTo` as an attached .eml instead of quoting it. */
  forwardAsAttachment: boolean;
  includeOriginalAttachments?: boolean;
  /** First-open work only; never persisted or repeated when reopening a draft. */
  loadOriginalAttachments?: boolean;
  /** Whether the version opened from storage was synced to the provider. */
  synced?: boolean;
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
    body: { kind: "rich", text: "", html: "" },
    attachments: [],
    forwardAsAttachment: false,
  };
}

export function formatAddress(a: Address): string {
  if (!a.name) return a.address;
  const name = /[",;:，；\\]/.test(a.name)
    ? `"${a.name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : a.name;
  return `${name} <${a.address}>`;
}

/** Separators between addresses in a recipient field. */
export const ADDRESS_SEPARATOR = /[,;，；\n]/;

/**
 * Parses "李雷 <li@example.com>, han@example.com". Returns the addresses and
 * the pieces that are not addresses, so the form can point at them.
 */
export function parseAddresses(input: string): { addresses: Address[]; invalid: string[] } {
  const addresses: Address[] = [];
  const invalid: string[] = [];
  for (const raw of splitAddresses(input)) {
    const part = raw.trim();
    if (!part) continue;
    const angle = /^(.*)<([^>]+)>$/.exec(part);
    const name = angle
      ? angle[1]!
          .trim()
          .replace(/^"|"$/g, "")
          .replace(/\\(["\\])/g, "$1")
      : "";
    const address = (angle ? angle[2]! : part).trim();
    if (isEmailAddress(address)) addresses.push({ name, address });
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
  aliases: readonly Pick<SendAs, "accountId" | "address">[] = [],
  selectedText?: string,
): Draft {
  const { to, cc } =
    mode === "forward"
      ? { to: [], cc: [] }
      : replyRecipients(
          m,
          [
            account.email,
            ...(account.imap ? [account.imap.username] : []),
            ...aliases
              .filter((alias) => alias.accountId === account.id)
              .map((alias) => alias.address),
          ],
          mode === "replyAll",
        );
  const forwardAsAttachment = mode === "forward" && asAttachment;

  const quoted = selectedText === undefined ? m : { ...m, bodyText: selectedText, bodyHtml: "" };
  const body = forwardAsAttachment
    ? ""
    : mode === "forward"
      ? `\n\n---------- 转发的邮件 ----------\n发件人：${formatAddress(m.from)}\n日期：${quoteDate(m.date)}\n主题：${m.subject}\n收件人：${m.to.map(formatAddress).join(", ")}\n\n${quoted.bodyText}`
      : quote(quoted);

  return {
    id: newDraftId(),
    mode,
    accountId: account.id,
    to: to.map(formatAddress).join(", "),
    cc: cc.map(formatAddress).join(", "),
    bcc: "",
    subject: prefixed(mode === "forward" ? "Fwd" : "Re", m.subject),
    body:
      mode === "forward" && !forwardAsAttachment && quoted.bodyHtml
        ? remoteComposeBody(
            `${textComposeHtml(body.slice(0, body.length - quoted.bodyText.length))}${preservedComposeHtml(quoted.bodyHtml)}`,
          )
        : richComposeBody(textComposeHtml(body)),
    ...(account.provider === "outlook" && mode === "forward" && !forwardAsAttachment
      ? {}
      : { includeOriginalAttachments: mode === "forward" && !forwardAsAttachment }),
    loadOriginalAttachments:
      account.provider !== "outlook" && mode === "forward" && !forwardAsAttachment,
    attachments: [],
    inReplyTo: m.id,
    forwardAsAttachment,
  };
}

/** A draft from core, as the compose window edits it. */
export function fromStored(d: StoredDraft): Draft {
  const m = d.message;
  return {
    id: d.id,
    synced: d.synced,
    mode: m.mode ?? "new",
    accountId: d.accountId,
    ...(m.from ? { from: m.from } : {}),
    to: m.to.map(formatAddress).join(", "),
    cc: m.cc.map(formatAddress).join(", "),
    bcc: m.bcc.map(formatAddress).join(", "),
    subject: m.subject,
    body: outgoingComposeBody(m),
    attachments: m.attachments,
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
    forwardAsAttachment: m.forwardAsAttachment ?? false,
    ...(m.includeOriginalAttachments === undefined
      ? {}
      : { includeOriginalAttachments: m.includeOriginalAttachments }),
    ...(d.proposalId === null ? {} : { proposalId: d.proposalId }),
  };
}

/** The message a draft stands for, and the recipient text that is not an address. */
export function toMessage(d: Draft): { message: OutgoingMessage; invalid: string[] } {
  const to = parseAddresses(d.to);
  const cc = parseAddresses(d.cc);
  const bcc = parseAddresses(d.bcc);
  const body = d.body;
  return {
    message: normalizeComposeMessage({
      ...(d.from ? { from: d.from } : {}),
      to: to.addresses,
      cc: cc.addresses,
      bcc: bcc.addresses,
      subject: d.subject,
      text: body.text,
      ...(body.kind === "rich"
        ? {
            html: body.html,
            ...(d.body.kind === "rich" && d.body.originalHtml !== undefined
              ? { originalHtml: d.body.originalHtml }
              : {}),
          }
        : {}),
      attachments: d.attachments,
      ...(d.includeOriginalAttachments === undefined
        ? {}
        : { includeOriginalAttachments: d.includeOriginalAttachments }),
      mode: d.mode,
      ...(d.inReplyTo ? { inReplyTo: d.inReplyTo } : {}),
      ...(body.kind === "markdown" ? { markdown: true } : {}),
      ...(d.forwardAsAttachment ? { forwardAsAttachment: true } : {}),
    }),
    invalid: [...to.invalid, ...cc.invalid, ...bcc.invalid],
  };
}

/** What autosave stores. Recipient text that is not an address yet is left out. */
export function toDraftInput(d: Draft): DraftInput {
  return { id: d.id, accountId: d.accountId, message: toMessage(d).message };
}

export function isEmpty(d: Draft, signature?: string): boolean {
  const body = d.body.text.trim();
  const automatic = signature
    ? richComposeBody(textComposeHtml(applySignature("", undefined, signature))).text.trim()
    : "";
  return (
    !d.to &&
    !d.cc &&
    !d.bcc &&
    !d.subject &&
    (!body || body === automatic) &&
    // An untouched image-only remote body has no editable text, but closing must keep it.
    (d.body.kind !== "rich" || d.body.originalHtml === undefined) &&
    d.attachments.length === 0 &&
    !d.forwardAsAttachment
  );
}

/** Switching reply modes only replaces addressing/threading fields; the edited body survives. */
export function switchReplyMode(
  draft: Draft,
  mode: Exclude<ComposeMode, "new">,
  original: Message,
  account: Account,
  aliases: readonly Pick<SendAs, "accountId" | "address">[],
): Draft {
  const next = draftFor(mode, original, account, false, aliases);
  const previous =
    draft.mode === "new"
      ? { to: "", cc: "" }
      : draftFor(draft.mode, original, account, false, aliases);
  const automatic = new Set(
    [...parseAddresses(previous.to).addresses, ...parseAddresses(previous.cc).addresses].map((a) =>
      a.address.toLowerCase(),
    ),
  );
  const seen = new Set<string>();
  const merge = (preset: string, typed: string) => {
    const entered = parseAddresses(typed);
    const manual = entered.addresses.filter((a) => !automatic.has(a.address.toLowerCase()));
    const recipients = [...parseAddresses(preset).addresses, ...manual].filter((a) => {
      const key = a.address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return [...recipients.map(formatAddress), ...entered.invalid].join(", ");
  };
  const subject = /^(?:re|fwd?|fw)\s*:/i.test(draft.subject)
    ? prefixed(
        mode === "forward" ? "Fwd" : "Re",
        draft.subject.replace(/^(?:(?:re|fwd?|fw)\s*:\s*)+/i, ""),
      )
    : draft.subject;
  return {
    ...draft,
    mode,
    to: merge(next.to, draft.to),
    cc: merge(next.cc, draft.cc),
    subject,
    forwardAsAttachment: false,
    inReplyTo: original.id,
  };
}

/** Autosaved, remotely synced versions close quietly; incomplete recipient text still needs a choice. */
export function needsClosePrompt(
  draft: Draft,
  stored: StoredDraft | null,
  options: { initial?: Draft; empty?: boolean } = {},
): boolean {
  if (options.empty ?? isEmpty(draft)) return stored !== null && draft !== options.initial;
  if (stored === null && draft === options.initial) return false;
  const { message, invalid } = toMessage(draft);
  return (
    !stored?.synced ||
    stored.accountId !== draft.accountId ||
    invalid.length > 0 ||
    JSON.stringify(message) !== JSON.stringify(toMessage(fromStored(stored)).message)
  );
}
