import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { AsyncResult, Atom } from "effect/reactivity";
import { X } from "lucide-react";
import { useState } from "react";

import type { Address } from "../../../shared/api";
import { ADDRESS_SEPARATOR, formatAddress, parseAddresses } from "../draft";
import type { AppError } from "../errors";
import { displayName } from "../format";
import { Keys } from "../state/keys";
import { setContactHiddenAtom } from "../state/mutations";
import { suggestionsAtom } from "../state/queries";

type Suggestions = Atom.Atom<AsyncResult.AsyncResult<readonly Address[], AppError>>;
const none: Suggestions = Atom.make(AsyncResult.success([]));

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  className: string;
  /** The address the message is sent from; the only own address not suggested. */
  from: string | undefined;
}

/** Splits the field into what is settled and the address being typed after the last separator. */
function split(value: string): { head: string; token: string } {
  let cut = -1;
  for (let i = value.length - 1; i >= 0; i--) {
    if (ADDRESS_SEPARATOR.test(value[i]!)) {
      cut = i;
      break;
    }
  }
  return { head: value.slice(0, cut + 1), token: value.slice(cut + 1) };
}

/**
 * A To, Cc or Bcc field with suggestions from mail history. Arrow keys move,
 * Enter or Tab picks, the × on a row hides that address from suggestions.
 */
export function RecipientField({ label, value, onChange, autoFocus, className, from }: Props) {
  const { t } = useLingui();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const hide = useAtomSet(setContactHiddenAtom);
  const { head, token } = split(value);
  const query = token.trim();
  const open = focused && query.length > 0 && dismissed !== value;
  const suggestions: Suggestions = open ? suggestionsAtom(query, from) : none;
  const result = useAtomValue(suggestions);
  const taken = new Set(parseAddresses(value).addresses.map((a) => a.address.toLowerCase()));
  const shown = AsyncResult.getOrElse(result, () => []).filter(
    (a) => !taken.has(a.address.toLowerCase()),
  );
  const current = Math.min(active, Math.max(shown.length - 1, 0));

  const pick = (a: Address) => {
    const spaced = head && !head.endsWith(" ") ? `${head} ` : head;
    onChange(`${spaced}${formatAddress(a)}, `);
    setActive(0);
  };

  return (
    <span className="relative flex min-w-0 flex-1">
      <input
        aria-label={label}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(0);
          setDismissed(null);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (!open || shown.length === 0) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((current + step + shown.length) % shown.length);
          } else if ((e.key === "Enter" || e.key === "Tab") && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            pick(shown[current]!);
          } else if (e.key === "Escape") {
            // Closes the list; the compose window sees the key as handled.
            e.preventDefault();
            setDismissed(value);
          }
        }}
        className={className}
      />
      {open && shown.length > 0 && (
        <ul
          aria-label={t`${label} suggestions`}
          className="absolute top-9 left-0 z-30 max-h-64 w-80 overflow-y-auto rounded-lg border border-black/10 bg-white py-1 shadow-xl dark:border-white/10 dark:bg-neutral-800"
        >
          {shown.map((a, i) => (
            <li
              key={a.address}
              className={`group flex items-center gap-2 pr-2 ${i === current ? "bg-blue-500/10" : ""}`}
            >
              <button
                type="button"
                aria-current={i === current}
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                // Keep focus in the field.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(a);
                }}
                className="min-w-0 flex-1 px-3 py-1.5 text-left"
              >
                <span className="block truncate">{displayName(a)}</span>
                <span className="block truncate text-[12px] text-neutral-500">{a.address}</span>
              </button>
              <button
                type="button"
                title={t`Stop suggesting this address`}
                aria-label={t`Stop suggesting ${a.address}`}
                tabIndex={-1}
                onMouseDown={(e) => {
                  e.preventDefault();
                  hide({
                    payload: { address: a.address, hidden: true },
                    reactivityKeys: [Keys.contacts],
                  });
                }}
                className="rounded p-0.5 text-neutral-400 opacity-0 group-hover:opacity-100 hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
