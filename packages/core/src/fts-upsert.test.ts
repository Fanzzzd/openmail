import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Store } from "./services.js";
import { StoreLive } from "./store.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import type { IncomingMessage } from "./domain/domain.js";

const tables = ["messages_fts", "messages_words", "derived_fts", "derived_words"] as const;
const message: IncomingMessage = {
  providerId: "one",
  threadId: "thread",
  subject: "Review",
  from: { name: "Bob", address: "bob@example.com" },
  to: [],
  cc: [],
  date: 1,
  snippet: "",
  bodyText: "请查收季度报告 budget",
  bodyHtml: "",
  labels: ["INBOX", "UNREAD"],
  attachments: [{ filename: "scan.png", mimeType: "image/png", size: 1 }],
  isUnread: true,
  isStarred: false,
};

it.effect(
  "unchanged re-upserts leave both FTS indexes untouched; changed text remains searchable and consistent",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      const id = `${account.id}/one`;
      yield* store.upsertMessage(account.id, message);
      const provenance = (text: string) => ({
        messageId: id,
        text,
        source: { kind: "attachment", index: 0, name: "scan.png", mimeType: "image/png" },
        page: null,
        region: null,
        pipelineVersion: "test",
        visionRevision: 1,
      });
      const text = "扫描的登机牌 boarding";
      yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(${id},${text},${JSON.stringify(provenance(text))})`;
      const snapshot = () =>
        Effect.gen(function* () {
          const result: unknown[] = [];
          for (const table of tables) {
            result.push(yield* sql`SELECT * FROM ${sql.literal(`${table}_data`)} ORDER BY id`);
            result.push(
              yield* sql`SELECT * FROM ${sql.literal(`${table}_idx`)} ORDER BY segid,term`,
            );
            result.push(yield* sql`SELECT * FROM ${sql.literal(`${table}_docsize`)} ORDER BY id`);
          }
          return result;
        });
      const check = () =>
        Effect.gen(function* () {
          for (const table of tables)
            yield* sql`INSERT INTO ${sql.literal(table)}(${sql.literal(table)},rank) VALUES('integrity-check',1)`;
        });
      const before = yield* snapshot();
      yield* store.upsertMessage(account.id, message);
      yield* store.upsertMessage(account.id, { ...message, labels: ["INBOX"], isUnread: false });
      yield* sql`UPDATE derived_chunks SET text=text,provenance_json=${JSON.stringify({ ...provenance(text), visionRevision: 2 })} WHERE message_id=${id}`;
      assert.deepStrictEqual(yield* snapshot(), before);
      yield* check();
      for (const search of ["报告", "budget", "in:attachment 登机", "in:attachment boarding"])
        assert.strictEqual((yield* store.listThreads({ search })).length, 1);
      // All four message fields must independently trigger indexing when their value changes.
      for (const updated of [
        { ...message, subject: "Revised" },
        { ...message, from: { name: "Alice", address: message.from.address } },
        { ...message, from: { name: message.from.name, address: "alice@example.com" } },
        { ...message, bodyText: "更新后的发票 invoice" },
      ]) {
        yield* store.upsertMessage(account.id, updated);
        yield* check();
      }
      assert.strictEqual((yield* store.listThreads({ search: "budget" })).length, 0);
      assert.strictEqual((yield* store.listThreads({ search: "invoice" })).length, 1);
      assert.strictEqual((yield* store.listThreads({ search: "发票" })).length, 1);
      const old = "登机牌 boarding";
      yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(${id},${old},${JSON.stringify(provenance(old))})`;
      const changed = "发票 invoice";
      yield* sql`UPDATE derived_chunks SET text=${changed},provenance_json=${JSON.stringify(provenance(changed))} WHERE message_id=${id}`;
      yield* check();
      assert.strictEqual(
        (yield* store.listThreads({ search: "in:attachment boarding" })).length,
        0,
      );
      assert.strictEqual((yield* store.listThreads({ search: "in:attachment invoice" })).length, 1);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);
