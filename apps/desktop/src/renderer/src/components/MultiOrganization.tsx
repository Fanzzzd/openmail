import { categoryKey, mergeCategoryNames } from "@openmail/core/schema";
import { useState } from "react";
import { useLingui } from "@lingui/react/macro";
import type { Label, MailOp, Provider } from "../../../shared/api";

/** Outlook categories stack; IMAP copies create separate messages in each chosen folder. */
export function MultiOrganization({
  provider,
  labels,
  current,
  onOp,
}: {
  provider: Provider;
  labels: readonly Label[];
  current: readonly string[];
  onOp: (op: MailOp) => void;
}) {
  const { t } = useLingui();
  const categories = provider === "outlook";
  const available = labels.filter((label) => categories === label.id.startsWith("category:"));
  const [selected, setSelected] = useState<string[]>([]);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [names, setNames] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <div className="px-2 py-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setSelected(
            categories
              ? available
                  .filter((label) =>
                    current.some((id) => categoryKey(id) === categoryKey(label.id)),
                  )
                  .map((label) => label.id)
              : [],
          );
          setNames("");
          setTouched(new Set());
          setOpen(!open);
        }}
      >
        {categories ? t`Categories…` : t`Copy to folders…`}
      </button>
      {open && (
        <fieldset className="space-y-2 py-2">
          <legend className="text-xs text-a11y-muted">
            {categories
              ? t`Choose multiple categories`
              : t`Creates a separate copy in each selected folder. Keeps the original. Copies cannot be undone.`}
          </legend>
          <div className="max-h-40 overflow-auto">
            {available.map((label) => (
              <label key={label.id} className="flex gap-2 py-1">
                <input
                  type="checkbox"
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
                className="mt-1 w-full rounded border bg-transparent px-2 py-1"
                value={names}
                onChange={(event) => setNames(event.target.value)}
              />
            </label>
          )}
          <button
            type="button"
            className="text-a11y-accent"
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
      )}
    </div>
  );
}
