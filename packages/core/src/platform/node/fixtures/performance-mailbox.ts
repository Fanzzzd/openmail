import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { IncomingMessage } from "../../../domain.js";
import { MailboxLive } from "../../../mailbox-live.js";
import { Store, Providers } from "../../../services.js";
import { StoreLive } from "../../../store.js";
import { MailCodec } from "../../mail-codec.js";
import { MemoryPlatform } from "../platform-memory.js";
import { fakeServer, makeFakeProvider } from "../fake-provider.js";

export const fixtureNow = Date.parse("2026-10-03T00:00:00Z");
export const fixtureAccounts = [
  "gmail:perf0@example.com",
  "outlook:perf1@example.com",
  "imap:perf2@example.com",
] as const;
const providers = ["gmail", "outlook", "imap"] as const;
const html = ["mailchimp-newsletter", "outlook-word"].map((name) =>
  readFileSync(new URL(`../../../../src/fixtures/reader/${name}.html`, import.meta.url), "utf8"),
);
// Small realistic bodies in every row; the standalone parser case is exactly 200 KiB UTF-8.
const fixtureHtml = html.map((body) => `${body}<p>weekly alpha beta 预算批准，会议通知。</p>`);
const fragment =
  '<table><tr><td style="color:#222">weekly alpha beta 预算批准，会议通知。</td></tr></table>';
const prefix = `<html><head><style>.hidden{display:none}td{font-family:Arial}</style></head><body><script type="application/ld+json">{"@type":"Event","name":"Review","startDate":"2026-10-04","endDate":"2026-10-04"}</script><div class="hidden">Hidden tracking text</div>${fixtureHtml[1]}`;
const paddingBytes = 200 * 1024 - Buffer.byteLength(`${prefix}</body></html>`);
export const largeHtml = `${prefix}${fragment.repeat(Math.floor(paddingBytes / Buffer.byteLength(fragment)))}${" ".repeat(paddingBytes % Buffer.byteLength(fragment))}</body></html>`;

export function fixtureMessage(i: number, large = false): IncomingMessage {
  // Exactly 20k threads: 4 messages each, plus 200 extra replies in each of 100 long chains.
  const thread = large && i >= 80_000 ? Math.floor((i - 80_000) / 200) : Math.floor(i / 4);
  const account = thread % 3;
  const folder = `Folder_${thread % (account === 2 ? 66 : 67)}`;
  const providerId = account === 2 ? `7:${i}:${folder}` : `m${i}`;
  return {
    providerId,
    threadId: `thread${thread}`,
    subject: `Weekly report ${thread} 预算批准`,
    from: { name: `Person ${thread % 1000}`, address: `person${thread % 1000}@example.com` },
    to: [{ name: "Recipient", address: "recipient@example.com" }],
    cc: [],
    date: fixtureNow - (100_000 - i) * 120_000,
    snippet: "weekly alpha beta 预算批准",
    bodyText: `weekly alpha beta 预算批准，会议通知。\n${"Project update and delivery schedule. ".repeat(8)}\nOn Monday someone wrote:\n> Earlier message`,
    bodyHtml: fixtureHtml[i % 2] ?? "",
    rfcMessageId: `<message${i}@example.com>`,
    labels: ["INBOX", folder, ...(i % 4 === 0 ? ["UNREAD"] : [])],
    attachments:
      i % 10 === 0 ? [{ filename: "report.pdf", mimeType: "application/pdf", size: 2048 }] : [],
    isUnread: i % 4 === 0,
    isStarred: i % 100 === 0,
  };
}

export const PerformanceMailbox = () =>
  Layer.unwrap(
    Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-perf61-"))),
      (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    ).pipe(
      Effect.map((dir) => {
        const adapters = Layer.effect(
          Providers,
          Effect.gen(function* () {
            const codec = yield* MailCodec;
            return Providers.of({
              get: () =>
                makeFakeProvider(fakeServer("perf@example.com"), { codec, strictFolders: true }),
            });
          }),
        );
        return MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(StoreLive, adapters).pipe(
              Layer.provideMerge(MemoryPlatform({ database: join(dir, "mail.db") })),
            ),
          ),
        );
      }),
    ),
  );

