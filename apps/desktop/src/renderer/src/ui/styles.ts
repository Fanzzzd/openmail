/**
 * Class recipes shared across the renderer. They use the tokens in styles.css
 * (surface, raised, overlay, separator, edge, control, fill-*, rounded-sheet …
 * rounded-item, shadow-control/popup/sheet, text-caption … text-title), so a
 * surface changes in one place. Popups portal to <body>, so each surface opts
 * out of the titlebar drag region itself (no-drag).
 */

/**
 * Menus, pickers, selects and popovers: an opaque panel kept inside the window. Opaque because
 * the sidebar behind a popup is transparent, and blur there let its text read through.
 */
export const popupSurface =
  "no-drag max-h-(--available-height) max-w-(--available-width) rounded-card bg-overlay text-body text-neutral-900 shadow-popup outline-none dark:text-neutral-100";

/** Scale-and-fade from the anchor. Off with reduced motion and for instant opens. */
export const popupMotion =
  "origin-(--transform-origin) transition-[opacity,scale] duration-100 ease-out data-ending-style:opacity-0 data-instant:transition-none data-starting-style:scale-[0.97] data-starting-style:opacity-0 motion-reduce:transition-none";

/** Every popup that drops from a trigger leaves this gap below it. */
export const popupOffset = 4;

/**
 * A 44 px touch target (Apple's minimum) on a phone or tablet in the web build
 * (the `coarse` variant in styles.css). Desktop sizes don't change.
 */
export const touchTarget = "coarse:min-h-11 coarse:min-w-11";
/** The same for an icon-only button: the icon stays centred in the larger box. */
export const touchIcon = `coarse:inline-grid coarse:place-items-center ${touchTarget}`;

/** One row in a menu or list. The highlight is the macOS accent with white text. */
export const itemClass =
  "flex min-h-[22px] coarse:min-h-11 cursor-default items-center gap-2 rounded-item px-2 outline-none select-none data-disabled:opacity-40 data-highlighted:bg-blue-600 data-highlighted:text-white";

/** Menu separator. */
export const separatorClass = "mx-2 my-1 h-px bg-separator";

/** A borderless icon button in a header or toolbar. Callers add the text color. */
export const iconButton = `rounded-control p-1 ${touchIcon} transition-colors duration-100 hover:bg-fill-hover active:bg-fill-pressed motion-reduce:transition-none`;

/**
 * The first row of every window: the 52 px row main centres the traffic
 * lights in (TITLEBAR_HEIGHT). It drags the window; start it with
 * <TrafficLightSpace/> wherever the lights can sit over it. In the web build
 * the first such row of a pane also clears the phone's status bar and notch
 * (the safe-area inset); a second row, such as the list's title under its
 * search field, stays 52 px.
 */
export const titlebarRow =
  "drag flex h-13 shrink-0 items-center web:first:h-[calc(3.25rem+env(safe-area-inset-top))] web:first:pt-[env(safe-area-inset-top)]";

/** Keyboard shortcut next to a label. */
export const kbdClass =
  "font-sans text-caption tracking-wide text-neutral-600 tabular-nums group-data-highlighted:text-white dark:text-neutral-400";

/**
 * Push buttons. One size (28 px), the control radius, the shared focus ring
 * and a pressed state.
 */
const buttonBase =
  "inline-flex h-7 coarse:min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-control px-3 text-body font-medium outline-offset-1 outline-a11y-focus transition-colors duration-100 focus-visible:outline-[3px] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none";
export const buttonSecondary = `${buttonBase} bg-white text-neutral-900 shadow-control ring-1 ring-edge hover:bg-neutral-50 active:bg-neutral-100 dark:bg-white/[0.08] dark:text-neutral-100 dark:hover:bg-white/[0.12] dark:active:bg-white/[0.16]`;
export const buttonPrimary = `${buttonBase} bg-blue-600 text-white shadow-control hover:bg-blue-700 active:bg-blue-800`;
export const buttonDanger = `${buttonBase} bg-red-600 text-white shadow-control outline-red-500/60 hover:bg-red-700 active:bg-red-800`;
/** A text-only action, such as "Sign in again" in a notice or "Remove" in a row. */
export const buttonLink =
  "rounded-item font-medium text-a11y-accent outline-offset-1 outline-a11y-focus hover:underline focus-visible:outline-2 disabled:opacity-50";

