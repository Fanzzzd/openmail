import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Select } from "../../../ui/Select";
import { AI_MODELS } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { Effect } from "effect";
import { useId, useRef, useState } from "react";
import type { Account } from "../../../../../shared/api";
import { MailClient, submitAiKey } from "../../../state/rpc";
import { errorText, resultError } from "../../../lib/errors";
import { Keys } from "../../../state/keys";
import { SettingsCheckRow, SettingsRow } from "../../../ui/SettingsRows";
import {
  buttonSecondary,
  formInput,
  settingsGroup,
  settingsHeading,
  settingsHint,
} from "../../../ui/styles";

/** A native checkbox in the accent colour; the fieldset around it can still disable it. */
const nativeCheck = "size-3.5 shrink-0 accent-blue-600";

import { aiSettingsAtom } from "../../ai";
import { CONSENT_ANCHOR } from "./ai-clients-ui";
const accountMutation = MailClient.mutation("SetAiAccount");
const modelMutation = MailClient.mutation("SetAiModel");

export function AiSettings({ accounts }: { accounts: readonly Account[] }) {
  const { t, i18n } = useLingui();
  const modelId = useId();
  const settings = AsyncResult.getOrElse(useAtomValue(aiSettingsAtom), () => null);
  // Uncontrolled input: the key is never put in React state, atoms or preferences.
  const keyInput = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [accountResult, setAccount] = useAtom(accountMutation);
  const [modelResult, setModel] = useAtom(modelMutation);
  const save = (remove: boolean) => {
    const value = remove ? "" : (keyInput.current?.value ?? "");
    if (keyInput.current) keyInput.current.value = "";
    setSaving(true);
    setKeyError(null);
    Effect.runFork(
      submitAiKey(value).pipe(
        Effect.catch((error) => Effect.sync(() => setKeyError(errorText(i18n, error)))),
        Effect.catchCause(() =>
          Effect.sync(() => setKeyError(t`Couldn't save the API key in the system keychain.`)),
        ),
        Effect.ensuring(Effect.sync(() => setSaving(false))),
      ),
    );
  };
  return (
    <>
      <section>
        <h3 className={settingsHeading}>
          <Trans>Built-in AI</Trans>
        </h3>
        <p className={`mb-2 px-1 ${settingsHint}`}>
          <Trans>
            When you allow an account, questions and selected mail text, subjects, sender and
            recipient addresses are sent to Anthropic using your API key. Images, attachments and
            media stay on this device. Requests may incur API charges. Automatic summaries run only
            when you enable them for an account.
          </Trans>
        </p>
        <div className={settingsGroup}>
          <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
            <label className="flex min-w-0 flex-1 basis-72 items-center gap-3">
              <span className="shrink-0">
                <Trans>Anthropic API key</Trans>
              </span>
              <input
                ref={keyInput}
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label={t`Anthropic API key`}
                placeholder={settings?.keyConfigured ? "••••••••" : ""}
                className={`min-w-0 flex-1 ${formInput}`}
              />
            </label>
            <button
              type="button"
              disabled={saving}
              onClick={() => save(false)}
              className={buttonSecondary}
            >
              <Trans>Save key</Trans>
            </button>
            <button
              type="button"
              disabled={!settings?.keyConfigured || saving}
              onClick={() => save(true)}
              className={buttonSecondary}
            >
              <Trans>Remove key</Trans>
            </button>
          </div>
          <SettingsRow label={<Trans>Model</Trans>} htmlFor={modelId}>
            <Select
              id={modelId}
              aria-label={t`Model`}
              variant="field"
              className="min-w-48"
              value={settings?.model ?? AI_MODELS[0]}
              disabled={modelResult.waiting}
              options={AI_MODELS.map((name) => ({ value: name, label: name }))}
              onValueChange={(model) => setModel({ payload: { model }, reactivityKeys: [Keys.ai] })}
            />
          </SettingsRow>
        </div>
        {keyError && (
          <p role="alert" className="mt-1.5 px-1 text-footnote text-a11y-danger">
            {keyError}
          </p>
        )}
        {settings?.keyUnreadable && (
          <p role="alert" className="mt-1.5 px-1 text-footnote text-a11y-danger">
            <Trans>
              OpenMail couldn't read the API key from the keychain. Unlock the keychain, then open
              Settings again.
            </Trans>
          </p>
        )}
      </section>
      <div id={CONSENT_ANCHOR} className="scroll-mt-4 space-y-6">
        {accounts.map((account) => {
          const current = settings?.accounts.find((a) => a.accountId === account.id) ?? {
            accountId: account.id,
            allowed: false,
            autoSummaries: false,
            autoTriage: false,
          };
          return (
            <fieldset
              key={account.id}
              disabled={!settings || accountResult.waiting}
              className="min-w-0"
            >
              <legend className={`truncate ${settingsHeading}`}>{account.email}</legend>
              <div className={settingsGroup}>
                <SettingsCheckRow
                  hint={
                    <Trans>
                      Built-in AI sends this account's subjects, addresses and message text to
                      Anthropic with your API key. Connected AI apps can also read this account.
                    </Trans>
                  }
                >
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className={nativeCheck}
                      checked={current.allowed}
                      onChange={(event) =>
                        setAccount({
                          payload: {
                            input: {
                              ...current,
                              allowed: event.target.checked,
                              autoSummaries: event.target.checked && current.autoSummaries,
                              autoTriage: event.target.checked && current.autoTriage,
                            },
                          },
                          reactivityKeys: [Keys.ai],
                        })
                      }
                    />
                    <Trans>Allow AI to read this account</Trans>
                  </label>
                </SettingsCheckRow>
                <SettingsCheckRow>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className={nativeCheck}
                      disabled={!current.allowed}
                      checked={current.autoSummaries}
                      onChange={(event) =>
                        setAccount({
                          payload: { input: { ...current, autoSummaries: event.target.checked } },
                          reactivityKeys: [Keys.ai],
                        })
                      }
                    />
                    <Trans>Automatically summarize new mail</Trans>
                  </label>
                </SettingsCheckRow>
                <SettingsCheckRow>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className={nativeCheck}
                      disabled={!current.allowed}
                      checked={current.autoTriage ?? false}
                      onChange={(event) =>
                        setAccount({
                          payload: { input: { ...current, autoTriage: event.target.checked } },
                          reactivityKeys: [Keys.ai],
                        })
                      }
                    />
                    <Trans>Suggest triage for new inbox mail</Trans>
                  </label>
                </SettingsCheckRow>
              </div>
            </fieldset>
          );
        })}
      </div>
      <div className="space-y-1.5 px-1">
        <p className={settingsHint}>
          <Trans>
            MCP access follows each account's AI setting above. MCP cannot read an account that is
            not enabled.
          </Trans>
        </p>
        <p className={settingsHint}>
          <Trans>
            Triage runs while the app is in the foreground or on AC power. Suggestions require your
            approval. Reply needed adds a star when accepted.
          </Trans>
        </p>
        {resultError(i18n, accountResult) && (
          <p role="alert" className="text-footnote text-a11y-danger">
            {resultError(i18n, accountResult)}
          </p>
        )}
      </div>
    </>
  );
}
