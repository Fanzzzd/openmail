import { compatibleMime } from "../mime-compat.js";
import { simpleParser } from "mailparser";
import type { MailCodecPort } from "../mail-codec.js";
import { buildMime } from "./compose.js";
export const nodeMailCodec: MailCodecPort = {
  parse: async (raw, options) =>
    compatibleMime(
      await simpleParser(Buffer.from(raw), options),
      (inner) => simpleParser(Buffer.from(inner), options),
      raw,
    ),
  build: buildMime,
};
