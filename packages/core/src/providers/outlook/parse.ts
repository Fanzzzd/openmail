import { Effect, Schema } from "effect";
import { type AttachmentRef, MEDIA_RAW_TOO_LARGE, pickAttachment } from "../../mime/attachments.js";
import type { Account } from "../../domain/account.js";
import type { Address, Attachment, IncomingMessage } from "../../domain/message.js";
import { PermanentError, ProviderError } from "../../domain/errors.js";
import { cleanDisplayName, messageSecurity } from "../../reader/message-security.js";
import { Buffer } from "../../platform/bytes.js";
import { finishInline, finishWith, type HtmlBody, HtmlText } from "../../platform/html-text.js";
import {
  decodedBody,
  hasSignedContainer,
  MAX_MIME_BYTES,
  withUuAttachments,
} from "../../platform/mime-compat.js";
import type { OutlookClient } from "./client.js";
import { AttachmentNames, GraphAddress, GraphMessage, writeFailure } from "./graph.js";

export const makeOutlookRead = (client: OutlookClient) =>
  Effect.gen(function* () {
    const { codec, get, getBytes } = client;
    const htmlText = yield* HtmlText;

    const parseGraph = (raw: GraphMessage, label: string, attachments: readonly Attachment[]) =>
      finishWith(htmlText, graphBody(raw, label, attachments));

    const incomingGraph = (
      account: Account,
      raw: GraphMessage,
      label: string,
      attachments: readonly Attachment[],
    ) =>
      Effect.flatMap(parseGraph(raw, label, attachments), (message) => {
        if (!hasSignedContainer(message)) return Effect.succeed(message);
        return fetchRaw(account, raw.id, MAX_MIME_BYTES).pipe(
          Effect.catchTag("PermanentError", (error) =>
            Effect.fail(new ProviderError({ message: error.message })),
          ),
          Effect.flatMap((source) =>
            Effect.tryPromise({
              try: () => codec.parse(source),
              catch: () => new ProviderError({ message: "Cannot parse signed MIME" }),
            }),
          ),
          Effect.flatMap((parsed) => finishWith(htmlText, decodedBody(message, parsed))),
          Effect.catch(() => Effect.succeed(message)),
        );
      });

    const fetchRaw = Effect.fn("Outlook.fetchRaw")(
      function* (account: Account, providerId: string, maxBytes?: number) {
        if (maxBytes !== undefined) {
          // Graph has no message byte-size property. Estimate from body and all
          // attachment sizes (including inline), then bound the MIME stream too.
          const metadata = yield* get(
            account.id,
            Schema.Struct({ body: Schema.Struct({ content: Schema.String }) }),
            `/me/messages/${encodeURIComponent(providerId)}?$select=body`,
          );
          const parts = yield* get(
            account.id,
            Schema.Struct({
              value: Schema.Array(Schema.Struct({ size: Schema.Number })),
              "@odata.nextLink": Schema.optionalKey(Schema.String),
            }),
            `/me/messages/${encodeURIComponent(providerId)}/attachments?$select=size`,
          );
          const estimate =
            128 * 1024 +
            Buffer.byteLength(metadata.body.content) * 3 +
            parts.value.reduce((total, part) => total + part.size * 2, 0);
          if (parts["@odata.nextLink"] || estimate > maxBytes)
            return yield* new PermanentError({ message: MEDIA_RAW_TOO_LARGE });
        }
        return yield* getBytes(
          account.id,
          `/me/messages/${encodeURIComponent(providerId)}/$value`,
          maxBytes,
        );
      },
      (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
    );

    const fetchAttachment = Effect.fn("Outlook.fetchAttachment")(
      function* (account: Account, providerId: string, ref: AttachmentRef) {
        // The same list, order and filter as the attachments stored on the message.
        const { value } = yield* get(
          account.id,
          AttachmentNames,
          `/me/messages/${encodeURIComponent(providerId)}/attachments?$select=id,name,isInline`,
        );
        const found = pickAttachment(
          value.filter((a) => !a.isInline),
          (a) => a.name,
          ref,
        );
        if (!found) {
          const bytes = yield* fetchRaw(account, providerId);
          const parsed = yield* Effect.tryPromise({
            try: () => codec.parse(bytes),
            catch: () => new ProviderError({ message: "Cannot parse attachment MIME" }),
          });
          const attachment = pickAttachment(
            parsed.attachments.filter((part) => !part.related),
            (part) => part.filename ?? "attachment",
            ref,
          );
          if (attachment) return new Uint8Array(attachment.content);
          return yield* new PermanentError({ message: `No attachment ${ref.filename}` });
        }
        // $value is the file for file attachments and MIME for attached messages.
        return yield* getBytes(
          account.id,
          `/me/messages/${encodeURIComponent(providerId)}/attachments/${encodeURIComponent(found.id)}/$value`,
        );
      },
      (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
    );
    return {
      fetchRaw,
      fetchAttachment,
      incomingGraph,
      parseGraph,
      parseConcurrency: htmlText.concurrency,
    };
  });
export type OutlookRead = Effect.Success<ReturnType<typeof makeOutlookRead>>;

export const expandedAttachments = (raw: GraphMessage): Attachment[] | undefined =>
  raw.attachments
    ?.filter((a) => !a.isInline)
    .map((a) => ({ filename: a.name, mimeType: a.contentType, size: a.size }));

function address(a: GraphAddress | null | undefined): Address {
  return {
    name: cleanDisplayName(a?.emailAddress?.name ?? ""),
    address: a?.emailAddress?.address ?? "",
  };
}

export const parseGraphMessage = (
  raw: GraphMessage,
  folderLabel: string,
  attachments: readonly Attachment[],
): IncomingMessage => finishInline(graphBody(raw, folderLabel, attachments));

export function graphBody(
  raw: GraphMessage,
  folderLabel: string,
  attachments: readonly Attachment[],
): HtmlBody<IncomingMessage> {
  const content = raw.body?.content ?? "";
  const isHtml = raw.body?.contentType.toLowerCase() === "html";
  return isHtml
    ? {
        html: content,
        finish: (text) => graphMessage(raw, folderLabel, attachments, content, text),
      }
    : { finish: () => graphMessage(raw, folderLabel, attachments, "", content) };
}

function graphMessage(
  raw: GraphMessage,
  folderLabel: string,
  attachments: readonly Attachment[],
  html: string,
  text: string,
): IncomingMessage {
  const isUnread = raw.isRead === false;
  const isStarred = raw.flag?.flagStatus === "flagged";

  const labels = [folderLabel, ...(raw.categories ?? []).map((name) => `category:${name}`)];
  if (raw.inferenceClassification)
    labels.push(raw.inferenceClassification === "focused" ? "CATEGORY_PERSONAL" : "CATEGORY_OTHER");
  if (raw.importance === "high") labels.push("IMPORTANT");
  if (isUnread) labels.push("UNREAD");
  if (isStarred) labels.push("STARRED");

  return withUuAttachments({
    providerId: raw.id,
    threadId: raw.conversationId,
    ...(raw.webLink ? { webLink: raw.webLink } : {}),
    subject: raw.subject ?? "",
    from: address(raw.from),
    to: (raw.toRecipients ?? []).map(address),
    cc: (raw.ccRecipients ?? []).map(address),
    bcc: (raw.bccRecipients ?? []).map(address),
    ...(raw.internetMessageHeaders ? { headers: raw.internetMessageHeaders } : {}),
    ...(raw.internetMessageId ? { rfcMessageId: raw.internetMessageId } : {}),
    replyTo: (raw.replyTo ?? []).map(address).filter((a) => a.address.trim()),
    date: Date.parse(raw.receivedDateTime || raw.sentDateTime || ""),
    snippet: raw.bodyPreview ?? "",
    bodyText: text,
    bodyHtml: html,
    // Graph header order is not used to establish authentication trust.
    security: messageSecurity([], "outlook"),
    ...(/eventMessage/i.test(raw["@odata.type"] ?? "") ? { hasCalendar: true } : {}),
    labels,
    attachments,
    isUnread,
    isStarred,
  });
}
