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
import { incoming } from "./platform/node/testing.js";
import { SEARCH_FLAG_ATTACHMENT_TYPES_45 } from "./db.js";
import { ATTACHMENT_TYPES } from "./search.js";

const accountId = "gmail:me@example.com";
const rows: Record<string, [text: string, html: string, attachments: string]> = {
  file: ["See https://drive.google.com/file/d/abc/view", "", "[]"],
  sheet: ["", '<a href="HTTPS://DOCS.GOOGLE.COM/spreadsheets/d/xyz">Budget</a>', "[]"],
  doc: ["Draft: https://docs.google.com/document/d/123/edit", "", "[]"],
  plain: ["No links here, only google.com and drive.google", "", "[]"],
  xlsx: [
    "",
    "",
    JSON.stringify([{ filename: "Q3.XLSX", mimeType: "application/octet-stream", size: 1 }]),
  ],
  logo: ["", '<img src="cid:logo@x">', "[]"],
  scan: [
    "",
    "",
    JSON.stringify([{ filename: "scan", mimeType: "image/heic; name=scan", size: 1 }]),
  ],
};
const ids = (rows: readonly { readonly id: string }[]) =>
  rows.map((row) => row.id.slice(accountId.length + 1)).toSorted();

it("search flags freeze the attachment rules that migration 45 embeds", () => {
  expect(ATTACHMENT_TYPES).toEqual(SEARCH_FLAG_ATTACHMENT_TYPES_45);
});

it("migration 45 flags has: operators at write time and backfills older rows in batches", async () => {
  expect(MIGRATIONS.length).toBeGreaterThanOrEqual(45);
  const directory = await mkdtemp(join(tmpdir(), "openmail-drive-links-"));
  const file = join(directory, "mail.sqlite");
  try {
    const legacy = new DatabaseSync(file);
    for (const [index, migration] of MIGRATIONS.slice(0, 44).entries())
      applyNativeMigration(legacy, migration, index + 1);
    legacy
      .prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,?)")
      .run(accountId, "gmail", "me@example.com", 1);
    const insert = legacy.prepare(
      "INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred) VALUES(?,?,?,?,'','','me@example.com','[]','[]',1,'',?,?,'[\"INBOX\"]',?,0,0)",
    );
    for (const [id, [text, html, attachments]] of Object.entries(rows))
      insert.run(`${accountId}/${id}`, accountId, id, id, text, html, attachments);
    legacy.close();
    const layer = StoreLive.pipe(
      Layer.provideMerge(databaseLayer(file).pipe(Layer.provide(NodeSystem))),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const search = (query: string) =>
          store.listThreads({ search: query, flat: true }).pipe(Effect.map(ids));
        const expectResults = Effect.gen(function* () {
          expect(yield* search("has:drive")).toEqual(["doc", "file", "sheet"]);
          expect(yield* search("has:spreadsheet")).toEqual(["sheet", "xlsx"]);
          expect(yield* search("has:document")).toEqual(["doc"]);
          expect(yield* search("has:presentation")).toEqual([]);
          expect(yield* search("has:image")).toEqual(["logo", "scan"]);
          expect(yield* search("-has:drive -has:image -has:spreadsheet")).toEqual(["plain"]);
        });
        // Not backfilled: every old row falls back to the body scan.
        yield* expectResults;
        expect(yield* store.backfillSearchFlags(4)).toEqual({ processed: 4, ready: false });
        // Half backfilled: flagged rows and unflagged rows both answer.
        yield* expectResults;
        expect(yield* store.backfillSearchFlags(4)).toEqual({ processed: 3, ready: true });
        expect(yield* store.backfillSearchFlags(4)).toEqual({ processed: 0, ready: true });
        yield* expectResults;
        // New rows and body rewrites keep the flag current without a backfill.
        yield* store.upsertMessage(
          accountId,
          incoming("deck", { bodyText: "https://docs.google.com/presentation/d/9" }),
        );
        yield* store.upsertMessage(
          accountId,
          incoming("file", { threadId: "file", bodyText: "Link removed", bodyHtml: "" }),
        );
        yield* store.upsertMessage(
          accountId,
          incoming("plain", {
            threadId: "plain",
            bodyText: "No links",
            attachments: [{ filename: "talk.key", mimeType: "application/zip", size: 1 }],
          }),
        );
        expect(yield* search("has:drive")).toEqual(["deck", "doc", "sheet"]);
        expect(yield* search("has:presentation")).toEqual(["deck", "plain"]);
      }).pipe(Effect.provide(layer)),
    );
    const db = new DatabaseSync(file);
    try {
      expect(
        db
          .prepare(
            "SELECT message_id AS id, search_flags FROM message_search_meta ORDER BY message_id",
          )
          .all()
          .map((row) => [String(row.id).slice(accountId.length + 1), row.search_flags]),
      ).toEqual([
        ["deck", 1 | 8],
        ["doc", 1 | 2],
        ["file", 0],
        ["logo", 512],
        ["plain", 256],
        ["scan", 32],
        ["sheet", 1 | 4],
        ["xlsx", 128],
      ]);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
