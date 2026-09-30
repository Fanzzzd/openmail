import { Autocomplete } from "@base-ui/react/autocomplete";
import { useState } from "react";
import { pickerInput, pickerItem, pickerList } from "./Picker";

/** Inline command list; the caller owns filtering and the selected command. */
export function CommandPicker({
  label,
  query,
  onQuery,
  items,
  onPick,
}: {
  label: string;
  query: string;
  onQuery: (query: string) => void;
  items: readonly { id: string; label: string }[];
  onPick: (id: string) => void;
}) {
  const [highlighted, setHighlighted] = useState<string | undefined>();
  return (
    <Autocomplete.Root
      items={items.map((item) => item.id)}
      filter={null}
      value={query}
      onValueChange={(value, details) => {
        if (details.reason === "item-press") onPick(value);
        else onQuery(value);
      }}
      onItemHighlighted={(id) => setHighlighted(id)}
      inline
      autoHighlight
    >
      <Autocomplete.Input
        autoFocus
        placeholder={label}
        aria-label={label}
        className={pickerInput}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (highlighted || items[0])) {
            e.preventDefault();
            onPick(highlighted ?? items[0]?.id ?? "");
          }
        }}
      />
      <Autocomplete.List className={pickerList}>
        {(id: string) => (
          <Autocomplete.Item key={id} value={id} className={pickerItem} onClick={() => onPick(id)}>
            {items.find((item) => item.id === id)?.label}
          </Autocomplete.Item>
        )}
      </Autocomplete.List>
    </Autocomplete.Root>
  );
}
