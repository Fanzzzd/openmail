import type { I18n } from "@lingui/core";
import type { Label } from "@openmail/core/portable";

export function mailboxName(i18n: I18n, label: Label) {
  switch (label.id) {
    case "INBOX":
      return i18n._({ id: "Inbox", message: "Inbox" });
    case "SENT":
      return i18n._({ id: "Sent", message: "Sent" });
    case "DRAFT":
      return i18n._({ id: "Drafts", message: "Drafts" });
    case "TRASH":
      return i18n._({ id: "Trash", message: "Trash" });
    case "SPAM":
      return i18n._({ id: "Spam", message: "Spam" });
    case "ARCHIVE":
      return i18n._({ id: "Archive", message: "Archive" });
    default:
      return label.name;
  }
}
