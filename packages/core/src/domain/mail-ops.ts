import { mergeCategoryNames } from "./categories.js";
import {
  OUTLOOK_CATEGORIES,
  isOutlookClassification,
  type MailOp,
  type Provider,
} from "./domain.js";

const FLAG_LABELS = new Set(["UNREAD", "STARRED", "IMPORTANT"]);

/**
 * The labels a message carries after `op`. Gmail labels stack; on Outlook and
 * IMAP a message sits in exactly one folder, so moving ops swap the folder
 * label; IMAP has no writable importance flag.
 */
export function applyOpToLabels(
  labels: readonly string[],
  op: MailOp,
  provider: Provider,
): string[] {
  const out = new Set(labels);
  if (
    ["inbox", "archive", "trash", "spam", "move"].includes(op.kind) ||
    (op.kind === "label" && op.value && provider !== "gmail")
  )
    out.delete("SNOOZED");
  const flag = (label: string, value: boolean) => (value ? out.add(label) : out.delete(label));
  if (op.kind === "read") flag("UNREAD", !op.value);
  else if (op.kind === "star") flag("STARRED", op.value);
  else if (op.kind === "important" && provider !== "imap") flag("IMPORTANT", op.value);
  else if (op.kind === "classification" && provider === "outlook") {
    for (const category of OUTLOOK_CATEGORIES) out.delete(category);
    out.add(op.value === "focused" ? "CATEGORY_PERSONAL" : "CATEGORY_OTHER");
  } else if (op.kind === "categories" && provider === "outlook") {
    const current = [...out]
      .filter((label) => label.startsWith("category:"))
      .map((label) => label.slice(9));
    for (const name of current) out.delete(`category:${name}`);
    for (const name of mergeCategoryNames(current, op.add, op.remove)) out.add(`category:${name}`);
  } else if (op.kind === "copy" || op.kind === "categories" || op.kind === "classification")
    return [...labels];
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
      case "move":
        if (op.removeLabelId && op.removeLabelId !== op.labelId) out.delete(op.removeLabelId);
        if (op.labelId !== "TRASH") out.delete("TRASH");
        if (op.labelId !== "SPAM") out.delete("SPAM");
        out.add(op.labelId);
        break;
      case "label":
        flag(op.labelId, op.value);
        break;
    }
  } else {
    const target = folderTarget(op, labels);
    if (target) {
      for (const l of labels)
        if (
          !FLAG_LABELS.has(l) &&
          !l.startsWith("category:") &&
          !(provider === "outlook" && isOutlookClassification(l))
        )
          out.delete(l);
      out.add(target);
    }
  }
  return [...out];
}

/** The folder label a moving op sends a folder-model message to, or null for no move. */
export function folderTarget(op: MailOp, labels: readonly string[]): string | null {
  switch (op.kind) {
    case "move":
      return op.labelId;
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

export function invalidCategoryFolderOp(op: MailOp): boolean {
  return (
    ((op.kind === "move" || op.kind === "label") && op.labelId.startsWith("category:")) ||
    (op.kind === "move" && op.removeLabelId?.startsWith("category:") === true) ||
    (op.kind === "copy" && op.labelIds.some((id) => id.startsWith("category:")))
  );
}
