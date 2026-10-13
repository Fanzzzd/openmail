import { assert, it } from "@effect/vitest";
import { Effect, Layer, ConfigProvider, Option } from "effect";
import { HttpClient } from "effect/http";
import { makeGmail } from "../gmail.js";
import { makeOutlook } from "../outlook.js";
import { makeImap } from "../platform/node/imap/adapter.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import {
  offlineAdapter,
  READ_ONLY_METHODS,
  readOnlyAdapter,
  READ_ONLY_MESSAGE,
  refused,
} from "./read-only.js";
import { Mailbox } from "./mailbox.js";
import { Store } from "../services.js";
import { EMPTY_FILTER } from "../domain/organization.js";
import { fakeServer, TestMailbox } from "../platform/node/testing.js";
import { makeFakeProvider } from "../platform/node/fake-provider.js";
import { detectMailEvents } from "../calendar.js";
import { type IncomingMessage, type OutgoingMessage } from "../domain/domain.js";
{
  it.effect(
    "every real provider method is explicitly read-allowlisted or refused without calling it",
    () =>
      Effect.gen(function* () {
        for (const adapter of [yield* makeGmail, yield* makeOutlook, yield* makeImap]) {
          const readonly = readOnlyAdapter(adapter);
          for (const name of Object.keys(adapter)) {
            const method: unknown = Reflect.get(readonly, name);
            const original: unknown = Reflect.get(adapter, name);
            if (READ_ONLY_METHODS.some((key) => key === name))
              assert.strictEqual(method, original, name);
            else {
              assert.strictEqual(typeof method, "function", name);
              assert.notStrictEqual(method, original, name);
              assert.strictEqual(method, refused, name);
              const result = yield* refused().pipe(Effect.result);
              assert.strictEqual(result._tag, "Failure", name);
              if (result._tag === "Failure")
                assert.strictEqual(result.failure.message, READ_ONLY_MESSAGE);
              assert.strictEqual(Object.getOwnPropertyDescriptor(readonly, name)?.value, method);
            }
          }
          let invoked = false;
          const extended = {
            ...adapter,
            newWrite: () =>
              Effect.sync(() => {
                invoked = true;
              }),
          };
          const closed = readOnlyAdapter(extended);
          assert.strictEqual(Reflect.get(closed, "newWrite"), refused);
          assert.strictEqual((yield* refused().pipe(Effect.result))._tag, "Failure");
          Object.defineProperty(extended, "futureGetter", {
            configurable: true,
            enumerable: true,
            get: () => {
              invoked = true;
              return () => Effect.void;
            },
          });
          assert.strictEqual(Reflect.get(closed, "futureGetter"), refused);
          assert.strictEqual(
            Object.getOwnPropertyDescriptor(closed, "futureGetter")?.value,
            refused,
          );
          assert.strictEqual(invoked, false);
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            MemoryPlatform(),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("Unexpected network request")),
            ),
          ),
        ),
      ),
  );
}

