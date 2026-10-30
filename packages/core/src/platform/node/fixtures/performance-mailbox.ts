import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { IncomingMessage } from "../../../domain/message.js";
import { MailboxLive } from "../../../mailbox/mailbox-live.js";
import { Store } from "../../../store/service.js";
import { Providers } from "../../../providers/adapter.js";
import { StoreLive } from "../../../store/store.js";
import { MailCodec } from "../../mail-codec.js";
import { MemoryPlatform } from "../platform-memory.js";
import { searchVisibleText } from "../../../visible-text/visible-text.js";
import { fakeServer, makeFakeProvider } from "../fake-provider.js";

export const fixtureNow = Date.parse("2026-10-03T00:00:00Z");
export const fixtureAccounts = [
  "gmail:perf0@example.com",
  "outlook:perf1@example.com",
  "imap:perf2@example.com",
] as const;
const providers = ["gmail", "outlook", "imap"] as const;
const html = ["mailchimp-newsletter", "outlook-word"].map((name) =>
  readFileSync(
    new URL(`../../../../test-support/fixtures/reader/${name}.html`, import.meta.url),
    "utf8",
  ),
);
// Small realistic bodies in every row; the standalone parser case is exactly 200 KiB UTF-8.
const fixtureHtml = html.map((body) => `${body}<p>weekly alpha beta 预算批准，会议通知。</p>`);
const fragment =
  '<table><tr><td style="color:#222">weekly alpha beta 预算批准，会议通知。</td></tr></table>';
const prefix = `<html><head><style>.hidden{display:none}td{font-family:Arial}</style></head><body><script type="application/ld+json">{"@type":"Event","name":"Review","startDate":"2026-10-04","endDate":"2026-10-04"}</script><div class="hidden">Hidden tracking text</div>${fixtureHtml[1]}`;
const paddingBytes = 200 * 1024 - Buffer.byteLength(`${prefix}</body></html>`);
export const largeHtml = `${prefix}${fragment.repeat(Math.floor(paddingBytes / Buffer.byteLength(fragment)))}${" ".repeat(paddingBytes % Buffer.byteLength(fragment))}</body></html>`;

/** One message in 50 is a draft, in place of the inbox: 2,000 in the 100k fixture. */
export const isFixtureDraft = (i: number) => i % 50 === 25;
/** The first few drafts have a discard held for its Undo, so lists and counts leave them out. */
export const HELD_FIXTURE_DRAFTS = 5;

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
    // One message in a thousand shares a Google Sheet, so has:drive must find sparse rows.
    // Ten carry the rare CJK pair 鲸鱼, which a one- or two-character search must find.
    bodyText: `weekly alpha beta 预算批准，会议通知。\n${"Project update and delivery schedule. ".repeat(8)}${i % 1000 === 500 ? `\nSheet: https://docs.google.com/spreadsheets/d/${i}/edit` : ""}${i % 10_000 === 4321 ? "\n鲸鱼出没" : ""}\nOn Monday someone wrote:\n> Earlier message`,
    bodyHtml: fixtureHtml[i % 2] ?? "",
    rfcMessageId: `<message${i}@example.com>`,
    // One message in a thousand is important, so is:important with a common word walks far.
    labels: [
      isFixtureDraft(i) ? "DRAFT" : "INBOX",
      folder,
      ...(i % 4 === 0 && !isFixtureDraft(i) ? ["UNREAD"] : []),
      ...(i % 1000 === 3 ? ["IMPORTANT"] : []),
    ],
    attachments:
      i % 10 === 0 ? [{ filename: "report.pdf", mimeType: "application/pdf", size: 2048 }] : [],
    isUnread: i % 4 === 0 && !isFixtureDraft(i),
    isStarred: i % 100 === 0,
  };
}

