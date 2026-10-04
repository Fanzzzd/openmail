import { Config, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { AppConfig, type ClientConfig } from "./services.js";

/**
 * OAuth client registrations. They are the user's own (openmail is not a
 * published app), so they live in config.json rather than in the source.
 * Env vars win so a one-off run can try a different client.
 */
const ConfigFile = Schema.Struct({
  google: Schema.optionalKey(
    Schema.Struct({ clientId: Schema.String, clientSecret: Schema.String }),
  ),
  /** Public client (PKCE, no secret). Registered by the user in Azure. */
  microsoft: Schema.optionalKey(Schema.Struct({ clientId: Schema.String })),
});

// Keys this version does not know survive a write.
const RawFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

const env = (name: string) => Config.option(Config.NonEmptyString(name));

/** Client overrides from OPENMAIL_GOOGLE_CLIENT_ID/SECRET and OPENMAIL_MICROSOFT_CLIENT_ID. */
const EnvOverrides = Config.all({
  googleId: env("OPENMAIL_GOOGLE_CLIENT_ID"),
  googleSecret: env("OPENMAIL_GOOGLE_CLIENT_SECRET"),
  microsoftId: env("OPENMAIL_MICROSOFT_CLIENT_ID"),
}).pipe(
  Config.map(({ googleId, googleSecret, microsoftId }): ClientConfig => {
    const config: ClientConfig = {};
    if (Option.isSome(googleId) && Option.isSome(googleSecret)) {
      config.google = { clientId: googleId.value, clientSecret: googleSecret.value };
    }
    if (Option.isSome(microsoftId)) config.microsoft = { clientId: microsoftId.value };
    return config;
  }),
);

const MODE = 0o600;

/**
 * config.json in `dir`, mode 600. A malformed file or a failing disk is a
 * defect, as for the database. Env overrides are read once, when the layer
 * builds, from the ConfigProvider in scope.
 */
export function appConfigFile(
  dir: string,
): Layer.Layer<AppConfig, never, FileSystem.FileSystem | Path.Path> {
  return Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const overrides = yield* Effect.orDie(EnvOverrides);
      const file = path.join(dir, "config.json");

      const readRaw = fs.exists(file).pipe(
        Effect.flatMap((exists) => (exists ? fs.readFileString(file) : Effect.succeed("{}"))),
        Effect.flatMap(Schema.decodeUnknownEffect(RawFile)),
        Effect.orDie,
      );

      const read = readRaw.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ConfigFile)),
        Effect.orDie,
        Effect.map((stored): ClientConfig => ({ ...stored, ...overrides })),
        Effect.withSpan("AppConfig.read"),
      );

      // Merges into the file as stored, so env overrides never get written.
      const write = Effect.fn("AppConfig.write")(function* (patch: ClientConfig) {
        const next = { ...(yield* readRaw), ...patch };
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* fs.writeFileString(file, `${JSON.stringify(next, null, 2)}\n`, { mode: MODE });
        // mode only applies when the file is created.
        yield* fs.chmod(file, MODE);
      }, Effect.orDie);

      return AppConfig.of({ read, write });
    }),
  );
}
