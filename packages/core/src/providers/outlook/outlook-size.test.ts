import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { DatabaseSync } from "node:sqlite";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { MIGRATIONS } from "../../platform/node/db.js";
import { applyNativeMigration } from "../../platform/node/migrations.js";
import { MemoryPlatform } from "../../platform/node/platform-memory.js";
import { matchesSearch } from "../../search/search-match.js";
import { Store } from "../../store/service.js";
import { StoreLive } from "../../store/store.js";
import { account, raw, run } from "../../../test-support/outlook-fixtures.js";
import { estimatedMessageSize, parseGraphMessage } from "./parse.js";

const pdf = { filename: "deck.pdf", mimeType: "application/pdf", size: 2_000_000 };
const small = parseGraphMessage({ ...raw, id: "small", conversationId: "c-small" }, "INBOX", []);
const big = parseGraphMessage({ ...raw, id: "big", conversationId: "c-big" }, "INBOX", [pdf]);

const cases: [string, string[]][] = [
  ["larger:1M", ["big"]],
  ["size:1M", ["big"]],
  ["smaller:1M", ["small"]],
  ["-larger:1M", ["small"]],
  ["-smaller:1M", ["big"]],
  ["-(subject:报价 larger:1M)", ["small"]],
];

it("Outlook messages carry the body bytes plus the attachment sizes as their size", () => {
  const body = raw.body.content;
  assert.strictEqual(small.size, new TextEncoder().encode(body).length);
  assert.strictEqual(big.size, new TextEncoder().encode(body).length + pdf.size);
  assert.strictEqual(estimatedMessageSize("é", [pdf]), 2 + pdf.size);
});

it.effect("size operators narrow Outlook mail in SQLite and in the local predicate alike", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const owner = yield* store.upsertAccount("outlook", "me@outlook.com");
    for (const message of [small, big]) yield* store.upsertMessage(owner.id, message);
    for (const [search, ids] of cases) {
      const threads = yield* store.listThreads({ search });
      assert.deepStrictEqual(
        threads.map((t) => t.threadId.replace("c-", "")).toSorted(),
        ids,
        `store ${search}`,
      );
      assert.deepStrictEqual(
        [small, big].filter((m) => matchesSearch(m, { search })).map((m) => m.providerId),
        ids,
        `predicate ${search}`,
      );
    }
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
);

it.effect("Outlook server search applies larger: to the Graph page", () => {
  const http = fakeHttp({
    "GET /me/mailFolders": { json: { value: [] } },
    "GET /me/mailFolders/inbox": { json: { id: "inbox-id" } },
    "GET /me/messages": {
      json: {
        value: [
          { ...raw, id: "small", parentFolderId: "inbox-id", hasAttachments: false },
          {
            ...raw,
            id: "big",
            parentFolderId: "inbox-id",
            attachments: [{ name: "deck.pdf", contentType: "application/pdf", ...pdf }],
          },
        ],
      },
    },
  });
  return run(http, (a) => a.search(account, { search: "larger:1M" })).pipe(
    Effect.tap((page) =>
      Effect.sync(() =>
        assert.deepStrictEqual(
          page.messages.map((m) => m.providerId),
          ["big"],
        ),
      ),
    ),
  );
});

it("migration 55 fills the size of stored Outlook rows and leaves other providers alone", () => {
  const db = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS.slice(0, 54)) applyNativeMigration(db, migration);
  const addAccount = db.prepare(
    "INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,1)",
  );
  addAccount.run("o", "outlook", "me@outlook.com");
  addAccount.run("i", "imap", "me@example.com");
  const addMessage = db.prepare(
    `INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
     VALUES(?,?,?,?,'','','','[]','[]',0,'',?,?,'["INBOX"]',?,0,0)`,
  );
  addMessage.run("o/html", "o", "html", "t1", "text", "<p>é</p>", JSON.stringify([pdf]));
  addMessage.run("o/plain", "o", "plain", "t2", "héllo", "", "[]");
  addMessage.run("i/x", "i", "x", "t3", "text", "<p>é</p>", "[]");
  applyNativeMigration(db, MIGRATIONS[54] ?? "");
  const size = (id: string) =>
    db.prepare("SELECT message_size AS size FROM messages WHERE id=?").get(id)?.["size"];
  assert.strictEqual(size("o/html"), estimatedMessageSize("<p>é</p>", [pdf]));
  assert.strictEqual(size("o/plain"), estimatedMessageSize("héllo", []));
  assert.strictEqual(size("i/x"), null);
  db.close();
});
