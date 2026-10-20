import { Combobox } from "@base-ui/react/combobox";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import {
  type Address,
  editSearchToken,
  modifySearchToken,
  negateSearchToken,
  searchDateSuggestions,
  searchTokenModifiers,
  searchValueTarget,
  searchFieldParts,
  selectSearchOperator,
  selectSearchDate,
  serializeSearchField,
  submittedSearchText,
} from "@openmail/core/schema";
import { Clock, Folder, Mails, Search, X } from "lucide-react";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  type FocusEvent,
  type KeyboardEvent,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { recentSearches, useRecentSearches } from "../../state/recent-searches";
import {
  contactLookup,
  operatorGroup,
  type SearchSuggestion,
  type SearchSuggestionGroup,
  searchSuggestions,
  suggestionFor,
  suggestionKeyAction,
} from "./search-suggestions";
import { openMailLink } from "../../state/desktop";
import { useRunMail } from "../../state/mail";
import { searchScopeAtom } from "../../state/ui";
import { labelsAtom, suggestionsAtom } from "../../state/queries";
import { listQueryAtom } from "../../state/threads";
import { DropdownMenu, MenuItem, MenuSeparator } from "../../ui/Menu";

import { useOpenSurface } from "../../ui/open-surfaces";
import { Select } from "../../ui/Select";
import { Tip } from "../../ui/Tip";
import { isTouchWeb } from "../../lib/platform";
import { primaryShortcutText } from "../../../../shared/shortcuts";
import { useShortcutSet } from "../../i18n/use-shortcut-text";
import { itemClass, popupOffset, popupSurface } from "../../ui/styles";
import { rememberSearchReturn } from "./search-return";

/** The operator reference on the docs site, opened in the default browser. */
const SEARCH_HELP_URL = "https://openmail-docs.vercel.app/docs/search-operators";

const noContacts = Atom.make(AsyncResult.success<readonly Address[]>([]));

/**
 * Base UI moves focus between chips with a plain focus(), which does not scroll
 * a partly visible chip into view in the row that scrolls sideways. React
 * focus events bubble, so this also covers the Modify button inside the chip.
 */
const revealOnFocus = (event: FocusEvent<HTMLElement>) =>
  event.currentTarget.scrollIntoView({ inline: "nearest", block: "nearest" });

/**
 * The chip catches Enter and Space as they bubble and moves focus to the input,
 * so the Modify button opens its menu here and the chip never sees the key.
 */
const openMenuOnKey = (event: KeyboardEvent<HTMLButtonElement>) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.click();
};

/**
 * Base UI's chip refocuses itself on any key it does not handle, Tab included, so Tab from a chip's
 * Modify or Remove button landed on the chip and the next Tab on the same button again. Skipping
 * its handler for Tab lets the browser move focus on, forward or back.
 */
const letTabMoveFocus = (event: KeyboardEvent<HTMLElement> & { preventBaseUIHandler(): void }) => {
  if (event.key === "Tab") event.preventBaseUIHandler();
};

