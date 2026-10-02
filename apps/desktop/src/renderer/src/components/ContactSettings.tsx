import { Button } from "@base-ui/react/button";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import type { Account } from "../../../shared/api";
import { resultError } from "../errors";
import { Keys } from "../state/keys";
import { reauthAtom, refreshContactsAtom } from "../state/mutations";
import { contactSyncAtom } from "../state/queries";
import { formButton } from "./OrganizationSettings";

export function ContactSettings({ account }: { account: Account }) {
  const { t, i18n } = useLingui();
  const status = AsyncResult.getOrElse(useAtomValue(contactSyncAtom), () => []).find(
    (s) => s.accountId === account.id,
  );
  const [result, refresh] = useAtom(refreshContactsAtom);
  const [signIn, reauth] = useAtom(reauthAtom(account.id));
  const count = i18n.number(status?.count ?? 0);
  return (
    <section className="space-y-2 border-t border-black/10 pt-4 dark:border-white/10">
      <h3 className="font-semibold">
        <Trans>Server contacts</Trans>
      </h3>
      <p className="text-a11y-muted">
        <Trans>
          Server contacts refresh every six hours while the app runs. Cached contacts and local
          correspondents appear in recipient suggestions.
        </Trans>
      </p>
      <p>
        {t`${count} cached contacts`}
        {status?.refreshedAt !== null && status?.refreshedAt !== undefined && (
          <>
            {" "}
            ·{" "}
            {new Intl.DateTimeFormat(i18n.locale, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(status.refreshedAt)}
          </>
        )}
      </p>
      {status?.error && (
        <p role="alert" className="text-orange-700 dark:text-orange-400">
          {status.scopeMissing
            ? t`Sign in again to sync server contacts.`
            : t`Contact refresh failed. Cached suggestions remain available.`}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          className={formButton}
          disabled={result.waiting || signIn.waiting}
          onClick={() =>
            refresh({ payload: { accountId: account.id }, reactivityKeys: [Keys.contacts] })
          }
        >
          <Trans>Refresh contacts</Trans>
        </Button>
        {status?.scopeMissing && (
          <Button
            className={formButton}
            disabled={signIn.waiting || result.waiting}
            onClick={() => reauth()}
          >
            <Trans>Sign in again</Trans>
          </Button>
        )}
      </div>
      {resultError(i18n, result) && (
        <p role="alert" className="text-orange-700 dark:text-orange-400">
          {resultError(i18n, result)}
        </p>
      )}
      {resultError(i18n, signIn) && (
        <p role="alert" className="text-orange-700 dark:text-orange-400">
          {resultError(i18n, signIn)}
        </p>
      )}
    </section>
  );
}
