import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime, Clock } from "effect";
import {
  MobileBackgroundStorage,
  MobileBackgroundStorageLive,
  DEFAULT_MOBILE_BACKGROUND,
} from "./mobile-background.js";
import { SqlClient } from "effect/sql";
import { StoreLive } from "../store/store.js";
import { Store } from "../services.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";

it("persists device opt-ins and atomic stable-id claims across database reopen without a migration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openmail-background-"));
  const create = () =>
    ManagedRuntime.make(
      MobileBackgroundStorageLive.pipe(
        Layer.provideMerge(MemoryPlatform({ database: join(directory, "mail.db") })),
      ),
    );
  let runtime = create();
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* MobileBackgroundStorage;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO accounts(id,provider,email,created_at) VALUES ('a','gmail','a@example.test',0),('b','gmail','b@example.test',0)`;
        expect(yield* storage.preferences).toEqual(DEFAULT_MOBILE_BACKGROUND);
        yield* storage.save({ refresh: true, badge: true, hideContent: true, accounts: ["a"] });
        const claims = yield* Effect.all(
          [
            storage.claim({ id: "a/id", accountId: "a" }),
            storage.claim({ id: "a/id", accountId: "a" }),
          ],
          {
            concurrency: "unbounded",
          },
        );
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(yield* storage.claim({ id: "b/id", accountId: "b" })).toBe(true);
      }),
    );
    await runtime.dispose();
    runtime = create();
    await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* MobileBackgroundStorage;
        expect((yield* storage.preferences).refresh).toBe(true);
        expect(yield* storage.claim({ id: "a/id", accountId: "a" })).toBe(false);
      }),
    );
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("prunes 30-day and removed-account claims, upgrades legacy claims and excludes internal rows from compose preferences", async () => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(MobileBackgroundStorageLive, StoreLive).pipe(
      Layer.provideMerge(MemoryPlatform()),
    ),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const storage = yield* MobileBackgroundStorage;
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO accounts(id,provider,email,created_at) VALUES ('a','gmail','a@example.test',0),('a/b','gmail','b@example.test',0)`;
        yield* storage.claim({ id: "a/recent", accountId: "a" });
        yield* storage.claim({ id: "a/b/nested", accountId: "a/b" });
        yield* sql`INSERT INTO prefs(key,value_json) VALUES ('mobile-background:notified:a/old',${JSON.stringify({ at: now - 31 * 86400000, accountId: "a" })}),('mobile-background:notified:a/legacy','true'),('mobile-background:notified:removed/gone',${JSON.stringify({ at: now, accountId: "removed" })})`;
        yield* storage.prune;
        expect(yield* storage.claim({ id: "a/old", accountId: "a" })).toBe(true);
        expect(yield* storage.claim({ id: "a/legacy", accountId: "a" })).toBe(false);
        expect(yield* storage.claim({ id: "a/recent", accountId: "a" })).toBe(false);
        const gone =
          yield* sql`SELECT key FROM prefs WHERE key='mobile-background:notified:removed/gone'`;
        expect(gone).toHaveLength(0);
        // Changing internal rows must not change normal preferences.
        const before = yield* (yield* Store).prefs;
        yield* sql`INSERT INTO prefs(key,value_json) VALUES ('mobile-background:ignored','invalid-json')`;
        expect(yield* (yield* Store).prefs).toEqual(before);
        yield* sql`DELETE FROM accounts WHERE id='a'`;
        yield* storage.prune;
        expect(
          yield* sql`SELECT key FROM prefs WHERE key='mobile-background:notified:a/recent'`,
        ).toHaveLength(0);
        // Slash-containing account IDs are matched by the complete prefix.
        expect(
          yield* sql`SELECT key FROM prefs WHERE key='mobile-background:notified:a/b/nested'`,
        ).toHaveLength(1);
      }),
    );
  } finally {
    await runtime.dispose();
  }
});
