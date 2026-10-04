import { Effect } from "effect";
import { PlatformCrypto } from "./platform/crypto.js";

export const newMessageId = (address: string) =>
  Effect.map(PlatformCrypto, (crypto) => `<${crypto.randomUUID()}@${address.split("@").at(-1)}>`);

/** Remove one opening/closing bracket. SQL trim removes repeated brackets intentionally. */
export const stripMessageIdBrackets = (value: string): string => value.replace(/^<|>$/g, "");

/** IMAP identity comparison ignores every bracket and whitespace character. */
export const messageIdKey = (value: string): string => value.replace(/[<>\s]/g, "");
