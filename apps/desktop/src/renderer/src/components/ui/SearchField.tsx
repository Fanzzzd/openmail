import { Combobox } from "@base-ui/react/combobox";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import {
  SEARCH_OPERATORS,
  type Address,
  editSearchToken,
  modifySearchToken,
  negateSearchToken,
  searchDateSuggestions,
  searchTokenModifiers,
  searchValueSuggestions,
  searchValueTarget,
  searchFieldParts,
  selectSearchOperator,
  selectSearchDate,
  serializeSearchField,
} from "@openmail/core/schema";
import { Search, X } from "lucide-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { searchScopeAtom } from "../../state/ui";
import { labelsAtom, suggestionsAtom } from "../../state/queries";
import { listQueryAtom } from "../../state/threads";
import { DropdownMenu, MenuItem, MenuSeparator } from "./Menu";

import { Select } from "./Select";
import { itemClass, popupSurface } from "./styles";

const noContacts = Atom.make(AsyncResult.success<readonly Address[]>([]));

export function SearchField({
  value,
  onChange,
  inputRef,
}: {
  value: string;
  onChange: (text: string) => void;
  inputRef: Ref<HTMLInputElement>;
}) {
  const { t } = useLingui();
  const [scope, setScope] = useAtom(searchScopeAtom);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<string | undefined>();
  const fieldRef = useRef<HTMLInputElement>(null);
  useImperativeHandle<HTMLInputElement | null, HTMLInputElement | null>(
    inputRef,
    () => fieldRef.current,
  );
  const listQuery = useAtomValue(listQueryAtom);
  const labels = AsyncResult.getOrElse(useAtomValue(labelsAtom(listQuery?.accountIds)), () => []);
  const { chips, text, pending } = searchFieldParts(value);
  const target = searchValueTarget(pending);
  const addressTarget =
    target && ["from:", "to:", "cc:"].includes(target.operator.replace(/^-/, ""));
  const contactValue = addressTarget ? target.value.trim() : "";
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
  const dateTarget =
    target && ["before:", "after:"].includes(target.operator.replace(/^-/, "")) ? target : null;
  const dateLabels = { today: t`Today`, yesterday: t`Yesterday`, last7Days: t`Last 7 days` };
  const suggestions = [
    ...searchValueSuggestions(pending, contacts, labels),
    ...(dateTarget
      ? searchDateSuggestions(dateTarget.operator).map((item) => ({
          token: item.token,
          label: dateLabels[item.kind],
        }))
      : []),
    ...SEARCH_OPERATORS.filter(
      (item) => item.startsWith(pending.toLowerCase().replace(/^-/, "")) && !chips.includes(item),
    ).map((item) => ({ token: pending.startsWith("-") ? `-${item}` : item, label: item })),
  ];
  const items = suggestions.map((item) => item.token).filter((token) => !chips.includes(token));
  const byToken = new Map(suggestions.map((item) => [item.token, item.label]));
  const emit = (next: readonly string[], typed: string) =>
    onChange(serializeSearchField(next, typed));
  const replaceChip = (index: number, token: string) =>
    emit(
      chips.map((previous, i) => (i === index ? token : previous)),
      text,
    );
  const editChip = (index: number) => {
    onChange(editSearchToken(value, index));
    setOpen(false);
    requestAnimationFrame(() => fieldRef.current?.focus());
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
    <div className="no-drag flex min-w-0 max-w-[520px] flex-1 items-center gap-2">
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
          if (details.reason === "escape-key" || details.reason === "input-clear") return;
          if (details.reason === "item-press") {
            const item = next.find((token) => !chips.includes(token));
            if (item) {
              onChange(selectSearchOperator(value, item));
              setOpen(false);
            }
          } else emit(next, text);
        }}
        open={open && items.length > 0}
        onOpenChange={setOpen}
        autoHighlight={false}
        onItemHighlighted={(item) => setHighlighted(item)}
      >
        <Combobox.Chips className="focus-within:ring-2 focus-within:ring-a11y-focus flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-1 rounded-md border border-black/10 px-2 dark:border-white/10">
          <Search className="size-3.5 text-a11y-muted" />
          {chips.map((token, index) => (
            <Combobox.Chip
              key={`${index}:${token}`}
              className="flex max-w-48 items-center gap-1 rounded bg-blue-500/10 px-1 text-[12px]"
            >
              <DropdownMenu
                align="start"
                trigger={
                  <button type="button" aria-label={t`Modify ${token}`} className="truncate">
                    {token}
                  </button>
                }
              >
                <MenuItem onClick={() => editChip(index)}>{t`Edit token`}</MenuItem>
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
              </DropdownMenu>
              <Combobox.ChipRemove aria-label={t`Remove ${token}`}>
                <X className="size-3" />
              </Combobox.ChipRemove>
            </Combobox.Chip>
          ))}
          <Combobox.Input
            onKeyDown={(e) => {
              if (e.key === "Enter" && !(open && highlighted)) {
                e.preventDefault();
                onChange(`${value.trimEnd()} `);
                setOpen(false);
              }
            }}
            ref={fieldRef}
            aria-label={t`Search mail`}
            placeholder={t`Search  /`}
            className="h-6 min-w-16 flex-1 bg-transparent text-[13px] outline-none"
          />
        </Combobox.Chips>
        <Combobox.Portal>
          <Combobox.Positioner sideOffset={4} className="no-drag z-[60]">
            <Combobox.Popup className={`w-60 p-1 ${popupSurface}`}>
              <Combobox.List>
                {(item: string) => (
                  <Combobox.Item key={item} value={item} className={itemClass}>
                    {byToken.get(item) ?? item}
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
      {dateTarget && (
        <input
          type="date"
          aria-label={
            dateTarget.operator.replace(/^-/, "") === "before:" ? t`Before date` : t`After date`
          }
          className="w-32 rounded border border-black/10 bg-transparent px-1 text-[12px] dark:border-white/10"
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
      <Select
        aria-label={t`Search scope`}
        value={scope}
        onValueChange={setScope}
        options={[
          { value: "all", label: t`All Mail` },
          { value: "folder", label: t`Current folder` },
        ]}
      />
    </div>
  );
}
