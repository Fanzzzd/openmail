import { expect, vi } from "vitest";
import { assert, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, ManagedRuntime, Option } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { AuthError, PermanentError, ProviderError, SendUncertain } from "../domain/errors.js";
import { type MailboxOptions } from "./mailbox-live.js";
import { Mailbox } from "./mailbox.js";
import { TestMailbox } from "../platform/node/testing.js";
import { fakeServer, makeFakeProvider } from "../platform/node/fake-provider.js";
import { Store, type ProviderAdapter } from "../services.js";
for (const action of ["discard", "send"] as const) {
  it.effect(`${action} queues Message-ID cleanup for an uncertain draft creation`, () =>
    core(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const account = yield* mailbox.connect({ provider: "gmail" });
        const input = { id: "uncertain-copy", accountId: account.id, message: outgoing };
        yield* store.putDraft(input);
        yield* store.setDraftCreateState(input.id, {
          messageId: "<orphan@example.test>",
          attempted: true,
        });
        yield* action === "discard"
          ? mailbox.discardDraft(input.id)
          : mailbox.perform(
              { kind: "send", draftId: input.id, accountId: account.id, message: outgoing },
              { kind: "user", surface: "app" },
            );
        const cleanups = (yield* store.listPendingOps).filter(
          (item) => item.op.kind === "deleteDraft",
        );
        assert.strictEqual(cleanups.length, 1);
        assert.deepStrictEqual(cleanups[0]?.op, {
          kind: "deleteDraft",
          remote: { draftId: null, messageId: null, rfcMessageId: "<orphan@example.test>" },
        });
        assert.isTrue(Option.isNone(yield* store.draftCreateState(input.id)));
      }),
      {},
      { localDraftQueue: true },
    ),
  );
}

const outgoing = {
  to: [{ name: "", address: "bob@example.com" }],
  cc: [],
  bcc: [],
  subject: "Test",
  text: "Hello",
  attachments: [],
};
function core<A, E>(
  body: Effect.Effect<A, E, Mailbox | Store | SqlClient.SqlClient>,
  overrides: Partial<ProviderAdapter> = {},
  options: MailboxOptions = {},
) {
  const server = fakeServer("me@gmail.com");
  const adapter = { ...makeFakeProvider(server), ...overrides };

  return body.pipe(
    Effect.provide(
      TestMailbox.withAdapter(adapter, {
        options: { backgroundFlush: false, imapIdle: false, ...options },
      }),
    ),
  );
}

it.effect("approved quit cancels waiting desktop sends and preserves drafts", () => {
  let sends = 0;
  return core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.queueUndoSend(
        { id: "quit-wait", accountId: account.id, message: outgoing },
        5000,
      );
      yield* mailbox.cancelDesktopUndoSends();
      yield* TestClock.adjust("6 seconds");
      assert.strictEqual(sends, 0);
      assert.deepStrictEqual(yield* mailbox.queuedSends, []);
      assert.isTrue(Option.isSome(yield* (yield* Store).getDraft("quit-wait")));
    }),
    {
      send: () =>
        Effect.sync(() => {
          sends++;
        }),
    },
  );
});

it.effect("direct send rejects a waiting queued send of the same draft", () => {
  let sends = 0;
  return core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      const input = { id: "already-queued", accountId: account.id, message: outgoing };
      yield* mailbox.queueSend(input, 0);
      const direct = yield* mailbox
        .perform(
          { kind: "send", draftId: input.id, accountId: account.id, message: outgoing },
          { kind: "user", surface: "app" },
        )
        .pipe(Effect.result);
      assert.strictEqual(direct._tag === "Failure" && direct.failure._tag, "InvalidInput");
      assert.strictEqual(sends, 0);
      yield* mailbox.flushQueuedSends();
      assert.strictEqual(sends, 1);
    }),
    {
      send: () =>
        Effect.sync(() => {
          sends++;
        }),
    },
  );
});

