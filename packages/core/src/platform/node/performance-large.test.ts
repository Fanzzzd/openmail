import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, join } from "node:path";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Stream, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { Mailbox } from "../../mailbox/mailbox.js";
import { Store } from "../../store/service.js";
import { MailToolkit, MailToolkitLayer } from "../../tools/tools.js";
import { AgentIdentity } from "../../tools/agent-identity.js";
import { visibleHtmlText } from "../../visible-text/visible-text.js";
import { sanitizeReaderHtml } from "../../reader/reader-sanitize.js";
import { structuredMailEvents } from "../../calendar/structured-events.js";
import { incoming } from "./testing.js";
import { PERF_FACTOR, perfBudget } from "../../../test-support/perf-budget.js";
import { calibratedMs, perfCalibration } from "../../../test-support/perf-calibration.js";
import {
  HELD_FIXTURE_DRAFTS,
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
    // The fixed work runs first, on an idle process, so the ratio reflects the machine.
    const calibration = perfCalibration();
    const trace = traceQueries();
    const mailbox = PerformanceMailbox();
    const handlers = MailToolkitLayer.pipe(
      Layer.provide(mailbox),
      Layer.provide(AgentIdentity.fixed("mcp", "perf")),
    );
    const results: {
      name: string;
      medianMs: number;
      calibratedMs: number;
      maxMs: number;
      budgetMs: number;
      loadAverage: number[];
      samplesMs: number[];
      queries: QueryPlan[];
      /** The first pass, when contention spread its samples and the measurement ran again. */
      contendedPass?: {
        medianMs: number;
        maxMs: number;
        loadAverage: number[];
        samplesMs: number[];
      };
    }[] = [];
    return Effect.gen(function* () {
      const store = yield* Store,
        sql = yield* SqlClient.SqlClient,
        mail = yield* Mailbox,
        toolkit = yield* MailToolkit;
      yield* TestClock.setTime(fixtureNow);
      process.stdout.write(
        `Calibration: CPU ${calibration.cpuMs.toFixed(1)} ms, SQLite ${calibration.sqliteMs.toFixed(1)} ms, ratio ${calibration.ratio.toFixed(2)}\n`,
      );
      const seedStart = performance.now();
      const seedPhases = yield* seedMailbox(100_000);
      const seedMs = performance.now() - seedStart;
      process.stdout.write(
        `Seed phases (ms): ${Object.entries(seedPhases)
          .map(([phase, ms]) => `${phase} ${Math.round(ms)}`)
          .join(", ")}\n`,
      );
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
              withinBudgets: results.every(
                (result) => result.medianMs < perfBudget(result.budgetMs),
              ),
              budgetFactor: PERF_FACTOR,
              node: process.version,
              messages: 100_000,
              accounts: 3,
              labels: 200,
              threads: 20_000,
              longestChain: 204,
              htmlBytes: Buffer.byteLength(largeHtml),
              calibration,
              seedMs,
              seedPhases,
              calibratedSeedPhases: Object.fromEntries(
                Object.entries(seedPhases).map(([phase, ms]) => [phase, calibratedMs(ms)]),
              ),
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
          // A comma-separated list of measurement names runs only those.
          if (
            process.env.OPENMAIL_PERF_MEASURE &&
            !process.env.OPENMAIL_PERF_MEASURE.split(",").includes(name)
          )
            return;
          trace.start();
          yield* effect;
          const queries = trace.stop();
          const pass = Effect.gen(function* () {
            const times: number[] = [];
            for (let i = 0; i < iterations; i++) {
              const start = performance.now();
              yield* effect;
              times.push(performance.now() - start);
            }
            times.sort((a, b) => a - b);
            return {
              medianMs: times[Math.floor(times.length / 2)] ?? 0,
              maxMs: times.at(-1) ?? 0,
              loadAverage: loadavg(),
              samplesMs: times,
            };
          });
          const report = (label: string, run: { medianMs: number; maxMs: number }) =>
            process.stdout.write(
              `${label}: ${run.medianMs.toFixed(2)} ms (calibrated ${calibratedMs(run.medianMs).toFixed(2)}, max ${run.maxMs.toFixed(2)}, budget ${budgetMs})\n`,
            );
          let run = yield* pass;
          let contendedPass: typeof run | undefined;
          // Over budget with the slowest run more than 3x the fastest: other processes took the
          // CPU for part of the pass. A regression slows every run, so it fails the second pass too.
          if (run.medianMs >= perfBudget(budgetMs) && run.maxMs > 3 * (run.samplesMs[0] ?? 0)) {
            report(`${name} (contended, measuring again)`, run);
            contendedPass = run;
            run = yield* pass;
          }
          results.push({
            name,
            medianMs: run.medianMs,
            calibratedMs: calibratedMs(run.medianMs),
            maxMs: run.maxMs,
            budgetMs,
            loadAverage: run.loadAverage,
            samplesMs: run.samplesMs,
            queries,
            ...(contendedPass ? { contendedPass } : {}),
          });
          writeReport();
          report(name, run);
        });
      const gmail = fixtureAccounts[0],
        imap = fixtureAccounts[2];
      // The provider copies of the drafts whose discard is held.
      const heldDrafts = new Set(
        Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String })))(
          yield* sql`SELECT d.account_id || '/' || d.remote_message_id AS id FROM drafts d JOIN draft_discards x ON x.id=d.id`,
        ).map((row) => row.id),
      );
      assert.strictEqual(heldDrafts.size, HELD_FIXTURE_DRAFTS);
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
      // 2,000 draft messages, each linked to its local draft, and a few held for their Undo.
      yield* measure(
        "drafts first page",
        50,
        store.listThreads({ mailbox: "drafts", limit: 50 }).pipe(
          Effect.tap((rows) =>
            Effect.sync(() => {
              assert.strictEqual(rows.length, 50);
              assert.ok(rows.every((row) => row.labels.includes("DRAFT") && row.recipients));
              assert.ok(rows.every((row) => !heldDrafts.has(row.id)));
            }),
          ),
        ),
      );
      yield* measure(
        "badges with drafts",
        100,
        store
          .unreadByLabel(undefined, undefined, false)
          .pipe(
            Effect.tap((counts) =>
              Effect.sync(() => assert.strictEqual(counts["DRAFT"], 2_000 - HELD_FIXTURE_DRAFTS)),
            ),
          ),
      );
      // A change refreshes the list on screen. At the top it reads two pages however many rows
      // are loaded (refreshPages in the renderer); the 2,000-row read is what it cost before.
      yield* measure(
        "list refresh at the top",
        75,
        store.listThreads({ mailbox: "inbox", limit: 200 }),
      );
      yield* measure(
        "list refresh of 2,000 loaded rows",
        600,
        store.listThreads({ mailbox: "inbox", limit: 2000 }),
      );
      // Every system refresh (each change, focus and 15 s tick) reads the notification queue.
      yield* measure("empty notification queue", 5, store.takeNotifications(fixtureNow));
      // Sparse matches: 100 of 100k messages carry a Google Sheet link.
      for (const [name, search] of [
        ["search has:drive", "has:drive"],
        ["search has:spreadsheet", "has:spreadsheet"],
      ] as const)
        yield* measure(
          name,
          50,
          store
            .listThreads({ search, limit: 50 })
            .pipe(Effect.tap((rows) => Effect.sync(() => assert.strictEqual(rows.length, 50)))),
        );
      for (const [name, search, budget] of [
        ["search common", "weekly", 150],
        ["search CJK", "预算批准", 150],
        ["search operators", "from:person2 is:unread has:attachment after:2026-09-01", 150],
        ["search AROUND", '"alpha AROUND 0 beta"', 500],
        ["search AROUND 3", "alpha AROUND 3 beta", 475],
      ] as const)
        yield* measure(name, budget, store.listThreads({ search, limit: 50 }));
      // Each thread carries one of 67 folders, so Folder_5 is on 1 in 67 messages; `weekly` is in
      // every message. label: matches a label id or a label name in any case.
      for (const [name, search] of [
        ["search label: id", "label:Folder_5"],
        ["search label: name", 'label:"folder 5"'],
        ["search label: and common word", "label:Folder_5 weekly"],
      ] as const)
        yield* measure(
          name,
          200,
          store
            .listThreads({ search, limit: 50 })
            .pipe(Effect.tap((rows) => Effect.sync(() => assert.strictEqual(rows.length, 50)))),
        );
      // Every subject has `report`, every body `weekly` and `alpha`, and invoice is only in the
      // 10k OCR chunks. Without a match, to:, cc:, filename: and list: test every message.
      for (const [name, search, budget, threads] of [
        ["search subject: common", "subject:report", 200, 50],
        ["search subject: phrase", 'subject:"weekly report"', 200, 50],
        ["search OR", "weekly OR alpha", 200, 50],
        ["search OR is:unread", "(weekly OR delivery) is:unread", 200, 50],
        ["search attachment word OR common", "invoice OR weekly", 200, 50],
        ["search to: no match", "to:nobody@example.com", 200, 0],
        ["search cc: no match", "cc:nobody", 200, 0],
        ["search filename: no match", "filename:none.pdf", 200, 0],
        ["search list: no match", "list:nolist", 200, 0],
        // from:, has:attachment and to: with a common word walk the date index. Starting from
        // the 100k rowids of `weekly` took 0.4-0.8 s on fixture R. A sender with no match walks
        // the whole date index once.
        ["search -to: and common word", "-to:nobody weekly", 200, 50],
        ["search from: and common word", "from:person1 weekly", 200, 50],
        ["search has:attachment and common word", "has:attachment weekly", 200, 50],
        ["search from: no match and common word", "from:nobody weekly", 350, 0],
        // No match: the fast pass's empty window is the answer, so the date index is walked once.
        [
          "search negations, no match and common word",
          "-is:important -has:attachment from:nobody weekly",
          350,
          0,
        ],
      ] as const)
        yield* measure(
          name,
          budget,
          store
            .listThreads({ search, limit: 50 })
            .pipe(
              Effect.tap((rows) => Effect.sync(() => assert.strictEqual(rows.length, threads))),
            ),
        );
      // is:important tests labels_json with a bare json_each EXISTS. A flat page ran the word
      // index probe before it (863 ms on 50k messages); one account walked the account index and
      // read labels_json from the table. 100 of 100k messages are important.
      for (const [name, search, query] of [
        ["search is:important and common word, flat", "is:important weekly", { flat: true }],
        [
          "search is:important and common word, flat, one account",
          "is:important weekly",
          { flat: true, accountIds: [gmail] },
        ],
        [
          "search Important list filter and common word, flat",
          "weekly",
          {
            flat: true,
            listFilters: {
              enabled: true,
              unread: false,
              starred: false,
              important: true,
              inInbox: false,
            },
          },
        ],
      ] as const) {
        const expected = Math.min(50, yield* store.countThreads({ ...query, search }));
        assert.isAbove(expected, 0, name);
        yield* measure(
          name,
          200,
          store
            .listThreads({ ...query, search, limit: 50 })
            .pipe(
              Effect.tap((rows) => Effect.sync(() => assert.strictEqual(rows.length, expected))),
            ),
        );
      }
      // One account of three: the thread fast pass's `recent` CTE scoped its rows only inside a
      // CASE, so a one-account search walked messages_account_list_date_id across every account
      // (from:nobody weekly on a 100-message account: 111 ms before, 0.6 ms after, on 100k).
      for (const [name, search, budget, threads] of [
        ["search one account from: no match and common word", "from:nobody weekly", 200, 0],
        ["search one account from: and common word", "from:person1 weekly", 200, 50],
        ["search one account is:unread and common word", "is:unread weekly", 200, 50],
        ["search one account common word", "weekly", 150, 50],
      ] as const)
        yield* measure(
          name,
          budget,
          store
            .listThreads({ search, limit: 50, accountIds: [gmail] })
            .pipe(
              Effect.tap((rows) => Effect.sync(() => assert.strictEqual(rows.length, threads))),
            ),
        );
      // A count reads Spam/Trash eligibility from message_search_meta. Reading labels_json, after
      // the body columns, took 0.4 s warm and 3.4 s cold for `weekly OR alpha` on fixture R.
      // These run warm: the suite cannot clear the system page cache.
      for (const [name, search, threads] of [
        ["count OR", "weekly OR alpha", 20_000],
        ["count operator OR common word", "to:nobody OR weekly", 20_000],
        ["count -to: and common word", "-to:nobody weekly", 20_000],
      ] as const)
        yield* measure(
          name,
          250,
          store
            .countThreads({ search })
            .pipe(Effect.tap((n) => Effect.sync(() => assert.strictEqual(n, threads)))),
          // Nine runs: on a shared runner a burst of load can cover two of five runs.
          9,
        );
      // The sidebar's label view lists one label id, across accounts or in one account.
      for (const [name, accountIds] of [
        ["list label view", undefined],
        ["list label view, one account", [gmail]],
      ] as const)
        yield* measure(
          name,
          200,
          store
            .listThreads({
              mailbox: "all",
              label: "Folder_5",
              limit: 50,
              ...(accountIds ? { accountIds } : {}),
            })
            .pipe(Effect.tap((rows) => Effect.sync(() => assert.strictEqual(rows.length, 50)))),
        );
      // A label view with the search scope set to the current folder sends the view's label and
      // mailbox with the search. These walk the date index like `label:Folder_5 weekly`.
      for (const [name, search, mailbox, flat] of [
        ["search current folder in label view", "weekly", "all", false],
        ["search current folder in label view subject:", "subject:weekly alpha", "all", false],
        ["search current folder in label view flat", "weekly", "all", true],
        ["search current folder in label view Inbox", "weekly", "inbox", false],
      ] as const)
        yield* measure(
          name,
          200,
          store
            .listThreads({
              search,
              searchScope: "folder",
              mailbox,
              label: "Folder_5",
              flat,
              limit: 50,
            })
            .pipe(Effect.tap((rows) => Effect.sync(() => assert.strictEqual(rows.length, 50)))),
        );
      // While the person types, the search field runs the unfinished last word as a prefix.
      // The word index has no prefix index, so each probe of `pe*` expands it over all terms.
      for (const search of ["we*", "week*", "person", "pe*", "weekly de*", "weekly delivery"])
        yield* measure(
          `search typed ${search}`,
          150,
          store
            .listThreads({ search, limit: 50 })
            .pipe(Effect.tap((rows) => Effect.sync(() => assert.strictEqual(rows.length, 50)))),
        );
      // Ten of 100k messages contain 鲸鱼. One and two CJK characters are too short for trigrams;
      // a sparse lookup gets the has:drive budget, a term in every message the CJK search budget.
      for (const [name, search, budget, threads] of [
        ["search CJK rare 2-char", "鲸鱼", 50, 10],
        ["search CJK rare 1-char", "鲸", 50, 10],
        ["search CJK common 2-char", "预算", 150, 50],
        ["search CJK common 1-char", "会", 150, 50],
      ] as const)
        yield* measure(
          name,
          budget,
          store
            .listThreads({ search, limit: 50 })
            .pipe(
              Effect.tap((rows) => Effect.sync(() => assert.strictEqual(rows.length, threads))),
            ),
        );
      // The search field looks people up from the third typed character, as in "per".
      for (const [name, query] of [
        ["people suggestion prefix", "per"],
        ["people suggestion name", "person42"],
      ] as const)
        yield* measure(
          name,
          30,
          store
            .suggestContacts(query, 2)
            .pipe(Effect.tap((rows) => Effect.sync(() => assert.strictEqual(rows.length, 2)))),
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
        mail.reading.threadForModel(`${gmail}/m0`, 12000),
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
      // MCP reads only accounts with AI consent; without it both tools return nothing.
      for (const accountId of fixtureAccounts)
        yield* mail.ai.setAiAccount({ accountId, allowed: true, autoSummaries: false });
      const threadCount = (value: unknown) =>
        typeof value === "object" &&
        value !== null &&
        "threads" in value &&
        Array.isArray(value.threads)
          ? value.threads.length
          : 0;
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
            assert.isAbove(Option.isSome(result) ? threadCount(result.value.result) : 0, 0);
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
          perfBudget(result.budgetMs),
          `${result.name}: ${result.medianMs.toFixed(2)} ms exceeds ${perfBudget(result.budgetMs)} ms`,
        );
    }).pipe(
      Effect.provide(Layer.mergeAll(handlers, mailbox, AgentIdentity.fixed("mcp", "perf"))),
      Effect.ensuring(Effect.sync(trace.restore)),
    );
  },
  { timeout: 1_200_000 },
);

