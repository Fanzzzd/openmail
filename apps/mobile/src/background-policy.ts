import type { MobileBackgroundPreferences, Message } from "@openmail/core/portable";
export type VisibleMailbox = { accountId: string; label: string } | null;
export function shouldNotify(options: {
  message: Message;
  preferences: MobileBackgroundPreferences;
  foreground: boolean;
  visible: VisibleMailbox;
}) {
  const { message, preferences, foreground, visible } = options;
  return (
    preferences.accounts.includes(message.accountId) &&
    message.isUnread &&
    message.labels.includes("INBOX") &&
    !(foreground && visible?.accountId === message.accountId && visible.label === "INBOX")
  );
}
function notificationText(value: string, limit: number): string {
  const clean = value
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(clean).slice(0, limit).join("");
}
export function mailNotification(message: Message, hideContent: boolean, newMail: string) {
  return {
    identifier: `openmail:${JSON.stringify([message.accountId, message.threadId])}`,
    content: {
      title:
        notificationText(message.from.name, 80) ||
        notificationText(message.from.address, 80) ||
        newMail,
      ...(hideContent ? {} : { body: notificationText(message.subject, 120) }),
      sound: false,
      data: {
        openmailPublicTitle: newMail,
        openmailAccount: message.accountId,
        openmailThread: JSON.stringify([message.accountId, message.threadId]),
        url: `openmail:///reader?accountId=${encodeURIComponent(message.accountId)}&messageId=${encodeURIComponent(message.id)}`,
      },
    },
  };
}
/** Only our local reader route may enter navigation through notification data. */
export function notificationRoute(
  data: unknown,
): { pathname: "/reader"; params: { accountId: string; messageId: string } } | null {
  if (typeof data !== "object" || data === null || !("url" in data) || typeof data.url !== "string")
    return null;
  try {
    const url = new URL(data.url);
    if (url.protocol !== "openmail:" || url.host || url.pathname !== "/reader") return null;
    const accountId = url.searchParams.get("accountId");
    const messageId = url.searchParams.get("messageId");
    return accountId && messageId?.startsWith(`${accountId}/`)
      ? { pathname: "/reader", params: { accountId, messageId } }
      : null;
  } catch {
    return null;
  }
}
