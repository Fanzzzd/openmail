import { Effect } from "effect";
import MailComposer from "nodemailer/lib/mail-composer";

import type { Address, OutgoingMessage } from "./domain.js";
import { PermanentError } from "./errors.js";

const format = (a: Address) => (a.name ? { name: a.name, address: a.address } : a.address);

/** Threading headers of the message being replied to or forwarded. */
export interface Threading {
  readonly messageId?: string | undefined;
  readonly references?: string | undefined;
}

/**
 * RFC 5322 message for providers that take raw MIME (Gmail `messages.send`,
 * SMTP). UTF-8 headers and bodies are encoded by nodemailer's composer. A
 * message that fails to build fails the same way every time, so the error is
 * permanent.
 */
export const buildMime = Effect.fnUntraced(function* (
  from: Address,
  message: OutgoingMessage,
  threading: Threading = {},
): Effect.fn.Return<Buffer, PermanentError> {
  const replying = message.mode === "reply" || message.mode === "replyAll";
  const references = [threading.references, threading.messageId].filter(Boolean).join(" ");
  const composer = new MailComposer({
    from: format(from),
    to: message.to.map(format),
    cc: message.cc.map(format),
    bcc: message.bcc.map(format),
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    ...(replying && threading.messageId
      ? { inReplyTo: threading.messageId, references: references || undefined }
      : {}),
    attachments: message.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.mimeType,
      content: a.content,
      encoding: "base64",
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
