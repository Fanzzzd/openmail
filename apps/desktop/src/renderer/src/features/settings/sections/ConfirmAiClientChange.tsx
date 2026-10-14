import { Trans, useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { Reactivity } from "effect/reactivity";
import { useEffect, useId, useRef, useState } from "react";

import {
  type AiClientChange,
  type AiClientPreview,
  type DiffLine,
} from "../../../../../shared/ai-clients";
import { useRunMail, withMail } from "../../../state/mail";
import { Keys } from "../../../state/keys";
import { Checkbox } from "../../../ui/Checkbox";
import { Dialog } from "../../../ui/Dialog";
import { buttonPrimary, buttonSecondary, settingsHint } from "../../../ui/styles";

import { CLIENTS, PathText, RELOAD_HINTS, failureText, wrappedCode } from "./ai-clients-ui";

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
export function ConfirmChange({
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
  // Only the latest preview may land: the diff must match the checkbox.
  const request = useRef(0);
  const load = (next: AiClientChange) => {
    const id = ++request.current;
    setCurrent(next);
    setPreview(null);
    setError(null);
    run(
      withMail((call) => call("PreviewAiClientChange", { change: next })).pipe(
        Effect.matchCause({
          onSuccess: (value) => {
            if (id === request.current) setPreview(value);
          },
          onFailure: (cause) => {
            if (id === request.current) setError(failureText(i18n, cause));
          },
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
    <Dialog nested aria-label={title} onClose={onClose} className="w-[min(600px,calc(100vw-48px))]">
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
              <Trans>Let {name} make AI suggestions for you to approve</Trans>
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
                <pre className={wrappedCode}>
                  {preview.commands.map((argv) => argv.join(" ")).join("\n")}
                </pre>
              </div>
            )}
            <div className="space-y-1">
              <p className="font-medium break-words">
                {preview.commands.length ? (
                  <Trans>
                    Which changes <PathText path={preview.file} />:
                  </Trans>
                ) : (
                  <Trans>
                    Changes to <PathText path={preview.file} />:
                  </Trans>
                )}
              </p>
              <div
                aria-label={t`Changes`}
                className="max-h-64 overflow-y-auto rounded-control bg-fill-quiet py-1 font-mono text-footnote select-text"
              >
                {preview.diff.map((line, index) => (
                  <div
                    key={index}
                    className={`grid grid-cols-[1.5ch_minmax(0,1fr)] gap-x-1.5 px-2.5 ${DIFF_TONE[line.kind]}`}
                  >
                    <span aria-hidden className="select-none">
                      {DIFF_MARK[line.kind]}
                    </span>
                    <span className="break-all whitespace-pre-wrap">{line.text}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className={settingsHint}>
              {preview.commands.length ? (
                <Trans>
                  {name} makes this change with its own command, and only the openmail entry
                  changes. If adding the new entry fails, OpenMail puts the old one back.
                </Trans>
              ) : preview.backup ? (
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
          <p role="alert" className="text-footnote break-words text-a11y-danger">
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