it.effect(
  "draft creation waits for three misses and two minutes, and discard clears its journal",
  () => {
    const misses: boolean[] = [];
    return core(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const account = yield* mailbox.connect({ provider: "gmail" });
        const input = { id: "bounded-create", accountId: account.id, message: outgoing };
        yield* mailbox.saveDraft(input);
        assert.deepStrictEqual(misses, [false, false, false, false, true]);
        assert.isFalse(Option.getOrThrow(yield* store.draftCreateState(input.id)).attempted);
        yield* mailbox.discardDraft(input.id);
        assert.isTrue(Option.isNone(yield* store.draftCreateState(input.id)));
      }),
      {
        saveDraft: (_account, push) =>
          Effect.gen(function* () {
            const state = yield* push.creation.begin();
            yield* push.creation.attempted(state.messageId);
            misses.push(yield* push.creation.missing());
            misses.push(yield* push.creation.missing());
            misses.push(yield* push.creation.missing());
            yield* TestClock.adjust("119999 millis");
            misses.push(yield* push.creation.missing());
            yield* TestClock.adjust("1 millis");
            misses.push(yield* push.creation.missing());
            return yield* new ProviderError({ message: "Unconfirmed creation" });
          }),
      },
    );
  },
);

it.effect("elapsed creation time alone does not permit another POST", () => {
  const misses: boolean[] = [];
  return core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.saveDraft({ id: "timed-create", accountId: account.id, message: outgoing });
      assert.deepStrictEqual(misses, [false, false, true]);
    }),
    {
      saveDraft: (_account, push) =>
        Effect.gen(function* () {
          const state = yield* push.creation.begin();
          yield* push.creation.attempted(state.messageId);
          yield* TestClock.adjust("2 minutes");
          misses.push(yield* push.creation.missing());
          misses.push(yield* push.creation.missing());
          misses.push(yield* push.creation.missing());
          return yield* new ProviderError({ message: "Unconfirmed creation" });
        }),
    },
  );
});

it.effect("closing a composer cancels only its waiting desktop sends", () =>
  core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.queueUndoSend(
        { id: "compose-a", accountId: account.id, message: outgoing },
        60000,
        { archive: false, confirmResend: false, owner: "a" },
      );
      yield* mailbox.queueUndoSend(
        { id: "compose-b", accountId: account.id, message: outgoing },
        60000,
        { archive: false, confirmResend: false, owner: "b" },
      );
      yield* mailbox.queueUndoSend(
        { id: "ownerless", accountId: account.id, message: outgoing },
        60000,
      );
      yield* mailbox.queueSend({ id: "mobile", accountId: account.id, message: outgoing }, 60000);
      yield* mailbox.cancelDesktopUndoSends("a");
      assert.deepStrictEqual((yield* mailbox.queuedSends).map((item) => item.id).toSorted(), [
        "compose-b",
        "mobile",
        "ownerless",
      ]);
      assert.isTrue(Option.isSome(yield* (yield* Store).getDraft("compose-a")));
    }),
  ),
);

for (const failure of [false, true]) {
  it.effect(
    `a finished ${failure ? "failed" : "successful"} undo worker is removed without a renderer waiter`,
    () =>
      core(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const account = yield* mailbox.connect({ provider: "gmail" });
          yield* mailbox.queueUndoSend(
            { id: "finished-worker", accountId: account.id, message: outgoing },
            5000,
          );
          yield* TestClock.adjust("6 seconds");
          const waiter = yield* mailbox.awaitUndoSend("finished-worker").pipe(Effect.result);
          assert.strictEqual(waiter._tag === "Failure" && waiter.failure._tag, "InvalidInput");
          assert.strictEqual(yield* mailbox.pendingSendCount, 0);
        }),
        {
          send: () =>
            failure ? Effect.fail(new ProviderError({ message: "Rejected" })) : Effect.void,
        },
      ),
  );
}

