/**
 * Reading rules shared by every surface: when an open thread counts as read,
 * which senders may load remote images, how a thread is ordered, and how raw
 * source splits into headers and body. No Node dependencies; exported through
 * `@openmail/core/schema`.
 */
import { constVoid } from "effect/Function";

import type { MarkReadDelay } from "./domain.js";

/**
 * Marks a thread read after the delay from preferences, unless cancelled
 * first (the person moved on). Returns the cancel function. A delay of 0
 * marks right away; "manual" never does.
 */
export function markReadAfter(delay: MarkReadDelay, mark: () => void): () => void {
  if (delay === "manual") return constVoid;
  if (delay === 0) {
    mark();
    return constVoid;
  }
  const timer = setTimeout(mark, delay * 1000);
  return () => clearTimeout(timer);
}

/**
 * An entry of the remote image allowlist: a whole address ("news@shop.com")
 * or a domain ("shop.com"). Lower case, trimmed; a leading "@" is dropped.
 */
export function imageSenderKey(entry: string): string {
  return entry.trim().toLowerCase().replace(/^@/, "");
}

/** The domain part of an address, lower case. */
export function addressDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).toLowerCase();
}

/**
 * Whether mail from `address` may load remote images. An address entry
 * matches that address; a domain entry matches the domain and its
 * subdomains (shop.com covers mail.shop.com).
 */
export function imagesAllowed(address: string, allowlist: readonly string[]): boolean {
  const from = address.trim().toLowerCase();
  if (!from) return false;
  const domain = addressDomain(from);
  return allowlist.some((raw) => {
    const entry = imageSenderKey(raw);
    if (!entry) return false;
    if (entry.includes("@")) return entry === from;
    return domain === entry || domain.endsWith(`.${entry}`);
  });
}

/** A thread's messages in the order the person chose. Stored threads are oldest first. */
export function orderThread<T extends { readonly date: number }>(
  messages: readonly T[],
  order: "oldest" | "newest",
): T[] {
  const sorted = messages.toSorted((a, b) => a.date - b.date);
  return order === "newest" ? sorted.toReversed() : sorted;
}

export interface RawParts {
  /** Header lines as sent, folded lines kept. */
  headers: string;
  body: string;
}

/** Splits RFC 5322 source at the first empty line. */
export function splitRawMessage(raw: string): RawParts {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match) return { headers: raw, body: "" };
  return { headers: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) };
}
