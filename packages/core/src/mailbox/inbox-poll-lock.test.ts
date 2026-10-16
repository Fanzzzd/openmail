import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { Effect, Logger } from "effect";
import { logCodeOf } from "../domain/diagnostic-log.js";
import { fakeServer, incoming, TestMailbox } from "../platform/node/testing.js";
import { Mailbox } from "./mailbox.js";

// An inbox poll found another process's write lock held, died with the lock timeout, and wrote its
// failure under the 5 s busy timeout again: 10 s, a sync-crashed log, and no backoff.
it.effect(
  "an inbox poll under a held write lock returns busy, logs no crash and backs off",
  () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "openmail-poll-lock-"));
      const file = join(dir, "mail.db");
      const server = fakeServer("me@example.com", [incoming("one")]);
      const codes: unknown[] = [];
      const logger = Logger.make((options) => codes.push(logCodeOf(options.annotations)));
      try {
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          const account = yield* m.accounts.connect({ provider: "gmail" });
          yield* m.sync.sync();
          server.messages.set("two", incoming("two"));
          const writer = new DatabaseSync(file);
          writer.exec("BEGIN IMMEDIATE");
          try {
            const started = performance.now();
            const results = yield* m.sync.pollInbox([account.id]);
            // Unscaled on purpose: the regression waits out the 5 s busy timeout twice.
            assert.isBelow(performance.now() - started, 4000);
            assert.strictEqual(results.length, 1);
            assert.isDefined(results[0]?.error);
            assert.notInclude(codes, "sync-crashed");
            const pulls = server.pulls.length;
            // A scheduled poll skips an account that is backing off.
            yield* m.sync.pollInbox();
            assert.strictEqual(server.pulls.length, pulls);
          } finally {
            writer.exec("ROLLBACK");
            writer.close();
          }
        }).pipe(
          Effect.provide(
            TestMailbox({ gmail: server }, { backgroundFlush: false }, {}, undefined, {
              database: file,
            }),
          ),
          Effect.provide(Logger.layer([logger])),
          Effect.scoped,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  30_000,
);
