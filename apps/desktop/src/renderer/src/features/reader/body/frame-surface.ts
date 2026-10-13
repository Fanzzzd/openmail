export type MessageBackground = "light" | "dark";

/** EmailFrame's height before the document is measured; the placeholder keeps the same box. */
export const FRAME_INITIAL_HEIGHT = 120;

export const frameSurface = (background: MessageBackground) =>
  `overflow-hidden rounded-card p-4 ${
    background === "dark"
      ? "bg-black ring-1 ring-white/10"
      : "bg-white dark:ring-1 dark:ring-white/10"
  }`;
