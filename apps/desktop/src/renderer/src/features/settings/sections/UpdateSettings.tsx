import { Button } from "@base-ui/react/button";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult, Reactivity } from "effect/reactivity";
import { useState } from "react";
import { Keys } from "../../../state/keys";
import { useRunMail, withMail } from "../../../state/mail";
import { Effect } from "effect";
import { Select } from "../../../ui/Select";
import { SettingsGroup, SettingsRow, SettingsSwitchRow } from "../../../ui/SettingsRows";
import { buttonPrimary, buttonSecondary } from "../../../ui/styles";
import { setPrefsAtom } from "../../../state/mutations";
import { prefsAtom, updateStateAtom } from "../../../state/queries";

export function UpdateSettings() {
  const { t } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const setPrefs = useAtomSet(setPrefsAtom);
  const run = useRunMail();
  const state = AsyncResult.getOrElse(useAtomValue(updateStateAtom), () => null);
  const [checking, setChecking] = useState(false);
  const check = (download: boolean) => {
    setChecking(true);
    run(
      withMail((call) => call("CheckForUpdates", { download })).pipe(
        Reactivity.mutation([Keys.cache]),
        Effect.ensuring(Effect.sync(() => setChecking(false))),
      ),
    );
  };
  const status =
    checking || state?.status === "checking" ? (
      <Trans>Checking for updates…</Trans>
    ) : state?.status === "disabled" ? (
      <Trans>Updates require a signed, installed macOS build.</Trans>
    ) : state?.status === "upToDate" ? (
      <Trans>You are up to date.</Trans>
    ) : state?.status === "error" ? (
      <Trans>Update check or download failed. Try again.</Trans>
    ) : state && "version" in state ? (
      state.status === "downloaded" ? (
        <Trans>Update {state.version} is ready. It will install when you quit.</Trans>
      ) : state.status === "downloading" ? (
        <Trans>Downloading update {state.version}…</Trans>
      ) : (
        <Trans>Update {state.version} is available.</Trans>
      )
    ) : null;
  return (
    <SettingsGroup title={<Trans>Software updates</Trans>}>
      <SettingsRow label={<output>{status}</output>}>
        <Button
          className={buttonSecondary}
          disabled={checking || state?.status === "checking" || state?.status === "downloading"}
          onClick={() => check(false)}
        >
          <Trans>Check for updates</Trans>
        </Button>
        {state?.status === "available" && (
          <Button className={buttonPrimary} disabled={checking} onClick={() => check(true)}>
            <Trans>Download update</Trans>
          </Button>
        )}
      </SettingsRow>
      <SettingsRow label={t`Update channel`}>
        <Select
          aria-label={t`Update channel`}
          variant="field"
          className="min-w-32"
          value={prefs?.updateChannel ?? "stable"}
          options={[
            { value: "stable", label: t`Stable` },
            { value: "latest", label: t`Latest` },
          ]}
          onValueChange={(updateChannel) =>
            setPrefs({ payload: { patch: { updateChannel } }, reactivityKeys: [Keys.prefs] })
          }
        />
      </SettingsRow>
      <SettingsSwitchRow
        label={<Trans>Automatically download updates</Trans>}
        hint={
          <Trans>Downloaded updates install when you quit, after pending drafts are checked.</Trans>
        }
        checked={prefs?.updateAutoDownload ?? true}
        onCheckedChange={(updateAutoDownload) =>
          setPrefs({ payload: { patch: { updateAutoDownload } }, reactivityKeys: [Keys.prefs] })
        }
      />
    </SettingsGroup>
  );
}
