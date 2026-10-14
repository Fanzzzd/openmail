import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Disclosure } from "../../../ui/Disclosure";
import { redactSyncHealth, type HealthVerdict, type SyncHealth } from "@openmail/core/schema";
import { Effect } from "effect";
import { useState } from "react";
import { useRunMail, withMail } from "../../../state/mail";

import { buttonLink, settingsHint } from "../../../ui/styles";

const head = "px-2 py-1 font-medium whitespace-nowrap";
const cell = "px-2 py-1 align-top";
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
  const days = (value: number | null) =>
    value === null ? t`All mail` : t`${plural(value, { one: "# day", other: "# days" })}`;
  const seconds = Math.floor((report?.cursorAgeMs ?? 0) / 1000);
  const age =
    report?.cursorAgeMs == null
      ? t`Never synced`
      : t`${plural(seconds, { one: "# second", other: "# seconds" })}`;
  return (
    <section className="space-y-2" aria-label={t`Sync health`}>
      <button type="button" onClick={check} disabled={waiting} className={buttonLink}>
        {waiting ? t`Checking sync health…` : t`Check sync health`}
      </button>
      {failed && (
        <p role="alert" className="text-a11y-danger">
          {t`Couldn't check sync health.`}
        </p>
      )}
      {report && (
        <>
          <p className="tabular-nums">
            <Trans>
              Cursor age: {age}. Pending operations: {report.pendingOps}.
            </Trans>
          </p>
          <p className={settingsHint}>
            <Trans>
              Counts compare messages. Matching counts do not verify message contents. Cache windows
              retain message text; headers remain cached.
            </Trans>
          </p>
          <div className="overflow-x-auto rounded-control ring-1 ring-edge">
            <table className="w-full text-left text-caption tabular-nums">
              <caption className="sr-only">
                <Trans>Sync health</Trans>
              </caption>
              <thead className="border-b border-separator bg-fill-quiet text-a11y-muted">
                <tr>
                  <th scope="col" className={head}>
                    <Trans>Folder or label</Trans>
                  </th>
                  <th scope="col" className={head}>
                    <Trans>Server total / unread / threads</Trans>
                  </th>
                  <th scope="col" className={head}>
                    <Trans>Local total / unread / threads</Trans>
                  </th>
                  <th scope="col" className={head}>
                    <Trans
                      context="cached message text"
                      comment="Retention window for downloaded email message text, not headers."
                    >
                      Message text cache window
                    </Trans>
                  </th>
                  <th scope="col" className={head}>
                    <Trans>Sync window</Trans>
                  </th>
                  <th scope="col" className={head}>
                    <Trans>Pending operations</Trans>
                  </th>
                  <th scope="col" className={head}>
                    <Trans>Verdict</Trans>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-separator">
                {report.folders.map((folder) => (
                  <tr key={folder.scope}>
                    <th scope="row" className={`max-w-40 font-normal break-words ${cell}`}>
                      {folder.scope}
                    </th>
                    <td className={cell}>
                      {folder.server.kind === "available"
                        ? `${folder.server.total} / ${folder.server.unread} / ${folder.server.threads ?? "—"}`
                        : t`Server unavailable`}
                    </td>
                    <td className={cell}>
                      {folder.local.total} / {folder.local.unread} / {folder.local.threads}
                    </td>
                    <td className={cell}>{days(folder.bodyCacheWindowDays)}</td>
                    <td className={cell}>
                      {folder.headerWindow
                        ? t`${folder.headerWindow.days} days, up to ${folder.headerWindow.messageLimit} messages`
                        : t`All mail`}
                    </td>
                    <td className={cell}>{folder.pendingOps}</td>
                    <td className={cell}>{verdicts[folder.verdict]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" onClick={copy} className={buttonLink}>
            {copied ? t`Copied` : t`Copy redacted report`}
          </button>
          <Disclosure summary={<Trans>Redacted report</Trans>}>
            <textarea
              readOnly
              aria-label={t`Redacted report`}
              value={JSON.stringify(redactSyncHealth(report), null, 2)}
              className="selectable block h-40 w-full rounded-control border border-control bg-fill-quiet px-2 py-1 font-mono text-caption outline-offset-0 outline-a11y-focus focus:border-transparent focus:outline-2"
            />
          </Disclosure>
        </>
      )}
    </section>
  );
}
