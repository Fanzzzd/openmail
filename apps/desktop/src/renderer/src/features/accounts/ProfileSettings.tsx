import { useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { AsyncResult, Reactivity } from "effect/reactivity";
import { useState } from "react";
import type { Account, Profile } from "../../../../shared/api";
import { prefsAtom, profilesAtom } from "../../state/queries";
import { Keys } from "../../state/keys";
import { useRunMail, withMail } from "../../state/mail";
import { ProfileEditor } from "./lazy";
import { Dialog } from "../../ui/Dialog";
import { Select } from "../../ui/Select";
import { SettingsGroup, SettingsRow } from "../../ui/SettingsRows";
import { buttonPrimary, buttonSecondary, settingsHint } from "../../ui/styles";

export function ProfileSwitcher({
  profiles,
  value,
  onChange,
}: {
  profiles: readonly Profile[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useLingui();
  if (!profiles.length) return null;
  return (
    <div className="drag flex h-9 shrink-0 items-center justify-end border-b border-edge px-4">
      <Select
        className="no-drag"
        aria-label={t`Space`}
        value={value}
        onValueChange={onChange}
        options={[
          { value: "overview", label: t`Overview` },
          { value: "all", label: t`All accounts` },
          ...profiles.map((p) => ({ value: p.id, label: `${p.icon} ${p.name}` })),
        ]}
      />
    </div>
  );
}
export function DefaultProfilesPrompt({
  accounts,
  profiles,
  busy,
}: {
  accounts: readonly Account[];
  profiles: readonly Profile[];
  busy: boolean;
}) {
  const { t } = useLingui();
  const run = useRunMail();
  const result = useAtomValue(prefsAtom);
  const prefs = AsyncResult.getOrElse(result, () => null);
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);
  if (
    !prefs ||
    prefs.defaultProfilesPrompted ||
    accounts.length < 2 ||
    profiles.length ||
    busy ||
    dismissed
  )
    return null;
  const choose = (accept: boolean) => {
    setSaving(true);
    run(
      withMail((call) =>
        call("InitializeProfiles", { accept, names: { personal: t`Personal`, work: t`Work` } }),
      ).pipe(
        Reactivity.mutation([Keys.prefs, Keys.profiles]),
        Effect.tap(() => Effect.sync(() => setDismissed(true))),
        Effect.ensuring(Effect.sync(() => setSaving(false))),
      ),
    );
  };
  return (
    <Dialog aria-label={t`Create spaces?`} className="w-[420px] p-5">
      <h2 className="text-headline font-semibold">
        <Trans>Create Personal and Work spaces?</Trans>
      </h2>
      <p className="mt-3 text-a11y-muted">
        <Trans>Spaces group accounts. You can assign accounts and edit spaces in Settings.</Trans>
      </p>
      <div className="mt-5 flex justify-end gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={() => choose(false)}
          className={buttonSecondary}
        >
          <Trans>Skip</Trans>
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => choose(true)}
          className={buttonPrimary}
        >
          <Trans>Create spaces</Trans>
        </button>
      </div>
    </Dialog>
  );
}
export function ProfileSettings({ accounts }: { accounts: readonly Account[] }) {
  const { t } = useLingui();
  const profiles = AsyncResult.getOrElse(useAtomValue(profilesAtom), () => []);
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  return (
    <>
      {/* The tab already shows "Spaces" as its title. */}
      <p className={`px-1 ${settingsHint}`}>
        <Trans>Group accounts into spaces and choose a space in the window toolbar.</Trans>
      </p>
      {profiles.length > 0 && (
        <SettingsGroup>
          {profiles.map((profile) => (
            <SettingsRow
              key={profile.id}
              label={
                <>
                  {profile.icon} {profile.name}
                </>
              }
              hint={accounts
                .filter((a) => a.profileId === profile.id)
                .map((a) => a.description || a.email)
                .join(", ")}
            >
              <button type="button" onClick={() => setEditing(profile)} className={buttonSecondary}>
                <Trans>Edit</Trans>
              </button>
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}
      <div>
        <button type="button" onClick={() => setEditing("new")} className={buttonSecondary}>
          {t`New space`}
        </button>
      </div>
      {editing && (
        <ProfileEditor
          {...(editing === "new" ? {} : { profile: editing })}
          accounts={accounts}
          profiles={profiles}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
