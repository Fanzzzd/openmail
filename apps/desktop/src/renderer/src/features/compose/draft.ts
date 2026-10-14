import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
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
  providerCapabilities,
} from "@openmail/core/schema";
import type {
  Account,
  Address,
  DraftInput,
  Message,
  OutgoingAttachment,
  OutgoingMessage,
  StoredDraft,
} from "../../../../shared/api";

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

// Entry code loads this module through draft-loader.ts and builds bodies with these.
export { applyComposeSignature, richComposeBody, textComposeHtml } from "@openmail/core/schema";

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

/**
 * The date in a quote or forward header. Recipients read it later, so it is
 * absolute ("Mon, Oct 13, 2026, 10:24 AM"), never "today".
 */
export function mailDate(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
}

/** The line above a quoted reply, in the app language, as Gmail and Apple Mail write it. */
function replyHeader(i18n: I18n, m: Message): string {
  const date = mailDate(m.date, i18n.locale);
  const name = displayName(m.from);
  const address = m.from.address;
  return i18n._(
    msg({
      context: "outgoing reply quote header",
      comment: "Written into the sent message above the quoted text.",
      message: `On ${date}, ${name} <${address}> wrote:`,
    }),
  );
}

function quote(i18n: I18n, m: Message): string {
  const lines = m.bodyText.trimEnd().split("\n");
  return `\n\n${replyHeader(i18n, m)}\n${lines.map((l) => `> ${l}`).join("\n")}`;
}

/** The header block above a forwarded message's text, in the app language. */
function forwardHeader(i18n: I18n, m: Message): string {
  const from = formatAddress(m.from);
  const date = mailDate(m.date, i18n.locale);
  const subject = m.subject;
  const to = m.to.map(formatAddress).join(", ");
  const banner = i18n._(msg({ context: "outgoing forward header", message: "Forwarded message" }));
  return [
    `---------- ${banner} ---------`,
    i18n._(msg({ context: "outgoing forward header", message: `From: ${from}` })),
    i18n._(msg({ context: "outgoing forward header", message: `Date: ${date}` })),
    i18n._(msg({ context: "outgoing forward header", message: `Subject: ${subject}` })),
    i18n._(msg({ context: "outgoing forward header", message: `To: ${to}` })),
  ].join("\n");
}

/** To and Cc of a reply or forward, as recipient text. */
function addressing(
  mode: Exclude<ComposeMode, "new">,
  m: Message,
  account: Account,
  aliases: readonly Pick<SendAs, "accountId" | "address">[],
): { to: string; cc: string } {
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
  return { to: to.map(formatAddress).join(", "), cc: cc.map(formatAddress).join(", ") };
}

/**
 * A reply, reply-all or forward of `m`, sent from the account that received
 * it. `asAttachment` forwards the original as an .eml instead of quoting it.
 */
export function draftFor(
  i18n: I18n,
  mode: Exclude<ComposeMode, "new">,
  m: Message,
  account: Account,
  asAttachment = false,
  aliases: readonly Pick<SendAs, "accountId" | "address">[] = [],
  selectedText?: string,
  replyFrom?: { preference: "received" | "default"; aliases: readonly SendAs[] },
): Draft {
  const { to, cc } = addressing(mode, m, account, aliases);
  const forwardAsAttachment = mode === "forward" && asAttachment;

  const quoted = selectedText === undefined ? m : { ...m, bodyText: selectedText, bodyHtml: "" };
  const body = forwardAsAttachment
    ? ""
    : mode === "forward"
      ? `\n\n${forwardHeader(i18n, m)}\n\n${quoted.bodyText}`
      : quote(i18n, quoted);

  return {
    id: newDraftId(),
    mode,
    accountId: account.id,
    ...(mode !== "forward" && replyFrom
      ? { from: replyFromAddress(m, account, replyFrom.aliases, replyFrom.preference) }
      : {}),
    to,
    cc,
    bcc: "",
    subject: mode === "forward" ? forwardSubject(m.subject) : replySubject(m.subject),
    body:
      mode === "forward" && !forwardAsAttachment && quoted.bodyHtml
        ? remoteComposeBody(
            `${textComposeHtml(body.slice(0, body.length - quoted.bodyText.length))}${preservedComposeHtml(quoted.bodyHtml)}`,
          )
        : richComposeBody(textComposeHtml(body)),
    ...(providerCapabilities(account.provider).serverForward &&
    mode === "forward" &&
    !forwardAsAttachment
      ? {}
      : { includeOriginalAttachments: mode === "forward" && !forwardAsAttachment }),
    loadOriginalAttachments:
      !providerCapabilities(account.provider).serverForward &&
      mode === "forward" &&
      !forwardAsAttachment,
    attachments: [],
    inReplyTo: m.id,
    forwardAsAttachment,
  };
}

/** A draft from core, as the compose window edits it. */
export function fromStored(d: StoredDraft): Draft {
  const m = normalizeComposeMessage(d.message);
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
            ...(body.hiddenTextRemoved ? { hiddenTextRemoved: true } : {}),
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
  const next = addressing(mode, original, account, aliases);
  const previous =
    draft.mode === "new" ? { to: "", cc: "" } : addressing(draft.mode, original, account, aliases);
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
