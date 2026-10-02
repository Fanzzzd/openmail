import { richComposeBody } from "./compose-body.js";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "./platform/node/db.js";
import { DEFAULT_PREFS, type IncomingMessage, type OutgoingMessage } from "./domain.js";
import { fakeServer, makeFakeProvider, type FakeServer } from "./platform/node/fake-provider.js";
import { Mailbox } from "./mailbox.js";
import { TestMailbox } from "./platform/node/testing.js";
import { MailboxLive } from "./mailbox-live.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { Store, Providers, type ProviderAdapter } from "./services.js";
import { StoreLive } from "./store.js";
import { ProviderError } from "./errors.js";
import { applyComposeSignature, replyFromAddress } from "./signatures.js";

const accountId = "gmail:me@example.com";
const message: OutgoingMessage = {
  to: [{ name: "John", address: "j@acme.com" }],
  cc: [],
  bcc: [],
  subject: "Hello",
  text: "v1",
  attachments: [],
};
const incoming: IncomingMessage = {
  providerId: "one",
  threadId: "one",
  from: { name: "John", address: "j@acme.com" },
  to: [],
  cc: [],
  subject: "Hello",
  snippet: "",
  bodyText: "Hello",
  bodyHtml: "",
  date: 1,
  labels: ["INBOX"],
  attachments: [],
  isUnread: false,
  isStarred: false,
};
function fixture<A, E>(
  body: (
    m: Mailbox["Service"],
    store: Store["Service"],
    server: FakeServer,
  ) => Effect.Effect<A, E, SqlClient.SqlClient>,
  wrap: (adapter: ProviderAdapter) => ProviderAdapter = (adapter) => adapter,
) {
  const server = fakeServer("me@example.com");
  const adapter = wrap(makeFakeProvider(server));
  return Effect.gen(function* () {
    const m = yield* Mailbox,
      store = yield* Store;
    yield* store.upsertAccount("gmail", server.email);
    return yield* body(m, store, server);
  }).pipe(
    Effect.provide(
      MailboxLive({ backgroundFlush: false }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(StoreLive, Layer.succeed(Providers, { get: () => adapter })).pipe(
            Layer.provideMerge(MemoryPlatform()),
          ),
        ),
      ),
    ),
  );
}

it.effect(
  "keeping local during a claimed push retains its remote ids and Retry updates the single cloud draft",
  () =>
    Effect.gen(function* () {
      const created = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      let calls = 0;
      yield* fixture(
        (m, store, server) =>
          Effect.gen(function* () {
            const saving = yield* Effect.forkChild(
              m.saveDraft({ id: "draft:race", accountId, message }),
            );
            yield* Deferred.await(created);
            yield* m.recoverDraft("draft:race", "local");
            assert.strictEqual((yield* store.listPendingOps).length, 1);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(saving);
            const kept = yield* store.getDraft("draft:race");
            assert.ok(Option.isSome(kept));
            assert.ok(kept.value.remote?.draftId);
            assert.strictEqual(kept.value.localOnly, true);
            yield* m.recoverDraft("draft:race", "retry");
            assert.strictEqual(server.drafts.size, 1);
            const second = server.draftLog.filter((log) => log.kind === "save")[1];
            assert.strictEqual(second?.push.remote?.draftId, kept.value.remote.draftId);
          }),
        (adapter) => ({
          ...adapter,
          saveDraft: (account, push) =>
            adapter
              .saveDraft(account, push)
              .pipe(
                Effect.tap(() =>
                  Effect.suspend(() =>
                    ++calls === 1
                      ? Deferred.succeed(created, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                        )
                      : Effect.void,
                  ),
                ),
              ),
        }),
      );
    }),
);

