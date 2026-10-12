import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult, Reactivity } from "effect/reactivity";
import { DEFAULT_PREFS } from "@openmail/core/schema";
import { Keys } from "../../../state/keys";
import { useRunMail, withMail } from "../../../state/mail";
import { setAppleContactsAtom } from "../../../state/mutations";
import { appleContactsStatusAtom, prefsAtom } from "../../../state/queries";
import { Checkbox } from "../../../ui/Checkbox";
import { SettingsCheckRow, SettingsRow } from "../../../ui/SettingsRows";
import { buttonSecondary } from "../../../ui/styles";

/** Rows for a SettingsGroup: the Apple Contacts switch, its access state and actions. */
export function AppleContactsSettings() {
  const { t } = useLingui();
  const run = useRunMail();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const state =
    AsyncResult.getOrElse(useAtomValue(appleContactsStatusAtom), () => null)?.status ?? null;
  const [result, setEnabled] = useAtom(setAppleContactsAtom);
  if (state === "unsupported") return null;
  const denied = state === "denied" || state === "restricted";
  return (
    <>
      <SettingsCheckRow
        hint={<Trans>Apple Contacts stay on this device and are never sent to AI models.</Trans>}
      >
        <label className="flex items-center gap-2">
          <Checkbox
            checked={prefs.useAppleContacts}
            disabled={result.waiting || state === null}
            onCheckedChange={(enabled) =>
              setEnabled({ payload: { enabled }, reactivityKeys: [Keys.contacts, Keys.prefs] })
            }
          />
          <span>{t`Use Apple Contacts`}</span>
        </label>
      </SettingsCheckRow>
      {prefs.useAppleContacts && (
        <SettingsRow
          label={
            <span role={denied || state === "error" ? "alert" : "status"}>
              {state === "authorized"
                ? t`Contacts access allowed.`
                : state === "limited"
                  ? t`Only selected Apple Contacts are available.`
                  : state === "denied"
                    ? t`Contacts access denied. Allow access in System Settings.`
                    : state === "restricted"
                      ? t`Contacts access restricted by system policy.`
                      : state === "notDetermined"
                        ? t`Contacts access not granted. Turn this setting off and on to request access.`
                        : state === "waiting"
                          ? t`Waiting for Contacts permission. Respond to the system prompt.`
                          : state === "error"
                            ? t`Could not load Apple Contacts. Try refreshing.`
                            : null}
            </span>
          }
        >
          <button
            type="button"
            className={buttonSecondary}
            onClick={() => run(withMail((call) => call("OpenAppleContactsSettings", undefined)))}
          >
            <Trans>Open System Settings</Trans>
          </button>
          <button
            type="button"
            className={buttonSecondary}
            disabled={result.waiting}
            onClick={() =>
              run(
                withMail((call) => call("RefreshAppleContacts", undefined)).pipe(
                  Reactivity.mutation([Keys.contacts]),
                ),
              )
            }
          >
            <Trans>Refresh contacts</Trans>
          </button>
        </SettingsRow>
      )}
      {AsyncResult.isFailure(result) && (
        <p role="alert" className="px-3 py-2 text-a11y-danger">
          {t`Contacts operation failed.`}
        </p>
      )}
    </>
  );
}
