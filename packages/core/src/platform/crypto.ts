import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Context } from "effect";

const bytes = (value: string | Uint8Array) =>
  typeof value === "string" ? new TextEncoder().encode(value) : value;
const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Pure fingerprints remain synchronous on every platform, including draft rendering. */
export const sha256Hex = (value: string | Uint8Array) => hex(sha256(bytes(value)));
export const hmacSha256Hex = (key: string | Uint8Array, value: string | Uint8Array) =>
  hex(hmac(sha256, bytes(key), bytes(value)));

export interface PlatformCrypto {
  readonly randomUUID: () => string;
  readonly sha256: typeof sha256Hex;
  readonly hmac: typeof hmacSha256Hex;
}
/** Web runtimes can use their crypto implementation; native apps supply secure randomness. */
export const PlatformCrypto = Context.Reference<PlatformCrypto>("openmail/PlatformCrypto", {
  defaultValue: () => ({
    randomUUID: () => globalThis.crypto.randomUUID(),
    sha256: sha256Hex,
    hmac: hmacSha256Hex,
  }),
});
