import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { MailClient } from "../../../state/rpc";
import { prefsAtom } from "../../../state/queries";
import { setPrefsAtom } from "../../../state/mutations";
import { Keys } from "../../../state/keys";
import { Checkbox } from "../../../ui/Checkbox";
import { resultError } from "../../../lib/errors";
import { SettingsCheckRow, SettingsGroup } from "../../../ui/SettingsRows";

const languagesAtom = MailClient.query("SpellcheckLanguages", undefined);
export function SpellcheckSettings() {
  const { t, i18n } = useLingui();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const languages = AsyncResult.getOrElse(useAtomValue(languagesAtom), () => null);
  const [result, save] = useAtom(setPrefsAtom);
  return (
    <SettingsGroup title={<Trans>Spelling</Trans>}>
      <SettingsCheckRow
        hint={
          languages?.automatic ? (
            <Trans>macOS uses the system spellchecker and detects languages automatically.</Trans>
          ) : undefined
        }
      >
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
      </SettingsCheckRow>
      {!languages?.automatic && (
        <div className="px-3 py-2">
          <fieldset disabled={result.waiting} className="min-w-0">
            <legend className="mb-1.5">{t`Spelling languages`}</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-1.5">
              {languages?.languages.map((language) => (
                <label key={language} className="inline-flex items-center gap-2">
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
            </div>
          </fieldset>
        </div>
      )}
      {resultError(i18n, result) && (
        <output role="alert" className="block px-3 py-2 text-a11y-danger">
          {resultError(i18n, result)}
        </output>
      )}
    </SettingsGroup>
  );
}
