import os from "node:os";

import { Config, Effect, Option, Path } from "effect";

const env = (name: string) => Config.option(Config.NonEmptyString(name));

/**
 * One data directory shared by the desktop app, the CLI and the MCP server, so
 * all three read the same database. Electron's `app.getPath("userData")` is
 * deliberately not used: it is keyed by product name and the CLI cannot see it.
 *
 * `platform` is a parameter so tests can resolve every OS's folder on any host.
 */
export const dataDirFor = (platform: NodeJS.Platform) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const override = yield* env("OPENMAIL_HOME");
    if (Option.isSome(override)) return override.value;
    const home = Option.getOrElse(yield* env(platform === "win32" ? "USERPROFILE" : "HOME"), () =>
      os.homedir(),
    );
    switch (platform) {
      case "darwin":
        return path.join(home, "Library", "Application Support", "openmail");
      case "win32": {
        const appData = yield* env("APPDATA");
        return path.join(
          Option.getOrElse(appData, () => path.join(home, "AppData", "Roaming")),
          "openmail",
        );
      }
      default: {
        const xdg = yield* env("XDG_DATA_HOME");
        return path.join(
          Option.getOrElse(xdg, () => path.join(home, ".local", "share")),
          "openmail",
        );
      }
    }
  }).pipe(Effect.orDie, Effect.withSpan("dataDir"));

/** OPENMAIL_HOME, or the app data folder of the OS this process runs on. */
export const dataDir: Effect.Effect<string, never, Path.Path> = dataDirFor(process.platform);