it.effect("a late creation callback cannot overwrite or delete the winning draft", () => {
  let sql: SqlClient.SqlClient | undefined;
  let store: Store["Service"] | undefined;
  return core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      sql = yield* SqlClient.SqlClient;
      store = yield* Store;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.saveDraft({ id: "fenced-draft", accountId: account.id, message: outgoing });
      const draft = Option.getOrThrow(yield* store.getDraft("fenced-draft"));
      assert.strictEqual(draft.remote?.changeKey, "winner-version");
      assert.isFalse(
        (yield* store.listPendingOps).some(
          (op) => op.op.kind === "deleteDraft" && op.op.remote.messageId === "winner",
        ),
      );
    }),
    {
      saveDraft: (account, push) =>
        Effect.gen(function* () {
          if (!sql || !store)
            return yield* new ProviderError({ message: "Missing creation context" });
          yield* push.creation.begin();
          yield* sql`UPDATE pending_ops SET claim_token='winner-token' WHERE provider_id='fenced-draft'`.pipe(
            Effect.orDie,
          );
          yield* store.setDraftRemote(
            "fenced-draft",
            { draftId: "winner", messageId: "winner", changeKey: "winner-version" },
            null,
            account.id,
          );
          yield* push.creation.remember({
            draftId: "winner",
            messageId: "winner",
            changeKey: "stale-version",
          });
          return { draftId: "winner", messageId: "winner", changeKey: "stale-version" };
        }),
    },
  );
});

it.effect("a lost claim cannot mark another draft creation attempted", () => {
  let sql: SqlClient.SqlClient | undefined;
  let store: Store["Service"] | undefined;
  let posts = 0;
  return core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      sql = yield* SqlClient.SqlClient;
      store = yield* Store;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.saveDraft({ id: "fenced-attempt", accountId: account.id, message: outgoing });
      assert.strictEqual(posts, 0);
      assert.isFalse(Option.getOrThrow(yield* store.draftCreateState("fenced-attempt")).attempted);
    }),
    {
      saveDraft: (_account, push) =>
        Effect.gen(function* () {
          if (!sql) return yield* new ProviderError({ message: "Missing creation context" });
          const state = yield* push.creation.begin();
          yield* sql`UPDATE pending_ops SET claim_token='winner-token' WHERE provider_id='fenced-attempt'`.pipe(
            Effect.orDie,
          );
          yield* push.creation.attempted(state.messageId);
          posts++;
          return { draftId: "late", messageId: "late" };
        }),
    },
  );
});

it.effect("queued partial delivery preserves the draft and resend protection", () => {
  let sends = 0;
  return core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const store = yield* Store;
      const account = yield* mailbox.connect({ provider: "gmail" });
      const input = { id: "partial-send", accountId: account.id, message: outgoing };
      yield* mailbox.queueSend(input, 0);
      yield* mailbox.flushQueuedSends();
      assert.isTrue(yield* store.sendUncertain(input.id));
      assert.strictEqual((yield* mailbox.queuedSends)[0]?.status, "failed");
      assert.isTrue(Option.isSome(yield* store.getDraft(input.id)));
      yield* mailbox.flushQueuedSends();
      assert.strictEqual(sends, 1);
      const retry = yield* mailbox.queueSend(input, 0).pipe(Effect.result);
      assert.strictEqual(retry._tag === "Failure" && retry.failure._tag, "SendUncertain");
    }),
    {
      send: () =>
        Effect.sync(() => {
          sends++;
          return { rejected: ["bob@example.com"] };
        }),
    },
  );
});

it.effect("a remapped draft ID is authoritative over stored version metadata", () =>
  core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* store.putDraft({ id: "remapped", accountId: account.id, message: outgoing });
      yield* store.setDraftRemote(
        "remapped",
        { draftId: "old", messageId: "old", changeKey: "version" },
        null,
      );
      yield* sql`UPDATE drafts SET remote_draft_id='new', remote_message_id='new' WHERE id='remapped'`;
      assert.strictEqual(
        Option.getOrThrow(yield* store.getDraft("remapped")).remote?.messageId,
        "new",
      );
    }),
  ),
);

