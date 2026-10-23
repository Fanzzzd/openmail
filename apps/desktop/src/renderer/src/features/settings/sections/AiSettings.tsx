import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Select } from "../../../ui/Select";
import {
  AI_MODELS,
  AI_SUMMARY_INPUT,
  AI_TRIAGE_INPUT,
  AUTO_SUMMARY_DAILY_CAP,
  AUTO_TRIAGE_DAILY_CAP,
  aiModelName,
  type AiModelName,
} from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { Effect } from "effect";
import { useId, useRef, useState } from "react";
import type { Account } from "../../../../../shared/api";
import { MailClient, removeAiKey, submitAiKey } from "../../../state/rpc";
import { errorText, resultError } from "../../../lib/errors";
import { Keys } from "../../../state/keys";
import { SettingsRow, SettingsSwitchRow } from "../../../ui/SettingsRows";
import {
  buttonSecondary,
  formInput,
  settingsGroup,
  settingsHeading,
  settingsHint,
} from "../../../ui/styles";

/** A native checkbox in the accent colour; the fieldset around it can still disable it. */
const summaryKb = AI_SUMMARY_INPUT / 1000;
const summaryCap = AUTO_SUMMARY_DAILY_CAP;
const triageKb = AI_TRIAGE_INPUT / 1000;
const triageCap = AUTO_TRIAGE_DAILY_CAP;

import { aiSettingsAtom } from "../../ai";
import { CONSENT_ANCHOR } from "./ai-clients-ui";
const accountMutation = MailClient.mutation("SetAiAccount");
const modelMutation = MailClient.mutation("SetAiModel");

export function AiSettings({ accounts }: { accounts: readonly Account[] }) {
  const { t, i18n } = useLingui();
  /** List prices per token, relative to Sonnet, the default. */
  const costNote: Record<AiModelName, string> = {
    "claude-sonnet-5-5": t`Default`,
    "claude-opus-5-5": t`About twice the cost`,
    "claude-haiku-5-5": t`About 1/20 of the cost`,
  };
  const modelId = useId();
  const settings = AsyncResult.getOrElse(useAtomValue(aiSettingsAtom), () => null);
  // Uncontrolled input: the key is never put in React state, atoms or preferences.
  const keyInput = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  // Only whether the field has text, so Save stays off for a blank key.
  const [keyTyped, setKeyTyped] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [accountResult, setAccount] = useAtom(accountMutation);
  const [modelResult, setModel] = useAtom(modelMutation);
  const save = (remove: boolean) => {
    const value = keyInput.current?.value ?? "";
    if (!remove && !value.trim()) return;
    if (keyInput.current) keyInput.current.value = "";
    setKeyTyped(false);
    setSaving(true);
    setKeyError(null);
    Effect.runFork(
      (remove ? removeAiKey() : submitAiKey(value)).pipe(
        Effect.catch((error) => Effect.sync(() => setKeyError(errorText(i18n, error)))),
        Effect.catchCause(() =>
          Effect.sync(() =>
            setKeyError(
              remove
                ? t`Couldn't remove the API key from the system keychain.`
                : t`Couldn't save the API key in the system keychain.`,
            ),
          ),
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
                onChange={(event) => setKeyTyped(event.currentTarget.value.trim() !== "")}
                placeholder={settings?.keyConfigured ? "••••••••" : ""}
                className={`min-w-0 flex-1 ${formInput}`}
              />
            </label>
            <button
              type="button"
              disabled={saving || !keyTyped}
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
              options={AI_MODELS.map((id) => ({
                value: id,
                label: `${aiModelName(id)} · ${costNote[id]}`,
              }))}
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
          const locked = !settings || accountResult.waiting;
          return (
            <fieldset key={account.id} className="min-w-0">
              <legend className={`truncate ${settingsHeading}`}>{account.email}</legend>
              <div className={settingsGroup}>
                <SettingsSwitchRow
                  label={<Trans>Allow AI to read this account</Trans>}
                  hint={
                    <Trans>
                      Built-in AI sends this account's subjects, addresses and message text to
                      Anthropic with your API key. Connected AI apps can also read this account.
                    </Trans>
                  }
                  disabled={locked}
                  checked={current.allowed}
                  onCheckedChange={(allowed) =>
                    setAccount({
                      payload: {
                        input: {
                          ...current,
                          allowed,
                          autoSummaries: allowed && current.autoSummaries,
                          autoTriage: allowed && current.autoTriage,
                        },
                      },
                      reactivityKeys: [Keys.ai],
                    })
                  }
                />
                <SettingsSwitchRow
                  label={<Trans>Automatically summarize new mail</Trans>}
                  hint={
                    <Trans>
                      Each automatic summary uses your Anthropic API key and sends up to {summaryKb}{" "}
                      KB of the conversation. At most {summaryCap} a day across all accounts.
                      Summaries that fail before any text arrives don't count.
                    </Trans>
                  }
                  disabled={locked || !current.allowed}
                  checked={current.autoSummaries}
                  onCheckedChange={(autoSummaries) =>
                    setAccount({
                      payload: { input: { ...current, autoSummaries } },
                      reactivityKeys: [Keys.ai],
                    })
                  }
                />
                <SettingsSwitchRow
                  label={<Trans>Suggest triage for new inbox mail</Trans>}
                  hint={
                    <Trans>
                      Each triage suggestion uses your Anthropic API key and sends up to {triageKb}{" "}
                      KB of the conversation. At most {triageCap} a day across all accounts.
                      Suggestions that fail before any text arrives don't count.
                    </Trans>
                  }
                  disabled={locked || !current.allowed}
                  checked={current.autoTriage ?? false}
                  onCheckedChange={(autoTriage) =>
                    setAccount({
                      payload: { input: { ...current, autoTriage } },
                      reactivityKeys: [Keys.ai],
                    })
                  }
                />
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