/**
 * A single-line or multi-line text field, like an NSTextField: a 1 px boundary at the 3:1 control
 * token, a faint inner shadow along the top edge, and the focus ring in place of the border.
 */
export const formInput =
  "w-full rounded-control border border-control bg-white px-2 py-1 text-body shadow-[inset_0_0.5px_1px_rgb(0_0_0/0.07)] outline-offset-0 outline-a11y-focus placeholder:text-a11y-muted focus:border-transparent focus:outline-2 disabled:opacity-50 dark:bg-white/[0.05] dark:shadow-[inset_0_0.5px_0_rgb(255_255_255/0.04)]";

/**
 * Checkbox box and radio button, 14 px like the AppKit regular size. Unchecked is a white bezel
 * with the 3:1 boundary and an inner shadow under its top edge. The boundary is drawn inside the
 * box, so a container that clips its overflow never cuts it. Checked fills with the accent, with
 * a slight top-to-bottom gradient as in AppKit, and draws a white mark. Pressing darkens either.
 * The `group` on the root lets the mark inside read the state.
 */
const toggleBase =
  "group relative inline-flex size-3.5 shrink-0 items-center justify-center bg-white text-white shadow-[inset_0_1px_1px_rgb(0_0_0/0.06)] ring-1 ring-control ring-inset outline-offset-2 outline-a11y-focus transition-[background-color,box-shadow] duration-100 focus-visible:outline-2 not-data-disabled:active:bg-neutral-100 data-disabled:opacity-50 motion-reduce:transition-none dark:bg-white/[0.08] dark:shadow-[inset_0_0.5px_0_rgb(255_255_255/0.06)] dark:not-data-disabled:active:bg-white/[0.16]";
export const checkboxBox = `${toggleBase} rounded-[3.5px] data-checked:bg-linear-to-b data-checked:from-blue-500 data-checked:to-blue-600 data-checked:shadow-[inset_0_0.5px_0_rgb(255_255_255/0.25)] data-checked:ring-blue-600 data-checked:not-data-disabled:active:from-blue-600 data-checked:not-data-disabled:active:to-blue-700 dark:data-checked:ring-blue-500 data-indeterminate:bg-linear-to-b data-indeterminate:from-blue-500 data-indeterminate:to-blue-600 data-indeterminate:shadow-[inset_0_0.5px_0_rgb(255_255_255/0.25)] data-indeterminate:ring-blue-600 data-indeterminate:not-data-disabled:active:from-blue-600 data-indeterminate:not-data-disabled:active:to-blue-700 dark:data-indeterminate:ring-blue-500`;
export const radioCircle = `${toggleBase} rounded-full data-checked:bg-linear-to-b data-checked:from-blue-500 data-checked:to-blue-600 data-checked:shadow-[inset_0_0.5px_0_rgb(255_255_255/0.25)] data-checked:ring-blue-600 data-checked:not-data-disabled:active:from-blue-600 data-checked:not-data-disabled:active:to-blue-700 dark:data-checked:ring-blue-500`;
/** A full-row radio: a card that tints when chosen. The circle inside is its 3:1 boundary. */
export const choiceRow =
  "group/choice flex w-full cursor-default gap-2.5 rounded-card px-3 py-2 text-left ring-1 ring-edge outline-offset-1 outline-a11y-focus transition-colors duration-100 hover:bg-fill-hover focus-visible:outline-2 data-checked:bg-blue-600/[0.06] data-checked:ring-blue-600/40 data-disabled:opacity-50 motion-reduce:transition-none dark:data-checked:bg-blue-500/[0.1] dark:data-checked:ring-blue-400/40";

