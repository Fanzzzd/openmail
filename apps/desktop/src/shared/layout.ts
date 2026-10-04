/**
 * The narrowest width at which each pane's content stays readable, in CSS
 * pixels. The rail is the sidebar's icon column in the medium layout.
 */
export const PANE_MIN = { sidebar: 200, rail: 56, list: 300, reader: 340 } as const;

/** The sidebar docks only once the reader keeps 460 px beside it; below that the reader gets its room. */
export const WIDE_MIN = PANE_MIN.sidebar + PANE_MIN.list + 460;
/**
 * Two panes show once the rail, the list and the reader all fit at their
 * minimum widths. Tailwind's `sm` breakpoint is set to the same width in
 * styles.css, so `max-sm:` styles apply exactly in the narrow layout.
 */
export const MEDIUM_MIN = PANE_MIN.rail + PANE_MIN.list + PANE_MIN.reader;

/** Every window can shrink to this size; the main window shows one pane at a time there. */
export const WINDOW_MIN = { width: 480, height: 400 } as const;