it.effect("creation journal is persisted before the provider write and reused on retry", () => {
  let creates = 0;
  let firstId: string | undefined;
  let journal: Store["Service"] | undefined;
  return core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      journal = yield* Store;
      const account = yield* mailbox.connect({ provider: "gmail" });
      const draft = { id: "journal", accountId: account.id, message: outgoing };
      yield* mailbox.saveDraft(draft);
      yield* mailbox.saveDraft({ ...draft, message: { ...outgoing, text: "edited" } });
      assert.strictEqual(creates, 1);
      const stored = yield* journal.getDraft(draft.id);
      assert.strictEqual(Option.getOrThrow(stored).remote?.messageId, "found");
    }),
    {
      saveDraft: (_account, push) =>
        Effect.gen(function* () {
          if (!journal) {
            creates++;
            return yield* new ProviderError({ message: "Lost response", status: 0 });
          }
          const state = yield* push.creation.begin();
          if (state.attempted) {
            assert.strictEqual(state.messageId, firstId);
            return { draftId: "found", messageId: "found" };
          }
          firstId = state.messageId;
          yield* push.creation.attempted(state.messageId);
          const persisted = yield* journal.draftCreateState("journal");
          assert.isTrue(Option.getOrThrow(persisted).attempted);
          creates++;
          return yield* new ProviderError({ message: "Lost response", status: 0 });
        }),
    },
  );
});

it.effect("partially saved draft retains its ID and queues failed old-draft cleanup", () =>
  core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const store = yield* Store;
      const account = yield* mailbox.connect({ provider: "outlook" });
      yield* mailbox.saveDraft({ id: "partial", accountId: account.id, message: outgoing });
      const draft = Option.getOrThrow(yield* store.getDraft("partial"));
      assert.strictEqual(draft.remote?.messageId, "new");
      assert.strictEqual(draft.pushedAttachments, null);
      assert.include(draft.syncError ?? "", "attachment failed");
      assert.isTrue(
        (yield* store.listPendingOps).some(
          (op) => op.op.kind === "deleteDraft" && op.op.remote.messageId === "old",
        ),
      );
    }),
    {
      saveDraft: () =>
        Effect.succeed({
          draftId: "new",
          messageId: "new",
          saveError: new ProviderError({ message: "attachment failed" }),
          replacedMessageId: "old",
        }),
    },
  ),
);

for (const failure of [
  new AuthError({ message: "Sign in" }),
  new PermanentError({ message: "Bad message" }),
  new ProviderError({ message: "Rejected", status: 429 }),
  new ProviderError({ message: "DNS failure", status: 0, reason: "connection" }),
  new ProviderError({ message: "Provider rejected the message" }),
  new ProviderError({ message: "Threading lookup failed", status: 503 }),
]) {
  it.effect(`definite ${failure._tag} is retryable without uncertain-send confirmation`, () =>
    core(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const account = yield* mailbox.connect({ provider: "gmail" });
        const draft = { id: "retryable", accountId: account.id, message: outgoing };
        yield* mailbox.queueSend(draft, 0);
        yield* mailbox.flushQueuedSends();
        assert.strictEqual((yield* mailbox.queuedSends)[0]?.status, "retryable");
        assert.isFalse(yield* store.sendUncertain(draft.id));
        yield* mailbox.queueSend(draft, 0);
        assert.strictEqual((yield* mailbox.queuedSends)[0]?.status, "waiting");
      }),
      { send: () => Effect.fail(failure) },
    ),
  );
}

for (const queued of [false, true]) {
  it.effect(
    `IMAP definite send failure clears resend protection (${queued ? "queued" : "direct"})`,
    () =>
      core(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const store = yield* Store;
          const account = yield* store.upsertAccount("imap", "me@example.test");
          const input = { id: "imap-failure", accountId: account.id, message: outgoing };
          yield* store.putDraft(input);
          if (queued) {
            yield* mailbox.queueSend(input, 0);
            yield* mailbox.flushQueuedSends();
            assert.strictEqual((yield* mailbox.queuedSends)[0]?.status, "retryable");
          } else {
            const failure = yield* mailbox
              .perform(
                { kind: "send", draftId: input.id, accountId: account.id, message: outgoing },
                { kind: "user", surface: "app" },
              )
              .pipe(Effect.result);
            assert.strictEqual(failure._tag === "Failure" && failure.failure._tag, "ProviderError");
          }
          assert.isFalse(yield* store.sendUncertain(input.id));
          yield* mailbox.queueSend(input, 60000);
          assert.strictEqual((yield* mailbox.queuedSends)[0]?.status, "waiting");
        }),
        { send: () => Effect.fail(new ProviderError({ message: "SMTP message rejected" })) },
      ),
  );
}

