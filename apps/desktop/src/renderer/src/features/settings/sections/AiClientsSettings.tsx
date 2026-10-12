import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentActivity } from "@openmail/core/schema";
import { Cause, Effect } from "effect";
import { AsyncResult, Reactivity } from "effect/reactivity";
import { Check, Copy, RefreshCw } from "lucide-react";
import { type ComponentType, useEffect, useId, useState } from "react";
import ClaudeIcon from "~icons/logos/claude-icon";
import CodexIcon from "~icons/logos/codex";
import CursorIcon from "~icons/logos/cursor-icon";
import ClaudeCodeIcon from "~icons/thesvg-color/claude-code";

import type { Account } from "../../../../../shared/api";
import {
  type AiClientChange,
  AiClientError,
  type AiClientId,
  type AiClientPreview,
  type AiClientView,
  type AiLaunchProblem,
  type DiffLine,
} from "../../../../../shared/ai-clients";
import { threadDate } from "../../../lib/format";
import { useRunMail, withMail } from "../../../state/mail";
import { aiClientsAtom } from "../../../state/queries";
import { aiSettingsAtom } from "../../ai";
import { Keys } from "../../../state/keys";
import { Checkbox } from "../../../ui/Checkbox";
import { Dialog } from "../../../ui/Dialog";
import { Disclosure } from "../../../ui/Disclosure";
import { SettingsGroup, SettingsRow } from "../../../ui/SettingsRows";
import {
  buttonLink,
  buttonPrimary,
  buttonSecondary,
  noticeRow,
  noticeTone,
  settingsGroup,
  settingsHeading,
  settingsHint,
} from "../../../ui/styles";

/** Anchors in the AI Access tab that the cards link to. */
export const CONSENT_ANCHOR = "ai-account-consent";
export const WRITE_MODE_ANCHOR = "ai-write-mode";

const CLIENTS: Record<AiClientId, { name: string; icon: ComponentType<{ className?: string }> }> = {
  "claude-code": { name: "Claude Code", icon: ClaudeCodeIcon },
  codex: { name: "Codex", icon: CodexIcon },
  "claude-desktop": { name: "Claude", icon: ClaudeIcon },
  cursor: { name: "Cursor", icon: CursorIcon },
};

/** Which card an MCP client's initialize name belongs to. */
export function activityClient(name: string): AiClientId | null {
  if (/^claude-code/i.test(name)) return "claude-code";
  if (/codex/i.test(name)) return "codex";
  if (/^claude(-ai| desktop)?$/i.test(name)) return "claude-desktop";
  if (/cursor/i.test(name)) return "cursor";
  return null;
}

/** Paths in the person's home read shorter as ~/… */
const homeShort = (path: string) => path.replace(/^\/Users\/[^/]+(?=\/)/, "~");

function scrollToAnchor(id: string) {
  const target = document.getElementById(id);
  target?.scrollIntoView({ block: "start", behavior: "smooth" });
  target?.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
}

const RELOAD_HINTS = {
  "claude-code": msg`Start a new Claude Code session to load it.`,
  codex: msg`Start a new Codex session to load it.`,
  "claude-desktop": msg`Quit and reopen Claude to load it.`,
  cursor: msg`Restart Cursor to load it.`,
} as const;

function clientErrorText(i18n: I18n, error: AiClientError): string {
  const detail = error.detail;
  switch (error.reason) {
    case "unreadable":
      return i18n._(
        msg`OpenMail can't read this config file, so it changes nothing. Fix the file, then try again. ${detail}`,
      );
    case "unsupportedLayout":
      return i18n._(
        msg`The openmail entry is written in a form OpenMail won't edit. Change it by hand. ${detail}`,
      );
    case "changed":
      return i18n._(msg`The file changed after the preview. Review the change again.`);
    case "cliFailed":
      return i18n._(msg`The app's command failed. Nothing else was changed. ${detail}`);
    case "notInstalled":
      return i18n._(msg`This app isn't installed.`);
    case "launchUnavailable":
      return i18n._(msg`OpenMail's MCP server can't start from here yet. See the note above.`);
    default:
      return i18n._(msg`Couldn't write the file. Nothing was changed. ${detail}`);
  }
}

