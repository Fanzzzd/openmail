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
import { useOpenSurface } from "../../../ui/open-surfaces";
import { recipientLabel, splitAddresses } from "@openmail/core/schema";
import { Combobox } from "@base-ui/react/combobox";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { AsyncResult, Atom } from "effect/reactivity";
import { MoreHorizontal, X } from "lucide-react";
import { type Ref, useId, useRef, useState } from "react";

import type { Address } from "../../../../../shared/api";
import { ADDRESS_SEPARATOR, formatAddress, parseAddresses } from "../draft";
import type { AppError } from "../../../lib/errors";
import { removesSuggestion } from "../../../lib/delete-key";
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
 * typed gets suggestions from mail history. The first suggestion is
 * highlighted as soon as suggestions arrive, also when they arrive after the
 * last keystroke, unless the typed text is already one complete address: then
 * nothing is highlighted until the user moves the highlight with the keyboard
 * or pointer. Enter or Tab picks the highlighted suggestion, so what shows
 * highlighted, and what a screen reader hears, is what they do. Without a suggestion, Enter
 * turns typed text into a chip and Tab moves on, which does the same on blur.
 * A separator turns typed text into a chip, and Backspace in an empty field
 * removes the last chip. The × on a suggestion, or forward Delete on the
 * highlighted one (see removesSuggestion), hides that address from suggestions;
 * the field then shows what it stopped suggesting with an Undo button.
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
  /** The user moved the highlight with the keyboard or pointer, rather than autoHighlight. */
  const [chose, setChose] = useState(false);
  const hide = useAtomSet(setContactHiddenAtom);
  const hideHint = useId();
  /** The address the last hide stopped suggesting, shown with Undo until focus leaves both. */
  const [stopped, setStopped] = useState<Address | null>(null);
  const undoRef = useRef<HTMLButtonElement>(null);

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
  const suggested = useAtomValue(suggestions);
  const found = AsyncResult.getOrElse(suggested, () => []);
  const taken = new Set(parseAddresses(value).addresses.map((a) => a.address.toLowerCase()));
  const shown = found.filter((a) => !taken.has(a.address.toLowerCase()));
  const byText = new Map(shown.map((a) => [formatAddress(a), a]));
  const groups = AsyncResult.getOrElse(useAtomValue(contactGroupsAtom(query)), () => []).filter(
    (group) => group.members.some((a) => !taken.has(a.address.toLowerCase())),
  );
  const byGroup = new Map(groups.map((group) => [`group:${group.accountId}:${group.id}`, group]));
  const items = [...byText.keys(), ...(query ? byGroup.keys() : [])];
  const listed = open && query !== "" && items.length > 0;
  // Base UI forgets a keystroke's highlight request when the popup closes. Keeping the popup
  // open, empty and hidden while the query's suggestions load lets autoHighlight mark the first
  // of them when they arrive after the last keystroke.
  const loading = query !== "" && (suggested._tag === "Initial" || suggested.waiting);
  const popupOpen = open && query !== "" && (items.length > 0 || loading);
  const typedAddress = parseAddresses(query);
  const complete = typedAddress.addresses.length === 1 && typedAddress.invalid.length === 0;
  const suggestion = listed && highlighted && (chose || !complete) ? highlighted : undefined;
  useOpenSurface(listed, () => setOpen(false));

  const emit = (next: string) => {
    if (next !== value) onChange(next);
  };

  const stopSuggesting = (address: Address) => {
    hide({ payload: { address: address.address, hidden: true }, reactivityKeys: [Keys.contacts] });
    setStopped(address);
    const hidden = address.address;
    setAnnouncement(
      t({
        message: `Stopped suggesting ${hidden}. Undo follows this field.`,
        comment:
          "Screen reader announcement after a recipient suggestion is hidden. Undo is the button right after the To, Cc or Bcc field that shows it again.",
      }),
    );
  };

  const undoStop = (address: Address) => {
    hide({ payload: { address: address.address, hidden: false }, reactivityKeys: [Keys.contacts] });
    setStopped(null);
    setAnnouncement(t`Suggesting ${address.address} again`);
    fieldRef.current?.querySelector("input")?.focus();
  };

  const type = (text: string) => {
    const parts = splitAddresses(text);
    const rest = parts.pop() ?? "";
    const done = parts.map((part) => part.trim()).filter(Boolean);
    setTyped(rest);
    setChose(false);
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
      open={popupOpen}
      onOpenChange={(next) => setOpen(next)}
      openOnInputClick={false}
      // Each new query empties the list until its suggestions load, which clears the highlight;
      // a complete address then gets none.
      autoHighlight={!complete}
      onItemHighlighted={(item, details) => {
        setHighlighted(item);
        setChose(item !== undefined && details.reason !== "none");
      }}
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
            const highlightedAddress = listed && highlighted ? byText.get(highlighted) : undefined;
            if (highlightedAddress && removesSuggestion(e, e.currentTarget)) {
              // The same key as the search field's removal of a recent search.
              e.preventDefault();
              e.preventBaseUIHandler();
              stopSuggesting(highlightedAddress);
            } else if (e.key === "Escape" && !listed) {
              // Nothing to close here: let the compose window handle it.
              e.preventBaseUIHandler();
            } else if (e.key === "Tab" && !e.shiftKey && suggestion) {
              e.preventDefault();
              pick(suggestion);
            } else if (e.key === "Enter" && !suggestion && commit()) {
              e.preventDefault();
              // Base UI would pick the highlighted suggestion over the typed address.
              e.preventBaseUIHandler();
            }
          }}
          onBlur={(event) => {
            // On the way to Undo the text stays text: Undo puts focus back to finish it.
            if (event.relatedTarget === undoRef.current) return;
            commit();
            setStopped(null);
          }}
          className="h-[22px] min-w-24 flex-1 bg-transparent text-body outline-none placeholder:text-a11y-muted"
        />
      </Combobox.Chips>
      {stopped && (
        <span className="flex h-9 max-w-[60%] shrink-0 items-center gap-1.5 text-footnote text-a11y-muted coarse:h-11">
          <span className="min-w-0 truncate" title={stopped.address}>
            {t`Stopped suggesting ${stopped.address}`}
          </span>
          <button
            ref={undoRef}
            type="button"
            // A click keeps focus in the field, so its typed text stays text instead of a chip.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => undoStop(stopped)}
            onBlur={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                fieldRef.current?.contains(event.relatedTarget)
              )
                return;
              // Focus left the field by way of Undo: the typed text becomes a chip, as on blur.
              commit();
              setStopped(null);
            }}
            className="shrink-0 rounded font-medium text-a11y-accent hover:underline dark:text-blue-400"
          >
            {t`Undo`}
          </button>
        </span>
      )}
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
            className={`max-h-64 w-80 overflow-y-auto p-[5px] data-empty:hidden ${popupSurface} ${popupMotion}`}
          >
            <span id={hideHint} hidden>
              {t({
                message: "Press Fn-Delete to stop suggesting this address.",
                comment:
                  "Screen reader hint on a recipient suggestion. Fn-Delete is forward delete on a Mac keyboard (⌦ on a full keyboard); it hides the highlighted suggestion.",
              })}
            </span>
            <Combobox.List aria-label={t`${label} suggestions`}>
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
                  <Combobox.Item
                    key={text}
                    value={text}
                    aria-describedby={hideHint}
                    className={`group py-1 pr-1 ${itemClass}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{displayName(a)}</span>
                      <span className="block truncate text-footnote text-a11y-muted group-data-highlighted:text-white">
                        {a.address}
                      </span>
                    </span>
                    {/* Pointer only, so the option holds no control: keyboard users press forward Delete. */}
                    <span
                      aria-hidden
                      title={t`Stop suggesting ${a.address}`}
                      // Keep focus in the field and don't pick the row.
                      onPointerDown={(e) => e.preventDefault()}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        stopSuggesting(a);
                      }}
                      className={`rounded p-0.5 opacity-0 group-hover:opacity-80 group-data-highlighted:opacity-80 hover:bg-white/20 hover:opacity-100 coarse:opacity-80 ${touchIcon}`}
                    >
                      <X className="size-3.5" />
                    </span>
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
      label={t`Actions for ${address.address}`}
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
