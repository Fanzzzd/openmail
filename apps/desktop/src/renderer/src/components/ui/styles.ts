/**
 * House styling shared by every Base UI popup. Popups portal to <body>, so
 * each surface opts out of the titlebar drag region itself (no-drag).
 */

/** Menus, pickers, selects: a light macOS-style panel, kept inside the window. */
export const popupSurface =
  "no-drag max-h-(--available-height) max-w-(--available-width) rounded-lg bg-white/95 text-[13px] text-neutral-900 shadow-[0_8px_24px_rgb(0_0_0/0.16)] ring-1 ring-black/10 outline-none backdrop-blur-xl dark:bg-[#2c2c2e]/95 dark:text-neutral-100 dark:shadow-[0_8px_24px_rgb(0_0_0/0.5)] dark:ring-white/10";

/** Scale-and-fade from the anchor. Off with reduced motion and for instant opens. */
export const popupMotion =
  "origin-(--transform-origin) transition-[opacity,scale] duration-100 ease-out data-ending-style:opacity-0 data-instant:transition-none data-starting-style:scale-[0.97] data-starting-style:opacity-0 motion-reduce:transition-none";

/** One row in a menu or list. The highlight is the macOS accent with white text. */
export const itemClass =
  "flex min-h-[22px] cursor-default items-center gap-2 rounded-[4px] px-2 outline-none select-none data-disabled:opacity-40 data-highlighted:bg-blue-600 data-highlighted:text-white";

/** Menu separator. */
export const separatorClass = "mx-2 my-1 h-px bg-black/10 dark:bg-white/10";

/** A borderless icon button in a header or toolbar. Callers add the text color. */
export const iconButton = "rounded-md p-1 hover:bg-black/5 dark:hover:bg-white/10";

/** Left padding that keeps a header at the window's leading edge clear of the traffic lights. */
export const trafficLightInset = "pl-20";
/** The same clearance for a header that starts after the 56 px sidebar rail: 56 + 24 = 80 px. */
export const railTrafficLightInset = "pl-6";

/** Keyboard shortcut next to a label. */
export const kbdClass =
  "font-sans text-[11px] tracking-wide text-neutral-600 tabular-nums group-data-highlighted:text-white dark:text-neutral-400";
