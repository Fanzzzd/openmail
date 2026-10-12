import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import type { ReactNode } from "react";

import { itemClass, popupMotion, popupOffset, popupSurface } from "./styles";

interface SelectOption<T extends string> {
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
  /** For a visible <label htmlFor>; clicking that label then reaches the control. */
  id?: string;
  disabled?: boolean;
  className?: string;
  /** Classes for the current label in the button, e.g. to hide it in a narrow container. */
  valueClassName?: string;
  /**
   * "inline" is a borderless pop-up button for toolbars and setting rows.
   * "field" is a full-width control with the 3:1 control boundary, like text inputs in forms.
   */
  variant?: "inline" | "field";
}

const triggerStyles = {
  inline:
    "h-7 gap-2 rounded-control px-1.5 -mx-1.5 outline-offset-0 not-data-disabled:hover:bg-fill-hover focus-visible:outline-[3px] data-popup-open:bg-fill-pressed",
  field:
    "h-7 w-full justify-between gap-2 rounded-control bg-white px-2.5 shadow-control ring-1 ring-control outline-offset-1 not-data-disabled:hover:bg-neutral-50 focus-visible:outline-2 data-disabled:opacity-50 data-popup-open:ring-blue-600/60 dark:bg-white/[0.08] dark:not-data-disabled:hover:bg-white/[0.12]",
} as const;

/**
 * A pop-up button. The list drops below the button, start-aligned and at least
 * as wide, like every other popup in the app; opening it over the button hid
 * the label and looked misplaced next to fields. Inline, when disabled it
 * reads as plain text.
 */
export function Select<T extends string>({
  value,
  options,
  onValueChange,
  "aria-label": label,
  id,
  disabled,
  className = "",
  valueClassName = "",
  variant = "inline",
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
        id={id}
        aria-label={label}
        className={`group flex min-w-0 coarse:min-h-10 items-center text-left outline-a11y-focus ${triggerStyles[variant]} ${className}`}
      >
        {current?.icon}
        <BaseSelect.Value
          className={`min-w-0 truncate ${variant === "field" ? "flex-1" : ""} ${valueClassName}`}
        />
        <BaseSelect.Icon
          className={`shrink-0 text-a11y-muted ${variant === "inline" ? "group-data-disabled:hidden" : ""}`}
        >
          <ChevronsUpDown className="size-3.5" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          className="z-[60] outline-none"
          alignItemWithTrigger={false}
          align="start"
          sideOffset={popupOffset}
        >
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
