import { stripMessageIdBrackets } from "./message-id.js";
/** Protocol and notification decisions shared by desktop and tests. No platform APIs. */
import { Schema } from "effect";

import {
  WEEKDAYS,
  type Account,
  type ActiveHours,
  type Message,
  type Prefs,
  type QuietHours,
} from "./domain.js";

export const MailtoDraft = Schema.Struct({
  to: Schema.String,
  cc: Schema.String,
  bcc: Schema.String,
  subject: Schema.String,
  body: Schema.String,
});
export type MailtoDraft = typeof MailtoDraft.Type;
export type AppLink =
  | { kind: "compose"; draft: MailtoDraft }
  | { kind: "message"; id: string; single?: boolean };

function hasHeaderControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Accept only the fields a person can review in Composer. Never accept sender or attachments. */
export function parseAppLink(raw: string): AppLink | null {
  if (raw.length > 100_000 || hasHeaderControl(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "openmail:") {
      if (
        !["message", "thread", "single"].includes(url.host) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return null;
      if (/(?:^|\/)(?:\.|%2e){1,2}(?=\/|$|[?#])/i.test(raw)) return null;
      const encoded = url.pathname.slice(1);
      if (!encoded || encoded.includes("/")) return null;
      const id = decodeURIComponent(encoded);
      return id && !hasHeaderControl(id)
        ? {
            kind: "message",
            id,
            ...(url.host === "thread"
              ? { single: false }
              : url.host === "single" || id.startsWith("rfc:")
                ? { single: true }
                : {}),
          }
        : null;
    }
    if (url.protocol !== "mailto:" || url.host || url.hash) return null;
    // URLSearchParams treats '+' as space. RFC 6068 uses percent encoding instead.
    const fields = new URLSearchParams(url.search.replace(/\+/g, "%2B"));
    if (/%(?![0-9a-f]{2})/i.test(url.search)) return null;
    if ([...fields].some(([, value]) => value.includes("\uFFFD"))) return null;
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

const StableReference = Schema.Tuple([Schema.String, Schema.String]);
export function stableReference(
  message: Pick<Message, "id" | "accountId" | "rfcMessageId">,
): string {
  return message.rfcMessageId
    ? `rfc:${JSON.stringify([message.accountId, stripMessageIdBrackets(message.rfcMessageId)])}`
    : message.id;
}
export function parseStableReference(id: string): { accountId: string; messageId: string } | null {
  if (!id.startsWith("rfc:")) return null;
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(StableReference))(id.slice(4));
  if (parsed._tag === "None") return null;
  const [accountId, messageId] = parsed.value;
  return accountId && messageId && !hasHeaderControl(accountId + messageId)
    ? { accountId, messageId }
    : null;
}
export function privateMailLink(
  message: Pick<Message, "id" | "accountId" | "rfcMessageId">,
  kind: "message" | "thread",
): string {
  return `openmail://${kind === "message" ? "single" : "thread"}/${encodeURIComponent(stableReference(message))}`;
}

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
/** Overnight ranges belong to their starting weekday. DST follows local wall time:
 * repeated minutes match twice, and skipped minutes never occur. */
export function inActiveHours(hours: ActiveHours, now: Date): boolean {
  if (!hours.enabled) return true;
  const day = WEEKDAYS[now.getDay()];
  const previous = WEEKDAYS[(now.getDay() + 6) % 7];
  if (!day || !previous) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  return (
    hours.days[day].some(
      ({ start, end }) =>
        start === end || (start < end ? minute >= start && minute < end : minute >= start),
    ) || hours.days[previous].some(({ start, end }) => start > end && minute < end)
  );
}

/** Shared by notifications, catch-up and the Dock, including ungrouped accounts. */
export function profileNotificationsActive(account: Account, prefs: Prefs, now: Date): boolean {
  const id = account.profileId ?? "all";
  const hours = prefs.activeHours[id];
  return hours ? inActiveHours(hours, now) : !inQuietHours(prefs.quietHours[id], now);
}

export function notificationEligible(
  account: Account,
  message: Pick<Message, "isUnread" | "labels">,
  prefs: Prefs,
): boolean {
  if (account.enabled === false) return false;
  const mode = prefs.notifications[account.id] ?? "primary";
  if (mode === "off" || !message.isUnread || !message.labels.includes("INBOX")) return false;
  if (message.labels.some((l) => ["DRAFT", "SENT", "SPAM", "TRASH", "SNOOZED"].includes(l)))
    return false;
  return (
    mode !== "primary" ||
    (account.provider === "outlook"
      ? !message.labels.includes("CATEGORY_OTHER")
      : account.provider !== "gmail" || !message.labels.some((l) => SECONDARY.has(l)))
  );
}

export function shouldNotify(account: Account, message: Message, prefs: Prefs, now: Date): boolean {
  return (
    notificationEligible(account, message, prefs) && profileNotificationsActive(account, prefs, now)
  );
}

export const MENU_BAR_MAIL_LIMIT = 50;
export const menuBarCountTitle = (enabled: boolean, unread: number) =>
  enabled ? String(unread) : "";

export function dockUnreadCount(
  space: string,
  accounts: readonly Account[],
  counts: Readonly<Record<string, number>>,
  prefs: Prefs,
  now: Date,
): number {
  const scoped = new Set(spaceAccountIds(space, accounts));
  return accounts
    .filter((account) => scoped.has(account.id) && profileNotificationsActive(account, prefs, now))
    .reduce((total, account) => total + (counts[account.id] ?? 0), 0);
}

/** The active space scopes system surfaces; an empty profile must count nothing. */
export function spaceAccountIds(space: string, accounts: readonly Account[]): string[] {
  return accounts
    .filter(
      (a) =>
        a.enabled !== false && (space === "all" || space === "overview" || a.profileId === space),
    )
    .map((a) => a.id);
}

/** Resolve indexes against the configuration captured when the notification was shown. */
export function notificationAction(
  actions: Prefs["notificationActions"],
  actionIndex: number,
  selectionIndex = -1,
): import("./domain.js").MailOp | null {
  const selected = actions[actionIndex];
  const action =
    selected === "menu" ? (["archive", "trash", "read"] as const)[selectionIndex] : selected;
  switch (action) {
    case "archive":
      return { kind: "archive" };
    case "trash":
      return { kind: "trash" };
    case "read":
      return { kind: "read", value: true };
    default:
      return null;
  }
}

/** macOS has button actions; selection actions are supported only on Windows. */
export function notificationButtonActions(
  actions: Prefs["notificationActions"],
  platform: string,
): Prefs["notificationActions"] {
  if (platform === "win32") return actions;
  return [
    ...new Set(
      actions.flatMap((action) =>
        action === "menu" ? (["archive", "trash", "read"] as const) : [action],
      ),
    ),
  ];
}
