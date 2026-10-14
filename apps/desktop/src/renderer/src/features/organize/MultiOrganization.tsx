import { categoryKey, mergeCategoryNames, providerCapabilities } from "@openmail/core/schema";
import { cloneElement, type ReactElement, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import type { Label, MailOp, Provider } from "../../../../shared/api";
import { PickerPopover } from "../../ui/Picker";
import { buttonPrimary, formInput } from "../../ui/styles";

/**
 * Outlook categories stack; IMAP copies create separate messages in each
 * chosen folder. In a menu the form opens in place; with a `trigger`, as in
 * a toolbar, it opens in a popover anchored to that button.
 */
export function MultiOrganization({
  provider,
  labels,
  current,
  onOp,
  trigger,
}: {
  provider: Provider;
  labels: readonly Label[];
  current: readonly string[];
  onOp: (op: MailOp) => void;
  /** The button that opens the popover, without content; the label goes inside. */
  trigger?: ReactElement<{ children?: string }>;
}) {
  const { t } = useLingui();
  const categories = providerCapabilities(provider).categories;
  const available = labels.filter((label) => categories === label.id.startsWith("category:"));
  const [selected, setSelected] = useState<string[]>([]);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [names, setNames] = useState("");
  const [open, setOpen] = useState(false);
  const title = categories ? t`Categories…` : t`Copy to folders…`;
  /** Opening starts from the thread's current categories and no new names. */
  const toggle = (next: boolean) => {
    if (next) {
      setSelected(
        categories
          ? available
              .filter((label) => current.some((id) => categoryKey(id) === categoryKey(label.id)))
              .map((label) => label.id)
          : [],
      );
      setNames("");
      setTouched(new Set());
    }
    setOpen(next);
  };
  const form = (
    <fieldset className="space-y-2 py-2">
      <legend className="text-footnote text-a11y-muted">
        {categories
          ? t`Choose multiple categories`
          : t`Creates a separate copy in each selected folder. Keeps the original. Copies cannot be undone.`}
      </legend>
      <div className="max-h-40 overflow-auto">
        {available.map((label) => (
          <label key={label.id} className="flex items-center gap-2 py-1">
            <input
              type="checkbox"
              className="size-3.5 accent-blue-600"
              checked={selected.includes(label.id)}
              onChange={(event) => {
                setTouched((previous) => new Set([...previous, label.id]));
                setSelected((previous) =>
                  event.target.checked
                    ? [...previous, label.id]
                    : previous.filter((id) => id !== label.id),
                );
              }}
            />
            {label.name}
          </label>
        ))}
      </div>
      {categories && (
        <label className="block">
          {t`Additional category names, separated by commas`}
          <input
            className={`mt-1 ${formInput}`}
            value={names}
            onChange={(event) => setNames(event.target.value)}
          />
        </label>
      )}
      <button
        type="button"
        className={buttonPrimary}
        disabled={!categories && !selected.length}
        onClick={() => {
          if (categories) {
            const wanted = mergeCategoryNames(
              selected.map((id) => id.slice(9)),
              names
                .split(",")
                .map((name) => name.trim())
                .filter(Boolean),
              [],
            );
            onOp({
              kind: "categories",
              add: wanted,
              remove: [...touched]
                .filter(
                  (id) =>
                    id.startsWith("category:") &&
                    !wanted.some((name) => categoryKey(name) === categoryKey(id.slice(9))),
                )
                .map((id) => id.slice(9)),
            });
          } else onOp({ kind: "copy", labelIds: selected });
          setOpen(false);
        }}
      >
        {categories ? t`Apply` : t`Copy`}
      </button>
    </fieldset>
  );
  if (trigger)
    return (
      <PickerPopover
        aria-label={title}
        open={open}
        onOpenChange={toggle}
        trigger={cloneElement(trigger, {}, title)}
        className="w-72 px-3 py-1"
      >
        {form}
      </PickerPopover>
    );
  return (
    <div>
      {/* Lines up with the menu items around it: their icon column is 32 px wide. */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => toggle(!open)}
        className="flex min-h-[22px] w-full items-center rounded-item pr-2 pl-8 text-left hover:bg-fill-hover"
      >
        {title}
      </button>
      {open && <div className="px-2">{form}</div>}
    </div>
  );
}
