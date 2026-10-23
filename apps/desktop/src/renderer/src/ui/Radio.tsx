import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { useId, type ReactNode } from "react";

import { choiceRow, radioCircle, settingsHint } from "./styles";

/**
 * A group of radio buttons. Tab reaches the chosen one and the arrow keys move the choice.
 * `null` chooses nothing, for example while the current value loads.
 */
export function RadioGroup<T extends string>({
  value,
  onValueChange,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  disabled,
  className = "",
  children,
}: {
  value: T | null;
  onValueChange: (value: T) => void;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <BaseRadioGroup<T | null>
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      disabled={disabled}
      className={className}
    >
      {children}
    </BaseRadioGroup>
  );
}

/** The 14 px circle with its white dot. `checked` and `disabled` come from the radio's state. */
function Circle({ checked, disabled }: { checked: boolean; disabled: boolean }) {
  return (
    <span
      aria-hidden
      data-checked={checked ? "" : undefined}
      data-unchecked={checked ? undefined : ""}
      data-disabled={disabled ? "" : undefined}
      className={radioCircle}
    >
      <span className="hidden size-1.5 rounded-full bg-white group-data-checked:block" />
    </span>
  );
}

/** A radio button with its label beside it, as in an AppKit form. The label is the click target. */
export function Radio({
  value,
  label,
  hint,
  disabled,
}: {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <BaseRadio.Root
      value={value}
      disabled={disabled}
      aria-labelledby={`${id}-label`}
      aria-describedby={hint ? `${id}-hint` : undefined}
      className="group/radio flex w-fit cursor-default items-start gap-2 rounded-item text-left outline-offset-2 outline-a11y-focus focus-visible:outline-2 data-disabled:text-a11y-muted"
      render={(props, state) => (
        <span {...props}>
          <span className="mt-px flex">
            <Circle checked={state.checked} disabled={state.disabled} />
          </span>
          <span className="min-w-0">
            <span id={`${id}-label`} className="block">
              {label}
            </span>
            {hint && (
              <span id={`${id}-hint`} className={`mt-0.5 block ${settingsHint}`}>
                {hint}
              </span>
            )}
          </span>
        </span>
      )}
    />
  );
}

/** A full-row choice: a card with the circle, a title and a line of detail. */
export function RadioCard({
  value,
  label,
  hint,
  hintClassName = settingsHint,
}: {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
  /** The detail line's type style. */
  hintClassName?: string;
}) {
  const id = useId();
  return (
    <BaseRadio.Root
      value={value}
      aria-labelledby={`${id}-label`}
      aria-describedby={hint ? `${id}-hint` : undefined}
      className={choiceRow}
      render={(props, state) => (
        <span {...props}>
          <span className="mt-[3px] flex">
            <Circle checked={state.checked} disabled={state.disabled} />
          </span>
          <span className="min-w-0">
            <span id={`${id}-label`} className="block font-medium">
              {label}
            </span>
            {hint && (
              <span id={`${id}-hint`} className={`mt-0.5 block ${hintClassName}`}>
                {hint}
              </span>
            )}
          </span>
        </span>
      )}
    />
  );
}

/**
 * A radio drawn by the caller, such as a color swatch or an emoji tile. Style the chosen one with
 * `data-checked:`; name it with `aria-label` when it shows no text.
 */
export function RadioTile({
  value,
  className,
  "aria-label": ariaLabel,
  children,
}: {
  value: string;
  className: string;
  "aria-label"?: string;
  children?: ReactNode;
}) {
  return (
    <BaseRadio.Root value={value} aria-label={ariaLabel} className={className}>
      {children}
    </BaseRadio.Root>
  );
}