it.effect("a push whose local draft is discarded deletes the newly created cloud copy", () =>
  Effect.gen(function* () {
    const created = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    yield* fixture(
      (m, store, server) =>
        Effect.gen(function* () {
          const saving = yield* Effect.forkChild(
            m.saveDraft({ id: "draft:discard", accountId, message }),
          );
          yield* Deferred.await(created);
          yield* store.deleteDraft("draft:discard");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(saving);
          assert.strictEqual(server.drafts.size, 0);
        }),
      (adapter) => ({
        ...adapter,
        saveDraft: (account, push) =>
          adapter
            .saveDraft(account, push)
            .pipe(
              Effect.tap(() =>
                Deferred.succeed(created, undefined).pipe(Effect.andThen(Deferred.await(release))),
              ),
            ),
      }),
    );
  }),
);

it.effect("unchanged upserts and no-op labels do not rebuild contact candidates", () =>
  fixture((_m, store) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* store.upsertMessage(accountId, incoming);
      yield* sql`CREATE TABLE candidate_changes(count INTEGER)`;
      yield* sql`INSERT INTO candidate_changes VALUES(0)`;
      yield* sql`CREATE TRIGGER observe_contact_delete AFTER DELETE ON contact_candidates BEGIN UPDATE candidate_changes SET count=count+1; END`;
      yield* store.upsertMessage(accountId, incoming);
      yield* sql`UPDATE messages SET labels_json=labels_json WHERE provider_id='one'`;
      const [changes] = yield* sql`SELECT count FROM candidate_changes`;
      assert.strictEqual(changes?.count, 0);
      yield* store.upsertMessage(accountId, {
        ...incoming,
        from: { name: "Updated", address: "updated@acme.com" },
      });
      assert.strictEqual(
        (yield* store.suggestContacts("updated acme", 10))[0]?.address,
        "updated@acme.com",
      );
      assert.deepStrictEqual(yield* store.suggestContacts("john acme", 10), []);
    }),
  ),
);

