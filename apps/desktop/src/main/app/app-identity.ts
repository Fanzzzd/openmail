/**
 * Unpackaged runs call themselves "OpenMail Dev" and use the blueprint dev icon
 * (build/icon-dev.png), so a dev instance is never mistaken for the installed
 * app. Only displayed strings and icons change. Never call app.setName here:
 * Electron derives userData from the app name, and a dev run must keep using
 * the same data directory.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app } from "electron";

export function appIdentity(packaged: boolean, buildDir: string) {
  return packaged
    ? { title: "OpenMail", icon: undefined }
    : { title: "OpenMail Dev", icon: path.join(buildDir, "icon-dev.png") };
}

// build/ is not packaged: the bundle icon comes from build/icon.icns. In dev the
// Dock and window would otherwise show Electron's icon.
const identity = appIdentity(
  app.isPackaged,
  fileURLToPath(new URL("../../build", import.meta.url)),
);
export const APP_TITLE = identity.title;
export const DEV_ICON = identity.icon;

/** CC BY 4.0 asks for attribution where the icons ship. Notices: THIRD_PARTY_NOTICES.md. */
export const ABOUT_CREDITS = "Provider icons by selfh.st, https://selfh.st/icons (CC BY 4.0).";

/**
 * Puts the icon credits in the About panel. Unpackaged runs also get the dev
 * icon in the Dock and the dev name in the About panel.
 */
export function showAppIdentity() {
  if (!DEV_ICON) {
    app.setAboutPanelOptions({ credits: ABOUT_CREDITS });
    return;
  }
  if (process.platform === "darwin") app.dock?.setIcon(DEV_ICON);
  app.setAboutPanelOptions({
    applicationName: APP_TITLE,
    applicationVersion: app.getVersion(),
    credits: ABOUT_CREDITS,
  });
}
