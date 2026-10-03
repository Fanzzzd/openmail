import { compatibleMime, normalizeMimeCharsets } from "../mime-compat.js";
import PostalMime, { type Address } from "postal-mime";
import { Layer } from "effect";
import { buildMobileMime } from "./compose.js";
import { MailCodec, type MimeAddresses, type MimeMessage } from "../mail-codec.js";
import { PermanentError } from "../../errors.js";

const addresses = (value: readonly Address[]): MimeAddresses => ({
  value,
  text: value.map((address) => address.address ?? address.name).join(", "),
});
async function parsePortableMime(raw: Uint8Array): Promise<MimeMessage> {
  if (raw.byteLength > 25 * 1024 * 1024)
    throw new PermanentError({ message: "Mobile MIME exceeds 25 MiB" });
  const email = await PostalMime.parse(normalizeMimeCharsets(raw), {
    attachmentEncoding: "arraybuffer",
    forceRfc822Attachments: true,
    maxNestingDepth: 32,
    maxHeadersSize: 256 * 1024,
    maxRfc822NestingDepth: 0,
  }).catch(() => {
    throw new PermanentError({ message: "Cannot parse MIME message" });
  });
  return {
    html: email.html ?? false,
    ...(email.text === undefined ? {} : { text: email.text }),
    ...(email.subject === undefined ? {} : { subject: email.subject }),
    ...(email.from ? { from: addresses([email.from]) } : {}),
    ...(email.to ? { to: addresses(email.to) } : {}),
    ...(email.replyTo ? { replyTo: addresses(email.replyTo) } : {}),
    ...(email.cc ? { cc: addresses(email.cc) } : {}),
    ...(email.bcc ? { bcc: addresses(email.bcc) } : {}),
    ...(email.inReplyTo ? { inReplyTo: email.inReplyTo } : {}),
    ...(email.date ? { date: new Date(email.date) } : {}),
    headers: new Map(email.headers.map((header) => [header.key, header.value])),
    attachments: email.attachments.map((part) => {
      if (typeof part.content === "string")
        throw new PermanentError({ message: "Unexpected mobile attachment encoding" });
      const content =
        part.content instanceof Uint8Array ? part.content : new Uint8Array(part.content);
      return {
        content,
        size: content.byteLength,
        contentType: part.mimeType,
        related: part.related ?? false,
        headers: new Map<string, unknown>(
          part.method
            ? [["content-type", { value: part.mimeType, params: { method: part.method } }]]
            : [],
        ),
        ...(part.filename ? { filename: part.filename } : {}),
        ...(part.contentId
          ? { contentId: part.contentId, cid: part.contentId.replace(/^<|>$/g, "") }
          : {}),
      };
    }),
  };
}
export async function parseMobileMime(raw: Uint8Array): Promise<MimeMessage> {
  try {
    return await compatibleMime(await parsePortableMime(raw), parsePortableMime, raw);
  } catch (cause) {
    if (cause instanceof PermanentError) throw cause;
    const error = new PermanentError({ message: "Cannot parse MIME message" });
    Object.defineProperty(error, "cause", { value: cause, configurable: true });
    throw error;
  }
}
/** Portable reader and send MIME, with the shared compose transport sanitizer. */
export const mobileMailCodecLayer = Layer.succeed(MailCodec, {
  parse: parseMobileMime,
  build: buildMobileMime,
});
