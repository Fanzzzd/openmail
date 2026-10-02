import { assert, it, layer } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Path, Ref } from "effect";

import { appConfigFile } from "./config.js";
import { dataDirFor } from "./platform/node/paths.js";
import { MemoryFiles, MemoryFileSystem } from "./platform/node/platform-memory.js";
import { AppConfig } from "./services.js";

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
const configOn = (files: Record<string, string>, env: Record<string, string> = {}) =>
  appConfigFile("/om").pipe(
    Layer.provideMerge(Layer.mergeAll(MemoryFileSystem(files), Path.layer)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
  );

const stored = Effect.gen(function* () {
  const mem = yield* MemoryFiles;
  return (yield* Ref.get(mem.files)).get(FILE);
});

it.effect("a missing file reads as no clients; a write creates it with mode 600", () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    assert.deepStrictEqual(yield* config.read, {});
    yield* config.write({ microsoft: { clientId: "ms" } });
    const file = yield* stored;
    assert.ok(file);
    assert.strictEqual(file.mode, 0o600);
    assert.strictEqual(
      file.data,
      `${JSON.stringify({ microsoft: { clientId: "ms" } }, null, 2)}\n`,
    );
    assert.deepStrictEqual(yield* config.read, { microsoft: { clientId: "ms" } });
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

it.effect("env clients win on read and are never written", () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    assert.deepStrictEqual(yield* config.read, {
      google: { clientId: "env-g", clientSecret: "env-s" },
      microsoft: { clientId: "env-ms" },
    });
    yield* config.write({ microsoft: { clientId: "saved" } });
    const file = yield* stored;
    assert.ok(file);
    assert.deepStrictEqual(JSON.parse(file.data), {
      google: { clientId: "file-g", clientSecret: "file-s" },
      microsoft: { clientId: "saved" },
    });
  }).pipe(
    Effect.provide(
      configOn(
        { [FILE]: JSON.stringify({ google: { clientId: "file-g", clientSecret: "file-s" } }) },
        {
          OPENMAIL_GOOGLE_CLIENT_ID: "env-g",
          OPENMAIL_GOOGLE_CLIENT_SECRET: "env-s",
          OPENMAIL_MICROSOFT_CLIENT_ID: "env-ms",
        },
      ),
    ),
  ),
);

it.effect("a Google id without its secret is ignored", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* (yield* AppConfig).read, {});
  }).pipe(Effect.provide(configOn({}, { OPENMAIL_GOOGLE_CLIENT_ID: "only-id" }))),
);
