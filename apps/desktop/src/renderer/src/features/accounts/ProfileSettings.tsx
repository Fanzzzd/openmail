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
        aria-label={t`Profile`}
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
    <Dialog aria-label={t`Create profiles?`} className="w-[420px] p-5">
      <h2 className="font-semibold">
        <Trans>Create Personal and Work profiles?</Trans>
      </h2>
      <p className="mt-3 text-a11y-muted">
        <Trans>
          Profiles group accounts. You can assign accounts and edit profiles in Settings.
        </Trans>
      </p>
      <div className="mt-5 flex justify-end gap-3">
        <button type="button" disabled={saving} onClick={() => choose(false)}>
          <Trans>Skip</Trans>
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => choose(true)}
          className="rounded bg-blue-600 px-3 py-1 text-white"
        >
          <Trans>Create profiles</Trans>
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
    <section className="space-y-4">
      <h2 className="font-semibold">
        <Trans>Profiles</Trans>
      </h2>
      <p className="text-a11y-muted">
        <Trans>Group accounts and choose a profile in the window toolbar.</Trans>
      </p>
      {profiles.map((profile) => (
        <div key={profile.id} className="flex items-center gap-3">
          <span className="flex-1">
            {profile.icon} {profile.name}
          </span>
          <span className="text-a11y-muted">
            {accounts
              .filter((a) => a.profileId === profile.id)
              .map((a) => a.description || a.email)
              .join(", ")}
          </span>
          <button type="button" onClick={() => setEditing(profile)}>
            <Trans>Edit</Trans>
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setEditing("new")}
        className="rounded bg-blue-600 px-3 py-1 text-white"
      >{t`New profile`}</button>
      {editing && (
        <ProfileEditor
          {...(editing === "new" ? {} : { profile: editing })}
          accounts={accounts}
          profiles={profiles}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
