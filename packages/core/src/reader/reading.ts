import { cleanDisplayName } from "./message-security.js";
/**
 * Reading rules shared by every surface: when an open thread counts as read,
 * which senders may load remote images, how a thread is ordered, and how raw
 * source splits into headers and body. No Node dependencies; exported through
 * `@openmail/core/schema`.
 */
import { constVoid } from "effect/Function";

import type { Address, MessageSecurity } from "../domain/message.js";
import type { MarkReadDelay, RemoteImageMode } from "../domain/prefs.js";
import type { Provider } from "../domain/account.js";

/**
 * The sender's name for a header that shows the address beside it. Senders
 * often repeat their own address in the name ("Azure <azure@…>", or just the
 * address); that copy is dropped. A different address stays, so the spoofing
 * warning still has something to point at.
 */
export function senderName(sender: Address): string {
  const address = sender.address.trim();
  const name = cleanDisplayName(sender.name);
  if (!address) return name.trim();
  const own = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only the whole address counts; "support@paypal.com.au" is not "support@paypal.com".
  const whole = `(?<![\\w.+-])${own}(?![\\w.-])`;
  const stripped = name
    .replace(new RegExp(`[<([]\\s*${whole}\\s*[>)\\]]|${whole}`, "giu"), "")
    .replace(/^[\s"'“”‘’,;:|–—-]+|[\s"'“”‘’,;:|–—-]+$/gu, "");
  return stripped || address;
}

export function threadExpansion(ids: readonly string[], expanded: boolean): Set<string> {
  return new Set(expanded ? ids : []);
}

/** Provider JSON is untrusted, even when the URL comes from Graph. */
export function officialMessageUrl(provider: Provider, value: string): string | null {
  try {
    const url = new URL(value);
    const origins =
      provider === "gmail"
        ? ["https://mail.google.com"]
        : provider === "outlook"
          ? [
              "https://outlook.live.com",
              "https://outlook.office.com",
              "https://outlook.office365.com",
            ]
          : [];
    return !url.username && !url.password && origins.includes(url.origin) ? url.href : null;
  } catch {
    return null;
  }
}

/** Legacy Gmail web routes identify the conversation, not a later message in it. */
export function gmailThreadUrl(email: string, threadId: string): string {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${encodeURIComponent(threadId)}`;
}

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

/**
 * The remote image mode to apply. Prefs that have not loaded fail closed to "ask".
 * `unchosen` replaces the default for people who never picked a mode.
 */
export function remoteImageMode(
  prefs: { readonly remoteImages: RemoteImageMode; readonly remoteImagesChosen: boolean } | null,
  unchosen?: RemoteImageMode,
): RemoteImageMode {
  if (!prefs) return "ask";
  return prefs.remoteImagesChosen || !unchosen ? prefs.remoteImages : unchosen;
}

/**
 * Whether a message loads remote images without asking.
 * The allowlist and known senders count only with a DMARC pass, so a forged From
 * unlocks nothing. Trackers stay stripped in every case.
 */
export function shouldLoadRemote(
  message: {
    readonly from: { readonly address: string };
    readonly security?: Pick<MessageSecurity, "dmarc"> | undefined;
  },
  prefs: {
    readonly remoteImages: RemoteImageMode;
    readonly imageSenders: readonly string[];
    /** The sender is a contact, the account itself, or someone the person mailed. */
    readonly knownSender: boolean;
  },
): boolean {
  if (prefs.remoteImages === "always") return true;
  if (message.security?.dmarc !== "pass") return false;
  return (
    imagesAllowed(message.from.address, prefs.imageSenders) ||
    (prefs.remoteImages === "known" && prefs.knownSender)
  );
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

/** Chronological suffix, including the selected message; independent of reader ordering. */
export function messagesFrom<T extends { readonly id: string; readonly date: number }>(
  messages: readonly T[],
  id: string,
): T[] {
  const ordered = orderThread(messages, "oldest");
  const index = ordered.findIndex((message) => message.id === id);
  return index < 0 ? [] : ordered.slice(index);
}

/** Exact HTTPS origins only. Zoom's regional meeting hosts are listed explicitly. */
export function meetingUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const origins = [
      "https://meet.google.com",
      "https://teams.microsoft.com",
      "https://teams.live.com",
      "https://zoom.us",
      "https://us02web.zoom.us",
      "https://us04web.zoom.us",
      "https://us05web.zoom.us",
      "https://us06web.zoom.us",
      "https://us07web.zoom.us",
      "https://us08web.zoom.us",
    ];
    if (url.username || url.password || !origins.includes(url.origin)) return null;
    const path = url.pathname;
    const meeting =
      url.hostname === "meet.google.com"
        ? /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(path)
        : url.hostname.startsWith("teams.")
          ? /^\/(?:l\/meetup-join\/|meet\/)/.test(path)
          : /^\/(?:j|my)\/[^/]+/.test(path);
    return meeting ? url.href : null;
  } catch {
    return null;
  }
}

/** Candidates from body text, HTML hrefs and iCalendar fields; validation is shared with main. */
export function meetingLinks(...sources: readonly string[]): string[] {
  const links = new Set<string>();
  for (const source of sources) {
    const decoded = source.replaceAll("&amp;", "&").replaceAll("&#38;", "&");
    for (const match of decoded.matchAll(/https:\/\/[^\s<>"']+/gi)) {
      const url = meetingUrl(match[0].replace(/[),.;]+$/, ""));
      if (url) links.add(url);
    }
  }
  return [...links];
}

/** Remove quote prefixes only for comparison, never from the rendered original. */
export const normalizeQuote = (value: string) =>
  value
    .replace(/^\s*>+\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();

/** Bodies are normalized once per thread; each message only sees its earlier prefix. */
export interface QuoteHistory {
  readonly bodies: readonly string[];
  readonly before: number;
}
export const EMPTY_QUOTE_HISTORY: QuoteHistory = { bodies: [], before: 0 };

export function repeatedQuote(text: string, previous: QuoteHistory): boolean {
  const quote = normalizeQuote(text);
  if (quote.length < 20) return false;
  for (let index = 0; index < previous.before; index++)
    if (previous.bodies[index]?.includes(quote)) return true;
  return false;
}

export function splitRepeatedQuote(
  text: string,
  previous: QuoteHistory,
): { body: string; quote: string } {
  const match = /(?:^|\n)[ \t]*>[^]*$/.exec(text);
  if (!match || !repeatedQuote(match[0], previous)) return { body: text, quote: "" };
  return { body: text.slice(0, match.index), quote: text.slice(match.index) };
}

/** Web fallback IDs came from an app link, before any provider request. Graph IDs are opaque base64/base64url. */
export function validMessageProviderId(provider: Provider, id: string): boolean {
  if (!id || id.length > 2048) return false;
  return provider === "gmail"
    ? /^[a-f0-9]+$/i.test(id)
    : provider === "outlook"
      ? /^[A-Za-z0-9][A-Za-z0-9_+/-]*={0,2}$/.test(id)
      : false;
}
