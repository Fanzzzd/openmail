import { assert, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { ProviderError } from "../domain/errors.js";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { splitWriteBatch } from "./mailbox-sync.js";
import { fakeServer, makeFakeProvider } from "../platform/node/fake-provider.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { Providers } from "../providers/adapter.js";
import { Store } from "../store/service.js";
import { StoreLive } from "../store/store.js";
import { incoming, TestMailbox } from "../platform/node/testing.js";
import type { Change } from "../providers/adapter.js";

const upsert = (id: string, htmlLength: number): Change => ({
  _tag: "Upsert",
  message: incoming(id, { bodyHtml: "x".repeat(htmlLength), bodyText: "" }),
});
const tags = (parts: Change[][]) =>
  parts.map((part) =>
    part.map((change) => (change._tag === "Upsert" ? change.message.providerId : change._tag)),
  );

it("cuts a write batch by body size and keeps each message's Progress with it", () => {
  const progress: Change = { _tag: "Progress", fetched: 1, total: 4 };
  const batch = [
    upsert("a", 105_000),
    progress,
    upsert("b", 105_000),
    progress,
    upsert("c", 50_000),
    upsert("d", 20_000),
    { _tag: "Cursor", cursor: "end" } satisfies Change,
  ];
  expect(tags(splitWriteBatch(batch, 200_000))).toEqual([
    ["a", "Progress"],
    ["b", "Progress", "c", "d", "Cursor"],
  ]);
  // A message over the budget gets its own transaction; small batches stay whole.
  expect(tags(splitWriteBatch([upsert("big", 500_000), upsert("e", 10)], 200_000))).toEqual([
    ["big"],
    ["e"],
  ]);
  expect(splitWriteBatch([progress, progress], 200_000)).toEqual([[progress, progress]]);
  expect(splitWriteBatch([])).toEqual([]);
});

// IMAP renewed it already; its connect also needs server settings.
for (const provider of ["gmail", "outlook"] as const)
  it(`${provider}: a full sync renews the inbox cursor, so inbox polls never start from an expired one`, async () => {
    const server = fakeServer("me@example.com", [incoming("one")]);
    const runtime = ManagedRuntime.make(TestMailbox({ [provider]: server }));
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const m = yield* Mailbox;
          yield* m.accounts.connect({ provider });
          yield* m.sync(); // cursor "1"
          yield* m.pollInbox(); // inbox cursor "2"
          // Full syncs keep going (on a phone: in the foreground) while polls stop for a while.
          yield* m.sync(); // cursor "2"
          yield* m.sync(); // cursor "3"
          yield* m.pollInbox();
          // The poll starts from the newest full-sync cursor, not the one its last poll left.
          expect(server.pulls).toEqual([null, "1", "1", "2", "3"]);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });

it.effect("the snooze wake loop keeps running after one failed pass", () =>
  Effect.gen(function* () {
    let calls = 0;
    const flakyStore = Layer.effect(
      Store,
      Effect.map(Store, (store) => ({
        ...store,
        wakeSnoozed: (now: number) =>
          Effect.suspend(() => {
            calls++;
            return calls === 1
              ? Effect.die(new Error("database is locked"))
              : store.wakeSnoozed(now);
          }),
      })),
    ).pipe(Layer.provide(StoreLive));
    const live = MailboxLive({
      autoSync: "1 hour",
      backgroundReady: Effect.never,
      backgroundFlush: false,
      imapIdle: false,
    }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          flakyStore,
          Layer.succeed(Providers, {
            get: () => makeFakeProvider(fakeServer("me@example.test")),
          }),
        ).pipe(Layer.provideMerge(MemoryPlatform())),
      ),
    );
    yield* Effect.gen(function* () {
      yield* Mailbox;
      yield* TestClock.adjust("1 second");
      assert.strictEqual(calls, 1);
      yield* TestClock.adjust("30 seconds");
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual(calls, 3);
    }).pipe(Effect.provide(live));
  }),
);

it.live("a full sync pulls up to three accounts at once, each account once", () => {
  let active = 0;
  let most = 0;
  const pulls: string[] = [];
  const layer = TestMailbox.withAdapter((base) => ({
    ...base,
    pull: (account, ...rest) =>
      Stream.unwrap(
        Effect.gen(function* () {
          pulls.push(account.email);
          most = Math.max(most, ++active);
          yield* Effect.sleep("30 millis");
          active--;
          return base.pull(account, ...rest);
        }),
      ),
  }));
  return Effect.gen(function* () {
    const store = yield* Store;
    const mailbox = yield* Mailbox;
    for (const name of ["a", "b", "c", "d", "e"])
      yield* store.upsertAccount("gmail", `${name}@example.test`);
    const results = yield* mailbox.sync();
    assert.deepStrictEqual(
      results.map((result) => result.error),
      [undefined, undefined, undefined, undefined, undefined],
    );
    assert.strictEqual(most, 3);
    assert.deepStrictEqual(pulls.toSorted(), [
      "a@example.test",
      "b@example.test",
      "c@example.test",
      "d@example.test",
      "e@example.test",
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("a checkpoint cursor before a failed first sync does not mark the account synced", () => {
  const pulls: { cursor: string | undefined; scope: string | undefined }[] = [];
  const layer = TestMailbox.withAdapter((base) => ({
    ...base,
    pull: (_account, cursor, scope) => {
      pulls.push({ cursor: Option.getOrUndefined(cursor), scope });
      const checkpoint: Change = { _tag: "Cursor", cursor: "initial:901", checkpoint: true };
      return Stream.make(checkpoint).pipe(
        Stream.concat(
          Stream.fail(new ProviderError({ message: "Gmail API 400: bad", status: 400 })),
        ),
      );
    },
  }));
  return Effect.gen(function* () {
    const store = yield* Store;
    const mailbox = yield* Mailbox;
    const account = yield* store.upsertAccount("gmail", "me@example.test");
    const [result] = yield* mailbox.sync();
    assert.ok(result?.error);
    const after = yield* store.getAccount(account.id);
    assert.strictEqual(after.lastSyncedAt, null);
    assert.deepStrictEqual(yield* store.getSyncCursor(account.id), Option.some("initial:901"));
    assert.isTrue(Option.isNone(yield* store.getInboxCursor(account.id)));
    // Inbox polls wait for a completed first sync instead of listing the inbox again.
    yield* mailbox.pollInbox();
    assert.deepStrictEqual(pulls, [{ cursor: undefined, scope: undefined }]);
  }).pipe(Effect.provide(layer));
});
