import type { UpdateState } from "./update-state.js";
import { parse } from "semver";
import { Effect, Option, Schema } from "effect";
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
  allowPrerelease?: boolean;
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

/** A Stable quit must never stage a prerelease, even if Latest downloaded it earlier. */
export function updateVersionAllowed(channel: "stable" | "latest", version: string): boolean {
  const parsed = parse(version);
  return parsed !== null && (channel === "latest" || parsed.prerelease.length === 0);
}
function configureUpdates(client: UpdateClient, token: string, channel: "stable" | "latest") {
  client.autoInstallOnAppQuit = false;
  client.logger = null;
  client.allowPrerelease = channel === "latest";
  client.setFeedURL({
    provider: "github",
    owner: "Fanzzzd",
    repo: "openmail",
    private: true,
    token,
  });
}

const UpdateCheckMetadata = Schema.Struct({
  isUpdateAvailable: Schema.Boolean,
  updateInfo: Schema.optionalKey(Schema.Struct({ version: Schema.String })),
});
/** The updater SDK is an IO boundary; malformed metadata never reaches IPC. */
function updateResult(result: unknown, channel: "stable" | "latest"): ManualUpdateResult {
  const decoded = Schema.decodeUnknownOption(UpdateCheckMetadata)(result);
  if (Option.isNone(decoded)) return { status: "error" };
  if (!decoded.value.isUpdateAvailable) return { status: "upToDate" };
  const version = decoded.value.updateInfo?.version;
  return version !== undefined && updateVersionAllowed(channel, version)
    ? { status: "available", version }
    : { status: "error" };
}
async function observeCheck(
  client: UpdateClient,
  channel: "stable" | "latest",
  report: (state: UpdateState) => void,
): Promise<ManualUpdateResult> {
  report({ status: "checking" });
  try {
    const raw = await client.checkForUpdates();
    const result = updateResult(raw, channel);
    report(result);
    if (
      result.status === "available" &&
      typeof raw === "object" &&
      raw !== null &&
      "downloadPromise" in raw &&
      raw.downloadPromise instanceof Promise
    ) {
      report({ status: "downloading", version: result.version });
      void raw.downloadPromise.then(
        () => report({ status: "downloaded", version: result.version }),
        () => report({ status: "error" }),
      );
    }
    return result;
  } catch {
    report({ status: "error" });
    return { status: "error" };
  }
}
const discardState = (_state: UpdateState): void => undefined;
export interface UpdateOptions {
  packaged: boolean;
  bundle: string;
  channel?: "stable" | "latest";
  autoDownload?: boolean;
  onState?: (state: UpdateState) => void;
}

/** Tokens are supplied on the user's machine, never embedded in app-update.yml. */
export function startAutoUpdates(
  client: UpdateClient,
  options: {
    signed: boolean;
    packaged: boolean;
    token: string | undefined;
    channel?: "stable" | "latest";
    autoDownload?: boolean;
    onState?: (state: UpdateState) => void;
  },
): () => void {
  client.autoInstallOnAppQuit = false;
  const report = options.onState ?? discardState;
  client.autoDownload = false;
  if (!options.packaged || !options.signed || !options.token) {
    report({ status: "disabled" });
    return () => null;
  }
  configureUpdates(client, options.token, options.channel ?? "stable");
  client.autoDownload = options.autoDownload ?? true;
  client.on("error", ignoreError);
  let active = true;
  let busy = false;
  let downloaded: UpdateState | undefined;
  const check = () => {
    if (busy) return;
    busy = true;
    client.autoDownload = options.autoDownload ?? true;
    void observeCheck(client, options.channel ?? "stable", (state) => {
      if (!active) return;
      // Once ready, a routine check must not hide the pending installation.
      if (state.status === "downloaded") downloaded = state;
      else if (state.status === "downloading") downloaded = undefined;
      report(downloaded ?? state);
    }).finally(() => {
      busy = false;
    });
  };
  check();
  const interval = setInterval(check, 6 * 60 * 60_000);
  interval.unref();
  return () => {
    active = false;
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
  options: UpdateOptions,
  token: Effect.Effect<Option.Option<string>>,
  verify: (bundle: string) => Promise<boolean> = isSignedMacApp,
): Effect.Effect<() => void> {
  return Effect.gen(function* () {
    client.autoInstallOnAppQuit = false;
    client.autoDownload = false;
    const disabled = () => {
      options.onState?.({ status: "disabled" });
      return () => null;
    };
    if (!options.packaged) return disabled();
    const saved = yield* token;
    if (Option.isNone(saved) || !saved.value) return disabled();
    const signed = yield* Effect.promise(() => verify(options.bundle));
    return startAutoUpdates(client, {
      packaged: true,
      signed,
      token: saved.value,
      channel: options.channel,
      autoDownload: options.autoDownload,
      onState: options.onState,
    });
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
  options: UpdateOptions,
  token: Effect.Effect<Option.Option<string>>,
  verify: (bundle: string) => Promise<boolean> = isSignedMacApp,
): Effect.Effect<ManualUpdateResult> {
  const report = options.onState ?? discardState;
  return Effect.gen(function* () {
    const automaticDownload = client.autoDownload;
    return yield* Effect.gen(function* () {
      client.autoInstallOnAppQuit = false;
      client.autoDownload = false;
      const disabled = { status: "disabled" } satisfies ManualUpdateResult;
      if (!options.packaged) {
        report(disabled);
        return disabled;
      }
      const saved = yield* token;
      if (Option.isNone(saved) || !saved.value) {
        report(disabled);
        return disabled;
      }
      if (!(yield* Effect.promise(() => verify(options.bundle)))) {
        report(disabled);
        return disabled;
      }
      configureUpdates(client, saved.value, options.channel ?? "stable");
      client.autoDownload = options.autoDownload ?? true;
      client.on("error", ignoreError);
      return yield* Effect.promise(() =>
        observeCheck(client, options.channel ?? "stable", report),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            client.removeListener("error", ignoreError);
          }),
        ),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          client.autoDownload = automaticDownload;
        }),
      ),
    );
  }).pipe(
    Effect.catchCause(() => {
      report({ status: "error" });
      return Effect.succeed({ status: "error" } satisfies ManualUpdateResult);
    }),
  );
}
