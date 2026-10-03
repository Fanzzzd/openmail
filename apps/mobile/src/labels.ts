import type { I18n } from "@lingui/core";
export function actionLabels(i18n: I18n) {
  return {
    none: i18n._({ id: "None", message: "None" }),
    archive: i18n._({ id: "Archive", message: "Archive" }),
    trash: i18n._({
      id: "Delete",
      message: "Delete",
      comment: "Action that moves messages to the Trash mailbox, not the mailbox name.",
    }),
    read: i18n._({ id: "Mark as read", message: "Mark as read" }),
    unread: i18n._({ id: "Mark as unread", message: "Mark as unread" }),
    star: i18n._({ id: "Star", message: "Star" }),
    unstar: i18n._({ id: "Unstar", message: "Unstar" }),
    snooze: i18n._({ id: "Snooze", message: "Snooze" }),
    label: i18n._({ id: "Labels", message: "Labels" }),
    move: i18n._({ id: "Move to", message: "Move to" }),
    cancel: i18n._({ id: "Cancel", message: "Cancel" }),
    select: i18n._({ id: "Select", message: "Select" }),
  };
}
