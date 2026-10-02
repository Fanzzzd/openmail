import { assert, it } from "@effect/vitest";
import { Clock, Effect, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databaseLayer } from "./platform/node/db.js";
import { DEFAULT_PREFS, type IncomingMessage, type Provider } from "./domain.js";
import { ProviderError } from "./errors.js";
import { fakeServer, makeFakeProvider } from "./platform/node/fake-provider.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { NodeSystem } from "./platform/node/platform-node.js";
import { Store, Providers } from "./services.js";
import { StoreLive } from "./store.js";
import { applyComposeSignature, orderedSignatures } from "./signatures.js";
import { applySignature } from "./compose-text.js";
import { remoteComposeBody, richComposeBody } from "./compose-body.js";

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
  Effect.sync(() => mkdtempSync(join(tmpdir(), "om-slice29-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);
const connect = (m: Mailbox["Service"], provider: Provider) =>
  m.connect(
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
    MailboxLive({ backgroundFlush: false }).pipe(
      Layer.provideMerge(
        Layer.merge(
          StoreLive.pipe(Layer.provide(databaseLayer(file).pipe(Layer.provide(NodeSystem)))),
          Layer.succeed(Providers, { get: () => makeFakeProvider(server, { strictFolders }) }),
        ),
      ),
      Layer.provide(MemoryPlatform()),
    );

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
              (yield* m.modifyWithUndo([id], { kind: "star", value: index % 2 === 0 }, true))
                .undoId,
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
          const history = yield* m.undoHistory;
          assert.strictEqual(history.length, 50);
          assert.strictEqual(history[0]?.undoId, handles.at(-1));
          assert.ok(!history.some((entry) => entry.undoId === handles[0]));
          const latest = history[0];
          assert.ok(latest);
          const pushed = server.pushed.length;
          server.failNext = new ProviderError({ message: "offline verification" });
          assert.strictEqual(
            (yield* Effect.flip(m.undoBatch(latest.undoId)))._tag,
            "ProviderError",
          );
          assert.strictEqual(server.pushed.length, pushed);
          assert.strictEqual((yield* m.undoHistory).length, 50);
          yield* m.undoBatch(latest.undoId);
          yield* m.sync();
          assert.strictEqual(server.messages.get("one")?.isStarred, false);
          assert.deepStrictEqual(server.messages.get("untouched")?.labels, ["INBOX", "UNREAD"]);
          assert.strictEqual((yield* m.undoHistory).length, 49);
          assert.strictEqual((yield* Effect.flip(m.undoBatch(latest.undoId)))._tag, "InvalidInput");
          const previous = (yield* m.undoHistory)[0];
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
            (yield* Effect.flip(m.undoBatch(previous.undoId)))._tag,
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
        const result = yield* m.modifyWithUndo(
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
        assert.ok((yield* m.labels()).some((label) => label.id === "category:A"));
        return result.undoId;
      }).pipe(Effect.provide(session()));
      yield* Effect.gen(function* () {
        const m = yield* Mailbox;
        yield* m.undoBatch(undoId);
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
        const result = yield* m.modifyWithUndo(
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
            m.modifyWithUndo([id], { kind: "copy", labelIds: ["Foreign"] }, true),
          ))._tag,
          "InvalidInput",
        );
        assert.strictEqual(server.pushed.length, count);
      }).pipe(Effect.provide(sessions(join(directory, "mail.db"), server)()));
    }).pipe(Effect.scoped),
);

it.effect("signature formatting, order and preferences persist in a temporary database", () =>
  Effect.gen(function* () {
    const directory = yield* temporary;
    const session = sessions(join(directory, "mail.db"), fakeServer("me@example.com"));
    const ids = yield* Effect.gen(function* () {
      const m = yield* Mailbox;
      const a = yield* m.saveNamedSignature({
        address: "me@example.com",
        name: "A",
        text: "Ignored",
        html: '<b>A</b><span style="color:#ff0000">Red</span><script>PRIVATE_SCRIPT</script><img src="https://tracker.invalid"><a href="javascript:bad()">link</a>',
      });
      const b = yield* m.saveNamedSignature({ address: "me@example.com", name: "B", text: "B" });
      assert.ok(a.html?.includes("<strong>A</strong>"));
      assert.ok(!/PRIVATE_SCRIPT|tracker|javascript/.test(a.html ?? ""));
      yield* m.setPrefs({
        signatureOrder: [b.id, a.id],
        signaturePosition: "below",
        signatureSeparator: false,
      });
      return [b.id, a.id];
    }).pipe(Effect.provide(session()));
    yield* Effect.gen(function* () {
      const m = yield* Mailbox;
      const prefs = yield* m.prefs;
      assert.strictEqual(prefs.signaturePosition, "below");
      assert.strictEqual(prefs.signatureSeparator, false);
      assert.deepStrictEqual(
        orderedSignatures(yield* m.namedSignatures, prefs.signatureOrder).map(
          (signature) => signature.id,
        ),
        ids,
      );
    }).pipe(Effect.provide(session()));
  }).pipe(Effect.scoped),
);

