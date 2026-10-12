import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A summary that shows and hides more content. The button is a real button
 * with aria-expanded, so Enter and Space toggle it. The panel slides open on
 * click only, and not at all with reduced motion.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className = "",
  summaryClassName = "",
  panelClassName = "",
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  summaryClassName?: string;
  panelClassName?: string;
}) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className={className}>
      <Collapsible.Trigger
        className={`group -ml-1 inline-flex max-w-full items-center gap-1 rounded-md py-0.5 pr-1.5 pl-1 text-left outline-offset-1 outline-a11y-focus hover:bg-black/[0.04] focus-visible:outline-2 active:bg-black/[0.07] dark:hover:bg-white/5 dark:active:bg-white/10 ${summaryClassName}`}
      >
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 text-a11y-muted transition-transform duration-150 ease-out group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="min-w-0">{summary}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
        <div className={`pt-2 ${panelClassName}`}>{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
