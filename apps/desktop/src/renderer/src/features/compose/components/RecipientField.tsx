import {
  RECIPIENT_MIME,
  parseRecipientDrag,
  recipientTokens,
  replaceRecipient,
  type RecipientDrag,
  type RecipientFieldName,
} from "../recipient-actions";
import { AppleContactActions } from "../../contacts";
import { DropdownMenu, MenuItem } from "../../../ui/Menu";
import { recipientLabel, splitAddresses } from "@openmail/core/schema";
import { Combobox } from "@base-ui/react/combobox";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { AsyncResult, Atom } from "effect/reactivity";
import { MoreHorizontal, X } from "lucide-react";
import { type Ref, useRef, useState } from "react";

import type { Address } from "../../../../../shared/api";
import { ADDRESS_SEPARATOR, formatAddress, parseAddresses } from "../draft";
import type { AppError } from "../../../lib/errors";
import { displayName } from "../../../lib/format";
import { Keys } from "../../../state/keys";
import { setContactHiddenAtom } from "../../../state/mutations";
import {
  contactGroupsAtom,
  contactAlternativesAtom,
  suggestionsAtom,
} from "../../../state/queries";
import { itemClass, popupMotion, popupSurface, touchIcon } from "../../../ui/styles";
import { isTouchWeb } from "../../../lib/platform";

type Suggestions = Atom.Atom<AsyncResult.AsyncResult<readonly Address[], AppError>>;
const none: Suggestions = Atom.make(AsyncResult.success([]));

