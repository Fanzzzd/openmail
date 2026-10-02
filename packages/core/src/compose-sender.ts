import type { SendAs } from "./organization.js";
import type { Account, Prefs } from "./domain.js";

/** A fixed verified sender takes precedence; missing accounts/aliases follow the view again. */
export function composeSender(
  accounts: readonly Account[],
  aliases: readonly SendAs[],
  fixed: Prefs["defaultFrom"],
  view: { accountId?: string; label?: { accountId?: string } },
  scope?: readonly string[],
): { accountId: string; address: string; name: string } | undefined {
  const configured = accounts.find((a) => a.id === fixed?.accountId);
  if (configured && fixed) {
    if (configured.email.toLowerCase() === fixed.address.toLowerCase())
      return { accountId: configured.id, address: configured.email, name: "" };
    const alias = aliases.find(
      (a) =>
        a.accountId === configured.id && a.address.toLowerCase() === fixed.address.toLowerCase(),
    );
    if (configured.provider === "gmail" && alias)
      return { accountId: configured.id, address: alias.address, name: alias.name };
  }
  const account =
    accounts.find((a) => a.id === (view.label?.accountId ?? view.accountId ?? scope?.[0])) ??
    accounts[0];
  return account ? { accountId: account.id, address: account.email, name: "" } : undefined;
}
