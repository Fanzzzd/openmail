import { ServiceHint } from "../../accounts/OptionalServices";
import { accountName } from "../../../lib/format";
import { categoryNames, importanceNames } from "../../../i18n/organization-labels";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  CATEGORIES,
  GMAIL_REMOVABLE_SYSTEM_LABELS,
  ruleImportance,
  outlookServerOnlyAction,
  MESSAGE_ACTION_FLAGS,
  RULE_IMPORTANCE,
  RULE_SENSITIVITY,
  outlookPreviewUnavailable,
  type OutlookRulePredicates,
  EMPTY_FILTER,
  requiresFilterDeleteConfirmation,
  EMPTY_VACATION,
  type FilterPreview,
  type FilterRestoration,
  type ServerFilter,
  htmlToText,
  escapeHtml,
  type FilterInput,
  type Vacation,
} from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import type { Account } from "../../../../../shared/api";
import { resultError, settingsScopeMissing } from "../../../lib/errors";
import { Keys, MAIL_KEYS } from "../../../state/keys";
import {
  updateFilterAtom,
  restoreFilterAtom,
  prepareFilterRestorationAtom,
  discardFilterRestorationAtom,
  applyFilterAtom,
  prepareFilterAtom,
  createFilterAtom,
  deleteFilterAtom,
  reauthAtom,
  setVacationAtom,
  syncSendAsAtom,
} from "../../../state/mutations";
import { filtersListAtom, labelsAtom, sendAsAtom, vacationAtom } from "../../../state/queries";
import { MailClient } from "../../../state/rpc";
import { Alert, AlertCancel, alertDanger, alertPrimary, Dialog } from "../../../ui/Dialog";
import { Disclosure } from "../../../ui/Disclosure";
import { Checkbox } from "../../../ui/Checkbox";
import { Select } from "../../../ui/Select";
import { ContactSettings } from "./ContactSettings";
import { SettingsGroup, SettingsRow } from "../../../ui/SettingsRows";
import {
  buttonLink,
  buttonPrimary,
  buttonSecondary,
  formInput,
  noticeRow,
  noticeTone,
  settingsGroup,
  settingsHeading,
  settingsHint,
} from "../../../ui/styles";

/** A borderless push button inside a settings row. */
const rowButton =
  "h-7 shrink-0 rounded-control px-2.5 font-medium outline-offset-1 outline-a11y-focus transition-colors duration-100 hover:bg-fill-hover focus-visible:outline-[3px] active:bg-fill-pressed disabled:opacity-50 disabled:hover:bg-transparent motion-reduce:transition-none";
/** One row in a settings list. */
const listRow = "flex min-h-10 items-center gap-1 px-3 py-1.5";
/** A field's label, above the field. */
const fieldLabel = "mb-1 block text-footnote font-medium text-a11y-muted";
/** A legend over a group of checkboxes inside a form. */
const fieldLegend = "mb-1.5 p-0 text-footnote font-medium text-a11y-muted";

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
      <ContactSettings key={`contacts:${id}`} account={account} />
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
          {(settingsScopeMissing(filters) || settingsScopeMissing(vacation)) && (
            <button
              type="button"
              disabled={signedIn.waiting}
              onClick={() => reauth("settings")}
              className={buttonLink}
            >
              <Trans>Sign in again</Trans>
            </button>
          )}
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

