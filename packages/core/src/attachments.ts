/**
 * Attachment lookup shared by the provider adapters, and parts read from raw
 * MIME: inline images for the reader and a fallback for attachment content.
 */
import { Effect } from "effect";
import { simpleParser } from "mailparser";

import { ProviderError } from "./errors.js";

/**
 * Which attachment of a message to fetch, as listed on the stored message.
 * Adapters look it up by filename and its occurrence among attachments with
 * that name, so a provider that lists parts in another order still finds the
 * right one. `index` is the fallback when no name matches.
 */
export interface AttachmentRef {
  readonly index: number;
  readonly filename: string;
  /** 0 for the first attachment with this filename, 1 for the second, and so on. */
  readonly occurrence: number;
}

export function attachmentRef(
  attachments: readonly { readonly filename: string }[],
  index: number,
): AttachmentRef | undefined {
  const target = attachments[index];
  if (!target) return undefined;
  const occurrence = attachments
    .slice(0, index)
    .filter((a) => a.filename === target.filename).length;
  return { index, filename: target.filename, occurrence };
}

export function pickAttachment<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  ref: AttachmentRef,
): T | undefined {
  const named = items.filter((item) => nameOf(item) === ref.filename);
  return named[ref.occurrence] ?? items[ref.index];
}

/** Inline images bigger than this stay out of the reader; the message shows them as broken. */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

const parse = (raw: Uint8Array) =>
  Effect.tryPromise({
    try: () => simpleParser(Buffer.from(raw), { skipImageLinks: true }),
    catch: (error) =>
      new ProviderError({
        message: `Cannot read the message: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

/** Inline images (parts with a Content-ID) as data: URLs keyed by Content-ID without brackets. */
export const inlineImagesFromRaw = (raw: Uint8Array) =>
  Effect.map(parse(raw), (parsed) => {
    const out: Record<string, string> = {};
    let total = 0;
    for (const a of parsed.attachments) {
      const cid = a.cid ?? a.contentId?.replace(/^<|>$/g, "");
      if (!cid || !a.contentType.toLowerCase().startsWith("image/")) continue;
      total += a.size;
      if (total > MAX_INLINE_BYTES) break;
      out[cid] = `data:${a.contentType};base64,${a.content.toString("base64")}`;
    }
    return out;
  });

/** An attachment's content read from raw MIME, for providers without a per-part API. */
export const attachmentFromRaw = (raw: Uint8Array, ref: AttachmentRef) =>
  Effect.map(parse(raw), (parsed) => {
    const listed = parsed.attachments.filter((a) => !a.related);
    const found = pickAttachment(listed, (a) => a.filename ?? "attachment", ref);
    return found ? new Uint8Array(found.content) : undefined;
  });
