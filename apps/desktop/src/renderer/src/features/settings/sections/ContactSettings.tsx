import { ServiceHint } from "../../accounts/OptionalServices";
import { Button } from "@base-ui/react/button";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import type { Account } from "../../../../../shared/api";
import { resultError } from "../../../lib/errors";
import { canCall } from "../../../lib/platform";
import { SignInAgainOnMac } from "../../../ui/SignInAgainOnMac";
import { Keys } from "../../../state/keys";
import { reauthAtom, refreshContactsAtom } from "../../../state/mutations";
import { contactSyncAtom } from "../../../state/queries";
import { SettingsGroup, SettingsRow } from "../../../ui/SettingsRows";
import { buttonSecondary } from "../../../ui/styles";
import { dateFormat } from "../../../lib/format";

const alertRow = "px-3 py-2 text-orange-700 dark:text-orange-400";

export function ContactSettings({ account }: { account: Account }) {
  const { t, i18n } = useLingui();
  const status = AsyncResult.getOrElse(useAtomValue(contactSyncAtom), () => []).find(
    (s) => s.accountId === account.id,
  );
  const [result, refresh] = useAtom(refreshContactsAtom);
  const [signIn, reauth] = useAtom(reauthAtom(account.id));
  const count = i18n.number(status?.count ?? 0);
  return (
    <div className="space-y-2">
      <ServiceHint accountId={account.id} service="contacts" />
      <SettingsGroup
        title={<Trans>Server contacts</Trans>}
        footer={
          <Trans>
            Server contacts refresh every six hours while the app runs. Cached contacts and local
            correspondents appear in recipient suggestions.
          </Trans>
        }
      >
        <SettingsRow
          label={
            <>
              {t`${count} cached contacts`}
              {status?.refreshedAt !== null && status?.refreshedAt !== undefined && (
                <>
                  {" "}
                  ·{" "}
                  {new Intl.DateTimeFormat(dateFormat(i18n).locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                    ...dateFormat(i18n).clock,
                  }).format(status.refreshedAt)}
                </>
              )}
            </>
          }
        >
          <Button
            className={buttonSecondary}
            disabled={result.waiting || signIn.waiting}
            onClick={() =>
              refresh({ payload: { accountId: account.id }, reactivityKeys: [Keys.contacts] })
            }
          >
            <Trans>Refresh contacts</Trans>
          </Button>
          {status?.scopeMissing &&
            (canCall("Reauth") ? (
              <Button
                className={buttonSecondary}
                disabled={signIn.waiting || result.waiting}
                onClick={() => reauth("contacts")}
              >
                <Trans>Sign in again</Trans>
              </Button>
            ) : (
              <SignInAgainOnMac />
            ))}
        </SettingsRow>
        {status?.error && (
          <p role="alert" className={alertRow}>
            {status.scopeMissing
              ? t`Sign in again to sync server contacts.`
              : t`Contact refresh failed. Cached suggestions remain available.`}
          </p>
        )}
        {resultError(i18n, result) && (
          <p role="alert" className={alertRow}>
            {resultError(i18n, result)}
          </p>
        )}
        {resultError(i18n, signIn) && (
          <p role="alert" className={alertRow}>
            {resultError(i18n, signIn)}
          </p>
        )}
      </SettingsGroup>
    </div>
  );
}
