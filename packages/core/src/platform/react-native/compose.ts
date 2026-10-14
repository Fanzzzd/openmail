import { Effect } from "effect";
import { Buffer } from "../bytes.js";
import { PlatformCrypto } from "../crypto.js";
import type { Address } from "../../domain/message.js";
import type { OutgoingMessage } from "../../domain/changes.js";
import { DRAFT_WRITE_HEADER, type Threading } from "../mail-codec.js";
import { PermanentError } from "../../domain/errors.js";
import { normalizeComposeMessage } from "../../compose/compose-body.js";
import { composeTransportHtml } from "../../compose/compose-transport.js";

const encoded = (value: string) => `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
const headerSafe = (value: string) => {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid MIME header");
  return value;
};
const address = (value: Address) => {
  const email = headerSafe(value.address);
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(email)) throw new Error("Invalid MIME address");
  return value.name ? `${encoded(headerSafe(value.name))} <${email}>` : email;
};
const wrap = (value: string) => value.match(/.{1,76}/g)?.join("\r\n") ?? "";
const textPart = (mime: string, body: string) =>
  [
    `Content-Type: ${mime}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap(Buffer.from(body).toString("base64")),
  ].join("\r\n");
/** Portable RFC 5322 composer: base64 bodies cannot collide with MIME boundaries. */
export const buildMobileMime = (
  from: Address,
  message: OutgoingMessage,
  threading: Threading = {},
  options: { draft?: boolean; messageId?: string; writeNonce?: string } = {},
) =>
  Effect.flatMap(PlatformCrypto, (crypto) =>
    Effect.try({
      try: () => {
        const prepared = normalizeComposeMessage(message);
        const mixed = `openmail-${crypto.randomUUID()}`;
        const alternative = `openmail-${crypto.randomUUID()}`;
        const headers = [
          `From: ${address(from)}`,
          `To: ${prepared.to.map(address).join(", ")}`,
          `Cc: ${prepared.cc.map(address).join(", ")}`,
          `Bcc: ${prepared.bcc.map(address).join(", ")}`,
          `Subject: ${encoded(headerSafe(prepared.subject))}`,
          `Date: ${new Date().toUTCString()}`,
          `Message-ID: ${headerSafe(options.messageId ?? `<${crypto.randomUUID()}@${from.address.split("@")[1] ?? "openmail.local"}>`)}`,
          "MIME-Version: 1.0",
          `Content-Type: multipart/mixed; boundary="${mixed}"`,
        ];
        if (options.draft && options.writeNonce)
          headers.push(`${DRAFT_WRITE_HEADER}: ${headerSafe(options.writeNonce)}`);
        if ((prepared.mode === "reply" || prepared.mode === "replyAll") && threading.messageId) {
          headers.push(`In-Reply-To: ${headerSafe(threading.messageId)}`);
          headers.push(
            `References: ${headerSafe([threading.references, threading.messageId].filter(Boolean).join(" "))}`,
          );
        }
        const html = composeTransportHtml(prepared);
        const body = html
          ? [
              `Content-Type: multipart/alternative; boundary="${alternative}"`,
              "",
              `--${alternative}`,
              textPart("text/plain", prepared.text),
              `--${alternative}`,
              textPart("text/html", html),
              `--${alternative}--`,
            ].join("\r\n")
          : textPart("text/plain", prepared.text);
        const parts = [
          body,
          ...prepared.attachments.map((file) => {
            const mime = headerSafe(file.mimeType);
            if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime) || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content))
              throw new Error("Invalid MIME attachment");
            const filename = encoded(headerSafe(file.filename));
            return [
              `Content-Type: ${mime}`,
              `Content-Disposition: ${file.contentId ? "inline" : "attachment"}; filename="${filename}"`,
              ...(file.contentId ? [`Content-ID: <${headerSafe(file.contentId)}>`] : []),
              "Content-Transfer-Encoding: base64",
              "",
              wrap(file.content),
            ].join("\r\n");
          }),
        ];
        const raw = Buffer.from(
          [
            ...headers,
            "",
            ...parts.flatMap((part) => [`--${mixed}`, part]),
            `--${mixed}--`,
            "",
          ].join("\r\n"),
        );
        if (raw.byteLength > 25 * 1024 * 1024) throw new Error("Mobile MIME exceeds 25 MiB");
        return raw;
      },
      catch: () => new PermanentError({ message: "Could not build the mobile message" }),
    }),
  );
