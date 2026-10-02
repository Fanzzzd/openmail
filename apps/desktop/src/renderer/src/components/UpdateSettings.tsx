import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult, Reactivity } from "effect/reactivity";
import { useState } from "react";
import { resultError } from "../errors";
import { Keys } from "../state/keys";
import { useRunMail, withMail } from "../state/mail";
import { Effect } from "effect";
import { Checkbox } from "./ui/Checkbox";
import { Select } from "./ui/Select";
import { setPrefsAtom, setUpdateTokenAtom } from "../state/mutations";
import { prefsAtom, updateTokenConfiguredAtom, updateStateAtom } from "../state/queries";

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
  return (
    <section className="mt-6 space-y-3 border-t border-black/10 pt-4 dark:border-white/10">
      <h2 className="font-semibold">
        <Trans>Software updates</Trans>
      </h2>
      <p className="text-a11y-muted">
        <Trans>
          Signed builds use a GitHub access token to download private releases. The token is stored
          in your system keychain.
        </Trans>
      </p>
      <label className="flex items-center gap-3">
        <span>{t`Update channel`}</span>
        <Select
          aria-label={t`Update channel`}
          value={prefs?.updateChannel ?? "stable"}
          options={[
            { value: "stable", label: t`Stable` },
            { value: "latest", label: t`Latest` },
          ]}
          onValueChange={(updateChannel) =>
            setPrefs({ payload: { patch: { updateChannel } }, reactivityKeys: [Keys.prefs] })
          }
        />
      </label>
      <label htmlFor="update-auto-download" className="flex items-center gap-3">
        <Checkbox
          id="update-auto-download"
          checked={prefs?.updateAutoDownload ?? true}
          onCheckedChange={(updateAutoDownload) =>
            setPrefs({ payload: { patch: { updateAutoDownload } }, reactivityKeys: [Keys.prefs] })
          }
        />
        <Trans>Automatically download updates</Trans>
      </label>
      <p className="text-a11y-muted">
        <Trans>Downloaded updates install when you quit, after pending drafts are checked.</Trans>
      </p>
      <output>
        {checking || state?.status === "checking" ? (
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
        ) : null}
      </output>
      <div className="flex gap-3">
        <Button
          disabled={checking || state?.status === "checking" || state?.status === "downloading"}
          onClick={() => check(false)}
        >
          <Trans>Check for updates</Trans>
        </Button>
        {state?.status === "available" && (
          <Button disabled={checking} onClick={() => check(true)}>
            <Trans>Download update</Trans>
          </Button>
        )}
      </div>
      <output>
        {configured ? <Trans>Access token saved</Trans> : <Trans>No access token saved</Trans>}
      </output>
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="off"
          value={token}
          onValueChange={setToken}
          aria-label={t`GitHub access token`}
          placeholder={t`GitHub access token`}
          className="min-w-0 flex-1 rounded border border-black/10 px-2 py-1 dark:border-white/10"
        />
        <Button
          disabled={!token.trim() || result.waiting}
          onClick={() => submit(token)}
          className="rounded px-2 py-1 hover:bg-black/5 dark:hover:bg-white/5"
        >
          <Trans>Save token</Trans>
        </Button>
        <Button
          disabled={!configured || result.waiting}
          onClick={() => submit("")}
          className="rounded px-2 py-1 hover:bg-black/5 dark:hover:bg-white/5"
        >
          <Trans>Remove token</Trans>
        </Button>
      </div>
      {resultError(i18n, result) && (
        <output role="alert" className="text-a11y-danger">
          {resultError(i18n, result)}
        </output>
      )}
    </section>
  );
}
