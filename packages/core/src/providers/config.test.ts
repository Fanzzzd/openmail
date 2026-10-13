import { assert, it, layer } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Path, Ref } from "effect";

import { appConfigFile, readClientsFile } from "./config.js";
import { effectiveClients } from "./oauth-clients.js";
import { dataDirFor } from "../platform/node/paths.js";
import { MemoryFiles, MemoryFileSystem } from "../platform/node/platform-memory.js";
import { AppConfig, type ClientConfig } from "../platform/auth.js";

const withEnv = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)));

layer(Path.layer)("dataDir", (it) => {
  it.effect("OPENMAIL_HOME wins on every OS", () =>
    Effect.gen(function* () {
      for (const os of ["darwin", "linux", "win32"] as const) {
        assert.strictEqual(yield* dataDirFor(os), "/data/om");
      }
    }).pipe(withEnv({ OPENMAIL_HOME: "/data/om", HOME: "/home/me", USERPROFILE: "/home/me" })),
  );

  it.effect("each OS has its own app data folder", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* dataDirFor("darwin"),
        "/Users/me/Library/Application Support/openmail",
      );
      assert.strictEqual(yield* dataDirFor("linux"), "/Users/me/.local/share/openmail");
      assert.strictEqual(yield* dataDirFor("win32"), "/Users/me/AppData/Roaming/openmail");
    }).pipe(withEnv({ HOME: "/Users/me", USERPROFILE: "/Users/me" })),
  );

  it.effect("XDG_DATA_HOME and APPDATA move the folder", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* dataDirFor("linux"), "/xdg/openmail");
      assert.strictEqual(yield* dataDirFor("win32"), "/roaming/openmail");
    }).pipe(withEnv({ HOME: "/h", USERPROFILE: "/h", XDG_DATA_HOME: "/xdg", APPDATA: "/roaming" })),
  );
});

const FILE = "/om/config.json";

/** appConfigFile over the memory file system, with `env` as the process environment. */
const configOn = (
  files: Record<string, string>,
  env: Record<string, string> = {},
  builtIn: ClientConfig = {},
) =>
  appConfigFile("/om", builtIn).pipe(
    Layer.provideMerge(Layer.mergeAll(MemoryFileSystem(files), Path.layer)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
  );

const effective = Effect.flatMap(AppConfig, (config) =>
  Effect.map(config.sources, effectiveClients),
);

const stored = Effect.gen(function* () {
  const mem = yield* MemoryFiles;
  return (yield* Ref.get(mem.files)).get(FILE);
});

it.effect("a missing file reads as no clients; a write creates it with mode 600", () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    assert.deepStrictEqual(yield* effective, {});
    yield* config.write({ microsoft: { clientId: "ms" } });
    const file = yield* stored;
    assert.ok(file);
    assert.strictEqual(file.mode, 0o600);
    assert.strictEqual(
      file.data,
      `${JSON.stringify({ microsoft: { clientId: "ms" } }, null, 2)}\n`,
    );
    assert.deepStrictEqual(yield* effective, { microsoft: { clientId: "ms" } });
  }).pipe(Effect.provide(configOn({}))),
);

it.effect("a write keeps unknown keys and tightens an existing file to 600", () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    yield* config.write({ google: { clientId: "g", clientSecret: "s" } });
    const file = yield* stored;
    assert.ok(file);
    assert.strictEqual(file.mode, 0o600);
    assert.deepStrictEqual(JSON.parse(file.data), {
      future: { keep: true },
      microsoft: { clientId: "ms" },
      google: { clientId: "g", clientSecret: "s" },
    });
  }).pipe(
    Effect.provide(
      configOn({
        [FILE]: JSON.stringify({ future: { keep: true }, microsoft: { clientId: "ms" } }),
      }),
    ),
  ),
);

it.effect(
  "new sign-ins prefer the user's client, then env vars, then the built-in one; only user clients are written",
  () =>
    Effect.gen(function* () {
      const config = yield* AppConfig;
      assert.deepStrictEqual(yield* config.sources, {
        user: { google: { clientId: "file-g", clientSecret: "file-s" } },
        env: {
          google: { clientId: "env-g", clientSecret: "env-s" },
          microsoft: { clientId: "env-ms" },
        },
        builtIn: {
          google: { clientId: "host-g", clientSecret: "host-s" },
          microsoft: { clientId: "host-ms" },
        },
      });
      assert.deepStrictEqual(yield* effective, {
        google: { clientId: "file-g", clientSecret: "file-s" },
        microsoft: { clientId: "env-ms" },
      });
      yield* config.write({ microsoft: { clientId: "saved" } });
      const file = yield* stored;
      assert.ok(file);
      assert.deepStrictEqual(JSON.parse(file.data), {
        google: { clientId: "file-g", clientSecret: "file-s" },
        microsoft: { clientId: "saved" },
      });
      assert.deepStrictEqual((yield* effective).microsoft, { clientId: "saved" });
    }).pipe(
      Effect.provide(
        configOn(
          { [FILE]: JSON.stringify({ google: { clientId: "file-g", clientSecret: "file-s" } }) },
          {
            OPENMAIL_GOOGLE_CLIENT_ID: "env-g",
            OPENMAIL_GOOGLE_CLIENT_SECRET: "env-s",
            OPENMAIL_MICROSOFT_CLIENT_ID: "env-ms",
          },
          {
            google: { clientId: "host-g", clientSecret: "host-s" },
            microsoft: { clientId: "host-ms" },
          },
        ),
      ),
    ),
);

it.effect("without a user client, new sign-ins use the built-in one", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* effective, {
      google: { clientId: "host-g", clientSecret: "host-s" },
    });
  }).pipe(
    Effect.provide(configOn({}, {}, { google: { clientId: "host-g", clientSecret: "host-s" } })),
  ),
);

it.effect("a built-in clients file reads like config.json; a missing one reads as none", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* readClientsFile("/repo/missing.json"), {});
    assert.deepStrictEqual(yield* readClientsFile("/repo/clients.json"), {
      microsoft: { clientId: "local-ms" },
    });
  }).pipe(
    Effect.provide(
      MemoryFileSystem({
        "/repo/clients.json": JSON.stringify({ microsoft: { clientId: "local-ms" } }),
      }),
    ),
  ),
);

it.effect("clearing the user's client keeps other keys and falls back to the built-in one", () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    yield* config.clearUser("google");
    const file = yield* stored;
    assert.ok(file);
    assert.deepStrictEqual(JSON.parse(file.data), {
      future: { keep: true },
      microsoft: { clientId: "ms" },
    });
    assert.deepStrictEqual((yield* effective).google, {
      clientId: "host-g",
      clientSecret: "host-s",
    });
  }).pipe(
    Effect.provide(
      configOn(
        {
          [FILE]: JSON.stringify({
            future: { keep: true },
            microsoft: { clientId: "ms" },
            google: { clientId: "g", clientSecret: "s" },
          }),
        },
        {},
        { google: { clientId: "host-g", clientSecret: "host-s" } },
      ),
    ),
  ),
);

it.effect("a malformed clients file is ignored instead of stopping the command", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* readClientsFile("/repo/clients.json"), {});
  }).pipe(Effect.provide(MemoryFileSystem({ "/repo/clients.json": "{ not json" }))),
);

it.effect("a Google id without its secret is ignored", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* effective, {});
  }).pipe(Effect.provide(configOn({}, { OPENMAIL_GOOGLE_CLIENT_ID: "only-id" }))),
);
