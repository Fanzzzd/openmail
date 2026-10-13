import { Context, Effect } from "effect";
import type { Address } from "../domain/message.js";
import type { OutgoingMessage } from "../domain/changes.js";
import type { PermanentError } from "../domain/errors.js";

export interface MimeAddress {
  readonly name: string;
  readonly address?: string;
  readonly group?: readonly MimeAddress[];
}
export interface MimeAddresses {
  readonly value: readonly MimeAddress[];
  readonly text: string;
}
export interface MimePart {
  readonly filename?: string;
  readonly contentType: string;
  readonly content: Uint8Array;
  readonly size: number;
  readonly cid?: string;
  readonly contentId?: string;
  readonly related: boolean;
  readonly headers: Map<string, unknown>;
}
export interface MimeMessage {
  readonly headerLines?: readonly { readonly key: string; readonly line: string }[];
  readonly messageId?: string;
  readonly references?: string | readonly string[];
  readonly priority?: string;
  readonly attachments: readonly MimePart[];
  readonly headers: Map<string, unknown>;
  readonly subject?: string;
  readonly text?: string;
  readonly html: string | false;
  readonly from?: MimeAddresses;
  readonly to?: MimeAddresses | MimeAddresses[];
  readonly replyTo?: MimeAddresses;
  readonly cc?: MimeAddresses | MimeAddresses[];
  readonly bcc?: MimeAddresses | MimeAddresses[];
  readonly inReplyTo?: string;
  readonly date?: Date;
}
export interface MimeParseOptions {
  readonly skipImageLinks?: boolean;
  readonly skipTextToHtml?: boolean;
  readonly skipHtmlToText?: boolean;
  readonly maxHtmlLengthToParse?: number;
}
export interface Threading {
  readonly messageId?: string;
  readonly references?: string;
}
export interface MailCodecPort {
  readonly parse: (raw: Uint8Array, options?: MimeParseOptions) => Promise<MimeMessage>;
  readonly build: (
    from: Address,
    message: OutgoingMessage,
    threading?: Threading,
    options?: { draft?: boolean; messageId?: string },
  ) => Effect.Effect<Uint8Array, PermanentError>;
}
export class MailCodec extends Context.Service<MailCodec, MailCodecPort>()("openmail/MailCodec") {}
export const parseMime = (raw: Uint8Array, options?: MimeParseOptions) =>
  Effect.flatMap(MailCodec, (codec) => Effect.tryPromise(() => codec.parse(raw, options)));
export function mimeAddresses(
  value: MimeAddresses | readonly MimeAddresses[] | undefined,
): Address[] {
  const objects = Array.isArray(value) ? value : value ? [value] : [];
  return objects.flatMap((object) =>
    object.value.flatMap((address: MimeAddress) =>
      [address, ...(address.group ?? [])].flatMap((item) =>
        item.address ? [{ name: item.name, address: item.address }] : [],
      ),
    ),
  );
}
