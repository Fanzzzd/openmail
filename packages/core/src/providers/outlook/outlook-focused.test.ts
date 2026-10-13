import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PREFS } from "../../domain/domain.js";
import { MIGRATIONS } from "../../db/db.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { makeOutlook } from "./outlook.js";
import { parseGraphMessage } from "./parse.js";
import { GraphMessage } from "./graph.js";
import { applyOpToLabels } from "../../domain/mail-ops.js";
import {
  account as makeAccount,
  incoming,
  fakeServer,
  TestMailbox,
} from "../../platform/node/testing.js";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { MemoryPlatform } from "../../platform/node/platform-memory.js";
import { applyNativeMigration } from "../../platform/node/migrations.js";
import { Store } from "../../services.js";
import { StoreLive } from "../../store/store.js";
import { makeResetGuard } from "../../sync/sync-reset.js";
import { matchesSearch } from "../../search/search.js";
import { notificationEligible } from "../../app/system.js";

const account = makeAccount("outlook");
const raw = {
  id: "m1",
  conversationId: "t1",
  subject: "Project",
  parentFolderId: "inbox",
  from: { emailAddress: { name: "Alice", address: "alice@example.com" } },
  receivedDateTime: "2026-10-06T10:00:00Z",
  body: { contentType: "text", content: "Cached text" },
  isRead: false,
  categories: ["Work"],
  inferenceClassification: "focused",
};
const platform = () =>
  MemoryPlatform({
    secrets: { [account.id]: "refresh" },
    config: { microsoft: { clientId: "client" } },
  });