it("migration 23 safely indexes mixed/empty recipients already stored by migration 22", () => {
  const directory = mkdtempSync(join(tmpdir(), "openmail-signatures-fixes-"));
  const db = new DatabaseSync(join(directory, "mail.db"));
  try {
    const migration23 = MIGRATIONS[22];
    assert.ok(migration23);
    for (const migration of MIGRATIONS.slice(0, 22)) db.exec(migration);
    db.prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,?)").run(
      accountId,
      "gmail",
      "me@example.com",
      0,
    );
    db.prepare(
      "INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "one",
      accountId,
      "one",
      "one",
      "Hello",
      "Me",
      "me@example.com",
      JSON.stringify([
        "broken",
        null,
        {},
        { address: "" },
        { address: " " },
        { address: "John@Acme.Com", name: "John" },
      ]),
      "[]",
      1,
      "",
      "",
      "",
      '["SENT"]',
      "[]",
      0,
      0,
    );
    db.exec(migration23);
    assert.deepStrictEqual(
      db
        .prepare("SELECT DISTINCT address FROM contact_candidates WHERE source=2")
        .all()
        .map((row) => row.address),
      ["john@acme.com"],
    );
    db.exec(
      'UPDATE messages SET to_json=\'[null,{},"broken",{"address":""},{"address":"jane@acme.com","name":"Jane"}]\' WHERE id=\'one\'',
    );
    assert.deepStrictEqual(
      db
        .prepare("SELECT DISTINCT address FROM contact_candidates WHERE source=2")
        .all()
        .map((row) => row.address),
      ["jane@acme.com"],
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.effect(
  "deleting a chosen signature restores Gmail fallback while explicit None stays None",
  () =>
    fixture((m, store) =>
      Effect.gen(function* () {
        yield* store.replaceSendAs(accountId, [
          { accountId, address: "me@example.com", name: "Me", isDefault: true, signature: "Gmail" },
        ]);
        const local = yield* m.saveNamedSignature({
          address: "me@example.com",
          name: "Local",
          text: "Local",
        });
        yield* m.setSignatureDefault({
          address: local.address,
          kind: "new",
          signatureId: local.id,
        });
        yield* m.setSignatureDefault({ address: local.address, kind: "reply", signatureId: null });
        yield* m.deleteNamedSignature(local.id);
        assert.strictEqual((yield* m.signatures).find((s) => s.kind === "new")?.text, "Gmail");
        assert.ok(!(yield* m.signatures).some((s) => s.kind === "reply"));
      }),
    ),
);

it("replying to one's own Sent message retains its verified From ahead of recipients", () => {
  const aliases = [
    { accountId, address: "alias@example.com", name: "Alias", isDefault: false, signature: "" },
  ];
  const sent = {
    from: { name: "Alias", address: "alias@example.com" },
    to: [{ name: "", address: "me@example.com" }],
    cc: [],
    labels: ["SENT"],
  };
  assert.strictEqual(
    replyFromAddress(sent, { id: accountId, email: "me@example.com" }, aliases, "received").address,
    "alias@example.com",
  );
  assert.strictEqual(
    replyFromAddress(sent, { id: accountId, email: "me@example.com" }, aliases, "default").address,
    "me@example.com",
  );
});

it.effect("Retry atomically saves current edits while an earlier push is still claimed", () =>
  Effect.gen(function* () {
    const created = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    let count = 0;
    yield* fixture(
      (m, store, server) =>
        Effect.gen(function* () {
          const saving = yield* Effect.forkChild(
            m.saveDraft({ id: "draft:retry-race", accountId, message }),
          );
          yield* Deferred.await(created);
          const retry = yield* Effect.forkChild(
            m.recoverDraft("draft:retry-race", "retry", {
              id: "draft:retry-race",
              accountId,
              message: { ...message, text: "Current edits" },
            }),
          );
          yield* Effect.yieldNow;
          // The old claimed push remains owned; recovery never passes through local-only.
          const current = yield* store.getDraft("draft:retry-race");
          assert.ok(Option.isSome(current));
          assert.strictEqual(current.value.localOnly, false);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(saving);
          const result = yield* Fiber.join(retry);
          assert.strictEqual(result.message.text, "Current edits");
          assert.strictEqual(result.synced, true);
          assert.strictEqual(server.drafts.size, 1);
          assert.strictEqual([...server.drafts.values()][0]?.push.message.text, "Current edits");
        }),
      (adapter) => ({
        ...adapter,
        saveDraft: (account, push) =>
          adapter
            .saveDraft(account, push)
            .pipe(
              Effect.tap(() =>
                Effect.suspend(() =>
                  ++count === 1
                    ? Deferred.succeed(created, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                      )
                    : Effect.void,
                ),
              ),
            ),
      }),
    );
  }),
);

it.effect(
  "a late push after changing accounts deletes its cloud copy instead of attaching it to the new account",
  () =>
    Effect.gen(function* () {
      const created = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      yield* fixture(
        (m, store, server) =>
          Effect.gen(function* () {
            const saving = yield* Effect.forkChild(
              m.saveDraft({ id: "draft:moved", accountId, message }),
            );
            yield* Deferred.await(created);
            const other = yield* store.upsertAccount("outlook", "other@example.com");
            yield* store.putDraft({ id: "draft:moved", accountId: other.id, message });
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(saving);
            assert.strictEqual(server.drafts.size, 0);
            const moved = yield* store.getDraft("draft:moved");
            assert.ok(Option.isSome(moved));
            assert.strictEqual(moved.value.remote, null);
          }),
        (adapter) => ({
          ...adapter,
          saveDraft: (account, push) =>
            adapter
              .saveDraft(account, push)
              .pipe(
                Effect.tap(() =>
                  Deferred.succeed(created, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                ),
              ),
        }),
      );
    }),
);

it.effect(
  "pending transient failures stay recoverable and become terminal only when attempts are exhausted",
  () =>
    fixture((m, _store, server) =>
      Effect.gen(function* () {
        for (let attempt = 1; attempt <= 5; attempt++) {
          server.failNext = new ProviderError({ message: "Private network detail" });
          yield* attempt === 1
            ? m.saveDraft({ id: "draft:attempts", accountId, message })
            : m.sync();
          const draft = yield* m.openDraft("draft:attempts");
          assert.strictEqual(draft.syncRetrying, attempt < 5);
          assert.strictEqual(draft.syncError, "Private network detail");
          assert.strictEqual(draft.message.text, message.text);
        }
      }),
    ),
);

it.effect("remote acknowledgements retain local-only error bookkeeping", () =>
  fixture((_m, store) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* store.putDraft({ id: "draft:bookkeeping", accountId, message });
      yield* store.setDraftLocalOnly("draft:bookkeeping", true);
      yield* sql`UPDATE drafts SET sync_error='Preserved diagnostic' WHERE id='draft:bookkeeping'`;
      assert.strictEqual(
        yield* store.setDraftRemote(
          "draft:bookkeeping",
          { draftId: "remote", messageId: "message" },
          "attachments",
          accountId,
        ),
        true,
      );
      const draft = yield* store.getDraft("draft:bookkeeping");
      assert.ok(Option.isSome(draft));
      assert.strictEqual(draft.value.syncError, "Preserved diagnostic");
      assert.deepStrictEqual(draft.value.remote, { draftId: "remote", messageId: "message" });
    }),
  ),
);
it("signature insertion and switching preserve main's compose font metadata", () => {
  const body = { ...richComposeBody("Body"), font: DEFAULT_PREFS.composeFont };
  const first = { text: "First" },
    second = { text: "Second" };
  const signed = applyComposeSignature(body, undefined, first),
    switched = applyComposeSignature(signed, first, second);
  const removed = applyComposeSignature(switched, second, undefined);
  for (const result of [signed, switched, removed]) {
    assert.ok(result.kind === "rich");
    assert.deepStrictEqual(result.font, body.font);
  }
});

it.effect(
  "changing From accounts keeps a local copy local and leaves the old server draft untouched",
  () => {
    const gmail = fakeServer("me@example.com"),
      outlook = fakeServer("other@example.com");
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const originalAccount = yield* mailbox.connect({ provider: "gmail" });
      const newAccount = yield* mailbox.connect({ provider: "outlook" });
      const saved = yield* mailbox.saveDraft({
        id: "draft:local-account-change",
        accountId: originalAccount.id,
        message,
      });
      yield* mailbox.sync();
      const oldCloudDrafts = [...gmail.drafts.entries()];
      const oldLogLength = gmail.draftLog.length;
      assert.strictEqual(oldCloudDrafts.length, 1);
      yield* mailbox.recoverDraft(saved.id, "local");
      const changed = yield* mailbox.saveDraft({
        id: saved.id,
        accountId: newAccount.id,
        message: { ...message, text: "Local edits after changing From" },
      });
      yield* mailbox.sync();
      const reopened = yield* mailbox.openDraft(saved.id);
      assert.deepStrictEqual(
        {
          returnedLocal: changed.localOnly,
          storedLocal: reopened.localOnly,
          oldCloudCount: gmail.drafts.size,
          newCloudCount: outlook.drafts.size,
        },
        { returnedLocal: true, storedLocal: true, oldCloudCount: 1, newCloudCount: 0 },
      );
      assert.strictEqual(reopened.accountId, newAccount.id);
      assert.strictEqual(reopened.message.text, "Local edits after changing From");
      assert.deepStrictEqual([...gmail.drafts.entries()], oldCloudDrafts);
      assert.strictEqual(gmail.draftLog.length, oldLogLength);
      assert.strictEqual(outlook.draftLog.length, 0);
    }).pipe(Effect.provide(TestMailbox({ gmail, outlook })));
  },
);