export function SearchField({
  value,
  onChange,
  onEnterResults,
  inputRef,
}: {
  value: string;
  onChange: (text: string) => void;
  /** Asks for the results of the text that ran; see results-entry.ts for the rule. */
  onEnterResults: (search: string) => void;
  inputRef: Ref<HTMLInputElement>;
}) {
  const { t } = useLingui();
  const [scope, setScope] = useAtom(searchScopeAtom);
  // The hint follows the keymap: ⌥⌘F in the Mac sets, / in Gmail's.
  const shortcutSet = useShortcutSet();
  const searchKey = isTouchWeb() ? "" : primaryShortcutText(shortcutSet, "search");
  const scopeName = scope === "all" ? t`Search scope: All Mail` : t`Search scope: Current folder`;
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<string | undefined>();
  /** The text the last Enter ran, so a later key can tell the field has not changed since. */
  const [submitted, setSubmitted] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  useImperativeHandle<HTMLInputElement | null, HTMLInputElement | null>(
    inputRef,
    () => fieldRef.current,
  );
  const listQuery = useAtomValue(listQueryAtom);
  const labels = AsyncResult.getOrElse(useAtomValue(labelsAtom(listQuery?.accountIds)), () => []);
  const { chips, text, pending } = searchFieldParts(value);
  const target = searchValueTarget(pending);
  // A typed name offers from: and to:; a from:, to: or cc: value offers its people.
  const contactValue = contactLookup(pending);
  const contactKey = JSON.stringify([target?.operator, contactValue, listQuery?.accountIds]);
  const [lookupKey, setLookupKey] = useState<string | null>(null);
  useEffect(() => {
    const timer = contactValue ? setTimeout(() => setLookupKey(contactKey), 150) : undefined;
    return () => clearTimeout(timer);
  }, [contactKey, contactValue]);
  const contacts = AsyncResult.getOrElse(
    useAtomValue(
      contactValue && lookupKey === contactKey && listQuery?.accountIds?.length !== 0
        ? suggestionsAtom(contactValue, undefined, listQuery?.accountIds)
        : noContacts,
    ),
    () => [],
  );
  const dateTarget = target && operatorGroup(target.operator) === "dates" ? target : null;
  const dateLabels = { today: t`Today`, yesterday: t`Yesterday`, last7Days: t`Last 7 days` };
  const recents = useRecentSearches();
  const run = useRunMail();
  const removeHint = useId();
  const groups = searchSuggestions({
    value,
    recents,
    contacts,
    labels,
    dates: dateTarget
      ? searchDateSuggestions(dateTarget.operator).map((item) => ({
          token: item.token,
          label: dateLabels[item.kind],
        }))
      : [],
  });
  const byKey = new Map(groups.flatMap(({ items }) => items.map((item) => [item.key, item])));
  const items = groups.map((entry) => ({
    value: entry.group,
    items: entry.items.map((item) => item.key),
  }));
  // An empty field with no history shows one hint instead of a list of filters.
  const hint = !value.trim() && recents.length === 0;
  const shown = open && (items.length > 0 || hint);
  useOpenSurface(shown, () => setOpen(false));
  const groupNames: Record<SearchSuggestionGroup, string> = {
    recent: t`Recent`,
    people: t`People`,
    labels: t`Labels`,
    filters: t`Operators`,
    dates: t`Dates`,
  };
  const choose = (suggestion: SearchSuggestion) => {
    if (suggestion.kind === "clearRecent") {
      recentSearches.clear();
      return;
    }
    if (suggestion.kind === "recent") {
      recentSearches.add(suggestion.query);
      // Runs as Enter ran it, so a saved unfinished word stays a prefix.
      onChange(submittedSearchText(suggestion.query));
    } else onChange(selectSearchOperator(value, suggestion.token));
    setOpen(false);
  };
  const emit = (next: readonly string[], typed: string) =>
    onChange(serializeSearchField(next, typed));
  const replaceChip = (index: number, token: string) =>
    emit(
      chips.map((previous, i) => (i === index ? token : previous)),
      text,
    );
  // The chip's Remove button takes no Tab stop, so its menu offers the same; focus goes to the
  // input, as the chip and its menu are gone.
  const removeChip = (index: number) => {
    emit(
      chips.filter((_, i) => i !== index),
      text,
    );
    requestAnimationFrame(() => fieldRef.current?.focus());
  };
  const editChip = (index: number) => {
    onChange(editSearchToken(value, index));
    setOpen(false);
    requestAnimationFrame(() => fieldRef.current?.focus());
  };
  const submit = () => {
    recentSearches.add(value);
    // An unfinished word stays a prefix, as while typing.
    const ran = submittedSearchText(value);
    onChange(ran);
    setSubmitted(ran);
    setOpen(false);
    return ran;
  };
  const commitDate = (date: string) => {
    if (!dateTarget) return false;
    const next = selectSearchDate(value, dateTarget.operator, date);
    if (next === null) return false;
    onChange(next);
    setOpen(false);
    return true;
  };
  return (
    <div className="no-drag @container/search flex min-w-0 max-w-[520px] flex-1 items-center gap-2">
      <Combobox.Root<string, true>
        multiple
        value={chips}
        items={items}
        filter={null}
        inputValue={text}
        onInputValueChange={(next, details) => {
          if (details.reason === "input-change") emit(chips, next);
        }}
        onValueChange={(next, details) => {
          // With the popup closed, Base UI clears chips on Escape and stops the key. The window's
          // handler clears the search and hands focus back, so the key goes on to it. The open
          // state can still be on from typing with nothing to suggest; the emptied field would
          // then show its hint.
          if (details.reason === "escape-key") {
            details.allowPropagation();
            setOpen(false);
            return;
          }
          if (details.reason === "input-clear") return;
          if (details.reason === "item-press") {
            const key = next.find((token) => !chips.includes(token));
            const suggestion = key === undefined ? undefined : suggestionFor(byKey, key);
            if (suggestion) choose(suggestion);
          } else emit(next, text);
        }}
        open={shown}
        onOpenChange={setOpen}
        autoHighlight={false}
        onItemHighlighted={(item) => setHighlighted(item)}
      >
        {/* One line at any width: chips keep their width up to 12rem, then truncate. When they do not all fit, the row scrolls sideways. */}
        <Combobox.Chips
          aria-label={t`Search filters`}
          className="focus-within:ring-2 focus-within:ring-a11y-focus flex h-7 min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden rounded-control [scrollbar-width:none] border border-edge bg-fill-quiet px-2 transition-colors focus-within:bg-transparent motion-reduce:transition-none"
        >
          <Search className="size-3.5 shrink-0 text-a11y-muted" />
          {chips.map((token, index) => (
            <Combobox.Chip
              key={`${index}:${token}`}
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- Base UI renders the chip as a div; a fieldset would add a border and legend.
              role="group"
              aria-label={token}
              onFocus={revealOnFocus}
              onKeyDown={letTabMoveFocus}
              className="flex max-w-48 shrink-0 items-center gap-1 rounded-item bg-blue-500/10 px-1.5 text-footnote whitespace-nowrap text-blue-800 dark:bg-blue-400/15 dark:text-blue-200"
            >
              <DropdownMenu
                label={t`Modify ${token}`}
                align="start"
                trigger={
                  <button
                    type="button"
                    aria-label={t`Modify ${token}`}
                    title={token}
                    onKeyDown={openMenuOnKey}
                    className="min-w-0 truncate"
                  >
                    {token}
                  </button>
                }
              >
                <MenuItem onClick={() => editChip(index)}>
                  {t({
                    message: "Edit filter",
                    comment:
                      "Menu item on a search chip, such as from:bob, that puts its text back in the search field to edit.",
                  })}
                </MenuItem>
                <MenuItem onClick={() => replaceChip(index, negateSearchToken(token))}>
                  {token.startsWith("-") ? t`Include matches` : t`Exclude matches`}
                </MenuItem>
                {searchTokenModifiers(token).length > 0 && <MenuSeparator />}
                {searchTokenModifiers(token).map((modifier) => (
                  <MenuItem
                    key={modifier}
                    onClick={() => replaceChip(index, modifySearchToken(token, modifier))}
                  >
                    {modifier}:
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem onClick={() => removeChip(index)}>
                  {t({
                    message: "Remove filter",
                    comment:
                      "Menu item on a search chip, such as from:bob, that drops it from the search.",
                  })}
                </MenuItem>
              </DropdownMenu>
              <Combobox.ChipRemove aria-label={t`Remove ${token}`} className="shrink-0">
                <X className="size-3" />
              </Combobox.ChipRemove>
            </Combobox.Chip>
          ))}
          <Combobox.Input
            onFocus={(e) => rememberSearchReturn(e.relatedTarget, e.currentTarget.parentElement)}
            onKeyDown={(e) => {
              const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
              // The handoff to the results follows the rule in results-entry.ts. A second Enter asks
              // for them; Down does with no suggestions showing, after running the text as Enter
              // does. With suggestions showing, Down moves through them.
              const toResults =
                plain &&
                ((e.key === "Enter" && !open && submitted === value) ||
                  (e.key === "ArrowDown" && !shown && value.trim() !== ""));
              if (toResults) {
                e.preventDefault();
                e.preventBaseUIHandler();
                onEnterResults(submitted === value ? value : submit());
                return;
              }
              const active = open && highlighted !== undefined ? byKey.get(highlighted) : undefined;
              const action = suggestionKeyAction(e, e.currentTarget, active, open ? groups : []);
              if (!action) return;
              e.preventDefault();
              if (action.kind === "submit") submit();
              else if (action.kind === "complete") choose(action.suggestion);
              else recentSearches.remove(action.query);
            }}
            ref={fieldRef}
            aria-label={t`Search mail`}
            placeholder={chips.length ? undefined : searchKey ? t`Search  ${searchKey}` : t`Search`}
            className="h-6 min-w-24 flex-1 bg-transparent text-body text-ellipsis outline-none"
          />
        </Combobox.Chips>
        <Combobox.Portal>
          <Combobox.Positioner
            sideOffset={popupOffset}
            align="start"
            collisionPadding={8}
            className="no-drag z-[60]"
          >
            <Combobox.Popup className={`w-(--anchor-width) min-w-72 p-1 ${popupSurface}`}>
              {hint && (
                <Combobox.Empty className="flex items-center gap-2 px-2 py-1 text-footnote text-a11y-muted">
                  <span className="flex-1">{t`Try from:name or has:attachment`}</span>
                  <button
                    type="button"
                    // Keeps focus in the field so the popup stays put until the browser opens.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => run(openMailLink(SEARCH_HELP_URL))}
                    className="shrink-0 font-medium text-a11y-accent hover:underline dark:text-blue-400"
                  >
                    {t`Search help`}
                  </button>
                </Combobox.Empty>
              )}
              <span id={removeHint} hidden>
                {t({
                  message: "Press Fn-Delete to remove it from recent searches.",
                  comment:
                    "Screen reader hint on a recent search. Fn-Delete is forward delete on a Mac keyboard (⌦ on a full keyboard); it removes the highlighted recent search.",
                })}
              </span>
              <Combobox.List>
                {(group: { value: SearchSuggestionGroup; items: string[] }) => (
                  <Combobox.Group key={group.value} items={group.items} className="py-0.5">
                    <Combobox.GroupLabel className="px-2 pt-1 pb-0.5 text-caption font-semibold text-a11y-muted">
                      {groupNames[group.value]}
                    </Combobox.GroupLabel>
                    <Combobox.Collection>
                      {(key: string) => {
                        const item = byKey.get(key);
                        return item ? (
                          <Combobox.Item
                            key={key}
                            value={key}
                            aria-describedby={item.kind === "recent" ? removeHint : undefined}
                            className={`group ${itemClass}`}
                          >
                            <SuggestionRow
                              item={item}
                              onRemove={(query) => recentSearches.remove(query)}
                            />
                          </Combobox.Item>
                        ) : null;
                      }}
                    </Combobox.Collection>
                  </Combobox.Group>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
      {value && (
        <Tip label={t`Clear search`}>
          <button
            type="button"
            aria-label={t`Clear search`}
            onClick={() => {
              onChange("");
              fieldRef.current?.focus();
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded-full text-a11y-muted hover:bg-fill-hover"
          >
            <X className="size-3.5" />
          </button>
        </Tip>
      )}
      {dateTarget && (
        <input
          type="date"
          aria-label={
            dateTarget.operator.replace(/^-/, "") === "before:" ? t`Before date` : t`After date`
          }
          className="w-32 rounded-item border border-edge bg-transparent px-1 text-footnote"
          min="1970-01-01"
          max="9999-12-31"
          onBlur={(event) => commitDate(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            event.stopPropagation();
            if (commitDate(event.currentTarget.value))
              requestAnimationFrame(() => fieldRef.current?.focus());
          }}
        />
      )}
      {/* Icon only at every width, so the scope never reads as the folder in the title. */}
      <Tip label={scopeName}>
        <span className="flex shrink-0">
          <Select
            aria-label={scopeName}
            value={scope}
            onValueChange={setScope}
            className="shrink-0"
            valueClassName="sr-only"
            options={[
              { value: "all", label: t`All Mail`, icon: <Mails className="size-3.5 shrink-0" /> },
              {
                value: "folder",
                label: t`Current folder`,
                icon: <Folder className="size-3.5 shrink-0" />,
              },
            ]}
          />
        </span>
      </Tip>
    </div>
  );
}

/** One suggestion: a recent query, a person, a label, or a filter with what it does. */
function SuggestionRow({
  item,
  onRemove,
}: {
  item: SearchSuggestion;
  onRemove: (query: string) => void;
}) {
  const { t, i18n } = useLingui();
  if (item.kind === "clearRecent")
    return (
      <span className="text-a11y-accent group-data-highlighted:text-white">{t`Clear recent searches`}</span>
    );
  if (item.kind === "recent")
    return (
      <>
        <Clock className="size-3.5 shrink-0 opacity-60" />
        <span className="min-w-0 flex-1 truncate">{item.query}</span>
        {/* Pointer only: keyboard users press Delete on the highlighted row. */}
        <span
          aria-hidden
          title={t`Remove from recent searches`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemove(item.query);
          }}
          className="shrink-0 rounded-item p-0.5 opacity-0 group-data-highlighted:opacity-100 hover:bg-white/20 coarse:p-2.5 coarse:opacity-70"
        >
          <X className="size-3" />
        </span>
      </>
    );
  return (
    <>
      {/* The name keeps its width up to the whole row; the detail truncates in what is left. */}
      <span className="max-w-full min-w-0 shrink-0 truncate">{item.label}</span>
      {(item.description || item.detail) && (
        <span className="min-w-0 flex-1 truncate text-footnote opacity-70">
          {item.description ? i18n._(item.description) : item.detail}
        </span>
      )}
    </>
  );
}