it.effect(
  "Outlook delta selects and caches Focused/Other, hydrating a classification-only delta",
  () => {
    const http = fakeHttp({
      "GET /me/mailFolders/inbox/messages/delta": {
        json: {
          value: [raw, { id: "m2", inferenceClassification: "other" }],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=new",
        },
      },
      "GET /me/messages/m2": {
        json: { ...raw, id: "m2", conversationId: "t2", inferenceClassification: "other" },
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* makeOutlook;
      const changes = yield* Stream.runCollect(adapter.pull(account, Option.none(), "inbox"));
      const messages = changes
        .filter((change) => change._tag === "Upsert")
        .map((change) => change.message);
      assert.strictEqual(messages.length, 2);
      assert.deepStrictEqual(messages.find((m) => m.providerId === "m1")?.labels, [
        "INBOX",
        "category:Work",
        "CATEGORY_PERSONAL",
        "UNREAD",
      ]);
      assert.deepStrictEqual(messages.find((m) => m.providerId === "m2")?.labels, [
        "INBOX",
        "category:Work",
        "CATEGORY_OTHER",
        "UNREAD",
      ]);
      for (const call of http.calls)
        assert.isTrue(
          call.url.searchParams.get("$select")?.split(",").includes("inferenceClassification") ??
            false,
        );
      const store = yield* Store;
      yield* store.upsertAccount("outlook", account.email);
      for (const message of messages) yield* store.upsertMessage(account.id, message);
      assert.strictEqual((yield* store.getMessage(`${account.id}/m2`)).bodyText, "Cached text");
      assert.deepStrictEqual(
        (yield* store.listThreads({ mailbox: "inbox", label: "CATEGORY_PERSONAL" })).map(
          (m) => m.id,
        ),
        [`${account.id}/m1`],
      );
      for (const search of ["category:primary", "category:focused"])
        assert.deepStrictEqual(
          (yield* store.listThreads({ search })).map((m) => m.id),
          [`${account.id}/m1`],
        );
      assert.deepStrictEqual(
        (yield* store.listThreads({ search: "category:other" })).map((m) => m.id),
        [`${account.id}/m2`],
      );
      assert.deepStrictEqual((yield* store.organization)[0]?.selectedCategories, [
        "CATEGORY_PERSONAL",
        "CATEGORY_OTHER",
      ]);
    }).pipe(
      Effect.provide(StoreLive.pipe(Layer.provideMerge(Layer.mergeAll(platform(), http.layer)))),
    );
  },
);

it.effect(
  "Focused badges count unclassified Outlook Inbox mail and preserve Gmail categories",
  () => {
    const outlook = fakeServer(account.email, [
      incoming("unknown", { labels: ["INBOX", "UNREAD"] }),
      incoming("focused", { labels: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"] }),
      incoming("other", { threadId: "t-focused", labels: ["INBOX", "UNREAD", "CATEGORY_OTHER"] }),
      incoming("reply", { threadId: "t-unknown", labels: ["INBOX", "UNREAD"] }),
      incoming("read", { labels: ["INBOX"], isUnread: false }),
      incoming("archived", { labels: ["UNREAD", "CATEGORY_PERSONAL"] }),
    ]);
    const gmail = fakeServer("gmail@example.com", [
      incoming("unknown", { labels: ["INBOX", "UNREAD"] }),
      incoming("primary", { labels: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"] }),
    ]);
    return Effect.gen(function* () {
      const mail = yield* Mailbox;
      const store = yield* Store;
      yield* mail.connect({ provider: "outlook" });
      yield* mail.connect({ provider: "gmail" });
      yield* mail.sync();
      const outlookIds = [account.id];
      const gmailIds = ["gmail:gmail@example.com"];
      for (const within of [undefined, "INBOX"]) {
        assert.strictEqual((yield* store.unreadByLabel(outlookIds, within)).CATEGORY_PERSONAL, 3);
        assert.strictEqual(
          (yield* store.unreadByLabel(outlookIds, within, true)).CATEGORY_PERSONAL,
          2,
        );
        assert.strictEqual((yield* store.unreadByLabel(gmailIds, within)).CATEGORY_PERSONAL, 1);
        assert.strictEqual((yield* store.unreadByLabel(undefined, within)).CATEGORY_PERSONAL, 4);
        assert.strictEqual((yield* store.unreadByLabel([], within)).CATEGORY_PERSONAL ?? 0, 0);
      }
      assert.strictEqual(
        (yield* store.listThreads({
          accountIds: outlookIds,
          mailbox: "inbox",
          label: "CATEGORY_PERSONAL",
          unreadOnly: true,
          flat: true,
        })).length,
        3,
      );
      assert.isFalse(
        (yield* store.getMessage(`${account.id}/unknown`)).labels.includes("CATEGORY_PERSONAL"),
      );
    }).pipe(Effect.provide(TestMailbox({ outlook, gmail })));
  },
);

it("unknown classification is absent; Outlook moves preserve inference and color categories", () => {
  const unknown = parseGraphMessage(
    Schema.decodeUnknownSync(GraphMessage)({ ...raw, inferenceClassification: null }),
    "INBOX",
    [],
  );
  assert.isFalse(unknown.labels.includes("CATEGORY_PERSONAL"));
  assert.deepStrictEqual(applyOpToLabels(["CATEGORY_OTHER", "UNREAD"], { kind: "inbox" }, "imap"), [
    "UNREAD",
    "INBOX",
  ]);
  const labels = ["INBOX", "UNREAD", "CATEGORY_OTHER", "category:Work"];
  assert.deepStrictEqual(applyOpToLabels(labels, { kind: "archive" }, "outlook"), [
    "UNREAD",
    "CATEGORY_OTHER",
    "category:Work",
    "ARCHIVE",
  ]);
});

it("Primary notifications mean Focused for Outlook; unknown is Focused and Other stays silent and Inbox includes them", () => {
  for (const classification of ["CATEGORY_PERSONAL", "CATEGORY_OTHER", "unknown"]) {
    const message = { isUnread: true, labels: ["INBOX", classification] };
    assert.strictEqual(
      notificationEligible(account, message, DEFAULT_PREFS),
      classification !== "CATEGORY_OTHER",
    );
    assert.isTrue(
      notificationEligible(account, message, {
        ...DEFAULT_PREFS,
        notifications: { [account.id]: "inbox" },
      }),
    );
    assert.isTrue(notificationEligible({ ...account, provider: "imap" }, message, DEFAULT_PREFS));
    assert.isFalse(notificationEligible(account, { ...message, isUnread: false }, DEFAULT_PREFS));
    assert.isFalse(
      notificationEligible(account, { ...message, labels: [classification] }, DEFAULT_PREFS),
    );
  }
});

for (const original of ["focused", "other"] as const) {
  it.effect(
    `Outlook classification from ${original} queues, survives sync, and restores through undo`,
    () => {
      const originalLabel = original === "focused" ? "CATEGORY_PERSONAL" : "CATEGORY_OTHER";
      const other = original === "focused" ? "other" : "focused";
      const server = fakeServer(account.email, [
        incoming("one", { labels: ["INBOX", originalLabel, "category:Work"] }),
        incoming("sibling", {
          threadId: "t-one",
          labels: ["INBOX", originalLabel, "category:Work"],
        }),
      ]);
      return Effect.gen(function* () {
        const m = yield* Mailbox;
        const store = yield* Store;
        yield* m.connect({ provider: "outlook" });
        yield* m.sync();
        const id = `${account.id}/one`;
        const result = yield* m.modifyWithUndo(
          [id],
          { kind: "classification", value: other },
          true,
        );
        assert.deepStrictEqual((yield* store.undoJournal(result.undoId))?.changes, [
          { id, op: { kind: "classification", value: original } },
        ]);
        yield* m.sync();
        assert.isTrue(
          server.messages
            .get("one")
            ?.labels.includes(other === "focused" ? "CATEGORY_PERSONAL" : "CATEGORY_OTHER"),
        );
        assert.isTrue(server.messages.get("sibling")?.labels.includes(originalLabel));
        yield* m.undoBatch(result.undoId);
        yield* m.sync();
        assert.deepStrictEqual(
          (yield* store.getMessage(id)).labels.toSorted(),
          ["INBOX", originalLabel, "category:Work"].toSorted(),
        );
        assert.isTrue(
          server.pushed.some((p) => p.op.kind === "classification" && p.op.value === original),
        );
      }).pipe(Effect.provide(TestMailbox({ outlook: server })));
    },
  );
}

it.effect(
  "Graph classification PATCH and explicit sender override use the documented bodies",
  () => {
    const http = fakeHttp({
      "PATCH /me/messages/m%2F1": { status: 200 },
      "POST /me/inferenceClassification/overrides": { status: 201, json: { id: "override" } },
    });
    return makeOutlook.pipe(
      Effect.flatMap((adapter) =>
        Effect.gen(function* () {
          yield* adapter.push(account, "m/1", { kind: "classification", value: "other" });
          const override = adapter.setClassificationOverride?.bind(adapter);
          assert.ok(override);
          yield* override(account, { name: "Alice", address: "alice@example.com" }, "focused");
          assert.deepStrictEqual(
            http.calls.map((call) => call.body),
            [
              { inferenceClassification: "other" },
              {
                classifyAs: "focused",
                senderEmailAddress: { name: "Alice", address: "alice@example.com" },
              },
            ],
          );
          assert.isTrue(http.calls.every((call) => call.prefer?.includes('IdType="ImmutableId"')));
        }),
      ),
      Effect.provide(Layer.mergeAll(http.layer, platform())),
    );
  },
);

it.effect(
  "missing Mail.ReadWrite prevents both local classification and sender override, then reauth grants the feature",
  () => {
    let overrides = 0;
    const server = fakeServer(account.email, [
      incoming("one", { labels: ["INBOX", "CATEGORY_PERSONAL"] }),
    ]);
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const store = yield* Store;
      yield* m.connect({ provider: "outlook" });
      yield* m.sync();
      yield* store.setGrantedScopes(account.id, ["Mail.Read", "MailboxSettings.ReadWrite"]);
      const id = `${account.id}/one`;
      for (const work of [
        m.modifyWithUndo([id], { kind: "classification", value: "other" }, true),
        m.setClassificationOverride(id, "other"),
      ]) {
        const result = yield* work.pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.strictEqual(result.failure._tag, "FeatureScopeMissing");
          if (result.failure._tag === "FeatureScopeMissing")
            assert.strictEqual(result.failure.feature, "focusedInbox");
        }
      }
      assert.strictEqual(overrides, 0);
      assert.strictEqual((yield* store.listPendingOps).length, 0);
      assert.deepStrictEqual((yield* store.getMessage(id)).labels, ["INBOX", "CATEGORY_PERSONAL"]);
      yield* m.reauth(account.id, "focusedInbox");
      yield* m.setClassificationOverride(id, "other");
      assert.strictEqual(overrides, 1);
    }).pipe(
      Effect.provide(
        TestMailbox.withAdapter(
          (base) => ({
            ...base,
            setClassificationOverride: () =>
              Effect.sync(() => {
                overrides++;
              }),
          }),
          { servers: { outlook: server } },
        ),
      ),
    );
  },
);

it("migration 39 renews only Outlook cursors and preserves cached messages, FTS and notification dedup", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const script of MIGRATIONS.slice(0, 38)) applyNativeMigration(db, script);
    for (const provider of ["outlook", "gmail", "imap"]) {
      db.prepare(
        "INSERT INTO accounts(id,provider,email,created_at,sync_cursor) VALUES(?,?,?,?,?)",
      ).run(provider, provider, `${provider}@example.com`, 1, "cursor");
      db.prepare(
        "INSERT INTO incoming_state(account_id,inbox_cursor,initial_sync_complete) VALUES(?,?,1)",
      ).run(provider, "inbox-cursor");
      db.prepare(
        "INSERT INTO account_organization(account_id,categories,selected_categories) VALUES(?,1,?)",
      ).run(provider, '["CATEGORY_PERSONAL","CATEGORY_SOCIAL"]');
    }
    db.exec(`INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
      VALUES('m','outlook','m','t','Project','Alice','alice@example.com','[]','[]',1,'','cached searchable text','','["INBOX"]','[]',1,0)`);
    db.prepare("INSERT INTO seen_incoming(account_id,identity) VALUES('outlook','m')").run();
    const rowid = db.prepare("SELECT rowid FROM messages WHERE id='m'").get();
    applyNativeMigration(db, MIGRATIONS[38] ?? "");
    assert.strictEqual(
      db.prepare("SELECT sync_cursor FROM accounts WHERE id='outlook'").get()?.sync_cursor,
      null,
    );
    assert.strictEqual(
      db.prepare("SELECT inbox_cursor FROM incoming_state WHERE account_id='outlook'").get()
        ?.inbox_cursor,
      null,
    );
    assert.strictEqual(
      db
        .prepare("SELECT initial_sync_complete FROM incoming_state WHERE account_id='outlook'")
        .get()?.initial_sync_complete,
      1,
    );
    for (const provider of ["gmail", "imap"])
      assert.strictEqual(
        db.prepare("SELECT sync_cursor FROM accounts WHERE id=?").get(provider)?.sync_cursor,
        "cursor",
      );
    assert.deepStrictEqual(db.prepare("SELECT rowid FROM messages WHERE id='m'").get(), rowid);
    assert.strictEqual(
      db
        .prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'searchable'")
        .get()?.n,
      1,
    );
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM seen_incoming").get()?.n, 1);
    assert.strictEqual(
      db
        .prepare("SELECT selected_categories FROM account_organization WHERE account_id='outlook'")
        .get()?.selected_categories,
      null,
    );
  } finally {
    db.close();
  }
});

