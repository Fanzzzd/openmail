import { Trans, useLingui } from "@lingui/react/macro";
import { Disclosure } from "./ui/Disclosure";
import { redactSyncHealth, type HealthVerdict, type SyncHealth } from "@openmail/core/schema";
import { Effect } from "effect";
import { useState } from "react";
import { useRunMail, withMail } from "../state/mail";

const button =
  "rounded-md border border-black/10 px-2.5 py-1 text-a11y-accent disabled:opacity-50 dark:border-white/15";
export function SyncHealthCheck({ accountId }: { accountId: string }) {
  const { t } = useLingui();
  const run = useRunMail();
  const [report, setReport] = useState<SyncHealth | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const verdicts: Record<HealthVerdict, string> = {
    "in sync": t`In sync`,
    "local has fewer — window": t`Local has fewer: sync window`,
    "local has fewer — missing": t`Local has fewer: missing`,
    "local has more — stale": t`Local has more: stale`,
    "server unavailable": t`Server unavailable`,
  };
  const check = () => {
    setWaiting(true);
    setFailed(false);
    setCopied(false);
    run(
      withMail((call) => call("SyncHealth", { accountId })).pipe(
        Effect.matchCause({
          onSuccess: (value) => {
            setReport(value);
            setWaiting(false);
          },
          onFailure: () => {
            setFailed(true);
            setWaiting(false);
          },
        }),
      ),
    );
  };
  const copy = () => {
    if (!report) return;
    void navigator.clipboard.writeText(JSON.stringify(redactSyncHealth(report), null, 2)).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  const days = (value: number | null) => (value === null ? t`All mail` : t`${value} days`);
  const age =
    report?.cursorAgeMs == null
      ? t`Never synced`
      : t`${Math.floor(report.cursorAgeMs / 1000)} seconds`;
  return (
    <section className="w-full space-y-2" aria-label={t`Sync health`}>
      <button type="button" onClick={check} disabled={waiting} className={button}>
        {waiting ? t`Checking sync health…` : t`Check sync health`}
      </button>
      {failed && <p role="alert">{t`Could not check sync health.`}</p>}
      {report && (
        <>
          <p>
            <Trans>
              Cursor age: {age}. Pending operations: {report.pendingOps}.
            </Trans>
          </p>
          <p className="text-a11y-muted">
            <Trans>
              Counts compare messages. Matching counts do not verify message contents. Cache windows
              retain message text; headers remain cached.
            </Trans>
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">
                <Trans>Sync health</Trans>
              </caption>
              <thead>
                <tr>
                  <th scope="col">
                    <Trans>Folder or label</Trans>
                  </th>
                  <th scope="col">
                    <Trans>Server total / unread / threads</Trans>
                  </th>
                  <th scope="col">
                    <Trans>Local total / unread / threads</Trans>
                  </th>
                  <th scope="col">
                    <Trans
                      context="cached message text"
                      comment="Retention window for downloaded email message text, not headers."
                    >
                      Message text cache window
                    </Trans>
                  </th>
                  <th scope="col">
                    <Trans>Sync window</Trans>
                  </th>
                  <th scope="col">
                    <Trans>Pending operations</Trans>
                  </th>
                  <th scope="col">
                    <Trans>Verdict</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.folders.map((folder) => (
                  <tr key={folder.scope}>
                    <th scope="row" className="max-w-40 break-words py-1.5 font-normal">
                      {folder.scope}
                    </th>
                    <td>
                      {folder.server.kind === "available"
                        ? `${folder.server.total} / ${folder.server.unread} / ${folder.server.threads ?? "—"}`
                        : t`Server unavailable`}
                    </td>
                    <td>
                      {folder.local.total} / {folder.local.unread} / {folder.local.threads}
                    </td>
                    <td>{days(folder.bodyCacheWindowDays)}</td>
                    <td>
                      {folder.headerWindow
                        ? t`${folder.headerWindow.days} days, up to ${folder.headerWindow.messageLimit} messages`
                        : t`All mail`}
                    </td>
                    <td>{folder.pendingOps}</td>
                    <td>{verdicts[folder.verdict]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" onClick={copy} className={button}>
            {copied ? t`Copied` : t`Copy redacted report`}
          </button>
          <Disclosure summary={<Trans>Redacted report</Trans>}>
            <textarea
              readOnly
              aria-label={t`Redacted report`}
              value={JSON.stringify(redactSyncHealth(report), null, 2)}
              className="selectable h-40 w-full font-mono text-xs"
            />
          </Disclosure>
        </>
      )}
    </section>
  );
}
