import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { Account } from "../../../shared/api";
import { accountSettingsInput } from "../account-settings";
import { resultError } from "../errors";
import { MAIL_KEYS } from "../state/keys";
import { setAccountSettingsAtom } from "../state/mutations";
import { profilesAtom } from "../state/queries";
import { Checkbox } from "./ui/Checkbox";
import { Select } from "./ui/Select";

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
  return (
    <div className="flex w-full flex-wrap items-center gap-3 border-t border-black/5 pt-2 dark:border-white/5">
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
      <label className="flex items-center gap-2">
        <Trans>Display name</Trans>
        <input
          className="w-36 rounded border border-black/10 bg-transparent px-2 py-1 dark:border-white/15"
          value={description}
          maxLength={200}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2">
        <Checkbox checked={customColor} onCheckedChange={setCustomColor} />
        <Trans>Custom colour</Trans>
        {customColor && (
          <input
            aria-label={t`Account colour`}
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        )}
      </label>
      <button
        type="button"
        disabled={result.waiting}
        onClick={() =>
          saveSettings({ kind: "appearance", description, color: customColor ? color : null })
        }
        className="rounded px-2 py-1 text-a11y-accent disabled:opacity-40"
      >
        <Trans>Save</Trans>
      </button>
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
        className="rounded px-2 py-1 disabled:opacity-40"
      >
        <Trans>Move up</Trans>
      </button>
      <button
        type="button"
        disabled={moving || !next}
        onClick={() => move(account.id, account.profileId, members[index + 2]?.id ?? null)}
        className="rounded px-2 py-1 disabled:opacity-40"
      >
        <Trans>Move down</Trans>
      </button>
      {resultError(i18n, result) && (
        <output role="alert" className="text-a11y-danger">
          {resultError(i18n, result)}
        </output>
      )}
    </div>
  );
}
