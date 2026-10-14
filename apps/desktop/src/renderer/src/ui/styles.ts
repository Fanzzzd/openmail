/**
 * Class recipes shared across the renderer. They use the tokens in styles.css
 * (surface, raised, overlay, separator, edge, control, fill-*, rounded-sheet …
 * rounded-item, shadow-control/popup/sheet, text-caption … text-title), so a
 * surface changes in one place. Popups portal to <body>, so each surface opts
 * out of the titlebar drag region itself (no-drag).
 */

/** Menus, pickers, selects and popovers: a translucent macOS panel, kept inside the window. */
export const popupSurface =
  "no-drag max-h-(--available-height) max-w-(--available-width) rounded-card bg-overlay text-body text-neutral-900 shadow-popup outline-none backdrop-blur-xl dark:text-neutral-100";

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

/** A single-line or multi-line text field. Its boundary is the 3:1 control token. */
export const formInput =
  "w-full rounded-control border border-control bg-white px-2 py-1 text-body outline-offset-0 outline-a11y-focus placeholder:text-a11y-muted focus:border-transparent focus:outline-2 disabled:opacity-50 dark:bg-white/[0.05]";

/** Checkbox box and radio dot. The ring is the 3:1 boundary; checked fills it with the accent. */
const toggleBase =
  "flex size-3.5 shrink-0 items-center justify-center bg-white shadow-control ring-1 ring-control dark:bg-white/[0.08]";
export const checkboxBox = `${toggleBase} rounded-item outline-offset-1 outline-a11y-focus focus-visible:outline-[3px] data-checked:bg-blue-600 data-checked:ring-blue-600 dark:data-checked:bg-blue-600 dark:data-checked:ring-blue-500`;
/** Inside a Radio.Root with `group`. */
export const radioDot = `${toggleBase} rounded-full group-data-checked:bg-blue-600 group-data-checked:ring-blue-600 dark:group-data-checked:bg-blue-600 dark:group-data-checked:ring-blue-500`;
/** A full-row radio: a card that tints when chosen. The dot inside is its 3:1 boundary. */
export const choiceRow =
  "group flex w-full cursor-default gap-2.5 rounded-card px-3 py-2 text-left ring-1 ring-edge outline-offset-1 outline-a11y-focus transition-colors duration-100 hover:bg-fill-hover focus-visible:outline-[3px] data-checked:bg-blue-600/[0.06] data-checked:ring-blue-600/40 motion-reduce:transition-none dark:data-checked:bg-blue-500/[0.1] dark:data-checked:ring-blue-400/40";

/** An on/off switch: Switch.Root and Switch.Thumb. */
export const switchTrack =
  "flex h-[18px] w-8 shrink-0 rounded-full bg-black/[0.14] p-0.5 outline-offset-2 outline-a11y-focus transition-colors duration-150 focus-visible:outline-2 data-checked:bg-blue-600 data-disabled:opacity-50 motion-reduce:transition-none dark:bg-white/20";
export const switchThumb =
  "size-3.5 rounded-full bg-white shadow-control transition-transform duration-150 data-checked:translate-x-3.5 motion-reduce:transition-none";

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
