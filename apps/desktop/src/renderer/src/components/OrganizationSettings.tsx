import { accountName } from "../format";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { LabelChange } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { Account, Label } from "../../../shared/api";
import { resultError } from "../errors";
import { Keys } from "../state/keys";
import { changeLabelAtom, setLabelPreferenceAtom, setOrganizationAtom } from "../state/mutations";
import { labelsAtom, labelPreferencesAtom, organizationAtom } from "../state/queries";
import { Alert, AlertCancel, alertDanger, Dialog } from "./ui/Dialog";
import { Checkbox } from "./ui/Checkbox";
import { Select } from "./ui/Select";

export const formInput =
  "w-full rounded-md border border-black/15 bg-transparent px-2 py-1.5 outline-blue-500 dark:border-white/15";
export const formButton = "rounded-md bg-blue-500 px-3 py-1.5 text-white disabled:opacity-50";

export function OrganizationSettings({ accounts }: { accounts: readonly Account[] }) {
  accounts = accounts.filter((a) => a.enabled !== false);
  const { t, i18n } = useLingui();
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
    <section className="space-y-4">
      <Select
        aria-label={t`Account`}
        value={accountId}
        onValueChange={(id) => {
          setAccountId(id);
          setEditing(null);
          setDeleting(null);
        }}
        options={accounts.map((a) => ({ value: a.id, label: accountName(a) }))}
      />
      {account?.provider === "gmail" && (
        <label className="flex items-center gap-2">
          <Checkbox
            checked={organization.find((o) => o.accountId === accountId)?.categories ?? true}
            onCheckedChange={(categories) =>
              setOrg({
                payload: { input: { accountId, categories } },
                reactivityKeys: [Keys.organization],
              })
            }
          />
          <span>{t`Show Gmail categories`}</span>
        </label>
      )}
      <button
        type="button"
        onClick={() => setEditing("new")}
        className={formButton}
        disabled={!accountId}
      >
        <Trans>New label or folder</Trans>
      </button>
      {account && account.provider !== "gmail" && (
        <p className="text-[12px] text-neutral-500">
          <Trans>Folder colors are stored on this computer only.</Trans>
        </p>
      )}
      <p role="alert" className="text-red-500">
        {resultError(i18n, changed)}
      </p>
      <ul className="space-y-3">
        {labels.map((label) => {
          const pref = prefs.find((p) => p.accountId === accountId && p.id === label.id) ?? {
            accountId,
            id: label.id,
            visible: true,
            favorite: false,
            color: null,
          };
          return (
            <li
              key={label.id}
              className="flex flex-wrap items-center gap-3 border-b border-black/5 pb-2 dark:border-white/10"
            >
              <span className="min-w-0 flex-1 truncate">{label.name}</span>
              {account?.provider === "gmail" ? (
                <>
                  <Select
                    aria-label={t`Label list visibility`}
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
                    aria-label={t`Message list visibility`}
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
                aria-label={t`Color`}
                value={pref.color ?? label.color ?? "none"}
                options={[
                  { value: "none", label: t`Default` },
                  ...["#4986e7", "#fb4c2f", "#fbe983", "#16a765", "#b99aff"].map((color) => ({
                    value: color,
                    label: color,
                    icon: (
                      <span className="size-3 rounded-full" style={{ backgroundColor: color }} />
                    ),
                  })),
                ]}
                onValueChange={(color) => {
                  void perform({
                    kind: "color",
                    id: label.id,
                    color: color === "none" ? null : color,
                  });
                }}
              />
              <button type="button" className="text-blue-500" onClick={() => setEditing(label)}>
                <Trans>Rename</Trans>
              </button>
              <button type="button" className="text-red-500" onClick={() => setDeleting(label)}>
                <Trans>Delete</Trans>
              </button>
            </li>
          );
        })}
      </ul>
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
          account?.provider === "gmail"
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
  const [name, setName] = useState(label === "new" ? "" : label.name);
  const [parent, setParent] = useState("");
  return (
    <Dialog aria-label={t`Label or folder`} onClose={onClose} className="w-96 p-5">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(
            label === "new"
              ? { kind: "create", name: name.trim(), ...(parent ? { parentId: parent } : {}) }
              : { kind: "rename", id: label.id, name: name.trim() },
          );
        }}
      >
        <label className="block space-y-1">
          <span>{t`Name`}</span>
          <input
            autoFocus
            className={formInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        {label === "new" && (
          <Select
            aria-label={t`Parent folder`}
            value={parent}
            onValueChange={setParent}
            options={[
              { value: "", label: t`No parent` },
              ...labels.map((l) => ({ value: l.id, label: l.name })),
            ]}
          />
        )}
        {error && (
          <p role="alert" className="text-red-500">
            {error}
          </p>
        )}
        <button type="submit" className={formButton} disabled={busy || !name.trim()}>
          <Trans>Save</Trans>
        </button>
      </form>
    </Dialog>
  );
}
