import { TestMailbox, fakeServer } from "../platform/node/testing.js";
import { assert, it } from "@effect/vitest";
import { Clock, Effect, Option, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { type IncomingMessage, type Provider } from "../domain/domain.js";
import { ProviderError } from "../domain/errors.js";
import { makeFakeProvider } from "../platform/node/fake-provider.js";
import { Mailbox } from "./mailbox.js";
import { Store } from "../store/service.js";
const incoming = (labels: string[]): IncomingMessage => ({
  providerId: "one",
  threadId: "thread",
  subject: "Pending before snooze",
  from: { name: "Alice", address: "alice@example.com" },
  to: [],
  cc: [],
  date: 1000,
  snippet: "",
  bodyText: "original",
  bodyHtml: "",
  attachments: [],
  labels,
  isUnread: labels.includes("UNREAD"),
  isStarred: labels.includes("STARRED"),
});

for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  for (const sequence of ["inbox", "archive-undo"] as const) {
    for (const pull of ["upsert", "flags"] as const) {
      it.effect(`${provider}: pending ${sequence} then snooze survives ${pull} sync`, () => {
        const server = fakeServer(`${provider}@example.com`, [
          incoming(sequence === "inbox" ? ["ARCHIVE", "UNREAD"] : ["INBOX", "UNREAD"]),
        ]);
        let flagsOnly = false;
        const layer = TestMailbox.withAdapter(
          (base) => ({
            ...base,
            pull: (...args: Parameters<typeof base.pull>) =>
              flagsOnly
                ? Stream.make({
                    _tag: "Flags",
                    providerId: "one",
                    isUnread: true,
                    isStarred: true,
                  } as const)
                : base.pull(...args),
          }),
          { servers: { [provider]: server } },
        );
        return Effect.gen(function* () {
          const m = yield* Mailbox;
          const store = yield* Store;
          const account = yield* m.connect(
            provider === "imap"
              ? { provider, input: { preset: "icloud", email: server.email, password: "fake" } }
              : { provider },
          );
          yield* m.sync();
          const id = `${account.id}/one`;
          server.beforePush = Effect.fail(new ProviderError({ message: "offline", status: 503 }));
          const batch = yield* m.modifyWithUndo([id], {
            kind: sequence === "inbox" ? "inbox" : "archive",
          });
          if (sequence === "archive-undo") yield* m.undoBatch(batch.undoId);
          const due = (yield* Clock.currentTimeMillis) + 60_000;
          yield* m.snoozeWithUndo([id], due);
          const before = yield* store.reminderSnapshot(id);
          assert.isTrue(Option.isSome(before));
          flagsOnly = pull === "flags";
          const sql = yield* SqlClient.SqlClient;
          const rowid = yield* sql`SELECT rowid FROM messages WHERE id=${id}`;
          if (flagsOnly) {
            yield* sql`CREATE TEMP TABLE label_writes(message_id TEXT PRIMARY KEY, writes INTEGER NOT NULL)`;
            yield* sql`INSERT INTO label_writes VALUES (${id}, 0)`;
            yield* sql`CREATE TEMP TRIGGER count_label_writes AFTER UPDATE OF labels_json ON main.messages
              BEGIN UPDATE label_writes SET writes=writes+1 WHERE message_id=NEW.id; END`;
          }
          yield* m.sync();
          if (flagsOnly) {
            // The changed flags need one upsert; they must not replay a separate label update.
            assert.strictEqual((yield* sql`SELECT writes FROM label_writes`)[0]?.["writes"], 1);
            const labels = yield* sql`SELECT labels_json FROM messages WHERE id=${id}`;
            yield* sql`UPDATE label_writes SET writes=0`;
            yield* m.sync();
            assert.strictEqual((yield* sql`SELECT writes FROM label_writes`)[0]?.["writes"], 0);
            assert.deepStrictEqual(
              yield* sql`SELECT labels_json FROM messages WHERE id=${id}`,
              labels,
            );
          }
          assert.deepStrictEqual(yield* sql`SELECT rowid FROM messages WHERE id=${id}`, rowid);
          const message = yield* store.getMessage(id);
          assert.strictEqual(message.bodyText, "original");
          assert.deepStrictEqual(yield* store.reminderSnapshot(id), before);
          assert.include((yield* store.getMessage(id)).labels, "SNOOZED");
          assert.notInclude((yield* store.getMessage(id)).labels, "INBOX");
          assert.strictEqual((yield* m.threads({ mailbox: "snoozed" }))[0]?.id, id);
          assert.deepStrictEqual(yield* m.threads({ mailbox: "inbox" }), []);
          assert.isAbove((yield* store.listPendingOps).length, 0);
          assert.strictEqual(server.pushed.length, 0);
        }).pipe(Effect.provide(layer));
      });
    }
  }
}

for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it.effect(`${provider}: queued read and star preserve wake_pending when Flags arrive`, () => {
    const server = fakeServer(`${provider}@example.com`, [incoming(["INBOX", "UNREAD"])]);
    const fake = makeFakeProvider(server);
    let flagsOnly = false;
    const adapter = {
      ...fake,
      pull: (...args: Parameters<typeof fake.pull>) =>
        flagsOnly
          ? Stream.make({
              _tag: "Flags",
              providerId: "one",
              isUnread: false,
              isStarred: false,
            } as const)
          : fake.pull(...args),
    };
    const layer = TestMailbox.withAdapter(adapter, {
      options: { backgroundFlush: false },
      platformOptions: {},
    });
    return Effect.gen(function* () {
      const m = yield* Mailbox;
      const store = yield* Store;
      const account = yield* m.connect(
        provider === "imap"
          ? { provider, input: { preset: "icloud", email: server.email, password: "fake" } }
          : { provider },
      );
      yield* m.sync();
      const id = `${account.id}/one`;
      server.beforePush = Effect.fail(new ProviderError({ message: "offline", status: 503 }));
      yield* m.modifyWithUndo([id], { kind: "read", value: true });
      yield* m.modifyWithUndo([id], { kind: "star", value: true });
      yield* store.restoreReminder({
        accountId: account.id,
        threadId: "thread",
        dueAt: null,
        wokenAt: yield* Clock.currentTimeMillis,
        wakePending: true,
        members: [{ providerId: "one", wakePending: true }],
      });
      const before = yield* store.reminderSnapshot(id);
      flagsOnly = true;
      yield* m.sync();
      assert.deepStrictEqual(yield* store.reminderSnapshot(id), before);
      const message = yield* store.getMessage(id);
      assert.isTrue(message.isUnread);
      assert.isTrue(message.isStarred);
      assert.include(message.labels, "INBOX");
      assert.include(message.labels, "UNREAD");
      assert.include(message.labels, "STARRED");
      assert.strictEqual(server.pushed.length, 0);
    }).pipe(Effect.provide(layer));
  });
}
