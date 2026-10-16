import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { causeText } from "../lib/errors";
import { canCall } from "../lib/platform";
import { accountsAtom } from "../state/queries";
import { buttonPrimary, buttonSecondary, titlebarRow } from "../ui/styles";

/** The main pane with no account: a load error with Try again, or Add account. */
export function NoAccounts({
  landmark = true,
  adding,
  onAdd,
}: {
  /** False inside the layout's main landmark, which a main landmark may not nest in. */
  landmark?: boolean;
  /** The Add account dialog is open, so the pane stays empty behind it. */
  adding: boolean;
  onAdd: () => void;
}) {
  const accounts = useAtomValue(accountsAtom);
  const { t, i18n } = useLingui();
  const refresh = useAtomRefresh(accountsAtom);
  const Root = landmark ? "main" : "div";
  return (
    <Root className="flex h-full w-full flex-col bg-surface">
      <div className={titlebarRow} />
      {accounts._tag === "Failure" ? (
        <div
          role="alert"
          className="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-13 text-center"
        >
          <p className="max-w-80 text-a11y-muted">
            {t`Couldn't load your accounts.`} {causeText(i18n, accounts.cause)}
          </p>
          <button type="button" className={buttonSecondary} onClick={refresh}>
            {t`Try again`}
          </button>
        </div>
      ) : accounts._tag === "Success" && !adding ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-13 text-center">
          <p className="text-a11y-muted">{t`No email accounts yet.`}</p>
          {canCall("Connect") ? (
            <button type="button" className={buttonPrimary} onClick={onAdd}>
              {t`Add account`}
            </button>
          ) : (
            <p className="text-a11y-muted">{t`Add an account on your Mac.`}</p>
          )}
        </div>
      ) : null}
    </Root>
  );
}
