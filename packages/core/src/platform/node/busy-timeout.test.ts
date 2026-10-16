import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it } from "vitest";
import { BUSY_TIMEOUT_MS } from "../../db/migrate.js";
import { NodePlatform } from "./platform-node.js";

/** The busy_timeout NodePlatform's connection uses when the process has `env`. */
const busyTimeout = async (env: Record<string, string>) => {
  const dataDir = mkdtempSync(join(tmpdir(), "openmail-busy-timeout-"));
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ timeout: number }>`SELECT timeout FROM pragma_busy_timeout`;
        return rows[0]?.timeout;
      }).pipe(
        Effect.provide(
          NodePlatform({ dataDir }).pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
          ),
        ),
        Effect.scoped,
      ),
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
};

it("OPENMAIL_TEST_BUSY_TIMEOUT_MS lengthens the database busy timeout", async () => {
  expect(await busyTimeout({ OPENMAIL_TEST_BUSY_TIMEOUT_MS: "30000" })).toBe(30_000);
});

it("OPENMAIL_TEST_BUSY_TIMEOUT_MS cannot shorten the default busy timeout", async () => {
  expect(await busyTimeout({ OPENMAIL_TEST_BUSY_TIMEOUT_MS: "100" })).toBe(BUSY_TIMEOUT_MS);
  expect(await busyTimeout({})).toBe(BUSY_TIMEOUT_MS);
});