it.effect("interruption during a claimed send retains durable resend protection", () => {
  let store: Store["Service"] | undefined;
  return Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    yield* core(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        store = yield* Store;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.queueSend({ id: "crash", accountId: account.id, message: outgoing }, 0);
        const sending = yield* mailbox.flushQueuedSends().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        assert.strictEqual((yield* mailbox.queuedSends)[0]?.status, "sending");
        assert.isTrue(yield* store.sendUncertain("crash"));
        yield* Fiber.interrupt(sending);
        assert.isTrue(yield* store.sendUncertain("crash"));
        const retry = yield* mailbox
          .perform(
            { kind: "send", draftId: "crash", accountId: account.id, message: outgoing },
            { kind: "user", surface: "app" },
          )
          .pipe(Effect.result);
        assert.strictEqual(retry._tag === "Failure" && retry.failure._tag, "SendUncertain");
      }),
      { send: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) },
    );
  });
});

it.effect("disconnecting the renderer waiter does not cancel core's undo send", () => {
  let sent = 0;
  return core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      const now = yield* Clock.currentTimeMillis;
      yield* mailbox.queueUndoSend(
        { id: "undo", accountId: account.id, message: outgoing },
        now + 5000,
      );
      assert.strictEqual(yield* mailbox.pendingSendCount, 1);
      const renderer = yield* mailbox.awaitUndoSend("undo").pipe(Effect.forkChild);
      yield* Fiber.interrupt(renderer);
      yield* TestClock.adjust("6 seconds");
      assert.strictEqual(sent, 1);
      assert.deepStrictEqual(yield* mailbox.queuedSends, []);
    }),
    {
      send: () =>
        Effect.sync(() => {
          sent++;
        }),
    },
  );
});

it.effect("an old cancelled timer cannot send a newly queued version of the same draft", () => {
  let sent = 0;
  return core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      const now = yield* Clock.currentTimeMillis;
      const input = { id: "undo-requeue", accountId: account.id, message: outgoing };
      yield* mailbox.queueUndoSend(input, now + 5000);
      const oldWaiter = yield* mailbox.awaitUndoSend(input.id).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isTrue(yield* mailbox.cancelWaitingSend(input.id));
      assert.strictEqual((yield* Fiber.await(oldWaiter))._tag, "Failure");
      yield* mailbox.queueUndoSend(input, now + 10000);
      yield* TestClock.adjust("6 seconds");
      assert.strictEqual(sent, 0);
      yield* TestClock.adjust("5 seconds");
      assert.strictEqual(sent, 1);
    }),
    {
      send: () =>
        Effect.sync(() => {
          sent++;
        }),
    },
  );
});

