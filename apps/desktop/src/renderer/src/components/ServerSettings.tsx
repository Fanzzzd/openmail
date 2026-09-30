import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  EMPTY_FILTER,
  EMPTY_VACATION,
  type FilterInput,
  type Vacation,
} from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { Account } from "../../../shared/api";
import { resultError, settingsScopeMissing } from "../errors";
import { Keys } from "../state/keys";
import {
  createFilterAtom,
  deleteFilterAtom,
  reauthAtom,
  setVacationAtom,
  syncSendAsAtom,
} from "../state/mutations";
import { filtersListAtom, labelsAtom, sendAsAtom, vacationAtom } from "../state/queries";
import { MailClient } from "../rpc";
import { Alert, AlertCancel, alertDanger, Dialog } from "./ui/Dialog";
import { Checkbox } from "./ui/Checkbox";
import { Select } from "./ui/Select";
import { formButton, formInput } from "./OrganizationSettings";

export function ServerSettings({ accounts }: { accounts: readonly Account[] }) {
  const { t } = useLingui();
  const available = accounts.filter((a) => a.provider !== "imap");
  const [id, setId] = useState(available[0]?.id ?? "");
  const account = available.find((a) => a.id === id);
  if (!account)
    return (
      <p>
        <Trans>Server filters and automatic replies are available for Gmail and Outlook.</Trans>
      </p>
    );
  return (
    <section className="space-y-5">
      <Select
        aria-label={t`Account`}
        value={id}
        onValueChange={setId}
        options={available.map((a) => ({ value: a.id, label: a.email }))}
      />
      <AccountServerSettings key={id} account={account} />
    </section>
  );
}

