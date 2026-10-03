import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { IncomingMessage } from "./domain.js";
import { PermanentError, ProviderError } from "./errors.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { Providers, Store, type Change, type ProviderAdapter } from "./services.js";
import { StoreLive } from "./store.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { fakeServer, makeFakeProvider } from "./platform/node/fake-provider.js";

const message = (providerId: string, rfcMessageId: string): IncomingMessage => ({
  providerId,
  rfcMessageId,
  threadId: rfcMessageId,
  subject: rfcMessageId,
  from: { name: "Alice", address: "alice@example.com" },
  to: [],
  cc: [],
  date: 100,
  snippet: "",
  bodyText: rfcMessageId,
  bodyHtml: "",
  labels: ["INBOX"],
  attachments: [],
  isUnread: true,
  isStarred: false,
});
const withAdapter = <A, E>(adapter: ProviderAdapter, body: Effect.Effect<A, E, Store | Mailbox>) =>
  body.pipe(
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

it.effect(
  "slice55: a two-message archive applies COPYUID mappings and later operations use the destination",
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

it.effect(
  "slice55: duplicate Message-IDs remap each old row at most once across pull batches",
  () => {
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
  },
);

for (const polling of [false, true])
  it.effect(
    `slice55: a UID swap during ${polling ? "polling" : "sync"} cannot transfer queued mutations`,
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
            message: { to: [], cc: [], bcc: [], subject: "draft", text: "draft", attachments: [] },
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

it.effect(
  "slice55-fix: archive X, invalidate, then undo cannot mutate Y or approve stale proposals",
  () => {
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
        assert.isFalse(yield* store.hasMessage(old));
      }),
    );
  },
);

for (const polling of [false, true])
  it.effect(
    `slice55-fix: a slow IMAP ${polling ? "poll" : "sync"} never blocks Gmail and resumes its own queue`,
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

it.effect(
  "slice55-fix: a rejected regressed push invalidates instead of refreshing Y into X's handle",
  () => {
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
        assert.isFalse(yield* store.hasMessage(old));
        yield* store.upsertMessage(account.id, message("7:1:INBOX", "<y@x>"));
        assert.notStrictEqual(yield* store.messageIdForProvider(account.id, "7:1:INBOX"), old);
      }),
    );
  },
);
