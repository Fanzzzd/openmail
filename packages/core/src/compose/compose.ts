import { Buffer } from "../platform/bytes.js";
import { Effect } from "effect";
import { MailCodec } from "../platform/mail-codec.js";
import type { Address } from "../domain/message.js";
import type { OutgoingMessage } from "../domain/changes.js";
import type { Threading } from "../platform/mail-codec.js";
export type { Threading } from "../platform/mail-codec.js";
export const buildMime = (
  from: Address,
  message: OutgoingMessage,
  threading?: Threading,
  options?: { draft?: boolean; messageId?: string; writeNonce?: string },
) =>
  Effect.flatMap(MailCodec, (codec) => codec.build(from, message, threading, options)).pipe(
    Effect.map((raw) => Buffer.from(raw)),
  );
