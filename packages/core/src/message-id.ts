import { Effect } from "effect";
import { PlatformCrypto } from "./platform/crypto.js";

export const newMessageId = (address: string) =>
  Effect.map(PlatformCrypto, (crypto) => `<${crypto.randomUUID()}@${address.split("@").at(-1)}>`);
