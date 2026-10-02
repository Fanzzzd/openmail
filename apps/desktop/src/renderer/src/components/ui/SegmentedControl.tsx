import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { ReactNode } from "react";

export interface SegmentedOption<T> {
  value: T;
  label: ReactNode;
}

interface Props<T extends string | number> {
  options: readonly SegmentedOption<T>[];
  /** `null` selects nothing, for example while prefs are loading. */
  value: T | null;
  onValueChange: (value: T) => void;
  "aria-label": string;
  disabled?: boolean;
  className?: string;
}

/**
 * macOS-style segmented control for picking exactly one value. It is a Base UI
 * radio group: Tab focuses the selected segment, arrow keys move the selection.
 * Segments share one width, so the selection pill slides by whole segments.
 */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onValueChange,
  "aria-label": ariaLabel,
  disabled,
  className = "",
}: Props<T>) {
  const selected = options.findIndex((o) => o.value === value);
  return (
    <RadioGroup<T | null>
      aria-label={ariaLabel}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      disabled={disabled}
      className={`relative inline-grid grid-flow-col auto-cols-fr rounded-[7px] bg-black/[0.06] p-0.5 outline-offset-1 outline-a11y-focus has-focus-visible:outline-[3px] data-disabled:opacity-50 dark:bg-white/[0.07] dark:shadow-[inset_0_0_0_0.5px_rgb(255_255_255/0.06)] ${className}`}
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-y-0.5 left-0.5 rounded-[5px] bg-white shadow-[0_1px_1.5px_rgb(0_0_0/0.14),0_0_0_0.5px_rgb(0_0_0/0.06)] transition-transform duration-200 ease-[cubic-bezier(0.25,0.8,0.3,1)] motion-reduce:transition-none dark:bg-neutral-500/80 dark:shadow-[0_1px_1.5px_rgb(0_0_0/0.35),inset_0_0.5px_0_rgb(255_255_255/0.12)] ${
          selected < 0 ? "hidden" : ""
        }`}
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          transform: `translateX(${Math.max(selected, 0) * 100}%)`,
        }}
      />
      {options.map((option, i) => (
        <Radio.Root<T | null>
          key={option.value}
          value={option.value}
          className={`relative flex h-6 items-center justify-center rounded-[5px] px-3 text-[13px] whitespace-nowrap text-neutral-600 outline-none transition-colors duration-150 before:absolute before:inset-y-1.5 before:left-0 before:w-px before:bg-black/[0.12] before:transition-opacity motion-reduce:transition-none data-checked:text-neutral-900 data-unchecked:hover:text-neutral-900 data-unchecked:active:bg-black/[0.05] dark:text-neutral-300 dark:before:bg-white/[0.12] dark:data-checked:text-white dark:data-unchecked:hover:text-white dark:data-unchecked:active:bg-white/[0.06] ${
            i === 0 || i === selected || i - 1 === selected ? "before:opacity-0" : ""
          }`}
        >
          {option.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
