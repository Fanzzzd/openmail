import { Popover } from "@base-ui/react/popover";
import type { ComponentProps, ReactElement, ReactNode } from "react";

import { itemClass, popupMotion, popupSurface } from "./styles";
import { Tip } from "./Tip";

type Side = ComponentProps<typeof Popover.Positioner>["side"];
type FinalFocus = ComponentProps<typeof Popover.Popup>["finalFocus"];

interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button that opens it, rendered by Popover.Trigger. */
  trigger: ReactElement;
  /** Tooltip on the trigger. */
  tip?: { label: string; shortcut?: string };
  side?: Side;
  finalFocus?: FinalFocus;
  className?: string;
  children: ReactNode;
}

/**
 * A panel anchored to a button, for filterable pickers. Escape and outside
 * clicks close it; focus starts in its first field.
 */
export function PickerPopover({
  open,
  onOpenChange,
  trigger,
  tip,
  side = "bottom",
  finalFocus,
  className = "w-60",
  children,
}: PopoverProps) {
  return (
    <Popover.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      {tip ? (
        <Tip label={tip.label} shortcut={tip.shortcut} side={side}>
          <Popover.Trigger render={trigger} />
        </Tip>
      ) : (
        <Popover.Trigger render={trigger} />
      )}
      <Popover.Portal>
        <Popover.Positioner side={side} align="start" sideOffset={6} className="z-[60]">
          <Popover.Popup
            finalFocus={finalFocus}
            className={`flex flex-col overflow-hidden ${popupSurface} ${popupMotion} ${className}`}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Search field at the top of a picker. */
export const pickerInput =
  "h-8 w-full shrink-0 border-b border-black/[0.07] bg-transparent px-3 text-[13px] outline-none placeholder:text-neutral-400 dark:border-white/[0.08]";

/** Footer button of a picker. */
export const pickerFooter =
  "block h-8 w-full shrink-0 border-t border-black/[0.07] px-3 text-left text-blue-600 outline-none hover:bg-black/[0.03] focus-visible:bg-black/[0.05] dark:border-white/[0.08] dark:text-blue-400 dark:hover:bg-white/5";

/** The list of a picker. */
export const pickerList = "max-h-64 overflow-y-auto p-[5px] empty:hidden";

/** One row in a picker list, with the macOS highlight. */
export const pickerItem = `group py-1 ${itemClass}`;
