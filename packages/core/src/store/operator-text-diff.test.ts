import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { MailOp } from "../domain/changes.js";
import type { IncomingMessage } from "../domain/message.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { operatorTextValues } from "../db/operator-text.js";
import { scaledMs } from "../../test-support/test-time.js";
import { Store } from "./service.js";
import { StoreLive } from "./store.js";

const layer = StoreLive.pipe(Layer.provideMerge(MemoryPlatform()));

// The default suite runs 10 rounds (about 0.6 s); OPENMAIL_PERF runs 50. OPENMAIL_DIFF_SEED
// picks another random sequence.
const ROUNDS = process.env.OPENMAIL_PERF ? 50 : 10;
const WRITES_PER_ROUND = 40;

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// LIKE wildcards, quotes, backslashes, case and non-ASCII in names, files and lists.
const NAMES = ["Ann", "Bob_1", "100% Real", "Zoë", "", "ANN", "o'neil", "a\\b", "Team Lead"];
const DOMAINS = ["example.com", "corp.example", "news.example.org", "x.io"];
const FILES = ["report.pdf", "notes_1.txt", "notesA1.txt", "Invoice 50%.xlsx", "", "a.b.c"];
const LISTS = ["<news.example.org>", "<dev.list.x.io>", "Weekly <weekly.example.com>"];
const POSTS = ["<mailto:news@example.org>", "NO", "<mailto:dev@list.x.io>"];
const QUERIES = [
  "to:ann",
  "to:bob_1",
  "to:100%",
  "to:zoë",
  "to:example.com",
  "to:nobody",
  "cc:corp",
  "cc:lead",
  "cc:o'neil",
  "cc:a\\b",
  "filename:report",
  "filename:notes_1",
  "filename:50%",
  "filename:.pdf",
  "list:news@example.org",
  "list:news.example",
  "list:dev@list.x.io",
  "list:weekly",
  "list:nolist",
  "-to:ann",
  "-filename:pdf hello",
  "to:ann OR cc:corp",
  "(to:bob OR list:news) is:unread",
  "to:ann filename:report",
  "-cc:corp -to:example",
];

const OperatorRow = Schema.Struct({
  row_id: Schema.Number,
  to_text: Schema.String,
  cc_text: Schema.String,
  file_text: Schema.String,
  list_id_text: Schema.String,
  list_post_text: Schema.String,
});
const ProviderRow = Schema.Struct({ provider_id: Schema.String });
const CountRow = Schema.Struct({ n: Schema.Number });

