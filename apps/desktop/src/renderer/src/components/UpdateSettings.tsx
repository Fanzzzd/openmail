import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { resultError } from "../errors";
import { Keys } from "../state/keys";
import { setUpdateTokenAtom } from "../state/mutations";
import { updateTokenConfiguredAtom } from "../state/queries";

export function UpdateSettings() {
  const { t, i18n } = useLingui();
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
        <Trans>Updates</Trans>
      </h2>
      <p className="text-neutral-500">
        <Trans>
          Signed builds use a GitHub access token to download private releases. The token is stored
          in your system keychain.
        </Trans>
      </p>
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
        <output className="text-red-500">{resultError(i18n, result)}</output>
      )}
    </section>
  );
}