it("signatures respect quote position and separator in plain, Markdown and sanitized rich bodies", () => {
  const signature = { text: "Me", html: "<strong>Me</strong>" };
  const text = "Answer\n\nOn Monday wrote:\n> Quoted";
  for (const signaturePosition of ["above", "below"] as const)
    for (const signatureSeparator of [true, false]) {
      const options = { signaturePosition, signatureSeparator };
      const plain = applySignature(text, undefined, "Me", options);
      assert.strictEqual(plain.includes("-- \n"), signatureSeparator);
      assert.strictEqual(
        plain.indexOf("Me") < plain.indexOf("On Monday"),
        signaturePosition === "above",
      );
      assert.strictEqual(applySignature(plain, "Me", "You", options).split("You").length, 2);
      const markdown = applyComposeSignature(
        { kind: "markdown", text },
        undefined,
        signature,
        options,
      );
      assert.strictEqual(markdown.text, plain);
      const rich = applyComposeSignature(
        richComposeBody("<p>Answer</p><blockquote>Quoted</blockquote>"),
        undefined,
        signature,
        options,
      );
      assert.ok(rich.kind === "rich");
      assert.strictEqual(
        rich.html.indexOf("<strong>Me</strong>") < rich.html.indexOf("<blockquote>"),
        signaturePosition === "above",
      );
      assert.strictEqual(rich.text.split("\n").includes("--"), signatureSeparator);
      const replaced = applyComposeSignature(
        rich,
        signature,
        { text: "You", html: "<em>You</em>" },
        options,
      );
      assert.ok(replaced.kind === "rich");
      assert.ok(replaced.html.includes("<em>You</em>"));
      assert.ok(!replaced.html.includes("<strong>Me</strong>"));
    }
  const remote = remoteComposeBody(
    '<blockquote>Quoted<img src="https://remote.invalid"></blockquote>',
  );
  const below = { ...DEFAULT_PREFS, signaturePosition: "below" } as const;
  const signed = applyComposeSignature(remote, undefined, signature, below);
  const replaced = applyComposeSignature(
    signed,
    signature,
    { text: "You", html: "<em>You</em>" },
    below,
  );
  assert.ok(replaced.kind === "rich");
  assert.ok(replaced.originalHtml?.includes("https://remote.invalid"));
  assert.ok(replaced.originalHtml?.endsWith("<div>--<br><em>You</em></div>"));
});

it.effect("restart snooze undo restores only local folder state after checking server state", () =>
  Effect.gen(function* () {
    const directory = yield* temporary;
    const server = fakeServer("me@example.com", [incoming("one")]);
    const session = sessions(join(directory, "mail.db"), server);
    const undoId = yield* Effect.gen(function* () {
      const m = yield* Mailbox;
      yield* connect(m, "gmail");
      yield* m.sync();
      const now = yield* Clock.currentTimeMillis;
      const batch = yield* m.snoozeWithUndo(["gmail:me@example.com/one"], now + 60_000);
      assert.strictEqual((yield* m.threads({ mailbox: "snoozed" })).length, 1);
      return batch.undoId;
    }).pipe(Effect.provide(session()));
    yield* Effect.gen(function* () {
      const m = yield* Mailbox;
      yield* m.undoBatch(undoId);
      assert.strictEqual((yield* m.threads({ mailbox: "snoozed" })).length, 0);
      assert.strictEqual((yield* m.threads({ mailbox: "inbox" })).length, 1);
      assert.strictEqual(server.pushed.length, 0);
    }).pipe(Effect.provide(session()));
  }).pipe(Effect.scoped),
);
it("changing the quote preference moves an unchanged signature to the new position", () => {
  const signature = { text: "Me", html: "<strong>Me</strong>" };
  const above = applyComposeSignature(
    richComposeBody("<div>Answer</div><blockquote>Quote</blockquote>"),
    undefined,
    signature,
  );
  const below = applyComposeSignature(above, signature, signature, {
    signaturePosition: "below",
    signatureSeparator: false,
  });
  assert.ok(below.kind === "rich");
  assert.ok(below.html.indexOf("Me") > below.html.indexOf("</blockquote>"));
  assert.ok(!below.text.split("\n").includes("--"));
  const again = applyComposeSignature(below, signature, signature);
  assert.ok(again.kind === "rich");
  assert.ok(again.html.indexOf("Me") < again.html.indexOf("<blockquote>"));
  assert.strictEqual(again.html.split("Me").length, 2);
});