export const seedMailbox = (count: number) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA cache_size=-8192`;
    for (const [a, provider] of providers.entries()) {
      const account = yield* store.upsertAccount(provider, `perf${a}@example.com`);
      yield* store.replaceLabels(
        account.id,
        Array.from({ length: a === 2 ? 66 : 67 }, (_, i) => ({
          id: `Folder_${i}`,
          name: `Folder ${i}`,
          color: null,
        })),
      );
    }
    for (let start = 0; start < count; start += 500) {
      yield* store.transaction(
        Effect.gen(function* () {
          for (let i = start; i < Math.min(start + 500, count); i++) {
            const message = fixtureMessage(i, count === 100_000);
            const thread = Number(message.threadId.slice(6));
            const account = fixtureAccounts[thread % 3];
            if (account) yield* store.upsertMessage(account, message);
          }
        }),
      );
      if (count === 100_000 && start % 10_000 === 0)
        process.stdout.write(`Seeded ${start + 500}/100000\n`);
    }
    while (!(yield* store.backfillWordIndex(500)).ready) {
      /* finish the actual background index */
    }
    yield* sql`ANALYZE`;
  });

const PlanRows = Schema.Array(Schema.Struct({ detail: Schema.String }));
export type QueryPlan = { sql: string; plan: string[] };

/** Captures executed SQL, including cached prepares, and computes plans only during the untimed pass. */
export function traceQueries() {
  // oxlint-disable-next-line typescript/unbound-method
  const prepare = DatabaseSync.prototype.prepare;
  let capture: Map<string, QueryPlan> | undefined;
  DatabaseSync.prototype.prepare = function (query) {
    const statement = prepare.call(this, query);
    const all = statement.all.bind(statement),
      get = statement.get.bind(statement),
      run = statement.run.bind(statement);
    const record = (
      first: SQLInputValue | Record<string, SQLInputValue> | undefined,
      rest: SQLInputValue[],
    ) => {
      if (capture && !capture.has(query)) {
        const explain = prepare.call(this, `EXPLAIN QUERY PLAN ${query}`);
        const raw =
          first === undefined
            ? explain.all()
            : typeof first === "object" && first !== null && !ArrayBuffer.isView(first)
              ? explain.all(first, ...rest)
              : explain.all(first, ...rest);
        const rows = Schema.decodeUnknownSync(PlanRows)(raw);
        capture.set(query, { sql: query, plan: rows.map((row) => row.detail) });
      }
    };
    statement.all = (
      first?: SQLInputValue | Record<string, SQLInputValue>,
      ...rest: SQLInputValue[]
    ) => {
      record(first, rest);
      return first === undefined
        ? all()
        : typeof first === "object" && first !== null && !ArrayBuffer.isView(first)
          ? all(first, ...rest)
          : all(first, ...rest);
    };
    statement.get = (
      first?: SQLInputValue | Record<string, SQLInputValue>,
      ...rest: SQLInputValue[]
    ) => {
      record(first, rest);
      return first === undefined
        ? get()
        : typeof first === "object" && first !== null && !ArrayBuffer.isView(first)
          ? get(first, ...rest)
          : get(first, ...rest);
    };
    statement.run = (
      first?: SQLInputValue | Record<string, SQLInputValue>,
      ...rest: SQLInputValue[]
    ) => {
      record(first, rest);
      return first === undefined
        ? run()
        : typeof first === "object" && first !== null && !ArrayBuffer.isView(first)
          ? run(first, ...rest)
          : run(first, ...rest);
    };
    return statement;
  };
  return {
    start: () => {
      capture = new Map();
    },
    stop: () => {
      const result = [...(capture?.values() ?? [])];
      capture = undefined;
      return result;
    },
    restore: () => {
      DatabaseSync.prototype.prepare = prepare;
      capture = undefined;
    },
  };
}
