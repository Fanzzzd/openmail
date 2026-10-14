import { useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { providerCapabilities } from "@openmail/core/schema";
import type { OutgoingMessage, Provider } from "../../../../../shared/api";
import { labelsAtom } from "../../../state/queries";
import { Tag } from "lucide-react";
import { iconButton, touchIcon } from "../../../ui/styles";
import { Tip } from "../../../ui/Tip";

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
  const caps = providerCapabilities(provider);
  // Gmail drafts keep labels and stars on this Mac; folder accounts write categories or keywords.
  const localLabels = caps.organization === "labels";
  const organizeLabel = caps.categories
    ? t`Draft categories`
    : localLabels
      ? t`Local draft labels`
      : t`Draft keywords`;
  return (
    <>
      <button
        type="button"
        aria-label={localLabels ? t`Star draft on this Mac` : t`Star draft`}
        aria-pressed={value.starred}
        onClick={() => onChange({ ...value, starred: !value.starred })}
        className={`rounded px-2 py-1 ${touchIcon} hover:bg-black/5`}
      >
        {value.starred ? "★" : "☆"}
      </button>
      <Tip label={organizeLabel} side="top">
        <button
          type="button"
          aria-label={organizeLabel}
          aria-expanded={open}
          onClick={() => {
            setNames(value.labels.join(", "));
            setOpen((previous) => !previous);
          }}
          className={`${iconButton} ${value.labels.length ? "text-a11y-accent" : "text-a11y-muted"}`}
        >
          <Tag className="size-4" />
        </button>
      </Tip>
      {open && (
        <div className="absolute right-4 bottom-12 z-10 w-64 space-y-2 rounded-card bg-overlay p-3 shadow-popup backdrop-blur-xl">
          {localLabels && (
            <p className="text-footnote text-a11y-muted">{t`Gmail draft labels and stars stay on this Mac. Gmail only allows the Draft label on server drafts.`}</p>
          )}
          {localLabels ? (
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
                {caps.categories
                  ? t`Category names, separated by commas`
                  : t`IMAP keywords, separated by commas`}
                <input
                  value={names}
                  onChange={(event) => setNames(event.target.value)}
                  className="mt-1 w-full rounded border bg-transparent px-2 py-1 border-separator"
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
