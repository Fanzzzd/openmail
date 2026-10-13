import { assert, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Fiber, Layer, Logger, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import { type IncomingMessage } from "./domain/domain.js";
import { PermanentError, ProviderError } from "./domain/errors.js";
import { MailboxLive } from "./mailbox-live.js";
import { Mailbox } from "./mailbox.js";
import { fakeServer, makeFakeProvider } from "./platform/node/fake-provider.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { incoming as makeIncoming, TestMailbox } from "./platform/node/testing.js";
import { Providers, Store, type Change, type ProviderAdapter } from "./services.js";
import { StoreLive } from "./store.js";
{
  const message = (providerId: string, rfcMessageId: string): IncomingMessage =>
    makeIncoming(providerId, {
      rfcMessageId,
      threadId: rfcMessageId,
      subject: rfcMessageId,
      to: [],
      date: 100,
      bodyText: rfcMessageId,
      labels: ["INBOX"],
    });

  const withAdapter = <A, E>(
    adapter: ProviderAdapter,
    body: Effect.Effect<A, E, Store | Mailbox>,
  ) =>
    body.pipe(
      Effect.provide(
        TestMailbox.withAdapter(adapter, {
          options: { backgroundFlush: false },
          platformOptions: {},
        }),
      ),
    );

  it.effect(
    "a two-message archive applies COPYUID mappings and later operations use the destination",
    () => {
      const base = makeFakeProvider(fakeServer("me@example.com"));
      const pushes: string[] = [];
      const adapter: ProviderAdapter = {
        ...base,
        pushBatch: (_account, ids) =>
          Effect.succeed(ids.map((from, index) => ({ from, to: `8:${index + 10}:Archive` }))),
        push: (_account, id) =>
          Effect.sync(() => {
            pushes.push(id);
          }),
      };
      return withAdapter(
        adapter,
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const store = yield* Store;
          const account = yield* store.upsertAccount("imap", "me@example.com");
          for (const uid of [1, 2])
            yield* store.upsertMessage(account.id, message(`7:${uid}:INBOX`, `<${uid}@x>`));
          yield* mailbox.perform(
            {
              kind: "modify",
              threads: [1, 2].map((uid) => `${account.id}/7:${uid}:INBOX`),
              op: { kind: "archive" },
            },
            { kind: "user", surface: "app" },
          );
          for (const uid of [1, 2]) {
            const local = `${account.id}/7:${uid}:INBOX`;
            assert.strictEqual((yield* store.messageRef(local)).providerId, `8:${uid + 9}:Archive`);
            yield* mailbox.perform(
              { kind: "modify", threads: [local], op: { kind: "star", value: true } },
              { kind: "user", surface: "app" },
            );
          }
          assert.deepStrictEqual(pushes, ["8:10:Archive", "8:11:Archive"]);
        }),
      );
    },
  );

  it.effect("duplicate Message-IDs remap each old row at most once across pull batches", () => {
    const base = makeFakeProvider(fakeServer("me@example.com"));
    const changes: Change[] = [
      {
        _tag: "Remap",
        previous: { path: "INBOX", uidValidity: "7" },
        message: message("8:3:INBOX", "<duplicate@x>"),
      },
      { _tag: "Cursor", cursor: "checkpoint" },
      {
        _tag: "Remap",
        previous: { path: "INBOX", uidValidity: "7" },
        message: message("8:3:INBOX", "<duplicate@x>"),
      },
      {
        _tag: "Remap",
        previous: { path: "INBOX", uidValidity: "7" },
        message: message("8:4:INBOX", "<duplicate@x>"),
      },
      {
        _tag: "RebuildFolder",
        previous: { path: "INBOX", uidValidity: "7" },
        keep: ["8:3:INBOX", "8:4:INBOX"],
      },
    ];
    return withAdapter(
      { ...base, pull: () => Stream.fromIterable(changes) },
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount("imap", "me@example.com");
        for (const uid of [1, 2])
          yield* store.upsertMessage(account.id, message(`7:${uid}:INBOX`, "<duplicate@x>"));
        yield* mailbox.sync();
        assert.deepStrictEqual(
          (yield* Effect.forEach([1, 2], (uid) => store.messageRef(`${account.id}/7:${uid}:INBOX`)))
            .map((ref) => ref.providerId)
            .toSorted(),
          ["8:3:INBOX", "8:4:INBOX"],
        );
      }),
    );
  });

  for (const polling of [false, true])
    it.effect(
      `a UID swap during ${polling ? "polling" : "sync"} cannot transfer queued mutations`,
      () => {
        const base = makeFakeProvider(fakeServer("me@example.com"));
        const changes: Change[] = [
          { _tag: "InvalidateFolder", previous: { path: "INBOX", uidValidity: "7" } },
          { _tag: "Upsert", message: message("7:5:INBOX", "<x@x>") },
          { _tag: "Upsert", message: message("7:2:INBOX", "<y@x>") },
          { _tag: "Cursor", cursor: "reset" },
        ];
        const pushed: string[] = [];
        return withAdapter(
          {
            ...base,
            pull: () => Stream.fromIterable(changes),
            fetchMessage: () => Effect.fail(new ProviderError({ message: "offline" })),
            push: (_account, id) =>
              Effect.sync(() => {
                pushed.push(id);
              }),
          },
          Effect.gen(function* () {
            const store = yield* Store;
            const mailbox = yield* Mailbox;
            const account = yield* store.upsertAccount("imap", "me@example.com");
            yield* store.upsertMessage(account.id, message("7:2:INBOX", "<x@x>"));
            yield* store.upsertMessage(account.id, message("7:5:INBOX", "<y@x>"));
            yield* store.enqueueOp(account.id, "7:2:INBOX", { kind: "star", value: true });
            yield* store.enqueueOp(account.id, "7:99:INBOX", { kind: "read", value: true });
            yield* store.putDraft({
              id: "draft:old",
              accountId: account.id,
              message: {
                to: [],
                cc: [],
                bcc: [],
                subject: "draft",
                text: "draft",
                attachments: [],
              },
            });
            yield* store.setDraftRemote(
              "draft:old",
              { draftId: "7:98:INBOX", messageId: null },
              null,
            );
            if (polling) {
              yield* store.saveSyncCursor(account.id, "previous");
              yield* mailbox.pollInbox();
            } else yield* mailbox.sync();
            const x = yield* store.messageIdForProvider(account.id, "7:5:INBOX");
            const y = yield* store.messageIdForProvider(account.id, "7:2:INBOX");
            assert.ok(x && y);
            assert.strictEqual((yield* store.getMessage(x)).rfcMessageId, "<x@x>");
            assert.strictEqual((yield* store.getMessage(y)).rfcMessageId, "<y@x>");
            const pending = yield* store.listPendingOps;
            assert.strictEqual(pending.length, 2);
            assert.isTrue(
              pending.every(
                (item) => item.op.kind === "reconcile" && item.providerId.startsWith("unmapped:"),
              ),
            );
            const draft = yield* store.getDraft("draft:old");
            assert.ok(Option.isSome(draft));
            assert.strictEqual(draft.value.remote, null);
            assert.strictEqual(pending[0]?.op.kind, "reconcile");
            assert.notStrictEqual(pending[0]?.providerId, "7:2:INBOX");
            assert.deepStrictEqual(pushed, []);
            assert.isFalse((yield* store.getMessage(y)).isStarred);
          }),
        );
      },
    );

  it.effect("archive X, invalidate, then undo cannot mutate Y or approve stale proposals", () => {
    const server = fakeServer("me@example.com");
    const base = makeFakeProvider(server);
    return withAdapter(
      {
        ...base,
        pull: () =>
          Stream.fromIterable<Change>([
            { _tag: "InvalidateFolder", previous: { path: "INBOX", uidValidity: "7" } },
            { _tag: "Upsert", message: message("7:1:INBOX", "<y@x>") },
            { _tag: "Cursor", cursor: "reset" },
          ]),
      },
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount("imap", "me@example.com");
        const old = `${account.id}/7:1:INBOX`;
        yield* store.upsertMessage(account.id, message("7:1:INBOX", "<x@x>"));
        const { undoId } = yield* mailbox.modifyWithUndo([old], { kind: "archive" });
        yield* store.insertProposal(
          { kind: "agent", surface: "mcp", name: "test" },
          { kind: "modify", threads: [old], op: { kind: "star", value: true } },
        );
        yield* store.insertProposal(
          { kind: "agent", surface: "mcp", name: "test" },
          {
            kind: "send",
            accountId: account.id,
            message: {
              to: [],
              cc: [],
              bcc: [],
              subject: "reply",
              text: "reply",
              attachments: [],
              inReplyTo: old,
            },
          },
        );
        yield* mailbox.sync();
        server.pushed.length = 0;
        const undo = yield* mailbox.undoBatch(undoId).pipe(Effect.result);
        assert.strictEqual(undo._tag, "Failure");
        assert.deepStrictEqual(server.pushed, []);
        assert.deepStrictEqual(yield* store.listProposals("pending"), []);
        assert.deepStrictEqual(yield* mailbox.undoHistory, []);
        assert.isTrue((yield* store.messageRef(old)).providerId.startsWith("unmapped:"));
        assert.strictEqual((yield* store.getMessage(old)).rfcMessageId, "<x@x>");
      }),
    );
  });

  for (const polling of [false, true])
    it.effect(
      `a slow IMAP ${polling ? "poll" : "sync"} never blocks Gmail and resumes its own queue`,
      () =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const imapServer = fakeServer("imap@example.com");
          const gmailServer = fakeServer("gmail@example.com");
          const imap: ProviderAdapter = {
            ...makeFakeProvider(imapServer),
            pull: () =>
              Stream.fromEffect(
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as<Change>({ _tag: "Cursor", cursor: "done" }),
                ),
              ),
          };
          const providers = Layer.succeed(Providers, {
            get: (kind) => (kind === "imap" ? imap : makeFakeProvider(gmailServer)),
          });
          yield* Effect.gen(function* () {
            const mailbox = yield* Mailbox;
            const store = yield* Store;
            const imapAccount = yield* store.upsertAccount("imap", "imap@example.com");
            const gmail = yield* store.upsertAccount("gmail", "gmail@example.com");
            yield* store.upsertMessage(gmail.id, message("g", "<g@x>"));
            yield* store.upsertMessage(imapAccount.id, message("7:1:INBOX", "<x@x>"));
            if (polling) yield* store.saveSyncCursor(imapAccount.id, "previous");
            const sync = yield* (
              polling ? mailbox.pollInbox([imapAccount.id]) : mailbox.sync(imapAccount.id)
            ).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* store.enqueueOp(imapAccount.id, "7:1:INBOX", { kind: "star", value: true });
            const modify = yield* mailbox
              .perform(
                { kind: "modify", threads: [`${gmail.id}/g`], op: { kind: "star", value: true } },
                { kind: "user", surface: "app" },
              )
              .pipe(Effect.forkChild);
            yield* TestClock.adjust("1 second");
            assert.ok(modify.pollUnsafe());
            assert.strictEqual(gmailServer.pushed.length, 1);
            assert.deepStrictEqual(imapServer.pushed, []);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(sync);
            yield* Fiber.join(modify);
            assert.strictEqual(imapServer.pushed.length, 1);
          }).pipe(
            Effect.provide(
              MailboxLive({ backgroundFlush: false }).pipe(
                Layer.provideMerge(
                  Layer.mergeAll(StoreLive, providers).pipe(Layer.provideMerge(MemoryPlatform())),
                ),
              ),
            ),
          );
        }),
    );

  it.effect("a rejected regressed push invalidates instead of refreshing Y into X's handle", () => {
    const base = makeFakeProvider(fakeServer("me@example.com"));
    return withAdapter(
      {
        ...base,
        push: () =>
          Effect.fail(
            new PermanentError({
              message: "Folder was rebuilt",
              imapReset: { path: "INBOX", uidValidity: "7" },
            }),
          ),
        fetchMessage: () => Effect.succeed(message("7:1:INBOX", "<y@x>")),
      },
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount("imap", "me@example.com");
        const old = `${account.id}/7:1:INBOX`;
        yield* store.upsertMessage(account.id, message("7:1:INBOX", "<x@x>"));
        yield* mailbox.perform(
          { kind: "modify", threads: [old], op: { kind: "star", value: true } },
          { kind: "user", surface: "app" },
        );
        assert.isTrue((yield* store.messageRef(old)).providerId.startsWith("unmapped:"));
        assert.strictEqual((yield* store.getMessage(old)).rfcMessageId, "<x@x>");
        yield* store.upsertMessage(account.id, message("7:1:INBOX", "<y@x>"));
        assert.notStrictEqual(yield* store.messageIdForProvider(account.id, "7:1:INBOX"), old);
      }),
    );
  });
}

