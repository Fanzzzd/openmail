import { Config, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { CLIENT_ENV_VARS, clientsFromEnv, parseClientsFile } from "./oauth-client-sources.js";
import { AppConfig, type ClientConfig, type ClientSources } from "./services.js";

/**
 * OAuth clients. The user's own registrations live in config.json. The
 * built-in ones are openmail's registrations: the desktop build compiles them
 * into the main process, and the CLI reads them from a local file. Env vars
 * are a third source. None of them is in the source tree.
 */
const ConfigFile = Schema.Struct({
  google: Schema.optionalKey(
    Schema.Struct({ clientId: Schema.String, clientSecret: Schema.String }),
  ),
  /** Public client (PKCE, no secret). */
  microsoft: Schema.optionalKey(Schema.Struct({ clientId: Schema.String })),
});

// Keys this version does not know survive a write.
const RawFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

/** OPENMAIL_GOOGLE_CLIENT_ID/SECRET and OPENMAIL_MICROSOFT_CLIENT_ID from the ConfigProvider. */
const EnvClients = Config.all(
  Object.fromEntries(
    CLIENT_ENV_VARS.map((name) => [name, Config.option(Config.NonEmptyString(name))]),
  ),
).pipe(
  Config.map((values) =>
    clientsFromEnv(
      Object.fromEntries(
        Object.entries(values).map(([name, value]) => [name, Option.getOrUndefined(value)]),
      ),
    ),
  ),
);

/**
 * A JSON file of built-in clients, shaped like config.json. A missing file
 * reads as none. A malformed one is logged and ignored, so a bad local file
 * does not stop every CLI command.
 */
export const readClientsFile = Effect.fn("readClientsFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file).pipe(Effect.option);
  if (Option.isNone(text)) return {};
  return yield* Effect.try({
    try: () => parseClientsFile(text.value),
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  }).pipe(
    Effect.catch((reason) =>
      Effect.as(Effect.logWarning(`Ignoring the OAuth clients file ${file}: ${reason}`), {}),
    ),
  );
});

const MODE = 0o600;

/**
 * config.json in `dir`, mode 600, holds the user's clients. A malformed file
 * or a failing disk is a defect, as for the database. Env vars are read once,
 * when the layer builds, from the ConfigProvider in scope.
 */
export function appConfigFile(
  dir: string,
  builtIn: ClientConfig = {},
): Layer.Layer<AppConfig, never, FileSystem.FileSystem | Path.Path> {
  return Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const env = yield* Effect.orDie(EnvClients);
      const file = path.join(dir, "config.json");

      const readRaw = fs.exists(file).pipe(
        Effect.flatMap((exists) => (exists ? fs.readFileString(file) : Effect.succeed("{}"))),
        Effect.flatMap(Schema.decodeUnknownEffect(RawFile)),
        Effect.orDie,
      );

      const sources = readRaw.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ConfigFile)),
        Effect.orDie,
        Effect.map((user): ClientSources => ({ user, env, builtIn })),
        Effect.withSpan("AppConfig.sources"),
      );

      const save = (next: Record<string, unknown>) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(dir, { recursive: true });
          yield* fs.writeFileString(file, `${JSON.stringify(next, null, 2)}\n`, { mode: MODE });
          // mode only applies when the file is created.
          yield* fs.chmod(file, MODE);
        }).pipe(Effect.orDie);

      // Merges into the file as stored, so other sources never get written.
      const write = Effect.fn("AppConfig.write")(function* (patch: ClientConfig) {
        yield* save({ ...(yield* readRaw), ...patch });
      });

      const clearUser = Effect.fn("AppConfig.clearUser")(function* (provider: keyof ClientConfig) {
        const { [provider]: _removed, ...rest } = yield* readRaw;
        yield* save(rest);
      });

      return AppConfig.of({ sources, write, clearUser });
    }),
  );
}
