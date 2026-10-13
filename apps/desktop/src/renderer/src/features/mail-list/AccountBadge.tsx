import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { accountName, accountColorClass, accountColorStyle, avatarColor } from "../../lib/format";
import { accountsAtom, prefsAtom } from "../../state/queries";

function useAccount(accountId: string) {
  const accounts = AsyncResult.getOrElse(useAtomValue(accountsAtom), () => []);
  return accounts.find((a) => a.id === accountId);
}

/** The account's name as the sidebar shows it, for a row's accessible name. */
export function useAccountName(accountId: string): string {
  const account = useAccount(accountId);
  return account ? accountName(account) : accountId;
}

/**
 * Unified folders share the account's name and chosen colour with the sidebar. Without the
 * name, the colour carries the account's initial as in the sidebar avatar, so it does not rely
 * on colour alone.
 */
export function AccountBadge({
  accountId,
  accent = false,
}: {
  accountId: string;
  accent?: boolean;
}) {
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const account = useAccount(accountId);
  const name = account ? accountName(account) : accountId;
  const color = account ? accountColorClass(account) : avatarColor(accountId.split(":")[1] ?? "");
  const style = account ? accountColorStyle(account) : undefined;
  return (
    <span
      className={`flex max-w-36 shrink-0 items-center gap-1.5 self-center text-caption ${accent ? "text-white" : "text-a11y-muted"}`}
      title={account?.email ?? accountId}
    >
      {prefs?.showAccountLabels ? (
        <>
          <span className={`size-1.5 shrink-0 rounded-full ${color}`} style={style} />
          <span className="truncate">{name}</span>
        </>
      ) : (
        <span
          className={`flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] leading-none font-semibold text-white ${color}`}
          style={style}
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
}
