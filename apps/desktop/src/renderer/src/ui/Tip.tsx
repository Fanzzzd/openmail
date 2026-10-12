import { Tooltip } from "@base-ui/react/tooltip";
import type { ComponentProps, ReactElement, ReactNode } from "react";

const DELAY_MS = 500;

/** One provider at the app root, so moving between tips skips the delay. */
export function TipProvider({ children }: { children: ReactNode }) {
  return <Tooltip.Provider delay={DELAY_MS}>{children}</Tooltip.Provider>;
}

interface Props {
  label: ReactNode;
  /** Shown after the label, for example "⌘N". Not translated. */
  shortcut?: string | undefined;
  side?: ComponentProps<typeof Tooltip.Positioner>["side"];
  /** The trigger. Icon-only triggers keep their own aria-label. */
  children: ReactElement;
}

/** A short tooltip with an optional keyboard shortcut. */
export function Tip({ label, shortcut, side = "bottom", children }: Props) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger delay={DELAY_MS} render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={6} className="z-[70]">
          <Tooltip.Popup className="no-drag flex max-w-72 items-center gap-2 rounded-control bg-white px-2 py-1 text-footnote text-neutral-700 shadow-[0_2px_8px_rgb(0_0_0/0.12)] ring-1 ring-edge transition-opacity duration-100 data-ending-style:opacity-0 data-instant:transition-none data-starting-style:opacity-0 motion-reduce:transition-none dark:bg-neutral-700 dark:text-neutral-100">
            <span>{label}</span>
            {shortcut && (
              <kbd className="rounded-item bg-fill-hover px-1 font-sans text-caption text-a11y-muted dark:text-neutral-300">
                {shortcut}
              </kbd>
            )}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
