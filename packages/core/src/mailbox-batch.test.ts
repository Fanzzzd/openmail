import { assert, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { databaseLayer } from "./db.js";
import type { IncomingMessage, MailOp, Provider } from "./domain.js";
import { AuthError } from "./errors.js";
import { makeFakeProvider } from "./fake-provider.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { MemoryPlatform } from "./platform-memory.js";
import { NodeSystem } from "./platform-node.js";
import { Providers, Store } from "./services.js";
import { StoreLive } from "./store.js";
import { fakeServer, TestMailbox } from "./testing.js";

const message = (id: string, labels = ["INBOX", "UNREAD"], threadId = id): IncomingMessage => ({
  providerId: id,
  threadId,
  labels,
  isUnread: labels.includes("UNREAD"),
  isStarred: labels.includes("STARRED"),
  from: { name: "Sender", address: "from@example.com" },
  to: [],
  cc: [],
  date: 1000,
  subject: id,
  snippet: "",
  bodyText: "body",
  bodyHtml: "",
  attachments: [],
});

const fields = (
  messages: readonly {
    id: string;
    labels: readonly string[];
    isUnread: boolean;
    isStarred: boolean;
  }[],
) =>
  messages
    .map((m) => ({
      id: m.id,
      labels: [...m.labels].toSorted(),
      isUnread: m.isUnread,
      isStarred: m.isStarred,
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));

for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it.effect(
    `${provider}: whole batches restore mixed flags and original folders in a temporary database`,
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-batch-"))),
          (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const server = fakeServer(`${provider}@example.com`, [
          message("a", ["INBOX", "UNREAD"], "shared"),
          message("b", ["custom", "STARRED"], "shared"),
          message("c", ["ARCHIVE", "UNREAD", "STARRED"]),
          message("untouched", ["INBOX", "UNREAD"]),
        ]);
        server.labels = [
          { id: "custom", name: "Custom", color: null },
          { id: "target", name: "Target", color: null },
        ];
        const adapter = makeFakeProvider(server, { strictFolders: true });
        const layer = MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provide(
            Layer.merge(
              StoreLive.pipe(
                Layer.provide(
                  databaseLayer(join(directory, "mail.db")).pipe(Layer.provide(NodeSystem)),
                ),
              ),
              Layer.succeed(Providers, Providers.of({ get: () => adapter })),
            ),
          ),
          Layer.provide(MemoryPlatform()),
        );
        yield* Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          yield* mailbox.connect(
            provider === "imap"
              ? {
                  provider,
                  input: {
                    preset: "custom",
                    email: server.email,
                    password: "test",
                    imapHost: "imap.example.com",
                    imapPort: 993,
                    smtpHost: "smtp.example.com",
                    smtpPort: 465,
                    smtpSecure: true,
                  },
                }
              : { provider },
          );
          yield* mailbox.sync();
          const rows = yield* mailbox.threads({ mailbox: "all" });
          const selected = rows.filter((row) => row.subject !== "untouched").map((row) => row.id);
          const untouched = rows.find((row) => row.subject === "untouched");
          assert.ok(untouched);
          const originals = fields(
            (yield* Effect.forEach(selected, (id) => mailbox.thread(id))).flat(),
          );
          const other = fields(yield* mailbox.thread(untouched.id));
          const ops: MailOp[] = [
            { kind: "read", value: true },
            { kind: "read", value: false },
            { kind: "star", value: true },
            { kind: "star", value: false },
            { kind: "archive" },
            { kind: "trash" },
            { kind: "label", labelId: "target", value: true },
            { kind: "label", labelId: "custom", value: false },
          ];
          for (const op of ops) {
            const batch = yield* mailbox.modifyWithUndo([...selected, ...selected], op);
            yield* mailbox.sync();
            yield* mailbox.undoBatch(batch.undoId);
            yield* mailbox.sync();
            assert.deepStrictEqual(
              fields((yield* Effect.forEach(selected, (id) => mailbox.thread(id))).flat()),
              originals,
            );
            assert.strictEqual(originals.length, 3);
            assert.deepStrictEqual(fields(yield* mailbox.thread(untouched.id)), other);
            assert.ok(!server.pushed.some((push) => push.providerId === "untouched"));
            // Pulling again also confirms the provider ended up with the restored state.
            yield* mailbox.sync();
            assert.deepStrictEqual(
              fields((yield* Effect.forEach(selected, (id) => mailbox.thread(id))).flat()),
              originals,
            );
            const repeated = yield* mailbox.undoBatch(batch.undoId).pipe(Effect.flip);
            assert.strictEqual(repeated._tag, "InvalidInput");
          }
          const partial = yield* mailbox.modifyWithUndo([selected[0]!, "missing"], {
            kind: "trash",
          });
          yield* mailbox.undoBatch(partial.undoId);
          yield* mailbox.sync();
          assert.deepStrictEqual(
            fields((yield* Effect.forEach(selected, (id) => mailbox.thread(id))).flat()),
            originals,
          );
          yield* mailbox.setPrefs({ nextSelection: "above" });
          assert.strictEqual((yield* mailbox.prefs).nextSelection, "above");
        }).pipe(Effect.provide(layer));
        yield* Effect.gen(function* () {
          const store = yield* Store;
          assert.strictEqual((yield* store.prefs).nextSelection, "above");
        }).pipe(
          Effect.provide(
            StoreLive.pipe(
              Layer.provide(
                databaseLayer(join(directory, "mail.db")).pipe(Layer.provide(NodeSystem)),
              ),
            ),
          ),
        );
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );
}

