import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import type { ReactNode } from "react";

import { checkboxBox } from "./styles";

interface Props {
  id?: string;
  checked: boolean;
  /** Mixed: some of the items it stands for are checked. Drawn as a dash; a click checks it. */
  indeterminate?: boolean;
  disabled?: boolean;
  /** `event` is the click or key event, for callers that read modifier keys. */
  onCheckedChange: (checked: boolean, event: Event) => void;
  /** Submitted with a form when checked. */
  name?: string;
  value?: string;
  /** Leave out when `label` or a wrapping <label> names the checkbox. */
  "aria-label"?: string;
  "aria-describedby"?: string;
  /**
   * The text beside the box. The whole label is the click target, as in AppKit. Without it the
   * caller supplies its own <label> around the box, or an `aria-label`.
   */
  label?: ReactNode;
  /** Classes for the label row when `label` is given, otherwise for the box. */
  className?: string;
}

/** The check and the dash, drawn for the 14 px box. */
function Mark() {
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      className="hidden size-3.5 group-data-checked:block group-data-indeterminate:block"
    >
      <path
        d="M3.6 7.3 6 9.6l4.4-5.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="group-data-indeterminate:hidden"
      />
      <rect
        x="3.5"
        y="6.1"
        width="7"
        height="1.8"
        rx="0.9"
        fill="currentColor"
        className="hidden group-data-indeterminate:block"
      />
    </svg>
  );
}

/**
 * macOS checkbox: a 14 px rounded box, accent-filled with a white check when checked and a dash
 * when mixed. It is a Base UI checkbox, so Space toggles it and a form receives `name`.
 */
export function Checkbox({
  id,
  checked,
  indeterminate,
  disabled,
  onCheckedChange,
  name,
  value,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  label,
  className = "",
}: Props) {
  const box = (
    <BaseCheckbox.Root
      id={id}
      checked={checked}
      indeterminate={indeterminate}
      disabled={disabled}
      name={name}
      value={value}
      onCheckedChange={(next, details) => onCheckedChange(next, details.event)}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      className={label === undefined ? `${checkboxBox} ${className}` : checkboxBox}
    >
      <Mark />
    </BaseCheckbox.Root>
  );
  if (label === undefined) return box;
  return (
    <label className={`flex items-center gap-2 has-data-disabled:text-a11y-muted ${className}`}>
      {box}
      <span className="min-w-0">{label}</span>
    </label>
  );
}
