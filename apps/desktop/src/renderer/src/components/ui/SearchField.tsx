import { Combobox } from "@base-ui/react/combobox";
import { useAtom } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import {
  SEARCH_OPERATORS,
  searchFieldParts,
  selectSearchOperator,
  serializeSearchField,
} from "@openmail/core/schema";
import { Search, X } from "lucide-react";
import { type Ref, useState } from "react";
import { searchScopeAtom } from "../../state/ui";
import { Select } from "./Select";
import { itemClass, popupSurface } from "./styles";

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
  const { chips, text, pending } = searchFieldParts(value);
  const items = SEARCH_OPERATORS.filter(
    (item) => item.startsWith(pending.toLowerCase()) && !chips.includes(item),
  );
  const emit = (next: readonly string[], typed: string) =>
    onChange(serializeSearchField(next, typed));
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
        <Combobox.Chips className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-1 rounded-md border border-black/10 px-2 dark:border-white/10">
          <Search className="size-3.5 text-neutral-400" />
          {chips.map((token, index) => (
            <Combobox.Chip
              key={`${index}:${token}`}
              className="flex max-w-48 items-center gap-1 rounded bg-blue-500/10 px-1 text-[12px]"
            >
              <span className="truncate">{token}</span>
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
            onBlur={() => {
              if (value) onChange(`${value.trimEnd()} `);
            }}
            ref={inputRef}
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
                    {item}
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
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
