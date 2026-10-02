import { useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { OutgoingMessage, Provider } from "../../../shared/api";
import { labelsAtom } from "../state/queries";

type Organization = NonNullable<OutgoingMessage["draftOrganization"]>;
export function DraftOrganization({
  provider,
  accountId,
  value,
  onChange,
}: {
  provider: Provider;
  accountId: string;
  value: Organization;
  onChange: (value: Organization) => void;
}) {
  const { t } = useLingui();
  const labels = AsyncResult.getOrElse(useAtomValue(labelsAtom([accountId])), () => []).filter(
    (label) => label.accountId === accountId && label.id.startsWith("Label_"),
  );
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState(value.labels.join(", "));
  return (
    <>
      <button
        type="button"
        aria-label={provider === "gmail" ? t`Star draft on this Mac` : t`Star draft`}
        aria-pressed={value.starred}
        onClick={() => onChange({ ...value, starred: !value.starred })}
        className="rounded px-2 py-1 hover:bg-black/5"
      >
        {value.starred ? "★" : "☆"}
      </button>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setNames(value.labels.join(", "));
          setOpen((previous) => !previous);
        }}
      >
        {provider === "outlook"
          ? t`Draft categories`
          : provider === "imap"
            ? t`Draft keywords`
            : t`Local draft labels`}
      </button>
      {open && (
        <div className="absolute right-4 bottom-12 z-10 w-64 space-y-2 rounded-lg border bg-white p-3 shadow-lg dark:bg-neutral-800">
          {provider === "gmail" && (
            <p className="text-xs text-a11y-muted">{t`Gmail draft labels and stars stay on this Mac. Gmail only allows the Draft label on server drafts.`}</p>
          )}
          {provider === "gmail" ? (
            <div className="max-h-48 overflow-auto">
              {labels.length ? (
                labels.map((label) => (
                  <label key={label.id} className="flex gap-2 py-1">
                    <input
                      type="checkbox"
                      checked={value.labels.includes(label.id)}
                      onChange={(event) =>
                        onChange({
                          ...value,
                          labels: event.target.checked
                            ? [...value.labels, label.id]
                            : value.labels.filter((id) => id !== label.id),
                        })
                      }
                    />
                    {label.name}
                  </label>
                ))
              ) : (
                <p>{t`No custom labels`}</p>
              )}
            </div>
          ) : (
            <>
              <label className="block">
                {provider === "outlook"
                  ? t`Category names, separated by commas`
                  : t`IMAP keywords, separated by commas`}
                <input
                  value={names}
                  onChange={(event) => setNames(event.target.value)}
                  className="mt-1 w-full rounded border bg-transparent px-2 py-1"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      onChange({
                        ...value,
                        labels: [
                          ...new Set(
                            names
                              .split(",")
                              .map((name) => name.trim())
                              .filter(Boolean),
                          ),
                        ],
                      });
                      setOpen(false);
                    }
                  }}
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  onChange({
                    ...value,
                    labels: [
                      ...new Set(
                        names
                          .split(",")
                          .map((name) => name.trim())
                          .filter(Boolean),
                      ),
                    ],
                  });
                  setOpen(false);
                }}
              >{t`Apply`}</button>
            </>
          )}
          <button type="button" onClick={() => setOpen(false)}>{t`Close`}</button>
        </div>
      )}
    </>
  );
}
