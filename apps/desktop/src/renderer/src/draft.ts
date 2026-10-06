import { quoteDate } from "./format";
import {
  displayName,
  formatAddress,
  parseAddresses,
  applySignature,
  replyFromAddress,
  replyRecipients,
  replySubject,
  forwardSubject,
  type SendAs,
  type SignatureOptions,
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
  syncError?: string | null;
  syncRetrying?: boolean;
  localOnly?: boolean;
  signatureId?: string | null;
  organization?: OutgoingMessage["draftOrganization"];
  /** The agent proposal this draft came from. */
  proposalId?: number;
  agentOrigin?: OutgoingMessage["agentOrigin"];
}

const newDraftId = () => `draft:${crypto.randomUUID()}`;

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

export { formatAddress, parseAddresses, ADDRESS_SEPARATOR } from "@openmail/core/schema";

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
  replyFrom?: { preference: "received" | "default"; aliases: readonly SendAs[] },
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
    ...(mode !== "forward" && replyFrom
      ? { from: replyFromAddress(m, account, replyFrom.aliases, replyFrom.preference) }
      : {}),
    to: to.map(formatAddress).join(", "),
    cc: cc.map(formatAddress).join(", "),
    bcc: "",
    subject: mode === "forward" ? forwardSubject(m.subject) : replySubject(m.subject),
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
    ...(m.agentOrigin ? { agentOrigin: m.agentOrigin } : {}),
    synced: d.synced,
    ...(m.signatureId === undefined ? {} : { signatureId: m.signatureId }),
    syncError: d.syncError,
    syncRetrying: d.syncRetrying,
    localOnly: d.localOnly,
    ...(m.draftOrganization ? { organization: m.draftOrganization } : {}),
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
      ...(d.agentOrigin ? { agentOrigin: d.agentOrigin } : {}),
      ...(d.from ? { from: d.from } : {}),
      to: to.addresses,
      cc: cc.addresses,
      bcc: bcc.addresses,
      subject: d.subject,
      text: body.text,
      ...(body.kind === "rich"
        ? {
            html: body.html,
            ...(d.body.kind === "rich" && d.body.font ? { composeFont: d.body.font } : {}),
            ...(d.body.kind === "rich" && d.body.originalHtml !== undefined
              ? { originalHtml: d.body.originalHtml }
              : {}),
          }
        : {}),
      attachments: d.attachments,
      ...(d.organization ? { draftOrganization: d.organization } : {}),
      ...(d.includeOriginalAttachments === undefined
        ? {}
        : { includeOriginalAttachments: d.includeOriginalAttachments }),
      mode: d.mode,
      ...(d.signatureId === undefined ? {} : { signatureId: d.signatureId }),
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

export function isEmpty(d: Draft, signature?: string, options?: SignatureOptions): boolean {
  const body = d.body.text.trim();
  const automatic = signature
    ? richComposeBody(
        textComposeHtml(applySignature("", undefined, signature, options)),
      ).text.trim()
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
    ? (mode === "forward" ? forwardSubject : replySubject)(
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
    (!stored?.synced && !stored?.localOnly) ||
    stored.accountId !== draft.accountId ||
    invalid.length > 0 ||
    JSON.stringify(message) !== JSON.stringify(toMessage(fromStored(stored)).message)
  );
}
