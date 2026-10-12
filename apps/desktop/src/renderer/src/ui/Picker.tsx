import { useLingui } from "@lingui/react/macro";
import { Popover } from "@base-ui/react/popover";
import type { ComponentProps, ReactElement, ReactNode } from "react";

import { itemClass, popupMotion, popupSurface } from "./styles";
import { Tip } from "./Tip";

type Side = ComponentProps<typeof Popover.Positioner>["side"];
type FinalFocus = ComponentProps<typeof Popover.Popup>["finalFocus"];

interface PopoverProps {
  "aria-label": string;
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
  "aria-label": label,
  open,
  onOpenChange,
  trigger,
  tip,
  side = "bottom",
  finalFocus,
  className = "w-60",
  children,
}: PopoverProps) {
  const { t } = useLingui();
  return (
    <Popover.Root modal="trap-focus" open={open} onOpenChange={(next) => onOpenChange(next)}>
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
            aria-label={label}
            finalFocus={finalFocus}
            className={`focus-within:ring-2 focus-within:ring-a11y-focus flex flex-col overflow-hidden ${popupSurface} ${popupMotion} ${className}`}
          >
            {children}
            <Popover.Close className="sr-only focus:not-sr-only focus:p-2">{t`Close`}</Popover.Close>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Search field at the top of a picker. */
export const pickerInput =
  "h-8 w-full shrink-0 border-b border-separator bg-transparent px-3 text-body outline-none placeholder:text-a11y-muted";

/** Footer button of a picker. */
export const pickerFooter =
  "block h-8 w-full shrink-0 border-t border-separator px-3 text-left text-a11y-accent outline-none hover:bg-fill-hover focus-visible:bg-black/[0.05] dark:text-blue-400";

/** The list of a picker. */
export const pickerList = "max-h-64 overflow-y-auto p-[5px] empty:hidden";

/** One row in a picker list, with the macOS highlight. */
export const pickerItem = `group py-1 ${itemClass}`;
