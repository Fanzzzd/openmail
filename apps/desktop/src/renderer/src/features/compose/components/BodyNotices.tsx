/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Status notices above the editor, as in ComposeEditor. */
import { useLingui } from "@lingui/react/macro";
import { EMPTY_QUOTE_HISTORY } from "@openmail/core/schema";
import { constVoid } from "effect/Function";
import { useState } from "react";
import { EDIT_MESSAGE_TEXT } from "../../../i18n/message-text";
import { Alert, AlertCancel, alertButton, alertPrimary } from "../../../ui/Dialog";
import { EmailFrame } from "../../reader/frame/EmailFrame";
import { editorButton } from "./ComposeEditorBars";

/**
 * Notices above the body: hidden text removed when the draft opened, or original formatting kept
 * in a read-only preview until the person chooses to edit.
 */
export function BodyNotices({
  hiddenTextRemoved,
  remoteUnsupported,
  locked,
  onUnlock,
}: {
  hiddenTextRemoved: boolean;
  remoteUnsupported: boolean;
  locked: boolean;
  onUnlock: () => void;
}) {
  const { t } = useLingui();
  const [editPrompt, setEditPrompt] = useState(false);
  return (
    <>
      {hiddenTextRemoved && (
        <p
          role="status"
          className="shrink-0 border-b border-edge px-4 py-2 text-callout text-a11y-muted"
        >
          {t({
            message: "Hidden text was removed.",
            context: "compose sanitization notice",
            comment:
              "Invisible message text was removed before opening this draft in the editable rich composer. Do not include the removed text.",
          })}
        </p>
      )}
      {remoteUnsupported && (
        <div
          role="status"
          className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <p className="font-medium">
            {t({
              message: "Original formatting kept",
              context: "compose formatting status",
              comment:
                "Status for a draft shown in a read-only preview that preserves its original layout.",
            })}
          </p>
          <p>{t`This draft contains formatting or images this editor cannot keep. The original is preserved until you edit the body.`}</p>
          {locked && (
            <button type="button" className={editorButton} onClick={() => setEditPrompt(true)}>
              {t(EDIT_MESSAGE_TEXT)}
            </button>
          )}
        </div>
      )}
      <Alert
        open={editPrompt}
        onOpenChange={setEditPrompt}
        title={t`Edit this draft body?`}
        description={t`Editing removes unsupported formatting and images from this draft. Lists, bold, italic, underline and links are kept.`}
      >
        <AlertCancel>{t`Cancel`}</AlertCancel>
        <button
          type="button"
          className={alertPrimary}
          onClick={() => {
            onUnlock();
            setEditPrompt(false);
          }}
        >
          {t(EDIT_MESSAGE_TEXT)}
        </button>
      </Alert>
    </>
  );
}

/** The draft as it will be sent, while the body keeps formatting the editor cannot. */
export function LockedPreview({ html }: { html: string }) {
  return (
    <div className="bg-surface px-4 py-4">
      <EmailFrame
        html={html}
        remote={false}
        background="light"
        zoom={100}
        presentation="compose"
        previous={EMPTY_QUOTE_HISTORY}
        findQuery=""
        findIndex={0}
        onMatches={undefined}
        onActivate={constVoid}
        onKeyDown={(event) => {
          const forwarded = new window.KeyboardEvent("keydown", {
            key: event.key,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            bubbles: true,
            cancelable: true,
          });
          window.dispatchEvent(forwarded);
          if (forwarded.defaultPrevented) event.preventDefault();
        }}
      />
    </div>
  );
}

/** Asks before a writing mode change that drops formatting. */
export function ModeChangePrompt({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useLingui();
  return (
    <Alert
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={t`Change writing mode?`}
      description={t`Some formatting cannot be kept in this mode. Link addresses are kept. You can undo the mode change.`}
    >
      <AlertCancel>{t`Cancel`}</AlertCancel>
      <button type="button" className={alertButton} onClick={onConfirm}>{t`Change mode`}</button>
    </Alert>
  );
}