/** Different lengths, frequencies and phrase spacing exercise attachment BM25. */
export function fixtureOcrText(i: number): string {
  switch (Math.floor(i / 10) % 4) {
    case 0:
      return "Invoice total amount due: 250.00. weekly delivery schedule";
    case 1:
      return `Invoice weekly ledger. ${"weekly delivery schedule. ".repeat(3)}total pending review amount due: 250.00.`;
    case 2:
      return `Invoice total ${"item details and delivery notes. ".repeat(12)}amount due: 250.00. weekly reconciliation`;
    default:
      return `Invoice weekly summary: total amount due. ${"delivery details. ".repeat(4)}`;
  }
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

/** Wall-clock milliseconds of each seeding phase, for the perf report. */
export interface SeedPhases {
  messagesMs: number;
  draftsMs: number;
  ocrChunksMs: number;
  wordIndexMs: number;
  bigramsMs: number;
  visibleTextMs: number;
  analyzeMs: number;
}

/**
 * Budgets run without planner statistics by default, as on a fresh install
 * before the first `PRAGMA optimize`. OPENMAIL_PERF_ANALYZE=1 measures the
 * analyzed variant. Returns how long each phase took.
 */
export const seedMailbox = (
  count: number,
  { analyze = process.env.OPENMAIL_PERF_ANALYZE === "1" }: { analyze?: boolean } = {},
) =>
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
    let phaseStart = performance.now();
    const lap = () => {
      const now = performance.now();
      const ms = now - phaseStart;
      phaseStart = now;
      return ms;
    };
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
    const messagesMs = lap();
    // Each draft message is the provider copy of a local draft, as after a save and a pull.
    let drafts = 0;
    for (let start = 25; start < count; start += 500 * 50) {
      yield* store.transaction(
        Effect.gen(function* () {
          for (let i = start; i < Math.min(start + 500 * 50, count); i += 50) {
            const message = fixtureMessage(i, count === 100_000);
            const account = fixtureAccounts[Number(message.threadId.slice(6)) % 3];
            if (!account || !isFixtureDraft(i)) continue;
            const id = `draft:perf${i}`;
            yield* store.putDraft({
              id,
              accountId: account,
              message: {
                to: message.to,
                cc: [],
                bcc: [],
                subject: message.subject,
                text: message.bodyText,
                attachments: [],
              },
            });
            yield* store.setDraftRemote(
              id,
              { draftId: `d${i}`, messageId: message.providerId },
              null,
            );
            if (drafts++ < HELD_FIXTURE_DRAFTS)
              yield* store.holdDraftDiscard(id, fixtureNow + 60_000);
          }
        }),
      );
    }
    const draftsMs = lap();
    // One extracted OCR chunk for each attachment: 10k chunks in the 100k fixture.
    for (let start = 0; start < count; start += 500) {
      yield* store.transaction(
        Effect.gen(function* () {
          for (let i = start; i < Math.min(start + 500, count); i += 10) {
            const message = fixtureMessage(i, count === 100_000);
            const account = fixtureAccounts[Number(message.threadId.slice(6)) % 3];
            const messageId = `${account}/${message.providerId}`;
            const text = fixtureOcrText(i);
            yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(${messageId},${text},${JSON.stringify(
              {
                messageId,
                text,
                source: {
                  kind: "attachment",
                  index: 0,
                  name: "report.pdf",
                  mimeType: "application/pdf",
                },
                page: 1,
                region: null,
                pipelineVersion: "perf-ocr",
                visionRevision: 1,
              },
            )})`;
          }
        }),
      );
    }
    const ocrChunksMs = lap();
    while (!(yield* store.backfillWordIndex(500)).ready) {
      /* finish the actual background index */
    }
    const wordIndexMs = lap();
    while (!(yield* store.indexBigrams(1000)).ready) {
      /* and the bigram queue the same background loop drains */
    }
    const bigramsMs = lap();
    // Search's visible text, which the app fills on a worker. The fixture repeats about a hundred
    // bodies, so each distinct body is computed once and stored for every message that has it.
    const groups = yield* sql<{ body_text: string; body_html: string; rows: string }>`
      SELECT m.body_text,m.body_html,json_group_array(p.row_id) AS rows
      FROM message_visible_text_pending p JOIN messages m ON m.rowid=p.row_id
      GROUP BY m.body_text,m.body_html`;
    for (const group of groups)
      yield* sql`INSERT OR REPLACE INTO message_visible_text(row_id,text)
        SELECT value,${searchVisibleText(group.body_text, group.body_html)} FROM json_each(${group.rows})`;
    yield* sql`DELETE FROM message_visible_text_pending`;
    const visibleTextMs = lap();
    if (analyze) yield* sql`ANALYZE`;
    return {
      messagesMs,
      draftsMs,
      ocrChunksMs,
      wordIndexMs,
      bigramsMs,
      visibleTextMs,
      analyzeMs: lap(),
    } satisfies SeedPhases;
  });

const PlanRows = Schema.Array(Schema.Struct({ detail: Schema.String }));
export type QueryPlan = { sql: string; plan: string[] };

/** Captures executed SQL, including cached prepares, and computes plans only during the untimed pass. */
export function traceQueries(
  onQuery?: (query: string, phase: "prepare" | "execute") => () => void,
) {
  // oxlint-disable-next-line typescript/unbound-method -- the original is called with .call(this) after the prototype is patched.
  const prepare = DatabaseSync.prototype.prepare;
  let capture: Map<string, QueryPlan> | undefined;
  DatabaseSync.prototype.prepare = function (query) {
    const endPrepare = onQuery?.(query, "prepare");
    const statement = prepare.call(this, query);
    endPrepare?.();
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
      const endQuery = onQuery?.(query, "execute");
      try {
        return first === undefined
          ? all()
          : typeof first === "object" && first !== null && !ArrayBuffer.isView(first)
            ? all(first, ...rest)
            : all(first, ...rest);
      } finally {
        endQuery?.();
      }
    };
    statement.get = (
      first?: SQLInputValue | Record<string, SQLInputValue>,
      ...rest: SQLInputValue[]
    ) => {
      record(first, rest);
      const endQuery = onQuery?.(query, "execute");
      try {
        return first === undefined
          ? get()
          : typeof first === "object" && first !== null && !ArrayBuffer.isView(first)
            ? get(first, ...rest)
            : get(first, ...rest);
      } finally {
        endQuery?.();
      }
    };
    statement.run = (
      first?: SQLInputValue | Record<string, SQLInputValue>,
      ...rest: SQLInputValue[]
    ) => {
      record(first, rest);
      const endQuery = onQuery?.(query, "execute");
      try {
        return first === undefined
          ? run()
          : typeof first === "object" && first !== null && !ArrayBuffer.isView(first)
            ? run(first, ...rest)
            : run(first, ...rest);
      } finally {
        endQuery?.();
      }
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
