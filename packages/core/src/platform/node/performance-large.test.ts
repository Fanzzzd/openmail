import { writeFileSync } from "node:fs";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Stream, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { Mailbox } from "../../mailbox.js";
import { Store } from "../../services.js";
import { AgentIdentity, MailToolkit, MailToolkitLayer } from "../../tools.js";
import { visibleHtmlText } from "../../visible-text.js";
import { sanitizeReaderHtml } from "../../reader-sanitize.js";
import { structuredMailEvents } from "../../structured-events.js";
import {
  PerformanceMailbox,
  fixtureAccounts,
  fixtureNow,
  largeHtml,
  seedMailbox,
  traceQueries,
  type QueryPlan,
} from "./fixtures/performance-mailbox.js";
it.effect(
  "100k mailbox stays within local performance budgets",
  () => {
    const trace = traceQueries();
    const mailbox = PerformanceMailbox();
    const handlers = MailToolkitLayer.pipe(
      Layer.provide(mailbox),
      Layer.provide(AgentIdentity.fixed("mcp", "perf")),
    );
    const results: {
      name: string;
      medianMs: number;
      maxMs: number;
      budgetMs: number;
      queries: QueryPlan[];
    }[] = [];
    return Effect.gen(function* () {
      const store = yield* Store,
        sql = yield* SqlClient.SqlClient,
        mail = yield* Mailbox,
        toolkit = yield* MailToolkit;
      yield* TestClock.setTime(fixtureNow);
      const seedStart = performance.now();
      yield* seedMailbox(100_000);
      const seedMs = performance.now() - seedStart;
      const [counts] =
        yield* sql`SELECT COUNT(*) AS messages, (SELECT COUNT(*) FROM (SELECT account_id,thread_id FROM messages GROUP BY account_id,thread_id)) AS threads, (SELECT COUNT(*) FROM labels) AS labels FROM messages`;
      assert.deepStrictEqual(counts, { messages: 100_000, threads: 20_000, labels: 200 });

      const output = process.env.OPENMAIL_PERF_REPORT ?? "/tmp/openmail-performance.json";
      let complete = false;
      const writeReport = () => {
        writeFileSync(
          output,
          `${JSON.stringify(
            {
              complete,
              withinBudgets: results.every((result) => result.medianMs < result.budgetMs),
              node: process.version,
              messages: 100_000,
              accounts: 3,
              labels: 200,
              threads: 20_000,
              longestChain: 204,
              htmlBytes: Buffer.byteLength(largeHtml),
              seedMs,
              memory: process.memoryUsage(),
              results,
            },
            null,
            2,
          )}\n`,
        );
      };
      const measure = <A, E>(
        name: string,
        budgetMs: number,
        effect: Effect.Effect<A, E>,
        iterations = 5,
      ) =>
        Effect.gen(function* () {
          trace.start();
          yield* effect;
          const queries = trace.stop();
          const times: number[] = [];
          for (let i = 0; i < iterations; i++) {
            const start = performance.now();
            yield* effect;
            times.push(performance.now() - start);
          }
          times.sort((a, b) => a - b);
          const medianMs = times[Math.floor(times.length / 2)] ?? 0;
          const maxMs = times.at(-1) ?? 0;
          results.push({ name, medianMs, maxMs, budgetMs, queries });
          writeReport();
          process.stdout.write(
            `${name}: ${medianMs.toFixed(2)} ms (max ${maxMs.toFixed(2)}, budget ${budgetMs})\n`,
          );
        });
      const gmail = fixtureAccounts[0],
        imap = fixtureAccounts[2];
      yield* measure("provider identity miss", 5, store.messageIdForProvider(gmail, "absent"));
      yield* measure("sync health label", 150, store.syncHealthLocal(gmail, "Folder_0", false));
      yield* measure("sync health IMAP", 100, store.syncHealthLocal(imap, "Folder_2", true));
      yield* measure("sync health labels", 150, store.syncHealthLabels(gmail, true));
      yield* measure(
        "stale label page",
        100,
        store.staleCandidates(gmail, ["INBOX", "DRAFT"], false, "m50000", 100),
      );
      yield* measure(
        "stale IMAP page",
        100,
        store.staleCandidates(imap, ["Folder_2"], true, "7:50000:Folder_2", 100),
      );
      yield* measure(
        "reset account window",
        200,
        store.resetCandidates(gmail, { _tag: "Reset", keep: [], since: fixtureNow - 7 * 86400000 }),
      );
      yield* measure(
        "reset label window",
        150,
        store.resetCandidates(gmail, {
          _tag: "DeleteLabel",
          label: "Folder_0",
          keep: [],
          since: fixtureNow - 30 * 86400000,
        }),
      );
      yield* measure(
        "reset IMAP window",
        150,
        store.resetCandidates(imap, {
          _tag: "RebuildFolder",
          previous: { path: "Folder_2", uidValidity: "7" },
          keep: [],
          since: fixtureNow - 30 * 86400000,
        }),
      );
      yield* measure("unread account badges", 100, store.unreadCounts);
      yield* measure("unread label badges", 100, store.unreadByLabel(undefined, undefined, true));
      yield* measure(
        "Inbox category conversation badges",
        100,
        store.unreadByLabel(undefined, "INBOX", true),
      );
      yield* measure(
        "Inbox category message badges",
        100,
        store.unreadByLabel(undefined, "INBOX", false),
      );
      yield* measure("list first page", 75, store.listThreads({ mailbox: "inbox", limit: 50 }));
      for (const [name, search] of [
        ["search common", "weekly"],
        ["search CJK", "预算批准"],
        ["search operators", "from:person2 is:unread has:attachment after:2026-09-01"],
        ["search AROUND", '"alpha AROUND 0 beta"'],
      ] as const)
        yield* measure(
          name,
          name === "search AROUND" ? 500 : 150,
          store.listThreads({ search, limit: 50 }),
        );
      yield* measure(
        "search mixed body+OCR 200",
        100,
        store.listThreads({ search: "weekly", limit: 200 }).pipe(
          Effect.tap((rows) =>
            Effect.sync(() => {
              assert.strictEqual(rows.length, 200);
              assert.isTrue(
                rows.every((row) =>
                  row.searchMatches?.some(
                    (match) => match.source === "subject" || match.source === "body",
                  ),
                ),
              );
              assert.isTrue(
                rows.some((row) =>
                  row.searchMatches?.some(
                    (match) => match.source === "attachment" && match.highlights.length > 0,
                  ),
                ),
              );
            }),
          ),
        ),
      );
      yield* measure(
        "search OCR snippet",
        150,
        store.listThreads({ search: "in:attachment invoice", limit: 50 }).pipe(
          Effect.tap((rows) =>
            Effect.sync(() => {
              assert.strictEqual(rows.length, 50);
              assert.isTrue(
                rows.every((row) =>
                  row.searchMatches?.some(
                    (match) =>
                      match.source === "attachment" &&
                      match.attachmentName === "report.pdf" &&
                      match.highlights.length > 0,
                  ),
                ),
              );
            }),
          ),
        ),
      );
      yield* measure(
        "thread open long chain",
        100,
        store
          .getThread(`${gmail}/m0`)
          .pipe(Effect.tap((rows) => Effect.sync(() => assert.strictEqual(rows.length, 204)))),
      );
      yield* measure(
        "thread model text long chain",
        500,
        mail.threadForModel(`${gmail}/m0`, 12000),
      );
      assert.strictEqual(Buffer.byteLength(largeHtml), 200 * 1024);
      yield* measure(
        "visible text 200 KiB",
        150,
        Effect.sync(() => {
          assert.include(visibleHtmlText(largeHtml).text, "预算");
        }),
      );
      yield* measure(
        "sanitizer 200 KiB",
        200,
        Effect.sync(() => {
          assert.notInclude(sanitizeReaderHtml(largeHtml), "application/ld+json");
        }),
      );
      yield* measure(
        "structured events 200 KiB",
        100,
        Effect.sync(() => {
          assert.strictEqual(structuredMailEvents(largeHtml, "Review").events.length, 1);
        }),
      );
      for (const [name, params] of [
        ["list_threads", { limit: 50 }],
        ["search", { query: "weekly", limit: 20 }],
      ] as const)
        yield* measure(
          `MCP ${name}`,
          200,
          Effect.gen(function* () {
            const stream = yield* toolkit.handle(name, params);
            const result = yield* Stream.runLast(stream);
            assert.isTrue(Option.isSome(result) && !result.value.isFailure);
          }),
        );
      // Roll back each timed mutation, so every repetition sees the same rows, bodies and queue.
      class Rollback extends Schema.TaggedError<Rollback>()("PerfRollback", {}) {}
      const rollback = <A, E>(operation: Effect.Effect<A, E>) =>
        store
          .transaction(operation.pipe(Effect.andThen(Effect.fail(new Rollback()))))
          .pipe(Effect.catchTag("PerfRollback", () => Effect.void));
      yield* measure(
        "stale claim and position",
        25,
        rollback(
          store
            .claimStaleSweep(gmail, fixtureNow)
            .pipe(Effect.andThen(store.saveStaleSweepPosition(gmail, "m50000"))),
        ),
      );
      yield* measure(
        "reset candidate persistence",
        50,
        rollback(
          store
            .saveResetCandidates(gmail, [
              { providerId: "m0", rfcMessageId: "<message0@example.com>", labels: ["INBOX"] },
            ])
            .pipe(
              Effect.andThen(store.pendingResetCandidates(gmail)),
              Effect.andThen(store.saveResetCandidates(gmail, [])),
            ),
        ),
      );
      const mappings = Array.from({ length: 100 }, (_, i) => ({
        from: `7:${8 + 12 * i}:Folder_${(2 + 3 * i) % 66}`,
        to: `8:${8 + 12 * i}:Folder_${(2 + 3 * i) % 66}`,
      }));
      yield* measure(
        "remap 100 identities",
        250,
        rollback(store.remapProviderIds(imap, mappings)),
        3,
      );
      yield* measure(
        "invalidate IMAP folder",
        500,
        rollback(store.invalidateImapFolder(imap, { path: "Folder_2", uidValidity: "7" })),
        3,
      );
      const sizes = yield* store.bodySizes;
      const total = sizes.reduce((n, row) => n + row.bytes, 0);
      yield* measure("body sizes", 150, store.bodySizes);
      yield* measure(
        "body budget protected scan",
        5000,
        rollback(
          store
            .evictBodyBudget(total - 1, true)
            .pipe(Effect.tap((count) => Effect.sync(() => assert.strictEqual(count, 0)))),
        ),
        3,
      );
      // Explicit finite windows make this an eviction benchmark, not a protected-row no-op.
      for (const accountId of fixtureAccounts)
        yield* store.setCacheWindow({ accountId, label: "INBOX", days: 30 });
      yield* measure(
        "body budget evict 1 MiB",
        500,
        rollback(
          store
            .evictBodyBudget(total - 1024 * 1024, true)
            .pipe(Effect.tap((count) => Effect.sync(() => assert.isAbove(count, 0)))),
        ),
        3,
      );
      yield* measure(
        "body budget hourly skip",
        25,
        rollback(
          store
            .evictBodyBudget(total + 1, true)
            .pipe(Effect.andThen(store.evictBodyBudget(total - 1))),
        ),
      );
      // Preserve rowid-based external FTS integrity after all mutation benchmarks.
      yield* sql`INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)`;
      yield* sql`INSERT INTO messages_words(messages_words,rank) VALUES('integrity-check',1)`;
      complete = true;
      writeReport();
      process.stdout.write(`Report: ${output}\n`);
      for (const result of results)
        assert.isBelow(
          result.medianMs,
          result.budgetMs,
          `${result.name}: ${result.medianMs.toFixed(2)} ms exceeds ${result.budgetMs} ms`,
        );
    }).pipe(
      Effect.provide(Layer.mergeAll(handlers, mailbox, AgentIdentity.fixed("mcp", "perf"))),
      Effect.ensuring(Effect.sync(trace.restore)),
    );
  },
  { timeout: 1_200_000 },
);
