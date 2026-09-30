import type { MailOp, Provider } from "./domain.js";

const FLAG_LABELS = new Set(["UNREAD", "STARRED", "IMPORTANT"]);

/**
 * The labels a message carries after `op`. Gmail labels stack; on Outlook and
 * IMAP a message sits in exactly one folder, so moving ops swap the folder
 * label and `important` does nothing.
 */
export function applyOpToLabels(
  labels: readonly string[],
  op: MailOp,
  provider: Provider,
): string[] {
  const out = new Set(labels);
  if (
    ["inbox", "archive", "trash", "spam"].includes(op.kind) ||
    (op.kind === "label" && op.value && provider !== "gmail")
  )
    out.delete("SNOOZED");
  const flag = (label: string, value: boolean) => (value ? out.add(label) : out.delete(label));
  if (op.kind === "read") flag("UNREAD", !op.value);
  else if (op.kind === "star") flag("STARRED", op.value);
  else if (provider === "gmail") {
    switch (op.kind) {
      case "important":
        flag("IMPORTANT", op.value);
        break;
      case "archive":
        out.delete("INBOX");
        break;
      case "inbox":
        out.delete("TRASH");
        out.delete("SPAM");
        out.add("INBOX");
        break;
      case "trash":
      case "spam":
        out.delete("INBOX");
        out.add(op.kind === "trash" ? "TRASH" : "SPAM");
        break;
      case "label":
        flag(op.labelId, op.value);
        break;
    }
  } else {
    const target = folderTarget(op, labels);
    if (target) {
      for (const l of labels) if (!FLAG_LABELS.has(l)) out.delete(l);
      out.add(target);
    }
  }
  return [...out];
}

/** The folder label a moving op sends a folder-model message to, or null for no move. */
export function folderTarget(op: MailOp, labels: readonly string[]): string | null {
  switch (op.kind) {
    case "archive":
      return "ARCHIVE";
    case "inbox":
      return "INBOX";
    case "trash":
      return "TRASH";
    case "spam":
      return "SPAM";
    case "label":
      if (op.value) return op.labelId;
      return labels.includes(op.labelId) ? "INBOX" : null;
    default:
      return null;
  }
}
