import { Combobox } from "@base-ui/react/combobox";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { AsyncResult, Atom } from "effect/reactivity";
import { X } from "lucide-react";
import { type Ref, useState } from "react";

import type { Address } from "../../../shared/api";
import { ADDRESS_SEPARATOR, formatAddress, parseAddresses } from "../draft";
import type { AppError } from "../errors";
import { displayName } from "../format";
import { Keys } from "../state/keys";
import { setContactHiddenAtom } from "../state/mutations";
import { suggestionsAtom } from "../state/queries";
import { itemClass, popupMotion, popupSurface } from "./ui/styles";

type Suggestions = Atom.Atom<AsyncResult.AsyncResult<readonly Address[], AppError>>;
const none: Suggestions = Atom.make(AsyncResult.success([]));

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  /** The address the message is sent from; the only own address not suggested. */
  from: string | undefined;
}

/** The addresses in the field, trimmed, in order. */
const tokenize = (text: string) =>
  text
    .split(ADDRESS_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);

/** Chips first, then the text being typed. The draft keeps recipients as this text. */
const serialize = (chips: readonly string[], typed: string) => {
  const rest = typed.trimStart();
  return [...chips, ...(rest.trim() ? [rest] : [])].join(", ");
};

/**
 * A To, Cc or Bcc field. Finished addresses show as chips; the address being
 * typed gets suggestions from mail history. Enter or Tab picks the
 * highlighted suggestion, a separator or Enter turns typed text into a chip,
 * and Backspace in an empty field removes the last chip. The × on a
 * suggestion hides that address from suggestions.
 */
export function RecipientField({ label, value, onChange, inputRef, from }: Props) {
  const { t } = useLingui();
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<string | undefined>();
  const hide = useAtomSet(setContactHiddenAtom);

  // The value is the source of truth. The last token is still being typed
  // only while it matches what this field holds as typed text.
  const all = tokenize(value);
  const pending = typed.trim();
  const closed = ADDRESS_SEPARATOR.test(value.trimEnd().slice(-1));
  const editing = pending !== "" && all.at(-1) === pending && !closed;
  const chips = editing ? all.slice(0, -1) : all;
  const inputText = editing ? typed : "";
  const query = inputText.trim();

  const suggestions: Suggestions = query ? suggestionsAtom(query, from) : none;
  const found = AsyncResult.getOrElse(useAtomValue(suggestions), () => []);
  const taken = new Set(parseAddresses(value).addresses.map((a) => a.address.toLowerCase()));
  const shown = found.filter((a) => !taken.has(a.address.toLowerCase()));
  const byText = new Map(shown.map((a) => [formatAddress(a), a]));
  const items = [...byText.keys()];
  const listed = open && query !== "" && items.length > 0;

  const emit = (next: string) => {
    if (next !== value) onChange(next);
  };

  const type = (text: string) => {
    const parts = text.split(ADDRESS_SEPARATOR);
    const rest = parts.pop() ?? "";
    const done = parts.map((part) => part.trim()).filter(Boolean);
    setTyped(rest);
    emit(serialize([...chips, ...done], rest));
  };

  const pick = (text: string) => {
    setTyped("");
    setOpen(false);
    emit(serialize([...chips, text], ""));
  };

  /** Turns the typed text into a chip. */
  const commit = () => {
    if (!query) return false;
    setTyped("");
    emit(serialize([...chips, query], ""));
    return true;
  };

  return (
    <Combobox.Root<string, true>
      multiple
      items={items}
      filter={null}
      value={chips}
      onValueChange={(next, details) => {
        // Escape with the list closed would clear every chip; keep them.
        if (details.reason === "escape-key" || details.reason === "input-clear") return;
        if (details.reason === "item-press") {
          const added = next.find((text) => !chips.includes(text));
          if (added) pick(added);
          return;
        }
        emit(serialize(next, inputText));
      }}
      inputValue={inputText}
      onInputValueChange={(text, details) => {
        // Only typing changes the text; clears after a pick or on close are ignored.
        if (details.reason === "input-change") type(text);
      }}
      open={listed}
      onOpenChange={(next) => setOpen(next)}
      openOnInputClick={false}
      autoHighlight
      onItemHighlighted={(item) => setHighlighted(item)}
    >
      <Combobox.Chips className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-1 py-1.5">
        {chips.map((text, i) => {
          const address = parseAddresses(text).addresses[0];
          return (
            <Combobox.Chip
              key={`${i}:${text}`}
              aria-label={text}
              className={`group flex h-[22px] max-w-full items-center gap-0.5 rounded-[5px] pr-0.5 pl-1.5 outline-none focus:bg-blue-500 focus:text-white ${
                address
                  ? "bg-blue-500/10 text-blue-800 dark:bg-blue-400/15 dark:text-blue-200"
                  : "bg-red-500/10 text-red-700 dark:bg-red-400/15 dark:text-red-300"
              }`}
            >
              <span className="truncate">{address ? address.name || address.address : text}</span>
              <Combobox.ChipRemove
                aria-label={t`Remove ${text}`}
                tabIndex={-1}
                className="flex size-4 shrink-0 items-center justify-center rounded-[3px] opacity-0 group-hover:opacity-70 group-focus:opacity-100 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/15"
              >
                <X className="size-3" />
              </Combobox.ChipRemove>
            </Combobox.Chip>
          );
        })}
        <Combobox.Input
          ref={inputRef}
          aria-label={label}
          onKeyDown={(e) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === "Escape" && !listed) {
              // Nothing to close here: let the compose window handle it.
              e.preventBaseUIHandler();
            } else if (e.key === "Tab" && !e.shiftKey && listed && highlighted) {
              e.preventDefault();
              pick(highlighted);
            } else if (e.key === "Enter" && !(listed && highlighted) && commit()) {
              e.preventDefault();
            }
          }}
          onBlur={() => {
            commit();
          }}
          className="h-[22px] min-w-24 flex-1 bg-transparent text-[13px] outline-none placeholder:text-neutral-400"
        />
      </Combobox.Chips>
      <Combobox.Portal>
        <Combobox.Positioner
          side="bottom"
          align="start"
          sideOffset={2}
          className="z-[60] outline-none"
        >
          <Combobox.Popup
            aria-label={t`${label} suggestions`}
            className={`max-h-64 w-80 overflow-y-auto p-[5px] ${popupSurface} ${popupMotion}`}
          >
            <Combobox.List>
              {(text: string) => {
                const a = byText.get(text);
                if (!a) return null;
                return (
                  <Combobox.Item key={text} value={text} className={`group py-1 pr-1 ${itemClass}`}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{displayName(a)}</span>
                      <span className="block truncate text-[12px] text-neutral-500 group-data-highlighted:text-white/80">
                        {a.address}
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={t`Stop suggesting ${a.address}`}
                      tabIndex={-1}
                      // Keep focus in the field and don't pick the row.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        hide({
                          payload: { address: a.address, hidden: true },
                          reactivityKeys: [Keys.contacts],
                        });
                      }}
                      className="rounded p-0.5 opacity-0 group-hover:opacity-80 hover:bg-white/20 hover:opacity-100"
                    >
                      <X className="size-3.5" />
                    </button>
                  </Combobox.Item>
                );
              }}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