it("forwarded signatures are never replaced or used to suppress a below-quote signature", () => {
  const body = "Forwarding\n\n---------- Forwarded message ----------\nBody\n-- \nAlice Work";
  const options = { signaturePosition: "below", signatureSeparator: true } as const;
  const inserted = applySignature(body, undefined, "Me", options);
  assert.strictEqual(inserted, `${body}\n\n-- \nMe`);
  const same = applySignature(body, "Alice Work", "Me", options);
  assert.strictEqual(same, `${body}\n\n-- \nMe`);
  const two = `${body}\n\n-- \nAlice Work`;
  assert.strictEqual(applySignature(two, "Alice Work", "Me", options), `${body}\n\n-- \nMe`);
});
it.effect("removing and reconnecting an account clears its persisted undo batches", () =>
  Effect.gen(function* () {
    const directory = yield* temporary;
    const server = fakeServer("me@example.com", [incoming("one")]);
    yield* Effect.gen(function* () {
      const m = yield* Mailbox,
        store = yield* Store;
      yield* connect(m, "gmail");
      yield* m.sync();
      yield* m.modifyWithUndo(["gmail:me@example.com/one"], { kind: "star", value: true }, true);
      yield* m.sync();
      assert.strictEqual((yield* m.undoHistory).length, 1);
      yield* store.removeAccount("gmail:me@example.com");
      yield* connect(m, "gmail");
      assert.deepStrictEqual(yield* m.undoHistory, []);
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
        const batch = yield* m.modifyWithUndo([id], { kind: "star", value: true }, true);
        yield* m.sync();
        return batch.undoId;
      }).pipe(Effect.provide(session()));
      yield* Effect.gen(function* () {
        const m = yield* Mailbox,
          store = yield* Store;
        yield* kind === "local"
          ? store.applyLocalOp(id, { kind: "read", value: true })
          : store.enqueueOp("gmail:me@example.com", "one", { kind: "read", value: true });
        const result = yield* Effect.result(m.undoBatch(undoId));
        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual((yield* m.undoHistory)[0]?.undoId, undoId);
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
          (yield* Effect.result(m.modifyWithUndo(["outlook:me@example.com/one"], op, true)))._tag,
          "Failure",
        );
      }
      for (const change of [
        { kind: "rename", id: "category:Work", name: "Other" },
        { kind: "delete", id: "category:Work" },
        { kind: "parent", id: "category:Work", parentId: null },
      ] as const)
        assert.strictEqual(
          (yield* Effect.result(m.changeLabel("outlook:me@example.com", change)))._tag,
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
      const batch = yield* m.modifyWithUndo(
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
      assert.deepStrictEqual(yield* m.undoHistory, []);
      const result = yield* Effect.flip(m.undoBatch(undoId));
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
        const batch = yield* m.modifyWithUndo(
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
        assert.strictEqual((yield* Effect.exit(m.undoBatch(undoId)))._tag, "Failure");
        assert.deepStrictEqual(yield* store.listPendingOps, []);
        assert.strictEqual((yield* store.getMessage("gmail:me@example.com/one")).isStarred, true);
        assert.strictEqual((yield* m.undoHistory)[0]?.undoId, undoId);
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
        const batch = yield* m.modifyWithUndo(
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
        assert.strictEqual((yield* Effect.result(m.undoBatch(undoId)))._tag, "Failure");
        assert.strictEqual((yield* m.undoHistory)[0]?.undoId, undoId);
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
      const batch = yield* m.modifyWithUndo(["imap:me@example.com/one"], { kind: "archive" }, true);
      yield* m.sync();
      return batch.undoId;
    }).pipe(Effect.provide(session()));
    yield* Effect.gen(function* () {
      const m = yield* Mailbox;
      const failure = yield* Effect.flip(m.undoBatch(undoId));
      assert.strictEqual(failure._tag, "InvalidInput");
      if (failure._tag !== "InvalidInput") throw new Error("Expected InvalidInput");
      assert.ok(failure.message.includes("UID"));
    }).pipe(Effect.provide(session()));
  }).pipe(Effect.scoped),
);
