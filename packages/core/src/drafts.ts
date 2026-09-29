/**
 * Turning drafts into what providers take and back: the attached original of
 * a forward-as-attachment, and a provider's raw draft parsed for editing.
 */
import { Effect } from "effect";
import { simpleParser } from "mailparser";

import type {
  Address,
  ComposeMode,
  Draft,
  Message,
  OutgoingAttachment,
  OutgoingMessage,
} from "./domain.js";
import { ProviderError } from "./errors.js";
import { addresses } from "./imap.js";
import { htmlToText } from "./mime.js";
import type { StoredDraft } from "./services.js";

/** What a raw draft from the provider holds, ready for the compose window. */
export interface ParsedDraft {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
  attachments: OutgoingAttachment[];
  /** The draft answers another message (In-Reply-To header present). */
  isReply: boolean;
}

export const parseRawDraft = (raw: Uint8Array) =>
  Effect.tryPromise({
    try: () => simpleParser(Buffer.from(raw), { skipImageLinks: true }),
    catch: (error) =>
      new ProviderError({
        message: `Cannot read the draft: ${error instanceof Error ? error.message : String(error)}`,
      }),
  }).pipe(
    Effect.map((parsed): ParsedDraft => ({
      to: addresses(parsed.to),
      cc: addresses(parsed.cc),
      bcc: addresses(parsed.bcc),
      subject: parsed.subject ?? "",
      text: parsed.text ?? htmlToText(parsed.html || ""),
      attachments: parsed.attachments
        .filter((a) => !a.related)
        .map((a) => ({
          filename: a.filename ?? "attachment",
          mimeType: a.contentType,
          content: a.content.toString("base64"),
        })),
      isReply: Boolean(parsed.inReplyTo),
    })),
  );

/** The original message as an .eml attachment, named after its subject. */
export function originalAttachment(subject: string, raw: Uint8Array): OutgoingAttachment {
  const name =
    subject
      .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "message";
  return {
    filename: `${name}.eml`,
    mimeType: "message/rfc822",
    content: Buffer.from(raw).toString("base64"),
  };
}

/** Identifies an attachment list well enough to tell whether it changed since the last push. */
export function attachmentsKey(list: readonly OutgoingAttachment[]): string {
  return JSON.stringify(
    list.map((a) => [a.filename, a.mimeType, a.content.length, a.content.slice(-16)]),
  );
}

export function toDraft(d: StoredDraft): Draft {
  return {
    id: d.id,
    accountId: d.accountId,
    message: d.message,
    updatedAt: d.updatedAt,
    proposalId: d.proposalId,
    synced: d.remote !== null,
  };
}

/** A draft that came from another client, read back into the shape the compose window edits. */
export function importedMessage(parsed: ParsedDraft, thread: readonly Message[]): OutgoingMessage {
  // The draft sits in the thread it answers; the newest real message there is the original.
  const original = thread.filter((m) => !m.labels.includes("DRAFT")).at(-1);
  const forward = /^(fwd?|fw|转发)\s*[:：]/i.test(parsed.subject);
  const mode: ComposeMode =
    original && forward
      ? "forward"
      : original && parsed.isReply
        ? parsed.cc.length > 0
          ? "replyAll"
          : "reply"
        : "new";
  return {
    to: parsed.to,
    cc: parsed.cc,
    bcc: parsed.bcc,
    subject: parsed.subject,
    text: parsed.text,
    attachments: parsed.attachments,
    mode,
    ...(original && mode !== "new" ? { inReplyTo: original.id } : {}),
  };
}
