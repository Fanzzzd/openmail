import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { IncomingMessage, ThreadQuery, ThreadSummary } from "../domain/message.js";
import { traceQueries } from "../platform/node/fixtures/performance-mailbox.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { parseSearchQuery } from "../search/search.js";
import { scaledMs } from "../../test-support/test-time.js";
import { Store } from "./service.js";
import { StoreLive } from "./store.js";
import { CommonTermRows, makeQueryStore } from "./store-query.js";

const layer = StoreLive.pipe(Layer.provideMerge(MemoryPlatform()));

// A randomized differential test from the round 22 review. CommonTermRows=0 makes every search
// that planTextPage can walk walk the date index; 1e9 starts every search from the text index's
// rowids. Both plans must return the same pages, second pages, flags and counts. The first
// searches (FEW) match a few threads, so thread walks also answer from the fast pass. The default
// suite runs 1,500 messages and 60 searches (120 comparisons); OPENMAIL_PERF runs 3,000 and 300.
// OPENMAIL_DIFF_SEED picks another random sequence. After the random searches, a fixed sweep runs
// folder-scope searches in label views (state/threads.ts sends the view's label and mailbox) over
// user, system and category labels and several mailboxes; each must walk.
const MESSAGES = process.env.OPENMAIL_PERF ? 3000 : 1500;
const SEARCHES = process.env.OPENMAIL_PERF ? 300 : 60;
const WALK = 0;
const ROW_SET = 1e9;

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const OPERATORS: readonly [string, ...string[]] = [
  "from:s3",
  "from:sender",
  "from:nobody",
  "is:unread",
  "is:read",
  "is:starred",
  "is:important",
  "has:attachment",
  "to:r2",
  "to:nobody",
  "cc:team",
  "cc:corp",
  "filename:report",
  "filename:pdf",
  "list:news",
  "subject:weekly",
  "subject:report",
  "label:Label_1",
  "label:IMPORTANT",
  "in:inbox",
];
const WORDS: readonly [string, ...string[]] = [
  "weekly",
  "delivery",
  "alpine",
  "report",
  "weekl*",
  "nomatchword",
  "sender",
];

// Searches with a few matching threads: a walk whose unsearched window is shorter than the page
// and whose heads all match answers from the fast pass alone (threadPage).
const FEW = [
  "from:s3 is:starred weekly",
  "from:s7 is:important has:attachment delivery",
  "from:s11 is:starred -is:read report",
  "cc:team2 from:s5 is:starred weekly",
  "from:s13 has:attachment is:starred weekly",
];

const shown = (threads: readonly ThreadSummary[]) =>
  threads.map((thread) => [
    thread.id,
    thread.threadCount,
    thread.isUnread,
    thread.isStarred,
    thread.date,
  ]);

