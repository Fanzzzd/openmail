import type { Account } from "../../../../../shared/api";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { SettingsGroup, SettingsRow } from "../../../ui/SettingsRows";
import { Select } from "../../../ui/Select";
import { accountName } from "../../../lib/format";
import { ServiceHint } from "../../accounts/OptionalServices";
import { canCall } from "../../../lib/platform";
import { ContactSettings } from "./ContactSettings";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { filtersListAtom, sendAsAtom, vacationAtom } from "../../../state/queries";
import { EMPTY_VACATION, type ServerFilter } from "@openmail/core/schema";
import { deleteFilterAtom, reauthAtom, syncSendAsAtom } from "../../../state/mutations";
import { resultError, settingsScopeMissing } from "../../../lib/errors";
import {
  buttonLink,
  buttonSecondary,
  noticeRow,
  noticeTone,
  settingsGroup,
  settingsHeading,
  settingsHint,
} from "../../../ui/styles";
import { SignInAgainOnMac } from "../../../ui/SignInAgainOnMac";
import { AsyncResult } from "effect/reactivity";
import { listRow, rowButton } from "./server-settings-styles";
import { PendingRuleRestorations } from "./PendingRuleRestorations";
import { FilterEditor } from "./FilterEditor";
import { VacationEditor } from "./VacationEditor";
import { Alert, AlertCancel, alertDanger } from "../../../ui/Dialog";
import { Keys } from "../../../state/keys";

// LazyDialogs loads the filter editor through this module, so it shares the ServerSettings chunk.
export { FilterEditor };

export function ServerSettings({ accounts }: { accounts: readonly Account[] }) {
  const { t } = useLingui();
  const available = accounts.filter((a) => a.enabled !== false && a.provider !== "imap");
  const [id, setId] = useState(available[0]?.id ?? "");
  const account = available.find((a) => a.id === id);
  if (!account)
    return (
      <p className="text-a11y-muted">
        <Trans>Server filters and automatic replies are available for Gmail and Outlook.</Trans>
      </p>
    );
  return (
    <section className="space-y-6">
      <div>
        <SettingsGroup>
          <SettingsRow label={t`Account`}>
            <Select
              aria-label={t`Account`}
              variant="field"
              className="min-w-48"
              value={id}
              onValueChange={setId}
              options={available.map((a) => ({ value: a.id, label: accountName(a) }))}
            />
          </SettingsRow>
        </SettingsGroup>
        <div className="mt-1.5 px-1 empty:hidden">
          <ServiceHint accountId={account.id} service="settings" />
        </div>
      </div>
      <AccountServerSettings key={id} account={account} />
      {/* Server contacts sync on the Mac: the remote server refuses ContactSync and RefreshContacts. */}
      {canCall("ContactSync") && <ContactSettings key={`contacts:${id}`} account={account} />}
    </section>
  );
}