for (const messageCount of [20_000, 100_000]) {
  it.effect(
    `${messageCount / 1000}k dense NEAR with sparse exact matches stays within the fallback budget`,
    () => {
      const calibration = perfCalibration();
      const trace = traceQueries();
      return Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA cache_size=-8192`;
        const account = yield* store.upsertAccount("gmail", "sparse-perf@example.com");
        for (let start = 0; start < messageCount; start += 500) {
          yield* store.transaction(
            Effect.gen(function* () {
              for (let i = start; i < start + 500; i++) {
                yield* store.upsertMessage(
                  account.id,
                  incoming(`m${i}`, {
                    threadId: `t${i}`,
                    date: i,
                    subject: "Mail",
                    from: { name: "Sender", address: "sender@example.com" },
                    bodyText: i < 3 ? "alpha one beta" : "beta one alpha",
                    bodyHtml: "",
                    labels: ["INBOX"],
                    attachments: [],
                    isUnread: false,
                    isStarred: false,
                  }),
                );
              }
            }),
          );
          if (start % 10_000 === 0)
            process.stdout.write(`Seeded sparse ${start + 500}/${messageCount}\n`);
        }
        while (!(yield* store.backfillWordIndex(500)).ready) {
          /* finish indexes */
        }
        yield* sql`ANALYZE`;
        const results = [];
        const before = messageCount - 2000;
        for (const [name, query, expected, budgetMs] of [
          ["search AROUND sparse exact", { search: '"alpha AROUND 2 beta"' }, [2, 1, 0], 500],
          [
            "search AROUND sparse exact flat",
            { search: '"alpha AROUND 2 beta"', flat: true },
            [2, 1, 0],
            500,
          ],
          ["search AROUND sparse negated", { search: '-("beta AROUND 2 alpha")' }, [2, 1, 0], 500],
          [
            "search AROUND deep cursor",
            { search: '"beta AROUND 2 alpha"', before },
            Array.from({ length: 50 }, (_, i) => before - 1 - i),
            1500,
          ],
        ] as const) {
          const run = store.listThreads({ ...query, limit: 50 }).pipe(
            Effect.tap((rows) =>
              Effect.sync(() =>
                assert.deepStrictEqual(
                  rows.map((row) => row.id),
                  expected.map((i) => `${account.id}/m${i}`),
                ),
              ),
            ),
          );
          trace.start();
          yield* run;
          const queries = trace.stop();
          const samplesMs: number[] = [];
          for (let i = 0; i < 5; i++) {
            const start = performance.now();
            yield* run;
            samplesMs.push(performance.now() - start);
          }
          const medianMs = samplesMs.toSorted((a, b) => a - b)[2] ?? 0;
          results.push({
            name,
            medianMs,
            calibratedMs: calibratedMs(medianMs),
            budgetMs,
            samplesMs,
            loadAverage: loadavg(),
            queries,
          });
          process.stdout.write(`${name}: ${medianMs.toFixed(2)} ms (budget ${budgetMs})\n`);
        }
        const output =
          process.env.OPENMAIL_SPARSE_PERF_REPORT ?? "/tmp/openmail-around-sparse-performance.json";
        const reportPath = messageCount === 100_000 ? output : `${output}.${messageCount}.json`;
        writeFileSync(
          reportPath,
          `${JSON.stringify({ messages: messageCount, exactMatches: 3, node: process.version, calibration, results }, null, 2)}\n`,
        );
        process.stdout.write(`Sparse report: ${reportPath}\n`);
        for (const result of results)
          assert.isBelow(result.medianMs, perfBudget(result.budgetMs), result.name);
      }).pipe(Effect.provide(PerformanceMailbox()), Effect.ensuring(Effect.sync(trace.restore)));
    },
    { timeout: 1_200_000 },
  );
}

// The 100k fixture repeats a few words. Real mail has a long tail, so a two-letter prefix such
// as `co*` stands for many terms, and each per-row probe expanded all of them (650 ms). A prefix
// that every message matches (`se*`) is measured too.
it.effect(
  "typed prefixes over a 100k mailbox with a long-tail vocabulary stay within budget",
  () => {
    perfCalibration();
    return Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA cache_size=-8192`;
      const account = yield* store.upsertAccount("gmail", "vocabulary-perf@example.com");
      const syllables = [
        "co",
        "re",
        "an",
        "pro",
        "sta",
        "de",
        "mi",
        "lo",
        "ver",
        "tin",
        "ka",
        "su",
        "pe",
        "ri",
        "on",
        "ba",
        "el",
        "gu",
        "ny",
        "or",
        "the",
        "in",
        "mar",
        "sel",
        "ex",
        "ho",
        "qua",
        "di",
        "ten",
        "ul",
        "se",
        "fa",
        "ge",
        "po",
        "wi",
        "ar",
        "cu",
        "ne",
        "bo",
        "li",
      ];
      let seed = 7;
      const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      // 50,000 made-up words of two to four syllables, drawn with a heavy head and a long tail.
      const vocabulary = Array.from({ length: 50_000 }, () => {
        const length = 2 + Math.floor(random() * 3);
        let text = "";
        for (let i = 0; i < length; i++)
          text += syllables[Math.floor(random() * syllables.length)] ?? "";
        return text;
      });
      const word = () => vocabulary[Math.floor(Math.pow(random(), 3) * vocabulary.length)] ?? "";
      for (let start = 0; start < 100_000; start += 500) {
        yield* store.transaction(
          Effect.gen(function* () {
            for (let i = start; i < start + 500; i++)
              yield* store.upsertMessage(
                account.id,
                incoming(`m${i}`, {
                  threadId: `t${Math.floor(i / 3)}`,
                  date: fixtureNow - (100_000 - i) * 60_000,
                  subject: Array.from({ length: 4 }, word).join(" "),
                  from: { name: "Sender", address: "sender@example.com" },
                  bodyText: Array.from({ length: 30 }, word).join(" "),
                  bodyHtml: "",
                  labels: ["INBOX"],
                  attachments: [],
                  isUnread: i % 3 === 0,
                  isStarred: false,
                }),
              );
          }),
        );
        if (start % 20_000 === 0) process.stdout.write(`Seeded vocabulary ${start + 500}/100000\n`);
      }
      while (!(yield* store.backfillWordIndex(2000)).ready) {
        /* finish the index */
      }
      const results: {
        name: string;
        medianMs: number;
        calibratedMs: number;
        budgetMs: number;
        samplesMs: number[];
        loadAverage: number[];
      }[] = [];
      const common = vocabulary[0] ?? "";
      const rare = vocabulary.at(-1) ?? "";
      // `se` starts the syllables se and sel, so `se*` stands for about 2,500 words and every
      // message has one. A page ran BM25 over that whole prefix: `se* co*` took 157 ms.
      const [everywhere] = yield* sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM messages_words WHERE messages_words MATCH '"se"*'`;
      assert.isAbove(everywhere?.n ?? 0, 90_000, "se* hits most of the mailbox");
      for (const [search, flat] of [
        ["co*", false],
        ["re*", false],
        ["an*", false],
        ["pro*", false],
        ["sta*", false],
        ["the*", false],
        [`${common} re*`, false],
        [rare, false],
        ["se*", false],
        ["se*", true],
        ["se* co*", false],
        ["a*", true],
      ] as const) {
        const name = `search vocabulary ${search}${flat ? " flat" : ""}`;
        const run = store.listThreads({ search, limit: 50, flat });
        const first = yield* run;
        if (search !== rare) assert.strictEqual(first.length, 50, name);
        const samplesMs: number[] = [];
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          yield* run;
          samplesMs.push(performance.now() - start);
        }
        const medianMs = samplesMs.toSorted((a, b) => a - b)[2] ?? 0;
        results.push({
          name,
          medianMs,
          calibratedMs: calibratedMs(medianMs),
          budgetMs: 150,
          samplesMs,
          loadAverage: loadavg(),
        });
        process.stdout.write(
          `${name}: ${medianMs.toFixed(2)} ms (calibrated ${calibratedMs(medianMs).toFixed(2)}, budget 150)\n`,
        );
      }
      // Next to OPENMAIL_PERF_REPORT, so perf.yml's performance-report artifact includes it.
      const report = join(
        dirname(process.env.OPENMAIL_PERF_REPORT ?? "/tmp/openmail-performance.json"),
        "openmail-vocabulary-performance.json",
      );
      writeFileSync(
        report,
        `${JSON.stringify(
          {
            withinBudgets: results.every((result) => result.medianMs < perfBudget(result.budgetMs)),
            budgetFactor: PERF_FACTOR,
            node: process.version,
            messages: 100_000,
            vocabulary: vocabulary.length,
            calibration: perfCalibration(),
            results,
          },
          null,
          2,
        )}\n`,
      );
      process.stdout.write(`Vocabulary report: ${report}\n`);
      for (const result of results)
        assert.isBelow(result.medianMs, perfBudget(result.budgetMs), result.name);
    }).pipe(Effect.provide(PerformanceMailbox()));
  },
  { timeout: 1_200_000 },
);
