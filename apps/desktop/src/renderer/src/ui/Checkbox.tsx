import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";
import { checkboxBox } from "./styles";

interface Props {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Leave out when a wrapping <label> names the checkbox. */
  "aria-label"?: string;
}

/** macOS-style checkbox: a small rounded square, accent-filled when checked. */
export function Checkbox({ id, checked, disabled, onCheckedChange, "aria-label": label }: Props) {
  return (
    <BaseCheckbox.Root
      id={id}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(next) => onCheckedChange(next)}
      aria-label={label}
      className={checkboxBox}
    >
      <BaseCheckbox.Indicator className="text-white">
        <Check className="size-3" strokeWidth={3} />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
}
