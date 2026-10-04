import type { Address, Message, OutgoingMessage } from "./domain.js";

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

export function formatAddress(a: Address): string {
  if (!a.name) return a.address;
  const name = /[",;:，；\\]/.test(a.name)
    ? `"${a.name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : a.name;
  return `${name} <${a.address}>`;
}

/** Separators between addresses in a recipient field. */
export const ADDRESS_SEPARATOR = /[,;，；\n]/;

/**
 * Parses "李雷 <li@example.com>, han@example.com". Returns the addresses and
 * the pieces that are not addresses, so the form can point at them.
 */
export function parseAddresses(input: string): { addresses: Address[]; invalid: string[] } {
  const addresses: Address[] = [];
  const invalid: string[] = [];
  for (const raw of splitAddresses(input)) {
    const part = raw.trim();
    if (!part) continue;
    const angle = /^(.*)<([^>]+)>$/.exec(part);
    const name = angle
      ? angle[1]!
          .trim()
          .replace(/^"|"$/g, "")
          .replace(/\\(["\\])/g, "$1")
      : "";
    const address = (angle ? angle[2]! : part).trim();
    if (isEmailAddress(address)) addresses.push({ name, address });
    else invalid.push(part);
  }
  return { addresses, invalid };
}

/** Mobile draft fields retain invalid addresses so editing never discards user input. */
export function draftRecipients(value: string) {
  return splitAddresses(value)
    .filter((part) => part.trim())
    .map((part) => {
      const match = /^(.*?)<([^<>]+)>$/.exec(part.trim());
      return {
        name: match?.[1]?.trim().replace(/^"|"$/g, "") ?? "",
        address: (match?.[2] ?? part).trim(),
      };
    });
}

/** Preserve an existing reply/forward prefix, including Graph's FW alias. */
export const replySubject = (subject: string): string =>
  /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
export const forwardSubject = (subject: string): string =>
  /^(?:fwd?|fw)\s*:/i.test(subject) ? subject : `Fwd: ${subject}`;

export interface RecipientWarnings {
  readonly unfamiliar: readonly string[];
  readonly outsideThread: readonly string[];
}
export const hasRecipientWarnings = (warnings: RecipientWarnings): boolean =>
  warnings.unfamiliar.length > 0 || warnings.outsideThread.length > 0;

/** Recomputed from the current recipients at each send attempt, including hidden Bcc. */
export function agentRecipientWarnings(
  message: OutgoingMessage,
  known: readonly string[],
  thread: readonly Message[],
): RecipientWarnings {
  const origin = message.agentOrigin;
  if (!origin) return { unfamiliar: [], outsideThread: [] };
  const recipients = [
    ...new Set([...message.to, ...message.cc, ...message.bcc].map((a) => addressKey(a.address))),
  ];
  const participants = new Set(
    thread
      .flatMap((m) => [m.from, ...m.to, ...m.cc, ...(m.bcc ?? []), ...(m.replyTo ?? [])])
      .map((a) => addressKey(a.address)),
  );
  const added = new Set(origin.recipients.map(addressKey));
  const trusted = new Set(known.map(addressKey));
  return {
    unfamiliar: recipients.filter((a) => added.has(a) && !trusted.has(a)),
    outsideThread: origin.replyTo ? recipients.filter((a) => !participants.has(a)) : [],
  };
}
