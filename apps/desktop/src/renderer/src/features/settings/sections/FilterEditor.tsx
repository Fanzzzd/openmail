import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Account } from "../../../../../shared/api";
import {
  CATEGORIES,
  EMPTY_FILTER,
  GMAIL_REMOVABLE_SYSTEM_LABELS,
  RULE_IMPORTANCE,
  outlookPreviewUnavailable,
  outlookServerOnlyAction,
  providerCapabilities,
  requiresFilterDeleteConfirmation,
  ruleImportance,
  type FilterInput,
  type FilterPreview,
  type ServerFilter,
} from "@openmail/core/schema";
import { categoryNames, importanceNames } from "../../../i18n/organization-labels";
import { useEffect, useState } from "react";
import { useAtom, useAtomValue } from "@effect/atom-react";
import {
  applyFilterAtom,
  createFilterAtom,
  prepareFilterAtom,
  reauthAtom,
  updateFilterAtom,
} from "../../../state/mutations";
import { AsyncResult } from "effect/reactivity";
import { labelsAtom } from "../../../state/queries";
import { MailClient } from "../../../state/rpc";
import { Keys, MAIL_KEYS } from "../../../state/keys";
import { Alert, AlertCancel, Dialog, alertDanger } from "../../../ui/Dialog";
import { fieldLabel, fieldLegend } from "./server-settings-styles";
import {
  buttonLink,
  buttonPrimary,
  formInput,
  noticeRow,
  noticeTone,
  settingsHint,
} from "../../../ui/styles";
import { Select } from "../../../ui/Select";
import { Checkbox } from "../../../ui/Checkbox";
import { Disclosure } from "../../../ui/Disclosure";
import { OutlookPredicatesEditor } from "./OutlookPredicatesEditor";
import { resultError, settingsScopeMissing } from "../../../lib/errors";
import { canCall } from "../../../lib/platform";
import { SignInAgainOnMac } from "../../../ui/SignInAgainOnMac";

export function FilterDeletionWarning() {
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
  const caps = providerCapabilities(account.provider);
  const rules = caps.rules;
  const previewUnavailable =
    rules?.preview === "cache" &&
    (outlookPreviewUnavailable(input.criteria).length > 0 || preview._tag === "Failure");
  const matches = previewUnavailable ? [] : AsyncResult.getOrElse(preview, () => []);
  const count = matches.length;
  const serverOnlyAction = !!rules?.serverOnlyActions && outlookServerOnlyAction(input.action);
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
      maxHeight="85vh"
      className="w-[540px] overflow-y-auto p-5"
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
          {mode === "apply"
            ? t`Apply to existing mail`
            : initial
              ? t`Save filter`
              : t`Create filter`}
        </h2>
        {rules?.named && (
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
        {rules?.query && (
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
              step={String(rules?.sizeStep ?? 1)}
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
        {rules?.exceptions && (
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
        {rules?.exceptions && (
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
        {rules?.excludeChats && (
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
            {rules?.serverOnlyActions && (
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={input.action.stopProcessing ?? false}
                  onCheckedChange={(stopProcessing) => action({ stopProcessing })}
                />
                <span>{t`Stop processing more filters`}</span>
              </label>
            )}
            <label className="flex items-center gap-2">
              <Checkbox
                checked={input.action.archive}
                onCheckedChange={(archive) =>
                  action({
                    archive,
                    trash: false,
                    ...(caps.organization === "labels" ? {} : { label: null }),
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
            {rules?.star && (
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={input.action.star}
                  onCheckedChange={(star) => action({ star })}
                />
                <span>{t`Star`}</span>
              </label>
            )}
            {rules?.importanceLabel && (
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

            {rules?.serverOnlyActions && (
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
            {rules?.labelActions && (
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
            {rules?.labelActions && (
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
                  ...(caps.organization === "labels" ? {} : { archive: false }),
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
            ) : rules?.preview === "server" ? (
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
              <Trans>This filter can only be applied to future mail on the server</Trans>
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
            {settingsScopeMissing(result) &&
              (canCall("Reauth") ? (
                <button
                  type="button"
                  className={buttonLink}
                  disabled={signedIn.waiting}
                  onClick={() => reauth("settings")}
                >
                  <Trans>Sign in again to enable filters</Trans>
                </button>
              ) : (
                <SignInAgainOnMac className="font-medium" />
              ))}
          </div>
        )}
        <div className="flex justify-end pt-1">
          <button
            type="submit"
            className={buttonPrimary}
            disabled={
              busy ||
              (mode === "apply" && (previewUnavailable || serverOnlyAction)) ||
              (rules?.preview === "server" && (previewBusy || preview._tag !== "Success"))
            }
          >
            {mode === "apply"
              ? t`Apply to existing mail`
              : initial
                ? t`Save filter`
                : t`Create filter`}
          </button>
        </div>
      </form>
      <Alert
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={mode === "apply" ? t`Apply to existing mail?` : t`Confirm filter changes?`}
        description={
          confirming && (
            <>
              {confirming.preview.unavailable?.length
                ? t`Preview unavailable. The filter will apply to future mail on the server.`
                : t`${plural(confirming.preview.matches.length, { one: "Preview: # message.", other: "Preview: # messages." })} Only the previewed messages will be changed when applying to existing mail.`}
              {confirming.preview.truncated && (
                <span className="mt-2 block">
                  {rules?.preview === "cache"
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
