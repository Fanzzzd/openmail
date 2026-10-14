import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { Check, RefreshCw } from "lucide-react";
import { useState } from "react";

import type { Account } from "../../../../../shared/api";
import {
  type AiClientChange,
  type AiClientId,
  type AiClientView,
  type AiLaunchProblem,
} from "../../../../../shared/ai-clients";
import { aiClientsAtom } from "../../../state/queries";
import { aiSettingsAtom } from "../../ai";
import { Disclosure } from "../../../ui/Disclosure";
import { SettingsGroup, SettingsRow } from "../../../ui/SettingsRows";
import {
  buttonLink,
  buttonSecondary,
  noticeRow,
  noticeTone,
  settingsHeading,
  settingsHint,
} from "../../../ui/styles";

import {
  CONSENT_ANCHOR,
  RELOAD_HINTS,
  activityClient,
  readableAccounts,
  type ReadableAccounts,
  scrollToAnchor,
  WRITE_MODE_ANCHOR,
  WRITE_MODE_NAME,
  ASK_FIRST,
} from "./ai-clients-ui";
import { ClientCard } from "./AiClientCard";
import { ConfirmChange } from "./ConfirmAiClientChange";

function LaunchNotice({ problem }: { problem: AiLaunchProblem }) {
  return (
    <output className={`${noticeRow} ${noticeTone.warning}`}>
      {problem === "cliNotBuilt" ? (
        <Trans>
          This development build has no MCP server yet. Run pnpm build in the repository first.
        </Trans>
      ) : (
        <Trans>
          OpenMail is running from a disk image or the Downloads folder, so its path will change.
          Move it to Applications and open it again before you connect an AI app.
        </Trans>
      )}
    </output>
  );
}

/** Which accounts any connected AI app can read. Consent is per account, shared by every app. */
function AccessSummary({
  accounts,
  readable,
}: {
  accounts: readonly Account[];
  readable: ReadableAccounts;
}) {
  const { t, i18n } = useLingui();
  const allow = t`Allow AI to read this account`;
  const allowSuggestions = t`Allow AI suggestions`;
  const setting = i18n._(WRITE_MODE_NAME);
  const askFirst = i18n._(ASK_FIRST);
  return (
    <SettingsGroup>
      <SettingsRow
        label={<Trans>Accounts AI apps can read</Trans>}
        hint={
          readable.kind === "loading" ? null : readable.kind === "failed" ? (
            <span className="text-orange-700 dark:text-orange-400">
              <Trans>
                OpenMail couldn't load the AI settings, so it can't show which accounts AI apps can
                read. Close Settings and open it again.
              </Trans>
            </span>
          ) : readable.accounts.length ? (
            <span className="break-all">{readable.accounts.map((a) => a.email).join(", ")}</span>
          ) : (
            <span className="text-orange-700 dark:text-orange-400">
              {accounts.length ? (
                <Trans comment="allow is the translated per-account checkbox label in AI settings.">
                  No account allows AI reads, so a connected app sees no mail. Turn on “{allow}” for
                  an account above.
                </Trans>
              ) : (
                <Trans>Add a mail account first.</Trans>
              )}
            </span>
          )
        }
      >
        <button type="button" className={buttonLink} onClick={() => scrollToAnchor(CONSENT_ANCHOR)}>
          <Trans>Choose accounts</Trans>
        </button>
      </SettingsRow>
      <SettingsRow
        label={<Trans>What AI apps can do</Trans>}
        hint={
          <Trans comment="allowSuggestions is the translated Allow AI suggestions button on each app below; setting and askFirst are the translated Changes by AI apps setting and its Ask me first option.">
            Read and search mail, read only by default. To archive, label or draft, an app needs “
            {allowSuggestions}” below and “{setting}” set to “{askFirst}”. You approve every AI
            suggestion in OpenMail, and sending always needs your confirmation here.
          </Trans>
        }
      >
        <button
          type="button"
          className={buttonLink}
          onClick={() => scrollToAnchor(WRITE_MODE_ANCHOR)}
        >
          {setting}
        </button>
      </SettingsRow>
    </SettingsGroup>
  );
}

export function AiClientsSettings({ accounts }: { accounts: readonly Account[] }) {
  const { t } = useLingui();
  const readable = readableAccounts(useAtomValue(aiSettingsAtom), accounts);
  const view = AsyncResult.getOrElse(useAtomValue(aiClientsAtom), () => null);
  const refresh = useAtomRefresh(aiClientsAtom);
  const [pending, setPending] = useState<AiClientChange | null>(null);
  const [done, setDone] = useState<AiClientId | null>(null);
  const activityFor = (id: AiClientId) =>
    (view?.activity ?? []).filter((row) => activityClient(row.client) === id).slice(0, 4);
  const installed = (view?.clients ?? []).filter((c) => c.installed || c.state !== "notConnected");
  const missing = (view?.clients ?? []).filter((c) => !c.installed && c.state === "notConnected");
  const card = (client: AiClientView) => (
    <ClientCard
      key={client.id}
      client={client}
      activity={activityFor(client.id)}
      onChange={(change) => {
        setDone(null);
        setPending(change);
      }}
    />
  );
  return (
    <section className="space-y-3">
      <div>
        <h3 className={settingsHeading}>
          <Trans>AI apps</Trans>
        </h3>
        <p className={`px-1 ${settingsHint}`}>
          <Trans>
            Connect Claude Code, Codex and other AI apps to your mail through OpenMail's MCP server.
            OpenMail changes an app's settings only when you click Connect, after showing you the
            change.
          </Trans>
        </p>
      </div>
      <AccessSummary accounts={accounts} readable={readable} />
      {view?.launchProblem && <LaunchNotice problem={view.launchProblem} />}
      {done && (
        <output className={`${noticeRow} ${noticeTone.neutral}`}>
          <Check className="size-3.5 shrink-0" />
          <ReloadHint id={done} />
        </output>
      )}
      {installed.map(card)}
      {missing.length > 0 && (
        <Disclosure
          summary={
            <span className={settingsHint}>
              <Trans>Apps not found on this Mac</Trans>
            </span>
          }
        >
          <div className="space-y-3">{missing.map(card)}</div>
        </Disclosure>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          className={buttonSecondary}
          aria-label={t`Check AI apps again`}
          onClick={refresh}
        >
          <RefreshCw className="size-3.5" />
          <Trans>Refresh</Trans>
        </button>
      </div>
      {pending && (
        <ConfirmChange
          key={`${pending.client}-${pending.action}`}
          change={pending}
          onClose={() => setPending(null)}
          onDone={() => {
            setDone(pending.client);
            setPending(null);
          }}
        />
      )}
    </section>
  );
}

function ReloadHint({ id }: { id: AiClientId }) {
  const { i18n } = useLingui();
  return (
    <span>
      <Trans>Done.</Trans> {i18n._(RELOAD_HINTS[id])}
    </span>
  );
}
