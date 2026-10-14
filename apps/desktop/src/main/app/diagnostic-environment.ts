import { app } from "electron";

/** The git commit the app was built from; electron.vite.config.ts defines it at build time. */
declare const __OPENMAIL_BUILD__: string | null;

/** Build and runtime versions for the diagnostics snapshot. Core re-validates every field. */
export const diagnosticEnvironment = () => ({
  appVersion: app.getVersion(),
  build: typeof __OPENMAIL_BUILD__ === "string" ? __OPENMAIL_BUILD__ : undefined,
  packaged: app.isPackaged,
  platform: process.platform,
  osVersion: process.getSystemVersion(),
  arch: process.arch,
  electronVersion: process.versions.electron,
  nodeVersion: process.versions.node,
});