it.effect(
  "location-only Graph reset verification preserves cached Focused/Other and color categories",
  () => {
    const http = fakeHttp({
      "POST /$batch": {
        json: {
          responses: [{ id: "0", status: 200, body: { id: "m1", parentFolderId: "inbox" } }],
        },
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* makeOutlook;
      const store = yield* Store;
      yield* store.upsertAccount("outlook", account.email);
      const cached = parseGraphMessage(Schema.decodeUnknownSync(GraphMessage)(raw), "ARCHIVE", []);
      yield* store.upsertMessage(account.id, cached);
      const guard = makeResetGuard(
        store,
        adapter,
        account,
        { changed: 0, deleted: 0 },
        { remaining: 10 },
      );
      yield* guard.verify([{ providerId: "m1", rfcMessageId: null, labels: cached.labels }]);
      assert.deepStrictEqual(
        (yield* store.getMessage(`${account.id}/m1`)).labels.toSorted(),
        ["INBOX", "UNREAD", "CATEGORY_PERSONAL", "category:Work"].toSorted(),
      );
      assert.strictEqual(http.calls.filter((call) => call.method === "POST").length, 1);
    }).pipe(
      Effect.provide(StoreLive.pipe(Layer.provideMerge(Layer.mergeAll(platform(), http.layer)))),
    );
  },
);

it.effect(
  "window-excluded unclassified cached mail can move and undo to the effective Focused bucket",
  () => {
    const server = fakeServer(account.email, [
      incoming("unknown", { labels: ["INBOX", "UNREAD"], date: 1 }),
    ]);
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const store = yield* Store;
      yield* m.connect({ provider: "outlook" });
      yield* m.sync();
      const id = `${account.id}/unknown`;
      assert.deepStrictEqual(
        (yield* store.listThreads({ mailbox: "inbox", label: "CATEGORY_PERSONAL" })).map(
          (row) => row.id,
        ),
        [id],
      );
      assert.deepStrictEqual(
        (yield* store.listThreads({ search: "category:primary" })).map((row) => row.id),
        [id],
      );
      assert.isTrue(
        matchesSearch(incoming("unknown"), { search: "category:primary" }, [], "outlook"),
      );
      const result = yield* m.modifyWithUndo(
        [id],
        { kind: "classification", value: "other" },
        true,
      );
      assert.isTrue((yield* store.getMessage(id)).labels.includes("CATEGORY_OTHER"));
      yield* m.undoBatch(result.undoId);
      assert.isTrue((yield* store.getMessage(id)).labels.includes("CATEGORY_PERSONAL"));
    }).pipe(Effect.provide(TestMailbox({ outlook: server })));
  },
);

it.effect("sender overrides refuse account emails and aliases before any provider write", () => {
  let writes = 0;
  const server = fakeServer(account.email, [
    incoming("own", { from: { name: "Me", address: account.email.toUpperCase() } }),
    incoming("alias", { from: { name: "Me", address: "alias@example.com" } }),
  ]);
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    const store = yield* Store;
    yield* m.connect({ provider: "outlook" });
    yield* m.sync();
    yield* store.replaceSendAs(account.id, [
      {
        accountId: account.id,
        address: "alias@example.com",
        name: "Alias",
        isDefault: false,
        signature: "",
      },
    ]);
    for (const id of ["own", "alias"]) {
      const result = yield* m
        .setClassificationOverride(`${account.id}/${id}`, "other")
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "InvalidInput");
    }
    assert.strictEqual(writes, 0);
  }).pipe(
    Effect.provide(
      TestMailbox.withAdapter(
        (base) => ({
          ...base,
          setClassificationOverride: () =>
            Effect.sync(() => {
              writes++;
            }),
        }),
        { servers: { outlook: server } },
      ),
    ),
  );
});
