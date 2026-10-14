import { useLingui } from "@lingui/react/macro";
import type { Address } from "@openmail/core/schema";
import type { KeyboardEvent } from "react";
import { touchIcon } from "../../../ui/styles";

/** A small text button in the editor's toolbar rows and bars. */
export const editorButton = `rounded p-1.5 ${touchIcon} text-a11y-muted hover:bg-fill-hover focus-visible:outline-a11y-focus`;

/** People matching the @mention being typed; the arrow keys move `index`. */
export function MentionSuggestions({
  people,
  index: active,
  onPick,
}: {
  people: readonly Address[];
  index: number;
  onPick: (person: Address) => void;
}) {
  const { t } = useLingui();
  return (
    <div
      className="shrink-0 border-b px-4 py-2 border-separator"
      aria-label={t`Mention suggestions`}
    >
      {people.map((person, index) => (
        <button
          key={person.address}
          type="button"
          className={`${editorButton} ${index === active ? "bg-blue-500/10" : ""}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(person)}
        >
          {person.name || person.address}
        </button>
      ))}
    </div>
  );
}

/** Find and replace in the message text. */
export function ComposeFindBar({
  query,
  onQuery,
  replacement,
  onReplacement,
  onKeyDown,
  index,
  count,
  locked,
  onSelect,
  onReplace,
  onClose,
}: {
  query: string;
  onQuery: (query: string) => void;
  replacement: string;
  onReplacement: (replacement: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  index: number;
  count: number;
  locked: boolean;
  onSelect: (index: number) => void;
  onReplace: (all: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  return (
    <search
      aria-label={t`Find and replace`}
      className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2"
    >
      <input
        autoFocus
        aria-label={t`Find in body`}
        placeholder={t`Find in body`}
        value={query}
        onKeyDown={onKeyDown}
        onChange={(event) => onQuery(event.target.value)}
        className="min-w-0 flex-1 rounded border px-2 py-1 border-separator"
      />
      <input
        aria-label={t`Replace with`}
        placeholder={t`Replace with`}
        value={replacement}
        onKeyDown={onKeyDown}
        onChange={(event) => onReplacement(event.target.value)}
        className="min-w-0 flex-1 rounded border px-2 py-1 border-separator"
      />
      <output aria-live="polite">
        {count ? `${(index % count) + 1}/${count}` : t`No matches`}
      </output>
      <button
        type="button"
        disabled={!count}
        className={editorButton}
        onClick={() => onSelect((index + count - 1) % count)}
      >{t`Previous match`}</button>
      <button
        type="button"
        disabled={!count}
        className={editorButton}
        onClick={() => onSelect((index + 1) % count)}
      >{t`Next match`}</button>
      <button
        type="button"
        disabled={locked || !count}
        className={editorButton}
        onClick={() => onReplace(false)}
      >{t`Replace`}</button>
      <button
        type="button"
        disabled={locked || !count}
        className={editorButton}
        onClick={() => onReplace(true)}
      >{t`Replace all`}</button>
      <button type="button" className={editorButton} onClick={onClose}>{t`Close find`}</button>
    </search>
  );
}

/** The link address field, for a new link or the one under the caret. */
export function ComposeLinkBar({
  href,
  onHref,
  error,
  onApply,
  onCancel,
}: {
  href: string;
  onHref: (href: string) => void;
  /** The address is not an http, https or mailto link. */
  error: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2">
      <input
        autoFocus
        aria-label={t`Link URL`}
        value={href}
        placeholder="https://"
        className="min-w-0 flex-1 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-600"
        onChange={(e) => onHref(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onApply();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <button type="button" className={editorButton} onClick={onApply}>{t`Apply link`}</button>
      <button type="button" className={editorButton} onClick={onCancel}>{t`Cancel`}</button>
      {error && (
        <span
          role="alert"
          className="w-full text-a11y-danger"
        >{t`Use an http, https or mailto link`}</span>
      )}
    </div>
  );
}
