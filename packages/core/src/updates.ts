import { Effect, Option } from "effect";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const ignoreError = (_error: Error) => null;

/** Verifies the installed app, not build-time environment or an ad-hoc seal. */
export async function isSignedMacApp(bundle: string): Promise<boolean> {
  try {
    await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
    const result = await execute("/usr/bin/codesign", ["--display", "--verbose=4", bundle]);
    return (
      /Authority=Developer ID Application:/.test(result.stderr) &&
      /TeamIdentifier=[A-Z0-9]+/.test(result.stderr)
    );
  } catch {
    return false;
  }
}

/** Platform adapter; core owns update checks and their network policy. */
export interface UpdateClient {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  setFeedURL(options: {
    provider: "github";
    owner: string;
    repo: string;
    private: boolean;
    token: string;
  }): void;
  checkForUpdates(): Promise<unknown>;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
}

/** Tokens are supplied on the user's machine, never embedded in app-update.yml. */
export function startAutoUpdates(
  client: UpdateClient,
  options: { signed: boolean; packaged: boolean; token: string | undefined },
): () => void {
  if (!options.packaged || !options.signed || !options.token) return () => null;
  // Updater logs can contain request URLs/headers; suppress them rather than log credentials.
  client.logger = null;
  client.autoDownload = true;
  client.autoInstallOnAppQuit = true;
  client.setFeedURL({
    provider: "github",
    owner: "Fanzzzd",
    repo: "openmail",
    private: true,
    token: options.token,
  });
  client.on("error", ignoreError);
  const check = () => {
    void client.checkForUpdates().catch(() => null);
  };
  check();
  const interval = setInterval(check, 6 * 60 * 60_000);
  interval.unref();
  return () => {
    clearInterval(interval);
    client.autoDownload = false;
    client.autoInstallOnAppQuit = false;
    client.removeListener("error", ignoreError);
  };
}

export const UPDATE_TOKEN_KEY = "updates:github-release-token";
/** Called after the window is visible. No stored token means no codesign process. */
export function startStoredUpdates(
  client: UpdateClient,
  options: { packaged: boolean; bundle: string },
  token: Effect.Effect<Option.Option<string>>,
  verify: (bundle: string) => Promise<boolean> = isSignedMacApp,
): Effect.Effect<() => void> {
  return Effect.gen(function* () {
    if (!options.packaged) return () => null;
    const saved = yield* token;
    if (Option.isNone(saved)) return () => null;
    const signed = yield* Effect.promise(() => verify(options.bundle));
    return startAutoUpdates(client, { packaged: true, signed, token: saved.value });
  });
}

export type ManualUpdateResult =
  | { status: "disabled" }
  | { status: "upToDate" }
  | { status: "available"; version: string }
  | { status: "error" };

/** Manual checks obey the same packaging, signature and keychain gate as the timer. */
export function checkStoredUpdates(
  client: UpdateClient,
  options: { packaged: boolean; bundle: string },
  token: Effect.Effect<Option.Option<string>>,
  verify: (bundle: string) => Promise<boolean> = isSignedMacApp,
): Effect.Effect<ManualUpdateResult> {
  return Effect.gen(function* () {
    if (!options.packaged) return { status: "disabled" } satisfies ManualUpdateResult;
    const saved = yield* token;
    if (Option.isNone(saved) || !saved.value)
      return { status: "disabled" } satisfies ManualUpdateResult;
    if (!(yield* Effect.promise(() => verify(options.bundle))))
      return { status: "disabled" } satisfies ManualUpdateResult;
    client.logger = null;
    client.setFeedURL({
      provider: "github",
      owner: "Fanzzzd",
      repo: "openmail",
      private: true,
      token: saved.value,
    });
    client.on("error", ignoreError);
    const result = yield* Effect.tryPromise(() => client.checkForUpdates()).pipe(
      Effect.ensuring(Effect.sync(() => client.removeListener("error", ignoreError))),
    );
    if (
      typeof result !== "object" ||
      result === null ||
      !("isUpdateAvailable" in result) ||
      typeof result.isUpdateAvailable !== "boolean"
    )
      return { status: "error" } satisfies ManualUpdateResult;
    if (!result.isUpdateAvailable) return { status: "upToDate" } satisfies ManualUpdateResult;
    if (
      !("updateInfo" in result) ||
      typeof result.updateInfo !== "object" ||
      result.updateInfo === null ||
      !("version" in result.updateInfo) ||
      typeof result.updateInfo.version !== "string"
    )
      return { status: "error" } satisfies ManualUpdateResult;
    return { status: "available", version: result.updateInfo.version } satisfies ManualUpdateResult;
  }).pipe(
    Effect.catchCause(() => Effect.succeed({ status: "error" } satisfies ManualUpdateResult)),
  );
}
