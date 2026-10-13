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
import { buttonPrimary, buttonSecondary, formInput, settingsGroup } from "../../ui/styles";

const ICONS = ["💼", "🏠", "🏭", "🧪", "🎓", "✈️", "💰", "⭐"];

/** A field's label, above the field. */
const fieldLabel = "mb-1.5 text-footnote font-medium text-a11y-muted";
/** A borderless destructive action on the leading edge of the button row. */
const quietDanger =
  "inline-flex h-7 items-center rounded-control px-3 font-medium text-a11y-danger outline-offset-1 outline-a11y-focus transition-colors duration-100 hover:bg-fill-hover focus-visible:outline-[3px] active:bg-fill-pressed motion-reduce:transition-none";

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
        <h2 className="text-headline font-semibold">{title}</h2>

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
            className={`min-w-0 flex-1 ${formInput}`}
          />
        </div>

        <fieldset className="mt-5">
          <legend className={fieldLabel}>
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
                  className="flex size-8 items-center justify-center rounded-control text-title outline-offset-1 outline-a11y-focus transition-colors duration-100 hover:bg-fill-hover focus-visible:outline-2 data-checked:bg-fill-pressed motion-reduce:transition-none"
                >
                  {i}
                </Radio.Root>
              ))}
            </RadioGroup>
            <div className="ml-1 w-14 shrink-0">
              <input
                aria-label={t`Custom icon`}
                placeholder={t`Other`}
                onChange={(e) => {
                  const g = firstGrapheme(e.target.value);
                  if (g) setIcon(g);
                }}
                className={`text-center ${formInput}`}
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="mt-5">
          <legend className={fieldLabel}>
            <Trans>Color</Trans>
          </legend>
          <RadioGroup<ProfileColor>
            aria-label={t`Color`}
            value={color}
            onValueChange={setColor}
            className="flex gap-2.5 px-1 py-1"
          >
            {PROFILE_COLORS.map((c) => (
              <Radio.Root
                key={c}
                value={c}
                aria-label={c}
                className={`size-6 rounded-full ring-offset-2 ring-offset-raised outline-offset-[5px] outline-a11y-focus focus-visible:outline-2 data-checked:ring-2 data-checked:ring-neutral-900 dark:data-checked:ring-white ${PROFILE_BG[c]}`}
              />
            ))}
          </RadioGroup>
        </fieldset>

        <fieldset className="mt-5">
          <legend className={fieldLabel}>
            <Trans>Accounts</Trans>
          </legend>
          <div className={`max-h-48 overflow-y-auto ${settingsGroup}`}>
            {accounts.map((a) => {
              const elsewhere =
                a.profileId && a.profileId !== profile?.id ? profileName(a.profileId) : undefined;
              return (
                <label key={a.id} className="flex min-h-9 items-center gap-2.5 px-3 py-1.5">
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
                    <span className="shrink-0 text-footnote text-a11y-muted">
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
          <p role="alert" className="mt-3 text-a11y-danger">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center gap-2">
          {profile && (
            <button
              type="button"
              onClick={() => void deleteProfile(profile.id)}
              className={quietDanger}
            >
              <Trans>Delete space</Trans>
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={buttonSecondary}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" disabled={!name.trim() || save.waiting} className={buttonPrimary}>
            {profile ? <Trans>Save</Trans> : <Trans>Create</Trans>}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
