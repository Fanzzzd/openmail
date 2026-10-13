/** The window event the app and thread windows listen for to open Settings on a tab. */
export const OPEN_SETTINGS_EVENT = "openmail:open-settings";

/** Opens Settings → AI Access in the current window. */
export function openAiSettings() {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: "ai" }));
}
