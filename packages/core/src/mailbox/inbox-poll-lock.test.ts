import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { Cause, Effect, Exit, Logger, References, Stream } from "effect";
import type { ProviderAdapter } from "../providers/adapter.js";
import { isLockTimeout } from "../store/store-brief-lock.js";
import { logCodeOf } from "../domain/diagnostic-log.js";
import { fakeServer, incoming, Store, TestMailbox } from "../platform/node/testing.js";
import { AuthError, ProviderError } from "../domain/errors.js";
import { SYNC_FAILURE_TEXT, syncFailureText } from "../sync/sync-failure.js";
import { LOCK_WAIT_BOUND_MS, LONG_BUSY_TIMEOUT_MS } from "../../test-support/test-time.js";
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
      const logger = Logger.make((options) => {
        codes.push(logCodeOf(options.fiber.getRef(References.CurrentLogAnnotations)));
      });
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
            // The regression waits out the busy timeout twice.
            assert.isBelow(performance.now() - started, LOCK_WAIT_BOUND_MS);
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
              busyTimeoutMs: LONG_BUSY_TIMEOUT_MS,
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

// A full sync that finds the write lock held dies with the lock timeout once, so the CLI and MCP
// say "busy". Without the per-account branch each account logged a sync-crashed and went on to
// write its failure under the 5 s timeout again.
it.effect(
  "a full sync under a held write lock dies with the lock timeout and logs no crash",
  () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "openmail-sync-lock-"));
      const file = join(dir, "mail.db");
      const gmail = fakeServer("me@example.com", [incoming("one")]);
      const outlook = fakeServer("me@example.org", [incoming("two")]);
      const codes: unknown[] = [];
      const logger = Logger.make((options) => {
        codes.push(logCodeOf(options.fiber.getRef(References.CurrentLogAnnotations)));
      });
      let writer: DatabaseSync | undefined;
      // The lock is taken when the first account starts to pull, so the sync reaches its pulls.
      const lockOnPull = (base: ProviderAdapter): ProviderAdapter => ({
        ...base,
        pull: (...args) =>
          Stream.unwrap(
            Effect.sync(() => {
              if (writer && !writer.isTransaction) {
                writer.exec("BEGIN IMMEDIATE");
              }
              return base.pull(...args);
            }),
          ),
      });
      try {
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          yield* m.accounts.connect({ provider: "gmail" });
          yield* m.accounts.connect({ provider: "outlook" });
          yield* m.sync.sync();
          gmail.messages.set("three", incoming("three"));
          outlook.messages.set("four", incoming("four"));
          writer = new DatabaseSync(file);
          try {
            const exit = yield* Effect.exit(m.sync.sync());
            assert.isTrue(
              Exit.isFailure(exit) &&
                Cause.hasDies(exit.cause) &&
                isLockTimeout(Cause.squash(exit.cause)),
            );
            assert.notInclude(codes, "sync-crashed");
          } finally {
            try {
              writer.exec("ROLLBACK");
            } catch {
              // The lock was never taken.
            }
            writer.close();
          }
        }).pipe(
          Effect.provide(
            TestMailbox.withAdapter(lockOnPull, {
              servers: { gmail, outlook },
              platformOptions: { database: file },
            }),
          ),
          Effect.provide(Logger.layer([logger])),
          Effect.scoped,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  60_000,
);

// A scheduled poll flushed the queue before its per-account 200 ms writes. The flush claimed the op
// under the 5 s busy timeout, failed with a SqlError after 5.4 s and blocked the event loop.
it.effect(
  "a scheduled poll with a queued op under a held write lock skips the flush and backs off",
  () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "openmail-poll-flush-lock-"));
      const file = join(dir, "mail.db");
      const server = fakeServer("me@example.com", [incoming("one")]);
      try {
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          const store = yield* Store;
          const account = yield* m.accounts.connect({ provider: "gmail" });
          yield* m.sync.sync();
          yield* store.enqueueOp(account.id, "one", { kind: "star", value: true });
          const writer = new DatabaseSync(file);
          writer.exec("BEGIN IMMEDIATE");
          try {
            const started = performance.now();
            const results = yield* m.sync.pollInbox();
            // The regression waits out the busy timeout.
            assert.isBelow(performance.now() - started, LOCK_WAIT_BOUND_MS);
            assert.strictEqual(results.length, 1);
            assert.isDefined(results[0]?.error);
            const pulls = server.pulls.length;
            yield* m.sync.pollInbox();
            assert.strictEqual(server.pulls.length, pulls);
          } finally {
            writer.exec("ROLLBACK");
            writer.close();
          }
          assert.strictEqual((yield* store.listPendingOps).length, 1);
          // With the lock free, the next scheduled poll flushes the op.
          yield* m.sync.pollInbox();
          assert.strictEqual((yield* store.listPendingOps).length, 0);
        }).pipe(
          Effect.provide(
            TestMailbox({ gmail: server }, { backgroundFlush: false }, {}, undefined, {
              database: file,
              busyTimeoutMs: LONG_BUSY_TIMEOUT_MS,
            }),
          ),
          Effect.scoped,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  30_000,
);

