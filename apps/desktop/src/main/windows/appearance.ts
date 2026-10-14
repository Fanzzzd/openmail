import { app, nativeTheme } from "electron";

/**
 * The appearance a development run forces with OPENMAIL_APPEARANCE=light or dark, so screenshot
 * harnesses and reviewers can check both without changing the Mac's setting. Packaged builds,
 * and any other value, follow the system.
 */
export function developmentAppearance(
  value: string | undefined,
  packaged: boolean,
): "light" | "dark" | undefined {
  return !packaged && (value === "light" || value === "dark") ? value : undefined;
}

/** Applies OPENMAIL_APPEARANCE before the first window, so every window and frame follows it. */
export function applyDevelopmentAppearance() {
  const appearance = developmentAppearance(process.env.OPENMAIL_APPEARANCE, app.isPackaged);
  if (appearance) nativeTheme.themeSource = appearance;
}