it("desktop undo intents and draft creation metadata survive reopening", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const nodePath = await import("node:path");
  const { Layer } = await import("effect");
  const directory = mkdtempSync(nodePath.join(tmpdir(), "openmail-desktop-undo-"));
  const server = fakeServer("me@example.test");
  const layer = () =>
    TestMailbox(
      { gmail: server },
      { backgroundFlush: false, localDraftQueue: true, resumeDesktopSends: true },
      {},
      Layer.empty,
      { database: nodePath.join(directory, "mail.db") },
    );
  const first = ManagedRuntime.make(layer());
  try {
    await first.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.queueUndoSend(
          { id: "restart-undo", accountId: account.id, message: outgoing },
          Date.now() + 60000,
        );
        const intent = (yield* store.queuedSends)[0];
        if (!intent) throw new Error("Missing send intent");
        // The in-memory worker retains its original future deadline; reopen must
        // discover and resume this durable, now-due intent by itself.
        yield* store.putQueuedSend({ ...intent, due: Date.now() });
        yield* store.putDraft({ id: "create-marker", accountId: account.id, message: outgoing });
        yield* store.setDraftCreateState("create-marker", {
          messageId: "<client@example.test>",
          attempted: true,
        });
        yield* store.setDraftRemote(
          "create-marker",
          { draftId: "d", messageId: "d", changeKey: "version" },
          null,
        );
      }),
    );
  } finally {
    await first.dispose();
  }
  const cli = ManagedRuntime.make(
    TestMailbox({ gmail: server }, { backgroundFlush: false }, {}, Layer.empty, {
      database: nodePath.join(directory, "mail.db"),
    }),
  );
  try {
    await cli.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        // Layer start runs synchronously, so a CLI resume would already have sent.
        yield* mailbox.flushQueuedSends();
        expect(server.sent).toHaveLength(0);
        expect((yield* mailbox.queuedSends)[0]?.status).toBe("waiting");
      }),
    );
  } finally {
    await cli.dispose();
  }
  const reopened = ManagedRuntime.make(layer());
  try {
    await reopened.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        // The resumed intent is due now; its worker sends in the background.
        yield* Effect.promise(() => vi.waitFor(() => expect(server.sent).toHaveLength(1)));
        expect(yield* mailbox.queuedSends).toEqual([]);
        const draft = Option.getOrThrow(yield* store.getDraft("create-marker"));
        expect(draft.remote?.changeKey).toBe("version");
        expect(Option.getOrThrow(yield* store.draftCreateState("create-marker"))).toEqual({
          messageId: "<client@example.test>",
          attempted: true,
        });
      }),
    );
  } finally {
    await reopened.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const status of ["waiting", "sending", "stale"] as const) {
  it(`a ${status} desktop send survives restart with a visible failure and can be confirmed again`, async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const nodePath = await import("node:path");
    const { Layer } = await import("effect");
    const directory = mkdtempSync(nodePath.join(tmpdir(), "openmail-failed-desktop-send-"));
    const server = fakeServer("me@example.test");
    const layer = (resumeDesktopSends: boolean) =>
      TestMailbox(
        { gmail: server },
        { backgroundFlush: false, resumeDesktopSends },
        {},
        Layer.empty,
        { database: nodePath.join(directory, "mail.db") },
      );
    const first = ManagedRuntime.make(layer(false));
    try {
      await first.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const store = yield* Store;
          const account = yield* mailbox.connect({ provider: "gmail" });
          yield* store.putDraft({
            id: "restart-failure",
            accountId: account.id,
            message: outgoing,
          });
          yield* store.putQueuedSend({
            id: "restart-failure",
            accountId: account.id,
            message: outgoing,
            due: status === "stale" ? Date.now() - 120001 : Date.now(),
            status: status === "stale" ? "waiting" : status,
            desktopUndo: true,
          });
          if (status === "sending") yield* store.setSendUncertain("restart-failure", true);
        }),
      );
    } finally {
      await first.dispose();
    }
    server.sendFailure = new SendUncertain({ message: "Send response lost" });
    const reopened = ManagedRuntime.make(layer(true));
    try {
      await reopened.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const store = yield* Store;
          // A due "waiting" intent fails in its background worker; the others fail at start.
          const expected = status === "stale" ? "retryable" : "failed";
          yield* Effect.promise(() =>
            vi.waitFor(async () =>
              expect((await Effect.runPromise(mailbox.queuedSends))[0]?.status).toBe(expected),
            ),
          );
          expect(yield* store.sendUncertain("restart-failure")).toBe(status !== "stale");
          expect(server.sent).toHaveLength(0);
          const notices = yield* mailbox.listFailedOps;
          expect(notices).toHaveLength(1);
          expect(notices[0]).toMatchObject({
            kind: "send",
            providerId: "restart-failure",
            subject: outgoing.subject,
          });
          expect(notices[0]?.reason).toContain(
            status === "waiting"
              ? "Send response lost"
              : status === "stale"
                ? "expired"
                : "interrupted",
          );
          const queued = (yield* mailbox.queuedSends)[0];
          if (!queued) throw new Error("Missing failed send");
          const input = { id: queued.id, accountId: queued.accountId, message: queued.message };
          const refused = yield* mailbox.queueSend(input, Date.now() + 60000).pipe(Effect.result);
          if (status === "stale") expect(refused._tag).toBe("Success");
          else {
            expect(refused._tag === "Failure" && refused.failure._tag).toBe("SendUncertain");
            yield* mailbox.queueSend(input, Date.now() + 60000, true);
          }
          expect((yield* mailbox.queuedSends)[0]?.status).toBe("waiting");
          expect(yield* store.sendUncertain(input.id)).toBe(false);
        }),
      );
    } finally {
      await reopened.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

it.effect("a stalled provider send does not block queuing or undoing another draft", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    yield* core(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.queueSend({ id: "stalled", accountId: account.id, message: outgoing }, 0);
        const active = yield* mailbox.flushQueuedSends().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const waiting = yield* mailbox
          .queueUndoSend({ id: "other-draft", accountId: account.id, message: outgoing }, 60000)
          .pipe(Effect.timeout("1 second"), Effect.result, Effect.forkChild);
        yield* TestClock.adjust("1 second");
        assert.strictEqual((yield* Fiber.join(waiting))._tag, "Success");
        const undo = yield* mailbox
          .cancelWaitingSend("other-draft")
          .pipe(Effect.timeout("1 second"), Effect.result, Effect.forkChild);
        yield* TestClock.adjust("1 second");
        const cancelled = yield* Fiber.join(undo);
        assert.isTrue(cancelled._tag === "Success" && cancelled.success);
        assert.strictEqual((yield* mailbox.queuedSends)[0]?.status, "sending");
        yield* Fiber.interrupt(active);
      }),
      { send: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) },
    );
  }),
);

