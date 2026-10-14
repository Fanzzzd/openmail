import { incoming as makeIncoming, TestMailbox } from "../platform/node/testing.js";
import { assert, it } from "@effect/vitest";
import { Clock, Effect, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage } from "../domain/message.js";
import type { Provider } from "../domain/account.js";
import { ProviderError } from "../domain/errors.js";
import { fakeServer, makeFakeProvider } from "../platform/node/fake-provider.js";
import { Mailbox } from "./mailbox.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";
import { makeBatchMailbox } from "./mailbox-batch.js";
{
  const incoming = (id: string, labels = ["INBOX", "UNREAD"]): IncomingMessage => ({
    providerId: id,
    threadId: id,
    from: { name: "A", address: "a@example.com" },
    to: [],
    cc: [],
    date: 1,
    subject: "PRIVATE_SUBJECT",
    snippet: "PRIVATE_SNIPPET",
    bodyText: "PRIVATE_BODY",
    bodyHtml: "<p>PRIVATE_HTML</p>",
    labels,
    isUnread: labels.includes("UNREAD"),
    isStarred: labels.includes("STARRED"),
    attachments: [],
  });

  const temporary = Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "om-fixture-"))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );

  const connect = (m: Mailbox["Service"], provider: Provider) =>
    m.accounts.connect(
      provider === "imap"
        ? {
            provider,
            input: {
              preset: "custom",
              email: "me@example.com",
              password: "PRIVATE_PASSWORD",
              imapHost: "imap.example.com",
              imapPort: 993,
              smtpHost: "smtp.example.com",
              smtpPort: 465,
              smtpSecure: true,
            },
          }
        : { provider },
    );

  const sessions =
    (file: string, server: ReturnType<typeof fakeServer>, strictFolders = false) =>
    () =>
      TestMailbox.withAdapter(makeFakeProvider(server, { strictFolders }), {
        options: { backgroundFlush: false },
        platformOptions: { database: file },
      });

  for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
    it.effect(
      `${provider}: last 50 undo batches reopen, verify the server, and contain no message content`,
      () =>
        Effect.gen(function* () {
          const directory = yield* temporary;
          const file = join(directory, "mail.db");
          const server = fakeServer("me@example.com", [incoming("one"), incoming("untouched")]);
          const session = sessions(file, server);
          const id = `${provider}:me@example.com/one`;
          const handles = yield* Effect.gen(function* () {
            const m = yield* Mailbox;
            yield* connect(m, provider);
            yield* m.sync();
            const handles: string[] = [];
            for (let index = 0; index < 55; index++) {
              handles.push(
                (yield* m.organize.modifyWithUndo(
                  [id],
                  { kind: "star", value: index % 2 === 0 },
                  true,
                )).undoId,
              );
              yield* m.sync();
            }
            return handles;
          }).pipe(Effect.provide(session()));
          const db = new DatabaseSync(file);
          try {
            const rows = db.prepare("SELECT payload FROM undo_batches").all();
            assert.strictEqual(rows.length, 50);
            for (const row of rows)
              assert.ok(
                !/PRIVATE_|refresh|token|body|subject|snippet|password/i.test(String(row.payload)),
              );
          } finally {
            db.close();
          }
          yield* Effect.gen(function* () {
            const m = yield* Mailbox;
            const history = yield* m.organize.undoHistory;
            assert.strictEqual(history.length, 50);
            assert.strictEqual(history[0]?.undoId, handles.at(-1));
            assert.ok(!history.some((entry) => entry.undoId === handles[0]));
            const latest = history[0];
            assert.ok(latest);
            const pushed = server.pushed.length;
            server.failNext = new ProviderError({ message: "offline verification" });
            assert.strictEqual(
              (yield* Effect.flip(m.organize.undoBatch(latest.undoId)))._tag,
              "ProviderError",
            );
            assert.strictEqual(server.pushed.length, pushed);
            assert.strictEqual((yield* m.organize.undoHistory).length, 50);
            yield* m.organize.undoBatch(latest.undoId);
            yield* m.sync();
            assert.strictEqual(server.messages.get("one")?.isStarred, false);
            assert.deepStrictEqual(server.messages.get("untouched")?.labels, ["INBOX", "UNREAD"]);
            assert.strictEqual((yield* m.organize.undoHistory).length, 49);
            assert.strictEqual(
              (yield* Effect.flip(m.organize.undoBatch(latest.undoId)))._tag,
              "InvalidInput",
            );
            const previous = (yield* m.organize.undoHistory)[0];
            assert.ok(previous);
            const live = server.messages.get("one");
            assert.ok(live);
            server.messages.set("one", {
              ...live,
              isUnread: false,
              labels: live.labels.filter((label) => label !== "UNREAD"),
            });
            const before = server.pushed.length;
            assert.strictEqual(
              (yield* Effect.flip(m.organize.undoBatch(previous.undoId)))._tag,
              "InvalidInput",
            );
            assert.strictEqual(server.pushed.length, before);
          }).pipe(Effect.provide(session()));
        }).pipe(Effect.scoped),
    );
  }

  it.effect(
    "Outlook multi-category batches preserve folders and unrelated categories, including restart undo",
    () =>
      Effect.gen(function* () {
        const directory = yield* temporary;
        const server = fakeServer("me@example.com", [
          incoming("one", ["INBOX", "UNREAD", "category:Old"]),
          incoming("two", ["Work", "category:Keep"]),
        ]);
        const session = sessions(join(directory, "mail.db"), server);
        const undoId = yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          yield* connect(m, "outlook");
          yield* m.sync();
          const result = yield* m.organize.modifyWithUndo(
            ["outlook:me@example.com/one", "outlook:me@example.com/two"],
            { kind: "categories", add: ["A", "B"], remove: ["Old"] },
            true,
          );
          yield* m.sync();
          assert.deepStrictEqual(server.messages.get("one")?.labels, [
            "INBOX",
            "UNREAD",
            "category:A",
            "category:B",
          ]);
          assert.deepStrictEqual(server.messages.get("two")?.labels, [
            "Work",
            "category:Keep",
            "category:A",
            "category:B",
          ]);
          assert.ok((yield* m.reading.labels()).some((label) => label.id === "category:A"));
          return result.undoId;
        }).pipe(Effect.provide(session()));
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          yield* m.organize.undoBatch(undoId);
          yield* m.sync();
          assert.deepStrictEqual(
            [...(server.messages.get("one")?.labels ?? [])].toSorted(),
            ["INBOX", "UNREAD", "category:Old"].toSorted(),
          );
          assert.deepStrictEqual(server.messages.get("two")?.labels, ["Work", "category:Keep"]);
        }).pipe(Effect.provide(session()));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "IMAP multi-folder assignment copies each message, keeps originals, and rejects foreign destinations",
    () =>
      Effect.gen(function* () {
        const directory = yield* temporary;
        const server = fakeServer("me@example.com", [incoming("one")]);
        server.labels = [
          { id: "A", name: "A", color: null },
          { id: "B", name: "B", color: null },
        ];
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          yield* connect(m, "imap");
          yield* m.sync();
          const id = "imap:me@example.com/one";
          const result = yield* m.organize.modifyWithUndo(
            [id],
            { kind: "copy", labelIds: ["A", "B", "A"] },
            true,
          );
          assert.strictEqual(result.undoId, "");
          yield* m.sync();
          assert.strictEqual(server.messages.size, 3);
          assert.deepStrictEqual(server.messages.get("one")?.labels, ["INBOX", "UNREAD"]);
          assert.deepStrictEqual(
            [...server.messages.values()]
              .filter((message) => message.providerId !== "one")
              .map((message) => message.labels),
            [
              ["A", "UNREAD"],
              ["B", "UNREAD"],
            ],
          );
          const count = server.pushed.length;
          assert.strictEqual(
            (yield* Effect.flip(
              m.organize.modifyWithUndo([id], { kind: "copy", labelIds: ["Foreign"] }, true),
            ))._tag,
            "InvalidInput",
          );
          assert.strictEqual(server.pushed.length, count);
        }).pipe(Effect.provide(sessions(join(directory, "mail.db"), server)()));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "restart snooze undo restores only local folder state after checking server state",
    () =>
      Effect.gen(function* () {
        const directory = yield* temporary;
        const server = fakeServer("me@example.com", [incoming("one")]);
        const session = sessions(join(directory, "mail.db"), server);
        const undoId = yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          yield* connect(m, "gmail");
          yield* m.sync();
          const now = yield* Clock.currentTimeMillis;
          const batch = yield* m.organize.snoozeWithUndo(
            ["gmail:me@example.com/one"],
            now + 60_000,
          );
          assert.strictEqual((yield* m.reading.threads({ mailbox: "snoozed" })).length, 1);
          return batch.undoId;
        }).pipe(Effect.provide(session()));
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          yield* m.organize.undoBatch(undoId);
          assert.strictEqual((yield* m.reading.threads({ mailbox: "snoozed" })).length, 0);
          assert.strictEqual((yield* m.reading.threads({ mailbox: "inbox" })).length, 1);
          assert.strictEqual(server.pushed.length, 0);
        }).pipe(Effect.provide(session()));
      }).pipe(Effect.scoped),
  );

  it.effect("removing and reconnecting an account clears its persisted undo batches", () =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      const server = fakeServer("me@example.com", [incoming("one")]);
      yield* Effect.gen(function* () {
        const m = yield* Mailbox,
          store = yield* Store;
        yield* connect(m, "gmail");
        yield* m.sync();
        yield* m.organize.modifyWithUndo(
          ["gmail:me@example.com/one"],
          { kind: "star", value: true },
          true,
        );
        yield* m.sync();
        assert.strictEqual((yield* m.organize.undoHistory).length, 1);
        yield* store.removeAccount("gmail:me@example.com");
        yield* connect(m, "gmail");
        assert.deepStrictEqual(yield* m.organize.undoHistory, []);
      }).pipe(Effect.provide(sessions(join(directory, "mail.db"), server)()));
    }).pipe(Effect.scoped),
  );

  for (const kind of ["local", "pending"] as const)
    it.effect(`restart undo rejects ${kind} divergence before consuming the batch`, () =>
      Effect.gen(function* () {
        const directory = yield* temporary;
        const server = fakeServer("me@example.com", [incoming("one")]);
        const session = sessions(join(directory, "mail.db"), server);
        const id = "gmail:me@example.com/one";
        const undoId = yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          yield* connect(m, "gmail");
          yield* m.sync();
          const batch = yield* m.organize.modifyWithUndo([id], { kind: "star", value: true }, true);
          yield* m.sync();
          return batch.undoId;
        }).pipe(Effect.provide(session()));
        yield* Effect.gen(function* () {
          const m = yield* Mailbox,
            store = yield* Store;
          yield* kind === "local"
            ? store.applyLocalOp(id, { kind: "read", value: true })
            : store.enqueueOp("gmail:me@example.com", "one", { kind: "read", value: true });
          const result = yield* Effect.result(m.organize.undoBatch(undoId));
          assert.strictEqual(result._tag, "Failure");
          assert.strictEqual((yield* m.organize.undoHistory)[0]?.undoId, undoId);
        }).pipe(Effect.provide(session()));
      }).pipe(Effect.scoped),
    );

  it.effect("Outlook category ids are rejected by folder moves and folder maintenance", () =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      const server = fakeServer("me@example.com", [incoming("one", ["INBOX", "category:Work"])]);
      yield* Effect.gen(function* () {
        const m = yield* Mailbox;
        yield* connect(m, "outlook");
        yield* m.sync();
        for (const op of [
          { kind: "move", labelId: "category:Work", removeLabelId: "INBOX" },
          { kind: "label", labelId: "category:Work", value: true },
        ] as const) {
          assert.strictEqual(
            (yield* Effect.result(
              m.organize.modifyWithUndo(["outlook:me@example.com/one"], op, true),
            ))._tag,
            "Failure",
          );
        }
        for (const change of [
          { kind: "rename", id: "category:Work", name: "Other" },
          { kind: "delete", id: "category:Work" },
          { kind: "parent", id: "category:Work", parentId: null },
        ] as const)
          assert.strictEqual(
            (yield* Effect.result(m.organize.changeLabel("outlook:me@example.com", change)))._tag,
            "Failure",
          );
        assert.strictEqual(server.pushed.length, 0);
      }).pipe(Effect.provide(sessions(join(directory, "mail.db"), server)()));
    }).pipe(Effect.scoped),
  );

  it.effect("restored batches expire after 24 hours", () =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      const file = join(directory, "mail.db");
      const server = fakeServer("me@example.com", [incoming("one")]);
      const session = sessions(file, server);
      const undoId = yield* Effect.gen(function* () {
        const m = yield* Mailbox;
        yield* connect(m, "gmail");
        yield* m.sync();
        const batch = yield* m.organize.modifyWithUndo(
          ["gmail:me@example.com/one"],
          { kind: "star", value: true },
          true,
        );
        yield* m.sync();
        return batch.undoId;
      }).pipe(Effect.provide(session()));
      const db = new DatabaseSync(file);
      try {
        db.exec("UPDATE undo_batches SET created_at=created_at-86400001");
      } finally {
        db.close();
      }
      yield* Effect.gen(function* () {
        const m = yield* Mailbox;
        assert.deepStrictEqual(yield* m.organize.undoHistory, []);
        const result = yield* Effect.flip(m.organize.undoBatch(undoId));
        assert.strictEqual(result._tag, "InvalidInput");
        assert.strictEqual(server.messages.get("one")?.isStarred, true);
      }).pipe(Effect.provide(session()));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an inverse queue failure rolls back its local change and journal deletion together",
    () =>
      Effect.gen(function* () {
        const directory = yield* temporary;
        const file = join(directory, "mail.db");
        const server = fakeServer("me@example.com", [incoming("one")]);
        const session = sessions(file, server);
        const undoId = yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          yield* connect(m, "gmail");
          yield* m.sync();
          const batch = yield* m.organize.modifyWithUndo(
            ["gmail:me@example.com/one"],
            { kind: "star", value: true },
            true,
          );
          yield* m.sync();
          return batch.undoId;
        }).pipe(Effect.provide(session()));
        const db = new DatabaseSync(file);
        try {
          db.exec(
            "CREATE TRIGGER reject_undo_delete BEFORE DELETE ON undo_batches BEGIN SELECT RAISE(ABORT,'fixture'); END;",
          );
        } finally {
          db.close();
        }
        yield* Effect.gen(function* () {
          const m = yield* Mailbox,
            store = yield* Store;
          assert.strictEqual((yield* Effect.exit(m.organize.undoBatch(undoId)))._tag, "Failure");
          assert.deepStrictEqual(yield* store.listPendingOps, []);
          assert.strictEqual((yield* store.getMessage("gmail:me@example.com/one")).isStarred, true);
          assert.strictEqual((yield* m.organize.undoHistory)[0]?.undoId, undoId);
        }).pipe(Effect.provide(session()));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "restart undo checks the original folder on the server even when its cached label still exists",
    () =>
      Effect.gen(function* () {
        const directory = yield* temporary;
        const server = fakeServer("me@example.com", [incoming("one", ["Original"])]);
        server.labels = [{ id: "Original", name: "Original", color: null }];
        const session = sessions(join(directory, "mail.db"), server, true);
        const undoId = yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          yield* connect(m, "outlook");
          yield* m.sync();
          const batch = yield* m.organize.modifyWithUndo(
            ["outlook:me@example.com/one"],
            { kind: "inbox" },
            true,
          );
          yield* m.sync();
          return batch.undoId;
        }).pipe(Effect.provide(session()));
        server.labels = [];
        yield* Effect.gen(function* () {
          const m = yield* Mailbox;
          assert.strictEqual((yield* Effect.result(m.organize.undoBatch(undoId)))._tag, "Failure");
          assert.strictEqual((yield* m.organize.undoHistory)[0]?.undoId, undoId);
          assert.deepStrictEqual(server.messages.get("one")?.labels, ["INBOX"]);
        }).pipe(Effect.provide(session()));
      }).pipe(Effect.scoped),
  );

  it.effect("restart IMAP folder undo explicitly reports the changed UID limitation", () =>
    Effect.gen(function* () {
      const directory = yield* temporary;
      const server = fakeServer("me@example.com", [incoming("one")]);
      const session = sessions(join(directory, "mail.db"), server);
      const undoId = yield* Effect.gen(function* () {
        const m = yield* Mailbox;
        yield* connect(m, "imap");
        yield* m.sync();
        const batch = yield* m.organize.modifyWithUndo(
          ["imap:me@example.com/one"],
          { kind: "archive" },
          true,
        );
        yield* m.sync();
        return batch.undoId;
      }).pipe(Effect.provide(session()));
      yield* Effect.gen(function* () {
        const m = yield* Mailbox;
        const failure = yield* Effect.flip(m.organize.undoBatch(undoId));
        assert.strictEqual(failure._tag, "InvalidInput");
        if (failure._tag !== "InvalidInput") throw new Error("Expected InvalidInput");
        assert.ok(failure.message.includes("UID"));
      }).pipe(Effect.provide(session()));
    }).pipe(Effect.scoped),
  );
}