interface Props {
  label: string;
  fieldName?: RecipientFieldName;
  onMove?: (index: number, target: RecipientFieldName) => void;
  onDropRecipient?: (chip: RecipientDrag) => void;
  onDragChip?: () => void;
  value: string;
  onChange: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  "aria-describedby"?: string;
  /** The address the message is sent from; the only own address not suggested. */
  from: string | undefined;
  showFullAddresses: boolean;
}

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
export function RecipientField({
  label,
  value,
  onChange,
  inputRef,
  "aria-describedby": describedBy,
  from,
  showFullAddresses,
  fieldName,
  onMove,
  onDropRecipient,
  onDragChip,
}: Props) {
  const { t } = useLingui();
  const touch = isTouchWeb();
  const fieldRef = useRef<HTMLDivElement>(null);
  const [copyError, setCopyError] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<string | undefined>();
  const hide = useAtomSet(setContactHiddenAtom);

  // The value is the source of truth. The last token is still being typed
  // only while it matches what this field holds as typed text.
  const all = recipientTokens(value);
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
  const groups = AsyncResult.getOrElse(useAtomValue(contactGroupsAtom(query)), () => []).filter(
    (group) => group.members.some((a) => !taken.has(a.address.toLowerCase())),
  );
  const byGroup = new Map(groups.map((group) => [`group:${group.accountId}:${group.id}`, group]));
  const items = [...byText.keys(), ...(query ? byGroup.keys() : [])];
  const listed = open && query !== "" && items.length > 0;

  const emit = (next: string) => {
    if (next !== value) onChange(next);
  };

  const type = (text: string) => {
    const parts = splitAddresses(text);
    const rest = parts.pop() ?? "";
    const done = parts.map((part) => part.trim()).filter(Boolean);
    setTyped(rest);
    emit(serialize([...chips, ...done], rest));
  };

  const pick = (text: string) => {
    setTyped("");
    setOpen(false);
    const group = byGroup.get(text);
    const members = group
      ? group.members.filter((a) => !taken.has(a.address.toLowerCase())).map(formatAddress)
      : [text];
    emit(serialize([...chips, ...members], ""));
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
        const recipient = chips.find((chip) => !next.includes(chip));
        if (recipient) setAnnouncement(t`Removed ${recipient}`);
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
      <Combobox.Chips
        ref={fieldRef}
        onDragOver={(event) => {
          if (onDropRecipient && event.dataTransfer.types.includes(RECIPIENT_MIME)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(event) => {
          const chip = parseRecipientDrag(event.dataTransfer.getData(RECIPIENT_MIME));
          if (chip && onDropRecipient) {
            event.preventDefault();
            event.stopPropagation();
            onDropRecipient(chip);
          }
        }}
        className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-1 py-1.5"
      >
        {chips.map((text, i) => {
          const address = parseAddresses(text).addresses[0];
          return (
            <Combobox.Chip
              key={`${i}:${text}`}
              aria-label={text}
              onKeyDown={(event) => {
                // Nested buttons own their keys; the chip must not redirect their focus.
                if (event.target !== event.currentTarget) event.preventBaseUIHandler();
              }}
              draggable={Boolean(address && fieldName)}
              onDragStart={(event) => {
                if (!address || !fieldName) return;
                event.dataTransfer.setData(
                  RECIPIENT_MIME,
                  JSON.stringify({ source: fieldName, index: i, text }),
                );
                event.dataTransfer.effectAllowed = "move";
                onDragChip?.();
              }}
              className={`group flex h-[22px] max-w-full items-center gap-0.5 rounded-[5px] pr-0.5 pl-1.5 coarse:h-11 coarse:gap-2 coarse:pl-2.5 outline-none focus:bg-blue-600 focus:text-white ${
                address
                  ? "bg-blue-500/10 text-blue-800 dark:bg-blue-400/15 dark:text-blue-200"
                  : "bg-red-500/10 text-red-700 dark:bg-red-400/15 dark:text-red-300"
              }`}
            >
              {/* On a phone the chip itself opens its menu, so the name gets the width. */}
              {(!address || !touch) && (
                <span className="truncate">
                  {address ? recipientLabel(address, showFullAddresses) : text}
                </span>
              )}
              {address && (
                <ChipActions
                  label={touch ? recipientLabel(address, showFullAddresses) : undefined}
                  address={address}
                  fieldName={fieldName}
                  onCopy={() => {
                    void navigator.clipboard.writeText(address.address).then(
                      () => setCopyError(false),
                      () => setCopyError(true),
                    );
                  }}
                  onEdit={() => {
                    setTyped(text);
                    emit(
                      serialize(
                        chips.filter((_, index) => index !== i),
                        text,
                      ),
                    );
                    requestAnimationFrame(() => fieldRef.current?.querySelector("input")?.focus());
                  }}
                  onReplace={(next) => emit(replaceRecipient(value, i, next))}
                  onMove={onMove ? (target) => onMove(i, target) : undefined}
                />
              )}
              <Combobox.ChipRemove
                aria-label={t`Remove ${text}`}
                tabIndex={-1}
                className="flex size-4 shrink-0 items-center justify-center rounded-[3px] opacity-0 group-hover:opacity-70 group-focus-within:opacity-100 hover:bg-fill-pressed hover:opacity-100 coarse:size-11 coarse:opacity-70"
              >
                <X className="size-3" />
              </Combobox.ChipRemove>
            </Combobox.Chip>
          );
        })}
        <Combobox.Input
          ref={inputRef}
          aria-label={label}
          aria-describedby={describedBy}
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
          className="h-[22px] min-w-24 flex-1 bg-transparent text-body outline-none placeholder:text-a11y-muted"
        />
      </Combobox.Chips>
      <output aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </output>
      {copyError && <output role="alert">{t`Couldn't copy address`}</output>}
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
                const group = byGroup.get(text);
                if (group)
                  return (
                    <Combobox.Item
                      key={text}
                      value={text}
                      className={`group py-1 pr-1 ${itemClass}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{group.name}</span>
                        <span className="block text-footnote text-a11y-muted">
                          {t`Contact group`} · {group.members.length}
                        </span>
                      </span>
                    </Combobox.Item>
                  );
                const a = byText.get(text);
                if (!a) return null;
                return (
                  <Combobox.Item key={text} value={text} className={`group py-1 pr-1 ${itemClass}`}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{displayName(a)}</span>
                      <span className="block truncate text-footnote text-a11y-muted group-data-highlighted:text-white">
                        {a.address}
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={t`Stop suggesting ${a.address}`}
                      // Keep focus in the field and don't pick the row.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        hide({
                          payload: { address: a.address, hidden: true },
                          reactivityKeys: [Keys.contacts],
                        });
                      }}
                      className={`rounded p-0.5 opacity-0 group-hover:opacity-80 focus-visible:opacity-100 hover:bg-white/20 hover:opacity-100 coarse:opacity-80 ${touchIcon}`}
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

function ChipActions({
  label,
  address,
  fieldName,
  onCopy,
  onEdit,
  onReplace,
  onMove,
}: {
  /** The chip's text as the menu button, on a touch screen. Otherwise a ⋯ button follows it. */
  label: string | undefined;
  address: Address;
  fieldName: RecipientFieldName | undefined;
  onCopy: () => void;
  onEdit: () => void;
  onReplace: (address: Address) => void;
  onMove: ((target: RecipientFieldName) => void) | undefined;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const alternatives = AsyncResult.getOrElse(
    useAtomValue(open ? contactAlternativesAtom(address.address) : none),
    () => [],
  );
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          // The visible name is the button's name on a touch screen.
          aria-label={label === undefined ? t`Actions for ${address.address}` : undefined}
          title={label === undefined ? undefined : address.address}
          onKeyDown={(event) => {
            if (
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey &&
              ["Backspace", "Delete", "ArrowLeft", "ArrowRight"].includes(event.key)
            )
              event.stopPropagation();
          }}
          className={
            label === undefined
              ? `rounded p-0.5 hover:bg-black/10 ${touchIcon}`
              : "block min-w-0 truncate rounded text-left leading-11"
          }
        >
          {label === undefined ? <MoreHorizontal className="size-3" /> : label}
        </button>
      }
    >
      <MenuItem onClick={onCopy}>{t`Copy address`}</MenuItem>
      <MenuItem onClick={onEdit}>{t`Edit address`}</MenuItem>
      <AppleContactActions address={address} />
      {onMove && fieldName !== "to" && (
        <MenuItem onClick={() => onMove("to")}>{t`Move to To`}</MenuItem>
      )}
      {onMove && fieldName !== "cc" && (
        <MenuItem onClick={() => onMove("cc")}>{t`Move to Cc`}</MenuItem>
      )}
      {onMove && fieldName !== "bcc" && (
        <MenuItem onClick={() => onMove("bcc")}>{t`Move to Bcc`}</MenuItem>
      )}
      {alternatives
        .filter((a) => a.address.toLowerCase() !== address.address.toLowerCase())
        .map((a) => (
          <MenuItem key={a.address} onClick={() => onReplace(a)}>
            {a.address}
          </MenuItem>
        ))}
    </DropdownMenu>
  );
}