{
  const message = (id: string, bodyText = "alpha one beta"): IncomingMessage => ({
    providerId: id,
    threadId: id,
    subject: "Travel",
    from: { name: "Sender", address: "sender@example.com" },
    to: [],
    cc: [],
    date: 1,
    snippet: "",
    bodyText,
    bodyHtml: "",
    labels: ["INBOX"],
    attachments: [],
    isUnread: false,
    isStarred: false,
  });

  const outgoing: OutgoingMessage = {
    to: [{ name: "", address: "to@example.com" }],
    cc: [],
    bcc: [],
    subject: "Local draft",
    text: "Text",
    attachments: [],
  };

  const actor = { kind: "user", surface: "app" } as const;

  it.effect(
    "read-only session retains old operations and drafts, permits local edits and refuses sending",
    () => {
      const server = fakeServer("me@gmail.com", [message("one")]);
      return Effect.gen(function* () {
        const mailbox = yield* Mailbox,
          store = yield* Store;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.sync();
        yield* store.enqueueOp(account.id, "one", { kind: "star", value: true });
        const before = yield* store.listPendingOps;
        yield* mailbox.sync();
        assert.deepStrictEqual(yield* store.listPendingOps, before);
        yield* mailbox.perform(
          { kind: "modify", threads: [`${account.id}/one`], op: { kind: "read", value: false } },
          actor,
        );
        assert.strictEqual((yield* store.getMessage(`${account.id}/one`)).isUnread, true);
        yield* mailbox.saveDraft({ id: "local", accountId: account.id, message: outgoing });
        assert.strictEqual(
          Option.getOrThrow(yield* store.getDraft("local")).message.subject,
          "Local draft",
        );
        assert.strictEqual(Option.getOrThrow(yield* store.getDraft("local")).remote, null);
        assert.strictEqual(server.draftLog.length, 0);
        assert.strictEqual(server.pushed.length, 0);
        const sent = yield* mailbox
          .perform({ kind: "send", accountId: account.id, message: outgoing }, actor)
          .pipe(Effect.result);
        assert.strictEqual(sent._tag, "Failure");
        if (sent._tag === "Failure") assert.strictEqual(sent.failure.message, READ_ONLY_MESSAGE);
        assert.strictEqual(
          (yield* mailbox
            .queueSend({ id: "local", accountId: account.id, message: outgoing }, 1)
            .pipe(Effect.result))._tag,
          "Failure",
        );
        for (const action of [
          mailbox.unsubscribe(`${account.id}/one`, actor),
          mailbox.importCalendarAttachment(`${account.id}/one`, [0], "event", actor),
        ]) {
          const result = yield* action.pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.strictEqual(result.failure.message, READ_ONLY_MESSAGE);
        }
        yield* store.putQueuedSend({
          id: "old-send",
          accountId: account.id,
          message: outgoing,
          due: 0,
          status: "waiting",
        });
        yield* mailbox.flushQueuedSends();
        assert.strictEqual((yield* store.queuedSends)[0]?.status, "waiting");
        assert.strictEqual(server.sent.length, 0);
        assert.ok((yield* store.listPendingOps).length >= 3);
      }).pipe(
        Effect.provide(
          TestMailbox({ gmail: server }).pipe(
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromEnvRecord({ OPENMAIL_READ_ONLY: "1" })),
            ),
          ),
        ),
      );
    },
  );

  it.effect(
    "read-only provider boundary refuses folder, draft, filter, vacation and calendar mutations",
    () => {
      const server = fakeServer("me@gmail.com");
      const adapter = readOnlyAdapter(makeFakeProvider(server));
      const account = {
        id: "gmail:me@gmail.com",
        provider: "gmail",
        email: "me@gmail.com",
        color: null,
        profileId: null,
        needsReauth: false,
        createdAt: 0,
        lastSyncedAt: null,
        lastSyncError: null,
      } as const;
      const event = detectMailEvents({
        subject: "Travel",
        bodyText: "2026-10-03 09:00 to 10:00",
        date: Date.parse("2026-10-01T00:00:00Z"),
      })[0];
      assert.ok(event);
      return Effect.gen(function* () {
        const effects: Effect.Effect<unknown, { readonly message: string }>[] = [
          adapter.push(account, "one", { kind: "archive" }),
          adapter.send(account, outgoing, Option.none()),
          adapter.deleteDraft(account, { draftId: "draft", messageId: null }),
          adapter.markReadBatch(account, ["one"]),
          adapter.permanentlyDelete(account, ["one"], "trash"),
          adapter.changeLabel(account, { kind: "parent", id: "Label_one", parentId: null }),
          adapter.createFilter(account, EMPTY_FILTER),
          adapter.updateFilter(account, "one", EMPTY_FILTER),
          adapter.deleteFilter(account, "one"),
          adapter.setVacation(account, server.vacation),
          ...(adapter.createCalendarEvent ? [adapter.createCalendarEvent(account, event)] : []),
        ];
        for (const effect of effects) {
          const result = yield* effect.pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.strictEqual(result.failure.message, READ_ONLY_MESSAGE);
        }
        assert.deepStrictEqual(server.pushed, []);
        assert.deepStrictEqual(server.sent, []);
        assert.deepStrictEqual(server.deleted, []);
        assert.deepStrictEqual(server.filters, []);
        assert.deepStrictEqual(server.createdEvents, []);
      });
    },
  );
}

it.effect("OPENMAIL_OFFLINE refuses every provider method without calling it", () =>
  Effect.gen(function* () {
    for (const adapter of [yield* makeGmail, yield* makeOutlook, yield* makeImap]) {
      const closed = offlineAdapter(adapter);
      for (const name of Object.keys(adapter)) {
        const method: unknown = Reflect.get(closed, name);
        assert.strictEqual(typeof method, "function", name);
        assert.notStrictEqual(method, Reflect.get(adapter, name), name);
      }
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        MemoryPlatform(),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected network request")),
        ),
      ),
    ),
  ),
);

it.effect("an offline session syncs and checks health without one provider call", () => {
  const server = fakeServer("me@gmail.com");
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const store = yield* Store;
    const account = yield* store.upsertAccount("gmail", "me@gmail.com");
    const results = yield* mailbox.sync(account.id);
    assert.ok(results.length > 0);
    for (const result of results) assert.isString(result.error);
    yield* mailbox.syncHealth(account.id).pipe(Effect.result);
    assert.strictEqual(server.pulls.length, 0);
    assert.strictEqual(server.pushed.length, 0);
    assert.strictEqual(server.sent.length, 0);
  }).pipe(
    Effect.provide(
      TestMailbox({ gmail: server }).pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({ OPENMAIL_READ_ONLY: "1", OPENMAIL_OFFLINE: "1" }),
          ),
        ),
      ),
    ),
  );
});
