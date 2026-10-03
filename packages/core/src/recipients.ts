import type { Address, Message } from "./domain.js";

/** Split recipient text and RFC groups, keeping quoted names and encoded words intact. */
export function splitAddresses(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  let escaped = false;
  for (const ch of value.match(/=\?[^?]+\?[bq]\?[^?]*\?=|[\s\S]/gi) ?? []) {
    if (ch.length > 1) {
      current += ch;
      continue;
    }
    if (escaped) escaped = false;
    else if (ch === "\\" && quoted) escaped = true;
    else if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    if (ch === ":" && !quoted && !angled && !current.includes("@")) {
      // The group phrase is not a mailbox; its terminating semicolon is a separator.
      current = "";
    } else if (/[,;，；\n]/.test(ch) && !quoted && !angled) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

const addressKey = (address: string) => address.trim().toLowerCase();

/** Address syntax supported by recipient fields and parsed provider headers. */
export function isEmailAddress(address: string): boolean {
  return /^[^\s@<>",;:]+@[^\s@<>",;:]+\.[^\s@<>",;:]+$/.test(address);
}

/** Reply targets, deduplicated across To/Cc and excluding the replying account's identities. */
export function replyRecipients(
  message: Pick<Message, "from" | "to" | "cc" | "replyTo" | "bodyRefresh">,
  ownAddresses: readonly string[],
  replyAll: boolean,
): { to: Address[]; cc: Address[] } {
  if (message.bodyRefresh === "failed" && message.replyTo === undefined) return { to: [], cc: [] };
  const own = new Set(ownAddresses.map(addressKey));
  const sentByMe = own.has(addressKey(message.from.address));
  const targets = sentByMe
    ? message.to
    : message.replyTo?.length
      ? message.replyTo
      : [message.from];
  const seen = new Set(own);
  const unique = (list: readonly Address[]) =>
    list.filter((a) => {
      const address = addressKey(a.address);
      if (!address || seen.has(address)) return false;
      seen.add(address);
      return true;
    });
  let to = unique(targets);
  if (!to.length) to = sentByMe ? [...message.to] : unique([message.from]);
  return {
    to,
    cc: replyAll ? unique([...message.to, ...message.cc]) : [],
  };
}

export function recipientLabel(address: Address, showFullAddress: boolean): string {
  return showFullAddress && address.name
    ? `${address.name} <${address.address}>`
    : address.name || address.address;
}

export function displayName(address: Address): string {
  return address.name || address.address.split("@")[0] || address.address;
}
