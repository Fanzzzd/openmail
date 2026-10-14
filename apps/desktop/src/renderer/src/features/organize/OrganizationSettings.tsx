import { accountName } from "../../lib/format";
import { categoryNames } from "../../i18n/organization-labels";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { inboxCategories, providerCapabilities, type LabelChange } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";
import type { Account, Label } from "../../../../shared/api";
import { resultError } from "../../lib/errors";
import { Keys } from "../../state/keys";
import {
  changeLabelAtom,
  setLabelPreferenceAtom,
  setOrganizationAtom,
} from "../../state/mutations";
import { labelsAtom, labelPreferencesAtom, organizationAtom } from "../../state/queries";
import { Alert, AlertCancel, alertDanger, Dialog } from "../../ui/Dialog";
import { Checkbox } from "../../ui/Checkbox";
import { Select } from "../../ui/Select";
import { LABEL_COLORS, labelColorName } from "./label-colors";

import { SettingsCheckRow, SettingsGroup, SettingsRow } from "../../ui/SettingsRows";
import {
  buttonLink,
  buttonPrimary,
  buttonSecondary,
  formInput,
  settingsGroup,
  settingsHint,
} from "../../ui/styles";

/** A text action in a label row. Callers add the color. */
const rowAction =
  "shrink-0 rounded-item font-medium outline-offset-1 outline-a11y-focus hover:underline focus-visible:outline-2";
/**
 * Label rows share columns with the header row above them: name, the two visibility choices (one
 * checkbox for local folders), favorite, color and the row actions. A narrow sheet wraps instead.
 */
const labelColumns = (serverStyle: boolean) =>
  serverStyle
    ? "sm:grid-cols-[minmax(6rem,1fr)_auto_auto_auto_auto_auto]"
    : "sm:grid-cols-[minmax(6rem,1fr)_auto_auto_auto_auto]";
const labelRow =
  "flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 sm:col-span-full sm:grid sm:grid-cols-subgrid";
const swatch = (color: string | null) => (
  <span
    aria-hidden
    className={`size-3 shrink-0 rounded-full ${color ? "" : "ring-1 ring-control ring-inset"}`}
    style={color ? { backgroundColor: color } : undefined}
  />
);
/** A field's label, above the field. */
const fieldLabel = "mb-1 block text-footnote font-medium text-a11y-muted";

