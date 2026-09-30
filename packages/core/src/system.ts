/** Protocol and notification decisions shared by desktop and tests. No platform APIs. */
import { Schema } from "effect";

import type { Account, Message, Prefs, QuietHours } from "./domain.js";

export const MailtoDraft = Schema.Struct({
  to: Schema.String,
  cc: Schema.String,
  bcc: Schema.String,
  subject: Schema.String,
  body: Schema.String,
});
export type MailtoDraft = typeof MailtoDraft.Type;
export type AppLink = { kind: "compose"; draft: MailtoDraft } | { kind: "message"; id: string };

function hasHeaderControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Accept only the fields a person can review in Composer. Never accept sender or attachments. */
export function parseAppLink(raw: string): AppLink | null {
  if (raw.length > 100_000) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "openmail:") {
      if (url.host !== "message" || url.username || url.password || url.search || url.hash)
        return null;
      const encoded = url.pathname.slice(1);
      if (!encoded || encoded.includes("/")) return null;
      const id = decodeURIComponent(encoded);
      return id && !hasHeaderControl(id) ? { kind: "message", id } : null;
    }
    if (url.protocol !== "mailto:" || url.host || url.hash) return null;
    // URLSearchParams treats '+' as space. RFC 6068 uses percent encoding instead.
    const fields = new URLSearchParams(url.search.replace(/\+/g, "%2B"));
    const values = (key: string) =>
      [...fields].filter(([k]) => k.toLowerCase() === key).map(([, v]) => v);
    const to = [decodeURIComponent(url.pathname), ...values("to")].filter(Boolean).join(", ");
    const cc = values("cc").join(", ");
    const bcc = values("bcc").join(", ");
    const subject = values("subject")[0] ?? "";
    const body = (values("body")[0] ?? "").replace(/\r\n/g, "\n");
    if ([to, cc, bcc, subject].some((v) => hasHeaderControl(v)) || body.includes("\0")) return null;
    return { kind: "compose", draft: { to, cc, bcc, subject, body } };
  } catch {
    return null;
  }
}

export const messageLink = (id: string) => `openmail://message/${encodeURIComponent(id)}`;

export function inQuietHours(hours: QuietHours | undefined, now: Date): boolean {
  if (!hours?.enabled) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  if (hours.start === hours.end) return true;
  return hours.start < hours.end
    ? minute >= hours.start && minute < hours.end
    : minute >= hours.start || minute < hours.end;
}

const SECONDARY = new Set([
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);
export function shouldNotify(account: Account, message: Message, prefs: Prefs, now: Date): boolean {
  const mode = prefs.notifications[account.id] ?? "primary";
  if (mode === "off" || !message.isUnread || !message.labels.includes("INBOX")) return false;
  if (message.labels.some((l) => ["DRAFT", "SENT", "SPAM", "TRASH", "SNOOZED"].includes(l)))
    return false;
  if (inQuietHours(prefs.quietHours[account.profileId ?? "all"], now)) return false;
  return (
    mode !== "primary" ||
    account.provider !== "gmail" ||
    !message.labels.some((l) => SECONDARY.has(l))
  );
}

/** The active space scopes system surfaces; an empty profile must count nothing. */
export function spaceAccountIds(space: string, accounts: readonly Account[]): string[] {
  return accounts
    .filter((a) => space === "all" || space === "overview" || a.profileId === space)
    .map((a) => a.id);
}
