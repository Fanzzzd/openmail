import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";

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
      className="flex size-3.5 shrink-0 items-center justify-center rounded-[4px] bg-white shadow-[0_0.5px_1px_rgb(0_0_0/0.15)] ring-1 ring-black/20 outline-offset-1 outline-blue-500/60 focus-visible:outline-[3px] data-checked:bg-blue-500 data-checked:ring-blue-600 dark:bg-white/10 dark:ring-white/20 dark:data-checked:bg-blue-500 dark:data-checked:ring-blue-500"
    >
      <BaseCheckbox.Indicator className="text-white">
        <Check className="size-3" strokeWidth={3} />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
}
