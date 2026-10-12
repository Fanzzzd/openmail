import { useAtom } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { PROFILE_COLORS } from "@openmail/core/schema";
import { Exit } from "effect";
import { useState } from "react";

import type { Account, Profile, ProfileColor } from "../../../../shared/api";
import { resultError } from "../../lib/errors";
import {
  accountName,
  accountColorClass,
  accountColorStyle,
  firstGrapheme,
  PROFILE_BG,
} from "../../lib/format";
import { Keys } from "../../state/keys";
import { deleteProfileAtom, saveProfileAtom } from "../../state/mutations";
import { Checkbox } from "../../ui/Checkbox";
import { Dialog } from "../../ui/Dialog";

const ICONS = ["💼", "🏠", "🏭", "🧪", "🎓", "✈️", "💰", "⭐"];

interface Props {
  /** Edit this profile; omit to create one. */
  profile?: Profile;
  accounts: readonly Account[];
  profiles: readonly Profile[];
  onClose: () => void;
  onSaved?: (profile: Profile) => void;
  onDeleted?: () => void;
}

/**
 * Create or edit a profile and pick its accounts. An account sits in at most
 * one profile, so checking it here moves it out of its current one.
 */
export function ProfileEditor({ profile, accounts, profiles, onClose, onSaved, onDeleted }: Props) {
  const { t, i18n } = useLingui();
  const [name, setName] = useState(profile?.name ?? "");
  const [icon, setIcon] = useState(profile?.icon ?? ICONS[0]!);
  const [color, setColor] = useState<ProfileColor>(profile?.color ?? "blue");
  const [members, setMembers] = useState(
    () => new Set(accounts.filter((a) => profile && a.profileId === profile.id).map((a) => a.id)),
  );

  const [save, runSave] = useAtom(saveProfileAtom, { mode: "promiseExit" });
  const [remove, runRemove] = useAtom(deleteProfileAtom, { mode: "promiseExit" });

  const submit = async () => {
    const input = { name: name.trim(), icon, color };
    const exit = await runSave({ profile, input, members, accounts });
    if (Exit.isSuccess(exit)) {
      onSaved?.(exit.value);
      onClose();
    }
  };

  const deleteProfile = async (id: string) => {
    const exit = await runRemove({
      payload: { id },
      reactivityKeys: [Keys.profiles, Keys.accounts],
    });
    if (Exit.isSuccess(exit)) {
      onDeleted?.();
      onClose();
    }
  };

  const error = resultError(i18n, save) ?? resultError(i18n, remove);
  const title = profile ? t`Edit space` : t`New space`;
  const profileName = (id: string | null) => profiles.find((p) => p.id === id)?.name;

  return (
    <Dialog aria-label={title} onClose={onClose} className="w-[400px]">
      <form
        className="p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void submit();
        }}
      >
        <h2 className="text-[15px] font-semibold">{title}</h2>

        <div className="mt-4 flex items-center gap-3">
          <span
            className={`flex size-10 shrink-0 items-center justify-center rounded-full text-[20px] ${PROFILE_BG[color]}`}
          >
            {icon}
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t`Name, like Work`}
            className="h-8 min-w-0 flex-1 rounded-md border border-black/10 bg-transparent px-2.5 text-[14px] outline-none focus:border-blue-500 dark:border-white/15"
          />
        </div>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[12px] text-a11y-muted">
            <Trans>Icon</Trans>
          </legend>
          <div className="flex items-center gap-1">
            <RadioGroup<string>
              aria-label={t`Icon`}
              value={icon}
              onValueChange={setIcon}
              className="flex items-center gap-1"
            >
              {ICONS.map((i) => (
                <Radio.Root
                  key={i}
                  value={i}
                  className="flex size-8 items-center justify-center rounded-md text-[17px] outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-a11y-focus data-checked:bg-black/10 dark:hover:bg-white/5 dark:data-checked:bg-white/15"
                >
                  {i}
                </Radio.Root>
              ))}
            </RadioGroup>
            <input
              aria-label={t`Custom icon`}
              placeholder={t`Other`}
              onChange={(e) => {
                const g = firstGrapheme(e.target.value);
                if (g) setIcon(g);
              }}
              className="ml-1 h-8 w-14 rounded-md border border-black/10 bg-transparent px-2 text-center outline-none dark:border-white/15"
            />
          </div>
        </fieldset>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[12px] text-a11y-muted">
            <Trans>Color</Trans>
          </legend>
          <RadioGroup<ProfileColor>
            aria-label={t`Color`}
            value={color}
            onValueChange={setColor}
            className="flex gap-2"
          >
            {PROFILE_COLORS.map((c) => (
              <Radio.Root
                key={c}
                value={c}
                aria-label={c}
                className={`size-6 rounded-full outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-a11y-focus data-checked:ring-2 data-checked:ring-neutral-400 dark:ring-offset-neutral-800 ${PROFILE_BG[c]}`}
              />
            ))}
          </RadioGroup>
        </fieldset>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[12px] text-a11y-muted">
            <Trans>Accounts</Trans>
          </legend>
          <div className="max-h-48 space-y-px overflow-y-auto">
            {accounts.map((a) => {
              const elsewhere =
                a.profileId && a.profileId !== profile?.id ? profileName(a.profileId) : undefined;
              return (
                <label
                  key={a.id}
                  className="flex h-8 items-center gap-2.5 rounded-md px-2 hover:bg-black/[0.04] dark:hover:bg-white/5"
                >
                  <Checkbox
                    checked={members.has(a.id)}
                    onCheckedChange={(checked) =>
                      setMembers((prev) => {
                        const next = new Set(prev);
                        if (checked) next.add(a.id);
                        else next.delete(a.id);
                        return next;
                      })
                    }
                  />
                  <span
                    className={`size-2 rounded-full ${accountColorClass(a)}`}
                    style={accountColorStyle(a)}
                  />
                  <span className="min-w-0 flex-1 truncate">{accountName(a)}</span>
                  {elsewhere && (
                    <span className="shrink-0 text-[12px] text-a11y-muted">
                      {members.has(a.id) ? (
                        <Trans>Moves from “{elsewhere}”</Trans>
                      ) : (
                        <Trans>In “{elsewhere}”</Trans>
                      )}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>

        {error && (
          <p role="alert" className="mt-3 text-[12px] text-a11y-danger">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center gap-2">
          {profile && (
            <button
              type="button"
              onClick={() => void deleteProfile(profile.id)}
              className="h-8 rounded-md px-3 text-a11y-danger hover:bg-red-500/10"
            >
              <Trans>Delete Space</Trans>
            </button>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md px-3 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            type="submit"
            disabled={!name.trim() || save.waiting}
            className="h-8 rounded-md bg-blue-600 px-4 font-medium text-white disabled:opacity-40"
          >
            {profile ? <Trans>Save</Trans> : <Trans>Create</Trans>}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
