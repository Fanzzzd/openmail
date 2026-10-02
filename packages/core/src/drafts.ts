/**
 * Turning drafts into what providers take and back: the attached original of
 * a forward-as-attachment, and a provider's raw draft parsed for editing.
 */
import { Effect } from "effect";
import { simpleParser } from "mailparser";
import { remoteComposeBody } from "./compose-body.js";
import {
  draftBodyFingerprint,
  draftTextFingerprint,
  matchesMarkdownDraft,
  type MarkdownDraftSource,
} from "./markdown-draft.js";

import type {
  Address,
  ComposeMode,
  ComposeFont,
  Draft,
  Message,
  OutgoingAttachment,
  OutgoingMessage,
} from "./domain.js";
import { ProviderError } from "./errors.js";
import { addresses } from "./imap.js";
import type { StoredDraft } from "./services.js";

/** What a raw draft from the provider holds, ready for the compose window. */
export interface ParsedDraft {
  font?: ComposeFont;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  text: string;
  html?: string;
  originalHtml?: string;
  markdown?: boolean;
  /** Actual received HTML, computed before sanitization so external edits invalidate the source. */
  bodyFingerprint?: string;
  attachments: OutgoingAttachment[];
  /** The draft answers another message (In-Reply-To header present). */
  isReply: boolean;
}

export const parseRawDraft = (raw: Uint8Array) =>
  Effect.tryPromise({
    try: () =>
      simpleParser(Buffer.from(raw), {
        skipImageLinks: true,
        skipTextToHtml: true,
        skipHtmlToText: true,
      }),
    catch: (error) =>
      new ProviderError({
        message: `Cannot read the draft: ${error instanceof Error ? error.message : String(error)}`,
      }),
  }).pipe(
    Effect.map((parsed): ParsedDraft => {
      const html = parsed.html || undefined;
      const text = parsed.text ?? "";
      const bodyFingerprint = html === undefined ? undefined : draftBodyFingerprint(html);
      const declaredFingerprint = parsed.headers.get("x-openmail-markdown-body-sha256");
      const metadata = {
        version: 1,
        text,
        bodyFingerprint: typeof declaredFingerprint === "string" ? declaredFingerprint : "",
      } satisfies MarkdownDraftSource;
      const markdown =
        parsed.headers.get("x-openmail-markdown") === "1" &&
        parsed.headers.get("x-openmail-markdown-source-sha256") === draftTextFingerprint(text) &&
        matchesMarkdownDraft(metadata, bodyFingerprint);
      return {
        to: addresses(parsed.to),
        cc: addresses(parsed.cc),
        bcc: addresses(parsed.bcc),
        subject: parsed.subject ?? "",
        ...(markdown ? { text, markdown: true } : html ? remoteComposeBody(html) : { text }),
        ...(bodyFingerprint === undefined ? {} : { bodyFingerprint }),
        attachments: parsed.attachments.map((a) => ({
          filename: a.filename ?? "attachment",
          mimeType: a.contentType,
          content: a.content.toString("base64"),
          ...(a.contentId ? { contentId: a.contentId.replace(/^<|>$/g, "") } : {}),
        })),
        isReply: Boolean(parsed.inReplyTo),
      };
    }),
  );

/** Graph has an editable source property instead of an updateable MIME header. */
export function withDraftMarkdownSource(
  parsed: ParsedDraft,
  source: MarkdownDraftSource | undefined,
): ParsedDraft {
  if (source === undefined || !matchesMarkdownDraft(source, parsed.bodyFingerprint)) return parsed;
  const { html: _html, originalHtml: _originalHtml, ...rest } = parsed;
  return { ...rest, text: source.text, markdown: true };
}

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

export function draftOrganizationKey(
  organization: OutgoingMessage["draftOrganization"],
): string | null {
  return organization
    ? JSON.stringify({
        labels: [...new Set(organization.labels)].toSorted(),
        starred: organization.starred,
      })
    : null;
}

/** Identifies an attachment list well enough to tell whether it changed since the last push. */
export function attachmentsKey(list: readonly OutgoingAttachment[]): string {
  return JSON.stringify(
    list.map((a) => [a.filename, a.mimeType, a.contentId, a.content.length, a.content.slice(-16)]),
  );
}

export function toDraft(d: StoredDraft, pendingSave = false): Draft {
  return {
    id: d.id,
    accountId: d.accountId,
    message: d.message,
    updatedAt: d.updatedAt,
    proposalId: d.proposalId,
    synced: d.remote !== null && !pendingSave,
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
    ...(parsed.font ? { composeFont: parsed.font } : {}),
    cc: parsed.cc,
    bcc: parsed.bcc,
    subject: parsed.subject,
    text: parsed.text,
    ...(parsed.html === undefined ? {} : { html: parsed.html }),
    ...(parsed.originalHtml === undefined ? {} : { originalHtml: parsed.originalHtml }),
    ...(parsed.markdown ? { markdown: true } : {}),
    attachments: parsed.attachments,
    mode,
    ...(original && mode !== "new" ? { inReplyTo: original.id } : {}),
  };
}
