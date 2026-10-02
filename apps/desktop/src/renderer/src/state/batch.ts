import { applyOpToLabels, parseSearchQuery } from "@openmail/core/schema";
import type { Label, MailOp, Provider, ThreadQuery, ThreadSummary } from "../../../shared/api";

/** Only flags and folder/label membership change in an organization operation. */
export function leavesList(
  row: ThreadSummary,
  op: MailOp,
  provider: Provider,
  query: ThreadQuery,
  labels: readonly Label[],
): boolean {
  const after = applyOpToLabels(row.labels, op, provider);
  const parsed = parseSearchQuery(query);
  if (parsed.unreadOnly && !after.includes("UNREAD")) return true;
  if (parsed.starredOnly && !after.includes("STARRED")) return true;
  const filters = parsed.listFilters;
  if (filters?.enabled) {
    if (filters.inInbox && !after.includes("INBOX")) return true;
    if (
      (filters.unread || filters.starred || filters.important) &&
      !(
        (filters.unread && after.includes("UNREAD")) ||
        (filters.starred && after.includes("STARRED")) ||
        (filters.important && after.includes("IMPORTANT"))
      )
    )
      return true;
  }
  if (parsed.criteria?.important && !after.includes("IMPORTANT")) return true;
  for (const criterion of parsed.criteria?.labels ?? []) {
    const label = labels.find(
      (candidate) =>
        candidate.accountId === row.accountId &&
        (candidate.id === criterion || candidate.name.toLowerCase() === criterion.toLowerCase()),
    );
    if (!after.includes(label?.id ?? criterion)) return true;
  }
  const folderScope = query.search === undefined || query.searchScope === "folder";
  if (folderScope && query.label && !after.includes(query.label)) return true;
  const mailbox = folderScope ? (query.mailbox ?? "inbox") : "all";
  switch (mailbox) {
    case "inbox":
      return !after.includes("INBOX");
    case "important":
      return !after.includes("IMPORTANT");
    case "starred":
      return !after.includes("STARRED");
    case "sent":
      return !after.includes("SENT");
    case "drafts":
      return !after.includes("DRAFT");
    case "trash":
      return !after.includes("TRASH");
    case "spam":
      return !after.includes("SPAM");
    case "snoozed":
      return (
        ["archive", "inbox", "trash", "spam"].includes(op.kind) ||
        (op.kind === "label" && op.value && provider !== "gmail")
      );
    case "all":
      return after.includes("TRASH") || after.includes("SPAM");
    default: {
      const exhaustive: never = mailbox;
      return exhaustive;
    }
  }
}
