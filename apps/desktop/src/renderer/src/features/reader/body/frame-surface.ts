export type MessageBackground = "light" | "dark";

/** EmailFrame's height before the document is measured; the placeholder keeps the same box. */
export const FRAME_INITIAL_HEIGHT = 120;

/**
 * The card around a message. In the composer the card is inset 8 px and pads 8 px, so the
 * previewed text starts 16 px in, where the editor's text starts.
 */
export const frameSurface = (
  background: MessageBackground,
  presentation: "reader" | "compose" = "reader",
) =>
  `overflow-hidden rounded-card ${presentation === "compose" ? "p-2" : "p-4"} ${
    background === "dark"
      ? "bg-black ring-1 ring-white/10"
      : "bg-white dark:ring-1 dark:ring-white/10"
  }`;
