import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { MailClient } from "../rpc";
import { prefsAtom } from "../state/queries";
import { setPrefsAtom } from "../state/mutations";
import { Keys } from "../state/keys";
import { Checkbox } from "./ui/Checkbox";
import { resultError } from "../errors";

const languagesAtom = MailClient.query("SpellcheckLanguages", undefined);
export function SpellcheckSettings() {
  const { t, i18n } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const languages = AsyncResult.getOrElse(useAtomValue(languagesAtom), () => null);
  const [result, save] = useAtom(setPrefsAtom);
  return (
    <section className="mt-6 space-y-3 border-t border-black/10 pt-4 dark:border-white/10">
      <h2 className="font-semibold">
        <Trans>Spelling</Trans>
      </h2>
      <label htmlFor="compose-spellcheck" className="flex items-center gap-2">
        <Checkbox
          id="compose-spellcheck"
          checked={prefs.spellcheck}
          onCheckedChange={(spellcheck) =>
            save({ payload: { patch: { spellcheck } }, reactivityKeys: [Keys.prefs] })
          }
        />
        <Trans>Check spelling while typing</Trans>
      </label>
      {languages?.automatic ? (
        <p className="text-neutral-500">
          <Trans>macOS uses the system spellchecker and detects languages automatically.</Trans>
        </p>
      ) : (
        <fieldset disabled={result.waiting}>
          <legend>{t`Spelling languages`}</legend>
          {languages?.languages.map((language) => (
            <label key={language} className="inline-flex items-center gap-2 p-2">
              <Checkbox
                checked={prefs.spellcheckLanguages.includes(language)}
                onCheckedChange={(checked) =>
                  save({
                    payload: {
                      patch: {
                        spellcheckLanguages: checked
                          ? [...prefs.spellcheckLanguages, language]
                          : prefs.spellcheckLanguages.filter((l) => l !== language),
                      },
                    },
                    reactivityKeys: [Keys.prefs],
                  })
                }
              />
              {language}
            </label>
          ))}
        </fieldset>
      )}
      {resultError(i18n, result) && (
        <output className="text-red-500">{resultError(i18n, result)}</output>
      )}
    </section>
  );
}
