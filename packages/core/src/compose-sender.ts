import { Schema } from "effect";
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
  accounts = accounts.filter((a) => a.enabled !== false);
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

export const SuggestedSender = Schema.Struct({
  accountId: Schema.String,
  address: Schema.String,
  name: Schema.String,
});
export type SuggestedSender = typeof SuggestedSender.Type;
export interface SenderHistory {
  accountId: string;
  address: string;
  recipient: string;
  count: number;
  lastSent: number;
}
const commonDomains = new Set([
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "live.com",
  "aol.com",
  "qq.com",
  "163.com",
  "proton.me",
  "protonmail.com",
]);
/** Exact sent history wins; a shared private domain provides a weaker signal. Ties keep From. */
export function bestComposeSender(
  senders: readonly SuggestedSender[],
  current: Pick<SuggestedSender, "accountId" | "address">,
  recipients: readonly string[],
  history: readonly SenderHistory[],
): SuggestedSender | null {
  const addresses = new Set(recipients.map((address) => address.toLowerCase()));
  const score = (sender: SuggestedSender) => {
    let points = 0;
    for (const row of history) {
      if (
        row.accountId === sender.accountId &&
        row.address.toLowerCase() === sender.address.toLowerCase() &&
        addresses.has(row.recipient.toLowerCase())
      )
        points += 100 + Math.min(row.count, 50);
    }
    const domain = sender.address.toLowerCase().split("@")[1];
    if (domain && !commonDomains.has(domain))
      for (const address of addresses) if (address.endsWith(`@${domain}`)) points += 10;
    return points;
  };
  const present = senders.find(
    (s) =>
      s.accountId === current.accountId &&
      s.address.toLowerCase() === current.address.toLowerCase(),
  );
  const ranked = senders
    .map((sender) => ({ sender, score: score(sender) }))
    .toSorted((a, b) => b.score - a.score);
  const best = ranked[0];
  if (
    !best ||
    best.score === 0 ||
    best.score <= (present ? score(present) : 0) ||
    ranked[1]?.score === best.score
  )
    return null;
  return best.sender;
}
