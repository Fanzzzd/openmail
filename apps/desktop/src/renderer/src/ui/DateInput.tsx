import type { FocusEventHandler, KeyboardEventHandler } from "react";

import { formInput } from "./styles";

const variants = {
  /** A full-width form field. */
  field: formInput,
  /** Sized to its content, for a time or two on one line. */
  compact:
    "rounded-control border border-control bg-white px-1.5 py-0.5 text-body tabular-nums shadow-[inset_0_0.5px_1px_rgb(0_0_0/0.07)] outline-offset-0 outline-a11y-focus focus:border-transparent focus:outline-2 disabled:opacity-50 dark:bg-white/[0.05]",
  /** Inside another field, such as a search token. */
  inline:
    "rounded-item border border-edge bg-transparent px-1 text-footnote outline-offset-0 outline-a11y-focus focus:outline-2",
} as const;

/**
 * A date, a time, or both, with the system's own picker. The field follows the app's light or
 * dark appearance, so the digits and the calendar button stay readable in both.
 */
export function DateInput({
  type,
  value,
  onValueChange,
  variant = "field",
  className = "",
  ...rest
}: {
  type: "date" | "time" | "datetime-local";
  /** The input's value in its HTML format; omit for an uncontrolled field. */
  value?: string;
  onValueChange?: (value: string) => void;
  variant?: keyof typeof variants;
  className?: string;
  id?: string;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={onValueChange && ((event) => onValueChange(event.target.value))}
      className={`scheme-light tabular-nums dark:scheme-dark [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:hover:opacity-100 ${variants[variant]} ${className}`}
      {...rest}
    />
  );
}
