import { Trans, useLingui } from "@lingui/react/macro";
import { reorderAttachments } from "@openmail/core/schema";
import { Paperclip, X } from "lucide-react";
import type { RefObject } from "react";
import { formatBytes } from "../../../lib/format";
import type { Draft } from "../draft";
import { quiet } from "./composer-styles";

/** The attachment chips under the editor: reorder by drag or arrows, remove, and the forwarded original. */
export function ComposeAttachments({
  draft,
  set,
  attachmentDrag,
}: {
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  /** The index of the chip being dragged, shared with the composer's file drop handling. */
  attachmentDrag: RefObject<number | null>;
}) {
  const { t, i18n } = useLingui();
  if (draft.attachments.length === 0 && !draft.forwardAsAttachment) return null;
  return (
    <div className="flex flex-wrap gap-2 px-4 pb-2">
      {draft.forwardAsAttachment && (
        <span className="flex items-center gap-1.5 rounded-control border border-edge px-2 py-1">
          <Paperclip className="size-3.5 text-a11y-muted" />
          <Trans>Original message (.eml)</Trans>
          <button
            type="button"
            aria-label={t`Don't attach the original message`}
            onClick={() => set({ forwardAsAttachment: false })}
            className="text-a11y-muted hover:text-neutral-700 dark:hover:text-neutral-200"
          >
            <X className="size-3.5" />
          </button>
        </span>
      )}
      {draft.attachments.map((a, i) => (
        <span
          key={`${a.filename}-${i}`}
          draggable
          onDragStart={(event) => {
            attachmentDrag.current = i;
            event.dataTransfer.setData("application/x-openmail-attachment", String(i));
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => {
            attachmentDrag.current = null;
          }}
          onDragOver={(event) => {
            if (attachmentDrag.current !== null) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={(event) => {
            if (attachmentDrag.current !== null) {
              event.preventDefault();
              event.stopPropagation();
              set({
                attachments: reorderAttachments(draft.attachments, attachmentDrag.current, i),
              });
              attachmentDrag.current = null;
            }
          }}
          className="flex items-center gap-1.5 rounded-control border border-edge px-2 py-1"
        >
          <Paperclip className="size-3.5 text-a11y-muted" />
          {a.filename}
          <button
            type="button"
            disabled={i === 0}
            aria-label={t`Move ${a.filename} earlier`}
            onClick={() => set({ attachments: reorderAttachments(draft.attachments, i, i - 1) })}
            className={quiet}
          >
            ↑
          </button>
          <button
            type="button"
            disabled={i === draft.attachments.length - 1}
            aria-label={t`Move ${a.filename} later`}
            onClick={() => set({ attachments: reorderAttachments(draft.attachments, i, i + 1) })}
            className={quiet}
          >
            ↓
          </button>
          <span className="text-a11y-muted">
            {formatBytes((a.content.length * 3) / 4, i18n.locale)}
          </span>
          <button
            type="button"
            aria-label={t`Remove ${a.filename}`}
            onClick={() => set({ attachments: draft.attachments.filter((_, j) => j !== i) })}
            className="text-a11y-muted hover:text-neutral-700 dark:hover:text-neutral-200"
          >
            <X className="size-3.5" />
          </button>
        </span>
      ))}
    </div>
  );
}