// The poll wrote the provider's failure under the 200 ms wait. A held lock there must not turn the
// result into the generic retry text, and the crash handler must not see it.
it.effect(
  "a provider failure during a poll under a held write lock surfaces the provider's error",
  () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "openmail-poll-fail-lock-"));
      const file = join(dir, "mail.db");
      const server = fakeServer("me@example.com", [incoming("one")]);
      const codes: unknown[] = [];
      const logger = Logger.make((options) => {
        codes.push(logCodeOf(options.fiber.getRef(References.CurrentLogAnnotations)));
      });
      const failure = new ProviderError({ message: "unavailable", status: 503 });
      let failing: "no" | "error" | "defect" = "no";
      const failPull = (base: ProviderAdapter): ProviderAdapter => ({
        ...base,
        pull: (...args) =>
          failing === "error"
            ? Stream.fail(failure)
            : failing === "defect"
              ? Stream.die(new Error("provider bug"))
              : base.pull(...args),
      });
      try {
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          const account = yield* m.accounts.connect({ provider: "gmail" });
          yield* m.sync.sync();
          failing = "error";
          const writer = new DatabaseSync(file);
          writer.exec("BEGIN IMMEDIATE");
          try {
            const results = yield* m.sync.pollInbox([account.id]);
            assert.strictEqual(results[0]?.error, syncFailureText(failure));
            assert.notStrictEqual(results[0]?.error, SYNC_FAILURE_TEXT.unknown);
            assert.notInclude(codes, "sync-crashed");
            // A provider bug goes through the crash handler, whose error write also finds the
            // lock held. The poll still returns a result instead of dying.
            failing = "defect";
            const crashed = yield* m.sync.pollInbox([account.id]);
            assert.strictEqual(crashed[0]?.error, SYNC_FAILURE_TEXT.unknown);
            assert.include(codes, "sync-crashed");
          } finally {
            writer.exec("ROLLBACK");
            writer.close();
          }
        }).pipe(
          Effect.provide(
            TestMailbox.withAdapter(failPull, {
              servers: { gmail: server },
              platformOptions: { database: file },
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

// failed() wrote markReauth outside the 200 ms wait. A sign-in failure during a poll under a held
// lock blocked for 5.4 s, and a busy write lost the needsReauth flag.
it.effect(
  "a sign-in failure during a poll under a held write lock is recorded by the next poll",
  () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "openmail-poll-reauth-lock-"));
      const file = join(dir, "mail.db");
      const server = fakeServer("me@example.com", [incoming("one")]);
      // The provider rejects the token once; a lost flag would let the next poll sync normally.
      let rejectOnce = false;
      const rejectPull = (base: ProviderAdapter): ProviderAdapter => ({
        ...base,
        pull: (...args) => {
          if (!rejectOnce) return base.pull(...args);
          rejectOnce = false;
          return Stream.fail(new AuthError({ message: "revoked", reason: "token_revoked" }));
        },
      });
      try {
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          const store = yield* Store;
          const account = yield* m.accounts.connect({ provider: "gmail" });
          yield* m.sync.sync();
          rejectOnce = true;
          const writer = new DatabaseSync(file);
          writer.exec("BEGIN IMMEDIATE");
          try {
            const started = performance.now();
            const results = yield* m.sync.pollInbox([account.id]);
            // The regression waits out the busy timeout.
            assert.isBelow(performance.now() - started, LOCK_WAIT_BOUND_MS);
            assert.isTrue(results[0]?.needsReauth);
          } finally {
            writer.exec("ROLLBACK");
            writer.close();
          }
          assert.isFalse((yield* store.getAccount(account.id)).needsReauth);
          const pulls = server.pulls.length;
          const next = yield* m.sync.pollInbox([account.id]);
          assert.isTrue(next[0]?.needsReauth);
          assert.isTrue((yield* store.getAccount(account.id)).needsReauth);
          assert.strictEqual(server.pulls.length, pulls);
        }).pipe(
          Effect.provide(
            TestMailbox.withAdapter(rejectPull, {
              servers: { gmail: server },
              platformOptions: { database: file, busyTimeoutMs: LONG_BUSY_TIMEOUT_MS },
            }),
          ),
          Effect.scoped,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  30_000,
);
