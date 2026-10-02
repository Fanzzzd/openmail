import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import type { ReactNode } from "react";

import { itemClass, popupMotion, popupSurface } from "./styles";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Drawn before the label, in the button and in the list. */
  icon?: ReactNode;
}

interface Props<T extends string> {
  value: T;
  options: readonly SelectOption<T>[];
  onValueChange: (value: T) => void;
  "aria-label": string;
  disabled?: boolean;
  className?: string;
}

/**
 * A macOS pop-up button: the list opens over the button with the current
 * item under the pointer. When disabled it reads as plain text.
 */
export function Select<T extends string>({
  value,
  options,
  onValueChange,
  "aria-label": label,
  disabled,
  className = "",
}: Props<T>) {
  const current = options.find((o) => o.value === value);
  return (
    <BaseSelect.Root<T>
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      items={options.map((o) => ({ value: o.value, label: o.label }))}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        aria-label={label}
        className={`group flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 -mx-1.5 text-left outline-offset-0 outline-a11y-focus not-data-disabled:hover:bg-black/[0.04] focus-visible:outline-[3px] data-popup-open:bg-black/[0.06] dark:not-data-disabled:hover:bg-white/5 dark:data-popup-open:bg-white/10 ${className}`}
      >
        {current?.icon}
        <BaseSelect.Value className="min-w-0 truncate" />
        <BaseSelect.Icon className="shrink-0 text-a11y-muted group-data-disabled:hidden">
          <ChevronsUpDown className="size-3.5" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="z-[60] outline-none" sideOffset={4}>
          <BaseSelect.Popup
            className={`min-w-(--anchor-width) p-[5px] ${popupSurface} ${popupMotion}`}
          >
            <BaseSelect.List className="max-h-(--available-height) overflow-y-auto">
              {options.map((o) => (
                <BaseSelect.Item
                  key={o.value}
                  value={o.value}
                  label={o.label}
                  className={`group h-6 pr-3 ${itemClass}`}
                >
                  <BaseSelect.ItemIndicator className="flex size-3.5 shrink-0 items-center justify-center">
                    <Check className="size-3.5" />
                  </BaseSelect.ItemIndicator>
                  <span className="flex size-3.5 shrink-0 group-data-selected:hidden" />
                  {o.icon}
                  <BaseSelect.ItemText className="min-w-0 truncate">{o.label}</BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