function PendingRuleRestorations({ account }: { account: Account }) {
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
            >{t`Restore rule`}</button>
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
        title={t`Restore rule?`}
        description={
          pending && (
            <>
              {t`Restore the saved original rule on the server. Preview: ${pending.preview.matches.length} messages.`}
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
        >{t`Restore rule`}</button>
      </Alert>
      <Alert
        open={discarding !== null}
        onOpenChange={(open) => {
          if (!open) setDiscarding(null);
        }}
        title={t`Discard saved rule?`}
        description={t`This deletes the saved recovery copy. Rules on the server are unchanged.`}
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

function FilterDeletionWarning() {
  return (
    // The alert dialog announces its description, so this needs no role of its own.
    <span className="mt-2 block font-medium text-a11y-danger">
      <Trans>
        This rule deletes messages. Confirm only if the preview matches the messages you intend to
        delete.
      </Trans>
    </span>
  );
}

function OutlookPredicatesEditor({
  value,
  onChange,
}: {
  value: OutlookRulePredicates;
  onChange: (value: OutlookRulePredicates) => void;
}) {
  const { t } = useLingui();
  const patch = (update: Partial<OutlookRulePredicates>) => {
    const next = { ...value, ...update };
    const entries: [string, unknown][] = Object.entries(next);
    onChange(Object.fromEntries(entries.filter(([, v]) => v !== undefined)));
  };
  const importance = importanceNames(t);
  const sensitivity = {
    normal: t`Normal`,
    personal: t`Personal`,
    private: t`Private`,
    confidential: t`Confidential`,
  };
  const flags = {
    any: t`Any action flag`,
    call: t`Call`,
    doNotForward: t({
      message: "Do not forward",
      comment: "Incoming message action flag value; this option does not execute forwarding.",
    }),
    followUp: t`Follow up`,
    fyi: t`For your information`,
    forward: t({
      message: "Forward",
      context: "incoming message action flag",
      comment: "Flag value on the incoming message, not an action to execute.",
    }),
    noResponseNecessary: t`No response needed`,
    read: t({
      message: "Read",
      context: "incoming message action flag",
      comment: "Flag value on the incoming message, not an action to execute.",
    }),
    reply: t({
      message: "Reply",
      context: "incoming message action flag",
      comment: "Flag value on the incoming message, not an action to execute.",
    }),
    replyToAll: t({
      message: "Reply all",
      context: "incoming message action flag",
      comment: "Flag value on the incoming message, not an action to execute.",
    }),
    review: t`Review`,
  };
  const selects = [
    {
      key: "importance",
      label: t`Importance condition`,
      value: value.importance ?? "",
      options: RULE_IMPORTANCE.map((entry) => ({ value: entry, label: importance[entry] })),
      onChange: (next: string) =>
        patch({ importance: RULE_IMPORTANCE.find((entry) => entry === next) }),
    },
    {
      key: "sensitivity",
      label: t`Sensitivity`,
      value: value.sensitivity ?? "",
      options: RULE_SENSITIVITY.map((entry) => ({ value: entry, label: sensitivity[entry] })),
      onChange: (next: string) =>
        patch({ sensitivity: RULE_SENSITIVITY.find((entry) => entry === next) }),
    },
    {
      key: "messageActionFlag",
      label: t`Message action flag`,
      value: value.messageActionFlag ?? "",
      options: MESSAGE_ACTION_FLAGS.map((entry) => ({ value: entry, label: flags[entry] })),
      onChange: (next: string) =>
        patch({ messageActionFlag: MESSAGE_ACTION_FLAGS.find((entry) => entry === next) }),
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-3">
      {(
        [
          {
            key: "bodyContains",
            label: t({
              message: "Message text contains",
              comment: "Rule predicate matching the message text, excluding the subject.",
            }),
          },
          { key: "headerContains", label: t`Headers contain` },
        ] as const
      ).map(({ key, label }) => (
        <label key={key} className="block">
          <span className={fieldLabel}>{label}</span>
          <input
            className={formInput}
            value={value[key]?.[0] ?? ""}
            onChange={(e) => patch({ [key]: e.target.value ? [e.target.value] : undefined })}
          />
        </label>
      ))}
      {selects.map((select) => (
        // Not a label: a click on it would reach the select's hidden input, not its button.
        <div
          key={select.key}
          className={select.key === "messageActionFlag" ? "col-span-2" : undefined}
        >
          <span className={fieldLabel}>{select.label}</span>
          <Select
            aria-label={select.label}
            variant="field"
            value={select.value}
            options={[{ value: "", label: t`None` }, ...select.options]}
            onValueChange={select.onChange}
          />
        </div>
      ))}
      {(
        [
          { key: "minimumSize", label: t`Minimum size (KiB)` },
          { key: "maximumSize", label: t`Maximum size (KiB)` },
        ] as const
      ).map(({ key, label }) => (
        <label key={key} className="block">
          <span className={fieldLabel}>{label}</span>
          <input
            className={formInput}
            type="number"
            min="0"
            step="1"
            max="2147483647"
            value={value.withinSizeRange?.[key] ?? ""}
            onChange={(e) => {
              const range = { ...value.withinSizeRange };
              if (e.target.value) range[key] = Number(e.target.value);
              else delete range[key];
              patch({ withinSizeRange: Object.keys(range).length ? range : undefined });
            }}
          />
        </label>
      ))}
      {(
        [
          { key: "isAutomaticReply", label: t`Automatic reply` },
          { key: "sentToMe", label: t`To me` },
          { key: "sentOnlyToMe", label: t`Only to me` },
          { key: "sentCcMe", label: t`CC me` },
          { key: "notSentToMe", label: t`Not to me` },
          { key: "sentToOrCcMe", label: t`To or CC me` },
        ] as const
      ).map(({ key, label }) => (
        <label key={key} className="flex items-center gap-2">
          <Checkbox
            checked={value[key] ?? false}
            onCheckedChange={(checked) => patch({ [key]: checked ? true : undefined })}
          />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

export function FilterEditor({
  account,
  from = "",
  initial,
  mode = "save",
  onClose,
}: {
  account: Account;
  from?: string;
  initial?: ServerFilter | undefined;
  mode?: "save" | "apply";
  onClose: () => void;
}) {
  const { t, i18n } = useLingui();
  const categories = categoryNames(t);
  const importance = importanceNames(t);
  const [input, setInput] = useState<FilterInput>(() => {
    const value = initial ?? { ...EMPTY_FILTER, criteria: { ...EMPTY_FILTER.criteria, from } };
    return { name: value.name, criteria: value.criteria, action: value.action };
  });
  const [confirming, setConfirming] = useState<{
    input: FilterInput;
    preview: FilterPreview;
  } | null>(null);
  const [categoriesText, setCategoriesText] = useState(
    input.action.assignCategories?.join("\n") ?? "",
  );
  const [inputSource, setInputSource] = useState(initial);
  const [categoriesSource, setCategoriesSource] = useState(input.action.assignCategories);
  if (inputSource !== initial) {
    setInputSource(initial);
    if (initial)
      setInput({ name: initial.name, criteria: initial.criteria, action: initial.action });
  }
  if (categoriesSource !== input.action.assignCategories) {
    setCategoriesSource(input.action.assignCategories);
    const edited = categoriesText.split("\n").filter((value) => value.trim());
    if (JSON.stringify(edited) !== JSON.stringify(input.action.assignCategories ?? []))
      setCategoriesText(input.action.assignCategories?.join("\n") ?? "");
  }
  const [previewCriteria, setPreviewCriteria] = useState(input.criteria);
  useEffect(() => {
    const timer = setTimeout(() => setPreviewCriteria(input.criteria), 350);
    return () => clearTimeout(timer);
  }, [input.criteria]);
  const [result, create] = useAtom(createFilterAtom, { mode: "promiseExit" });
  const [updated, update] = useAtom(updateFilterAtom, { mode: "promiseExit" });
  const [applied, apply] = useAtom(applyFilterAtom, { mode: "promiseExit" });
  const [prepared, prepare] = useAtom(prepareFilterAtom, { mode: "promiseExit" });
  const busy = result.waiting || updated.waiting || applied.waiting || prepared.waiting;
  const [signedIn, reauth] = useAtom(reauthAtom(account.id));
  const labels = AsyncResult.getOrElse(useAtomValue(labelsAtom([account.id])), () => []);
  const preview = useAtomValue(
    MailClient.query(
      "PreviewFilter",
      { accountId: account.id, criteria: previewCriteria },
      { reactivityKeys: [Keys.threads] },
    ),
  );
  const previewUnavailable =
    account.provider === "outlook" &&
    (outlookPreviewUnavailable(input.criteria).length > 0 || preview._tag === "Failure");
  const matches = previewUnavailable ? [] : AsyncResult.getOrElse(preview, () => []);
  const count = matches.length;
  const serverOnlyAction = account.provider === "outlook" && outlookServerOnlyAction(input.action);
  const previewBusy =
    previewCriteria !== input.criteria || preview._tag === "Initial" || preview.waiting;
  const submit = async (value: FilterInput, token: string) => {
    const payload = {
      accountId: account.id,
      input: requiresFilterDeleteConfirmation(value)
        ? { ...value, queryDeletionConfirmed: true as const }
        : value,
      token,
    };
    const reactivityKeys = MAIL_KEYS;
    const exit =
      mode === "apply"
        ? await apply({ payload, reactivityKeys })
        : initial
          ? await update({ payload: { ...payload, id: initial.id }, reactivityKeys })
          : await create({ payload, reactivityKeys });
    if (exit._tag === "Success") onClose();
  };
  const criteria = (patch: Partial<FilterInput["criteria"]>) =>
    setInput((old) => {
      const next = { ...old.criteria, ...patch };
      if (next.size === undefined) delete next.size;
      if (next.sizeComparison === undefined) delete next.sizeComparison;
      return { ...old, criteria: next };
    });
  const action = (patch: Partial<FilterInput["action"]>) =>
    setInput((old) => {
      const next = { ...old.action, ...patch };
      if (next.important === undefined) delete next.important;
      if (next.category === undefined) delete next.category;
      if (next.markImportance === undefined) delete next.markImportance;
      if (next.copyToFolder === undefined) delete next.copyToFolder;
      return { ...old, action: next };
    });
  return (
    <Dialog
      aria-label={t`Create filter from these messages`}
      onClose={onClose}
      className="max-h-[85vh] w-[540px] overflow-y-auto p-5"
    >
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const exit = await prepare({ payload: { accountId: account.id, input } });
          if (exit._tag === "Success") setConfirming({ input, preview: exit.value });
        }}
      >
        <h2 className="text-headline font-semibold">
          {mode === "apply" ? t`Apply to existing mail` : initial ? t`Save rule` : t`Create filter`}
        </h2>
        {account.provider === "outlook" && (
          <label className="block">
            <span className={fieldLabel}>{t`Name`}</span>
            <input
              className={formInput}
              value={input.name}
              onChange={(e) => setInput({ ...input, name: e.target.value })}
              required
            />
          </label>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={fieldLabel}>{t`From`}</span>
            <input
              className={formInput}
              value={input.criteria.from}
              onChange={(e) => criteria({ from: e.target.value })}
            />
          </label>
          <label className="block">
            <span className={fieldLabel}>{t`To`}</span>
            <input
              className={formInput}
              value={input.criteria.to}
              onChange={(e) => criteria({ to: e.target.value })}
            />
          </label>
        </div>
        <label className="block">
          <span className={fieldLabel}>{t`Subject contains`}</span>
          <input
            className={formInput}
            value={input.criteria.subject}
            onChange={(e) => criteria({ subject: e.target.value })}
          />
        </label>
        {account.provider === "gmail" && (
          <label className="block">
            <span className={fieldLabel}>{t`Search query`}</span>
            <input
              className={formInput}
              value={input.criteria.query}
              onChange={(e) => criteria({ query: e.target.value })}
            />
          </label>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={fieldLabel}>{t`Has words`}</span>
            <input
              className={formInput}
              value={input.criteria.hasWords ?? ""}
              onChange={(e) => criteria({ hasWords: e.target.value })}
            />
          </label>
          <label className="block">
            <span className={fieldLabel}>{t`Does not have words`}</span>
            <input
              className={formInput}
              value={input.criteria.notWords ?? ""}
              onChange={(e) => criteria({ notWords: e.target.value })}
            />
          </label>
          {/* Sits on the input row: the chosen comparison labels itself. */}
          <div className="self-end">
            <Select
              aria-label={t`Size comparison`}
              variant="field"
              value={input.criteria.sizeComparison ?? "larger"}
              options={[
                { value: "larger", label: t`Larger than` },
                { value: "smaller", label: t`Smaller than` },
              ]}
              onValueChange={(sizeComparison) => criteria({ sizeComparison })}
            />
          </div>
          <label className="block">
            <span className={fieldLabel}>{t`Size in bytes`}</span>
            <input
              type="number"
              min="0"
              step={account.provider === "outlook" ? "1024" : "1"}
              className={formInput}
              disabled={!!input.criteria.outlook?.withinSizeRange}
              value={input.criteria.size ?? ""}
              onChange={(e) =>
                criteria({
                  size: e.target.value ? Number(e.target.value) : undefined,
                  sizeComparison: input.criteria.sizeComparison ?? "larger",
                })
              }
            />
          </label>
        </div>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={input.criteria.hasAttachment}
            onCheckedChange={(hasAttachment) => criteria({ hasAttachment })}
          />
          <span>{t`Has attachment`}</span>
        </label>
        {account.provider === "outlook" && (
          <div className="space-y-4">
            <label className="block">
              <span className={fieldLabel}>{t`Except sender contains`}</span>
              <input
                className={formInput}
                value={input.criteria.exceptFrom ?? ""}
                onChange={(e) => criteria({ exceptFrom: e.target.value })}
              />
            </label>
            <label className="block">
              <span className={fieldLabel}>{t`Except recipient contains`}</span>
              <input
                className={formInput}
                value={input.criteria.exceptTo ?? ""}
                onChange={(e) => criteria({ exceptTo: e.target.value })}
              />
            </label>
            <label className="block">
              <span className={fieldLabel}>{t`Except subject contains`}</span>
              <input
                className={formInput}
                value={input.criteria.exceptSubject ?? ""}
                onChange={(e) => criteria({ exceptSubject: e.target.value })}
              />
            </label>
            {/* Not a label: a click on it would reach the select's hidden input, not its button. */}
            <div>
              <span className={fieldLabel}>{t`Attachment exception`}</span>
              <Select
                aria-label={t`Attachment exception`}
                variant="field"
                value={input.criteria.exceptAttachment === true ? "with" : "none"}
                options={[
                  { value: "none", label: t`None` },
                  { value: "with", label: t`Has attachment` },
                ]}
                onValueChange={(value) =>
                  criteria({ exceptAttachment: value === "none" ? undefined : true })
                }
              />
            </div>
          </div>
        )}
        {account.provider === "outlook" && (
          <>
            <Disclosure summary={t`More conditions`} panelClassName="space-y-3">
              <OutlookPredicatesEditor
                value={input.criteria.outlook ?? {}}
                onChange={(outlook) =>
                  criteria({
                    outlook,
                    ...(outlook.withinSizeRange
                      ? { size: undefined, sizeComparison: undefined }
                      : {}),
                  })
                }
              />
            </Disclosure>
            <Disclosure summary={t`More exceptions`} panelClassName="space-y-3">
              <OutlookPredicatesEditor
                value={input.criteria.outlookExceptions ?? {}}
                onChange={(outlookExceptions) => criteria({ outlookExceptions })}
              />
            </Disclosure>
          </>
        )}
        {account.provider === "gmail" && (
          <label className="flex items-center gap-2">
            <Checkbox
              checked={input.criteria.excludeChats ?? false}
              onCheckedChange={(excludeChats) => criteria({ excludeChats })}
            />
            <span>{t`Exclude chats`}</span>
          </label>
        )}
        <fieldset className="rounded-card bg-raised px-3 pt-2.5 pb-3 ring-1 ring-edge dark:bg-white/[0.03]">
          <legend className={`float-left w-full ${fieldLegend}`}>
            <Trans>Actions</Trans>
          </legend>
          <div className="clear-both space-y-2.5">
            {account.provider === "outlook" && (
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={input.action.stopProcessing ?? false}
                  onCheckedChange={(stopProcessing) => action({ stopProcessing })}
                />
                <span>{t`Stop processing more rules`}</span>
              </label>
            )}
            <label className="flex items-center gap-2">
              <Checkbox
                checked={input.action.archive}
                onCheckedChange={(archive) =>
                  action({
                    archive,
                    trash: false,
                    ...(account.provider === "gmail" ? {} : { label: null }),
                  })
                }
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
                <Checkbox
                  checked={input.action.star}
                  onCheckedChange={(star) => action({ star })}
                />
                <span>{t`Star`}</span>
              </label>
            )}
            {account.provider === "gmail" && (
              <Select
                aria-label={t`Importance action`}
                variant="field"
                value={
                  input.action.important === undefined
                    ? "unchanged"
                    : input.action.important
                      ? "important"
                      : "normal"
                }
                options={[
                  { value: "unchanged", label: t`Keep importance` },
                  { value: "important", label: t`Mark as important` },
                  { value: "normal", label: t`Mark as not important` },
                ]}
                onValueChange={(value) =>
                  action({ important: value === "unchanged" ? undefined : value === "important" })
                }
              />
            )}

            {account.provider === "outlook" && (
              <>
                <Select
                  aria-label={t`Importance action`}
                  variant="field"
                  value={ruleImportance(input.action) ?? ""}
                  options={[
                    { value: "", label: t`Keep importance` },
                    ...RULE_IMPORTANCE.map((entry) => ({ value: entry, label: importance[entry] })),
                  ]}
                  onValueChange={(v) =>
                    action({
                      important: undefined,
                      markImportance: RULE_IMPORTANCE.find((entry) => entry === v),
                    })
                  }
                />
                <label className="block">
                  <span className={fieldLabel}>{t`Assign categories (one per line)`}</span>
                  <textarea
                    rows={2}
                    className={formInput}
                    value={categoriesText}
                    onChange={(e) => {
                      setCategoriesText(e.target.value);
                      action({
                        assignCategories: e.target.value
                          .split("\n")
                          .filter((value) => value.trim()),
                      });
                    }}
                  />
                </label>
                <Select
                  aria-label={t`Copy to folder`}
                  variant="field"
                  value={input.action.copyToFolder ?? ""}
                  options={[
                    { value: "", label: t`No copy` },
                    ...labels.map((l) => ({ value: l.id, label: l.name })),
                  ]}
                  onValueChange={(copyToFolder) =>
                    action({ copyToFolder: copyToFolder || undefined })
                  }
                />
              </>
            )}
            {account.provider === "gmail" && (
              <>
                <Select
                  aria-label={t`Category action`}
                  variant="field"
                  value={input.action.category ?? ""}
                  options={[
                    { value: "", label: t`Keep category` },
                    ...CATEGORIES.map((category) => ({
                      value: category,
                      label: categories[category],
                    })),
                  ]}
                  onValueChange={(value) =>
                    action({ category: CATEGORIES.find((c) => c === value) })
                  }
                />
                <fieldset className="space-y-1.5">
                  <legend className={fieldLegend}>{t`Additional labels`}</legend>
                  {labels.map((label) => (
                    <label key={label.id} className="flex items-center gap-2">
                      <Checkbox
                        checked={input.action.labels?.includes(label.id) ?? false}
                        onCheckedChange={(checked) =>
                          action({
                            labels: checked
                              ? [...(input.action.labels ?? []), label.id]
                              : (input.action.labels ?? []).filter((id) => id !== label.id),
                            trash: false,
                          })
                        }
                      />
                      <span>{label.name}</span>
                    </label>
                  ))}
                </fieldset>
              </>
            )}
            {account.provider === "gmail" && (
              <Disclosure summary={t`More label actions`} panelClassName="space-y-3">
                {(
                  [
                    { key: "addLabelIds", title: t`Add labels` },
                    { key: "removeLabelIds", title: t`Remove labels` },
                  ] as const
                ).map(({ key, title }) => (
                  <fieldset key={key} className="space-y-1.5">
                    <legend className={fieldLegend}>{title}</legend>
                    {[
                      ...labels,
                      { id: "INBOX", name: t`Inbox` },
                      { id: "UNREAD", name: t`Unread` },
                      { id: "STARRED", name: t`Starred` },
                      { id: "IMPORTANT", name: t`Important` },
                      { id: "SPAM", name: t`Spam` },
                      { id: "TRASH", name: t`Trash` },
                      ...CATEGORIES.map((id) => ({
                        id,
                        name: categories[id],
                      })),
                    ]
                      .filter((label) =>
                        key === "addLabelIds"
                          ? CATEGORIES.some((category) => category === label.id)
                          : !GMAIL_REMOVABLE_SYSTEM_LABELS.some((id) => id === label.id),
                      )
                      .map((label) => (
                        <label key={label.id} className="flex items-center gap-2">
                          <Checkbox
                            checked={input.action[key]?.includes(label.id) ?? false}
                            onCheckedChange={(checked) =>
                              action({
                                [key]: checked
                                  ? [...(input.action[key] ?? []), label.id]
                                  : (input.action[key] ?? []).filter((id) => id !== label.id),
                              })
                            }
                          />
                          <span>{label.name}</span>
                        </label>
                      ))}
                  </fieldset>
                ))}
              </Disclosure>
            )}
            <label className="flex items-center gap-2">
              <Checkbox
                checked={input.action.trash}
                onCheckedChange={(trash) =>
                  action({ trash, archive: false, label: null, labels: [], category: undefined })
                }
              />
              <span>{t`Delete`}</span>
            </label>
            <Select
              aria-label={t`Label or folder`}
              variant="field"
              value={input.action.label ?? ""}
              options={[
                { value: "", label: t`No label or folder` },
                ...labels.map((l) => ({ value: l.id, label: l.name })),
              ]}
              onValueChange={(label) =>
                action({
                  label: label || null,
                  trash: false,
                  ...(account.provider === "gmail" ? {} : { archive: false }),
                })
              }
            />
          </div>
        </fieldset>
        <div className="space-y-1.5">
          <p aria-live="polite" className="font-medium">
            {previewBusy ? (
              <Trans>Loading…</Trans>
            ) : previewUnavailable ? (
              <Trans>Preview unavailable</Trans>
            ) : account.provider === "gmail" ? (
              <Trans>Server preview: {count} messages</Trans>
            ) : (
              <Trans>Local preview: {count} messages</Trans>
            )}
            {count === 200 && " +"}
          </p>
          {previewUnavailable && (
            <p className={settingsHint}>
              <Trans>
                Some conditions need metadata that is not cached. Save the rule for future mail on
                the server.
              </Trans>
            </p>
          )}
          {mode === "apply" && serverOnlyAction && (
            <p className={settingsHint}>
              <Trans>This rule can only be applied to future mail on the server</Trans>
            </p>
          )}
          {resultError(i18n, preview) && (
            <p role="alert" className="text-a11y-danger">
              {resultError(i18n, preview)}
            </p>
          )}
          <ul
            className={`max-h-28 overflow-y-auto rounded-control bg-fill-quiet px-2 py-1.5 empty:hidden ${settingsHint}`}
          >
            {matches.slice(0, 20).map((m) => (
              <li key={m.id} className="truncate">
                {m.from.address}: {m.subject}
              </li>
            ))}
          </ul>
          {mode !== "apply" && (
            <p className={settingsHint}>
              <Trans>The filter applies to future mail on the server.</Trans>
            </p>
          )}
        </div>
        {(resultError(i18n, result) ||
          resultError(i18n, updated) ||
          resultError(i18n, applied) ||
          resultError(i18n, prepared)) && (
          <div role="alert" className={`flex-wrap ${noticeRow} ${noticeTone.danger}`}>
            <p className="min-w-0 flex-1">
              {resultError(i18n, result) ??
                resultError(i18n, updated) ??
                resultError(i18n, applied) ??
                resultError(i18n, prepared)}
            </p>
            {settingsScopeMissing(result) && (
              <button
                type="button"
                className={buttonLink}
                disabled={signedIn.waiting}
                onClick={() => reauth("settings")}
              >
                <Trans>Sign in again to enable filters</Trans>
              </button>
            )}
          </div>
        )}
        <div className="flex justify-end pt-1">
          <button
            type="submit"
            className={buttonPrimary}
            disabled={
              busy ||
              (mode === "apply" && (previewUnavailable || serverOnlyAction)) ||
              (account.provider === "gmail" && (previewBusy || preview._tag !== "Success"))
            }
          >
            {mode === "apply"
              ? t`Apply to existing mail`
              : initial
                ? t`Save rule`
                : t`Create filter`}
          </button>
        </div>
      </form>
      <Alert
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={mode === "apply" ? t`Apply to existing mail?` : t`Confirm rule changes?`}
        description={
          confirming && (
            <>
              {confirming.preview.unavailable?.length
                ? t`Preview unavailable. The rule will apply to future mail on the server.`
                : t`Preview: ${confirming.preview.matches.length} messages. Only the previewed messages will be changed when applying to existing mail.`}
              {confirming.preview.truncated && (
                <span className="mt-2 block">
                  {account.provider === "outlook"
                    ? t`The preview checked at most 201 server messages. Matching messages outside this sample may be missing.`
                    : t`The preview is limited to 200 messages. Narrow the conditions to process other messages.`}
                </span>
              )}
              {requiresFilterDeleteConfirmation(confirming.input) && <FilterDeletionWarning />}
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
          className={alertDanger}
          onClick={() => {
            if (confirming) void submit(confirming.input, confirming.preview.token);
          }}
        >
          <Trans>Confirm</Trans>
        </button>
      </Alert>
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
  const [internalBody, setInternalBody] = useState(() =>
    htmlToText(initial.outlook?.internalReplyMessage ?? ""),
  );
  const [result, save] = useAtom(setVacationAtom, { mode: "promiseExit" });
  const replies = input.outlook ?? {
    externalAudience: "none",
    internalReplyMessage: "",
    externalReplyMessage: "",
  };
  return (
    <Dialog aria-label={t`Automatic replies`} onClose={onClose} className="w-[480px] p-5">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const exit = await save({
            payload: { accountId: account.id, input },
            reactivityKeys: [Keys.serverSettings, Keys.audit],
          });
          if (exit._tag === "Success") onClose();
        }}
      >
        <h2 className="text-headline font-semibold">
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
          <label className="block">
            <span className={fieldLabel}>{t`Start`}</span>
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
          <label className="block">
            <span className={fieldLabel}>{t`End`}</span>
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
          <label className="block">
            <span className={fieldLabel}>{t`Subject`}</span>
            <input
              className={formInput}
              value={input.subject}
              onChange={(e) => setInput({ ...input, subject: e.target.value })}
            />
          </label>
        ) : (
          <p className={settingsHint}>
            <Trans>Outlook chooses the reply subject.</Trans>
          </p>
        )}
        <label className="block">
          <span className={fieldLabel}>{t`Message`}</span>
          <textarea
            rows={6}
            className={formInput}
            value={input.body}
            onChange={(e) => setInput({ ...input, body: e.target.value })}
          />
        </label>
        {account.provider === "gmail" ? (
          <label className="flex items-center gap-2">
            <Checkbox
              checked={input.contactsOnly}
              onCheckedChange={(contactsOnly) => setInput({ ...input, contactsOnly })}
            />
            <span>{t`Reply only to contacts`}</span>
          </label>
        ) : (
          <>
            <Select
              aria-label={t`External replies`}
              variant="field"
              value={replies.externalAudience}
              onValueChange={(externalAudience) =>
                setInput({
                  ...input,
                  contactsOnly: externalAudience === "contactsOnly",
                  outlook: { ...replies, externalAudience },
                })
              }
              options={[
                { value: "none", label: t`No external replies` },
                { value: "contactsOnly", label: t`Contacts only` },
                { value: "all", label: t`Everyone` },
              ]}
            />
            <label className="block">
              <span className={fieldLabel}>{t`Internal reply`}</span>
              <textarea
                rows={4}
                className={formInput}
                value={internalBody}
                onChange={(e) => {
                  setInternalBody(e.target.value);
                  setInput({
                    ...input,
                    outlook: {
                      ...replies,
                      internalReplyMessage: `<p>${escapeHtml(e.target.value).replaceAll("\n", "<br>")}</p>`,
                    },
                  });
                }}
              />
            </label>
          </>
        )}
        {resultError(i18n, result) && (
          <p role="alert" className="text-a11y-danger">
            {resultError(i18n, result)}
          </p>
        )}
        <div className="flex justify-end pt-1">
          <button type="submit" className={buttonPrimary} disabled={result.waiting}>
            <Trans>Save</Trans>
          </button>
        </div>
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
