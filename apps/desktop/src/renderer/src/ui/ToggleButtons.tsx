import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { ReactNode } from "react";

interface Option<T extends string> {
  value: T;
  label: ReactNode;
  /** The full name, for a short label such as "M" for Monday. */
  "aria-label"?: string;
}

/**
 * A row of buttons where any number can be on, like the weekday picker in Calendar's custom
 * repeat. Each is a toggle button (aria-pressed); the arrow keys move between them.
 */
export function ToggleButtons<T extends string>({
  options,
  value,
  onValueChange,
  "aria-label": ariaLabel,
  disabled,
  className = "",
}: {
  options: readonly Option<T>[];
  value: readonly T[];
  onValueChange: (value: T[]) => void;
  "aria-label": string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <ToggleGroup
      multiple
      aria-label={ariaLabel}
      value={[...value]}
      onValueChange={(next) =>
        onValueChange(options.filter((o) => next.includes(o.value)).map((o) => o.value))
      }
      disabled={disabled}
      className={`inline-flex rounded-control bg-white p-px shadow-control ring-1 ring-edge data-disabled:opacity-50 dark:bg-white/[0.08] ${className}`}
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          aria-label={option["aria-label"]}
          className="h-[26px] min-w-9 rounded-[5px] px-2 text-body text-neutral-700 outline-offset-1 outline-a11y-focus transition-colors duration-100 focus-visible:outline-2 not-data-disabled:hover:bg-fill-hover not-data-disabled:active:bg-fill-pressed data-pressed:bg-blue-600 data-pressed:text-white not-data-disabled:data-pressed:hover:bg-blue-600 not-data-disabled:data-pressed:active:bg-blue-700 motion-reduce:transition-none dark:text-neutral-200"
        >
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
