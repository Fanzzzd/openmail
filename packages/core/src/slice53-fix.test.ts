import { first } from "./sql-rows.js";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, splitStatements } from "./db.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { StoreLive } from "./store.js";
import { Providers, Store } from "./services.js";
import { TestMailbox, fakeServer } from "./platform/node/testing.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { makeFakeProvider } from "./platform/node/fake-provider.js";
import { BASE_SCOPES, OPTIONAL_SCOPES } from "./optional-services.js";
import { GMAIL_PERMANENT_DELETE_SCOPE } from "./folder-actions.js";
import type { IncomingMessage } from "./domain.js";

const lastScopes = (server: ReturnType<typeof fakeServer>) => {
  const input = server.connects.at(-1);
  if (!input || input.provider === "imap") throw new Error("Expected OAuth request");
  return input.grantedScopes;
};
const old = -400 * 86_400_000;
const mail = (providerId: string, change: Partial<IncomingMessage> = {}): IncomingMessage => ({
  providerId,
  threadId: providerId,
  date: old,
  subject: providerId,
  from: { name: "", address: "sender@example.com" },
  to: [],
  cc: [],
  bodyText: "1234567890",
  bodyHtml: "",
  labels: ["ARCHIVE"],
  isStarred: false,
  isUnread: false,
  snippet: "header",
  attachments: [],
  ...change,
});
for (const provider of ["gmail", "outlook"] as const) {
  it.effect(`${provider}: upgrade records legacy grants without deleting contacts or aliases`, () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), "openmail-slice53-upgrade-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
      );
      const filename = join(directory, "mail.db");
      const accountId = `${provider}:legacy@example.com`;
      const db = new DatabaseSync(filename);
      try {
        for (const migration of MIGRATIONS.slice(0, 33))
          for (const statement of splitStatements(migration)) db.exec(statement);
        db.exec("PRAGMA user_version=33");
        db.prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,0)").run(
          accountId,
          provider,
          "legacy@example.com",
        );
        db.prepare("INSERT INTO server_contacts(account_id,address,name) VALUES(?,?,?)").run(
          accountId,
          "old@example.com",
          "Old person",
        );
        db.prepare(
          "INSERT INTO send_as(account_id,address,name,is_default,signature) VALUES(?,?,?,0,'')",
        ).run(accountId, "alias@example.com", "Alias");
      } finally {
        db.close();
      }
      const server = fakeServer("legacy@example.com");
      const layer = () =>
        MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              StoreLive,
              Layer.succeed(Providers, Providers.of({ get: () => makeFakeProvider(server) })),
            ).pipe(Layer.provideMerge(MemoryPlatform({ database: filename }))),
          ),
        );
      yield* Effect.gen(function* () {
        const m = yield* Mailbox;
        const store = yield* Store;
        assert.deepStrictEqual(
          (yield* m.optionalServices(accountId)).map((grant) => grant.state),
          ["granted", "granted", "granted"],
        );
        assert.ok(
          (yield* store.grantedScopes(accountId)).includes(
            OPTIONAL_SCOPES[provider].contacts[0] ?? "",
          ),
        );
        assert.ok(
          (yield* m.suggestContacts("old")).some(
            (contact) => contact.address === "old@example.com",
          ),
        );
        assert.ok((yield* m.sendAs).some((alias) => alias.address === "alias@example.com"));
        assert.strictEqual((yield* m.prefs).bodyCacheBytes, 0);
      }).pipe(Effect.provide(layer()));
      yield* Effect.gen(function* () {
        const m = yield* Mailbox;
        assert.ok((yield* m.suggestContacts("old")).length);
        assert.ok((yield* m.sendAs).length);
        assert.strictEqual((yield* m.optionalServices(accountId))[0]?.state, "granted");
      }).pipe(Effect.provide(layer()));
    }).pipe(Effect.scoped),
  );
  it.effect(`${provider}: ordinary reauth and re-add preserve stored grants`, () => {
    const server = fakeServer("me@example.com");
    server.grantedScopes = [
      ...new Set([
        ...BASE_SCOPES[provider],
        ...Object.values(OPTIONAL_SCOPES[provider]).flat(),
        ...(provider === "gmail" ? [GMAIL_PERMANENT_DELETE_SCOPE] : []),
      ]),
    ];
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const account = yield* m.connect({ provider });
      yield* m.reauth(account.id);
      assert.deepStrictEqual(lastScopes(server), server.grantedScopes);
      yield* m.connect({ provider, loginHint: account.email });
      assert.deepStrictEqual(lastScopes(server), server.grantedScopes);
      yield* m.connect({ provider });
      assert.deepStrictEqual(lastScopes(server), server.grantedScopes);
    }).pipe(Effect.provide(TestMailbox({ [provider]: server })));
  });
}
it.effect(
  "Gmail Settings off retains aliases, reads them with mail scopes, and blocks only settings writes",
  () => {
    const server = fakeServer("me@gmail.com");
    server.grantedScopes = [...BASE_SCOPES.gmail];
    server.aliases = [
      {
        accountId: "gmail:me@gmail.com",
        address: "alias@example.com",
        name: "Alias",
        isDefault: false,
        signature: "",
      },
    ];
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const account = yield* m.connect({ provider: "gmail" });
      yield* m.syncSendAs(account.id);
      assert.ok((yield* m.sendAs).length);
      assert.strictEqual((yield* m.filters(account.id).pipe(Effect.result))._tag, "Success");
      assert.strictEqual((yield* m.vacation(account.id).pipe(Effect.result))._tag, "Success");
      yield* m.setServiceEnabled(account.id, "settings", false);
      assert.ok((yield* m.sendAs).length);
      yield* m.syncSendAs(account.id);
      assert.ok((yield* m.sendAs).length);
      assert.strictEqual(
        (yield* m.setVacation(account.id, server.vacation).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);
it("Outlook base grant includes the permission required by master categories", () =>
  assert.ok(BASE_SCOPES.outlook.includes("MailboxSettings.ReadWrite")));

it.effect(
  "budget respects stars, all retention windows, drafts and outbox, and is disabled by default",
  () =>
    Effect.gen(function* () {
      const m = yield* Mailbox;
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      assert.strictEqual((yield* m.prefs).bodyCacheBytes, 0);
      const protectedMail = [
        mail("inbox", { labels: ["INBOX"] }),
        mail("star", { isStarred: true }),
        mail("draft", { labels: ["DRAFT"] }),
        mail("outbox", { labels: ["OUTBOX"] }),
        mail("forever", { labels: ["Work"] }),
        mail("recent", { date: 0 }),
      ];
      yield* store.setCacheWindow({ accountId: account.id, label: "Work", days: null });
      for (const message of [...protectedMail, mail("expired")])
        yield* store.upsertMessage(account.id, message);
      yield* m.setPrefs({ bodyCacheBytes: 1 });
      for (const message of protectedMail)
        assert.strictEqual(
          (yield* store.getMessage(`${account.id}/${message.providerId}`)).bodyCached,
          true,
          message.providerId,
        );
      assert.strictEqual((yield* store.getMessage(`${account.id}/expired`)).bodyCached, false);
      yield* store.upsertMessage(account.id, mail("disabled"));
      yield* m.setPrefs({ bodyCacheBytes: 0 });
      assert.strictEqual((yield* store.getMessage(`${account.id}/disabled`)).bodyCached, true);
    }).pipe(Effect.provide(TestMailbox())),
);
it.effect("budget runs at most hourly and respects explicit preference changes", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("gmail", "me@example.com");
    yield* store.upsertMessage(account.id, mail("first"));
    yield* store.evictBodyBudget(1);
    yield* store.upsertMessage(account.id, mail("second"));
    assert.strictEqual(yield* store.evictBodyBudget(1), 0);
    assert.strictEqual((yield* store.getMessage(`${account.id}/second`)).bodyCached, true);
    yield* TestClock.adjust("1 hour");
    assert.strictEqual(yield* store.evictBodyBudget(1), 1);
    assert.strictEqual((yield* store.getMessage(`${account.id}/second`)).bodyCached, false);
  }).pipe(Effect.provide(TestMailbox())),
);
it.effect("Gmail local draft organization survives actual provider Flags sync", () => {
  const server = fakeServer("me@gmail.com");
  const base = makeFakeProvider(server);
  let flagsOnly = false;
  const adapter = {
    ...base,
    pull: (...args: Parameters<typeof base.pull>) =>
      flagsOnly
        ? Stream.fromIterable(
            [...server.messages.values()].map((message) => ({
              _tag: "Flags" as const,
              providerId: message.providerId,
              isUnread: false,
              isStarred: message.isStarred,
            })),
          )
        : base.pull(...args),
  };
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    const account = yield* m.connect({ provider: "gmail" });
    const draft = yield* m.saveDraft({
      id: "draft:flags-real",
      accountId: account.id,
      message: {
        to: [],
        cc: [],
        bcc: [],
        attachments: [],
        subject: "draft",
        text: "text",
        draftOrganization: { labels: ["Label_work"], starred: true },
      },
    });
    yield* m.sync();
    flagsOnly = true;
    yield* m.sync();
    assert.strictEqual((yield* m.threads({ mailbox: "drafts" }))[0]?.isStarred, true);
    yield* m.saveDraft({
      id: draft.id,
      accountId: account.id,
      message: { ...draft.message, draftOrganization: { labels: [], starred: false } },
    });
    for (const [id, message] of server.messages)
      server.messages.set(id, { ...message, isStarred: true });
    yield* m.sync();
    const cleared = (yield* m.threads({ mailbox: "drafts" }))[0];
    assert.strictEqual(cleared?.isStarred, false);
    assert.ok(!cleared?.labels.includes("Label_work"));
  }).pipe(
    Effect.provide(
      MailboxLive({ backgroundFlush: false }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            StoreLive,
            Layer.succeed(Providers, Providers.of({ get: () => adapter })),
          ).pipe(Layer.provideMerge(MemoryPlatform())),
        ),
      ),
    ),
  );
});