function AccountServerSettings({ account }: { account: Account }) {
  const { t, i18n } = useLingui();
  const filters = useAtomValue(filtersListAtom(account.id));
  const vacation = useAtomValue(vacationAtom(account.id));
  const [editing, setEditing] = useState<ServerFilter | "new" | null>(null);
  const [applying, setApplying] = useState<ServerFilter | null>(null);
  const [reply, setReply] = useState(false);
  const [deleting, setDeleting] = useState<ServerFilter | null>(null);
  const [deleted, remove] = useAtom(deleteFilterAtom, { mode: "promiseExit" });
  const [signedIn, reauth] = useAtom(reauthAtom(account.id));
  return (
    <>
      {(resultError(i18n, filters) || resultError(i18n, vacation)) && (
        <div role="alert" className={`flex-wrap ${noticeRow} ${noticeTone.warning}`}>
          <p className="min-w-0 flex-1">
            {resultError(i18n, filters) ?? resultError(i18n, vacation)}
          </p>
          {(settingsScopeMissing(filters) || settingsScopeMissing(vacation)) &&
            (canCall("Reauth") ? (
              <button
                type="button"
                disabled={signedIn.waiting}
                onClick={() => reauth("settings")}
                className={buttonLink}
              >
                <Trans>Sign in again</Trans>
              </button>
            ) : (
              <SignInAgainOnMac className="font-medium" />
            ))}
          {resultError(i18n, signedIn) && <p className="w-full">{resultError(i18n, signedIn)}</p>}
        </div>
      )}
      <section>
        <h3 className={settingsHeading}>
          <Trans>Server filters</Trans>
        </h3>
        {filters._tag === "Initial" && (
          <output className={`block px-1 ${settingsHint}`}>
            <Trans>Loading…</Trans>
          </output>
        )}
        <ul className={`empty:hidden ${settingsGroup}`}>
          {AsyncResult.getOrElse(filters, () => []).map((f) => (
            <li key={f.id} className={listRow}>
              <span className="mr-2 min-w-0 flex-1">
                <span className="block truncate">{f.name}</span>
                {f.editable === false && (
                  <span
                    className={`mt-0.5 block ${settingsHint}`}
                  >{t`Edit this rule in webmail to preserve all conditions and actions.`}</span>
                )}
              </span>
              <button
                type="button"
                className={rowButton}
                disabled={f.editable === false}
                onClick={() => setEditing(f)}
              >{t`Edit`}</button>
              <button
                type="button"
                className={rowButton}
                disabled={f.editable === false}
                onClick={() => setApplying(f)}
              >{t`Apply to existing mail`}</button>
              <button
                type="button"
                className={`${rowButton} text-a11y-danger`}
                onClick={() => setDeleting(f)}
              >
                <Trans>Delete</Trans>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-start gap-4 px-1">
          <div className="min-w-0 flex-1">
            {resultError(i18n, deleted) && (
              <p role="alert" className="text-a11y-danger">
                {resultError(i18n, deleted)}
              </p>
            )}
          </div>
          <button
            type="button"
            className={buttonSecondary}
            disabled={filters._tag !== "Success"}
            onClick={() => setEditing("new")}
          >
            <Trans>Create filter</Trans>
          </button>
        </div>
      </section>
      <section>
        <h3 className={settingsHeading}>
          <Trans>Automatic replies</Trans>
        </h3>
        <div className="px-1">
          <button
            type="button"
            disabled={vacation._tag !== "Success"}
            className={buttonSecondary}
            onClick={() => setReply(true)}
          >
            <Trans>Edit automatic reply</Trans>
          </button>
        </div>
      </section>
      {account.provider === "gmail" && (
        <>
          <PendingRuleRestorations account={account} />
          <Aliases account={account} />
        </>
      )}
      {editing && (
        <FilterEditor
          account={account}
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {applying && (
        <FilterEditor
          account={account}
          initial={applying}
          mode="apply"
          onClose={() => setApplying(null)}
        />
      )}
      {reply && (
        <VacationEditor
          account={account}
          initial={AsyncResult.getOrElse(vacation, () => EMPTY_VACATION)}
          onClose={() => setReply(false)}
        />
      )}
      <Alert
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t`Delete filter?`}
        description={t`This removes the filter from the server. Existing messages are unchanged.`}
      >
        <AlertCancel>
          <Trans>Cancel</Trans>
        </AlertCancel>
        <button
          type="button"
          disabled={deleted.waiting}
          className={alertDanger}
          onClick={async () => {
            if (!deleting) return;
            const exit = await remove({
              payload: {
                accountId: account.id,
                id: deleting.id,
                confirmed: true,
              },
              reactivityKeys: [Keys.serverSettings, Keys.audit],
            });
            if (exit._tag === "Success") setDeleting(null);
          }}
        >
          <Trans>Delete</Trans>
        </button>
      </Alert>
    </>
  );
}

function Aliases({ account }: { account: Account }) {
  const { i18n } = useLingui();
  const aliases = AsyncResult.getOrElse(useAtomValue(sendAsAtom), () => []).filter(
    (a) => a.accountId === account.id,
  );
  const [result, sync] = useAtom(syncSendAsAtom);
  return (
    <section>
      <h3 className={settingsHeading}>
        <Trans>Gmail aliases and signatures</Trans>
      </h3>
      <ul className={`empty:hidden ${settingsGroup}`}>
        {aliases.map((a) => (
          <li key={a.address} className="truncate px-3 py-2.5">
            {a.name} &lt;{a.address}&gt;
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-start gap-4 px-1">
        <div className="min-w-0 flex-1">
          {resultError(i18n, result) && (
            <p role="alert" className="text-a11y-danger">
              {resultError(i18n, result)}
            </p>
          )}
        </div>
        <button
          type="button"
          className={buttonSecondary}
          disabled={result.waiting}
          onClick={() =>
            sync({
              payload: { accountId: account.id },
              reactivityKeys: [Keys.sendAs, Keys.signatures],
            })
          }
        >
          <Trans>Sync aliases and signatures</Trans>
        </button>
      </div>
    </section>
  );
}