{
  const message: IncomingMessage = makeIncoming("one", {
    threadId: "one",
    subject: "Train",
    from: { name: "", address: "tickets@example.com" },
    to: [],
    date: 1,
    bodyText: "Departure 2026-10-10 09:00 to 10:30",
    labels: ["INBOX"],
  });

  it.effect(
    "snooze undo restores Inbox locally and preserves a previous reminder without provider changes",
    () => {
      const server = fakeServer("me@gmail.com", [message]);
      return Effect.gen(function* () {
        const m = yield* Mailbox;
        const account = yield* m.accounts.connect({ provider: "gmail" });
        yield* m.sync();
        const id = `${account.id}/one`;
        const batch = yield* m.organize.snoozeWithUndo([id], 2000000000000);
        assert.ok((yield* m.reading.thread(id))[0]?.labels.includes("SNOOZED"));
        yield* m.organize.undoBatch(batch.undoId);
        assert.ok((yield* m.reading.thread(id))[0]?.labels.includes("INBOX"));
        assert.strictEqual((yield* m.reading.threads({ mailbox: "snoozed" })).length, 0);
        yield* m.organize.snooze([id], 2000000000000);
        const change = yield* m.organize.snoozeWithUndo([id], 2100000000000);
        yield* m.organize.undoBatch(change.undoId);
        assert.strictEqual((yield* m.reading.threads({ mailbox: "snoozed" })).length, 1);
        assert.strictEqual(server.pushed.length, 0);
      }).pipe(Effect.provide(TestMailbox({ gmail: server })));
    },
  );

  it.effect("snooze undo restores the exact prior due date in the real SQLite store", () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@gmail.com");
      yield* store.upsertMessage(account.id, message);
      const id = `${account.id}/one`;
      const batch = yield* makeBatchMailbox(store, Effect.void, Effect.void);
      yield* store.snooze(id, 2000000000000);
      const changed = yield* batch.snoozeWithUndo([id], 2100000000000);
      yield* batch.undoBatch(changed.undoId);
      const restored = yield* store.reminderSnapshot(id);
      assert.strictEqual(restored._tag === "Some" && restored.value.dueAt, 2000000000000);
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provide(MemoryPlatform())))),
  );
}
