import type { MailboxView } from "./message.js";

export const MAILBOX_LABEL: Readonly<Record<Exclude<MailboxView, "all">, string>> = {
  inbox: "INBOX",
  starred: "STARRED",
  snoozed: "SNOOZED",
  drafts: "DRAFT",
  sent: "SENT",
  trash: "TRASH",
  spam: "SPAM",
  important: "IMPORTANT",
};
