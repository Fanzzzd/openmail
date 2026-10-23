import { NumberField as BaseNumberField } from "@base-ui/react/number-field";
import { ChevronDown, ChevronUp } from "lucide-react";

import { formInput, stepperBezel, stepperHalf } from "./styles";

interface Props {
  /** `null` is an empty field. */
  value: number | null;
  onValueChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
  /** Classes for the row that holds the field and the stepper, such as a width. */
  className?: string;
}

/**
 * A number field with a stepper beside it, like an NSTextField with an NSStepper. Typing, the
 * arrow keys and the stepper change the value. The stepper and the arrow keys stay within `min`
 * and `max`; typed text may go outside them, so the form's own check can explain what is wrong.
 * Digits are not grouped, so a byte count reads as typed.
 */
export function NumberField({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  id,
  name,
  disabled,
  required,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  className = "",
}: Props) {
  return (
    <BaseNumberField.Root
      id={id}
      name={name}
      value={value}
      onValueChange={(next) => onValueChange(next)}
      min={min}
      max={max}
      step={step}
      allowOutOfRange
      disabled={disabled}
      required={required}
      format={{ useGrouping: false, maximumFractionDigits: 20 }}
      className={`flex w-full items-center gap-1 ${className}`}
    >
      <BaseNumberField.Input
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        className={`min-w-0 flex-1 tabular-nums ${formInput}`}
      />
      <div className={stepperBezel}>
        <BaseNumberField.Increment tabIndex={-1} aria-hidden className={stepperHalf}>
          <ChevronUp className="size-2.5" strokeWidth={3} />
        </BaseNumberField.Increment>
        <span aria-hidden className="h-px bg-separator" />
        <BaseNumberField.Decrement tabIndex={-1} aria-hidden className={stepperHalf}>
          <ChevronDown className="size-2.5" strokeWidth={3} />
        </BaseNumberField.Decrement>
      </div>
    </BaseNumberField.Root>
  );
}
