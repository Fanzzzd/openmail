import { Separator } from "react-resizable-panels";

/**
 * The line between two panes. It draws the 1 px border the panes used to
 * carry themselves; the group's resizeTargetMinimumSize widens what the
 * pointer can grab without widening the line.
 */
export function ResizeHandle() {
  return (
    <Separator className="no-drag w-px bg-black/5 transition-colors outline-none data-[separator=active]:bg-blue-500 data-[separator=focus]:bg-blue-500 data-[separator=hover]:bg-blue-500/60 dark:bg-white/5" />
  );
}
