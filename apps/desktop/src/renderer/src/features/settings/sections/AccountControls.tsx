import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { Account } from "../../../../../shared/api";
import { accountSettingsInput } from "./account-settings";
import { resultError } from "../../../lib/errors";
import { MAIL_KEYS } from "../../../state/keys";
import { setAccountSettingsAtom } from "../../../state/mutations";
import { profilesAtom } from "../../../state/queries";
import { Checkbox } from "../../../ui/Checkbox";
import { Select } from "../../../ui/Select";
import { buttonLink, formInput, settingsHint } from "../../../ui/styles";

/** A small borderless button for secondary actions inside an account row. */
const quietButton =
  "h-6 rounded-control px-1.5 outline-offset-1 outline-a11y-focus transition-colors duration-100 hover:bg-fill-hover focus-visible:outline-2 active:bg-fill-pressed disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none";

export function AccountControls({
  account,
  accounts,
  move,
  moving,
}: {
  account: Account;
  accounts: readonly Account[];
  moving: boolean;
  move: (id: string, profileId: string | null, beforeId: string | null) => void;
}) {
  const { t, i18n } = useLingui();
  const profiles = AsyncResult.getOrElse(useAtomValue(profilesAtom), () => []);
  const [description, setDescription] = useState(account.description ?? "");
  const [authservId, setAuthservId] = useState(account.imap?.authservId ?? "");
  const [color, setColor] = useState(account.color ?? "#3b82f6");
  const [customColor, setCustomColor] = useState(!!account.color);
  const [result, save] = useAtom(setAccountSettingsAtom(account.id));
  const members = accounts.filter((a) => a.profileId === account.profileId);
  const index = members.findIndex((a) => a.id === account.id);
  const previous = members[index - 1];
  const next = members[index + 1];
  const saveSettings = (change: Parameters<typeof accountSettingsInput>[1]) =>
    save({
      payload: {
        accountId: account.id,
        input: accountSettingsInput(account, change),
      },
      reactivityKeys: MAIL_KEYS,
    });
  const saveButton = (
    <button
      type="button"
      disabled={result.waiting}
      onClick={() =>
        saveSettings({
          kind: "appearance",
          description,
          color: customColor ? color : null,
          ...(account.imap ? { imapAuthservId: authservId.trim() || null } : {}),
        })
      }
      className={buttonLink}
    >
      <Trans>Save</Trans>
    </button>
  );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label htmlFor={`account-enabled-${account.id}`} className="flex items-center gap-2">
          <Checkbox
            id={`account-enabled-${account.id}`}
            checked={account.enabled !== false}
            onCheckedChange={(enabled) => {
              if (!result.waiting) saveSettings({ kind: "toggle", enabled });
            }}
          />
          <Trans>Account enabled</Trans>
        </label>
        <label className="flex h-6 items-center gap-2">
          <Checkbox checked={customColor} onCheckedChange={setCustomColor} />
          <Trans>Custom color</Trans>
          {customColor && (
            <input
              aria-label={t`Account color`}
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-5 w-7 cursor-default rounded-item"
            />
          )}
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-2">
          <Trans>Display name</Trans>
          <span className="w-40">
            <input
              className={formInput}
              value={description}
              maxLength={200}
              onChange={(e) => setDescription(e.target.value)}
            />
          </span>
        </label>
        {/* With an IMAP trust field, Save follows it so it comes after both fields in tab order. */}
        {!account.imap && saveButton}
      </div>
      {account.imap && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <label htmlFor={`imap-authserv-${account.id}`} className="flex items-center gap-2">
              <Trans>Trusted authentication service (optional)</Trans>
              <span className="w-40">
                <input
                  id={`imap-authserv-${account.id}`}
                  value={authservId}
                  maxLength={253}
                  onChange={(event) => setAuthservId(event.target.value)}
                  className={formInput}
                />
              </span>
            </label>
            {saveButton}
          </div>
          <p className={settingsHint}>
            <Trans>
              Leave blank unless your mail administrator provides a trusted authserv-id. The IMAP
              server name is not a trust setting.
            </Trans>
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Select
          disabled={moving}
          aria-label={t`Account space`}
          value={account.profileId ?? ""}
          options={[
            { value: "", label: t`Ungrouped accounts` },
            ...profiles.map((p) => ({ value: p.id, label: p.name })),
          ]}
          onValueChange={(id) => move(account.id, id || null, null)}
        />
        <button
          type="button"
          disabled={moving || !previous}
          onClick={() => previous && move(account.id, account.profileId, previous.id)}
          className={quietButton}
        >
          <Trans>Move up</Trans>
        </button>
        <button
          type="button"
          disabled={moving || !next}
          onClick={() => move(account.id, account.profileId, members[index + 2]?.id ?? null)}
          className={quietButton}
        >
          <Trans>Move down</Trans>
        </button>
      </div>
      {resultError(i18n, result) && (
        <output role="alert" className="block text-a11y-danger">
          {resultError(i18n, result)}
        </output>
      )}
    </div>
  );
}
