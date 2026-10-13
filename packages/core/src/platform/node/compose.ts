import { composeTransportHtml } from "../../compose/compose-body.js";
import { Effect } from "effect";

import type { Address, OutgoingMessage } from "../../domain/domain.js";
import { PermanentError } from "../../domain/errors.js";
import { htmlDocument } from "../../mime.js";
import { draftTextFingerprint, markdownDraftSource } from "../../compose/markdown-draft.js";

const format = (a: Address) => (a.name ? { name: a.name, address: a.address } : a.address);

/** Threading headers of the message being replied to or forwarded. */
export interface Threading {
  readonly messageId?: string;
  readonly references?: string | undefined;
}

/**
 * RFC 5322 message for providers that take raw MIME (Gmail `messages.send`,
 * SMTP, Graph for a forward as attachment). nodemailer declares
 * charset=utf-8 on every text part, writes non-ASCII headers as RFC 2047
 * encoded-words and filenames as RFC 2231, and passes an attached .eml
 * through byte for byte (8bit). A message that fails to build fails the
 * same way every time, so the error is permanent.
 */
export const buildMime = Effect.fnUntraced(function* (
  from: Address,
  message: OutgoingMessage,
  threading: Threading = {},
  options: { draft?: boolean; messageId?: string } = {},
): Effect.fn.Return<Buffer, PermanentError> {
  const replying = message.mode === "reply" || message.mode === "replyAll";
  const references = [threading.references, threading.messageId].filter(Boolean).join(" ");
  const { default: MailComposer } = yield* Effect.tryPromise({
    try: () => import("nodemailer/lib/mail-composer"),
    catch: (error) =>
      new PermanentError({
        message: `Could not build the message: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });
  const composer = new MailComposer({
    from: format(from),
    to: message.to.map(format),
    cc: message.cc.map(format),
    bcc: message.bcc.map(format),
    subject: message.subject,
    ...(options.messageId ? { messageId: options.messageId } : {}),
    headers:
      options.draft && message.markdown
        ? {
            "X-Openmail-Markdown": "1",
            "X-Openmail-Markdown-Body-SHA256": markdownDraftSource(message.text).bodyFingerprint,
            "X-Openmail-Markdown-Source-SHA256": draftTextFingerprint(message.text),
          }
        : {},
    text: message.text,
    ...(message.html ? { html: htmlDocument(composeTransportHtml(message) ?? "") } : {}),
    ...(message.calendar ? { icalEvent: message.calendar } : {}),
    ...(replying && threading.messageId
      ? { inReplyTo: threading.messageId, references: references || undefined }
      : {}),
    attachments: message.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.mimeType,
      content: a.content,
      encoding: "base64",
      ...(a.contentId ? { cid: a.contentId } : {}),
      // Without this nodemailer marks message/rfc822 parts inline, and a
      // forwarded .eml shows up in the body instead of as a file.
      contentDisposition: a.contentId ? ("inline" as const) : ("attachment" as const),
    })),
  });
  const mail = composer.compile();
  // Keep Bcc in the raw message: Gmail reads it to deliver, then strips it.
  // SMTP callers remove it themselves (imap.ts stripBcc).
  mail.keepBcc = true;
  return yield* Effect.callback<Buffer, PermanentError>((resume) => {
    mail.build((error, buffer) =>
      resume(
        error
          ? Effect.fail(
              new PermanentError({ message: `Could not build the message: ${error.message}` }),
            )
          : Effect.succeed(buffer),
      ),
    );
  });
});