const failureText = (i18n: I18n, cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  return error._tag === "Some" && error.value instanceof AiClientError
    ? clientErrorText(i18n, error.value)
    : i18n._(msg`Something went wrong. Try again.`);
};

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
  readable: readonly Account[];
}) {
  const names = readable.map((a) => a.email).join(", ");
  return (
    <SettingsGroup>
      <SettingsRow
        label={<Trans>Accounts AI apps can read</Trans>}
        hint={
          readable.length ? (
            <span className="break-all">{names}</span>
          ) : (
            <span className="text-orange-700 dark:text-orange-400">
              {accounts.length ? (
                <Trans>
                  No account allows AI reads, so a connected app sees no mail. Turn on "Allow
                  sending mail text to the model" for an account above.
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
          <Trans>
            Read and search mail, read only by default. To archive, label or draft, an app needs
            proposals turned on below and a permission to change mail other than Read only. You
            approve every change in OpenMail, and sending always needs your confirmation here.
          </Trans>
        }
      >
        <button
          type="button"
          className={buttonLink}
          onClick={() => scrollToAnchor(WRITE_MODE_ANCHOR)}
        >
          <Trans>Permission</Trans>
        </button>
      </SettingsRow>
    </SettingsGroup>
  );
}

function StateText({ client }: { client: AiClientView }) {
  if (!client.installed && client.state === "notConnected")
    return (
      <span className="text-a11y-muted">
        <Trans>Not installed</Trans>
      </span>
    );
  switch (client.state) {
    case "connected":
      return (
        <span className="text-green-700 dark:text-green-400">
          {client.proposalTools ? (
            <Trans>Connected, can propose changes</Trans>
          ) : (
            <Trans>Connected, read only</Trans>
          )}
        </span>
      );
    case "stale":
      return (
        <span className="text-orange-700 dark:text-orange-400">
          <Trans>Set up for a different OpenMail</Trans>
        </span>
      );
    case "unreadable":
      return (
        <span className="text-red-600 dark:text-red-400">
          <Trans>Config file can't be read</Trans>
        </span>
      );
    default:
      return (
        <span className="text-a11y-muted">
          <Trans>Not connected</Trans>
        </span>
      );
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      className={buttonSecondary}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
    </button>
  );
}

const codeBlock =
  "max-h-48 overflow-auto rounded-control bg-fill-quiet px-2.5 py-2 font-mono text-footnote whitespace-pre select-text";

function Activity({ rows }: { rows: readonly AgentActivity[] }) {
  const { i18n } = useLingui();
  return (
    <ul className="space-y-0.5">
      {rows.map((row, index) => (
        <li key={`${row.at}-${index}`} className="flex items-baseline gap-2 text-footnote">
          <span className="font-mono">{row.tool}</span>
          {!row.ok && (
            <span className="text-red-600 dark:text-red-400">
              <Trans>failed</Trans>
            </span>
          )}
          <span className="ml-auto shrink-0 text-a11y-muted tabular-nums">
            {threadDate(row.at, i18n)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ClientCard({
  client,
  activity,
  onChange,
}: {
  client: AiClientView;
  activity: readonly AgentActivity[];
  onChange: (change: AiClientChange) => void;
}) {
  const { t } = useLingui();
  const { name, icon: Icon } = CLIENTS[client.id];
  const command = client.entry
    ? [homeShort(client.entry.command), ...client.entry.args].join(" ")
    : "";
  const cliPath = homeShort(client.cliPath ?? "");
  const configPath = homeShort(client.configPath);
  const canEdit = client.method !== "manual" && client.state !== "unreadable";
  const change = (action: AiClientChange["action"], proposalTools = client.proposalTools) =>
    onChange({ client: client.id, action, proposalTools });
  return (
    <section aria-label={name} className={settingsGroup}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-white shadow-control ring-1 ring-edge"
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <p className="font-medium">{name}</p>
          <p className="text-footnote">
            <StateText client={client} />
          </p>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-2">
            {client.state === "notConnected" && client.installed && (
              <button
                type="button"
                className={buttonSecondary}
                aria-label={t`Connect ${name}`}
                onClick={() => change("connect", false)}
              >
                <Trans>Connect</Trans>
              </button>
            )}
            {client.state === "stale" && (
              <button
                type="button"
                className={buttonPrimary}
                aria-label={t`Reconnect ${name}`}
                onClick={() => change("connect")}
              >
                <Trans>Reconnect</Trans>
              </button>
            )}
            {client.state !== "notConnected" && (
              <button
                type="button"
                className={buttonSecondary}
                aria-label={t`Disconnect ${name}`}
                onClick={() => change("disconnect")}
              >
                <Trans>Disconnect</Trans>
              </button>
            )}
          </div>
        )}
      </div>
      <div className={`space-y-1.5 px-3 py-2.5 ${settingsHint}`}>
        {client.state === "stale" && command && (
          <p className="break-words">
            <Trans>
              It starts <span className="font-mono">{command}</span>. Reconnect to use this app.
            </Trans>
          </p>
        )}
        {client.state === "unreadable" && client.problem && (
          <p className="break-all text-red-600 dark:text-red-400">{client.problem}</p>
        )}
        {client.state === "connected" && (
          <p>
            {client.proposalTools ? (
              <Trans>
                It can propose archiving, labels, snoozes and drafts. Each waits for your approval.
              </Trans>
            ) : (
              <Trans>It can read and search allowed accounts. It can't change anything.</Trans>
            )}{" "}
            <button
              type="button"
              className={buttonLink}
              onClick={() => change("connect", !client.proposalTools)}
            >
              {client.proposalTools ? (
                <Trans>Make read only</Trans>
              ) : (
                <Trans>Allow proposals</Trans>
              )}
            </button>
          </p>
        )}
        <p className="break-words">
          {client.method === "cli" ? (
            <Trans>
              Connects with <span className="font-mono">{cliPath}</span> and writes{" "}
              <span className="font-mono">{configPath}</span>.
            </Trans>
          ) : client.method === "file" ? (
            <Trans>
              Edits <span className="font-mono">{configPath}</span>.
            </Trans>
          ) : (
            <Trans>OpenMail didn't find the claude command. Copy the command below instead.</Trans>
          )}
        </p>
        {activity.length > 0 ? (
          <div className="pt-1">
            <p className="mb-0.5 font-medium">
              <Trans>Recent tool calls</Trans>
            </p>
            <Activity rows={activity} />
          </div>
        ) : (
          client.state === "connected" && (
            <p>
              <Trans>No tool calls yet.</Trans>
            </p>
          )
        )}
      </div>
      <div className="px-3 py-2">
        <Disclosure summary={<Trans>Set up by hand</Trans>} summaryClassName="text-footnote">
          <div className="space-y-2">
            <pre className={codeBlock}>{client.manual}</pre>
            <CopyButton
              text={client.manual}
              label={
                client.id === "claude-code" || client.id === "codex"
                  ? t`Copy command for ${name}`
                  : t`Copy config for ${name}`
              }
            />
          </div>
        </Disclosure>
      </div>
    </section>
  );
}

const DIFF_TONE: Record<DiffLine["kind"], string> = {
  add: "bg-green-500/10 text-green-800 dark:text-green-300",
  remove: "bg-red-500/10 text-red-800 dark:text-red-300",
  context: "text-a11y-muted",
  gap: "text-a11y-muted",
};
const DIFF_MARK: Record<DiffLine["kind"], string> = {
  add: "+",
  remove: "-",
  context: " ",
  gap: "⋯",
};

/** Shows exactly what will change and runs it only on the person's click. */
function ConfirmChange({
  change,
  onClose,
  onDone,
}: {
  change: AiClientChange;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const name = CLIENTS[change.client].name;
  const [current, setCurrent] = useState(change);
  const [preview, setPreview] = useState<AiClientPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const proposalsId = useId();
  const load = (next: AiClientChange) => {
    setCurrent(next);
    setPreview(null);
    setError(null);
    run(
      withMail((call) => call("PreviewAiClientChange", { change: next })).pipe(
        Effect.matchCause({
          onSuccess: setPreview,
          onFailure: (cause) => setError(failureText(i18n, cause)),
        }),
      ),
    );
  };
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- one preview when the dialog opens
  useEffect(() => load(change), []);
  const apply = () => {
    if (!preview) return;
    setBusy(true);
    run(
      withMail((call) =>
        call("ApplyAiClientChange", { change: current, token: preview.token }),
      ).pipe(
        Reactivity.mutation([Keys.aiClients]),
        Effect.matchCause({
          onSuccess: onDone,
          onFailure: (cause) => {
            setBusy(false);
            setError(failureText(i18n, cause));
          },
        }),
      ),
    );
  };
  const connect = current.action === "connect";
  const title = connect ? t`Connect ${name}?` : t`Disconnect ${name}?`;
  return (
    <Dialog aria-label={title} onClose={onClose} className="w-[min(600px,calc(100vw-48px))]">
      <div className="space-y-3 p-5">
        <h2 className="text-headline font-semibold">{title}</h2>
        <p className={settingsHint}>
          {connect ? (
            <Trans>
              {name} will start OpenMail's MCP server and read the accounts you allowed. Mail goes
              to {name} and the model provider it uses.
            </Trans>
          ) : (
            <Trans>{name} will no longer start OpenMail's MCP server.</Trans>
          )}{" "}
          {i18n._(RELOAD_HINTS[current.client])}
        </p>
        {connect && (
          <div className="flex items-center gap-2">
            <Checkbox
              id={proposalsId}
              checked={current.proposalTools}
              disabled={busy}
              onCheckedChange={(proposalTools) => load({ ...current, proposalTools })}
            />
            <label htmlFor={proposalsId}>
              <Trans>Let {name} propose changes for you to approve</Trans>
            </label>
          </div>
        )}
        {preview && (
          <>
            {preview.commands.length > 0 && (
              <div className="space-y-1">
                <p className="font-medium">
                  <Trans>OpenMail runs</Trans>
                </p>
                <pre className={codeBlock}>
                  {preview.commands.map((argv) => argv.join(" ")).join("\n")}
                </pre>
              </div>
            )}
            <div className="space-y-1">
              <p className="font-medium break-all">
                {preview.commands.length ? (
                  <Trans>
                    Which changes <span className="font-mono font-normal">{preview.file}</span>:
                  </Trans>
                ) : (
                  <Trans>
                    Changes to <span className="font-mono font-normal">{preview.file}</span>:
                  </Trans>
                )}
              </p>
              <div
                aria-label={t`Changes`}
                className="max-h-64 overflow-auto rounded-control bg-fill-quiet py-1 font-mono text-footnote select-text"
              >
                {preview.diff.map((line, index) => (
                  <div key={index} className={`px-2.5 whitespace-pre ${DIFF_TONE[line.kind]}`}>
                    {DIFF_MARK[line.kind]} {line.text}
                  </div>
                ))}
              </div>
            </div>
            <p className={settingsHint}>
              {preview.backup ? (
                <Trans>
                  OpenMail saves a copy of the file next to it first, named .openmail-backup with
                  the date. Nothing else in the file changes.
                </Trans>
              ) : (
                <Trans>The file doesn't exist yet. OpenMail creates it.</Trans>
              )}
            </p>
          </>
        )}
        {!preview && !error && (
          <p className={settingsHint}>
            <Trans>Preparing the change…</Trans>
          </p>
        )}
        {error && (
          <p role="alert" className="text-footnote break-all text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={buttonSecondary} onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            className={buttonPrimary}
            disabled={!preview || busy}
            onClick={apply}
          >
            {connect ? <Trans>Connect</Trans> : <Trans>Disconnect</Trans>}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Settings → AI Access → AI apps: connect Claude Code, Codex, Claude and Cursor to OpenMail. */
export function AiClientsSettings({ accounts }: { accounts: readonly Account[] }) {
  const { t } = useLingui();
  const consent = AsyncResult.getOrElse(useAtomValue(aiSettingsAtom), () => null)?.accounts ?? [];
  const allowed = new Set(consent.filter((a) => a.allowed).map((a) => a.accountId));
  const view = AsyncResult.getOrElse(useAtomValue(aiClientsAtom), () => null);
  const refresh = useAtomRefresh(aiClientsAtom);
  const [pending, setPending] = useState<AiClientChange | null>(null);
  const [done, setDone] = useState<AiClientId | null>(null);
  const readable = accounts.filter((a) => a.enabled !== false && allowed.has(a.id));
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
