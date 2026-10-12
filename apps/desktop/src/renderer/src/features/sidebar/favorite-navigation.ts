import { SYSTEM_FOLDERS, systemFolderId, type LabelPreference } from "@openmail/core/schema";
import type { Account, Label } from "../../../../shared/api";
import { ALL, OVERVIEW, spaceAccounts, type View } from "../../lib/view";

export function numberedFavorites(
  view: View,
  accounts: readonly Account[],
  labels: readonly Label[],
  preferences: readonly LabelPreference[],
) {
  const members = spaceAccounts(view.space, accounts);
  return preferences
    .filter((p) => p.favorite && members.some((a) => a.id === p.accountId && a.enabled !== false))
    .flatMap((p) => {
      const mailbox = SYSTEM_FOLDERS.find((id) => systemFolderId(id) === p.id);
      return mailbox || labels.some((l) => l.accountId === p.accountId && l.id === p.id)
        ? [{ ...p, mailbox: mailbox ?? null }]
        : [];
    });
}
export function favoriteView(
  view: View,
  favorite: ReturnType<typeof numberedFavorites>[number],
): View {
  const space = view.space === OVERVIEW ? ALL : view.space;
  return favorite.mailbox
    ? { ...view, space, mailbox: favorite.mailbox, accountId: favorite.accountId, label: undefined }
    : {
        ...view,
        space,
        mailbox: "all",
        accountId: undefined,
        label: { id: favorite.id, accountId: favorite.accountId },
      };
}