it.effect(
  "date walk plans return the same rows as row-set plans",
  () => {
    const trace = traceQueries();
    return Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const { planTextPage } = makeQueryStore({ sql });
      const r = random(Number(process.env.OPENMAIL_DIFF_SEED ?? 11));
      const pick = <A>(values: readonly [A, ...A[]]): A =>
        values[Math.floor(r() * values.length)] ?? values[0];
      const a = (yield* store.upsertAccount("gmail", "me@example.com")).id;
      const b = (yield* store.upsertAccount("gmail", "you@example.com")).id;
      // Outlook decides CATEGORY_PERSONAL by the absence of CATEGORY_OTHER.
      const c = (yield* store.upsertAccount("outlook", "me@outlook.com")).id;
      const start = Date.parse("2026-01-01T00:00:00Z");
      const message = (i: number): IncomingMessage => ({
        providerId: `p${i}`,
        threadId: `t${r() < 0.1 ? 0 : Math.floor(i / (1 + Math.floor(r() * 6)))}`,
        subject: `${r() < 0.8 ? "Weekly" : "Planning"} ${r() < 0.5 ? "report" : "notes"} ${i % 40}`,
        from: { name: `Sender ${i % 30}`, address: `s${i % 30}@example.com` },
        to: r() < 0.1 ? [] : [{ name: `Recipient ${i % 7}`, address: `r${i % 7}@example.com` }],
        cc: r() < 0.3 ? [{ name: "Team", address: `team${i % 5}@corp.example` }] : [],
        // Three messages share each date: ties order by id.
        date: start + Math.floor(i / 3) * 60_000,
        snippet: "",
        bodyText: [
          r() < 0.85 ? "weekly" : "",
          r() < 0.6 ? "delivery" : "",
          r() < 0.01 ? "alpine" : "",
        ].join(" "),
        bodyHtml: "",
        headers: r() < 0.3 ? [{ name: "List-Id", value: "<news.example.com>" }] : [],
        labels: [
          r() < 0.05 ? "SPAM" : r() < 0.05 ? "TRASH" : r() < 0.7 ? "INBOX" : "Label_2",
          ...(r() < 0.3 ? ["UNREAD"] : []),
          ...(r() < 0.2 ? ["IMPORTANT"] : []),
          ...(r() < 0.15 ? ["Label_1"] : []),
          // Fixed by position, so the random sequence above stays as it was.
          ...(i % 13 === 0 ? ["STARRED"] : []),
          ...(i % 9 === 4 ? ["CATEGORY_SOCIAL"] : []),
          ...(i % 4 === 1 ? ["CATEGORY_PERSONAL"] : []),
          ...(i % 10 === 9 && i % 3 === 0 ? ["CATEGORY_OTHER"] : []),
        ],
        attachments:
          r() < 0.15
            ? [
                {
                  filename: r() < 0.3 ? "" : `report${i % 3}.pdf`,
                  mimeType: "application/pdf",
                  size: 10,
                },
              ]
            : [],
        isUnread: r() < 0.3,
        isStarred: r() < 0.08,
      });
      yield* store.transaction(
        Effect.gen(function* () {
          for (let i = 0; i < MESSAGES; i++)
            yield* store.upsertMessage(i % 10 === 9 ? c : i % 2 ? a : b, message(i));
        }),
      );
      while (!(yield* store.backfillWordIndex(5000)).ready) {
        /* drain */
      }
      const search = () => {
        const parts: string[] = [];
        const operators = Math.floor(r() * 3);
        for (let k = 0; k < operators; k++)
          parts.push(`${r() < 0.35 ? "-" : ""}${pick(OPERATORS)}`);
        const words = 1 + Math.floor(r() * 2);
        for (let k = 0; k < words; k++) parts.push(`${r() < 0.08 ? "-" : ""}${pick(WORDS)}`);
        if (r() < 0.1) parts.push("OR", pick(WORDS));
        return parts.toSorted(() => r() - 0.5).join(" ");
      };
      const run = (query: ThreadQuery, threshold: number) =>
        Effect.gen(function* () {
          trace.start();
          const first = yield* store.listThreads({ ...query, limit: 15 });
          // The full thread query has a page and no unsearched window.
          const fullPass = trace
            .stop()
            .some(
              (statement) =>
                statement.sql.includes("page AS MATERIALIZED (") &&
                !statement.sql.includes("recent AS MATERIALIZED ("),
            );
          const last = first.at(-1);
          const second = last
            ? yield* store.listThreads({
                ...query,
                limit: 15,
                before: last.date,
                beforeId: last.id,
              })
            : [];
          const count = yield* store.countThreads(query);
          return { fullPass, result: { first: shown(first), second: shown(second), count } };
        }).pipe(Effect.provideService(CommonTermRows, threshold));
      let compared = 0;
      let walked = 0;
      let emptyWalks = 0;
      let oneWalkEmpty = 0;
      let oneWalkShort = 0;
      const differences: string[] = [];
      for (let k = 0; k < SEARCHES; k++) {
        const few = FEW[k];
        const query: ThreadQuery = {
          search: few ?? search(),
          flat: r() < 0.4 && few === undefined,
          ...(r() < 0.25 ? { accountIds: [a] } : {}),
          ...(r() < 0.3
            ? {
                label: pick(["INBOX", "Label_1", "IMPORTANT", "STARRED", "CATEGORY_PERSONAL"]),
                searchScope: pick(["all", "folder"] as const),
                ...(r() < 0.6
                  ? { mailbox: pick(["inbox", "all", "starred", "important"] as const) }
                  : {}),
              }
            : {}),
          ...(r() < 0.15
            ? {
                listFilters: {
                  enabled: true,
                  unread: r() < 0.5,
                  starred: r() < 0.3,
                  important: r() < 0.5,
                  inInbox: r() < 0.5,
                },
              }
            : {}),
          ...(r() < 0.1 ? { unreadOnly: true } : {}),
        };
        for (const ready of [true, false]) {
          yield* sql`UPDATE message_operator_text_backfill SET ready=${ready ? 1 : 0}`;
          const planned = yield* planTextPage({
            ...parseSearchQuery(query),
            wordIndexReady: true,
            derivedWordIndexReady: true,
            operatorTextReady: ready,
          }).pipe(Effect.provideService(CommonTermRows, WALK));
          const { fullPass, result: walk } = yield* run(query, WALK);
          const { result: rows } = yield* run(query, ROW_SET);
          compared++;
          if (planned.textPage) {
            walked++;
            if (!walk.first.length) emptyWalks++;
            if (!query.flat && !fullPass && walk.first.length < 15)
              if (walk.first.length) oneWalkShort++;
              else oneWalkEmpty++;
          }
          if (JSON.stringify(walk) !== JSON.stringify(rows))
            differences.push(
              `${JSON.stringify(query)} ready=${ready}\n walk=${JSON.stringify(walk)}\n rows=${JSON.stringify(rows)}`,
            );
        }
      }
      // Folder-scope searches in a label view walk for every label and mailbox.
      const folderSearches = [
        "weekly",
        "weekly delivery",
        "subject:weekly alpine",
        "is:unread weekly",
      ];
      let sweep = 0;
      let sweepRows = 0;
      for (const label of [
        "Label_1",
        "Label_2",
        "INBOX",
        "IMPORTANT",
        "STARRED",
        "CATEGORY_SOCIAL",
        "CATEGORY_PERSONAL",
      ])
        for (const mailbox of [undefined, "inbox", "all", "starred", "important"] as const)
          for (const flat of [false, true]) {
            const query: ThreadQuery = {
              search: folderSearches[sweep % folderSearches.length] ?? "weekly",
              searchScope: "folder",
              label,
              ...(mailbox ? { mailbox } : {}),
              flat,
              ...(sweep % 3 === 0 ? { accountIds: [sweep % 2 ? a : c] } : {}),
            };
            sweep++;
            yield* sql`UPDATE message_operator_text_backfill SET ready=1`;
            const planned = yield* planTextPage({
              ...parseSearchQuery(query),
              wordIndexReady: true,
              derivedWordIndexReady: true,
              operatorTextReady: true,
            }).pipe(Effect.provideService(CommonTermRows, WALK));
            assert.isDefined(planned.textPage, JSON.stringify(query));
            const { result: walk } = yield* run(query, WALK);
            const { result: rows } = yield* run(query, ROW_SET);
            sweepRows += walk.first.length;
            if (JSON.stringify(walk) !== JSON.stringify(rows))
              differences.push(
                `${JSON.stringify(query)}\n walk=${JSON.stringify(walk)}\n rows=${JSON.stringify(rows)}`,
              );
          }
      assert.deepStrictEqual(differences, []);
      assert.isAbove(sweepRows, sweep);
      assert.strictEqual(compared, SEARCHES * 2);
      // The comparison means something only if a good share of the searches walked, some of
      // them to an empty page.
      assert.isAbove(walked, compared / 4);
      assert.isAbove(emptyWalks, 0);
      // Some thread walks answered from the fast pass alone, empty and with a few threads.
      assert.isAbove(oneWalkEmpty, 0);
      assert.isAbove(oneWalkShort, 0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(trace.restore)));
  },
  scaledMs(process.env.OPENMAIL_PERF ? 600_000 : 120_000),
);
