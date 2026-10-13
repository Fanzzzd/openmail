import { incoming as makeIncoming, TestMailbox } from "../platform/node/testing.js";
import { assert, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { Mailbox } from "./mailbox.js";
import { PermanentError, ProviderError, SendUncertain } from "../domain/errors.js";
import { Store, type ProviderAdapter } from "../services.js";
import { fakeServer, makeFakeProvider } from "../platform/node/fake-provider.js";
import { type IncomingMessage } from "../domain/domain.js";
{
  const withAdapter = <A, E>(
    adapter: ProviderAdapter,
    body: Effect.Effect<A, E, Store | Mailbox | SqlClient.SqlClient>,
  ) =>
    body.pipe(
      Effect.provide(
        TestMailbox.withAdapter(adapter, {
          options: { backgroundFlush: false },
          platformOptions: {},
        }),
      ),
    );

  for (const status of [0, 429, 503])
    it.effect(`status ${status} does not drop offline changes and backs off`, () => {
      let pushes = 0;
      const adapter: ProviderAdapter = {
        ...makeFakeProvider(fakeServer("me@example.com")),
        push: () => {
          pushes++;
          return Effect.fail(
            new ProviderError({ message: "offline", status, deferred: status === 429 }),
          );
        },
      };
      return withAdapter(
        adapter,
        Effect.gen(function* () {
          const store = yield* Store;
          const mailbox = yield* Mailbox;
          const account = yield* store.upsertAccount("gmail", "me@example.com");
          yield* store.enqueueOp(account.id, "m1", { kind: "star", value: true });
          for (let i = 0; i < 8; i++) {
            yield* mailbox.sync();
            yield* TestClock.adjust("1 hour");
          }
          assert.strictEqual((yield* store.listPendingOps).length, 1);
          yield* mailbox.sync();
          const before = pushes;
          yield* mailbox.sync();
          assert.strictEqual(pushes, before);
        }),
      );
    });

  it.effect("unreachable reconciliation survives seven days", () =>
    withAdapter(
      {
        ...makeFakeProvider(fakeServer("me@example.com")),
        fetchMessage: () => Effect.fail(new ProviderError({ message: "offline", status: 0 })),
      },
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount("gmail", "me@example.com");
        yield* store.enqueueOp(account.id, "m1", { kind: "reconcile" });
        for (let i = 0; i < 8; i++) {
          yield* TestClock.adjust("1 day");
          yield* mailbox.sync();
        }
        assert.strictEqual((yield* store.listPendingOps).length, 1);
      }),
    ),
  );

  it.effect("permanent failures remain visible until acknowledged", () =>
    withAdapter(
      {
        ...makeFakeProvider(fakeServer("me@example.com")),
        push: () => Effect.fail(new PermanentError({ message: "Access denied" })),
        fetchMessage: () => Effect.fail(new PermanentError({ message: "gone" })),
      },
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount("gmail", "me@example.com");
        yield* store.enqueueOp(account.id, "m1", { kind: "archive" });
        yield* mailbox.sync();
        const failures = yield* mailbox.listFailedOps;
        assert.strictEqual(failures.length, 1);
        assert.strictEqual(failures[0]?.reason, "Access denied");
        yield* mailbox.acknowledgeFailedOps(failures.map((f) => f.id));
        assert.deepStrictEqual(yield* mailbox.listFailedOps, []);
      }),
    ),
  );

  it.effect("a stolen claim cannot settle or overwrite a draft", () =>
    withAdapter(
      makeFakeProvider(fakeServer("me@example.com")),
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("gmail", "me@example.com");
        yield* store.putDraft({
          id: "draft",
          accountId: account.id,
          message: { to: [], cc: [], bcc: [], subject: "s", text: "t", attachments: [] },
        });
        yield* store.enqueueOp(account.id, "draft", { kind: "saveDraft", draftId: "draft" });
        const [op] = yield* store.listPendingOps;
        assert.ok(op);
        assert.isTrue(yield* store.claimPendingOp(op.id, "old"));
        yield* TestClock.adjust("3 minutes");
        assert.isTrue(yield* store.claimPendingOp(op.id, "new"));
        yield* store.removePendingOp(op.id, "old");
        assert.strictEqual((yield* store.listPendingOps).length, 1);
        assert.isFalse(
          yield* store.setDraftRemote(
            "draft",
            { draftId: "stale", messageId: "stale" },
            null,
            account.id,
            { id: op.id, token: "old" },
          ),
        );
        assert.strictEqual(Option.getOrThrow(yield* store.getDraft("draft")).remote, null);
        assert.isTrue(yield* store.renewPendingOp(op.id, "new"));
        const now = yield* Clock.currentTimeMillis;
        assert.isAtLeast(now, 180000);
      }),
    ),
  );

  it.effect("remap database errors keep the operation queued", () =>
    withAdapter(
      {
        ...makeFakeProvider(fakeServer("me@example.com")),
        push: () => Effect.succeed([{ from: "old", to: "new" }]),
      },
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const sql = yield* SqlClient.SqlClient;
        const account = yield* store.upsertAccount("imap", "me@example.com");
        yield* sql`CREATE TRIGGER reject_remap BEFORE UPDATE OF provider_id ON pending_ops BEGIN SELECT RAISE(ABORT,'remap failed'); END`;
        yield* store.enqueueOp(account.id, "old", { kind: "star", value: true });
        yield* mailbox.sync().pipe(Effect.exit);
        assert.strictEqual((yield* store.listPendingOps).length, 1);
      }),
    ),
  );

  it.effect("a long push renews its claim and cancellation releases it", () => {
    const adapter: ProviderAdapter = {
      ...makeFakeProvider(fakeServer("me@example.com")),
      push: () => Effect.never,
    };
    return withAdapter(
      adapter,
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const sql = yield* SqlClient.SqlClient;
        const account = yield* store.upsertAccount("gmail", "me@example.com");
        yield* store.enqueueOp(account.id, "m1", { kind: "star", value: true });
        const [op] = yield* store.listPendingOps;
        assert.ok(op);
        const fiber = yield* Effect.forkChild(mailbox.sync());
        yield* Effect.yieldNow;
        for (let i = 0; i < 6; i++) {
          yield* TestClock.adjust("30 seconds");
          yield* Effect.yieldNow;
        }
        assert.isFalse(yield* store.claimPendingOp(op.id, "competitor"));
        yield* Fiber.interrupt(fiber);
        const rows = yield* sql`SELECT claimed_at FROM pending_ops WHERE id=${op.id}`;
        assert.strictEqual(rows[0]?.["claimed_at"], null);
      }),
    );
  });

  it.effect("partial send keeps the draft and rejected recipient notice", () =>
    withAdapter(
      {
        ...makeFakeProvider(fakeServer("me@example.com")),
        send: () => Effect.succeed({ rejected: ["rejected@example.com"], sentCopyMissing: true }),
      },
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount("imap", "me@example.com");
        const message = {
          to: [
            { name: "", address: "accepted@example.com" },
            { name: "", address: "rejected@example.com" },
          ],
          cc: [],
          bcc: [],
          subject: "s",
          text: "t",
          attachments: [],
        };
        yield* store.putDraft({ id: "draft", accountId: account.id, message });
        yield* mailbox.perform(
          { kind: "send", accountId: account.id, draftId: "draft", message },
          { kind: "user", surface: "app" },
        );
        assert.isTrue(Option.isSome(yield* store.getDraft("draft")));
        assert.isTrue(yield* store.sendUncertain("draft"));
        const failed = yield* mailbox.listFailedOps;
        assert.strictEqual(failed.length, 2);
        assert.isTrue(
          failed.some((f) => f.kind === "sendPartial" && f.reason.includes("rejected@example.com")),
        );
        assert.isTrue(failed.some((f) => f.kind === "sentCopyMissing"));
      }),
    ),
  );

  it.effect("failed replacement cleanup queues deletion of the old copy", () =>
    withAdapter(
      {
        ...makeFakeProvider(fakeServer("me@example.com")),
        saveDraft: () =>
          Effect.succeed({ draftId: "new", messageId: "new", cleanupMessageId: "old" }),
        deleteDraft: () => Effect.fail(new ProviderError({ message: "offline" })),
      },
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount("imap", "me@example.com");
        yield* store.putDraft({
          id: "draft",
          accountId: account.id,
          message: { to: [], cc: [], bcc: [], subject: "s", text: "t", attachments: [] },
        });
        yield* store.setDraftRemote("draft", { draftId: "old", messageId: "old" }, null);
        yield* store.enqueueDraftSave(account.id, "draft");
        yield* mailbox.sync();
        assert.strictEqual(
          Option.getOrThrow(yield* store.getDraft("draft")).remote?.messageId,
          "new",
        );
        assert.isTrue(
          (yield* store.listPendingOps).some(
            (p) => p.op.kind === "deleteDraft" && p.op.remote.messageId === "old",
          ),
        );
      }),
    ),
  );

  it.effect("queued Message-ID survives cache deletion and reaches the provider", () => {
    let observed: string | undefined;
    const adapter: ProviderAdapter = {
      ...makeFakeProvider(fakeServer("me@example.com")),
      push: (_account, id, _op, _cursor, context) =>
        Effect.sync(() => {
          observed = context?.messageIds.get(id);
        }),
    };
    return withAdapter(
      adapter,
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount("gmail", "me@example.com");
        yield* store.upsertMessage(account.id, {
          providerId: "m1",
          rfcMessageId: "<stable@example.com>",
          threadId: "t",
          subject: "s",
          from: { name: "", address: "sender@example.com" },
          to: [],
          cc: [],
          date: 0,
          snippet: "",
          bodyText: "",
          bodyHtml: "",
          labels: ["INBOX"],
          attachments: [],
          isUnread: false,
          isStarred: false,
        });
        yield* store.enqueueOp(account.id, "m1", { kind: "archive" });
        yield* store.deleteMessage(account.id, "m1");
        assert.strictEqual((yield* store.listPendingOps)[0]?.rfcMessageId, "<stable@example.com>");
        yield* mailbox.sync();
        assert.strictEqual(observed, "<stable@example.com>");
      }),
    );
  });

  it.effect("a week-old mutation expires with a notice while its reconciliation stays", () =>
    withAdapter(
      {
        ...makeFakeProvider(fakeServer("me@example.com")),
        push: () => Effect.fail(new ProviderError({ message: "offline", status: 0 })),
        fetchMessage: () => Effect.fail(new ProviderError({ message: "offline", status: 0 })),
      },
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount("gmail", "me@example.com");
        yield* store.enqueueOp(account.id, "m1", { kind: "star", value: true });
        yield* TestClock.adjust("8 days");
        yield* mailbox.sync();
        assert.strictEqual((yield* mailbox.listFailedOps).length, 1);
        assert.strictEqual((yield* store.listPendingOps)[0]?.op.kind, "reconcile");
      }),
    ),
  );

  it.effect("losing one claim does not interrupt unrelated queued work", () => {
    const pushed: string[] = [];
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const adapter: ProviderAdapter = {
        ...makeFakeProvider(fakeServer("me@example.com")),
        push: (_account, id) =>
          id === "one"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.sync(() => {
                pushed.push(id);
              }),
      };
      yield* withAdapter(
        adapter,
        Effect.gen(function* () {
          const store = yield* Store;
          const mailbox = yield* Mailbox;
          const sql = yield* SqlClient.SqlClient;
          const account = yield* store.upsertAccount("gmail", "me@example.com");
          yield* store.enqueueOp(account.id, "one", { kind: "archive" });
          yield* store.enqueueOp(account.id, "two", { kind: "archive" });
          const worker = yield* Effect.forkChild(mailbox.sync());
          yield* Deferred.await(entered);
          yield* sql`UPDATE pending_ops SET claim_token='other-worker' WHERE provider_id='one'`;
          yield* TestClock.adjust("30 seconds");
          yield* Fiber.await(worker);
          assert.deepStrictEqual(pushed, ["two"]);
        }),
      );
    });
  });

  it.effect("a late draft push deletes only its unowned new copy", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const deleted: string[] = [];
      const adapter: ProviderAdapter = {
        ...makeFakeProvider(fakeServer("me@example.com")),
        saveDraft: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as({ draftId: "late-copy", messageId: "late-copy" }),
          ),
        deleteDraft: (_account, remote) =>
          Effect.sync(() => {
            if (remote.messageId) deleted.push(remote.messageId);
          }),
      };
      yield* withAdapter(
        adapter,
        Effect.gen(function* () {
          const store = yield* Store;
          const mailbox = yield* Mailbox;
          const sql = yield* SqlClient.SqlClient;
          const account = yield* store.upsertAccount("imap", "me@example.com");
          yield* store.putDraft({
            id: "draft",
            accountId: account.id,
            message: { to: [], cc: [], bcc: [], subject: "s", text: "t", attachments: [] },
          });
          yield* store.setDraftRemote("draft", { draftId: "old", messageId: "old" }, null);
          yield* store.enqueueDraftSave(account.id, "draft");
          const worker = yield* Effect.forkChild(mailbox.sync());
          yield* Deferred.await(entered);
          yield* sql`UPDATE pending_ops SET claim_token='other-worker' WHERE provider_id='draft'`;
          yield* store.setDraftRemote("draft", { draftId: "winner", messageId: "winner" }, null);
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(worker);
          assert.deepStrictEqual(deleted, ["late-copy"]);
          assert.strictEqual(
            Option.getOrThrow(yield* store.getDraft("draft")).remote?.messageId,
            "winner",
          );
        }),
      );
    }),
  );

  it.effect("remap failure retries only its operation and completes the pull", () => {
    const pushed: string[] = [];
    const adapter: ProviderAdapter = {
      ...makeFakeProvider(fakeServer("me@example.com")),
      push: (_account, id) =>
        id === "old"
          ? Effect.succeed([{ from: "old", to: "new" }])
          : Effect.sync(() => {
              pushed.push(id);
            }),
    };
    return withAdapter(
      adapter,
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const sql = yield* SqlClient.SqlClient;
        const account = yield* store.upsertAccount("imap", "me@example.com");
        yield* store.enqueueOp(account.id, "old", { kind: "archive" });
        yield* store.enqueueOp(account.id, "other", { kind: "archive" });
        yield* sql`CREATE TRIGGER reject_review_remap BEFORE UPDATE OF provider_id ON pending_ops BEGIN SELECT RAISE(ABORT,'simulated write failure'); END`;
        yield* mailbox.sync();
        assert.deepStrictEqual(pushed, ["other"]);
        assert.strictEqual((yield* store.listPendingOps).length, 1);
      }),
    );
  });

  it.effect(
    "partial resend contains only rejected recipients and preserves the original draft",
    () =>
      withAdapter(
        {
          ...makeFakeProvider(fakeServer("me@example.com")),
          send: () =>
            Effect.succeed({ rejected: ["cc-rejected@example.com", "bcc-rejected@example.com"] }),
        },
        Effect.gen(function* () {
          const store = yield* Store;
          const mailbox = yield* Mailbox;
          const account = yield* store.upsertAccount("imap", "me@example.com");
          const message = {
            to: [{ name: "Accepted", address: "accepted@example.com" }],
            cc: [{ name: "Rejected cc", address: "cc-rejected@example.com" }],
            bcc: [{ name: "Rejected bcc", address: "bcc-rejected@example.com" }],
            subject: "A subject",
            text: "text",
            attachments: [],
          };
          yield* store.putDraft({ id: "original", accountId: account.id, message });
          yield* mailbox.perform(
            { kind: "send", accountId: account.id, draftId: "original", message },
            { kind: "user", surface: "app" },
          );
          const [notice] = yield* mailbox.listFailedOps;
          assert.ok(notice);
          assert.strictEqual(notice.subject, "A subject");
          assert.strictEqual(notice.sender, "me@example.com");
          const resend = yield* mailbox.prepareRejectedResend(notice.id);
          assert.notStrictEqual(resend.id, "original");
          assert.deepStrictEqual(resend.message.to, []);
          assert.deepStrictEqual(resend.message.cc, message.cc);
          assert.deepStrictEqual(resend.message.bcc, message.bcc);
          assert.isTrue(Option.isSome(yield* store.getDraft(resend.id)));
          assert.isFalse(yield* store.sendUncertain(resend.id));
          assert.deepStrictEqual(
            Option.getOrThrow(yield* store.getDraft("original")).message.to,
            message.to,
          );
        }),
      ),
  );

  it.effect("persisted copy markers survive a failed push and fence later operations", () => {
    let copyAttempts = 0;
    let starred = false;
    let retainedMarker = false;
    const adapter: ProviderAdapter = {
      ...makeFakeProvider(fakeServer("me@example.com")),
      push: (_account, id, op, _cursor, context) =>
        Effect.gen(function* () {
          if (op.kind === "star") {
            starred = true;
            return yield* Effect.void;
          }
          const key = JSON.stringify([id, "Archive"]);
          if (copyAttempts++ === 0) {
            if (context?.beforeCopy) yield* context.beforeCopy("Archive", [id]);
            return yield* new ProviderError({ message: "Lost COPY acknowledgement" });
          }
          retainedMarker = context?.progress?.has(key) ?? false;
          if (context?.afterCopy) yield* context.afterCopy("Archive", [id]);
          return { reconcile: true };
        }),
    };
    return withAdapter(
      adapter,
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount("imap", "me@example.com");
        yield* store.enqueueOp(account.id, "7:1:INBOX", { kind: "archive" });
        yield* store.enqueueOp(account.id, "7:1:INBOX", { kind: "star", value: true });
        yield* mailbox.sync();
        assert.deepStrictEqual((yield* store.listPendingOps)[0]?.progress, [
          JSON.stringify(["7:1:INBOX", "Archive"]),
        ]);
        yield* TestClock.adjust("5 seconds");
        yield* mailbox.sync();
        assert.isTrue(retainedMarker);
        assert.isFalse(starred);
        assert.isTrue((yield* store.listPendingOps).some((op) => op.op.kind === "reconcile"));
      }),
    );
  });

  it.effect("fallback releases a skipped duplicate without interrupting a slow operation", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      let finished = false;
      const adapter: ProviderAdapter = {
        ...makeFakeProvider(fakeServer("me@example.com")),
        pushBatch: () =>
          Effect.fail(new PermanentError({ message: "Batch needs individual verification" })),
        push: (_account, id) =>
          id === "one"
            ? Effect.fail(new ProviderError({ message: "offline" }))
            : Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(
                  Effect.sync(() => {
                    finished = true;
                  }),
                ),
              ),
      };
      yield* withAdapter(
        adapter,
        Effect.gen(function* () {
          const store = yield* Store;
          const mailbox = yield* Mailbox;
          const account = yield* store.upsertAccount("gmail", "me@example.com");
          for (const id of ["one", "one", "slow"])
            yield* store.enqueueOp(account.id, id, { kind: "archive" });
          const worker = yield* Effect.forkChild(mailbox.sync());
          yield* Deferred.await(entered);
          yield* TestClock.adjust("30 seconds");
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(worker);
          assert.isTrue(finished);
          assert.strictEqual((yield* store.listPendingOps).length, 2);
        }),
      );
    }),
  );
}