/**
 * An on/off switch at the size System Settings uses (26 by 15 px). The knob stretches while it is
 * pressed, as in AppKit. On a phone or tablet in the web build it grows to the iOS size.
 */
export const switchTrack =
  "group inline-flex h-[15px] w-[26px] shrink-0 items-center rounded-full bg-black/[0.12] p-px shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.06)] outline-offset-2 outline-a11y-focus transition-colors duration-150 focus-visible:outline-2 data-checked:bg-blue-600 data-disabled:opacity-50 motion-reduce:transition-none coarse:h-[31px] coarse:w-[51px] coarse:p-0.5 dark:bg-white/[0.18] dark:shadow-[inset_0_0_0_0.5px_rgb(255_255_255/0.06)] dark:data-checked:bg-blue-600";
export const switchThumb =
  "h-[13px] w-[13px] rounded-full bg-white shadow-[0_0_0_0.5px_rgb(0_0_0/0.06),0_1px_2px_rgb(0_0_0/0.22)] transition-[translate,width] duration-150 ease-out group-not-data-disabled:group-active:w-4 data-checked:translate-x-[11px] group-not-data-disabled:group-active:data-checked:translate-x-2 motion-reduce:transition-none coarse:size-[27px] coarse:data-checked:translate-x-5 coarse:group-active:w-[27px] coarse:group-active:data-checked:translate-x-5 dark:bg-neutral-100";

/**
 * A pop-up button in a form: the push button bezel with the accent chevron box AppKit draws at its
 * trailing edge. The box turns grey when the control is disabled.
 */
export const popUpField =
  "h-7 justify-between gap-2 rounded-control bg-white pr-1 pl-2.5 shadow-control ring-1 ring-edge outline-offset-1 not-data-disabled:hover:bg-neutral-50 not-data-disabled:active:bg-neutral-100 focus-visible:outline-2 data-disabled:opacity-50 data-popup-open:bg-neutral-100 dark:bg-white/[0.08] dark:not-data-disabled:hover:bg-white/[0.12] dark:not-data-disabled:active:bg-white/[0.16] dark:data-popup-open:bg-white/[0.16]";
export const popUpChevrons =
  "flex size-[17px] shrink-0 items-center justify-center rounded-[4px] bg-linear-to-b from-blue-500 to-blue-600 text-white shadow-[inset_0_0.5px_0_rgb(255_255_255/0.25)] group-data-disabled:from-neutral-400 group-data-disabled:to-neutral-400";

/** The stepper beside a number field: two halves of one small bezel, like NSStepper. */
export const stepperBezel =
  "flex h-7 w-4 shrink-0 flex-col overflow-hidden rounded-[5px] bg-white shadow-control ring-1 ring-edge dark:bg-white/[0.08]";
export const stepperHalf =
  "flex flex-1 items-center justify-center text-neutral-600 outline-none not-disabled:active:bg-fill-pressed disabled:opacity-40 dark:text-neutral-300";

/** A group of setting rows, like a macOS System Settings box. */
export const settingsGroup =
  "divide-y divide-separator rounded-card bg-raised ring-1 ring-edge dark:bg-white/[0.03]";
/** The title above a settings group. */
export const settingsHeading = "mb-1.5 px-1 text-footnote font-semibold text-a11y-muted";
/** A hint under a setting or a group. */
export const settingsHint = "text-footnote text-a11y-muted";

/** Compact status line: icon, one line of text, an action. Tones below. */
export const noticeRow =
  "flex min-h-8 min-w-0 items-center gap-1.5 rounded-card px-2 py-1.5 text-footnote leading-4";
export const noticeTone = {
  neutral: "bg-fill-quiet text-a11y-muted",
  danger: "bg-red-500/[0.07] text-red-700 dark:bg-red-400/[0.09] dark:text-red-300",
  warning: "bg-orange-500/[0.08] text-orange-800 dark:bg-orange-400/[0.09] dark:text-orange-300",
} as const;
