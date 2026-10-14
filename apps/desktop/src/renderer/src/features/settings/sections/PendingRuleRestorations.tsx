import { plural } from "@lingui/core/macro";
import type { Account } from "../../../../../shared/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { MailClient } from "../../../state/rpc";
import { Keys, MAIL_KEYS } from "../../../state/keys";
import {
  discardFilterRestorationAtom,
  prepareFilterRestorationAtom,
  restoreFilterAtom,
} from "../../../state/mutations";
import { useState } from "react";
import {
  requiresFilterDeleteConfirmation,
  type FilterPreview,
  type FilterRestoration,
} from "@openmail/core/schema";
import { settingsGroup } from "../../../ui/styles";
import { AsyncResult } from "effect/reactivity";
import { listRow, rowButton } from "./server-settings-styles";
import { resultError } from "../../../lib/errors";
import { Alert, AlertCancel, alertDanger, alertPrimary } from "../../../ui/Dialog";
import { FilterDeletionWarning } from "./FilterEditor";

export function PendingRuleRestorations({ account }: { account: Account }) {
  const { t, i18n } = useLingui();
  const backups = useAtomValue(
    MailClient.query(
      "FilterRestorations",
      { accountId: account.id },
      { reactivityKeys: [Keys.serverSettings] },
    ),
  );
  const [prepared, prepare] = useAtom(prepareFilterRestorationAtom, { mode: "promiseExit" });
  const [restored, restore] = useAtom(restoreFilterAtom, { mode: "promiseExit" });
  const [discarded, discard] = useAtom(discardFilterRestorationAtom, { mode: "promiseExit" });
  const [discarding, setDiscarding] = useState<FilterRestoration | null>(null);
  const [pending, setPending] = useState<{
    backup: FilterRestoration;
    preview: FilterPreview;
  } | null>(null);
  const busy = prepared.waiting || restored.waiting || discarded.waiting;
  return (
    <section className="space-y-2 empty:hidden">
      <div className={`empty:hidden ${settingsGroup}`}>
        {AsyncResult.getOrElse(backups, () => []).map((backup) => (
          <div key={backup.id} className={listRow}>
            <span className="mr-2 min-w-0 flex-1 truncate">
              {backup.input.name || backup.originalId}{" "}
            </span>
            <button
              type="button"
              className={rowButton}
              disabled={busy}
              onClick={async () => {
                const exit = await prepare({
                  payload: { accountId: account.id, id: backup.id },
                  reactivityKeys: MAIL_KEYS,
                });
                if (exit._tag === "Success" && exit.value.kind === "preview")
                  setPending({ backup, preview: exit.value.preview });
              }}
            >{t`Restore filter`}</button>
            <button
              type="button"
              className={`${rowButton} text-a11y-danger`}
              disabled={busy}
              onClick={() => setDiscarding(backup)}
            >{t`Discard`}</button>
          </div>
        ))}
      </div>
      {(resultError(i18n, backups) ||
        resultError(i18n, prepared) ||
        resultError(i18n, restored) ||
        resultError(i18n, discarded)) && (
        <p role="alert" className="px-1 text-a11y-danger">
          {resultError(i18n, backups) ??
            resultError(i18n, prepared) ??
            resultError(i18n, restored) ??
            resultError(i18n, discarded)}
        </p>
      )}
      <Alert
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={t`Restore filter?`}
        description={
          pending && (
            <>
              {t`Restore the saved original filter on the server. ${plural(pending.preview.matches.length, { one: "Preview: # message.", other: "Preview: # messages." })}`}
              {requiresFilterDeleteConfirmation(pending.backup.input) && <FilterDeletionWarning />}
            </>
          )
        }
      >
        <AlertCancel>
          <Trans>Cancel</Trans>
        </AlertCancel>
        <button
          type="button"
          disabled={busy}
          className={alertPrimary}
          onClick={async () => {
            if (!pending) return;
            const exit = await restore({
              payload: {
                accountId: account.id,
                id: pending.backup.id,
                token: pending.preview.token,
                ...(requiresFilterDeleteConfirmation(pending.backup.input)
                  ? { queryDeletionConfirmed: true as const }
                  : {}),
              },
              reactivityKeys: MAIL_KEYS,
            });
            if (exit._tag === "Success") setPending(null);
          }}
        >{t`Restore filter`}</button>
      </Alert>
      <Alert
        open={discarding !== null}
        onOpenChange={(open) => {
          if (!open) setDiscarding(null);
        }}
        title={t`Discard saved filter?`}
        description={t`This deletes the saved recovery copy. Filters on the server are unchanged.`}
      >
        <AlertCancel>
          <Trans>Cancel</Trans>
        </AlertCancel>
        <button
          type="button"
          disabled={busy}
          className={alertDanger}
          onClick={async () => {
            if (!discarding) return;
            const exit = await discard({
              payload: { accountId: account.id, id: discarding.id, confirmed: true },
              reactivityKeys: MAIL_KEYS,
            });
            if (exit._tag === "Success") setDiscarding(null);
          }}
        >{t`Discard`}</button>
      </Alert>
    </section>
  );
}