export function OrganizationSettings({ accounts }: { accounts: readonly Account[] }) {
  accounts = accounts.filter((a) => a.enabled !== false);
  const { t, i18n } = useLingui();
  const accountSelectId = useId();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [editing, setEditing] = useState<Label | "new" | null>(null);
  const [deleting, setDeleting] = useState<Label | null>(null);
  const labels = AsyncResult.getOrElse(useAtomValue(labelsAtom([accountId])), () => []);
  const prefs = AsyncResult.getOrElse(useAtomValue(labelPreferencesAtom), () => []);
  const organization = AsyncResult.getOrElse(useAtomValue(organizationAtom), () => []);
  const setPref = useAtomSet(setLabelPreferenceAtom);
  const setOrg = useAtomSet(setOrganizationAtom);
  const [changed, change] = useAtom(changeLabelAtom, { mode: "promiseExit" });
  const account = accounts.find((a) => a.id === accountId);
  const categoryIds = account ? inboxCategories(account.provider) : [];
  const caps = account ? providerCapabilities(account.provider) : undefined;
  const names = categoryNames(t, caps?.inboxTabs === "focused");
  const perform = async (input: LabelChange) => {
    const exit = await change({
      payload: { accountId, change: input },
      reactivityKeys: [Keys.labels, Keys.organization, Keys.audit],
    });
    if (exit._tag === "Success") {
      setEditing(null);
      setDeleting(null);
    }
  };
  return (
    <section className="space-y-6">
      <SettingsGroup>
        <SettingsRow label={t`Account`} htmlFor={accountSelectId}>
          <Select
            id={accountSelectId}
            aria-label={t`Account`}
            variant="field"
            className="min-w-48"
            value={accountId}
            onValueChange={(id) => {
              setAccountId(id);
              setEditing(null);
              setDeleting(null);
            }}
            options={accounts.map((a) => ({ value: a.id, label: accountName(a) }))}
          />
        </SettingsRow>
      </SettingsGroup>
      {account && caps?.inboxTabs && (
        <SettingsGroup>
          <SettingsCheckRow>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={organization.find((o) => o.accountId === accountId)?.categories ?? true}
                onCheckedChange={(categories) =>
                  setOrg({
                    payload: {
                      input: {
                        accountId,
                        categories,
                        selectedCategories: organization.find((o) => o.accountId === accountId)
                          ?.selectedCategories ?? [...categoryIds],
                      },
                    },
                    reactivityKeys: [Keys.organization],
                  })
                }
              />
              <span>
                {caps.inboxTabs === "focused" ? t`Show Focused/Other` : t`Show Gmail categories`}
              </span>
            </label>
          </SettingsCheckRow>
          {organization.find((o) => o.accountId === accountId)?.categories !== false && (
            <fieldset className="space-y-1.5 px-3 pt-1 pb-2.5">
              <legend className="px-0 pt-2 text-footnote font-medium text-a11y-muted">{t`Visible categories`}</legend>
              {categoryIds.map((category) => {
                const selected = organization.find((o) => o.accountId === accountId)
                  ?.selectedCategories ?? [...categoryIds];
                return (
                  <label key={category} className="flex items-center gap-2">
                    <Checkbox
                      checked={selected.includes(category)}
                      onCheckedChange={(checked) =>
                        setOrg({
                          payload: {
                            input: {
                              accountId,
                              categories: true,
                              selectedCategories: checked
                                ? [...selected, category]
                                : selected.filter((c) => c !== category),
                            },
                          },
                          reactivityKeys: [Keys.organization],
                        })
                      }
                    />
                    <span>{names[category]}</span>
                  </label>
                );
              })}
            </fieldset>
          )}
        </SettingsGroup>
      )}
      <div>
        <ul
          className={`empty:hidden sm:grid ${labelColumns(caps?.serverLabelStyle === true)} ${settingsGroup}`}
        >
          {labels.length > 0 && (
            // Column headings for sighted readers; each control's accessible name says the same.
            <li
              aria-hidden
              className={`${labelRow} min-h-0 py-1 text-footnote font-medium text-a11y-muted max-sm:hidden`}
            >
              <span>{t({ message: "Name", context: "label settings column" })}</span>
              <span>{t({ message: "In sidebar", context: "label settings column" })}</span>
              {caps?.serverLabelStyle && (
                <span>{t({ message: "In message list", context: "label settings column" })}</span>
              )}
              <span />
              <span>{t({ message: "Color", context: "label settings column" })}</span>
              <span />
            </li>
          )}
          {labels.map((label) => {
            const pref = prefs.find((p) => p.accountId === accountId && p.id === label.id) ?? {
              accountId,
              id: label.id,
              visible: true,
              favorite: false,
              color: null,
            };
            const current = (pref.color ?? label.color ?? "none").toLowerCase();
            return (
              <li key={label.id} className={labelRow}>
                <span className="min-w-0 flex-1 truncate">{label.name}</span>
                {caps?.serverLabelStyle ? (
                  <>
                    <Select
                      aria-label={t({ message: "In sidebar", context: "label settings column" })}
                      value={label.labelListVisibility ?? "labelShow"}
                      options={[
                        { value: "labelShow", label: t`Show` },
                        { value: "labelShowIfUnread", label: t`Show if unread` },
                        { value: "labelHide", label: t`Hide` },
                      ]}
                      onValueChange={(labelListVisibility) => {
                        void perform({
                          kind: "visibility",
                          id: label.id,
                          labelListVisibility,
                          messageListVisibility: label.messageListVisibility ?? "show",
                        });
                      }}
                    />
                    <Select
                      aria-label={t({
                        message: "In message list",
                        context: "label settings column",
                      })}
                      value={label.messageListVisibility ?? "show"}
                      options={[
                        { value: "show", label: t`Show` },
                        { value: "hide", label: t`Hide` },
                      ]}
                      onValueChange={(messageListVisibility) => {
                        void perform({
                          kind: "visibility",
                          id: label.id,
                          labelListVisibility: label.labelListVisibility ?? "labelShow",
                          messageListVisibility,
                        });
                      }}
                    />
                  </>
                ) : (
                  <label className="flex items-center gap-1.5">
                    <Checkbox
                      checked={pref.visible}
                      onCheckedChange={(visible) =>
                        setPref({
                          payload: { input: { ...pref, visible } },
                          reactivityKeys: [Keys.organization],
                        })
                      }
                    />
                    <span>{t`Show`}</span>
                  </label>
                )}
                <label className="flex items-center gap-1.5">
                  <Checkbox
                    checked={pref.favorite}
                    onCheckedChange={(favorite) =>
                      setPref({
                        payload: { input: { ...pref, favorite } },
                        reactivityKeys: [Keys.organization],
                      })
                    }
                  />
                  <span>{t`Favorite`}</span>
                </label>
                <Select
                  aria-label={t({ message: "Color", context: "label settings column" })}
                  value={current}
                  options={[
                    { value: "none", label: t`Default`, icon: swatch(null) },
                    ...LABEL_COLORS.map((color) => ({
                      value: color.value,
                      label: i18n._(color.name),
                      icon: swatch(color.value),
                    })),
                    // A color set elsewhere, such as in Gmail, stays choosable and shows its swatch.
                    ...(current === "none" || LABEL_COLORS.some((color) => color.value === current)
                      ? []
                      : [
                          {
                            value: current,
                            label: i18n._(labelColorName(current)),
                            icon: swatch(current),
                          },
                        ]),
                  ]}
                  onValueChange={(color) => {
                    void perform({
                      kind: "color",
                      id: label.id,
                      color: color === "none" ? null : color,
                    });
                  }}
                />
                <span className="flex gap-3">
                  <button type="button" className={buttonLink} onClick={() => setEditing(label)}>
                    <Trans>Rename</Trans>
                  </button>
                  <button
                    type="button"
                    className={`${rowAction} text-a11y-danger`}
                    onClick={() => setDeleting(label)}
                  >
                    <Trans>Delete</Trans>
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
        <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-2 px-1">
          <div className="min-w-0 flex-1 basis-48 space-y-1">
            {account && !caps?.serverLabelStyle && (
              <p className={settingsHint}>
                <Trans>Folder colors are stored on this computer only.</Trans>
              </p>
            )}
            <p role="alert" className="text-a11y-danger">
              {resultError(i18n, changed)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEditing("new")}
            className={buttonSecondary}
            disabled={!accountId}
          >
            <Trans>New label or folder</Trans>
          </button>
        </div>
      </div>
      {editing && (
        <LabelEditor
          key={editing === "new" ? "new" : editing.id}
          label={editing}
          labels={labels}
          busy={changed.waiting}
          error={resultError(i18n, changed)}
          onClose={() => setEditing(null)}
          onSave={(input) => {
            void perform(input);
          }}
        />
      )}
      <Alert
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t`Delete label or folder?`}
        description={
          caps?.organization === "labels"
            ? t`Messages keep their other labels.`
            : t`Deleting a folder also deletes its messages on the server.`
        }
      >
        <AlertCancel>
          <Trans>Cancel</Trans>
        </AlertCancel>
        <button
          type="button"
          disabled={changed.waiting}
          className={alertDanger}
          onClick={() => {
            if (deleting) void perform({ kind: "delete", id: deleting.id });
          }}
        >
          <Trans>Delete</Trans>
        </button>
      </Alert>
    </section>
  );
}

export function LabelEditor({
  label,
  labels,
  busy,
  error,
  onSave,
  onClose,
}: {
  label: Label | "new";
  labels: readonly Label[];
  busy: boolean;
  error: string | null;
  onSave: (change: LabelChange) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const errorId = useId();
  const parentId = useId();
  const [name, setName] = useState(label === "new" ? "" : label.name);
  const [parent, setParent] = useState("");
  return (
    <Dialog aria-label={t`Label or folder`} onClose={onClose} className="w-96 p-5">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(
            label === "new"
              ? { kind: "create", name: name.trim(), ...(parent ? { parentId: parent } : {}) }
              : { kind: "rename", id: label.id, name: name.trim() },
          );
        }}
      >
        <label className="block">
          <span className={fieldLabel}>{t`Name`}</span>
          <input
            autoFocus
            aria-describedby={error ? errorId : undefined}
            className={formInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        {label === "new" && (
          <div>
            <label htmlFor={parentId} className={fieldLabel}>
              {t`Parent folder`}
            </label>
            <Select
              id={parentId}
              aria-label={t`Parent folder`}
              variant="field"
              value={parent}
              onValueChange={setParent}
              options={[
                { value: "", label: t`No parent` },
                ...labels.map((l) => ({ value: l.id, label: l.name })),
              ]}
            />
          </div>
        )}
        {error && (
          <p id={errorId} role="alert" className="text-a11y-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end pt-1">
          <button type="submit" className={buttonPrimary} disabled={busy || !name.trim()}>
            <Trans>Save</Trans>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