it.effect(
  "an expired deadline is rechecked when a scheduled desktop worker claims its send",
  () => {
    let sends = 0;
    return core(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.queueUndoSend(
          { id: "paused-window", accountId: account.id, message: outgoing },
          5000,
        );
        const intent = (yield* store.queuedSends)[0];
        if (!intent) throw new Error("Missing intent");
        yield* store.putQueuedSend({ ...intent, due: -120001 });
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual(sends, 0);
        assert.strictEqual((yield* mailbox.queuedSends)[0]?.status, "retryable");
        assert.isFalse(yield* store.sendUncertain(intent.id));
        assert.strictEqual((yield* mailbox.listFailedOps)[0]?.kind, "send");
        assert.isTrue(Option.isSome(yield* store.getDraft(intent.id)));
      }),
      {
        send: () =>
          Effect.sync(() => {
            sends++;
          }),
      },
    );
  },
);

it.effect(
  "draft version preferences contain only version metadata and deletion clears an orphaned journal",
  () =>
    core(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* store.putDraft({ id: "metadata-only", accountId: account.id, message: outgoing });
        const remote = {
          draftId: "d",
          messageId: "m",
          changeKey: "key",
          lastWrittenAt: 1000,
          conflict: true,
          saveError: new ProviderError({ message: "Transient" }),
        };
        yield* store.setDraftRemote("metadata-only", remote, null);
        const rows =
          yield* sql`SELECT value_json FROM prefs WHERE key='draft-remote:metadata-only'`;
        assert.deepStrictEqual(rows, [
          { value_json: JSON.stringify({ changeKey: "key", lastWrittenAt: 1000 }) },
        ]);
        yield* store.setDraftCreateState("orphaned", {
          messageId: "<orphan@example.test>",
          attempted: true,
        });
        yield* store.deleteDraft("orphaned");
        assert.isTrue(Option.isNone(yield* store.draftCreateState("orphaned")));
      }),
    ),
);