{
  const withAdapter = <A, E>(
    adapter: ProviderAdapter,
    body: Effect.Effect<A, E, Store | Mailbox>,
  ) =>
    body.pipe(
      Effect.provide(
        TestMailbox.withAdapter(adapter, {
          options: { backgroundFlush: false },
          platformOptions: {},
        }),
      ),
    );

  it.effect("provider defect is content-free and the following sync recovers", () => {
    let failed = true;
    const adapter: ProviderAdapter = {
      ...makeFakeProvider(fakeServer("me@example.com")),
      pull: () =>
        failed
          ? Stream.fromEffect(Effect.die(new Error("private provider payload")))
          : Stream.succeed({ _tag: "Cursor", cursor: "1" }),
    };
    return withAdapter(
      adapter,
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount("outlook", "me@example.com");
        const first = yield* mailbox.sync(account.id);
        assert.strictEqual(first[0]?.error, "Sync could not finish. It will retry automatically.");
        failed = false;
        assert.isUndefined((yield* mailbox.sync(account.id))[0]?.error);
        assert.isFalse((yield* mailbox.syncState).running);
      }),
    );
  });

  for (const failure of ["defect", "interrupted"] as const)
    it.effect(
      `automatic sync survives a provider ${failure} and normal cancellation stays silent`,
      () => {
        let pulls = 0;
        const crashes: unknown[] = [];
        const logger = Logger.make((options) => {
          crashes.push(...(Array.isArray(options.message) ? options.message : [options.message]));
        });
        const adapter: ProviderAdapter = {
          ...makeFakeProvider(fakeServer("me@example.com")),
          pull: () =>
            ++pulls === 1
              ? failure === "defect"
                ? Stream.fromEffect(Effect.die("private provider response"))
                : Stream.failCause(Cause.interrupt(42))
              : Stream.succeed({ _tag: "Cursor", cursor: "1" }),
        };
        return Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const layer = TestMailbox.withAdapter(adapter, {
            options: {
              backgroundFlush: false,
              autoSync: "2 seconds",
              backgroundReady: Deferred.await(ready),
            },
            platformOptions: {},
          });
          yield* Effect.gen(function* () {
            const store = yield* Store;
            const mailbox = yield* Mailbox;
            const account = yield* store.upsertAccount("outlook", "me@example.com");
            yield* Deferred.succeed(ready, undefined);
            yield* TestClock.adjust("3 seconds");
            assert.isAtLeast(pulls, 2);
            assert.isNull((yield* store.getAccount(account.id)).lastSyncError);
            assert.isFalse((yield* mailbox.syncState).running);
          }).pipe(Effect.provide(layer));
          const recorded = crashes.filter(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              "_tag" in value &&
              value._tag === "SyncCrashDiagnostic",
          );
          assert.strictEqual(recorded.length, failure === "defect" ? 1 : 0);
          assert.deepStrictEqual(
            recorded.map((value) =>
              typeof value === "object" && value !== null && "causeKind" in value
                ? value.causeKind
                : null,
            ),
            failure === "defect" ? [failure] : [],
          );
          assert.isFalse(JSON.stringify(crashes).includes("private"));
        }).pipe(Effect.provide(Logger.layer([logger])));
      },
    );

  it.effect(
    "a propagated provider interruption releases sync state and allows a later pull",
    () => {
      let interrupted = true;
      const adapter: ProviderAdapter = {
        ...makeFakeProvider(fakeServer("me@example.com")),
        pull: () =>
          interrupted
            ? Stream.failCause(Cause.interrupt(42))
            : Stream.succeed({ _tag: "Cursor", cursor: "1" }),
      };
      return withAdapter(
        adapter,
        Effect.gen(function* () {
          const store = yield* Store;
          const mailbox = yield* Mailbox;
          const account = yield* store.upsertAccount("outlook", "me@example.com");
          assert.strictEqual((yield* mailbox.sync(account.id).pipe(Effect.exit))._tag, "Failure");
          assert.isFalse((yield* mailbox.syncState).running);
          interrupted = false;
          assert.isUndefined((yield* mailbox.sync(account.id))[0]?.error);
        }),
      );
    },
  );

  it.effect("maintenance defects release shared sync waiters and the next run recovers", () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("outlook", "me@example.com");
      let broken = true;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const adapter = makeFakeProvider(fakeServer(account.email));
      const unreliableStore: Store["Service"] = {
        ...store,
        getBackfillState: (id) =>
          Effect.suspend(() =>
            broken
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Effect.die("private maintenance payload")),
                )
              : store.getBackfillState(id),
          ),
      };
      yield* Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const first = yield* mailbox.sync(account.id).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const waiter = yield* mailbox.sync(account.id).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(first);
        assert.deepStrictEqual(yield* Fiber.join(waiter), result);
        assert.strictEqual(result[0]?.error, "Sync could not finish. It will retry automatically.");
        assert.isFalse((yield* mailbox.syncState).running);
        broken = false;
        assert.isUndefined((yield* mailbox.sync(account.id))[0]?.error);
      }).pipe(
        Effect.provide(
          MailboxLive({ backgroundFlush: false }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                Layer.succeed(Store, unreliableStore),
                Layer.succeed(Providers, { get: () => adapter }),
              ).pipe(Layer.provideMerge(MemoryPlatform())),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
  );

  it.effect("closing the automatic-sync scope during a pull is silent and terminates", () => {
    const crashes: unknown[] = [];
    const logger = Logger.make((options) => {
      crashes.push(...(Array.isArray(options.message) ? options.message : [options.message]));
    });
    return Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const pulling = yield* Deferred.make<void>();
      const adapter: ProviderAdapter = {
        ...makeFakeProvider(fakeServer("me@example.com")),
        pull: () =>
          Stream.fromEffect(
            Deferred.succeed(pulling, undefined).pipe(Effect.andThen(Effect.never)),
          ),
      };
      yield* Effect.gen(function* () {
        const store = yield* Store;
        yield* store.upsertAccount("outlook", "me@example.com");
        yield* Deferred.succeed(ready, undefined);
        yield* Deferred.await(pulling);
        // Releasing the layer interrupts the in-flight pull and the scheduler together.
      }).pipe(
        Effect.provide(
          TestMailbox.withAdapter(adapter, {
            options: {
              backgroundFlush: false,
              autoSync: "2 seconds",
              backgroundReady: Deferred.await(ready),
            },
            platformOptions: {},
          }),
        ),
      );
      assert.deepStrictEqual(crashes, []);
    }).pipe(Effect.provide(Logger.layer([logger])));
  });

  it.effect("wake clears provider and inbox polling backoff before the next pull", () => {
    let offline = false;
    let pulls = 0;
    let resets = 0;
    const adapter: ProviderAdapter = {
      ...makeFakeProvider(fakeServer("me@example.com")),
      pull: () => {
        pulls++;
        return offline
          ? Stream.fail(new ProviderError({ message: "Offline", status: 0, deferred: true }))
          : Stream.succeed({ _tag: "Cursor", cursor: "1" });
      },
      resetConnectivity: () =>
        Effect.sync(() => {
          resets++;
        }),
    };
    return withAdapter(
      adapter,
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount("outlook", "me@example.com");
        yield* mailbox.sync(account.id);
        offline = true;
        yield* mailbox.pollInbox();
        const before = pulls;
        yield* mailbox.pollInbox();
        assert.strictEqual(pulls, before);
        yield* mailbox.setSyncPaused(true);
        offline = false;
        yield* mailbox.setSyncPaused(false);
        yield* mailbox.pollInbox();
        assert.strictEqual(resets, 1);
        assert.strictEqual(pulls, before + 1);
      }),
    );
  });
}
