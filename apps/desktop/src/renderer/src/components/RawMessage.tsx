import { useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { splitRawMessage } from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useState } from "react";

import { resultError } from "../errors";
import { rawMessageAtom } from "../state/queries";
import { Dialog } from "./ui/Dialog";
import { useSaveMessage } from "./reader-actions";
import type { Notify } from "./Reader";

/** Longer sources (big attachments in base64) show only this much; Copy still copies all of it. */
const SHOWN_CHARS = 400_000;

const button =
  "flex h-7 items-center gap-1.5 rounded-md border border-black/10 px-2.5 font-medium outline-offset-1 outline-a11y-focus hover:bg-black/[0.04] focus-visible:outline-[3px] disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/5";

/** View Original: the message's source as the provider has it. */
export function RawMessageDialog({
  messageId,
  onClose,
  notify,
}: {
  messageId: string;
  onClose: () => void;
  notify: Notify;
}) {
  const { t, i18n } = useLingui();
  const save = useSaveMessage(notify);
  const result = useAtomValue(rawMessageAtom(messageId));
  const raw = AsyncResult.isSuccess(result) ? result.value : null;
  const [headersOpen, setHeadersOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const parts = raw === null ? null : splitRawMessage(raw);
  const body = parts?.body ?? "";

  const copy = () => {
    if (raw === null) return;
    void navigator.clipboard.writeText(raw).then(() => setCopied(true));
  };

  return (
    <Dialog
      aria-label={t`Original message`}
      onClose={onClose}
      className="flex h-[640px] max-h-[90vh] w-[820px] max-w-[92vw] flex-col overflow-hidden"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-black/[0.07] px-4 py-2.5 dark:border-white/[0.08]">
        <h2 className="flex-1 text-[14px] font-semibold">
          <Trans>Original message</Trans>
        </h2>
        <button type="button" onClick={copy} disabled={raw === null} className={button}>
          <Copy className="size-3.5" />
          {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
        </button>
        <button type="button" onClick={onClose} className={button}>
          <Trans>Close</Trans>
        </button>
        <button type="button" onClick={() => save(messageId)} className={button}>
          <Trans>Save message as EML…</Trans>
        </button>
      </header>
      <div className="selectable min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed">
        {parts === null ? (
          <p className="font-sans text-a11y-muted">
            {resultError(i18n, result) ?? <Trans>Loading the original from the server…</Trans>}
          </p>
        ) : (
          <>
            <button
              type="button"
              aria-expanded={headersOpen}
              onClick={() => setHeadersOpen((open) => !open)}
              className="mb-1 flex items-center gap-1 font-sans text-[12px] font-semibold text-a11y-muted hover:text-neutral-800 dark:hover:text-neutral-100"
            >
              {headersOpen ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              <Trans>Headers</Trans>
            </button>
            {headersOpen && (
              <pre className="mb-3 whitespace-pre-wrap break-all text-neutral-600 dark:text-neutral-300">
                {parts.headers}
              </pre>
            )}
            <pre className="border-t border-black/[0.07] pt-3 whitespace-pre-wrap break-all dark:border-white/[0.08]">
              {body.length > SHOWN_CHARS ? body.slice(0, SHOWN_CHARS) : body}
            </pre>
            {body.length > SHOWN_CHARS && (
              <p className="mt-2 font-sans text-a11y-muted">
                <Trans>The rest is left out here. Copy gets the whole message.</Trans>
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