function AccountServerSettings({ account }: { account: Account }) {
  const { t, i18n } = useLingui();
  const filters = useAtomValue(filtersListAtom(account.id));
  const vacation = useAtomValue(vacationAtom(account.id));
  const [editing, setEditing] = useState(false);
  const [reply, setReply] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleted, remove] = useAtom(deleteFilterAtom, { mode: "promiseExit" });
  const [signedIn, reauth] = useAtom(reauthAtom(account.id));
  return (
    <>
      {(resultError(i18n, filters) || resultError(i18n, vacation)) && (
        <div role="alert" className="space-y-2 text-orange-600">
          <p>{resultError(i18n, filters) ?? resultError(i18n, vacation)}</p>
          {(settingsScopeMissing(filters) || settingsScopeMissing(vacation)) && (
            <button
              type="button"
              disabled={signedIn.waiting}
              onClick={() => reauth()}
              className={formButton}
            >
              <Trans>Sign in again</Trans>
            </button>
          )}
          {resultError(i18n, signedIn) && <p>{resultError(i18n, signedIn)}</p>}
        </div>
      )}
      <section className="space-y-2">
        <h3 className="font-semibold">
          <Trans>Server filters</Trans>
        </h3>
        {filters._tag === "Initial" && (
          <output>
            <Trans>Loading…</Trans>
          </output>
        )}
        <ul className="divide-y divide-black/5 dark:divide-white/10">
          {AsyncResult.getOrElse(filters, () => []).map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3 py-2">
              <span className="truncate">{f.name}</span>
              <button type="button" className="text-red-500" onClick={() => setDeleting(f.id)}>
                <Trans>Delete</Trans>
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={formButton}
          disabled={filters._tag !== "Success"}
          onClick={() => setEditing(true)}
        >
          <Trans>Create filter</Trans>
        </button>
        {resultError(i18n, deleted) && (
          <p role="alert" className="text-red-500">
            {resultError(i18n, deleted)}
          </p>
        )}
      </section>
      <section className="space-y-2">
        <h3 className="font-semibold">
          <Trans>Automatic replies</Trans>
        </h3>
        <button
          type="button"
          disabled={vacation._tag !== "Success"}
          className={formButton}
          onClick={() => setReply(true)}
        >
          <Trans>Edit automatic reply</Trans>
        </button>
      </section>
      {account.provider === "gmail" && <Aliases account={account} />}
      {editing && <FilterEditor account={account} onClose={() => setEditing(false)} />}
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
        description={t`This removes the filter from the server.`}
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
              payload: { accountId: account.id, id: deleting },
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

export function FilterEditor({
  account,
  from = "",
  onClose,
}: {
  account: Account;
  from?: string;
  onClose: () => void;
}) {
  const { t, i18n } = useLingui();
  const [input, setInput] = useState<FilterInput>({
    ...EMPTY_FILTER,
    criteria: { ...EMPTY_FILTER.criteria, from },
  });
  const [result, create] = useAtom(createFilterAtom, { mode: "promiseExit" });
  const [signedIn, reauth] = useAtom(reauthAtom(account.id));
  const labels = AsyncResult.getOrElse(useAtomValue(labelsAtom([account.id])), () => []);
  const preview = useAtomValue(
    MailClient.query(
      "PreviewFilter",
      { accountId: account.id, criteria: input.criteria },
      { reactivityKeys: [Keys.threads] },
    ),
  );
  const matches = AsyncResult.getOrElse(preview, () => []);
  const count = matches.length;
  const criteria = (patch: Partial<FilterInput["criteria"]>) =>
    setInput((old) => ({ ...old, criteria: { ...old.criteria, ...patch } }));
  const action = (patch: Partial<FilterInput["action"]>) =>
    setInput((old) => ({ ...old, action: { ...old.action, ...patch } }));
  return (
    <Dialog
      aria-label={t`Create filter from these messages`}
      onClose={onClose}
      className="max-h-[85vh] w-[540px] overflow-y-auto p-5"
    >
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const exit = await create({
            payload: { accountId: account.id, input },
            reactivityKeys: [Keys.serverSettings, Keys.audit],
          });
          if (exit._tag === "Success") onClose();
        }}
      >
        <h2 className="font-semibold">
          <Trans>Create filter</Trans>
        </h2>
        {account.provider === "outlook" && (
          <label className="block space-y-1">
            <span>{t`Name`}</span>
            <input
              className={formInput}
              value={input.name}
              onChange={(e) => setInput({ ...input, name: e.target.value })}
              required
            />
          </label>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span>{t`From`}</span>
            <input
              className={formInput}
              value={input.criteria.from}
              onChange={(e) => criteria({ from: e.target.value })}
            />
          </label>
          <label className="block space-y-1">
            <span>{t`To`}</span>
            <input
              className={formInput}
              value={input.criteria.to}
              onChange={(e) => criteria({ to: e.target.value })}
            />
          </label>
        </div>
        <label className="block space-y-1">
          <span>{t`Subject contains`}</span>
          <input
            className={formInput}
            value={input.criteria.subject}
            onChange={(e) => criteria({ subject: e.target.value })}
          />
        </label>
        {account.provider === "gmail" && (
          <label className="block space-y-1">
            <span>{t`Search query`}</span>
            <input
              className={formInput}
              value={input.criteria.query}
              onChange={(e) => criteria({ query: e.target.value })}
            />
          </label>
        )}
        <label className="flex items-center gap-2">
          <Checkbox
            checked={input.criteria.hasAttachment}
            onCheckedChange={(hasAttachment) => criteria({ hasAttachment })}
          />
          <span>{t`Has attachment`}</span>
        </label>
        <fieldset className="space-y-2 rounded-md border border-black/10 p-3 dark:border-white/10">
          <legend>
            <Trans>Actions</Trans>
          </legend>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={input.action.archive}
              onCheckedChange={(archive) => action({ archive, trash: false, label: null })}
            />
            <span>{t`Archive`}</span>
          </label>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={input.action.markRead}
              onCheckedChange={(markRead) => action({ markRead })}
            />
            <span>{t`Mark as read`}</span>
          </label>
          {account.provider === "gmail" && (
            <label className="flex items-center gap-2">
              <Checkbox checked={input.action.star} onCheckedChange={(star) => action({ star })} />
              <span>{t`Star`}</span>
            </label>
          )}
          <label className="flex items-center gap-2">
            <Checkbox
              checked={input.action.trash}
              onCheckedChange={(trash) => action({ trash, archive: false, label: null })}
            />
            <span>{t`Delete`}</span>
          </label>
          <Select
            aria-label={t`Label or folder`}
            value={input.action.label ?? ""}
            options={[
              { value: "", label: t`No label or folder` },
              ...labels.map((l) => ({ value: l.id, label: l.name })),
            ]}
            onValueChange={(label) =>
              action({ label: label || null, archive: false, trash: false })
            }
          />
        </fieldset>
        <div className="space-y-1">
          <p aria-live="polite">
            <Trans>Local preview: {count} messages</Trans>
            {count === 200 && " +"}
          </p>
          <ul className="max-h-28 overflow-y-auto text-[12px] text-neutral-500">
            {matches.slice(0, 20).map((m) => (
              <li key={m.id} className="truncate">
                {m.from.address}: {m.subject}
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-neutral-500">
            <Trans>The filter applies to future mail on the server.</Trans>
          </p>
        </div>
        {resultError(i18n, result) && (
          <div role="alert" className="text-red-500">
            <p>{resultError(i18n, result)}</p>
            {settingsScopeMissing(result) && (
              <button type="button" disabled={signedIn.waiting} onClick={() => reauth()}>
                <Trans>Sign in again to enable filters</Trans>
              </button>
            )}
          </div>
        )}
        <button type="submit" className={formButton} disabled={result.waiting}>
          <Trans>Create filter</Trans>
        </button>
      </form>
    </Dialog>
  );
}

const datetime = (ms: number | null) =>
  ms === null
    ? ""
    : new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function VacationEditor({
  account,
  initial,
  onClose,
}: {
  account: Account;
  initial: Vacation;
  onClose: () => void;
}) {
  const { t, i18n } = useLingui();
  const [input, setInput] = useState(initial);
  const [result, save] = useAtom(setVacationAtom, { mode: "promiseExit" });
  return (
    <Dialog aria-label={t`Automatic replies`} onClose={onClose} className="w-[480px] p-5">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const exit = await save({
            payload: { accountId: account.id, input },
            reactivityKeys: [Keys.serverSettings, Keys.audit],
          });
          if (exit._tag === "Success") onClose();
        }}
      >
        <h2 className="font-semibold">
          <Trans>Automatic replies</Trans>
        </h2>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={input.enabled}
            onCheckedChange={(enabled) => setInput({ ...input, enabled })}
          />
          <span>{t`Enabled`}</span>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span>{t`Start`}</span>
            <input
              className={formInput}
              type="datetime-local"
              value={datetime(input.start)}
              onChange={(e) =>
                setInput({
                  ...input,
                  start: e.target.value ? new Date(e.target.value).getTime() : null,
                })
              }
            />
          </label>
          <label className="block space-y-1">
            <span>{t`End`}</span>
            <input
              className={formInput}
              type="datetime-local"
              value={datetime(input.end)}
              onChange={(e) =>
                setInput({
                  ...input,
                  end: e.target.value ? new Date(e.target.value).getTime() : null,
                })
              }
            />
          </label>
        </div>
        {account.provider === "gmail" ? (
          <label className="block space-y-1">
            <span>{t`Subject`}</span>
            <input
              className={formInput}
              value={input.subject}
              onChange={(e) => setInput({ ...input, subject: e.target.value })}
            />
          </label>
        ) : (
          <p className="text-[12px] text-neutral-500">
            <Trans>Outlook chooses the reply subject.</Trans>
          </p>
        )}
        <label className="block space-y-1">
          <span>{t`Message`}</span>
          <textarea
            rows={6}
            className={formInput}
            value={input.body}
            onChange={(e) => setInput({ ...input, body: e.target.value })}
          />
        </label>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={input.contactsOnly}
            onCheckedChange={(contactsOnly) => setInput({ ...input, contactsOnly })}
          />
          <span>{t`Reply only to contacts`}</span>
        </label>
        {resultError(i18n, result) && (
          <p role="alert" className="text-red-500">
            {resultError(i18n, result)}
          </p>
        )}
        <button type="submit" className={formButton} disabled={result.waiting}>
          <Trans>Save</Trans>
        </button>
      </form>
    </Dialog>
  );
}

function Aliases({ account }: { account: Account }) {
  const { i18n } = useLingui();
  const aliases = AsyncResult.getOrElse(useAtomValue(sendAsAtom), () => []).filter(
    (a) => a.accountId === account.id,
  );
  const [result, sync] = useAtom(syncSendAsAtom);
  return (
    <section className="space-y-2">
      <h3 className="font-semibold">
        <Trans>Gmail aliases and signatures</Trans>
      </h3>
      <ul>
        {aliases.map((a) => (
          <li key={a.address}>
            {a.name} &lt;{a.address}&gt;
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={formButton}
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
      {resultError(i18n, result) && (
        <p role="alert" className="text-red-500">
          {resultError(i18n, result)}
        </p>
      )}
    </section>
  );
}
