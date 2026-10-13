import { useLingui } from "@lingui/react/macro";
import type { RefObject } from "react";

/** Find in message: the bar above the thread while ⌘F is active. */
export function FindBar({
  inputRef,
  query,
  onQuery,
  index,
  count,
  onStep,
  onClose,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (query: string) => void;
  index: number;
  count: number;
  onStep: (direction: number) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  return (
    <search
      className="sticky top-0 z-10 mb-3 flex items-center gap-2 rounded border border-neutral-200 bg-surface p-2"
      aria-label={t`Find in message`}
    >
      <input
        ref={inputRef}
        aria-label={t`Find in message`}
        placeholder={t`Find in message`}
        className="min-w-0 flex-1 outline-none"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <output aria-live="polite">
        {count ? `${(index % count) + 1}/${count}` : t`No matches`}
      </output>
      <button
        type="button"
        disabled={!count}
        onClick={() => onStep(-1)}
      >{t`Previous match`}</button>
      <button type="button" disabled={!count} onClick={() => onStep(1)}>{t`Next match`}</button>
      <button type="button" onClick={onClose}>{t`Close find`}</button>
    </search>
  );
}
