import { applyNativeMigration } from "./platform/node/migrations.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { databaseLayer, MIGRATIONS } from "./platform/node/db.js";
import { StoreLive } from "./store.js";
import { Store } from "./services.js";
import { NodeSystem } from "./platform/node/platform-node.js";
import type { IncomingMessage } from "./domain/domain.js";

const accountId = "gmail:me@example.com";
const incoming = (providerId: string, bodyText: string): IncomingMessage => ({
  providerId,
  threadId: providerId,
  subject: "",
  from: { name: "", address: "me@example.com" },
  to: [],
  cc: [],
  date: 1,
  snippet: "",
  bodyText,
  bodyHtml: "",
  labels: ["INBOX"],
  attachments: [],
  isUnread: true,
  isStarred: false,
});
const provenance = (id: string, text: string) => ({
  messageId: `${accountId}/${id}`,
  text,
  source: { kind: "attachment", index: 0, name: "scan.png", mimeType: "image/png" },
  page: null,
  region: null,
  pipelineVersion: "test",
  visionRevision: 1,
});

it("migration leaves trigram indexes intact and empty word indexes resume across short transactions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmail-word-index-"));
  const file = join(directory, "mail.sqlite");
  try {
    const legacy = new DatabaseSync(file);
    for (const migration of MIGRATIONS.slice(0, 23)) applyNativeMigration(legacy, migration);
    legacy.exec("PRAGMA user_version=23");
    legacy
      .prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,?)")
      .run(accountId, "gmail", "me@example.com", 1);
    const insert = legacy.prepare(
      "INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (let index = 1; index <= 4; index++) {
      insert.run(
        `${accountId}/${index}`,
        accountId,
        String(index),
        String(index),
        "",
        "",
        "me@example.com",
        "[]",
        "[]",
        index,
        "",
        "请查收附件中的季度报告 budget reporting",
        "",
        '["INBOX"]',
        "[]",
        1,
        0,
      );
      const text = "请查看附件扫描件中的登机牌 boarding";
      legacy
        .prepare("INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(?,?,?)")
        .run(`${accountId}/${index}`, text, JSON.stringify(provenance(String(index), text)));
    }
    const before = legacy
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name IN ('messages_fts','derived_fts') ORDER BY name",
      )
      .all();
    const last = MIGRATIONS[23] ?? "";
    expect(last).not.toMatch(
      /DROP TABLE (?:messages_fts|derived_fts)|VALUES\s*\(\s*'rebuild'\s*\)/,
    );
    legacy.close();
    const layer = () =>
      StoreLive.pipe(Layer.provideMerge(databaseLayer(file).pipe(Layer.provide(NodeSystem))));
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        expect(yield* store.wordIndexReady).toEqual({ messages: false, derived: false });
        const observer = new DatabaseSync(file);
        try {
          expect(
            observer
              .prepare(
                "SELECT sql FROM sqlite_master WHERE name IN ('messages_fts','derived_fts') ORDER BY name",
              )
              .all(),
          ).toEqual(before);
          expect(
            observer
              .prepare("SELECT rowid FROM messages_words WHERE messages_words MATCH 'budget'")
              .all(),
          ).toEqual([]);
          expect(
            observer
              .prepare("SELECT rowid FROM derived_words WHERE derived_words MATCH 'boarding'")
              .all(),
          ).toEqual([]);
        } finally {
          observer.close();
        }
        // While words are incomplete, Latin terms use the existing trigram fallback.
        expect((yield* store.listThreads({ search: "port" })).length).toBe(4);
        for (const search of [
          "报告",
          "季度报告",
          "报告 budget",
          "季度报告 budget",
          "登机",
          "登机牌 boarding",
        ])
          expect((yield* store.listThreads({ search })).length).toBe(4);
        expect(yield* store.backfillWordIndex(1)).toEqual({ processed: 1, ready: false });
        // A separate connection can write between chunks; it indexes an unvisited old row via the trigger.
        const writer = new DatabaseSync(file);
        writer.exec("PRAGMA busy_timeout=0");
        try {
          writer
            .prepare("UPDATE messages SET body_text=? WHERE provider_id='4'")
            .run("请查收附件中的季度报告 budget revision");
        } finally {
          writer.close();
        }
        yield* store.upsertMessage(accountId, incoming("new", "Concurrent report budget"));
        yield* store.upsertMessage(
          accountId,
          incoming("4", "请查收附件中的季度报告 budget revision"),
        );
      }).pipe(Effect.provide(layer())),
    );
    // Disposing the first connection simulates interruption; marker and trigger rows survive.
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        let processed = 0;
        let ready = false;
        while (!ready) {
          const batch = yield* store.backfillWordIndex(1);
          processed += batch.processed;
          expect(batch.processed).toBeLessThanOrEqual(1);
          ready = batch.ready;
          if (!ready) yield* Effect.yieldNow;
        }
        expect(processed).toBe(7);
        expect(yield* store.wordIndexReady).toEqual({ messages: true, derived: true });
        expect((yield* store.listThreads({ search: "port" })).length).toBe(0);
        expect((yield* store.listThreads({ search: "report" })).map((row) => row.id)).toEqual([
          `${accountId}/new`,
        ]);
        expect((yield* store.listThreads({ search: "报告 budget" })).length).toBe(4);
        expect((yield* store.listThreads({ search: "in:attachment 登机" })).length).toBe(4);
        const db = new DatabaseSync(file);
        try {
          db.exec("INSERT INTO messages_words(messages_words,rank) VALUES('integrity-check',1)");
          db.exec("INSERT INTO derived_words(derived_words,rank) VALUES('integrity-check',1)");
          const entries = db
            .prepare("SELECT rowid FROM messages_words WHERE messages_words MATCH 'report'")
            .all();
          expect(entries).toHaveLength(1);
        } finally {
          db.close();
        }
        yield* store.deleteMessage(accountId, "new");
        expect((yield* store.listThreads({ search: "report" })).length).toBe(0);
      }).pipe(Effect.provide(layer())),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