it.effect(
  "byte accounting survives Unicode updates, eviction and deletes; LRU order uses the index",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "bytes@example.com");
      const values = first(
        Schema.Struct({ bytes: Schema.Number, total: Schema.Number, rowid: Schema.Number }),
      )(
        sql`SELECT m.body_bytes AS bytes,b.total_bytes AS total,m.rowid FROM messages m CROSS JOIN body_cache_budget b WHERE m.id=${`${account.id}/bytes`} AND b.id=1`,
      );
      yield* store.upsertMessage(
        account.id,
        mail("bytes", { bodyText: "世界", bodyHtml: "<b>é</b>" }),
      );
      const before = yield* values;
      assert.ok(before._tag === "Some");
      assert.strictEqual(before.value.bytes, 15);
      assert.strictEqual(before.value.total, 15);
      yield* store.upsertMessage(account.id, mail("bytes", { bodyText: "z", bodyHtml: "" }));
      const updated = yield* values;
      assert.ok(updated._tag === "Some");
      assert.strictEqual(updated.value.bytes, 1);
      assert.strictEqual(updated.value.total, 1);
      assert.strictEqual(updated.value.rowid, before.value.rowid);
      const plan = yield* first(Schema.Struct({ detail: Schema.String }))(
        sql`EXPLAIN QUERY PLAN SELECT id FROM messages WHERE body_cached=1 AND body_bytes>0 ORDER BY COALESCE(body_opened_at,date),id LIMIT 100`,
      );
      assert.ok(plan._tag === "Some" && plan.value.detail.includes("messages_body_lru"));
      yield* store.upsertMessage(account.id, mail("extra"));
      yield* store.evictBodyBudget(5);
      const evicted = yield* values;
      assert.ok(evicted._tag === "Some");
      assert.strictEqual(evicted.value.bytes, 0);
      assert.strictEqual(evicted.value.total, 0);
      assert.strictEqual(evicted.value.rowid, before.value.rowid);
      yield* store.upsertMessage(account.id, mail("bytes", { bodyText: "z", bodyHtml: "" }));
      yield* store.deleteMessage(account.id, "bytes");
      const deleted = yield* first(Schema.Struct({ total_bytes: Schema.Number }))(
        sql`SELECT total_bytes FROM body_cache_budget WHERE id=1`,
      );
      assert.ok(deleted._tag === "Some");
      assert.strictEqual(deleted.value.total_bytes, 0);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);
