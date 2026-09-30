import { app } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const profile = fileURLToPath(new URL("artifacts/electron-profile/", import.meta.url));
mkdirSync(profile, { recursive: true });
app.setName("OpenMailMediaSpike");
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.setAppLogsPath(profile);
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
// Electron emits ready only after the entry module finishes evaluation.
app.once("ready", async () => {
  try {
    const { benchmark } = await import("./bench-sqlite.mjs");
    benchmark("electron");
    app.exit(0);
  } catch (error) {
    const result = { versions: process.versions, error: String(error), stack: error.stack };
    writeFileSync(
      new URL("artifacts/sqlite-electron-error.json", import.meta.url),
      JSON.stringify(result, null, 2),
    );
    console.error(error);
    app.exit(1);
  }
});
