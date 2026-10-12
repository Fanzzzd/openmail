import { deleteFolderForMailbox } from "@openmail/core/schema";
import type { Account, ThreadQuery } from "../../../shared/api";
import type { View } from "./view";

export function permanentDeleteFolder(view: View, query: ThreadQuery | null) {
  return !view.label && (!query?.search || query.searchScope === "folder")
    ? deleteFolderForMailbox(view.mailbox)
    : null;
}
export function supportsInInboxFilter(
  view: View,
  accounts: readonly Pick<Account, "id" | "provider">[],
): boolean {
  const label = view.label;
  if (!label) return false;
  return label.accountId
    ? accounts.some((account) => account.id === label.accountId && account.provider === "gmail")
    : label.id.startsWith("CATEGORY_");
}
