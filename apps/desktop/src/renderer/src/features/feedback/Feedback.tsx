import { Trans, useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";
import type { OutgoingAttachment } from "../../../../shared/api";

/** How long the dialog waits for the diagnostics before offering to retry or skip them. */
export const DIAGNOSTICS_TIMEOUT = "10 seconds";
import { isEmailAddress } from "@openmail/core/schema";
import { useRunMail, withMail } from "../../state/mail";
import { Alert, AlertCancel, alertPrimary } from "../../ui/Dialog";
import { Select } from "../../ui/Select";
import { buttonLink } from "../../ui/styles";

export interface FeedbackInput {
  to: string;
  subject: string;
  body: string;
  attachments: readonly OutgoingAttachment[];
}
export function Feedback({
  crash,
  onClose,
  onDraft,
}: {
  crash: boolean;
  onClose: () => void;
  onDraft: (input: FeedbackInput) => void;
}) {
  const { t } = useLingui();
  const run = useRunMail();
  const [address, setAddress] = useState("");
  const [category, setCategory] = useState("Bug report");
  const [body, setBody] = useState("");
  // null while loading; false when loading failed or timed out.
  const [preview, setPreview] = useState<string | null | false>(null);
  const [attach, setAttach] = useState(false);
  useEffect(() => {
    // The address is optional; a failure leaves the field for the person to fill in.
    run(
      withMail((call) => call("FeedbackAddress", undefined)).pipe(
        Effect.map((loaded) => setAddress((typed) => typed || loaded)),
      ),
    );
  }, [run]);
  const loadDiagnostics = useCallback(() => {
    run(
      withMail((call) => call("Diagnostics", { crashOnly: crash })).pipe(
        Effect.timeout(DIAGNOSTICS_TIMEOUT),
        Effect.matchCause({
          onSuccess: (loaded) => setPreview(loaded),
          onFailure: () => {
            setAttach(false);
            setPreview(false);
          },
        }),
      ),
    );
  }, [run, crash]);
  useEffect(() => {
    loadDiagnostics();
  }, [loadDiagnostics]);
  const close = () => {
    if (crash) run(withMail((call) => call("DismissCrashReport", undefined)));
    onClose();
  };
  return (
    <Alert
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={crash ? t`OpenMail stopped unexpectedly` : t`Send feedback`}
    >
      <div className="w-full">
        <p className="mb-3 text-callout text-a11y-muted">
          <Trans>
            Review the local diagnostics below. Nothing is uploaded. Continue opens an email draft
            that you review and send from your own account.
          </Trans>
        </p>
        <label className="block text-callout">
          <Trans>Feedback address</Trans>
          <input
            aria-label={t`Feedback address`}
            className="my-1 block w-full rounded border p-2 border-separator"
            type="email"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={t`Enter the project's feedback address`}
          />
        </label>
        <div className="space-y-1 text-callout">
          <span className="block">
            <Trans>Category</Trans>
          </span>
          <Select
            variant="field"
            aria-label={t`Category`}
            value={category}
            options={[
              { value: "Bug report", label: t`Bug report` },
              { value: "Feature request", label: t`Feature request` },
              { value: "Other feedback", label: t`Other feedback` },
            ]}
            onValueChange={setCategory}
          />
        </div>
        <textarea
          aria-label={t`Feedback`}
          className="my-2 w-full rounded border p-2 border-separator"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t`Describe what happened`}
        />
        <label className="flex items-center gap-2 text-callout">
          <input
            type="checkbox"
            checked={attach}
            disabled={!preview}
            onChange={(e) => setAttach(e.target.checked)}
          />
          <Trans>Attach the redacted diagnostics shown below</Trans>
        </label>
        {preview === false ? (
          <div
            role="alert"
            className="my-3 flex items-center gap-3 rounded bg-neutral-100 p-2 text-footnote dark:bg-neutral-900"
          >
            <span className="min-w-0 flex-1">
              <Trans>Couldn't load diagnostics. You can continue without them.</Trans>
            </span>
            <button
              type="button"
              className={`shrink-0 ${buttonLink}`}
              onClick={() => {
                setPreview(null);
                loadDiagnostics();
              }}
            >
              <Trans>Try again</Trans>
            </button>
          </div>
        ) : (
          <pre
            aria-label={t`Diagnostics preview`}
            aria-busy={preview === null}
            className="my-3 max-h-48 overflow-auto rounded bg-neutral-100 p-2 text-footnote dark:bg-neutral-900"
          >
            {preview ?? t`Loading diagnostics…`}
          </pre>
        )}
        <div className="flex justify-end gap-2">
          <AlertCancel>
            <Trans>Cancel</Trans>
          </AlertCancel>
          <button
            className={alertPrimary}
            disabled={!isEmailAddress(address.trim()) || preview === null}
            onClick={() => {
              onDraft({
                to: address.trim(),
                subject: crash ? "OpenMail crash report" : `OpenMail: ${category}`,
                body,
                attachments:
                  attach && preview
                    ? [
                        {
                          filename: crash ? "openmail-crash.jsonl" : "openmail-diagnostics.jsonl",
                          mimeType: "application/x-ndjson",
                          content: btoa(preview),
                        },
                      ]
                    : [],
              });
              close();
            }}
          >
            <Trans>Continue to draft</Trans>
          </button>
        </div>
      </div>
    </Alert>
  );
}
