import { Trans, useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { useEffect, useState } from "react";
import type { OutgoingAttachment } from "../../../shared/api";
import { isEmailAddress } from "@openmail/core/schema";
import { useRunMail, withMail } from "../state/mail";
import { Alert, AlertCancel, alertPrimary } from "./ui/Dialog";
import { Select } from "./ui/Select";

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
  const [preview, setPreview] = useState<string | null>(null);
  const [attach, setAttach] = useState(false);
  useEffect(() => {
    run(
      withMail((call) =>
        Effect.all({
          address: call("FeedbackAddress", undefined),
          preview: call("Diagnostics", { crashOnly: crash }),
        }),
      ).pipe(
        Effect.map((loaded) => {
          setAddress(loaded.address);
          setPreview(loaded.preview);
        }),
      ),
    );
  }, [run, crash]);
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
      title={crash ? t`OpenMail stopped unexpectedly` : t`Send Feedback…`}
    >
      <div className="w-full">
        <p className="mb-3 text-sm text-a11y-muted">
          <Trans>
            Review the local diagnostics below. Nothing is uploaded. Continue opens an email draft
            that you review and send from your own account.
          </Trans>
        </p>
        <label className="block text-sm">
          <Trans>Feedback address</Trans>
          <input
            aria-label={t`Feedback address`}
            className="my-1 block w-full rounded border p-2"
            type="email"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={t`Enter the project's feedback address`}
          />
        </label>
        <div className="space-y-1 text-sm">
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
          className="my-2 w-full rounded border p-2"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t`Describe what happened`}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={attach}
            disabled={preview === null || !preview}
            onChange={(e) => setAttach(e.target.checked)}
          />
          <Trans>Attach the redacted diagnostics shown below</Trans>
        </label>
        <pre
          aria-label={t`Diagnostics preview`}
          className="my-3 max-h-48 overflow-auto rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-900"
        >
          {preview ?? t`Loading diagnostics…`}
        </pre>
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
