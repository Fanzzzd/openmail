import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useShortcutText } from "../use-shortcut-text";

/** "3 search matches · 1/3" with previous and next, above a message opened from a search. */
export function SearchHitBar({
  index,
  count,
  onStep,
}: {
  index: number;
  count: number;
  onStep: (direction: number) => void;
}) {
  const { t } = useLingui();
  const shortcut = useShortcutText();
  return (
    <fieldset className="sticky top-0 z-10 mb-3 flex min-w-0 items-center gap-2 rounded border border-neutral-200 bg-white px-2 py-1 text-[12px] dark:border-white/10 dark:bg-neutral-900">
      <legend className="sr-only">{t`Search matches`}</legend>
      <output aria-live="polite" className="flex-1 text-a11y-muted">
        {plural(count, { one: "# search match", other: "# search matches" })}
        {" · "}
        {`${(index % count) + 1}/${count}`}
      </output>
      <button type="button" onClick={() => onStep(-1)} title={shortcut("findPrevious")}>
        {t`Previous match`}
      </button>
      <button type="button" onClick={() => onStep(1)} title={shortcut("findNext")}>
        {t`Next match`}
      </button>
    </fieldset>
  );
}