it.effect("flat batches and undo touch only selected messages in a conversation", () => {
  const server = fakeServer("me@gmail.com", [
    message("a", ["INBOX", "UNREAD"], "shared"),
    message("b", ["INBOX"], "shared"),
  ]);
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    yield* mailbox.connect({ provider: "gmail" });
    yield* mailbox.sync();
    const rows = yield* mailbox.threads({ flat: true });
    assert.strictEqual(yield* mailbox.threadCount({}), 1);
    assert.strictEqual(yield* mailbox.threadCount({ flat: true }), 2);
    const a = rows.find((row) => row.subject === "a");
    assert.ok(a);
    const batch = yield* mailbox.modifyWithUndo([a.id], { kind: "trash" }, true);
    yield* mailbox.sync();
    assert.deepStrictEqual(
      server.pushed.map((push) => push.providerId),
      ["a"],
    );
    yield* mailbox.undoBatch(batch.undoId);
    yield* mailbox.sync();
    assert.ok(!server.pushed.some((push) => push.providerId === "b"));
    assert.deepStrictEqual(server.messages.get("a")?.labels.toSorted(), ["INBOX", "UNREAD"]);
    assert.ok(server.pushed.some((push) => push.op.kind === "inbox"));
    assert.ok(
      !server.pushed.some((push) => push.op.kind === "label" && push.op.labelId === "TRASH"),
    );
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

for (const provider of ["outlook", "imap"] as const) {
  it.effect(
    `${provider}: undo restores system folders using kind ops and rejects unknown folder IDs`,
    () => {
      const folders = ["INBOX", "ARCHIVE", "TRASH", "SPAM", "custom/path"];
      const server = fakeServer(
        "me@example.com",
        folders.map((folder, index) => message(`m${index}`, [folder, "UNREAD"])),
      );
      server.labels = [{ id: "custom/path", name: "Custom", color: null }];
      return Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        yield* mailbox.connect(
          provider === "imap"
            ? {
                provider,
                input: {
                  preset: "custom",
                  email: server.email,
                  password: "test",
                  imapHost: "imap.example.com",
                  smtpHost: "smtp.example.com",
                },
              }
            : { provider },
        );
        yield* mailbox.sync();
        const account = (yield* mailbox.accounts)[0];
        assert.ok(account);
        const ids = folders.map((_, index) => `${account.id}/m${index}`);
        const original = fields((yield* Effect.forEach(ids, (id) => mailbox.thread(id))).flat());
        const batch = yield* mailbox.modifyWithUndo(ids, { kind: "trash" });
        yield* mailbox.sync();
        yield* mailbox.undoBatch(batch.undoId);
        yield* mailbox.sync();
        assert.deepStrictEqual(
          fields((yield* Effect.forEach(ids, (id) => mailbox.thread(id))).flat()),
          original,
        );
        for (const [index, folder] of folders.entries())
          assert.ok(server.messages.get(`m${index}`)?.labels.includes(folder));
        assert.deepStrictEqual(
          server.pushed.slice(5).map((push) => push.op.kind),
          ["inbox", "archive", "trash", "spam", "label"],
        );
      }).pipe(
        Effect.provide(
          TestMailbox({ [provider]: server }, { backgroundFlush: false }, { strictFolders: true }),
        ),
      );
    },
  );
}

