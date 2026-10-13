import type { DesktopLabels } from "../../shared/desktop-labels";

/** English menu and notification labels, used until the renderer sends its Lingui ones. */
export const DEFAULT_DESKTOP_LABELS: DesktopLabels = {
  checkUpdates: "Check for updates…",
  updatesDisabled:
    "Update checks require a signed, installed macOS app and a saved GitHub access token.",
  updatesCurrent: "OpenMail is up to date.",
  updatesAvailable: "Update available:",
  updatesFailed: "Could not check for updates. Try again later.",
  ok: "OK",
  read: "Mark read",
  actionMenu: "Actions",
  settings: "Settings…",
  newWindow: "New window",
  compose: "New message",
  attachFiles: "Attach files…",
  help: "Keyboard shortcuts",
  archive: "Archive",
  trash: "Delete",
  noUnread: "No unread mail",
  showInbox: "Show Inbox",
  allAccounts: "All accounts",
  file: "File",
  edit: "Edit",
  undo: "Undo",
  undoSend: "Undo send",
  quitPending: "Quit with messages waiting to send?",
  quitPendingDetail:
    "Messages in the undo window will remain drafts. A send already in progress may finish.",
  quit: "Quit",
  cancel: "Cancel",
  selectAll: "Select all",
  window: "Window",
  newMessages: "new messages",
  feedback: "Send feedback…",
};
