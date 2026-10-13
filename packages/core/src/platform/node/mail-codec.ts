import { compatibleMime } from "../mime-compat.js";
import type { MailCodecPort } from "../mail-codec.js";
import { buildMime } from "./compose.js";
import { PermanentError } from "../../domain/errors.js";
export const makeNodeMailCodec = (parse: MailCodecPort["parse"]): MailCodecPort => ({
  parse: async (raw, options) => {
    if (raw.byteLength > 64 * 1024 * 1024)
      throw new PermanentError({ message: "MIME exceeds 64 MiB" });
    try {
      return await parse(raw, options);
    } catch (cause) {
      const error = new PermanentError({ message: "Cannot parse MIME message" });
      Object.defineProperty(error, "cause", { value: cause, configurable: true });
      throw error;
    }
  },
  build: buildMime,
});
export const nodeMailCodec = makeNodeMailCodec(async (raw, options) => {
  const { simpleParser } = await import("mailparser");
  const parse = (inner: Uint8Array) => simpleParser(Buffer.from(inner), options);
  return compatibleMime(await parse(raw), parse, raw);
});