it.effect("a stalled push does not block local commit, undo or mark-read", () => {
  const server = fakeServer("me@gmail.com", [message("a"), message("b")]);
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    yield* mailbox.connect({ provider: "gmail" });
    yield* mailbox.sync();
    const rows = yield* mailbox.threads({});
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    server.beforePush = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    );
    const first = yield* Effect.forkChild(
      mailbox.modifyWithUndo(
        rows.map((row) => row.id),
        { kind: "archive" },
      ),
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("1 second");
    assert.ok(first.pollUnsafe());
    const batch = yield* Fiber.join(first);
    yield* mailbox.undoBatch(batch.undoId);
    const read = yield* mailbox.modifyWithUndo([rows[0]!.id], { kind: "read", value: true });
    assert.ok(read.undoId);
    assert.strictEqual((yield* mailbox.threads({})).length, 2);
    assert.strictEqual((yield* mailbox.thread(rows[0]!.id))[0]?.isUnread, false);
    yield* Deferred.succeed(release, undefined);
    yield* mailbox.sync();
    assert.strictEqual(server.pushed.length, 5);
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

it.effect("sync-deleted batch IDs are skipped both at commit and at undo", () => {
  const server = fakeServer("me@gmail.com", [message("a"), message("b")]);
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    yield* mailbox.connect({ provider: "gmail" });
    yield* mailbox.sync();
    const rows = yield* mailbox.threads({});
    const a = rows.find((row) => row.subject === "a");
    const b = rows.find((row) => row.subject === "b");
    assert.ok(a && b);
    server.messages.delete("b");
    yield* mailbox.sync();
    const batch = yield* mailbox.modifyWithUndo([a.id, b.id], { kind: "star", value: true });
    assert.strictEqual((yield* mailbox.thread(a.id))[0]?.isStarred, true);
    yield* mailbox.undoBatch(batch.undoId);
    yield* mailbox.sync();
    const second = yield* mailbox.modifyWithUndo([a.id], { kind: "archive" });
    yield* mailbox.sync();
    server.messages.delete("a");
    yield* mailbox.sync();
    yield* mailbox.undoBatch(second.undoId);
    const vanished = yield* mailbox.modifyWithUndo([a.id, b.id], { kind: "star", value: true });
    yield* mailbox.undoBatch(vanished.undoId);
    assert.strictEqual((yield* mailbox.threads({})).length, 0);
    assert.ok(!server.pushed.some((push) => push.providerId === "b"));
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

it.effect("loaded counts respect grouping, filters and ignored paging cursors", () => {
  const server = fakeServer(
    "me@gmail.com",
    Array.from({ length: 205 }, (_, index) =>
      message(`m${index}`, index < 5 ? ["INBOX", "UNREAD"] : ["INBOX"]),
    ),
  );
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    yield* mailbox.connect({ provider: "gmail" });
    yield* mailbox.sync();
    const rows = yield* mailbox.threads({ mailbox: "inbox", limit: 100 });
    assert.strictEqual(rows.length, 100);
    assert.strictEqual(
      (yield* mailbox.threadCount({ mailbox: "inbox", before: rows.at(-1)?.date, limit: 100 })) -
        rows.length,
      105,
    );
    assert.strictEqual(yield* mailbox.threadCount({ mailbox: "inbox", unreadOnly: true }), 5);
    const five = yield* mailbox.threads({ mailbox: "inbox", unreadOnly: true });
    yield* mailbox.modifyWithUndo(
      five.map((row) => row.id),
      { kind: "archive" },
    );
    assert.strictEqual(yield* mailbox.threadCount({ mailbox: "inbox" }), 200);
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

it.effect("cross-account undo works while authentication leaves the forward batch queued", () => {
  const gmail = fakeServer("me@gmail.com", [message("a")]);
  const outlook = fakeServer("me@outlook.com", [message("b", ["custom", "STARRED"])]);
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    yield* mailbox.connect({ provider: "gmail" });
    yield* mailbox.connect({ provider: "outlook" });
    yield* mailbox.sync();
    const rows = yield* mailbox.threads({ mailbox: "all" });
    assert.strictEqual(rows.length, 2);
    const before = fields((yield* Effect.forEach(rows, (row) => mailbox.thread(row.id))).flat());
    const account = (yield* mailbox.accounts).find((account) => account.provider === "gmail");
    assert.ok(account);
    gmail.failNext = new AuthError({ accountId: account.id, message: "revoked" });
    const batch = yield* mailbox.modifyWithUndo(
      rows.map((row) => row.id),
      { kind: "trash" },
    );
    yield* mailbox.sync();
    assert.strictEqual(
      (yield* mailbox.accounts).find((item) => item.id === account.id)?.needsReauth,
      true,
    );
    yield* mailbox.undoBatch(batch.undoId);
    yield* mailbox.sync();
    assert.deepStrictEqual(
      fields((yield* Effect.forEach(rows, (row) => mailbox.thread(row.id))).flat()),
      before,
    );
    yield* mailbox.reauth(account.id);
    yield* mailbox.sync();
    assert.deepStrictEqual(
      fields((yield* Effect.forEach(rows, (row) => mailbox.thread(row.id))).flat()),
      before,
    );
  }).pipe(Effect.provide(TestMailbox({ gmail, outlook })));
});

it.effect("undo restores a batch's snoozed membership and original due time", () => {
  const server = fakeServer("me@gmail.com", [message("a"), message("b")]);
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    yield* mailbox.connect({ provider: "gmail" });
    yield* mailbox.sync();
    const rows = yield* mailbox.threads({});
    const ids = rows.map((row) => row.id);
    const due = (yield* Clock.currentTimeMillis) + 3600000;
    yield* mailbox.snooze(ids, due);
    const before = fields((yield* Effect.forEach(ids, (id) => mailbox.thread(id))).flat());
    const batch = yield* mailbox.modifyWithUndo(ids, { kind: "trash" });
    assert.strictEqual((yield* mailbox.threads({ mailbox: "snoozed" })).length, 0);
    yield* mailbox.undoBatch(batch.undoId);
    yield* mailbox.sync();
    assert.strictEqual((yield* mailbox.threads({ mailbox: "snoozed" })).length, 2);
    assert.deepStrictEqual(
      fields((yield* Effect.forEach(ids, (id) => mailbox.thread(id))).flat()),
      before,
    );
    yield* mailbox.sync();
    assert.strictEqual((yield* mailbox.threads({ mailbox: "snoozed" })).length, 2);
    assert.ok(
      !server.pushed.some((push) => push.op.kind === "label" && push.op.labelId === "SNOOZED"),
    );
    yield* TestClock.adjust("59 minutes");
    yield* mailbox.sync();
    assert.strictEqual((yield* mailbox.threads({ mailbox: "snoozed" })).length, 2);
    yield* TestClock.adjust("1 minute");
    yield* mailbox.sync();
    assert.strictEqual((yield* mailbox.threads({ mailbox: "snoozed" })).length, 0);
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

it.effect("undo uses captured message IDs and preserves unrelated later flag changes", () => {
  const server = fakeServer("me@gmail.com", [message("a", ["INBOX", "UNREAD"], "shared")]);
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    yield* mailbox.connect({ provider: "gmail" });
    yield* mailbox.sync();
    const row = (yield* mailbox.threads({}))[0];
    assert.ok(row);
    const batch = yield* mailbox.modifyWithUndo([row.id], { kind: "read", value: true });
    yield* mailbox.perform(
      { kind: "modify", threads: [row.id], op: { kind: "star", value: true } },
      { kind: "user", surface: "app" },
    );
    server.messages.set("new", message("new", ["INBOX"], "shared"));
    yield* mailbox.sync();
    yield* mailbox.undoBatch(batch.undoId);
    yield* mailbox.sync();
    const messages = yield* mailbox.thread(row.id);
    assert.strictEqual(messages.find((message) => message.id.endsWith("/a"))?.isUnread, true);
    assert.strictEqual(messages.find((message) => message.id.endsWith("/a"))?.isStarred, true);
    assert.strictEqual(messages.find((message) => message.id.endsWith("/new"))?.isUnread, false);
    assert.ok(!server.pushed.some((push) => push.providerId === "new"));
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

it.effect("Gmail queue batches identical operations in at most 1000 message IDs", () => {
  const server = fakeServer(
    "me@gmail.com",
    Array.from({ length: 1002 }, (_, index) => message(`m${index}`)),
  );
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    yield* mailbox.connect({ provider: "gmail" });
    yield* mailbox.sync();
    const rows = yield* mailbox.threads({ limit: 1100 });
    yield* mailbox.modifyWithUndo(
      rows.map((row) => row.id),
      { kind: "read", value: true },
    );
    yield* mailbox.sync();
    assert.deepStrictEqual(
      server.batches.map((batch) => batch.providerIds.length),
      [1000, 2],
    );
    assert.ok([...server.messages.values()].every((item) => !item.isUnread));
  }).pipe(
    Effect.provide(TestMailbox({ gmail: server }, { backgroundFlush: false }, { batches: true })),
  );
});
