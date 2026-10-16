import { Trans, useLingui } from "@lingui/react/macro";
import { Alert, AlertCancel, alertButton, alertDanger, alertPrimary } from "../../../ui/Dialog";
import type { Draft } from "../draft";
import type { useComposeSend } from "../hooks/use-compose-send";

/** The composer's confirmations: save before closing, and the send warnings. */
export function ComposerAlerts({
  draft,
  closing,
  setClosing,
  asking,
  setAsking,
  submit,
  onAttach,
  onDiscard,
  onClose,
}: {
  draft: Draft;
  closing: boolean;
  setClosing: (closing: boolean) => void;
  asking: ReturnType<typeof useComposeSend>["asking"];
  setAsking: ReturnType<typeof useComposeSend>["setAsking"];
  submit: ReturnType<typeof useComposeSend>["submit"];
  /** Opens the file picker. */
  onAttach: () => void;
  onDiscard: (draft: Draft) => void;
  onClose: (draft: Draft, changed: boolean) => void;
}) {
  const { t } = useLingui();
  return (
    <>
      <Alert
        open={closing}
        onOpenChange={setClosing}
        title={t`Save this draft before closing?`}
        description={t`This draft has unsaved changes or couldn't sync.`}
      >
        <AlertCancel>
          <Trans>Cancel</Trans>
        </AlertCancel>
        <button type="button" onClick={() => onDiscard(draft)} className={alertDanger}>
          <Trans>Delete</Trans>
        </button>
        <button type="button" onClick={() => onClose(draft, true)} className={alertPrimary}>
          <Trans>Save</Trans>
        </button>
      </Alert>
      <Alert
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        title={
          asking?.warning === "recipients"
            ? t`Review AI recipients`
            : asking?.warning === "subject"
              ? t`Send this message without a subject?`
              : t`The message mentions an attachment, but none is added.`
        }
      >
        {asking?.recipients?.unfamiliar.length ? (
          <p>
            <Trans>AI added unfamiliar recipients:</Trans> {asking.recipients.unfamiliar.join(", ")}
          </p>
        ) : null}
        {asking?.recipients?.outsideThread.length ? (
          <p>
            <Trans>Recipients outside the original conversation:</Trans>{" "}
            {asking.recipients.outsideThread.join(", ")}
          </p>
        ) : null}
        <AlertCancel>
          <Trans>Cancel</Trans>
        </AlertCancel>
        {asking?.warning === "attachment" && (
          <button
            type="button"
            autoFocus
            // Nothing is sent: the prompt closes and the file picker opens.
            onClick={() => {
              setAsking(null);
              onAttach();
            }}
            className={alertButton}
          >
            <Trans>Add attachment</Trans>
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (asking) submit(asking.archive, [...asking.confirmed, asking.warning]);
          }}
          className={alertPrimary}
        >
          <Trans>Send anyway</Trans>
        </button>
      </Alert>
    </>
  );
}
