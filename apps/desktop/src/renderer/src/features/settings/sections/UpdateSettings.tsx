import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult, Reactivity } from "effect/reactivity";
import { useState } from "react";
import { resultError } from "../../../lib/errors";
import { Keys } from "../../../state/keys";
import { useRunMail, withMail } from "../../../state/mail";
import { Effect } from "effect";
import { Checkbox } from "../../../ui/Checkbox";
import { Select } from "../../../ui/Select";
import { SettingsCheckRow, SettingsGroup, SettingsRow } from "../../../ui/SettingsRows";
import { buttonPrimary, buttonSecondary, formInput } from "../../../ui/styles";
import { setPrefsAtom, setUpdateTokenAtom } from "../../../state/mutations";
import { prefsAtom, updateTokenConfiguredAtom, updateStateAtom } from "../../../state/queries";

export function UpdateSettings() {
  const { t, i18n } = useLingui();
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
  const configured = AsyncResult.getOrElse(useAtomValue(updateTokenConfiguredAtom), () => false);
  const [token, setToken] = useState("");
  const [result, save] = useAtom(setUpdateTokenAtom, { mode: "promiseExit" });
  const submit = async (value: string) => {
    const exit = await save({ payload: { token: value }, reactivityKeys: [Keys.cache] });
    if (exit._tag === "Success") setToken("");
  };
  const status =
    checking || state?.status === "checking" ? (
      <Trans>Checking for updates…</Trans>
    ) : state?.status === "disabled" ? (
      <Trans>Updates require a signed macOS build and a saved access token.</Trans>
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
    <SettingsGroup
      title={<Trans>Software updates</Trans>}
      footer={
        <Trans>
          Signed builds use a GitHub access token to download private releases. The token is stored
          in your system keychain.
        </Trans>
      }
    >
      <SettingsRow label={<output>{status}</output>}>
        {state?.status === "available" && (
          <Button className={buttonPrimary} disabled={checking} onClick={() => check(true)}>
            <Trans>Download update</Trans>
          </Button>
        )}
        <Button
          className={buttonSecondary}
          disabled={checking || state?.status === "checking" || state?.status === "downloading"}
          onClick={() => check(false)}
        >
          <Trans>Check for updates</Trans>
        </Button>
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
      <SettingsCheckRow
        hint={
          <Trans>Downloaded updates install when you quit, after pending drafts are checked.</Trans>
        }
      >
        <label htmlFor="update-auto-download" className="flex items-center gap-2">
          <Checkbox
            id="update-auto-download"
            checked={prefs?.updateAutoDownload ?? true}
            onCheckedChange={(updateAutoDownload) =>
              setPrefs({ payload: { patch: { updateAutoDownload } }, reactivityKeys: [Keys.prefs] })
            }
          />
          <Trans>Automatically download updates</Trans>
        </label>
      </SettingsCheckRow>
      <div className="space-y-2 px-3 py-2.5">
        <output className="block">
          {configured ? <Trans>Access token saved</Trans> : <Trans>No access token saved</Trans>}
        </output>
        <div className="flex flex-wrap gap-2">
          <Input
            type="password"
            autoComplete="off"
            value={token}
            onValueChange={setToken}
            aria-label={t`GitHub access token`}
            placeholder={t`GitHub access token`}
            className={`min-w-40 flex-1 basis-48 ${formInput}`}
          />
          <Button
            className={buttonSecondary}
            disabled={!token.trim() || result.waiting}
            onClick={() => submit(token)}
          >
            <Trans>Save token</Trans>
          </Button>
          <Button
            className={buttonSecondary}
            disabled={!configured || result.waiting}
            onClick={() => submit("")}
          >
            <Trans>Remove token</Trans>
          </Button>
        </div>
        {resultError(i18n, result) && (
          <output role="alert" className="block text-a11y-danger">
            {resultError(i18n, result)}
          </output>
        )}
      </div>
    </SettingsGroup>
  );
}