it.effect(
  "randomized writes keep the operator text current and searches agree with the per-row test",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const r = random(Number(process.env.OPENMAIL_DIFF_SEED ?? 7));
      const pick = <A>(values: readonly A[]): A => {
        const value = values[Math.floor(r() * values.length)];
        if (value === undefined) throw new Error("pick from an empty list");
        return value;
      };
      const first = (yield* store.upsertAccount("gmail", "me@example.com")).id;
      let second = (yield* store.upsertAccount("gmail", "you@example.com")).id;
      const addresses = () =>
        Array.from({ length: Math.floor(r() * 3) }, () => {
          const name = pick(NAMES);
          const local = name.replace(/\W/g, "") || "u";
          // A nameless address keeps the case of the name it came from.
          return r() < 0.15
            ? { name: "", address: `${local}@${pick(DOMAINS)}` }
            : { name, address: `${local.toLowerCase()}@${pick(DOMAINS)}` };
        });
      const message = (pid: number): IncomingMessage => ({
        providerId: `p${pid}`,
        threadId: `t${pid % 37}`,
        subject: `hello ${pid}`,
        from: { name: "S", address: `s${pid % 5}@example.com` },
        to: addresses(),
        cc: addresses(),
        date: 1_700_000_000_000 + pid * 1000 + Math.floor(r() * 500),
        snippet: "",
        bodyText: r() < 0.5 ? "hello body" : "other",
        bodyHtml: "",
        ...(r() < 0.2
          ? {}
          : {
              headers: [
                ...(r() < 0.5
                  ? [
                      {
                        name: pick(["List-Id", "list-id", "LIST-ID"]),
                        value: pick(LISTS),
                      },
                    ]
                  : []),
                ...(r() < 0.3 ? [{ name: "List-Post", value: pick(POSTS) }] : []),
                { name: "X-Mailer", value: "nolist" },
              ],
            }),
        labels: [
          pick(["INBOX", "INBOX", "INBOX", "SPAM", "TRASH", "Label_1"]),
          ...(r() < 0.4 ? ["UNREAD"] : []),
        ],
        attachments: Array.from({ length: Math.floor(r() * 3) }, () => ({
          filename: pick(FILES),
          mimeType: "application/octet-stream",
          size: 1,
        })),
        isUnread: r() < 0.4,
        isStarred: r() < 0.1,
      });
      const live = new Map<string, Set<number>>([
        [first, new Set()],
        [second, new Set()],
      ]);
      const liveIds = (account: string) => live.get(account) ?? new Set<number>();
      let next = 0;

      // The stored text of every row equals the text recomputed from the messages.
      const sideTableCurrent = (label: string) =>
        Effect.gen(function* () {
          const stored = yield* sql`SELECT * FROM message_operator_text ORDER BY row_id`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OperatorRow))),
          );
          const fresh =
            yield* sql`WITH fresh(row_id,to_text,cc_text,file_text,list_id_text,list_post_text) AS (
              SELECT rowid,${sql.literal(operatorTextValues("m"))} FROM messages m)
              SELECT * FROM fresh ORDER BY row_id`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(OperatorRow))),
            );
          assert.deepStrictEqual(stored, fresh, label);
        });
      const results = Effect.gen(function* () {
        const out: unknown[] = [];
        for (const search of QUERIES)
          for (const flat of [false, true]) {
            const rows = yield* store.listThreads({ search, flat, limit: 30 });
            out.push([
              search,
              flat,
              rows.map((t) => [t.id, t.threadCount, t.isUnread]),
              yield* store.countThreads({ search, flat }),
            ]);
          }
        return out;
      });
      const setReady = (ready: boolean) =>
        sql`UPDATE message_operator_text_backfill SET ready=${ready ? 1 : 0}`;
      const localOps: readonly MailOp[] = [
        { kind: "archive" },
        { kind: "trash" },
        { kind: "inbox" },
        { kind: "label", labelId: "Label_1", value: true },
      ];

      const write = (account: string) =>
        Effect.gen(function* () {
          const ids = [...liveIds(account)];
          const x = r();
          if (x < 0.35 || ids.length === 0) {
            const pid = next++;
            yield* store.upsertMessage(account, message(pid));
            liveIds(account).add(pid);
          } else if (x < 0.5) yield* store.upsertMessage(account, message(pick(ids)));
          else if (x < 0.58)
            yield* store.setFlags(account, `p${pick(ids)}`, {
              isUnread: r() < 0.5,
              isStarred: r() < 0.5,
            });
          else if (x < 0.65) yield* store.applyLocalOp(`${account}/p${pick(ids)}`, pick(localOps));
          else if (x < 0.72) {
            const pid = pick(ids);
            yield* store.deleteMessage(account, `p${pid}`);
            liveIds(account).delete(pid);
          } else if (x < 0.78) {
            const from = pick(ids);
            const to = next++;
            yield* store
              .remapProviderIds(account, [{ from: `p${from}`, to: `p${to}` }])
              .pipe(Effect.orDie);
            liveIds(account).delete(from);
            liveIds(account).add(to);
          } else if (x < 0.84) {
            const pid = pick(ids);
            const id = `${account}/p${pid}`;
            // The header backfill only fills NULL headers.
            yield* sql`UPDATE messages SET headers_json=NULL WHERE id=${id}`;
            yield* store.updateCachedHeaders(
              account,
              { id, providerId: `p${pid}` },
              {
                kind: "headers",
                id,
                rfcMessageId: `<m${pid}@x>`,
                headers: [{ name: "List-Id", value: pick(LISTS) }],
              },
            );
          } else if (x < 0.87) yield* store.evictBodies(account, Date.now() + 10 ** 12, true);
          else if (x < 0.89) {
            yield* store.deleteMessagesWithLabel(account, "SPAM");
            const left =
              yield* sql`SELECT provider_id FROM messages WHERE account_id=${account}`.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ProviderRow))),
              );
            live.set(account, new Set(left.map((row) => Number(row.provider_id.slice(1)))));
          } else if (x < 0.895) {
            const keep = ids.filter(() => r() < 0.5).map((pid) => `p${pid}`);
            yield* store.deleteAccountMessages(account, keep);
            live.set(account, new Set(keep.map((p) => Number(p.slice(1)))));
          }
        });

      for (let round = 0; round < ROUNDS; round++) {
        yield* store.transaction(
          Effect.gen(function* () {
            for (let op = 0; op < WRITES_PER_ROUND; op++) yield* write(pick([first, second]));
          }),
        );
        if (round === Math.floor(ROUNDS / 2)) {
          yield* store.removeAccount(second);
          second = (yield* store.upsertAccount("gmail", "you@example.com")).id;
          live.set(second, new Set());
        }
        yield* sideTableCurrent(`round ${round}`);
        while (!(yield* store.backfillWordIndex(5000)).ready) {
          /* drain */
        }
        yield* setReady(true);
        const side = yield* results;
        yield* setReady(false);
        const scan = yield* results;
        yield* setReady(true);
        for (let i = 0; i < side.length; i++)
          assert.deepStrictEqual(side[i], scan[i], `round ${round}`);
      }
      const [count] = yield* sql`SELECT COUNT(*) AS n FROM messages`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CountRow))),
      );
      assert.isAbove(count?.n ?? 0, 30);
    }).pipe(Effect.provide(layer)),
  scaledMs(process.env.OPENMAIL_PERF ? 600_000 : 120_000),
);
