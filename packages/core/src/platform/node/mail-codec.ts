import { simpleParser } from "mailparser";
import type { MailCodecPort } from "../mail-codec.js";
import { buildMime } from "./compose.js";
export const nodeMailCodec: MailCodecPort = {
  parse: (raw, options) => simpleParser(Buffer.from(raw), options),
  build: buildMime,
};
