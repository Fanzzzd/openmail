import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { accountName, accountColorClass, accountColorStyle, avatarColor } from "../format";
import { accountsAtom, prefsAtom } from "../state/queries";

/** Unified folders share the account's name and chosen colour with the sidebar. */
export function AccountBadge({
  accountId,
  accent = false,
}: {
  accountId: string;
  accent?: boolean;
}) {
  const accounts = AsyncResult.getOrElse(useAtomValue(accountsAtom), () => []);
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const account = accounts.find((a) => a.id === accountId);
  return (
    <span
      className={`flex max-w-36 shrink-0 items-center gap-1.5 self-center text-[11px] ${accent ? "text-white" : "text-a11y-muted"}`}
      title={account?.email ?? accountId}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${account ? accountColorClass(account) : avatarColor(accountId.split(":")[1] ?? "")}`}
        style={account ? accountColorStyle(account) : undefined}
      />
      {prefs?.showAccountLabels && (
        <span className="truncate">{account ? accountName(account) : accountId}</span>
      )}
    </span>
  );
}
