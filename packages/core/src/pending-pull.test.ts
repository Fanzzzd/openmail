import { assert, it } from "@effect/vitest";
import { Clock, Effect, Layer, Option, Schema, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { CurrentTransformer, type Transformer } from "effect/sql/Statement";
import type { IncomingMessage, Provider } from "./domain.js";
import { ProviderError } from "./errors.js";
import { makeFakeProvider } from "./platform/node/fake-provider.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { Providers, Store } from "./services.js";
import { StoreLive } from "./store.js";
import { fakeServer } from "./platform/node/testing.js";

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
        const fake = makeFakeProvider(server);
        let flagsOnly = false;
        const adapter = {
          ...fake,
          pull: (...args: Parameters<typeof fake.pull>) =>
            flagsOnly
              ? Stream.make({
                  _tag: "Flags",
                  providerId: "one",
                  isUnread: true,
                  isStarred: true,
                } as const)
              : fake.pull(...args),
        };
        const layer = MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provideMerge(
            Layer.merge(StoreLive, Layer.succeed(Providers, { get: () => adapter })).pipe(
              Layer.provideMerge(MemoryPlatform()),
            ),
          ),
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
          const statements: string[] = [];
          const capture: Transformer = (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile()[0]);
              return statement;
            });
          yield* m.sync().pipe(Effect.provideService(CurrentTransformer, capture));
          assert.strictEqual(
            statements.filter((sql) => sql.startsWith("INSERT INTO messages (")).length,
            1,
          );
          assert.isFalse(
            statements.some((sql) => sql.startsWith("UPDATE messages SET labels_json")),
          );
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

it.effect("incoming pending lookup uses the account index, filters ids and keeps queue order", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const sql = yield* SqlClient.SqlClient;
    const account = yield* store.upsertAccount("gmail", "me@example.com");
    const other = yield* store.upsertAccount("gmail", "other@example.com");
    yield* store.enqueueOp(account.id, "one", { kind: "star", value: true });
    yield* store.enqueueOp(account.id, "ignored", { kind: "archive" });
    yield* store.enqueueOp(other.id, "one", { kind: "trash" });
    yield* store.enqueueOp(account.id, "one", { kind: "read", value: true });
    const statements: (readonly [string, ReadonlyArray<unknown>])[] = [];
    const capture: Transformer = (statement) =>
      Effect.sync(() => {
        statements.push(statement.compile());
        return statement;
      });
    const pending = yield* store
      .pendingOpsForMessages(account.id, ["one"])
      .pipe(Effect.provideService(CurrentTransformer, capture));
    assert.deepStrictEqual(
      pending.map((item) => item.op),
      [
        { kind: "star", value: true },
        { kind: "read", value: true },
      ],
    );
    assert.isTrue(
      pending.every((item) => item.accountId === account.id && item.providerId === "one"),
    );
    assert.strictEqual(statements.length, 1);
    const statement = statements[0];
    assert.ok(statement);
    const plan = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ detail: Schema.String })),
    )(yield* sql.unsafe(`EXPLAIN QUERY PLAN ${statement[0]}`, statement[1]));
    assert.isTrue(plan.some((row) => row.detail.includes("pending_ops_account")));
    statements.length = 0;
    assert.deepStrictEqual(
      yield* store
        .pendingOpsForMessages(account.id, [])
        .pipe(Effect.provideService(CurrentTransformer, capture)),
      [],
    );
    assert.strictEqual(statements.length, 0);
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);

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
    const layer = MailboxLive({ backgroundFlush: false }).pipe(
      Layer.provideMerge(
        Layer.merge(StoreLive, Layer.succeed(Providers, { get: () => adapter })).pipe(
          Layer.provideMerge(MemoryPlatform()),
        ),
      ),
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
