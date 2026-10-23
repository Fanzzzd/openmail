import { Switch as BaseSwitch } from "@base-ui/react/switch";

import { switchThumb, switchTrack } from "./styles";

interface Props {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  name?: string;
  /** Leave out when a <Field.Label> or a wrapping <label> names the switch. */
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  className?: string;
}

/**
 * An on/off switch for a setting that takes effect at once, as in System Settings. Space toggles
 * it. In a form or dialog that applies on a button, use a checkbox instead.
 */
export function Switch({
  id,
  checked,
  disabled,
  onCheckedChange,
  name,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
  className = "",
}: Props) {
  return (
    <BaseSwitch.Root
      id={id}
      checked={checked}
      disabled={disabled}
      name={name}
      onCheckedChange={(next) => onCheckedChange(next)}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`${switchTrack} ${className}`}
    >
      <BaseSwitch.Thumb className={switchThumb} />
    </BaseSwitch.Root>
  );
}
