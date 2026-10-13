import { useLingui } from "@lingui/react/macro";
import type { Account, Label } from "../../../shared/api";
import { MAILBOX_NAMES, categoryAccounts, inboxCategoryNames, type View } from "../lib/view";

/** The list's title: the mailbox, label or category, and the account when the view has one. */
export function useViewTitle(
  view: View,
  accountList: readonly Account[],
  labelMap: ReadonlyMap<string, Label>,
) {
  const { t, i18n } = useLingui();
  const viewAccount = accountList.find((a) => a.id === (view.label?.accountId ?? view.accountId));
  const categorized = categoryAccounts(view, accountList);
  const category = view.label
    ? inboxCategoryNames(
        categorized.length > 0 && categorized.every((a) => a.provider === "outlook"),
      )[view.label.id]
    : undefined;
  const baseTitle = view.label
    ? category
      ? i18n._(category)
      : (labelMap.get(`${view.label.accountId}/${view.label.id}`)?.name ?? t`Label`)
    : i18n._(MAILBOX_NAMES[view.mailbox]);
  const user = viewAccount?.email.split("@")[0];
  const title = viewAccount ? t`${baseTitle}: ${user}` : baseTitle;
  return { viewAccount, title };
}
