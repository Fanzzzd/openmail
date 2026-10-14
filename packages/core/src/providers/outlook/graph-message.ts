/** An OutgoingMessage as Graph message fields, plus the size and upload checks send and drafts share. */

import type { OutgoingMessage } from "../../domain/changes.js";
import type { Address } from "../../domain/message.js";
import { htmlDocument } from "../../mime/mime.js";
import { composeTransportHtml } from "../../compose/compose-transport.js";
import { largeAttachment } from "./upload.js";
import { Buffer } from "../../platform/bytes.js";
import { REQUEST_LIMIT } from "./graph.js";
import { Effect } from "effect";
import { PermanentError } from "../../domain/errors.js";
import { attachmentProblem, attachmentProblemMessage } from "../../mime/attachment-policy.js";

export function fileAttachment(a: OutgoingMessage["attachments"][number]) {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: a.filename,
    contentType: a.mimeType,
    contentBytes: a.content,
    ...(a.contentId ? { contentId: a.contentId, isInline: true } : {}),
  };
}

const recipients = (list: readonly Address[]) =>
  list.map((a) => ({ emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } }));

/** Custom internet headers are create-only; this property also supports draft updates. */
export const MARKDOWN_DRAFT_PROPERTY =
  "String {57d14d35-4d11-4f8f-ae63-961883378d87} Name OpenmailMarkdownSource";

/** Fingerprint of the last update written to a draft; see DraftRemote.writeNonce. */
export const DRAFT_WRITE_PROPERTY =
  "String {57d14d35-4d11-4f8f-ae63-961883378d87} Name OpenmailDraftWrite";

export function graphFields(message: OutgoingMessage) {
  return {
    subject: message.subject,
    body: message.html
      ? { contentType: "html", content: htmlDocument(composeTransportHtml(message) ?? "") }
      : { contentType: "text", content: message.text },
    toRecipients: recipients(message.to),
    ccRecipients: recipients(message.cc),
    bccRecipients: recipients(message.bcc),
  };
}

export const draftKey = (accountId: string, id: string) => `${accountId}\0${id}`;
export const keepsInherited = (message: OutgoingMessage) =>
  message.mode === "forward" && message.includeOriginalAttachments === undefined;
export function needsUpload(message: OutgoingMessage, fields?: object) {
  if (message.attachments.some(largeAttachment)) return true;
  const graphMessage = {
    ...(fields ?? graphFields(message)),
    attachments: message.attachments.map(fileAttachment),
  };
  return (
    Buffer.byteLength(
      JSON.stringify(fields ? graphMessage : { message: graphMessage, saveToSentItems: true }),
    ) > REQUEST_LIMIT
  );
}

export const checkRequestSize = (body: string) =>
  Buffer.byteLength(body) > REQUEST_LIMIT
    ? Effect.fail(
        new PermanentError({
          message:
            "Outlook message requests cannot exceed 4 MB. Large attached messages cannot be uploaded as Outlook items.",
        }),
      )
    : Effect.void;

export const forwardsMessage = (message: OutgoingMessage) =>
  message.attachments.some((a) => a.mimeType.toLowerCase() === "message/rfc822");

export const checkAttachmentSize = (message: OutgoingMessage) => {
  const problem = attachmentProblem("outlook", message.attachments, message);
  return problem
    ? Effect.fail(new PermanentError({ message: attachmentProblemMessage(problem) }))
    : Effect.void;
};
