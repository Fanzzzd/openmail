import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { AI_MODELS } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { Effect } from "effect";
import { useRef, useState } from "react";
import type { Account } from "../../../shared/api";
import { MailClient, submitAiKey } from "../rpc";
import { errorText, resultError } from "../errors";
import { Keys } from "../state/keys";

import { aiSettingsAtom } from "../state/ai-settings";
export { aiSettingsAtom } from "../state/ai-settings";
const accountMutation = MailClient.mutation("SetAiAccount");
const modelMutation = MailClient.mutation("SetAiModel");

export function AiSettings({ accounts }: { accounts: readonly Account[] }) {
  const { t, i18n } = useLingui();
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
          Effect.sync(() => setKeyError(t`Could not save the API key in the system keychain.`)),
        ),
        Effect.ensuring(Effect.sync(() => setSaving(false))),
      ),
    );
  };
  return (
    <section className="mb-6 space-y-3">
      <h3 className="font-semibold">
        <Trans>Built-in AI</Trans>
      </h3>
      <p className="text-a11y-muted">
        <Trans>
          When you allow an account, questions and selected mail text, subjects, sender and
          recipient addresses are sent to Anthropic using your API key. Images, attachments and
          media stay on this device. Requests may incur API charges. Automatic summaries run only
          when you enable them for an account.
        </Trans>
      </p>
      <label className="block">
        <span>
          <Trans>Anthropic API key</Trans>
        </span>
        <input
          ref={keyInput}
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={t`Anthropic API key`}
          placeholder={settings?.keyConfigured ? "••••••••" : ""}
          className="ml-3 rounded border border-black/10 px-2 py-1 dark:border-white/10"
        />
      </label>
      <div className="flex gap-3">
        <button type="button" disabled={saving} onClick={() => save(false)}>
          <Trans>Save key</Trans>
        </button>
        <button
          type="button"
          disabled={!settings?.keyConfigured || saving}
          onClick={() => save(true)}
        >
          <Trans>Remove key</Trans>
        </button>
      </div>
      <p className="text-a11y-muted">
        <Trans>
          MCP access follows this account's AI consent. Disabled accounts cannot be read through
          MCP.
        </Trans>
      </p>
      <label className="block">
        <Trans>Model</Trans>{" "}
        <select
          aria-label={t`Model`}
          value={settings?.model ?? AI_MODELS[0]}
          disabled={modelResult.waiting}
          onChange={(event) => {
            const model = AI_MODELS.find((name) => name === event.target.value);
            if (model) setModel({ payload: { model }, reactivityKeys: [Keys.ai] });
          }}
          className="rounded border border-black/10 bg-transparent p-1 dark:border-white/10"
        >
          {AI_MODELS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
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
            className="space-y-2 border-t border-black/10 py-3 dark:border-white/10"
          >
            <legend>{account.email}</legend>
            <label className="flex gap-2">
              <input
                type="checkbox"
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
              <Trans>Allow sending mail text to the model</Trans>
            </label>
            <label className="flex gap-2">
              <input
                type="checkbox"
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
            <label className="flex gap-2">
              <input
                type="checkbox"
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
          </fieldset>
        );
      })}
      <p className="text-a11y-muted">
        <Trans>
          Triage runs while the app is in the foreground or on AC power. Suggestions require your
          approval. Reply needed adds a star when accepted.
        </Trans>
      </p>
      {resultError(i18n, accountResult) && <p role="alert">{resultError(i18n, accountResult)}</p>}
      {keyError && <p role="alert">{keyError}</p>}
    </section>
  );
}