{
  const message: IncomingMessage = makeIncoming("old", {
    threadId: "old",
    subject: "Old mail",
    from: { name: "Sender", address: "sender@example.com" },
    to: [],
    snippet: "text",
    bodyText: "full body",
  });

  const outgoing = {
    to: [{ name: "", address: "bob@example.com" }],
    cc: [],
    bcc: [],
    subject: "Test",
    text: "Hello",
    attachments: [],
  };

  const user = { kind: "user", surface: "app" } as const;

  function core<A, E>(
    body: Effect.Effect<A, E, Mailbox | Store>,
    overrides: Partial<ProviderAdapter> = {},
  ) {
    const server = fakeServer("me@gmail.com", [message]);
    const adapter = { ...makeFakeProvider(server), ...overrides };

    return body.pipe(
      Effect.provide(
        TestMailbox.withAdapter(adapter, { options: { backgroundFlush: false, imapIdle: false } }),
      ),
    );
  }

  it.effect("uncertain drafts cannot resend until an app user confirms", () => {
    let submissions = 0;
    return core(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.saveDraft({ id: "draft:unknown", accountId: account.id, message: outgoing });
        const command = {
          kind: "send",
          accountId: account.id,
          draftId: "draft:unknown",
          message: outgoing,
        } as const;
        assert.strictEqual(
          (yield* mailbox.perform(command, user).pipe(Effect.flip))._tag,
          "SendUncertain",
        );
        const blocked = yield* mailbox.perform(command, user).pipe(Effect.result);
        assert.strictEqual(blocked._tag, "Failure");
        assert.strictEqual(submissions, 1);
        assert.isTrue(yield* store.sendUncertain("draft:unknown"));
        yield* mailbox.perform({ ...command, confirmResend: true }, user);
        assert.strictEqual(submissions, 2);
        assert.isFalse(yield* store.sendUncertain("draft:unknown"));
      }),
      {
        send: () =>
          Effect.suspend(() =>
            ++submissions === 1
              ? Effect.fail(new SendUncertain({ message: "Unknown submission" }))
              : Effect.void,
          ),
      },
    );
  });

  it.effect("reconcile remains queued while the provider is unreachable", () =>
    core(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* store.enqueueOp(account.id, "missing", { kind: "reconcile" });
        for (let attempt = 0; attempt < 3; attempt++) yield* mailbox.sync();
        assert.strictEqual((yield* store.listPendingOps).length, 1);
        assert.isFalse((yield* mailbox.audit(30)).some((entry) => entry.action === "sync-failed"));
      }),
      { fetchMessage: () => Effect.fail(new ProviderError({ message: "Still offline" })) },
    ),
  );
}
