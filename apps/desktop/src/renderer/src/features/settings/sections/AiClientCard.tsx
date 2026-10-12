import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentActivity } from "@openmail/core/schema";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { type AiClientChange, type AiClientView } from "../../../../../shared/ai-clients";
import { threadDate } from "../../../lib/format";
import { Disclosure } from "../../../ui/Disclosure";
import {
  buttonLink,
  buttonPrimary,
  buttonSecondary,
  settingsGroup,
  settingsHint,
} from "../../../ui/styles";

import { CLIENTS, PathText, codeBlock } from "./ai-clients-ui";

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
          <Trans>Points at another OpenMail copy</Trans>
        </span>
      );
    case "unreadable":
      return (
        <span className="text-a11y-danger">
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

function Activity({ rows }: { rows: readonly AgentActivity[] }) {
  const { i18n } = useLingui();
  return (
    <ul className="space-y-0.5">
      {rows.map((row, index) => (
        <li key={`${row.at}-${index}`} className="flex items-baseline gap-2 text-footnote">
          <span className="font-mono">{row.tool}</span>
          {!row.ok && (
            <span className="text-a11y-danger">
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

export function ClientCard({
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
  const entry = "entry" in client ? client.entry : null;
  const proposalTools = "proposalTools" in client && client.proposalTools;
  const cliPath = <PathText path={client.cliPath ?? ""} />;
  const configPath = <PathText path={client.configPath} />;
  const canEdit = client.method !== "manual" && client.state !== "unreadable";
  const change = (action: AiClientChange["action"], withProposals = proposalTools) =>
    onChange({ client: client.id, action, proposalTools: withProposals });
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
        {client.state === "stale" && entry && (
          <p className="break-words">
            <Trans>
              It starts{" "}
              <span>
                <PathText path={entry.command} />{" "}
                <span className="font-mono">{entry.args.join(" ")}</span>
              </span>
              . Reconnect to use this app.
            </Trans>
          </p>
        )}
        {client.state === "unreadable" && (
          <p className="break-words text-a11y-danger">{client.problem}</p>
        )}
        {client.state === "connected" && (
          <p>
            {proposalTools ? (
              <Trans>
                It can propose archiving, labels, snoozes and drafts. Each waits for your approval.
              </Trans>
            ) : (
              <Trans>It can read and search allowed accounts. It can't change anything.</Trans>
            )}{" "}
            <button
              type="button"
              className={buttonLink}
              onClick={() => change("connect", !proposalTools)}
            >
              {proposalTools ? <Trans>Make read only</Trans> : <Trans>Allow proposals</Trans>}
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
