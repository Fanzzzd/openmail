import type { Message } from "../domain/message.js";
import type { Threading } from "../platform/mail-codec.js";

/** The message a reply or forward answers, as the outbox hands it to an adapter. */
export interface SendOriginal {
  readonly providerId: string;
  readonly threadId: string;
  /**
   * Message-ID and References from the local cache. Adapters read the provider's copy first
   * and use these when it is gone (purged, moved) or cannot be read.
   */
  readonly cached?: Threading;
  /** The cached copy lists attachments, which a provider-side forward would carry along. */
  readonly hasAttachments?: boolean;
}

const bracketed = (id: string) => {
  const trimmed = id.trim();
  return /^<.*>$/.test(trimmed) ? trimmed : `<${trimmed}>`;
};

/** The original's cached threading headers and attachment presence. */
export function sendOriginal(
  providerId: string,
  source: Pick<Message, "threadId" | "rfcMessageId" | "headers" | "attachments">,
): SendOriginal {
  const references = source.headers
    ?.find((header) => header.name.toLowerCase() === "references")
    ?.value.trim();
  const messageId = source.rfcMessageId?.trim();
  const cached: Threading = {
    ...(messageId ? { messageId: bracketed(messageId) } : {}),
    ...(references ? { references } : {}),
  };
  return {
    providerId,
    threadId: source.threadId,
    ...(cached.messageId ? { cached } : {}),
    ...(source.attachments.length ? { hasAttachments: true } : {}),
  };
}

/** The cached headers, or nothing when the cache has no Message-ID to reply to. */
export const cachedThreading = (original: SendOriginal): Threading => original.cached ?? {};
